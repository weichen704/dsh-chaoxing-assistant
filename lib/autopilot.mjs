// lib/autopilot.mjs — 自动编排：启动浏览器 → 等待扫码登录 → 发现课程 → 逐课交给 engine。
//
// 边界与约束：
// - 不直接操作页面 DOM，也不自己调模型：页面动作在 engine，模型调用在 engine/quiz 层。
// - 绝不 killEdge、绝不关闭用户已有标签页。出错时浏览器保持打开，方便用户随时接手扫码或人工验证码；
//   只有 engine 内部允许关闭它自己开的 target。
// - 所有日志都是 JS 对象，交给注入的 log() 落盘；本模块不 console。
// - engine.start 的扩展入参（quizPolicy:'auto'、solveWorks、minConfidence、autoSubmit、dryRun）
//   原样透传；当前 engine 不认识这些键时会被忽略，后续扩展即可生效。
import { accountGet } from './browser.mjs';
import { LOGIN_URL, probeLogin, discoverCourses, readCatalog } from './chaoxing.mjs';
import { listWorks } from './work.mjs';
import { sleep, sleepUnless, nowClock, nowISO, truncate, randInt, clamp } from './util.mjs';

export const AUTO_DEFAULTS = {
  account: 'default',
  pollMs: 4000, // 等待登录/轮询 engine 任务的间隔
  loginWaitMinutes: 30, // 等扫码登录上限
  concurrency: 2, // 刷课并发
  maxMinutes: 600, // 整体时间预算（含登录、发现、刷课）
  kinds: ['video', 'document'],
  solveQuizzes: true, // 是否让 engine 用模型做章节测验
  solveWorks: true, // 是否让 engine 做作业
  minConfidence: 0.75, // 低于它的作答留着不提交
  autoSubmit: true, // false = 只抓题作答记录，不点提交（dry run）
  dryRun: false,
  courses: [], // 用户指定课程（课程名、courseid 或 "courseid:clazzid:cpi:enc"）；空=全部有未完成的课
  worksOnly: false, // 只做作业
  scanWorks: true, // 章节没有待完成时，也去作业列表里看有没有未交作业
  startUrl: '', // 浏览器启动页，空=LOGIN_URL
  resume: true, // 上次未完成的队列是否续跑（从 store.auto 读）
  taskWindow: false, // 任务页是否新开窗口（默认 false = 同一窗口开标签，不会弹一堆窗口）
  scanLimit: 0, // 每门课扫描时最多看多少待完成节点，0=全部（readCatalog 没有 limit 参数，当前仅写入 ctx 保留）
  maxBlanks: 0, // 允许提交的空白题数上限，0=有空题就存草稿不交
  videoNotConfirmedMax: 3, // 连续「放完但平台未确认」上限
  blankGuard: true, // 交卷前回读页面实际空题数
  humanGuard: true, // 页面出现人脸/活体/实人认证就停机（零点击、不绕过）
};

const RING_LIMIT = 200;
const TERMINAL = new Set(['done', 'stopped', 'error']);
/** 会话探测地址：已登录时打开个人空间不会落到登录页，避免“已登录仍停在登录页”的误判 */
const SESSION_URL = 'https://i.chaoxing.com/base';

/** 有限数字兜底 */
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 取第一个有效数字，全空返回 0 */
function firstNum(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** 课程标题归一化：去空白/标点、小写；用于「按课程名指定课程」的匹配 */
export function normTitle(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[\s\u3000·•\-—_()（）【】\[\]《》「」『』,，.。:：;；'"“”‘’!！?？、/\\|]+/g, '');
}

/** "courseid" / "courseid:clazzid:cpi:enc" / "课程名" → 规范对象（课程名放在 title 里） */
export function splitCourseSpec(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  // 纯数字 id（可带 clazzid/cpi/enc）才按 id 解析；其余整串当课程名，
  // 用户从面板里复制的课程名常带冒号/破折号，不能按分隔符切碎。
  if (!/^\d+$/.test(s) && !/^\d+(:\d+){1,3}$/.test(s)) {
    return { courseid: '', clazzid: '', cpi: '', enc: '', title: s, raw: s };
  }
  const parts = s
    .split(/[|,;:]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  return {
    courseid: parts[0] || '',
    clazzid: parts[1] || '',
    cpi: parts[2] || '',
    enc: (parts[3] || '').toLowerCase(),
    title: '',
    raw: s,
  };
}

/** 单条 spec 是否命中课程：courseid 精确（可加 clazzid），或课程名归一化匹配 */
export function matchesWanted(course, wanted) {
  const cid = String((course && course.courseid) || '');
  const ctitle = normTitle((course && course.title) || '');
  return (wanted || []).some((w) => {
    const sp = splitCourseSpec(w);
    if (!sp) return false;
    if (sp.courseid) {
      if (sp.courseid !== cid) return false;
      if (sp.clazzid && sp.clazzid !== String((course && course.clazzid) || '')) return false;
      return true;
    }
    const q = normTitle(sp.title);
    if (!q || !ctitle) return false;
    return ctitle === q || ctitle.includes(q) || q.includes(ctitle);
  });
}

/**
 * 按用户给定的课程列表从课程清单里挑选（保持用户给的顺序）：
 * - courseid / "courseid:clazzid:cpi:enc"：精确命中；指定 clazzid 时一并校验
 * - 课程名：先精确（归一化全等），其次包含匹配；命中多门算「歧义」，交调用方报错让用户写全名
 * 返回 { picked, misses, ambiguous }；wanted 为空时 picked=全部课程。
 */
export function pickWanted(courses, wanted) {
  const list = Array.isArray(courses) ? courses : [];
  const picked = [];
  const misses = [];
  const ambiguous = [];
  const seen = new Set();
  const add = (c) => {
    if (!c) return;
    const key = `${String(c.courseid || '')}:${String(c.clazzid || '')}`;
    if (seen.has(key)) return;
    seen.add(key);
    picked.push(c);
  };
  if (!wanted || !wanted.length) return { picked: list.slice(), misses, ambiguous };
  for (const w of wanted) {
    const sp = splitCourseSpec(w);
    if (!sp) {
      misses.push(String(w));
      continue;
    }
    if (sp.courseid) {
      const hit = list.find(
        (c) =>
          String((c && c.courseid) || '') === sp.courseid &&
          (!sp.clazzid || sp.clazzid === String((c && c.clazzid) || ''))
      );
      if (hit) add(hit);
      else misses.push(String(w));
      continue;
    }
    const q = normTitle(sp.title);
    if (!q) {
      misses.push(String(w));
      continue;
    }
    const exact = list.filter((c) => normTitle((c && c.title) || '') === q);
    if (exact.length === 1) {
      add(exact[0]);
      continue;
    }
    if (exact.length > 1) {
      ambiguous.push({ spec: String(w), options: exact });
      continue;
    }
    const loose = list.filter((c) => {
      const t = normTitle((c && c.title) || '');
      return t && (t.includes(q) || q.includes(t));
    });
    if (loose.length === 1) add(loose[0]);
    else if (!loose.length) misses.push(String(w));
    else ambiguous.push({ spec: String(w), options: loose });
  }
  return { picked, misses, ambiguous };
}

export class Autopilot {
  /**
   * @param {object} deps
   * @param {object} deps.store   Store 实例（或兼容 {get,set,touch,flush} 的对象）
   * @param {object} deps.hub     AccountHub 实例
   * @param {object} deps.engine  Engine 实例
   * @param {object|null} deps.llm  宿主模型服务；null 时自动关闭测验/作业作答
   * @param {object|Function|null} deps.paths  预留：插件数据目录（本模块不主动调用，避免测试期创建真实目录）
   * @param {Function} deps.log   日志落盘函数，收到 JS 对象
   * @param {object} deps.config  初始配置（会与 AUTO_DEFAULTS 合并）
   * @param {object|null} deps.deps  仅测试用：注入 { probeLogin, discoverCourses, readCatalog, LOGIN_URL }
   */
  constructor({ store, hub, engine, llm = null, paths = null, log = () => {}, config = {}, deps = null } = {}) {
    if (!store || !hub || !engine) throw new Error('Autopilot 需要 { store, hub, engine } 三个依赖');
    this.store = store;
    this.hub = hub;
    this.engine = engine;
    this.llm = llm || null;
    this.paths = paths || null;
    this.log = typeof log === 'function' ? log : () => {};

    const injected = deps && typeof deps === 'object' ? deps : {};
    this.deps = {
      LOGIN_URL: injected.LOGIN_URL || LOGIN_URL,
      probeLogin: typeof injected.probeLogin === 'function' ? injected.probeLogin : probeLogin,
      discoverCourses: typeof injected.discoverCourses === 'function' ? injected.discoverCourses : discoverCourses,
      readCatalog: typeof injected.readCatalog === 'function' ? injected.readCatalog : readCatalog,
      listWorks: typeof injected.listWorks === 'function' ? injected.listWorks : listWorks,
    };

    this._phase = 'idle';
    this._running = false;
    this._stopRequested = false;
    this._stopReason = '';
    this._trigger = '';
    this._startedAt = 0;
    this._finishedAt = 0;
    this._deadline = 0;
    this._error = '';
    this._note = '';
    this._login = { ok: false, nick: '', href: '', waitingSec: 0 };
    this._logs = [];
    this._queue = [];
    this._results = [];
    this._current = null;
    this._jobId = '';
    this._jobActive = false;
    this._jobStopSent = false;
    this._captchaNoted = false;
    this._account = null;
    this._accountName = String((config && config.account) || AUTO_DEFAULTS.account);
    this._page = null;
    this._resumeRaw = null;
    this._loopPromise = null;
    // 代次 token：每次 start() 递增；旧循环发现 gen 变了就绝不能再改新循环的状态
    this._gen = 0;
    this._stats = this._emptyStats();
    this.config = { ...AUTO_DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
    this._normalize();
  }

  // ------------------------------------------------------------------ 公共 API

  get phase() {
    return this._phase;
  }

  get running() {
    return !!this._running;
  }

  /**
   * 启动后台自动循环（立刻返回，不阻塞）。已运行则直接返回当前 snapshot。
   * @returns {object} snapshot
   */
  async start(opts = {}, trigger = 'manual') {
    if (this._running) {
      // 运行中又被显式指定了另一组课程：不能只回旧快照 —— 旧队列会继续打开其他课程，
      // 用户看到的就是「指定了 A 课，却一直开 B 课」。先停干净上一轮，再按新课程启动。
      const want = (opts && Array.isArray(opts.courses) ? opts.courses : [])
        .map((s) => String(s == null ? '' : s).trim())
        .filter(Boolean);
      if (want.length) {
        const cur = (Array.isArray(this.config.courses) ? this.config.courses : [])
          .map((s) => String(s == null ? '' : s).trim())
          .filter(Boolean);
        const same = cur.length === want.length && want.every((w) => cur.some((c) => String(c) === String(w) || normTitle(c) === normTitle(w)));
        if (!same) {
          try {
            await this.abort('start-replace');
          } catch {
            /* 停不掉就让下面的 _running 判断兜住 */
          }
        }
      }
      if (this._running) return this.snapshot();
    }
    // 新代次：旧循环即使还没收尾，也已在 _loop/_work/_awaitJob 的每个出口被 gen 拦下
    const gen = (this._gen = (this._gen || 0) + 1);
    if (opts && typeof opts === 'object') this.config = { ...this.config, ...opts };
    this._normalize();

    // 续跑信息必须在覆盖 store.auto 之前读走
    let prev = null;
    if (this.config.resume) {
      try {
        prev = this.store.get('auto', null) || null;
      } catch {
        prev = null;
      }
    }
    this._resumeRaw = prev;

    this._trigger = String(trigger || 'manual');
    this._stopRequested = false;
    this._stopReason = '';
    this._note = '';
    this._error = '';
    this._finishedAt = 0;
    this._startedAt = Date.now();
    this._deadline = this._startedAt + Math.round(num(this.config.maxMinutes, AUTO_DEFAULTS.maxMinutes) * 60000);
    this._stats = this._emptyStats();
    this._queue = [];
    this._results = [];
    this._current = null;
    this._login = { ok: false, nick: '', href: '', waitingSec: 0 };
    this._jobId = '';
    this._jobActive = false;
    this._jobStopSent = false;
    this._captchaNoted = false;
    this._account = null;
    this._page = null;
    this._logs = [];
    this._running = true;

    this._pushLog({ ev: 'auto-start', trigger: this._trigger, account: this._accountName, llm: !!this.llm, config: this._configView() });
    this._persist();

    this._loopPromise = this._loop(gen).catch((e) => {
      // 旧代次的兜底 catch 不能碰新循环的状态
      if (gen !== this._gen) return;
      // _loop 内部已有 try/catch，这里只是最后一道保险
      this._running = false;
      this._phase = 'error';
      this._error = `自动任务异常：${truncate((e && e.message) || e, 300)}`;
      this._finishedAt = Date.now();
      this._pushLog({ ev: 'loop-unhandled', err: truncate((e && e.message) || e, 300) });
      this._persist();
    });
    return this.snapshot();
  }

  /** 停止：置停止标志 + 停当前 engine job（最多调一次）+ phase='stopped'；等旧循环收尾（最多 5s） */
  async stop(reason = 'manual') {
    // 必须在 _running 被清掉之前记下当前循环，末尾才能等它真正收尾；
    // 没有在跑的循环就别 race（否则每次 stop 都白留一个 5s 定时器）
    const waitingLoop = this._running ? this._loopPromise : null;
    this._stopRequested = true;
    this._stopReason = String(reason || 'manual');
    this._pushLog({ ev: 'auto-stop', reason: this._stopReason, job: this._jobId || '' });
    if (this._jobActive && this._jobId) this._stopEngineJob();
    this._phase = 'stopped';
    this._running = false;
    this._current = null;
    this._finishedAt = Date.now();
    this._persist();
    // 等旧循环真正退出（最多 5s）：否则调用方紧接着 start() 时会出现两个托管循环并存。
    // 超时也不阻塞调用方；_gen 代次校验保证旧循环之后不会再改新循环的状态。
    // 用可清除的定时器：旧循环通常几毫秒就退出，别让一个 5s 定时器把进程/测试一直吊着。
    if (waitingLoop) {
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 5000);
      });
      await Promise.race([waitingLoop.catch(() => {}), timeout]);
      clearTimeout(timer);
    }
    return this.snapshot();
  }

  /** 硬停止（面板「停止」）：终止当前任务 + 清空队列/结果，之后不会自动恢复 */
  async abort(reason = 'manual') {
    await this.stop(reason);
    this._queue = [];
    this._results = [];
    this._stopRequested = true;
    this._note = '用户停止：已终止所有任务并清空队列，不会自动恢复';
    this._phase = 'stopped';
    this._running = false;
    this._current = null;
    this._finishedAt = Date.now();
    this._pushLog({ ev: 'auto-abort', reason: String(reason || 'manual'), note: this._note });
    this._persist();
    return { ...this.snapshot(), queueCleared: true };
  }

  /** 当前快照（可直接 JSON 序列化给工具层） */
  snapshot({ logLines = 20 } = {}) {    const n = Math.max(0, Math.floor(num(logLines, 20)));
    const end = this._running ? Date.now() : this._finishedAt || Date.now();
    return {
      running: !!this._running,
      phase: this._phase,
      trigger: this._trigger,
      account: this._accountName,
      startedAt: this._startedAt ? new Date(this._startedAt).toISOString() : '',
      elapsedSec: this._startedAt ? Math.round((end - this._startedAt) / 1000) : 0,
      error: this._error || '',
      note: this._note || '',
      config: this._configView(),
      stats: { ...this._stats },
      login: {
        ok: !!(this._login && this._login.ok),
        nick: (this._login && this._login.nick) || '',
        href: (this._login && this._login.href) || '',
        waitingSec: Math.round(num(this._login && this._login.waitingSec, 0)),
      },
      queue: this._queue.map((q) => this._queueView(q)),
      current: this._current
        ? {
            ...this._current,
            progress: this._current.progress ? { ...this._current.progress } : null,
            captcha: this._current.captcha ? { ...this._current.captcha } : null,
          }
        : null,
      logTail: n === 0 ? [] : this._logs.slice(-n),
    };
  }

  // ------------------------------------------------------------------ 主循环

  async _loop(gen) {
    try {
      if (this._stopRequested) return;
      this._setPhase('starting-browser');

      const account = this._resolveAccount();
      this._pushLog({ ev: 'account', name: this._accountName, port: account.port || 0 });
      const live = await this.hub.ensureBrowser(account, {
        startIfNeeded: true,
        edgePath: this.config.edgePath,
        startUrl: this._startUrl(),
      });
      if (this._stopRequested) return;
      if (!live) throw new Error(`浏览器连接失败（账号 ${this._accountName}）：请确认 Edge 能正常启动`);
      this._pushLog({ ev: 'browser-ready', port: live.port || account.port || 0 });

      // newWindow:false —— 登录/扫描只需要一个窗口：浏览器刚启动时复用其自带标签页，
      // 已经在跑时就在当前窗口开一个标签页，不再额外弹第二个登录窗口。
      const ensured = await this.hub.ensurePage(account, { edgePath: this.config.edgePath, newWindow: false });
      if (this._stopRequested) return;
      const page = ensured && ensured.page;
      if (!page) throw new Error('浏览器控制器页面创建失败：请确认 Edge 窗口没有被手动关掉');
      this._page = page;

      this._setPhase('waiting-login');
      const login = await this._waitLogin(page);
      this._login = login;
      if (this._stopRequested) return;
      if (!login.ok) {
        this._error =
          login.error ||
          `等待扫码登录超时（${this.config.loginWaitMinutes} 分钟）：请在 Edge 窗口里扫码登录学习通，完成后再启动自动任务`;
        this._pushLog({ ev: 'login-fail', err: truncate(this._error, 300) });
        this._setPhase('error');
        return;
      }

      this._setPhase('discovering');
      const resumed = this._resumeQueue();
      if (resumed) {
        this._queue = resumed;
        this._stats.courses = resumed.length;
        this._persist();
      } else {
        await this._discover(page);
      }
      if (this._stopRequested) return;
      if (!this._queue.length) {
        this._pushLog({
          ev: 'nothing-todo',
          hint: this.config.worksOnly ? '没有可做作业的课程' : '没有需要完成的课程任务点',
        });
        this._setPhase('done');
        return;
      }

      this._setPhase('working');
      await this._work(page, gen);
      if (this._stopRequested || gen !== this._gen) return;
      this._setPhase('done');
      this._pushLog({
        ev: 'auto-done',
        coursesDone: this._stats.coursesDone,
        courses: this._stats.courses,
        gained: this._stats.gained,
        nodesDone: this._stats.nodesDone,
        nodesFailed: this._stats.nodesFailed,
      });
    } catch (e) {
      if (gen !== this._gen) return;
      const msg = truncate((e && e.message) || String(e), 500);
      this._error = msg;
      this._pushLog({ ev: 'fatal', err: msg });
      this._phase = 'error';
    } finally {
      if (gen !== this._gen) return;
      this._running = false;
      this._current = null;
      this._finishedAt = this._finishedAt || Date.now();
      if (this._stopRequested && this._phase !== 'error') this._phase = 'stopped';
      this._persist();
    }
  }

  // ------------------------------------------------------------------ 登录

  /**
   * 打开 LOGIN_URL（仅当未登录）后轮询 probeLogin，直到登录 / 超时 / 停止。
   * 已登录直接返回。绝不关闭页面或浏览器。
   */
  async _waitLogin(page) {
    const loginUrl = this._startUrl();
    const loginLimit = Math.max(50, Math.round(num(this.config.loginWaitMinutes, AUTO_DEFAULTS.loginWaitMinutes) * 60000));
    // 登录等待也受整体 maxMinutes 预算约束，取两者较小值
    const budgetLeft = this._deadline ? this._deadline - Date.now() : loginLimit;
    const limitMs = Math.max(50, Math.min(loginLimit, budgetLeft));
    const poll = Math.max(1, Math.round(num(this.config.pollMs, AUTO_DEFAULTS.pollMs)));
    const t0 = Date.now();

    let st = await this._checkSession(page);
    const base = { ok: false, nick: (st && st.nick) || '', href: (st && st.href) || '', waitingSec: 0 };
    this._login = base;
    if (this._isLoggedIn(st)) {
      base.ok = true;
      this._login = base;
      this._pushLog({ ev: 'login-ok', href: truncate(base.href, 140), nick: base.nick, waitedSec: 0, via: 'session' });
      return base;
    }

    this._pushLog({ ev: 'login-required', href: truncate(base.href || loginUrl, 140), hint: '请在 Edge 窗口里扫码登录学习通' });
    // 如果当前页已经是登录页（刚启动的 Edge 直接开在 LOGIN_URL）就不再重复导航，避免多余刷新
    let alreadyThere = false;
    try {
      const cur = await page.evaluate('String(location.href)');
      alreadyThere = !!cur && /passport2?\.chaoxing\.com\/login|chaoxing\.com\/passport/i.test(String(cur));
    } catch {
      alreadyThere = false;
    }
    if (alreadyThere) {
      this._pushLog({ ev: 'login-goto-skip', href: truncate(String(base.href || ''), 140) });
    } else {
      try {
        await page.goto(loginUrl, { waitMs: 15000 });
      } catch (e) {
        this._pushLog({ ev: 'login-goto-fail', err: truncate((e && e.message) || e, 200) });
      }
    }
    if (this._stopRequested) return { ...base, waitingSec: Math.round((Date.now() - t0) / 1000), stopped: true };

    let lastHref = base.href;
    while (Date.now() - t0 < limitMs) {
      if (this._stopRequested) return { ...base, waitingSec: Math.round((Date.now() - t0) / 1000), stopped: true };
      await sleep(poll);
      if (this._stopRequested) return { ...base, waitingSec: Math.round((Date.now() - t0) / 1000), stopped: true };

      st = await this._probe(page);
      const cur = {
        ok: false,
        nick: (st && st.nick) || '',
        href: (st && st.href) || lastHref,
        waitingSec: Math.round((Date.now() - t0) / 1000),
      };
      this._login = cur; // 让 snapshot 在等待期间能看到 waitingSec
      if (st && st.href && st.href !== lastHref) {
        lastHref = st.href;
        this._pushLog({ ev: 'login-href', href: truncate(st.href, 140) });
      }
      if (this._isLoggedIn(st)) {
        cur.ok = true;
        this._login = cur;
        this._pushLog({ ev: 'login-ok', href: truncate(cur.href, 140), nick: cur.nick, waitedSec: cur.waitingSec });
        return cur;
      }
    }

    const out = {
      ok: false,
      nick: '',
      href: lastHref,
      waitingSec: Math.round((Date.now() - t0) / 1000),
      error: `等待扫码登录超时（已等 ${Math.round((Date.now() - t0) / 1000)} 秒）：请在 Edge 窗口里扫码登录学习通（或先用 chaoxing_account 的 login 动作登录），完成后再启动自动任务`,
    };
    this._login = out;
    this._pushLog({ ev: 'login-timeout', waitedSec: out.waitingSec });
    return out;
  }

  async _probe(page) {
    try {
      const st = await this.deps.probeLogin(page);
      return st || null;
    } catch (e) {
      this._pushLog({ ev: 'login-probe-fail', err: truncate((e && e.message) || e, 200) });
      return null;
    }
  }

  /**
   * 会话探测：先打开个人空间再 probeLogin。
   * 直接探测 about:blank / 登录页会把“已经登录”误判成未登录（登录页永远显示扫码框）。
   */
  async _checkSession(page) {
    try {
      await page.goto(SESSION_URL, { waitMs: 9000 });
    } catch (e) {
      this._pushLog({ ev: 'session-goto-fail', err: truncate((e && e.message) || e, 200) });
    }
    const st = await this._probe(page);
    if (st && st.redirected !== true) {
      this._pushLog({ ev: 'session-probe', href: truncate((st && st.href) || '', 140), loggedIn: !!(st && st.loggedIn), nick: (st && st.nick) || '' });
    }
    return st;
  }

  /** probeLogin 结果是否代表已登录（排除登录页 / 空白页，避免 about:blank 被误判） */
  _isLoggedIn(st) {
    if (!st || st.loggedIn !== true) return false;
    const href = String(st.href || '');
    if (!href || /^about:blank/i.test(href)) return false;
    if (/passport/i.test(href)) return false;
    if (st.onLoginPage === true) return false;
    return true;
  }

  // ------------------------------------------------------------------ 课程发现

  /**
   * discoverCourses → 过滤/指定课程 → 逐课 readCatalog 得 pending → 写 queue。
   * readCatalog 没有 limit 参数，scanLimit 只放进 ctx 供未来扩展；当前不做节点级截断。
   */
  async _discover(page) {
    const wanted = this.config.courses || [];
    const ctx = {
      log: (o) => this._pushLog(o),
      account: this._accountName,
      scanLimit: this.config.scanLimit,
    };
    this._pushLog({ ev: 'discover-start', account: this._accountName, wanted: wanted.length });

    let found = null;
    try {
      found = await this.deps.discoverCourses(page, ctx);
    } catch (e) {
      throw new Error(`课程发现失败：${truncate((e && e.message) || e, 200)}（请确认已登录且网络正常）`);
    }
    const courses = found && Array.isArray(found.courses) ? found.courses.slice() : [];
    this._pushLog({
      ev: 'discover-courses',
      count: courses.length,
      pages: found && Array.isArray(found.pagesTried) ? found.pagesTried.length : 0,
    });

    let picked = courses;
    if (wanted.length) {
      const sel = pickWanted(courses, wanted);
      if (sel.ambiguous.length) {
        const a = sel.ambiguous[0];
        throw new Error(
          `课程名「${truncate(a.spec, 40)}」匹配到多门课：${a.options
            .slice(0, 5)
            .map((c) => `${c.title}（${c.courseid}）`)
            .join('、')}，请写得更具体或用 courseid`
        );
      }
      picked = sel.picked;
      for (const m of sel.misses) {
        this._pushLog({
          ev: 'wanted-miss',
          spec: truncate(String(m), 80),
          hint: '课程列表里没找到这门课：请确认课程名/courseid，或先登录让课程列表刷新',
        });
      }
      if (!picked.length) {
        // 指定了课程却一门都没匹配上：必须明确报错，不能当成「没有任务」静默结束
        const names = courses.map((c) => c && c.title).filter(Boolean);
        throw new Error(
          `指定的课程在课程列表里没找到：${wanted
            .slice(0, 3)
            .map((w) => `「${truncate(String(w), 40)}」`)
            .join('、')}` +
            (names.length
              ? `；课程列表里有：${names.slice(0, 8).join('、')}${names.length > 8 ? '…' : ''}`
              : '（课程列表为空：可能还没登录，或课程页面没加载出来；请先在浏览器里打开学习通确认能看到课程）')
        );
      }
      this._pushLog({
        ev: 'wanted-picked',
        count: picked.length,
        titles: picked
          .slice(0, 8)
          .map((c) => truncate((c && c.title) || '', 30))
          .join('、'),
      });
    }

    const queue = [];
    let skipped = 0;
    // 在发现阶段如果控制器页被关掉/浏览器被重启，CDP 会话会失效（Page.navigate Session with given id not found）。
    // 此时重建控制器页并重试当前课程，而不是把整门课记成失败。
    let cur = page;
    const pageLost = (e) =>
      /Session with given id not found|Target closed|Not attached|WebSocket is not open|detached|Inspected target/i.test(
        String((e && e.message) || e)
      );
    const refreshPage = async (why) => {
      this._pushLog({ ev: 'page-reset', why: truncate(why, 140) });
      try {
        this.hub.invalidatePage(this._accountName);
      } catch {
        /* ignore */
      }
      const acc = this._resolveAccount();
      const ensured = await this.hub.ensurePage(acc, { edgePath: this.config.edgePath, newWindow: false });
      const next = ensured && ensured.page;
      if (next) {
        cur = next;
        this._page = next;
      }
      return cur;
    };
    for (const c of picked) {
      if (this._stopRequested) break;
      const course = {
        courseid: String((c && c.courseid) || ''),
        clazzid: String((c && c.clazzid) || ''),
        cpi: String((c && c.cpi) || ''),
        enc: String((c && c.enc) || '').toLowerCase(),
        title: truncate((c && c.title) || (c && c.courseid) || '未命名课程', 80),
      };
      const key = `${course.courseid}:${course.clazzid}`;
      if (!course.courseid || !course.clazzid) {
        skipped++;
        this._pushLog({ ev: 'course-invalid', courseid: course.courseid, title: course.title });
        continue;
      }
      try {
        let catalog;
        try {
          catalog = await this.deps.readCatalog(cur, course, ctx, { fast: true });
        } catch (e) {
          if (!pageLost(e)) throw e;
          await refreshPage((e && e.message) || e);
          catalog = await this.deps.readCatalog(cur, course, ctx, { fast: true });
        }
        const rows = Array.isArray(catalog) ? catalog : [];
        const pendingPoints = rows.reduce((a, r) => a + firstNum(r && r.points), 0);
        const pendingNodes = rows.filter((r) => firstNum(r && r.points) > 0).length;
        // 章节都刷完了也要看作业：有未交作业的课同样入队（engine 会跳过刷课直接做作业）
        let worksPending = 0;
        let worksTotal = 0;
        let worksOnly = false;
        if (this.config.solveWorks && this.config.scanWorks && pendingPoints === 0) {
          try {
            const wl = await this.deps.listWorks(cur, course, ctx, {
              attempts: 1,
              waitMs: 5000,
              polls: 3,
              pollMs: 1200,
            });
            if (wl && wl.ok) {
              const ws = Array.isArray(wl.items) ? wl.items : [];
              worksTotal = ws.length;
              worksPending = ws.filter((w) => (typeof w.canDo === 'boolean' ? w.canDo : !/已完成|已提交|已批改|待批阅/.test(`${w.title || ''} ${w.text || ''}`))).length;
            }
            this._pushLog({ ev: 'course-works', courseid: course.courseid, total: worksTotal, pending: worksPending });
          } catch (e) {
            this._pushLog({ ev: 'course-works-fail', courseid: course.courseid, err: truncate((e && e.message) || e, 160) });
          }
          worksOnly = worksPending > 0;
        }
        // worksOnly 时即使没有视频/文档任务点也要进去（作业可能还没做）
        if (pendingPoints > 0 || worksPending > 0 || this.config.worksOnly) {
          queue.push({
            key,
            courseid: course.courseid,
            clazzid: course.clazzid,
            cpi: course.cpi,
            enc: course.enc,
            title: course.title,
            pendingPoints,
            pendingNodes,
            worksPending,
            worksTotal,
            worksOnly,
            state: 'pending',
            error: '',
          });
          this._pushLog({
            ev: 'course-pending',
            courseid: course.courseid,
            title: truncate(course.title, 40),
            pendingPoints,
            pendingNodes,
            worksPending,
            worksOnly,
          });
        } else {
          skipped++;
          this._pushLog({ ev: 'course-skipped', courseid: course.courseid, title: course.title, why: 'no-pending-points' });
        }
      } catch (e) {
        skipped++;
        this._pushLog({ ev: 'course-catalog-fail', courseid: course.courseid, err: truncate((e && e.message) || e, 200) });
      }
    }

    this._queue = queue;
    this._stats.courses = queue.length;
    this._stats.coursesSkipped = skipped;
    this._pushLog({ ev: 'discover-done', queued: queue.length, skipped });
    this._persist();
  }

  /** resume=true 且 store.auto 里有未完成队列时，直接续跑（跳过重新发现/读目录） */
  _resumeQueue() {
    if (!this.config.resume || !this._resumeRaw) return null;
    const auto = this._resumeRaw;
    if (typeof auto !== 'object') return null;
    if (String(auto.account || '') !== this._accountName) return null;
    const prevPhase = String(auto.phase || '');
    if (!/^(working|discovering|error|stopped)$/.test(prevPhase)) return null;

    const rows = Array.isArray(auto.queue) ? auto.queue : [];
    let unfinished = rows.filter((r) => r && (r.state === 'pending' || r.state === 'working') && r.courseid);
    if (!unfinished.length) return null;

    const wanted = this.config.courses || [];
    if (wanted.length) {
      // 指定课程同样支持课程名：挑不到就返回 null 走正常发现（发现阶段会给出可读错误）
      unfinished = pickWanted(unfinished, wanted).picked;
      // 用户这轮指定了别的课 → 走正常发现，不要续跑旧队列
      if (!unfinished.length) return null;
    }

    const queue = unfinished.map((r) => ({
      key: `${r.courseid}:${r.clazzid || ''}`,
      courseid: String(r.courseid),
      clazzid: String(r.clazzid || ''),
      cpi: String(r.cpi || ''),
      enc: String(r.enc || '').toLowerCase(),
      title: truncate(r.title || r.courseid, 80),
      pendingPoints: firstNum(r.pendingPoints),
      pendingNodes: firstNum(r.pendingNodes),
      state: 'pending',
      error: '',
    }));
    this._pushLog({ ev: 'resume-queue', from: prevPhase, courses: queue.length, hint: '续跑 store.auto 里上次未完成的课程队列' });
    return queue;
  }

  // ------------------------------------------------------------------ 刷课/作业

  /**
   * 逐 queue 项交给 engine；每门课完成写 results/stats 并落盘。
   * 本模块不直接打开课程页面：engine 会自己开 target 并在结束时关掉。
   */
  async _work(_page, gen = this._gen) {
    let startedAny = false;
    for (const item of this._queue) {
      if (gen !== this._gen) return;
      if (item.state !== 'pending') continue;
      if (this._stopRequested) break;
      if (Date.now() >= this._deadline) {
        this._pushLog({ ev: 'budget-exhausted', min: this.config.maxMinutes, remaining: this._queue.filter((q) => q.state === 'pending').length });
        break;
      }

      // 课间随机停 2~5s；首门课不等
      if (startedAny) {
        const gap = randInt(2000, 5000);
        this._pushLog({ ev: 'course-gap', ms: gap });
        await sleepUnless(gap, () => this._stopRequested);
        if (this._stopRequested) break;
        if (gen !== this._gen) return;
      }
      startedAny = true;
      item.state = 'working';
      item.error = '';

      const course = { courseid: item.courseid, clazzid: item.clazzid, cpi: item.cpi, enc: item.enc, title: item.title };
      const remainingMin = Math.max(1, Math.ceil((this._deadline - Date.now()) / 60000));
      const jobMinutes = Math.max(1, Math.min(Math.round(num(this.config.maxMinutes, AUTO_DEFAULTS.maxMinutes)), remainingMin));
      const startArgs = {
        account: this._account || this._accountName,
        course,
        kinds: this.config.worksOnly || item.worksOnly ? [] : this.config.kinds.slice(),
        concurrency: this.config.concurrency,
        maxMinutes: jobMinutes,
        quizPolicy: this.config.solveQuizzes ? 'auto' : 'skip',
        solveWorks: !!this.config.solveWorks,
        minConfidence: this.config.minConfidence,
        autoSubmit: !!this.config.autoSubmit,
        dryRun: !!this.config.dryRun,
        maxBlanks: Number(this.config.maxBlanks) || 0,
        videoNotConfirmedMax: Number(this.config.videoNotConfirmedMax) || 0,
        blankGuard: this.config.blankGuard !== false,
        humanGuard: this.config.humanGuard !== false,
        startUrl: this._startUrl(),
        // 登录态在本阶段开头已经验过（session-probe），engine 里再探测一次反而有误判风险
        assumeLogin: true,
        // 任务页默认走标签页（同一个浏览器窗口），避免每开一个节点就弹一个新窗口
        taskWindow: !!this.config.taskWindow,
      };
      this._persist();

      let job = null;
      try {
        job = await this.engine.start(startArgs);
      } catch (e) {
        const msg = `启动任务失败：${truncate((e && e.message) || e, 240)}`;
        this._pushLog({ ev: 'engine-start-fail', courseid: item.courseid, err: msg });
        this._record(item, { state: 'failed', error: msg, progress: null, job: null });
        continue;
      }
      if (!job) {
        const msg = 'engine.start 没有返回任务对象';
        this._pushLog({ ev: 'engine-start-empty', courseid: item.courseid });
        this._record(item, { state: 'failed', error: msg, progress: null, job: null });
        continue;
      }
      if (job.already) {
        // engine 同账号互斥：已有任务在跑（可能是另一门课/手动扫描），本轮跳过而不是空转等待
        const msg = job.text || '同一账号已有任务在跑，跳过这门课';
        this._pushLog({ ev: 'engine-start-already', courseid: item.courseid, title: truncate(item.title, 40), job: job.id ? String(job.id) : '' });
        this._record(item, { state: 'skipped', error: msg, progress: null, job: null });
        continue;
      }

      this._pushLog({
        ev: 'course-work-start',
        courseid: item.courseid,
        title: truncate(item.title, 40),
        job: job.id ? String(job.id) : '',
        maxMinutes: jobMinutes,
        kinds: startArgs.kinds.join('+') || 'none',
        quizPolicy: startArgs.quizPolicy,
      });
      const outcome = await this._awaitJob(job, item, gen);
      if (gen !== this._gen) return;
      const state = outcome.finalState === 'done' ? 'done' : outcome.finalState === 'stopped' ? 'stopped' : 'failed';
      this._record(item, {
        state,
        error: outcome.finalState === 'error' ? outcome.error : '',
        progress: outcome.progress,
        job: outcome.job,
      });
    }
  }

  /** 轮询 engine job 直到终态 / 停止 / 整体超时 */
  async _awaitJob(job, item, gen = this._gen) {
    // 已被新的 start() 取代：当前 job 的收尾归新循环管，旧循环不许再写 _jobActive/_current
    const stale = () => gen !== this._gen;
    if (stale()) return { finalState: 'stopped', job, error: '', progress: null, stale: true };
    const poll = Math.max(1, Math.round(num(this.config.pollMs, AUTO_DEFAULTS.pollMs)));
    const jobId = job && job.id ? String(job.id) : '';
    const t0 = Date.now();
    this._jobId = jobId;
    this._jobActive = !!jobId;
    this._jobStopSent = false;
    this._captchaNoted = false;
    this._current = {
      courseid: item.courseid,
      title: item.title,
      jobId,
      state: (job && job.state) || 'starting',
      progress: null,
      captcha: null,
      sec: 0,
    };
    this._persist();

    let finalJob = job;
    let finalState = 'error';
    let lastError = '';

    for (;;) {
      if (stale()) break;
      if (this._stopRequested) {
        this._stopEngineJob();
        finalState = 'stopped';
        break;
      }
      const cur = this._getJob(jobId) || job;
      finalJob = cur;
      const view = this._jobView(cur);
      const state = view.state || 'unknown';
      this._current = {
        courseid: item.courseid,
        title: item.title,
        jobId,
        state,
        progress: view.progress,
        captcha:
          cur && cur.captcha
            ? { imagePath: String(cur.captcha.imagePath || ''), at: firstNum(cur.captcha.at) }
            : null,
        sec: Math.round((Date.now() - t0) / 1000),
      };
      if (state === 'need_captcha' && !this._captchaNoted) {
        this._captchaNoted = true;
        this._pushLog({
          ev: 'need-captcha',
          job: jobId,
          imagePath: (cur && cur.captcha && cur.captcha.imagePath) || '',
          hint: `用 chaoxing_exam 的 captcha 动作（jobId=${jobId}）把人工验证码交给该任务`,
        });
        this._persist();
      }
      if (TERMINAL.has(state)) {
        finalState = state;
        break;
      }
      if (Date.now() >= this._deadline) {
        this._pushLog({ ev: 'job-budget', job: jobId, min: this.config.maxMinutes });
        this._stopEngineJob();
        finalState = 'stopped';
        break;
      }
      await sleep(poll);
    }

    const view = this._jobView(finalJob);
    if (stale()) {
      // 代次已过期：绝不清理新循环的 _jobActive/_current，也不把旧结果写回队列
      return { finalState: 'stopped', job: finalJob, error: '', progress: view.progress, stale: true };
    }
    this._jobActive = false;
    this._current = null;
    if (finalState === 'error') lastError = String(view.error || lastError || '任务异常终止（引擎没有给出原因）');
    return { finalState, job: finalJob, error: lastError, progress: view.progress };
  }

  _getJob(id) {
    if (!id || !this.engine || typeof this.engine.get !== 'function') return null;
    try {
      return this.engine.get(id) || null;
    } catch (e) {
      this._pushLog({ ev: 'engine-get-fail', job: id, err: truncate((e && e.message) || e, 200) });
      return null;
    }
  }

  /** 停当前 engine job；用 _jobStopSent 保证一次 stop 只调用一次 engine.stop */
  _stopEngineJob() {
    if (!this._jobId || this._jobStopSent) return { ok: false, skipped: true };
    this._jobStopSent = true;
    try {
      const r = this.engine && typeof this.engine.stop === 'function' ? this.engine.stop(this._jobId) : null;
      if (r && typeof r.then === 'function') r.catch(() => {});
      this._pushLog({ ev: 'engine-stop', job: this._jobId, reason: this._stopReason || 'stop' });
      return { ok: true };
    } catch (e) {
      this._pushLog({ ev: 'engine-stop-fail', job: this._jobId, err: truncate((e && e.message) || e, 200) });
      return { ok: false, err: String((e && e.message) || e) };
    }
  }

  /** 把 engine job/snapshot 归一成 {state, progress, error}，兼容引擎尚未提供扩展统计的情况 */
  _jobView(job) {
    if (!job) return { state: '', progress: null, error: '' };
    let snap = null;
    try {
      if (this.engine && typeof this.engine.snapshot === 'function') {
        snap = this.engine.snapshot(job, { logLines: 0, results: false });
      }
    } catch {
      snap = null;
    }
    const src = snap && typeof snap === 'object' ? snap : job;
    const state = String((src && src.state) || (job && job.state) || '');
    const error = String((src && src.error) || (job && job.error) || '');
    const base =
      (src && typeof src.progress === 'object' && src.progress) ||
      (job && typeof job.progress === 'object' && job.progress) ||
      null;
    let progress = base ? { ...base } : null;
    for (const k of ['quizzesSolved', 'quizSolved', 'worksSolved', 'workSolved', 'skippedLowConfidence']) {
      if (src && src[k] !== undefined && src[k] !== null) {
        if (!progress) progress = {};
        progress[k] = src[k];
      }
    }
    return { state, progress, error };
  }

  /** 从 engine 的 progress / 顶层统计 / 日志里尽力取出测验、作业、低置信度计数 */
  _jobStats(job, progress) {
    const p = progress || {};
    const j = job || {};
    const out = {
      quizzesSolved: firstNum(p.quizzesSolved, p.quizSolved, j.quizzesSolved, j.quizSolved),
      worksSolved: firstNum(p.worksSolved, p.workSolved, j.worksSolved, j.workSolved),
      skippedLowConfidence: firstNum(p.skippedLowConfidence, j.skippedLowConfidence),
    };
    const logs = Array.isArray(j.logs) ? j.logs : [];
    if (!out.quizzesSolved && logs.length) {
      out.quizzesSolved = logs.filter((l) => l && l.ev === 'quiz-submit' && l.ok !== false).length;
    }
    if (!out.worksSolved && logs.length) {
      out.worksSolved = logs.filter(
        (l) => l && typeof l.ev === 'string' && /^work-(submit|done|solved)$/.test(l.ev) && l.ok !== false,
      ).length;
    }
    return out;
  }

  /** 记录一门课的结果并累加 stats、落盘 */
  _record(item, { state = 'failed', error = '', progress = null, job = null } = {}) {
    const p = progress || {};
    const hasProgress = !!progress && typeof progress === 'object';
    const pointsFrom = firstNum(p.pointsAtStart, p.catalogTotal, item.pendingPoints);
    const pointsNowRaw = hasProgress ? p.pointsNow : undefined;
    const pointsTo = Number.isFinite(Number(pointsNowRaw)) && pointsNowRaw !== undefined
      ? Number(pointsNowRaw)
      : state === 'done'
        ? 0
        : pointsFrom;
    const counts = this._jobStats(job, p);

    item.state = state;
    item.error = error || '';

    const row = {
      key: item.key,
      courseid: item.courseid,
      title: item.title,
      state,
      pointsFrom,
      pointsTo,
      nodesDone: firstNum(p.nodesDone),
      nodesFailed: firstNum(p.nodesFailed),
    };
    if (error) row.error = truncate(error, 300);
    this._results.push(row);

    this._stats.pointsFrom += pointsFrom;
    this._stats.pointsTo += pointsTo;
    this._stats.gained = this._stats.pointsFrom - this._stats.pointsTo;
    this._stats.nodesDone += row.nodesDone;
    this._stats.nodesFailed += row.nodesFailed;
    this._stats.quizzesSolved += counts.quizzesSolved;
    this._stats.worksSolved += counts.worksSolved;
    this._stats.skippedLowConfidence += counts.skippedLowConfidence;
    if (state === 'done') this._stats.coursesDone += 1;

    this._pushLog({
      ev: 'course-work-end',
      courseid: item.courseid,
      state,
      pointsFrom,
      pointsTo,
      nodesDone: row.nodesDone,
      nodesFailed: row.nodesFailed,
      ...(error ? { err: truncate(error, 160) } : {}),
    });
    this._persist();
    return row;
  }

  // ------------------------------------------------------------------ 其它内部工具

  _emptyStats() {
    return {
      courses: 0,
      coursesDone: 0,
      coursesSkipped: 0,
      pointsFrom: 0,
      pointsTo: 0,
      gained: 0,
      nodesDone: 0,
      nodesFailed: 0,
      quizzesSolved: 0,
      worksSolved: 0,
      skippedLowConfidence: 0,
    };
  }

  /** 合并/规整配置；llm=null 时强制关闭测验与作业 */
  _normalize() {
    const c = this.config;
    c.account = String(c.account || AUTO_DEFAULTS.account);
    c.pollMs = clamp(num(c.pollMs, AUTO_DEFAULTS.pollMs), 1, 60000);
    c.loginWaitMinutes = Math.max(0.001, num(c.loginWaitMinutes, AUTO_DEFAULTS.loginWaitMinutes));
    c.concurrency = Math.round(clamp(num(c.concurrency, AUTO_DEFAULTS.concurrency), 1, 4));
    c.maxMinutes = clamp(num(c.maxMinutes, AUTO_DEFAULTS.maxMinutes), 1, 24 * 60);
    const kinds = Array.isArray(c.kinds) ? c.kinds : AUTO_DEFAULTS.kinds;
    c.kinds = kinds.filter((k) => k === 'video' || k === 'document');
    if (!c.kinds.length) c.kinds = ['video', 'document'];
    c.solveQuizzes = !!c.solveQuizzes;
    c.solveWorks = !!c.solveWorks;
    c.minConfidence = clamp(num(c.minConfidence, AUTO_DEFAULTS.minConfidence), 0, 1);
    c.autoSubmit = c.autoSubmit !== false;
    c.dryRun = !!c.dryRun;
    if (Array.isArray(c.courses)) c.courses = c.courses.map(String).map((s) => s.trim()).filter(Boolean);
    else c.courses = c.courses ? [String(c.courses).trim()].filter(Boolean) : [];
    c.worksOnly = !!c.worksOnly;
    c.startUrl = String(c.startUrl || '');
    c.resume = c.resume !== false;
    c.scanLimit = Math.max(0, Math.floor(num(c.scanLimit, 0)));

    if (!this.llm) {
      c.solveQuizzes = false;
      c.solveWorks = false;
      this._note = '未检测到可用的模型服务（llm=null）：已自动关闭章节测验与作业作答，只做视频/文档任务点。';
    } else {
      this._note = '';
    }
    this._accountName = c.account;
  }

  _configView() {
    const c = this.config;
    return {
      account: this._accountName,
      pollMs: c.pollMs,
      loginWaitMinutes: c.loginWaitMinutes,
      concurrency: c.concurrency,
      maxMinutes: c.maxMinutes,
      kinds: Array.isArray(c.kinds) ? c.kinds.slice() : [],
      solveQuizzes: !!c.solveQuizzes,
      solveWorks: !!c.solveWorks,
      minConfidence: c.minConfidence,
      autoSubmit: !!c.autoSubmit,
      dryRun: !!c.dryRun,
      courses: Array.isArray(c.courses) ? c.courses.slice() : [],
      worksOnly: !!c.worksOnly,
      scanWorks: !!c.scanWorks,
      resume: !!c.resume,
      scanLimit: c.scanLimit,
      startUrl: c.startUrl,
      llm: !!this.llm,
    };
  }

  _startUrl() {
    return String(this.config.startUrl || this.deps.LOGIN_URL || LOGIN_URL);
  }

  _resolveAccount() {
    const opts = { create: true };
    if (this.config.port !== undefined) opts.port = this.config.port;
    if (this.config.profileDir !== undefined) opts.profileDir = this.config.profileDir;
    const acc = accountGet(this.store, this._accountName, opts);
    this._account = acc;
    this._accountName = String((acc && acc.name) || this._accountName);
    return acc;
  }

  _setPhase(p, extra = null) {
    // 已请求停止时，不再回到 running 类阶段（但允许落到 error）
    if (this._stopRequested && p !== 'stopped' && p !== 'error') return this._phase;
    this._phase = p;
    if (p === 'done' || p === 'stopped' || p === 'error') this._finishedAt = this._finishedAt || Date.now();
    this._pushLog({ ev: 'phase', phase: p, ...(extra || {}) });
    this._persist();
    return p;
  }

  _queueView(q) {
    const v = {
      key: q.key,
      courseid: q.courseid,
      title: q.title,
      pendingPoints: firstNum(q.pendingPoints),
      worksPending: firstNum(q.worksPending),
      worksOnly: !!q.worksOnly,
      state: q.state,
    };
    if (q.error) v.error = truncate(q.error, 300);
    return v;
  }

  _queueStoreView(q) {
    return {
      key: q.key,
      courseid: q.courseid,
      clazzid: q.clazzid,
      cpi: q.cpi,
      enc: q.enc,
      title: q.title,
      pendingPoints: firstNum(q.pendingPoints),
      pendingNodes: firstNum(q.pendingNodes),
      worksPending: firstNum(q.worksPending),
      worksTotal: firstNum(q.worksTotal),
      worksOnly: !!q.worksOnly,
      state: q.state,
      error: q.error || '',
    };
  }

  /** 每阶段 / 每门课后写 store.auto，并 touch + flush */
  _persist() {
    try {
      const data = {
        updatedAt: nowISO(),
        trigger: this._trigger,
        phase: this._phase,
        account: this._accountName,
        startedAt: this._startedAt ? new Date(this._startedAt).toISOString() : '',
        finishedAt: this._finishedAt ? new Date(this._finishedAt).toISOString() : '',
        elapsedSec: this._startedAt ? Math.round(((this._finishedAt || Date.now()) - this._startedAt) / 1000) : 0,
        llm: !!this.llm,
        note: this._note || '',
        stats: { ...this._stats },
        queue: this._queue.map((q) => this._queueStoreView(q)),
        results: this._results.map((r) => ({ ...r })),
      };
      if (this.store && typeof this.store.set === 'function') this.store.set('auto', data);
      // store.touch() 自带 400ms 去抖落盘；这里不再强制 flush，避免每次阶段切换都整档同步重写
      if (this.store && typeof this.store.touch === 'function') this.store.touch();
    } catch (e) {
      this._pushLog({ ev: 'persist-fail', err: truncate((e && e.message) || e, 200) });
    }
  }

  /** 环形日志：进 snapshot.logTail 的是字符串，交给 log() 的是 JS 对象 */
  _pushLog(obj) {
    const o = obj && typeof obj === 'object' ? obj : { msg: String(obj) };
    const line = this._formatLog(o);
    this._logs.push(line);
    if (this._logs.length > RING_LIMIT) this._logs.splice(0, this._logs.length - RING_LIMIT);
    try {
      this.log({ at: nowISO(), auto: true, ...o });
    } catch {
      /* 日志写盘失败不影响主流程 */
    }
  }

  _formatLog(o) {
    const parts = [];
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined || v === null || v === '') continue;
      let s;
      if (typeof v === 'object') {
        try {
          s = JSON.stringify(v);
        } catch {
          s = String(v);
        }
      } else {
        s = String(v);
      }
      parts.push(`${k}=${truncate(s, 120)}`);
    }
    return truncate(`[${nowClock()}] ${parts.join(' ') || 'log'}`, 400);
  }
}

export default Autopilot;
