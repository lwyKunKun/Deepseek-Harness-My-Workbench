#!/usr/bin/env node
// check-embed.mjs —— 验证「工作台」是不是真的嵌进 DSH 界面了
//
// 查三件事：
//   ① 左边侧栏有没有「工作台」这个按钮
//   ② 点它以后，右边主区是不是真的渲染出工作台（shadow root 里有 #topbar）
//   ③ 控制台有没有报错
//
// ⚠ 资源限制：DSH 界面是个重 SPA，无头浏览器不限住会把机器压垮（有过教训）。
//
// 用法：node dev/check-embed.mjs [--cdp 9342] [--shot data/embed.png]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = val('--url', 'http://127.0.0.1:3080/');
const PORT = Number(val('--cdp', 9342));
const SHOT = val('--shot', path.join(process.cwd(), 'data', 'embed.png'));
const WAIT = Number(val('--wait', 9000));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome/Chromium/Edge'); process.exit(2); }

/** 从 data/engine-cookie.json 取引擎 cookie，在浏览器里种上（否则页面 401）。 */
function cookieHeader() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'engine-cookie.json'), 'utf8'));
    return String(j.cookie || '');
  } catch (e) { return ''; }
}
function cookiePairs() {
  return cookieHeader().split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf('=');
    return { name: s.slice(0, i), value: decodeURIComponent(s.slice(i + 1)) };
  });
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-embed-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-default-apps', '--no-default-browser-check', '--mute-audio',
  '--renderer-process-limit=2', '--js-flags=--max-old-space-size=512',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--window-size=1600,1000',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.errors.push('未捕获异常：' + (d.exception?.description || d.text || ''));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push('console.error：' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时：' + method)); }
      }, 30000);
    });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
}

let cdp = null;
try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  // 种上引擎 cookie
  for (const c of cookiePairs()) {
    await cdp.send('Network.setCookie', { name: c.name, value: c.value, domain: '127.0.0.1', path: '/' });
  }

  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(WAIT);

  console.log('── ① 侧栏有没有「工作台」按钮 ──');
  const buttons = await cdp.eval(`(function(){
    var out = [];
    document.querySelectorAll('button, [role="button"], a').forEach(function(b){
      var t = (b.textContent||'').trim();
      var al = b.getAttribute('aria-label') || '';
      if (t || al) out.push({ text: t.slice(0,20), aria: al.slice(0,20), tag: b.tagName });
    });
    return out.filter(function(x){ return x.text.indexOf('工作台') >= 0 || x.aria.indexOf('工作台') >= 0; });
  })()`);
  console.log('   命中 ' + (buttons || []).length + ' 个：');
  (buttons || []).forEach((b) => console.log('     <' + b.tag + '> text=' + JSON.stringify(b.text) + ' aria=' + JSON.stringify(b.aria)));

  console.log('');
  console.log('── ② 点它，看主区 ──');
  const clicked = await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      var t = (b.textContent||'').trim();
      var al = b.getAttribute('aria-label') || '';
      if (t.indexOf('工作台') >= 0 || al.indexOf('工作台') >= 0) { b.click(); return 'clicked: ' + (al || t); }
    }
    return 'no-button';
  })()`);
  console.log('   ' + clicked);
  await sleep(6000);

  const state = await cdp.eval(`(function(){
    var hosts = [];
    document.querySelectorAll('*').forEach(function(el){
      if (el.shadowRoot) hosts.push(el);
    });
    var found = null;
    hosts.forEach(function(el){
      var top = el.shadowRoot.querySelector('#topbar');
      if (top) found = {
        host: el.tagName + '.' + (el.className||''),
        topbar: !!top,
        nav: el.shadowRoot.querySelectorAll('#mainnav .navbtn').length,
        cards: el.shadowRoot.querySelectorAll('.scene-card').length,
        text: (el.shadowRoot.textContent||'').replace(/\\s+/g,' ').slice(0,220),
      };
    });
    return { shadowHosts: hosts.length, found: found };
  })()`);
  console.log('   shadow 宿主数量：' + state.shadowHosts);
  if (state.found) {
    console.log('   ✓ 工作台渲染出来了：' + JSON.stringify(state.found, null, 2).replace(/\n/g, '\n   '));
  } else {
    console.log('   ✗ 没找到工作台的 shadow root');
  }

  // ③ 进一个角色 ⇒ AI 面板的 iframe 能不能从面板端口加载引擎
  const OPEN = val('--open', '');
  if (OPEN) {
    console.log('');
    console.log('── ③ 进角色「' + OPEN + '」，看 AI 面板的 iframe ──');
    const opened = await cdp.eval(`(function(){
      var host = null;
      document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host = el; });
      if (!host) return 'no-shadow';
      var card = host.shadowRoot.querySelector('.scene-card[data-sc-id="${OPEN}"]');
      if (!card) return 'no-card';
      var btn = card.querySelector('button');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()`);
    console.log('   ' + opened);
    await sleep(9000);

    const frames = await cdp.send('Page.getFrameTree');
    const all = [];
    (function walk(n) { all.push(n.frame); (n.childFrames || []).forEach(walk); })(frames.frameTree);
    const wb = all.filter((f) => f.url.indexOf('3082') >= 0 || f.url.indexOf('/engine/') >= 0);
    console.log('   iframe 数量（面板端口上的）：' + wb.length);
    wb.forEach((f) => console.log('     ' + f.url.split('?')[0]));
    if (!wb.length) console.log('   ✗ 没找到 AI 面板的 iframe');
  }

  // ④ 点左树里的另一个角色 ⇒ 右边的卡要跟着换
  const swap = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var leaves = host.shadowRoot.querySelectorAll('.side-leaf');
    if (!leaves.length) return 'no-leaves';
    var before = (host.shadowRoot.querySelector('.cat-main-name')||{}).textContent;
    var target = null;
    for (var i=0;i<leaves.length;i++){ if (!leaves[i].classList.contains('active')) { target = leaves[i]; break; } }
    if (!target) return 'only-one';
    var want = (target.querySelector('.side-leaf-name')||{}).textContent;
    target.click();
    return (before || '(空)') + ' → ' + (want || '(空)');
  })()`);
  console.log('④ 点树上另一个角色：' + swap);
  await sleep(3000);
  const after = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var name = (host.shadowRoot.querySelector('.cat-main-name')||{}).textContent;
    var cards = host.shadowRoot.querySelectorAll('.panel-card').length;
    var active = host.shadowRoot.querySelectorAll('.side-leaf.active').length;
    return name + ' | 卡片 ' + cards + ' 张 | 选中 ' + active + ' 个';
  })()`);
  console.log('   右边现在是：' + after);

  // 场景详情：看看「项目目录」面板
  const openScene = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var leaf = host.shadowRoot.querySelector('.side-leaf[data-sc-id="work"]');
    if (!leaf) return 'no-leaf';
    leaf.click();                       // 先选中（右边换成它的卡）
    return 'ok';
  })()`);
  console.log('选中「工作」：' + openScene);
  await sleep(2500);
  // 再点「打开场景」进详情页
  await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var btns = host.shadowRoot.querySelectorAll('.cat-main-head button');
    for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('打开场景')>=0) { btns[i].click(); return 'ok'; } }
    return 'no-btn';
  })()`);
  await sleep(4000);
  const proj = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var ids=[]; host.shadowRoot.querySelectorAll('[data-panel-id]').forEach(function(x){ids.push(x.getAttribute('data-panel-id'));});
    var p = host.shadowRoot.querySelector('[data-panel-id="work-proj"]');
    if (!p) return '没有这个面板；页面上的面板 = ' + ids.join(', ');
    var b = p.querySelector('.panel-body');
    return (b && b.innerText || '').replace(/\\s+/g,' ').slice(0,300);
  })()`);
  console.log('项目目录面板：' + proj);

  // 上传：在页面里造一个 File，往拖放区一丢
  const up = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var p = host.shadowRoot.querySelector('[data-panel-id="work-proj"]');
    if (!p) return 'no-panel';
    var drop = p.querySelector('.up-drop');
    if (!drop) return 'no-dropzone';
    var dt = new DataTransfer();
    dt.items.add(new File(['export const fromUi = 1;\\n'], 'from-ui.ts', { type: 'text/plain' }));
    drop.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    var over = drop.className;
    drop.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return 'dropped; dragover 时=' + over;
  })()`);
  console.log('上传（拖放）：' + up);
  await sleep(4000);
  const upNote = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    var p = host && host.shadowRoot.querySelector('[data-panel-id="work-proj"]');
    var n = p && p.querySelector('.up-note');
    return n ? n.textContent : '(没有提示)';
  })()`);
  console.log('上传结果：' + upNote);

  // 书架面板：进「阅读」场景看
  const shelf = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    // 先退出详情页（回目录），再在树上选阅读
    var back = host.shadowRoot.querySelector('.detail-head button');
    if (back) back.click();
    var leaf = host.shadowRoot.querySelector('.side-leaf[data-sc-id="reading"]');
    if (!leaf) { var ls=[]; host.shadowRoot.querySelectorAll('.side-leaf').forEach(function(x){ls.push(x.getAttribute('data-sc-id'));}); return 'no-leaf; 树上有: ' + ls.join(','); }
    if (!leaf) return 'no-leaf';
    leaf.click();
    return 'ok';
  })()`);
  console.log('选中「阅读」：' + shelf);
  await sleep(3500);
  await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return;
    var btns = host.shadowRoot.querySelectorAll('.cat-main-head button');
    for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('打开场景')>=0) { btns[i].click(); return; } }
  })()`);
  await sleep(5000);
  const shelfInfo = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var p = host.shadowRoot.querySelector('[data-panel-id="reading-shelf"]');
    if (!p) { var ids=[]; host.shadowRoot.querySelectorAll('[data-panel-id]').forEach(function(x){ids.push(x.getAttribute('data-panel-id'));}); return '没有书架面板；页面上的 = ' + ids.join(', '); }
    var counts = p.querySelector('.shelf-counts');
    var heads = p.querySelectorAll('.shelf-h');
    var books = p.querySelectorAll('.shelf-book');
    return { counts: counts ? counts.innerText.replace(/\\s+/g,' ') : '', groups: Array.prototype.map.call(heads, function(h){return h.textContent;}), books: books.length };
  })()`);
  console.log('书架面板：' + JSON.stringify(shelfInfo, null, 1).replace(/\\n/g, ' '));

  // 点开一本书 ⇒ 读书视图
  const opened = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var p = host.shadowRoot.querySelector('[data-panel-id="reading-shelf"]');
    if (!p) return 'no-shelf';
    var book = p.querySelector('.shelf-book');
    if (!book) return 'no-book';
    var title = (book.querySelector('.shelf-book-title')||{}).textContent;
    book.click();
    return 'clicked: ' + title;
  })()`);
  console.log('点开一本书：' + opened);
  await sleep(3500);
  const reader = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    var p = host && host.shadowRoot.querySelector('[data-panel-id="reading-shelf"]');
    var r = p && p.querySelector('.shelf-reader');
    if (!r) return '没有 .shelf-reader 容器';
    if (r.style.display === 'none') return 'reader 的 display 是 none（没打开）';
    return {
      title: (r.querySelector('.shelf-reader-title')||{}).textContent,
      meta: (r.querySelector('.shelf-reader-meta')||{}).textContent,
      body: (r.querySelector('.md')||{}).innerText ? r.querySelector('.md').innerText.replace(/\\s+/g,' ').slice(0,120) : '(空)',
    };
  })()`);
  console.log('读书视图：' + JSON.stringify(reader, null, 1).replace(/\\n/g, ' '));

  // 更新进度：在界面上点「更新进度」→ 填页码 → 确认 ⇒ 真改 md
  const upd = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var p = host.shadowRoot.querySelector('[data-panel-id="reading-shelf"]');
    if (!p) return 'no-shelf';
    // 回书架（如果在读书视图里）
    var back = p.querySelector('.shelf-reader-head button');
    if (back) back.click();
    var btns = p.querySelectorAll('.shelf-book-side .chip');
    for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('更新进度')>=0) { btns[i].click(); return 'clicked'; } }
    return 'no-button';
  })()`);
  console.log('点「更新进度」：' + upd);
  await sleep(1500);
  const dlgInfo = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    var d = host && host.shadowRoot.querySelector('.dialog.open');
    if (!d) return null;
    return { title: (d.querySelector('h3')||{}).textContent, desc: (d.querySelector('.dialog-p')||{}).textContent,
             input: (d.querySelector('.dialog-input')||{}).value };
  })()`);
  console.log('对话框：' + JSON.stringify(dlgInfo));
  if (dlgInfo) {
    await cdp.eval(`(function(){
      var host=null;
      document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
      var d = host && host.shadowRoot.querySelector('.dialog.open');
      if (!d) return;
      var inp = d.querySelector('.dialog-input');
      if (inp) inp.value = '112';
      var btns = d.querySelectorAll('.dialog-actions .chip');
      for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('更新')>=0) { btns[i].click(); return; } }
    })()`);
    await sleep(3500);
    const note = await cdp.eval(`(function(){
      var host=null;
      document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
      var p = host && host.shadowRoot.querySelector('[data-panel-id="reading-shelf"]');
      var first = p && p.querySelector('.shelf-book');
      return first ? ((first.querySelector('.shelf-book-title')||{}).textContent + ' → ' + ((first.querySelector('.shelf-book-page')||{}).textContent||'')) : '(没有书)';
    })()`);
    console.log('刷新后第一本书：' + note);
  }

  console.log('');
  console.log('── ③ 控制台报错 ──');
  if (!cdp.errors.length) console.log('   ✓ 没有报错');
  else cdp.errors.slice(0, 10).forEach((e) => console.log('   ✗ ' + e.slice(0, 300)));

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(r.data, 'base64'));
    console.log('');
    console.log('截图：' + SHOT);
  }).catch(() => {});
} catch (e) {
  console.error('检查失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
