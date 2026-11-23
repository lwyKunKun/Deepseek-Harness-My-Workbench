#!/usr/bin/env node
// check-registry.mjs —— 验「注册页」这条主线
//
// ① 已登记名单按分类分组（分组名 + 数量徽章 + 组里的角色）
// ② 分组顺序跟场景页左树一致（两边同一套 groupByCategory）
// ③ 分类字段是下拉，选项来自分类注册表（不是手输）
// ④ 选「＋ 新建分类…」⇒ 弹框 ⇒ 建出新分类 ⇒ 下拉里出现并选中它
// ⑤ 登记一个新角色 ⇒ 归到选中的分类 ⇒ 出现在那个分组里
// ⑥ 登记成功后 ⇒ 分类留在原地、成功提示看得见（登记会重画整个表单）
// ⑦ 取消「＋ 新建分类…」⇒ 用户原来选的分类不动
// ⑧ 收尾：删掉测试角色和测试分类，注册表回到原样
//
// 用法：node dev/check-registry.mjs [--cdp 9411]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9411));

const REGISTRY_FILE = path.join(ROOT, 'scenarios', '_categories.json');
// 起始的注册表 / 场景顺序原文 —— 收尾时原样写回。
//   删分类时服务端会把成员移到「未分类」，那个分类会跟着进注册表 ⇒ 收尾必须还原。
let REG_RAW = null;
let ORDER_RAW = null;
try { REG_RAW = fs.readFileSync(REGISTRY_FILE, 'utf8'); } catch (e) { /* ignore */ }
try { ORDER_RAW = fs.readFileSync(path.join(ROOT, 'data', 'scene-order.json'), 'utf8'); } catch (e) { /* ignore */ }
// 测试用的名字（跑完会清掉）
const TCAT = '测试分类丙';
const TROLE = '测试角色丙';

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-registry-'));
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

async function apiPost(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie() },
    body: JSON.stringify(body),
  });
  return res.json();
}
/** 服务端真相：每个角色的 category。 */
async function sceneCats() {
  const r = await (await fetch(BASE + '/api/scenes', { headers: { cookie: cookie() } })).json();
  const out = {};
  (r.scenes || []).forEach((s) => { out[s.id] = s.category; });
  return out;
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

/** 注册页的分组（分类名 + 计数 + 组里的角色）。 */
const GROUPS = `(function(){
  var host=${HOST}; if(!host) return null;
  var out=[];
  host.shadowRoot.querySelectorAll('.reg-group').forEach(function(g){
    var names=[];
    g.querySelectorAll('.reg-row .reg-name').forEach(function(n){ names.push(n.textContent); });
    var badge=g.querySelector('.side-count');
    out.push({ 分类: g.querySelector('.reg-group-name').textContent,
               计数: badge ? badge.textContent : '(没有徽章)',
               角色: names });
  });
  return out;
})()`;

/** 场景页左树的分类（名字 + 计数）。 */
const BRANCHES = `(function(){
  var host=${HOST}; if(!host) return null;
  var out=[];
  host.shadowRoot.querySelectorAll('.side-branch-head').forEach(function(b){
    out.push({ 分类: b.querySelector('.side-cat').textContent, 计数: b.querySelector('.side-count').textContent });
  });
  return out;
})()`;

/** 分类下拉的选项（value）。 */
const CAT_OPTIONS = `(function(){
  var host=${HOST}; if(!host) return null;
  var s=host.shadowRoot.querySelector('.reg-form select');
  if(!s) return null;
  return { 选项: Array.prototype.map.call(s.options, function(o){ return o.value; }), 当前: s.value };
})()`;

const pass = [];
const fail = [];
let cdp;
function check(ok, label, detail) {
  (ok ? pass : fail).push(label);
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail ? '  → ' + detail : ''));
}

async function gotoTab(mode) {
  await cdp.eval(`(function(){
    var host=${HOST}; var b=host.shadowRoot.querySelector('.navbtn[data-mode="${mode}"]');
    if (b) b.click();
    return 1;
  })()`);
  await sleep(1500);
}

/** 在对话框里填一个值并提交。 */
async function fillAndSubmit(value) {
  return cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (!d) return 'no-dialog';
    var inp = d.querySelector('.dialog-input');
    if (!inp) return 'no-input';
    inp.value = ${JSON.stringify(value)};
    d.querySelector('.dialog-actions .chip.solid').click();
    return 'submitted';
  })()`);
}

/** 让注册页的下拉选中某个值，并触发 change。 */
async function pickCat(value) {
  return cdp.eval(`(function(){
    var host=${HOST}; var s = host.shadowRoot.querySelector('.reg-form select');
    if (!s) return 'no-select';
    var found=false;
    for (var i=0;i<s.options.length;i++){ if (s.options[i].value === ${JSON.stringify(value)}) found=true; }
    if (!found) return 'no-option';
    s.value = ${JSON.stringify(value)};
    s.dispatchEvent(new Event('change', { bubbles:true }));
    return 'picked';
  })()`);
}

/** 填登记表单里的普通输入框（按 label 顺序：名字 / 图标 / 职责 / 技能）。 */
async function fillRoleForm(name, duty) {
  return cdp.eval(`(function(){
    var host=${HOST}; var form=host.shadowRoot.querySelector('.reg-form');
    if (!form) return 'no-form';
    var inputs=form.querySelectorAll('input.disp-input');
    if (inputs.length < 3) return 'no-inputs:'+inputs.length;
    inputs[0].value = ${JSON.stringify(name)};
    inputs[2].value = ${JSON.stringify(duty)};
    return 'filled';
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

/** 在对话框里点确认。 */
async function confirmDialog() {
  return cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (!d) return 'no-dialog';
    d.querySelector('.dialog-actions .chip.solid').click();
    return 'confirmed';
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
  console.log('起始注册表：' + before.join(' / '));
  console.log('');

  console.log('① 注册页的名单按分类分组');
  await gotoTab('registry');
  const groups = await cdp.eval(GROUPS);
  console.log('   ' + JSON.stringify(groups));
  check(!!groups && groups.length >= 2, '名单分成了几个组', groups && groups.length);
  const badCount = (groups || []).filter((g) => g.计数 !== String(g.角色.length));
  check(badCount.length === 0, '每组的徽章数 = 组里的角色数',
    badCount.map((g) => g.分类 + ':' + g.计数 + '/' + g.角色.length).join(' '));
  const flat = (groups || []).reduce((n, g) => n + g.角色.length, 0);
  const totalScenes = Object.keys(await sceneCats()).length;
  check(flat === totalScenes, '所有角色都在名单里（没漏）', flat + '/' + totalScenes);

  console.log('');
  console.log('② 分组顺序跟场景页左树一致');
  await gotoTab('scenes');
  const branches = await cdp.eval(BRANCHES);
  const treeOrder = (branches || []).filter((b) => Number(b.计数) > 0).map((b) => b.分类);
  const groupOrder = (groups || []).map((g) => g.分类);
  console.log('   树：' + treeOrder.join(' / '));
  console.log('   组：' + groupOrder.join(' / '));
  check(JSON.stringify(treeOrder) === JSON.stringify(groupOrder), '两边顺序一模一样', groupOrder.join(' / '));

  console.log('');
  console.log('③ 分类字段是下拉，选项来自分类注册表');
  await gotoTab('registry');
  const opts = await cdp.eval(CAT_OPTIONS);
  console.log('   ' + JSON.stringify(opts));
  check(!!opts, '登记表单里有个下拉', opts ? '有' : '没有');
  const missing = before.filter((c) => !(opts && opts.选项 || []).includes(c));
  check(missing.length === 0, '注册表里的分类都在下拉里', missing.join(' '));
  check(opts && (opts.选项 || []).includes('__new__'), '下拉最后有「＋ 新建分类…」', opts && opts.选项 && opts.选项[opts.选项.length - 1]);
  check(!(opts && opts.选项 || []).includes(''), '下拉里没有空值项（手输的口子堵上了）');

  console.log('');
  console.log('④ 选「＋ 新建分类…」⇒ 建出来并自动选中');
  const picked = await pickCat('__new__');
  console.log('   选中：' + picked);
  await sleep(1200);
  const dlg = await cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (!d) return '(对话框没出来)';
    return (d.querySelector('h3')||{}).textContent || '(无标题)';
  })()`);
  console.log('   对话框：' + dlg);
  check(String(dlg).indexOf('分类') >= 0, '弹出了建分类的对话框', dlg);
  const sub = await fillAndSubmit(TCAT);
  console.log('   提交：' + sub);
  await sleep(2500);
  const opts2 = await cdp.eval(CAT_OPTIONS);
  console.log('   ' + JSON.stringify(opts2));
  check(opts2 && (opts2.选项 || []).includes(TCAT), '新分类进了下拉', opts2 && (opts2.选项 || []).join(' '));
  check(opts2 && opts2.当前 === TCAT, '新分类被自动选中', opts2 && opts2.当前);
  check(registry().indexOf(TCAT) >= 0, '注册表文件里有它了', registry().join(' / '));

  console.log('');
  console.log('④ ½ 切走再切回 ⇒ 下拉还停在新分类（选中的分类得记住）');
  await gotoTab('scenes');
  await gotoTab('registry');
  const optsBack = await cdp.eval(CAT_OPTIONS);
  console.log('   ' + JSON.stringify(optsBack));
  check(optsBack && optsBack.当前 === TCAT, '切走再回来，选中的分类没丢', optsBack && optsBack.当前);

  console.log('');
  console.log('⑤ 登记一个角色 ⇒ 归到选中的分类');
  const filled = await fillRoleForm(TROLE, '测试用的角色，跑完就删');
  console.log('   表单：' + filled);
  await cdp.eval(`(function(){
    var host=${HOST}; var form=host.shadowRoot.querySelector('.reg-form');
    var btns=form.querySelectorAll('button');
    for (var i=0;i<btns.length;i++){ if (btns[i].textContent === '登记') { btns[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(3500);
  const cats = await sceneCats();
  const created = Object.keys(cats).filter((k) => cats[k] === TCAT);
  console.log('   归到「' + TCAT + '」的角色：' + (created.join('、') || '(没有)'));
  check(created.length === 1, '新角色落在选中的分类里', created.join(' '));
  const groups2 = await cdp.eval(GROUPS);
  const g2 = (groups2 || []).filter((g) => g.分类 === TCAT)[0];
  console.log('   ' + JSON.stringify(g2));
  check(!!g2 && g2.角色.length === 1, '名单里「' + TCAT + '」这一组出现了它', g2 && g2.角色.join(' '));

  console.log('');
  console.log('⑥ 登记成功后 ⇒ 分类留在原地、成功提示看得见');
  // ⚠ 登记成功会 refreshScenes() 重画整个注册页 ⇒ 下拉和提示都是新节点，
  //   重画前没记住的话：下拉跳回默认分类、提示直接消失。
  const after = await cdp.eval(CAT_OPTIONS);
  console.log('   ' + JSON.stringify(after));
  check(after && after.当前 === TCAT, '登记成功后下拉还停在登记时选的分类', after && after.当前);
  const tip = await cdp.eval(`(function(){
    var host=${HOST}; var m=host.shadowRoot.querySelector('.reg-form .disp-msg');
    if (!m) return { 文案:'(没有提示节点)', 类名:'' };
    return { 文案: m.textContent, 类名: m.className };
  })()`);
  console.log('   提示：' + JSON.stringify(tip));
  check(String(tip.文案 || '').indexOf('登记好了') >= 0, '成功提示还在（重画后没丢）', tip.文案);
  check(String(tip.类名 || '').indexOf('ok') >= 0, '提示是「成功」样式', tip.类名);

  console.log('');
  console.log('⑦ 取消「＋ 新建分类…」⇒ 用户原来选的分类不动');
  // 挑一个**不是默认分类**的来试 —— 默认是「工作」，用它测不出「被改成默认那个」这个 bug
  const otherCat = ((opts2 && opts2.选项) || []).filter((c) => c !== '__new__' && c !== '工作')[0];
  console.log('   拿「' + otherCat + '」来试');
  const pre = await pickCat(otherCat);
  console.log('   先选到它：' + pre);
  await sleep(600);
  await pickCat('__new__');
  await sleep(1200);
  const cancelled = await cdp.eval(`(function(){
    var host=${HOST}; var d = host.shadowRoot.querySelector('.dialog.open');
    if (!d) return 'no-dialog';
    d.querySelector('.dialog-actions .chip').click();   // 取消
    return 'cancelled';
  })()`);
  console.log('   对话框：' + cancelled);
  await sleep(1500);
  const opts3 = await cdp.eval(CAT_OPTIONS);
  console.log('   取消后：' + JSON.stringify(opts3));
  check(opts3 && opts3.当前 === otherCat, '取消后还是原来选的分类（没被改成默认那个）', opts3 && opts3.当前);
  check(opts3 && opts3.当前 !== '__new__', '下拉没卡在「＋ 新建分类…」上', opts3 && opts3.当前);

  console.log('');
  console.log('⑧ 分类被删掉 ⇒ 下拉不会卡在空值上');
  // 过期路径：登记到分类 X（记住了）→ X 被删 → 回注册页 ⇒ 下拉里没有 X 了。
  //   要是没校验，select.value 会被置成空串 ⇒ 登记时提交空 category ⇒ 服务端兜底成「其它」。
  // ⚠ 必须**走界面**删（右键分类头 → 删掉这个分类）：界面那条路才会刷新
  //   前端的分类表；直接打 API 的话前端的分类表还是旧的，测不到这条路径。
  await gotoTab('scenes');
  const branches2 = await cdp.eval(BRANCHES);
  const idx = (branches2 || []).findIndex((b) => b.分类 === TCAT);
  console.log('   「' + TCAT + '」在树里的第 ' + idx + ' 个');
  check(idx >= 0, '树里找得到这个分类', idx);
  await openCatMenu(idx);
  await clickMenuItem('删掉这个分类');
  await sleep(1200);
  await confirmDialog();
  await sleep(2500);
  await gotoTab('registry');
  const optsGone = await cdp.eval(CAT_OPTIONS);
  console.log('   ' + JSON.stringify(optsGone));
  check(optsGone && optsGone.当前 !== '', '下拉没有卡在空值上', optsGone && JSON.stringify(optsGone.当前));
  check(optsGone && (optsGone.选项 || []).includes(optsGone.当前), '选中的值是下拉里真实存在的一项',
    optsGone && optsGone.当前);
  check(optsGone && optsGone.当前 !== TCAT, '不会停在被删掉的那个分类上', optsGone && optsGone.当前);
  check(optsGone && !(optsGone.选项 || []).includes(TCAT), '下拉里已经没有那个被删掉的分类',
    optsGone && (optsGone.选项 || []).join(' '));

  console.log('');
  console.log('⑨ 收尾：删掉测试角色和测试分类');
  // ⚠ 按**名字**找测试角色：⑧ 里分类被删了 ⇒ 角色的 category 变成了「未分类」，
  //   按 category 找就找不到了 ⇒ 角色会残留。
  const rEnd = await (await fetch(BASE + '/api/scenes', { headers: { cookie: cookie() } })).json();
  for (const s of (rEnd.scenes || [])) {
    if (s.name === TROLE || s.category === TCAT) await apiPost('/api/scenes/delete', { id: s.id });
  }
  await apiPost('/api/categories', { op: 'delete', name: TCAT });
  await sleep(1500);
  // 注册表 / 场景顺序**原样写回**（删分类时服务端把成员移到「未分类」，
  //   那个分类会跟着进注册表 ⇒ 光删测试分类不够）
  if (REG_RAW !== null) fs.writeFileSync(REGISTRY_FILE, REG_RAW);
  if (ORDER_RAW !== null) fs.writeFileSync(path.join(ROOT, 'data', 'scene-order.json'), ORDER_RAW);
  await sleep(500);
  const regEnd = registry();
  console.log('   最后注册表：' + regEnd.join(' / '));
  check(regEnd.indexOf(TCAT) < 0, '测试分类清掉了', regEnd.join(' / '));
  check(JSON.stringify(regEnd) === JSON.stringify(before), '注册表回到起始状态', regEnd.join(' / '));
  const rEnd2 = await (await fetch(BASE + '/api/scenes', { headers: { cookie: cookie() } })).json();
  check(!(rEnd2.scenes || []).some((s) => s.name === TROLE), '测试角色也没了',
    (rEnd2.scenes || []).map((s) => s.name).join(' '));

  console.log('');
  console.log('控制台报错：' + (cdp.errors.length ? '\n  ' + cdp.errors.slice(0, 4).join('\n  ') : '无'));
  console.log('');
  console.log('通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
  if (fail.length) fail.forEach((f) => console.log('  ✗ ' + f));
  process.exitCode = fail.length ? 1 : 0;
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  // ⚠ 安全网：测试中途挂了 ⇒ 把动过的分类/角色恢复回去，别留脏数据
  try {
    const r = await (await fetch(BASE + '/api/scenes', { headers: { cookie: cookie() } })).json();
    for (const s of (r.scenes || [])) {
      if (s.name === TROLE || s.category === TCAT) await apiPost('/api/scenes/delete', { id: s.id });
    }
    if (registry().indexOf(TCAT) >= 0) await apiPost('/api/categories', { op: 'delete', name: TCAT });
  } catch (e) { /* ignore */ }
  // ⚠ 注册表 / 场景顺序**原样写回**
  //   删分类时服务端会把成员移到「未分类」，那个分类会跟着进注册表 ⇒ 光删测试分类不够。
  try {
    if (REG_RAW !== null) fs.writeFileSync(REGISTRY_FILE, REG_RAW);
    if (ORDER_RAW !== null) fs.writeFileSync(path.join(ROOT, 'data', 'scene-order.json'), ORDER_RAW);
  } catch (e) { /* ignore */ }
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
