// DSH 引擎接入层 —— 只做三件事
//
//   ① 代理：把浏览器请求原样转给引擎（带 Cookie），让 AI 面板能内嵌引擎界面
//   ② 注入：在引擎返回的 HTML 里插一行 <script src="/__wb/pin.js?cfg=…">，实现会话绑定
//   ③ RPC：转发 /api/<method> 调用（建会话 / 改名 / 发消息 / 打断）
//
// ⛔ 认证要点（实测踩坑）：
//   引擎的 cookie 里绑定了「audience」（= 请求的 Host:Port）。
//   所以代理时 **Host 必须改成引擎自己的 127.0.0.1:3080**，
//   否则换出来的 cookie 对不上，引擎会一直 401。
//
//   另一个坑：token 换 cookie 的路由要求 pathname 恰好是 "/"，
//   所以必须是 GET /?token=XXX，不能是 GET /index.html?token=XXX。

import http from 'node:http';
import https from 'node:https';
import { ENGINE } from './config.mjs';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
]);

function engineAuthority() {
  return `${ENGINE.host}:${ENGINE.port}`;
}

function targetUrl(url) {
  const u = new URL(url, 'http://wb.invalid');
  // 去掉我们自己的 pin 配置参数，别传给引擎
  u.searchParams.delete('__wbpin');
  return u;
}

/** 转发用的请求头：换 Host，留 Cookie，去逐跳头。 */
export function forwardHeaders(req, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out.host = engineAuthority();
  return { ...out, ...extra };
}

/** 引擎是否在跑（任何响应都算在跑）。 */
export function probe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${ENGINE.base}/`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ up: true, status: res.statusCode });
    });
    req.on('error', () => resolve({ up: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false, status: 0 }); });
  });
}

/**
 * 用启动 token 换一份签名 cookie。
 * 返回 set-cookie 头的完整值（交给浏览器存），换不到返回 null。
 */
export async function exchangeToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${ENGINE.base}/?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
      headers: { host: engineAuthority() },
    });
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return sc.length ? sc : null;
  } catch (e) {
    return null;
  }
}

/** 直接调一次引擎 RPC（服务端调用，用于自检/脚本）。 */
export async function rpc(method, args, cookie = '') {
  const res = await fetch(`${ENGINE.base}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      host: engineAuthority(),
      ...(cookie ? { cookie } : {}),
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
  // ⚠ 引擎的响应信封：{ result: { ok: true, value } } 或 { result: { ok: false, error } }
  //   ok 必须在这里算出来 —— 调用方只认 ok，别自己再判一遍 HTTP 状态码。
  const ok = res.status === 200 && !!(json && json.result && json.result.ok === true);
  return {
    status: res.status,
    ok,
    json,
    text,
    value: ok ? json.result.value : null,
    error: json && json.result && json.result.error ? json.result.error : null,
  };
}

/**
 * 把一个 HTTP 请求代理给引擎。
 * @param {object} opts
 * @param {boolean} opts.injectPin 是否往 HTML 里插 pin 脚本
 * @param {string}  opts.pinCfg     base64url 的绑定配置
 */
export function proxyHttp(req, res, opts = {}) {
  const url = targetUrl(req.url);
  const target = {
    host: ENGINE.host,
    port: ENGINE.port,
    method: req.method,
    path: url.pathname + url.search,
    headers: forwardHeaders(req),
  };

  const upstream = http.request(target, (up) => {
    const ctype = String(up.headers['content-type'] || '');
    const isHtml = ctype.includes('text/html');
    const wantInject = isHtml && opts.injectPin !== false;

    if (!wantInject) {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
      return;
    }

    // HTML 需要改写 ⇒ 先收全再注入
    const chunks = [];
    up.on('data', (c) => chunks.push(c));
    up.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf8');
      const cfg = opts.pinCfg ? `?cfg=${encodeURIComponent(opts.pinCfg)}` : '';
      const tag = `<script src="/__wb/pin.js${cfg}" data-wb-pin="1"></script>`;
      const patched = html.includes('</head>')
        ? html.replace('</head>', `${tag}</head>`)
        : tag + html;

      const headers = { ...up.headers };
      delete headers['content-length'];
      delete headers['content-encoding']; // 已被解压，避免长度对不上
      headers['content-length'] = Buffer.byteLength(patched, 'utf8');
      res.writeHead(up.statusCode || 200, headers);
      res.end(patched);
    });
    up.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
  });

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('引擎连接失败：' + err.message + '\n\n请确认 DSH 引擎已启动（' + ENGINE.base + '）');
    } else {
      try { res.destroy(); } catch (e) { /* ignore */ }
    }
  });

  req.pipe(upstream);
}

/** 代理 WebSocket 升级（引擎的 /api/remote.mux 走这条）。 */
export function proxyUpgrade(req, clientSocket, head) {
  const url = targetUrl(req.url);
  const headers = forwardHeaders(req);
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';

  const upstream = http.request({
    host: ENGINE.host,
    port: ENGINE.port,
    method: req.method,
    path: url.pathname + url.search,
    headers,
  });

  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    clientSocket.write(
      `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n` +
      Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') +
      '\r\n',
    );
    if (upHead && upHead.length) clientSocket.write(upHead);
    upSocket.pipe(clientSocket);
    clientSocket.pipe(upSocket);
    upSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upSocket.destroy());
  });

  upstream.on('response', (upRes) => {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    upRes.resume();
    clientSocket.destroy();
  });

  upstream.on('error', () => clientSocket.destroy());
  if (head && head.length) upstream.write(head);
  upstream.end();
}

export { https };
