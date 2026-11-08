#!/usr/bin/env node
// check-desk.mjs —— 用 CDP 打开「工作台」页签，抓三类证据：
//   ① 浏览器控制台的报错 / 未捕获的 Promise 拒绝（界面白屏的元凶）
//   ② 每个面板的实际文字（面板渲染失败时会显示「面板渲染失败：xxx」）
//   ③ 截图（存 data/desk.png）
//
// ⛔ 只开「工作台」页签 —— 它不含 AI 会话面板，不会去加载引擎那个重 SPA
//    （之前把整个引擎界面拉进无头 Chrome，把用户机器压垮过一次）。
//
// 用法：node dev/check-desk.mjs [--url http://127.0.0.1:3081] [--cdp 9334]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = val('--url', 'http://127.0.0.1:3081/');
const WAIT = Number(val('--wait', 4000));
const PORT = Number(val('--cdp', 9334));
const MODE = val('--mode', 'desk');
const SHOT = val('--shot', path.join(process.cwd(), 'data', 'desk.png'));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome/Chromium/Edge'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-desk-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--disable-default-apps', '--no-default-browser-check', '--mute-audio',
  '--renderer-process-limit=2', '--js-flags=--max-old-space-size=768',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--window-size=1600,1000',
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
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.errors.push('未捕获异常：' + (d.exception?.description || d.text || ''));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
        this.errors.push(msg.params.type + '：' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
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

  // ⛔ 场景详情页里有 AI 会话面板 ⇒ 它会去 3082-3087 加载引擎那个重 SPA。
  //    把这些端口挡掉：只验界面本身，不把引擎拽进无头浏览器（有过把机器压垮的教训）。
  try {
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', {
      urls: [3082, 3083, 3084, 3085, 3086, 3087].map((p) => '*://127.0.0.1:' + p + '/*'),
    });
  } catch (e) { console.log('（挡端口失败：' + e.message + '）'); }

  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(2500);

  // 切到指定页签；mode 形如 "scene:research" 时点开那张卡片
  const mode = MODE;
  let clicked;
  if (mode.indexOf('scene:') === 0) {
    const sid = mode.slice(6);
    clicked = await cdp.eval(`(function(){
      var c = document.querySelector('.scene-card[data-sc-id="${sid}"]');
      if (c) { c.click(); return 'clicked'; }
      return 'no-card';
    })()`);
  } else {
    clicked = await cdp.eval(`(function(){
      var b = document.querySelector('#mainnav .navbtn[data-mode="${mode}"]');
      if (b) { b.click(); return 'clicked'; }
      return 'no-button';
    })()`);
  }
  console.log('页签：' + mode + ' → ' + clicked);
  await sleep(WAIT);

  console.log('── 面板实际文字 ──');
  const panels = await cdp.eval(`(function(){
    var out = [];
    document.querySelectorAll('.panel').forEach(function(p){
      var b = p.querySelector('.panel-body');
      var t = p.querySelector('.panel-title');
      out.push({ id: p.getAttribute('data-panel-id'), title: t ? t.textContent : '', text: b ? b.innerText.slice(0, 600) : '' });
    });
    return out;
  })()`);
  for (const p of panels || []) {
    console.log('');
    console.log('▌' + p.title + '（' + p.id + '）');
    console.log('  ' + (p.text || '(空)').split('\n').filter(Boolean).join('\n  '));
  }

  // 目录页 / 注册页不是 .panel 结构 ⇒ 直接把 #view 的文字读出来
  if (mode !== 'desk') {
    const viewText = await cdp.eval(`(function(){
      var v = document.querySelector('#view');
      return v ? v.innerText.slice(0, 1200) : '(没有 #view)';
    })()`);
    console.log('');
    console.log('── 页面正文 ──');
    console.log('  ' + String(viewText).split('\n').filter(Boolean).join('\n  '));
  }

  console.log('');
  console.log('── 控制台报错 ──');
  if (!cdp.errors.length) console.log('  ✓ 没有报错');
  else cdp.errors.forEach((e) => console.log('  ✗ ' + e));

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(r.data, 'base64'));
    console.log('');
    console.log('截图：' + SHOT);
  }).catch(() => {});
} catch (e) {
  console.error('检查失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
