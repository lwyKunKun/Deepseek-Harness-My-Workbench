#!/usr/bin/env node
// diag-pin.mjs —— 诊断「钉会话」为什么没钉住
//
// 查两件事：
//   ① 父页面收到 pin.js 的诊断回报（state / title / rows / stored）
//   ② 面板 iframe（3082 那个 origin）里的 localStorage 与画面状态
//
// 用法：node dev/diag-pin.mjs [角色id]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCENE = process.argv[2] || 'research';
const URL_ = 'http://127.0.0.1:3080/';
const PORT = 9345;

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-diag-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-default-apps', '--no-default-browser-check', '--mute-audio',
  '--renderer-process-limit=2', '--js-flags=--max-old-space-size=512',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1600,1000', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.ws = ws; this.id = 0; this.pending = new Map(); this.contexts = []; this.net = []; this.console = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response;
        this.net && this.net.push({ url: r.url, status: r.status, type: m.params.type });
      }
      if (m.method === 'Network.loadingFailed') {
        this.net && this.net.push({ url: m.params.requestId, error: m.params.errorText, failed: true });
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        this.console && this.console.push({ ctx: m.params.executionContextId, type: m.params.type, text: txt });
      }
      if (m.method === 'Runtime.executionContextCreated') {
        const c = m.params.context;
        this.contexts.push({ id: c.id, origin: c.origin, aux: c.auxData || {} });
      }
      if (m.method === 'Runtime.executionContextDestroyed') {
        this.contexts = this.contexts.filter((c) => c.id !== m.params.executionContextId);
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
  async eval(expression, contextId) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
  contextFor(origin) {
    const c = this.contexts.filter((x) => x.origin === origin);
    return c.length ? c[c.length - 1].id : undefined;
  }
}

try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  const cookie = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'engine-cookie.json'), 'utf8')).cookie;
  for (const part of cookie.split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    await cdp.send('Network.setCookie', { name: part.slice(0, i), value: decodeURIComponent(part.slice(i + 1)), domain: '127.0.0.1', path: '/' });
  }

  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(9000);

  // 装一个回报收集器
  await cdp.eval(`(function(){
    window.__wbPin = [];
    window.addEventListener('message', function(e){
      if (e.data && e.data.source === 'wb-pin') window.__wbPin.push(e.data);
    });
    return true;
  })()`);

  // 点侧栏「工作台」
  await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i=0;i<all.length;i++){ var b=all[i]; var al=b.getAttribute('aria-label')||''; if (al === '工作台') { b.click(); return 'ok'; } }
    return 'no';
  })()`);
  await sleep(4000);

  // 进角色
  const opened = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var card = host.shadowRoot.querySelector('.scene-card[data-sc-id="${SCENE}"]');
    if (!card) return 'no-card';
    card.querySelector('button').click();
    return 'ok';
  })()`);
  console.log('进角色 ' + SCENE + '：' + opened);
  await sleep(14000);

  console.log('');
  console.log('── ① iframe（3082）的网络请求 ──');
  const net = (cdp.net || []).filter((n) => n.url);
  const inFrame = net.filter((n) => n.url.indexOf(':3082') >= 0);
  const inParent = net.filter((n) => n.url.indexOf(':3080') >= 0);
  console.log('   iframe(3082) 请求 ' + inFrame.length + ' 个：');
  inFrame.filter((n) => n.url.indexOf('/api/') >= 0 || n.url.indexOf('events') >= 0)
    .forEach((n) => console.log('     ' + n.status + '  ' + String(n.url).replace('http://127.0.0.1:3082', '').slice(0, 80)));
  console.log('   iframe 有没有要 session/list：' + (inFrame.some((n) => n.url.indexOf('session/list') >= 0) ? '有' : '❌ 没有'));
  console.log('   父页面(3080) 请求 ' + inParent.length + ' 个，其中有 session/list：' + (inParent.some((n) => n.url.indexOf('session/list') >= 0) ? '有' : '没有'));
  console.log('   mux（WebSocket）请求：');
  net.filter((n) => n.url.indexOf('mux') >= 0 || n.type === 'WebSocket').forEach((n) => console.log('     ' + n.status + '  ' + String(n.url).slice(0, 90)));
  console.log('   父页面有没有 mux：' + (inParent.some((n) => n.url.indexOf('mux') >= 0) ? '有' : '没有'));
  console.log('');
  console.log('── ① 各上下文的 console（错误/警告）──');
  (cdp.console || []).filter((c) => c.type === 'error' || c.type === 'warning').forEach((c) => {
    const origin = (cdp.contexts.filter((x) => x.id === c.ctx)[0] || {}).origin || ('ctx' + c.ctx);
    console.log('   [' + origin + '] ' + c.text.slice(0, 220));
  });

  console.log('');
  console.log('── ① 父页面收到的 pin.js 回报（最后 3 条）──');
  const reports = await cdp.eval(`(function(){
    var a = window.__wbPin || [];
    return a.slice(-3).map(function(r){
      return { state:r.state, title:r.title, titleSrc:r.titleSrc, pinned:r.pinned, rows:r.rows,
               stored:r.stored, sessionId:r.sessionId, sessionTitle:r.sessionTitle, by:r.by, error:r.error };
    });
  })()`);
  (reports || []).forEach((r) => console.log('   ' + JSON.stringify(r)));
  if (!reports || !reports.length) console.log('   （一条回报都没有 ⇒ pin.js 根本没跑起来）');

  console.log('');
  console.log('── ② 面板 iframe（3082）里的状态 ──');
  const ctx = cdp.contextFor('http://127.0.0.1:3082');
  if (!ctx) {
    console.log('   找不到 3082 的执行上下文');
  } else {
    const inner = await cdp.eval(`(function(){
      var sel=null;
      try { sel = JSON.parse(localStorage.getItem('dsh.sessions.current')||'null'); } catch(e){}
      var keys=[]; try { for (var i=0;i<localStorage.length;i++) keys.push(localStorage.key(i)); } catch(e){}
      var row=document.querySelector('[role="treeitem"][aria-selected="true"], [aria-selected="true"]');
      var hero=document.body.innerText.indexOf('选择一个工作区') >= 0;
      return { stored: sel, keys: keys, docTitle: document.title,
               selectedRow: row ? (row.textContent||'').trim().slice(0,40) : null,
               showsHero: hero };
    })()`, ctx);
    console.log('   ' + JSON.stringify(inner, null, 2).replace(/\n/g, '\n   '));

    // ③ 直接试：把键写好再刷新 iframe，看引擎认不认
    console.log('');
    console.log('── ③ 写好键 + 刷新 iframe，看引擎认不认 ──');
    await cdp.eval(`(function(){
      try { localStorage.setItem('dsh.sessions.current', JSON.stringify({sessionId:'session-7c31c5e0-8244-43cc-ab65-2e113f3378ec'})); } catch(e){}
      location.reload();
      return true;
    })()`, ctx);
    await sleep(12000);
    const ctx2 = cdp.contextFor('http://127.0.0.1:3082');
    if (!ctx2) { console.log('   刷新后找不到 3082 的上下文'); }
    else {
    const after = await cdp.eval(`(function(){
      var sel=null; try { sel = JSON.parse(localStorage.getItem('dsh.sessions.current')||'null'); } catch(e){}
      var keys=[]; try { for (var i=0;i<localStorage.length;i++) keys.push(localStorage.key(i)); } catch(e){}
      var head=document.querySelector('header, [class*="header"]');
      return { stored: sel, keys: keys, docTitle: document.title,
               showsHero: document.body.innerText.indexOf('选择一个工作区') >= 0,
               bodyStart: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,160) };
    })()`, ctx);
    console.log('   ' + JSON.stringify(after, null, 2).replace(/\n/g, '\n   '));
    }
  }
} catch (e) {
  console.error('诊断失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
