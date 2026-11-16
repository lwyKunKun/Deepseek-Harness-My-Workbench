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
  selected: '',          // 场景页左树里选中的角色（右边显示它的卡）
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
/* ── ① 场景页：左树 + 右卡 ───────────────────────────────────────
 * 照着视频里那版「场景-记忆机制（记忆文件+索引）-界面」做的：
 *   左边一列 = 场景树（分类是枝，角色是叶）
 *   右边     = 选中角色的「面板卡」（身份卡 / 项目信息 / 索引 / 体检 / AI 会话）
 * 点左边树里的角色 ⇒ 右边换成它的卡。
 */
var CAT_OPEN_KEY = 'wb.cat.open';

function catalogOpen() {
  try { return JSON.parse(localStorage.getItem(CAT_OPEN_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function setCatalogOpen(cat, on) {
  var s = catalogOpen();
  if (on) s[cat] = 1; else delete s[cat];
  try { localStorage.setItem(CAT_OPEN_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  render();
}

/** 场景按分类分组（分类名排序，稳）。 */
function groupByCategory() {
  var map = {};
  var order = [];
  STATE.scenes.forEach(function (s) {
    var c = s.category || '未分类';
    if (!map[c]) { map[c] = { name: c, scenes: [] }; order.push(c); }
    map[c].scenes.push(s);
  });
  // ⚠ 分类顺序 = 各分类**第一个成员在总顺序里的位置**（不按名字排）
  //   ⇒ 拖动一个角色到别的分类下，那个分类会跟着挪位置。
  return order.map(function (c) { return map[c]; });
}

/** 当前选中的角色（默认第一个）。 */
function selectedSceneId() {
  var ids = STATE.scenes.map(function (s) { return s.id; });
  if (STATE.selected && ids.indexOf(STATE.selected) >= 0) return STATE.selected;
  return ids[0] || '';
}

function renderCatalog() {
  var groups = groupByCategory();
  var layout = el('div', 'cat-layout');

  /* ── 左：场景树 ────────────────────────────────────────────── */
  var side = el('div', 'cat-side');
  var sideHead = el('div', 'cat-side-head');
  sideHead.appendChild(el('div', 'cat-side-title', '工作台 · 场景'));
  sideHead.appendChild(el('div', 'cat-side-count', STATE.scenes.length + ' 个场景'));
  side.appendChild(sideHead);

  var tree = el('div', 'side-tree');
  var sel = selectedSceneId();
  var open = catalogOpen();
  groups.forEach(function (g) {
    var isOpen = open[g.name] === undefined ? true : !!open[g.name];
    var branch = el('div', 'side-branch');

    var bh = el('div', 'side-branch-head');
    bh.appendChild(el('span', 'side-twisty', isOpen ? '▾' : '▸'));
    bh.appendChild(el('span', 'side-cat', g.name));
    bh.appendChild(el('span', 'side-count', String(g.scenes.length)));
    bh.addEventListener('click', function () {
      if (Date.now() - DRAG.at < 300) return;      // 刚拖完，别当成点击
      setCatalogOpen(g.name, !isOpen);
    });
    // 拖到分类标题上 ⇒ 落到这个分类的末尾（分类会跟着变）
    makeDropTarget(bh, g.name, true);
    // ★ 分类本身也能拖（分类的顺序 = 它第一个成员的位置）
    makeDraggable(bh, 'cat:' + g.name);
    // 分类的右键菜单：改名 / 删除这个分类下的角色
    wbBindMenu(bh, [
      { id: 'rename-cat', label: '改分类名…' },
      { separator: true },
      { id: 'delete-cat', label: '删掉这个分类', danger: true,
        hint: '只删分类（角色移到「未分类」），角色本身不删' },
    ], function (what) {
      if (what === 'rename-cat') renameCategory(g);
      else if (what === 'delete-cat') deleteCategory(g);
    });
    branch.appendChild(bh);

    if (isOpen) {
      var kids = el('div', 'side-kids');
      g.scenes.forEach(function (s) { kids.appendChild(sideLeaf(s, s.id === sel)); });
      branch.appendChild(kids);
    }
    tree.appendChild(branch);
  });
  side.appendChild(tree);
  layout.appendChild(side);

  /* ── 右：选中角色的面板卡 ────────────────────────────────────── */
  layout.appendChild(renderSceneCards(sel));
  DOM.view.appendChild(layout);
}

/* ── 拖拽排序：左树里把角色拖来拖去 ──────────────────────────────
 * 规则（跟文件管理器一个脾气）：
 *   · 拖到某个角色上   ⇒ 插到它前面 / 后面（看指针在上半还是下半）
 *   · 拖到某个分类上   ⇒ 落到那个分类的末尾（**分类也会跟着变**）
 *   · 分类的顺序       = 各分类第一个成员在总顺序里的位置（自动跟着走）
 *
 * 存哪儿：data/scene-order.json（服务端 loadScenes() 会按它排）。
 */
var DRAG = { id: '', at: 0 };

function markDrop(el, mode) {
  clearDropMarks();
  el.classList.add('drop-' + mode);
}
function clearDropMarks() {
  var root = DOM.view;
  if (!root) return;
  root.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(function (e) {
    e.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
}

/** 让一个元素可以当拖拽源。 */
function makeDraggable(el, id) {
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', function (e) {
    DRAG.id = id;
    DRAG.at = Date.now();
    el.classList.add('dragging');
    var tree = el.closest ? el.closest('.side-tree') : null;
    if (tree) tree.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    } catch (err) { /* ignore */ }
  });
  el.addEventListener('dragend', function () {
    el.classList.remove('dragging');
    var tree = el.closest ? el.closest('.side-tree') : null;
    if (tree) tree.classList.remove('dragging');
    clearDropMarks();
    DRAG.id = '';
  });
}

/**
 * 让一个元素可以接收放下。
 *
 * ⚠ 层级规则（机主定的）：
 *   · 一级菜单（分类）拖 ⇒ **只能换位置**，永远是枝，不会变成别人的二级。
 *     所以分类落在分类上 = 「两个分类换先后」，不是「降级」。
 *   · 二级菜单（角色）拖 ⇒ 随意：落分类上 = 加入该分类；
 *     落角色上/下 = 换顺序；拖到别的分类的分类上 = 也只是换先后。
 */
function makeDropTarget(el, targetId, isBranch) {
  el.addEventListener('dragover', function (e) {
    if (!DRAG.id || DRAG.id === targetId) return;
    // 拖分类落到分类上 ⇒ 不给「into」的语义（那是「加入」），只给 before/after
    var draggingCat = DRAG.id.indexOf('cat:') === 0;
    if (draggingCat && isBranch) {
      // 分类标题：按上下半区 ⇒ before / after（换先后）
      e.preventDefault();
      e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
      var r0 = el.getBoundingClientRect();
      markDrop(el, (e.clientY < r0.top + r0.height / 2) ? 'before' : 'after');
      return;
    }
    e.preventDefault();                       // 不 preventDefault 就不许放
    e.stopPropagation();
    try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
    var r = el.getBoundingClientRect();
    if (isBranch) { markDrop(el, 'into'); return; }
    markDrop(el, (e.clientY < r.top + r.height / 2) ? 'before' : 'after');
  });
  el.addEventListener('dragleave', function (e) {
    if (el.contains(e.relatedTarget)) return;
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
  el.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var dragged = DRAG.id;
    var mode = el.classList.contains('drop-before') ? 'before'
      : el.classList.contains('drop-after') ? 'after' : 'into';
    clearDropMarks();
    DRAG.id = '';
    if (!dragged || dragged === targetId) return;
    moveScene(dragged, targetId, mode);
  });
}

/** 真的挪：算新顺序 → 存 → 刷。 */
function moveScene(draggedId, targetId, mode) {
  // 拖的是**分类**（id 形如 'cat:阅读'）⇒ 整个分类一起挪
  if (draggedId.indexOf('cat:') === 0) {
    return moveCategory(draggedId.slice(4), targetId, mode);
  }
  var order = STATE.scenes.map(function (s) { return s.id; });
  var from = order.indexOf(draggedId);
  if (from < 0) return;
  order.splice(from, 1);

  var idx;
  var newCat = null;
  if (mode === 'into') {
    // 落到某个分类的末尾（目标可能是分类名，也可能是场景 id）
    var cat = targetId;
    var ts = STATE.scenes.filter(function (s) { return s.id === targetId; })[0];
    if (ts) cat = ts.category || '未分类';
    var last = -1;
    order.forEach(function (id, i) {
      var sc = STATE.scenes.filter(function (s) { return s.id === id; })[0];
      if (sc && (sc.category || '未分类') === cat) last = i;
    });
    idx = last + 1;
    // 拖到别的分类 ⇒ 分类也得改（写回场景配置）
    var dragged = STATE.scenes.filter(function (s) { return s.id === draggedId; })[0];
    if (dragged && (dragged.category || '未分类') !== cat) newCat = cat;
  } else {
    var t = order.indexOf(targetId);
    if (t < 0) return;
    idx = mode === 'before' ? t : t + 1;
  }
  order.splice(idx, 0, draggedId);

  var save = api('POST', '/api/scene/order', { ids: order });
  if (newCat) {
    save = save.then(function () {
      return api('POST', '/api/scene/category', { id: draggedId, category: newCat });
    });
  }
  save.then(function () { return refreshScenes(); })
    .then(function () { wbToast('顺序已保存'); })
    .catch(function (e) { wbToast('没挪成：' + (e && e.message || e), true); });
}

/**
 * 挪一个**分类**（连带它下面所有角色）。
 *
 * 分类在界面上是「枝」，它没有自己的行 —— 它的位置 = 它第一个成员在总顺序里的位置。
 * 所以拖分类 = 把它的成员当成一整块，插到目标位置。
 */
function moveCategory(catName, targetId, mode) {
  var members = STATE.scenes.filter(function (s) { return (s.category || '未分类') === catName; });
  if (!members.length) return;

  // ⛔ 一级菜单（分类）**只能换位置**，永远是一级菜单。
  //   拖到别的分类上 ⇒ 是「这两个分类换先后」，**不是**「这个分类降级成别人的二级」。
  //   所以：分类之间拖 ⇒ 只动顺序，成员的 category 一个都不改。
  var memberIds = members.map(function (s) { return s.id; });
  var order = STATE.scenes.map(function (s) { return s.id; });
  var rest = order.filter(function (id) { return memberIds.indexOf(id) < 0; });

  var idx;
  var targetCat = null;
  if (mode === 'into') {
    // 落到某个分类（分类标题）⇒ 排到它后面
    targetCat = targetId.indexOf('cat:') === 0 ? targetId.slice(4) : targetId;
    var last = -1;
    rest.forEach(function (id, i) {
      var sc = STATE.scenes.filter(function (s) { return s.id === id; })[0];
      if (sc && (sc.category || '未分类') === targetCat) last = i;
    });
    idx = last + 1;
  } else {
    // 落到某个角色上 ⇒ 排到它前面/后面（角色不动）
    var t = rest.indexOf(targetId);
    if (t < 0) {
      // 落到的是**分类标题**（targetId = 分类名）⇒ 排到那个分类的前/后
      var tCat = targetId.indexOf('cat:') === 0 ? targetId.slice(4) : targetId;
      var first = -1;
      rest.forEach(function (id, i) {
        var sc = STATE.scenes.filter(function (s) { return s.id === id; })[0];
        if (first < 0 && sc && (sc.category || '未分类') === tCat) first = i;
      });
      if (first < 0) return;
      idx = mode === 'before' ? first : first + 1;
      if (mode === 'after') {
        // 「after」= 排在那个分类**整块之后**
        var end = first;
        rest.forEach(function (id, i) {
          var sc = STATE.scenes.filter(function (s) { return s.id === id; })[0];
          if (sc && (sc.category || '未分类') === tCat) end = i;
        });
        idx = end + 1;
      }
    } else {
      idx = mode === 'before' ? t : t + 1;
    }
  }

  var next = rest.slice(0, idx).concat(memberIds, rest.slice(idx));
  api('POST', '/api/scene/order', { ids: next })
    .then(function () { return refreshScenes(); })
    .then(function () { wbToast('「' + catName + '」挪好了'); })
    .catch(function (e) { wbToast('没挪成：' + (e && e.message || e), true); });
}

/** 树上的一个叶子 = 一个角色。 */
function sideLeaf(s, active) {
  var row = el('div', 'side-leaf' + (active ? ' active' : ''));
  row.setAttribute('data-sc-id', s.id);
  row.appendChild(el('span', 'side-dot', s.icon || '●'));
  row.appendChild(el('span', 'side-leaf-name', s.name));
  if (s.projectRoot) {
    var mark = el('span', 'scene-proj', '📁');
    mark.title = '项目目录：' + s.projectRoot;
    row.appendChild(mark);
  }
  var del = el('button', 'side-del', '🗑');
  del.title = '删除这个场景';
  del.setAttribute('aria-label', '删除场景「' + s.name + '」');
  del.addEventListener('click', function (e) { e.stopPropagation(); confirmDeleteScene(s); });
  row.appendChild(del);
  row.addEventListener('click', function () {
    if (Date.now() - DRAG.at < 300) return;      // 刚拖完，别当成点击
    STATE.selected = s.id;
    render();
  });
  makeDraggable(row, s.id);
  makeDropTarget(row, s.id, false);
  // 右键菜单：改名 / 换分类 / 删除
  wbBindMenu(row, [
    { id: 'rename', label: '改名…' },
    { id: 'category', label: '换分类…' },
    { separator: true },
    { id: 'delete', label: '删除这个场景', danger: true },
  ], function (what) {
    if (what === 'rename') renameScene(s);
    else if (what === 'category') changeCategory(s);
    else if (what === 'delete') confirmDeleteScene(s);
  });
  return row;
}

/* ── 右键菜单的动作：改名 / 换分类 ──────────────────────────────── */

/** 改分类名 ⇒ 该分类下所有场景的 category 都跟着改。 */
function renameCategory(g) {
  var old = g.name;
  wbDialog({
    title: '改分类名：' + old,
    desc: '这个分类下有 ' + g.scenes.length + ' 个角色，它们的分类会一起改成新名字。',
    submitText: '改好了',
    fields: [{ key: 'name', label: '新分类名', type: 'text', value: old }],
    onSubmit: function (v) {
      var name = String(v.name || '').trim();
      if (!name) throw new Error('分类名不能空');
      if (name === old) return { ok: true };
      // 一个一个改（分类改名不是批量接口，但每个角色都有 /api/scene/category）
      return g.scenes.reduce(function (chain, sc) {
        return chain.then(function () {
          return api('POST', '/api/scene/category', { id: sc.id, category: name });
        });
      }, Promise.resolve()).then(function () {
        wbToast('分类改成「' + name + '」了');
        return refreshScenes();
      });
    },
  });
}

/** 删分类 ⇒ 角色移到「未分类」（角色本身留着）。 */
function deleteCategory(g) {
  wbDialog({
    title: '删掉分类「' + g.name + '」',
    desc: '这个分类下有 ' + g.scenes.length + ' 个角色。\n'
      + '它们会移到「未分类」，**角色本身不会删**。',
    submitText: '删分类',
    fields: [],
    onSubmit: function () {
      return g.scenes.reduce(function (chain, sc) {
        return chain.then(function () {
          return api('POST', '/api/scene/category', { id: sc.id, category: '未分类' });
        });
      }, Promise.resolve()).then(function () {
        wbToast('分类删了，角色移到「未分类」');
        return refreshScenes();
      });
    },
  });
}

function renameScene(s) {
  wbDialog({
    title: '改名：' + s.name,
    desc: '改的是场景的名字（' + s.id + '）。分类和职责不动。',
    submitText: '改好了',
    fields: [{ key: 'name', label: '新名字', type: 'text', value: s.name || '' }],
    onSubmit: function (v) {
      var name = String(v.name || '').trim();
      if (!name) throw new Error('名字不能空');
      if (name === s.name) return { ok: true };
      return api('POST', '/api/scene/rename', { id: s.id, name: name }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '改名失败');
        wbToast('改成「' + r.name + '」了');
        return refreshScenes();
      });
    },
  });
}

function changeCategory(s) {
  // 分类列表 = 现有的分类 + 新的一个
  var cats = [];
  STATE.scenes.forEach(function (x) {
    var c = x.category || '未分类';
    if (cats.indexOf(c) < 0) cats.push(c);
  });
  if (cats.indexOf('未分类') < 0) cats.push('未分类');
  wbDialog({
    title: '换分类：' + s.name,
    desc: '换一个分类（也可以直接把它拖到别的分类标题上）。',
    submitText: '换',
    fields: [{
      key: 'category', label: '分类', type: 'select',
      options: cats.map(function (c) { return { value: c, label: c }; }),
      value: s.category || '未分类',
    }],
    onSubmit: function (v) {
      var cat = String(v.category || '').trim() || '未分类';
      if (cat === (s.category || '未分类')) return { ok: true };
      return api('POST', '/api/scene/category', { id: s.id, category: cat }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '换分类失败');
        wbToast('移到「' + cat + '」了');
        return refreshScenes();
      });
    },
  });
}

/* ── 删除场景：先看清楚要删什么，再让它删 ──────────────────────── */
function confirmDeleteScene(s) {
  var ai = (s.panels || []).filter(function (p) { return p.type === 'harness' && p.sessionId; });
  wbDialog({
    title: '删除场景「' + s.name + '」',
    desc: '会删掉：'
      + '\n· 场景配置（scenarios/' + s.id + '.json）'
      + '\n· 它的全部记忆（memory/' + s.id + '/）'
      + '\n· 地盘表里它的登记'
      + (ai.length ? '\n· 它的常驻会话会**归档**（引擎没有删除接口 ⇒ 归档 = 从侧栏收起来，数据还在）' : '')
      + '\n\n记忆会**移到回收站**（data/trash/），拷回去就能还原。'
      + '\n台账、写痕、回执这些**历史记录不会删**。',
    submitText: '确认删除',
    fields: [],
    onSubmit: function () {
      return api('POST', '/api/scenes/delete', { id: s.id }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '删除失败');
        var bits = [];
        if (r.files) bits.push(r.files + ' 个记忆文件');
        if (r.todoRows) bits.push(r.todoRows + ' 条待办');
        if (r.sessions && r.sessions.length) bits.push(r.sessions.length + ' 条会话已归档');
        if (r.warnings && r.warnings.length) bits.push(r.warnings.length + ' 条警告');
        if (r.trash) bits.push('已移到 ' + r.trash + '（可还原）');
        if (STATE.selected === s.id) STATE.selected = '';
        return refreshScenes().then(function () {
          wbToast('已删除「' + r.name + '」' + (bits.length ? '（' + bits.join('、') + '）' : ''));
          return { ok: true };
        });
      });
    },
  });
}

/** 字节数 → 人看的单位。 */
function kb(bytes) {
  var n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  return (Math.round(n / 1024 * 10) / 10) + 'K';
}

/** 一张面板卡的壳子（内容稍后填）。 */
function panelCard(title, sub) {
  var card = el('div', 'panel-card');
  var head = el('div', 'panel-card-head');
  head.appendChild(el('div', 'panel-card-title', title));
  head.appendChild(el('div', 'panel-card-sub', sub || ''));
  card.appendChild(head);
  var body = el('div', 'panel-card-body');
  body.appendChild(el('div', 'panel-card-empty', '读取中…'));
  card.appendChild(body);
  card.body = body;         // 方便后面填内容
  return card;
}

/** 把一段文字塞进卡片（按行截断，最多 maxLines 行）。 */
function fillCard(card, text, maxLines) {
  if (!card || !card.body) return;
  card.body.innerHTML = '';
  var lines = String(text || '').split('\n').filter(function (l) { return l.trim() !== ''; });
  if (!lines.length) {
    card.body.appendChild(el('div', 'panel-card-empty', '（还没有内容）'));
    return;
  }
  lines.slice(0, maxLines || 9).forEach(function (l) {
    card.body.appendChild(el('div', 'panel-card-line', l.replace(/^#+\s*/, '')));
  });
  if (lines.length > (maxLines || 9)) {
    card.body.appendChild(el('div', 'panel-card-more', '… 还有 ' + (lines.length - (maxLines || 9)) + ' 行'));
  }
}

/** 右栏：选中角色的五张卡。 */
function renderSceneCards(id) {
  var sc = STATE.scenes.filter(function (s) { return s.id === id; })[0];
  var main = el('div', 'cat-main');
  if (!sc) {
    main.appendChild(el('div', 'todo-empty', '还没有角色 —— 去「注册」登记一个'));
    return main;
  }

  /* 头部：角色是谁 */
  var head = el('div', 'cat-main-head');
  head.appendChild(el('div', 'cat-main-icon', sc.icon || '●'));
  var nm = el('div', 'cat-main-names');
  nm.appendChild(el('div', 'cat-main-name', sc.name));
  nm.appendChild(el('div', 'cat-main-duty', sc.duty || sc.description || ''));
  head.appendChild(nm);
  if (sc.skills && sc.skills.length) {
    var tags = el('div', 'cat-main-tags');
    sc.skills.forEach(function (t) { tags.appendChild(el('span', 'cat-main-tag', t)); });
    head.appendChild(tags);
  }
  main.appendChild(head);

  /* 四张摘要卡：身份卡 · 项目信息 · 索引 · AI 会话 */
  var grid = el('div', 'panel-card-grid');
  var cId = panelCard('身份卡', '每场读的那张卡');
  var cMem = panelCard('项目信息', '§〇 开场先读');
  var cIdx = panelCard('索引', '场景索引 · 资产索引');
  var cAi = panelCard('AI 会话', '常驻会话');
  [cId, cMem, cIdx, cAi].forEach(function (c) { grid.appendChild(c); });
  main.appendChild(grid);

  /* 填内容（异步，取完再填） */
  api('GET', '/api/memory?scene=' + encodeURIComponent(id)).then(function (r) {
    if (!r || !r.ok) { fillCard(cId, '（读不到）'); return; }
    fillCard(cId, (r.card || '').replace(/^#.*\n/, '').trim(), 10);
    var sec0 = String(r.main || '').split(/^##\s*§〇.*$/m)[1] || '';
    fillCard(cMem, sec0.trim(), 9);
  });

  api('GET', '/api/index').then(function (r) {
    if (!r || !r.ok) return;
    var rows = (r.rows || []).filter(function (x) {
      return x.kind === '场景' ? x.key === id : (x.kind === '资产' && String(x.key).indexOf(id + '/') === 0);
    });
    var lines = rows.map(function (x) {
      return x.name + '　' + x.where + '　' + kb(x.size);
    });
    fillCard(cIdx, lines.join('\n'), 9);
  });

  /* AI 会话那张卡：会话信息 + 打开按钮（真会话界面太大，嵌不进卡片） */
  var ai = (sc.panels || []).filter(function (p) { return p.type === 'harness'; })[0];
  cAi.body.innerHTML = '';
  if (ai && ai.sessionId) {
    cAi.body.appendChild(el('div', 'panel-card-line', '会话：' + (ai.sessionTitle || '（未命名）')));
    cAi.body.appendChild(el('div', 'panel-card-line', ai.sessionId));
    cAi.body.appendChild(el('div', 'panel-card-line', '工作目录：' + (sc.territory || 'memory/' + id + '/')));
  } else {
    cAi.body.appendChild(el('div', 'panel-card-empty', '还没绑常驻会话 —— 去场景里建一条'));
  }
  // 「打开对话」⇒ 直接把那条常驻会话摆出来（不再跳到另一个页面）
  var go = el('button', 'panel-btn solid', '打开对话');
  go.addEventListener('click', function () { openChat(sc); });
  cAi.body.appendChild(go);

  return main;
}

function openScene(id) {
  STATE.open = id;
  render();
}

/**
 * 把某个角色的常驻会话摆出来（AI 会话卡的「打开对话」）。
 * 场景页右区从「摘要卡」切成「真会话面板」。
 */
function openChat(sc) {
  var ai = (sc.panels || []).filter(function (p) { return p.type === 'harness'; })[0];
  if (!ai || !ai.sessionId) {
    wbToast('这个角色还没绑常驻会话 —— 去场景里建一条');
    return;
  }
  // ⚠ 不走 render()：那会把右区整个重建（摘要卡先闪一下再换掉）。
  //   直接把右区换成会话面板。
  var host = wbRoot();
  var view = host.querySelector('#view');
  if (!view) return;
  var main = view.querySelector('.cat-main');
  if (!main) return;
  cleanupPanels();          // 收掉摘要卡那一堆面板（不重画）
  main.innerHTML = '';
  var head = el('div', 'cat-main-head');
  var back = el('button', 'panel-btn', '← 摘要');
  back.addEventListener('click', function () { STATE.open = null; render(); });
  head.appendChild(back);
  head.appendChild(el('div', 'cat-main-icon', sc.icon || '●'));
  var nm = el('div', 'cat-main-names');
  nm.appendChild(el('div', 'cat-main-name', (ai.title || 'AI·' + sc.name)));
  nm.appendChild(el('div', 'cat-main-duty', '常驻会话 · ' + ai.sessionId));
  head.appendChild(nm);
  main.appendChild(head);

  var grid = el('div', 'panel-grid');
  grid.style.gridTemplateColumns = '1fr';
  var p = {
    id: ai.id, title: ai.title || 'AI·' + sc.name, sub: '常驻会话',
    type: 'harness', col: 1, row: 1, w: 1, h: 8, expand: true,
    sessionId: ai.sessionId, sessionTitle: ai.sessionTitle, pinTarget: ai.pinTarget,
    scenario: sc.id,
  };
  var built = mkPanel(p, 0);
  grid.appendChild(built.wrap);
  main.appendChild(grid);
  var fn = window.APP_RENDERERS.harness;
  if (fn) {
    try {
      var c = fn(built.body, p, built.head);
      if (typeof c === 'function') STATE.cleanups.push(c);
    } catch (err) {
      built.body.appendChild(el('div', 'todo-empty', '面板渲染失败：' + err.message));
    }
  }
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
  // 详情页也放一个删除入口（卡片上的那个太小，详情页是「认真操作」的地方）
  var del = el('button', 'panel-btn danger', '删除场景');
  del.addEventListener('click', function () { confirmDeleteScene(sc); });
  head.appendChild(del);
  DOM.view.appendChild(head);

  // 固定面板组：身份卡 · 项目信息 · 索引 · 体检 · 项目目录 · 会话
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
    col: 4, row: 1, w: 1, h: 3,
    expand: true,
    sessionId: (ai && ai.sessionId) || '',
    sessionTitle: (ai && ai.sessionTitle) || '',
    pinTarget: (ai && ai.pinTarget) || [sc.name],
  });
  // 项目目录：把真实磁盘上的文件夹挂到这个角色上（AI 在那儿写代码）
  layout.push({
    id: id + '-proj',
    title: '项目目录',
    sub: '真实磁盘 · AI 在这儿写代码',
    type: 'project',
    col: 4, row: 4, w: 1, h: 2,
    scene: id,
  });
  // 书架：角色的仓库目录若是 Obsidian 库 ⇒ 挂「书架」面板（读真实 md）
  var sc2 = STATE.scenes.filter(function (x) { return x.id === id; })[0];
  if (sc2 && sc2.projectRoot) {
    layout.push({
      id: id + '-shelf',
      title: '书架',
      sub: 'Obsidian 书库',
      type: 'bookshelf',
      col: 1, row: 6, w: 3, h: 5,
      scene: id,
      dir: '05-Bookshelf/书籍list',
    });
  }

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
    // ↓ 这三个原来挂在「运维」角色上（会话管理 / 文件 / 三类活分流）——
    //   运维这个角色删掉了，工具不能跟着没 ⇒ 挪到工作台页自己身上。
    { id: 'desk-sessions', title: '会话管理', sub: '新建 / 钉会话', type: 'sessions', col: 1, row: 6, w: 1, h: 3, bind: true },
    { id: 'desk-files', title: '文件', sub: '工作台目录内', type: 'file', col: 2, row: 6, w: 1, h: 3, root: '.' },
    { id: 'desk-gpu', title: '三类活分流', sub: '该不该上 GPU', type: 'gputriage', col: 3, row: 6, w: 1, h: 3 },
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
