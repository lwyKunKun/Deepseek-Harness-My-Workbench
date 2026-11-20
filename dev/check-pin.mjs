#!/usr/bin/env node
// check-pin.mjs —— 验「钉会话」对**每个角色**都生效
//
// 走一遍：选角色 → 打开对话 → 看 AI 面板的诊断小字是不是「✓ 已钉」
// （以前它误报「✗ 找不到会话行」—— 引擎的「对话」页签也有 aria-selected，
//   pin.js 把它当成了会话标题。）
//
// 用法：node dev/check-pin.mjs [--cdp 9460] [--scene reading,command,...]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(val('--cdp', 9460));
const SCENES = val('--scene', '').split(',').filter(Boolean);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pin-'));
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--renderer-process-limit=2',
  '--js-flags=--max-old-space-size=512', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, '--window-size=1600,1000', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = () => { try { return JSON.parse(fs.readFileSync('data/engine-cookie.json', 'utf8')).cookie || ''; } catch (e) { return ''; } };
const api = async (u) => (await fetch('http://127.0.0.1:3080/workbench' + u, { headers: { cookie: cookie() } })).json();

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails?.exception?.description || '');
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 30000); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
}

const HOST = `(function(){ var h=null; document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) h=el; }); return h; })()`;

let failed = 0;
try {
  const target = (await (async () => { for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = l.find((t) => t.type === 'page'); if (p) return p; } catch (e) {} await sleep(250); } })());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  for (const part of cookie().split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    await cdp.send('Network.setCookie', { name: part.slice(0, i), value: decodeURIComponent(part.slice(i + 1)), domain: '127.0.0.1', path: '/' });
  }
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3080/' });
  await sleep(9000);
  await cdp.eval(`(function(){ var a=document.querySelectorAll('button,[role="button"]'); for(var i=0;i<a.length;i++){ if((a[i].getAttribute('aria-label')||'')==='工作台'){a[i].click();return 1;} } return 0; })()`);
  await sleep(3500);

  const scenes = await api('/api/scenes');
  const list = (scenes.scenes || []).filter((s) => {
    const ai = (s.panels || []).find((p) => p.type === 'harness');
    return ai && ai.sessionId;
  });
  const targets = SCENES.length ? list.filter((s) => SCENES.indexOf(s.id) >= 0) : list;

  console.log('要测 ' + targets.length + ' 个角色（每个都该显示「✓ 已钉」）');
  console.log('');

  for (const sc of targets) {
    // 选它
    await cdp.eval(`(function(){
      var h=${HOST}; if(!h) return;
      var leaf = h.shadowRoot.querySelector('.side-leaf[data-sc-id="${sc.id}"]');
      if (leaf) leaf.click();
    })()`);
    await sleep(2500);
    // 打开对话
    await cdp.eval(`(function(){
      var h=${HOST}; if(!h) return;
      var bs = h.shadowRoot.querySelectorAll('.panel-card .panel-btn');
      for (var i=0;i<bs.length;i++){ if ((bs[i].textContent||'').indexOf('打开对话')>=0) { bs[i].click(); return; } }
    })()`);
    await sleep(13000);
    // 读诊断小字
    const diag = await cdp.eval(`(function(){
      var h=${HOST}; if(!h) return '(no-shadow)';
      var d = h.shadowRoot.querySelector('.panel-diag');
      return d ? { text: d.textContent, title: d.title } : '(no-diag)';
    })()`);
    const ok = diag && String(diag.text).indexOf('已钉') >= 0;
    if (!ok) failed++;
    const wantTitle = (sc.panels || []).find((p) => p.type === 'harness').sessionTitle || sc.name;
    const gotTitle = diag && diag.title ? (diag.title.split('\n').find((l) => l.indexOf('画面上的会话') === 0) || '') : '';
    const titleOk = gotTitle.indexOf(wantTitle) >= 0;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + sc.name.padEnd(10) + ' 状态=' + (diag ? diag.text : '?')
      + '   画面标题=' + (titleOk ? '对' : gotTitle + '（期望含 ' + wantTitle + '）'));
    // 回目录
    await cdp.eval(`(function(){
      var h=${HOST}; if(!h) return;
      var back = h.shadowRoot.querySelector('.cat-main-head .panel-btn');
      if (back) back.click();
    })()`);
    await sleep(1500);
  }

  console.log('');
  console.log(failed ? ('✗ 有 ' + failed + ' 个角色没钉住') : '✓ 全部角色都钉住了');
  console.log('控制台报错：' + (cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '无'));
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
