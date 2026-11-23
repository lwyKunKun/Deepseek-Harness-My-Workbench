#!/usr/bin/env node
// dev/check-derive-ui.mjs —— 在**真实界面**里验「项目信息的自动区」
//
// 跑法：node dev/check-derive-ui.mjs [--scene reading] [--cdp 9403]
//
// 验四件事：
//   ① 项目信息面板里有个「§三 阅读台账」页签
//   ② §〇 页签顶上是**只读**的自动区（写着正在读哪本、读到哪页）
//   ③ 自动区不在输入框里（输入框里只有手写内容 ⇒ 人改不了自动区）
//   ④ 控制台没有报错
//
// ⚠ 只读界面：不点「更新进度」（测试不该改机主的书）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9403));
const SCENE = val('--scene', 'reading');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

// 跑测试前的两份底稿（测试会点「更新进度」⇒ 留痕台账 + 项目信息都会变 ⇒ 跑完要还原）
const LEDGER = path.join(ROOT, 'data', 'acts', SCENE + '.jsonl');
const MAIN_FILE = path.join(ROOT, 'memory', SCENE, '项目信息.md');
const readOrNull = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const LEDGER_BEFORE = readOrNull(LEDGER);
const MAIN_BEFORE = readOrNull(MAIN_FILE);

// 仓库根（书笔记的绝对路径靠它拼）：场景的 projectRoot 可能指向库里的子目录 ⇒ 往上找
const VAULT_ROOT = (() => {
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', SCENE + '.json'), 'utf8'));
    const dir = ((sc.vaultDirs || []).filter((v) => v && v.kind === 'books')[0] || {}).dir || '';
    let cur = path.resolve(sc.projectRoot || ROOT);
    for (let i = 0; i < 5; i++) {
      if (dir && fs.existsSync(path.resolve(cur, dir))) return cur;
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    return cur;
  } catch (e) { return ROOT; }
})();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-derive-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-default-apps', '--no-first-run', '--mute-audio',
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
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push('console.error：' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
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

const SHADOW = `var host=null;
  document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
  if (!host) return null; var sr=host.shadowRoot;`;

let failed = 0;
function ok(cond, label, extra) {
  if (cond) { console.log('  ✅ ' + label); return; }
  failed += 1;
  console.log('  ❌ ' + label + (extra ? '　⇒ ' + extra : ''));
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
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(9000);

  console.log('\n① 进工作台 → 打开阅读场景详情');
  await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i=0;i<all.length;i++){ if ((all[i].getAttribute('aria-label')||'') === '工作台') { all[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(3500);
  await cdp.eval(`(function(){ ${SHADOW}
    var leaf = sr.querySelector('.side-leaf[data-sc-id="${SCENE}"]');
    if (leaf) leaf.click();
  })()`);
  await sleep(4000);
  // 详情页：从侧栏点开场景后会自动进详情；保险起见再点一次卡片
  await cdp.eval(`(function(){ ${SHADOW}
    var cards = sr.querySelectorAll('.panel-card');
    for (var i=0;i<cards.length;i++) {
      var t = (cards[i].querySelector('.panel-card-title')||{}).textContent || '';
      if (t.indexOf('项目信息')>=0) { var b = cards[i].querySelector('button'); if (b) b.click(); return 1; }
    }
    return 0;
  })()`);
  await sleep(4500);

  const panel = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    if (!p) return { found:false, panels: Array.prototype.map.call(sr.querySelectorAll('[data-panel-id]'), function(x){return x.getAttribute('data-panel-id');}) };
    var tabs = Array.prototype.map.call(p.querySelectorAll('.mem-tab'), function(t){ return (t.textContent||'').trim(); });
    return { found:true, tabs:tabs };
  })()`);
  ok(panel.found, '场景详情里有「项目信息」面板', JSON.stringify(panel.panels || panel));
  ok((panel.tabs || []).some((t) => t.indexOf('§三') === 0), '有「§三 阅读台账」页签', JSON.stringify(panel.tabs));

  console.log('\n② §〇 页签：自动区是只读的');
  await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    var tabs = p ? p.querySelectorAll('.mem-tab') : [];
    for (var i=0;i<tabs.length;i++){ if ((tabs[i].textContent||'').indexOf('§〇')===0) { tabs[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(1500);

  const sec0 = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    if (!p) return { found:false };
    var autos = p.querySelectorAll('.mem-auto');
    var ta = p.querySelector('textarea');
    var auto = autos.length ? (autos[0].textContent||'') : '';
    return {
      found:true,
      autoCount: autos.length,
      autoTag: autos.length ? ((autos[0].querySelector('.mem-auto-tag')||{}).textContent||'') : '',
      autoText: auto.replace(/\\s+/g,' ').trim().slice(0,200),
      taValue: ta ? (ta.value||'') : '',
      editable: autos.length ? getComputedStyle(autos[0]).pointerEvents : '',
    };
  })()`);
  ok(sec0.found, '§〇 面板渲染了');
  ok(sec0.autoCount > 0, '§〇 顶部有自动区', JSON.stringify(sec0));
  ok((sec0.autoTag || '').indexOf('自动') >= 0, '自动区标了「自动 · 只读」', sec0.autoTag);
  ok((sec0.autoText || '').indexOf('正在读') >= 0, '自动区写着「正在读」', sec0.autoText);
  ok((sec0.autoText || '').indexOf('台账') >= 0, '自动区写着三组计数', sec0.autoText);
  ok((sec0.taValue || '').indexOf('正在读') < 0,
    '输入框里没有「正在读」那行（自动内容不在输入框里 ⇒ 人改不了）', sec0.taValue);
  ok((sec0.taValue || '').indexOf('下一步') >= 0, '输入框里是手写内容', sec0.taValue);

  console.log('\n③ §三 页签：台账表');
  await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    var tabs = p ? p.querySelectorAll('.mem-tab') : [];
    for (var i=0;i<tabs.length;i++){ if ((tabs[i].textContent||'').indexOf('§三')===0) { tabs[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(1500);
  const sec3 = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    if (!p) return { found:false };
    var autos = p.querySelectorAll('.mem-auto');
    var text = autos.length ? (autos[0].textContent||'') : '';
    return { found:true, autoCount: autos.length, text: text.replace(/\\s+/g,' ').trim().slice(0,300) };
  })()`);
  ok(sec3.autoCount > 0, '§三 里有自动区', JSON.stringify(sec3));
  ok((sec3.text || '').indexOf('书') >= 0 && (sec3.text || '').indexOf('进度') >= 0,
    '台账表渲染出来了（书 / 进度）', sec3.text);

  console.log('\n④ 界面上更新进度 ⇒ 项目信息自动跟着变');
  // 找第一本书，记下它现在的页码（最后要还原 —— 测试不该改机主的书）
  const book = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-shelf"]');
    if (!p) return { err:'no-shelf' };
    var rows = p.querySelectorAll('.shelf-book');
    if (!rows.length) return { err:'no-book' };
    var row = rows[0];
    var page = (row.querySelector('.shelf-book-page')||{}).textContent || '';
    var title = (row.querySelector('.shelf-book-title')||{}).textContent || '';
    var m = page.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
    return { title: title, cur: m ? Number(m[1]) : 0, total: m ? Number(m[2]) : 0,
             path: row.getAttribute('data-book') || '' };
  })()`);
  ok(!book.err, '找到第一本书', JSON.stringify(book));
  const NEW_PAGE = book.cur + 1;

  // ⚠ 动书之前先**把书笔记本身存一份底稿** ——
  //   以前这个脚本靠「再点一次更新进度填回原页码」来还原，靠不住：
  //   列表顺序会变、第二次点击可能落在别的书上、时序一慢就还原失败
  //   （真的把机主的 示例书.md 从 15 改成了 16，还自己报「已还原」）。
  //   现在：磁盘上那份原文就是底稿，跑完直接写回去。
  const BOOK_ABS = path.join(VAULT_ROOT, book.path);
  const BOOK_TEXT = readOrNull(BOOK_ABS);
  if (BOOK_TEXT == null) { console.error('  ❌ 读不到那本书：' + BOOK_ABS); process.exitCode = 1; }
  else ok(BOOK_TEXT.includes('currentPage: ' + book.cur), '底稿里页码对得上', BOOK_ABS);

  // 点「更新进度」⇒ 填新页码 ⇒ 确认
  await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-shelf"]');
    var rows = p.querySelectorAll('.shelf-book');
    var btns = rows[0].querySelectorAll('.shelf-book-side .chip');
    for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('更新进度')>=0) { btns[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(1500);
  await cdp.eval(`(function(){ ${SHADOW}
    var d = sr.querySelector('.dialog.open');
    if (!d) return 0;
    var inp = d.querySelector('.dialog-input');
    if (inp) inp.value = '${NEW_PAGE}';
    var btns = d.querySelectorAll('.dialog-actions .chip');
    for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('更新')>=0) { btns[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(4000);

  // 书笔记**磁盘上**真的改了吗？（别只看界面上的文字）
  const onDisk = readOrNull(BOOK_ABS) || '';
  ok(onDisk.includes('currentPage: ' + NEW_PAGE),
    '书笔记磁盘上的 currentPage 真的改了', onDisk.match(/currentPage: \d+/)?.[0]);

  // 项目信息面板（§〇）应该已经自己刷新了 —— 不用手动 reload
  await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    var tabs = p ? p.querySelectorAll('.mem-tab') : [];
    for (var i=0;i<tabs.length;i++){ if ((tabs[i].textContent||'').indexOf('§〇')===0) { tabs[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(1500);
  const after = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    if (!p) return { found:false };
    var autos = p.querySelectorAll('.mem-auto');
    return { found:true, text: autos.length ? (autos[0].textContent||'').replace(/\\s+/g,' ').trim().slice(0,200) : '' };
  })()`);
  ok((after.text || '').indexOf(String(NEW_PAGE) + '/') >= 0,
    '§〇 的自动区换成新页码了（面板自己刷新，没手动 reload）', after.text);

  // 还原书笔记（从磁盘底稿写回，不靠再点一次界面）
  if (BOOK_TEXT != null) {
    try { fs.writeFileSync(BOOK_ABS, BOOK_TEXT, 'utf8'); } catch (e) { /* ignore */ }
  }
  const back = readOrNull(BOOK_ABS) || '';
  ok(back.includes('currentPage: ' + book.cur), '书笔记还原了（测试没改机主的书）',
    back.match(/currentPage: \d+/)?.[0]);

  console.log('\n⑤ 控制台');
  ok(cdp.errors.length === 0, '没有控制台报错', cdp.errors.slice(0, 3).join(' | '));

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    const p = path.join(ROOT, 'data', 'derive.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('截图：data/derive.png');
  }).catch(() => {});
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  // 还原测试动过的东西（跑失败也要还原）：
  //   ① 书笔记 —— 点了「更新进度」真改了磁盘上的 currentPage ⇒ 用底稿写回去。
  //      ⚠ 顺序很重要：先还原书，再还原台账，最后还原项目信息 ——
  //        项目信息是「台账 + 书」派生出来的，这样还原出来才自洽。
  if (typeof BOOK_ABS !== 'undefined' && BOOK_TEXT != null) {
    try { fs.writeFileSync(BOOK_ABS, BOOK_TEXT, 'utf8'); } catch (e) { /* ignore */ }
  }
  //   ② 留痕台账 —— 多了几条「更新阅读进度」；派生器靠「最近一次更新进度」
  //      判定「正在读」⇒ 不清掉会改掉机主的「正在读」。
  if (LEDGER_BEFORE != null) {
    try { fs.writeFileSync(LEDGER, LEDGER_BEFORE, 'utf8'); } catch (e) { /* ignore */ }
  }
  //   ③ 项目信息.md —— 派生器按真实数据重算过，用跑测试前的那份盖回去。
  if (MAIN_BEFORE != null) {
    try { fs.writeFileSync(MAIN_FILE, MAIN_BEFORE, 'utf8'); } catch (e) { /* ignore */ }
  }
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log(failed === 0 ? '\n全部通过 ✅\n' : '\n有 ' + failed + ' 项没过 ❌\n');
process.exitCode = process.exitCode || (failed === 0 ? 0 : 1);
