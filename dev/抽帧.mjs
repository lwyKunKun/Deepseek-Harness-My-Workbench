#!/usr/bin/env node
// 抽帧.mjs —— 用无头 Chrome 播放本地视频并按时间点截图
//
// 为什么不用 ffmpeg：机器上没有，而 Chrome 本身就能播 mp4 ——
//   浏览器里 <video> + currentTime 跳转 + CDP 截图，够用了。
//
// 用法：
//   node dev/抽帧.mjs <视频路径> <输出目录> <秒,秒,秒…>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const video = process.argv[2];
const outDir = process.argv[3] || '/tmp/frames';
const times = (process.argv[4] || '0,60,120,180,240,300,360,420,480,540,600,660,720')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

if (!video || !fs.existsSync(video)) {
  console.error('用法：node dev/抽帧.mjs <视频> <输出目录> [秒,秒,…]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const PORT = 9460;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-frames-'));
const ch = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
  '--allow-file-access-from-files', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = l.find((t) => t.type === 'page');
      if (target) break;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!target) { console.error('Chrome 没起来'); ch.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id; pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.text || 'eval 失败');
    }
    return r.result.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  // ⚠ 不设视口，截图会被裁成默认的 800×600 ⇒ 画面看不清
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });

  const html = '<!doctype html><meta charset="utf-8">'
    + '<body style="margin:0;background:#000">'
    + '<video id="v" style="width:1280px;height:720px" src="file://' + path.resolve(video) + '"></video>';
  fs.writeFileSync(path.join(profile, 'page.html'), html);
  await send('Page.navigate', { url: 'file://' + path.join(profile, 'page.html') });
  await sleep(2500);

  const dur = await evaluate('document.getElementById("v").duration');
  console.log('视频时长：' + Math.round(dur) + ' 秒');

  for (const t of times) {
    const tt = Math.min(t, Math.max(0, dur - 1));
    await evaluate(`(function(){
      var v=document.getElementById("v");
      return new Promise(function(res){
        if (Math.abs(v.currentTime - ${tt}) < 0.05) return res(true);
        v.addEventListener("seeked", function(){ res(true); }, {once:true});
        v.currentTime = ${tt};
        setTimeout(function(){ res(false); }, 8000);
      });
    })()`, true);
    await sleep(450);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, 'f' + String(Math.round(tt)).padStart(4, '0') + '.png');
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log('  ✓ ' + path.basename(file));
  }

  ch.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
})();
