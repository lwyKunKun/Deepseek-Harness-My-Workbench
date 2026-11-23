#!/usr/bin/env node
// check-drag.mjs —— 验证左树能拖拽排序
//
// 做法：用 CDP 的 Input.dispatchDragEvent 真拖一次（HTML5 拖放没法用普通鼠标事件模拟），
// 然后看两件事：
//   ① 树里的顺序变了
//   ② 顺序存下来了（data/scene-order.json + /api/scenes 的返回）
//
// 用法：node dev/check-drag.mjs [--cdp 9360]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9360));
// ⚠ 路径基于脚本自己算 ⇒ 从哪个目录跑都对（原来靠 process.cwd()）。
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// ⚠ 拖拽会改写 data/scene-order.json ⇒ 收尾时**原样写回**，别把用户的顺序搅乱
const ORDER_FILE = path.join(ROOT, 'data', 'scene-order.json');
let ORDER_RAW = null;
try { ORDER_RAW = fs.readFileSync(ORDER_FILE, 'utf8'); } catch (e) { /* ignore */ }
/* 角色归属也一起兜住：落点是按像素算的，万一 CSS 变了、落点翻到下半区 ⇒
 * 拖拽会变成「加入那个分类」⇒ 角色的 category 就被改了。
 * 所以不只还原顺序，归属也按快照写回。 */
let SNAP_CATS = {};      // 场景 id → 分类
const apiPath = (u, body) => fetch('http://127.0.0.1:3080/workbench' + u, {
  method: body ? 'POST' : 'GET',
  headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie: cookie() },
  body: body ? JSON.stringify(body) : undefined,
});
async function takeSnapshot() {
  const r = await (await apiPath('/api/scenes')).json();
  (r.scenes || []).forEach((x) => { SNAP_CATS[x.id] = x.category; });
}
async function restoreSnapshot() {
  for (const id of Object.keys(SNAP_CATS)) {
    try { await apiPath('/api/scene/category', { id, category: SNAP_CATS[id] }); } catch (e) { /* ignore */ }
  }
  try { if (ORDER_RAW !== null) fs.writeFileSync(ORDER_FILE, ORDER_RAW); } catch (e) { /* ignore */ }
}

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-drag-'));
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
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'engine-cookie.json'), 'utf8')).cookie || ''; }
  catch (e) { return ''; }
};

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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
}

/** 树里某个角色（叶子）的位置 */
const leafBox = (id) => `(() => {
  var host=null;
  document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
  if (!host) return null;
  var leaf = host.shadowRoot.querySelector('.side-leaf[data-sc-id="${id}"]');
  if (!leaf) return null;
  var r = leaf.getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2, top: r.top, bottom: r.bottom, name: (leaf.querySelector('.side-leaf-name')||{}).textContent };
})()`;

/** 当前树里的顺序 */
const treeOrder = `(() => {
  var host=null;
  document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
  if (!host) return null;
  var out=[];
  host.shadowRoot.querySelectorAll('.side-branch').forEach(function(br){
    var cat = (br.querySelector('.side-cat')||{}).textContent;
    br.querySelectorAll('.side-leaf').forEach(function(lf){
      out.push((lf.getAttribute('data-sc-id')||'?') + '/' + cat + '/' + (lf.querySelector('.side-leaf-name')||{}).textContent);
    });
  });
  return out;
})()`;

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
  await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i=0;i<all.length;i++){ if ((all[i].getAttribute('aria-label')||'') === '工作台') { all[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(4000);

  await takeSnapshot();          // ⚠ 拍在第一次拖拽之前
  console.log('① 拖之前的顺序：');
  const before = await cdp.eval(treeOrder);
  (before || []).forEach((x, i) => console.log('   ' + (i + 1) + '. ' + x));

  // 拖：把第一个角色拖到**最后一个分类的标题下半区** ⇒ 加入那个分类（归属跟着变）
  //
  // ⚠ 为什么不用 CDP 的鼠标事件：headless Chrome 起不了原生 HTML5 拖放
  //   （dragstart 不触发）。所以这里**在页面里派发真实的 DragEvent**，
  //   跑的是我自己写的那套 handler（dragstart → dragover → drop → dragend），
  //   不是绕过它。
  const first = (before || [])[0];
  const last = (before || [])[(before || []).length - 1];
  const srcId = first.split('/')[0];
  const dstId = last.split('/')[0];
  console.log('② 拖：把「' + srcId + '」拖到最后一个分类的标题上（= 换分类）');

  const dragged = await cdp.eval(`(function(){
    var host=null;
    document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
    if (!host) return 'no-shadow';
    var src = host.shadowRoot.querySelector('.side-leaf[data-sc-id="${srcId}"]');
    // 落点：最后一个分类的标题（拖过去 = 换分类）
    var branches = host.shadowRoot.querySelectorAll('.side-branch');
    var lastBranch = branches[branches.length - 1];
    var bh = lastBranch && lastBranch.querySelector('.side-branch-head');
    if (!src || !bh) return 'no-leaf';
    var dt = new DataTransfer();
    var r = bh.getBoundingClientRect();
    // ⚠ 落点必须在分类标题的**下半区**（app.js 的规则）：
    //   上半区 = 排在这个分类前面（只换顺序，归属不变）
    //   下半区 = 加入这个分类（改归属）
    // 之前落在上半区 ⇒ 归属没变 ⇒ 树是按分类分组的，看起来完全没动 ⇒ 断言误报。
    var dropY = r.top + r.height * 0.85;
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    bh.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: dropY }));
    var marked = bh.className;
    bh.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: dropY }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return 'dispatched; 落点标记=' + marked;
  })()`);
  console.log('   ' + dragged);
  await sleep(3500);

  console.log('③ 拖之后的顺序：');
  const after = await cdp.eval(treeOrder);
  (after || []).forEach((x, i) => console.log('   ' + (i + 1) + '. ' + x));

  const changed = JSON.stringify(before) !== JSON.stringify(after);
  console.log('');
  console.log('   顺序变了？' + (changed ? '✓ 变了' : '❌ 没变'));

  console.log('④ 存下来了？');
  const order = await (await fetch('http://127.0.0.1:3080/workbench/api/scenes', { headers: { cookie: cookie() } })).json();
  console.log('   /api/scenes 返回的顺序：' + (order.scenes || []).map((x) => x.name).join(' → '));
  const saved = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8'));
  console.log('   data/scene-order.json：' + (saved.ids || []).join(' → '));

  console.log('');
  console.log('控制台报错：' + (cdp.errors.length ? '\n  ' + cdp.errors.slice(0, 4).join('\n  ') : '无'));
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  // ⚠ 还原：拖拽把 data/scene-order.json 改了（归属也可能被改）⇒ 按快照原样写回
  try { await restoreSnapshot(); } catch (e) { /* ignore */ }
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
