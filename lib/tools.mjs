// 四个宿主工具：账号管理、任务扫描、自动刷课、测验/作业。
// 设计原则：工具只做“本地浏览器操作 + 返回结构化事实”，不替用户猜答案；
// 提交计分测验/作业必须显式 confirm:true。
import { accountGet, accountList, DEFAULT_ACCOUNT } from './browser.mjs';
import { LOGIN_URL, probeLogin, waitLogin, discoverCourses } from './chaoxing.mjs';
import { makeCtx } from './engine.mjs';
import { parseCourseParams, truncate, nowISO } from './util.mjs';
import { fetchQuiz, fillQuiz, submitQuiz, normalizePlan, quizAnswerKey } from './quiz.mjs';
import { listWorks, openWork, fetchWork, fillWork, submitWork } from './work.mjs';
import { paths } from './paths.mjs';

const ACCOUNT_ACTIONS = ['list', 'add', 'start', 'login', 'wait_login', 'courses', 'stop', 'remove'];
const TASK_ACTIONS = ['scan', 'list', 'status', 'stop'];
const EXAM_ACTIONS = ['quiz_fetch', 'quiz_submit', 'work_list', 'work_fetch', 'work_submit', 'captcha'];
const AUTO_ACTIONS = ['start', 'stop', 'status', 'progress', 'llm'];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string' },
    result: { type: 'object', additionalProperties: true },
  },
  required: ['tool', 'result'],
};

function renderResult(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value.result ?? value, null, 2) }];
}

/** DSH 要求工具返回值是“无损 JSON”：去掉 undefined、NaN/Infinity→null、Date→ISO、断循环引用 */
// 快路径：JSON.stringify/parse 的语义与逐字段清洗完全一致（undefined 丢弃、数组里变 null、
// NaN→null、Date→ISO），大对象交给 V8 的原生实现比递归 JS 快一个量级；只有 BigInt/循环引用
// 会抛错，此时退回逐字段慢路径。
function lossless(value) {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? undefined : JSON.parse(s);
  } catch {
    return losslessSlow(value);
  }
}

function losslessSlow(value, seen = new WeakSet()) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'bigint') return String(value);
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined;
  if (Array.isArray(value)) {
    return value.map((v) => {
      const r = losslessSlow(v, seen);
      return r === undefined ? null : r;
    });
  }
  if (t === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (seen.has(value)) return null;
    seen.add(value);
    const out = {};
    for (const k of Object.keys(value)) {
      if (k === '__proto__') continue;
      const r = losslessSlow(value[k], seen);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return undefined;
}

/** 默认账号：优先用插件配置里的 autoAccount，避免面板/命令误走 default 另开一个浏览器 */
function autoAccountOf(deps) {
  const cfg = (deps && deps.config) || {};
  const auto = cfg.auto && typeof cfg.auto === 'object' ? cfg.auto : {};
  return String(cfg.autoAccount || auto.account || '');
}

function accountOf(deps, args, { create = false } = {}) {
  const name = String(args.account || autoAccountOf(deps) || DEFAULT_ACCOUNT);
  return accountGet(deps.store, name, { create, port: args.port, profileDir: args.profileDir });
}

/** course 参数：对象 / 课程 URL / "courseid:clazzid:cpi:enc"；缺 clazzid 时回查 courses 缓存 */
function courseOf(deps, args) {
  const accName = String(args.account || autoAccountOf(deps) || DEFAULT_ACCOUNT);
  let c = {};
  const raw = args.course;
  if (raw && typeof raw === 'object') c = { ...raw };
  else if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    const looksLikeCode = /^\d+$/.test(s) || /^\d+(:\d+){1,3}$/.test(s) || /[?=&]/.test(s);
    if (!looksLikeCode) {
      // 允许直接输入课程名：从已保存的课程列表里按标题匹配
      const hit = findCourseByTitle(deps, accName, s);
      c = { courseid: hit.courseid, clazzid: hit.clazzid, cpi: hit.cpi, enc: hit.enc, title: hit.title };
    } else if (/[?=&]/.test(s)) c = parseCourseParams(s);
    else {
      const p = s.split(/[|,;:]+/).map((x) => x.trim()).filter(Boolean);
      c = { courseid: p[0], clazzid: p[1], cpi: p[2], enc: p[3] };
    }
  }
  for (const k of ['courseid', 'clazzid', 'cpi', 'enc']) {
    const v = args[k];
    if (v !== undefined && v !== null && String(v) !== '') c[k] = String(v);
  }
  const norm = {
    courseid: String(c.courseid || c.courseId || ''),
    clazzid: String(c.clazzid || c.classId || ''),
    cpi: String(c.cpi || ''),
    enc: String(c.enc || '').toLowerCase(),
  };
  if (c.title && !args.title) norm.title = String(c.title);
  if (!norm.courseid) throw new Error('缺少 courseid：course 可以是课程名、对象、课程 URL 或 "courseid:clazzid:cpi:enc"');
  if (!norm.clazzid) {
    const saved = deps.store.get('courses', {})[`${accName}:${norm.courseid}`];
    if (saved && saved.clazzid) {
      norm.clazzid = String(saved.clazzid);
      if (!norm.cpi && saved.cpi) norm.cpi = String(saved.cpi);
      if (!norm.enc && saved.enc) norm.enc = String(saved.enc);
      if (!norm.title && saved.title) norm.title = String(saved.title);
    }
  }
  if (!norm.clazzid) throw new Error('缺少 clazzid：先用 chaoxing_account 的 courses 动作列出课程，或直接传课程名/课程 URL');
  return norm;

  function findCourseByTitle(d, acc, text) {
    const norm = (x) => String(x || '').toLowerCase().replace(/[\s\u3000·\-—_()（）【】\[\]《》]/g, '');
    const target = norm(text);
    const saved = Object.entries(d.store.get('courses', {}) || {})
      .filter(([key, v]) => v && v.courseid && key.startsWith(`${acc}:`))
      .map(([, v]) => v);
    if (!saved.length) {
      throw new Error(`还没有课程列表（账号 ${acc}）：先用 chaoxing_account 的 courses 动作拉一次，再按课程名指定`);
    }
    const exact = saved.filter((v) => norm(v.title) === target);
    const loose = saved.filter((v) => {
      const t = norm(v.title);
      return t && (t.includes(target) || target.includes(t));
    });
    const list = exact.length ? exact : loose;
    const uniq = [...new Map(list.map((v) => [String(v.courseid), v])).values()];
    if (uniq.length === 1) return uniq[0];
    if (uniq.length > 1) {
      throw new Error(
        `课程名「${text}」匹配到多门课：${uniq.slice(0, 6).map((v) => `${v.title}（${v.courseid}）`).join('、')}，请写得更具体或用 courseid`
      );
    }
    const sample = saved.slice(0, 10).map((v) => v.title).filter(Boolean).join('、');
    throw new Error(`找不到课程「${text}」。可选：${sample}${saved.length > 10 ? '…' : ''}`);
  }
}

function collectLog(exec, sink, limit = 200) {
  return (o) => {
    sink.push(o);
    if (sink.length > limit) sink.splice(0, sink.length - limit);
    exec?.signal?.throwIfAborted?.();
  };
}

function examCtx(deps, exec, sink) {
  const ctx = makeCtx({ store: deps.store, python: deps.python });
  ctx.log = collectLog(exec, sink);
  return ctx;
}

function saveCourse(deps, accountName, course) {
  if (!course || !course.courseid) return;
  const all = deps.store.get('courses', {});
  all[`${accountName}:${course.courseid}`] = { ...course, at: nowISO() };
  deps.store.set('courses', all);
}

function needList(attachments) {
  return (attachments || [])
    .filter((a) => !a.passed)
    .map((a) => {
      if (a.type === 'video') return { idx: a.idx, type: 'video', durationSec: a.duration || 0 };
      if (a.type === 'document') return { idx: a.idx, type: 'document' };
      if (a.type === 'workid') return { idx: a.idx, type: 'quiz', jobid: a.jobid || '' };
      return { idx: a.idx, type: a.type || 'unknown' };
    });
}

export function createToolDefinitions(deps) {
  const { store, hub, engine, python } = deps;

  const accountTool = {
    name: 'chaoxing_account',
    description:
      '管理超星学习通账号与真实 Edge 浏览器（通过 CDP 调试端口驱动，不碰用户其他窗口）。动作：list=查看已登记账号与浏览器状态；add=登记账号（可指定 port/profileDir，复用已有 Edge 用户目录可保留登录态）；start=启动浏览器；login=打开学习通登录页，需要用户在 Edge 窗口扫码或输密码；wait_login=轮询等待登录完成；courses=列出账号下的课程及 courseid/clazzid/cpi/enc；stop=关闭本插件启动的浏览器。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACCOUNT_ACTIONS, description: '要执行的动作' },
        account: { type: 'string', description: '账号别名，默认 default' },
        port: { type: 'integer', description: 'Edge 远程调试端口，默认 9422' },
        profileDir: { type: 'string', description: 'Edge 用户数据目录；指向已有目录可复用登录态' },
        edgePath: { type: 'string', description: 'msedge.exe 完整路径，默认自动查找' },
        startUrl: { type: 'string', description: '启动后打开的网址，默认学习通主页' },
        timeoutSec: { type: 'integer', description: 'wait_login 最多等多少秒，默认 180' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 240000,
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(args, exec = {}) {
      const action = String(args.action || '');
      const sink = [];
      const log = collectLog(exec, sink);
      let result;
      try {
        if (action === 'list') {
          const accounts = accountList(store);
          const list = [];
          for (const a of accounts) {
            list.push(await hub.status(a).catch((e) => ({ account: a.name, error: String((e && e.message) || e) })));
          }
          result = { ok: true, dataDir: paths().base, accounts: list, hint: '第一次用：先 add 登记账号（可直接用已有 Edge 目录），再 start/login' };
        } else if (action === 'add') {
          const account = accountOf({ store }, args, { create: true });
          result = { ok: true, account, hint: 'action=start 启动浏览器；action=login 打开登录页' };
        } else if (action === 'start') {
          const account = accountOf({ store }, args, { create: true });
          await hub.ensureBrowser(account, { edgePath: args.edgePath, startUrl: args.startUrl || 'https://i.chaoxing.com/base' });
          const st = await hub.status(account);
          result = { ok: true, ...st, hint: '如果还没登录，用 action=login 打开登录页扫码' };
        } else if (action === 'login') {
          const account = accountOf({ store }, args, { create: true });
          const { page } = await hub.ensurePage(account, { edgePath: args.edgePath });
          await page.goto(LOGIN_URL, { waitMs: 6000 });
          const probe = await probeLogin(page);
          result = {
            ok: true,
            account: account.name,
            loggedIn: probe.loggedIn,
            nick: probe.nick,
            hint: probe.loggedIn ? '看起来已经登录了' : '请在弹出的 Edge 窗口扫码或输入账号密码，完成后用 action=wait_login 确认',
          };
        } else if (action === 'wait_login') {
          const account = accountOf({ store }, args, {});
          const { page } = await hub.ensurePage(account, { edgePath: args.edgePath });
          const timeoutSec = Math.max(20, Math.min(300, Number(args.timeoutSec) || 180));
          const r = await waitLogin(page, { timeoutMs: timeoutSec * 1000, log });
          result = {
            ok: r.ok,
            ...r,
            hint: r.ok ? '登录完成，可以 list 课程了' : '还没检测到登录：确认已在 Edge 窗口完成扫码，再调一次',
          };
        } else if (action === 'courses') {
          const account = accountOf({ store }, args, { create: true });
          const { page } = await hub.ensurePage(account, { edgePath: args.edgePath });
          const ctx = makeCtx({ store, python });
          ctx.log = log;
          const r = await discoverCourses(page, ctx);
          const courses = (r.courses || []).map((c) => ({
            courseid: String(c.courseid || ''),
            clazzid: String(c.clazzid || ''),
            title: c.title || '',
            cpi: c.cpi || '',
            enc: c.enc || '',
            source: c.source || '',
          }));
          for (const c of courses) saveCourse({ store }, account.name, c);
          result = {
            ok: courses.length > 0,
            account: account.name,
            count: courses.length,
            courses,
            pagesTried: r.pagesTried || [],
            login: r.login || null,
            hint: courses.length ? '课程参数已缓存；可用 chaoxing_tasks 的 scan 动作扫描课程' : '没有读到课程：可能未登录（先 login/wait_login）或该账号没有在学课程',
          };
        } else if (action === 'stop') {
          const account = accountOf({ store }, args, {});
          const r = await hub.stop(account, { kill: true });
          result = { ok: true, ...r, hint: '已关闭本插件启动的浏览器；登录态保存在 profile 目录里' };
        } else if (action === 'remove') {
          const name = String(args.account || '');
          if (!name) throw new Error('remove 需要 account');
          const accounts = store.get('accounts', {}) || {};
          if (!accounts[name]) throw new Error(`账号 ${name} 不存在`);
          try {
            await hub.stop(accounts[name], { kill: true });
          } catch {
            /* 浏览器本来就没开 */
          }
          delete accounts[name];
          store.set('accounts', accounts);
          store.flush();
          result = { ok: true, account: name, removed: true, remaining: Object.keys(accounts) };
        } else {
          throw new Error(`未知 action "${action}"，可用：${ACCOUNT_ACTIONS.join(', ')}`);
        }
      } catch (e) {
        result = { ok: false, error: truncate(e && e.message, 500), log: sink.slice(-8) };
      }
      return { tool: 'chaoxing_account', result };
    },
  };

  const tasksTool = {
    name: 'chaoxing_tasks',
    description:
      '查看学习通课程的任务点情况。scan=后台扫描课程（读目录 + 每个待完成节点的视频/文档/测验清单，不产生任何计点行为，结果落盘）；list=列出已有扫描记录与后台任务；status=查看某任务进度/最近节点/停止原因（扫描完成时附带待完成节点清单）；stop=停止后台任务。扫描和刷课都是幂等的，可随时重跑。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: TASK_ACTIONS, description: '要执行的动作' },
        account: { type: 'string', description: '账号别名，默认 default' },
        course: { type: 'string', description: '课程：课程名（如 电工电子技术）、对象、课程 URL 或 "courseid:clazzid:cpi:enc"' },
        courseid: { type: 'string', description: '课程 id（也可作为 course 的补充）' },
        clazzid: { type: 'string', description: '班级 id' },
        limit: { type: 'integer', description: 'scan 时最多检查多少个待完成节点，0=全部（默认 0，节点多时较慢）' },
        concurrency: { type: 'integer', description: 'scan 并发窗口数，1-3，默认 2' },
        jobId: { type: 'string', description: 'status/stop 的任务 id' },
        logLines: { type: 'integer', description: 'status 返回多少行日志，默认 0（省 token；调试时再传 20）' },
        detail: { type: 'boolean', description: 'status 是否附带扫描出的节点明细，默认 false' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(args, exec = {}) {
      const action = String(args.action || 'scan');
      let result;
      try {
        if (action === 'scan') {
          const account = accountOf({ store }, args, { create: false });
          const course = courseOf({ store }, args);
          const job = engine.startScan({
            account: account.name,
            course,
            limit: Math.max(0, Number(args.limit) || 0),
            concurrency: Math.max(1, Math.min(3, Number(args.concurrency) || 2)),
          });
          saveCourse({ store }, account.name, course);
          const snap = engine.snapshot(job, { logLines: 0, results: false });
          result = {
            ok: true,
            jobId: job.id,
            state: snap.state,
            course,
            hint: '扫描在后台进行（复用同一个浏览器窗口的标签页，不会弹新窗口）。用 action=status 传这个 jobId 看进度；完成后可用 detail 拿到每个节点要做什么',
          };
        } else if (action === 'list') {
          const scans = Object.entries(store.get('scans', {})).map(([key, v]) => ({
            key,
            at: v.at,
            account: v.account,
            courseid: v.course && v.course.courseid,
            title: (v.course && v.course.title) || '',
            totalPoints: v.totalPoints,
            pendingCount: v.pendingCount,
            nodeCount: v.nodeCount,
            scannedCount: v.scannedCount,
            truncated: !!v.truncated,
          }));
          result = { ok: true, scans, jobs: engine.list() };
        } else if (action === 'status') {
          const id = String(args.jobId || '');
          const job = id ? engine.get(id) : engine.latest();
          if (!job) {
            result = { ok: true, jobs: engine.list(), hint: '还没有后台任务：先 action=scan 或 chaoxing_run' };
          } else {
            const snap = engine.snapshot(job, { logLines: Math.max(0, Number(args.logLines) || 0), results: true });
            const out = { ok: true, jobId: snap.id, ...snap };
            if (snap.kind === 'scan' && snap.state === 'done' && args.detail === true) {
              const scan = store.get('scans', {})[`${job.account}:${snap.course.courseid}`];
              if (scan) {
                out.scan = {
                  totalPoints: scan.totalPoints,
                  pendingCount: scan.pendingCount,
                  nodeCount: scan.nodeCount,
                  scannedCount: scan.scannedCount,
                  truncated: !!scan.truncated,
                  nodes: (scan.nodes || []).slice(0, 60).map((n) => ({
                    kid: n.kid,
                    name: truncate(n.name, 40),
                    points: n.points,
                    need: needList(n.attachments),
                    scanError: n.scanError || '',
                  })),
                };
              }
            }
            result = out;
          }
        } else if (action === 'stop') {
          const r = engine.stop(String(args.jobId || ''));
          // 点停止即清临时数据（任务收尾时的最后一行日志由 cleaner 10s/45s 后补刀）
          let cleaned = null;
          try {
            const c = deps.cleanup;
            if (c && typeof c.afterStop === 'function') cleaned = c.afterStop('tasks-stop');
          } catch {
            /* ignore */
          }
          const cleanNote = cleaned && cleaned.deleted ? `；已清理 ${cleaned.deleted} 个临时文件` : '';
          result = {
            ...r,
            ...(cleaned ? { tempCleaned: cleaned.deleted || 0, tempBytes: cleaned.bytes || 0 } : {}),
            hint: r.ok
              ? `已请求停止；当前正在处理的任务会做完当前这一步后退出${cleanNote}`
              : `没找到该任务${cleaned && cleaned.deleted ? cleanNote : ''}`,
          };
        } else {
          throw new Error(`未知 action "${action}"，可用：${TASK_ACTIONS.join(', ')}`);
        }
      } catch (e) {
        result = { ok: false, error: truncate(e && e.message, 500) };
      }
      return { tool: 'chaoxing_tasks', result };
    },
  };

  const runTool = {
    name: 'chaoxing_run',
    description:
      '启动后台自动刷课任务：按课程目录逐个节点，用真实鼠标点击播放视频（1x 播完才算完成）、滚轮把文档翻到底，已完成的自动跳过；遇到 9010 验证码会自动 OCR，失败会转人工并在任务状态里给出图片路径。默认 quizPolicy=skip 完全不碰章节测验；只有你之前用 chaoxing_exam 抓题并缓存过答案的测验，在 quizPolicy=cached 时才会回填提交。返回任务快照，用 chaoxing_tasks 的 status 查看进度。只能在用户自己的账号上使用。',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: '账号别名，默认 default' },
        course: { type: 'string', description: '课程：课程名（如 电工电子技术）、对象、课程 URL 或 "courseid:clazzid:cpi:enc"' },
        courseid: { type: 'string', description: '课程 id' },
        clazzid: { type: 'string', description: '班级 id' },
        kinds: { type: 'array', items: { type: 'string', enum: ['video', 'document'] }, description: '要刷的任务类型，默认视频+文档' },
        concurrency: { type: 'integer', description: '并发窗口数 1-4，默认 2（越小越稳，>=5 容易触发 9010）' },
        maxMinutes: { type: 'integer', description: '最长运行分钟数，默认 120' },
        only: { type: 'array', items: { type: 'string' }, description: '只处理这些 knowledgeid（调试用）' },
        quizPolicy: { type: 'string', enum: ['skip', 'cached', 'auto'], description: 'skip=不碰测验（默认）；cached=只提交已缓存答案的测验；auto=让宿主模型作答（低置信度不提交）' },
        solveWorks: { type: 'boolean', description: '是否在刷完课后让模型做作业，默认 false' },
        minConfidence: { type: 'number', description: '模型作答置信度门限 0-1，默认 0.75' },
        autoSubmit: { type: 'boolean', description: '模型作答后是否真的提交，默认 true' },
        dryRun: { type: 'boolean', description: '演练：抓题+模型作答但不填不交，默认 false' },
        workLimit: { type: 'integer', description: '最多做几份作业（0=全部），调试用' },
        maxBlanks: { type: 'integer', description: '允许提交的空白题数上限，默认 0（只要有空题就不提交，改存草稿，避免低分卷）' },
        startUrl: { type: 'string', description: '启动后先打开的网址，默认学习通主页' },
      },
      required: ['course'],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(_args, _exec = {}) {
      const args = _args || {};
      let result;
      try {
        const account = accountOf({ store }, args, { create: true });
        const course = courseOf({ store }, args);
        const kinds = Array.isArray(args.kinds) ? args.kinds.filter((k) => k === 'video' || k === 'document') : ['video', 'document'];
        const quizPolicy = args.quizPolicy === 'auto' ? 'auto' : args.quizPolicy === 'cached' ? 'cached' : 'skip';
        const job = engine.start({
          account,
          course,
          kinds,
          concurrency: Math.max(1, Math.min(4, Number(args.concurrency) || 2)),
          maxMinutes: Math.max(1, Math.min(1440, Number(args.maxMinutes) || 120)),
          only: Array.isArray(args.only) ? args.only.map(String) : [],
          quizPolicy,
          solveWorks: !!args.solveWorks,
          minConfidence: Number(args.minConfidence) || 0.75,
          autoSubmit: args.autoSubmit !== false,
          dryRun: !!args.dryRun,
          workLimit: Math.max(0, Number(args.workLimit) || 0),
          maxBlanks: Math.max(0, Number(args.maxBlanks) || 0),
          startUrl: args.startUrl,
        });
        if (job && job.already) {
          // 同账号互斥：已有任务在跑，不要把 {ok:false,already:true} 当 job 用
          result = {
            ok: false,
            already: true,
            jobId: job.id ? String(job.id) : '',
            text: job.text || '同一账号已有任务在跑：先停止或等它结束',
            hint: '用 chaoxing_tasks 的 status 看正在跑的任务，或先 stop 再重试',
          };
        } else {
          saveCourse({ store }, account.name, course);
          const snap = engine.snapshot(job, { logLines: 0, results: false });
          result = {
            ok: true,
            jobId: snap.id,
            kind: snap.kind,
            state: snap.state,
            account: account.name,
            course,
            kinds,
            quizPolicy,
            solveWorks: !!args.solveWorks,
            dryRun: !!args.dryRun,
            concurrency: snap.concurrency,
            hint: '任务在后台运行，别关 Edge 窗口。用 chaoxing_tasks 的 status 看进度（30 秒左右看一次即可），stop 可停止',
          };
        }
      } catch (e) {
        result = { ok: false, error: truncate(e && e.message, 500) };
      }
      return { tool: 'chaoxing_run', result };
    },
  };

  const examTool = {
    name: 'chaoxing_exam',
    description:
      '章节测验与作业（只操作本地浏览器）：quiz_fetch=打开某个知识点的测验页并抓题（自动解码学习通的反爬字体，返回题干/选项/填空数量）；quiz_submit=把你作答的计划回填并提交（必须 confirm:true，可 save 缓存答案供 chaoxing_run 的 quizPolicy=cached 使用）；work_list=列出一门课的作业；work_fetch=打开作业并抓题（含图片题干提示）；work_submit=回填并提交作业（必须 confirm:true）；captcha=把人工识别的验证码交给卡住的后台任务。抓题不会提交任何东西；不要用猜测的答案提交计分测验或作业。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: EXAM_ACTIONS, description: '要执行的动作' },
        account: { type: 'string', description: '账号别名，默认 default' },
        course: { type: 'string', description: '课程：课程名（如 电工电子技术）、对象、课程 URL 或 "courseid:clazzid:cpi:enc"' },
        courseid: { type: 'string', description: '课程 id' },
        clazzid: { type: 'string', description: '班级 id' },
        kid: { type: 'string', description: '知识点 id（scan 结果里的 kid）' },
        num: { type: 'integer', description: '卡片序号，默认 0' },
        answers: {
          type: 'array',
          description: '作答计划：[{i:题目下标, letters:["A"], texts:["选项文字前12字"]}] 或填空 {i, text:"答案"}',
          items: {
            type: 'object',
            properties: {
              i: { type: 'integer' },
              letters: { type: 'array', items: { type: 'string' } },
              texts: { type: 'array', items: { type: 'string' } },
              text: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
        confirm: { type: 'boolean', description: '提交类动作必须显式传 true' },
        save: { type: 'boolean', description: 'quiz_submit 成功后是否缓存答案，默认 true' },
        workUrl: { type: 'string', description: '作业地址；不给则按 workIndex 从作业列表里取' },
        workIndex: { type: 'integer', description: '作业列表里的下标，默认 0' },
        jobId: { type: 'string', description: 'captcha 动作要提交到的后台任务 id' },
        code: { type: 'string', description: 'captcha 动作的人工验证码' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 300000,
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(args, exec = {}) {
      const action = String(args.action || '');
      const sink = [];
      let result;
      try {
        if (action === 'captcha') {
          const jobId = String(args.jobId || '');
          if (!jobId) throw new Error('captcha 动作需要 jobId（chaoxing_tasks 的 status 返回的 id）');
          result = await engine.submitCaptchaCode(jobId, String(args.code || ''));
          return { tool: 'chaoxing_exam', result };
        }

        const account = accountOf({ store }, args, { create: false });
        const course = courseOf({ store }, args);
        const ctx = examCtx({ store, python }, exec, sink);

        if (action === 'quiz_fetch') {
          const kid = String(args.kid || '');
          if (!kid) throw new Error('quiz_fetch 需要 kid（知识点 id，可从 chaoxing_tasks 的 scan 结果里取）');
          const num = Math.max(0, Number(args.num) || 0);
          const { page } = await hub.openTaskPage(account);
          try {
            const q = await fetchQuiz(page, course, kid, num, ctx);
            if (!q.ok) {
              result = { ok: false, reason: q.reason || 'fetch-failed', imagePath: q.imagePath, log: sink.slice(-8) };
            } else {
              result = {
                ok: true,
                course,
                kid,
                num,
                alreadySubmitted: q.alreadySubmitted,
                fontFound: q.fontFound,
                mapped: q.mapped,
                md5: q.md5,
                items: q.items,
                hint: '把每题的答案整理成 [{i, letters:["A"], texts:["选项文字前12字"]}]（多选就多个字母），再调 quiz_submit 并传 confirm:true',
              };
            }
          } finally {
            await page.close().catch(() => {});
          }
        } else if (action === 'quiz_submit') {
          if (args.confirm !== true) {
            result = { ok: false, error: '提交计分测验不可撤销：确认要提交后再传 confirm:true' };
          } else {
            const kid = String(args.kid || '');
            if (!kid) throw new Error('quiz_submit 需要 kid');
            const num = Math.max(0, Number(args.num) || 0);
            const answers = Array.isArray(args.answers) ? args.answers : [];
            if (!answers.length) throw new Error('quiz_submit 需要 answers（先 quiz_fetch 抓题再作答）');
            const { page } = await hub.openTaskPage(account);
            try {
              const q = await fetchQuiz(page, course, kid, num, ctx);
              if (!q.ok) {
                result = { ok: false, reason: q.reason || 'fetch-failed', imagePath: q.imagePath, log: sink.slice(-8) };
              } else if (q.alreadySubmitted) {
                result = { ok: true, alreadySubmitted: true, hint: '这套测验已经提交/判分过了，没有重复提交' };
              } else {
                const plan = normalizePlan(answers);
                const fill = await fillQuiz(page, plan, ctx);
                const sub = await submitQuiz(page, ctx);
                let saved = false;
                if (sub.ok && args.save !== false) {
                  const all = store.get('answers', {});
                  all[quizAnswerKey(course, kid, num)] = { at: nowISO(), answers, count: plan.length };
                  store.set('answers', all);
                  saved = true;
                }
                result = { ok: !!sub.ok, fill, submit: sub, saved, log: sink.slice(-10) };
              }
            } finally {
              await page.close().catch(() => {});
            }
          }
        } else if (action === 'work_list') {
          const { page } = await hub.openTaskPage(account);
          try {
            const r = await listWorks(page, course, ctx);
            result = {
              ok: !!r.ok,
              items: r.items || [],
              href: r.href || '',
              sample: r.sample || '',
              hint: r.ok && (r.items || []).length ? '用 work_fetch（传 workIndex 或 workUrl）抓题' : '没有读到作业列表：可能没有作业、已截止或页面结构变了',
            };
          } finally {
            await page.close().catch(() => {});
          }
        } else if (action === 'work_fetch') {
          const { page } = await hub.openTaskPage(account);
          try {
            const url = await resolveWorkUrl(page, course, args, ctx);
            await openWork(page, { url, ctx });
            const f = await fetchWork(page, ctx);
            if (!f.ok) {
              result = { ok: false, reason: f.reason || 'fetch-failed', sample: f.sample || '', log: sink.slice(-8) };
            } else {
              result = {
                ok: true,
                url,
                items: f.items,
                md5: f.md5,
                mapped: f.mapped,
                hint: '作答后调 work_submit（传 workUrl/workIndex + answers + confirm:true）；图片题干需要人看',
              };
            }
          } finally {
            await page.close().catch(() => {});
          }
        } else if (action === 'work_submit') {
          if (args.confirm !== true) {
            result = { ok: false, error: '提交作业不可撤销：确认要提交后再传 confirm:true' };
          } else {
            const answers = Array.isArray(args.answers) ? args.answers : [];
            if (!answers.length) throw new Error('work_submit 需要 answers（先 work_fetch 抓题再作答）');
            const { page } = await hub.openTaskPage(account);
            try {
              const url = await resolveWorkUrl(page, course, args, ctx);
              await openWork(page, { url, ctx });
              const f = await fetchWork(page, ctx);
              if (!f.ok) {
                result = { ok: false, reason: f.reason || 'fetch-failed', sample: f.sample || '', log: sink.slice(-8) };
              } else {
                const plan = normalizePlan(answers);
                const fill = await fillWork(page, plan, ctx);
                const sub = await submitWork(page, ctx);
                if (sub.ok) {
                  const all = store.get('works', {});
                  all[`${course.courseid}:${url}`] = { at: nowISO(), url, answers, count: plan.length };
                  store.set('works', all);
                }
                result = { ok: !!sub.ok, url, fill, submit: sub, log: sink.slice(-10) };
              }
            } finally {
              await page.close().catch(() => {});
            }
          }
        } else {
          throw new Error(`未知 action "${action}"，可用：${EXAM_ACTIONS.join(', ')}`);
        }
      } catch (e) {
        result = { ok: false, error: truncate(e && e.message, 500), log: sink.slice(-8) };
      }
      return { tool: 'chaoxing_exam', result };
    },
  };

  const autoTool = {
    name: 'chaoxing_auto',
    description:
      '全自动托管（需要手动开始）：插件启用时不会自动运行，必须执行 start（或面板点「开始」）才开始。启动时会打开学习通登录页，你用 Edge 窗口扫码/登录；检测到已登录后自动列出所有还有未完成任务的课程，逐门扫描章节+作业，然后自动刷视频/文档、让宿主模型作答章节测验和作业。可用 minConfidence 控制“没把握就不交”，dryRun 只作答不提交，courses 指定课程，worksOnly 只做作业。用 status 看阶段与实时进度；stop=终止所有任务并清空队列，之后不会自动恢复。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: AUTO_ACTIONS, description: 'start=开始全自动（不会自动启动，需手动调用）；stop=终止所有任务并清空队列（不会自动恢复）；status=看阶段与统计；progress=看多行实时进度；llm=自检模型桥接是否可用' },
        account: { type: 'string', description: '账号别名，默认用配置里的 autoAccount' },
        courses: { type: 'array', items: { type: 'string' }, description: '只跑这些课（课程名、courseid 或 "courseid:clazzid:cpi"）；不传=自动发现所有还有未完成任务的课' },
        concurrency: { type: 'integer', description: '每门课的并发窗口 1-4，默认 2' },
        maxMinutes: { type: 'integer', description: '单门课最长运行分钟数，默认 600' },
        kinds: { type: 'array', items: { type: 'string', enum: ['video', 'document'] }, description: '刷哪些任务类型，默认视频+文档' },
        solveQuizzes: { type: 'boolean', description: '是否让模型自动做章节测验（默认 true）' },
        solveWorks: { type: 'boolean', description: '是否让模型自动做作业（默认 true）' },
        minConfidence: { type: 'number', description: '模型作答置信度门限 0-1，低于它的题不提交，默认 0.75' },
        autoSubmit: { type: 'boolean', description: '是否真的提交模型答案，默认 true' },
        dryRun: { type: 'boolean', description: '演练模式：抓题+模型作答但不填不交，默认 false' },
        worksOnly: { type: 'boolean', description: '只做作业不刷课，默认 false' },
        loginWaitMinutes: { type: 'integer', description: '等待扫码登录的分钟数，默认 30' },
        scanLimit: { type: 'integer', description: '每门课最多检查多少个待完成节点，0=全部' },
        logLines: { type: 'integer', description: 'status 返回的日志行数，默认 0（省 token）' },
        reason: { type: 'string', description: 'stop 的原因' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(rawArgs) {
      const args = rawArgs || {};
      const action = String(args.action || '');
      let result;
      try {
        if (action === 'progress') {
          const text =
            typeof deps.progressText === 'function'
              ? deps.progressText()
              : JSON.stringify(
                  (deps.autopilot && deps.autopilot.snapshot && deps.autopilot.snapshot({ logLines: 0 })) || {},
                  null,
                  1
                );
          result = { ok: true, text };
        } else if (action === 'llm') {
          const llm = deps.llm || null;
          if (!llm) {
            result = { ok: false, ready: false, error: '宿主没有暴露 llm 服务（ctx.get("llm") 为空），模型自动作答不可用；刷课/文档不受影响' };
          } else {
            const t0 = Date.now();
            const r = await llm.text({
              system: '你是连接自检助手，只输出要求的字符。',
              user: '只回复 OK 两个字母，不要多余内容。',
              maxTokens: 32,
              temperature: 0,
            });
            const text = r && typeof r === 'object' ? r.text : r;
            result = {
              ok: true,
              ready: !!llm.ready,
              route: (r && r.provider ? { provider: r.provider, model: r.model } : llm.route) || null,
              ms: Date.now() - t0,
              text: truncate(String(text || ''), 120),
              usage: (r && r.usage) || null,
            };
          }
        } else if (!deps.autopilot) {
          result = { ok: false, error: 'autopilot 模块没有加载（插件需要重装或 DSH 需要重启）' };
        } else if (action === 'start') {
          const phase0 = String((deps.autopilot && deps.autopilot.phase) || 'idle');
          const snap = (await deps.autopilot.start(
            {
              account: String(args.account || autoAccountOf(deps) || DEFAULT_ACCOUNT),
              courses: Array.isArray(args.courses) ? args.courses.map(String) : [],
              concurrency: Number(args.concurrency) || undefined,
              maxMinutes: Number(args.maxMinutes) || undefined,
              kinds: Array.isArray(args.kinds) && args.kinds.length ? args.kinds : undefined,
              solveQuizzes: args.solveQuizzes !== false,
              solveWorks: args.solveWorks !== false,
              minConfidence: args.minConfidence != null ? Number(args.minConfidence) : undefined,
              autoSubmit: args.autoSubmit !== false,
              dryRun: !!args.dryRun,
              worksOnly: !!args.worksOnly,
              loginWaitMinutes: Number(args.loginWaitMinutes) || undefined,
              scanLimit: args.scanLimit != null ? Number(args.scanLimit) : undefined,
              resume: true,
            },
            'tool',
          )) || {};
          result = {
            ok: true,
            ...snap,
            resumed: phase0 === 'stopped' || phase0 === 'done' || phase0 === 'error',
            hint: '全自动任务已在后台运行：如果 Edge 里出现学习通登录页，请在 30 分钟内扫码登录；之后它会自动扫描并开始刷课。用 chaoxing_auto 的 status 看进度；stop 会终止所有任务并清空队列（不会自动恢复）。',
          };
        } else if (action === 'stop') {
          const reason = String(args.reason || 'user-stop');
          // 1) 先停掉所有手动 chaoxing_run/scan 的后台 job（autopilot.abort 只管全自动队列）
          let stoppedJobs = 0;
          try {
            const jobs = (deps.engine && deps.engine.list && deps.engine.list()) || [];
            for (const j of jobs) {
              if (!j || !j.id) continue;
              if (j.state === 'running' || j.state === 'starting' || j.state === 'need_captcha') {
                try {
                  deps.engine.stop(j.id);
                  stoppedJobs++;
                } catch {
                  /* ignore */
                }
              }
            }
          } catch {
            /* ignore */
          }
          // 2) 再终止全自动并清空队列
          const snap = await (typeof deps.autopilot.abort === 'function'
            ? deps.autopilot.abort(reason)
            : deps.autopilot.stop(reason)) || {};
          // 3) 清掉本轮任务的临时数据（任务收尾时的最后一行日志由 cleaner 10s/45s 后补刀）
          let cleaned = null;
          try {
            const c = deps.cleanup;
            if (c && typeof c.afterStop === 'function') cleaned = c.afterStop('auto-stop');
          } catch {
            /* ignore */
          }
          const cleanNote = cleaned && cleaned.deleted ? `；已清理 ${cleaned.deleted} 个临时文件` : '';
          result = {
            ok: true,
            ...snap,
            stoppedJobs,
            ...(cleaned ? { tempCleaned: cleaned.deleted || 0, tempBytes: cleaned.bytes || 0 } : {}),
            hint: `已停止：${stoppedJobs ? `${stoppedJobs} 个手动任务 + ` : ''}全自动已终止、队列已清空，不会自动恢复${cleanNote}；需要再跑就重新执行 start（或面板点「开始」）。`,
          };
        } else if (action === 'status') {
          const snap = deps.autopilot.snapshot({ logLines: Math.max(0, Number(args.logLines) || 0) }) || {};
          result = { ok: true, ...snap };
        } else {
          throw new Error(`未知 action "${action}"，可用：${AUTO_ACTIONS.join(', ')}`);
        }
      } catch (e) {
        result = { ok: false, error: truncate(e && e.message, 500) };
      }
      return { tool: 'chaoxing_auto', result };
    },
  };

  async function resolveWorkUrl(page, course, args, ctx) {
    const direct = String(args.workUrl || '');
    if (direct) return direct;
    const r = await listWorks(page, course, ctx);
    const items = r.items || [];
    const idx = Math.max(0, Number(args.workIndex) || 0);
    const it = items[idx];
    if (!it || !it.url) throw new Error(`作业列表里没有第 ${idx} 项（读到 ${items.length} 项），先用 work_list 看看`);
    return it.url;
  }

  return [accountTool, tasksTool, runTool, examTool, autoTool].map((t) => ({
    ...t,
    async execute(args, exec = {}) {
      return lossless(await t.execute(args, exec));
    },
  }));
}
