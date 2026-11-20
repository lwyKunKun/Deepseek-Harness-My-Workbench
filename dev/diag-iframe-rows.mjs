#!/usr/bin/env node
// diag-iframe-rows.mjs —— 看**面板 iframe 里**的引擎侧栏长什么样
//
// 目的：查「钉会话」为什么找不到目标行 ——
//   是分组折叠？还是分组根本不在？还是有别的结构？
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(val('--cdp', 9450));
const SCENE = val('--scene', 'reading');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-if-'));
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--renderer-process-limit=2',
  '--js-flags=--max-old-space-size=512', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, '--window-size=1600,1000', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = () => { try { return JSON.parse(fs.readFileSync('data/engine-cookie.json', 'utf8')).cookie || ''; } catch (e) { return ''; } };

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.ctxs = []; this.errors = [];
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.executionContextCreated') { const c = m.params.context; this.ctxs.push({ id: c.id, origin: c.origin }); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails?.exception?.description || '');
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 30000); }); }
  async eval(expression, contextId) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, ...(contextId ? { contextId } : {}) }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; }
  ctxOf(origin) { const c = this.ctxs.filter((x) => x.origin === origin); return c.length ? c[c.length - 1].id : undefined; }
}

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
  // 进工作台 → 选角色 → 打开场景 → 打开对话（把 AI 面板弄出来）
  await cdp.eval(`(function(){ var a=document.querySelectorAll('button,[role="button"]'); for(var i=0;i<a.length;i++){ if((a[i].getAttribute('aria-label')||'')==='工作台'){a[i].click();return 1;} } return 0; })()`);
  await sleep(3500);
  await cdp.eval(`(function(){
    var h=null; document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) h=el; });
    if (!h) return;
    var leaf = h.shadowRoot.querySelector('.side-leaf[data-sc-id="${SCENE}"]');
    if (leaf) leaf.click();
  })()`);
  await sleep(2500);
  await cdp.eval(`(function(){
    var h=null; document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) h=el; });
    if (!h) return;
    var bs = h.shadowRoot.querySelectorAll('.panel-card .panel-btn');
    for (var i=0;i<bs.length;i++){ if ((bs[i].textContent||'').indexOf('打开对话')>=0) { bs[i].click(); return; } }
  })()`);
  await sleep(14000);

  const ctx = cdp.ctxOf('http://127.0.0.1:3082');
  if (!ctx) { console.log('找不到 3082 的上下文'); process.exit(1); }

  // 先看看 iframe 里到底有什么
  const rough = await cdp.eval(`(function(){
    return {
      url: location.href.slice(0,80),
      title: document.title,
      bodyStart: (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').slice(0,200),
      treeitems: document.querySelectorAll('[role="treeitem"]').length,
      anyRole: document.querySelectorAll('[role]').length,
      aside: document.querySelectorAll('aside, [class*="sidebar"], [class*="Sidebar"]').length,
      buttons: document.querySelectorAll('button').length,
    };
  })()`, ctx);
  console.log('=== iframe 里有什么 ===');
  console.log('  ' + JSON.stringify(rough, null, 1).replace(/\n/g, '\n  '));

  const dump = `(function(){
    var out = { groups: [], rows: [], total: 0 };
    var items = document.querySelectorAll('div[role="treeitem"]');
    out.total = items.length;
    for (var i=0;i<items.length;i++){
      var e = items[i];
      var t = e.querySelector('[class*="title"]');
      var rec = {
        cls: (e.className||'').slice(0,60),
        expanded: e.getAttribute('aria-expanded'),
        selected: e.getAttribute('aria-selected'),
        title: t ? (t.textContent||'').trim().slice(0,24) : '(无 title)',
      };
      if (rec.expanded !== null) out.groups.push(rec);
      else out.rows.push(rec);
    }
    return out;
  })()`;

  console.log('=== iframe 里侧栏的样子 ===');
  const before = await cdp.eval(dump, ctx);
  console.log('  treeitem 总数：' + before.total);
  console.log('  分组（带 aria-expanded）：');
  before.groups.forEach((g) => console.log('    ' + JSON.stringify(g)));
  console.log('  会话行：');
  before.rows.forEach((r) => console.log('    ' + JSON.stringify(r)));

  const hasTarget = before.rows.some((r) => r.title === '阅读');
  console.log('');
  console.log('  目标行「阅读」在可见行里吗？' + (hasTarget ? '✓ 在' : '✗ 不在（被折叠了）'));

  // 展开所有折叠分组，再看
  console.log('');
  console.log('=== 展开所有折叠分组后 ===');
  const after = await cdp.eval(`(function(){
    var n = 0;
    document.querySelectorAll('div[role="treeitem"][aria-expanded="false"]').forEach(function(e){
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
        try { e.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, view:window })); } catch(err){}
      });
      n++;
    });
    return n;
  })()`, ctx);
  console.log('  点了 ' + after + ' 个折叠分组');
  await sleep(2500);
  const after2 = await cdp.eval(dump, ctx);
  console.log('  会话行：');
  after2.rows.forEach((r) => console.log('    ' + JSON.stringify(r)));
  const has2 = after2.rows.some((r) => r.title === '阅读');
  console.log('');
  console.log('  目标行「阅读」出现了吗？' + (has2 ? '✓ 出现了' : '✗ 还是没有'));

  console.log('');
  console.log('报错：' + (cdp.errors.slice(0, 3).join(' | ') || '无'));
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
