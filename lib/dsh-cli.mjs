// 命令行侧的引擎客户端 —— 给脚本用
//
// 认证有两条路：
//   ① data/engine-cookie.json（工作台在界面里「引擎连接」过一次之后会存下来）
//   ② 环境变量 DSH_TOKEN（dsh web 启动时打印的 token）⇒ 现场换 cookie
//
// ⛔ 两条实测铁律（照抄，别改）：
//   · 换 cookie 必须是 GET /?token=XXX 且 redirect:'manual'
//     （跟随后反而 401，因为 303 的 Location 是 ./，cookie 得自己收）
//   · 引擎的 cookie 绑定了 Host:Port，Host 必须写成引擎自己的地址

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ENGINE } from './config.mjs';

const COOKIE_FILE = path.join(PATHS.data, 'engine-cookie.json');

export function authority() {
  return `${ENGINE.host}:${ENGINE.port}`;
}

export function saveCookie(setCookieArray) {
  const list = Array.isArray(setCookieArray) ? setCookieArray : [setCookieArray];
  const pairs = list
    .filter(Boolean)
    .map((c) => String(c).split(';')[0])
    .filter(Boolean);
  if (!pairs.length) return '';
  const cookie = pairs.join('; ');
  fs.mkdirSync(PATHS.data, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie, at: Date.now() }, null, 2), 'utf8');
  return cookie;
}

export function loadCookie() {
  try {
    const j = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    return (j && j.cookie) || '';
  } catch (e) {
    return '';
  }
}

/** 拿到一个能用的 cookie：先看缓存，没有就用 DSH_TOKEN 现换。 */
export async function getCookie() {
  const cached = loadCookie();
  if (cached) {
    const probe = await rpc('session/list', { _request: {} }, cached);
    // ⚠ 只有引擎明确说 401 才丢掉缓存。
    //   探针因为别的原因失败（比如参数写错）时，cookie 本身可能是好的 ——
    //   丢掉它会让后面所有调用莫名 401。
    if (probe.status !== 401) return cached;
  }
  const token = process.env.DSH_TOKEN || '';
  if (token) {
    const cookie = await exchangeToken(token);
    if (cookie) {
      saveCookie(cookie);
      return cookie;
    }
  }
  return '';
}

export async function exchangeToken(token) {
  try {
    const res = await fetch(`${ENGINE.base}/?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
      headers: { host: authority() },
    });
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return sc.length ? sc.map((c) => c.split(';')[0]).join('; ') : '';
  } catch (e) {
    return '';
  }
}

/** 调一次引擎 RPC。 */
/** 调一次引擎 RPC。cookie 省略时用已存的那份。 */
export async function rpc(method, args, cookie) {
  const ck = cookie !== undefined ? cookie : loadCookie();
  const res = await fetch(`${ENGINE.base}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      host: authority(),
      ...(ck ? { cookie: ck } : {}),
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'wb-' + Math.random().toString(36).slice(2, 10),
      method,
      payload: { args },
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  const ok = res.status === 200 && json && json.result && json.result.ok === true;
  return {
    status: res.status,
    ok,
    value: ok ? json.result.value : null,
    error: json && json.result && json.result.error ? json.result.error : null,
    text,
  };
}

/** 把 session/list 的返回拍平。 */
export function flattenSessions(value) {
  const items = (value && value.items) || [];
  return items.map((it) => {
    const v = (it.projections && it.projections.values) || {};
    return {
      sessionId: it.sessionId,
      title: v.title || '',
      cwd: it.cwd || v.workingDirectory || '',
      updatedAt: it.updatedAt || null,
      blank: !!it.blank,
      running: !!it.running,
    };
  });
}

/** 工作区表：会话按 workspace 分组，只传 cwd 建出来的会话会落进「未分组」。 */
export function findWorkspace(cwd) {
  const file = path.join(process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh'), 'storages', 'workspace.json');
  try {
    const tbl = (JSON.parse(fs.readFileSync(file, 'utf8')) || {}).tables || {};
    const norm = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
    for (const [id, v] of Object.entries(tbl.workspaces || {})) {
      if (norm(v.path) === norm(cwd)) return { workspaceId: id, title: v.title || '' };
    }
  } catch (e) { /* 读不到就退回 cwd */ }
  return null;
}
