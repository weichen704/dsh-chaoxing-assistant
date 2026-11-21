// 学习通助手的宿主侧命令：让右侧栏 UI（以及手打斜杠命令）能触发同一套操作。
// 与 chaoxing_* 工具共用 engine / autopilot / hub 实例，不在 UI 里另写一份逻辑。
import { probeLogin, LOGIN_URL } from './chaoxing.mjs';
import { parseCourseParams, truncate } from './util.mjs';

const COMMAND_NAME = 'chaoxing';

function shortErr(e) {
  const msg = String((e && e.message) || e || '') || '未知错误';
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

function fmtJob(job) {
  if (!job) return '';
  const p = job.progress || {};
  const parts = [
    `job ${job.id}`,
    `state=${job.state}`,
    `kind=${job.kind || 'run'}`,
  ];
  if (job.course) parts.push(`course=${job.course.courseid}`);
  if (p.total !== undefined) parts.push(`nodes ${p.done || 0}/${p.planned || 0}`);
  if (job.kind === 'scan' && job.scanSummary) {
    parts.push(`pending=${job.scanSummary.pendingCount}`);
  }
  return parts.join(' ');
}

export function registerChaoxingCommands(ctx, deps, config = {}) {
  const { store, hub, engine, autopilot } = deps;
  const disposers = [];
  // 用完整账号记录（含 port/profileDir），不要传 {name} 桩——否则会另起浏览器
  const accOf = (name) => {
    try {
      return (store.get('accounts', {}) || {})[name] || { name };
    } catch {
      return { name };
    }
  };
  const log = (o) => {
    try {
      store.pushLog('command', o);
    } catch {
      /* ignore */
    }
  };

  const autoCfg = config.auto || {};
  let lastStopAt = 0;
  const defaultAccount = () =>
    config.autoAccount || autoCfg.account || firstAccount() || 'default';

  function firstAccount() {
    try {
      const accounts = store.get('accounts', {}) || {};
      const names = Object.keys(accounts);
      return names.length ? names[0] : '';
    } catch {
      return '';
    }
  }

  function accountList() {
    try {
      const accounts = store.get('accounts', {}) || {};
      return Object.entries(accounts).map(([key, value]) => ({
        name: key,
        port: value && value.port,
        profileDir: value && value.profileDir,
        running: !!(value && value.pid),
      }));
    } catch {
      return [];
    }
  }

  function scanList(account) {
    try {
      const scans = store.get('scans', {}) || {};
      return Object.entries(scans)
        .filter(([key]) => !account || key.startsWith(`${account}:`))
        .map(([key, value]) => ({
          key,
          courseid: value && value.course && value.course.courseid,
          title: (value && value.course && value.course.title) || '',
          totalPoints: value && value.totalPoints,
          pendingPoints: value && value.pendingPoints,
          pendingCount: value && value.pendingCount,
        }))
        .filter((row) => row && row.courseid);
    } catch {
      return [];
    }
  }

  /**
   * 支持用户直接输入课程名（"电工电子技术"）：先查已保存的课程/扫描记录，
   * 查不到再在线拉一次课程列表；同名或多门近似课会列出候选让用户选。
   */
  async function resolveCourseInput(raw, account) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return pickCourse('', account);
    // 纯数字 courseid / courseid:clazzid[:cpi[:enc]]
    if (/^\d+$/.test(trimmed)) return enrich({ courseid: trimmed }, account);
    if (/^\d+(:\d+){1,3}$/.test(trimmed)) {
      const [courseid, clazzid, cpi, enc] = trimmed.split(':');
      return enrich({ courseid, clazzid, cpi, enc }, account);
    }
    const looksLikeUrl = /[?=&]/.test(trimmed) || /courseid=|courseId=/i.test(trimmed);
    if (!looksLikeUrl) {
      const hit = findCourseByName(trimmed, account);
      if (hit) return enrich({ courseid: String(hit.courseid), title: hit.title }, account);
      const fetched = await fetchCourses(account);
      const hit2 = findCourseByName(trimmed, account, fetched);
      if (hit2) return enrich({ courseid: String(hit2.courseid), title: hit2.title }, account);
      const saved = courseCandidates(account);
      const sample = saved.slice(0, 10).map((c) => c.title).filter(Boolean).join('、');
      throw new Error(
        `找不到课程「${trimmed}」${saved.length ? `，可能的课程名：${sample}${saved.length > 10 ? '…' : ''}` : '（还没有课程列表，先点「刷新状态」或在工具里跑 chaoxing_account courses）'}`
      );
    }
    const parsed = parseCourseParams(trimmed);
    if (!parsed || !parsed.courseid) throw new Error('课程参数不完整，至少需要 courseid（也可以直接给课程名）');
    return enrich(parsed, account);
  }

  function courseCandidates(account) {
    const rows = [];
    const seen = new Map();
    try {
      const saved = store.get('courses', {}) || {};
      for (const [key, c] of Object.entries(saved)) {
        if (!c || !c.courseid) continue;
        if (account && !key.startsWith(`${account}:`)) continue;
        const row = { courseid: String(c.courseid), title: c.title || '', clazzid: c.clazzid, cpi: c.cpi, enc: c.enc };
        const prev = seen.get(row.courseid);
        if (prev) {
          if (!prev.title && row.title) Object.assign(prev, row);
          continue;
        }
        seen.set(row.courseid, row);
        rows.push(row);
      }
    } catch {
      /* ignore */
    }
    for (const scan of scanList(account)) {
      const prev = seen.get(String(scan.courseid));
      if (prev && (prev.title || !scan.title)) continue;
      const row = { courseid: String(scan.courseid), title: scan.title || '', pendingPoints: scan.pendingPoints };
      if (prev) Object.assign(prev, row);
      else {
        seen.set(row.courseid, row);
        rows.push(row);
      }
    }
    return rows;
  }

  function findCourseByName(name, account, extra = []) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s\u3000·\-—_()（）【】\[\]《》]/g, '');
    const target = norm(name);
    if (!target) return null;
    const all = courseCandidates(account).concat(extra);
    const title = (c) => norm(c.title);
    const exact = all.filter((c) => title(c) === target);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      const ids = new Set(exact.map((c) => c.courseid));
      if (ids.size === 1) return exact[0];
      throw new Error(`课程名「${name}」匹配到多门课：${exact.map((c) => `${c.title}（${c.courseid}）`).join('、')}，请补 courseid 区分`);
    }
    const loose = all.filter((c) => {
      const t = title(c);
      return t && (t.includes(target) || target.includes(t));
    });
    if (!loose.length) return null;
    if (loose.length === 1) return loose[0];
    const best = loose.slice().sort((a, b) => String(a.title).length - String(b.title).length)[0];
    const ids = new Set(loose.map((c) => c.courseid));
    if (ids.size === 1) return best;
    throw new Error(
      `课程名「${name}」匹配到多门课：${loose
        .slice(0, 6)
        .map((c) => `${c.title}（${c.courseid}）`)
        .join('、')}，请写得更具体或直接用 courseid`
    );
  }

  /** 在线拉一次课程列表（需要浏览器已登录；失败不致命）。 */
  async function fetchCourses(account) {
    try {
      const { page } = await hub.ensurePage(accOf(account), { newWindow: false });
      if (!page) return [];
      const { discoverCourses } = await import('./chaoxing.mjs');
      const ctx = { store, python: deps.python, log: () => {} };
      const res = await discoverCourses(page, ctx);
      const list = (res && res.courses) || [];
      return list.map((c) => ({ courseid: String(c.courseid), title: c.title || '', clazzid: c.clazzid, cpi: c.cpi, enc: c.enc }));
    } catch {
      return [];
    }
  }


  function enrich(course, account) {
    if (!course || !course.courseid) return course;
    const saved = store.get('courses', {}) || {};
    const match =
      saved[`${account}:${course.courseid}`] ||
      Object.values(saved).find((c) => c && String(c.courseid) === String(course.courseid));
    if (match) {
      if (!course.clazzid && match.clazzid) course.clazzid = match.clazzid;
      if (!course.cpi && match.cpi) course.cpi = match.cpi;
      if (!course.enc && match.enc) course.enc = match.enc;
      if (!course.title && match.title) course.title = match.title;
    }
    return course;
  }

  function pickCourse(raw, account) {
    const trimmed = String(raw || '').trim();
    if (trimmed) {
      let parsed = null;
      if (/^\d+$/.test(trimmed)) {
        parsed = { courseid: trimmed };
      } else if (/^\d+(:\d+){1,3}$/.test(trimmed)) {
        const [courseid, clazzid, cpi, enc] = trimmed.split(':');
        parsed = { courseid, clazzid, cpi, enc };
      } else {
        parsed = parseCourseParams(trimmed);
      }
      if (!parsed || !parsed.courseid) throw new Error('课程参数不完整，至少需要 courseid（也可以直接给 courseid:clazzid:cpi）');
      return enrich(parsed, account);
    }
    const pending = scanList(account).filter((row) => (row.pendingPoints || 0) > 0 || (row.pendingCount || 0) > 0);
    const fallback = pending[0] || scanList(account)[0];
    if (!fallback) {
      throw new Error('还没有扫描记录：请先运行 scan <courseid:clazzid:cpi>，或在工具里用 chaoxing_tasks scan');
    }
    return enrich({ courseid: String(fallback.courseid), title: fallback.title }, account);
  }

  async function loggedInHint() {
    try {
      const { page } = await hub.ensurePage(accOf(defaultAccount()));
      const info = await probeLogin(page);
      return info;
    } catch (e) {
      return { ok: false, error: shortErr(e) };
    }
  }

  function compactJob(job) {
    const p = job.progress || {};
    const course = (job.course && (job.course.title || job.course.courseid)) || job.id;
    const tail = job.state === 'need_captcha' ? '（等验证码）' : '';
    return `${course} ${p.nodesDone || 0}/${p.nodesPlanned || 0}节点 作业${p.worksSolved || 0}${tail}`;
  }

  function fmtClock(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return h ? `${h}小时${String(m).padStart(2, '0')}分` : `${m}分${String(ss).padStart(2, '0')}秒`;
  }

  function bar(ratio, width = 10) {
    const r = Math.max(0, Math.min(1, Number(ratio) || 0));
    const filled = Math.round(r * width);
    return '▰'.repeat(filled) + '▱'.repeat(width - filled);
  }

  /** 面板用的多行进度：阶段 / 本轮 / 当前课程 / 累计 / 待跑，一眼看清。 */
  function progressText() {
    const lines = [];
    let snap = null;
    try {
      snap = autopilot ? autopilot.snapshot({ logLines: 0 }) : null;
    } catch {
      snap = null;
    }
    const st = (snap && snap.stats) || {};
    const phase = snap ? String(snap.phase || '') : '';

    if (snap && phase) {
      const marks = {
        idle: '⏸ 空闲（点「开始」启动）',
        'starting-browser': '🚀 正在启动浏览器',
        'waiting-login': '🔐 等待登录（在 Edge 窗口扫码）',
        discovering: '🔎 正在扫描课程',
        working: '⚡ 正在刷课 / 做作业',
        done: '✅ 本轮完成（点「开始」可重新扫描）',
        stopped: '⏹ 已停止（点「开始」重新运行）',
        error: '⚠ 出错（点「开始」重试）',
      };
      const head = marks[phase] || `全自动 ${phase}`;
      lines.push(`▸ ${head}${snap.elapsedSec ? ` · 已运行 ${fmtClock(snap.elapsedSec)}` : ''}`);
      if (snap.error) lines.push(`▸ 错误：${truncate(snap.error, 160)}`);
      if (snap.note) lines.push(`▸ 说明：${truncate(snap.note, 160)}`);

      const total = Number(st.courses) || 0;
      const doneCount = Number(st.coursesDone) || 0;
      if (total) {
        const left = snap.queue.filter((q) => q.state === 'pending').length;
        lines.push(`▸ 本轮 ${doneCount}/${total} 门完成${left ? ` · 剩余 ${left} 门` : ''}`);
      }
      const cur = snap.current;
      const curP = (cur && cur.progress) || {};
      if (cur) {
        const p = cur.progress || {};
        const planned = Number(p.planned ?? p.total ?? 0);
        const doneNodes = Number(p.done ?? p.nodesDone ?? 0);
        const ratio = planned ? doneNodes / planned : 0;
        const courseName = cur.title || cur.courseid || '';
        lines.push(
          `▸ 当前 ${courseName}${planned ? ` · 节点 ${doneNodes}/${planned} ${bar(ratio)} ${Math.round(ratio * 100)}%` : ''}${cur.state === 'need_captcha' ? ' · 等验证码' : ''}`
        );
      }
      // 课程未结束时，该课程的节点/测验还没有汇总进 stats，这里把当前 job 的实时数补上，避免一直显示 0。
      const aggNodes = (Number(st.nodesDone) || 0) + (Number(curP.nodesDone) || 0);
      const aggFail = (Number(st.nodesFailed) || 0) + (Number(curP.nodesFailed) || 0);
      const aggQuiz = (Number(st.quizzesSolved) || 0) + (Number(curP.quizzesSolved) || 0);
      const aggWork = (Number(st.worksSolved) || 0) + (Number(curP.worksSolved) || 0);
      lines.push(
        `▸ 累计 节点 ${aggNodes} 完成 / ${aggFail} 失败 · 测验 ${aggQuiz} · 作业 ${aggWork} · 点数 ${Number(st.pointsFrom) || 0}→${Number(st.pointsTo) || 0}`
      );
      const pendingCourses = snap.queue.filter((q) => q.state === 'pending').slice(0, 3);
      if (pendingCourses.length) {
        lines.push(`▸ 待跑 ${pendingCourses.map((q) => `${q.title || q.courseid}${q.pendingPoints ? `(${q.pendingPoints}点)` : ''}`).join(' · ')}${leftMore(snap.queue)}`);
      }
    }

    let jobs = [];
    try {
      jobs = (engine.list() || []).filter((j) => j.state === 'running' || j.state === 'starting' || j.state === 'need_captcha');
    } catch {
      /* ignore */
    }
    if (!snap || !phase || phase === 'idle' || phase === 'stopped') {
      if (jobs.length) lines.push(`▸ 手动任务 ${jobs.length} 个：${jobs.slice(0, 2).map(compactJob).join('；')}`);
      else if (!lines.length) lines.push('▸ 空闲（点「开始」启动全自动，或刷新状态）');
    }
    return lines.join('\n');
  }

  function leftMore(queue) {
    const left = queue.filter((q) => q.state === 'pending').length;
    return left > 3 ? ` 等 ${left} 门` : '';
  }

  async function statusText() {
    const lines = [];
    lines.push(`账号：${accountList().map((a) => `${a.name}${a.running ? '（运行中）' : ''}`).join('、') || '（未登记）'}`);
    const scans = scanList();
    const pending = scans.filter((row) => (row.pendingPoints || 0) > 0 || (row.pendingCount || 0) > 0);
    lines.push(`扫描记录：${scans.length} 门，待完成 ${pending.length} 门`);
    for (const row of pending.slice(0, 4)) {
      lines.push(`  · ${row.title || row.courseid} 剩 ${row.pendingPoints ?? '?'} 点 / ${row.pendingCount ?? '?'} 节点`);
    }
    const jobs = (engine && engine.list ? engine.list() : []).filter((job) => job.state === 'running' || job.state === 'starting' || job.state === 'need_captcha');
    if (jobs.length) {
      lines.push(`运行中的任务：${jobs.length}`);
      for (const job of jobs.slice(0, 3)) lines.push(`  · ${fmtJob(job)}`);
    } else {
      lines.push('运行中的任务：无');
    }
    if (autopilot && autopilot.phase) {
      lines.push(`全自动托管：${autopilot.phase}${autopilot.running ? '' : ''}`);
    }
    return lines.join('\n');
  }

  async function handleLogin() {
    const { page } = await hub.ensurePage(accOf(defaultAccount()));
    const before = await probeLogin(page);
    if (before && before.loggedIn) {
      return `已登录${before.nick ? `：${before.nick}` : ''}（${before.href || ''}）`;
    }
    await page.goto(LOGIN_URL, { waitMs: 6000, timeoutMs: 30000 }).catch(() => {});
    return '已打开学习通登录页：请在 Edge 窗口里扫码，登录完成后点「刷新」或再点「登录检测」';
  }

  async function handleScan(raw) {
    const account = defaultAccount();
    const course = await resolveCourseInput(raw, account);
    if (!course.cpi) throw new Error('缺少 cpi，无法扫描：请给出完整 courseid:clazzid:cpi');
    const job = engine.startScan({ account, course, concurrency: 2 });
    return `已开始扫描 ${course.title || course.courseid}（job ${job.id}），点「刷新」查看进度`;
  }

  async function handleRun(raw, { worksOnly = false } = {}) {
    const account = defaultAccount();
    const course = await resolveCourseInput(raw, account);
    if (!course.cpi) throw new Error('缺少 cpi，无法启动：请给出完整 courseid:clazzid:cpi');
    const job = engine.start({
      account,
      course,
      kinds: worksOnly ? [] : ['video', 'document'],
      concurrency: 2,
      maxMinutes: Number(autoCfg.maxMinutes || 120),
      quizPolicy: 'auto',
      solveWorks: true,
      minConfidence: Number(autoCfg.minConfidence || 0.6),
      autoSubmit: true,
      dryRun: false,
    });
    return `已开始${worksOnly ? '做作业' : '刷课+做题'} ${course.title || course.courseid}（job ${job.id}），点「刷新」查看进度`;
  }

  async function handleAuto() {
    const account = defaultAccount();
    const phase = String((autopilot && autopilot.phase) || 'idle');
    if (phase === 'stopped' || phase === 'done' || phase === 'error') {
      // 继续/重启：保留队列续跑（autopilot.start 内部走 resume）
      autopilot.start(
        {
          account,
          courses: [],
          concurrency: 2,
          maxMinutes: Number(autoCfg.maxMinutes || 240),
          kinds: ['video', 'document'],
          solveQuizzes: true,
          solveWorks: true,
          minConfidence: Number(autoCfg.minConfidence || 0.6),
          autoSubmit: true,
          dryRun: false,
          loginWaitMinutes: Number(autoCfg.loginWaitMinutes || 30),
          resume: true,
        },
        'command',
      );
      return `全自动已开始（上一轮 ${phase}，队列续跑）：登录检测 → 扫描 → 刷课 → 做作业/测验`;
    }
    autopilot.start(
      {
        account,
        courses: [],
        concurrency: 2,
        maxMinutes: Number(autoCfg.maxMinutes || 240),
        kinds: ['video', 'document'],
        solveQuizzes: true,
        solveWorks: true,
        minConfidence: Number(autoCfg.minConfidence || 0.6),
        autoSubmit: true,
        dryRun: false,
        loginWaitMinutes: Number(autoCfg.loginWaitMinutes || 30),
      },
      'command',
    );
    return '全自动已开始：登录检测 → 扫描 → 刷课 → 做作业/测验（点「刷新状态」看阶段）';
  }

  function handleStop() {
    // 防抖：1 秒内的重复 stop（面板连点/旧客户端轮询）直接忽略，避免无限 pause/resume 抖动
    const now = Date.now();
    if (now - lastStopAt < 1000) return '停止请求已处理（忽略了重复的停止命令）';
    lastStopAt = now;
    let stopped = 0;
    try {
      for (const job of engine.jobs.values()) {
        if (job.state === 'running' || job.state === 'starting' || job.state === 'need_captcha') {
          engine.stop(job.id);
          stopped += 1;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      // 硬停止：终止当前任务 + 清空队列/结果，之后不会自动恢复（需用户再点「开始」）
      if (autopilot && typeof autopilot.abort === 'function') autopilot.abort('command');
      else if (autopilot) autopilot.stop('command');
    } catch {
      /* ignore */
    }
    return `已停止（任务 ${stopped} 个）：所有任务终止、队列已清空，不会自动恢复；点「开始」重新扫描`;
  }

  async function handler(invocation) {
    const raw = String((invocation && invocation.rawInput) || '').trim();
    const [verb, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ');
    // 审计：记录每次命令（便于排查面板/命令来源），不打印大对象
    try {
      if (String(verb || 'status').toLowerCase() !== 'progress') {
        const inv = invocation || {};
        const agent = inv.agent || {};
        log({
          ev: 'cmd',
          verb: String(verb || 'status'),
          arg: truncate(arg, 80),
          cmdId: truncate(String(inv.commandId || ''), 40),
          agent: truncate(String(agent.id || agent.name || ''), 40),
          session: truncate(String(inv.sessionId || ''), 40),
        });
      }
    } catch {
      /* ignore */
    }
    try {
      switch ((verb || 'status').toLowerCase()) {
        case 'status':
          return { kind: 'success', text: await statusText() };
        case 'progress':
          return { kind: 'success', text: progressText() };
        case 'login': {
          const text = await handleLogin();
          return { kind: 'success', text };
        }
        case 'check': {
          const info = await loggedInHint();
          if (!info || info.error) throw new Error(info && info.error ? info.error : '无法检测登录状态');
          return { kind: 'success', text: info.loggedIn ? `已登录${info.nick ? `：${info.nick}` : ''}` : `未登录：${info.href || ''}` };
        }
        case 'scan':
          return { kind: 'success', text: await handleScan(arg) };
        case 'run':
          return { kind: 'success', text: await handleRun(arg) };
        case 'works':
          return { kind: 'success', text: await handleRun(arg, { worksOnly: true }) };
        case 'auto':
        case 'continue':
          return { kind: 'success', text: await handleAuto() };
        case 'stop':
          return { kind: 'success', text: handleStop() };
        case 'courses': {
          const rows = scanList();
          if (!rows.length) return { kind: 'success', text: '还没有扫描记录' };
          return { kind: 'success', text: rows.map((row) => `${row.courseid}  ${row.title}  剩 ${row.pendingPoints ?? '?'}/${row.pendingCount ?? '?'}`).join('\n') };
        }
        default:
          return {
            kind: 'error',
            text: '用法：/chaoxing status | progress | login | check | courses | scan <course> | run <course> | works <course> | auto | stop',
          };
      }
    } catch (e) {
      return { kind: 'error', text: shortErr(e) };
    }
  }

  const commands = ctx.get && ctx.get('commands');
  if (!commands || typeof commands.register !== 'function') {
    return () => {};
  }
  disposers.push(
    commands.register({
      name: COMMAND_NAME,
      description: '学习通助手：查看状态、登录检测、扫描课程、刷课、做作业、全自动托管',
      input: { hint: 'status | progress | login | check | courses | scan <course> | run <course> | works <course> | auto | stop' },
      handler,
    }),
  );

  // 让工具也能返回同一份“多行进度”文本（chaoxing_auto action=progress）
  try {
    deps.progressText = progressText;
  } catch {
    /* ignore */
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}

export { COMMAND_NAME };
