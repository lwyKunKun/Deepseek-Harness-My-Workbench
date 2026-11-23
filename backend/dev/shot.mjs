#!/usr/bin/env node
// shot.mjs —— 登录 3080 并截图（用于人眼核对界面）
//
// 用法：
//   node dev/shot.mjs <输出png> [--url http://127.0.0.1:3080/] [--wait 8000]
//                    [--eval "js 表达式"] [--click "文字"] [--w 1600] [--h 1000]
//
// --click 可重复：按可见文字找到元素，用真实鼠标事件点它（DOM 的 .click() 常常不触发框架的委托）。
// 鉴权：沿用 data/engine-cookie.json 里存的那份引擎 cookie。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const out = argv[0] && !argv[0].startsWith('--') ? argv[0] : '/tmp/wb-shot.png';
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const URL_ = val('--url', 'http://127.0.0.1:3080/');
const WAIT = Number(val('--wait', 8000));
const EXPR = val('--eval', '');
const CLICKS = argv.reduce((acc, a, i) => (a === '--click' ? acc.concat([argv[i + 1]]) : acc), []);
const W = Number(val('--w', 1600));
const H = Number(val('--h', 1000));
const PORT = Number(val('--cdp', 9470));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const cookie = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'engine-cookie.json'), 'utf8')).cookie || ''; }
  catch (e) { return ''; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p;
    } catch (e) { /* 等 */ }
    await sleep(250);
  }
  throw new Error('Chrome 没起来');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'log'].includes(m.params.type)) {
        const text = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        this.logs.push('[' + m.params.type + '] ' + text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.logs.push('[exception] ' + (d.exception?.description || d.text || ''));
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时：' + method)); } }, 30000);
    });
  }
  async eval(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-default-apps', '--no-default-browser-check', '--mute-audio',
  '--renderer-process-limit=2', '--js-flags=--max-old-space-size=512',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=' + W + ',' + H, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  for (const part of cookie().split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    await cdp.send('Network.setCookie', { name: part.slice(0, i), value: decodeURIComponent(part.slice(i + 1)), domain: '127.0.0.1', path: '/' });
  }

  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(WAIT);

  if (EXPR) {
    let r;
    try { r = await cdp.eval(EXPR, true); } catch (e) { r = 'ERR ' + e.message; }
    console.log('eval →', JSON.stringify(r));
    await sleep(2000);
  }

  // 按可见文字找元素 → 取中心坐标 → 发真实鼠标事件
  for (const text of CLICKS) {
    const box = await cdp.eval(`(function(){
      function walk(root, out){
        root.querySelectorAll('*').forEach(function(el){
          if (el.shadowRoot) walk(el.shadowRoot, out);
          var label = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
          var leaf = el.children.length === 0 && (el.textContent||'').trim() === ${JSON.stringify(text)};
          if (label === ${JSON.stringify(text)} || leaf) {
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) out.push({ x: r.x + r.width/2, y: r.y + r.height/2, tag: el.tagName, by: label === ${JSON.stringify(text)} ? 'label' : 'text' });
          }
        });
      }
      var out=[]; walk(document, out);
      out.sort(function(a,b){ return (a.by==='label'?0:1) - (b.by==='label'?0:1); });
      return out[0] || null;
    })()`);
    if (!box) { console.log('click 找不到：' + text); continue; }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      });
    }
    console.log('click ' + text + ' @ ' + Math.round(box.x) + ',' + Math.round(box.y));
    await sleep(3000);
  }

  // 打字：逐字符发 keyDown/keyUp（xterm 认 keydown 的 key + text）
  const TEXT = val('--type', '');
  if (TEXT) {
    for (const ch of TEXT) {
      if (ch === '\n') {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      } else {
        const up = ch.toUpperCase();
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: ch, text: ch,
          keyCode: up.charCodeAt(0),
          windowsVirtualKeyCode: up.charCodeAt(0),
        });
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: ch,
          keyCode: up.charCodeAt(0),
          windowsVirtualKeyCode: up.charCodeAt(0),
        });
      }
    }
    console.log('type ' + JSON.stringify(TEXT));
    await sleep(2000);
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('截图已存：' + out);
  if (cdp.logs.length) {
    console.log('--- 控制台报错/警告 ---');
    for (const l of cdp.logs.slice(-25)) console.log('  ' + l);
  }
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
}
