#!/usr/bin/env node
// check-menu.mjs —— 验「一级菜单 → 摘要卡 → 会话」这条主线
//
// ① 左边是场景树（可拖拽）
// ② 点一个场景 ⇒ 右边出 4 张摘要卡（身份卡 / 项目信息 / 索引 / AI 会话）
// ③ 点「打开对话」⇒ 右边换成真会话面板（带 ← 摘要 可退回）
// ④ 拖一个场景 ⇒ 顺序真的变了并存下来了
//
// 用法：node dev/check-menu.mjs [--cdp 9410]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9413));
// ⚠ 路径基于脚本自己算 ⇒ 从哪个目录跑都对（原来靠 process.cwd()）。
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// ⚠ 拖拽会改写 data/scene-order.json ⇒ 收尾时**原样写回**，别把用户的顺序搅乱
const ORDER_FILE = path.join(ROOT, 'data', 'scene-order.json');
let ORDER_RAW = null;
try { ORDER_RAW = fs.readFileSync(ORDER_FILE, 'utf8'); } catch (e) { /* ignore */ }
/* 角色归属也一起兜住：落点是按像素算的，万一 CSS 变了、落点翻到上半区 ⇒
 * 拖拽会变成「排到那个分类前面」（仍不改归属）或别的模式 ⇒ 归属可能被改。
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-menu-'));
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
  async eval(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
}

const HOST = `(function(){
  var host=null;
  document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
  return host;
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
  await sleep(3500);

  console.log('① 左边是一级菜单（场景树）');
  const tree = await cdp.eval(`(function(){
    var host=${HOST};
    if (!host) return 'no-shadow';
    var leaves = host.shadowRoot.querySelectorAll('.side-leaf');
    var branches = host.shadowRoot.querySelectorAll('.side-branch-head');
    var draggable = host.shadowRoot.querySelectorAll('.side-leaf[draggable="true"]').length;
    var out=[];
    for (var i=0;i<leaves.length && i<5;i++) out.push((leaves[i].getAttribute('data-sc-id')||'?'));
    return { 角色数: leaves.length, 分类数: branches.length, 可拖的: draggable, 前几个: out };
  })()`);
  console.log('   ' + JSON.stringify(tree));

  console.log('');
  console.log('② 点一个场景 ⇒ 右边出摘要卡');
  const cards = await cdp.eval(`(function(){
    var host=${HOST};
    var leaf = host.shadowRoot.querySelector('.side-leaf');
    if (!leaf) return 'no-leaf';
    var id = leaf.getAttribute('data-sc-id');
    leaf.click();
    return id;
  })()`);
  console.log('   点了：' + cards);
  await sleep(4000);
  const cardInfo = await cdp.eval(`(function(){
    var host=${HOST};
    var titles=[]; host.shadowRoot.querySelectorAll('.panel-card-title').forEach(function(t){ titles.push(t.textContent); });
    var lines=[]; host.shadowRoot.querySelectorAll('.panel-card-line, .panel-card-empty').forEach(function(l){ lines.push(l.textContent.slice(0,34)); });
    return { 卡数: titles.length, 标题: titles, 内容行数: lines.length, 前几行: lines.slice(0,6) };
  })()`);
  console.log('   ' + JSON.stringify(cardInfo, null, 1).replace(/\\n/g, ' '));

  console.log('');
  console.log('③ 点「打开对话」⇒ 右边换成真会话');
  const chat = await cdp.eval(`(function(){
    var host=${HOST};
    var btns = host.shadowRoot.querySelectorAll('.panel-card .panel-btn');
    for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('打开对话')>=0) { btns[i].click(); return 'clicked'; } }
    return 'no-button';
  })()`);
  console.log('   ' + chat);
  await sleep(12000);
  const chatInfo = await cdp.eval(`(function(){
    var host=${HOST};
    var panels = host.shadowRoot.querySelectorAll('.cat-main .panel').length;
    var iframes = host.shadowRoot.querySelectorAll('.cat-main iframe').length;
    var cardsLeft = host.shadowRoot.querySelectorAll('.panel-card').length;
    var diag = host.shadowRoot.querySelector('.panel-diag');
    var back = host.shadowRoot.querySelectorAll('.cat-main-head .panel-btn');
    return { 面板数: panels, iframe数: iframes, 摘要卡还在吗: cardsLeft,
             钉住状态: diag ? diag.textContent : '(无)',
             有返回按钮: back.length > 0 };
  })()`);
  console.log('   ' + JSON.stringify(chatInfo));

  console.log('');
  await takeSnapshot();          // ⚠ 拍在第一次拖拽之前
  console.log('④ 拖一个场景 ⇒ 顺序变了并存下来');
  const before = await (await fetch('http://127.0.0.1:3080/workbench/api/scenes', { headers: { cookie: cookie() } })).json();
  const beforeIds = (before.scenes || []).map((x) => x.id);
  const dragged = await cdp.eval(`(function(){
    var host=${HOST};
    var leaves = host.shadowRoot.querySelectorAll('.side-leaf');
    if (leaves.length < 2) return 'no-leaves';
    var src = leaves[0], dst = leaves[leaves.length-1];
    var dt = new DataTransfer();
    var r = dst.getBoundingClientRect();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles:true, cancelable:true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, dataTransfer: dt, clientX:r.left+10, clientY:r.top + r.height * 0.85 }));
    var marked = dst.className.indexOf('drop-after') >= 0 ? 'drop-after' : (dst.className.indexOf('drop-before') >= 0 ? 'drop-before' : '?');
    dst.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer: dt, clientX:r.left+10, clientY:r.top + r.height * 0.85 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles:true, cancelable:true, dataTransfer: dt }));
    return src.getAttribute('data-sc-id') + ' → ' + dst.getAttribute('data-sc-id') + '（落点 ' + marked + '）';
  })()`);
  console.log('   拖了：' + dragged);
  await sleep(3500);
  const after = await (await fetch('http://127.0.0.1:3080/workbench/api/scenes', { headers: { cookie: cookie() } })).json();
  const afterIds = (after.scenes || []).map((x) => x.id);
  console.log('   之前：' + beforeIds.join(' → '));
  console.log('   之后：' + afterIds.join(' → '));
  console.log('   顺序变了？' + (JSON.stringify(beforeIds) !== JSON.stringify(afterIds) ? '✓ 变了' : '❌ 没变'));
  const saved = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8'));
  console.log('   存下来了：' + (saved.ids || []).join(' → '));

  console.log('');
  console.log('控制台报错：' + (cdp.errors.length ? '\n  ' + cdp.errors.slice(0, 4).join('\n  ') : '无'));

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    const p = path.join(ROOT, 'data', 'menu.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('截图：data/menu.png');
  }).catch(() => {});
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  // ⚠ 还原：拖拽把 data/scene-order.json 改了（归属也可能被改）⇒ 按快照原样写回
  try { await restoreSnapshot(); } catch (e) { /* ignore */ }
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
