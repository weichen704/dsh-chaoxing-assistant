window.__ModuleLoader__.load({
  id: 'dsh-chaoxing-assistant',
  factory(require) {
    const React = require('react');
    if (!React || typeof React.createElement !== 'function') return {};

    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useMemo = React.useMemo;
    const DEF_ID = 'dsh-chaoxing-assistant';
    const VERSION = '2.3.1';
    const UI_PORT = 9483;
    // 两条传输：优先 DSH 同源路由（dsh-app://app 下无 CORS/无额外端口），失败再退到本机独立端口。
    // v2.2.1 只写死了 http://127.0.0.1:9483，桌面端 Origin 是 dsh-app://app，被桥 403 掉 → 永远「未连接」。
    const ROUTE_BASE = '/chaoxing';
    const LEGACY_BASE = 'http://127.0.0.1:' + UI_PORT;
    const BASES = [ROUTE_BASE, LEGACY_BASE];
    let activeBase = null;
    const POLL_MS = 2500;
    const HIDDEN_POLL_MS = 8000;
    const MAX_BACKOFF_MS = 20000;
    const MAX_LINES = 240;
    const STYLE_ID = 'chaoxing-tech-style';
    const COURSE_KEY = 'chaoxing.course';
    const MODE_KEY = 'chaoxing.mode';

    /* ---------------- 面板服务 API ---------------- */

    function timed(ms) {
      const ctl = new AbortController();
      const t = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, ms);
      return { signal: ctl.signal, done: () => clearTimeout(t) };
    }

    function nowMs() {
      try {
        if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
      } catch (e) { /* ignore */ }
      return Date.now();
    }

    function baseLabel() {
      if (!activeBase) return '未连接';
      return activeBase === ROUTE_BASE ? '同源 /chaoxing' : '127.0.0.1:' + UI_PORT;
    }

    /** 先试同源路由，再退到本机 9483；成功的那条被记住，失败后下次重排 */
    function baseOrder() {
      return activeBase ? [activeBase].concat(BASES.filter((b) => b !== activeBase)) : BASES.slice();
    }

    function dropBase() { activeBase = null; }

    async function apiFetch(path, init, ms) {
      const order = baseOrder();
      let lastError = null;
      for (let i = 0; i < order.length; i += 1) {
        const b = order[i];
        const w = timed(ms);
        try {
          const r = await fetch(b + path, Object.assign({ cache: 'no-store' }, init || {}, { signal: w.signal }));
          // 404/405 = 这条通道没有该路由（例如旧宿主还没有 /chaoxing），换下一条
          if (r && (r.status === 404 || r.status === 405)) {
            lastError = new Error('HTTP ' + r.status);
            continue;
          }
          activeBase = b;
          return r;
        } catch (e) {
          lastError = e;
        } finally { w.done(); }
      }
      activeBase = null;
      throw lastError || new Error('面板服务不可达');
    }

    async function getProgress(mode) {
      const r = await apiFetch('/progress?_=' + Date.now() + (mode ? '&mode=' + encodeURIComponent(mode) : ''), null, 6000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    }

    async function getState() {
      try {
        const r = await apiFetch('/state?_=' + Date.now(), null, 6000);
        if (!r.ok) return null;
        const j = await r.json();
        return j && typeof j === 'object' ? j : null;
      } catch (e) {
        return null;
      }
    }

    /** 一次取齐「进度文本 + 状态」：每 tick 只发 1 个请求 */
    async function getSnapshot(mode) {
      const r = await apiFetch('/snapshot?mode=' + encodeURIComponent(mode || ''), null, 6000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j || typeof j !== 'object') throw new Error('面板服务返回了无法解析的数据');
      return {
        text: typeof j.text === 'string' ? j.text : '',
        state: j.state && typeof j.state === 'object' ? j.state : null,
      };
    }

    async function postAction(action, body) {
      const r = await apiFetch('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: action }, body || {})),
      }, 90000);
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { /* 非 JSON 响应 */ }
      if (!j || typeof j !== 'object') return { ok: r.ok, text: txt || ('面板服务返回 HTTP ' + r.status) };
      return j;
    }

    /* ---------------- 文案与格式化 ---------------- */

    const PHASES = {
      idle: '空闲',
      'starting-browser': '启动浏览器',
      'waiting-login': '等待登录',
      discovering: '扫描课程',
      working: '自动刷课',
      done: '已完成',
      error: '出错',
      stopped: '已停止',
    };

    const DESK_PHASES = {
      launching: '启动客户端',
      navigating: '打开页面',
      scanning: '扫描课程',
      works: '做作业',
      running: '运行中',
      starting: '启动中',
    };

    const MODES = [
      { key: 'web', name: '网页版', desc: '插件自带的 Edge' },
      { key: 'desktop', name: '桌面版', desc: '本机学习通客户端' },
    ];

    const CTA = [
      { key: 'start', label: '开始', cls: 'start' },
      { key: 'stop', label: '停止', cls: 'stop' },
    ];

    // 主操作：直接动任务队列
    const CORE = [
      { key: 'scan', label: '扫描', needsCourse: true },
      { key: 'run', label: '刷课', needsCourse: true },
      { key: 'works', label: '作业', needsCourse: true },
    ];

    // 辅助操作：准备与查看
    const AUX = [
      { key: 'login', label: '登录' },
      { key: 'check', label: '检查' },
      { key: 'refresh', label: '刷新' },
    ];

    const ALL_ACTIONS = CTA.concat(CORE).concat(AUX);
    const NEEDS_COURSE = ['scan', 'run', 'works'];
    const ACTION_LABELS = {};
    ALL_ACTIONS.forEach((a) => { ACTION_LABELS[a.key] = a.label; });
    ACTION_LABELS.focus = '确定';

    function labelOf(key) {
      return ACTION_LABELS[key] || key;
    }

    function fmtClock(sec) {
      const s = Math.max(0, Math.floor(sec || 0));
      const hh = Math.floor(s / 3600);
      const mm = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      const pad = (n) => (n < 10 ? '0' + n : '' + n);
      return (hh ? hh + ':' : '') + pad(mm) + ':' + pad(ss);
    }

    function fmtTime(ts) {
      try {
        const d = new Date(ts);
        const pad = (n) => (n < 10 ? '0' + n : '' + n);
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      } catch (e) { return ''; }
    }

    /** 进度文本里的运行时长的解析：网页版「已运行 00:12:34」/ 桌面版「▸ 桌面版 scanning · 12:34」 */
    function parseElapsed(text) {
      const line = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
      if (!line) return null;
      let m = /已运行\s*(\d{1,3}(?::\d{1,2}){1,2})/.exec(line);
      if (!m) m = /^▸\s*桌面版[^·]*·\s*(\d{1,3}(?::\d{1,2}){1,2})/.exec(line);
      if (!m) return null;
      const parts = m[1].split(':').map((x) => parseInt(x, 10));
      if (parts.some((n) => !isFinite(n))) return null;
      let s = 0;
      for (let i = 0; i < parts.length; i += 1) s = s * 60 + parts[i];
      return s;
    }

    /** 旧桥没有 /state.desktop 时，从进度文本首行兜底推断桌面版阶段 */
    function deskHeadFromText(text) {
      const line = String(text || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
      const m = /^▸\s*桌面版\s*([^·]*)/.exec(line);
      return m ? String(m[1] || '').trim() : '';
    }

    function loadCourse() {
      try { return localStorage.getItem(COURSE_KEY) || ''; } catch (e) { return ''; }
    }

    function saveCourse(v) {
      try { localStorage.setItem(COURSE_KEY, v); } catch (e) { /* ignore */ }
    }

    function loadMode() {
      try {
        const m = localStorage.getItem(MODE_KEY);
        // 默认「网页版」：老版本什么都没存时会返回 null，导致所有按钮 disabled，
        // 用户看到的就是「点了没反应」。
        return m === 'desktop' ? 'desktop' : 'web';
      } catch (e) { return 'web'; }
    }

    function saveMode(v) {
      try { if (v) localStorage.setItem(MODE_KEY, v); } catch (e) { /* ignore */ }
    }

    function lineClass(line) {
      if (/^▸/.test(line)) return 'cx-line cx-line-head';
      if (/已完成|已登录|已继续|已锁定|本轮完成|成功/.test(line)) return 'cx-line cx-line-ok';
      if (/失败|出错|错误|异常|超时|未登录|找不到|未连接|不可用|拒绝/.test(line)) return 'cx-line cx-line-warn';
      if (/^\s{2,}[·-]/.test(line)) return 'cx-line cx-line-dim';
      return 'cx-line';
    }

    /** 只比较业务字段：/state 的 at 每次都变，不能因此触发整块重渲染 */
    function sameState(a, b) {
      if (a === b) return true;
      if (!a || !b) return false;
      try {
        const ca = Object.assign({}, a);
        const cb = Object.assign({}, b);
        delete ca.at;
        delete cb.at;
        return JSON.stringify(ca) === JSON.stringify(cb);
      } catch (e) {
        return false;
      }
    }

    /* ---------------- 样式 ---------------- */

    const CSS = `.cx-root{
  /* ---- 色彩：冷调玻璃，一层冷光、一层薄荷色状态 ---- */
  --bg:#06070a;
  --text:#eef1f7;
  --text-2:#a7aebd;
  --text-3:#767e8d;
  --accent:#a9c1ff;
  --accent-2:#829fff;
  --accent-soft:rgba(169,193,255,.12);
  --accent-line:rgba(169,193,255,.34);
  --ok:#9fe0c0;
  --warn:#e8cd9c;
  --err:#eeb2b8;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Microsoft YaHei UI",monospace;
  /* ---- 玻璃材质：高光边 / 接触阴影 / 环境光 ---- */
  --rim-hi:rgba(255,255,255,.46);
  --rim-mid:rgba(255,255,255,.10);
  --rim-lo:rgba(169,193,255,.20);
  --contact:0 1px 0 rgba(0,0,0,.55);
  --drop:0 26px 46px -34px rgba(0,0,0,1),0 10px 20px -16px rgba(0,0,0,.92);

  position:relative;box-sizing:border-box;height:100%;width:100%;
  display:flex;flex-direction:column;gap:10px;
  padding:13px 13px 11px;border-radius:15px;
  border:1px solid rgba(255,255,255,.07);
  overflow-y:auto;overflow-x:hidden;
  background:
    radial-gradient(118% 62% at 50% -18%,rgba(169,193,255,.22),rgba(169,193,255,0) 62%),
    radial-gradient(74% 46% at 106% -2%,rgba(146,124,255,.14),rgba(146,124,255,0) 62%),
    radial-gradient(96% 48% at 50% 114%,rgba(96,128,220,.10),rgba(96,128,220,0) 68%),
    radial-gradient(80% 52% at -8% 96%,rgba(122,220,192,.055),rgba(122,220,192,0) 64%),
    linear-gradient(180deg,#0b0d13 0%,#090a0e 42%,#060709 100%);
  color:var(--text);font-size:12.5px;line-height:1.6;color-scheme:dark;
  font-family:ui-sans-serif,"Microsoft YaHei UI","PingFang SC","HarmonyOS Sans SC",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  container:cxroot/inline-size;
  animation:cx-enter .42s cubic-bezier(.2,.7,.2,1) both;
}
/* 顶部一道冷光：面板与宿主窗口的“分界光” */
.cx-root::before{content:"";position:absolute;top:0;left:16px;right:16px;height:1px;pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(190,209,255,.55),rgba(255,255,255,.10),transparent)}
.cx-root::-webkit-scrollbar{width:8px}
.cx-root::-webkit-scrollbar-thumb{background:rgba(255,255,255,.10);border-radius:999px}
.cx-root::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.18)}
.cx-root::-webkit-scrollbar-track{background:transparent}
.cx-root *,.cx-root *::before,.cx-root *::after{box-sizing:border-box}

/* =========================================================
   L1 · 玻璃面板（抬起的表面）
   ========================================================= */
.cx-head,.cx-controls,.cx-metrics,.cx-notice,.cx-console{
  position:relative;
  border:1px solid rgba(255,255,255,.085);
  background:
    linear-gradient(180deg,rgba(255,255,255,.062),rgba(255,255,255,.026) 46%,rgba(255,255,255,.012));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.17),
    inset 0 -1px 0 rgba(255,255,255,.028),
    var(--contact),var(--drop);
}

/* ---- 高光边：只在支持 mask 合成的环境启用，避免降级成实心块 ---- */
@supports (mask-composite:exclude) or (-webkit-mask-composite:xor){
  .cx-head::after,.cx-controls::before,.cx-metrics::before{
    content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;
    background:linear-gradient(152deg,var(--rim-hi),var(--rim-mid) 27%,rgba(255,255,255,.02) 62%,var(--rim-lo));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor;mask-composite:exclude;
  }
}

/* =========================================================
   L0 · 头部
   ========================================================= */
.cx-head{display:flex;align-items:center;gap:11px;min-width:0;flex:none;padding:12px;
  border-radius:16px;overflow:hidden;
  background:
    radial-gradient(120% 130% at 88% -30%,rgba(150,180,255,.22),rgba(150,180,255,0) 60%),
    linear-gradient(160deg,rgba(255,255,255,.085),rgba(255,255,255,.030) 52%,rgba(255,255,255,.014));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.22),
    inset 0 -1px 0 rgba(255,255,255,.03),
    var(--contact),0 26px 44px -34px rgba(0,0,0,1),0 8px 18px -16px rgba(120,150,255,.35);
}
.cx-head::before{content:"";position:absolute;left:-30px;bottom:-84px;width:210px;height:160px;border-radius:50%;
  background:radial-gradient(closest-side,rgba(169,193,255,.20),transparent);pointer-events:none}
.cx-head>*{position:relative;z-index:1}
.cx-logo{flex:none;width:36px;height:36px;border-radius:12px;display:grid;place-items:center;
  border:1px solid rgba(255,255,255,.72);color:#0a0c11;
  background:
    radial-gradient(120% 120% at 30% -20%,#ffffff,rgba(255,255,255,0) 62%),
    linear-gradient(155deg,#fdfefe 0%,#eef2f8 40%,#d3dce9 72%,#bcc7d8 100%);
  font-family:"Songti SC","STSong","SimSun",serif;font-size:18px;font-weight:700;line-height:1;
  letter-spacing:-.04em;text-indent:-.02em;
  box-shadow:
    inset 0 1px 0 #fff,
    inset 0 -1px 1px rgba(0,0,0,.20),
    inset 0 8px 14px -10px rgba(255,255,255,.95),
    0 2px 4px rgba(0,0,0,.35),
    0 10px 20px -10px rgba(150,180,255,.55);
}
.cx-brand{min-width:0;display:flex;flex-direction:column;gap:2px}
.cx-title{font-size:15px;font-weight:650;letter-spacing:.014em;color:#f8f9fc;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  text-shadow:0 1px 1px rgba(0,0,0,.35)}
.cx-sub{font-size:8.5px;font-weight:500;letter-spacing:.16em;color:var(--text-3);
  text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cx-pill{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:6px;max-width:48%;
  padding:4px 9px;border-radius:999px;color:var(--text-2);
  border:1px solid rgba(255,255,255,.10);
  background:linear-gradient(180deg,rgba(255,255,255,.085),rgba(255,255,255,.03));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 1px 2px rgba(0,0,0,.35);
  font-size:10.5px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cx-pill .cx-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none;opacity:.9}
.cx-pill.on{color:#bff0d8;border-color:rgba(159,224,192,.26);
  background:linear-gradient(180deg,rgba(159,224,192,.16),rgba(159,224,192,.06));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 0 16px -6px rgba(159,224,192,.45)}
.cx-pill.on .cx-dot{box-shadow:0 0 8px rgba(159,224,192,.75);animation:cx-breathe 2.6s ease-in-out infinite}
.cx-pill.idle{color:var(--text-2)}
.cx-pill.off{color:#f2bcc2;border-color:rgba(238,178,184,.28);
  background:linear-gradient(180deg,rgba(238,178,184,.14),rgba(238,178,184,.05))}

/* =========================================================
   L1 · 分区标题（层级：小标题 + 发丝延长线）
   ========================================================= */
.cx-section,.cx-course{display:flex;flex-direction:column;gap:6px;flex:none}
.cx-cap{display:flex;align-items:center;gap:8px;min-width:0;padding:0 2px;
  font-size:9.5px;font-weight:600;letter-spacing:.15em;line-height:1.4;
  color:var(--text-3);text-transform:uppercase}
.cx-cap>span:first-child{flex:none;display:inline-flex;align-items:center;gap:6px}
.cx-cap>span:first-child::before{content:"";width:2px;height:9px;border-radius:2px;flex:none;
  background:linear-gradient(180deg,var(--accent),rgba(169,193,255,.05))}
.cx-cap::after{content:"";height:1px;flex:1;min-width:12px;
  background:linear-gradient(90deg,rgba(255,255,255,.13),rgba(255,255,255,0))}
.cx-cap-hint{flex:none;font-size:9px;font-weight:400;letter-spacing:.04em;text-transform:none;
  color:var(--text-3);opacity:.78;white-space:nowrap}

/* =========================================================
   L2 · 分段开关：凹陷玻璃槽 + 抬起玻璃片
   ========================================================= */
.cx-modes{display:flex;gap:3px;padding:4px;height:38px;flex:none;border-radius:12px;
  border:1px solid rgba(255,255,255,.07);
  background:linear-gradient(180deg,rgba(0,0,0,.34),rgba(255,255,255,.018));
  box-shadow:
    inset 0 2px 7px rgba(0,0,0,.55),
    inset 0 -1px 0 rgba(255,255,255,.055),
    0 1px 0 rgba(255,255,255,.03)}
.cx-mode{position:relative;flex:1;display:flex;align-items:center;justify-content:center;gap:6px;
  padding:0 8px;border:1px solid transparent;border-radius:9px;background:transparent;
  color:var(--text-3);font-family:inherit;font-size:11.5px;letter-spacing:.02em;cursor:pointer;
  transition:color .2s ease,background .2s ease,border-color .2s ease,box-shadow .2s ease,transform .2s ease}
.cx-mode:hover:not(:disabled){color:var(--text-2);background:rgba(255,255,255,.035)}
.cx-mode.active{color:#f7f9fc;font-weight:600;border-color:rgba(255,255,255,.15);
  background:linear-gradient(180deg,rgba(255,255,255,.17),rgba(255,255,255,.075) 52%,rgba(255,255,255,.05));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.42),
    inset 0 -1px 0 rgba(255,255,255,.06),
    0 1px 1px rgba(0,0,0,.45),
    0 8px 18px -12px rgba(150,180,255,.55)}
.cx-mode.active::after{content:"";position:absolute;left:50%;bottom:3px;width:16px;height:2px;border-radius:2px;
  transform:translateX(-50%);background:linear-gradient(90deg,var(--accent-2),var(--accent));
  box-shadow:0 0 10px rgba(169,193,255,.65)}
.cx-mode:disabled{opacity:.4;cursor:not-allowed}

/* =========================================================
   L2 · 课程输入：内凹玻璃槽
   ========================================================= */
.cx-row{display:flex;gap:7px;align-items:center}
.cx-inputwrap{flex:1;min-width:0;display:flex;align-items:center;gap:5px;height:36px;padding:0 11px;
  border-radius:10px;border:1px solid rgba(255,255,255,.075);
  background:linear-gradient(180deg,rgba(0,0,0,.36),rgba(255,255,255,.02));
  box-shadow:inset 0 2px 6px rgba(0,0,0,.42),inset 0 -1px 0 rgba(255,255,255,.05);
  transition:border-color .2s ease,box-shadow .2s ease,background .2s ease}
.cx-inputwrap:focus-within{border-color:rgba(169,193,255,.42);
  background:linear-gradient(180deg,rgba(20,26,44,.5),rgba(169,193,255,.05));
  box-shadow:inset 0 2px 6px rgba(0,0,0,.35),0 0 0 3px rgba(169,193,255,.09),0 0 18px -8px rgba(169,193,255,.55)}
.cx-input{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--text);outline:none;
  font-family:inherit;font-size:12.5px;letter-spacing:.01em}
.cx-input::placeholder{color:#6d7483}
.cx-clear{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;
  color:var(--text-3);font-family:inherit;font-size:13px;line-height:1;cursor:pointer;
  display:grid;place-items:center;transition:color .15s ease,background .15s ease}
.cx-clear:hover{color:var(--text);background:rgba(255,255,255,.09)}
.cx-ok{flex:none;height:36px;min-width:66px;padding:0 14px;border-radius:10px;
  color:var(--text);font-family:inherit;font-size:12px;font-weight:550;cursor:pointer;
  position:relative;
  border:1px solid rgba(255,255,255,.13);
  background:
    radial-gradient(120% 100% at 50% -40%,rgba(255,255,255,.26),rgba(255,255,255,0) 58%),
    linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.05) 55%,rgba(255,255,255,.03));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.38),
    inset 0 -1px 0 rgba(255,255,255,.05),
    0 1px 1px rgba(0,0,0,.5),
    0 10px 20px -16px rgba(0,0,0,.95);
  transition:background .2s ease,border-color .2s ease,box-shadow .2s ease,transform .2s ease,opacity .2s ease}
.cx-ok:not(:disabled):hover{border-color:rgba(255,255,255,.22);transform:translateY(-1px);
  background:
    radial-gradient(120% 100% at 50% -40%,rgba(255,255,255,.34),rgba(255,255,255,0) 58%),
    linear-gradient(180deg,rgba(255,255,255,.17),rgba(255,255,255,.075) 55%,rgba(255,255,255,.04));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 2px 3px rgba(0,0,0,.4),0 14px 24px -16px rgba(150,180,255,.5)}
.cx-ok:not(:disabled):active{transform:translateY(0) scale(.995)}
.cx-ok:disabled{opacity:.38;cursor:not-allowed}

/* =========================================================
   L2 · 主控台：玻璃甲板 + 液态玻璃按钮
   ========================================================= */
.cx-controls{display:flex;flex-direction:column;gap:8px;flex:none;padding:10px;border-radius:14px;
  background:
    radial-gradient(90% 60% at 50% -20%,rgba(169,193,255,.10),rgba(169,193,255,0) 60%),
    linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.018) 55%,rgba(255,255,255,.01));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.14),
    inset 0 -1px 0 rgba(255,255,255,.025),
    var(--contact),0 24px 40px -32px #000}
.cx-cta{display:grid;grid-template-columns:minmax(0,1fr) 88px;gap:8px}

/* 液态玻璃按钮母版：高光穹顶 + 边缘折射 + 底部焦散 */
.cx-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:37px;padding:0 10px;border-radius:11px;cursor:pointer;white-space:nowrap;
  overflow:hidden;
  border:1px solid rgba(255,255,255,.13);color:var(--text-2);
  font-family:inherit;font-size:12.5px;letter-spacing:.02em;
  background:
    radial-gradient(125% 105% at 50% -45%,rgba(255,255,255,.30),rgba(255,255,255,0) 60%),
    linear-gradient(180deg,rgba(255,255,255,.115),rgba(255,255,255,.05) 52%,rgba(255,255,255,.028));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.36),
    inset 0 -1px 0 rgba(255,255,255,.05),
    inset 0 -12px 18px -16px rgba(255,255,255,.42),
    0 1px 1px rgba(0,0,0,.5),
    0 8px 18px -14px rgba(0,0,0,.95);
  transition:background .2s ease,border-color .2s ease,color .2s ease,box-shadow .2s ease,transform .2s ease,opacity .2s ease}
/* 扫光：只在 hover 时掠过，模拟玻璃表面的镜面反射 */
.cx-btn::before,.cx-ok::before,.cx-tool::before{content:"";position:absolute;inset:-1px;border-radius:inherit;
  pointer-events:none;opacity:0;z-index:0;
  background:linear-gradient(105deg,rgba(255,255,255,0) 36%,rgba(255,255,255,.42) 48%,rgba(255,255,255,.08) 56%,rgba(255,255,255,0) 64%)}
.cx-btn:hover:not(:disabled)::before,.cx-ok:hover:not(:disabled)::before,.cx-tool:hover::before{
  animation:cx-sheen .82s cubic-bezier(.32,.72,.32,1)}
/* 边缘折射：1px 渐变亮边 */
@supports (mask-composite:exclude) or (-webkit-mask-composite:xor){
  .cx-btn::after,.cx-ok::after,.cx-mode.active::before{
    content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;
    background:linear-gradient(178deg,rgba(255,255,255,.62),rgba(255,255,255,.13) 26%,rgba(255,255,255,.03) 64%,rgba(255,255,255,.24));
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
    -webkit-mask-composite:xor;mask-composite:exclude;
  }
  .cx-btn.start::after{background:linear-gradient(178deg,#fff,rgba(255,255,255,.74) 24%,rgba(186,208,255,.46) 62%,rgba(128,164,255,.88))}
  .cx-btn.stop::after{background:linear-gradient(178deg,rgba(255,220,222,.55),rgba(255,220,222,.14) 30%,rgba(255,220,222,.05) 66%,rgba(238,178,184,.32))}
  .cx-tools .cx-btn::after{background:linear-gradient(178deg,rgba(255,255,255,.30),rgba(255,255,255,.08) 30%,rgba(255,255,255,.02) 66%,rgba(255,255,255,.12))}
}
.cx-btn:disabled{opacity:.35;cursor:not-allowed}
.cx-btn[aria-busy="true"]{color:var(--text)}
.cx-btn-label{position:relative;z-index:1;white-space:nowrap}

/* 主按钮：液态玻璃 —— 透光（backdrop-blur 吸走背后底色）+ 镜面弧光 + 冷色折射边 + 底部焦散 */
.cx-btn.start{color:#0b1220;font-weight:700;letter-spacing:.045em;
  border-color:rgba(255,255,255,.62);
  background:
    radial-gradient(78% 28% at 50% 0%,#fff 0%,rgba(255,255,255,.74) 44%,rgba(255,255,255,0) 100%),
    linear-gradient(180deg,rgba(255,255,255,.97) 0%,rgba(250,252,255,.92) 32%,rgba(234,241,253,.86) 64%,rgba(212,225,248,.82) 100%),
    linear-gradient(180deg,rgba(255,255,255,.18),rgba(150,180,255,.10));
  -webkit-backdrop-filter:blur(12px) saturate(160%);
  backdrop-filter:blur(12px) saturate(160%);
  box-shadow:
    inset 0 1.5px 0 rgba(255,255,255,1),
    inset 0 -1px 0 rgba(255,255,255,.92),
    inset 0 -5px 9px -7px rgba(52,96,190,.55),
    inset 0 -1px 2px rgba(140,170,225,.32),
    0 1px 1px rgba(0,0,0,.52),
    0 2px 2px rgba(0,0,0,.26),
    0 10px 22px -12px rgba(151,183,255,.62),
    0 22px 34px -26px rgba(125,163,255,.92);
  text-shadow:0 1px 0 rgba(255,255,255,.85)}
/* 液态：一道高光在玻璃里缓慢游动（hover 时改为扫光） */
.cx-btn.start::before{
  background:radial-gradient(38% 130% at 20% 0%,rgba(255,255,255,.9),rgba(255,255,255,.22) 46%,rgba(255,255,255,0) 72%);
  opacity:.9;mix-blend-mode:screen;
  animation:cx-liquid 7.5s ease-in-out infinite}
.cx-btn.start:hover:not(:disabled)::before{background:
  linear-gradient(105deg,rgba(255,255,255,0) 36%,rgba(255,255,255,.42) 48%,rgba(255,255,255,.08) 56%,rgba(255,255,255,0) 64%)}
.cx-btn.start:not(:disabled):hover{transform:translateY(-1px);
  border-color:rgba(255,255,255,.82);
  background:
    radial-gradient(78% 28% at 50% 0%,#fff 0%,rgba(255,255,255,.82) 44%,rgba(255,255,255,0) 100%),
    linear-gradient(180deg,#fff 0%,rgba(252,253,255,.96) 32%,rgba(239,245,255,.92) 64%,rgba(219,231,252,.88) 100%),
    linear-gradient(180deg,rgba(255,255,255,.24),rgba(150,180,255,.14));
  box-shadow:
    inset 0 1.5px 0 #fff,
    inset 0 -1px 0 rgba(255,255,255,.95),
    inset 0 -5px 9px -7px rgba(52,96,190,.45),
    inset 0 -1px 2px rgba(140,170,225,.28),
    0 2px 2px rgba(0,0,0,.42),
    0 14px 26px -12px rgba(151,183,255,.8),
    0 30px 42px -28px rgba(125,163,255,1)}
/* 按下：玻璃被压进底座，高光收窄、焦散加深 */
.cx-btn.start:active:not(:disabled){transform:translateY(0) scale(.995);
  background:
    radial-gradient(52% 34% at 50% 8%,rgba(255,255,255,.92),rgba(255,255,255,.34) 64%,rgba(255,255,255,0) 100%),
    linear-gradient(180deg,rgba(238,244,255,.62),rgba(198,214,246,.46));
  box-shadow:
    inset 0 2px 4px rgba(48,86,170,.42),
    inset 0 1px 0 rgba(255,255,255,.7),
    inset 0 -1px 0 rgba(255,255,255,.5),
    0 6px 14px -10px rgba(152,184,255,.55)}
/* 危险操作：玫瑰色玻璃 */
.cx-btn.stop{color:#f0bcc1;font-weight:550;border-color:rgba(238,178,184,.24);
  background:
    radial-gradient(125% 105% at 50% -45%,rgba(255,200,205,.20),rgba(255,200,205,0) 60%),
    linear-gradient(180deg,rgba(238,178,184,.10),rgba(238,178,184,.04) 55%,rgba(238,178,184,.025))}
.cx-btn.stop:not(:disabled):hover{color:#f7c9cd;border-color:rgba(238,178,184,.42);
  background:
    radial-gradient(125% 105% at 50% -45%,rgba(255,206,212,.28),rgba(255,206,212,0) 60%),
    linear-gradient(180deg,rgba(238,178,184,.16),rgba(238,178,184,.07) 55%,rgba(238,178,184,.04));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.22),
    inset 0 -1px 0 rgba(255,220,222,.08),
    0 1px 1px rgba(0,0,0,.5),
    0 10px 22px -14px rgba(238,140,150,.45)}
.cx-btn:active:not(:disabled){transform:translateY(0)}
.cx-spin{width:10px;height:10px;flex:none;border-radius:50%;border:1.5px solid rgba(255,255,255,.24);
  border-top-color:currentColor;animation:cx-spin .8s linear infinite;position:relative;z-index:1}
.cx-btn.start .cx-spin{border-color:rgba(10,13,20,.22);border-top-color:#0c111c}

/* 工具格：一颗颗独立的玻璃珠 */
.cx-tools{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;flex:none}
.cx-tools .cx-btn{height:34px;font-size:11.5px;letter-spacing:.03em;border-radius:10px;
  border-color:rgba(255,255,255,.085);color:var(--text-3);
  background:
    radial-gradient(64% 42% at 50% 2%,rgba(255,255,255,.20),rgba(255,255,255,0) 100%),
    radial-gradient(124% 108% at 50% -42%,rgba(255,255,255,.17),rgba(255,255,255,0) 62%),
    linear-gradient(180deg,rgba(255,255,255,.062),rgba(255,255,255,.020));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.14),
    inset 0 -1px 0 rgba(255,255,255,.035),
    inset 0 -9px 14px -14px rgba(255,255,255,.28),
    0 1px 1px rgba(0,0,0,.42),0 8px 14px -14px #000;
  transition:background .18s ease,border-color .18s ease,color .18s ease,box-shadow .18s ease,transform .18s ease,opacity .18s ease}
/* 主功能（扫描/刷课/作业）比辅助功能高一档：带冷色玻璃 */
.cx-tools .cx-btn:nth-child(-n+3){color:var(--text-2);font-weight:500;
  border-color:rgba(190,209,255,.16);
  background:
    radial-gradient(64% 42% at 50% 2%,rgba(255,255,255,.30),rgba(255,255,255,0) 100%),
    radial-gradient(124% 108% at 50% -42%,rgba(255,255,255,.26),rgba(255,255,255,0) 62%),
    linear-gradient(180deg,rgba(190,209,255,.12),rgba(169,193,255,.035));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.24),
    inset 0 -1px 0 rgba(190,209,255,.10),
    inset 0 -9px 14px -14px rgba(190,209,255,.45),
    0 1px 1px rgba(0,0,0,.44),0 10px 16px -14px #000}
.cx-tools .cx-btn:not(:disabled):hover{color:var(--text);border-color:rgba(255,255,255,.22);
  transform:translateY(-1px);
  background:
    radial-gradient(64% 42% at 50% 2%,rgba(255,255,255,.42),rgba(255,255,255,0) 100%),
    radial-gradient(124% 108% at 50% -42%,rgba(255,255,255,.34),rgba(255,255,255,0) 62%),
    linear-gradient(180deg,rgba(255,255,255,.15),rgba(255,255,255,.055));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.34),
    inset 0 -1px 0 rgba(255,255,255,.06),
    0 2px 3px rgba(0,0,0,.4),0 14px 22px -16px rgba(150,180,255,.6)}
.cx-tools .cx-btn:active:not(:disabled){transform:translateY(0)}

/* =========================================================
   L1 · 状态卡
   ========================================================= */
.cx-metrics{display:flex;flex-direction:column;gap:9px;flex:none;padding:11px 12px;border-radius:14px;
  background:
    radial-gradient(100% 70% at 6% -30%,rgba(159,224,192,.10),rgba(159,224,192,0) 62%),
    linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.02) 55%,rgba(255,255,255,.012))}
.cx-phase{display:flex;align-items:center;gap:8px;min-width:0;font-size:12.5px;color:var(--text)}
.cx-phase b{font-weight:600;letter-spacing:.01em;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  text-shadow:0 1px 1px rgba(0,0,0,.35)}
.cx-phase .cx-dot{width:6px;height:6px;border-radius:50%;background:var(--text-3);flex:none;opacity:.8}
.cx-phase.run .cx-dot{background:var(--ok);opacity:1;
  box-shadow:0 0 0 3px rgba(159,224,192,.10),0 0 12px rgba(159,224,192,.55)}
.cx-clock{margin-left:auto;flex:none;font-size:10.5px;color:var(--text-3);
  font-variant-numeric:tabular-nums;letter-spacing:.04em;padding-left:8px}
.cx-chips{display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-width:0}
.cx-chip{padding:3px 8px;border-radius:999px;color:var(--text-2);
  border:1px solid rgba(255,255,255,.085);
  background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.025));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 1px 2px rgba(0,0,0,.32);
  font-size:10.5px;line-height:1.35;font-variant-numeric:tabular-nums;white-space:nowrap}
.cx-chip.mint{color:#c6f0dc;border-color:rgba(159,224,192,.22);
  background:linear-gradient(180deg,rgba(159,224,192,.16),rgba(159,224,192,.055));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 0 14px -8px rgba(159,224,192,.7)}
.cx-chip.amber{color:#f2dfb8;border-color:rgba(232,205,156,.22);
  background:linear-gradient(180deg,rgba(232,205,156,.16),rgba(232,205,156,.055));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.10),0 0 14px -8px rgba(232,205,156,.65)}
.cx-chip.muted{color:var(--text-3);background:transparent;border-color:rgba(255,255,255,.055);box-shadow:none}
.cx-bar{position:relative;height:3px;flex:none;margin-top:1px;border-radius:999px;overflow:hidden;
  background:rgba(0,0,0,.45);box-shadow:inset 0 1px 2px rgba(0,0,0,.6)}
.cx-bar>i{display:block;height:100%;width:38%;border-radius:999px;
  background:linear-gradient(90deg,rgba(169,193,255,0),var(--accent),rgba(255,255,255,.9),var(--accent),rgba(169,193,255,0));
  box-shadow:0 0 12px rgba(169,193,255,.75);animation:cx-sweep 2.2s ease-in-out infinite}

/* =========================================================
   L1 · 提示条
   ========================================================= */
.cx-notice{display:flex;align-items:flex-start;gap:8px;flex:none;padding:9px 11px;border-radius:11px;
  color:var(--text-2);font-size:11.5px;line-height:1.6;
  border-color:rgba(255,255,255,.09);
  background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.022))}
.cx-notice.ok{color:#d2f2e2;border-color:rgba(159,224,192,.26);
  background:linear-gradient(100deg,rgba(159,224,192,.16),rgba(159,224,192,.05) 46%,rgba(255,255,255,.018));
  box-shadow:inset 2px 0 0 rgba(159,224,192,.65),inset 0 1px 0 rgba(255,255,255,.10),0 12px 22px -20px #000}
.cx-notice.err{color:#f6d3d7;border-color:rgba(238,178,184,.26);
  background:linear-gradient(100deg,rgba(238,178,184,.16),rgba(238,178,184,.05) 46%,rgba(255,255,255,.018));
  box-shadow:inset 2px 0 0 rgba(238,178,184,.65),inset 0 1px 0 rgba(255,255,255,.10),0 12px 22px -20px #000}
.cx-notice .cx-n-text{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap}
.cx-notice .cx-n-x{flex:none;padding:0 2px;border:0;background:transparent;color:inherit;
  font-family:inherit;font-size:14px;line-height:1;opacity:.55;cursor:pointer;transition:opacity .15s ease}
.cx-notice .cx-n-x:hover{opacity:1}

/* =========================================================
   L-1 · 终端：下沉的玻璃井
   ========================================================= */
.cx-console{flex:1 1 auto;min-height:150px;display:flex;flex-direction:column;position:relative;
  border-radius:14px;overflow:hidden;background:#05060a;
  border-color:rgba(255,255,255,.065);
  box-shadow:
    inset 0 2px 8px rgba(0,0,0,.6),
    inset 0 -1px 0 rgba(255,255,255,.035),
    0 1px 0 rgba(255,255,255,.05),
    0 24px 40px -34px #000}
.cx-console-head{display:flex;align-items:center;gap:7px;height:33px;padding:0 7px 0 12px;flex:none;
  border-bottom:1px solid rgba(255,255,255,.06);
  background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.012));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.10);
  color:var(--text-3);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase}
.cx-console-title{display:inline-flex;align-items:center;gap:7px;min-width:0;white-space:nowrap}
.cx-live-dot{width:5px;height:5px;border-radius:50%;background:var(--text-3);opacity:.45;flex:none}
.cx-console-title.on .cx-live-dot{opacity:1;background:var(--ok);
  box-shadow:0 0 0 3px rgba(159,224,192,.08),0 0 10px rgba(159,224,192,.6);
  animation:cx-breathe 2.4s ease-in-out infinite}
.cx-sync{margin-left:auto;min-width:0;color:var(--text-3);font-size:9.5px;letter-spacing:.02em;
  text-transform:none;font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cx-tool{position:relative;flex:none;width:25px;height:25px;display:grid;place-items:center;padding:0;
  border:1px solid rgba(255,255,255,.06);border-radius:8px;color:var(--text-3);
  background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.08);
  font-family:inherit;font-size:12px;line-height:1;cursor:pointer;overflow:hidden;
  transition:color .15s ease,background .15s ease,border-color .15s ease,box-shadow .15s ease}
.cx-tool:hover{color:var(--text);border-color:rgba(255,255,255,.18);
  background:linear-gradient(180deg,rgba(255,255,255,.11),rgba(255,255,255,.04));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 6px 12px -10px #000}
.cx-out{flex:1;min-height:0;overflow:auto;padding:10px 12px 12px;
  background:radial-gradient(120% 80% at 0 0,rgba(169,193,255,.028),transparent 58%);
  color:#b8c0cf;font-family:var(--mono);font-size:11.2px;line-height:1.75;
  white-space:pre-wrap;word-break:break-word}
.cx-out::-webkit-scrollbar{width:6px;height:6px}
.cx-out::-webkit-scrollbar-thumb{background:rgba(255,255,255,.10);border-radius:999px}
.cx-out::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.2)}
.cx-out::-webkit-scrollbar-track{background:transparent}
.cx-line{color:#b8c0cf}
.cx-line-head{color:#f1f4fa;font-weight:500}
.cx-line-ok{color:#aee3c8}
.cx-line-warn{color:#eed6a8}
.cx-line-dim{color:#7c8492}
.cx-empty{height:100%;min-height:96px;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:7px;padding:16px;text-align:center;color:var(--text-3);font-size:11.5px}
.cx-empty .cx-e-glyph{width:36px;height:36px;display:grid;place-items:center;border-radius:50%;
  border:1px solid rgba(255,255,255,.13);color:var(--text-2);font-size:14px;line-height:1;
  background:
    radial-gradient(120% 120% at 30% 0,rgba(169,193,255,.20),rgba(255,255,255,.02) 62%),
    linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.02));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.16),0 8px 16px -12px rgba(169,193,255,.5)}
.cx-empty .cx-e-tip{max-width:26em;font-size:10.5px;line-height:1.65;opacity:.9}
.cx-empty>div:nth-child(2){color:var(--text-2);font-size:12px;letter-spacing:.01em}
.cx-console:has(.cx-jump) .cx-out{padding-bottom:40px}
.cx-jump{position:absolute;right:10px;bottom:10px;height:25px;padding:0 11px;border-radius:999px;
  border:1px solid rgba(255,255,255,.16);color:var(--text);
  background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,.05));
  -webkit-backdrop-filter:blur(10px) saturate(150%);backdrop-filter:blur(10px) saturate(150%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.24),0 10px 22px rgba(0,0,0,.55);
  font-family:inherit;font-size:10.5px;cursor:pointer}
.cx-jump:hover{background:linear-gradient(180deg,rgba(255,255,255,.20),rgba(255,255,255,.08))}

/* =========================================================
   L0 · 页脚
   ========================================================= */
.cx-foot{flex:none;display:flex;align-items:center;gap:5px;padding:8px 2px 0;
  border-top:1px solid rgba(255,255,255,.055);color:var(--text-3);
  font-size:9.5px;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cx-foot b{color:var(--text-2);font-weight:550;font-variant-numeric:tabular-nums;
  font-family:var(--mono);font-size:9.5px}

.cx-root button:focus-visible,.cx-root input:focus-visible{
  outline:2px solid rgba(169,193,255,.65);outline-offset:2px}

@keyframes cx-enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes cx-liquid{0%,100%{transform:translateX(-14%) scaleX(1);opacity:.55}
  50%{transform:translateX(14%) scaleX(1.12);opacity:.95}}
@keyframes cx-breathe{0%,100%{opacity:.35}50%{opacity:1}}
@keyframes cx-spin{to{transform:rotate(360deg)}}
@keyframes cx-sweep{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}
@keyframes cx-sheen{0%{opacity:0;transform:translateX(-120%) skewX(-10deg)}
  16%{opacity:1}
  72%{opacity:.55}
  100%{opacity:0;transform:translateX(120%) skewX(-10deg)}}

@container cxroot (max-width:340px){
  .cx-root{gap:9px;padding:12px 11px 10px}
  .cx-head{padding:10px;gap:9px;border-radius:14px}
  .cx-logo{width:33px;height:33px;border-radius:11px;font-size:17px}
  .cx-sub{display:none}
  .cx-section .cx-cap-hint{display:none}
  .cx-cta{grid-template-columns:minmax(0,1fr) 78px;gap:7px}
  .cx-ok{min-width:58px;padding:0 11px}
  .cx-tools{gap:6px}
  .cx-tools .cx-btn{font-size:11px;height:32px}
  .cx-foot{font-size:9px}
}
@container cxroot (max-width:300px){
  .cx-root{gap:8px;padding:11px 10px 9px;border-radius:13px}
  .cx-title{font-size:14px}
  .cx-pill{max-width:44%;padding:3px 7px;font-size:9.5px}
  .cx-mode{font-size:11px;padding:0 6px}
  .cx-btn{font-size:12px;height:36px;border-radius:10px}
  .cx-tools .cx-btn{height:31px;font-size:10.5px}
  .cx-chip{font-size:10px;padding:2px 6px}
  .cx-metrics{padding:10px}
}
@media (prefers-reduced-motion:reduce){
  .cx-root{animation:none}
  .cx-root *,.cx-root *::before,.cx-root *::after{animation:none!important;transition:none!important}
}
`;

    /* ---------------- 组件 ---------------- */

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      render() {
        if (this.state.error) {
          return h('div', { className: 'cx-root' },
            h('div', { className: 'cx-empty' },
              h('div', { className: 'cx-e-glyph' }, '⚠'),
              h('div', null, '面板渲染出错'),
              h('div', { className: 'cx-e-tip' }, String((this.state.error && this.state.error.message) || this.state.error || ''))
            )
          );
        }
        return this.props.children;
      }
    }

    function Notice(props) {
      const n = props.notice;
      if (!n) return null;
      return h('div', { className: 'cx-notice' + (n.kind === 'ok' ? ' ok' : n.kind === 'err' ? ' err' : ''), role: 'status' },
        h('span', { className: 'cx-n-text' }, n.text),
        h('button', { type: 'button', className: 'cx-n-x', title: '关闭提示', 'aria-label': '关闭提示', onClick: props.onClose }, '×')
      );
    }

    /** 行动按钮：只有被点的那颗转圈，其余仅变灰；「停止」始终保持可点 */
    function ActionButton(props) {
      const item = props.item;
      const busy = props.pending === item.key;
      const blocked = !!props.pending && !busy && item.key !== 'stop';
      return h('button', {
        type: 'button',
        className: 'cx-btn' + (item.cls ? ' ' + item.cls : ''),
        disabled: blocked || !!props.disabled,
        'aria-busy': busy ? 'true' : 'false',
        title: item.title || item.label,
        onClick: () => props.onAct(item.key),
      },
        busy ? h('span', { className: 'cx-spin', 'aria-hidden': 'true' }) : null,
        h('span', { className: 'cx-btn-label' }, item.label)
      );
    }

    /** 独立计时的运行时长：只让这一小块每秒重渲染 */
    function Elapsed(props) {
      const [, tick] = useState(0);
      const active = !!props.active;
      useEffect(() => {
        if (!active) return undefined;
        const id = setInterval(() => tick((v) => v + 1), 1000);
        return () => clearInterval(id);
      }, [active]);
      const base = Number(props.base || 0);
      if (!base && !active) return null;
      const sec = base + (active ? Math.max(0, (Date.now() - Number(props.at || Date.now())) / 1000) : 0);
      return h('span', { className: 'cx-clock', title: '已运行时长' }, fmtClock(sec));
    }

    function Panel(props) {
      const app = (props && props.ctx) || {};
      const [text, setText] = useState('');
      const [state, setState] = useState(null);
      const [live, setLive] = useState(null);        // null=连接中 true=已连接 false=断开
      const [pending, setPending] = useState('');    // 正在执行的动作 key
      const [course, setCourse] = useState(loadCourse);
      const [mode, setMode] = useState(loadMode);
      const [notice, setNotice] = useState(null);
      const [at, setAt] = useState(0);
      const [latency, setLatency] = useState(0);
      const [clock, setClock] = useState(null);      // { sec, at }：从进度文本解析的运行时长
      const [bottom, setBottom] = useState(true);

      const modeRef = useRef(null);
      const pendingRef = useRef('');
      const epochRef = useRef(0);
      const refreshRef = useRef(null);
      const outRef = useRef(null);
      const stickRef = useRef(true);

      modeRef.current = mode;
      const connected = live !== false;
      const phase = (state && state.phase) || 'idle';
      const stats = (state && state.stats) || {};
      const desk = (state && state.desktop) || null;
      const running = !!(state && state.running) && connected;
      const deskActive = !!(desk && (desk.state === 'running' || desk.state === 'starting'));
      const active = mode === 'desktop' ? deskActive : running;

      let headLabel;
      let chipSource;
      if (mode === 'desktop') {
        if (desk) {
          headLabel = DESK_PHASES[desk.phase] || DESK_PHASES[desk.state] || desk.phase || '运行中';
          chipSource = 'desk';
        } else {
          const raw = deskHeadFromText(text);
          headLabel = DESK_PHASES[raw] || raw || '空闲';
          chipSource = 'text';
        }
      } else {
        headLabel = PHASES[phase] || phase || '空闲';
        chipSource = 'web';
      }

      const chips = [];
      if (!connected && state) chips.push({ text: '离线 · 数据已过期', cls: 'amber' });
      if (chipSource === 'desk') {
        const p = desk.progress || {};
        if (desk.item) chips.push({ text: '节点 ' + desk.item, cls: 'mint' });
        if (p.videos || p.docs || p.quizzes) {
          chips.push({ text: '视频 ' + (p.videos || 0) + ' · 文档 ' + (p.docs || 0) + ' · 测验 ' + (p.quizzes || 0), cls: '' });
        }
        if (p.itemsPending) chips.push({ text: '待完成 ' + p.itemsPending, cls: 'amber' });
        if (p.worksFound || p.worksDone) chips.push({ text: '作业 ' + (p.worksDone || 0) + '/' + ((p.worksFound || 0) + (p.worksDone || 0)), cls: '' });
      } else if (chipSource === 'text') {
        // 旧桥兜底：从展示文本里刮（后端升级到 /state.desktop 后不再走这里）
        const node = /节点\s*([^\s·]+)/.exec(text || '');
        const media = /视频\s*(\d+)\s*·\s*文档\s*(\d+)\s*·\s*测验\s*(\d+)/.exec(text || '');
        const pendingCnt = /未完成任务点\s*(\d+)/.exec(text || '');
        const works = /作业\s*未交\s*(\d+)/.exec(text || '');
        if (node) chips.push({ text: '节点 ' + node[1], cls: 'mint' });
        if (media) chips.push({ text: '视频 ' + media[1] + ' · 文档 ' + media[2] + ' · 测验 ' + media[3], cls: '' });
        if (pendingCnt) chips.push({ text: '待完成 ' + pendingCnt[1], cls: 'amber' });
        if (works) chips.push({ text: '作业未交 ' + works[1], cls: '' });
      } else {
        if (stats.courses) chips.push({ text: '课程 ' + (stats.coursesDone || 0) + '/' + stats.courses, cls: '' });
        if (stats.nodesDone) chips.push({ text: '节点 ' + stats.nodesDone, cls: 'mint' });
        if (stats.nodesFailed) chips.push({ text: '失败 ' + stats.nodesFailed, cls: 'amber' });
        if (stats.gained) chips.push({ text: '得分 +' + stats.gained, cls: 'mint' });
        if (stats.quizzesSolved) chips.push({ text: '测验 ' + stats.quizzesSolved, cls: '' });
        if (stats.worksSolved) chips.push({ text: '作业 ' + stats.worksSolved, cls: '' });
      }
      if (state && state.jobs && state.jobs.length) chips.push({ text: '任务 ' + state.jobs.length, cls: 'muted' });

      useEffect(() => {
        try { saveCourse(course); } catch (e) { /* ignore */ }
      }, [course]);

      useEffect(() => {
        try { saveMode(mode); } catch (e) { /* ignore */ }
      }, [mode]);

      // 轮询：1 个 /snapshot 请求；失败退避（2.5s→5s→10s→20s），成功立即恢复
      useEffect(() => {
        let alive = true;
        let timer = null;
        let fails = 0;
        let hidden = false;
        const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
        const schedule = (ms) => {
          clear();
          if (!alive) return;
          timer = setTimeout(tick, Math.max(0, ms));
        };
        const tick = async () => {
          if (!alive) return;
          // 不可见时也继续轮询（只是放慢）：旧版直接跳过，窗口最小化/被挡时面板一直停在「未连接」
          const docHidden = typeof document !== 'undefined' && !!document.hidden;
          hidden = docHidden;
          const m = modeRef.current || '';
          const epoch = epochRef.current;
          const t0 = nowMs();
          try {
            const snap = await getSnapshot(m);
            if (!alive) return;
            // 切模式或手动刷新后，旧请求的响应直接丢掉，避免覆盖新状态
            if (epoch !== epochRef.current || m !== (modeRef.current || '')) { schedule(0); return; }
            fails = 0;
            setLatency(Math.round(nowMs() - t0));
            setLive(true);
            setState((prev) => (sameState(prev, snap.state) ? prev : snap.state));
            setText((prev) => (prev === snap.text ? prev : snap.text));
            setAt(Date.now());
            const el = parseElapsed(snap.text);
            if (el != null) setClock({ sec: el, at: Date.now() });
            schedule(docHidden ? HIDDEN_POLL_MS : POLL_MS);
          } catch (e) {
            if (!alive) return;
            fails += 1;
            dropBase();
            setLive(false);
            const why = String((e && e.message) || e || '').slice(0, 120);
            setText((prev) => prev || ('› 面板服务未连接' + (why ? '（' + why + '）' : '') +
              '\n  · 同源路由 /chaoxing 与端口 ' + UI_PORT + ' 都不可达' +
              '\n  · 自动重连中，也可点右上角 ⟲ 立即重试'));
            schedule(Math.min(POLL_MS * Math.pow(2, Math.min(fails - 1, 3)), MAX_BACKOFF_MS));
          }
        };
        refreshRef.current = () => { fails = 0; dropBase(); schedule(0); };
        tick();
        const onVis = () => {
          if (typeof document !== 'undefined' && !document.hidden) {
            if (hidden) { hidden = false; fails = 0; schedule(0); }
          }
        };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
        return () => {
          alive = false;
          clear();
          refreshRef.current = null;
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
        };
      }, []);

      useEffect(() => {
        if (!notice) return undefined;
        const id = setTimeout(() => setNotice(null), notice.kind === 'err' ? 9000 : 5000);
        return () => clearTimeout(id);
      }, [notice]);

      useEffect(() => {
        const el = outRef.current;
        if (!el || !stickRef.current) return;
        el.scrollTop = el.scrollHeight;
      }, [text]);

      const act = async (key, forceMode) => {
        const cur = pendingRef.current;
        if (cur && key !== 'stop' && cur !== key) {
          setNotice({ kind: 'err', text: '正在执行「' + labelOf(cur) + '」，等它结束或点「停止」' });
          return null;
        }
        if (cur === key) return null;
        const curMode = forceMode || modeRef.current;
        const c = String(course || '').trim();
        if (key === 'focus' && !c) {
          setNotice({ kind: 'err', text: '先在课程框里输入课程名，再点「确定」' });
          return null;
        }
        const body = { mode: curMode || undefined };
        if (c) {
          body.course = c;
          if (NEEDS_COURSE.indexOf(key) >= 0) body.courses = [c];
        }
        pendingRef.current = key;
        setPending(key);
        try {
          const j = await postAction(key, body);
          const ok = !!(j && j.ok !== false);
          if (ok) {
            let msg = j && j.text ? String(j.text) : '已执行「' + labelOf(key) + '」';
            if (key === 'refresh') msg = '进度已刷新';
            setNotice({ kind: 'ok', text: msg });
            if (key === 'refresh' && j && typeof j.text === 'string') {
              // /action refresh 本身就返回了最新进度文本，直接落盘，不再多打一次 /snapshot
              const t = j.text;
              setText(t);
              setAt(Date.now());
              const el = parseElapsed(t);
              setClock(el != null ? { sec: el, at: Date.now() } : null);
              setLive(true);
            } else if (refreshRef.current) {
              refreshRef.current();
            }
          } else {
            setNotice({ kind: 'err', text: (j && j.text) ? String(j.text) : '操作失败' });
          }
          return j;
        } catch (e) {
          const m = e && (e.name === 'AbortError' ? '请求超时（90 秒）' : (e.message || String(e)));
          setNotice({ kind: 'err', text: '操作失败：' + m });
          return null;
        } finally {
          pendingRef.current = '';
          setPending('');
        }
      };

      const chooseMode = (key) => {
        if (mode === key) {
          if (refreshRef.current) refreshRef.current();
          return;
        }
        epochRef.current += 1;
        modeRef.current = key;
        setMode(key);
        setClock(null);
        act(key, key);
      };

      const onOutScroll = () => {
        const el = outRef.current;
        if (!el) return;
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
        stickRef.current = near;
        setBottom((prev) => (prev === near ? prev : near));
      };

      const jumpToBottom = () => {
        const el = outRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        stickRef.current = true;
        setBottom(true);
      };

      const copyText = async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text || '');
          } else {
            const ta = document.createElement('textarea');
            ta.value = text || '';
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
          setNotice({ kind: 'ok', text: '已复制当前进度文本' });
        } catch (e) {
          setNotice({ kind: 'err', text: '复制失败：' + (e && e.message ? e.message : e) });
        }
      };

      const lines = useMemo(() => {
        const raw = String(text || '');
        if (!raw.trim()) return [];
        const all = raw.split('\n');
        const tail = all.length > MAX_LINES ? all.slice(all.length - MAX_LINES) : all;
        return tail.map((l, i) => ({ k: i, cls: lineClass(l), t: l === '' ? ' ' : l }));
      }, [text]);

      const pillCls = live === false ? ' off' : active ? ' on' : live === true ? ' idle' : '';
      const pillText = live === false ? '未连接' : live === null ? '连接中' : active ? '运行中 · ' + headLabel : '空闲';

      const baseSec = mode === 'desktop' ? (desk ? desk.elapsedSec : 0) : (clock ? clock.sec : 0);
      const baseAt = mode === 'desktop' ? at : (clock ? clock.at : at);

      const syncLabel = live === false
        ? '未连接 · 重连中'
        : at
          ? '同步 ' + fmtTime(at) + (latency ? ' · ' + latency + 'ms' : '')
          : '等待数据';

      const emptyTitle = live === null
        ? '正在连接面板服务…'
        : live === false
          ? '面板服务未连接'
          : !mode
            ? '先选运行环境'
            : '还没有进度输出';
      const emptyTip = live === false
        ? '确认 DSH 正在运行（端口 ' + UI_PORT + '），会自动重连'
        : !mode
          ? '网页版用自带 Edge，桌面版用本机学习通客户端'
          : '开始任务后这里会滚动显示实时进度';

      return h('div', { className: 'cx-root' },
        h('div', { className: 'cx-head' },
          h('div', { className: 'cx-logo', 'aria-hidden': 'true' }, '学'),
          h('div', { className: 'cx-brand' },
            h('div', { className: 'cx-title' }, '学习通助手'),
            h('div', { className: 'cx-sub' }, 'Chaoxing Autopilot')
          ),
          h('span', {
            className: 'cx-pill' + pillCls,
            'aria-live': 'polite',
            title: '阶段：' + headLabel,
          },
            h('i', { className: 'cx-dot', 'aria-hidden': 'true' }),
            pillText
          )
        ),

        h('div', { className: 'cx-section' },
          h('div', { className: 'cx-cap' },
            h('span', null, '运行环境'),
            h('span', { className: 'cx-cap-hint' }, 'WEB / DESKTOP')
          ),
          h('div', { className: 'cx-modes', role: 'group', 'aria-label': '运行环境' },
            MODES.map((m) => h('button', {
              key: m.key,
              type: 'button',
              title: m.name + '：' + m.desc,
              className: 'cx-mode' + (mode === m.key ? ' active' : ''),
              'aria-pressed': mode === m.key,
              onClick: () => chooseMode(m.key),
            }, h('span', null, m.name)))
          )
        ),

        mode ? h('div', { className: 'cx-course' },
          h('div', { className: 'cx-cap' },
            h('span', null, '目标课程'),
            h('span', { className: 'cx-cap-hint' }, '留空 = 全部课程')
          ),
          h('div', { className: 'cx-row' },
            h('div', { className: 'cx-inputwrap' },
              h('input', {
                className: 'cx-input',
                value: course,
                placeholder: '输课程名，如：电工电子技术',
                'aria-label': '目标课程',
                onChange: (e) => setCourse(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); try { e.target.blur(); } catch (err) { /* ignore */ } } },
              }),
              course ? h('button', {
                type: 'button',
                className: 'cx-clear',
                title: '清空课程名',
                'aria-label': '清空课程名',
                onClick: () => setCourse(''),
              }, '×') : null
            ),
            h('button', {
              type: 'button',
              className: 'cx-ok',
              disabled: !String(course || '').trim() || pending === 'focus',
              title: '用这门课重新开始自动任务（会中断当前队列，只跑这一门）',
              onClick: () => act('focus'),
            }, pending === 'focus' ? h('span', { className: 'cx-spin', 'aria-hidden': 'true' }) : '确定')
          )
        ) : null,

        h('div', { className: 'cx-controls' },
          h('div', { className: 'cx-cta' },
            CTA.map((b) => h(ActionButton, {
              key: b.key,
              item: Object.assign({}, b, { title: b.key === 'start' ? '开始/继续自动任务' : '停止所有任务（不会自动恢复）' }),
              pending,
              disabled: !mode && b.key === 'start',
              onAct: act,
            }))
          ),
          h('div', { className: 'cx-tools', role: 'group', 'aria-label': '任务操作' },
            CORE.concat(AUX).map((b) => h(ActionButton, {
              key: b.key,
              item: Object.assign({}, b, {
                title: b.needsCourse && String(course || '').trim()
                  ? b.label + '：只处理《' + String(course).trim() + '》'
                  : b.label,
              }),
              pending,
              disabled: !mode,
              onAct: act,
            }))
          )
        ),

        (state || mode === 'desktop') ? h('div', { className: 'cx-metrics' },
          h('div', { className: 'cx-phase' + (active ? ' run' : '') },
            h('i', { className: 'cx-dot', 'aria-hidden': 'true' }),
            h('b', null, headLabel),
            h(Elapsed, { base: baseSec, at: baseAt, active })
          ),
          chips.length ? h('div', { className: 'cx-chips' },
            chips.map((c, i) => h('span', { key: i, className: 'cx-chip ' + c.cls }, c.text))
          ) : null,
          active ? h('div', { className: 'cx-bar', 'aria-hidden': 'true' }, h('i')) : null
        ) : null,

        h(Notice, { notice: notice, onClose: () => setNotice(null) }),

        h('div', { className: 'cx-console' },
          h('div', { className: 'cx-console-head' },
            h('span', { className: 'cx-console-title' + (active ? ' on' : '') },
              h('i', { className: 'cx-live-dot', 'aria-hidden': 'true' }),
              '实时输出'
            ),
            h('span', { className: 'cx-sync' }, syncLabel),
            h('button', { type: 'button', className: 'cx-tool', title: '立即重新连接', 'aria-label': '立即重新连接', onClick: () => { if (refreshRef.current) refreshRef.current(); } }, '⟲'),
            h('button', { type: 'button', className: 'cx-tool', title: '复制进度文本', 'aria-label': '复制进度文本', onClick: copyText }, '⧉')
          ),
          h('div', {
            className: 'cx-out',
            ref: outRef,
            onScroll: onOutScroll,
            role: 'log',
            'aria-live': 'off',
            'aria-label': '实时进度输出',
          },
            lines.length
              ? lines.map((l) => h('div', { key: l.k, className: l.cls }, l.t))
              : h('div', { className: 'cx-empty' },
                  h('div', { className: 'cx-e-glyph', 'aria-hidden': 'true' }, '◌'),
                  h('div', null, emptyTitle),
                  h('div', { className: 'cx-e-tip' }, emptyTip)
                )
          ),
          !bottom && lines.length ? h('button', { type: 'button', className: 'cx-jump', onClick: jumpToBottom }, '↓ 最新') : null
        ),

        h('div', { className: 'cx-foot' },
          h('span', null, '面板通道 '),
          h('b', null, baseLabel()),
          h('span', null, ' · 备用 127.0.0.1:' + UI_PORT),
          h('span', null, ' · ' + (POLL_MS / 1000) + 's 自动刷新'),
          h('span', null, ' · v' + VERSION)
        )
      );
    }

    /* ---------------- 注册 ---------------- */

    function apply(ctx) {
      const app = ctx || {};
      const offs = [];

      // 无 DOM 环境（测试/SSR/宿主只拿 factory 不挂载）时跳过样式注入，避免 apply 直接抛错
      if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
        const old = document.getElementById(STYLE_ID);
        if (old) old.remove();
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.body || document.documentElement).appendChild(style);
        offs.push(() => { try { style.remove(); } catch (e) { /* ignore */ } });
      }

      if (app.slots && typeof app.slots.register === 'function') {
        // 槽位可能由宿主插件稍后才声明：用 slots.inject 等它出现再注册，
        // 直接 register 会在槽位尚未声明时抛错而被静默吞掉（旧版即因此不显示）。
        const put = (name, spec, Comp) => {
          const full = Object.assign({ name: name }, spec);
          let off;
          if (typeof app.slots.inject === 'function') {
            off = app.slots.inject(name, () => app.slots.register(full, Comp));
          } else {
            off = app.slots.register(full, Comp);
          }
          if (typeof off === 'function') offs.push(off);
        };

        try {
          put('sidebar.right.pane.tab', { key: DEF_ID }, (props) =>
            h(PanelBoundary, null, h(Panel, Object.assign({}, props, { ctx: app })))
          );
        } catch (e) {
          try { console.warn('[chaoxing] register pane failed', e && e.message); } catch (e2) { /* ignore */ }
        }
        // 右侧边栏：注册一个「学习通」标签类型 + 引导页入口（左侧栏设置按钮保持原样，不再占用 footer 槽位）。
        // sidebarRightTabs 由 sidebar-right 插件运行时 reflect.provide，不能写进 inject（会让整个插件永远不 apply）；
        // 等到右侧边栏的 pane.tab 槽位出现（说明该插件已就绪）再注册，失败只告警。
        let tabTypeReg = false;
        const registerRightTab = () => {
          if (tabTypeReg) return;
          let tabs = null;
          try { tabs = app.get && app.get('sidebarRightTabs'); } catch (e) { tabs = null; }
          if (!tabs || typeof tabs.register !== 'function') return;
          let off = null;
          try {
            off = tabs.register({
              id: DEF_ID,
              kind: DEF_ID,
              priority: 'plugin',
              title: () => '学习通',
              keepMounted: true,
              guide: [
                {
                  id: DEF_ID,
                  order: 40,
                  title: () => '学习通',
                  description: () => '刷课 · 作业 · 进度面板',
                },
              ],
            });
          } catch (e) {
            // 热重载后旧实例可能还占着同 id：当成已注册，避免轮询里反复抛错。
            if (e && /already registered/i.test(String(e.message || e))) { tabTypeReg = true; return; }
            throw e;
          }
          tabTypeReg = true;
          if (typeof off === 'function') offs.push(off);
        };
        // 右侧边栏服务是运行时 provide 的：等 pane.tab 槽位出现后再试，失败则短轮询直到就绪（最多 ~16s）。
        const tryRegisterRightTab = () => {
          try { registerRightTab(); } catch (e) {
            try { console.warn('[chaoxing] register right tab type failed', e && e.message); } catch (e2) { /* ignore */ }
          }
        };
        try {
          if (typeof app.slots.inject === 'function') {
            const offWait = app.slots.inject('sidebar.right.pane.tab', tryRegisterRightTab);
            if (typeof offWait === 'function') offs.push(offWait);
          }
        } catch (e) {
          try { console.warn('[chaoxing] right tab type inject failed', e && e.message); } catch (e2) { /* ignore */ }
        }
        let tabTries = 0;
        const tabTimer = setInterval(() => {
          tabTries += 1;
          if (tabTypeReg || tabTries > 40) { clearInterval(tabTimer); return; }
          tryRegisterRightTab();
        }, 400);
        if (typeof tabTimer.unref === 'function') tabTimer.unref();
        offs.push(() => clearInterval(tabTimer));
      }

      const dispose = () => {
        while (offs.length) {
          const fn = offs.pop();
          try { if (typeof fn === 'function') fn(); } catch (e) { /* ignore */ }
        }
      };
      return dispose;
    }

    return { inject: ['slots'], apply };
  },
});
