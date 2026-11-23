#!/usr/bin/env node
// check-addcat.mjs —— 验「添加分类」这条主线
//
// ① 树底部有「＋ 新分类」
// ② 点它 ⇒ 弹对话框 ⇒ 建出一个**空分类**（计数 0，展开有「还没有角色」提示）
// ③ 分类头右键 ⇒「在这后面加分类」⇒ 插到指定位置
// ④ 分类头右键 ⇒「改分类名…」⇒ 改名
// ⑤ 分类头右键 ⇒「删掉这个分类」⇒ 删掉
// ⑥ 注册表文件（scenarios/_categories.json）跟着变
//
// 用法：node dev/check-addcat.mjs [--cdp 9412]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9412));

const REGISTRY_FILE = path.join(ROOT, 'scenarios', '_categories.json');
// ⚠ 起始的注册表原文 —— 收尾时**原样写回**。
//   原来收尾是 reorder(['生活','工作','系统']) ⇒ 分类一多就把「个人成长」「投资」这类
//   后加的分类弄丢。分类是会增减的 ⇒ 只能按「起始状态」还原，不能写死一份。
const REG_RAW = (() => { try { return fs.readFileSync(REGISTRY_FILE, 'utf8'); } catch (e) { return null; } })();
// 测试用的分类名（跑完会清掉）
const T1 = '测试分类甲';
const T2 = '测试分类乙';

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-addcat-'));
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
const registry = () => {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')).categories || []; }
  catch (e) { return []; }
};
const BASE = 'http://127.0.0.1:3080/workbench';

/** 直接打服务端的分类接口（带 cookie）—— 验服务端真相，不靠界面。 */
async function apiCat(body) {
  const res = await fetch(BASE + '/api/categories', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie() },
    body: JSON.stringify(body),
  });
  return res.json();
}
/** 场景的 category 字段（服务端真相）。 */
async function sceneCats() {
  const r = await (await fetch(BASE + '/api/scenes', { headers: { cookie: cookie() } })).json();
  const out = {};
  (r.scenes || []).forEach((s) => { out[s.id] = s.category; });
  return out;
}
/** 把某个场景挪到别的分类（服务端接口）。 */
async function setSceneCat(id, cat) {
  const res = await fetch(BASE + '/api/scene/category', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie() },
    body: JSON.stringify({ id, category: cat }),
  });
  return res.json();
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

/** 工作台挂在 DSH 的 shadow DOM 里 —— 得先找到那个宿主。 */
const HOST = `(function(){
  var host=null;
  document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
  return host;
})()`;

/** 树里所有分类分支（名字 + 计数）。 */
const BRANCHES = `(function(){
  var host=${HOST}; if(!host) return null;
  var out=[];
  host.shadowRoot.querySelectorAll('.side-branch-head').forEach(function(b){
    out.push({ 分类: b.querySelector('.side-cat').textContent, 计数: b.querySelector('.side-count').textContent });
  });
  return out;
})()`;

const pass = [];
const fail = [];
let cdp;
// ⑥ 改名测试用的两个名字（finally 要拿它们还原）
let RENAME_FROM = '';
let RENAME_TO = '';

/* ── 还原用的快照 ────────────────────────────────────────────────
 * 角色归属分类 / 场景顺序 / 分类先后 —— 全部按**测试前的真实状态**还原，
 * 不写死（写死的那份早就不符了：invest 是「投资」、review 是「个人成长」…）。
 */
let SNAP_CATS = {};      // 场景 id → 分类
let ORDER_RAW = null;    // 场景顺序原文（data/scene-order.json）
const readRaw = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const writeRaw = (p, raw) => { try { if (raw !== null) fs.writeFileSync(p, raw); } catch (e) { /* ignore */ } };

async function takeSnapshot() {
  const cats = await sceneCats();
  Object.keys(cats).forEach((id) => { SNAP_CATS[id] = cats[id]; });
  ORDER_RAW = readRaw(path.join(ROOT, 'data', 'scene-order.json'));
}

/** 把角色归属写回快照里的样子（不写死「command 是系统」这种）。 */
async function restoreSnapshot() {
  for (const id of Object.keys(SNAP_CATS)) {
    try { await apiPost('/api/scene/category', { id, category: SNAP_CATS[id] }); } catch (e) { /* ignore */ }
  }
  writeRaw(path.join(ROOT, 'data', 'scene-order.json'), ORDER_RAW);
}
function check(ok, label, detail) {
  (ok ? pass : fail).push(label);
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail ? '  → ' + detail : ''));
}

/** 在对话框里填一个值并提交。 */
async function fillAndSubmit(value) {
  return cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (!d) return 'no-dialog';
    var inp = d.querySelector('.dialog-input');
    if (!inp) return 'no-input';
    inp.value = ${JSON.stringify(value)};
    var btn = d.querySelector('.dialog-actions .chip.solid');
    if (!btn) return 'no-submit';
    btn.click();
    return 'submitted';
  })()`);
}

/** 右键点第 n 个分类头，返回菜单里各项的文字。 */
async function openCatMenu(index) {
  return cdp.eval(`(function(){
    var host=${HOST}; var sr=host.shadowRoot;
    var heads = sr.querySelectorAll('.side-branch-head');
    var h = heads[${index}];
    if (!h) return 'no-head';
    var r = h.getBoundingClientRect();
    h.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:r.left+20, clientY:r.top+8 }));
    var m = document.querySelector('.ctx-menu');
    if (!m) return 'no-menu';
    var items=[]; m.querySelectorAll('.ctx-item').forEach(function(i){ items.push(i.textContent); });
    return items.join(' | ');
  })()`);
}

/** 点右键菜单里文字含 label 的那一项。 */
async function clickMenuItem(label) {
  return cdp.eval(`(function(){
    var m = document.querySelector('.ctx-menu');
    if (!m) return 'no-menu';
    var items = m.querySelectorAll('.ctx-item');
    for (var i=0;i<items.length;i++){
      if ((items[i].textContent||'').indexOf(${JSON.stringify(label)})>=0) { items[i].click(); return 'clicked'; }
    }
    return 'not-found';
  })()`);
}

/** 让左树重画一次（切到「注册」再切回「场景」）。 */
async function refreshTree() {
  await cdp.eval(`(function(){
    var host=${HOST}; var sr=host.shadowRoot;
    var reg = sr.querySelector('.navbtn[data-mode="registry"]');
    var sc = sr.querySelector('.navbtn[data-mode="scenes"]');
    if (reg) reg.click();
    if (sc) setTimeout(function(){ sc.click(); }, 400);
    return 1;
  })()`);
  await sleep(2200);
}

/** 右键一个角色，返回菜单里的项。 */
async function openLeafMenu(sceneId) {
  return cdp.eval(`(function(){
    var host=${HOST}; var sr=host.shadowRoot;
    var leaf = sr.querySelector('.side-leaf[data-sc-id="${sceneId}"]');
    if (!leaf) return 'no-leaf';
    var r = leaf.getBoundingClientRect();
    leaf.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:r.left+20, clientY:r.top+8 }));
    var m = document.querySelector('.ctx-menu');
    if (!m) return 'no-menu';
    var items=[]; m.querySelectorAll('.ctx-item').forEach(function(i){ items.push(i.textContent); });
    return items.join(' | ');
  })()`);
}

/** 在对话框的下拉里选一项并提交。 */
async function selectInDialog(value) {
  return cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (!d) return 'no-dialog';
    var sel = d.querySelector('select.dialog-input');
    if (!sel) return 'no-select';
    var found = false;
    for (var i=0;i<sel.options.length;i++){ if (sel.options[i].value === ${JSON.stringify(value)}) found = true; }
    if (!found) return 'no-option:' + Array.prototype.map.call(sel.options, function(o){ return o.value; }).join(',');
    sel.value = ${JSON.stringify(value)};
    d.querySelector('.dialog-actions .chip.solid').click();
    return 'submitted';
  })()`);
}

try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  for (const part of cookie().split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    await cdp.send('Network.setCookie', { name: part.slice(0, i), value: decodeURIComponent(part.slice(i + 1)), domain: '127.0.0.1', path: '/' });
  }
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(8000);
  await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i=0;i<all.length;i++){ if ((all[i].getAttribute('aria-label')||'') === '工作台') { all[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(4000);

  const before = registry();
  await takeSnapshot();          // ⚠ 拍在第一次改动之前
  console.log('起始注册表：' + before.join(' / '));
  console.log('');

  console.log('① 树底部有「＋ 新分类」');
  const hasBtn = await cdp.eval(`(function(){
    var host=${HOST}; var b = host.shadowRoot.querySelector('.side-add-cat');
    return b ? b.textContent : '(没有)';
  })()`);
  console.log('   ' + hasBtn);
  check(String(hasBtn).indexOf('新分类') >= 0, '树底部有「＋ 新分类」按钮', hasBtn);

  console.log('');
  console.log('② 点「＋ 新分类」⇒ 建一个空分类');
  await cdp.eval(`(function(){ var host=${HOST}; host.shadowRoot.querySelector('.side-add-cat').click(); return 1; })()`);
  await sleep(1200);
  const dlg = await cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (!d) return '(对话框没出来)';
    return (d.querySelector('h3')||{}).textContent || '(无标题)';
  })()`);
  console.log('   对话框：' + dlg);
  check(String(dlg).indexOf('分类') >= 0, '弹出了建分类的对话框', dlg);
  const sub = await fillAndSubmit(T1);
  console.log('   提交：' + sub);
  await sleep(2500);
  const branches = await cdp.eval(BRANCHES);
  console.log('   ' + JSON.stringify(branches));
  const b1 = (branches || []).filter((b) => b.分类 === T1)[0];
  check(!!b1, '新分类出现在树里', T1);
  check(b1 && b1.计数 === '0', '新分类是空的（计数 0）', b1 && b1.计数);
  const emptyNote = await cdp.eval(`(function(){
    var host=${HOST};
    var heads = host.shadowRoot.querySelectorAll('.side-branch-head');
    for (var i=0;i<heads.length;i++){
      if (heads[i].querySelector('.side-cat').textContent === ${JSON.stringify(T1)}) {
        var br = heads[i].parentNode;
        var n = br.querySelector('.side-kids-empty');
        return n ? n.textContent : '(没有提示行)';
      }
    }
    return '(找不到这个分类)';
  })()`);
  console.log('   空分类提示：' + emptyNote);
  check(String(emptyNote).indexOf('还没有角色') >= 0, '展开后有「这个分类还没有角色」', emptyNote);
  check(registry().indexOf(T1) >= 0, '注册表文件里有它了', registry().join(' / '));

  console.log('');
  console.log('③ 分类头右键 ⇒「在这后面加分类」');
  const menu = await openCatMenu((branches || []).findIndex((b) => b.分类 === T1));
  console.log('   菜单：' + menu);
  check(String(menu).indexOf('在这后面加分类') >= 0, '右键菜单里有「在这后面加分类」', menu);
  await clickMenuItem('在这后面加分类');
  await sleep(1200);
  const dlg2 = await cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (!d) return '(对话框没出来)';
    return (d.querySelector('h3')||{}).textContent || '(无标题)';
  })()`);
  console.log('   对话框：' + dlg2);
  check(String(dlg2).indexOf(T1) >= 0, '标题里点名了插在谁后面', dlg2);
  await fillAndSubmit(T2);
  await sleep(2500);
  const reg2 = registry();
  console.log('   注册表：' + reg2.join(' / '));
  const i1 = reg2.indexOf(T1);
  const i2 = reg2.indexOf(T2);
  check(i1 >= 0 && i2 === i1 + 1, '插到了「' + T1 + '」的正后面', reg2.join(' / '));

  console.log('');
  console.log('④ 右键 ⇒「改分类名…」');
  const menu2 = await openCatMenu((await cdp.eval(BRANCHES)).findIndex((b) => b.分类 === T1));
  await clickMenuItem('改分类名');
  await sleep(1200);
  const T1b = T1 + '改';
  await fillAndSubmit(T1b);
  await sleep(2500);
  const reg3 = registry();
  console.log('   注册表：' + reg3.join(' / '));
  check(reg3.indexOf(T1b) >= 0 && reg3.indexOf(T1) < 0, '改名生效', reg3.join(' / '));

  console.log('');
  console.log('⑤ 右键 ⇒「删掉这个分类」');
  const menu3 = await openCatMenu((await cdp.eval(BRANCHES)).findIndex((b) => b.分类 === T1b));
  await clickMenuItem('删掉这个分类');
  await sleep(1200);
  const dlg3 = await cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (!d) return '(对话框没出来)';
    return (d.querySelector('h3')||{}).textContent || '(无标题)';
  })()`);
  console.log('   对话框：' + dlg3);
  check(String(dlg3).indexOf('删掉分类') >= 0, '弹出了删分类的确认框', dlg3);
  await cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    d.querySelector('.dialog-actions .chip.solid').click();
    return 1;
  })()`);
  await sleep(2500);
  const reg4 = registry();
  console.log('   注册表：' + reg4.join(' / '));
  check(reg4.indexOf(T1b) < 0, '分类删掉了', reg4.join(' / '));

  console.log('');
  console.log('⑥ 改名（有成员的分类）⇒ 底下角色的 category 跟着改');
  const catsBefore = await sceneCats();
  // 拿一个有成员的分类来试 —— 成员是动态的，别写死「生活」有几个成员
  const LIVE = Object.keys(catsBefore)
    .map((k) => catsBefore[k])
    .filter((c, i, a) => a.indexOf(c) === i && c !== '未分类')
    .find((c) => Object.keys(catsBefore).filter((k) => catsBefore[k] === c).length > 0);
  const T3 = LIVE + '改名测试';
  RENAME_FROM = LIVE;
  RENAME_TO = T3;
  const members = Object.keys(catsBefore).filter((k) => catsBefore[k] === LIVE);
  console.log('   「' + LIVE + '」的成员：' + members.join('、'));
  check(members.length > 0, '拿一个有成员的分类来试', members.join('、'));
  await openCatMenu((await cdp.eval(BRANCHES)).findIndex((b) => b.分类 === LIVE));
  await clickMenuItem('改分类名');
  await sleep(1000);
  await fillAndSubmit(T3);
  await sleep(2500);
  const catsRenamed = await sceneCats();
  const renamed = members.filter((k) => catsRenamed[k] === T3);
  console.log('   改名后：' + members.map((k) => k + '=' + catsRenamed[k]).join(' '));
  check(members.length > 0 && renamed.length === members.length,
    '底下的角色 category 跟着改了（' + renamed.length + '/' + members.length + '）');
  const brRenamed = (await cdp.eval(BRANCHES)).filter((b) => b.分类 === T3)[0];
  check(!!brRenamed && brRenamed.计数 === String(members.length),
    '树上还是这几个人（挂在新名字下）', brRenamed && brRenamed.计数);
  // 改回去
  await openCatMenu((await cdp.eval(BRANCHES)).findIndex((b) => b.分类 === T3));
  await clickMenuItem('改分类名');
  await sleep(1000);
  await fillAndSubmit(LIVE);
  await sleep(2500);
  const catsBack = await sceneCats();
  check(members.every((k) => catsBack[k] === LIVE), '改回去了（角色的 category 也回来了）',
    members.map((k) => k + '=' + catsBack[k]).join(' '));

  console.log('');
  console.log('⑦ 删有成员的分类 ⇒ 成员移到「未分类」');
  const T4 = '测试删除';
  // 先建一个空分类（走 UI，动作会刷新数据）
  await cdp.eval(`(function(){ var host=${HOST}; host.shadowRoot.querySelector('.side-add-cat').click(); return 1; })()`);
  await sleep(1000);
  await fillAndSubmit(T4);
  await sleep(2500);
  // 再把「命令」挪进去（用「换分类…」—— 空分类也得能在下拉里选到）
  const leafMenu = await openLeafMenu('command');
  console.log('   角色右键菜单：' + leafMenu);
  await clickMenuItem('换分类');
  await sleep(1200);
  const selRes = await selectInDialog(T4);
  console.log('   下拉里选「' + T4 + '」：' + selRes);
  check(selRes === 'submitted', '下拉框里能选到刚建的空分类', selRes);
  await sleep(2500);
  const brT4 = (await cdp.eval(BRANCHES)).filter((b) => b.分类 === T4)[0];
  check(!!brT4 && brT4.计数 === '1', '「' + T4 + '」里有 1 个角色', brT4 && brT4.计数);
  // 删掉它
  await openCatMenu((await cdp.eval(BRANCHES)).findIndex((b) => b.分类 === T4));
  await clickMenuItem('删掉这个分类');
  await sleep(1000);
  await cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (d) d.querySelector('.dialog-actions .chip.solid').click();
    return 1;
  })()`);
  await sleep(2500);
  const catsAfterDel = await sceneCats();
  console.log('   command 的 category：' + catsAfterDel.command);
  check(catsAfterDel.command === '未分类', '成员移到「未分类」', catsAfterDel.command);
  check(!(await cdp.eval(BRANCHES)).some((b) => b.分类 === T4), '分类从树上没了');
  // 恢复：把「命令」换回它**原来**的分类（快照里的，不是写死的「系统」），再把「未分类」这个空分类删掉
  await openLeafMenu('command');
  await clickMenuItem('换分类');
  await sleep(1200);
  await selectInDialog(SNAP_CATS.command || '系统');
  await sleep(2500);
  const hasUncat = (await cdp.eval(BRANCHES)).some((b) => b.分类 === '未分类');
  if (hasUncat) {
    await openCatMenu((await cdp.eval(BRANCHES)).findIndex((b) => b.分类 === '未分类'));
    await clickMenuItem('删掉这个分类');
    await sleep(1000);
    await cdp.eval(`(function(){
      var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
      if (d) d.querySelector('.dialog-actions .chip.solid').click();
      return 1;
    })()`);
    await sleep(2500);
  }
  const catsRestored = await sceneCats();
  check(catsRestored.command === (SNAP_CATS.command || '系统'), '恢复：command 回到原来的分类', catsRestored.command);

  console.log('');
  console.log('⑧ 建重名 ⇒ 报错，不建');
  await cdp.eval(`(function(){ var host=${HOST}; host.shadowRoot.querySelector('.side-add-cat').click(); return 1; })()`);
  await sleep(1000);
  await fillAndSubmit(LIVE);
  await sleep(2000);
  const errMsg = await cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (!d) return '(对话框关了)';
    var m = d.querySelector('.dialog-msg');
    return m ? m.textContent : '(没有提示)';
  })()`);
  console.log('   提示：' + errMsg);
  check(String(errMsg).indexOf('已经有这个分类') >= 0, '重名被挡住了', errMsg);
  await cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (d) d.querySelector('.dialog-actions .chip').click();   // 取消
    return 1;
  })()`);
  await sleep(800);

  console.log('');
  console.log('⑨ 收尾：删掉另一个测试分类，注册表回到原样');
  await openCatMenu((await cdp.eval(BRANCHES)).findIndex((b) => b.分类 === T2));
  await clickMenuItem('删掉这个分类');
  await sleep(1000);
  await cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (d) d.querySelector('.dialog-actions .chip.solid').click();
    return 1;
  })()`);
  await sleep(2500);
  const regEnd = registry();
  console.log('   最后注册表：' + regEnd.join(' / '));
  check(regEnd.indexOf(T1) < 0 && regEnd.indexOf(T2) < 0 && regEnd.indexOf(T1b) < 0
    && regEnd.indexOf(T3) < 0 && regEnd.indexOf(T4) < 0 && regEnd.indexOf('未分类') < 0,
    '测试分类都清干净了', regEnd.join(' / '));
  check(JSON.stringify(regEnd) === JSON.stringify(before), '注册表回到起始状态', regEnd.join(' / '));
  const catsFinal = await sceneCats();
  const sameAsStart = Object.keys(catsBefore).every((k) => catsFinal[k] === catsBefore[k]);
  check(sameAsStart, '每个角色的 category 都回到原样',
    Object.keys(catsBefore).map((k) => k + '=' + catsFinal[k]).join(' '));

  console.log('');
  console.log('控制台报错：' + (cdp.errors.length ? '\n  ' + cdp.errors.slice(0, 4).join('\n  ') : '无'));
  console.log('');
  console.log('通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
  if (fail.length) fail.forEach(f => console.log('  ✗ ' + f));
  process.exitCode = fail.length ? 1 : 0;
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  // ⚠ 安全网：测试中途挂了 ⇒ 把动过的分类/角色恢复回去，别留脏数据
  try {
    const reg = registry();
    if (RENAME_TO && reg.indexOf(RENAME_TO) >= 0) await apiCat({ op: 'rename', name: RENAME_TO, newName: RENAME_FROM });
    if (reg.indexOf('测试删除') >= 0) await apiCat({ op: 'delete', name: '测试删除' });
  } catch (e) { /* ignore */ }
  // ⚠ 角色归属按**快照**写回（原来写死 command=系统，换套数据就错；
  //   而且 ⑥ 改名中途夭折的话，成员会停在「XX改名测试」上没人还原）
  try { await restoreSnapshot(); } catch (e) { /* ignore */ }
  // ⚠ 注册表**原样写回**（最后一步，覆盖上面 API 清理留下的痕迹）
  //   原来这里写死 reorder(['生活','工作','系统']) ⇒ 分类一多就丢「个人成长」「投资」。
  try {
    if (REG_RAW !== null && fs.readFileSync(REGISTRY_FILE, 'utf8') !== REG_RAW) {
      fs.writeFileSync(REGISTRY_FILE, REG_RAW);
      console.log('   （注册表已还原成起始状态）');
    }
  } catch (e) { /* ignore */ }
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
