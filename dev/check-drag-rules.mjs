#!/usr/bin/env node
// check-drag-rules.mjs —— 验拖拽的层级规则（机主定的规矩）
//
//   · 一级菜单（分类）拖 ⇒ **只能换位置**：永远是枝，成员的归属一个都不改
//   · 二级菜单（角色）拖 ⇒ 随意：
//       拖到分类标题的**上半区** ⇒ 排到那个分类前面（只换顺序，不改归属）
//       拖到分类标题的**下半区** ⇒ 加入那个分类（改归属）
//       拖到角色上/下 ⇒ 换顺序
//
// 四个用例都跑一遍，最后把数据恢复原样。
//
// 用法：node dev/check-drag-rules.mjs [--cdp 9440]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9440));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rules-'));
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
    body: b ? JSON.stringify(b) : undefined });
  return r.json();
};

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '');
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 30000); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
}

const HOST = `(function(){ var h=null; document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) h=el; }); return h; })()`;

/** 界面的树：分类 → 它的角色 */
const TREE = `(function(){
  var host=${HOST}; if(!host) return null; var out=[];
  host.shadowRoot.querySelectorAll('.side-branch').forEach(function(br){
    out.push((br.querySelector('.side-cat')||{}).textContent + ':' + Array.prototype.map.call(br.querySelectorAll('.side-leaf'), function(l){ return l.getAttribute('data-sc-id'); }).join(','));
  });
  return out;
})()`;

/** 服务端的分类字段 */
async function serverCats() {
  const r = await api('GET', '/api/scenes');
  return (r.scenes || []).map((x) => x.name + '(' + x.category + ')').join(' ');
}
const catsOf = (tree, cat) => { const row = (tree || []).find((x) => x.startsWith(cat + ':')); return row ? row.split(':')[1] : ''; };

/** 拖一下（kind: 'cat' 拖分类；'leaf' 拖角色；half: 'upper'|'lower'） */
async function drag(srcCat, dstCat, kind, half, srcLeaf) {
  const leafSel = ".side-leaf[data-sc-id=\"" + srcLeaf + "\"]";
  return cdp.eval(`(function(){
    var host=${HOST};
    var src=null, dst=null;
    host.shadowRoot.querySelectorAll('.side-branch').forEach(function(br){
      var c=(br.querySelector('.side-cat')||{}).textContent;
      if (c === '${srcCat}') src = br.querySelector('${kind === 'cat' ? ".side-branch-head" : leafSel}');
      if (c === '${dstCat}') dst = br.querySelector('.side-branch-head');
    });
    if (!src || !dst) return 'no-node';
    var dt = new DataTransfer();
    var r = dst.getBoundingClientRect();
    var y = ${half === 'lower' ? 'r.top + r.height - 2' : 'r.top + 2'};
    src.dispatchEvent(new DragEvent('dragstart', { bubbles:true, cancelable:true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, dataTransfer: dt, clientX:r.left+10, clientY:y }));
    var marked = dst.className.indexOf('drop-before')>=0 ? 'drop-before' : (dst.className.indexOf('drop-after')>=0?'drop-after':(dst.className.indexOf('drop-into')>=0?'drop-into':'?'));
    dst.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer: dt, clientX:r.left+10, clientY:y }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles:true, cancelable:true, dataTransfer: dt }));
    return marked;
  })()`);
}

let failed = 0;
let cdp;
const ok = (cond, label) => { console.log('   ' + (cond ? '✓ ' : '✗ ') + label); if (!cond) failed++; };

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
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(9000);
  await cdp.eval(`(function(){ var a=document.querySelectorAll('button,[role="button"]'); for(var i=0;i<a.length;i++){ if((a[i].getAttribute('aria-label')||'')==='工作台'){a[i].click();return 1;} } return 0; })()`);
  await sleep(3500);

  const snap = async () => ({ tree: await cdp.eval(TREE), cats: await serverCats() });
  const before = await snap();
  console.log('起始：');
  (before.tree || []).forEach((t) => console.log('   ' + t));

  // 找两个分类：一个有多个成员（当被拖的），一个有成员（当落点）
  const cats = await cdp.eval(`(function(){
    var host=${HOST}; var out=[];
    host.shadowRoot.querySelectorAll('.side-branch').forEach(function(br){
      out.push((br.querySelector('.side-cat')||{}).textContent + '|' + br.querySelectorAll('.side-leaf').length);
    });
    return out;
  })()`);
  const catA = cats.filter((c) => parseInt(c.split('|')[1], 10) > 0).pop().split('|')[0];
  const catB = cats.filter((c) => parseInt(c.split('|')[1], 10) > 0)[0].split('|')[0];
  const leafInB = catsOf(before.tree, catB).split(',')[0];

  console.log('');
  console.log('【用例 1】拖分类「' + catA + '」到分类「' + catB + '」上面');
  const m1 = await drag(catA, catB, 'cat', 'upper');
  await sleep(3500);
  const s1 = await snap();
  console.log('   落点：' + m1);
  ok(m1 === 'drop-before' || m1 === 'drop-after', '落点是「换先后」（不是 into）');
  ok(catsOf(s1.tree, catA) === catsOf(before.tree, catA), '分类「' + catA + '」的成员没变（' + catsOf(s1.tree, catA) + '）');
  ok((s1.tree || []).some((t) => t.startsWith(catA + ':')), '分类「' + catA + '」还在（仍是一级菜单）');
  ok(JSON.stringify(s1.tree) !== JSON.stringify(before.tree), '顺序变了');

  console.log('');
  console.log('【用例 2】拖角色「' + leafInB + '」到分类「' + catA + '」上面（上半区）');
  const before2 = await snap();
  const m2 = await drag(catB, catA, 'leaf', 'upper', leafInB);
  await sleep(3500);
  const s2 = await snap();
  console.log('   落点：' + m2);
  ok(m2 === 'drop-before', '落点是 drop-before（只换顺序）');
  ok(catsOf(s2.tree, catB) === catsOf(before2.tree, catB), '分类「' + catB + '」的成员没变');

  console.log('');
  console.log('【用例 3】拖角色「' + leafInB + '」到分类「' + catA + '」下面（下半区）');
  const before3 = await snap();
  const m3 = await drag(catB, catA, 'leaf', 'lower', leafInB);
  await sleep(3500);
  const s3 = await snap();
  console.log('   落点：' + m3);
  ok(m3 === 'drop-into', '落点是 drop-into（加入分类）');
  ok(catsOf(s3.tree, catA).indexOf(leafInB) >= 0, '角色加入了分类「' + catA + '」');
  ok(catsOf(s3.tree, catB).indexOf(leafInB) < 0, '角色离开了分类「' + catB + '」');

  console.log('');
  console.log('【用例 4】右键菜单');
  const menu = await cdp.eval(`(function(){
    var host=${HOST};
    var leaf = host.shadowRoot.querySelector('.side-leaf');
    if (!leaf) return 'no-leaf';
    var r = leaf.getBoundingClientRect();
    leaf.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:r.left+20, clientY:r.top+8 }));
    var m = document.querySelector('.ctx-menu');
    if (!m) return '菜单没出来';
    var items=[]; m.querySelectorAll('.ctx-item').forEach(function(i){ items.push(i.textContent); });
    return items.join(' | ');
  })()`);
  console.log('   ' + menu);
  ok(String(menu).indexOf('改名') >= 0 && String(menu).indexOf('删除') >= 0, '场景菜单有「改名」和「删除」');

  // 恢复数据
  console.log('');
  console.log('（恢复测试动过的数据）');
  for (const pair of [['command', '指挥'], ['reading', '阅读'], ['work', '工作'], ['dispatch', '协作'], ['invest', '投资'], ['analysis', '分析'], ['sport', '运动'], ['ops', '运维'], ['review', '复盘'], ['llmwiki', '知识']]) {
    await api('POST', '/api/scene/category', { id: pair[0], category: pair[1] });
  }
  await api('POST', '/api/scene/order', { ids: ['command', 'reading', 'work', 'dispatch', 'invest', 'analysis', 'sport', 'ops', 'review', 'llmwiki'] });
  console.log('   ' + await serverCats());

  console.log('');
  console.log(failed ? ('✗ 有 ' + failed + ' 项没过') : '✓ 四个用例全过');
  console.log('控制台报错：' + (cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '无'));
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
