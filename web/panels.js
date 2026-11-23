/* panels.js —— 面板注册表
 *
 * 注册 = 往一个普通对象上赋值（没有 registerPanel() 这种函数式 API）。
 * 渲染器签名固定：(body, meta, head) => void | (() => void)
 *   body  = .panel-body（带 dataset.kind = meta.type）
 *   meta  = 场景 json 里那个面板对象（已注入 scenario 字段）
 *   head  = .panel-head 容器，可往里塞按钮和小字
 *   返回值 = 可选 cleanup，切场景时统一调用
 *
 * ⛔ 热更新约束：顶层一律用 var / function 声明。
 *   用 const/let 的话，重跑整份脚本会撞车，Chromium 对解析失败不发 onerror ⇒ 静默失效。
 */

var PANELS = {};

/* ── 小工具 ─────────────────────────────────────────────────────── */
function wbEl(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
/**
 * API 前缀：独立页是 ''，嵌在 DSH 界面里是 '/workbench'。
 * 由 app.js 的 mountWorkbench 设进 window.__WB_BASE（这里只读）。
 */
function wbBase() {
  return (typeof window !== 'undefined' && window.__WB_BASE) || '';
}
function wbApi(method, url, body) {
  return fetch(wbBase() + url, {
    method: method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) { return r.json(); });
}
function wbToast(text, bad) {
  var scope = (typeof window !== 'undefined' && window.__WB_ROOT_EL) || document;
  var host = scope.querySelector ? scope.querySelector('#toast-host') : null;
  if (!host) return;
  var t = wbEl('div', 'toast' + (bad ? ' bad' : ''), text);
  host.appendChild(t);
  setTimeout(function () { t.classList.add('out'); }, 2600);
  setTimeout(function () { t.remove(); }, 3200);
}

/**
 * ★ 留一笔操作痕迹（人在界面上的动作）。
 *
 * 服务端自己改的东西（进度·加书·上传·写记忆）由后端就地留痕；
 * 这里补的是**只有界面知道**的动作：进场景、开哪本书、翻到第几条…
 *
 * 失败不打扰人 —— 留痕是辅助，不该挡住正事。
 */
function wbAct(scene, action, target, detail) {
  if (!scene || !action) return;
  try {
    var payload = {
      scene: String(scene),
      actor: 'user',
      action: String(action),
      target: target == null ? '' : String(target),
      detail: detail == null ? '' : detail,
    };
    fetch(wbBase() + '/api/actlog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(function () { /* 留不上就算了 */ });
  } catch (e) { /* 同上 */ }
}
/** 往标题栏塞一组小按钮 + 一行诊断小字。 */
function wbHeadActs(head, id) {
  var acts = wbEl('div', 'panel-acts');
  var diag = wbEl('span', 'panel-diag');
  diag.id = 'diag-' + id;
  acts.appendChild(diag);
  head.appendChild(acts);
  return { acts: acts, diag: diag };
}
function wbHeadButton(head, label, title, onClick) {
  var b = wbEl('button', 'panel-btn', label);
  if (title) b.title = title;
  b.addEventListener('click', function (e) { e.stopPropagation(); onClick(e); });
  head.appendChild(b);
  return b;
}

/* ── 1. harness：AI 会话面板 ────────────────────────────────────── */
PANELS.harness = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  body.classList.add('no-pad');

  var wrap = wbEl('div', 'harness-wrap');
  var frame = wbEl('iframe', 'harness-frame');
  frame.setAttribute('title', meta.title || 'AI 会话');
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  wrap.appendChild(frame);
  body.appendChild(wrap);

  // 面板专属的代理端口 ⇒ 独立 localStorage ⇒ 不会跟别的面板抢会话
  var port = (window.__wbAllocPort && window.__wbAllocPort(meta.id)) || 0;
  var cfg = {
    panel: meta.id,
    sessionId: meta.sessionId || '',
    sessionTitle: meta.sessionTitle || '',
    pinTarget: meta.pinTarget || [],
  };
  var src = 'http://127.0.0.1:' + port + '/engine/?__wbpin=' + encodeURIComponent(JSON.stringify(cfg));
  frame.src = src;

  var diag = acts.diag;
  function onMsg(e) {
    if (!e.data || e.data.source !== 'wb-pin') return;
    if (e.data.panel !== meta.id) return;
    var d = e.data;
    var txt;
    if (d.pinned || d.state === 'pinned') txt = '✓ 已钉';
    else if (d.state === 'clicked') txt = '✓ 已钉（点行）';
    else if (d.state === 'unbound') txt = '○ 未绑定 · 自由选会话';
    else if (d.state === 'need-reload') txt = '⚠ 需刷新一次';
    else if (d.state === 'not-found') txt = '✗ 找不到会话行';
    else if (d.state === 'expanding') txt = '… 展开分组中';
    else txt = '检测中…';
    diag.textContent = txt;
    diag.title =
      '目标会话：' + (d.sessionId || '（未指定）') + '\n' +
      '存储里的当前会话：' + (d.stored || '（空）') + '\n' +
      '画面上的会话：' + (d.title || '读不到') + '\n' +
      (d.titles && d.titles.length > 1 ? '候选标题：' + d.titles.join(' / ') + '\n' : '') +
      '会话行数：' + (d.rows != null ? d.rows : '?') + '\n' +
      '（点这行小字 = 忘掉记住的标题，重新按会话名匹配）';
    diag.className = 'panel-diag ' + (d.pinned ? 'ok' : (d.state === 'not-found' ? 'bad' : ''));
  }
  window.addEventListener('message', onMsg);

  diag.addEventListener('click', function () {
    try {
      var w = frame.contentWindow;
      if (w) { w.localStorage.removeItem('app_pin_bind_v2:' + meta.id); w.location.reload(); }
    } catch (e) { wbToast('清绑定失败：' + e.message, true); }
  });

  wbHeadButton(head, '⟳', '重新加载这个面板', function () {
    try { frame.contentWindow.location.reload(); } catch (e) { frame.src = src; }
  });

  return function () {
    window.removeEventListener('message', onMsg);
    if (window.__wbFreePort) window.__wbFreePort(meta.id);
  };
};

/* ── 留痕的折叠/聚合（只动显示，不动数据） ──────────────────────────
 *
 * 为什么折：台账里 87% 是「选中场景 / 进入场景」这种纯点击（实测 157 条里 136 条），
 *   再加上会话里 AI 的每次 bash/read ⇒ 一个场景 250+ 行，真事淹没在噪声里。
 *
 * 折法：
 *   · 导航动作（选中场景 / 进入场景）⇒ 一天合成一行「进出场景 ×N」
 *   · AI 的工具调用 ⇒ 按工具名合成一行「bash ×12　14:02→14:09」，点开看明细
 *   · 有结果的动作（打开书 / 写记忆 / 更新阅读进度…）⇒ 一条一行，不折
 *
 * ⚠ 台账（data/acts/*.jsonl）照旧**全记**：折叠只是显示层，随时能查全量。
 */

/** 纯导航动作：点一下树、进出场景 —— 不算「干了什么」。 */
var ACT_NAV_ACTIONS = { '选中场景': 1, '进入场景': 1 };

function actIsNav(e) { return e.actor !== 'ai' && !!ACT_NAV_ACTIONS[e.action]; }
function actIsTool(e) { return e.actor === 'ai'; }
function actDayOf(e) { return e.day || wbLocalDay(e); }

/** 一批留痕 ⇒ 「天 → 折好的行」（新的在前）。 */
function actBuildGroups(entries) {
  var days = [];
  var byDay = new Map();
  (entries || []).forEach(function (e) {
    var day = actDayOf(e);
    var d = byDay.get(day);
    if (!d) {
      d = { day: day, nav: null, tools: [], toolMap: new Map(), singles: [] };
      byDay.set(day, d);
      days.push(d);
    }
    if (actIsNav(e)) {
      if (!d.nav) d.nav = { kind: 'nav', count: 0, byAction: {}, items: [], first: e, last: e };
      d.nav.count += 1;
      d.nav.byAction[e.action] = (d.nav.byAction[e.action] || 0) + 1;
      d.nav.items.push(e);
      d.nav.last = e;
      return;
    }
    if (actIsTool(e)) {
      var g = d.toolMap.get(e.action);
      if (!g) {
        g = { kind: 'tool', action: e.action, count: 0, items: [], first: e, last: e };
        d.toolMap.set(e.action, g);
        d.tools.push(g);
      }
      g.count += 1;
      g.items.push(e);
      g.last = e;
      return;
    }
    d.singles.push({ kind: 'one', entry: e, last: e });
  });
  days.reverse();                       // 新的天在前
  days.forEach(function (d) {
    var list = [];
    if (d.nav) list.push(d.nav);
    d.tools.forEach(function (g) { list.push(g); });
    d.singles.forEach(function (s) { list.push(s); });
    list.sort(function (a, b) { return (b.last.at || 0) - (a.last.at || 0); });
    d.rows = list;
  });
  return days;
}

/* ── 操作留痕的视图（项目信息里的「留痕」页签 / 独立的留痕面板共用） ── */

/**
 * 留痕的本地日期 / 本地时间。
 *
 * ⚠ 踩过的坑：台账里存的是 **ISO UTC**（`2026-11-17T09:09:07.930Z`）——
 *   以前直接切字符串 `ts.slice(11,19)` 显示出来的是 **UTC**，
 *   本地是 CST+8 就整整差 8 小时 ⇒ 「每个场景的留痕时间都是错的」。
 *   现在一律用 `at`（epoch ms）换成本地时间。
 */
function wbLocalDay(e) {
  var d = wbActInstant(e);
  if (!d) return '';
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function wbLocalTime(e) {
  var d = wbActInstant(e);
  if (!d) return '';
  var p = function (n) { return String(n).padStart(2, '0'); };
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
/** 一条留痕的时刻（epoch ms；没有 at 就从 ts 解析）。 */
function wbActInstant(e) {
  var at = Number(e && e.at);
  if (at) return new Date(at);
  var t = Date.parse(String((e && e.ts) || ''));
  return isNaN(t) ? null : new Date(t);
}

/**
 * 画一条操作时间线。
 * @param {HTMLElement} box  容器
 * @param {string} sceneId   场景 id
 * @param {function} onLoad  每次取到数据后回调（条数）
 * @returns {{refresh: function}} 刷新函数
 */
function wbActlogView(box, sceneId, onLoad) {
  box.innerHTML = '';
  var top = wbEl('div', 'act-top');
  var filters = wbEl('div', 'act-filters');
  top.appendChild(filters);
  var exportBtn = wbEl('button', 'chip', '导出 Markdown');
  exportBtn.addEventListener('click', function () {
    wbApi('POST', '/api/actlog/export', { scene: sceneId }).then(function (r) {
      if (!r || !r.ok) { wbToast('导不出：' + ((r && r.error) || '未知'), true); return; }
      wbToast('已导出 ' + r.count + ' 条 → ' + r.path);
    }).catch(function (e) { wbToast('导不出：' + ((e && e.message) || e), true); });
  });
  top.appendChild(exportBtn);
  var refreshBtn = wbEl('button', 'chip', '刷新');
  top.appendChild(refreshBtn);
  box.appendChild(top);

  var foldNote = wbEl('div', 'act-foldnote');
  box.appendChild(foldNote);
  var list = wbEl('div', 'act-list');
  box.appendChild(list);

  var rows = [];
  var summary = null;
  var who = 'all';          // all | user | ai

  function renderFilters() {
    filters.innerHTML = '';
    [['all', '全部'], ['user', '人'], ['ai', 'AI']].forEach(function (pair) {
      var b = wbEl('button', 'chip' + (who === pair[0] ? ' solid' : ''), pair[1]);
      b.addEventListener('click', function () { who = pair[0]; renderFilters(); render(); });
      filters.appendChild(b);
    });
  }

  function detailOf(d) {
    if (!d) return null;
    if (typeof d === 'object') {
      var keys = Object.keys(d);
      if (!keys.length) return null;
      var span = wbEl('span', 'act-detail');
      keys.forEach(function (k) { span.appendChild(wbEl('span', 'act-kv', k + '=' + d[k])); });
      return span;
    }
    return wbEl('span', 'act-detail', String(d));
  }

  /**
   * 折好的一行 ⇒ 卡片。
   * kind: 'one'（一条真事，原样）｜'nav'（进出场景 ×N）｜'tool'（某个工具 ×N）
   */
  function renderGroup(r) {
    var wrap = wbEl('div', 'act-group');
    var row = wbEl('div', 'act-row' + (r.kind === 'tool' ? ' ai' : ''));
    var timeTxt, actionTxt, extra = '';
    if (r.kind === 'nav') {
      timeTxt = r.last.time || wbLocalTime(r.last);
      actionTxt = '进出场景';
      extra = Object.keys(r.byAction).map(function (k) { return k + ' ' + r.byAction[k]; }).join(' · ');
    } else if (r.kind === 'tool') {
      var t1 = r.first.time || wbLocalTime(r.first);
      var t2 = r.last.time || wbLocalTime(r.last);
      timeTxt = r.count > 1 ? (t1 + '→' + t2) : t2;
      actionTxt = r.action;
    } else {
      timeTxt = r.entry.time || wbLocalTime(r.entry);   // ⚠ 本地时间（不是 UTC）
      actionTxt = r.entry.action;
    }
    row.appendChild(wbEl('span', 'act-time', timeTxt));
    row.appendChild(wbEl('span', 'act-who', r.kind === 'tool' ? 'AI' : (r.kind === 'one' && r.entry.actor === 'system' ? '系统' : '人')));
    row.appendChild(wbEl('span', 'act-action', actionTxt));
    if (r.count > 1) row.appendChild(wbEl('span', 'act-count', '×' + r.count));
    if (extra) row.appendChild(wbEl('span', 'act-target', extra));
    else if (r.kind === 'one' && r.entry.target) row.appendChild(wbEl('span', 'act-target', r.entry.target));
    var d = (r.kind === 'one') ? detailOf(r.entry.detail) : null;
    if (d) row.appendChild(d);
    wrap.appendChild(row);

    if (r.kind !== 'one' && r.items && r.items.length) {
      // 折起来的明细 ⇒ 点一下展开（原始记录一条没丢）
      var box = wbEl('div', 'act-sub');
      box.style.display = 'none';
      r.items.slice().reverse().forEach(function (e) {
        var line = wbEl('div', 'act-sub-line');
        line.appendChild(wbEl('span', 'act-time', e.time || wbLocalTime(e)));
        line.appendChild(wbEl('span', 'act-action', e.action));
        if (e.target) line.appendChild(wbEl('span', 'act-target', String(e.target).slice(0, 90)));
        box.appendChild(line);
      });
      row.classList.add('clickable');
      row.title = '点开看这 ' + r.items.length + ' 条明细';
      row.addEventListener('click', function () {
        box.style.display = (box.style.display === 'none') ? '' : 'none';
        row.classList.toggle('open', box.style.display !== 'none');
      });
      wrap.appendChild(box);
    }
    return wrap;
  }

  function render() {
    list.innerHTML = '';
    var shown = who === 'all' ? rows : rows.filter(function (e) { return e.actor === who; });
    if (!shown.length) {
      list.appendChild(wbEl('div', 'todo-empty', rows.length ? '这个筛选下没有记录' : '这个场景还没有留痕'));
      return;
    }
    var groups = actBuildGroups(shown);
    var nRows = 0;
    groups.forEach(function (g) { nRows += g.rows.length; });
    // 顶部：原始多少条 → 折成多少行（说清楚折掉了什么，别让人以为记录丢了）
    foldNote.textContent = shown.length > nRows
      ? ('原始 ' + shown.length + ' 条 → 折成 ' + nRows + ' 行（进出场景、AI 工具调用已折叠，点开看明细）')
      : (shown.length + ' 条');
    groups.forEach(function (g) {
      list.appendChild(wbEl('div', 'act-day', g.day));
      g.rows.forEach(function (r) { list.appendChild(renderGroup(r)); });
    });
  }

  function load() {
    wbApi('GET', '/api/actlog?scene=' + encodeURIComponent(sceneId) + '&limit=300&ai=1')
      .then(function (r) {
        if (!r || !r.ok) {
          list.innerHTML = '';
          list.appendChild(wbEl('div', 'todo-empty', (r && r.error) || '读不到留痕'));
          return;
        }
        rows = r.entries || [];
        summary = r.summary || null;
        render();
        if (onLoad) onLoad(rows.length, summary);
      }).catch(function (e) {
        list.innerHTML = '';
        list.appendChild(wbEl('div', 'todo-empty', '读不到留痕：' + ((e && e.message) || e)));
      });
  }

  renderFilters();
  load();
  refreshBtn.addEventListener('click', function () { load(); });
  return { refresh: load, getRows: function () { return rows; }, getSummary: function () { return summary; } };
}

/* ── 2. memory：项目信息.md（分节）+ 身份卡 + 留痕 ───────────────── */
PANELS.memory = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var scene = meta.scenario;
  var SECTIONS = [
    { key: '§〇', name: '当前交接', hint: '开场先读这一节，≤4K' },
    { key: '§一', name: '场景清单', hint: '这个项目有几个场景 / 几个面板' },
    { key: '§二', name: '资产路径', hint: '东西在哪' },
    { key: '§五', name: '资产索引', hint: '文件多了 AI 只看索引' },
    { key: '§六', name: '协作', hint: '跟别的场景怎么搭界' },
  ];
  var tabs = wbEl('div', 'mem-tabs');
  var editBox = wbEl('div', 'mem-editor');
  body.appendChild(tabs);
  body.appendChild(editBox);
  var cur = '§〇';
  var secs = {};             // 各节的**手写**正文（load 时从 项目信息.md 解析出来）
  var autos = {};            // 各节的自动区（派生内容，只读）
  var titles = {};           // 各节的标题（§三 阅读台账这种，名字在文件里）
  var cardText = '';         // 身份卡正文
  var drafts = {};           // 改过还没存的草稿（按页签存，切页签不丢）
  var health = null;
  var dupNote = '';         // ⚠ 文件里有两段 §〇（只有最后一段算数）
  var trail = null;          // 「留痕」页签里的那条时间线
  var trailTimer = null;     // 停留在这个页签时的自动刷新

  /* 自动区（派生块）：内容是程序按真实数据算出来的 ⇒ 只读，人改不动。
     规矩跟 lib/memory.mjs 一致：<!-- 自动:<key>:start --> … <!-- 自动:<key>:end --> */
  var AUTO_RE = /<!--\s*自动:([A-Za-z0-9_.\-]+):start\s*-->([\s\S]*?)<!--\s*自动:\1:end\s*-->/g;

  /** 一节正文 ⇒ 自动区们 + 手写内容。 */
  function splitAuto(text) {
    var src = String(text || '');
    var blocks = [];
    var re = new RegExp(AUTO_RE.source, 'g');
    var m;
    while ((m = re.exec(src))) {
      blocks.push({ key: m[1], content: String(m[2] || '').replace(/^\n+/, '').replace(/\s+$/, '') });
    }
    var manual = src.replace(new RegExp(AUTO_RE.source, 'g'), '').replace(/\n{3,}/g, '\n\n').trim();
    return { blocks: blocks, manual: manual };
  }

  /**
   * 这个页签该显示什么？
   * ⚠ 踩过的坑：以前 curText 只在 load() 里算一次 ⇒ 切页签时显示的是**上一节**的正文，
   *   在 §一 里点保存 ⇒ 把 §〇 的内容写进 §一（数据被改坏）。
   *   现在：草稿优先，没有草稿才取磁盘上那一节的正文。
   */
  function textFor(key) {
    if (Object.prototype.hasOwnProperty.call(drafts, key)) return drafts[key];
    if (key === '身份卡') return cardText;
    return secs[key] || '';
  }

  // 想直接落到「留痕」页签上（卡片里「打开场景看全部」那个按钮）⇒ 认一下
  try {
    if (window.__WB_MEM_TAB && window.__WB_MEM_TAB.scene === scene && window.__WB_MEM_TAB.tab) {
      cur = String(window.__WB_MEM_TAB.tab);
      window.__WB_MEM_TAB = null;
    }
  } catch (e) { /* 忽略 */ }

  /** 页签清单：固定那几节 + 文件里多出来的节（如阅读的「§三 阅读台账」）。 */
  function tabList() {
    var out = SECTIONS.slice();
    Object.keys(titles).forEach(function (k) {
      if (out.some(function (s) { return s.key === k; })) return;
      out.push({ key: k, name: titles[k] || k, hint: '这一节来自 项目信息.md' });
    });
    out.sort(function (a, b) {
      var ai = out.indexOf(a), bi = out.indexOf(b);
      var rank = ['§〇', '§一', '§二', '§三', '§四', '§五', '§六'];
      var ra = rank.indexOf(a.key), rb = rank.indexOf(b.key);
      if (ra >= 0 && rb >= 0) return ra - rb;
      return ai - bi;
    });
    return out;
  }

  function renderTabs() {
    tabs.innerHTML = '';
    tabList().forEach(function (s) {
      var b = wbEl('button', 'mem-tab' + (cur === s.key ? ' active' : ''), s.key + ' ' + s.name);
      b.title = s.hint;
      b.addEventListener('click', function () { cur = s.key; renderTabs(); renderBody(); });
      tabs.appendChild(b);
    });
    var card = wbEl('button', 'mem-tab' + (cur === '身份卡' ? ' active' : ''), '身份卡');
    card.addEventListener('click', function () { cur = '身份卡'; renderTabs(); renderBody(); });
    tabs.appendChild(card);
    // ★ 留痕页签：这个场景里发生过的一切（人 + 服务端 + AI）都在这条时间线上
    var log = wbEl('button', 'mem-tab' + (cur === '留痕' ? ' active' : ''), '留痕');
    log.title = '这个场景里发生过的一切：谁 · 做了什么 · 动了哪一样东西';
    log.addEventListener('click', function () { cur = '留痕'; renderTabs(); renderBody(); });
    tabs.appendChild(log);
    // 页签排成一行（窄面板里横向滚）⇒ 当前页签可能在可视范围外 ⇒ 滚进来
    var act = tabs.querySelector('.mem-tab.active');
    if (act && tabs.scrollWidth > tabs.clientWidth) {
      var l = act.offsetLeft, w = act.offsetWidth, sw = tabs.clientWidth;
      if (l < tabs.scrollLeft) tabs.scrollLeft = Math.max(0, l - 8);
      else if (l + w > tabs.scrollLeft + sw) tabs.scrollLeft = l + w - sw + 8;
    }
  }

  function renderBody() {
    editBox.innerHTML = '';
    // 「留痕」页签：不是可编辑的正文 ⇒ 只画时间线，不给保存按钮
    if (cur === '留痕') {
      var box = wbEl('div', 'act-box act-in-mem');
      editBox.appendChild(box);
      trail = wbActlogView(box, scene, function (n, sum) {
        acts.diag.textContent = n + ' 条 · 今 ' + ((sum && sum.today) || 0);
      });
      // 停留在这个页签时自己刷新（切走就停）
      if (trailTimer) { clearInterval(trailTimer); trailTimer = null; }
      trailTimer = setInterval(function () {
        if (cur !== '留痕') { clearInterval(trailTimer); trailTimer = null; return; }
        trail.refresh();
      }, 12000);
      return;
    }
    if (trailTimer) { clearInterval(trailTimer); trailTimer = null; }
    // ★ 自动区（派生内容）：只读，画在输入框上面 —— 它的内容是工作台按真实数据
    //   算出来的，人改不动（保存时服务端也会用磁盘上的原自动区盖回去）。
    (autos[cur] || []).forEach(function (b) {
      var box2 = wbEl('div', 'mem-auto');
      box2.appendChild(wbEl('div', 'mem-auto-tag', '自动 · 只读（按真实数据算的）'));
      var bd = wbEl('div', 'mem-auto-body');
      bd.appendChild(wbMdTable(b.content));
      box2.appendChild(bd);
      editBox.appendChild(box2);
    });
    var ta = wbEl('textarea', 'note-area');
    ta.value = textFor(cur);
    ta.spellcheck = false;
    ta.addEventListener('input', function () { drafts[cur] = ta.value; });
    editBox.appendChild(ta);

    var bar = wbEl('div', 'mem-bar');
    if (health) {
      var ok = !health.problems.length;
      bar.appendChild(wbEl('span', 'mem-size ' + (ok ? 'ok' : 'bad'),
        '§〇 ' + Math.round((health.sec0 || 0) / 1024 * 10) / 10 + 'K / 4K'
        + '　主文件 ' + Math.round((health.bytes || 0) / 1024 * 10) / 10 + 'K / 25K'));
      if (health.problems.length) bar.appendChild(wbEl('span', 'mem-prob', '⚠ ' + health.problems.join('；')));
    }
    // ⚠ 前端自己再数一遍（服务端那版要等引擎重启才生效）：
    //   文件里有两段 §〇 ⇒ 前面那段是死字，面板只认最后一段。
    if (dupNote) bar.appendChild(el('span', 'mem-prob', '⚠ ' + dupNote));
    var save = wbEl('button', 'panel-btn solid', '保存');
    save.addEventListener('click', function () {
      var key = cur;                       // 点保存时锁定是哪一节（别被切页签带跑）
      var body2 = { scene: scene, text: ta.value };
      if (key === '身份卡') body2.card = true; else body2.section = key;
      wbApi('POST', '/api/memory', body2).then(function (r) {
        if (r && r.ok) { health = r.health; delete drafts[key]; wbToast('已存'); load(); }
        else wbToast('没存成', true);
      });
    });
    bar.appendChild(save);
    editBox.appendChild(bar);
  }

  function load() {
    wbApi('GET', '/api/memory?scene=' + encodeURIComponent(scene)).then(function (r) {
      if (!r || !r.ok) return;
      health = r.health;
      var text = r.main || '';
      // ⚠ 有两段 §〇 ⇒ 前面那段是死字（面板只认最后一段）
      //   ⚠ 别用 \b：§〇 不是 ASCII 词字符，\b 在它后面不成立（会一个都匹配不到）。
      var dup = (text.match(/^##\s*§〇(?![〇一二三四五六七八九十])/gm) || []).length;
      dupNote = dup > 1 ? ('文件里有 ' + dup + ' 段 §〇（只有最后一段算数）· 修：node dev/去重交接.mjs') : '';
      secs = {};
      autos = {};
      titles = {};
      var re = /^##\s*(§[〇一二三四五六七八九十]+)\s*(.*)$/gm;
      var m, keys = [];
      while ((m = re.exec(text))) keys.push({ key: m[1], title: m[2], start: m.index, bodyStart: re.lastIndex });
      for (var i = 0; i < keys.length; i++) {
        var end = i + 1 < keys.length ? keys[i + 1].start : text.length;
        var raw = text.slice(keys[i].bodyStart, end);
        // ⚠ 只有**最后**一段同名节算数（前面那段是死字）—— 跟服务端一致。
        var sp = splitAuto(raw);
        secs[keys[i].key] = sp.manual;
        autos[keys[i].key] = sp.blocks;
        titles[keys[i].key] = keys[i].title;
      }
      cardText = r.card || '';
      renderTabs();
      renderBody();
    });
  }
  load();
  // 别的面板改了项目信息（如书架更新了阅读进度 ⇒ 服务端重算了自动区）
  //   ⇒ 这边重新拉一遍，别让人看着过期数据。
  function onMemChanged(e) {
    if (e && e.detail && e.detail.scene && e.detail.scene !== scene) return;
    load();
  }
  window.addEventListener('wb:mem-changed', onMemChanged);
  return function () {
    if (trailTimer) { clearInterval(trailTimer); trailTimer = null; }
    window.removeEventListener('wb:mem-changed', onMemChanged);
  };
};

/* ── 2b. note：便签（写在场景自己的 项目记忆/ 下） ───────────────── */
PANELS.note = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var scene = meta.scenario;
  var dir = '项目记忆';
  var file = meta.file || '便签.md';
  var ta = wbEl('textarea', 'note-area');
  ta.spellcheck = false;
  ta.placeholder = meta.placeholder || '随手记（存在这个场景的 项目记忆/ 下）';
  body.appendChild(ta);
  var dirty = false;
  ta.addEventListener('input', function () { dirty = true; acts.diag.textContent = '未保存'; });

  function load() {
    wbApi('GET', '/api/scratch?scene=' + encodeURIComponent(scene) + '&dir=' + encodeURIComponent(dir) + '&file=' + encodeURIComponent(file))
      .then(function (r) {
        ta.value = (r && r.text) || '';
        dirty = false;
        acts.diag.textContent = dirty ? '未保存' : '已存';
      });
  }
  function save() {
    wbApi('POST', '/api/scratch', { scene: scene, dir: dir, file: file, text: ta.value })
      .then(function (r) {
        dirty = false;
        acts.diag.textContent = (r && r.ok) ? '已存' : '没存成';
      });
  }
  wbHeadButton(head, '存', '保存到 ' + dir + '/' + file, save);
  var timer = setInterval(function () { if (dirty) save(); }, 4000);
  load();
  return function () { clearInterval(timer); if (dirty) save(); };
};

/* ── 3. todo：待办清单 ─────────────────────────────────────────── */
PANELS.todo = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var file = meta.file || '_待办.md';
  var list = wbEl('div', 'todo-list');
  var input = wbEl('input', 'todo-input');
  input.placeholder = '加一条，回车确认';
  body.appendChild(list);
  body.appendChild(input);

  var items = [];
  function render() {
    list.innerHTML = '';
    if (!items.length) {
      list.appendChild(wbEl('div', 'todo-empty', '还没有待办'));
      return;
    }
    items.forEach(function (it, i) {
      var row = wbEl('div', 'todo-row' + (it.done ? ' done' : ''));
      var box = wbEl('input', 'todo-box');
      box.type = 'checkbox';
      box.checked = !!it.done;
      box.addEventListener('change', function () { it.done = box.checked; save(); render(); });
      var txt = wbEl('span', 'todo-text', it.text);
      var del = wbEl('button', 'todo-del', '×');
      del.addEventListener('click', function () { items.splice(i, 1); save(); render(); });
      row.appendChild(box); row.appendChild(txt); row.appendChild(del);
      list.appendChild(row);
    });
  }
  function save() {
    var text = items.map(function (it) { return '- [' + (it.done ? 'x' : ' ') + '] ' + it.text; }).join('\n');
    return wbApi('POST', '/api/memory', { scene: meta.scenario, file: file, text: text })
      .then(function () { acts.diag.textContent = items.length + ' 条'; });
  }
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var v = input.value.trim();
    if (!v) return;
    items.push({ text: v, done: false });
    input.value = '';
    save(); render();
  });
  wbApi('GET', '/api/memory?scene=' + encodeURIComponent(meta.scenario) + '&file=' + encodeURIComponent(file))
    .then(function (r) {
      var t = (r && r.text) || '';
      items = t.split('\n').map(function (line) {
        var m = line.match(/^- \[( |x)\]\s*(.*)$/);
        return m ? { done: m[1] === 'x', text: m[2] } : null;
      }).filter(Boolean);
      render();
    });
  return function () { /* 无定时器 */ };
};

/* ── 4. links：网址清单 ─────────────────────────────────────────── */
PANELS.links = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var list = wbEl('div', 'links-list');
  body.appendChild(list);
  var links = Array.isArray(meta.links) ? meta.links : [];
  links.forEach(function (l) {
    var row = wbEl('div', 'links-row');
    var a = wbEl('a', 'links-a', l.title || l.url);
    a.href = l.url;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    row.appendChild(a);
    row.appendChild(wbEl('span', 'links-url', l.url));
    list.appendChild(row);
  });
  if (!links.length) list.appendChild(wbEl('div', 'todo-empty', '这个面板还没有网址（场景 json 里加 links 数组）'));
  acts.diag.textContent = links.length + ' 条';
  return function () { /* noop */ };
};

/* ── 5. file：文件浏览（限定在工作台目录内） ───────────────────── */
PANELS.file = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var root = meta.root || '.';
  var cur = root;
  var bar = wbEl('div', 'file-bar');
  var pathEl = wbEl('span', 'file-path', root);
  var list = wbEl('div', 'file-list');
  bar.appendChild(pathEl);
  body.appendChild(bar);
  body.appendChild(list);

  function refresh() {
    wbApi('GET', '/api/fs/list?dir=' + encodeURIComponent(cur)).then(function (r) {
      list.innerHTML = '';
      if (!r || !r.ok) { list.appendChild(wbEl('div', 'todo-empty', '读不了：' + (r && r.error || '未知'))); return; }
      pathEl.textContent = r.dir;
      acts.diag.textContent = r.rows.length + ' 项';
      r.rows.forEach(function (row) {
        var line = wbEl('div', 'file-row' + (row.isDir ? ' dir' : ''));
        line.appendChild(wbEl('span', 'file-name', row.name));
        if (!row.isDir) line.appendChild(wbEl('span', 'file-size', row.size + ' B'));
        line.addEventListener('click', function () {
          if (row.isDir) { cur = row.path; refresh(); }
          else preview(row);
        });
        list.appendChild(line);
      });
    });
  }
  function preview(row) {
    wbApi('GET', '/api/fs/read?path=' + encodeURIComponent(row.path)).then(function (r) {
      if (!r || !r.ok) { wbToast('读不了：' + (r && r.error), true); return; }
      var pre = wbEl('pre', 'file-preview', r.text);
      var old = body.querySelector('.file-preview');
      if (old) old.remove();
      body.appendChild(pre);
    });
  }
  refresh();
  return function () { /* noop */ };
};

/* ── 6. sessions：会话管理 + 一键钉到本场景 ────────────────────── */
PANELS.sessions = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var wrap = wbEl('div', 'sess-wrap');
  body.appendChild(wrap);

  var titleIn = wbEl('input', 'todo-input');
  titleIn.placeholder = '新会话标题';
  var mkBtn = wbEl('button', 'panel-btn solid', '新建会话');
  var mkRow = wbEl('div', 'todo-input-row');
  mkRow.appendChild(titleIn); mkRow.appendChild(mkBtn);
  wrap.appendChild(mkRow);

  var list = wbEl('div', 'sess-list');
  wrap.appendChild(list);

  function refresh() {
    wbApi('GET', '/api/sessions').then(function (r) {
      list.innerHTML = '';
      if (!r || !r.ok) {
        list.appendChild(wbEl('div', 'todo-empty', r && r.needAuth ? '引擎未认证 —— 去右上角「引擎」里连一下' : ('读不到会话：' + (r && r.error))));
        return;
      }
      var ss = r.sessions || [];
      acts.diag.textContent = ss.length + ' 条';
      ss.slice(0, 80).forEach(function (s) {
        var row = wbEl('div', 'sess-row');
        var main = wbEl('div', 'sess-main');
        main.appendChild(wbEl('div', 'sess-title', s.title || '（无标题）'));
        main.appendChild(wbEl('div', 'sess-sub', s.sessionId + (s.cwd ? '  ·  ' + s.cwd : '')));
        row.appendChild(main);
        if (meta.bind) {
          var bind = wbEl('button', 'panel-btn', '钉到本场景');
          bind.addEventListener('click', function () {
            wbApi('POST', '/api/scene/bind', {
              scene: meta.scenario, panelId: meta.id,
              sessionId: s.sessionId, title: s.title,
            }).then(function (res) {
              if (res && res.ok) { wbToast('已绑定到「' + meta.scenario + '」'); if (window.__wbReloadScene) window.__wbReloadScene(); }
              else wbToast('绑定失败：' + (res && res.error), true);
            });
          });
          row.appendChild(bind);
        }
        list.appendChild(row);
      });
    });
  }

  mkBtn.addEventListener('click', function () {
    var t = titleIn.value.trim();
    if (!t) { wbToast('先起个标题', true); return; }
    wbApi('POST', '/api/rpc', { method: 'session/create', args: { request: { cwd: meta.cwd || '' } } })
      .then(function (r) {
        if (!r || !r.ok || !r.value || !r.value.sessionId) { wbToast('建会话失败：' + JSON.stringify(r).slice(0, 200), true); return; }
        var id = r.value.sessionId;
        return wbApi('POST', '/api/rpc', { method: 'session/rename', args: { request: { sessionId: id, title: t } } })
          .then(function () {
            titleIn.value = '';
            wbToast('建好了：' + id);
            refresh();
          });
      });
  });

  refresh();
  var timer = setInterval(refresh, 15000);
  return function () { clearInterval(timer); };
};

/* ── 8. combo：组合面板（嵌套子面板） ──────────────────────────── */
PANELS.combo = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var grid = wbEl('div', 'combo-grid');
  body.appendChild(grid);
  var cleanups = [];
  var subs = Array.isArray(meta.subPanels) ? meta.subPanels : [];
  subs.forEach(function (sp) {
    var cell = wbEl('div', 'combo-cell');
    cell.style.gridColumn = (sp.col ? sp.col + ' / span ' : 'span ') + (sp.w || 1);
    cell.style.gridRow = (sp.row ? sp.row + ' / span ' : 'span ') + (sp.h || 1);
    var h = wbEl('div', 'combo-head', sp.title || sp.id);
    var b = wbEl('div', 'combo-body');
    b.dataset.kind = sp.type;
    cell.appendChild(h); cell.appendChild(b);
    grid.appendChild(cell);
    var fn = PANELS[sp.type];
    if (fn) {
      try {
        var c = fn(b, Object.assign({}, sp, { scenario: meta.scenario }), h);
        if (typeof c === 'function') cleanups.push(c);
      } catch (e) { b.appendChild(wbEl('div', 'todo-empty', '渲染失败：' + e.message)); }
    } else {
      b.appendChild(wbEl('div', 'todo-empty', '未知面板类型：' + sp.type));
    }
  });
  acts.diag.textContent = subs.length + ' 块';
  return function () { cleanups.forEach(function (c) { try { c(); } catch (e) { /* ignore */ } }); };
};

/* ── 9. reserved：占位面板 ──────────────────────────────────────── */
PANELS.reserved = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  body.appendChild(wbEl('div', 'todo-empty', meta.hint || '这块还没接上（预留位）'));
  acts.diag.textContent = '预留';
  return function () { /* noop */ };
};

/* ── 10. dispatch：派单台（真唤醒 + 回执闭环） ──────────────────── */
PANELS.dispatch = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var scene = meta.scenario;
  body.classList.add('disp-body');

  // ① 负载闸读数 —— ★ 判据只写一处，这里只显示结果
  var gateBox = wbEl('div', 'gate-box');
  var gateTxt = wbEl('div', 'gate-txt', '负载闸：测量中…');
  gateBox.appendChild(gateTxt);
  var gateBtn = wbEl('button', 'panel-btn', '⟳ 刷新');
  gateBtn.addEventListener('click', function () { loadGate(); });
  gateBox.appendChild(gateBtn);
  body.appendChild(gateBox);

  function loadGate() {
    gateTxt.textContent = '负载闸：测量中…';
    gateTxt.className = 'gate-txt';
    wbApi('GET', '/api/loadgate').then(function (r) {
      if (!r || !r.gate) { gateTxt.textContent = '负载闸：量不到'; return; }
      var g = r.gate;
      gateTxt.className = 'gate-txt ' + g.verdict;
      gateTxt.innerHTML = '';
      gateTxt.appendChild(wbEl('b', '', g.text));
      gateTxt.appendChild(wbEl('span', 'gate-detail',
        'CPU ' + (g.cpu != null ? g.cpu : '?') + '% · 内存 ' + (g.ram != null ? g.ram : '?') + '%'
        + (g.ramMode ? '（' + g.ramMode + '）' : '')
        + ' · 采样 ' + (g.samples || []).join('/') + '%'));
      if (g.verdict !== 'ok') {
        gateTxt.appendChild(wbEl('div', 'gate-warn',
          '⇒ 现在不派活：' + g.reason + '。机器接不了活的时候叫醒别的会话，只会让大家一起变慢。'));
      }
    });
  }
  loadGate();

  // ② 派单表单（四件套）
  var form = wbEl('div', 'disp-form');
  var sceneSel = wbEl('select', 'disp-input');
  var topicIn = wbEl('input', 'disp-input');
  topicIn.placeholder = '主题（同一主题 = 同一条线）';
  var symIn = wbEl('textarea', 'disp-area');
  symIn.placeholder = '① 现象：现在是什么样子（可观察的，不要形容词）';
  var howIn = wbEl('textarea', 'disp-area');
  howIn.placeholder = '② 照哪做：哪份文档的哪一节 / 哪个工具（唯一出处）';
  var verIn = wbEl('textarea', 'disp-area');
  verIn.placeholder = '③ 怎么验：做完跑哪个检查、看到什么算通过';
  var repIn = wbEl('textarea', 'disp-area');
  repIn.placeholder = '④ 回一句：明确要回执，并写「我在等你的回执」';

  form.appendChild(wbEl('label', 'disp-label', '发给谁'));
  form.appendChild(sceneSel);
  form.appendChild(wbEl('label', 'disp-label', '主题'));
  form.appendChild(topicIn);
  ['① 现象', '② 照哪做', '③ 怎么验', '④ 回一句'].forEach(function (t) { form.appendChild(wbEl('label', 'disp-label', t)); });
  form.appendChild(symIn); form.appendChild(howIn); form.appendChild(verIn); form.appendChild(repIn);

  var sendBtn = wbEl('button', 'panel-btn solid', '派单（真唤醒）');
  var msg = wbEl('div', 'disp-msg');
  var action = wbEl('div', 'disp-action');
  action.appendChild(sendBtn);
  action.appendChild(msg);
  form.appendChild(action);
  body.appendChild(form);

  wbApi('GET', '/api/scenes').then(function (r) {
    var list = (r && r.scenes) || [];
    list.forEach(function (s) {
      if (s.id === scene) return;
      var o = wbEl('option', '', s.name);
      o.value = s.id;
      sceneSel.appendChild(o);
    });
    if (!sceneSel.options.length) {
      var o = wbEl('option', '', '（没有别的场景）');
      o.value = '';
      sceneSel.appendChild(o);
    }
  });

  // 分诊面板点「派给 X」⇒ 这里自动填好「发给谁」和「主题」，你只管补四件套
  function onPrefill(e) {
    var d = e.detail || {};
    if (d.to) {
      for (var i = 0; i < sceneSel.options.length; i++) {
        if (sceneSel.options[i].value === d.to) { sceneSel.selectedIndex = i; break; }
      }
    }
    if (d.topic) topicIn.value = d.topic;
    symIn.focus();
  }
  window.addEventListener('wb:prefill', onPrefill);

  sendBtn.addEventListener('click', function () {
    msg.textContent = '';
    msg.className = 'disp-msg';
    sendBtn.disabled = true;
    wbApi('POST', '/api/dispatch', {
      from: scene, to: sceneSel.value,
      topic: topicIn.value, symptom: symIn.value,
      how: howIn.value, verify: verIn.value, reply: repIn.value,
    }).then(function (r) {
      sendBtn.disabled = false;
      if (r && r.ok) {
        msg.className = 'disp-msg ok';
        msg.textContent = '✓ 已派单（' + (r.rec && r.rec.delivered) + '）· 编号 ' + r.hash;
        (r.warnings || []).forEach(function (w) { msg.textContent += '  ⚠ ' + w; });
        topicIn.value = ''; symIn.value = ''; howIn.value = ''; verIn.value = ''; repIn.value = '';
        refresh();
      } else {
        msg.className = 'disp-msg bad';
        msg.textContent = '✗ ' + ((r && r.errors && r.errors.join('\n')) || (r && r.error) || '发不出去');
      }
    }).catch(function (e) {
      sendBtn.disabled = false;
      msg.className = 'disp-msg bad';
      msg.textContent = '✗ ' + e.message;
    });
  });

  // ③ 台账 + 两个查询
  var ledger = wbEl('div', 'disp-ledger');
  body.appendChild(ledger);

  function lineRow(l, kind) {
    var row = wbEl('div', 'line-row ' + kind);
    var main = wbEl('div', 'line-main');
    main.appendChild(wbEl('div', 'line-topic', l.topic + '  →  ' + l.to));
    main.appendChild(wbEl('div', 'line-sub',
      l.hash + ' · ' + l.at + ' · ' + l.kind + ' · ' + l.count + ' 条'
      + (l.state === '未回执' ? ' · ⏰ 超时未回执' : '')));
    if (l.ack) {
      main.appendChild(wbEl('div', 'line-ack', '✓ ' + (l.ack.conclusion || '已回执')
        + (l.ack.evidence ? '  ｜ 证据：' + l.ack.evidence : '')));
    }
    row.appendChild(main);
    var acts2 = wbEl('div', 'line-acts');
    if (kind === 'waiting') {
      var ackBtn = wbEl('button', 'panel-btn', '回执');
      ackBtn.addEventListener('click', function () { openAck(l); });
      acts2.appendChild(ackBtn);
    }
    if (!l.closed && l.state !== '已销账') {
      var cl = wbEl('button', 'panel-btn', '收尾知悉');
      cl.addEventListener('click', function () {
        wbApi('POST', '/api/dispatch/close', { hash: l.hash, from: scene }).then(function (r) {
          if (r && r.ok) { wbToast('已销账'); refresh(); }
          else wbToast((r && r.error) || '销账失败', true);
        });
      });
      acts2.appendChild(cl);
    }
    row.appendChild(acts2);
    return row;
  }

  function openAck(l) {
    var c = wbEl('input', 'disp-input');
    c.placeholder = '结论：一句话';
    var e = wbEl('textarea', 'disp-area');
    e.placeholder = '证据：跑了什么 / 几个通过 / 差异集合';
    var pth = wbEl('input', 'disp-input');
    pth.placeholder = '落盘：改了哪些文件';
    var box = wbEl('div', 'ack-box');
    box.appendChild(c); box.appendChild(e); box.appendChild(pth);
    var ok = wbEl('button', 'panel-btn solid', '投递回执');
    box.appendChild(ok);
    var err = wbEl('div', 'disp-msg');
    box.appendChild(err);
    ok.addEventListener('click', function () {
      wbApi('POST', '/api/dispatch/ack', {
        hash: l.hash, conclusion: c.value, evidence: e.value, path: pth.value,
      }).then(function (r) {
        if (r && r.ok) { box.remove(); wbToast('回执已投递'); refresh(); }
        else err.textContent = '✗ ' + (r && r.error);
      });
    });
    ledger.appendChild(box);
  }

  function refresh() {
    wbApi('GET', '/api/dispatch?scene=' + encodeURIComponent(scene)).then(function (r) {
      if (!r || !r.ok) return;
      ledger.innerHTML = '';
      ledger.appendChild(wbEl('div', 'ledger-h', '我发出还没人回的（' + r.mine.length + '）'));
      if (!r.mine.length) ledger.appendChild(wbEl('div', 'todo-empty', '没有'));
      r.mine.forEach(function (l) { ledger.appendChild(lineRow(l, 'mine')); });

      ledger.appendChild(wbEl('div', 'ledger-h', '别人在等我回的（' + r.waiting.length + '）'));
      if (!r.waiting.length) ledger.appendChild(wbEl('div', 'todo-empty', '没有'));
      r.waiting.forEach(function (l) { ledger.appendChild(lineRow(l, 'waiting')); });

      var un = (r.unacked || []).filter(function (l) { return l.from === scene; });
      if (un.length) {
        ledger.appendChild(wbEl('div', 'ledger-h bad', '未回执（超时了，' + un.length + '）'));
        un.forEach(function (l) { ledger.appendChild(lineRow(l, 'unacked')); });
      }

      var done = (r.all || []).filter(function (l) { return l.state === '已回执' || l.state === '已销账'; });
      ledger.appendChild(wbEl('div', 'ledger-h', '已销账（' + done.length + '）'));
      done.slice(0, 8).forEach(function (l) { ledger.appendChild(lineRow(l, 'done')); });
      acts.diag.textContent = '待回 ' + r.mine.length + ' · 等我 ' + r.waiting.length;
    });
  }
  refresh();
  var timer = setInterval(refresh, 6000);
  return function () { clearInterval(timer); window.removeEventListener('wb:prefill', onPrefill); };
};

/* ── 11. gputriage：三类活分流 ────────────────────────────────── */
PANELS.gputriage = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  body.classList.add('disp-body');

  var taskIn = wbEl('textarea', 'disp-area');
  taskIn.placeholder = '这个活是什么？（一句话描述）';
  body.appendChild(taskIn);

  var kindSel = wbEl('select', 'disp-input');
  [['ocr', 'OCR（文字识别）'], ['video', '视频编码'], ['render', '三维渲染'],
   ['llm', '大模型推理 / 对话'], ['image', 'AI 生图（云端）'], ['other', '其它 / 说不清']]
    .forEach(function (kv) {
      var o = wbEl('option', '', kv[1]); o.value = kv[0]; kindSel.appendChild(o);
    });
  body.appendChild(kindSel);

  var go = wbEl('button', 'panel-btn solid', '判定该不该上 GPU');
  body.appendChild(go);
  var out = wbEl('div', 'gpu-out');
  body.appendChild(out);

  function show(r) {
    out.innerHTML = '';
    var v = r.verdict;
    out.appendChild(wbEl('div', 'gpu-verdict ' + (v.useGpu ? 'yes' : 'no'),
      (v.useGpu ? '✓ 上 GPU' : '⛔ 不上 GPU') + '  ·  ' + v.label));
    out.appendChild(wbEl('div', 'gpu-why', v.why));
    out.appendChild(wbEl('div', 'gpu-path',
      '路径：' + (v.path === 'gpu' ? 'GPU' : v.path === 'remote-api' ? '远端 API（本地 GPU 不参与）' : 'CPU')));
    if (v.params && v.params.processes) {
      var p = v.params;
      out.appendChild(wbEl('div', 'gpu-cpu',
        '退 CPU 三约束：单进程 ' + p.processes
        + ' · 线程 ' + (p.env.OMP_NUM_THREADS) + '（OMP/MKL）'
        + ' · 优先级 ' + p.priority));
      out.appendChild(wbEl('div', 'gpu-note', p.note));
    }
    if (r.probe) {
      out.appendChild(wbEl('div', 'gpu-probe',
        '本机：' + (r.probe.available ? (r.probe.vendor + ' ' + r.probe.name) : '探测不到 GPU')
        + ' · providers ' + (r.probe.providers.join(', ') || '（无）')
        + ' · 编码器 ' + (r.probe.encoders.join(', ') || '（无）')));
      (r.probe.notes || []).forEach(function (n) { out.appendChild(wbEl('div', 'gpu-note', '· ' + n)); });
    }
    var acc = r.acceptance;
    out.appendChild(wbEl('div', 'gpu-acc-h', '验收三条（缺一不算「真的用上 GPU」）'));
    acc.checks.forEach(function (c) {
      out.appendChild(wbEl('div', 'gpu-acc ' + (c.ok ? 'ok' : 'no'),
        (c.ok ? '✓' : '✗') + ' ' + c.name + ' — ' + c.detail));
    });
    acts.diag.textContent = (v.useGpu ? 'GPU' : 'CPU') + ' · ' + acc.okCount + '/3';
  }

  go.addEventListener('click', function () {
    go.disabled = true;
    out.textContent = '判定中…';
    wbApi('POST', '/api/gpu/verdict', { task: taskIn.value, kind: kindSel.value }).then(function (r) {
      go.disabled = false;
      if (r && r.ok) show(r); else out.textContent = '✗ ' + (r && r.error);
    }).catch(function (e) { go.disabled = false; out.textContent = '✗ ' + e.message; });
  });

  var g = wbEl('div', 'gate-box');
  var gt = wbEl('div', 'gate-txt', '负载闸：测量中…');
  g.appendChild(gt);
  body.appendChild(g);
  wbApi('GET', '/api/loadgate?fast=1').then(function (r) {
    if (!r || !r.gate) { gt.textContent = '负载闸：量不到'; return; }
    gt.className = 'gate-txt ' + r.gate.verdict;
    gt.textContent = r.gate.text + '（CPU ' + r.gate.cpu + '% · 内存 ' + r.gate.ram + '%）';
  });

  return function () { /* noop */ };
};

/* ── 12. triage：分诊出口（唯一对口可执行） ────────────────────── */
PANELS.triage = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var scene = meta.scenario;
  var box = wbEl('div', 'triage-box');
  body.appendChild(box);

  var addIn = wbEl('input', 'disp-input');
  addIn.placeholder = '加一条待办（可写 @场景名 指定归属）';
  var addBtn = wbEl('button', 'panel-btn', '加');
  var addRow = wbEl('div', 'todo-input-row');
  addRow.appendChild(addIn); addRow.appendChild(addBtn);
  body.appendChild(addRow);
  addBtn.addEventListener('click', function () {
    var v = addIn.value.trim();
    if (!v) return;
    var m = v.match(/@(\S+)/);
    wbApi('POST', '/api/todo', {
      action: 'add',
      text: v.replace(/@(\S+)/, '').trim(),
      owner: m ? m[1] : '',
    }).then(function () { addIn.value = ''; refresh(); });
  });

  /** 把「派单给 X」预填到派单台面板。 */
  function prefill(suggestion, text) {
    var ev = new CustomEvent('wb:prefill', {
      detail: { to: suggestion ? suggestion.scene : '', topic: text },
    });
    window.dispatchEvent(ev);
    wbToast('已预填派单台 —— 去那边补齐四件套再发');
  }

  function itemRow(it, unowned) {
    var row = wbEl('div', 'triage-row' + (unowned ? '' : ' owned'));
    row.appendChild(wbEl('div', 'triage-kind', it.source));
    row.appendChild(wbEl('div', 'triage-text', it.text));
    if (it.detail) row.appendChild(wbEl('div', 'triage-detail', it.detail));

    if (it.suggestion) {
      var sug = wbEl('div', 'triage-sug');
      sug.appendChild(wbEl('span', 'sug-label', '唯一对口 ⇒ 建议 '));
      sug.appendChild(wbEl('b', '', it.suggestion.sceneName));
      sug.appendChild(wbEl('span', 'sug-why', '（' + it.suggestion.topic + '｜命中：' + it.suggestion.matched.join('、') + '）'));
      row.appendChild(sug);
    } else if (unowned) {
      row.appendChild(wbEl('div', 'triage-sug none',
        '没有对口场景 ⇒ **问机主一句**（拿不准就别猜着办）'));
    }
    if (it.overlap) {
      row.appendChild(wbEl('div', 'triage-detail', '重叠判据：' + it.overlap.advice));
    }

    var opts = wbEl('div', 'triage-opts');
    if (unowned) {
      // 无主：派单 / 我自己做 / 问机主 —— 原文的三种出口
      if (it.suggestion) {
        var d1 = wbEl('button', 'panel-btn solid', '派给 ' + it.suggestion.sceneName);
        d1.addEventListener('click', function () { prefill(it.suggestion, it.text); });
        opts.appendChild(d1);
      }
      var d2 = wbEl('button', 'panel-btn', '我自己做');
      d2.addEventListener('click', function () {
        wbApi('POST', '/api/dispatch/claim', { scene: scene, text: it.text, note: '分诊判定：自己接手' })
          .then(function (r) {
            if (r && r.ok) { wbToast('已认领，台账落了一行'); refresh(); }
            else wbToast((r && r.error) || '认领失败', true);
          });
      });
      opts.appendChild(d2);
      var d3 = wbEl('button', 'panel-btn', '问机主');
      d3.addEventListener('click', function () { wbToast('这条要问机主 —— 拿不准就别猜着办'); });
      opts.appendChild(d3);
    } else if (it.source === '台账未办结') {
      // 有主但没办结：催 / 改派 / 问机主
      var c1 = wbEl('button', 'panel-btn', '催一次');
      c1.addEventListener('click', function () {
        wbToast('催之前先看台账：同一件事 ≤3 条，别催成客套');
      });
      opts.appendChild(c1);
      var c2 = wbEl('button', 'panel-btn', '问机主');
      c2.addEventListener('click', function () { wbToast('这条要问机主 —— 拿不准就别猜着办'); });
      opts.appendChild(c2);
    }
    row.appendChild(opts);
    return row;
  }

  function refresh() {
    wbApi('GET', '/api/dispatch/triage?scene=' + encodeURIComponent(scene)).then(function (r) {
      if (!r || !r.ok) return;
      var t = r.triage;
      box.innerHTML = '';

      box.appendChild(wbEl('div', 'ledger-h',
        '无主（' + t.counts.unowned + '）—— 挂着却没有归属 ⇒ 不许当没看见'));
      if (!t.unowned.length) box.appendChild(wbEl('div', 'todo-empty', '没有无主的活 ✓'));
      t.unowned.forEach(function (it) { box.appendChild(itemRow(it, true)); });

      box.appendChild(wbEl('div', 'ledger-h',
        '有主（' + t.counts.owned + '）' + (t.counts.overdue ? '　其中超时 ' + t.counts.overdue + ' 条' : '')));
      if (!t.owned.length) box.appendChild(wbEl('div', 'todo-empty', '没有'));
      t.owned.slice(0, 20).forEach(function (it) { box.appendChild(itemRow(it, false)); });

      acts.diag.textContent = '无主 ' + t.counts.unowned + ' · 有主 ' + t.counts.owned;
    });
  }
  refresh();
  var timer = setInterval(refresh, 8000);
  return function () { clearInterval(timer); };
};

/* ── 13. authority：修改权分档（地盘表 + 越界审计） ─────────────── */
PANELS.authority = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var scene = meta.scenario;
  body.classList.add('disp-body');

  var box = wbEl('div', 'auth-box');
  body.appendChild(box);

  function renderTiers(tiers) {
    var t = wbEl('div', 'auth-tiers');
    Object.keys(tiers).forEach(function (k) {
      var row = wbEl('div', 'auth-tier tier-' + k);
      row.appendChild(wbEl('div', 'auth-tier-head', k + '  ' + tiers[k].label));
      row.appendChild(wbEl('div', 'auth-tier-scope', '范围：' + tiers[k].scope));
      row.appendChild(wbEl('div', 'auth-tier-who', '谁能改：' + tiers[k].who));
      row.appendChild(wbEl('div', 'auth-tier-breach', '越界后果：' + tiers[k].breach));
      t.appendChild(row);
    });
    box.appendChild(t);
  }

  function renderTerritory(ter) {
    var h = wbEl('div', 'ledger-h', '地盘表（规则负责人：' + (ter.ruleOwner || '?') + '）');
    box.appendChild(h);
    var names = Object.keys(ter.scenes || {});
    names.forEach(function (id) {
      var s = ter.scenes[id];
      var row = wbEl('div', 'terr-row' + (id === scene ? ' mine' : ''));
      row.appendChild(wbEl('div', 'terr-name', s.name + (id === scene ? '（我）' : '')));
      row.appendChild(wbEl('div', 'terr-line', '地盘：' + (s.territory || []).join('、')));
      row.appendChild(wbEl('div', 'terr-line', '不碰：' + (s.notTouch || []).join('、')));
      row.appendChild(wbEl('div', 'terr-line', '写回：' + (s.writeBack || '—') + '　职责：' + (s.duty || '')));
      box.appendChild(row);
    });

    if ((ter.soleResponsibility || []).length) {
      box.appendChild(wbEl('div', 'ledger-h', '唯一对口'));
      ter.soleResponsibility.forEach(function (r) {
        box.appendChild(wbEl('div', 'terr-line sole', r.topic + ' → ' + r.scene + '　（' + (r.note || '') + '）'));
      });
    }
  }

  function renderAudit(rep) {
    box.appendChild(wbEl('div', 'ledger-h', '越界审计（扫了 ' + rep.scanned + ' 个场景会话）'));
    if (!rep.violations.length) {
      box.appendChild(wbEl('div', 'audit-ok', '✓ 没有越界。' + rep.touches.length + ' 次写入，全部在各自的地盘里。'));
    } else {
      rep.violations.forEach(function (v) {
        var row = wbEl('div', 'audit-bad');
        row.appendChild(wbEl('div', 'audit-line', '⛔ [' + v.tier + ' 档] ' + v.scene + ' 动了 ' + v.path));
        row.appendChild(wbEl('div', 'audit-why', v.why));
        box.appendChild(row);
      });
    }
    acts.diag.textContent = rep.violations.length ? '越界 ' + rep.violations.length + ' 次' : '干净';
  }

  function load() {
    box.innerHTML = '';
    wbApi('GET', '/api/authority').then(function (r) {
      if (!r || !r.ok) { box.appendChild(wbEl('div', 'todo-empty', '读不到地盘表')); return; }
      box.appendChild(wbEl('div', 'ledger-h', '五档'));
      renderTiers(r.tiers);
      renderTerritory(r.territory);
    });
    wbApi('GET', '/api/authority/audit').then(function (r) {
      if (r && r.ok) renderAudit(r.report);
    });
    wbApi('GET', '/api/writes').then(function (r) {
      if (r && r.ok) renderWrites(r);
    });
  }

  function renderWrites(r) {
    var h = r.history || {};
    var cols = h.collisions || [];
    box.appendChild(wbEl('div', 'ledger-h',
      '写痕与撞车（写了 ' + (h.files || []).length + ' 个文件 · 撞车 ' + cols.length + ' 次）'));
    if (!cols.length) {
      box.appendChild(wbEl('div', 'audit-ok', '✓ 没有同一文件两个写入者。'));
    } else {
      cols.slice(0, 6).forEach(function (c) {
        var row = wbEl('div', 'audit-bad');
        row.appendChild(wbEl('div', 'audit-line',
          (c.lostCount ? '⛔ 改动神秘消失：' : '⚠ 同路径两个写入者：')
          + c.byName + ' → ' + c.overName));
        row.appendChild(wbEl('div', 'audit-why',
          c.path + '（间隔 ' + (c.gapMin != null ? c.gapMin + ' 分钟' : '?') + '）'
          + (c.lostCount ? '　丢了 ' + c.lostCount + ' 行：' + c.samples.join(' / ') : '')));
        box.appendChild(row);
      });
    }
    var claims = r.claims || [];
    if (claims.length) {
      box.appendChild(wbEl('div', 'ledger-h', '写入权（一个文件同时只留一个写入者）'));
      claims.forEach(function (c) {
        box.appendChild(wbEl('div', 'terr-line',
          c.path + '　→　' + c.scene + (c.expired ? '（已过期）' : '（持有中）')));
      });
    }
    acts.diag.textContent = (acts.diag.textContent || '') + ' · 撞车 ' + cols.length;
  }

  load();
  var timer = setInterval(load, 15000);
  wbHeadButton(head, '⟳', '重跑审计', load);
  return function () { clearInterval(timer); };
};

/* ── 18. project：项目目录 ─────────────────────────────────────────
 * 把**真实磁盘上的一个文件夹**挂到这个角色上：
 *   · 绑了之后，这个角色的 AI 会话可以以它为工作目录（cwd）⇒ 让 AI 直接写代码
 *   · 文件面板能浏览它
 *   · 它登记成这个角色的地盘 ⇒ 别的角色碰它就是越界（E 档）
 */
PANELS.project = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var sceneId = meta.scene || (meta.scenario || '');
  var wrap = wbEl('div', 'proj-box');
  body.appendChild(wrap);

  var headRow = wbEl('div', 'proj-row');
  var cur = wbEl('div', 'proj-cur', '读取中…');
  headRow.appendChild(cur);
  wrap.appendChild(headRow);

  var form = wbEl('div', 'proj-form');
  var input = wbEl('input', 'proj-input');
  input.placeholder = '项目目录（绝对路径，如 /Users/你/Projects/my-app）';
  form.appendChild(input);
  var bind = wbEl('button', 'chip solid', '绑定');
  form.appendChild(bind);
  var unbind = wbEl('button', 'chip', '解绑');
  form.appendChild(unbind);
  wrap.appendChild(form);

  var acts2 = wbEl('div', 'proj-row');
  var mkSession = wbEl('button', 'chip', '用这个目录开一条会话');
  acts2.appendChild(mkSession);
  var hint = wbEl('span', 'proj-hint', '');
  acts2.appendChild(hint);
  wrap.appendChild(acts2);

  /* ── 文件树（VS Code 那种：文件夹能展开、能新建） ─────────────── */
  var tools = wbEl('div', 'proj-tools');
  var mkDir = wbEl('button', 'chip', '＋ 新建文件夹');
  var mkFile = wbEl('button', 'chip', '＋ 新建文件');
  var refresh = wbEl('button', 'chip', '⟳ 刷新');
  tools.appendChild(mkDir);
  tools.appendChild(mkFile);
  tools.appendChild(refresh);
  var selTip = wbEl('span', 'proj-hint', '');
  tools.appendChild(selTip);
  wrap.appendChild(tools);

  /* ── 面包屑 + 搜索（深目录一层层点太费劲 ⇒ 加这两个） ────────── */
  var crumb = wbEl('div', 'proj-crumb');
  var searchBox = wbEl('div', 'proj-search');
  var searchInput = wbEl('input', 'ft-search');
  searchInput.type = 'search';
  searchInput.placeholder = '搜文件名（整个项目底下）';
  var searchRes = wbEl('div', 'proj-search-res');
  searchBox.appendChild(searchInput);
  searchBox.appendChild(searchRes);

  var list = wbEl('div', 'proj-list ftree');
  wrap.appendChild(crumb);
  wrap.appendChild(searchBox);
  wrap.appendChild(list);

  /* ── 上传：把文件拖进来，或点按钮选 ─────────────────────────── */
  var up = wbEl('div', 'up-box');
  var drop = wbEl('div', 'up-drop');
  drop.textContent = '把文件拖到这里，或点下面选';
  up.appendChild(drop);
  var pick = wbEl('button', 'chip', '选择文件');
  up.appendChild(pick);
  var pickDir = wbEl('button', 'chip', '选择文件夹');
  up.appendChild(pickDir);
  var upNote = wbEl('div', 'up-note', '');
  up.appendChild(upNote);
  var inputEl = wbEl('input');
  inputEl.type = 'file';
  inputEl.multiple = true;
  inputEl.style.display = 'none';
  up.appendChild(inputEl);
  var dirEl = wbEl('input');
  dirEl.type = 'file';
  dirEl.multiple = true;
  dirEl.webkitdirectory = true;      // 选整个文件夹
  dirEl.style.display = 'none';
  up.appendChild(dirEl);
  wrap.appendChild(up);

  var root = '';

  function uploadFiles(files) {
    if (!files || !files.length) return;
    var list2 = Array.prototype.slice.call(files);
    upNote.textContent = '正在传 ' + list2.length + ' 个文件…';
    var done = 0, failed = 0;
    list2.forEach(function (f) {
      // 选文件夹时，webkitRelativePath 带着目录结构 ⇒ 保留它
      var rel = f.webkitRelativePath || '';
      var dir = '';
      var fname = f.name;
      if (rel) {
        var cut = rel.lastIndexOf('/');
        if (cut > 0) { dir = rel.slice(0, cut); fname = rel.slice(cut + 1); }
      }
      // 落到「选中的那个文件夹」里（相对基准目录）
      var into = relToBase(uploadTarget || selected || treeRoot);
      if (into) dir = into + (dir ? '/' + dir : '');
      var q = '?scene=' + encodeURIComponent(sceneId)
        + '&name=' + encodeURIComponent(fname)
        + (dir ? '&dir=' + encodeURIComponent(dir) : '');
      fetch(wbBase() + '/api/upload' + q, { method: 'POST', body: f })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok) done++; else failed++;
          var msg = res.ok ? '✓ ' + f.name : '✗ ' + f.name + '：' + (res.j && res.j.error || '失败');
          upNote.textContent = msg + '（' + (done + failed) + '/' + list2.length + '）';
          if (failed) upNote.className = 'up-note bad';
          if (done + failed === list2.length) {
            upNote.textContent = '传完：成功 ' + done + ' 个' + (failed ? '，失败 ' + failed + ' 个' : '');
            if (!failed) wbToast('传完了：' + done + ' 个文件');
            load();
          }
        })
        .catch(function (e) {
          failed++;
          upNote.textContent = '✗ ' + f.name + '：' + (e && e.message || e);
        });
    });
  }

  drop.addEventListener('dragover', function (e) {
    e.preventDefault(); e.stopPropagation();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
  drop.addEventListener('drop', function (e) {
    e.preventDefault(); e.stopPropagation();
    drop.classList.remove('over');
    uploadFiles(e.dataTransfer && e.dataTransfer.files);
  });
  pick.addEventListener('click', function () { inputEl.click(); });
  inputEl.addEventListener('change', function () {
    uploadFiles(inputEl.files);
    inputEl.value = '';
  });
  pickDir.addEventListener('click', function () { dirEl.click(); });
  dirEl.addEventListener('change', function () {
    uploadFiles(dirEl.files);
    dirEl.value = '';
  });

  /* ── 树：加载 / 展开 / 新建 ─────────────────────────────────── */
  var base = '';          // 上传和新建的基准目录（项目目录，或它的项目记忆目录）
  var treeRoot = '';      // 树根目录（= base；没绑项目目录时就是项目记忆目录）
  var selected = '';      // 当前选中的文件夹（新建的东西放这儿）
  var rowsByPath = {};    // 路径 → 行元素（要往某个文件夹里塞东西时找得到它的容器）
  var uploadTarget = '';  // 上传落到哪个文件夹

  function sizeText(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' K';
    return (n / 1024 / 1024).toFixed(1) + ' M';
  }

  /** 绝对路径 → 相对基准目录（上传接口只收相对路径）。 */
  function relToBase(abs) {
    if (!abs || !base) return '';
    if (abs === base) return '';
    if (abs.indexOf(base + '/') === 0) return abs.slice(base.length + 1);
    return '';
  }

  /** 选中一个文件夹（新建 / 上传的落点）。 */
  function selectDir(p) {
    selected = p || '';
    Object.keys(rowsByPath).forEach(function (k) {
      rowsByPath[k].classList.toggle('sel', k === selected);
    });
    selTip.textContent = !selected ? '' : (selected === treeRoot ? '落点：根目录' : '落点：' + selected);
    renderCrumb();
  }

  /** 面包屑：当前树根 + 选中的目录。
   *  点一段 ⇒ 以它为根重新看（比一层层点开快）。 */
  function renderCrumb() {
    if (!crumb) return;
    crumb.innerHTML = '';
    var cur = selected || treeRoot || '';
    var segs = cur.split('/').filter(Boolean);
    var baseSegs = (base || '').split('/').filter(Boolean);
    // 项目目录之前的那几段没意义（都是 /Users/…），不显示
    var start = 0;
    for (var i = 0; i < baseSegs.length; i++) {
      if (segs[i] === baseSegs[i]) start = i + 1; else break;
    }
    crumb.appendChild(wbEl('span', 'crumb-sep', '／'));
    if (!segs.length) {
      crumb.appendChild(wbEl('span', 'crumb-dim', '（还没绑目录）'));
      return;
    }
    var acc = '';
    segs.forEach(function (seg, i) {
      acc += '/' + seg;
      var inBase = i < start;
      var b = wbEl('button', 'crumb' + (i === segs.length - 1 ? ' on' : ''), seg);
      b.title = acc + (inBase ? '（项目目录）' : '');
      b.addEventListener('click', function () {
        if (inBase) { load(); return; }      // 回到项目目录根
        loadTree(acc);                       // 以它为根看
      });
      crumb.appendChild(b);
    });
  }

  /** 按文件名搜（整个项目底下）。命中目录 ⇒ 以它为根看；命中文件 ⇒ 预览。 */
  var searchTimer = null;
  function runSearch() {
    var kw = searchInput.value.trim();
    searchRes.innerHTML = '';
    if (!kw) return;
    var scope = treeRoot || base;
    if (!scope) return;
    wbApi('GET', '/api/fs/search?dir=' + encodeURIComponent(scope) + '&q=' + encodeURIComponent(kw))
      .then(function (r) {
        searchRes.innerHTML = '';
        if (!r || !r.ok) {
          searchRes.appendChild(wbEl('div', 'ftree-empty', '搜不了：' + (r && r.error || '未知')));
          return;
        }
        if (!r.rows.length) {
          searchRes.appendChild(wbEl('div', 'ftree-empty', '没找到「' + kw + '」'));
          return;
        }
        r.rows.forEach(function (n) {
          var row = wbEl('div', 'ftree-row is-file ftree-hit');
          row.appendChild(wbEl('span', 'ftree-chev', ''));
          row.appendChild(wbEl('span', 'ftree-icon', n.isDir ? '📁' : '📄'));
          row.appendChild(wbEl('span', 'ftree-name', n.rel || n.name));
          row.title = n.path;
          row.addEventListener('click', function () {
            if (n.isDir) loadTree(n.path);
            else previewFile(n.path, n.name);
          });
          searchRes.appendChild(row);
        });
        if (r.truncated) searchRes.appendChild(wbEl('div', 'ftree-empty', '（结果太多，只列了前面一部分）'));
      });
  }
  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });

  /** 某个文件夹的「子项容器」（根目录的就是列表本身）。 */
  function kidsOf(dir) {
    if (!dir || dir === treeRoot) return list;
    var row = rowsByPath[dir];
    return row ? row.__kids : null;
  }

  /** 画一行（文件夹 / 文件）。 */
  function nodeEl(n, depth) {
    var node = wbEl('div', 'ftree-node');
    var row = wbEl('div', 'ftree-row ' + (n.isDir ? 'is-dir' : 'is-file'));
    row.setAttribute('data-path', n.path);
    row.setAttribute('data-name', n.name);
    row.style.paddingLeft = (8 + depth * 15) + 'px';

    var chev = wbEl('span', 'ftree-chev', n.isDir ? '▸' : '');
    row.appendChild(chev);
    var icon = wbEl('span', 'ftree-icon', n.isDir ? '📁' : '📄');
    row.appendChild(icon);
    row.appendChild(wbEl('span', 'ftree-name', n.name));
    if (!n.isDir) row.appendChild(wbEl('span', 'ftree-size', sizeText(n.size)));

    node.appendChild(row);

    if (n.isDir) {
      var kids = wbEl('div', 'ftree-kids');
      kids.style.display = 'none';
      kids.__dir = n.path;
      kids.__depth = depth + 1;
      node.appendChild(kids);

      row.__kids = kids;
      row.__open = false;
      row.__loaded = false;
      rowsByPath[n.path] = row;
      kids.__row = row;

      chev.addEventListener('click', function (e) {
        e.stopPropagation();
        selectDir(n.path);
        toggle(row);
      });
      row.addEventListener('click', function () {
        selectDir(n.path);
        toggle(row);
      });
      // 右键：这个文件夹里能干什么
      wbBindMenu(row, [
        { id: 'mkdir', label: '新建文件夹…' },
        { id: 'mkfile', label: '新建文件…' },
        { id: 'upload', label: '上传文件到此处…' },
        { separator: true },
        { id: 'session', label: '在这里开一条会话' },
      ], function (id) {
        selectDir(n.path);
        if (id === 'mkdir') startCreate(n.path, kids, 'dir');
        else if (id === 'mkfile') startCreate(n.path, kids, 'file');
        else if (id === 'upload') { uploadTarget = n.path; inputEl.click(); }
        else if (id === 'session') openSession(n.path);
      });
    } else {
      row.addEventListener('click', function () { previewFile(n.path, n.name); });
    }
    return node;
  }

  /** 展开 / 收起一个文件夹（没加载过就先拉一层）。 */
  function toggle(row) {
    var kids = row.__kids;
    if (!kids) return;
    var chev = row.querySelector('.ftree-chev');
    var icon = row.querySelector('.ftree-icon');
    if (row.__open) {
      row.__open = false;
      kids.style.display = 'none';
      chev.textContent = '▸';
      icon.textContent = '📁';
      return;
    }
    row.__open = true;
    kids.style.display = '';
    chev.textContent = '▾';
    icon.textContent = '📂';
    if (row.__loaded) return;
    row.__loaded = true;
    var p = row.getAttribute('data-path');
    wbApi('GET', '/api/fs/tree?dir=' + encodeURIComponent(p) + '&depth=1').then(function (r) {
      row.__loaded = false;                       // 失败了下次还能重试
      if (!r || !r.ok) {
        kids.appendChild(wbEl('div', 'ftree-empty', '读不了：' + (r && r.error || '未知')));
        return;
      }
      fillKids(kids, r.rows);
    });
  }

  /** 把一个目录下的内容画进容器。 */
  function fillKids(container, rows) {
    container.innerHTML = '';
    var depth = container.__depth || 0;
    if (!rows || !rows.length) {
      container.appendChild(wbEl('div', 'ftree-empty', '（空）'));
      return;
    }
    rows.forEach(function (n) { container.appendChild(nodeEl(n, depth)); });
  }

  /** 重新拉一个目录的内容（建完东西后刷新那一块）。 */
  function refreshKids(container) {
    var dir = container && container.__dir;
    if (!dir) return;
    wbApi('GET', '/api/fs/tree?dir=' + encodeURIComponent(dir) + '&depth=1').then(function (r) {
      if (!r || !r.ok) return;
      fillKids(container, r.rows);
    });
  }

  /**
   * 新建文件夹 / 新建文件：像 VS Code 那样，在目标文件夹下面冒出一行输入框。
   */
  function startCreate(parentPath, container, kind) {
    if (!container) { wbToast('先在树上点一个文件夹', true); return; }
    // 目标文件夹是收着的 ⇒ 先展开它，不然新建的东西看不见
    if (container.__row && container.style.display === 'none') {
      container.style.display = '';
      container.__row.__open = true;
      var c = container.__row.querySelector('.ftree-chev');
      var ic = container.__row.querySelector('.ftree-icon');
      if (c) c.textContent = '▾';
      if (ic) ic.textContent = '📂';
    }
    var row = wbEl('div', 'ftree-row is-new');
    row.style.paddingLeft = '20px';
    row.appendChild(wbEl('span', 'ftree-icon', kind === 'dir' ? '📁' : '📄'));
    var inp = wbEl('input', 'ftree-input');
    inp.placeholder = kind === 'dir' ? '文件夹名（回车确认）' : '文件名（回车确认）';
    row.appendChild(inp);
    container.appendChild(row);
    inp.focus();

    var done = false;
    function cancel() { if (done) return; done = true; row.remove(); }
    function commit() {
      if (done) return;
      var name = inp.value.trim();
      if (!name) { cancel(); return; }
      done = true;
      wbApi('POST', '/api/fs/create', {
        scene: sceneId, dir: parentPath, name: name, kind: kind,
      }).then(function (r) {
        if (!r || !r.ok) {
          wbToast('建不出来：' + (r && r.error || '未知'), true);
          row.remove();
          return;
        }
        wbToast('建好了：' + r.name);
        wbAct(sceneId, kind === 'dir' ? '新建文件夹' : '新建文件', r.path, { 位置: parentPath });
        refreshKids(container);
      }).catch(function (e) {
        wbToast('建不出来：' + (e && e.message || e), true);
        row.remove();
      });
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    inp.addEventListener('blur', function () { setTimeout(function () { if (!done) commit(); }, 200); });
  }

  /** 点文件 ⇒ 底下开个小预览（不想跳出去就能瞄一眼）。 */
  function previewFile(p, name) {
    var box = wrap.querySelector('.ftree-preview');
    if (!box) {
      box = wbEl('div', 'ftree-preview');
      wrap.appendChild(box);
    }
    box.style.display = '';
    box.textContent = '读 ' + name + ' …';
    wbApi('GET', '/api/fs/read?path=' + encodeURIComponent(p)).then(function (r) {
      if (!r || !r.ok) { box.textContent = '读不了：' + (r && r.error || '未知'); return; }
      var text = String(r.text || '');
      var lines = text.split('\n');
      var cut = lines.length > 200;
      box.textContent = '── ' + name + '（' + sizeText(r.size) + '）──\n'
        + lines.slice(0, 200).join('\n') + (cut ? '\n…（后面还有，滚下去看）' : '');
      box.scrollTop = 0;
    });
  }

  /** 以某个目录为工作目录，开一条新会话。 */
  function openSession(cwd) {
    if (!cwd) { wbToast('先选一个文件夹', true); return; }
    var sc = (window.__WB_SCENES || []).filter(function (s) { return s.id === sceneId; })[0];
    var title = (sc && sc.name ? sc.name : sceneId) + '·' + cwd.split('/').pop();
    wbApi('POST', '/api/sessions/create', { scene: sceneId, title: title, cwd: cwd }).then(function (r) {
      if (!r || !r.ok) { wbToast('开会话失败：' + (r && r.error), true); return; }
      hint.textContent = '新会话已绑上（' + r.sessionId.slice(0, 20) + '…），工作目录 = ' + cwd;
      wbToast('开好了，工作目录是 ' + cwd);
    }).catch(function (e) { wbToast('开会话失败：' + (e && e.message || e), true); });
  }

  function load() {
    wbApi('GET', '/api/scene/project?id=' + encodeURIComponent(sceneId)).then(function (r) {
      if (!r || !r.ok) { cur.textContent = '读不到：' + (r && r.error || '未知'); return; }
      root = r.projectRoot || '';
      base = r.base || root || '';
      input.value = root;

      if (root && !r.exists) {
        cur.className = 'proj-cur';
        cur.textContent = root + '（⚠ 目录不在了）';
        acts.diag.textContent = '目录缺失';
        list.innerHTML = '';
        list.appendChild(wbEl('div', 'todo-empty', '绑的目录不在了 —— 重新绑一个，或先建一个。'));
        return;
      }
      // 没绑项目目录 ⇒ 看它自己的「项目记忆」目录（照样能建文件夹）
      var rootPath = root || base;
      cur.className = root ? 'proj-cur' : 'proj-cur off';
      cur.textContent = root
        ? root
        : base + '（还没绑项目目录：现在看的是它自己的项目记忆目录）';
      acts.diag.textContent = root ? '已绑定' : '未绑目录';
      loadTree(rootPath);
    });
  }

  function loadTree(dir) {
    list.innerHTML = '';
    rowsByPath = {};
    treeRoot = dir;
    list.__dir = dir;
    list.__depth = 0;
    wbApi('GET', '/api/fs/tree?dir=' + encodeURIComponent(dir) + '&depth=1').then(function (r) {
      if (!r || !r.ok) {
        list.appendChild(wbEl('div', 'todo-empty', '读不了：' + (r && r.error || '未知')));
        return;
      }
      acts.diag.textContent = r.rows.length + ' 项';
      fillKids(list, r.rows);
      selectDir(dir);
    });
  }

  bind.addEventListener('click', function () {
    var v = input.value.trim();
    if (!v) { wbToast('先填个目录', true); return; }
    wbApi('POST', '/api/scene/project', { id: sceneId, root: v }).then(function (r) {
      if (!r || !r.ok) { wbToast('绑不上：' + (r && r.error), true); return; }
      wbToast('绑好了：' + r.projectRoot);
      load();
    }).catch(function (e) { wbToast('绑不上：' + (e && e.message || e), true); });
  });

  unbind.addEventListener('click', function () {
    if (!root) return;
    wbApi('POST', '/api/scene/project', { id: sceneId, root: '' }).then(function (r) {
      if (!r || !r.ok) { wbToast('解不开：' + (r && r.error), true); return; }
      wbToast('已解绑');
      load();
    });
  });

  mkSession.addEventListener('click', function () {
    if (!root) { wbToast('先绑一个项目目录', true); return; }
    openSession(root);
  });

  /* ── 工具条：新建文件夹 / 新建文件 / 刷新 ───────────────────── */
  mkDir.addEventListener('click', function () {
    var dir = selected || treeRoot;
    startCreate(dir, kidsOf(dir), 'dir');
  });
  mkFile.addEventListener('click', function () {
    var dir = selected || treeRoot;
    startCreate(dir, kidsOf(dir), 'file');
  });
  refresh.addEventListener('click', function () { load(); });

  load();
  return function () { /* noop */ };
};

/* ── 19. bookshelf：书架（照 Obsidian 的 05-Bookshelf 搭） ──────────────
 *
 * 读的是**真实仓库**里的 md（frontmatter 里的 title/author/status/
 * currentPage/totalPage/cover）⇒ 你的 Obsidian 和这里是同一份数据。
 *
 * 三组：在读 / 想读 / 已读完 —— 和 Obsidian 的 dataviewjs 仪表盘一样。
 */
PANELS.bookshelf = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var sceneId = meta.scene || meta.scenario || '';
  var dir = meta.dir || '05-Bookshelf/书籍list';

  var box = wbEl('div', 'shelf-box');
  body.appendChild(box);

  var top = wbEl('div', 'shelf-top');
  var counts = wbEl('div', 'shelf-counts', '读取中…');
  top.appendChild(counts);
  var addBtn = wbEl('button', 'chip', '＋ 加一本');
  top.appendChild(addBtn);
  box.appendChild(top);

  var list = wbEl('div', 'shelf-list');
  box.appendChild(list);

  var reader = wbEl('div', 'shelf-reader');
  reader.style.display = 'none';
  box.appendChild(reader);

  var books = [];

  /* ── 进度条（Obsidian 那份是 10 格方块） ── */
  function bar(cur, total) {
    if (!total || total <= 0) return null;
    var pct = Math.round(Math.min(1, cur / total) * 100);
    var n = Math.round(pct / 10);
    return '🟩'.repeat(n) + '⬜'.repeat(10 - n) + '  ' + pct + '%';
  }

  function coverOf(b) {
    if (!b.cover) return null;
    if (/^https?:/.test(b.cover)) {
      var img = wbEl('img', 'shelf-cover');
      img.src = b.cover;
      img.loading = 'lazy';
      img.alt = b.title;
      return img;
    }
    return null;   // 本地封面（_covers/）工作台读不到，先不画
  }

  function bookRow(b) {
    var row = wbEl('div', 'shelf-book');
    row.setAttribute('data-book', b.path);

    var cov = coverOf(b);
    if (cov) row.appendChild(cov);

    var main = wbEl('div', 'shelf-book-main');
    var t = wbEl('div', 'shelf-book-title', b.title);
    main.appendChild(t);
    var metaLine = wbEl('div', 'shelf-book-meta');
    metaLine.textContent = [b.author || '—', (b.totalPage ? b.totalPage + ' 页' : null),
      b.startDate || null, b.status].filter(Boolean).join(' · ');
    main.appendChild(metaLine);

    var pb = bar(b.currentPage, b.totalPage);
    if (pb) {
      var p = wbEl('div', 'shelf-book-prog', pb);
      main.appendChild(p);
      main.appendChild(wbEl('div', 'shelf-book-page', b.currentPage + ' / ' + (b.totalPage || '?') + ' 页'));
    }
    if (b.excerpt) main.appendChild(wbEl('div', 'shelf-book-excerpt', b.excerpt));

    row.appendChild(main);

    var side = wbEl('div', 'shelf-book-side');
    var read = wbEl('button', 'chip', b.currentPage > 0 ? '继续' : '开始');
    read.addEventListener('click', function (e) { e.stopPropagation(); openBook(b); });
    side.appendChild(read);
    var upd = wbEl('button', 'chip', '更新进度');
    upd.addEventListener('click', function (e) { e.stopPropagation(); askProgress(b); });
    side.appendChild(upd);
    row.appendChild(side);

    row.addEventListener('click', function () { openBook(b); });
    return row;
  }

  function section(title, list2, cls) {
    if (!list2 || !list2.length) return;
    var h = wbEl('div', 'shelf-h' + (cls ? ' ' + cls : ''), title + '（' + list2.length + '）');
    list.appendChild(h);
    list2.forEach(function (b) { list.appendChild(bookRow(b)); });
  }

  function load() {
    wbApi('GET', '/api/vault/books?scene=' + encodeURIComponent(sceneId) + '&dir=' + encodeURIComponent(dir))
      .then(function (r) {
        list.innerHTML = '';
        if (!r || !r.ok) {
          counts.textContent = '';
          list.appendChild(wbEl('div', 'todo-empty', (r && r.error) || '读不到仓库'));
          return;
        }
        books = [];
        var c = r.counts;
        counts.innerHTML = '';
        [['📊 总计', c.total], ['📖 在读', c.reading], ['📋 想读', c.want], ['✅ 已读完', c.done]]
          .forEach(function (pair) {
            var chip = wbEl('span', 'shelf-chip', pair[0] + ' ' + pair[1]);
            counts.appendChild(chip);
          });
        acts.diag.textContent = c.total + ' 本';
        section('📖 在读', r.groups['在读'], 'reading');
        section('📋 想读', r.groups['想读']);
        section('✅ 已读完', r.groups['已读完'], 'done');
        if (r.other && r.other.length) section('📦 其它状态', r.other);
        if (!c.total) list.appendChild(wbEl('div', 'todo-empty', '这个目录还没有书 —— 点「＋ 加一本」'));
      });
  }

  /* ── 打开一本书：读它的正文 ── */
  function openBook(b) {
    wbApi('GET', '/api/vault/note?scene=' + encodeURIComponent(sceneId) + '&path=' + encodeURIComponent(b.path))
      .then(function (r) {
        if (!r || !r.ok) { wbToast('读不到：' + (r && r.error), true); return; }
        wbAct(sceneId, '打开书', b.title, { 路径: b.path, 进度: (b.currentPage || 0) + '/' + (b.totalPage || '?') });
        reader.innerHTML = '';
        reader.style.display = '';
        list.style.display = 'none';            // 读书视图接管
        var head2 = wbEl('div', 'shelf-reader-head');
        var back = wbEl('button', 'chip', '← 书架');
        back.addEventListener('click', function () {
          wbAct(sceneId, '返回书架', b.title);
          reader.style.display = 'none';
          reader.innerHTML = '';
          list.style.display = '';               // 回书架
        });
        head2.appendChild(back);
        head2.appendChild(wbEl('div', 'shelf-reader-title', b.title));
        reader.appendChild(head2);

        var metaLine = wbEl('div', 'shelf-reader-meta',
          [b.author || '—', (b.totalPage ? b.totalPage + ' 页' : null),
            b.currentPage + ' / ' + (b.totalPage || '?') + ' 页', b.status].filter(Boolean).join(' · '));
        reader.appendChild(metaLine);

        var upd = wbEl('button', 'chip solid', '更新进度');
        upd.addEventListener('click', function () { askProgress(b); });
        reader.appendChild(upd);

        // ⚠ mdToText 返回的是**元素**，不能塞进 wbEl 的第三个参数（那是文本）
        //   —— 塞进去会打印成 [object HTMLDivElement]。
        var pre = wbEl('div', 'shelf-md');
        pre.appendChild(mdToText(r.body || ''));
        reader.appendChild(pre);
      });
  }

  /** 极简 markdown → 可读文本（标题/列表/引用/分隔线）。 */
  function mdToText(md) {
    var out = [];
    String(md || '').split(/\r?\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) { out.push({ gap: true }); return; }
      if (t === '---') { out.push({ hr: true }); return; }
      var h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push({ h: h[2], lvl: h[1].length }); return; }
      if (t.startsWith('> ')) { out.push({ q: t.slice(2) }); return; }
      var li = t.match(/^[-*+]\s+(.*)$/);
      if (li) { out.push({ li: li[1] }); return; }
      out.push({ p: t });
    });
    var box2 = wbEl('div', 'md');
    out.forEach(function (n) {
      if (n.gap) { box2.appendChild(wbEl('div', 'md-gap')); return; }
      if (n.hr) { box2.appendChild(wbEl('hr', 'md-hr')); return; }
      if (n.h) { box2.appendChild(wbEl('div', 'md-h md-l' + (n.lvl || 1), n.h)); return; }
      if (n.q) { box2.appendChild(wbEl('div', 'md-q', n.q)); return; }
      if (n.li) { box2.appendChild(wbEl('div', 'md-li', '· ' + n.li)); return; }
      box2.appendChild(wbEl('div', 'md-p', n.p));
    });
    return box2;
  }

  /* ── 更新进度 ── */
  function askProgress(b) {
    wbDialog({
      title: '更新进度：' + b.title,
      desc: '当前 ' + b.currentPage + ' / ' + (b.totalPage || '?') + ' 页。'
        + '\n读到第几页了？（填满总页数 ⇒ 状态自动变「已读完」）',
      submitText: '更新',
      fields: [{
        key: 'page', label: '当前页码', type: 'text',
        value: String(b.currentPage || 0),
      }],
      onSubmit: function (v) {
        var page = parseInt(String(v.page).replace(/[^\d]/g, ''), 10);
        if (isNaN(page) || page < 0) throw new Error('页码不对');
        return wbApi('POST', '/api/vault/progress?scene=' + encodeURIComponent(sceneId), {
          path: b.path, currentPage: page,
        }).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || '更新失败');
          wbToast('进度更新了：' + page + ' 页');
          load();
          // 服务端已经把项目信息的自动区重算了 ⇒ 通知「项目信息」面板刷新
          window.dispatchEvent(new CustomEvent('wb:mem-changed', { detail: { scene: sceneId } }));
          return { ok: true };
        });
      },
    });
  }

  /* ── 加一本书 ── */
  addBtn.addEventListener('click', function () {
    wbDialog({
      title: '加一本书',
      desc: '会在「' + dir + '」里新建一个 md（格式跟 Obsidian 的书笔记一样：'
        + 'title / author / totalPage / status / cover）。',
      submitText: '加进去',
      fields: [
        { key: 'title', label: '书名', type: 'text' },
        { key: 'author', label: '作者', type: 'text' },
        { key: 'totalPage', label: '总页数', type: 'text' },
        { key: 'cover', label: '封面链接（可留空）', type: 'text' },
      ],
      onSubmit: function (v) {
        if (!v.title || !v.title.trim()) throw new Error('要书名');
        return wbApi('POST', '/api/vault/book?scene=' + encodeURIComponent(sceneId), {
          dir: dir, title: v.title.trim(), author: v.author || '',
          totalPage: v.totalPage || 0, cover: v.cover || '', status: '想读',
        }).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || '加不进去');
          wbToast('加好了：' + r.path);
          load();
          window.dispatchEvent(new CustomEvent('wb:mem-changed', { detail: { scene: sceneId } }));
          return { ok: true };
        });
      },
    });
  });

  load();
  return function () { /* noop */ };
};

/* ── 20. notes：仓库条目（通用版） ─────────────────────────────────
 *
 * 读角色绑定的仓库目录下的 md，按 frontmatter 挑着显示。
 * 和「书架」的区别：书架是书（进度条/状态三组），这里是**任意条目**
 * —— 概念卡、运动记录、股票池…
 *
 * 显示哪些字段由面板配置决定（fields），没配就按类型猜。
 */
PANELS.notes = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var sceneId = meta.scene || meta.scenario || '';
  var dir = meta.dir || '';
  var fields = Array.isArray(meta.fields) ? meta.fields : null;   // 要显示的 frontmatter 字段

  var box = wbEl('div', 'notes-box');
  body.appendChild(box);

  var top = wbEl('div', 'notes-top');
  var count = wbEl('div', 'notes-count', '读取中…');
  top.appendChild(count);
  var search = wbEl('input', 'notes-search');
  search.placeholder = '搜标题…';
  top.appendChild(search);
  box.appendChild(top);

  var list = wbEl('div', 'notes-list');
  box.appendChild(list);

  var reader = wbEl('div', 'notes-reader');
  reader.style.display = 'none';
  box.appendChild(reader);

  var all = [];
  var kw = '';

  /** 没配 fields ⇒ 按 frontmatter 里有什么来显示。 */
  function pickFields(fm) {
    if (fields && fields.length) return fields;
    var preferred = ['date', 'type', 'subtype', 'distance_m', 'duration_min', 'avg_pace',
      'calories', 'avg_heart_rate', 'feel', 'location', 'author', 'updated'];
    var keys = Object.keys(fm || {});
    var out = [];
    for (var i = 0; i < preferred.length; i++) {
      if (keys.indexOf(preferred[i]) >= 0) out.push(preferred[i]);
    }
    return out.slice(0, 4);
  }

  function labelOf(k) {
    var map = {
      date: '日期', type: '类型', subtype: '泳姿', distance_m: '距离(米)',
      duration_min: '时长(分)', avg_pace: '配速', calories: '卡路里',
      avg_heart_rate: '平均心率', max_heart_rate: '最大心率', feel: '体感',
      location: '地点', author: '作者', updated: '更新于', notes: '备注',
    };
    return map[k] || k;
  }

  function fmt(k, v) {
    if (v == null || v === '') return '';
    if (k === 'distance_m') return v + ' 米';
    if (k === 'duration_min') return v + ' 分钟';
    if (k === 'calories') return v + ' 千卡';
    if (k === 'avg_heart_rate' || k === 'max_heart_rate') return v + ' bpm';
    if (k === 'feel') return v + ' /5';
    return String(v);
  }

  function noteRow(n) {
    var row = wbEl('div', 'notes-item');
    row.setAttribute('data-note', n.path);

    var head = wbEl('div', 'notes-item-head');
    head.appendChild(el('span', 'notes-item-title', n.title || n.file));
    if (n.date) head.appendChild(el('span', 'notes-item-date', n.date));
    row.appendChild(head);

    var fs2 = pickFields(n.fm);
    if (fs2.length) {
      var metaLine = wbEl('div', 'notes-item-meta');
      fs2.forEach(function (k) {
        var v = fmt(k, n.fm[k]);
        if (!v) return;
        metaLine.appendChild(el('span', 'notes-chip', labelOf(k) + ' ' + v));
      });
      row.appendChild(metaLine);
    }
    if (n.excerpt) row.appendChild(el('div', 'notes-item-excerpt', n.excerpt));

    row.addEventListener('click', function () { openNote(n); });
    return row;
  }

  function render() {
    list.innerHTML = '';
    var rows = all.filter(function (n) {
      if (!kw) return true;
      var t = (n.title || n.file) + ' ' + (n.excerpt || '');
      return t.toLowerCase().indexOf(kw.toLowerCase()) >= 0;
    });
    count.textContent = all.length + ' 条' + (kw ? '（匹配 ' + rows.length + '）' : '');
    acts.diag.textContent = rows.length + ' 条';
    if (!rows.length) { list.appendChild(el('div', 'todo-empty', all.length ? '没有匹配的' : '这个目录里没有 md')); return; }
    rows.forEach(function (n) { list.appendChild(noteRow(n)); });
  }

  function load() {
    wbApi('GET', '/api/vault/notes?scene=' + encodeURIComponent(sceneId) + '&dir=' + encodeURIComponent(dir))
      .then(function (r) {
        if (!r || !r.ok) {
          count.textContent = '';
          list.appendChild(el('div', 'todo-empty', (r && r.error) || '读不到仓库'));
          return;
        }
        all = r.notes || [];
        render();
      });
  }

  /* ── 打开一条：读正文 ── */
  function openNote(n) {
    wbApi('GET', '/api/vault/note?scene=' + encodeURIComponent(sceneId) + '&path=' + encodeURIComponent(n.path))
      .then(function (r) {
        if (!r || !r.ok) { wbToast('读不到：' + (r && r.error), true); return; }
        wbAct(sceneId, '打开条目', n.title || n.file, { 路径: n.path });
        reader.innerHTML = '';
        reader.style.display = '';
        list.style.display = 'none';
        var head2 = wbEl('div', 'notes-reader-head');
        var back = wbEl('button', 'chip', '← 列表');
        back.addEventListener('click', function () {
          reader.style.display = 'none';
          reader.innerHTML = '';
          list.style.display = '';
        });
        head2.appendChild(back);
        head2.appendChild(el('div', 'notes-reader-title', n.title || n.file));
        reader.appendChild(head2);

        // frontmatter 的关键字段摆出来
        var fmKeys = pickFields(n.fm);
        if (fmKeys.length) {
          var metaLine = wbEl('div', 'notes-reader-meta');
          fmKeys.forEach(function (k) {
            var v = fmt(k, n.fm[k]);
            if (v) metaLine.appendChild(el('span', 'notes-chip', labelOf(k) + ' ' + v));
          });
          reader.appendChild(metaLine);
        }

        var pre = wbEl('div', 'notes-md');
        pre.appendChild(wbMd(n.content || ''));
        reader.appendChild(pre);
      });
  }

  search.addEventListener('input', function () { kw = search.value.trim(); render(); });

  load();
  return function () { /* noop */ };
};

/** 极简 markdown → 元素（标题/列表/引用/表格/分隔线/代码块）。 */
function wbMd(md) {
  var box = wbEl('div', 'md');
  String(md || '').split(/\r?\n/).forEach(function (line) {
    var t = line.trim();
    if (!t) { box.appendChild(wbEl('div', 'md-gap')); return; }
    if (t === '---') { box.appendChild(wbEl('hr', 'md-hr')); return; }
    if (t.startsWith('```')) { box.appendChild(wbEl('div', 'md-code', '（代码块）')); return; }
    var h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { box.appendChild(wbEl('div', 'md-h md-l' + (h[1].length), h[2])); return; }
    if (t.startsWith('> ')) { box.appendChild(wbEl('div', 'md-q', t.slice(2))); return; }
    var li = t.match(/^[-*+]\s+(.*)$/);
    if (li) { box.appendChild(wbEl('div', 'md-li', '· ' + li[1])); return; }
    if (t.startsWith('|')) { box.appendChild(wbEl('div', 'md-tb', t)); return; }
    box.appendChild(wbEl('div', 'md-p', t.replace(/^`this\.\w+\s*$/, '')));
  });
  return box;
}

/**
 * markdown → 元素，**表格画成真表格**（wbMd 把 | 行画成纯文本，太难读）。
 * 台账那种一行一列的东西，用这个。
 */
function wbMdTable(md) {
  var box = wbEl('div', 'md md-tbl-wrap');
  var lines = String(md || '').split(/\r?\n/);
  var i = 0;
  while (i < lines.length) {
    var t = lines[i].trim();
    if (!t.startsWith('|')) {
      // 非表格的一段 ⇒ 攒起来交给 wbMd
      var chunk = [];
      while (i < lines.length && !lines[i].trim().startsWith('|')) { chunk.push(lines[i]); i++; }
      if (chunk.join('').trim()) box.appendChild(wbMd(chunk.join('\n')));
      continue;
    }
    // 一段连续的 | 行 ⇒ 一张表
    var rows = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      var raw = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '');
      var cells = raw.split('|').map(function (c) { return c.trim().replace(/\\\|/g, '|'); });
      // |---|---| 这种分隔行不算数据
      if (!cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) rows.push(cells);
      i++;
    }
    if (!rows.length) continue;
    var table = wbEl('table', 'md-tbl');
    var thead = wbEl('thead');
    var trh = wbEl('tr');
    rows[0].forEach(function (c) { trh.appendChild(wbEl('th', '', c)); });
    thead.appendChild(trh);
    table.appendChild(thead);
    var tbody = wbEl('tbody');
    rows.slice(1).forEach(function (r) {
      var tr = wbEl('tr');
      r.forEach(function (c) { tr.appendChild(wbEl('td', '', c)); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  }
  return box;
}

/* ── 14. dashboard：仪表盘（五套机制的状态 + 现在该做什么） ─────── */
PANELS.dashboard = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  body.classList.add('disp-body');
  var box = wbEl('div', 'dash-box');
  body.appendChild(box);

  function card(title, value, detail, cls) {
    var c = wbEl('div', 'dash-card ' + (cls || ''));
    c.appendChild(wbEl('div', 'dash-card-title', title));
    c.appendChild(wbEl('div', 'dash-card-value', value));
    if (detail) c.appendChild(wbEl('div', 'dash-card-detail', detail));
    return c;
  }

  function render(d) {
    box.innerHTML = '';

    // ① 状态卡
    var cards = wbEl('div', 'dash-cards');
    cards.appendChild(card('引擎', d.engine.up ? '已连' : '未连', d.engine.base,
      d.engine.up ? 'ok' : 'bad'));
    cards.appendChild(card('负载闸', d.gate.verdict === 'ok' ? '可派单' : (d.gate.verdict === 'warn' ? '停止派单' : (d.gate.verdict === 'stop' ? '停重活' : '量不到')),
      'CPU ' + (d.gate.cpu != null ? d.gate.cpu : '?') + '% · 内存 ' + (d.gate.ram != null ? d.gate.ram : '?') + '%',
      d.gate.verdict === 'ok' ? 'ok' : (d.gate.verdict === 'unknown' ? '' : 'bad')));
    cards.appendChild(card('派单', d.dispatch.awaitingReply + ' 等回执',
      '未回执 ' + d.dispatch.overdue + ' · 已销账 ' + d.dispatch.closed,
      d.dispatch.overdue ? 'bad' : ''));
    cards.appendChild(card('分诊', d.triage.unowned + ' 无主',
      '有主 ' + d.triage.owned + ' · 合计 ' + d.triage.total,
      d.triage.unowned ? 'warn' : 'ok'));
    cards.appendChild(card('权限', d.authority.violations + ' 越界',
      '撞车 ' + d.authority.collisions + ' · 租约 ' + d.authority.claims,
      d.authority.violations ? 'bad' : 'ok'));
    cards.appendChild(card('记忆', d.memory.files + ' 个文件',
      (d.memory.over.length ? '⛔ §〇 超 4KB' : '红线正常'),
      d.memory.over.length ? 'bad' : 'ok'));
    cards.appendChild(card('场景', d.scenes.length + ' 个',
      d.scenes.filter(function (x) { return !x.ok; }).length + ' 个没绑会话',
      d.scenes.every(function (x) { return x.ok; }) ? 'ok' : 'bad'));
    box.appendChild(cards);

    // ② 现在该做什么
    var todo = d.todo || [];
    box.appendChild(wbEl('div', 'ledger-h', '现在该做什么（' + todo.length + '）'));
    if (!todo.length) {
      box.appendChild(wbEl('div', 'dash-clear', '✓ 没有急事。机器能接活，活都有人认，没越界。'));
    }
    todo.forEach(function (t, idx) {
      var row = wbEl('div', 'dash-todo ' + t.level);
      row.appendChild(wbEl('div', 'dash-todo-what', t.what));
      row.appendChild(wbEl('div', 'dash-todo-how', t.how));
      if (t.action) {
        var acts2 = wbEl('div', 'dash-todo-acts');
        var btn = wbEl('button', 'panel-btn solid', t.action.label);
        btn.addEventListener('click', function () {
          btn.disabled = true;
          Promise.resolve(window.wbAction(t.action)).then(function (r) {
            btn.disabled = false;
            if (r && r.ok !== false) { wbToast('做完了'); load(); }
          }).catch(function (e) {
            btn.disabled = false;
            wbToast(String(e && e.message || e), true);
          });
        });
        acts2.appendChild(btn);
        row.appendChild(acts2);
      }
      box.appendChild(row);
    });

    // ③ 场景表
    box.appendChild(wbEl('div', 'ledger-h', '场景'));
    var tbl = wbEl('div', 'dash-scenes');
    d.scenes.forEach(function (s) {
      var row = wbEl('div', 'dash-scene' + (s.ok ? '' : ' bad'));
      row.appendChild(wbEl('span', 'dash-scene-name', s.name));
      row.appendChild(wbEl('span', 'dash-scene-meta',
        s.panels + ' 面板 · AI ' + s.bound + '/' + s.aiPanels));
      tbl.appendChild(row);
    });
    box.appendChild(tbl);

    var bad = todo.filter(function (t) { return t.level === 'bad'; }).length;
    acts.diag.textContent = bad ? bad + ' 件急事' : '一切正常';
  }

  function load() {
    wbApi('GET', '/api/dashboard').then(function (r) {
      if (r && r.ok) render(r.dashboard);
      else box.textContent = '读不到仪表盘';
    });
  }
  load();
  var timer = setInterval(load, 10000);
  wbHeadButton(head, '⟳', '刷新', load);
  wbHeadButton(head, '自检', '跑一遍体检（22 项）', function () {
    var b = wbEl('button', 'panel-btn', '自检中…');
    b.disabled = true;
    wbApi('GET', '/api/doctor').then(function (r) {
      var rep = r.report || { rows: [], fail: 0 };
      var lines = rep.rows.map(function (x) {
        return (x.ok ? '✓ ' : '✗ ') + x.name + (x.detail ? ' — ' + x.detail : '');
      }).join('\n');
      lines += '\n\n' + (rep.fail ? '⛔ ' + rep.fail + ' 项未通过' : '✅ 全部通过');
      return window.wbDialog({
        title: '自检（' + rep.rows.length + ' 项）',
        desc: lines,
        submitText: '知道了',
        fields: [],
        onSubmit: function () { return { ok: true }; },
      });
    }).catch(function (e) {
      wbToast('自检跑不了：' + e.message, true);
    }).then(function () { b.disabled = false; });
  });
  return function () { clearInterval(timer); };
};

/* ── 13. identity：身份卡（每场读的那张卡） ──────────────────────── */
PANELS.identity = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var scene = meta.scenario;
  var box = wbEl('div', 'id-card');
  body.appendChild(box);
  var ta = wbEl('textarea', 'note-area');
  var save = wbEl('button', 'panel-btn solid', '保存');
  save.addEventListener('click', function () {
    wbApi('POST', '/api/memory', { scene: scene, card: true, text: ta.value }).then(function (r) {
      if (r && r.ok) wbToast('身份卡已存');
      else wbToast('没存成', true);
    });
  });
  function load() {
    wbApi('GET', '/api/memory?scene=' + encodeURIComponent(scene)).then(function (r) {
      if (!r || !r.ok) return;
      box.innerHTML = '';
      var info = wbEl('div', 'id-meta');
      info.appendChild(wbEl('div', 'id-name', scene));
      info.appendChild(wbEl('div', 'id-duty', '每场读的那张卡：我是谁、干什么、能碰什么'));
      box.appendChild(info);
      ta.value = r.card || '';
      box.appendChild(ta);
      box.appendChild(save);
      acts.diag.textContent = Math.round((r.card || '').length / 1024 * 10) / 10 + 'K';
    });
  }
  load();
  return function () { /* noop */ };
};

/* ── 14. constitution：宪法（AGENTS.md） ─────────────────────────── */
PANELS.constitution = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var box = wbEl('div', 'const-box');
  body.appendChild(box);
  var pre = wbEl('pre', 'const-text');
  box.appendChild(pre);
  wbApi('GET', '/api/constitution').then(function (r) {
    if (!r || !r.ok) { pre.textContent = '读不到宪法'; return; }
    pre.textContent = r.text || '（宪法是空的）';
    acts.diag.textContent = Math.round((r.text || '').length / 1024 * 10) / 10 + 'K';
  });
  return function () { /* noop */ };
};

/* ── 15. indexmap：索引（场景索引 + 资产索引） ───────────────────── */
PANELS.indexmap = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var box = wbEl('div', 'idx-box');
  body.appendChild(box);
  function load() {
    wbApi('GET', '/api/index').then(function (r) {
      if (!r || !r.ok) { box.textContent = '读不到索引'; return; }
      box.innerHTML = '';
      var groups = {};
      (r.rows || []).forEach(function (row) { (groups[row.kind] = groups[row.kind] || []).push(row); });
      Object.keys(groups).forEach(function (k) {
        box.appendChild(wbEl('div', 'ledger-h', k + '（' + groups[k].length + '）'));
        groups[k].forEach(function (row) {
          var line = wbEl('div', 'idx-row');
          line.appendChild(wbEl('span', 'idx-key', row.key));
          line.appendChild(wbEl('span', 'idx-where', row.where));
          line.appendChild(wbEl('span', 'idx-size', Math.round((row.size || 0) / 1024 * 10) / 10 + 'K'));
          if (row.note) line.appendChild(wbEl('span', 'idx-note', row.note));
          box.appendChild(line);
        });
      });
      acts.diag.textContent = (r.rows || []).length + ' 条';
    });
  }
  load();
  var timer = setInterval(load, 15000);
  return function () { clearInterval(timer); };
};

/* ── 16. health：体检（这个场景的） ─────────────────────────────── */
PANELS.health = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var box = wbEl('div', 'health-box');
  body.appendChild(box);
  function load() {
    wbApi('GET', '/api/doctor').then(function (r) {
      // ⚠ 判据看**报告在不在**，不看 r.ok ——
      //   r.ok 的意思是「所有项都绿」，只要有一项红它就是 false。
      //   早先这里判的是 !r.ok ⇒ 只要有一项红，面板就只显示「体检跑不了」，
      //   24 项报告全被吞掉 —— 想看体检的人恰恰看不到是哪一项坏了。
      if (!r || !r.report || !Array.isArray(r.report.rows)) { box.textContent = '体检跑不了'; return; }
      var rows = r.report.rows || [];
      box.innerHTML = '';
      var mine = rows.filter(function (x) { return x.name.indexOf('会话绑定') >= 0 || x.name.indexOf('记忆') >= 0; });
      rows.forEach(function (x) {
        var line = wbEl('div', 'health-row ' + (x.ok ? 'ok' : 'bad'));
        line.appendChild(wbEl('span', 'health-name', x.name));
        line.appendChild(wbEl('span', 'health-detail', x.detail || ''));
        box.appendChild(line);
      });
      var bad = rows.filter(function (x) { return !x.ok; }).length;
      acts.diag.textContent = rows.length + ' 项 · ' + (bad ? bad + ' 项要修' : '全绿');
      void mine;
    }).catch(function (e) {
      box.innerHTML = '';
      box.appendChild(wbEl('div', 'todo-empty', '体检跑不了：' + ((e && e.message) || e)));
    });
  }
  load();
  var timer = setInterval(load, 20000);
  return function () { clearInterval(timer); };
};

/* ── 21. actlog：操作留痕（这个场景里发生过的一切） ──────────────────
 *
 * 一条时间线：**人**在界面上的动作 + **服务端**改动过的东西 + **AI** 的工具调用。
 * 数据来自 GET /api/actlog?scene=<id>&ai=1（判据在 lib/actlog.mjs）。
 *
 * ⚠ 留痕的主场是**项目信息面板里的「留痕」页签**（wbActlogView 是同一份实现）——
 *   这里保留一个独立面板类型，想单独摆一面墙的时候用。
 */
PANELS.actlog = function (body, meta, head) {
  var acts = wbHeadActs(head, meta.id);
  var sceneId = meta.scene || meta.scenario || '';
  var box = wbEl('div', 'act-box');
  body.appendChild(box);
  var view = wbActlogView(box, sceneId, function (n, sum) {
    acts.diag.textContent = n + ' 条 · 今 ' + ((sum && sum.today) || 0);
  });
  var timer = setInterval(function () { view.refresh(); }, 12000);
  return function () { clearInterval(timer); };
};

/* 导出给 app.js 用 */
window.APP_RENDERERS = PANELS;
window.APP_PANEL_UTILS = { el: wbEl, api: wbApi, toast: wbToast, headActs: wbHeadActs, headButton: wbHeadButton };
