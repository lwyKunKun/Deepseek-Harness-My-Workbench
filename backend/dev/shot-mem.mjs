#!/usr/bin/env node
// dev/shot-mem.mjs —— 专门给「项目信息」面板截图（两个视图都拍）
//
// 用法：node dev/shot-mem.mjs [--cdp 9471] [--w 1600] [--h 1000]
//   拍两张：
//     /tmp/mem-cards.png   场景页（右侧是摘要卡）
//     /tmp/mem-detail.png  场景详情页（项目信息是其中一个面板）
//
// 导航走 shadow DOM（工作台整个界面在 DSH 的 shadow root 里），
//   DOM 的 .click() 对它不生效，得直接调元素方法。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9471));
const W = Number(val('--w', 1600));
const H = Number(val('--h', 1000));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shotmem-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-default-apps', '--no-first-run', '--mute-audio',
  '--renderer-process-limit=2', '--js-flags=--max-old-space-size=512',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=' + W + ',' + H, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'engine-cookie.json'), 'utf8')).cookie || ''; }
  catch (e) { return ''; }
};

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
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.logs.push('[error] ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
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

const SHADOW = `var host=null;
  document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
  if (!host) return null; var sr=host.shadowRoot;`;

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
  await sleep(9000);

  // ① 进工作台 → 选中「阅读」
  await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i=0;i<all.length;i++){ if ((all[i].getAttribute('aria-label')||'') === '工作台') { all[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(3500);
  await cdp.eval(`(function(){ ${SHADOW}
    var leaf = sr.querySelector('.side-leaf[data-sc-id="reading"]');
    if (leaf) leaf.click();
  })()`);
  await sleep(3500);

  let r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/mem-cards.png', Buffer.from(r.data, 'base64'));
  console.log('场景页 → /tmp/mem-cards.png');

  // ② 进详情页（双击摘要卡 / 点「详情」按钮）
  await cdp.eval(`(function(){ ${SHADOW}
    var cards = sr.querySelectorAll('.panel-card');
    for (var i=0;i<cards.length;i++) {
      var t = (cards[i].querySelector('.panel-card-title')||{}).textContent || '';
      if (t.indexOf('项目信息')>=0) {
        var b = cards[i].querySelector('.panel-card-open');
        if (b) { b.click(); return 1; }
      }
    }
    return 0;
  })()`);
  await sleep(4500);
  r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/mem-detail.png', Buffer.from(r.data, 'base64'));
  console.log('详情页 → /tmp/mem-detail.png');

  // ③ 把「项目信息」面板展开成全宽（用户截图里那张就是展开态）
  await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="reading-mem"]');
    if (!p) return 0;
    var btn = p.querySelector('.panel-expand');
    if (btn) { btn.click(); return 1; }
    return 0;
  })()`);
  await sleep(1200);
  r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/mem-expanded.png', Buffer.from(r.data, 'base64'));
  console.log('展开态 → /tmp/mem-expanded.png');

  // ④ 「留痕」页签也得正常（面板正文改成 flex 之后，别把时间线挤没了）
  await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="reading-mem"]');
    if (!p) return 0;
    var tabs = p.querySelectorAll('.mem-tab');
    for (var i=0;i<tabs.length;i++){ if ((tabs[i].textContent||'').indexOf('留痕')>=0) { tabs[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(2500);
  const trail = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="reading-mem"]');
    if (!p) return { found:false };
    var list = p.querySelector('.act-list');
    var box = p.querySelector('.act-box');
    return {
      found: true,
      rows: p.querySelectorAll('.act-row').length,
      listH: list ? list.getBoundingClientRect().height : -1,
      boxH: box ? box.getBoundingClientRect().height : -1,
    };
  })()`);
  console.log('留痕页签：' + JSON.stringify(trail));
  r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/mem-trail.png', Buffer.from(r.data, 'base64'));
  console.log('留痕态 → /tmp/mem-trail.png');

  if (cdp.logs.length) {
    console.log('--- 控制台报错 ---');
    for (const l of cdp.logs.slice(-10)) console.log('  ' + l);
  }
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
