#!/usr/bin/env node
// check-filetree.mjs —— 验「项目目录」重构：左树拆成「角色 / 项目」双视图
//
// 判据（计划里的验收标准，六条）：
//   ① 角色视图里左树**只有角色**，没有文件树 —— 角色和目录不再同屏同名同图标
//   ② 项目视图能列出项目根，且**角色归属正确**
//      （父项目 → …/projects/demo-parent；子端 → …/projects/demo-parent/sub-app）
//   ③ **父子嵌套正确** —— sub-app 挂在父项目下面，不是并列
//   ④ 展开能**懒加载**下一层（真磁盘上的子项；绑过角色的目录不重复列）
//   ⑤ **搜索**能按名命中文件（深目录也搜得到）
//   ⑥ **新建文件夹**真建出来（落在工作台内的项目记忆目录，不碰真实公司目录）
//
// 用法：node dev/check-filetree.mjs [--cdp 9401] [--url http://127.0.0.1:3080/]
// 通过：六条判据全绿 ⇒ 退出码 0。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = val('--url', 'http://127.0.0.1:3080/');
const PORT = Number(val('--cdp', 9401));
const ROOT = process.cwd();

// 自检用的项目树命名 —— 按自己环境用参数覆盖：--parent/--parent-path/--child/--child-scene
const PARENT = val('--parent', '示例父项目');
const PARENT_PATH = val('--parent-path', '/projects/demo-parent');
const CHILD = val('--child', 'sub-app');
const CHILD_SCENE = val('--child-scene', '子端');

// 新建文件夹自检用的场景：**没绑项目目录** ⇒ 落在工作台内的「项目记忆」目录
//   （不碰机主真实磁盘上的公司目录）
const TEST_SCENE = 'command';
const TEST_NAME = '__树自检';
const TEST_DIR = path.join(ROOT, 'memory', TEST_SCENE, '项目记忆', TEST_NAME);
const SHOT_ROLES = val('--shot-roles', path.join(process.cwd(), 'data', 'tree-roles.png'));
const SHOT_PROJ = val('--shot-proj', path.join(process.cwd(), 'data', 'tree-projects.png'));
const SHOT_DETAIL = val('--shot-detail', path.join(process.cwd(), 'data', 'tree-detail.png'));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tree-'));
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

/** 在 shadow root 里找工作台宿主。 */
const HOST_FN = `(function(){
  var host=null;
  document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
  return host;
})()`;

/**
 * 把自检自己写进留痕的那几行删掉 —— 别给机主留垃圾痕迹。
 * （只删带自检名字的行；别的痕迹一行不动。）
 */
function cleanupTrace(scene, name) {
  const files = [
    path.join(ROOT, 'data', 'acts', scene + '.jsonl'),
    path.join(ROOT, 'data', 'writes.jsonl'),
  ];
  for (const f of files) {
    try {
      if (!fs.existsSync(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      const kept = lines.filter((l) => l.indexOf(name) < 0);
      if (kept.length === lines.length) continue;
      fs.writeFileSync(f, kept.join('\n') + '\n', 'utf8');
      console.log('清掉自检痕迹：' + f + '（-' + (lines.length - kept.length) + ' 行）');
    } catch (e) { /* 清不掉就算了 */ }
  }
}

/** 打开工作台（左边侧栏那个「工作台」按钮）。 */
async function openWorkbench(cdp) {
  await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i=0;i<all.length;i++){ if ((all[i].getAttribute('aria-label')||'') === '工作台') { all[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(2600);
}

/** 切左树的视图：'roles'（角色）/ 'projects'（项目）。 */
async function switchView(cdp, view) {
  const hit = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var btns = host.shadowRoot.querySelectorAll('.side-switch-btn');
    for (var i=0;i<btns.length;i++){
      if ((btns[i].textContent||'').indexOf('${view}') === 0) { btns[i].click(); return 1; }
    }
    return 0;
  })()`);
  await sleep(1600);
  return hit;
}

/** 进某个场景的详情页（点角色 → 点「打开场景」）。 */
async function openScene(cdp, sceneId) {
  await openWorkbench(cdp);
  await switchView(cdp, '角色');
  await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var back = host.shadowRoot.querySelector('.detail-head button');
    if (back) back.click();
    var leaf = host.shadowRoot.querySelector('.side-leaf[data-sc-id="${sceneId}"]');
    if (leaf) leaf.click();
    return leaf ? 1 : 0;
  })()`);
  await sleep(1600);
  await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var btns = host.shadowRoot.querySelectorAll('.cat-main button, .panel-card button, .side-leaf button');
    for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('打开场景')>=0) { btns[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(2600);
}

const rows = [];
const ok = (cond, text) => { rows.push([cond, text]); console.log((cond ? '✓ ' : '✗ ') + text); };
const shot = async (cdp, file) => {
  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('截图：' + file);
  }).catch(() => {});
};

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

  /* ── ① 角色视图：左树只有角色，没有文件树 ─────────────────────── */
  await openWorkbench(cdp);
  await switchView(cdp, '角色');
  const roles = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return { err: 'no-host' };
    var sw = [];
    host.shadowRoot.querySelectorAll('.side-switch-btn').forEach(function(b){ sw.push(b.textContent); });
    var leafs = host.shadowRoot.querySelectorAll('.side-leaf');
    var marks = host.shadowRoot.querySelectorAll('.side-leaf .scene-proj');
    return {
      sw: sw,
      roles: leafs.length,
      marks: marks.length,
      trees: host.shadowRoot.querySelectorAll('.side-tree .ftnode-root, .side-tree .ftnode').length,
      on: (host.shadowRoot.querySelector('.side-switch-btn.on')||{}).textContent || '',
    };
  })()`);
  console.log('左树视图：' + JSON.stringify(roles));
  ok((roles.roles || 0) >= 5, '① 角色视图里左树列出了角色（' + (roles.roles || 0) + ' 个）');
  ok((roles.trees || 0) === 0, '① 角色视图里没有文件树了（角色和目录不再同屏同名同图标）');
  ok((roles.sw || []).some((t) => t.indexOf('角色') === 0) && (roles.sw || []).some((t) => t.indexOf('项目') === 0),
    '① 顶部有「角色 / 项目」切换器（' + (roles.sw || []).join('、') + '）');
  ok((roles.marks || 0) > 0, '① 绑了目录的角色行上有 📁 标记（' + (roles.marks || 0) + ' 个）');
  await shot(cdp, SHOT_ROLES);

  /* ── ② 点角色的 📁 ⇒ 跳到项目视图并定位到那个目录 ─────────────── */
  const jumped = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var leaf = host.shadowRoot.querySelector('.side-leaf[data-sc-id="work"]');
    if (!leaf) return 0;
    var mark = leaf.querySelector('.scene-proj');
    if (!mark) return 0;
    mark.click();
    return 1;
  })()`);
  await sleep(1800);
  const onProj = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return { err: 'no-host' };
    return { on: (host.shadowRoot.querySelector('.side-switch-btn.on')||{}).textContent || '',
             tree: !!host.shadowRoot.querySelector('.proj-tree') };
  })()`);
  ok(jumped === 1 && (onProj.on || '').indexOf('项目') === 0 && onProj.tree,
    '② 点角色行上的 📁 ⇒ 跳到「项目」视图并定位到那个目录');

  /* ── ② 项目根列得出来 + 角色归属正确 ─────────────────────────── */
  const proj = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return { err: 'no-host' };
    var out = [];
    host.shadowRoot.querySelectorAll('.projnode-row').forEach(function(r){
      var chips = [];
      r.querySelectorAll('.proj-chip').forEach(function(c){ chips.push(c.textContent); });
      out.push({
        path: r.getAttribute('data-path') || '',
        name: (r.querySelector('.projnode-name')||{}).textContent || '',
        chips: chips,
        nested: !!r.closest('.projnode-subs'),
      });
    });
    return { rows: out, crumb: (host.shadowRoot.querySelector('.proj-crumb')||{}).textContent || '',
             hasSearch: !!host.shadowRoot.querySelector('.ft-search') };
  })()`);
  const pr = proj.rows || [];
  console.log('项目视图：' + pr.map((r) => r.name + (r.chips.length ? '[' + r.chips.join('') + ']' : '') + (r.nested ? '↳' : '')).join('、'));
  const gfl = pr.filter((r) => r.name === PARENT)[0] || {};
  const xq = pr.filter((r) => r.name === CHILD)[0] || {};
  const bk = pr.filter((r) => r.name === '05-Bookshelf')[0] || {};
  ok(pr.length >= 5, '② 项目视图列出了项目根（' + pr.length + ' 个）');
  ok(gfl.path && gfl.path.indexOf(PARENT_PATH) > 0 && gfl.chips.join('').indexOf(PARENT) >= 0,
    '② 父项目绑的是 ' + (gfl.path || '(没找到)') + '，归属正确');
  ok(xq.path && xq.path.indexOf('/' + CHILD) > 0 && xq.chips.join('').indexOf(CHILD_SCENE) >= 0,
    '② 子端绑的是 ' + (xq.path || '(没找到)') + '，归属正确');
  ok(bk.path && bk.path.indexOf('05-Bookshelf') > 0 && bk.chips.join('').indexOf('阅读') >= 0,
    '② 读者绑的是 ' + (bk.path || '(没找到)') + '，归属正确');
  ok((proj.hasSearch === true), '② 项目视图里有搜索框');
  await shot(cdp, SHOT_PROJ);

  /* ── ③ 父子嵌套：子目录挂在父项目下面，不是并列 ──────────── */
  ok(xq.nested === true && gfl.nested === false,
    '③ 父子嵌套正确（' + CHILD + ' 是 ' + PARENT + ' 的子节点，不是并列）');

  /* ── ④ 展开能懒加载下一层（真磁盘上的子项） ───────────────────── */
  await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var rows = host.shadowRoot.querySelectorAll('.projnode-row');
    for (var i=0;i<rows.length;i++){
      var p = rows[i].getAttribute('data-path')||'';
      if (p.indexOf(PARENT_PATH) > 0 && p.indexOf('/' + CHILD) < 0) { rows[i].click(); return 1; }
    }
    return 0;
  })()`);
  await sleep(2000);
  const kids = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return { names: [] };
    var rows = host.shadowRoot.querySelectorAll('.projnode-row');
    for (var i=0;i<rows.length;i++){
      var p = rows[i].getAttribute('data-path')||'';
      if (p.indexOf(PARENT_PATH) > 0 && p.indexOf('/' + CHILD) < 0){
        var node = rows[i].closest('.projnode');
        // ⚠ 只看**自己这一层**的盒子 —— 嵌套子目录也有 .ftnode-kids，
        //   不限定直接子节点的话会读到别人的。
        var box = node.querySelector(':scope > .ftnode-kids');
        if (!box) return { names: [], note: 'no-box' };
        var names = [];
        box.querySelectorAll('.ftnode-row .ftnode-name').forEach(function(x){ names.push(x.textContent); });
        return { names: names, note: (box.querySelector('.ftnode-note')||{}).textContent || '' };
      }
    }
    return { names: [] };
  })()`);
  console.log('展开父项目后：' + (kids.names || []).join('、'));
  ok((kids.names || []).length > 0, '④ 展开能懒加载下一层（' + (kids.names || []).length + ' 项）');
  ok(!(kids.names || []).includes(CHILD),
    '④ 绑过角色的目录不在这一层重复列（一份磁盘一棵）');

  /* ── ⑤ 搜索能按名命中文件 ─────────────────────────────────────── */
  const typed = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var inp = host.shadowRoot.querySelector('.ft-search');
    if (!inp) return 0;
    inp.value = 'package.json';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await sleep(2500);
  const hits = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return { rows: [] };
    var out = [];
    host.shadowRoot.querySelectorAll('.proj-search-res .ftnode-hit').forEach(function(x){
      out.push(x.getAttribute('title') || x.textContent || '');
    });
    return { rows: out, note: (host.shadowRoot.querySelector('.proj-search-res .ftnode-note')||{}).textContent || '' };
  })()`);
  console.log('搜「package.json」命中：' + (hits.rows || []).slice(0, 5).join('、'));
  ok(typed === 1 && (hits.rows || []).length > 0, '⑤ 搜索能按名命中文件（' + (hits.rows || []).length + ' 条）');
  ok((hits.rows || []).some((p) => p.indexOf('/' + CHILD) >= 0),
    '⑤ 深目录也搜得到（命中里有子目录底下的）');

  /* ── ⑥ 新建文件夹（落在工作台内的项目记忆目录，不碰真实公司目录） ── */
  await openScene(cdp, TEST_SCENE);
  await sleep(1200);
  const state = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return { err: 'no-host' };
    var panel = host.shadowRoot.querySelector('[data-panel-id="${TEST_SCENE}-proj"]');
    if (!panel) return { err: 'no-panel' };
    var tools = [];
    panel.querySelectorAll('.proj-tools button').forEach(function(x){ tools.push(x.textContent); });
    return { hasPanel: true, tools: tools,
             crumb: (panel.querySelector('.proj-crumb')||{}).textContent || '',
             hasSearch: !!panel.querySelector('.ft-search') };
  })()`);
  console.log('详情页 · 项目目录面板：' + JSON.stringify(state));
  ok(state.hasPanel === true, '⑥ 详情页里有「项目目录」面板');
  ok((state.tools || []).some((t) => t.indexOf('新建文件夹') >= 0), '⑥ 面板工具条上有「新建文件夹」');
  ok(state.hasSearch === true, '⑥ 详情页面板里有搜索框（深目录不用一层层点）');
  await shot(cdp, SHOT_DETAIL);

  await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var panel = host.shadowRoot.querySelector('[data-panel-id="${TEST_SCENE}-proj"]');
    if (!panel) return 0;
    var btn = null;
    panel.querySelectorAll('.proj-tools button').forEach(function (b) { if ((b.textContent||'').indexOf('新建文件夹') >= 0) btn = b; });
    if (!btn) return 0;
    btn.click();
    return 1;
  })()`);
  await sleep(700);
  const typedName = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 'no-host';
    var inp = host.shadowRoot.querySelector('[data-panel-id="${TEST_SCENE}-proj"] .ftree-input');
    if (!inp) return 'no-input';
    inp.value = '${TEST_NAME}';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'typed';
  })()`);
  console.log('输入：' + typedName);
  await sleep(2200);
  const onDisk = fs.existsSync(TEST_DIR);
  ok(onDisk, '⑥ 真的建出来了：' + TEST_DIR.replace(ROOT, '工作台'));
  const inTree = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var panel = host.shadowRoot.querySelector('[data-panel-id="${TEST_SCENE}-proj"]');
    if (!panel) return 0;
    return panel.querySelectorAll('.ftree-name').length;
  })()`);
  ok((inTree || 0) > 0, '⑥ 新建的文件夹出现在树里（树里 ' + (inTree || 0) + ' 项）');

  // 清掉自检产物（磁盘上的文件夹 + 自检自己写进留痕的那几行）
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) { /* 清不掉就算了 */ }
  cleanupTrace(TEST_SCENE, TEST_NAME);

  console.log('');
  const bad = rows.filter((r) => !r[0]);
  console.log(bad.length ? '❌ 不对：' + bad.map((r) => r[1]).join('；') : '✓ 六条判据全过');
  console.log('控制台报错：' + (cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '无'));
  process.exitCode = bad.length ? 1 : 0;
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
