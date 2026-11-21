// 学习通助手 · DSH 客户端半（科技风面板 v1.7.0）
// 右侧栏面板：课程输入 + 「确定」优先刷该课 + 8 个操作按钮 + 每 2.5 秒自动刷新的实时进度。
// 数据通道：宿主插件在 127.0.0.1:9483 起了个只监听环回地址的小 HTTP 服务（lib/uibridge.mjs），
// 面板用 fetch 读 /progress、发 /action —— 不走 ctx.remote.commands，所以不会往会话里刷记录。
(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return;

  window.__ModuleLoader__.load({
    id: '@local/chaoxing-assistant',
    factory(require) {
      const React = require('react');
      const h = React.createElement;

      const KIND = 'chaoxing';
      const DEF_ID = '@local/chaoxing-assistant';
      const VERSION = '1.9.5';
      const UI_PORT = 9483;
      const BASE = 'http://127.0.0.1:' + UI_PORT;
      const POLL_MS = 2500;
      const STYLE_ID = 'chaoxing-tech-style';

      const CSS = [
        '.cx-root{--cx-cyan:#38bdf8;--cx-mint:#34d399;--cx-dim:#6b8fb3;box-sizing:border-box;height:100%;display:flex;flex-direction:column;gap:10px;padding:12px;overflow:hidden;border-radius:12px;border:1px solid rgba(56,189,248,.26);background:radial-gradient(1200px 420px at 8% -20%,rgba(56,189,248,.16),transparent 62%),linear-gradient(165deg,#060b14,#0a1424 55%,#060d18);box-shadow:inset 0 0 0 1px rgba(56,189,248,.05),0 12px 32px rgba(2,8,20,.55);color:#dbeeff;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
        '.cx-head{display:flex;align-items:center;gap:8px}',
        '.cx-dot{width:8px;height:8px;border-radius:50%;background:var(--cx-mint);box-shadow:0 0 10px rgba(52,211,153,.9);animation:cx-pulse 1.6s ease-in-out infinite}',
        '.cx-dot.idle{background:#f0b429;box-shadow:0 0 8px rgba(240,180,41,.8);animation:none}',
        '@keyframes cx-pulse{0%,100%{opacity:.45;transform:scale(.82)}50%{opacity:1;transform:scale(1.08)}}',
        '.cx-title{font-weight:700;letter-spacing:.5px;background:linear-gradient(90deg,#7dd3fc,#34d399);-webkit-background-clip:text;background-clip:text;color:transparent}',
        '.cx-ver{margin-left:auto;padding:1px 7px;border-radius:999px;border:1px solid rgba(56,189,248,.35);color:#8fd6ff;font-size:10px}',
        '.cx-label{color:var(--cx-dim);font-size:11px;letter-spacing:.5px}',
        '.cx-row{display:flex;gap:8px;align-items:center}',
        '.cx-input{flex:1;min-width:0;padding:7px 10px;border-radius:8px;border:1px solid rgba(56,189,248,.22);background:rgba(8,20,36,.85);color:#dbeeff;outline:none;font-family:inherit;font-size:12px}',
        '.cx-input:focus{border-color:rgba(56,189,248,.6);box-shadow:0 0 0 3px rgba(56,189,248,.14)}',
        '.cx-ok{padding:7px 12px;border-radius:8px;border:1px solid rgba(52,211,153,.45);background:linear-gradient(180deg,rgba(16,185,129,.3),rgba(16,185,129,.12));color:#c9ffe8;cursor:pointer;font-family:inherit;font-size:12px}',
        '.cx-ok:hover{box-shadow:0 0 14px rgba(52,211,153,.4)}',
        '.cx-ok:disabled{opacity:.5;cursor:default}',
        '.cx-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
        '.cx-btn{display:flex;align-items:center;gap:6px;justify-content:center;padding:8px 6px;border-radius:8px;border:1px solid rgba(56,189,248,.25);background:linear-gradient(180deg,rgba(30,64,110,.55),rgba(9,20,38,.75));color:#cfe9ff;cursor:pointer;font-family:inherit;font-size:12px;transition:all .15s ease}',
        '.cx-btn:hover{transform:translateY(-1px);border-color:rgba(56,189,248,.55);box-shadow:0 4px 16px rgba(56,189,248,.22)}',
        '.cx-btn.primary{border-color:rgba(52,211,153,.4);color:#d8ffe9}',
        '.cx-btn.danger{border-color:rgba(248,113,113,.45);color:#ffd8d8}',
        '.cx-btn:disabled{opacity:.5;cursor:default;transform:none}',
        '.cx-glyph{font-size:13px}',
        '.cx-meta{display:flex;align-items:center;gap:8px;color:var(--cx-dim);font-size:10px}',
        '.cx-bar{flex:1;height:3px;border-radius:999px;background:rgba(56,189,248,.12);overflow:hidden}',
        '.cx-bar i{display:block;height:100%;width:38%;background:linear-gradient(90deg,transparent,#38bdf8,transparent);animation:cx-slide 1.4s linear infinite}',
        '@keyframes cx-slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}',
        '.cx-out{flex:1;min-height:60px;overflow:auto;padding:8px 10px;border-radius:8px;border:1px solid rgba(56,189,248,.16);background:rgba(4,10,20,.72);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-all}',
        '.cx-line{white-space:pre-wrap}',
        '.cx-line.head{color:#8fd6ff}',
        '.cx-line.ok{color:#7ef0c2}',
        '.cx-line.warn{color:#ffd68a}',
        '.cx-foot{color:var(--cx-dim);font-size:10px}',
        '.cx-entry{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:1px solid rgba(56,189,248,.3);background:rgba(8,24,44,.7);color:#bfe6ff;cursor:pointer;font-size:11px}',
        '.cx-modes{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
        '.cx-mode{padding:14px 8px;flex-direction:column;gap:6px;font-size:13px;letter-spacing:.5px}',
        '.cx-mode .cx-glyph{font-size:20px}',
        '.cx-mode.active{border-color:rgba(52,211,153,.75);color:#dbfff0;background:linear-gradient(180deg,rgba(16,185,129,.28),rgba(6,30,26,.85));box-shadow:0 0 18px rgba(52,211,153,.28),inset 0 0 12px rgba(52,211,153,.12)}',
        '.cx-mode.active::after{content:"已选择";font-size:9px;color:#7ef0c2;letter-spacing:1px}',
        '.cx-hint{padding:8px 10px;border-radius:8px;border:1px dashed rgba(56,189,248,.28);background:rgba(8,22,40,.55);color:#9dc2e2;font-size:11px;line-height:1.6}',
        '.cx-actions{display:flex;flex-direction:column;gap:10px}',
        '.cx-modebar{display:flex;align-items:center;gap:6px;font-size:10px;color:#8fd6ff}',
        '.cx-chip{padding:1px 8px;border-radius:999px;border:1px solid rgba(52,211,153,.45);background:rgba(16,185,129,.14);color:#b8ffe2}',
      ].join('');

      function ensureStyle() {
        if (typeof document === 'undefined') return () => {};
        if (document.getElementById(STYLE_ID)) return () => {};
        const el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = CSS;
        document.head.appendChild(el);
        return () => {
          try {
            el.remove();
          } catch (e) {}
        };
      }

      // ---------- 数据通道 ----------
      async function getProgress(mode) {
        const q = '?_=' + Date.now() + (mode ? '&mode=' + encodeURIComponent(mode) : '');
        const r = await fetch(BASE + '/progress' + q, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return String(await r.text());
      }

      async function postAction(action, body) {
        const r = await fetch(BASE + '/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action, ...(body || {}) }),
        });
        const j = await r.json().catch(() => ({}));
        return j;
      }

      // ---------- 错误边界 ----------
      const Base = (React && React.Component) || class {
        constructor(props) {
          this.props = props || {};
          this.state = {};
        }
        setState(next) {
          this.state = { ...this.state, ...(next || {}) };
        }
      };

      class PanelBoundary extends Base {
        constructor(props) {
          super(props);
          this.state = { err: '' };
        }
        static getDerivedStateFromError(err) {
          return { err: String((err && err.message) || err) };
        }
        componentDidCatch(err) {
          try {
            console.warn('[chaoxing] panel crashed', err);
          } catch (e) {}
        }
        render() {
          if (this.state.err) {
            return h('pre', { style: { padding: 12, fontSize: 12, whiteSpace: 'pre-wrap', color: '#ffd9d9' } }, '学习通面板渲染失败：' + this.state.err);
          }
          return this.props.children;
        }
      }

      // 两套入口共用同一套操作按钮，只是各自作用在自己那套系统上：
      //   网页版 → 插件控制的 Edge；桌面版 → 本机学习通客户端
      const ACTION_BUTTONS = [
        { key: 'start', label: '开始', glyph: '⚡', cls: 'primary' },
        { key: 'stop', label: '停止', glyph: '■', cls: 'danger' },
        { key: 'login', label: '登录', glyph: '⤴' },
        { key: 'check', label: '检查', glyph: '✓' },
        { key: 'scan', label: '扫描', glyph: '⌕', needsCourse: true },
        { key: 'run', label: '刷课', glyph: '▶', needsCourse: true },
        { key: 'works', label: '作业', glyph: '✎', needsCourse: true },
        { key: 'refresh', label: '刷新', glyph: '⟳' },
      ];

      function buttonsOf() {
        return ACTION_BUTTONS;
      }

      // 两个入口：选一个版本后，下面的操作按钮才显示
      const MODE_BUTTONS = [
        { key: 'web', label: '网页版', glyph: '🌐', desc: '在 Edge 里打开学习通网页' },
        { key: 'desktop', label: '桌面版', glyph: '🖥', desc: '启动本机学习通客户端' },
      ];


      function lineClass(line) {
        if (/已停止|出错|错误|失败|未登录|找不到|异常/.test(line)) return 'cx-line warn';
        if (/✅|已登录|已开始|已继续|本轮完成|已优先/.test(line)) return 'cx-line ok';
        if (/^[▸›]/.test(line)) return 'cx-line head';
        return 'cx-line';
      }

      function Panel(props) {
        const ctx = props.ctx;
        const [text, setText] = React.useState('› 正在连接面板服务…');
        const [busy, setBusy] = React.useState('');
        const [course, setCourse] = React.useState('');
        const [live, setLive] = React.useState(true);
        // 入口选择：null = 还没选，仅显示「网页版 / 桌面版」两个大按钮
        const [mode, setMode] = React.useState(null);
        const modeRef = React.useRef(null);
        React.useEffect(() => { modeRef.current = mode; }, [mode]);
        const alive = React.useRef(true);
        const pollRef = React.useRef(null);

        React.useEffect(() => {
          alive.current = true;
          const tick = async () => {
            try {
              const t = await getProgress(modeRef.current);
              if (alive.current) {
                setText(t);
                setLive(true);
              }
            } catch (e) {
              if (alive.current) {
                setLive(false);
                setText(
                  '› 面板服务未连接（' +
                    String((e && e.message) || e) +
                    '）。\n› 面板服务随插件启动，若刚更新插件请完整重启 DSH；也可以用 /chaoxing progress 命令查看。'
                );
              }
            }
          };
          tick();
          pollRef.current = setInterval(tick, POLL_MS);
          return () => {
            alive.current = false;
            if (pollRef.current) clearInterval(pollRef.current);
          };
        }, []);

        const act = React.useCallback(
          async (key, forceMode) => {
            const curMode = forceMode || modeRef.current;
            const payload = { action: key };
            const btn = (buttonsOf(curMode).find((b) => b.key === key) || {});
            if (key === 'focus' || btn.needsCourse) payload.course = course.trim();
            // 传当前入口：桌面版=在学习通客户端里操作，网页版=在 Edge 里操作
            const body = { course: payload.course, mode: curMode || undefined };
            if (payload.course && ['start', 'scan', 'run', 'works', 'focus'].includes(key)) body.courses = [payload.course];
            setBusy(key);
            try {
              const j = await postAction(payload.action, body);
              if (alive.current) {
                setText('› ' + String((j && j.text) || '已执行'));
                if (j && j.ok === false) setLive(false);
                else setLive(true);
              }
              return j;
            } catch (e) {
              if (alive.current) setText('› 操作失败：' + String((e && e.message) || e));
              return { ok: false };
            } finally {
              if (alive.current) setBusy('');
            }
          },
          [course, mode]
        );

        // 选入口：点了就先执行 web/desktop，再展开下面的操作按钮
        const chooseMode = React.useCallback(
          async (key) => {
            modeRef.current = key;
            if (alive.current) {
              setMode(key);
              setText('› 正在切换到' + (key === 'desktop' ? '桌面版（学习通客户端）' : '网页版（Edge）') + '…');
            }
            await act(key, key);
            if (alive.current) setMode(key);
          },
          [act]
        );

        const modeLabel = mode === 'web' ? '网页版' : mode === 'desktop' ? '桌面版' : '';

        return h(
          'div',
          { className: 'cx-root' },
          h(
            'div',
            { className: 'cx-head' },
            h('span', { className: 'cx-dot' + (live ? '' : ' idle') }),
            h('span', { className: 'cx-title' }, '学习通助手'),
            h('span', { className: 'cx-ver' }, 'v' + VERSION)
          ),
          // 第一步：只显示两个入口
          h(
            'div',
            { className: 'cx-modes' },
            MODE_BUTTONS.map((b) =>
              h(
                'button',
                {
                  key: b.key,
                  type: 'button',
                  className: 'cx-btn cx-mode' + (mode === b.key ? ' active' : ''),
                  disabled: !!busy,
                  title: b.desc,
                  onClick: () => chooseMode(b.key),
                },
                h('span', { className: 'cx-glyph' }, b.glyph),
                h('span', null, busy === b.key ? b.label + '…' : b.label)
              )
            )
          ),
          mode
            ? h(
                'div',
                { className: 'cx-modebar' },
                h('span', null, '当前入口'),
                h('span', { className: 'cx-chip' }, modeLabel),
                h('span', null, '· 点另一个可切换')
              )
            : h(
                'div',
                { className: 'cx-hint' },
                '先选一个入口：网页版 = 在插件控制的 Edge 里打开学习通；桌面版 = 启动本机学习通客户端。选好后下面才会出现 开始 / 扫描 / 刷课 / 作业 等操作按钮。'
              ),
          // 第二步：选好入口后才显示的操作区（网页版/桌面版的按钮各管各的）
          h(
            'div',
            { className: 'cx-actions', style: mode ? undefined : { display: 'none' } },
            h(
              'div',
              { className: 'cx-label' },
              mode === 'desktop'
                ? '目标课程（可留空 = 客户端里所有课程；填了就先点「确定」锁定这门课）'
                : '目标课程（可留空，或用课程名锁定这一门）'
            ),
            h(
              'div',
              { className: 'cx-row' },
              h('input', {
                className: 'cx-input',
                value: course,
                spellCheck: false,
                placeholder: '输课程名，如：电工电子技术',
                onChange: (e) => setCourse(e.target.value),
              }),
              h(
                'button',
                { type: 'button', className: 'cx-ok', disabled: !!busy || !course.trim(), onClick: () => act('focus') },
                busy === 'focus' ? '…' : '确定'
              )
            ),
            h(
              'div',
              { className: 'cx-grid' },
              buttonsOf(mode).map((b) =>
                h(
                  'button',
                  {
                    key: b.key,
                    type: 'button',
                    className: 'cx-btn' + (b.cls ? ' ' + b.cls : ''),
                    disabled: !!busy,
                    onClick: () => act(b.key),
                  },
                  h('span', { className: 'cx-glyph' }, b.glyph),
                  h('span', null, busy === b.key ? b.label + '…' : b.label)
                )
              )
            ),
            h(
              'div',
              { className: 'cx-hint' },
              mode === 'desktop'
                ? '桌面版按钮只控制本机学习通客户端（不打开 Edge）：开始 = 打开客户端刷课/做题；扫描 = 读课程与未完成数；作业 = 逐份做未交作业；停止 = 只停桌面任务（客户端不关、不会再弹窗）'
                : '网页版按钮只控制插件打开的 Edge（不会动学习通客户端）：开始 = 全自动托管；登录/检查/扫描/刷课/作业 都只对网页版生效'
            )
          ),
          h(
            'div',
            { className: 'cx-meta' },
            h('span', null, (busy ? 'RUNNING · ' + busy : live ? '实时进度 · 每 ' + POLL_MS / 1000 + ' 秒' : '服务未连接') + ' · ' + (modeLabel ? modeLabel + ' · ' : '') + (props.sessionId ? '会话已就绪' : '未选会话')),
            h('div', { className: 'cx-bar' }, h('i'))
          ),
          h(
            'div',
            { className: 'cx-out', 'data-chaoxing-output': '1' },
            String(text || '')
              .split('\n')
              .slice(0, 40)
              .map((line, i) => h('div', { key: i, className: lineClass(line) }, line || ' '))
          ),
          h('div', { className: 'cx-foot' }, '网页版 / 桌面版 = 选择用哪个学习通（两套按钮互不串台） · 确定 = 优先完成该课程')
        );
      }

      function EntryButton(props) {
        const ctx = props.ctx;
        const open = () => {
          try {
            if (props.sessionId && ctx.sidebarRight.openTabIn) ctx.sidebarRight.openTabIn(props.sessionId, KIND);
            else ctx.sidebarRight.openTab(KIND);
          } catch (e) {
            try {
              ctx.sidebarRight.openTab(KIND);
            } catch (e2) {}
          }
          try {
            ctx.layout.openRightbar(true, false);
          } catch (e) {}
        };
        return h('button', { type: 'button', className: 'cx-entry', onClick: open }, '📚 学习通');
      }

      function apply(ctx) {
        const disposeStyle = ensureStyle();
        if (ctx.effect) ctx.effect(() => disposeStyle, 'chaoxing: style');
        else ctx.on?.('dispose', disposeStyle);

        try {
          const def = {
            id: DEF_ID,
            kind: KIND,
            priority: 'extension',
            multiple: false,
            keepMounted: true,
            title: () => '学习通助手',
          };
          const disposeTab = ctx.sidebarRightTabs.register(def);
          if (ctx.effect) ctx.effect(() => disposeTab, 'chaoxing: tab type');
        } catch (e) {
          try {
            console.warn('[chaoxing] register tab type failed', e && e.message);
          } catch (e2) {}
        }

        try {
          const disposePane = ctx.slots.register({ name: 'sidebar.right.pane.tab', key: DEF_ID }, (props) =>
            h(PanelBoundary, null, h(Panel, { ...props, ctx }))
          );
          if (ctx.effect) ctx.effect(() => disposePane, 'chaoxing: pane');
        } catch (e) {
          try {
            console.warn('[chaoxing] register pane failed', e && e.message);
          } catch (e2) {}
        }

        try {
          const disposeEntry = ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'chaoxing-entry', order: 40 }, (props) =>
            h(EntryButton, { ...props, ctx })
          );
          if (ctx.effect) ctx.effect(() => disposeEntry, 'chaoxing: entry');
        } catch (e) {
          try {
            console.warn('[chaoxing] register entry failed', e && e.message);
          } catch (e2) {}
        }

        // 说明：面板不再做「关旧 tab」自愈 —— 判断宿主 tab 记录是否失效不可靠，
        // 误关会打断用户正在看的页面。若右侧栏空白，完整重启 DSH 即可重新加载本模块。
      }

      return {
        inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'layout'],
        apply,
      };
    },
  });
})();
