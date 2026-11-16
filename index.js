/**
 * 工作台插件 · Host 那一半
 *
 * 它干三件事：
 *
 *   ① 把工作台的界面 + API 挂到**引擎自己的 HTTP 服务**上（默认 /workbench/*）
 *      ⇒ 不用再单开一个 3081 的服务，DSH 界面里点一下就是工作台。
 *
 *   ② 起一排**面板代理端口**（3082…）：每个 AI 面板一个独立 origin。
 *      为什么要独立 origin：引擎只用一个 localStorage 键记住「上次会话」，
 *      共用 origin ⇒ 两个面板互抢会话。一板一端口 = 一板一 localStorage。
 *
 *   ③ 把嵌入用的两份资源加工好：
 *      /workbench/embed.css  —— 把「页面级」选择器改成 :host（挂进 shadow root 用）
 *      /workbench/bundle.js  —— panels.js + app.js 包一层，避免污染 DSH 的全局
 *
 * 认证：跟引擎自己的路由一样（Host/Origin 检查 + 浏览器 cookie），
 * 免得别的网页能拿 127.0.0.1:3080 的接口乱发派单。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const inject = ['webServer', 'connection'];

/** 工作台的代码与数据在哪：配置 > 环境变量 > <当前目录>/workbench > 插件自身目录。 */
function resolveRoot(config) {
  const candidates = [];
  if (config && config.root) candidates.push(String(config.root));
  if (process.env.WB_ROOT) candidates.push(String(process.env.WB_ROOT));
  candidates.push(path.join(process.cwd(), 'workbench'));
  candidates.push(HERE);
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (fs.existsSync(path.join(abs, 'server.mjs'))) return abs;
  }
  return path.resolve(candidates[0]);
}

let loadSeq = 0;

/**
 * 把工作台的 server.mjs 拉进来。
 *
 * ⚠ 必须先设 WB_ROOT 再 import —— lib/config.mjs 在 import 时就定死了根目录。
 * ⚠ server.mjs 每次都**重新** import（带个时间戳破缓存）：
 *    插件被停用/启用时，要拿到最新的代码重新起面板端口，
 *    不然 ESM 缓存里的旧模块会一直用着（端口再也起不来）。
 */
function loadWorkbench(root) {
  loadSeq += 1;
  const stamp = '?wb=' + loadSeq + '-' + Date.now();
  return (async () => {
    process.env.WB_ROOT = root;
    const cfg = await import(pathToFileURL(path.join(root, 'lib', 'config.mjs')).href);
    const srv = await import(pathToFileURL(path.join(root, 'server.mjs')).href + stamp);
    return { cfg, srv };
  })();
}

/* ── 嵌入用的两份资源 ──────────────────────────────────────────── */

/**
 * 页面级 CSS ⇒ shadow root 里用的 CSS。
 * `:root` / `html, body` / `body` 这几处是「整页」语义，
 * 进了 shadow root 就要改成 `:host`（影子宿主 = 那个 div）。
 */
function toEmbedCss(css) {
  return String(css)
    .replace(/:root\s*\{/g, ':host {')
    .replace(/^html,\s*body\s*\{/m, ':host {')
    .replace(/^body\s*\{/gm, ':host {');
}

/**
 * panels.js + app.js 包一层 IIFE。
 * 为什么不直接引两个 <script>：那会把 STATE / el / api 这些名字撒进 DSH 页面的全局。
 */
function toBundleJs(menuSrc, panelsSrc, appSrc) {
  return [
    '/* 工作台前端（嵌进 DSH 界面用）：包一层，避免污染全局 */',
    '(function () {',
    menuSrc,
    panelsSrc,
    appSrc,
    '})();',
    '',
  ].join('\n');
}

function sendText(res, code, body, type) {
  const buf = Buffer.from(String(body ?? ''), 'utf8');
  res.writeHead(code, {
    'content-type': type || 'text/plain; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

/* ── 装载 ──────────────────────────────────────────────────────── */

export function apply(ctx, config = {}) {
  const root = resolveRoot(config);
  const mount = String(config.mountPath || '/workbench').replace(/\/+$/, '') || '/workbench';

  const handler = async (req, res) => {
    // ① 认证：跟引擎自己的路由一个口径
    const rejection = ctx.connection.requestRejection({ headers: req.headers });
    if (rejection) {
      sendText(res, rejection, '需要先在 DSH 界面登录（浏览器里已经有 cookie 才算数）');
      return;
    }

    // ② 把前缀摘掉，剩下的交给工作台自己的路由
    const raw = req.url || '/';
    const q = raw.indexOf('?');
    const pathname = q < 0 ? raw : raw.slice(0, q);
    const search = q < 0 ? '' : raw.slice(q);
    if (pathname !== mount && !pathname.startsWith(mount + '/')) {
      sendText(res, 404, '不在工作台范围内');
      return;
    }
    const sub = pathname.slice(mount.length) || '/';

    let wb;
    try {
      wb = await loadWorkbench(root);
    } catch (err) {
      sendText(res, 500, '工作台装载失败：' + (err && err.message ? err.message : String(err)));
      return;
    }

    // ③ 嵌入用的两份资源
    if (sub === '/embed.css') {
      const file = path.join(wb.cfg.PATHS.web, 'style.css');
      if (!fs.existsSync(file)) { sendText(res, 404, '找不到 style.css'); return; }
      sendText(res, 200, toEmbedCss(fs.readFileSync(file, 'utf8')), 'text/css; charset=utf-8');
      return;
    }
    if (sub === '/bundle.js') {
      const web = wb.cfg.PATHS.web;
      const read = (f) => (fs.existsSync(path.join(web, f)) ? fs.readFileSync(path.join(web, f), 'utf8') : '');
      sendText(res, 200, toBundleJs(read('menu.js'), read('panels.js'), read('app.js')), 'text/javascript; charset=utf-8');
      return;
    }

    req.url = sub + search;
    await wb.srv.handleRequest(req, res);
  };

  const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: mount, handler });

  // 面板代理端口：每个 AI 面板一个独立 origin（详见文件头）
  ctx.effect(() => {
    let stop = () => {};
    loadWorkbench(root).then((wb) => {
      wb.srv.startPanelServers();
    }).catch((err) => {
      ctx.logger?.warn?.('工作台面板端口起不来：' + (err && err.message ? err.message : String(err)));
    });
    return () => { stop(); };
  });

  ctx.effect(() => disposeRoute);

  ctx.logger?.info?.('工作台已挂到 ' + mount + '（目录：' + root + '）');
}
