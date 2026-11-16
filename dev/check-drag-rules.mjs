#!/usr/bin/env node
// check-drag-rules.mjs —— 验拖拽的层级规则
//
// ⛔ 机主定的规矩：
//   · 一级菜单（分类）拖 ⇒ **只能换位置**，永远是枝，不会变成别人的二级菜单
//   · 二级菜单（角色）拖 ⇒ 随意（落分类上 = 加入；落角色上 = 换顺序）
//
// 验三件事：
//   ① 拖分类到另一个分类上 ⇒ 分类换位置，**成员归属不变**
//   ② 拖分类 ⇒ 它还是一级菜单（还在分类行里，不是别人的子项）
//   ③ 拖角色到分类上 ⇒ 角色换分类（这才是「二级可以随意」）
//
// 用法：node dev/check-drag-rules.mjs [--cdp 9420]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9420));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-drag-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--renderer-process-limit=2',
  '--js-flags=--max-old-space-size=512', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, '--window-size=1600,1000', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = () => { try { return JSON.parse(fs.readFileSync('data/engine-cookie.json', 'utf8')).cookie || ''; } catch (e) { return ''; } };
const api = async (m, u, b) => {
  const r = await fetch('http://127.0.0.1:3080/workbench' + u, {
    method: m, headers: { ...(b ? { 'content-type': 'application/json' } : {}), cookie: cookie() },
    body: b ? JSON.stringify(b) : undefined,
  });
  return r.json();
};

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails?.exception?.description || '');
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 30000); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
}

const HOST = `(function(){ var h=null; document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) h=el; }); return h; })()`;

/** 从界面上读出「树长什么样」：每个分类 + 它下面有哪些角色。 */
const READ_TREE = `(function(){
  var host=${HOST};
  if (!host) return null;
  var out=[];
  host.shadowRoot.querySelectorAll('.side-branch').forEach(function(br){
    var cat = (br.querySelector('.side-cat')||{}).textContent;
    var kids=[];
    br.querySelectorAll('.side-leaf').forEach(function(lf){ kids.push(lf.getAttribute('data-sc-id')); });
    out.push(cat + ':' + kids.join(','));
  });
  return out;
})()`;

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
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(9000);
  await cdp.eval(`(function(){ var a=document.querySelectorAll('button,[role="button"]'); for(var i=0;i<a.length;i++){ if((a[i].getAttribute('aria-label')||'')==='工作台'){a[i].click();return 1;} } return 0; })()`);
  await sleep(3500);

  console.log('① 拖之前的树');
  const before = await cdp.eval(READ_TREE);
  (before || []).forEach((t) => console.log('   ' + t));

  // 找两个都有成员的分类
  const cats = (before || []).map((t) => t.split(':')[0]).filter((c) => (before.find((x) => x.startsWith(c + ':')) || '').split(':')[1]);
  // 拖「最后一个分类」到「第一个分类」前面 ⇒ 位置必须真的变
  const catA = cats[cats.length - 1];
  const catB = cats[0];
  if (!catA || !catB) { console.log('   （分类不足两个，跳过）'); process.exit(0); }
  console.log('');
  console.log('② 把分类「' + catA + '」拖到分类「' + catB + '」上面（换位置，不该改归属）');

  const dragInfo = await cdp.eval(`(function(){
    var host=${HOST};
    var branches = host.shadowRoot.querySelectorAll('.side-branch');
    var src=null, dst=null;
    for (var i=0;i<branches.length;i++){
      var c=(branches[i].querySelector('.side-cat')||{}).textContent;
      if (c === '${catA}') src = branches[i].querySelector('.side-branch-head');
      if (c === '${catB}') dst = branches[i].querySelector('.side-branch-head');
    }
    if (!src || !dst) return 'no-branch';
    var dt = new DataTransfer();
    var r = dst.getBoundingClientRect();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles:true, cancelable:true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, dataTransfer: dt, clientX:r.left+10, clientY:r.top+2 }));
    var marked = dst.className.indexOf('drop-before')>=0 ? 'drop-before' : (dst.className.indexOf('drop-after')>=0?'drop-after':(dst.className.indexOf('drop-into')>=0?'drop-into':'?'));
    dst.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer: dt, clientX:r.left+10, clientY:r.top+2 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles:true, cancelable:true, dataTransfer: dt }));
    return '落点标记=' + marked;
  })()`);
  console.log('   ' + dragInfo);
  await sleep(3500);

  console.log('');
  console.log('③ 拖之后的树');
  const after = await cdp.eval(READ_TREE);
  (after || []).forEach((t) => console.log('   ' + t));

  console.log('');
  // 判据：分类还在（还是一级）、成员归属没变
  const membersOf = (tree, cat) => { const row = (tree || []).find((x) => x.startsWith(cat + ':')); return row ? row.split(':')[1] : ''; };
  const mA_before = membersOf(before, catA);
  const mA_after = membersOf(after, catA);
  const stillThere = (after || []).some((t) => t.startsWith(catA + ':'));
  console.log('   分类「' + catA + '」还在吗？' + (stillThere ? '✓ 还在（仍是一级菜单）' : '❌ 没了（被降级了！）'));
  console.log('   成员归属没变？' + (mA_before === mA_after ? '✓ 没变（' + mA_after + '）' : '❌ 变了：' + mA_before + ' → ' + mA_after));
  const orderChanged = JSON.stringify(before) !== JSON.stringify(after);
  console.log('   顺序变了？' + (orderChanged ? '✓ 变了' : '❌ 没变'));

  // ③b 二级菜单（角色）拖 ⇒ 随意：拖到别的分类下 ⇒ 归属要变
  console.log('');
  console.log('③b 把角色拖到另一个分类下（这才是「二级可以随意」）');
  const moveRole = await cdp.eval(`(function(){
    var host=${HOST};
    var leaves = host.shadowRoot.querySelectorAll('.side-leaf');
    if (!leaves.length) return 'no-leaves';
    var src = leaves[0];
    var srcId = src.getAttribute('data-sc-id');
    var branches = host.shadowRoot.querySelectorAll('.side-branch-head');
    if (branches.length < 2) return 'no-branches';
    var dst = branches[1];
    var dt = new DataTransfer();
    var r = dst.getBoundingClientRect();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles:true, cancelable:true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, dataTransfer: dt, clientX:r.left+10, clientY:r.top+5 }));
    var marked = dst.className.indexOf('drop-into')>=0 ? 'drop-into' : '其它';
    dst.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer: dt, clientX:r.left+10, clientY:r.top+5 }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles:true, cancelable:true, dataTransfer: dt }));
    return srcId + ' → 落点 ' + marked;
  })()`);
  console.log('   ' + moveRole);
  await sleep(3500);
  const after2 = await cdp.eval(READ_TREE);
  (after2 || []).forEach((t) => console.log('   ' + t));

  // 服务端也看一眼分类字段
  const sc = await api('GET', '/api/scenes');
  const cats2 = (sc.scenes || []).map((x) => x.name + '(' + x.category + ')');
  console.log('   服务端分类字段：' + cats2.join(' '));

  // ④ 右键菜单
  console.log('');
  console.log('④ 右键菜单');
  const menu = await cdp.eval(`(function(){
    var host=${HOST};
    var leaf = host.shadowRoot.querySelector('.side-leaf');
    if (!leaf) return 'no-leaf';
    var r = leaf.getBoundingClientRect();
    leaf.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:r.left+20, clientY:r.top+8 }));
    var m = document.querySelector('.ctx-menu');
    if (!m) return '菜单没出来';
    var items=[]; m.querySelectorAll('.ctx-item').forEach(function(i){ items.push(i.textContent); });
    return { 菜单项: items, 位置: m.style.left + ',' + m.style.top };
  })()`);
  console.log('   ' + JSON.stringify(menu));

  const rename = await cdp.eval(`(function(){
    var m = document.querySelector('.ctx-menu');
    if (!m) return 'no-menu';
    var btns = m.querySelectorAll('.ctx-item');
    for (var i=0;i<btns.length;i++){ if (btns[i].textContent.indexOf('改名')>=0) { btns[i].click(); return 'clicked'; } }
    return 'no-rename';
  })()`);
  console.log('   点改名：' + rename);
  await sleep(1200);
  const dlg = await cdp.eval(`(function(){
    var host=${HOST};
    var d = host && host.shadowRoot.querySelector('.dialog.open');
    if (!d) return 'no-dialog';
    return { 标题:(d.querySelector('h3')||{}).textContent, 输入框值:(d.querySelector('.dialog-input')||{}).value };
  })()`);
  console.log('   对话框：' + JSON.stringify(dlg));
  // 取消，不真改名
  await cdp.eval(`(function(){
    var host=${HOST};
    var d = host && host.shadowRoot.querySelector('.dialog.open');
    if (!d) return;
    var btns = d.querySelectorAll('.dialog-actions .chip');
    for (var i=0;i<btns.length;i++){ if (btns[i].textContent.indexOf('取消')>=0) { btns[i].click(); return; } }
  })()`);

  // ⑤ 分类的右键菜单
  console.log('');
  console.log('⑤ 分类的右键菜单');
  const catMenu = await cdp.eval(`(function(){
    var host=${HOST};
    var head = host.shadowRoot.querySelector('.side-branch-head');
    if (!head) return 'no-head';
    var r = head.getBoundingClientRect();
    head.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:r.left+20, clientY:r.top+5 }));
    var m = document.querySelector('.ctx-menu');
    if (!m) return '菜单没出来';
    var items=[]; m.querySelectorAll('.ctx-item').forEach(function(i){ items.push(i.textContent); });
    var st = document.getElementById('wb-menu-style');
    return { 菜单项: items, 样式注入了: !!st, 背景色: m ? getComputedStyle(m).backgroundColor : '?' };
  })()`);
  console.log('   ' + JSON.stringify(catMenu));
  await cdp.eval(`(function(){ var m=document.querySelector('.ctx-menu'); if(m){ var b=m.querySelectorAll('.ctx-item'); for(var i=0;i<b.length;i++){ if(b[i].textContent.indexOf('取消')>=0){b[i].click();return;} } } })()`);

  // 截一张带菜单的图
  await cdp.eval(`(function(){
    var host=${HOST};
    var head = host.shadowRoot.querySelector('.side-branch-head');
    if (!head) return;
    var r = head.getBoundingClientRect();
    head.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:r.left+30, clientY:r.top+8 }));
  })()`);
  await sleep(600);
  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    fs.writeFileSync(path.join(process.cwd(), 'data', 'ctxmenu.png'), Buffer.from(r.data, 'base64'));
    console.log('截图：data/ctxmenu.png');
  }).catch(() => {});

  console.log('');
  console.log('控制台报错：' + (cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '无'));
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
