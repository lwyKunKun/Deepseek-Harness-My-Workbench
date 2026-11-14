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

/* ── 2. memory：项目信息.md（分节）+ 身份卡 ─────────────────────── */
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
  var curText = '';
  var health = null;

  function renderTabs() {
    tabs.innerHTML = '';
    SECTIONS.forEach(function (s) {
      var b = wbEl('button', 'mem-tab' + (cur === s.key ? ' active' : ''), s.key + ' ' + s.name);
      b.title = s.hint;
      b.addEventListener('click', function () { cur = s.key; renderTabs(); renderBody(); });
      tabs.appendChild(b);
    });
    var card = wbEl('button', 'mem-tab' + (cur === '身份卡' ? ' active' : ''), '身份卡');
    card.addEventListener('click', function () { cur = '身份卡'; renderTabs(); renderBody(); });
    tabs.appendChild(card);
  }

  function renderBody() {
    editBox.innerHTML = '';
    var ta = wbEl('textarea', 'note-area');
    ta.value = curText;
    ta.spellcheck = false;
    editBox.appendChild(ta);

    var bar = wbEl('div', 'mem-bar');
    if (health) {
      var ok = !health.problems.length;
      bar.appendChild(wbEl('span', 'mem-size ' + (ok ? 'ok' : 'bad'),
        '§〇 ' + Math.round((health.sec0 || 0) / 1024 * 10) / 10 + 'K / 4K'
        + '　主文件 ' + Math.round((health.bytes || 0) / 1024 * 10) / 10 + 'K / 25K'));
      if (health.problems.length) bar.appendChild(wbEl('span', 'mem-prob', '⚠ ' + health.problems.join('；')));
    }
    var save = wbEl('button', 'panel-btn solid', '保存');
    save.addEventListener('click', function () {
      var body2 = { scene: scene, text: ta.value };
      if (cur === '身份卡') body2.card = true; else body2.section = cur;
      wbApi('POST', '/api/memory', body2).then(function (r) {
        if (r && r.ok) { health = r.health; wbToast('已存'); load(); }
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
      var secs = {};
      var re = /^##\s*(§[〇一二三四五六七八九十]+)\s*(.*)$/gm;
      var m, keys = [];
      while ((m = re.exec(text))) keys.push({ key: m[1], title: m[2], start: m.index, bodyStart: re.lastIndex });
      for (var i = 0; i < keys.length; i++) {
        var end = i + 1 < keys.length ? keys[i + 1].start : text.length;
        secs[keys[i].key] = text.slice(keys[i].bodyStart, end).replace(/^\n+/, '').replace(/\n+$/, '');
      }
      curText = cur === '身份卡' ? (r.card || '') : (secs[cur] || '');
      renderTabs();
      renderBody();
    });
  }
  load();
  return function () { /* noop */ };
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

  var list = wbEl('div', 'proj-list');
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

  function load() {
    wbApi('GET', '/api/scene/project?id=' + encodeURIComponent(sceneId)).then(function (r) {
      if (!r || !r.ok) { cur.textContent = '读不到：' + (r && r.error || '未知'); return; }
      root = r.projectRoot || '';
      if (!root) {
        cur.textContent = '还没绑项目目录';
        cur.className = 'proj-cur off';
        input.value = '';
        list.innerHTML = '';
        return;
      }
      cur.className = 'proj-cur';
      cur.textContent = r.exists ? root : root + '（⚠ 目录不在了）';
      input.value = root;
      acts.diag.textContent = r.exists ? '已绑定' : '目录缺失';
      if (r.exists) browse(root);
    });
  }

  function browse(dir) {
    wbApi('GET', '/api/fs/list?dir=' + encodeURIComponent(dir)).then(function (r) {
      list.innerHTML = '';
      if (!r || !r.ok) { list.appendChild(wbEl('div', 'todo-empty', '读不了：' + (r && r.error || '未知'))); return; }
      acts.diag.textContent = r.rows.length + ' 项';
      if (!r.rows.length) { list.appendChild(wbEl('div', 'todo-empty', '空目录')); return; }
      r.rows.slice(0, 40).forEach(function (row) {
        var line = wbEl('div', 'file-row' + (row.isDir ? ' dir' : ''));
        line.appendChild(wbEl('span', 'file-name', row.name));
        if (!row.isDir) line.appendChild(wbEl('span', 'file-size', row.size + ' B'));
        line.addEventListener('click', function () { if (row.isDir) browse(row.path); });
        list.appendChild(line);
      });
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
    var sc = (window.__WB_SCENES || []).filter(function (s) { return s.id === sceneId; })[0];
    var title = (sc && sc.name ? sc.name : sceneId) + '·项目';
    wbApi('POST', '/api/sessions/create', { scene: sceneId, title: title, cwd: root }).then(function (r) {
      if (!r || !r.ok) { wbToast('开会话失败：' + (r && r.error), true); return; }
      hint.textContent = '新会话已绑上（' + r.sessionId.slice(0, 20) + '…），工作目录 = ' + root;
      wbToast('开好了，工作目录是项目目录');
    }).catch(function (e) { wbToast('开会话失败：' + (e && e.message || e), true); });
  });

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
        reader.innerHTML = '';
        reader.style.display = '';
        list.style.display = 'none';            // 读书视图接管
        var head2 = wbEl('div', 'shelf-reader-head');
        var back = wbEl('button', 'chip', '← 书架');
        back.addEventListener('click', function () {
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
          return { ok: true };
        });
      },
    });
  });

  load();
  return function () { /* noop */ };
};

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
      if (!r || !r.ok) { box.textContent = '体检跑不了'; return; }
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
    });
  }
  load();
  var timer = setInterval(load, 20000);
  return function () { clearInterval(timer); };
};

/* 导出给 app.js 用 */
window.APP_RENDERERS = PANELS;
window.APP_PANEL_UTILS = { el: wbEl, api: wbApi, toast: wbToast, headActs: wbHeadActs, headButton: wbHeadButton };
