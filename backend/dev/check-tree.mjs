#!/usr/bin/env node
// check-tree.mjs —— 验「分类是容器」这条规则
//
// 场景页左边是树：分类（枝）= 容器，角色（叶）= 内容。
//   ① 树里的分类跟注册表一致（名字、顺序、数量），每组计数 = 该分类下的角色数
//   ② 容器弱化：分类行比角色行小、且是灰字；角色是亮字
//   ③ 没选中角色 ⇒ 右栏 0 张摘要卡，只有一句中性空态
//   ④ 点分类头 ⇒ 只展开/折叠（来回调），右栏始终 0 张卡
//   ⑤ 点角色 ⇒ 右栏出 5 张摘要卡，空态消失，选中项被记住
//
// ⚠ 分类**不写死**：分类会增减（用户随时能建新的），断言一律拿服务端真相
//   （/api/state 的 categories）来比，别再写死「3 个分类、计数 3/4/1」。
//
// 用法：node dev/check-tree.mjs [--cdp 9410]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9410));
const BASE = 'http://127.0.0.1:3080/workbench';

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

/** 工作台挂在 DSH 的 shadow DOM 里 —— 得先找到那个宿主。 */
const HOST = `(function(){
  var host=null;
  document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
  return host;
})()`;

const pass = [];
const fail = [];
const warn = [];
function check(ok, label, detail) {
  (ok ? pass : fail).push(label);
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (detail ? '  → ' + detail : ''));
}

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

  // 清掉「上次选中的角色」再进页面 ⇒ 模拟第一次打开（右栏该是空的）
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(6000);
  await cdp.eval(`localStorage.removeItem('wb.scene.selected')`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(8000);

  const opened = await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i=0;i<all.length;i++){ if ((all[i].getAttribute('aria-label')||'') === '工作台') { all[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(4000);
  console.log('（点了工作台：' + opened + '）');
  console.log('');

  console.log('① 分类树结构');
  const tree = await cdp.eval(`(function(){
    var host=${HOST};
    if (!host) return {err:'no-shadow'};
    var sr = host.shadowRoot;
    var branches=[]; sr.querySelectorAll('.side-branch-head').forEach(function(b){
      branches.push({ 分类: b.querySelector('.side-cat').textContent, 计数: b.querySelector('.side-count').textContent });
    });
    var leaves=[]; sr.querySelectorAll('.side-leaf').forEach(function(l){ leaves.push(l.querySelector('.side-leaf-name').textContent); });
    return { branches: branches, leaves: leaves };
  })()`);
  console.log('   ' + JSON.stringify(tree));
  // 分类不写死 —— 跟服务端真相（注册表 + 场景里出现过的）比
  const state = await (await fetch(BASE + '/api/state', { headers: { cookie: cookie() } })).json();
  const cats = state.categories || [];
  const scenes = state.scenes || [];
  const treeNames = (tree.branches || []).map((b) => b.分类);
  console.log('   注册表分类：' + cats.join(' / '));
  check(tree.branches && treeNames.length === cats.length, '分类数 = 注册表里的分类数（' + cats.length + '）', treeNames.length + ' 个');
  check(treeNames.join('/') === cats.join('/'), '分类名和顺序跟注册表一致', treeNames.join('/'));
  const expectCounts = cats.map((c) => scenes.filter((s) => (s.category || '未分类') === c).length);
  const treeCounts = (tree.branches || []).map((b) => Number(b.计数));
  check(treeCounts.join('/') === expectCounts.join('/'), '每组计数 = 该分类下的角色数',
    treeCounts.join('/') + ' vs ' + expectCounts.join('/'));
  const clash = (tree.leaves || []).filter((n) => cats.includes(n));
  if (clash.length) {
    // ⚠ 重名**不影响**树的结构（分类行灰字带徽章，角色行亮字带图标，认得出来），
    //   但按 README 的规矩（"分类名不跟角色名重名"）是最好避开的。
    //   这属于数据层的事 —— 报出来，不判失败：要不要改名是用户的事。
    console.log('  ! 分类和角色重名：' + clash.join('、') + '（不影响功能，但容易分不清哪行是分类哪行是角色）');
    warn.push('分类和角色重名：' + clash.join('、'));
  } else {
    console.log('  ✓ 没有角色跟分类重名');
    pass.push('没有角色跟分类重名');
  }

  console.log('');
  console.log('② 容器弱化（分类行 vs 角色行）');
  const style = await cdp.eval(`(function(){
    var host=${HOST}; var sr=host.shadowRoot;
    var cat = sr.querySelector('.side-cat'), leaf = sr.querySelector('.side-leaf-name');
    var cs = getComputedStyle(cat);
    return { 分类字号: cs.fontSize, 分类色: cs.color,
             角色字号: getComputedStyle(leaf).fontSize, 角色色: getComputedStyle(leaf.parentNode).color };
  })()`);
  console.log('   ' + JSON.stringify(style));
  check(parseFloat(style.分类字号) < parseFloat(style.角色字号), '分类字号 < 角色字号', style.分类字号 + ' < ' + style.角色字号);
  check(style.分类色 === 'rgb(139, 147, 167)', '分类是灰字（--text-dim）', style.分类色);
  check(style.角色色 === 'rgb(230, 232, 238)', '角色是亮字（--text）', style.角色色);

  console.log('');
  console.log('③ 未选中 ⇒ 右栏无内容卡');
  const empty = await cdp.eval(`(function(){
    var host=${HOST}; var sr=host.shadowRoot;
    return { 摘要卡数: sr.querySelectorAll('.panel-card').length,
             空态: sr.querySelectorAll('.cat-empty').length,
             空态文案: (sr.querySelector('.cat-empty-title')||{}).textContent || '(无)' };
  })()`);
  console.log('   ' + JSON.stringify(empty));
  check(empty.摘要卡数 === 0, '右栏 0 张摘要卡（没有身份卡）', empty.摘要卡数 + ' 张');
  check(empty.空态 === 1, '出现中性空态', empty.空态文案);

  console.log('');
  console.log('④ 点分类头（枝）⇒ 仍然没有任何内容卡，且只展开/折叠');
  const SNAP = `(function(){
    var host=${HOST}; var sr=host.shadowRoot;
    var heads = sr.querySelectorAll('.side-branch-head');
    // ⚠ 拿**第一个有成员的**分类来测折叠：全空的分类折了也不掉叶子 ⇒ 断言会退化成恒真
    var pick = null, pickIdx = -1;
    for (var i=0;i<heads.length;i++){
      if (parseInt(heads[i].querySelector('.side-count').textContent, 10) > 0) { pick = heads[i]; pickIdx = i; break; }
    }
    return { 叶数: sr.querySelectorAll('.side-leaf').length,
             摘要卡数: sr.querySelectorAll('.panel-card').length,
             空态: sr.querySelectorAll('.cat-empty').length,
             索引: pickIdx,
             twisty: pick ? pick.querySelector('.side-twisty').textContent : '?',
             分类: pick ? pick.querySelector('.side-cat').textContent : '(没有有成员的分类)',
             组内成员: pick ? parseInt(pick.querySelector('.side-count').textContent, 10) : 0 };
  })()`;
  const before = await cdp.eval(SNAP);
  console.log('   点的是「' + before.分类 + '」（组内 ' + before.组内成员 + ' 个成员），折叠前叶数 ' + before.叶数);
  check(before.组内成员 > 0, '有个有成员的分类可测折叠', before.分类);
  await cdp.eval(`(function(){ var host=${HOST}; host.shadowRoot.querySelectorAll('.side-branch-head')[${before.索引}].click(); return 1; })()`);
  await sleep(2500);
  const after = await cdp.eval(SNAP);
  console.log('   折叠后：叶数 ' + after.叶数 + ' / twisty ' + after.twisty);
  check(after.叶数 === before.叶数 - before.组内成员, '点一次 = 折叠（叶数减少该组成员数）',
        before.叶数 + ' → ' + after.叶数 + '（该组 ' + before.组内成员 + ' 人）');
  check(after.twisty === '▸', '折叠后箭头变 ▸', after.twisty);
  check(after.摘要卡数 === 0 && after.空态 === 1, '点分类头后右栏依旧没有任何卡', '卡 ' + after.摘要卡数 + ' / 空态 ' + after.空态);

  // 再点一次 ⇒ 必须能弹回来（曾经折叠存不住，点了跟没点一样）
  await cdp.eval(`(function(){ var host=${HOST}; host.shadowRoot.querySelectorAll('.side-branch-head')[${before.索引}].click(); return 1; })()`);
  await sleep(2500);
  const again = await cdp.eval(SNAP);
  console.log('   再点一次：叶数 ' + again.叶数 + ' / twisty ' + again.twisty);
  check(again.叶数 === before.叶数, '再点一次 = 展开（叶数回到 ' + before.叶数 + '）', again.叶数 + ' 个叶子');
  check(again.twisty === '▾', '展开后箭头回到 ▾', again.twisty);
  check(again.摘要卡数 === 0 && again.空态 === 1, '来回点分类头，右栏始终没有卡', '卡 ' + again.摘要卡数 + ' / 空态 ' + again.空态);

  console.log('');
  console.log('⑤ 点角色（叶）⇒ 右栏出 5 张卡');
  const leafId = await cdp.eval(`(function(){
    var host=${HOST}; var sr=host.shadowRoot;
    var leaf = sr.querySelector('.side-leaf');
    leaf.click();
    return leaf.getAttribute('data-sc-id');
  })()`);
  await sleep(4000);
  const cards = await cdp.eval(`(function(){
    var host=${HOST}; var sr=host.shadowRoot;
    var titles=[]; sr.querySelectorAll('.panel-card-title').forEach(function(t){ titles.push(t.textContent); });
    return { 卡数: titles.length, 标题: titles, 空态: sr.querySelectorAll('.cat-empty').length,
             选中项: localStorage.getItem('wb.scene.selected') };
  })()`);
  console.log('   点了 ' + leafId + ' → ' + JSON.stringify(cards));
  check(cards.卡数 === 5, '点角色后出 5 张摘要卡', cards.卡数 + ' 张: ' + cards.标题.join('/'));
  check(cards.空态 === 0, '空态消失', cards.空态);
  check(cards.选中项 === leafId, '选中项已写进 localStorage', cards.选中项);

  console.log('');
  console.log('控制台报错：' + (cdp.errors.length ? '\n  ' + cdp.errors.slice(0, 4).join('\n  ') : '无'));
  console.log('警告：' + (warn.length ? warn.join('；') : '无'));
  console.log('');
  console.log('通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
  if (fail.length) fail.forEach(f => console.log('  ✗ ' + f));
  process.exitCode = fail.length ? 1 : 0;
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
