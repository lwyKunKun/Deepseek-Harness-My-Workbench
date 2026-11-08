/* app.js —— 工作台外壳
 *
 * 三个页签（对齐视频里的「场景 / 注册 / 工作台」）：
 *   场景   = 卡片目录。用起来的角色/场景，点卡片进去是它的面板组。
 *   注册   = 登记新角色（建场景 + 建记忆骨架 + 建会话）。
 *   工作台 = 现在有什么在跑：仪表盘 / 派单台 / 分诊 / 写痕。
 *
 * 场景详情页 = 固定五个面板：身份卡 · 项目信息 · 索引 · 体检 · 会话。
 *
 * ⛔ 热更新约束：顶层一律用 var / function 声明。
 */

var STATE = {
  scenes: [],
  mode: 'scenes',        // scenes | registry | desk
  open: null,            // 打开的场景 id（详情页）
  category: '全部',
  panelPorts: [],
  usedPorts: {},
  engineUp: false,
  cleanups: [],
};

var DOM = {};

/* ── 端口池：一板一 origin = 一板一 localStorage ───────────────── */
function allocPort(panelId) {
  if (!STATE.panelPorts.length) return 0;
  var used = Object.keys(STATE.usedPorts).filter(function (k) { return STATE.usedPorts[k] === panelId; });
  if (used.length) return STATE.usedPorts[used[0]];
  var free = STATE.panelPorts.filter(function (p) {
    return !Object.keys(STATE.usedPorts).some(function (k) { return STATE.usedPorts[k] === p; });
  });
  var port = free.length ? free[0] : STATE.panelPorts[Object.keys(STATE.usedPorts).length % STATE.panelPorts.length];
  STATE.usedPorts[panelId] = port;
  return port;
}
function freePort(panelId) {
  delete STATE.usedPorts[panelId];
}
window.__wbAllocPort = allocPort;
window.__wbFreePort = freePort;

/* ── 小工具 ────────────────────────────────────────────────────── */

/**
 * 工作台的「挂载点」。
 *
 * 两种跑法：
 *   ① 独立页（node server.mjs）—— 挂到 document.body，API 前缀是 ''
 *   ② 嵌在 DSH 界面里（插件）—— 挂到插件给的容器里，API 前缀是 '/workbench'
 *
 * WB_BASE 由装载方先设好（window.__WB_BASE），这里只读一次。
 */
var WB_BASE = (typeof window !== 'undefined' && window.__WB_BASE) || '';
function wbUrl(p) { return WB_BASE + p; }
function wbRoot() {
  return (typeof window !== 'undefined' && window.__WB_ROOT_EL) || document.body;
}
/** 在挂载点里查元素（不是整个 document）—— 免得跟 DSH 界面自己的东西撞。 */
function wbAll(sel) {
  var root = wbRoot();
  return root && root.querySelectorAll ? root.querySelectorAll(sel) : [];
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function api(method, url, body) {
  return fetch(wbUrl(url), {
    method: method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (r) { return r.json(); });
}

/* ── 页签 ──────────────────────────────────────────────────────── */
function cleanupPanels() {
  STATE.cleanups.forEach(function (c) { try { c(); } catch (e) { /* ignore */ } });
  STATE.cleanups = [];
  collapseAll();
}

function setMode(mode) {
  cleanupPanels();
  STATE.mode = mode;
  STATE.open = null;
  Array.prototype.forEach.call(wbAll('#mainnav .navbtn'), function (b) {
    b.classList.toggle('active', b.getAttribute('data-mode') === mode);
  });
  render();
}

/* ── 渲染入口 ──────────────────────────────────────────────────── */
function render() {
  cleanupPanels();
  var view = DOM.view;
  view.innerHTML = '';
  if (STATE.mode === 'scenes') {
    if (STATE.open) renderSceneDetail(STATE.open);
    else renderCatalog();
  } else if (STATE.mode === 'registry') {
    renderRegistry();
  } else {
    renderDesk();
  }
}

/* ── ① 场景页：卡片目录 ────────────────────────────────────────── */
function renderCatalog() {
  var cats = ['全部'];
  STATE.scenes.forEach(function (s) { if (cats.indexOf(s.category) < 0) cats.push(s.category); });

  var bar = el('div', 'cat-bar');
  cats.forEach(function (c) {
    var b = el('button', 'cat-btn' + (STATE.category === c ? ' active' : ''), c);
    b.addEventListener('click', function () { STATE.category = c; render(); });
    bar.appendChild(b);
  });
  DOM.view.appendChild(bar);

  var grid = el('div', 'card-grid');
  var list = STATE.scenes.filter(function (s) {
    return STATE.category === '全部' || s.category === STATE.category;
  });
  if (!list.length) {
    grid.appendChild(el('div', 'todo-empty', '这个分类还没有场景 —— 去「注册」登记一个'));
  }
  list.forEach(function (s) { grid.appendChild(sceneCard(s)); });
  DOM.view.appendChild(grid);
}

function sceneCard(s) {
  var card = el('div', 'scene-card');
  card.setAttribute('data-sc-id', s.id);

  var top = el('div', 'scene-card-top');
  top.appendChild(el('div', 'scene-icon', s.icon || '●'));
  var names = el('div', 'scene-names');
  names.appendChild(el('div', 'scene-name', s.name));
  names.appendChild(el('div', 'scene-cat', s.category || ''));
  top.appendChild(names);
  card.appendChild(top);

  card.appendChild(el('div', 'scene-duty', s.duty || s.description || ''));

  if (s.skills && s.skills.length) {
    var tags = el('div', 'scene-tags');
    s.skills.forEach(function (t) { tags.appendChild(el('span', 'scene-tag', t)); });
    card.appendChild(tags);
  }

  var foot = el('div', 'scene-card-foot');
  var st = el('span', 'scene-stat');
  var ai = (s.panels || []).filter(function (p) { return p.type === 'harness'; });
  var bound = ai.filter(function (p) { return p.sessionId; }).length;
  st.textContent = (s.panels || []).length + ' 面板 · 会话 ' + bound + '/' + ai.length;
  foot.appendChild(st);
  var open = el('button', 'panel-btn solid', '打开');
  open.addEventListener('click', function (e) { e.stopPropagation(); openScene(s.id); });
  foot.appendChild(open);
  card.appendChild(foot);

  card.addEventListener('click', function () { openScene(s.id); });
  return card;
}

function openScene(id) {
  STATE.open = id;
  render();
}

/* ── ② 场景详情：固定五个面板 ──────────────────────────────────── */
function renderSceneDetail(id) {
  var sc = STATE.scenes.filter(function (s) { return s.id === id; })[0];
  if (!sc) { STATE.open = null; return render(); }

  var head = el('div', 'detail-head');
  var back = el('button', 'panel-btn', '← 场景');
  back.addEventListener('click', function () { STATE.open = null; render(); });
  head.appendChild(back);
  head.appendChild(el('div', 'detail-icon', sc.icon || '●'));
  var nm = el('div', 'detail-names');
  nm.appendChild(el('div', 'detail-name', sc.name));
  nm.appendChild(el('div', 'detail-duty', sc.duty || sc.description || ''));
  head.appendChild(nm);
  DOM.view.appendChild(head);

  // 固定面板组：身份卡 · 项目信息 · 索引 · 体检 · 会话
  var layout = [
    { id: id + '-id', title: '身份卡', sub: '每场读的那张卡', type: 'identity', col: 1, row: 1, w: 1, h: 5 },
    { id: id + '-mem', title: '项目信息', sub: '§〇 开场先读', type: 'memory', col: 2, row: 1, w: 1, h: 5 },
    { id: id + '-idx', title: '索引', sub: '场景索引 · 资产索引', type: 'indexmap', col: 3, row: 1, w: 1, h: 3 },
    { id: id + '-health', title: '体检', sub: '这个场景的', type: 'health', col: 3, row: 4, w: 1, h: 2 },
  ];
  // 会话面板：沿用场景配置里那个 harness 面板（带绑定）
  var ai = (sc.panels || []).filter(function (p) { return p.type === 'harness'; })[0];
  layout.push({
    id: (ai && ai.id) || id + '-chat',
    title: (ai && ai.title) || 'AI·' + sc.name,
    sub: '常驻会话',
    type: 'harness',
    col: 4, row: 1, w: 1, h: 5,
    expand: true,
    sessionId: (ai && ai.sessionId) || '',
    sessionTitle: (ai && ai.sessionTitle) || '',
    pinTarget: (ai && ai.pinTarget) || [sc.name],
  });

  var grid = el('div', 'panel-grid');
  grid.style.gridTemplateColumns = 'repeat(4, 1fr)';
  layout.forEach(function (p, i) {
    p.scenario = id;
    var built = mkPanel(p, i);
    grid.appendChild(built.wrap);
    var fn = window.APP_RENDERERS[p.type];
    if (!fn) { built.body.appendChild(el('div', 'todo-empty', '未知面板类型：' + p.type)); return; }
    try {
      var c = fn(built.body, p, built.head);
      if (typeof c === 'function') STATE.cleanups.push(c);
    } catch (err) {
      built.body.appendChild(el('div', 'todo-empty', '面板渲染失败：' + err.message));
      console.error('[panel ' + p.id + ']', err);
    }
  });
  DOM.view.appendChild(grid);
}

/* ── ③ 注册页 ──────────────────────────────────────────────────── */
function renderRegistry() {
  var wrap = el('div', 'registry');
  DOM.view.appendChild(wrap);

  var listBox = el('div', 'reg-list');
  wrap.appendChild(listBox);

  var form = el('div', 'reg-form');
  form.appendChild(el('div', 'reg-h', '登记一个新角色'));
  form.appendChild(el('div', 'reg-tip', '登记 = 建一个场景 + 它的记忆骨架（身份卡 / 项目信息）'));

  var f = {};
  [['name', '名字', '这个角色叫什么'], ['icon', '图标', '一个字符，如 ⌘ ◎ ⚙'],
   ['category', '分类', '归到哪一类，如 指挥 / 研究 / 运维'],
   ['duty', '一句话职责', '它负责什么（可观察、可判断）'],
   ['skills', '专属技能', '逗号分隔']].forEach(function (spec) {
    form.appendChild(el('label', 'disp-label', spec[1]));
    var i = el('input', 'disp-input');
    i.placeholder = spec[2];
    form.appendChild(i);
    f[spec[0]] = i;
  });
  var msg = el('div', 'disp-msg');
  var go = el('button', 'panel-btn solid', '登记');
  go.addEventListener('click', function () {
    var body = {
      name: f.name.value.trim(),
      icon: f.icon.value.trim() || '●',
      category: f.category.value.trim() || '其它',
      duty: f.duty.value.trim(),
      skills: f.skills.value.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean),
    };
    if (!body.name) { msg.className = 'disp-msg bad'; msg.textContent = '要名字'; return; }
    go.disabled = true;
    msg.textContent = '登记中…';
    api('POST', '/api/scenes/create', body).then(function (r) {
      go.disabled = false;
      if (r && r.ok) {
        msg.className = 'disp-msg ok';
        msg.textContent = '✓ 登记好了：' + r.id + '　去「场景」页点开它，再建一条会话';
        ['name', 'icon', 'category', 'duty', 'skills'].forEach(function (k) { f[k].value = ''; });
        refreshScenes();
      } else {
        msg.className = 'disp-msg bad';
        msg.textContent = '✗ ' + (r && (r.error || '没登记成'));
      }
    });
  });
  form.appendChild(go);
  form.appendChild(msg);
  wrap.appendChild(form);

  function renderList() {
    listBox.innerHTML = '';
    listBox.appendChild(el('div', 'reg-h', '已登记（' + STATE.scenes.length + '）'));
    STATE.scenes.forEach(function (s) {
      var row = el('div', 'reg-row');
      row.appendChild(el('span', 'reg-icon', s.icon || '●'));
      row.appendChild(el('span', 'reg-name', s.name));
      row.appendChild(el('span', 'reg-cat', s.category || ''));
      row.appendChild(el('span', 'reg-duty', s.duty || ''));
      var open = el('button', 'panel-btn', '打开');
      open.addEventListener('click', function () { STATE.mode = 'scenes'; openScene(s.id); });
      row.appendChild(open);
      listBox.appendChild(row);
    });
  }
  renderList();
}

/* ── ④ 工作台页 ────────────────────────────────────────────────── */
function renderDesk() {
  var grid = el('div', 'panel-grid');
  grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
  var layout = [
    { id: 'desk-dash', title: '仪表盘', sub: '状态 + 待办', type: 'dashboard', col: 1, row: 1, w: 3, h: 2 },
    { id: 'desk-dispatch', title: '派单台', sub: '四件套 · 真唤醒 · 台账', type: 'dispatch', col: 1, row: 3, w: 1, h: 3 },
    { id: 'desk-triage', title: '分诊', sub: '唯一对口 · 三个出口', type: 'triage', col: 2, row: 3, w: 1, h: 3 },
    { id: 'desk-auth', title: '权限与写痕', sub: '五档 · 越界 · 撞车', type: 'authority', col: 3, row: 3, w: 1, h: 3 },
  ];
  layout.forEach(function (p, i) {
    p.scenario = 'dispatch';
    var built = mkPanel(p, i);
    grid.appendChild(built.wrap);
    var fn = window.APP_RENDERERS[p.type];
    if (!fn) { built.body.appendChild(el('div', 'todo-empty', '未知面板类型：' + p.type)); return; }
    try {
      var c = fn(built.body, p, built.head);
      if (typeof c === 'function') STATE.cleanups.push(c);
    } catch (err) {
      built.body.appendChild(el('div', 'todo-empty', '面板渲染失败：' + err.message));
    }
  });
  DOM.view.appendChild(grid);
}

/* ── 面板外壳 ──────────────────────────────────────────────────── */
function mkPanel(p, idx) {
  var wrap = el('section', 'panel');
  wrap.setAttribute('data-panel-id', p.id);
  wrap.style.gridColumn = (p.col ? p.col + ' / span ' : 'span ') + (p.w || 1);
  wrap.style.gridRow = (p.row ? p.row + ' / span ' : 'span ') + (p.h || 1);

  var head = el('div', 'panel-head');
  head.appendChild(el('span', 'panel-badge', String(idx + 1).padStart(2, '0')));
  head.appendChild(el('span', 'panel-title', p.title || p.id));
  if (p.sub) head.appendChild(el('span', 'panel-sub', p.sub));

  var body = el('div', 'panel-body');
  body.setAttribute('data-kind', p.type);

  wrap.appendChild(head);
  wrap.appendChild(body);

  var exp = el('button', 'panel-expand', '▲');
  exp.title = '展开这个面板';
  exp.addEventListener('click', function (e) { e.stopPropagation(); toggleExpand(wrap, p); });
  head.appendChild(exp);

  return { wrap: wrap, head: head, body: body };
}

/* ── 展开 / 收起 ───────────────────────────────────────────────── */
var expandZ = 60;
function toggleExpand(wrap, p) {
  if (wrap.classList.contains('expanded')) collapsePanel(wrap);
  else expandPanel(wrap, p);
}
function expandPanel(wrap) {
  var grid = wrap.parentNode;
  var slot = el('div', 'panel-slot');
  slot.style.gridColumn = wrap.style.gridColumn;
  slot.style.gridRow = wrap.style.gridRow;
  grid.appendChild(slot);
  wrap.__slot = slot;

  var r = wrap.getBoundingClientRect();
  var gr = grid.getBoundingClientRect();
  wrap.classList.add('expanded');
  wrap.style.position = 'fixed';
  wrap.style.left = r.left + 'px';
  wrap.style.top = r.top + 'px';
  wrap.style.width = r.width + 'px';
  wrap.style.height = r.height + 'px';
  wrap.style.zIndex = String(++expandZ);
  requestAnimationFrame(function () {
    wrap.style.transition = 'left .32s, top .32s, width .32s, height .32s';
    wrap.style.left = gr.left + 'px';
    wrap.style.top = gr.top + 'px';
    wrap.style.width = gr.width + 'px';
    wrap.style.height = gr.height + 'px';
  });
  setTimeout(function () { wrap.style.transition = ''; }, 360);
}
function collapsePanel(wrap) {
  if (!wrap.classList.contains('expanded')) return;
  var slot = wrap.__slot;
  if (slot) {
    var r = slot.getBoundingClientRect();
    wrap.style.transition = 'left .28s, top .28s, width .28s, height .28s';
    wrap.style.left = r.left + 'px';
    wrap.style.top = r.top + 'px';
    wrap.style.width = r.width + 'px';
    wrap.style.height = r.height + 'px';
  }
  setTimeout(function () {
    wrap.classList.remove('expanded');
    wrap.style.position = '';
    wrap.style.left = ''; wrap.style.top = '';
    wrap.style.width = ''; wrap.style.height = '';
    wrap.style.zIndex = '';
    wrap.style.transition = '';
    if (wrap.__slot) { wrap.__slot.remove(); wrap.__slot = null; }
  }, 280);
}
function collapseAll() {
  Array.prototype.forEach.call(wbAll('.panel.expanded'), function (w) { collapsePanel(w); });
}

/* ── 通用动作对话框 ───────────────────────────────────────────── */
var DIALOG = null;

function closeDialog(result) {
  if (!DIALOG) return;
  var dlg = DIALOG;
  DIALOG = null;
  dlg.overlay.classList.remove('open');
  if (dlg.resolve) dlg.resolve(result);
}

function wbDialog(spec) {
  closeDialog(null);
  var overlay = document.createElement('div');
  overlay.className = 'dialog open';
  var card = document.createElement('div');
  card.className = 'dialog-card';
  overlay.appendChild(card);

  var h = document.createElement('h3');
  h.textContent = spec.title || '';
  card.appendChild(h);
  if (spec.desc) {
    var p = document.createElement('p');
    p.className = 'dialog-p';
    p.textContent = spec.desc;
    card.appendChild(p);
  }

  var inputs = {};
  (spec.fields || []).forEach(function (f) {
    var lab = document.createElement('label');
    lab.className = 'dialog-label';
    lab.textContent = f.label;
    card.appendChild(lab);
    var input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.className = 'dialog-textarea';
      input.rows = f.rows || 3;
    } else if (f.type === 'select') {
      input = document.createElement('select');
      input.className = 'dialog-input';
      (f.options || []).forEach(function (o) {
        var op = document.createElement('option');
        op.value = typeof o === 'string' ? o : o.value;
        op.textContent = typeof o === 'string' ? o : o.label;
        input.appendChild(op);
      });
    } else {
      input = document.createElement('input');
      input.className = 'dialog-input';
    }
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.value != null) input.value = f.value;
    card.appendChild(input);
    inputs[f.key] = input;
  });

  var msg = document.createElement('div');
  msg.className = 'dialog-msg';
  card.appendChild(msg);

  var actions = document.createElement('div');
  actions.className = 'dialog-actions';
  var cancel = document.createElement('button');
  cancel.className = 'chip';
  cancel.textContent = '取消';
  var submit = document.createElement('button');
  submit.className = 'chip solid';
  submit.textContent = spec.submitText || '确定';
  actions.appendChild(cancel);
  actions.appendChild(submit);
  card.appendChild(actions);

  wbRoot().appendChild(overlay);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDialog(null); });

  var promise = new Promise(function (resolve) { DIALOG = { overlay: overlay, resolve: resolve }; });
  cancel.addEventListener('click', function () { closeDialog(null); });

  submit.addEventListener('click', function () {
    var values = {};
    Object.keys(inputs).forEach(function (k) { values[k] = inputs[k].value; });
    if (spec.validate) {
      var bad = spec.validate(values);
      if (bad) { msg.textContent = bad; return; }
    }
    submit.disabled = true;
    msg.textContent = '执行中…';
    Promise.resolve(spec.onSubmit ? spec.onSubmit(values) : values).then(function (r) {
      closeDialog({ ok: true, values: values, result: r });
    }).catch(function (e) {
      submit.disabled = false;
      msg.textContent = '✗ ' + (e && e.message || e);
    });
  });

  return promise;
}
window.wbDialog = wbDialog;

function wbAction(spec) {
  if (!spec) return Promise.resolve(null);
  var call = function (url, body) {
    return fetch(wbUrl(url), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().then(function (j) {
      if (!r.ok || (j && j.ok === false)) throw new Error((j && (j.error || (j.errors && j.errors.join('；')))) || ('HTTP ' + r.status));
      return j;
    }); });
  };

  if (spec.kind === 'reload') return Promise.resolve({ ok: true });

  if (spec.kind === 'dispatch') {
    return wbDialog({
      title: '派单：' + (spec.topic || ''),
      desc: '四件套缺一件对方就得追问 —— 少一项就别发。',
      submitText: '派单（真唤醒）',
      fields: [
        { key: 'to', label: '发给谁（场景）', type: 'text', value: spec.to || '' },
        { key: 'topic', label: '主题（同一主题 = 同一条线）', type: 'text', value: spec.topic || '' },
        { key: 'symptom', label: '① 现象：现在是什么样子', type: 'textarea', placeholder: '可观察的，不要形容词' },
        { key: 'how', label: '② 照哪做：哪份文档的哪一节 / 哪个工具', type: 'textarea', placeholder: '唯一出处，别让对方再猜' },
        { key: 'verify', label: '③ 怎么验：做完跑哪个检查、看到什么算通过', type: 'textarea' },
        { key: 'reply', label: '④ 回一句：明确要回执', type: 'textarea', value: '我在等你的回执（结论+证据+落盘路径）' },
      ],
      validate: function (v) {
        var miss = [];
        if (!v.symptom.trim()) miss.push('现象');
        if (!v.how.trim()) miss.push('照哪做');
        if (!v.verify.trim()) miss.push('怎么验');
        if (!v.reply.trim()) miss.push('回一句');
        if (!v.to.trim()) miss.push('发给谁');
        return miss.length ? '还缺：' + miss.join('、') : '';
      },
      onSubmit: function (v) {
        return call('/api/dispatch', {
          from: spec.from || '', to: v.to, topic: v.topic,
          symptom: v.symptom, how: v.how, verify: v.verify, reply: v.reply,
        });
      },
    });
  }

  if (spec.kind === 'ack') {
    return wbDialog({
      title: '回执：' + (spec.topic || ''),
      desc: '回执必须带证据 —— 只说「好了」等于没说。',
      submitText: '投递回执',
      fields: [
        { key: 'conclusion', label: '结论（一句话）', type: 'text' },
        { key: 'evidence', label: '证据：跑了什么 / 几个通过 / 差异集合', type: 'textarea', rows: 3 },
        { key: 'path', label: '落盘：改了哪些文件', type: 'text' },
      ],
      validate: function (v) {
        return (!v.conclusion.trim() || !v.evidence.trim()) ? '结论和证据都要写' : '';
      },
      onSubmit: function (v) {
        return call('/api/dispatch/ack', { hash: spec.hash, conclusion: v.conclusion, evidence: v.evidence, path: v.path });
      },
    });
  }

  if (spec.kind === 'close') {
    return wbDialog({
      title: '销账：' + (spec.topic || ''),
      desc: '收尾知悉（最多 1 条）⇒ 这条线到这儿。',
      submitText: '销账',
      fields: [{ key: 'note', label: '备注（可空）', type: 'text' }],
      onSubmit: function () { return call('/api/dispatch/close', { hash: spec.hash, from: spec.from || '' }); },
    });
  }

  if (spec.kind === 'claim') {
    return wbDialog({
      title: '我自己做',
      desc: '自己做 ⇒ 台账落一行（原文要求）。',
      submitText: '认领',
      fields: [{ key: 'note', label: '备注（可空）', type: 'text' }],
      onSubmit: function (v) {
        return call('/api/dispatch/claim', { scene: spec.scene || '', text: spec.text || '', note: v.note || '' });
      },
    });
  }

  if (spec.kind === 'session.new') {
    return wbDialog({
      title: '建会话并绑定：' + (spec.scene || ''),
      desc: '建完会自动改名并写回场景 json 的三字段。',
      submitText: '建',
      fields: [{ key: 'title', label: '会话标题', type: 'text', value: spec.title || '' }],
      validate: function (v) { return v.title.trim() ? '' : '要有标题'; },
      onSubmit: function (v) { return call('/api/sessions/create', { scene: spec.scene, title: v.title }); },
    });
  }

  if (spec.kind === 'audit') {
    return call('/api/authority/audit').then(function (r) {
      var v = r.report.violations || [];
      var lines = v.length
        ? v.map(function (x) { return '⛔ [' + x.tier + '] ' + x.scene + ' → ' + x.path + '\n   ' + x.why; }).join('\n')
        : '✓ 没有越界。' + (r.report.touches || []).length + ' 次写入都在各自的地盘里。';
      return wbDialog({ title: '越界审计', desc: lines, submitText: '知道了', fields: [], onSubmit: function () { return { ok: true }; } });
    });
  }

  if (spec.kind === 'traces') {
    return call('/api/writes').then(function (r) {
      var f = (r.history.files || []).filter(function (x) { return !spec.path || x.path === spec.path; })[0];
      var lines = '（没有写痕）';
      if (f) {
        lines = f.writes.map(function (w) {
          return new Date(w.time || 0).toLocaleString('zh-CN') + '  ' + w.sceneName + '  ' + w.tool;
        }).join('\n');
        if (f.collisions && f.collisions.length) {
          lines += '\n\n撞车：\n' + f.collisions.map(function (c) {
            return (c.lostCount ? '⛔ 丢了 ' + c.lostCount + ' 行' : '同路径两个写入者')
              + '　' + c.byName + ' → ' + c.overName + (c.samples.length ? '\n   丢的是：' + c.samples.join(' / ') : '');
          }).join('\n');
        }
      }
      return wbDialog({ title: '写痕：' + (spec.path || '全部'), desc: lines, submitText: '知道了', fields: [], onSubmit: function () { return { ok: true }; } });
    });
  }

  if (spec.kind === 'memory') {
    return wbDialog({
      title: '记忆：' + (spec.file || ''),
      desc: '超了 4KB 就是红线 —— 覆盖写，别追加。',
      submitText: '保存',
      fields: [{ key: 'text', label: '内容', type: 'textarea', rows: 8 }],
      onSubmit: function (v) {
        return call('/api/memory', { scene: spec.scene, file: spec.file, text: v.text });
      },
    });
  }

  return Promise.resolve(null);
}
window.wbAction = wbAction;

/* ── 引擎状态 ──────────────────────────────────────────────────── */
function setEngineStatus(up, text) {
  STATE.engineUp = up;
  DOM.dot.className = 'status-dot ' + (up ? 'ok' : 'bad');
  DOM.status.textContent = text;
}

/* ── 启动 ──────────────────────────────────────────────────────── */
function refreshScenes() {
  return api('GET', '/api/state').then(function (r) {
    if (!r || !r.ok) return;
    STATE.scenes = r.scenes || [];
    STATE.panelPorts = r.panelPorts || [];
    setEngineStatus(!!(r.engine && r.engine.up), r.engine && r.engine.up ? '引擎已连' : '引擎未连');
    render();
  });
}

/** 顶栏的样子（独立页的 index.html 与插件挂载共用同一份，免得两处走样）。 */
function wbShellHtml() {
  return [
    '<header id="topbar">',
    '  <div class="brand"><span class="brand-mark">◈</span><span class="brand-name">我的工作台</span></div>',
    '  <nav id="mainnav">',
    '    <button class="navbtn active" data-mode="scenes">场景</button>',
    '    <button class="navbtn" data-mode="registry">注册</button>',
    '    <button class="navbtn" data-mode="desk">工作台</button>',
    '  </nav>',
    '  <div class="top-right"><span id="status-dot" class="status-dot"></span><span id="status-text">连接中…</span></div>',
    '</header>',
    '<main id="view"></main>',
    '<div id="toast-host"></div>',
  ].join('\n');
}

/**
 * 把工作台挂进一个容器。
 *
 * 独立页：mount(document.body)
 * 插件：  mount(插件给的 div, { base: '/workbench' })
 *
 * 返回一个 dispose 函数（插件卸载时调）。
 */
function mountWorkbench(root, opts) {
  opts = opts || {};
  if (opts.base != null) WB_BASE = opts.base;
  window.__WB_BASE = WB_BASE;

  var prevRoot = window.__WB_ROOT_EL;
  window.__WB_ROOT_EL = root;

  // 壳：顶栏 + 视图区 + toast 容器
  root.innerHTML = wbShellHtml();
  // root 可能是 ShadowRoot（没有 classList）⇒ 样式挂在宿主元素上
  var hostEl = (root && root.host) ? root.host : root;
  if (hostEl && hostEl.classList) hostEl.classList.add('wb-host');

  // 样式：嵌在 shadow root 里时由装载方交进来（innerHTML 赋值会清掉先前挂的东西，
  // 所以样式必须在这里、赋值之后放）。
  if (opts.css) {
    var style = document.createElement('style');
    style.textContent = opts.css;
    root.insertBefore(style, root.firstChild);
  }

  DOM.view = root.querySelector('#view');
  DOM.dot = root.querySelector('#status-dot');
  DOM.status = root.querySelector('#status-text');

  Array.prototype.forEach.call(root.querySelectorAll('#mainnav .navbtn'), function (b) {
    b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
  });

  function onKey(e) {
    if (e.key === 'Escape') collapseAll();
  }
  document.addEventListener('keydown', onKey);

  refreshScenes();
  var timer = setInterval(function () {
    fetch(wbUrl('/api/engine/status')).then(function (r) { return r.json(); }).then(function (r) {
      if (r && r.engine) setEngineStatus(!!r.engine.up, r.engine.up ? '引擎已连' : '引擎未连');
    }).catch(function () { /* ignore */ });
  }, 5000);

  return function dispose() {
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    cleanupPanels();
    root.innerHTML = '';
    window.__WB_ROOT_EL = prevRoot;
  };
}

/**
 * 对外接口：插件靠它把工作台挂进 DSH 界面的主区。
 */
window.WB = {
  mount: mountWorkbench,
  base: function () { return WB_BASE; },
};

/* 独立页：页面上已经有壳 ⇒ 直接挂。插件装载时这页没有 #view ⇒ 不自动启动。 */
function bootStandalone() {
  if (!document.getElementById('view')) return false;
  mountWorkbench(document.body);
  return true;
}

if (!window.__WB_MANUAL_BOOT) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootStandalone);
  else bootStandalone();
}
