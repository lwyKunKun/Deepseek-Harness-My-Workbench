#!/usr/bin/env node
// check-shelf.mjs —— 专门验「书架只挂在阅读模块下」
//
// 规则（来自机主原话）：书架只能在阅读的模块下，其他模块不应该有书架。
// 判据：**看场景自己的配置**（scenarios/*.json 的 vaultDirs）——
//   只有声明了 kind='books' 的场景才挂书架面板（现在只有 reading）。
//   绑了同一个 Obsidian 库（projectRoot）**不算**挂书架的理由。
//
// 用法：node dev/check-shelf.mjs [--cdp 9399]
// 通过：只有 reading 有 <id>-shelf 面板，其他场景一个都没有。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = 'http://127.0.0.1:3080/';
const PORT = Number(val('--cdp', 9399));
const ROOT = process.cwd();

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shelf-'));
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

const rows = [];
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

  // 进「工作台」
  await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i=0;i<all.length;i++){ if ((all[i].getAttribute('aria-label')||'') === '工作台') { all[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(3500);

  // 树上的全部场景
  const scenes = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return [];
    var out=[]; host.shadowRoot.querySelectorAll('.side-leaf[data-sc-id]').forEach(function(x){ out.push(x.getAttribute('data-sc-id')); });
    return out;
  })()`);
  console.log('树上的场景：' + (scenes.join('、') || '(没找到)'));
  console.log('');

  for (const sc of scenes) {
    // 选场景 → 点「打开场景看留痕」⇒ 进详情页（面板都挂在那儿）
    await cdp.eval(`(function(){
      var host = ${HOST_FN};
      if (!host) return;
      var back = host.shadowRoot.querySelector('.detail-head button');   // 先回目录
      if (back) back.click();
      var leaf = host.shadowRoot.querySelector('.side-leaf[data-sc-id="${sc}"]');
      if (leaf) leaf.click();
    })()`);
    await sleep(2200);
    await cdp.eval(`(function(){
      var host = ${HOST_FN};
      if (!host) return;
      var btns = host.shadowRoot.querySelectorAll('.panel-card button, .cat-main button');
      for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('打开场景')>=0) { btns[i].click(); return; } }
    })()`);
    await sleep(3200);

    const info = await cdp.eval(`(function(){
      var host = ${HOST_FN};
      if (!host) return { err:'no-host' };
      var ids=[]; host.shadowRoot.querySelectorAll('[data-panel-id]').forEach(function(x){ ids.push(x.getAttribute('data-panel-id')); });
      var titles=[]; host.shadowRoot.querySelectorAll('.panel-title').forEach(function(x){ titles.push(x.textContent); });
      return { ids: ids, titles: titles, shelf: !!host.shadowRoot.querySelector('[data-panel-id="${sc}-shelf"]') };
    })()`);

    const row = {
      scene: sc,
      shelf: !!info.shelf,
      shelfTitle: info.titles && info.titles.includes('书架') ? '书架' : '',
      panels: (info.ids || []).length,
      ids: (info.ids || []).join(','),
    };
    rows.push(row);
    console.log(
      (row.scene + '        ').slice(0, 12) +
      (row.shelf ? '有书架' : '无书架') +
      '　面板 ' + row.panels + ' 个：' + row.ids
    );
  }

  // 判据：只有 reading 挂书架
  const shouldHave = 'reading';
  const wrong = rows.filter((r) => (r.scene === shouldHave) !== r.shelf);
  console.log('');
  console.log('规则：书架只挂在「' + shouldHave + '」下，其他模块一个都不许有。');
  if (wrong.length) {
    console.log('❌ 不对：' + wrong.map((r) => r.scene + (r.shelf ? '（多出书架）' : '（缺书架）')).join('、'));
  } else {
    console.log('✓ 全对：' + rows.filter((r) => r.shelf).map((r) => r.scene).join('、') + ' 有书架；其余 ' + rows.filter((r) => !r.shelf).length + ' 个场景没有。');
  }
  console.log('控制台报错：' + (cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '无'));
  process.exitCode = wrong.length ? 1 : 0;
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
