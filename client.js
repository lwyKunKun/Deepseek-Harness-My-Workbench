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
      inject: ['slots'],
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
      },
    };
  },
});
