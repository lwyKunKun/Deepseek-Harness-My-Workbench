#!/usr/bin/env node
// mock-engine.mjs —— 假引擎，只用来验证「钉会话」这条链路
//
// 它复刻 DSH GUI 的 DOM 契约（原仓库实测出来的）：
//   · 会话行 = div[role="treeitem"][aria-selected]，**行里没有会话 id**（但这里额外给了 data-session-id 方便观察）
//   · 标题在 <span class="title">，行文本还带相对时间
//   · 分组头 = div[role="treeitem"][aria-expanded]（点了只展开分组）
//   · 引擎用 localStorage['dsh.sessions.current'] 记住「上次会话」
//
// 用法：DSH_ENGINE_BASE=http://127.0.0.1:3099 node server.mjs
//   然后把场景里的 sessionId 填成 s-cmd / s-rs 之类，再看面板小字是不是变成「✓ 已钉」。

import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 3099);

const SESSIONS = [
  { id: 's-cmd', title: '命令', group: '工作区' },
  { id: 's-rs', title: '调研', group: '工作区' },
  { id: 's-ops', title: '运维', group: '工作区' },
  { id: 's-cmd2', title: '命令 改造', group: '其他' },
  { id: 's-cmd3', title: '命令改造', group: '其他' },
];

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>DeepSeek Harness</title>
<style>
  body { margin:0; font-family: system-ui; background:#0d1017; color:#e6e8ee; display:flex; height:100vh; }
  aside { width:260px; border-right:1px solid #232a3a; padding:10px; overflow:auto; }
  .grp { font-size:11px; color:#8b93a7; margin:12px 0 4px; }
  .row { padding:6px 8px; border-radius:6px; cursor:pointer; display:flex; justify-content:space-between; }
  .row:hover { background:#1a2030; }
  .row[aria-selected="true"] { background:rgba(79,140,255,.16); outline:1px solid rgba(79,140,255,.4); }
  .title { font-size:13px; }
  .time { font-size:10px; color:#8b93a7; }
  main { flex:1; padding:20px; }
</style></head>
<body>
<aside id="side"></aside>
<main><h2>对话</h2><div id="flow" data-chat-flow>（这里会是聊天区）</div></main>
<script>
(function () {
  var SESSIONS = __SESSIONS__;
  var side = document.getElementById('side');
  var groups = {};
  SESSIONS.forEach(function (s) { (groups[s.group] = groups[s.group] || []).push(s); });

  function rowOf(s) {
    var d = document.createElement('div');
    d.className = 'row';
    d.setAttribute('role', 'treeitem');
    d.setAttribute('aria-selected', 'false');
    d.setAttribute('data-session-id', s.id);
    var t = document.createElement('span'); t.className = 'title'; t.textContent = s.title;
    var m = document.createElement('span'); m.className = 'time'; m.textContent = '3天前';
    d.appendChild(t); d.appendChild(m);
    d.addEventListener('click', function () { select(s.id); });
    return d;
  }
  function select(id) {
    SESSIONS.forEach(function (s) {
      var el = side.querySelector('[data-session-id="' + s.id + '"]');
      if (el) el.setAttribute('aria-selected', String(s.id === id));
    });
    var s = SESSIONS.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    document.title = s.title + ' — DeepSeek Harness';
    // 引擎记住「上次会话」
    try {
      var cur = JSON.parse(localStorage.getItem('dsh.sessions.current') || 'null') || {};
      cur.sessionId = id;
      localStorage.setItem('dsh.sessions.current', JSON.stringify(cur));
    } catch (e) {}
    window.__mockCurrent = s.title;
    // 回报给 mock 服务端（便于用命令行断言到底选中了哪条）
    try { fetch('/mock/select?id=' + encodeURIComponent(id)); } catch (e) {}
  }
  Object.keys(groups).forEach(function (g) {
    var h = document.createElement('div'); h.className = 'grp'; h.textContent = g;
    side.appendChild(h);
    groups[g].forEach(function (s) { side.appendChild(rowOf(s)); });
  });

  // 引擎启动时：读出「上次会话」并打开它
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem('dsh.sessions.current') || 'null'); } catch (e) {}
  if (stored && stored.sessionId) select(String(stored.sessionId));
  window.__mockReady = true;

  // 诊断心跳：把「钉住脚本有没有装上」「存储里是什么」回报给 mock 服务端
  setTimeout(function () {
    try {
      fetch('/mock/probe?pinLoaded=' + (window.__wbPinLoaded ? 1 : 0) +
            '&gen=' + encodeURIComponent(String(window.__pinGen || '')) +
            '&stored=' + encodeURIComponent(String(localStorage.getItem('dsh.sessions.current') || '')) +
            '&title=' + encodeURIComponent(String(document.title || '')) +
            '&current=' + encodeURIComponent(String(window.__mockCurrent || '')));
    } catch (e) {}
  }, 1500);
})();
</script>
</body></html>`;

const selected = { id: '', title: '', at: 0, history: [] };
const probes = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/mock/select') {
    const id = u.searchParams.get('id') || '';
    const s = SESSIONS.find((x) => x.id === id);
    selected.id = id;
    selected.title = s ? s.title : '';
    selected.at = Date.now();
    selected.history.push({ id, title: selected.title, at: selected.at });
    console.log('  [mock] 选中会话：' + selected.title + ' (' + id + ')');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (u.pathname === '/mock/probe') {
    const info = Object.fromEntries(u.searchParams.entries());
    probes.push({ ...info, at: Date.now() });
    console.log('  [mock] probe ' + JSON.stringify(info));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (u.pathname === '/mock/probes') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(probes));
    return;
  }
  if (u.pathname === '/mock/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(selected));
    return;
  }
  if (u.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', result: { ok: true, value: { items: [] } } }));
    return;
  }
  const html = PAGE.replace('__SESSIONS__', JSON.stringify(SESSIONS));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock 引擎： http://127.0.0.1:' + PORT);
});
