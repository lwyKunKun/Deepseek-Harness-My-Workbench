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
import { allCategories, saveCategories } from './lib/categories.mjs';
import { proxyHttp, proxyUpgrade, probe, exchangeToken, rpc } from './lib/engine.mjs';
import * as dispatch from './lib/dispatch.mjs';
import * as loadGate from './lib/loadgate.mjs';
import * as gpu from './lib/gpu.mjs';
import * as authority from './lib/authority.mjs';
import * as triage from './lib/triage.mjs';
import * as writelog from './lib/writelog.mjs';
import * as dashboard from './lib/dashboard.mjs';
import * as doctor from './lib/doctor.mjs';
import * as writeapi from './lib/writeapi.mjs';
import * as panelPorts from './lib/panelports.mjs';
import { findWorkspace } from './lib/dsh-cli.mjs';

/* ── actlog：操作留痕的底座 ────────────────────────────────────────
 *
 * ⚠ 这里为什么不用一句 import 就完事：
 *   插件模式里 server.mjs 是带 ?wb=… **每次请求重新** import 的，
 *   但 ESM 按 URL 缓存模块 ⇒ 相对 import 的 ./lib/*.mjs 仍是**第一次那份** ——
 *   改了 lib/actlog.mjs 也不生效（界面报「actlog.xxx is not a function」）。
 *   借 server.mjs 自己的那个时间戳 import 它 ⇒ 每次请求都拿到最新代码。
 */
const STAMP = import.meta.url.includes('?') ? '?' + import.meta.url.split('?')[1] : '';
const actlog = await import('./lib/actlog.mjs' + STAMP);
// 记忆读写同理（改了 lib/memory.mjs 也要立刻生效）
const mem = await import('./lib/memory.mjs' + STAMP);
// 仓库读写同理（改了 lib/vault.mjs 也要立刻生效）
const vault = await import('./lib/vault.mjs' + STAMP);
// 派生器（项目信息的自动区）同理：改了 lib/derive.mjs 也要立刻生效
const derive = await import('./lib/derive.mjs' + STAMP);

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

/** 读原始字节（上传文件用 —— 不能转字符串，二进制会坏）。 */
function readBodyBuf(req, limit = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('文件太大（上限 256MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

/* ── 文件访问：工作台目录 + 当前工作区 + 各角色绑定的项目目录 ──────
 * ⚠ 项目目录是**角色自己的地盘**（在真实磁盘上）。这里只是允许**浏览**；
 *   能不能写，由权限判定（lib/authority.mjs）按「谁的地盘」说了算。
 */
function fsRoots() {
  const roots = [path.resolve(PATHS.root), path.resolve(process.cwd())];
  for (const r of authority.projectRoots()) {
    if (!roots.includes(r)) roots.push(r);
  }
  return roots;
}

function fsAllowed(p) {
  try {
    const real = fs.realpathSync(p);
    return fsRoots().some((root) => {
      // ⚠ 根也要 realpath：macOS 上 /tmp 是 /private/tmp 的软链，
      //   只对候选路径 realpath 的话两边对不上 ⇒ 明明在允许范围内却说不在。
      let realRoot = root;
      try { realRoot = fs.realpathSync(root); } catch (e) { /* 根不在了就按原样比 */ }
      return real === realRoot || real.startsWith(realRoot + path.sep);
    });
  } catch (e) {
    return false;
  }
}

function fsResolve(p) {
  const abs = path.resolve(fsRoots()[0], p);
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

/* ── 树：一次列出一棵子树（VS Code 那种文件夹树） ─────────────────
 *  · 深度上限 + 节点上限 —— 免得一个 node_modules 把面板撑爆
 *  · 软链不进树（防环，也防顺着软链跑到别人的地盘）
 *  · . 开头的跳过（和 handleFsList 一个口径）
 */
const FS_TREE_MAX_DEPTH = 6;
const FS_TREE_MAX_NODES = 3000;

function fsTreeChildren(abs, depth, budget) {
  let names;
  try { names = fs.readdirSync(abs); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (budget.n <= 0) { budget.cut = true; break; }
    const full = path.join(abs, name);
    let st;
    try { st = fs.lstatSync(full); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;              // 软链不进树
    const isDir = st.isDirectory();
    if (isDir && !fsAllowed(full)) continue;        // 不在允许范围内的目录不进树
    const node = { name, path: full, isDir, size: st.size, mtime: st.mtimeMs };
    budget.n--;
    if (isDir) {
      if (depth > 0) {
        node.children = fsTreeChildren(full, depth - 1, budget);
      } else {
        node.children = [];                         // 到深度上限：点开时前端再拉一层
        node.lazy = true;
      }
    }
    out.push(node);
  }
  out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  return out;
}

function handleFsTree(res, dir, depth) {
  const abs = fsResolve(dir || '.');
  if (!abs) { sendJson(res, 403, { ok: false, error: '这个目录不在允许范围内' }); return; }
  let st;
  try { st = fs.statSync(abs); } catch (e) {
    sendJson(res, 404, { ok: false, error: '目录不存在' }); return;
  }
  if (!st.isDirectory()) { sendJson(res, 400, { ok: false, error: '那不是一个目录' }); return; }
  const d = Math.max(1, Math.min(Number(depth) || 1, FS_TREE_MAX_DEPTH));
  const budget = { n: FS_TREE_MAX_NODES, cut: false };
  const rows = fsTreeChildren(abs, d, budget);
  sendJson(res, 200, { ok: true, dir: abs, depth: d, truncated: budget.cut, rows });
}

/* ── 搜索：在某个目录里按文件名找（深目录一层层点太费劲 ⇒ 加这个） ──
 * · 递归往下找，深度和条数都有上限（免得一个 node_modules 拖死）
 * · .git / node_modules 这类目录**不进去**（那儿全是噪声）
 * · 软链不进（跟树一个口径，防环）
 * · 只读 —— 走的是同一套 fsResolve / fsAllowed 白名单
 */
const FS_SEARCH_MAX_DEPTH = 8;
const FS_SEARCH_MAX_ROWS = 120;
const FS_SEARCH_SKIP = new Set([
  '.git', 'node_modules', '.next', '.nuxt', 'dist', 'build',
  '.cache', 'coverage', '.venv', '__pycache__',
]);

function handleFsSearch(res, dir, q, max) {
  const abs = fsResolve(dir || '.');
  if (!abs) { sendJson(res, 403, { ok: false, error: '这个目录不在允许范围内' }); return; }
  const kw = String(q || '').trim().toLowerCase();
  if (!kw) { sendJson(res, 200, { ok: true, dir: abs, q: '', rows: [] }); return; }
  const limit = Math.max(1, Math.min(Number(max) || FS_SEARCH_MAX_ROWS, FS_SEARCH_MAX_ROWS));
  const rows = [];
  let cut = false;

  const walk = (cur, depth) => {
    if (rows.length >= limit) { cut = true; return; }
    let names;
    try { names = fs.readdirSync(cur); } catch (e) { return; }
    for (const name of names) {
      if (rows.length >= limit) { cut = true; return; }
      if (name.startsWith('.')) continue;
      const full = path.join(cur, name);
      let st;
      try { st = fs.lstatSync(full); } catch (e) { continue; }
      if (st.isSymbolicLink()) continue;              // 软链不进
      const isDir = st.isDirectory();
      if (isDir && !fsAllowed(full)) continue;        // 不在允许范围内的目录不进
      if (name.toLowerCase().includes(kw)) {
        rows.push({
          path: full, name, isDir, size: st.size, mtime: st.mtimeMs,
          rel: path.relative(abs, full),
        });
      }
      if (!isDir) continue;
      if (FS_SEARCH_SKIP.has(name)) continue;         // 噪声目录：不进去
      if (depth >= FS_SEARCH_MAX_DEPTH) continue;
      walk(full, depth + 1);
    }
  };
  walk(abs, 1);

  // 目录在前、同层按名字排 —— 找目录和找文件的顺序不一样
  rows.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  sendJson(res, 200, { ok: true, dir: abs, q: kw, truncated: cut, rows });
}

/**
 * 这个角色能往哪两个根里写东西：
 *   ① 它绑的**项目目录**（真实磁盘上的地盘）
 *   ② 它的**项目记忆目录**（工作台内，没绑项目目录时的默认落点）
 */
function sceneWriteRoots(sc) {
  const out = [];
  const pr = String(sc.projectRoot || '').trim();
  if (pr) out.push(path.resolve(pr));
  out.push(path.resolve(PATHS.memory, sc.id, '项目记忆'));
  return out;
}

/**
 * 新建文件夹 / 新建文件。
 * 权限和「上传文件」同一套分档判定（自己的地盘才能建，别人的地盘 = 越界）。
 */
function handleFsCreate(res, body) {
  const scene = String(body.scene || '').trim();
  const kind = body.kind === 'file' ? 'file' : 'dir';
  const name = String(body.name || '').trim();
  const parent = String(body.dir || '').trim();
  if (!scene) { sendJson(res, 400, { ok: false, error: '要建在哪个场景下？' }); return; }
  const sc = getScene(scene);
  if (!sc) { sendJson(res, 404, { ok: false, error: '没有这个场景：' + scene }); return; }
  if (!name) { sendJson(res, 400, { ok: false, error: '名字不能空' }); return; }
  if (name === '.' || name === '..' || /[/\\]/.test(name) || name.startsWith('.')) {
    sendJson(res, 400, { ok: false, error: '名字不对（不能带 / 或反斜杠，也不能以 . 开头）' }); return;
  }
  if (!parent) { sendJson(res, 400, { ok: false, error: '要建在哪个目录里？' }); return; }

  const abs = path.resolve(parent);
  const roots = sceneWriteRoots(sc);
  const inRoot = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!inRoot) {
    sendJson(res, 403, { ok: false, error: '只能建在这个角色自己的目录里（项目目录 / 项目记忆）' });
    return;
  }
  if (!fsAllowed(abs)) { sendJson(res, 403, { ok: false, error: '这个目录不在允许范围内' }); return; }
  let st;
  try { st = fs.statSync(abs); } catch (e) {
    sendJson(res, 404, { ok: false, error: '目录不存在：' + abs }); return;
  }
  if (!st.isDirectory()) { sendJson(res, 400, { ok: false, error: '那不是一个目录' }); return; }

  const target = path.join(abs, name);
  if (fs.existsSync(target)) {
    sendJson(res, 409, { ok: false, error: '已经有同名的东西了：' + name }); return;
  }

  // 分档判定：工作台内的用相对路径，工作台外的用绝对路径（跟上传同一口径）
  const rel = (abs === PATHS.root || abs.startsWith(PATHS.root + path.sep))
    ? path.relative(PATHS.root, abs).split(path.sep).join('/')
    : abs;
  const v = authority.check(rel + '/' + name, scene);
  if (!v.allowed) {
    sendJson(res, 403, { ok: false, error: v.why, verdict: v });
    return;
  }

  try {
    if (kind === 'dir') fs.mkdirSync(target);
    else fs.writeFileSync(target, '', 'utf8');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: '建不出来：' + (e && e.message || e) });
    return;
  }

  // 留痕：人在这儿动了一下手 ⇒ 记一笔（和上传同一口径）
  const relTarget = rel + '/' + name;
  writelog.appendApiWrite({
    path: relTarget, scene, sceneName: sc.name,
    at: Date.now(), time: Date.now(),
    op: kind === 'dir' ? 'mkdir' : 'newfile',
    content: kind === 'file' ? '' : null,
  });
  actlog.append({
    scene, actor: 'user',
    action: kind === 'dir' ? '新建文件夹' : '新建文件',
    target: relTarget,
    detail: { 位置: rel },
  });

  sendJson(res, 200, { ok: true, kind, name, path: target, dir: abs, verdict: v });
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

/**
 * 工作台的请求处理（界面 + API + 引擎代理）。
 *
 * 它**不自带监听**：被 DSH 插件装载时，由引擎的 webServer 转发过来（见 index.js）；
 * 单独跑 `node server.mjs` 时才自己 listen。
 */
export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;

  // 浏览器手上的引擎 cookie 是最新的（引擎重启过就会换）⇒ 先把它记下来。
  // 后面的体检/派单等要直连引擎的接口就靠这份（存的 cookie 可能是旧的 ⇒ 401）。
  cookieOf(req);

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
    // ── 文件树（VS Code 那种文件夹树）───────────────────────────
    if (p === '/api/fs/tree') {
      handleFsTree(res, url.searchParams.get('dir') || '.', url.searchParams.get('depth') || 1);
      return;
    }
    // ── 按文件名搜（深目录翻文件用）─────────────────────────────
    if (p === '/api/fs/search') {
      handleFsSearch(res, url.searchParams.get('dir') || '.',
        url.searchParams.get('q') || '', url.searchParams.get('max') || '');
      return;
    }
    // ── 新建文件夹 / 新建文件（在角色自己的目录里）────────────────
    if (p === '/api/fs/create' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { body = {}; }
      handleFsCreate(res, body);
      return;
    }

    // ── 场景顺序（标签栏拖拽换位后持久化） ───────────────────────
    if (p === '/api/scene/order' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      writeJson(path.join(PATHS.data, 'scene-order.json'), { ids });
      sendJson(res, 200, { ok: true, ids });
      return;
    }

    // ── 改一个场景的名字（右键菜单「改名」） ──────────────────────
    if (p === '/api/scene/rename' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = String(body.id || '').trim();
      const name = String(body.name || '').trim();
      if (!id) { sendJson(res, 400, { ok: false, error: '要改哪个场景？' }); return; }
      if (!name) { sendJson(res, 400, { ok: false, error: '名字不能空' }); return; }
      const file = path.join(PATHS.scenarios, id + '.json');
      const raw = readJson(file);
      if (!raw) { sendJson(res, 404, { ok: false, error: '没有这个场景：' + id }); return; }
      const old = raw.name || id;
      raw.name = name;
      // description 是「一句话职责」，名字变了但职责没变 ⇒ 只更新 name
      writeJson(file, raw);
      // 地盘表里的名字也跟着改（否则面板上显示的还是旧名）
      const terr = authority.loadTerritory();
      if (terr.scenes && terr.scenes[id]) {
        terr.scenes[id].name = name;
        authority.saveTerritory(terr);
      }
      sendJson(res, 200, { ok: true, id, name, old });
      return;
    }

    // ── 改一个场景的分类（树上把它拖到别的分类下时用） ──────────────
    if (p === '/api/scene/category' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = String(body.id || '').trim();
      const cat = String(body.category || '').trim() || '未分类';
      const file = path.join(PATHS.scenarios, id + '.json');
      const raw = readJson(file);
      if (!raw) { sendJson(res, 404, { ok: false, error: '没有这个场景：' + id }); return; }
      raw.category = cat;
      writeJson(file, raw);
      sendJson(res, 200, { ok: true, id, category: cat });
      return;
    }

    // ── 分类注册表：新建 / 改名 / 删 / 换顺序 ──────────────────────
    //    分类的「定义 + 顺序」在 scenarios/_categories.json；
    //    改名和删分类要连带改场景的 category 字段，否则场景会指向不存在的分类。
    if (p === '/api/categories' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const op = String(body.op || '').trim();
      const scenes = loadScenes();
      let names = allCategories(scenes);        // 注册表 + 场景里出现过的
      /** 把某个分类下的场景改成另一个分类。 */
      const moveScenes = (from, to) => {
        scenes.filter((s) => (s.category || '未分类') === from).forEach((s) => {
          const file = path.join(PATHS.scenarios, s.id + '.json');
          const raw = readJson(file);
          if (!raw) return;
          raw.category = to;
          writeJson(file, raw);
        });
      };

      if (op === 'create') {
        const name = String(body.name || '').trim();
        if (!name) { sendJson(res, 400, { ok: false, error: '分类名不能空' }); return; }
        if (names.indexOf(name) >= 0) { sendJson(res, 400, { ok: false, error: '已经有这个分类了：' + name }); return; }
        const after = String(body.after || '').trim();
        const at = after ? names.indexOf(after) : -1;
        names.splice(at < 0 ? names.length : at + 1, 0, name);
        saveCategories(names);
        sendJson(res, 200, { ok: true, categories: names, created: name });
        return;
      }

      if (op === 'rename') {
        const name = String(body.name || '').trim();
        const next = String(body.newName || '').trim();
        if (!name || !next) { sendJson(res, 400, { ok: false, error: '分类名不能空' }); return; }
        if (name === next) { sendJson(res, 200, { ok: true, categories: names }); return; }
        if (names.indexOf(next) >= 0) { sendJson(res, 400, { ok: false, error: '已经有这个分类了：' + next }); return; }
        names = names.map((c) => (c === name ? next : c));
        saveCategories(names);
        moveScenes(name, next);
        sendJson(res, 200, { ok: true, categories: names, renamed: name, newName: next });
        return;
      }

      if (op === 'delete') {
        const name = String(body.name || '').trim();
        if (!name) { sendJson(res, 400, { ok: false, error: '删哪个分类？' }); return; }
        const moved = scenes.filter((s) => (s.category || '未分类') === name).length;
        if (moved) moveScenes(name, '未分类');
        // ⚠ 移完**再**算名单：注册表要反映**现在**真实存在的分类
        //   （成员去了「未分类」⇒ 它就该进注册表，不能当半幽灵）。
        names = allCategories(loadScenes()).filter((c) => c !== name);
        saveCategories(names);
        sendJson(res, 200, { ok: true, categories: names, deleted: name, moved });
        return;
      }

      if (op === 'reorder') {
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const next = [];
        ids.forEach((id) => { if (names.indexOf(id) >= 0 && next.indexOf(id) < 0) next.push(id); });
        names.forEach((c) => { if (next.indexOf(c) < 0) next.push(c); });
        saveCategories(next);
        sendJson(res, 200, { ok: true, categories: next });
        return;
      }

      sendJson(res, 400, { ok: false, error: '不认识的 op：' + op });
      return;
    }

    // ── Obsidian 仓库：读你的真实笔记 ──────────────────────────────
    //    角色绑了项目目录 ⇒ 那个目录就是仓库根（Obsidian 库）。
    if (p.startsWith('/api/vault/')) {
      const action = p.slice('/api/vault/'.length);
      const scene = String(url.searchParams.get('scene') || '').trim();
      const sc = getScene(scene);
      if (!sc) { sendJson(res, 404, { ok: false, error: '没有这个场景：' + scene }); return; }
      const projectRoot = String(sc.projectRoot || '').trim();
      if (!projectRoot) {
        sendJson(res, 400, { ok: false, error: '「' + sc.name + '」还没绑仓库目录 —— 先在「项目目录」面板里绑定 Obsidian 库 的路径' });
        return;
      }
      if (!fs.existsSync(projectRoot)) {
        sendJson(res, 400, { ok: false, error: '仓库目录不存在：' + projectRoot });
        return;
      }
      // ⚠ 仓库根不一定 = projectRoot：场景可能已经绑在库**里面**的子目录上
      //   （阅读角色绑的是 `Obsidian 库/05-Bookshelf`，而书库路径是相对
      //   **库根**写的 `05-Bookshelf/书籍list`）⇒ 拼起来会变成
      //   `05-Bookshelf/05-Bookshelf/书籍list`，读不到书。
      //   resolveVaultRoot：从 projectRoot 往上逐级试，谁能接住这个路径就是谁。
      const vaultRoot = (sub) => vault.resolveVaultRoot(projectRoot, sub);

      // 书架：列出所有 md（按 status 分组）
      if (action === 'books') {
        const sub = String(url.searchParams.get('dir') || '').trim();
        const root = vaultRoot(sub);
        const r = vault.readBooks(root, sub);
        if (!r.ok) { sendJson(res, 400, { ok: false, error: r.error }); return; }
        const groups = { 在读: [], 想读: [], 已读完: [] };
        const other = [];
        for (const b of r.books) {
          if (groups[b.status]) groups[b.status].push(b);
          else other.push(b);
        }
        sendJson(res, 200, {
          ok: true, root, dir: sub,
          groups,
          other,
          counts: {
            total: r.books.length,
            reading: groups['在读'].length,
            want: groups['想读'].length,
            done: groups['已读完'].length,
          },
        });
        return;
      }

      // 通用条目（概念卡 / 运动记录 / 股票池 …）：列一个目录下的所有 md
      if (action === 'notes') {
        const sub = String(url.searchParams.get('dir') || '').trim();
        const limit = Number(url.searchParams.get('limit') || 0);
        const root = vaultRoot(sub);
        const r = vault.readNotes(root, sub, { limit });
        if (!r.ok) { sendJson(res, 400, { ok: false, error: r.error }); return; }
        sendJson(res, 200, { ok: true, root, dir: sub, notes: r.notes, total: r.total });
        return;
      }

      // 读一篇笔记（正文 + frontmatter）
      if (action === 'note') {
        const rel = String(url.searchParams.get('path') || '').trim();
        const root = vaultRoot(path.dirname(rel));
        const r = vault.readNote(root, rel);
        if (!r.ok) { sendJson(res, 404, { ok: false, error: r.error }); return; }
        sendJson(res, 200, { ok: true, root, path: rel, fm: r.fm, body: r.body });
        return;
      }

      // 更新阅读进度（照 Obsidian 的字段：currentPage / status / endDate）
      if (action === 'progress' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const rel = String(body.path || '').trim();
        const page = Number(body.currentPage);
        const root = vaultRoot(path.dirname(rel));
        const note = vault.readNote(root, rel);
        if (!note.ok) { sendJson(res, 404, { ok: false, error: note.error }); return; }
        const total = Number(note.fm.totalPage) || 0;
        if (!Number.isFinite(page) || page < 0 || (total > 0 && page > total)) {
          sendJson(res, 400, { ok: false, error: '页码不对（0 ~ ' + (total || '?') + '）' });
          return;
        }
        const today = new Date().toISOString().slice(0, 10);
        const oldStatus = String(note.fm.status || '想读');
        const oldPage = Number(note.fm.currentPage) || 0;
        vault.writeFrontmatterField(root, rel, 'currentPage', page);
        if (total > 0 && page >= total) {
          vault.writeFrontmatterField(root, rel, 'status', '已读完');
          vault.writeFrontmatterField(root, rel, 'endDate', today);
        } else {
          if (oldStatus === '已读完') {
            vault.writeFrontmatterField(root, rel, 'status', page > 0 ? '在读' : '想读');
            vault.writeFrontmatterField(root, rel, 'endDate', '');
          } else if (oldStatus === '想读' && page > 0) {
            vault.writeFrontmatterField(root, rel, 'status', '在读');
          }
        }
        sendJson(res, 200, { ok: true, path: rel, currentPage: page, totalPage: total });
        // 留痕：进度改了多少、旧状态是什么，事后查得到
        actlog.append({
          scene: sc.id,
          actor: 'user',
          action: '更新阅读进度',
          target: rel,
          detail: { 页码: oldPage + ' → ' + page, 总页数: total || '?', 状态: oldStatus },
        });
        // ★ 项目信息跟着变：书库变了 ⇒ §〇 摘要 / §三 台账 自动重算。
        //   ⚠ 必须在留痕**之后**跑：派生器靠「最近一次『更新阅读进度』动的是哪本」
        //     来判定「正在读」—— 先留痕，派生器才看得到这一条。
        try { derive.deriveScene(sc.id); } catch (e) { /* 派生失败不该让更新进度失败 */ }
        return;
      }

      // 加一本书（按 Obsidian 的书笔记格式新建 md）
      if (action === 'book' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const title = String(body.title || '').trim();
        if (!title) { sendJson(res, 400, { ok: false, error: '要书名' }); return; }
        const dir = String(body.dir || '书籍list').trim();
        const rel = dir + '/' + title.replace(/[/\\]/g, '-') + '.md';
        const root = vaultRoot(dir);
        const r = vault.createBookNote(root, rel, {
          title,
          author: body.author,
          totalPage: body.totalPage,
          status: body.status,
          cover: body.cover,
        });
        if (!r.ok) { sendJson(res, 400, { ok: false, error: r.error }); return; }
        sendJson(res, 200, { ok: true, path: rel });
        actlog.append({
          scene: sc.id,
          actor: 'user',
          action: '加一本书',
          target: rel,
          detail: { 书名: title, 作者: body.author || '—', 总页数: body.totalPage || '?' },
        });
        // 书库多了一本 ⇒ §〇 摘要 / §三 台账 跟着重算
        try { derive.deriveScene(sc.id); } catch (e) { /* 派生失败不该让加书失败 */ }
        return;
      }

      sendJson(res, 404, { ok: false, error: '没有这个仓库接口：' + action });
      return;
    }

    // ── 操作留痕：这个场景里发生的每一次操作都记一笔 ────────────────
    //    人的界面操作走 POST（前端埋点）；
    //    服务端自己改的东西（进度·加书·上传·写记忆）就地留痕 ——
    //    那样记下来的才是**事实**，不靠前端自觉。
    if (p === '/api/actlog') {
      if (req.method === 'GET') {
        const scene = String(url.searchParams.get('scene') || '').trim();
        if (!scene) { sendJson(res, 400, { ok: false, error: '要哪个场景的留痕？' }); return; }
        const limit = Number(url.searchParams.get('limit') || 300);
        const entries = actlog.read(scene, { limit });
        const all = url.searchParams.get('ai') === '1'
          ? entries.concat(actlog.sessionActions(scene)).sort((a, b) => (a.at || 0) - (b.at || 0))
          : entries;
        sendJson(res, 200, {
          ok: true, scene, entries: all,
          summary: actlog.summarize(all),
          file: actlog.ledgerFile(scene),
        });
        return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const scene = String(body.scene || '').trim();
        if (!scene) { sendJson(res, 400, { ok: false, error: '留痕要指明场景' }); return; }
        const entry = actlog.append({
          scene,
          actor: body.actor || 'user',
          action: body.action,
          target: body.target,
          detail: body.detail,
          result: body.result,
        });
        sendJson(res, 200, { ok: true, entry });
        return;
      }
    }
    if (p === '/api/actlog/export' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const scene = String(body.scene || '').trim();
      if (!scene) { sendJson(res, 400, { ok: false, error: '要导出哪个场景？' }); return; }
      const r = actlog.exportMarkdown(scene);
      sendJson(res, 200, { ok: true, path: r.path, count: r.count });
      return;
    }

    // ── 上传文件：把文件传进某个角色的目录 ──────────────────────────
    //    目标：角色绑了项目目录 ⇒ 传进项目目录；没绑 ⇒ 传进它的记忆目录。
    //    权限：走同一套分档判定（它自己的地盘才能写，别的角色写就是越界）。
    if (p === '/api/upload' && req.method === 'POST') {
      const scene = String(url.searchParams.get('scene') || '').trim();
      const rawName = String(url.searchParams.get('name') || '').trim();
      const sub = String(url.searchParams.get('dir') || '').trim();
      if (!scene) { sendJson(res, 400, { ok: false, error: '要传到哪个场景？' }); return; }
      const sc = getScene(scene);
      if (!sc) { sendJson(res, 404, { ok: false, error: '没有这个场景：' + scene }); return; }
      if (!rawName) { sendJson(res, 400, { ok: false, error: '要传哪个文件？' }); return; }

      const name = path.basename(rawName);            // 文件名只取最后一段（不许带路径）
      if (!name || name === '.' || name === '..') { sendJson(res, 400, { ok: false, error: '文件名不对' }); return; }
      // 子目录：只许相对路径，不许往上爬
      let subRel = '';
      if (sub) {
        const norm = path.normalize(sub).replace(/^([/\\.]+)/, '');
        if (norm.split(/[/\\]/).includes('..')) { sendJson(res, 400, { ok: false, error: '子目录不对' }); return; }
        subRel = norm;
      }

      // 目标根：项目目录优先，否则角色的记忆目录
      const projectRoot = String(sc.projectRoot || '').trim();
      const base = projectRoot
        ? path.resolve(projectRoot)
        : path.resolve(PATHS.memory, sc.id, '项目记忆');
      const dir = subRel ? path.join(base, subRel) : base;
      if (!dir.startsWith(base)) { sendJson(res, 400, { ok: false, error: '子目录不对' }); return; }

      // 权限：这个路径归不归它
      const rel = dir.startsWith(PATHS.root + path.sep) || dir === PATHS.root
        ? path.relative(PATHS.root, dir).split(path.sep).join('/')
        : dir;                                    // 工作台之外 ⇒ 用绝对路径
      const target = rel + '/' + name;
      const v = authority.check(target, scene);
      if (!v.allowed) {
        sendJson(res, 403, { ok: false, error: v.why, verdict: v });
        return;
      }

      let buf;
      try { buf = await readBodyBuf(req); } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e && e.message || e) });
        return;
      }
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), buf);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: '写不进去：' + (e && e.message || e) });
        return;
      }

      // 写痕留一笔（内容只记摘要，二进制不整份进日志）
      writelog.appendApiWrite({
        path: target,
        scene,
        sceneName: sc.name,
        time: Date.now(),
        tool: 'upload',
        content: '«上传 ' + buf.length + ' 字节»',
      });

      sendJson(res, 200, {
        ok: true,
        scene,
        path: target,
        abs: path.join(dir, name),
        bytes: buf.length,
        where: projectRoot ? '项目目录' : '场景记忆目录',
      });
      actlog.append({
        scene,
        actor: 'user',
        action: '上传文件',
        target: name,
        detail: { 字节: buf.length, 去处: projectRoot ? '项目目录' : '场景记忆目录' },
      });
      return;
    }

    // ── 项目目录：把一个**真实磁盘上的文件夹**挂到这个角色上 ─────────
    //    绑了之后：
    //      · 这个角色的 AI 会话可以以它为工作目录（cwd）⇒ 让 AI 直接写代码
    //      · 文件面板能浏览它
    //      · 它登记成这个角色的地盘 ⇒ 别的角色碰它就是越界（E 档）
    if (p === '/api/scene/project') {
      if (req.method === 'GET') {
        const id = String(url.searchParams.get('id') || '').trim();
        const sc = getScene(id);
        if (!sc) { sendJson(res, 404, { ok: false, error: '没有这个场景：' + id }); return; }
        const root = sc.projectRoot || '';
        let exists = false;
        let isDir = false;
        if (root) {
          try { isDir = fs.statSync(root).isDirectory(); exists = isDir; } catch (e) { exists = false; }
        }
        // base = 这个角色的「工作根」：绑了项目目录就是它，没绑就是它的项目记忆目录
        //   （前端用它算相对路径：上传 / 新建都落在 base 底下）
        const base = root
          ? path.resolve(root)
          : path.resolve(PATHS.memory, sc.id, '项目记忆');
        // 没绑项目目录时，base 可能还没建出来 ⇒ 先把它建上（树才有根可看）
        if (!root) { try { fs.mkdirSync(base, { recursive: true }); } catch (e) { /* 建不出来就算了 */ } }
        sendJson(res, 200, { ok: true, id, projectRoot: root, base, exists, cwd: process.cwd() });
        return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const id = String(body.id || '').trim();
        const file = path.join(PATHS.scenarios, id + '.json');
        const raw = readJson(file);
        if (!raw) { sendJson(res, 404, { ok: false, error: '没有这个场景：' + id }); return; }

        const want = String(body.root || '').trim();
        if (!want) {
          // 解绑
          raw.projectRoot = '';
          writeJson(file, raw);
          authority.registerScene(id, { name: raw.name, duty: raw.duty, projectRoot: '' });
          sendJson(res, 200, { ok: true, id, projectRoot: '' });
          actlog.append({ scene: id, actor: 'user', action: '解绑项目目录', target: id });
          return;
        }
        const abs = path.resolve(want.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
        try {
          if (!fs.statSync(abs).isDirectory()) {
            sendJson(res, 400, { ok: false, error: '那不是一个目录：' + abs });
            return;
          }
        } catch (e) {
          sendJson(res, 400, { ok: false, error: '目录不存在：' + abs });
          return;
        }
        raw.projectRoot = abs;
        writeJson(file, raw);
        const reg = authority.registerScene(id, { name: raw.name, duty: raw.duty, projectRoot: abs });
        sendJson(res, 200, { ok: true, id, projectRoot: abs, territory: reg.ok });
        actlog.append({ scene: id, actor: 'user', action: '绑定项目目录', target: abs });
        return;
      }
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
        categories: allCategories(loadScenes()),
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
      mem.scaffold(id, { name, duty: sc.duty, skills: sc.skills });
      // ⚠ 同时登记进地盘表 —— 不登记的话，它的记忆目录算「未登记」，
      //   按规矩是 C 档 ⇒ 它连自己的记忆都写不了（闸会拦）。
      const reg = authority.registerScene(id, { name, duty: sc.duty });
      sendJson(res, 200, { ok: true, id, scene: sc, created: true, territory: reg.ok });
      return;
    }

    // ── 删除一个场景（角色） ───────────────────────────────────────
    //    删的东西：场景配置 + 它的记忆目录 + 地盘表里的登记
    //              + 它在待办板上自己的那些行 + 把它的常驻会话归档
    //    不删的：台账/写痕/回执（那是历史，不是它的私产）
    if (p === '/api/scenes/delete' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = String(body.id || '').trim();
      if (!id) { sendJson(res, 400, { ok: false, error: '要删哪个场景？' }); return; }
      const file = path.join(PATHS.scenarios, id + '.json');
      const raw = readJson(file);
      if (!raw) { sendJson(res, 404, { ok: false, error: '没有这个场景：' + id }); return; }
      const name = raw.name || id;

      // 规则负责人不能删 —— 删了 A/C 档就没人能改了
      const terr = authority.loadTerritory();
      if (terr.ruleOwner === id || terr.ruleOwner === name) {
        sendJson(res, 409, {
          ok: false,
          error: '「' + name + '」是规则负责人（' + terr.ruleOwner + '）—— 删了它，A/C 档（规矩与工具）就没人能改了。要删的话，先把 territory.json 里的 ruleOwner 改成别人。',
        });
        return;
      }

      const report = { ok: true, id, name, files: 0, todoRows: 0, sessions: [], warnings: [] };

      // ① 待办板上归它自己的行（@归属 是它）—— 不删会变成指向空角色的死引用
      const board = path.join(PATHS.memory, '_共享记忆', '_待办.md');
      if (fs.existsSync(board)) {
        const lines = fs.readFileSync(board, 'utf8').split('\n');
        const kept = lines.filter((l) => {
          const at = l.match(/@\s*(\S+)\s*$/);
          if (!at) return true;
          const owner = authority.resolveSceneId(at[1]);
          return !(owner && owner === id);
        });
        const gone = lines.length - kept.length;
        if (gone > 0) {
          fs.writeFileSync(board, kept.join('\n'), 'utf8');
          report.todoRows = gone;
        }
      }

      // ② 它的常驻会话：归档（引擎没有删除接口 ⇒ 归档是最接近的「收起来」）
      const sessions = (raw.panels || []).filter((x) => x.type === 'harness' && x.sessionId).map((x) => x.sessionId);
      const cookie = cookieOf(req);
      for (const sid of sessions) {
        try {
          const r = await rpc('workspace/archiveSession', { request: { sessionId: sid } }, cookie);
          if (r.ok) report.sessions.push(sid);
          else report.warnings.push('会话 ' + sid + ' 没归档成功（可以手动在 DSH 侧栏删）');
        } catch (e) {
          report.warnings.push('会话 ' + sid + ' 没归档成功（可以手动在 DSH 侧栏删）');
        }
      }

      // ③ 记忆目录 + 场景配置 ⇒ **移到回收站**（不是真删）
      //    删角色是有后果的动作（一个角色的记忆可能攒了很久）⇒ 给一条后悔路。
      //    回收站在 data/trash/<id>-<时间戳>/，手动拷回去就能还原。
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const trash = path.join(PATHS.data, 'trash', id + '-' + stamp);
      fs.mkdirSync(path.join(trash, 'scenarios'), { recursive: true });
      fs.mkdirSync(path.join(trash, 'memory'), { recursive: true });

      const memDir = path.join(PATHS.memory, id);
      if (fs.existsSync(memDir)) {
        const count = fs.readdirSync(memDir, { recursive: true }).filter((f) => {
          try { return fs.statSync(path.join(memDir, f)).isFile(); } catch (e) { return false; }
        }).length;
        fs.renameSync(memDir, path.join(trash, 'memory', id));
        report.files = count;
      }
      fs.renameSync(file, path.join(trash, 'scenarios', id + '.json'));
      report.trash = path.relative(PATHS.root, trash);

      // ④ 地盘表里摘掉它
      authority.unregisterScene(id);

      sendJson(res, 200, report);
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
        actlog.append({ scene: body.scene, actor: 'user', action: '写记忆', target: body.section });
        return;
      }
      if (body.card) {
        fs.mkdirSync(mem.sceneDir(body.scene), { recursive: true });
        fs.writeFileSync(mem.cardPath(body.scene), String(body.text || ''), 'utf8');
        sendJson(res, 200, { ok: true, health: mem.health(body.scene) });
        actlog.append({ scene: body.scene, actor: 'user', action: '写身份卡', target: body.scene });
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
      actlog.append({ scene, actor: 'user', action: '写便签', target: dir + '/' + file });
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
}

ensureDirs();

/* ── 面板端口池：每个 AI 面板一个独立 origin ──────────────────────
 * 为什么：引擎只用一个 localStorage 键记住「上次会话」，不区分面板。
 * 共用 origin ⇒ 两个面板互抢（实感：左右两个窗口变成同一条会话）。
 * 一板一端口 ⇒ 一板一 localStorage ⇒ 天然隔离。
 */
export const PANEL_PORTS = [];
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

let panelsWired = false;
/**
 * 面板端口逐个监听（失败的不影响主服务）。
 * 独立运行时自动调用；被 DSH 插件装载时由插件调用。
 * ⚠ 可以重复调用：端口没在听就再听一次（插件被停用/启用时要用）。
 */
export function startPanelServers() {
  panelServers.forEach((ps, i) => {
    if (!panelsWired) {
      panelsWired = true;
      // 面板端口的 WebSocket 也要代理（引擎的 /api/remote.mux 走这条）
      //
      // ⚠⚠ 这里**必须**像 HTTP 那条路一样把 /engine 前缀摘掉：
      //   面板里的引擎界面，它的 base 是 /engine/，所以 WebSocket 会连
      //   /engine/api/remote.mux。引擎只认 /api/remote.mux ⇒ 不摘前缀就 404
      //   ⇒ 客户端的实时通道连不上（控制台刷「connection lost, retry #N」）
      //   ⇒ 它压根不去拉会话列表 ⇒ 面板里显示的是空白会话，不是我们钉的那条。
      ps.on('upgrade', (req, socket, head) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/__wb/pin.js') { socket.destroy(); return; }
        let p = u.pathname;
        if (p === '/engine' || p.startsWith('/engine/')) p = p.slice('/engine'.length) || '/';
        req.url = p + u.search;
        proxyUpgrade(req, socket, head);
      });
      ps.on('error', (err) => {
        console.warn('  ⚠ 面板端口 ' + PANEL_PORTS[i] + ' 起不来：' + err.message);
      });
    }
    if (ps.listening) return;
    ps.listen(PANEL_PORTS[i], SERVER.host);
    // 记一笔：这些端口是我们自己的（体检要分清「被谁占」）
    panelPorts.markOwned(PANEL_PORTS[i]);
  });
  return PANEL_PORTS.slice();
}

// 启动时把索引生成一份（AI 第一次开场就能看）
try { writeIndexFile(buildIndexRows()); } catch (e) { /* ignore */ }

/* ── 独立运行（node server.mjs）：自己监听 ─────────────────────────
 * 被 DSH 插件装载时**不**监听 —— 那一路走引擎自己的 webServer。
 */
const isMain = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const server = http.createServer(handleRequest);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/engine/') || url.pathname.startsWith('/api/')) {
      // ⚠ 同样要摘掉 /engine 前缀（理由见面板端口那段注释）
      const p = url.pathname.startsWith('/engine/') ? url.pathname.slice('/engine'.length) || '/' : url.pathname;
      req.url = p + url.search;
      proxyUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });

  startPanelServers();

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
}
