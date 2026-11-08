#!/usr/bin/env node
// 工作台服务端 —— 一台机器，三个角色
//
//   ① 界面服务器：给浏览器发前端（场景标签栏 + 网格面板）
//   ② 引擎代理：把 /engine/* 原样转给 DSH 引擎（带 Cookie），让 AI 面板能内嵌引擎界面
//   ③ 工作台 API：场景、记忆、会话（建/改名/归档/列）
//
// 为什么要有代理这一层（关键设计）：
//   引擎的 cookie 里绑定了「audience」= 请求的 Host:Port。
//   所以代理时 Host 必须改成引擎自己的 127.0.0.1:3080，
//   否则换出来的 cookie 对不上，引擎永远 401。
//
//   代理之后，AI 面板的 iframe 和工作台页面**同源**（同协议同主机同端口），
//   于是注入进去的 pin.js 能直接读写 iframe 里的 localStorage ——
//   这就是「写键直达 + 点行兜底」能落地的前提。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PATHS, SERVER, ENGINE, PANEL_PORT, ensureDirs, readJson, writeJson } from './lib/config.mjs';
import { loadScenes, getScene, resolveScene } from './lib/scenes.mjs';
import { proxyHttp, proxyUpgrade, probe, exchangeToken, rpc } from './lib/engine.mjs';
import * as mem from './lib/memory.mjs';
import * as dispatch from './lib/dispatch.mjs';
import * as loadGate from './lib/loadgate.mjs';
import * as gpu from './lib/gpu.mjs';
import * as authority from './lib/authority.mjs';
import * as triage from './lib/triage.mjs';
import * as writelog from './lib/writelog.mjs';
import * as dashboard from './lib/dashboard.mjs';
import * as doctor from './lib/doctor.mjs';
import * as writeapi from './lib/writeapi.mjs';
import { findWorkspace } from './lib/dsh-cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  res.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj, null, 2), { 'content-type': 'application/json; charset=utf-8' });
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, file, { inject = false } = {}) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, '找不到：' + path.basename(file));
    return;
  }
  const ext = path.extname(file).toLowerCase();
  let body = fs.readFileSync(file);
  if (inject) {
    const html = body.toString('utf8');
    const tag = '<script src="/__wb/pin.js" data-wb-pin="1"></script>';
    body = Buffer.from(html.includes('</head>') ? html.replace('</head>', tag + '</head>') : tag + html, 'utf8');
  }
  send(res, 200, body, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
}

/** 从请求里取浏览器手上的引擎 cookie（浏览器对 127.0.0.1 的 cookie 端口无关，能直接用）。 */
function cookieOf(req) {
  const c = req.headers.cookie || '';
  if (c) { rememberCookie(c); return c; }
  // 浏览器没带（比如命令行调本工作台的 API）⇒ 用服务端自己存的那份
  try {
    const j = readJson(cookieFile, null);
    return (j && j.cookie) || '';
  } catch (e) {
    return '';
  }
}

/**
 * 记住浏览器带来的引擎 cookie。
 * 用途：浏览器在 127.0.0.1:3080 登录过 GUI 之后，cookie 对同主机的所有端口都有效，
 * 工作台代理直接转发它即可；而命令行脚本没有浏览器 ⇒ 把这份 cookie 落盘给它们用。
 */
let cookieFile = path.join(PATHS.data, 'engine-cookie.json');
function rememberCookie(cookie) {
  try {
    const prev = readJson(cookieFile, null);
    if (prev && prev.cookie === cookie) return;
    writeJson(cookieFile, { cookie, at: Date.now() });
  } catch (e) { /* ignore */ }
}
function storedCookie() {
  try {
    const j = readJson(cookieFile, null);
    return (j && j.cookie) || '';
  } catch (e) {
    return '';
  }
}
/**
 * 代理请求前保证带着引擎 cookie：
 *   浏览器有 ⇒ 用浏览器的（它可能是更新的那份）
 *   浏览器没有 ⇒ 用服务端存的那份（命令行、开新浏览器都能用）
 */
function ensureEngineCookie(req) {
  if (req.headers.cookie) { rememberCookie(req.headers.cookie); return; }
  const c = storedCookie();
  if (c) req.headers.cookie = c;
}

/** 把工作台自己的 RPC 转给引擎。 */
async function engineRpc(res, method, args, cookie) {
  const out = await rpc(method, args, cookie);
  if (out.status === 401) {
    sendJson(res, 401, {
      ok: false,
      error: '引擎未认证：请在「引擎连接」里粘贴 dsh web 启动时打印的 token',
    });
    return;
  }
  const value = out.json && out.json.result && out.json.result.ok === true
    ? out.json.result.value
    : (out.json && out.json.result && out.json.result.error) || null;
  sendJson(res, out.status === 200 ? 200 : (out.status >= 400 ? out.status : 502), {
    ok: out.status === 200,
    value,
    raw: out.json,
  });
}

/** 归一化 session/list 的返回，挑出我们要的字段。 */
function normalizeSessions(payload) {
  const items = (payload && payload.items) || [];
  return items.map((it) => {
    const v = (it.projections && it.projections.values) || {};
    return {
      sessionId: it.sessionId,
      title: v.title || '',
      cwd: v.cwd || it.cwd || '',
      updatedAt: it.updatedAt || null,
      blank: !!it.blank,
      running: !!it.running,
      workingDirectory: v.workingDirectory || '',
      contextPressure: v.contextPressure || null,
    };
  });
}

/* ── 服务端自己掌握的引擎 token（可选） ─────────────────────────── */
async function serverToken() {
  if (process.env.DSH_TOKEN) return process.env.DSH_TOKEN.trim();
  const f = path.join(PATHS.data, 'token.txt');
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t) return t;
  } catch (e) { /* 没有就算了 */ }
  return '';
}

/* ── 文件访问：只允许工作台目录与当前工作区（防目录穿越） ───────── */
const FS_ROOTS = [path.resolve(PATHS.root), path.resolve(process.cwd())];

function fsAllowed(p) {
  try {
    const real = fs.realpathSync(p);
    return FS_ROOTS.some((root) => real === root || real.startsWith(root + path.sep));
  } catch (e) {
    return false;
  }
}

function fsResolve(p) {
  const abs = path.resolve(FS_ROOTS[0], p);
  if (!fsAllowed(abs)) return null;
  return abs;
}

function handleFsList(res, dir) {
  const abs = fsResolve(dir || '.');
  if (!abs) { sendJson(res, 403, { ok: false, error: '这个目录不在允许范围内' }); return; }
  let names;
  try { names = fs.readdirSync(abs); } catch (e) {
    sendJson(res, 400, { ok: false, error: '读不了目录：' + e.message }); return;
  }
  const rows = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(abs, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory() && !fsAllowed(full)) continue;
    rows.push({ name, path: full, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
  }
  rows.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  sendJson(res, 200, { ok: true, dir: abs, rows });
}

function handleFsRead(res, p) {
  const abs = fsResolve(p || '');
  if (!abs) { sendJson(res, 403, { ok: false, error: '这个文件不在允许范围内' }); return; }
  let st;
  try { st = fs.statSync(abs); } catch (e) {
    sendJson(res, 404, { ok: false, error: '文件不存在' }); return;
  }
  if (st.size > 2 * 1024 * 1024) { sendJson(res, 413, { ok: false, error: '文件太大（>2MB）' }); return; }
  sendJson(res, 200, { ok: true, path: abs, size: st.size, text: fs.readFileSync(abs, 'utf8') });
}

/* ── 面板代理端口池：每个 AI 面板一个独立 origin = 独立 localStorage ── */
function panelHandler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__wb/pin.js') {
    serveStatic(res, path.join(PATHS.web, 'pin.js'));
    return;
  }
  // ⚠ 面板端口要代理**引擎的全部路径**，不能只代理 /engine/*：
  //   引擎界面里的 API 调用是绝对路径（/api/session/…），懒加载的 chunk 也是。
  //   只代理 /engine/* 的话，GUI 会加载出壳却发不出任何请求。
  if (url.pathname === '/engine' || url.pathname.startsWith('/engine/')) {
    const rest = url.pathname.slice('/engine'.length) || '/';
    const pinCfg = url.searchParams.get('__wbpin') || '';
    req.url = rest + (url.search || '');
    ensureEngineCookie(req);
    proxyHttp(req, res, { injectPin: true, pinCfg });
    return;
  }
  req.url = url.pathname + url.search;
  ensureEngineCookie(req);
  proxyHttp(req, res, { injectPin: false });
}

/** 读场景自己的便签。 */
function readScratch(scene, dir, file) {
  const abs = path.join(PATHS.memory, scene, dir, file);
  if (!abs.startsWith(path.join(PATHS.memory, scene))) return '';
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

/** 读共享层的一份文档（宪法/索引）。 */
function readShared(name) {
  const f = mem.sharedPath(name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
}

/** 把索引落盘（自动生成，不靠人手维护）。 */
function writeIndexFile(rows) {
  const lines = [
    '# 索引',
    '',
    '> 自动生成。文件多了以后 AI 只看这张表，不用全量扫目录。',
    '> 场景索引 = 有哪些场景；资产索引 = 每个文件在哪、多大。',
    '',
    '## 场景索引',
    '',
    '| 场景 | 在哪 | 职责 | 大小 |',
    '|---|---|---|---|',
  ];
  for (const r of rows.filter((x) => x.kind === '场景')) {
    lines.push('| ' + r.name + ' | ' + r.where + ' | ' + (r.note || '').replace(/\|/g, '／') + ' | ' + r.size + ' |');
  }
  lines.push('');
  lines.push('## 资产索引');
  lines.push('');
  lines.push('| 归属 | 文件 | 在哪 | 大小 |');
  lines.push('|---|---|---|---|');
  for (const r of rows.filter((x) => x.kind !== '场景')) {
    lines.push('| ' + r.kind + ' | ' + r.name + ' | ' + r.where + ' | ' + r.size + ' |');
  }
  lines.push('');
  fs.mkdirSync(mem.sharedPath(), { recursive: true });
  fs.writeFileSync(mem.sharedPath(mem.INDEX_FILE), lines.join('\n'), 'utf8');
}

/** 索引表：每个场景一行（场景索引）+ 每个资产文件一行（资产索引）。 */
function buildIndexRows() {
  const rows = [];
  for (const sc of loadScenes()) {
    const h = mem.health(sc.id);
    rows.push({
      kind: '场景',
      key: sc.id,
      name: sc.name,
      where: 'memory/' + sc.id + '/',
      size: h.bytes,
      note: (sc.duty || sc.description || '') + (h.problems.length ? '　⚠ ' + h.problems.join('；') : ''),
    });
  }
  if (fs.existsSync(PATHS.memory)) {
    for (const scene of fs.readdirSync(PATHS.memory)) {
      const dir = path.join(PATHS.memory, scene);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (!fs.statSync(full).isFile()) continue;
        rows.push({
          kind: scene.startsWith('_') ? '共享' : '资产',
          key: scene + '/' + f,
          name: f,
          where: 'memory/' + scene + '/' + f,
          size: fs.statSync(full).size,
          note: '',
        });
      }
    }
  }
  return rows;
}

/* ── 派单投递：★ 必须真唤醒（发进对方会话），不是「我写进文件了」 ── */
async function deliverDispatch(rec, cookie) {
  const scene = resolveScene(rec.to);
  if (!scene) return { error: '没有这个场景：' + rec.to + '（按 id 和名字都找过了）' };
  const panel = (scene.panels || []).find((p) => p.type === 'harness' && p.sessionId);
  if (!panel) {
    return { error: '场景「' + rec.to + '」没有绑定会话的 AI 面板 —— 先给它建一条会话并钉上（scenarios/' + rec.to + '.json）' };
  }
  const ackFile = dispatch.ackPath(rec.hash);
  const prompt = [
    '【派单 · 来自「' + rec.from + '」】主题：' + rec.topic + '（编号 ' + rec.hash + '）',
    '',
    rec.body,
    '',
    '请按上面四件套干活。干完 / 卡住 / 干不了 都要回执。',
    '回执格式（固定三段，缺证据等于没说）：',
    '  结论：<一句话>',
    '  证据：<跑了什么 / 几个通过 / 差异集合>',
    '  落盘：<你改了哪些文件>',
    '把回执写到下面这个文件（写进文件我才看得见；只在自己窗口说「我做完了」= 没交付）：',
    '  ' + ackFile,
    '末行写【结束】。',
    '',
    '⛔ 地盘（只写这三处，别的一律不碰）：',
    '   ① memory/' + rec.to + '/  —— 你自己场景的记忆',
    '   ② ' + ackFile,
    '   ③ memory/_共享记忆/_跨场景通知.md（看板）',
    '   别的场景的记忆目录：⛔ 一个字都不许写（那是别人的地盘，写了会污染对方的判断）。',
    '   规矩与工具（memory/_共享记忆/*.md、lib/、dev/）是 A/C 档 ⇒ 只有规则负责人能改。',
    '   要改别人的东西 ⇒ 只能提请求（一次派单），别自己动手。',
    '   改之前可以先判一次（会告诉你能不能动、归谁）：',
    '   curl -s "http://127.0.0.1:3081/api/authority/check?path=<路径>&scene=' + rec.to + '"',
  ].join('\n');

  const out = await rpc('session/prompt', {
    request: {
      requestId: (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
      sessionId: panel.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    },
  }, cookie);

  if (!out.ok) {
    const why = (out.error && (out.error.message || out.error.code)) || String(out.text || '').slice(0, 240);
    return { error: '引擎没接受（HTTP ' + out.status + '）：' + why };
  }
  return { delivered: 'RPC-200 · 已唤醒 ' + rec.to + ' 的会话 ' + panel.sessionId, ackFile };
}

/* ── 待办板写入（分诊用） ─────────────────────────────────────── */
function todoWrite(body) {
  const action = String(body.action || 'add');
  fs.mkdirSync(path.dirname(dispatch.TODO_FILE), { recursive: true });
  let lines = [];
  if (fs.existsSync(dispatch.TODO_FILE)) {
    lines = fs.readFileSync(dispatch.TODO_FILE, 'utf8').split('\n');
  }
  const text = String(body.text || '').trim();
  if (!text) return { ok: false, error: '没内容' };

  const render = (t) => '- [' + (t.done ? 'x' : ' ') + '] ' + t.text + (t.owner ? ' @' + t.owner : '');

  if (action === 'add') {
    lines.push(render({ done: false, text, owner: String(body.owner || '').trim() }));
    lines.push('');
  } else {
    const idx = lines.findIndex((l) => l.includes(text));
    if (idx < 0) return { ok: false, error: '待办板上没有这一条：' + text };
    if (action === 'toggle') {
      // ⚠ 别写成 .replace(a,b).replace(b,a) —— 两次替换会把自己抵消回去
      lines[idx] = lines[idx].startsWith('- [x]')
        ? lines[idx].replace('- [x]', '- [ ]')
        : lines[idx].replace('- [ ]', '- [x]');
    } else if (action === 'remove') {
      lines.splice(idx, 1);
    } else if (action === 'owner') {
      const t = dispatch.readTodos().find((x) => x.text === text);
      if (t) lines[idx] = render({ done: t.done, text: t.text, owner: String(body.owner || '').trim() });
    } else {
      return { ok: false, error: '未知动作：' + action };
    }
  }
  fs.writeFileSync(dispatch.TODO_FILE, lines.join('\n'), 'utf8');
  return { ok: true, todos: dispatch.readTodos() };
}

/** 场景 → 会话 的清单（审计/写痕都要用）。 */
function sceneSessions() {
  const sessions = [];
  for (const sc of loadScenes()) {
    for (const p of sc.panels || []) {
      if (p.type === 'harness' && p.sessionId) {
        sessions.push({ sessionId: p.sessionId, scene: sc.id, sceneName: sc.name });
      }
    }
  }
  return sessions;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;

  try {
    // ── 引擎代理：AI 面板内嵌引擎界面 ─────────────────────────────
    if (p === '/engine' || p.startsWith('/engine/')) {
      const rest = p.slice('/engine'.length) || '/';
      const pinCfg = url.searchParams.get('__wbpin') || '';
      req.url = rest + (url.search || '');
      ensureEngineCookie(req);
      proxyHttp(req, res, { injectPin: true, pinCfg });
      return;
    }

    // ── 文件浏览 ─────────────────────────────────────────────────
    if (p === '/api/fs/list') { handleFsList(res, url.searchParams.get('dir') || '.'); return; }
    if (p === '/api/fs/read') { handleFsRead(res, url.searchParams.get('path') || ''); return; }

    // ── 场景顺序（标签栏拖拽换位后持久化） ───────────────────────
    if (p === '/api/scene/order' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      writeJson(path.join(PATHS.data, 'scene-order.json'), { ids });
      sendJson(res, 200, { ok: true, ids });
      return;
    }

    // ── 把一条真实会话钉到场景里的某个面板 ───────────────────────
    if (p === '/api/scene/bind' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sceneId = String(body.scene || '');
      const file = path.join(PATHS.scenarios, sceneId + '.json');
      const raw = readJson(file);
      if (!raw) { sendJson(res, 404, { ok: false, error: '没有这个场景：' + sceneId }); return; }
      let hit = null;
      for (const p2 of raw.panels || []) {
        if (String(p2.id) === String(body.panelId)) { hit = p2; break; }
      }
      if (!hit) { sendJson(res, 404, { ok: false, error: '这个场景里没有面板：' + body.panelId }); return; }
      hit.sessionId = String(body.sessionId || '').trim();
      hit.sessionTitle = String(body.title || '').trim();
      const targets = Array.isArray(hit.pinTarget) ? hit.pinTarget.slice() : [];
      if (hit.sessionTitle && !targets.includes(hit.sessionTitle)) targets.unshift(hit.sessionTitle);
      hit.pinTarget = targets;
      writeJson(file, raw);
      sendJson(res, 200, { ok: true, panel: hit });
      return;
    }


    // ── 注入脚本本体（从 iframe 里加载） ──────────────────────────
    if (p === '/__wb/pin.js') {
      serveStatic(res, path.join(PATHS.web, 'pin.js'));
      return;
    }

    // ── 前端静态资源 ────────────────────────────────────────────
    if (p === '/' || p === '/index.html') {
      serveStatic(res, path.join(PATHS.web, 'index.html'));
      return;
    }
    if (/^\/[A-Za-z0-9_.-]+\.(js|css|svg|png|ico|woff2?)$/.test(p)) {
      const file = path.join(PATHS.web, path.basename(p));
      if (fs.existsSync(file)) { serveStatic(res, file); return; }
    }

    // ── 工作台 API ──────────────────────────────────────────────
    if (p === '/api/state') {
      const status = await probe();
      sendJson(res, 200, {
        ok: true,
        server: { host: SERVER.host, port: SERVER.port, url: `http://${SERVER.host}:${SERVER.port}` },
        engine: { base: ENGINE.base, up: status.up, status: status.status },
        panelPorts: PANEL_PORTS,
        scenes: loadScenes(),
      });
      return;
    }

    if (p === '/api/scenes') {
      sendJson(res, 200, { ok: true, scenes: loadScenes() });
      return;
    }

    if (p === '/api/scene') {
      const id = url.searchParams.get('id') || '';
      const scene = getScene(id);
      if (!scene) { sendJson(res, 404, { ok: false, error: '没有这个场景：' + id }); return; }
      sendJson(res, 200, { ok: true, scene });
      return;
    }

    if (p === '/api/engine/status') {
      const status = await probe();
      sendJson(res, 200, { ok: true, engine: { base: ENGINE.base, up: status.up, status: status.status } });
      return;
    }

    // 引擎连接：把启动 token 换成签名 cookie，塞给浏览器
    if (p === '/api/engine/link') {
      let token = url.searchParams.get('token') || '';
      if (!token) token = await serverToken();
      if (!token) {
        sendJson(res, 400, { ok: false, error: '没有 token。贴一个，或给服务端设 DSH_TOKEN' });
        return;
      }
      const cookies = await exchangeToken(token);
      if (!cookies) {
        sendJson(res, 400, { ok: false, error: 'token 无效或引擎没在跑' });
        return;
      }
      const list = Array.isArray(cookies) ? cookies : [cookies];
      rememberCookie(list.map((c) => c.split(';')[0]).join('; '));
      sendJson(res, 200, { ok: true, linked: true }, {
        'set-cookie': list.map((c) => c.split(';')[0] + '; Path=/; SameSite=Lax'),
      });
      return;
    }

    // ── 自检（界面上的「自检」按钮调它）─────────────────────────
    if (p === '/api/doctor') {
      const report = await doctor.doctor();
      sendJson(res, 200, { ok: report.ok, report });
      return;
    }

    // ── 注册：登记一个新角色（= 建一个场景 + 它的记忆骨架）──────────
    if (p === '/api/scenes/create' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const name = String(body.name || '').trim();
      if (!name) { sendJson(res, 400, { ok: false, error: '要名字' }); return; }
      // id：英文/数字/短横；中文名给个拼音式的兜底（用时间戳）
      let id = String(body.id || name).trim()
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
      if (!id) {
        // 中文名做不出好 id ⇒ 给个连号的（role1 / role2 …），比时间戳好认
        let n = 1;
        while (fs.existsSync(path.join(PATHS.scenarios, 'role' + n + '.json'))) n++;
        id = 'role' + n;
      }
      if (fs.existsSync(path.join(PATHS.scenarios, id + '.json'))) {
        sendJson(res, 409, { ok: false, error: '已经有叫「' + id + '」的场景了' });
        return;
      }
      const sc = {
        id,
        name,
        icon: String(body.icon || '●'),
        category: String(body.category || '其它'),
        duty: String(body.duty || ''),
        description: String(body.duty || ''),
        skills: Array.isArray(body.skills) ? body.skills.map(String) : [],
        cols: 4,
        panels: [
          { id: id + '-id', title: '身份卡', sub: '每场读的那张卡', type: 'identity', col: 1, row: 1, w: 1, h: 5 },
          { id: id + '-mem', title: '项目信息', sub: '§〇 开场先读', type: 'memory', col: 2, row: 1, w: 1, h: 5 },
          { id: id + '-idx', title: '索引', sub: '场景索引 · 资产索引', type: 'indexmap', col: 3, row: 1, w: 1, h: 3 },
          { id: id + '-health', title: '体检', sub: '这个场景的', type: 'health', col: 3, row: 4, w: 1, h: 2 },
          { id: id + '-chat', title: 'AI·' + name, sub: '常驻会话', type: 'harness', col: 4, row: 1, w: 1, h: 5, expand: true, sessionTitle: '', sessionId: '', pinTarget: [name] },
        ],
      };
      writeJson(path.join(PATHS.scenarios, id + '.json'), sc);
      mem.scaffold(id, { name, duty: sc.duty });
      sendJson(res, 200, { ok: true, id, scene: sc, created: true });
      return;
    }

    // ── 仪表盘：五套机制的状态汇总 + 现在该做什么 ─────────────────
    if (p === '/api/dashboard') {
      let sessionIds = [];
      try {
        const lr = await rpc('session/list', { _request: {} }, cookieOf(req));
        if (lr.ok && lr.value) sessionIds = (lr.value.items || []).map((i) => i.sessionId);
      } catch (e) { /* 量不到就跳过这项体检 */ }
      const d = await dashboard.collect({ sessionIds });
      sendJson(res, 200, { ok: true, dashboard: d, oneLine: dashboard.oneLine(d) });
      return;
    }

    // ── 受闸的写接口：改任何东西之前先过权限判定 ──────────────────
    //    （核心逻辑在 lib/writeapi.mjs —— 自测也调它，不用绕 HTTP）
    if (p === '/api/write' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = writeapi.doWrite(body, { sessions: sceneSessions() });
      sendJson(res, r.status, r.body);
      return;
    }

    // ── 写入权 ────────────────────────────────────────────────────
    if (p === '/api/writes/claim' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = writeapi.doClaim(body);
      sendJson(res, r.status, r.body);
      return;
    }

    // ── 写痕与撞车（会话日志 + 受闸写接口，合起来看） ──────────────
    //    ⚠ 界面上的「写痕」面板调的就是这个；缺了它那一段会永远空白。
    if (p === '/api/writes' && req.method === 'GET') {
      const now = Date.now();
      const claims = Object.entries(writelog.loadClaims()).map(([path, c]) => ({
        path,
        scene: c.scene || '',
        at: c.at || 0,
        expires: c.expires || 0,
        expired: !!(c.expires && now > c.expires),
      }));
      sendJson(res, 200, {
        ok: true,
        history: writelog.buildHistory({ sessions: sceneSessions() }),
        claims,
      });
      return;
    }

    // ── 修改权分档：地盘表 / 路径判定 / 越界审计 ──────────────────
    if (p === '/api/authority' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        tiers: authority.TIERS,
        territory: authority.loadTerritory(),
      });
      return;
    }
    // 一行式判定（给 AI 用：改之前先问一句「这个我能动吗」）
    if (p === '/api/authority/check' && req.method === 'GET') {
      const v = authority.check(url.searchParams.get('path') || '', url.searchParams.get('scene') || '');
      const one = (v.allowed ? '✓ 允许' : '✗ 拒绝') + '　[' + v.tier + ' 档]　' + v.path + '　归属：'
        + (v.owner || '—') + '　' + v.why;
      sendJson(res, 200, { ok: true, verdict: v, one });
      return;
    }
    if (p === '/api/authority/check' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const v = authority.check(body.path || '', body.scene || '', {
        content: body.content || '',
        oldString: body.oldString || '',
      });
      sendJson(res, 200, { ok: true, verdict: v });
      return;
    }
    if (p === '/api/authority/audit') {
      const report = authority.audit({ sessions: sceneSessions() });
      sendJson(res, 200, { ok: true, report });
      return;
    }

    // ── 负载闸：★ 判据只写一处，调用方只认 canDispatch ────────────
    if (p === '/api/loadgate') {
      const fast = url.searchParams.get('fast') === '1';
      const g = await loadGate.gate(fast ? { samples: 1, intervalMs: 200 } : {});
      sendJson(res, 200, { ok: true, gate: g });
      return;
    }

    // ── GPU 优先：三类活分流 ──────────────────────────────────────
    if (p === '/api/gpu' && req.method === 'GET') {
      const probe = await gpu.probeGpu(url.searchParams.get('force') === '1');
      sendJson(res, 200, { ok: true, probe, kinds: gpu.ALL_KINDS });
      return;
    }
    if (p === '/api/gpu/verdict' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const probe = await gpu.probeGpu();
      const kind = body.kind || gpu.classifyTask(body.task || '').kind;
      const verdict = gpu.shouldUseGpu(kind, probe);
      sendJson(res, 200, {
        ok: true, verdict,
        probe,
        acceptance: gpu.acceptanceCheck(body.report || {}),
      });
      return;
    }

    // ── 派单机制 ──────────────────────────────────────────────────
    if (p === '/api/dispatch' && req.method === 'GET') {
      const scene = url.searchParams.get('scene') || '';
      // 自动销账在 dispatch.lines() 里统一做（各处口径一致）
      sendJson(res, 200, { ok: true, ...dispatch.openLines(scene), board: dispatch.readBoard() });
      return;
    }

    if (p === '/api/dispatch' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const gate = await loadGate.gate();

      // ★ 负载闸卡住「真唤醒」：机器接不了活就不许叫醒别的会话
      if (gate.verdict !== 'ok' && body.kind !== '公告') {
        sendJson(res, 409, {
          ok: false,
          error: '负载闸：' + gate.text + '（' + gate.reason + '）—— 现在不派活，先等机器缓过来',
          gate,
        });
        return;
      }

      const result = await dispatch.dispatch(body, {
        deliver: (rec) => deliverDispatch(rec, cookieOf(req)),
      });
      sendJson(res, result.ok ? 200 : 400, { ...result, gate });
      return;
    }

    if (p === '/api/dispatch/ack' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = dispatch.recordAck(body.hash, body);
      sendJson(res, r.ok ? 200 : 400, r);
      return;
    }

    if (p === '/api/dispatch/close' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = dispatch.closeLine(body.hash, body.from);
      sendJson(res, r.ok ? 200 : 400, r);
      return;
    }

    if (p === '/api/dispatch/triage') {
      const scene = url.searchParams.get('scene') || '';
      // 引擎里真实存在的会话 id（用来查「绑的会话没了」）
      let sessionIds = [];
      try {
        const lr = await rpc('session/list', { _request: {} }, cookieOf(req));
        if (lr.ok && lr.value) sessionIds = (lr.value.items || []).map((i) => i.sessionId);
      } catch (e) { /* 量不到就跳过这项体检 */ }
      const report = triage.scan({ scenes: loadScenes(), sessionIds });
      sendJson(res, 200, { ok: true, triage: report, legacy: dispatch.triage(scene) });
      return;
    }

    // 分诊：「我自己做」⇒ 台账落一行
    if (p === '/api/dispatch/claim' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const rec = triage.claimIt(String(body.scene || ''), String(body.text || ''), body.note || '');
      sendJson(res, 200, { ok: true, rec });
      return;
    }

    // ── 待办板（分诊用） ──────────────────────────────────────────
    if (p === '/api/todo' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, todos: dispatch.readTodos() });
      return;
    }
    if (p === '/api/todo' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = todoWrite(body);
      sendJson(res, r.ok ? 200 : 400, r);
      return;
    }

    // 建会话（并可顺手绑定到场景的三字段）—— 仪表盘上的「建会话并绑定」
    if (p === '/api/sessions/create' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const title = String(body.title || '').trim();
      const sceneId = String(body.scene || '').trim();
      if (!title) { sendJson(res, 400, { ok: false, error: '要有标题' }); return; }
      const cookie = cookieOf(req);
      if (!cookie) { sendJson(res, 401, { ok: false, error: '引擎未认证' }); return; }

      // 工作目录 = 工作台根目录（否则写回执要提权 ⇒ 闭环会断）
      const cwd = path.resolve(String(body.cwd || PATHS.root));
      const ws = findWorkspace(cwd);
      const created = await rpc('session/create', { request: ws ? { workspaceId: ws.workspaceId } : { cwd } }, cookie);
      if (!created.ok || !created.value || !created.value.sessionId) {
        sendJson(res, 400, { ok: false, error: '建会话失败：' + (created.error ? created.error.message : created.status) });
        return;
      }
      const sessionId = created.value.sessionId;
      await rpc('session/rename', { request: { sessionId, title } }, cookie);

      // 写回场景 json 的三字段
      let bound = null;
      if (sceneId) {
        const file = path.join(PATHS.scenarios, sceneId + '.json');
        const raw = readJson(file);
        if (raw) {
          const panel = (raw.panels || []).find((p2) => p2.type === 'harness'
            && (!body.panel || p2.id === body.panel));
          if (panel) {
            panel.sessionId = sessionId;
            panel.sessionTitle = title;
            const targets = Array.isArray(panel.pinTarget) ? panel.pinTarget.slice() : [];
            if (!targets.includes(title)) targets.unshift(title);
            panel.pinTarget = targets;
            writeJson(file, raw);
            bound = panel.id;
          }
        }
      }
      sendJson(res, 200, { ok: true, sessionId, title, bound, cwd });
      return;
    }

    // 会话列表（走引擎的 session/list，不读磁盘）
    if (p === '/api/sessions') {
      const out = await rpc('session/list', { _request: {} }, cookieOf(req));
      if (out.status === 401) {
        sendJson(res, 401, { ok: false, error: '引擎未认证', needAuth: true });
        return;
      }
      const value = out.json && out.json.result && out.json.result.value;
      sendJson(res, 200, { ok: true, sessions: normalizeSessions(value) });
      return;
    }

    // 通用 RPC 通道：建会话 / 改名 / 归档 / 发消息 …
    if (p === '/api/rpc' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const method = String(body.method || '');
      const args = body.args ?? {};
      if (!method) { sendJson(res, 400, { ok: false, error: '缺 method' }); return; }
      // 建会话必须给工作目录（否则落进「未分组」）；界面上没指定就用工作台自己的工作区
      if (method === 'session/create') {
        const req0 = (args && args.request) || {};
        if (!req0.workspaceId && !req0.cwd) {
          const def = path.join(PATHS.root, '工作区');
          fs.mkdirSync(def, { recursive: true });
          args.request = Object.assign({}, req0, { cwd: def });
        }
      }
      await engineRpc(res, method, args, cookieOf(req));
      return;
    }

    // ── 记忆：项目信息.md（分节）+ 身份卡 ─────────────────────────
    if (p === '/api/memory' && req.method === 'GET') {
      const scene = url.searchParams.get('scene') || '';
      if (url.searchParams.get('all') === '1') {
        sendJson(res, 200, { ok: true, main: mem.readMain(scene), card: mem.readCard(scene), health: mem.health(scene) });
        return;
      }
      sendJson(res, 200, { ok: true, main: mem.readMain(scene), card: mem.readCard(scene), health: mem.health(scene) });
      return;
    }
    if (p === '/api/memory' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.section) {
        const r = mem.writeSection(body.scene, body.section, body.text);
        sendJson(res, 200, { ok: true, ...r, health: mem.health(body.scene) });
        return;
      }
      if (body.card) {
        fs.mkdirSync(mem.sceneDir(body.scene), { recursive: true });
        fs.writeFileSync(mem.cardPath(body.scene), String(body.text || ''), 'utf8');
        sendJson(res, 200, { ok: true, health: mem.health(body.scene) });
        return;
      }
      sendJson(res, 400, { ok: false, error: '要写哪一节？（section）或写身份卡（card）' });
      return;
    }
    if (p === '/api/memory/handoff' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = mem.writeHandoff(body.scene, body.text);
      sendJson(res, 200, { ok: true, ...r, health: mem.health(body.scene) });
      return;
    }
    if (p === '/api/memory/scaffold' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, { ok: true, ...mem.scaffold(body.scene, { name: body.name, duty: body.duty }) });
      return;
    }

    // ── 便签（场景自己的 项目记忆/ 下；不是共享层）─────────────────
    if (p === '/api/scratch' && req.method === 'GET') {
      const scene = String(url.searchParams.get('scene') || '');
      const dir = String(url.searchParams.get('dir') || '项目记忆');
      const file = String(url.searchParams.get('file') || '便签.md');
      sendJson(res, 200, { ok: true, text: readScratch(scene, dir, file) });
      return;
    }
    if (p === '/api/scratch' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const scene = String(body.scene || '');
      const dir = String(body.dir || '项目记忆');
      const file = String(body.file || '便签.md');
      const abs = path.join(PATHS.memory, scene, dir, file);
      if (!abs.startsWith(path.join(PATHS.memory, scene))) {
        sendJson(res, 403, { ok: false, error: '只能写自己场景的目录' });
        return;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(body.text || ''), 'utf8');
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── 宪法（AGENTS）与索引 ─────────────────────────────────────
    if (p === '/api/constitution') {
      sendJson(res, 200, { ok: true, text: readShared(mem.AGENTS_FILE), path: mem.sharedPath(mem.AGENTS_FILE) });
      return;
    }
    if (p === '/api/index' && req.method === 'GET') {
      const rows = buildIndexRows();
      writeIndexFile(rows);
      sendJson(res, 200, { ok: true, text: readShared(mem.INDEX_FILE), rows });
      return;
    }
    if (p === '/api/index' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      fs.mkdirSync(mem.sharedPath(), { recursive: true });
      fs.writeFileSync(mem.sharedPath(mem.INDEX_FILE), String(body.text || ''), 'utf8');
      sendJson(res, 200, { ok: true });
      return;
    }

    send(res, 404, '没有这个接口：' + p);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/engine/') || url.pathname.startsWith('/api/')) {
    proxyUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

ensureDirs();

/* ── 面板端口池：每个 AI 面板一个独立 origin ──────────────────────
 * 为什么：引擎只用一个 localStorage 键记住「上次会话」，不区分面板。
 * 共用 origin ⇒ 两个面板互抢（实感：左右两个窗口变成同一条会话）。
 * 一板一端口 ⇒ 一板一 localStorage ⇒ 天然隔离。
 */
const PANEL_PORTS = [];
const panelServers = [];
{
  const base = PANEL_PORT.base || (SERVER.port + 1);
  for (let i = 0; i < PANEL_PORT.count; i++) {
    const port = base + i;
    PANEL_PORTS.push(port);
    const ps = http.createServer(panelHandler);
    panelServers.push(ps);
  }
}

// 启动时把索引生成一份（AI 第一次开场就能看）
try { writeIndexFile(buildIndexRows()); } catch (e) { /* ignore */ }

server.listen(SERVER.port, SERVER.host, async () => {
  const status = await probe();
  const base = `http://${SERVER.host}:${SERVER.port}`;
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │  我的工作台                                  │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('  界面：   ' + base);
  console.log('  引擎：   ' + ENGINE.base + (status.up ? '  ✓ 在跑' : '  ✗ 没连上'));
  if (!status.up) {
    console.log('');
    console.log('  ⚠ 引擎没连上。先起引擎，再回来刷新本页。');
    console.log('    dsh web --no-open --port 3080');
  }
  console.log('  面板端口：' + PANEL_PORTS.join(', ') + '（每个 AI 面板一个，独立 localStorage）');
  console.log('');
  console.log('  场景数： ' + loadScenes().length);
  console.log('');
});

// 面板端口逐个监听（失败的不影响主服务）
panelServers.forEach((ps, i) => {
  // 面板端口的 WebSocket 也要代理（引擎的 /api/remote.mux 走这条）
  ps.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/__wb/pin.js') { socket.destroy(); return; }
    req.url = u.pathname + u.search;
    proxyUpgrade(req, socket, head);
  });
  ps.on('error', (err) => {
    console.warn('  ⚠ 面板端口 ' + PANEL_PORTS[i] + ' 起不来：' + err.message);
  });
  ps.listen(PANEL_PORTS[i], SERVER.host);
});
