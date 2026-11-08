/* pin.js —— 注入进引擎页面，负责把 AI 面板「钉」在某一条会话上
 *
 * 原理（来自原仓库的实测结论，别乱改）：
 *
 *   ① 引擎只用一个 localStorage 键记住「上次会话」：
 *        dsh.sessions.current  →  { sessionId: "…" }
 *      它不区分标签、不区分面板 ⇒ 多面板共用一个键就会互抢。
 *      本工作台给每个 AI 面板一个**独立端口的代理**（= 独立 localStorage），
 *      天然实现「一板一分区」，从根上避免鬼绑定。
 *
 *   ② 写键直达：把目标 sessionId 写进本面板分区的 dsh.sessions.current，
 *      引擎下次启动就会直接进这条会话。本脚本是阻塞式 <script>，
 *      在引擎应用启动**之前**执行 ⇒ 预置 ⇒ 打开即命中，不用刷新。
 *
 *   ③ 点行兜底：写键没生效（会话被改名/归档/换过）时，
 *      按标题在会话列表里找到那一行并点它。
 *      ⚠ 会话行 = div[role="treeitem"][aria-selected]，**行里没有会话 id**，
 *        标题在 <span class*="title">，行文本还带相对时间 ⇒ 不能拿整行文本做完全相等判断。
 *      ⚠ 分组头 = div[role="treeitem"][aria-expanded]，点了只展开分组，绝不能点。
 *
 *   ④ 判据只看画面：「键写对了」≠「界面切过去了」。所以每轮都重新读当前标题再判断。
 */

(function () {
  'use strict';

  if (window.__wbPinLoaded) return;
  window.__wbPinLoaded = true;

  var SEL_KEY = 'dsh.sessions.current';
  var CFG_KEY = '__wb_pin_cfg';
  var RELOAD_MAX = 5;
  var RELOAD_GAP_MS = 8000;
  var RELOAD_GAP_SLOW_MS = 25000;

  // ── 配置 ────────────────────────────────────────────────────────
  // ⚠ 配置在**脚本自己的 URL** 上（/?cfg=…），不在 iframe 页面的 location.search 上。
  //   两者不一样：iframe 是 /engine/?__wbpin=…，脚本是 /__wb/pin.js?cfg=…
  function cfgFromScript() {
    var s = document.currentScript;
    if (s && s.src) {
      try {
        var u = new URL(s.src, location.href);
        var v = u.searchParams.get('cfg');
        if (v) return v;
      } catch (e) { /* ignore */ }
    }
    try {
      var q = new URLSearchParams(location.search).get('cfg');
      if (q) return q;
    } catch (e) { /* ignore */ }
    return '';
  }

  var cfg = null;
  try {
    var raw = cfgFromScript() || sessionStorage.getItem(CFG_KEY) || '';
    if (raw) {
      cfg = JSON.parse(raw);
      sessionStorage.setItem(CFG_KEY, raw);
    }
  } catch (e) { cfg = null; }

  var PANEL = String((cfg && cfg.panel) || 'ai').replace(/[^A-Za-z0-9_-]/g, '') || 'ai';
  var SESSION_ID = String((cfg && cfg.sessionId) || '').trim();
  var SESSION_TITLE = String((cfg && cfg.sessionTitle) || '').trim();
  var TARGETS = (Array.isArray(cfg && cfg.pinTarget) ? cfg.pinTarget : [])
    .map(function (t) { return String(t == null ? '' : t).trim(); })
    .filter(Boolean);

  // 签名：改了绑定配置 ⇒ 换键 ⇒ 旧绑定记忆立刻失效（防鬼绑定）
  var SIG = SESSION_ID || SESSION_TITLE || TARGETS.join('|') || 'none';
  var BIND_KEY = 'app_pin_bind_v2:' + PANEL + ':' + SIG;
  var GEN = 'pin_v3:' + BIND_KEY;

  if (window.__pinGen === GEN) {
    try { window.__pinTick && window.__pinTick(); } catch (e) { /* ignore */ }
    return;
  }
  window.__pinGen = GEN;

  // ── 基础工具 ────────────────────────────────────────────────────
  function norm(x) {
    // 只压连续空白，**不能删掉单个空格**：孪生会话「DSH 改造」/「DSH改造」不是同一条
    return String(x == null ? '' : x).toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function readSel() {
    try { return JSON.parse(localStorage.getItem(SEL_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeSel(id) {
    try {
      var cur = readSel();
      if (!cur || typeof cur !== 'object') cur = {};
      localStorage.setItem(SEL_KEY, JSON.stringify(Object.assign({}, cur, { sessionId: String(id) })));
      return true;
    } catch (e) { return false; }
  }
  function readBind() {
    try { var s = localStorage.getItem(BIND_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function saveBind(title) {
    try { localStorage.setItem(BIND_KEY, JSON.stringify({ title: String(title) })); } catch (e) { /* ignore */ }
  }
  function clearBind() {
    try { localStorage.removeItem(BIND_KEY); } catch (e) { /* ignore */ }
  }

  // ── 预置：引擎应用启动之前就把目标会话写进存储 ──────────────────
  // 这样打开面板即命中那条会话，不会先闪一下别的会话。
  (function preseed() {
    if (!SESSION_ID) return;
    var cur = readSel();
    if (!cur || String(cur.sessionId || '') !== String(SESSION_ID)) {
      writeSel(SESSION_ID);
    }
  })();

  // ── DOM 读取 ────────────────────────────────────────────────────
  function isGroupHead(e) {
    return !!(e && e.getAttribute && e.getAttribute('role') === 'treeitem'
      && e.hasAttribute('aria-expanded'));
  }
  function isSessionRow(e) {
    if (!e || !e.getAttribute) return false;
    if (e.getAttribute('role') === 'treeitem') return !isGroupHead(e);
    return e.hasAttribute('aria-selected');
  }
  function readText(e) {
    if (!e) return '';
    var t = e.querySelector ? e.querySelector('[class*="title"]') : null;
    if (t && t.textContent) return t.textContent.trim();
    var aria = e.getAttribute && e.getAttribute('aria-label');
    if (aria) {
      var m = String(aria).match(/[「『](.+?)[」』]/);
      if (m) return m[1].trim();
    }
    return (e.textContent || '').trim();
  }
  function allRows() {
    var out = [];
    var seen = new Set();
    var nodes = document.querySelectorAll('div[role="treeitem"], li, [aria-selected]');
    for (var i = 0; i < nodes.length; i++) {
      var e = nodes[i];
      if (seen.has(e)) continue;
      seen.add(e);
      if (isGroupHead(e)) continue;
      if (!isSessionRow(e)) continue;
      var t = readText(e);
      if (!t) continue;
      out.push({ el: e, t: t, n: norm(t) });
    }
    return out;
  }
  /** 当前画面上的会话标题：优先 DOM 里选中的行，其次 document.title。 */
  function titleOf() {
    var sel = document.querySelector('[role="treeitem"][aria-selected="true"], [aria-selected="true"]');
    if (sel) {
      var t = readText(sel);
      if (t) return { title: t, src: 'dom' };
    }
    var dt = String(document.title || '').replace(/\s*[—–-]\s*DSH.*$/i, '').trim();
    if (dt) return { title: dt, src: 'title' };
    return { title: '', src: '' };
  }
  /** 画面上是不是已经是我们要的那条？ */
  function titlePinned(current) {
    var t = norm(current);
    if (!t) return false;
    var bind = readBind();
    if (bind && bind.title && t === norm(bind.title)) return true;
    if (SESSION_TITLE && t === norm(SESSION_TITLE)) return true;
    for (var i = 0; i < TARGETS.length; i++) {
      if (t.indexOf(norm(TARGETS[i])) >= 0) return true;
    }
    return false;
  }
  /** 找一个标题匹配的行。优先完全相等，其次包含。 */
  function findBest(rows) {
    var bind = readBind();
    var want = [];
    if (bind && bind.title) want.push({ n: norm(bind.title), by: '绑定标题:' + bind.title, exact: true });
    if (SESSION_TITLE) want.push({ n: norm(SESSION_TITLE), by: '指定标题:' + SESSION_TITLE, exact: true });
    for (var i = 0; i < TARGETS.length; i++) {
      want.push({ n: norm(TARGETS[i]), by: '候选名:' + TARGETS[i], exact: false });
    }
    for (var w = 0; w < want.length; w++) {
      var W = want[w];
      if (!W.n) continue;
      var best = null;
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var hit = W.exact ? (row.n === W.n) : (row.n.indexOf(W.n) >= 0);
        if (!hit) continue;
        // 完全相等 > 文本越短越像
        var score = (row.n === W.n ? 0 : 1000) + row.n.length;
        if (!best || score < best.score) best = { row: row, score: score };
      }
      if (best) {
        return {
          el: best.row.el,
          title: best.row.t,
          by: (best.row.n === W.n ? '完全相等 · ' : '包含 · ') + W.by,
        };
      }
    }
    return null;
  }
  /** 合成事件点一下（React 才收得到，.click() 不够）。 */
  function doClick(el) {
    try {
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
        var Ctor = type.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
        try {
          el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
        } catch (e) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      });
      window.__wbPinClickedAt = Date.now();
      window.__wbPinLastHit = el.textContent;
    } catch (e) { /* ignore */ }
  }

  // ── 诊断回传 ────────────────────────────────────────────────────
  function report(extra) {
    var cur = titleOf();
    var d = {
      source: 'wb-pin',
      panel: PANEL,
      sessionId: SESSION_ID,
      sessionTitle: SESSION_TITLE,
      targets: TARGETS,
      stored: (function () { var s = readSel(); return s && s.sessionId ? String(s.sessionId) : ''; })(),
      bound: readBind(),
      title: cur.title,
      titleSrc: cur.src,
      pinned: titlePinned(cur.title),
      rows: allRows().length,
      clickedAt: window.__wbPinClickedAt || 0,
    };
    if (extra) Object.assign(d, extra);
    try { window.parent.postMessage(d, '*'); } catch (e) { /* ignore */ }
  }

  // ── 主循环 ──────────────────────────────────────────────────────
  var lastAction = 0;
  var reloads = 0;
  var reloadAt = 0;
  function bumpReloads() { reloads++; }
  function reloadGap() { return reloads >= 3 ? RELOAD_GAP_SLOW_MS : RELOAD_GAP_MS; }

  function clickItem() {
    if (!SESSION_ID && !SESSION_TITLE && !TARGETS.length) {
      var b0 = readBind();
      if (!b0 || !b0.title) { report({ state: 'unbound' }); return; }
    }
    var cur = titleOf();
    if (titlePinned(cur.title)) {
      // 记住了这条的精确标题，下次按标题认人更准
      var bind = readBind();
      if (cur.title && (!bind || bind.title !== cur.title)) saveBind(cur.title);
      report({ state: 'pinned' });
      return;
    }
    var now = Date.now();
    if (now - lastAction < 1500) { report({ state: 'waiting' }); return; }
    lastAction = now;

    // ① 直达通道：键里不是目标 id ⇒ 写进去，让引擎下次直接进这条
    if (SESSION_ID) {
      var cur2 = readSel();
      var curId = cur2 && cur2.sessionId ? String(cur2.sessionId) : '';
      if (curId !== String(SESSION_ID)) {
        if (writeSel(SESSION_ID)) {
          reloads++; reloadAt = now;
          report({ state: 'need-reload' });
          // 预置阶段已经写过；这里再写一次是兜底（引擎可能改写了键）
          return;
        }
      }
    }

    // ② 点行兜底：按标题找到那一行并点它
    var rows = allRows();
    var hit = findBest(rows);
    if (hit) {
      doClick(hit.el);
      report({ state: 'clicked', by: hit.by, hitTitle: hit.title });
      return;
    }

    // ③ 展开一个折叠的分组，下一轮再找
    var collapsed = [];
    document.querySelectorAll('div[role="treeitem"][aria-expanded]').forEach(function (e) {
      if (e.getAttribute('aria-expanded') === 'false') collapsed.push(e);
    });
    if (collapsed.length) {
      doClick(collapsed[0]);
      report({ state: 'expanding' });
      return;
    }

    report({ state: 'not-found' });
  }

  // ── 装定时器（幂等：同一份配置只装一次） ────────────────────────
  window.__pinTick = function () {
    try { clickItem(); } catch (e) { report({ state: 'error', error: String(e && e.message || e) }); }
  };
  setTimeout(function () { window.__pinTick(); }, 800);
  var fast = setInterval(function () { window.__pinTick(); }, 1500);
  setTimeout(function () { clearInterval(fast); }, 30000);      // 前 30 秒密一点
  setInterval(function () { window.__pinTick(); }, 4000);        // 常驻
  // 心跳诊断：报**当前真实状态**，别把「已钉住」刷成「检测中」
  setInterval(function () {
    try {
      var cur = titleOf();
      report({ state: titlePinned(cur.title) ? 'pinned' : 'idle' });
    } catch (e) { report({ state: 'idle' }); }
  }, 5000);

  report({ state: 'installed' });
})();
