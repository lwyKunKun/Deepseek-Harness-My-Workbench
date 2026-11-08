#!/usr/bin/env node
// check-delete.mjs —— 在真实界面上验一遍「删除场景」
//
// 流程：造一个临时角色 → 在卡片目录里点它的 🗑 → 确认对话框出现
//       → 点「确认删除」→ 卡片消失、接口报告删了什么
//
// 用法：node dev/check-delete.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = 'http://127.0.0.1:3080/';
const PORT = 9352;
const TMP_ID = 'zzdel';
const TMP_NAME = '待删角色';

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-del-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-default-apps', '--no-default-browser-check', '--mute-audio',
  '--renderer-process-limit=2', '--js-flags=--max-old-space-size=512',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1600,1000', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = () => {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'engine-cookie.json'), 'utf8')).cookie || ''; }
  catch (e) { return ''; }
};
async function api(method, url, body) {
  const res = await fetch('http://127.0.0.1:3080/workbench' + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie() ? { cookie: cookie() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  try { return JSON.parse(t); } catch (e) { return { ok: false, error: t.slice(0, 200) }; }
}

async function findTarget() {
  for (let i = 0; i < 40; i++) {
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
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.errors.push('未捕获：' + (d.exception?.description || d.text || ''));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push('console.error：' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

try {
  console.log('① 造一个临时角色：' + TMP_NAME);
  const made = await api('POST', '/api/scenes/create', { id: TMP_ID, name: TMP_NAME, category: '测试', duty: '验证删除', skills: ['删除'] });
  console.log('   ' + (made.ok ? '建好了（id=' + made.id + '）' : '没建成：' + made.error));

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

  console.log('② 进「工作台」页');
  await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i=0;i<all.length;i++){ var b=all[i]; if ((b.getAttribute('aria-label')||'') === '工作台') { b.click(); return 1; } }
    return 0;
  })()`);
  await sleep(4000);

  console.log('③ 卡片上有没有 🗑 按钮');
  const hasDel = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var card = host.shadowRoot.querySelector('.side-leaf[data-sc-id="${TMP_ID}"]');
    if (!card) return 'no-card';
    var b = card.querySelector('.side-del');
    if (!b) return 'no-button';
    b.click();
    return 'clicked';
  })()`);
  console.log('   ' + hasDel);
  await sleep(1200);

  console.log('④ 确认对话框');
  const dlg = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    var d = host && host.shadowRoot.querySelector('.dialog.open');
    if (!d) return null;
    return {
      title: (d.querySelector('h3')||{}).textContent,
      desc: (d.querySelector('.dialog-p')||{}).textContent,
      buttons: Array.prototype.map.call(d.querySelectorAll('.dialog-actions .chip'), function(b){ return b.textContent; }),
    };
  })()`);
  if (!dlg) { console.log('   ✗ 没有弹出确认框'); }
  else {
    console.log('   标题：' + dlg.title);
    console.log('   说明：' + String(dlg.desc).replace(/\n/g, ' / ').slice(0, 200));
    console.log('   按钮：' + dlg.buttons.join(' / '));
  }

  console.log('⑤ 点「确认删除」');
  await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    var d = host && host.shadowRoot.querySelector('.dialog.open');
    if (!d) return 'no-dialog';
    var btns = d.querySelectorAll('.dialog-actions .chip');
    for (var i=0;i<btns.length;i++){ if (btns[i].textContent.indexOf('删除') >= 0) { btns[i].click(); return btns[i].textContent; } }
    return 'no-button';
  })()`);
  await sleep(1200);
  const toastText = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    var t = host && host.shadowRoot.querySelector('#toast-host');
    return t ? t.textContent.replace(/\\s+/g,' ').trim() : '(没有 toast 容器)';
  })()`);
  console.log('   提示条：' + toastText);
  await sleep(3000);

  const after = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    var card = host && host.shadowRoot.querySelector('.side-leaf[data-sc-id="${TMP_ID}"]');
    var toast = host && host.shadowRoot.querySelector('#toast-host');
    return { cardStillThere: !!card, toast: toast ? toast.innerText.replace(/\\s+/g,' ').slice(0,120) : '' };
  })()`);
  console.log('   卡片还在吗：' + (after.cardStillThere ? '❌ 还在' : '✓ 没了'));
  console.log('   提示：' + (after.toast || '(没有 toast)'));

  const left = await api('GET', '/api/scenes');
  console.log('   接口里的场景数：' + (left.scenes || left).length + '（' + (left.scenes || left).map((s) => s.name).join('、') + '）');

  console.log('');
  console.log('控制台报错：' + (cdp.errors.length ? '\n  ' + cdp.errors.slice(0, 5).join('\n  ') : '无'));
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
