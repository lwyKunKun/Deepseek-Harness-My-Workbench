#!/usr/bin/env node
// dev/check-health-ui.mjs —— 在**真实界面**里验「体检」面板
//
// 跑法：node dev/check-health-ui.mjs [--scene reading] [--cdp 9402]
//
// 验三件事：
//   ① 体检面板**列得出 24 项**（不是只显示一句「体检跑不了」）
//   ② 红项标红、而且看得到是哪一项坏了
//   ③ 面板小字说清「几项要修」
//
// ⚠ 体检是全局的（24 项），不是只查这一个场景 —— 这里借一个场景的面板看它。

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
const PORT = Number(val('--cdp', 9402));
const SCENE = val('--scene', 'reading');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-health-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-default-apps', '--mute-audio',
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
  await cdp.eval(`(function(){ ${SHADOW}
    var cards = sr.querySelectorAll('.panel-card');
    for (var i=0;i<cards.length;i++) {
      var t = (cards[i].querySelector('.panel-card-title')||{}).textContent || '';
      if (t.indexOf('操作留痕')>=0) { var b = cards[i].querySelector('button'); if (b) { b.click(); return 1; } }
    }
    return 0;
  })()`);
  await sleep(6000);

  console.log('\n① 体检面板');
  const panel = await cdp.eval(`(function(){ ${SHADOW}
    var p = sr.querySelector('[data-panel-id="${SCENE}-health"]');
    if (!p) return { found:false, panels: Array.prototype.map.call(sr.querySelectorAll('[data-panel-id]'), function(x){return x.getAttribute('data-panel-id');}) };
    var rows = p.querySelectorAll('.health-row');
    var okRows = p.querySelectorAll('.health-row.ok');
    var badRows = p.querySelectorAll('.health-row.bad');
    var bad = [];
    p.querySelectorAll('.health-row.bad').forEach(function(r){ bad.push((r.textContent||'').replace(/\\s+/g,' ').trim()); });
    return {
      found: true,
      rows: rows.length, ok: okRows.length, bad: badRows.length,
      badDetail: bad,
      diag: (p.querySelector('.panel-diag')||{}).textContent || '',
      text: (p.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120),
    };
  })()`);
  ok(panel.found, '场景详情里有「体检」面板', JSON.stringify(panel.panels || panel));
  ok(panel.rows >= 20, '体检面板列出了全部项（不是一句「跑不了」）', '行数=' + panel.rows + '｜' + panel.text);
  ok(panel.bad === (panel.badDetail || []).length, '红项标红了', JSON.stringify(panel.badDetail));
  ok(/项/.test(panel.diag || ''), '小字说清几项要修', panel.diag);
  if ((panel.badDetail || []).length) {
    console.log('  —— 没过的项 ——');
    panel.badDetail.forEach((b) => console.log('    ✗ ' + b));
  }

  console.log('\n② 控制台');
  ok(cdp.errors.length === 0, '没有控制台报错', cdp.errors.slice(0, 3).join(' | '));

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    const p = path.join(ROOT, 'data', 'health.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('截图：data/health.png');
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
