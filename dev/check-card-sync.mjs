#!/usr/bin/env node
// check-card-sync.mjs —— 验「身份卡是职责与技能的唯一来源」
//
// 判据（四条）：
//   ① 场景页头部那行「职责」 == 身份卡里的「职责」（逐个角色对）
//   ② 头部那排「技能」标签 == 身份卡里的「技能」（逐个角色对）
//   ③ 在身份卡面板里改职责 → 保存 ⇒ 详情页标题当场变、回列表页头部当场变
//   ④ 改回来 ⇒ 头部回到原值（脚本自己还原，别给机主留垃圾）
//
// ⚠ 这里**自己**解析身份卡（不 import lib/memory.mjs）——
//   拿后端同一份解析器来对，就成了自己跟自己比，测不出东西。
//
// 用法：node dev/check-card-sync.mjs [--cdp 9401] [--url http://127.0.0.1:3080/]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = val('--url', 'http://127.0.0.1:3080/');
const PORT = Number(val('--cdp', 9401));
const ROOT = process.cwd();

// 自检用的角色（它的卡会被改一下再改回来）
const SCENE = val('--scene', 'work');
const SCENE_NAME = '总项目';
const MARK = '自检：改过的职责';
const SHOT = val('--shot', path.join(process.cwd(), 'data', 'card-sync.png'));

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cardsync-'));
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

/* ── 自己解析身份卡（独立于后端那套） ─────────────────────────────── */
const cardFile = (id) => path.join(ROOT, 'memory', id, '身份卡.md');
const cardText = (id) => {
  try { return fs.readFileSync(cardFile(id), 'utf8'); } catch (e) { return ''; }
};
/** 「- 职责：xxx」那一行（就认这个格式，不搞花哨的）。 */
function cardLine(text, key) {
  const m = String(text || '').match(new RegExp('^- ' + key + '：(.*)$', 'm'));
  return m ? m[1].trim() : '';
}
/** 括号包着的 / TODO ⇒ 模板占位，当没写。 */
function placeholder(v) {
  const s = String(v || '').trim();
  if (!s) return true;
  if (/^todo$/i.test(s)) return true;
  return /^（/.test(s);
}
const sceneIds = fs.readdirSync(path.join(ROOT, 'scenarios'))
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort();
/** 期望显示的值：卡里有实在内容就用它，否则用 json 里的（兜底）。 */
function expectOf(id) {
  const text = cardText(id);
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', id + '.json'), 'utf8'));
  const duty = cardLine(text, '职责');
  const skills = cardLine(text, '技能');
  return {
    duty: placeholder(duty) ? String(raw.duty || raw.description || '') : duty,
    skills: placeholder(skills)
      ? (raw.skills || [])
      : skills.split('/').map((x) => x.trim()).filter(Boolean),
  };
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
  async eval(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
}

const HOST_FN = `(function(){
  var host=null;
  document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) host=el; });
  return host;
})()`;

/** 进「工作台」侧栏。 */
async function openWorkbench(cdp) {
  await cdp.eval(`(function(){
    var all = document.querySelectorAll('button, [role="button"]');
    for (var i=0;i<all.length;i++){ if ((all[i].getAttribute('aria-label')||'') === '工作台') { all[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(2600);
}

/** 点左树里的某个角色 ⇒ 读它头部的职责行与技能标签。 */
async function headOf(cdp, id) {
  await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var back = host.shadowRoot.querySelector('.detail-head button');
    if (back) back.click();
    var leaf = host.shadowRoot.querySelector('.side-leaf[data-sc-id="${id}"]');
    if (leaf) leaf.click();
    return leaf ? 1 : 0;
  })()`);
  await sleep(1500);
  return cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return { err: 'no-host' };
    var duty = host.shadowRoot.querySelector('.cat-main-duty');
    var tags = [];
    host.shadowRoot.querySelectorAll('.cat-main-tag').forEach(function(t){ tags.push(t.textContent); });
    var name = host.shadowRoot.querySelector('.cat-main-name');
    return { duty: duty ? duty.textContent : '', skills: tags, name: name ? name.textContent : '' };
  })()`);
}

/** 进某个场景的详情页。 */
async function openDetail(cdp, id) {
  await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var back = host.shadowRoot.querySelector('.detail-head button');
    if (back) back.click();
    var leaf = host.shadowRoot.querySelector('.side-leaf[data-sc-id="${id}"]');
    if (leaf) leaf.click();
    return leaf ? 1 : 0;
  })()`);
  await sleep(1500);
  await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var btns = host.shadowRoot.querySelectorAll('.cat-main button, .panel-card button, .side-leaf button');
    for (var i=0;i<btns.length;i++){ if ((btns[i].textContent||'').indexOf('打开场景')>=0) { btns[i].click(); return 1; } }
    return 0;
  })()`);
  await sleep(2600);
}

/** 身份卡面板的 textarea 里改「职责」那一行 ⇒ 保存。 */
async function saveCardDuty(cdp, scene, dutyText) {
  const typed = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 'no-host';
    var ta = host.shadowRoot.querySelector('[data-panel-id="${scene}-id"] textarea');
    if (!ta) return 'no-textarea';
    var lines = ta.value.split('\\n');
    var hit = false;
    for (var i=0;i<lines.length;i++){
      if (lines[i].indexOf('- 职责：') === 0) { lines[i] = '- 职责：' + ${JSON.stringify(dutyText)}; hit = true; break; }
    }
    if (!hit) return 'no-duty-line';
    ta.value = lines.join('\\n');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    var btn = null;
    host.shadowRoot.querySelectorAll('[data-panel-id="${scene}-id"] button').forEach(function(b){
      if ((b.textContent||'').indexOf('保存') >= 0) btn = b;
    });
    if (!btn) return 'no-save';
    btn.click();
    return 'ok';
  })()`);
  await sleep(2200);
  return typed;
}

/** 详情页标题下的职责（保存后应当场变）。 */
async function detailDuty(cdp) {
  return cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return '';
    var d = host.shadowRoot.querySelector('.detail-duty');
    return d ? d.textContent : '';
  })()`);
}

/** 回列表页。 */
async function backToList(cdp) {
  await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 0;
    var b = host.shadowRoot.querySelector('.detail-head button');
    if (b) { b.click(); return 1; }
    return 0;
  })()`);
  await sleep(1800);
}

/* 自检自己写进留痕的那几行 ⇒ 删掉（别给机主留垃圾痕迹）。 */
function cleanupTrace(scene, fromTs) {
  const f = path.join(ROOT, 'data', 'acts', scene + '.jsonl');
  try {
    if (!fs.existsSync(f)) return;
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter((l) => {
      try { const o = JSON.parse(l); return !(o.action === '写身份卡' && o.at >= fromTs); }
      catch (e) { return true; }
    });
    if (kept.length === lines.length) return;
    fs.writeFileSync(f, kept.join('\n') + '\n', 'utf8');
    console.log('清掉自检痕迹：' + f + '（-' + (lines.length - kept.length) + ' 行）');
  } catch (e) { /* 清不掉就算了 */ }
}

const rows = [];
const ok = (cond, text) => { rows.push([cond, text]); console.log((cond ? '✓ ' : '✗ ') + text); };

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
  await openWorkbench(cdp);

  /* ── ① ② 逐个角色：头部职责/技能 == 身份卡里的职责/技能 ─────────── */
  console.log('\n① 逐个角色核对：头部那行职责 & 那排技能标签');
  let dutyBad = [];
  let skillBad = [];
  for (const id of sceneIds) {
    const want = expectOf(id);
    const got = await headOf(cdp, id);
    if (String(got.duty || '').trim() !== String(want.duty || '').trim()) {
      dutyBad.push(id + '（界面「' + got.duty + '」/ 卡里「' + want.duty + '」）');
    }
    const gs = (got.skills || []).join(' / ');
    const ws2 = (want.skills || []).join(' / ');
    if (gs !== ws2) skillBad.push(id + '（界面「' + gs + '」/ 卡里「' + ws2 + '」）');
  }
  ok(dutyBad.length === 0, '① 头部职责 == 身份卡里的职责（' + sceneIds.length + ' 个角色'
    + (dutyBad.length ? '，不对：' + dutyBad.join('；') : '') + '）');
  ok(skillBad.length === 0, '② 头部技能标签 == 身份卡里的技能（' + sceneIds.length + ' 个角色'
    + (skillBad.length ? '，不对：' + skillBad.join('；') : '') + '）');

  /* ── ③ 改身份卡 ⇒ 头部当场跟着变 ─────────────────────────────── */
  console.log('\n③ 在身份卡面板里改职责 ⇒ 保存 ⇒ 头部当场变');
  const cardBefore = cardText(SCENE);
  const dutyBefore = cardLine(cardBefore, '职责');
  const fromTs = Date.now();
  await openDetail(cdp, SCENE);
  const typed = await saveCardDuty(cdp, SCENE, MARK);
  ok(typed === 'ok', '③ 身份卡面板里改到了「职责」那一行并保存（' + typed + '）');
  const onDisk = cardLine(fs.readFileSync(cardFile(SCENE), 'utf8'), '职责');
  ok(onDisk === MARK, '③ 身份卡文件真的改了（磁盘上是「' + onDisk + '」）');
  const dd = await detailDuty(cdp);
  ok(String(dd).trim() === MARK, '③ 详情页标题下的职责当场变了（「' + dd + '」）');
  await backToList(cdp);
  const back = await headOf(cdp, SCENE);
  ok(String(back.duty || '').trim() === MARK, '③ 回列表页头部那行职责当场变了（「' + back.duty + '」）');

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(r.data, 'base64'));
    console.log('截图：' + SHOT);
  }).catch(() => {});

  /* ── ④ 改回来 ─────────────────────────────────────────────────── */
  console.log('\n④ 改回来（还原原文件）');
  await openDetail(cdp, SCENE);
  const restored = await cdp.eval(`(function(){
    var host = ${HOST_FN};
    if (!host) return 'no-host';
    var ta = host.shadowRoot.querySelector('[data-panel-id="${SCENE}-id"] textarea');
    if (!ta) return 'no-textarea';
    ta.value = ${JSON.stringify(cardBefore)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    var btn = null;
    host.shadowRoot.querySelectorAll('[data-panel-id="${SCENE}-id"] button').forEach(function(b){
      if ((b.textContent||'').indexOf('保存') >= 0) btn = b;
    });
    if (!btn) return 'no-save';
    btn.click();
    return 'ok';
  })()`);
  await sleep(2200);
  ok(restored === 'ok', '④ 身份卡已还原');
  const dutyAfter = cardLine(fs.readFileSync(cardFile(SCENE), 'utf8'), '职责');
  ok(dutyAfter === dutyBefore, '④ 磁盘上的职责回到原值（「' + dutyAfter + '」）');
  await backToList(cdp);
  const back2 = await headOf(cdp, SCENE);
  ok(String(back2.duty || '').trim() === dutyBefore, '④ 头部那行职责也回到原值（「' + back2.duty + '」）');

  cleanupTrace(SCENE, fromTs);

  console.log('');
  const bad = rows.filter((r) => !r[0]);
  console.log(bad.length ? '❌ 不对：' + bad.map((r) => r[1]).join('；') : '✓ 四条判据全过');
  console.log('控制台报错：' + (cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '无'));
  process.exitCode = bad.length ? 1 : 0;
} catch (e) {
  console.error('失败：' + e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill(); } catch (e) { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
