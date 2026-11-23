#!/usr/bin/env node
// diag-catdrag.mjs —— 盯着分类拖拽的每一步，看它到底做了什么
//
// 只拖**分类**，记录：落点标记 / 服务端返回 / 分类字段 / 界面树
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9430;
// ⚠ 路径基于脚本自己算 ⇒ 从哪个目录跑都对（原来靠相对路径）。
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// ⚠ 拖拽会改写 data/scene-order.json ⇒ 收尾时**原样写回**，别把用户的顺序搅乱
const ORDER_FILE = path.join(ROOT, 'data', 'scene-order.json');
let ORDER_RAW = null;
try { ORDER_RAW = fs.readFileSync(ORDER_FILE, 'utf8'); } catch (e) { /* ignore */ }
/* 角色归属也一起兜住：落点是按像素算的，万一 CSS 变了、落点翻到下半区 ⇒
 * 拖拽会变成「加入那个分类」⇒ 角色的 category 就被改了。
 * 所以不只还原顺序，归属也按快照写回。 */
let SNAP_CATS = {};      // 场景 id → 分类
async function takeSnapshot() {
  const r = await api('GET', '/api/scenes');
  (r.scenes || []).forEach((x) => { SNAP_CATS[x.id] = x.category; });
}
async function restoreSnapshot() {
  for (const id of Object.keys(SNAP_CATS)) {
    try { await api('POST', '/api/scene/category', { id, category: SNAP_CATS[id] }); } catch (e) { /* ignore */ }
  }
  try { if (ORDER_RAW !== null) fs.writeFileSync(ORDER_FILE, ORDER_RAW); } catch (e) { /* ignore */ }
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cd-'));
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--renderer-process-limit=2',
  '--js-flags=--max-old-space-size=512', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, '--window-size=1600,1000', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'engine-cookie.json'), 'utf8')).cookie || ''; } catch (e) { return ''; } };
const api = async (m, u, b) => {
  const r = await fetch('http://127.0.0.1:3080/workbench' + u, {
    method: m, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie: cookie() },
    body: b ? JSON.stringify(b) : undefined });
  return r.json();
};

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '');
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.errors.push('console.error: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 30000); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; }
}

const HOST = `(function(){ var h=null; document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) h=el; }); return h; })()`;

let cdp;
const dump = async (label) => {
  const sc = await api('GET', '/api/scenes');
  console.log('  [' + label + '] 服务端：' + (sc.scenes || []).map((x) => x.name + '(' + x.category + ')').join(' '));
  const tree = await cdp.eval(`(function(){
    var host=${HOST}; if(!host) return null;
    var out=[]; host.shadowRoot.querySelectorAll('.side-branch').forEach(function(br){
      out.push((br.querySelector('.side-cat')||{}).textContent + ':' + Array.prototype.map.call(br.querySelectorAll('.side-leaf'), function(l){ return l.getAttribute('data-sc-id'); }).join(','));
    });
    return out;
  })()`);
  console.log('  [' + label + '] 界面树：' + (tree || []).join(' | '));
};

try {
  const target = (await (async () => { for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = l.find((t) => t.type === 'page'); if (p) return p; } catch (e) {} await sleep(250); } })());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  for (const part of cookie().split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    await cdp.send('Network.setCookie', { name: part.slice(0, i), value: decodeURIComponent(part.slice(i + 1)), domain: '127.0.0.1', path: '/' });
  }
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3080/' });
  await sleep(9000);
  await cdp.eval(`(function(){ var a=document.querySelectorAll('button,[role="button"]'); for(var i=0;i<a.length;i++){ if((a[i].getAttribute('aria-label')||'')==='工作台'){a[i].click();return 1;} } return 0; })()`);
  await sleep(3500);

  await dump('拖之前');

  // 找一个有 ≥1 个成员的分类，和另一个分类
  const cats = await cdp.eval(`(function(){
    var host=${HOST}; var out=[];
    host.shadowRoot.querySelectorAll('.side-branch').forEach(function(br){
      var c=(br.querySelector('.side-cat')||{}).textContent;
      var n=br.querySelectorAll('.side-leaf').length;
      out.push(c+'|'+n);
    });
    return out;
  })()`);
  console.log('  分类（名字|成员数）：' + cats.join(' '));
  const withMembers = cats.filter((c) => parseInt(c.split('|')[1], 10) > 0);
  const srcCat = withMembers[withMembers.length - 1].split('|')[0];
  const dstCat = withMembers[0].split('|')[0];
  console.log('');
  console.log('把一个角色拖到分类「' + dstCat + '」上面（drop-before ⇒ 换顺序，不改归属）');
  await takeSnapshot();          // ⚠ 拍在第一次拖拽之前

  const info = await cdp.eval(`(function(){
    var host=${HOST};
    // ⚠ 这次拖的是**角色**（二级），落点是分类标题
    var src=null, dst=null;
    host.shadowRoot.querySelectorAll('.side-branch').forEach(function(br){
      var c=(br.querySelector('.side-cat')||{}).textContent;
      if (c === '${dstCat}') dst = br.querySelector('.side-branch-head');
    });
    // 找一个不在 dstCat 里的角色
    host.shadowRoot.querySelectorAll('.side-branch').forEach(function(br){
      if (src) return;
      var c=(br.querySelector('.side-cat')||{}).textContent;
      if (c !== '${dstCat}') src = br.querySelector('.side-leaf');
    });
    if (!src || !dst) return 'no-leaf';
    var srcId = src.getAttribute('data-sc-id');
    var dt = new DataTransfer();
    var r = dst.getBoundingClientRect();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles:true, cancelable:true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, dataTransfer: dt, clientX:r.left+10, clientY:r.top + r.height * 0.15 }));
    var marked = dst.className;
    dst.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer: dt, clientX:r.left+10, clientY:r.top + r.height * 0.15 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles:true, cancelable:true, dataTransfer: dt }));
    return '拖的是角色 ' + srcId + ' → 落点 class=' + marked;
  })()`);
  console.log('  ' + info);
  await sleep(4000);

  await dump('拖之后');
  console.log('');
  console.log('报错：' + (cdp.errors.slice(0, 3).join(' | ') || '无'));
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  // ⚠ 还原：拖拽把 data/scene-order.json 改了（归属也可能被改）⇒ 按快照原样写回
  try { await restoreSnapshot(); } catch (e) { /* ignore */ }
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
