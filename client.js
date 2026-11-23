/**
 * 工作台插件 · Client 那一半
 *
 * 干两件事：
 *   ① 左边侧栏加一个「工作台」按钮（sidebar.panellist）
 *   ② 点它 ⇒ 右边主区显示工作台（main 槽，key = 'workbench'）
 *
 * 为什么不套 iframe：
 *   Harness 的规矩明写着「插件页面要在槽里渲染成 React 组件，
 *   不要让 Host 发一个 HTML 页面再塞进 iframe」—— iframe 里的文档
 *   拿不到宿主的 theme token、浅色/深色切换和 ctx.locale。
 *   所以这里把工作台的 DOM 挂进 **shadow root**：
 *     · 工作台的样式不会漏出去污染 DSH 界面，DSH 的样式也进不来；
 *     · theme token（--dsw-alias-*）照常继承（自定义属性穿过 shadow 边界）；
 *     · locale 走不到（工作台目前是纯中文界面，这是已知取舍）。
 */

window.__ModuleLoader__.load({
  id: '@local/workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const MOUNT_PATH = '/workbench';

    let assets = null;

    /** 一次性把工作台的前端资源拉进来（脚本 + 样式）。 */
    function loadAssets() {
      if (assets) return assets;
      assets = (async () => {
        // 先告诉 app.js「别自己启动」—— 启动由插件来掌握
        window.__WB_MANUAL_BOOT = true;

        const cssPromise = fetch(MOUNT_PATH + '/embed.css').then((r) => r.text());
        const scriptPromise = new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = MOUNT_PATH + '/bundle.js';
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('工作台脚本加载失败'));
          document.head.appendChild(s);
        });
        const [css] = await Promise.all([cssPromise, scriptPromise]);
        return { css };
      })();
      return assets;
    }

    /** 侧栏那个图标（四宫格，跟「工作台 = 一堆面板」对得上）。 */
    function PanelIcon(props) {
      const size = props.size || 18;
      const common = {
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        rx: 1.6,
      };
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', pointerEvents: 'none' },
      },
        h('rect', Object.assign({ x: 3, y: 3, width: 8, height: 8 }, common)),
        h('rect', Object.assign({ x: 13, y: 3, width: 8, height: 8 }, common)),
        h('rect', Object.assign({ x: 3, y: 13, width: 8, height: 8 }, common)),
        h('rect', Object.assign({ x: 13, y: 13, width: 8, height: 8 }, common, { fill: 'currentColor', opacity: 0.8, stroke: 'none' })));
    }

    /** 终端小图标（>_ 那个）。 */
    function TerminalGlyph(props) {
      var size = props.size || 13;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', pointerEvents: 'none' },
      },
        h('rect', {
          x: 2.5, y: 4, width: 19, height: 16, rx: 2.5,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        }),
        h('path', {
          d: 'M6.5 9.5 L9.5 12 L6.5 14.5 M12 14.5 H17',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    /**
     * 会话标题旁的「终端」按钮。
     *
     * 点一下 ⇒ 在**对话区上方**开一块浮动终端面板（destination: 'float'），
     * 而不是把终端塞进右侧栏。终端跑的是真 PTY（DSH 的 xterm + node-pty），
     * 在里面敲 claude 就是本机那套真 Claude Code 交互界面。
     *
     * ⚠ 两个坑：
     *   ① 组件第一个参数是 props，ctx 得从 props.ctx 拿；
     *   ② 取服务用 ctx.get('sidebarRight') 而不是 ctx.sidebarRight ——
     *      属性代理是在 fiber 创建时装的，工作台这个 fiber 早于右栏插件
     *      provide 服务，ctx.sidebarRight 会是 undefined；ctx.get 是实时的。
     */
    function FloatTerminalButton(props) {
      var ctx = props.ctx;
      var onClick = React.useCallback(function () {
        try {
          var sidebar = (ctx.get && ctx.get('sidebarRight')) || ctx.sidebarRight;
          if (!sidebar) throw new Error('拿不到右栏服务');
          // ⚠ openTab 不认 destination（只有 openResource 认）——
          //   所以走「先开进右栏、再把它拖成浮动面板」这两步。
          var wasExpanded = sidebar.isExpanded();
          sidebar.openTab('terminal');
          var tab = sidebar.active();
          if (tab === undefined || tab.kind !== 'terminal') {
            throw new Error('终端标签页没开出来');
          }
          // 浮在对话区右边（坐标是视口像素）。面板可以自己拖大拖小。
          var w = Math.max(520, Math.min(880, Math.round(window.innerWidth * 0.55)));
          var h = Math.max(300, Math.min(600, Math.round(window.innerHeight * 0.55)));
          sidebar.float(tab.id, {
            x: Math.max(16, window.innerWidth - w - 56),
            y: 96,
            width: w,
            height: h,
          });
          // 之前右栏是收着的，就把它收回去，别在对话旁边留一条空栏。
          if (!wasExpanded && sidebar.isExpanded()) sidebar.toggleExpanded();
        } catch (err) {
          console.warn('[工作台] 开浮动终端失败：', err);
        }
      }, [ctx]);
      return h('button', {
        type: 'button',
        title: '终端（浮在对话上）',
        'aria-label': '终端',
        onClick: onClick,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          height: '24px',
          padding: '0 8px',
          marginLeft: '4px',
          border: '1px solid var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.28))',
          borderRadius: '6px',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.75))',
          font: 'inherit',
          fontSize: '12px',
          cursor: 'pointer',
        },
      }, h(TerminalGlyph), '终端');
    }

    /** 主区里的工作台。 */
    function WorkbenchPanel() {
      const ref = React.useRef(null);

      React.useEffect(() => {
        let cancelled = false;
        let dispose = null;

        loadAssets().then(({ css }) => {
          if (cancelled || !ref.current) return;
          const host = ref.current;
          const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
          if (!window.WB || typeof window.WB.mount !== 'function') {
            throw new Error('工作台没装载上（window.WB.mount 不存在）');
          }
          // 样式交给 mount 放（mount 会重写 innerHTML，先挂的 style 会被冲掉）
          dispose = window.WB.mount(shadow, { base: MOUNT_PATH, css: css });
        }).catch((err) => {
          if (cancelled || !ref.current) return;
          const shadow = ref.current.shadowRoot || ref.current.attachShadow({ mode: 'open' });
          shadow.innerHTML = '';
          const box = document.createElement('div');
          box.style.cssText = 'padding:16px;color:#e6e8ee;font:13px/1.6 system-ui,sans-serif';
          box.textContent = '工作台装载失败：' + (err && err.message ? err.message : String(err));
          shadow.appendChild(box);
        });

        return () => {
          cancelled = true;
          if (typeof dispose === 'function') dispose();
        };
      }, []);

      return h('div', {
        ref,
        style: {
          height: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
      });
    }

    return {
      inject: ['slots', 'sidebarRight'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'workbench',
          order: 5,
          label: '工作台',
        }, PanelIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'workbench',
        }, WorkbenchPanel));

        // 会话标题旁挂一个「终端」按钮：点一下在对话上开浮动终端。
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'workbench-float-terminal',
        }, function () { return h(FloatTerminalButton, { ctx: ctx }); }));
      },
    };
  },
});
