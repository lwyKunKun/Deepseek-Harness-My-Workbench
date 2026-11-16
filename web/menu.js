/* menu.js —— 右键菜单（改名字 / 换分类 / 删除 …）
 *
 * ⚠ 菜单本体挂在 **document.body** 上（不是 shadow root 里）：
 *   shadow root 里的定位元素按页面坐标算，菜单会跑偏。
 *   做法是：拿宿主元素算屏幕坐标，菜单用 fixed 定位挂到 body。
 *
 * ⚠ 样式也跟着挂到 document.head：
 *   工作台的 CSS 在 shadow root 里（embed.css），body 上的菜单吃不到 ⇒
 *   得把菜单那几行样式单独注入到 head。
 *
 * ⚠ 前端是普通 script（不是 ESM）⇒ 全部用顶层 var/function 声明。
 */
var WB_MENU = { el: null, cleanup: null };

/** 菜单的样式（单独一份，注入 document.head）。 */
var WB_MENU_CSS = [
  '.ctx-menu{position:fixed;z-index:9999;min-width:168px;padding:4px;',
  'background:#131722;color:#e6e8ee;border:1px solid #232a3a;border-radius:12px;',
  'box-shadow:0 10px 34px rgba(0,0,0,.55);font:12px/1.5 -apple-system,system-ui,sans-serif;}',
  '.ctx-item{display:block;width:100%;text-align:left;border:none;border-radius:8px;',
  'background:transparent;color:inherit;font:inherit;padding:6px 10px;cursor:pointer;}',
  '.ctx-item:hover{background:#1a2030;}',
  '.ctx-item.danger{color:#ef5d6d;}',
  '.ctx-item.danger:hover{background:rgba(239,93,109,.14);}',
  '.ctx-item.disabled{opacity:.45;cursor:default;}',
  '.ctx-sep{height:1px;margin:4px 2px;background:#232a3a;}',
].join('');

/** 把菜单样式注进 document.head（只注一次）。 */
function wbEnsureMenuStyle() {
  if (document.getElementById('wb-menu-style')) return;
  var st = document.createElement('style');
  st.id = 'wb-menu-style';
  st.textContent = WB_MENU_CSS;
  document.head.appendChild(st);
}

/**
 * 弹出菜单。
 * @param {Array} items  [{id,label,danger,disabled,hint} | {separator:true}]
 * @param {{x:number,y:number}} at 屏幕坐标
 * @param {function(string)} onPick
 */
function wbShowMenu(items, at, onPick) {
  wbCloseMenu();
  wbEnsureMenuStyle();
  var menu = document.createElement('div');
  menu.className = 'ctx-menu';
  items.forEach(function (it) {
    if (!it) return;
    if (it.separator) {
      var sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      return;
    }
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    row.textContent = it.label;
    if (it.hint) row.title = it.hint;
    if (it.disabled) row.disabled = true;
    row.addEventListener('click', function (e) {
      e.stopPropagation();
      wbCloseMenu();
      if (!it.disabled) onPick(it.id);
    });
    menu.appendChild(row);
  });
  document.body.appendChild(menu);

  // 贴着鼠标放，别跑出屏幕。
  // ⚠ 菜单此刻已经进了 DOM ⇒ 能量到自己的宽高。
  var r = menu.getBoundingClientRect();
  var x = at.x + 2;
  var y = at.y + 2;
  if (x + r.width > window.innerWidth - 8) x = Math.max(8, at.x - r.width - 2);
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // 点别处 / 按 Esc ⇒ 关掉
  function onDown(e) { if (!menu.contains(e.target)) wbCloseMenu(); }
  function onKey(e) { if (e.key === 'Escape') wbCloseMenu(); }
  setTimeout(function () {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  WB_MENU.cleanup = function () {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  WB_MENU.el = menu;
  return menu;
}

/** 关掉当前菜单（幂等）。 */
function wbCloseMenu() {
  if (WB_MENU.cleanup) { WB_MENU.cleanup(); WB_MENU.cleanup = null; }
  if (WB_MENU.el && WB_MENU.el.parentNode) WB_MENU.el.parentNode.removeChild(WB_MENU.el);
  WB_MENU.el = null;
}

/**
 * 在某个节点上挂右键菜单。
 * @param {Element} el
 * @param {Array} items
 * @param {function(string)} onPick
 * @param {function(Event)} [onPos] 自定义菜单位置（默认用鼠标位置）
 */
function wbBindMenu(el, items, onPick, onPos) {
  el.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var at = { x: e.clientX, y: e.clientY };
    if (onPos) at = onPos(e);
    wbShowMenu(items, at, onPick);
  });
}
