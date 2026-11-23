#!/usr/bin/env node
// dev/check-actlog-ui.mjs —— 在**真实界面**里验「操作留痕」
//
// 跑法：node dev/check-actlog-ui.mjs [--scene reading] [--cdp 9401]
//
// 做四件事：
//   ① 进「工作台」→ 点开场景详情 ⇒ 留痕面板在不在、渲染有没有报错
//   ② 在界面上点一本书（只读，不改书）⇒ 留痕里有没有多一条「打开书」
//   ③ 台账文件 data/acts/<场景>.jsonl 里对不对得上
//   ④ 截图存 data/actlog.png
//
// ⚠ 不碰「更新进度」/「加一本」—— 测试不该改机主的书。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
process.env.WB_ROOT = ROOT;

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9401));
const SCENE = val('--scene', 'reading');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-actlog-'));
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

  console.log('\n① 进工作台 → 打开场景详情');
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
  await sleep(2500);

  console.log('\n① 卡片视图里有「操作留痕」这张卡');
  const card = await cdp.eval(`(function(){ ${SHADOW}
    var cards = sr.querySelectorAll('.panel-card');
    for (var i=0;i<cards.length;i++) {
      var t = (cards[i].querySelector('.panel-card-title')||{}).textContent || '';
      if (t.indexOf('操作留痕')>=0) {
        return {
          found: true,
          lines: cards[i].querySelectorAll('.panel-card-line').length,
          btn: (cards[i].querySelector('button')||{}).textContent || '',
          text: (cards[i].textContent||'').replace(/\\s+/g,' ').trim().slice(0,160),
        };
      }
    }
    return { found:false, titles: Array.prototype.map.call(cards, function(c){ return (c.querySelector('.panel-card-title')||{}).textContent; }) };
  })()`);
  ok(card.found, '右栏有一张「操作留痕」卡', JSON.stringify(card.titles || card));
  ok(card.lines > 0, '卡里有留痕行', String(card.lines));

  console.log('\n② 点「打开场景看留痕」⇒ 进场景详情（项目信息的「留痕」页签）');
  const openedDetail = await cdp.eval(`(function(){ ${SHADOW}
    var cards = sr.querySelectorAll('.panel-card');
    for (var i=0;i<cards.length;i++) {
      var t = (cards[i].querySelector('.panel-card-title')||{}).textContent || '';
      if (t.indexOf('操作留痕')>=0) { var b = cards[i].querySelector('button'); if (b) { b.click(); return 1; } }
    }
    return 0;
  })()`);
  ok(openedDetail === 1, '点得开', String(openedDetail));
  await sleep(5000);

  const panel = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    if (!p) return { found:false, panels: Array.prototype.map.call(sr.querySelectorAll('[data-panel-id]'), function(x){return x.getAttribute('data-panel-id');}) };
    var tabs = Array.prototype.map.call(p.querySelectorAll('.mem-tab'), function(t){ return t.textContent; });
    var active = p.querySelector('.mem-tab.active');
    var rows = p.querySelectorAll('.act-row');
    var empty = p.querySelector('.todo-empty');
    return {
      found: true,
      tabs: tabs,
      active: active ? (active.textContent||'') : '',
      rows: rows.length,
      empty: empty ? (empty.textContent||'').trim() : '',
      first: rows[0] ? (rows[0].textContent||'').replace(/\\s+/g,' ').trim() : '',
      diag: (p.querySelector('.panel-diag')||{}).textContent || '',
    };
  })()`);
  ok(panel.found, '场景详情里有「项目信息」面板', JSON.stringify(panel.panels || panel));
  ok((panel.tabs || []).indexOf('留痕') >= 0, '项目信息里有「留痕」页签', JSON.stringify(panel.tabs));
  ok(panel.active === '留痕', '进来就落在「留痕」页签', panel.active);
  ok(panel.rows > 0 || !!panel.empty, '留痕页签里有内容（要么有行，要么明说还没有）', JSON.stringify(panel));

  // 手动点一下页签，确认切换正常
  const switched = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    var tabs = p ? p.querySelectorAll('.mem-tab') : [];
    for (var i=0;i<tabs.length;i++){ if ((tabs[i].textContent||'').indexOf('§〇')===0) { tabs[i].click(); return 1; } }
    return 0;
  })()`);
  ok(switched === 1, '能切回 §〇');
  await sleep(1200);
  await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    var tabs = p ? p.querySelectorAll('.mem-tab') : [];
    for (var i=0;i<tabs.length;i++){ if ((tabs[i].textContent||'')==='留痕') { tabs[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(2500);
  const back = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    return p ? p.querySelectorAll('.act-row').length : -1;
  })()`);
  ok(back > 0, '切回「留痕」页签仍能看到这些行', String(back));

  console.log('\n② 界面上点一本书（只读）⇒ 该留下一条');
  const before = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-shelf"]');
    if (!p) return 'no-shelf';
    var book = p.querySelector('.shelf-book');
    if (!book) return 'no-book';
    var t = (book.querySelector('.shelf-book-title')||{}).textContent;
    book.click();
    return t;
  })()`);
  console.log('  点开：' + before);
  await sleep(3500);

  console.log('\n③ 台账文件对不对得上');
  const actlog = await import(pathToFileURL(path.join(ROOT, 'lib', 'actlog.mjs')).href);
  const rows = actlog.read(SCENE);
  ok(rows.length > 0, '台账里有记录', String(rows.length));
  const opened = rows.filter((r) => r.action === '打开书');
  ok(opened.length > 0, '有「打开书」这条', JSON.stringify(opened.slice(-1)[0] || {}));
  const enter = rows.filter((r) => r.action === '进入场景');
  ok(enter.length > 0, '有「进入场景」这条（点进阅读场景本身也记了）');
  const last = rows.slice(-3);
  console.log('  最近三条：');
  last.forEach((r) => console.log('    ' + actlog.lineOf(r)));

  const after = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-mem"]');
    return p ? p.querySelectorAll('.act-row').length : -1;
  })()`);
  ok(after > 0, '留痕页签里已经显示出这些行', String(after));

  console.log('\n④ 控制台');
  ok(cdp.errors.length === 0, '没有控制台报错', cdp.errors.slice(0, 3).join(' | '));

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    const p = path.join(ROOT, 'data', 'actlog.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('截图：data/actlog.png');
  }).catch(() => {});
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log(failed === 0 ? '\n全部通过 ✅\n' : '\n有 ' + failed + ' 项没过 ❌\n');
process.exitCode = process.exitCode || (failed === 0 ? 0 : 1);
