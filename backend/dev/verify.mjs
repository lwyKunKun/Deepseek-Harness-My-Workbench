#!/usr/bin/env node
// verify.mjs —— 用 CDP 驱动真实浏览器，验证「钉会话」这条链路
//
// 为什么不用 --screenshot --virtual-time-budget：
//   虚拟时间不会推进**跨源 iframe** 里的定时器，而钉会话的点击兜底正是靠定时器触发的。
//   所以这里用 CDP 连一个**正常跑**的无头浏览器，等真实时间过去，再回读证据。
//
// 用法：
//   node dev/verify.mjs --url http://127.0.0.1:3088/?scene=pintest --mock http://127.0.0.1:3099
//
// 证据有三层：
//   ① 父页面：面板标题栏的小字诊断（钉没钉住）
//   ② mock 引擎：它到底选中了哪条会话（服务端记的，不是自己说了算）
//   ③ 面板 iframe：localStorage['dsh.sessions.current'] 的值

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = val('--url', 'http://127.0.0.1:3081/');
const MOCK = val('--mock', '');
const WAIT = Number(val('--wait', 6000));
const PORT = Number(val('--cdp', 9333));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));

if (!CHROME) { console.error('找不到 Chrome/Chromium/Edge'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-verify-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  // ⛔ 资源限制：真引擎是个重 SPA，不限住会把机器压垮（有过教训）
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-default-apps', '--no-default-browser-check', '--mute-audio',
  '--renderer-process-limit=2', '--js-flags=--max-old-space-size=768',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--window-size=1400,900',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时：' + method)); }
      }, 20000);
    });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
}

let cdp = null;
try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(WAIT);

  console.log('');
  console.log('── ① 父页面：面板诊断小字 ──');
  const diag = await cdp.eval(`(function(){
    var out = [];
    document.querySelectorAll('.panel').forEach(function(p){
      var d = p.querySelector('.panel-diag');
      out.push({ panel: p.getAttribute('data-panel-id'), diag: d ? d.textContent : '(无)', title: d ? d.title : '' });
    });
    return out;
  })()`);
  for (const d of diag || []) {
    console.log('   面板 ' + d.panel + '：' + d.diag);
    if (d.title) console.log('      ' + d.title.split('\n').join('\n      '));
  }

  console.log('');
  console.log('── ② iframe 里的存储键（dsh.sessions.current）──');
  const frames = await cdp.send('Page.getFrameTree');
  const all = [];
  (function walk(n) { all.push(n.frame); (n.childFrames || []).forEach(walk); })(frames.frameTree);
  for (const f of all) {
    if (f.url.indexOf('/engine/') < 0) continue;
    console.log('   面板 iframe：' + f.url.split('?')[0] + '  (id=' + f.id + ')');
  }

  if (MOCK) {
    console.log('');
    console.log('── ③ mock 引擎记录的选中结果 ──');
    const st = await (await fetch(MOCK + '/mock/state')).json();
    console.log('   选中的会话：' + (st.title || '（无）') + '   id=' + (st.id || '（无）'));
    const probes = await (await fetch(MOCK + '/mock/probes')).json();
    for (const p of probes.slice(-2)) {
      console.log('   probe: pinLoaded=' + p.pinLoaded + ' stored=' + (p.stored || '(空)'));
      console.log('          title=' + (p.title || '(空)') + ' current=' + (p.current || '(空)'));
    }
  }

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    fs.writeFileSync(path.join(process.cwd(), 'data', 'verify.png'), Buffer.from(r.data, 'base64'));
    console.log('');
    console.log('   截图：data/verify.png');
  }).catch(() => {});
} catch (e) {
  console.error('验证失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
