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
  categories: [],        // 分类注册表（名字 + 顺序）—— 空分类也在这儿
  mode: 'scenes',        // scenes | registry | desk
  open: null,            // 打开的场景 id（详情页）
  selected: '',          // 场景页左树里选中的角色（右边显示它的卡）
  category: '全部',
  regCat: '',            // 注册页：记住上次选的分类（登记成功会重画表单 ⇒ 得记着）
  regMsg: null,          // 注册页：上次的提示（重画会把节点换掉 ⇒ 得记着，否则看不见）
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
  // ⚠ 折叠要**存 0**，不能删键 —— 读取时缺键默认「展开」，
  //   删了就等于没记下来，点分类头会立刻弹回去（点了跟没点一样）。
  s[cat] = on ? 1 : 0;
  try { localStorage.setItem(CAT_OPEN_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  render();
}

/* ── 左树有两个视图 ────────────────────────────────────────────────
 *   角色 = 分类 → 角色（谁在干活）
 *   项目 = 磁盘目录 → 谁绑了它（地在哪）
 * 两者是**引用**关系，不是包含关系 —— 一个目录可以绑给好几个角色，
 * 一个角色也可以只管记忆目录不碰真实磁盘。
 *
 * 为什么非得拆开：磁盘上「总项目」这个目录恰好是 campus-app 等五个
 * 目录的**父目录**。按角色各挂一棵 ⇒ 同一份磁盘被复制成六七棵大树，
 * 视角被文件淹没，角色和目录长得又一样（同名同图标）⇒ 谁都认不出。
 */
var TREE_VIEW_KEY = 'wb.tree.view';
function treeView() {
  try {
    var v = String(localStorage.getItem(TREE_VIEW_KEY) || '');
    return v === 'projects' ? 'projects' : 'roles';
  } catch (e) { return 'roles'; }
}
function setTreeView(v) {
  try { localStorage.setItem(TREE_VIEW_KEY, v === 'projects' ? 'projects' : 'roles'); } catch (e) { /* ignore */ }
  render();
}

/* 项目视图的临时状态（不进场景配置）：
 *   focus  = 当前所在的目录（面包屑显示它，搜索默认在它底下找）
 *   locate = 要定位到的目录（从角色跳过来时用，定位完就清掉）
 *   kw     = 搜索框里的词（切视图回来别丢） */
var PROJ = { focus: '', locate: '', kw: '' };

/* 上次选中的角色（跨刷新记住）。
 * ⛔ 右栏只显示**显式选中**的角色 —— 分类是枝，点它不选中也就不该有内容卡。 */
var SEL_KEY = 'wb.scene.selected';
function loadSelected() {
  try { return String(localStorage.getItem(SEL_KEY) || ''); } catch (e) { return ''; }
}
function saveSelected(id) {
  try {
    if (id) localStorage.setItem(SEL_KEY, id);
    else localStorage.removeItem(SEL_KEY);
  } catch (e) { /* ignore */ }
}

/** 全部分类名：注册表顺序在前，场景里出现但注册表没有的补在最后。
 *  场景树、分类下拉、注册表是同一份来源 —— 别处别再自己拼一遍。 */
function allCats() {
  var cats = (STATE.categories || []).slice();
  STATE.scenes.forEach(function (s) {
    var c = s.category || '未分类';
    if (cats.indexOf(c) < 0) cats.push(c);
  });
  return cats;
}

/** 登记新角色时默认落在哪个分类：优先「工作」（大头在这儿），否则第一个。 */
function defaultCat() {
  var cats = allCats();
  if (cats.indexOf('工作') >= 0) return '工作';
  return cats[0] || '其它';
}

/** 场景按分类分组。
 *
 *  分类的**定义和顺序**来自注册表（scenarios/_categories.json）⇒
 *  · 空分类也能存在（先建出来，再把角色拖进去）
 *  · 顺序写在文件里，换机器也不丢
 *  场景里出现、注册表里没有的分类会补在最后（手改过 json 也不丢）。
 */
function groupByCategory() {
  var map = {};
  var order = [];
  var names = allCats();
  names.forEach(function (c) {
    map[c] = { name: c, scenes: [] };
    order.push(c);
  });
  STATE.scenes.forEach(function (s) {
    var c = s.category || '未分类';
    if (!map[c]) { map[c] = { name: c, scenes: [] }; order.push(c); }
    map[c].scenes.push(s);
  });
  return order.map(function (c) { return map[c]; });
}

/** 当前选中的角色。没选过就是没选 —— **不默认挑第一个**：
 *  否则右栏会凭空长出一张身份卡，看着像「点分类进去就有内容」。 */
function selectedSceneId() {
  var ids = STATE.scenes.map(function (s) { return s.id; });
  var sel = STATE.selected || loadSelected();
  if (sel && ids.indexOf(sel) >= 0) return sel;
  return '';
}

function renderCatalog() {
  var groups = groupByCategory();
  var layout = el('div', 'cat-layout');

  /* ── 左：场景树 / 项目树 ───────────────────────────────────── */
  var view = treeView();
  var proj = buildProjectTree();

  var side = el('div', 'cat-side');
  var sideHead = el('div', 'cat-side-head');
  sideHead.appendChild(el('div', 'cat-side-title', view === 'projects' ? '工作台 · 项目' : '工作台 · 场景'));
  sideHead.appendChild(el('div', 'cat-side-count', view === 'projects'
    ? proj.count + ' 个目录'
    : STATE.scenes.length + ' 个场景'));
  side.appendChild(sideHead);

  /* 切换器：角色 / 项目 —— 两个视图看的是同一批角色的两面 */
  var sw = el('div', 'side-switch');
  [['roles', '角色 ' + STATE.scenes.length], ['projects', '项目 ' + proj.count]].forEach(function (t) {
    var b = el('button', 'side-switch-btn' + (view === t[0] ? ' on' : ''), t[1]);
    b.addEventListener('click', function () { setTreeView(t[0]); });
    sw.appendChild(b);
  });
  side.appendChild(sw);

  side.appendChild(view === 'projects' ? renderProjectTree(proj) : renderRoleTree(groups));
  layout.appendChild(side);

  /* ── 右：选中角色的面板卡 ────────────────────────────────────── */
  layout.appendChild(renderSceneCards(selectedSceneId()));
  DOM.view.appendChild(layout);
}

/** 左树 · 角色视图：分类是枝，角色是叶。**不掺文件树** —— 文件在「项目」视图里。 */
function renderRoleTree(groups) {
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
    // 拖到分类标题上 ⇒ 下半区=加进这个分类（归属跟着变）；上半区=排在这个分类前面
    makeDropTarget(bh, g.name, true);
    // ★ 分类本身也能拖（分类的顺序 = 它第一个成员的位置）
    makeDraggable(bh, 'cat:' + g.name);
    // 分类的右键菜单：改名 / 在后面加一个 / 删除这个分类
    wbBindMenu(bh, [
      { id: 'rename-cat', label: '改分类名…' },
      { id: 'add-cat-after', label: '在这后面加分类' },
      { separator: true },
      { id: 'delete-cat', label: '删掉这个分类', danger: true,
        hint: '只删分类（角色移到「未分类」），角色本身不删' },
    ], function (what) {
      if (what === 'rename-cat') renameCategory(g);
      else if (what === 'add-cat-after') addCategory(g.name);
      else if (what === 'delete-cat') deleteCategory(g);
    });
    branch.appendChild(bh);

    if (isOpen) {
      var kids = el('div', 'side-kids');
      g.scenes.forEach(function (s) {
        kids.appendChild(sideLeaf(s, s.id === sel));
      });
      // 空分类也要看得见 —— 不然「建了分类」跟「没建」长得一样
      if (!g.scenes.length) kids.appendChild(el('div', 'side-kids-empty', '这个分类还没有角色'));
      branch.appendChild(kids);
    }
    tree.appendChild(branch);
  });
  // 树底部：建一个新分类（分类是容器，可以先空着，再把角色拖进去）
  var addRow = el('div', 'side-add-cat', '＋ 新分类');
  addRow.title = '建一个新分类';
  addRow.addEventListener('click', function () { addCategory(''); });
  tree.appendChild(addRow);
  return tree;
}

/* ── 拖拽排序：左树里把角色拖来拖去 ──────────────────────────────
 * 规则（跟文件管理器一个脾气）：
 *   · 拖到某个角色上   ⇒ 插到它前面 / 后面（看指针在上半还是下半）
 *   · 拖到某个分类上   ⇒ 上半区 = 排在这个分类前面（**只换顺序，归属不变**）；
 *                       下半区 = 加到这个分类末尾（**归属也跟着变**）
 *   · 分类的先后       = 注册表 scenarios/_categories.json 里的位置
 *   · 角色组内的先后   = data/scene-order.json（服务端按它排）
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
    var upper = (e.clientY < r.top + r.height / 2);
    if (isBranch) {
      // 分类标题：
      //   拖**角色** ⇒ 上半区 = 排在这个分类前面（只换顺序，不改归属）
      //                     下半区 = 加入这个分类（改归属）
      //   拖**分类** ⇒ 只有换位置（见上面的分支）
      markDrop(el, upper ? 'before' : 'into');
      return;
    }
    markDrop(el, upper ? 'before' : 'after');
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
    if (t < 0) {
      // 落点是**分类标题**（targetId = 分类名）⇒ 排到那个分类的前/后
      //   ⚠ 只换顺序，**不改归属** —— 一级菜单的成员不能被动。
      var tCat = targetId.indexOf('cat:') === 0 ? targetId.slice(4) : targetId;
      var first = -1;
      var lastOf = -1;
      order.forEach(function (id, i) {
        var sc = STATE.scenes.filter(function (s) { return s.id === id; })[0];
        if (sc && (sc.category || '未分类') === tCat) {
          if (first < 0) first = i;
          lastOf = i;
        }
      });
      if (first < 0) return;
      idx = mode === 'before' ? first : lastOf + 1;
    } else {
      idx = mode === 'before' ? t : t + 1;
    }
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
 * 挪一个**分类**（换它在注册表里的位置）。
 *
 * 分类在界面上是「枝」，它没有自己的行 —— 它的位置 = 注册表（scenarios/_categories.json）里的位置。
 * ⛔ 一级菜单（分类）**只能换位置**，永远是一级菜单 ⇒ 底下角色的 category 一个都不改。
 */
function moveCategory(catName, targetId, mode) {
  var names = (STATE.categories || []).slice();
  var from = names.indexOf(catName);
  if (from < 0) return;
  names.splice(from, 1);

  // 落点 ⇒ 目标分类。
  // ⚠ 分类标题的落点 id 是**纯分类名**（makeDropTarget 传的是 g.name），
  //   角色落点才是场景 id —— 两种都要认。
  var targetCat = null;
  var ts = STATE.scenes.filter(function (s) { return s.id === targetId; })[0];
  if (ts) {
    targetCat = ts.category || '未分类';
  } else if (names.indexOf(targetId) >= 0) {
    targetCat = targetId;
  } else if (targetId.indexOf('cat:') === 0) {
    targetCat = targetId.slice(4);
  }
  if (!targetCat || targetCat === catName) return;

  var t = names.indexOf(targetCat);
  var idx = t < 0 ? names.length : (mode === 'before' ? t : t + 1);
  names.splice(idx, 0, catName);

  api('POST', '/api/categories', { op: 'reorder', ids: names })
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
    // 角色行上的这个标记 = 「这角色有一块真实磁盘的地盘」。
    // 点它 ⇒ 跳到「项目」视图定位到那个目录（角色↔项目双向可达）。
    var mark = el('button', 'scene-proj', '📁');
    mark.title = '项目目录：' + s.projectRoot + '\n（点一下在「项目」视图里找到它）';
    mark.setAttribute('aria-label', '在项目视图里定位「' + s.name + '」的项目目录');
    mark.addEventListener('click', function (e) {
      e.stopPropagation();
      PROJ.locate = String(s.projectRoot).replace(/\/+$/, '');
      PROJ.focus = PROJ.locate;
      setTreeView('projects');
    });
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
    saveSelected(s.id);
    wbAct(s.id, '选中场景', s.name);
    render();
    // 换个角色 ⇒ 头部那行职责/技能标签得是**这个**角色的 ⇒ 重新拉一次场景数据
    //   （身份卡改了但界面没跟上，就是漏了这一步）
    refreshSceneList();
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

/* ── 左树里的「项目目录」树（VS Code 的资源管理器那样） ─────────────
 *
 * 机主原话：「我在工作类下面，可能会有很多工作的文件，做在项目目录里的
 *            做成树形结构的菜单形式」
 *   ⇒ 角色（叶）底下挂一棵项目目录的树：文件夹能展开，文件能点开看。
 *
 * 展开状态记在 FILETREE.open（路径 → 1）+ localStorage ——
 *   重新渲染（选中角色 / 切页签 / 刷新页面）之后，展开着的还展开着。
 */
var FILETREE_KEY = 'wb.filetree.open';
var FILETREE = { open: {} };
try { FILETREE.open = JSON.parse(localStorage.getItem(FILETREE_KEY) || '{}') || {}; } catch (e) { FILETREE.open = {}; }

function fileTreeSet(path, on) {
  if (on) FILETREE.open[path] = 1; else delete FILETREE.open[path];
  try { localStorage.setItem(FILETREE_KEY, JSON.stringify(FILETREE.open)); } catch (e) { /* ignore */ }
}
function fileTreeIsOpen(path) { return !!FILETREE.open[path]; }

function ftSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' K';
  return (n / 1024 / 1024).toFixed(1) + ' M';
}

/* ── 项目视图：磁盘目录 ⇄ 角色 ────────────────────────────────────
 *
 * 一棵树，根是**真实磁盘上的目录**，节点上标着**谁绑了它**。
 * 父子关系按路径本身来（总项目那个目录是 campus-app 的父）⇒ 一份磁盘一棵，
 * 不会像以前那样按角色复制出六七棵大分叉。
 *
 * 两种节点，长得不一样：
 *   📂 绑定目录 = 有人把它当地盘（标着角色）
 *   📁 磁盘子项 = 目录里的普通内容
 */

/** 把所有角色绑的 projectRoot 拼成一棵按磁盘路径的树。 */
function buildProjectTree() {
  var byPath = {};
  var bound = STATE.scenes.filter(function (s) { return s.projectRoot; });

  bound.forEach(function (s) {
    var p = String(s.projectRoot).replace(/\/+$/, '');
    if (!p || byPath[p]) return;
    byPath[p] = { path: p, name: p.split('/').pop() || p, scenes: [], children: [] };
  });

  // 按路径长度排 ⇒ 父目录一定排在子目录前面（父路径更短）
  var paths = Object.keys(byPath).sort(function (a, b) { return a.length - b.length; });
  paths.forEach(function (p) {
    var node = byPath[p];
    var parent = null;
    paths.forEach(function (q) {
      if (q === p || p.indexOf(q + '/') !== 0) return;
      if (!parent || q.length > parent.path.length) parent = byPath[q];
    });
    if (parent) parent.children.push(node);
  });

  // 角色挂到它绑的那个节点上（同一个目录可以绑给好几个角色）
  bound.forEach(function (s) {
    var p = String(s.projectRoot).replace(/\/+$/, '');
    if (byPath[p]) byPath[p].scenes.push(s);
  });

  // 同一层的孩子按**名字**排 —— 目录一栏得是字母序，不是按路径长度乱序
  var byName = function (a, b) { return a.name.localeCompare(b.name); };
  var roots = paths.filter(function (p) {
    return !paths.some(function (q) { return q !== p && p.indexOf(q + '/') === 0; });
  });
  roots.sort(function (a, b) { return a.length - b.length || a.localeCompare(b); });
  Object.keys(byPath).forEach(function (p) { byPath[p].children.sort(byName); });

  return { roots: roots.map(function (p) { return byPath[p]; }), byPath: byPath, count: paths.length };
}

/** 项目视图：面包屑 + 搜索 + 目录树。 */
function renderProjectTree(pt) {
  var box = el('div', 'side-tree proj-tree');

  if (!pt.roots.length) {
    box.appendChild(el('div', 'side-kids-empty', '还没有角色绑真实目录 —— 到角色详情页的「项目目录」面板里绑一个'));
    return box;
  }

  box.appendChild(projCrumb());
  box.appendChild(projSearch(pt));

  pt.roots.forEach(function (node) {
    box.appendChild(projNode(node, pt));
  });

  // 从角色跳过来 ⇒ 定位到那个目录（滚过去 + 闪一下）
  if (PROJ.locate) {
    var loc = PROJ.locate;
    PROJ.locate = '';
    var row = null;
    Array.prototype.forEach.call(box.querySelectorAll('.projnode-row'), function (r) {
      if (r.getAttribute('data-path') === loc) row = r;
    });
    if (row) {
      row.classList.add('locate');
      setTimeout(function () {
        row.scrollIntoView({ block: 'center' });
        setTimeout(function () { row.classList.remove('locate'); }, 2400);
      }, 80);
    }
  }
  return box;
}

/** 项目树里的一个节点 = 磁盘上的一个目录。 */
function projNode(node, pt) {
  var wrap = el('div', 'projnode');
  var row = el('div', 'projnode-row');
  row.setAttribute('data-path', node.path);
  row.title = node.path;

  row.appendChild(el('span', 'ftnode-twisty', fileTreeIsOpen(node.path) ? '▾' : '▸'));
  row.appendChild(el('span', 'ftnode-icon', '📂'));
  row.appendChild(el('span', 'projnode-name', node.name));

  // 谁绑了这个目录 —— 一眼看出归属（痛点：不知道哪些目录归谁）
  node.scenes.forEach(function (s) {
    var chip = el('button', 'proj-chip', (s.icon || '●') + ' ' + s.name);
    chip.title = '这个目录绑给了「' + s.name + '」—— 点一下跳到那个角色';
    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      STATE.selected = s.id;
      saveSelected(s.id);
      wbAct(s.id, '选中场景', s.name);
      setTreeView('roles');
    });
    row.appendChild(chip);
  });

  wrap.appendChild(row);

  // 磁盘上**也是绑定目录**的子节点 ⇒ 直接列出来（不用展开才知道这个仓库归了几个人）
  if (node.children.length) {
    var subs = el('div', 'projnode-subs');
    node.children.forEach(function (c) { subs.appendChild(projNode(c, pt)); });
    wrap.appendChild(subs);
  }

  // 真实磁盘上的内容（懒加载）
  var kids = el('div', 'ftnode-kids');
  kids.setAttribute('data-ft-dir', node.path);
  kids.__skip = pt.byPath;      // 绑定目录已经单独画过了，别重复
  wrap.appendChild(kids);

  var scene = node.scenes[0] || null;
  row.addEventListener('click', function () {
    PROJ.focus = node.path;
    ftToggle(row, kids, node.path, scene);
  });
  wbBindMenu(row, ftFolderMenu(), function (what) {
    ftAction(what, node.path, scene, kids);
  });
  if (fileTreeIsOpen(node.path)) ftToggle(row, kids, node.path, scene, true);
  return wrap;
}

/** 面包屑：当前所在目录，点任一段跳过去。 */
function projCrumb() {
  var box = el('div', 'proj-crumb');
  var segs = PROJ.focus ? PROJ.focus.split('/').filter(Boolean) : [];
  box.appendChild(el('span', 'crumb-sep', '／'));
  if (!segs.length) {
    box.appendChild(el('span', 'crumb-dim', '（选一个目录）'));
    return box;
  }
  var acc = '';
  segs.forEach(function (seg, i) {
    acc += '/' + seg;
    var last = i === segs.length - 1;
    var b = el('button', 'crumb' + (last ? ' on' : ''), seg);
    b.title = acc;
    b.addEventListener('click', function () {
      PROJ.focus = acc;
      PROJ.locate = acc;
      render();
    });
    box.appendChild(b);
  });
  return box;
}

/** 搜索框：在当前目录底下按文件名找（深目录一层层点太费劲）。 */
function projSearch(pt) {
  var box = el('div', 'proj-search');
  var input = el('input', 'ft-search');
  input.type = 'search';
  var scope = PROJ.focus || (pt.roots[0] && pt.roots[0].path) || '';
  input.placeholder = '搜文件名（' + (scope.split('/').pop() || '当前目录') + ' 底下）';
  input.value = PROJ.kw || '';
  var res = el('div', 'proj-search-res');
  box.appendChild(input);
  box.appendChild(res);

  var timer = null;
  function run() {
    var kw = input.value.trim();
    PROJ.kw = kw;
    res.innerHTML = '';
    if (!kw) return;
    api('GET', '/api/fs/search?dir=' + encodeURIComponent(scope) + '&q=' + encodeURIComponent(kw))
      .then(function (r) {
        res.innerHTML = '';
        if (!r || !r.ok) {
          res.appendChild(el('div', 'ftnode-note', '搜不了：' + (r && r.error || '未知')));
          return;
        }
        if (!r.rows.length) {
          res.appendChild(el('div', 'ftnode-note', '没找到「' + kw + '」'));
          return;
        }
        r.rows.forEach(function (n) {
          var row = el('div', 'ftnode-row ftnode-hit');
          row.appendChild(el('span', 'ftnode-icon', n.isDir ? '📁' : '📄'));
          row.appendChild(el('span', 'ftnode-name', n.rel || n.name));
          if (!n.isDir) row.appendChild(el('span', 'ftnode-size', ftSize(n.size)));
          row.title = n.path;
          row.addEventListener('click', function () {
            if (!n.isDir) { wbFilePreview(n.path, n.name); return; }
            // 目录 ⇒ 在结果里就地展开（继续往下钻）
            var kids = el('div', 'ftnode-kids');
            row.appendChild(kids);
            ftLoad(kids, n.path, null);
          });
          res.appendChild(row);
        });
        if (r.truncated) res.appendChild(el('div', 'ftnode-note', '（结果太多，只列了前面一部分）'));
      });
  }

  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  if (PROJ.kw) setTimeout(run, 0);
  return box;
}

/** 展开 / 收起一个文件夹（懒加载下一层）。 */
function ftToggle(row, kids, path, scene, force) {
  var open = force || !fileTreeIsOpen(path);
  fileTreeSet(path, open);
  var tw = row.querySelector('.ftnode-twisty');
  if (tw) tw.textContent = open ? '▾' : '▸';
  if (!open) { kids.innerHTML = ''; kids.removeAttribute('data-loaded'); return; }
  if (kids.getAttribute('data-loaded') === '1') { kids.style.display = ''; return; }
  ftLoad(kids, path, scene);
}

/** 读一个目录的内容，画成子节点。
 *  kids.__skip = 已经单独渲染过的绑定目录（路径 → 节点）——
 *    它们在磁盘上也存在，但显示成「📂 带角色」的节点，别重复列一遍。 */
function ftLoad(kids, path, scene) {
  var skip = kids.__skip || null;
  kids.innerHTML = '';
  kids.style.display = '';
  kids.appendChild(el('div', 'ftnode-note', '读…'));
  api('GET', '/api/fs/tree?dir=' + encodeURIComponent(path) + '&depth=1').then(function (r) {
    kids.innerHTML = '';
    kids.setAttribute('data-loaded', '1');
    if (!r || !r.ok) { kids.appendChild(el('div', 'ftnode-note', '读不了：' + (r && r.error || '未知'))); return; }
    var rows = r.rows.filter(function (n) { return !(skip && skip[n.path]); });
    if (!rows.length) { kids.appendChild(el('div', 'ftnode-note', '（空）')); return; }
    rows.forEach(function (n) { kids.appendChild(ftNode(n, scene, skip)); });
  });
}

/** 重新读一个目录（新建完东西刷新那一块）。 */
function ftReload(kids, scene) {
  var dir = kids.getAttribute('data-ft-dir');
  if (!dir) return;
  kids.removeAttribute('data-loaded');
  ftLoad(kids, dir, scene);
}

/** 一个文件夹 / 文件的节点。 */
function ftNode(n, scene, skip) {
  var wrap = el('div', 'ftnode');
  var row = el('div', 'ftnode-row');
  row.setAttribute('data-ft-path', n.path);
  row.appendChild(el('span', 'ftnode-twisty', n.isDir ? (fileTreeIsOpen(n.path) ? '▾' : '▸') : ''));
  row.appendChild(el('span', 'ftnode-icon', n.isDir ? '📁' : '📄'));
  row.appendChild(el('span', 'ftnode-name', n.name));
  if (!n.isDir) row.appendChild(el('span', 'ftnode-size', ftSize(n.size)));
  row.title = n.path;
  wrap.appendChild(row);
  if (n.isDir) {
    var kids = el('div', 'ftnode-kids');
    kids.setAttribute('data-ft-dir', n.path);
    kids.__skip = skip || null;      // 绑定目录不在下面重复列
    wrap.appendChild(kids);
    row.addEventListener('click', function () { ftToggle(row, kids, n.path, scene); });
    wbBindMenu(row, ftFolderMenu(), function (what) { ftAction(what, n.path, scene, kids); });
    if (fileTreeIsOpen(n.path)) ftToggle(row, kids, n.path, scene, true);
  } else {
    row.addEventListener('click', function () { wbFilePreview(n.path, n.name); });
    wbBindMenu(row, ftFileMenu(), function (what) { ftFileAction(what, n); });
  }
  return wrap;
}

function ftFolderMenu() {
  return [
    { id: 'mkdir', label: '新建文件夹…' },
    { id: 'mkfile', label: '新建文件…' },
    { separator: true },
    { id: 'copy', label: '复制路径' },
    { id: 'session', label: '在这里开一条会话' },
    { id: 'reload', label: '刷新这一层' },
  ];
}
function ftFileMenu() {
  return [
    { id: 'open', label: '打开看看' },
    { separator: true },
    { id: 'copy', label: '复制路径' },
  ];
}

function ftAction(what, path, scene, kids) {
  if (what === 'mkdir') ftCreate(path, scene, 'dir', kids);
  else if (what === 'mkfile') ftCreate(path, scene, 'file', kids);
  else if (what === 'copy') ftCopy(path);
  else if (what === 'session') ftSession(path, scene);
  else if (what === 'reload') ftReload(kids, scene);
}
function ftFileAction(what, n) {
  if (what === 'open') wbFilePreview(n.path, n.name);
  else if (what === 'copy') ftCopy(n.path);
}

/** 新建文件夹 / 文件（名字走对话框，跟工作台其它地方一个脾气）。 */
function ftCreate(dir, scene, kind, kids) {
  wbDialog({
    title: kind === 'dir' ? '新建文件夹' : '新建文件',
    desc: '位置：' + dir,
    submitText: '建好了',
    fields: [{ key: 'name', label: kind === 'dir' ? '文件夹名' : '文件名', type: 'text', value: '' }],
    validate: function (v) {
      var n = String(v.name || '').trim();
      if (!n) return '名字不能空';
      if (n.indexOf('/') >= 0 || n.indexOf('\\') >= 0) return '名字里不能带 / 或 \\';
      return null;
    },
    onSubmit: function (v) {
      return api('POST', '/api/fs/create', {
        scene: scene.id, dir: dir, name: String(v.name).trim(), kind: kind,
      }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '建不出来');
        wbToast('建好了：' + r.name);
        ftReload(kids, scene);
      });
    },
  });
}

function ftCopy(path) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(path);
      wbToast('路径复制好了');
      return;
    }
  } catch (e) { /* 复制不了就把它显示出来 */ }
  wbToast(path);
}

function ftSession(path, scene) {
  api('POST', '/api/sessions/create', {
    scene: scene.id,
    title: (scene.name || scene.id) + '·' + String(path).split('/').filter(Boolean).pop(),
    cwd: path,
  }).then(function (r) {
    if (!r || !r.ok) { wbToast('开会话失败：' + (r && r.error || '未知'), true); return; }
    wbToast('开好了，工作目录 = ' + path);
  });
}

/** 点开一个文件 ⇒ 弹个窗看前几百行（二进制就不给看）。 */
function wbFilePreview(path, name) {
  var overlay = document.createElement('div');
  overlay.className = 'dialog open';
  var card = document.createElement('div');
  card.className = 'dialog-card wide';
  overlay.appendChild(card);
  var h = document.createElement('h3');
  h.textContent = name;
  card.appendChild(h);
  var meta = document.createElement('p');
  meta.className = 'dialog-p';
  meta.textContent = path;
  card.appendChild(meta);
  var pre = document.createElement('pre');
  pre.className = 'dialog-pre';
  pre.textContent = '读 ' + name + ' …';
  card.appendChild(pre);
  var actions = document.createElement('div');
  actions.className = 'dialog-actions';
  var close = document.createElement('button');
  close.className = 'chip solid';
  close.textContent = '关上';
  actions.appendChild(close);
  card.appendChild(actions);
  wbRoot().appendChild(overlay);
  function shut() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  close.addEventListener('click', shut);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) shut(); });
  api('GET', '/api/fs/read?path=' + encodeURIComponent(path)).then(function (r) {
    if (!r || !r.ok) { pre.textContent = '读不了：' + (r && r.error || '未知'); return; }
    var text = String(r.text || '');
    if (text.indexOf('\u0000') >= 0) { pre.textContent = '（二进制文件，这儿看不了）'; return; }
    var lines = text.split('\n');
    pre.textContent = lines.slice(0, 500).join('\n')
      + (lines.length > 500 ? '\n…（后面还有 ' + (lines.length - 500) + ' 行）' : '');
  });
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
      // 一次请求搞定：注册表改名 + 底下角色的 category 字段一起改
      return api('POST', '/api/categories', { op: 'rename', name: old, newName: name }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '改名失败');
        wbToast('分类改成「' + name + '」了');
        return refreshScenes();
      });
    },
  });
}

/**
 * 新建分类。
 *
 * 分类是「枝」：可以先建出来（空的），再把角色拖进去。
 * after = 插在哪个分类之后；空 = 追加到最后。
 */
function addCategory(after) {
  wbDialog({
    title: after ? ('在「' + after + '」后面加一个分类') : '新加一个分类',
    desc: '分类是个「枝」：先建出来，再把角色拖进去。\n'
      + '分类名别跟角色重名（重了就分不清哪行是分类哪行是角色）。',
    submitText: '建好了',
    fields: [{ key: 'name', label: '分类名', type: 'text', value: '' }],
    onSubmit: function (v) {
      var name = String(v.name || '').trim();
      if (!name) throw new Error('分类名不能空');
      return api('POST', '/api/categories', { op: 'create', name: name, after: after || '' }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '建分类失败');
        wbToast('分类「' + name + '」建好了');
        return refreshScenes();
      });
    },
  });
}

/** 删分类 ⇒ 角色移到「未分类」（角色本身留着）。 */
function deleteCategory(g) {
  wbDialog({
    title: '删掉分类「' + g.name + '」',
    desc: g.scenes.length
      ? ('这个分类下有 ' + g.scenes.length + ' 个角色。\n它们会移到「未分类」，**角色本身不会删**。')
      : '这个分类是空的，删掉它就行。',
    submitText: '删分类',
    fields: [],
    onSubmit: function () {
      return api('POST', '/api/categories', { op: 'delete', name: g.name }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '删分类失败');
        wbToast('分类删了' + (r.moved ? '，' + r.moved + ' 个角色移到「未分类」' : ''));
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
  // 分类列表 = 注册表里的（含空分类）+ 场景里出现过的 + 未分类
  var cats = allCats();
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
        if (STATE.selected === s.id) { STATE.selected = ''; saveSelected(''); }
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

/* 双击判定：两次点击同一张卡、间隔在 DBL_MS 内 ⇒ 算双击。
 * ⚠ 为什么自己判、不用浏览器的 dblclick 事件：
 *   浏览器只在「两次点击的目标链完全一致」时才派发 dblclick ——
 *   点到卡片里的文字/小按钮/滚动条，就可能不派发。
 *   自己判 ⇒ 稳。
 */
var DBL_MS = 450;
var DBL_STATE = { card: null, at: 0 };

/**
 * 一张面板卡的壳子（内容稍后填）。
 *
 * ⚠ **双击**这张卡 ⇒ 打开该场景的详情页（正式面板，不是摘要）。
 *   单击不动 —— 摘要卡上要能选字、点按钮，双击才不会误触。
 */
function panelCard(title, sub, sceneId) {
  var card = el('div', 'panel-card');
  var head = el('div', 'panel-card-head');
  head.appendChild(el('div', 'panel-card-title', title));
  head.appendChild(el('div', 'panel-card-sub', sub || ''));
  card.appendChild(head);
  var body = el('div', 'panel-card-body');
  body.appendChild(el('div', 'panel-card-empty', '读取中…'));
  card.appendChild(body);
  card.body = body;         // 方便后面填内容

  if (sceneId) {
    card.classList.add('dbl-open');
    card.title = '双击这张卡 ⇒ 打开详情页';
    // 明摆着一个入口（双击是省事的那个，不是唯一的那个）
    var open = el('button', 'panel-card-open', '详情');
    open.title = '打开详情页';
    open.addEventListener('click', function (e) {
      e.stopPropagation();
      openScene(sceneId);
    });
    head.appendChild(open);
    card.addEventListener('click', function (e) {
      // 点在按钮/链接上 ⇒ 不当双击的一部分（那些有自己的行为）
      if (e.target && e.target.closest && e.target.closest('button, a, input, textarea')) {
        DBL_STATE.card = null;
        return;
      }
      var now = Date.now();
      if (DBL_STATE.card === card && now - DBL_STATE.at <= DBL_MS) {
        DBL_STATE.card = null;
        openScene(sceneId);
        return;
      }
      DBL_STATE = { card: card, at: now };
    });
  }
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
    if (!STATE.scenes.length) {
      main.appendChild(el('div', 'todo-empty', '还没有角色 —— 去「注册」登记一个'));
      return main;
    }
    // ⛔ 没选中角色 ⇒ 右栏**不出任何内容卡**（身份卡这些都挂在角色身上）。
    //   分类（枝）只是分组容器，点它不会选中角色，右栏就该是空的。
    var empty = el('div', 'cat-empty');
    empty.appendChild(el('div', 'cat-empty-icon', '◫'));
    empty.appendChild(el('div', 'cat-empty-title', '还没选角色'));
    empty.appendChild(el('div', 'cat-empty-sub', '左边点一个角色，右边显示它的身份卡、项目信息、索引和会话。'));
    main.appendChild(empty);
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

  /* 五张摘要卡：身份卡 · 项目信息 · 索引 · AI 会话 · 操作留痕 */
  var grid = el('div', 'panel-card-grid');
  var cId = panelCard('身份卡', '每场读的那张卡', id);
  var cMem = panelCard('项目信息', '§〇 开场先读', id);
  var cIdx = panelCard('索引', '场景索引 · 资产索引', id);
  var cAi = panelCard('AI 会话', '常驻会话', id);
  var cAct = panelCard('操作留痕', '这个场景发生过的一切');
  [cId, cMem, cIdx, cAi, cAct].forEach(function (c) { grid.appendChild(c); });
  main.appendChild(grid);

  /* 填内容（异步，取完再填） */
  api('GET', '/api/memory?scene=' + encodeURIComponent(id)).then(function (r) {
    if (!r || !r.ok) { fillCard(cId, '（读不到）'); return; }
    fillCard(cId, (r.card || '').replace(/^#.*\n/, '').trim(), 10);
    // ⚠ §〇 的提取要在**下一个小节**那里停住 ——
    //   只按「## §〇」切一刀的话，后面 §一/§二/§五/§六 全都跟着进来了。
    var sec0 = String(r.main || '').split(/^##\s*§〇.*$/m)[1] || '';
    sec0 = sec0.split(/\n##\s/)[0];
    // ⚠ 自动区（派生内容）在文件里是带 <!-- 自动:… --> 标记的 ——
    //   摘要卡给人看，不该露出这行标记 ⇒ 只去掉标记，留内容。
    sec0 = sec0.replace(/<!--\s*自动:[^>]*?-->/g, '');
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

  /* 操作留痕：这个场景里发生过的每一次操作（人 + 服务端 + AI） */
  api('GET', '/api/actlog?scene=' + encodeURIComponent(id) + '&limit=8').then(function (r) {
    if (!r || !r.ok) { fillCard(cAct, '（读不到留痕）'); return; }
    var lines = (r.entries || []).slice().reverse().map(function (e) {
      var who = e.actor === 'ai' ? 'AI' : (e.actor === 'system' ? '系统' : '我');
      var t = (e.time || wbLocalTime(e)).slice(0, 5);   // ⚠ 本地时间（不是 UTC）
      return t + '　' + who + '　' + e.action + (e.target ? '　' + e.target : '');
    });
    fillCard(cAct, lines.join('\n'), 8);
    var more = el('button', 'panel-btn', '打开场景看留痕');
    more.addEventListener('click', function () { openScene(id, '留痕'); });
    cAct.body.appendChild(more);
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

function openScene(id, tab) {
  STATE.open = id;
  var sc = STATE.scenes.filter(function (s) { return s.id === id; })[0];
  wbAct(id, '进入场景', sc ? sc.name : id);
  // 想直接落到某个页签上（如「留痕」）⇒ 告诉那个面板
  if (tab) window.__WB_MEM_TAB = { scene: id, tab: tab };
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
  wbAct(sc.id, '打开会话', (ai && ai.sessionTitle) || sc.name);
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
  back.addEventListener('click', function () {
    STATE.open = null;
    render();
    // 回列表页 ⇒ 头部要显示最新的职责/技能（身份卡可能刚在详情页里改过）
    refreshSceneList();
  });
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
    { id: id + '-health', title: '体检', sub: '这个场景的', type: 'health', col: 1, row: 6, w: 1, h: 2 },
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
  //   w:2 —— 跨 col3/col4 两栏。窄条里放文件树，文件名全被截成「package-lo...」，
  //   翻深目录根本没法用 ⇒ 给它两栏的宽度（体检挪到左下角腾地方）。
  layout.push({
    id: id + '-proj',
    title: '项目目录',
    sub: '真实磁盘 · AI 在这儿写代码',
    type: 'project',
    col: 3, row: 4, w: 2, h: 3,
    scene: id,
  });
  // 书架：**只挂给声明了 books 型仓库的场景**（现在只有「阅读」）。
  //   ⛔ 别按 projectRoot 挂 —— LLM-wiki / 运动 绑的是同一个 Obsidian 库，
  //   按库挂 ⇒ 那些模块下也冒出书架（书架归阅读一个模块）。
  var bookDir = (sc.vaultDirs || []).filter(function (v) { return v && v.kind === 'books'; })[0];
  if (sc.projectRoot && bookDir) {
    layout.push({
      id: id + '-shelf',
      title: bookDir.title || '书架',
      sub: 'Obsidian 书库',
      type: 'bookshelf',
      col: 1, row: 6, w: 3, h: 5,
      scene: id,
      dir: bookDir.dir || '05-Bookshelf/书籍list',
    });
  }
  // ⚠ 留痕**不再单开一个面板** —— 它住在「项目信息」面板的「留痕」页签里
  //   （同一个场景发生的每一次操作：人 + 服务端 + AI，都在那条时间线上）。

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

/** 弹一个「新建分类」的框。建好了分类已经进了注册表，onOk 拿名字。 */
function newCategoryDialog(onOk) {
  wbDialog({
    title: '新建分类',
    desc: '分类是个「枝」：先建出来，再把角色放进去。\n名字别跟角色重名（重了分不清哪行是分类哪行是角色）。',
    submitText: '建好了',
    fields: [{ key: 'name', label: '分类名', type: 'text', value: '' }],
    validate: function (v) {
      return String(v.name || '').trim() ? '' : '分类名不能空';
    },
    onSubmit: function (v) {
      var name = String(v.name || '').trim();
      return api('POST', '/api/categories', { op: 'create', name: name }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || '建分类失败');
        // 服务端已写进注册表 ⇒ 本地补一份，界面立刻就能选到
        if ((STATE.categories || []).indexOf(name) < 0) STATE.categories.push(name);
        onOk(name);
        return { ok: true };
      });
    },
  });
}

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
   ['duty', '一句话职责', '它负责什么（可观察、可判断）'],
   ['skills', '专属技能', '逗号分隔']].forEach(function (spec) {
    form.appendChild(el('label', 'disp-label', spec[1]));
    var i = el('input', 'disp-input');
    i.placeholder = spec[2];
    form.appendChild(i);
    f[spec[0]] = i;
  });

  /* 分类 = 下拉，选项来自分类注册表（跟场景页那棵树同一份）。
   * 手输容易打出「工作 」「工作」这种跟注册表对不上的名字 ⇒ 变成只有场景、
   * 注册表里没有的孤儿分类，注册表就再也说不清它排在哪儿。 */
  form.appendChild(el('label', 'disp-label', '分类'));
  var NEW_CAT = '__new__';
  var catSel = el('select', 'disp-input disp-select');
  var lastCat = '';       // 下拉上一次的值（change 时要拿它当「用户原来选的那个」）
  function fillCats(current) {
    catSel.innerHTML = '';
    var names = allCats();
    names.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      catSel.appendChild(o);
    });
    var o = document.createElement('option');
    o.value = NEW_CAT;
    o.textContent = '＋ 新建分类…';
    catSel.appendChild(o);
    // ⚠ current / STATE.regCat 可能是**过期**的分类（它后来被删或被改名了）。
    //   下拉里没有这个选项时，select.value 会被置成空串 ⇒ 登记时提交空 category
    //   ⇒ 服务端兜底成「其它」⇒ 又冒出一个孤儿分类（正是这里要消灭的东西）。所以校验一下。
    var want = current || STATE.regCat || defaultCat();
    if (names.indexOf(want) < 0) want = defaultCat();   // 过期值 ⇒ 回落默认分类（defaultCat 就在 names 里）
    catSel.value = want;
    lastCat = catSel.value;
    STATE.regCat = catSel.value;   // 记住当前选中的（切走再回来还在原地）
  }
  fillCats();
  catSel.addEventListener('change', function () {
    if (catSel.value !== NEW_CAT) { lastCat = catSel.value; return; }
    // 选中「新分类」只是意图 ⇒ 先复原到**用户原来选的那个**（lastCat），不是默认分类。
    //   取消也不留残值，更不会把他原来的选择改掉。
    //   ⚠ 不能靠 selectedIndex-1 找「原来那个」：change 触发时 selectedIndex
    //     已经是新值了 ⇒ 得自己记着上一次是什么。
    catSel.value = lastCat || defaultCat();
    lastCat = catSel.value;
    newCategoryDialog(function (name) {
      fillCats(name);
      wbToast('分类「' + name + '」建好了');
    });
  });
  form.appendChild(catSel);

  var msg = el('div', 'disp-msg');
  if (STATE.regMsg) {
    msg.className = 'disp-msg ' + STATE.regMsg.kind;
    msg.textContent = STATE.regMsg.text;
  }
  // 用户开始改名字 ⇒ 上一条提示（「✓ 登记好了」之类）就没意义了 ⇒ 清掉
  f.name.addEventListener('input', function () {
    if (!STATE.regMsg) return;
    STATE.regMsg = null;
    msg.className = 'disp-msg';
    msg.textContent = '';
  });
  var go = el('button', 'panel-btn solid', '登记');
  go.addEventListener('click', function () {
    var body = {
      name: f.name.value.trim(),
      icon: f.icon.value.trim() || '●',
      category: catSel.value,
      duty: f.duty.value.trim(),
      skills: f.skills.value.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean),
    };
    if (!body.name) {
      msg.className = 'disp-msg bad';
      msg.textContent = '要名字';
      STATE.regMsg = { kind: 'bad', text: '要名字' };
      return;
    }
    if (!body.category) {
      // 一个可用分类都没有 ⇒ 别提交空 category（服务端会兜底成「其它」，冒孤儿分类）
      msg.className = 'disp-msg bad';
      msg.textContent = '先在下拉里选个分类（或选「＋ 新建分类…」建一个）';
      STATE.regMsg = { kind: 'bad', text: msg.textContent };
      return;
    }
    go.disabled = true;
    msg.className = 'disp-msg';
    msg.textContent = '登记中…';
    STATE.regMsg = { kind: '', text: '登记中…' };
    api('POST', '/api/scenes/create', body).then(function (r) {
      go.disabled = false;
      if (r && r.ok) {
        // ⚠ refreshScenes() 会把整个注册页重画 ⇒ 选中的分类和这句提示
        //   得先存进 STATE：不然重画后下拉跳回默认分类、提示也跟着没了。
        STATE.regCat = catSel.value;
        STATE.regMsg = { kind: 'ok', text: '✓ 登记好了：' + r.id + '　去「场景」页点开它，再建一条会话' };
        // 分类留着不清 —— 连着登记同类角色时不用每次重选
        ['name', 'icon', 'duty', 'skills'].forEach(function (k) { f[k].value = ''; });
        refreshScenes();
      } else {
        STATE.regMsg = { kind: 'bad', text: '✗ ' + (r && (r.error || '没登记成')) };
        msg.className = 'disp-msg bad';
        msg.textContent = STATE.regMsg.text;
      }
    });
  });
  form.appendChild(go);
  form.appendChild(msg);
  wrap.appendChild(form);

  function renderList() {
    listBox.innerHTML = '';
    listBox.appendChild(el('div', 'reg-h', '已登记（' + STATE.scenes.length + '）'));
    // 按分类分组 —— 跟场景页左树同一套分组与顺序（groupByCategory）
    groupByCategory().forEach(function (g) {
      if (!g.scenes.length) return;      // 空分类不进名单（场景树里才看得见它）
      var box = el('div', 'reg-group');
      var head = el('div', 'reg-group-head');
      head.appendChild(el('span', 'reg-group-name', g.name));
      head.appendChild(el('span', 'side-count', String(g.scenes.length)));
      box.appendChild(head);
      g.scenes.forEach(function (s) {
        var row = el('div', 'reg-row');
        row.appendChild(el('span', 'reg-icon', s.icon || '●'));
        row.appendChild(el('span', 'reg-name', s.name));
        row.appendChild(el('span', 'reg-duty', s.duty || ''));
        var open = el('button', 'panel-btn', '打开');
        open.addEventListener('click', function () { STATE.mode = 'scenes'; openScene(s.id); });
        row.appendChild(open);
        box.appendChild(row);
      });
      listBox.appendChild(box);
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
    STATE.categories = r.categories || [];
    STATE.panelPorts = r.panelPorts || [];
    setEngineStatus(!!(r.engine && r.engine.up), r.engine && r.engine.up ? '引擎已连' : '引擎未连');
    render();
  });
}

/**
 * 只刷新场景列表（不打 /api/state —— 那个会顺手探一次引擎，慢）。
 *
 * 什么时候用：**身份卡改了之后**。
 *   卡的「职责」「技能」是这两处显示的唯一出处（后端 loadScenes() 从卡里派生），
 *   所以改完卡要把场景数据重新拉一遍，头部那行职责和那排技能标签才跟着变。
 *
 * ⚠ 在**详情页**时不重画整个视图 —— 那会把别的面板里正在写的内容冲掉。
 *   只改详情页标题下的那行职责。
 * ⚠ 数据没变就**不重画**（免得点一下角色闪一下）。
 */
function refreshSceneList() {
  return api('GET', '/api/scenes').then(function (r) {
    if (!r || !r.ok) return;
    var next = r.scenes || [];
    var changed = next.length !== STATE.scenes.length || next.some(function (s, i) {
      var old = STATE.scenes[i];
      return !old || old.id !== s.id || old.duty !== s.duty
        || String(old.skills || '') !== String(s.skills || '');
    });
    STATE.scenes = next;
    if (!changed) return;
    if (STATE.open) {
      // 详情页：只更新标题下的职责，别重建面板（会把正在写的内容冲掉）
      var sc = next.filter(function (s) { return s.id === STATE.open; })[0];
      var duty = DOM.view ? DOM.view.querySelector('.detail-duty') : null;
      if (sc && duty) duty.textContent = sc.duty || sc.description || '';
      return;
    }
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

  // 切回这个标签页 ⇒ 场景数据可能已经变了（在 Obsidian 里改了身份卡、在别处建了角色…）
  //   ⇒ 重新拉一次。⚠ 只在**列表页**刷（refreshSceneList 自己在详情页只改标题那行，
  //   不会重建面板 ⇒ 面板里正在写的内容不会丢）。
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshSceneList();
  });

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
