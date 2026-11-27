// 自动刷课引擎：目录规划 → 逐节点开窗处理视频/文档/测验 → 进度与止损。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sleep, sleepUnless, nowClock, truncate, fmtDur, randInt, clamp, confThreshold, chaoxingUrl, safeAccountName, safeStartUrl } from './util.mjs';
import { paths, appendLog } from './paths.mjs';
import { readCatalog, readCardArgs, cardArgsOnPage, resolveCourse, pageIsCaptcha, solveCaptcha, cardsUrl, probeLogin, bringToFront } from './chaoxing.mjs';
import { waitFrames, playVideo, rollDoc, vidNeed } from './actions.mjs';
import {
  fetchQuiz,
  fetchQuizHere,
  setQuizRoot,
  quizFrameCount,
  fillQuiz,
  submitQuiz,
  quizAnswerKey,
  quizReeditHref,
  fetchQuizOnPage,
  fillQuizReedit,
  countQuizBlanks,
  saveQuizDraft,
} from './quiz.mjs';
import { solveQuiz, solveWork } from './solver.mjs';
import { listWorks, openWork, fetchWork, fillWork, submitWork, countBlanks, saveWorkDraft } from './work.mjs';
import { listTargets, closeTarget } from './cdp.mjs';
import { submitGate, shouldStopUnconfirmed } from './judge.mjs';
import { scanHumanVerification } from './guard.mjs';

export function makeCtx({ store, python, log = () => {} }) {
  return { store, python, log, fontMaps: new Map(), captchaTries: 8, captchaLog: [] };
}

function jobId() {
  return 'run_' + Date.now().toString(36) + '_' + crypto.randomBytes(2).toString('hex');
}

// 同一账号同时只允许跑一个任务（重复 start 会把两个任务压进同一个 Edge 窗口、互抢验证码）；
// 终态任务只留最近若干个，避免 list()/snapshot 随历史任务线性变慢。
const BUSY_STATES = new Set(['starting', 'running', 'need_captcha']);
const TERMINAL_JOB_STATES = new Set(['done', 'stopped', 'error']);
const KEEP_TERMINAL_JOBS = 20;

/** 账号名归一化：start() 存字符串，startScan() 存原始入参（可能是对象） */
function accountNameOf(account) {
  if (!account) return '';
  if (typeof account === 'string') return account;
  return String(account.name || '');
}

function summarize(atts) {
  return atts
    .map((a) => `${a.idx}:${a.type}${a.passed ? '(已完成)' : ''}`)
    .join(' ');
}

export class Engine {
  constructor({ hub, store, python, llm = null }) {
    this.hub = hub;
    this.store = store;
    this.python = python;
    // llm: LlmClient（宿主模型桥接）；没有模型时 quizPolicy=auto / solveWorks 会自动降级为跳过
    this.llm = llm || null;
    this.jobs = new Map();
    this.seq = 0;
  }

  /** 同账号正在跑（含等验证码）的任务：没有则 null */
  _busyJobFor(accountName) {
    const name = String(accountName || '');
    for (const job of this.jobs.values()) {
      if (BUSY_STATES.has(job.state) && accountNameOf(job.account) === name) return job;
    }
    return null;
  }

  /**
   * 淘汰历史终态任务：只保留最近 20 个。
   * 正在跑的任务绝不删除；删 job 时顺手清日志文件，失败忽略（文件可能不存在/被占用）。
   */
  evictTerminalJobs(keep = KEEP_TERMINAL_JOBS) {
    try {
      const terminal = [];
      for (const job of this.jobs.values()) {
        if (TERMINAL_JOB_STATES.has(job.state)) terminal.push(job);
      }
      if (terminal.length <= keep) return;
      terminal.sort((a, b) => (Number(b.endedAt) || Number(b.startedAt) || 0) - (Number(a.endedAt) || Number(a.startedAt) || 0));
      for (const job of terminal.slice(keep)) {
        this.jobs.delete(job.id);
        try {
          if (job.logPath) fs.unlinkSync(job.logPath);
        } catch {
          /* 日志文件可能不存在：忽略 */
        }
      }
    } catch {
      /* 清理逻辑绝不能影响任务本身 */
    }
  }

  ctxFor(job) {
    const ctx = makeCtx({ store: this.store, python: this.python });
    ctx.log = (obj) => this.logLine(job, obj);
    ctx.onCaptchaText = (text, file) => {
      this.logLine(job, { ev: 'captcha-ocr', text, file: path.basename(file || '') });
    };
    return ctx;
  }

  logLine(job, obj) {
    const rec = { t: nowClock(), ...obj };
    job.logs.push(rec);
    if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
    appendLog(job.logPath, { at: new Date().toISOString(), job: job.id, ...obj });
  }

  /** 启动一个后台刷课任务 */
  start({
    account,
    course,
    kinds = ['video', 'document'],
    concurrency = 2,
    maxMinutes = 120,
    only = [],
    quizPolicy = 'skip',
    startUrl,
    solveWorks = false,
    minConfidence = 0.75,
    autoSubmit = true,
    dryRun = false,
    assumeLogin = false,
    workLimit = 0,
    // 允许提交的空白题数上限：0（默认）= 只要还有空题就不交，改为保存草稿
    maxBlanks = 0,
    // 连续多少节「播放器说放完了、但平台没确认为已完成」就停机（0=不检查）
    videoNotConfirmedMax = 3,
    // 交卷前数空题；false=只看模型计划（旧行为，不推荐）
    blankGuard = true,
    // true=页面出现人脸/活体/实人认证就停机，零点击不绕过
    humanGuard = true,
    // true=每个任务页新开一个窗口；false（默认）=在当前窗口开标签，避免弹一堆窗口
    taskWindow = false,
  }) {
    const accountName = typeof account === 'string' ? account : account && account.name;
    // 同账号已有任务（含扫描任务、等验证码）→ 直接拒绝，别把两个任务压进同一个 Edge 窗口
    const busy = this._busyJobFor(accountName);
    if (busy) {
      return { ok: false, already: true, id: busy.id, text: '同一账号已有任务在跑：先停止或等它结束' };
    }
    const id = jobId();
    const llmReady = !!this.llm;
    const job = {
      id,
      kind: 'run',
      account: accountName,
      course: { ...course },
      kinds: kinds.filter((k) => k === 'video' || k === 'document'),
      concurrency: clamp(concurrency, 1, 4),
      maxMinutes: clamp(maxMinutes, 1, 24 * 60),
      only: Array.isArray(only) ? only.map(String) : [],
      quizPolicy,
      solveWorks: !!solveWorks && llmReady,
      minConfidence: confThreshold(minConfidence),
      autoSubmit: autoSubmit !== false,
      dryRun: !!dryRun,
      assumeLogin: !!assumeLogin,
      workLimit: Math.max(0, Number(workLimit) || 0),
      maxBlanks: Math.max(0, Number(maxBlanks) || 0),
      videoNotConfirmedMax: Math.max(0, Math.min(10, Number(videoNotConfirmedMax) || 0)),
      blankGuard: blankGuard !== false,
      humanGuard: humanGuard !== false,
      videoUnconfirmed: 0,
      stopReason: '',
      taskWindow: !!taskWindow,
      llmReady,
      state: 'starting',
      startedAt: Date.now(),
      endedAt: 0,
      logs: [],
      logPath: path.join(paths().logs, `job_${id}.jsonl`),
      progress: {
        rounds: 0,
        catalogTotal: 0,
        catalogPending: 0,
        nodesPlanned: 0,
        nodesDone: 0,
        nodesFailed: 0,
        nodesSkipped: 0,
        pointsAtStart: 0,
        pointsNow: 0,
        quizzesPlanned: 0,
        quizzesSolved: 0,
        quizzesSkipped: 0,
        worksPlanned: 0,
        worksSolved: 0,
        worksFailed: 0,
        worksSkipped: 0,
      },
      nodes: {},
      current: [],
      captcha: null,
      error: '',
      stopRequested: false,
      captchaWaiter: null,
    };
    this.jobs.set(id, job);
    this.logLine(job, {
      ev: 'start',
      account: job.account,
      course: course.courseid,
      kinds: job.kinds,
      k: job.concurrency,
      maxMinutes: job.maxMinutes,
      quizPolicy: job.quizPolicy,
      solveWorks: job.solveWorks,
      dryRun: job.dryRun,
      llm: llmReady ? 'ready' : 'none',
    });
    job.promise = this.run(job, { startUrl }).catch((e) => {
      job.state = 'error';
      job.error = String((e && e.message) || e);
      job.endedAt = Date.now();
      this.logLine(job, { ev: 'fatal', err: truncate(job.error, 400), stack: truncate(String((e && e.stack) || ''), 800) });
      this.evictTerminalJobs();
    });
    return job;
  }

  /** 后台扫描任务：读目录 + 逐节点读卡片附件，结果写 store.scans */
  startScan({ account, course, limit = 0, concurrency = 2 }) {
    const id = jobId();
    const job = {
      id,
      kind: 'scan',
      account,
      course: { ...course },
      kinds: [],
      concurrency: clamp(concurrency, 1, 3),
      maxMinutes: 60,
      only: [],
      quizPolicy: 'skip',
      state: 'starting',
      startedAt: Date.now(),
      endedAt: 0,
      logs: [],
      logPath: path.join(paths().logs, `job_${id}.jsonl`),
      progress: { scanned: 0, scanTotal: 0, nodesPlanned: 0, nodesDone: 0, nodesFailed: 0, nodesSkipped: 0, rounds: 0, catalogTotal: 0, catalogPending: 0, pendingCount: 0 },
      nodes: {},
      current: [],
      captcha: null,
      error: '',
      stopRequested: false,
      captchaWaiter: null,
      scanSummary: null,
    };
    this.jobs.set(id, job);
    this.logLine(job, { ev: 'scan-start', account, course: course.courseid, limit, k: job.concurrency });
    job.promise = (async () => {
      job.state = 'running';
      const scan = await scanCourse({
        hub: this.hub,
        store: this.store,
        python: this.python,
        account,
        course,
        concurrency: job.concurrency,
        limit,
        log: (o) => this.logLine(job, o),
        onProgress: (done, total) => {
          job.progress.scanned = done;
          job.progress.scanTotal = total;
        },
        shouldStop: () => job.stopRequested,
      });
      job.course = scan.course || job.course;
      job.scanSummary = {
        totalPoints: scan.totalPoints,
        pendingCount: scan.pendingCount,
        nodeCount: scan.nodeCount,
        scannedCount: scan.scannedCount,
        truncated: scan.truncated,
        partial: scan.partial,
      };
      job.progress.catalogTotal = scan.totalPoints;
      job.progress.pendingCount = scan.pendingCount;
      job.progress.nodesPlanned = scan.pendingCount;
      job.state = job.stopRequested ? 'stopped' : 'done';
      job.endedAt = Date.now();
      this.logLine(job, { ev: 'scan-done', ...job.scanSummary });
      this.evictTerminalJobs();
    })().catch((e) => {
      job.state = 'error';
      job.error = truncate((e && e.message) || String(e), 400);
      job.endedAt = Date.now();
      this.logLine(job, { ev: 'scan-fatal', err: job.error });
      this.evictTerminalJobs();
    });
    return job;
  }

  get(id) {
    return this.jobs.get(String(id || ''));
  }

  /** 最近创建的任务（含扫描任务） */
  latest() {
    const all = Array.from(this.jobs.values());
    return all.length ? all[all.length - 1] : null;
  }

  list() {
    return Array.from(this.jobs.values()).map((j) => this.snapshot(j, { logLines: 0, results: false }));
  }

  stop(id) {
    const job = this.get(id);
    if (!job) return { ok: false, err: 'job-not-found' };
    job.stopRequested = true;
    // 正在等人工验证码时要把 waiter 一并放掉，否则 stop 之后 job 还要挂满 5 分钟才超时
    try {
      job.captcha?.resolve?.('');
    } catch {
      /* ignore */
    }
    if (job.captchaWaiter) job.captchaWaiter('');
    this.logLine(job, { ev: 'stop-requested' });
    return { ok: true, id: job.id };
  }

  /** 人工验证码：把用户输入的码填进当前卡住的验证码页 */
  async submitCaptchaCode(id, code) {
    const job = this.get(id);
    if (!job) return { ok: false, err: 'job-not-found' };
    if (!job.captcha || !job.captcha.resolve) return { ok: false, err: '该任务当前没有等待验证码' };
    job.captcha.code = String(code || '').trim();
    const resolve = job.captcha.resolve;
    job.captcha.resolve = null;
    resolve(job.captcha.code);
    return { ok: true, jobId: job.id, code: job.captcha.code };
  }

  snapshot(job, { logLines = 30, results = true } = {}) {
    const elapsed = Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000);
    const nodeVals = Object.values(job.nodes);
    return {
      id: job.id,
      kind: job.kind || 'run',
      account: job.account,
      course: job.course,
      state: job.state,
      elapsedSec: elapsed,
      elapsed: fmtDur(elapsed),
      budgetMin: job.maxMinutes,
      concurrency: job.concurrency,
      kinds: job.kinds,
      quizPolicy: job.quizPolicy,
      solveWorks: !!job.solveWorks,
      minConfidence: job.minConfidence,
      autoSubmit: job.autoSubmit,
      dryRun: !!job.dryRun,
      maxBlanks: job.maxBlanks,
      videoNotConfirmedMax: job.videoNotConfirmedMax,
      blankGuard: job.blankGuard !== false,
      humanGuard: job.humanGuard !== false,
      videoUnconfirmed: job.videoUnconfirmed || 0,
      stopReason: job.stopReason || '',
      llmReady: !!job.llmReady,
      progress: job.progress,
      nodes: {
        planned: job.progress.nodesPlanned,
        done: job.progress.nodesDone,
        failed: job.progress.nodesFailed,
        skipped: job.progress.nodesSkipped,
        running: job.current.map((c) => ({ kid: c.kid, phase: c.phase, sec: Math.round((Date.now() - c.t0) / 1000) })),
        recent: results
          ? nodeVals
              .filter((n) => n.finishedAt)
              .sort((a, b) => b.finishedAt - a.finishedAt)
              .slice(0, 6)
              .map((n) => ({ kid: n.kid, name: n.name, state: n.state, tookSec: n.tookSec, detail: truncate(n.detail, 120) }))
          : [],
      },
      captcha: job.captcha ? { imagePath: job.captcha.imagePath, at: job.captcha.at, hint: '用 chaoxing_exam 的 captcha 动作传 code' } : null,
      scanSummary: job.scanSummary || null,
      works: {
        planned: job.progress.worksPlanned,
        solved: job.progress.worksSolved,
        failed: job.progress.worksFailed,
        skipped: job.progress.worksSkipped,
        recent: job.workRecent || [],
      },
      error: job.error,
      logPath: job.logPath,
      logTail: logLines > 0 ? job.logs.slice(-logLines) : [],
    };
  }

  /** 人工验证码等待：返回用户输入的 code 或 '' */
  waitManualCaptcha(job, imagePath) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (job.captcha && job.captcha.resolve === resolve) {
          job.captcha = null;
        }
        resolve('');
      }, 300000);
      timer.unref?.();
      job.captcha = {
        imagePath,
        at: Date.now(),
        resolve: (code) => {
          clearTimeout(timer);
          resolve(code || '');
        },
      };
      job.state = 'need_captcha';
    });
  }

  async runCaptcha(page, ctx, job, phase) {
    // 人工验证码可能永远填不对：限制轮次，避免 solve→manual→still→solve 无限递归
    job.captchaRounds = Number(job.captchaRounds || 0) + 1;
    if (job.captchaRounds > 6) {
      job.stopRequested = true;
      throw new Error('验证码连续 6 轮仍未通过，已停止（请手动登录后再试）');
    }
    const solved = await solveCaptcha(page, ctx);
    if (solved.ok) {
      this.logLine(job, { ev: 'captcha-solved', phase, tries: solved.tries, text: solved.text });
      return { ok: true };
    }
    this.logLine(job, { ev: 'captcha-need-manual', phase, imagePath: solved.imagePath, tries: solved.tries });
    const code = await this.waitManualCaptcha(job, solved.imagePath);
    if (!code) {
      // 直接写 job.state='stopped' 会被 runNode 的 catch 吃掉、job 继续跑后面的节点，
      // 与 autopilot 的终态判断打架（同一浏览器上出现两个 job）。统一走 stopRequested。
      job.stopRequested = true;
      throw new Error(`验证码识别失败且没有收到人工输入（图片：${solved.imagePath || '无'}）`);
    }
    this.logLine(job, { ev: 'captcha-manual', phase, code });
    job.state = 'running';
    // 在同一个页面上填人工码
    const filled = await page
      .evaluate(
        `(function(){var inp=document.querySelector('#ucode');if(!inp)return {ok:false};inp.value=${JSON.stringify(code)};inp.dispatchEvent(new Event('input',{bubbles:true}));var f=inp.form||document.querySelector('form');if(f){f.submit();return {ok:true}}return {ok:false};})()`,
      )
      .catch(() => null);
    await sleep(4500);
    const still = await pageIsCaptcha(page);
    if (still) {
      job.state = 'running';
      return this.runCaptcha(page, ctx, job, phase);
    }
    return { ok: true, manual: true, filled };
  }

  async ensureOkPage(page, ctx, job, phase) {
    // 先看人工验证（人脸/活体/实人认证）：命中即停机，绝不尝试点击或绕过
    if (job.humanGuard !== false) {
      const human = await scanHumanVerification(page).catch(() => ({ hit: false }));
      if (human && human.hit) {
        this.fatalStop(
          job,
          'HUMAN_VERIFICATION',
          `页面出现人工验证（${human.where || 'page'}：${human.label || '人脸/活体'}）：已停机且未做任何点击。请在客户端里自己完成验证，再点「开始」继续。`,
          { phase, where: human.where, label: human.label, url: human.url || '' },
        );
      }
    }
    if (await pageIsCaptcha(page)) return this.runCaptcha(page, ctx, job, phase);
    return { ok: true };
  }

  /** 回读平台是否确认这个视频已完成（附件 passed / isUnFinishJob=done）。探针不可用返回 unverified，不误停。 */
  async confirmVideoWatched(job, ctx, page, att, frameIdx) {
    const timeoutMs = Number(process.env.CX_VIDEO_CONFIRM_MS || 16000);
    const t0 = Date.now();
    let need = 'unk';
    while (Date.now() - t0 < timeoutMs && !job.stopRequested) {
      const chk = await cardArgsOnPage(page, ctx).catch(() => null);
      const vids = ((chk && chk.list) || []).filter((a) => a.type === 'video');
      let hit = null;
      if (att && att.jobid) hit = vids.find((a) => String(a.jobid) === String(att.jobid));
      else if (att && att.name) hit = vids.find((a) => String(a.name) === String(att.name));
      const passed = hit ? !!hit.passed : vids.length > 0 && vids.every((a) => a.passed);
      if (passed) {
        const waitedMs = Date.now() - t0;
        this.logLine(job, { ev: 'video-confirmed', via: 'attachment', waitedMs, matched: !!hit });
        return { ok: true, via: 'attachment', waitedMs };
      }
      need = await vidNeed(page, frameIdx).catch(() => 'unk');
      if (need === 'done') {
        const waitedMs = Date.now() - t0;
        this.logLine(job, { ev: 'video-confirmed', via: 'isUnFinishJob', waitedMs });
        return { ok: true, via: 'isUnFinishJob', waitedMs };
      }
      await sleep(2000);
    }
    if (need === 'unk') {
      // 页面上没有 isUnFinishJob 探针（或读不到）：无法确认不等于确认失败，记一条日志放过，避免误停。
      this.logLine(job, { ev: 'video-confirm-unknown', need });
      return { ok: true, via: 'unknown', unverified: true };
    }
    return { ok: false, need, waitedMs: Date.now() - t0 };
  }

  /** 触发不可恢复的停止并抛错：所有调用方都会按 error/stopped 收尾，不会继续点下去 */
  fatalStop(job, reason, message, extra = {}) {
    job.stopRequested = true;
    job.stopReason = reason;
    job.error = message;
    this.logLine(job, { ev: 'fatal-stop', reason, ...extra });
    const e = new Error(message);
    e.cxStop = reason;
    throw e;
  }

  async run(job, { startUrl }) {
    const { account, course } = job;
    const hub = this.hub;
    // startUrl 来自工具/HTTP 参数：只允许 http(s)，拒绝 `--foo` 与 file:// 这类值。
    const start = safeStartUrl(startUrl);
    if (!start) throw new Error('startUrl 非法：只允许 http(s) 网址');
    job.state = 'starting';
    const ctx = this.ctxFor(job);
    const accName = safeAccountName(account || 'default');
    const acc = hub.store.get('accounts', {})[accName] || {
      name: accName,
      port: 9422,
      profileDir: path.join(paths().profiles, accName),
    };

    // 1. 浏览器 + 控制器页
    const { page: ctrl } = await hub.ensurePage(acc, { startUrl: start });
    job.state = 'running';
    this.logLine(job, { ev: 'browser-ready', port: (await hub.status(acc)).port });

    // 先确认已登录，否则后面读目录只会给出含糊的报错。
    // 注意：新建窗口第一次打开 i.chaoxing.com/base 有时会被瞬时 302 到 passport 登录页，
    // 重试同一地址就能拿到已登录状态，所以这里最多探测 3 次再判定未登录。
    const preHref = await ctrl.evaluate('location.href').catch(() => '?');
    this.logLine(job, { ev: 'login-pre', href: truncate(preHref, 120), target: ctrl.targetId || '' });
    // autopilot 刚验过登录态时 assumeLogin=true：这里的探测只做记录，失败也不拦（探测本身有误判，
    // 真正是否可用由后面的 resolveCourse/readCatalog 决定，报错也更准确）。
    let loginProbe = null;
    if (job.assumeLogin) {
      loginProbe = await ctrl
        .goto(start, { waitMs: 5000 })
        .then(() => probeLogin(ctrl))
        .catch(() => null);
      this.logLine(job, {
        ev: 'login-assumed',
        href: truncate((loginProbe && loginProbe.href) || '', 120),
        loggedIn: !!(loginProbe && loginProbe.loggedIn),
      });
    } else {
      for (let attempt = 0; attempt < 3; attempt++) {
        const target = start;
        const probeUrl = attempt ? `${target}${target.includes('?') ? '&' : '?'}t=${Date.now()}` : target;
        loginProbe = await ctrl
          .goto(probeUrl, { waitMs: attempt ? 9000 : 7000 })
          .then(() => probeLogin(ctrl))
          .catch(() => null);
        if (loginProbe && !loginProbe.onLoginPage && loginProbe.loggedIn !== false) break;
        if (attempt < 2) {
          this.logLine(job, { ev: 'login-retry', attempt: attempt + 1, href: truncate((loginProbe && loginProbe.href) || '', 120) });
          await sleep(1500);
        }
      }
      if (loginProbe && (loginProbe.onLoginPage || loginProbe.loggedIn === false)) {
        this.logLine(job, { ev: 'login-required', href: truncate(loginProbe.href, 120) });
        await bringToFront(ctrl);
        throw new Error('还没有登录学习通：请点面板「登录」（或 chaoxing_account 的 login 动作），在弹出的 Edge 窗口扫码，登录后再点「开始」');
      }
    }
    this.logLine(job, { ev: 'login-ok', href: loginProbe ? truncate(loginProbe.href, 100) : '' });

    // 1.5 清掉上一轮异常退出残留的任务标签（只清 cards/work 任务页，不碰用户自己的标签）
    await this.sweepTaskTabs(job);

    // 2. 解析 cpi/enc
    const resolved = await resolveCourse(ctrl, course, ctx);
    job.course = { ...course, ...resolved };
    this.store.get('courses', {})[`${account}:${course.courseid}`] = { ...job.course, at: new Date().toISOString() };
    this.store.touch();
    this.logLine(job, { ev: 'course-resolved', cpi: job.course.cpi, enc: job.course.enc ? 'yes' : 'no' });

    // 3. 读目录
    const catalog = await readCatalog(ctrl, job.course, ctx);
    const totalPoints = catalog.reduce((a, r) => a + r.points, 0);
    job.progress.catalogTotal = totalPoints;
    job.progress.pointsAtStart = totalPoints;
    job.progress.pointsNow = totalPoints;
    let queue = catalog.filter((r) => r.points > 0);
    if (job.only.length) queue = queue.filter((r) => job.only.includes(String(r.kid)));
    job.progress.nodesPlanned = queue.length;
    this.logLine(job, { ev: 'catalog', totalPoints, pending: queue.length, only: job.only.length });
    // 目录只有 kid/points，没有附件名；保留上一次「扫描」写下的 nodes（含 attachments[].name），
    // 否则面板的「最近扫描」会退化成只剩一串 knowledgeid
    const scanKey = `${account}:${course.courseid}`;
    const prevScan = this.store.get('scans', {})[scanKey] || {};
    const richNodes = Array.isArray(prevScan.nodes) && prevScan.nodes.some((n) => n && Array.isArray(n.attachments) && n.attachments.length);
    this.store.get('scans', {})[scanKey] = {
      ...prevScan,
      at: new Date().toISOString(),
      course: job.course,
      totalPoints,
      pendingCount: richNodes && prevScan.pendingCount != null ? prevScan.pendingCount : queue.length,
      catalog,
      nodes: richNodes ? prevScan.nodes : catalog,
    };
    this.store.touch();

    const t0 = Date.now();
    const deadline = t0 + job.maxMinutes * 60000;
    let staleRounds = 0;
    let round = 0;

    if (!job.kinds.length && job.quizPolicy === 'skip') {
      // 只做作业、且不碰测验时不必逐个节点开卡片（每个节点要 3~5 秒），直接进作业阶段
      this.logLine(job, { ev: 'catalog-skip', why: 'no-kinds', pending: queue.length });
      queue = [];
    }
    while (queue.length && !job.stopRequested) {
      round++;
      job.progress.rounds = round;
      const batchSize = job.concurrency;
      for (let i = 0; i < queue.length; i += batchSize) {
        if (job.stopRequested) break;
        if (Date.now() > deadline) {
          this.logLine(job, { ev: 'budget-exhausted', min: job.maxMinutes });
          job.state = 'stopped';
          break;
        }
        const batch = queue.slice(i, i + batchSize);
        await Promise.all(
          batch.map((node) =>
            this.runNode(job, ctx, node).catch((e) => {
              job.progress.nodesFailed++;
              this.logLine(job, { ev: 'node-fatal', kid: node.kid, err: truncate(e.message, 200) });
            }),
          ),
        );
        const gap = randInt(1500, 3000);
        this.logLine(job, { ev: 'batch-gap', ms: gap, done: job.progress.nodesDone, failed: job.progress.nodesFailed });
        await sleepUnless(gap, () => job.stopRequested);
      }
      if (job.stopRequested) break;
      if (Date.now() > deadline) {
        job.state = 'stopped';
        break;
      }

      // 4. 刷新目录，检查是否还有待完成（同时更新剩余点数）
      const fresh = await readCatalog(ctrl, job.course, ctx).catch((e) => {
        this.logLine(job, { ev: 'catalog-refresh-fail', err: truncate(e.message, 160) });
        return null;
      });
      if (!fresh) break;
      const freshTotal = fresh.reduce((a, r) => a + r.points, 0);
      const base = job.progress.pointsNow;
      job.progress.catalogTotal = freshTotal;
      job.progress.pointsNow = freshTotal;
      queue = fresh.filter((r) => r.points > 0);
      if (job.only.length) queue = queue.filter((r) => job.only.includes(String(r.kid)));
      this.logLine(job, {
        ev: 'catalog-refresh',
        round,
        totalPoints: freshTotal,
        pending: queue.length,
        gained: base - freshTotal,
      });

      if (!queue.length) {
        job.state = 'done';
        this.logLine(job, { ev: 'all-clear', round });
        break;
      }
      if (freshTotal >= base) {
        staleRounds++;
        this.logLine(job, { ev: 'no-progress', round, staleRounds });
        // 第一轮完全没有进账时先等一会儿复核一次，仍为 0 就立刻止损，
        // 避免把整门课（例如全是文档的课）再原样跑一遍、白耗十几分钟。
        if (staleRounds === 1 && round === 1) {
          this.logLine(job, { ev: 'stale-confirm', waitMs: 30000, pending: queue.length });
          await sleepUnless(30000, () => job.stopRequested);
          if (job.stopRequested) break;
          const again = await readCatalog(ctrl, job.course, ctx).catch((e) => {
            this.logLine(job, { ev: 'catalog-recheck-fail', err: truncate(e.message, 160) });
            return null;
          });
          if (again) {
            const t2 = again.reduce((a, r) => a + r.points, 0);
            this.logLine(job, {
              ev: 'catalog-recheck',
              totalPoints: t2,
              pending: again.filter((r) => r.points > 0).length,
              gained: freshTotal - t2,
            });
            if (t2 >= freshTotal) {
              job.progress.catalogTotal = t2;
              job.progress.pointsNow = t2;
              job.state = 'done';
              job.error = '本轮没有任何任务点被计入（复核 30 秒后仍为 0），可能该课程不计点或页面行为变了，已停止以免空转';
              this.logLine(job, { ev: 'stale-stop', staleRounds: 2, afterRecheck: true });
              break;
            }
            job.progress.catalogTotal = t2;
            job.progress.pointsNow = t2;
            queue = again.filter((r) => r.points > 0);
            if (job.only.length) queue = queue.filter((r) => job.only.includes(String(r.kid)));
            if (!queue.length) {
              job.state = 'done';
              this.logLine(job, { ev: 'all-clear', round });
              break;
            }
            staleRounds = 0;
            continue;
          }
        }
        if (staleRounds >= 2) {
          job.state = 'done';
          job.error = '连续两轮目录任务点没有下降，可能该课程不计点或页面行为变了，已停止以免空转';
          this.logLine(job, { ev: 'stale-stop', staleRounds });
          break;
        }
      } else {
        staleRounds = 0;
      }
    }

    // 5. 作业（可选：让宿主模型自动作答并提交）
    if (job.solveWorks && !job.stopRequested && job.state !== 'error' && Date.now() < deadline) {
      try {
        await this.runWorks(job, ctx, ctrl);
      } catch (e) {
        this.logLine(job, { ev: 'works-fatal', err: truncate(e.message, 300) });
      }
    }

    // 6. 收尾
    if (!job.stopRequested && job.state === 'running') job.state = 'done';
    // 用户主动停止 = stopped；风控/人工验证/未确认等硬停 = error，面板才会显示为异常而不是"跑完了"
    if (job.stopRequested) job.state = job.stopReason ? 'error' : 'stopped';
    job.endedAt = Date.now();
    this.logLine(job, {
      ev: 'end',
      state: job.state,
      min: Math.round((job.endedAt - job.startedAt) / 60000),
      done: job.progress.nodesDone,
      failed: job.progress.nodesFailed,
      quizzesSolved: job.progress.quizzesSolved,
      worksSolved: job.progress.worksSolved,
      pointsFrom: job.progress.pointsAtStart,
      pointsTo: job.progress.pointsNow,
    });
    this.evictTerminalJobs();
    return job;
  }

  // 清掉历史遗留的任务标签：只关 knowledge/cards 与作业作答页，绝不碰用户自己开着的页面。
  async sweepTaskTabs(job) {
    try {
      const others = [...this.jobs.values()].filter(
        (j) => j !== job && (j.state === 'running' || j.state === 'starting'),
      );
      if (others.length) return; // 还有其他任务在跑，别乱关
      const acc = this.hub.store.get('accounts', {})[job.account] || { port: 9422 };
      const port = Number(acc.port) || 9422;
      const targets = await listTargets(port).catch(() => []);
      if (!Array.isArray(targets) || !targets.length) return;
      const isTask = (t) =>
        t &&
        t.type === 'page' &&
        /\/knowledge\/cards|\/mooc2\/work\/(task|dowork)|\/ananas\/modules\//i.test(String(t.url || ''));
      let closed = 0;
      for (const t of targets) {
        if (!isTask(t)) continue;
        await closeTarget(port, t.id || t.targetId).catch(() => {});
        closed++;
      }
      if (closed) this.logLine(job, { ev: 'tabs-swept', closed });
    } catch (e) {
      this.logLine(job, { ev: 'tabs-sweep-fail', err: truncate(e.message, 160) });
    }
  }

  async runNode(job, ctx, node) {
    if (job.stopRequested) return;
    const state = (job.nodes[node.kid] = job.nodes[node.kid] || {
      kid: node.kid,
      name: node.name,
      attempts: 0,
      state: 'running',
      detail: '',
      tookSec: 0,
    });
    state.attempts++;
    const tStart = Date.now();
    job.current.push({ kid: node.kid, phase: 'open', t0: tStart });
    this.logLine(job, { ev: 'node-start', kid: node.kid, points: node.points, name: truncate(node.name, 40) });

    const acc = this.hub.store.get('accounts', {})[job.account] || { name: job.account, port: 9422 };
    let page = null;
    try {
      page = (await this.hub.openTaskPage(acc, { newWindow: !!job.taskWindow })).page;
      const cur = job.current[job.current.length - 1];
      cur.phase = 'cards';

      // 知识点页可能有多张卡（num=0,1,2…），每张卡又可能挂多个附件：
      // 先把所有卡摸一遍（连续两张空卡就停），再按卡处理，避免把“附件序号”当成“卡号”。
      const first = await readCardArgs(page, job.course, node.kid, 0, ctx);
      // 注意：num=0 常常只是「目标要求」这类信息页（0 附件），真正的视频/文档/测验在 num=1、2…
      // 所以 num=0 为空不能直接判定整节点为空，必须继续摸后面的卡。
      const cards = [];
      if (first.ok) cards.push({ num: 0, list: first.list });
      else if (first.reason !== 'empty') {
        state.state = 'failed';
        state.detail = `卡片读取失败: ${first.reason}`;
        job.progress.nodesFailed++;
        this.logLine(job, { ev: 'node-fail', kid: node.kid, reason: first.reason });
        return;
      }
      let empty = 0;
      for (let num = 1; num < 25 && !job.stopRequested; num++) {
        await page.goto(cardsUrl(job.course, node.kid, num), { waitMs: 6500 });
        const okp = await this.ensureOkPage(page, ctx, job, `${node.kid}/card${num}`);
        if (!okp.ok) break;
        const att = await cardArgsOnPage(page, ctx);
        if (!att || !att.count) {
          empty++;
          if (empty >= 2) break;
          continue;
        }
        empty = 0;
        cards.push({ num, list: att.list });
      }

      cur.phase = 'plan';
      const allAtts = cards.flatMap((c) => c.list);
      const plannedCards = [];
      for (const c of cards) {
        const wanted = [];
        for (let idx = 0; idx < c.list.length; idx++) {
          const a = c.list[idx];
          if (a.passed) continue;
          const kind =
            a.type === 'video' && job.kinds.includes('video')
              ? 'video'
              : a.type === 'document' && job.kinds.includes('document')
                ? 'doc'
                : a.type === 'workid' && job.quizPolicy !== 'skip'
                  ? 'quiz'
                  : '';
          if (kind) wanted.push({ idx, kind, a });
        }
        if (wanted.length) plannedCards.push({ num: c.num, wanted });
      }
      this.logLine(job, {
        ev: 'node-plan',
        kid: node.kid,
        cards: cards.length,
        atts: summarize(allAtts),
        planned: plannedCards.map((p) => `card${p.num}[${p.wanted.map((w) => `${w.idx}:${w.kind}`).join(',')}]`).join(' '),
      });
      if (!plannedCards.length) {
        state.state = 'skipped';
        state.detail = allAtts.every((a) => a.passed) ? '卡片附件都已通过' : `没有可处理类型（${summarize(allAtts)}）`;
        job.progress.nodesSkipped++;
        return;
      }

      const results = [];
      for (const pc of plannedCards) {
        if (job.stopRequested) break;
        const cur2 = job.current[job.current.length - 1];
        cur2.phase = `card#${pc.num}`;
        // 发现阶段最后停在空卡上，所以处理每张卡都重新导航一次
        await page.goto(cardsUrl(job.course, node.kid, pc.num), { waitMs: 10000 });
        const okp = await this.ensureOkPage(page, ctx, job, `${node.kid}/${pc.num}`);
        if (!okp.ok) break;
        const wantKinds = new Set(pc.wanted.map((w) => w.kind));
        const f = await waitFrames(page, { timeoutMs: 22000, minTotal: 1, log: ctx.log });

        if (wantKinds.has('video')) {
          const vlist = (f && f.vid) || [];
          const vatts = pc.wanted.filter((w) => w.kind === 'video');
          if (!vlist.length) results.push({ card: pc.num, k: 'novframe' });
          for (let k = 0; k < vlist.length; k++) {
            const vi = vlist[k];
            const need = await vidNeed(page, vi).catch(() => 'unk');
            if (need !== 'need') {
              results.push({ card: pc.num, frame: vi, k: 'video-skip', why: need });
              continue;
            }
            const cur3 = job.current[job.current.length - 1];
            cur3.phase = `video#${pc.num}/${vi}`;
            const dur = Number((vatts[k] && vatts[k].a && vatts[k].a.duration) || 1200);
            const budget = clamp(dur + 240, 120, 5400);
            this.logLine(job, { ev: 'video-start', kid: node.kid, card: pc.num, frame: vi, budgetSec: budget });
            let last = null;
            const r = await playVideo(page, vi, budget, {
              log: ctx.log,
              guard: job.humanGuard === false ? null : () => scanHumanVerification(page),
              onTick: (tick) => {
                last = tick;
                if (tick.sec % 30 < 5) this.logLine(job, { ev: 'video-tick', kid: node.kid, d: tick.d, t: tick.t, paused: tick.paused });
              },
            });
            if (r && r.k === 'human') {
              this.fatalStop(
                job,
                'HUMAN_VERIFICATION',
                `视频播放中出现人工验证（${(r.hit && r.hit.where) || 'page'}：${(r.hit && r.hit.label) || '人脸/活体'}）：已停机且未做任何点击。请在客户端里自己完成验证，再点「开始」继续。`,
                { kid: node.kid, card: pc.num, frame: vi },
              );
            }
            results.push({ card: pc.num, frame: vi, ...r });
            this.logLine(job, { ev: 'video-end', kid: node.kid, card: pc.num, ...r, last });
            // 播完不等于平台记账：回读任务点/附件，连续未确认到上限就停机，避免"假刷完"一直空转
            if (r && r.k === 'fin' && job.videoNotConfirmedMax > 0) {
              const conf = await this.confirmVideoWatched(job, ctx, page, vatts[k] && vatts[k].a, vi);
              if (conf.ok) {
                job.videoUnconfirmed = 0;
              } else {
                job.videoUnconfirmed++;
                this.logLine(job, { ev: 'video-unconfirmed', kid: node.kid, card: pc.num, streak: job.videoUnconfirmed, max: job.videoNotConfirmedMax, need: conf.need });
                if (shouldStopUnconfirmed(job.videoUnconfirmed, job.videoNotConfirmedMax)) {
                  this.fatalStop(
                    job,
                    'VIDEO_NOT_CONFIRMED',
                    `连续 ${job.videoUnconfirmed} 个视频播放器显示已放完、但平台未确认为已完成（${conf.need || 'need'}）：可能被判定为无效观看，已停机。请人工检查一个视频后再跑。`,
                    { kid: node.kid, card: pc.num },
                  );
                }
              }
            }
          }
        }

        if (wantKinds.has('doc')) {
          const plist = (f && f.pdf) || [];
          if (!plist.length) results.push({ card: pc.num, k: 'nopdfframe' });
          for (const fi of plist) {
            const cur3 = job.current[job.current.length - 1];
            cur3.phase = `doc#${pc.num}/${fi}`;
            const r = await rollDoc(page, fi, { log: ctx.log });
            results.push({ card: pc.num, frame: fi, ...r });
            this.logLine(job, { ev: 'doc-end', kid: node.kid, card: pc.num, ...r });
          }
          // 翻完不等于通过：回读附件状态；没通过就重新进一次卡片再翻一遍（PPT/PDF 常见需要二次确认）
          for (let retry = 0; retry < 2; retry++) {
            const chk = await cardArgsOnPage(page, ctx);
            const docs = ((chk && chk.list) || []).filter((a) => a.type === 'document');
            const okDoc = docs.some((a) => a.passed);
            this.logLine(job, { ev: 'doc-verify', kid: node.kid, card: pc.num, retry, passed: okDoc, n: docs.length });
            if (okDoc || !docs.length || job.stopRequested) break;
            await page.goto(cardsUrl(job.course, node.kid, pc.num), { waitMs: 10000 });
            await this.ensureOkPage(page, ctx, job, `${node.kid}/${pc.num}/doc-retry`);
            const f2 = await waitFrames(page, { timeoutMs: 20000, minTotal: 1, log: ctx.log });
            const pl2 = (f2 && f2.pdf) || [];
            for (const fi of pl2) {
              const cur3 = job.current[job.current.length - 1];
              cur3.phase = `doc-retry#${pc.num}/${fi}`;
              const r2 = await rollDoc(page, fi, { log: ctx.log, maxMs: 60000 });
              results.push({ card: pc.num, frame: fi, retry, ...r2 });
              this.logLine(job, { ev: 'doc-end', kid: node.kid, card: pc.num, retry, ...r2 });
            }
          }
        }

        if (wantKinds.has('quiz')) {
          const qn = await quizFrameCount(page);
          if (!qn) results.push({ card: pc.num, k: 'noquizframe' });
          for (let fi = 0; fi < qn; fi++) {
            if (job.stopRequested) break;
            const cur3 = job.current[job.current.length - 1];
            cur3.phase = `quiz#${pc.num}/${fi}`;
            const baseKey = quizAnswerKey(job.course, node.kid, pc.num);
            const key = fi === 0 ? baseKey : `${baseKey}#f${fi}`;
            job.progress.quizzesPlanned++;
            const r = await this.solveQuizNode(job, ctx, page, node, { idx: pc.num }, { cardNum: pc.num, frameIdx: fi, key, onPage: true });
            results.push({ card: pc.num, frame: fi, ...r });
          }
        }
      }

      state.state = 'done';
      state.detail = summarize(allAtts) + (results.length ? ' | ' + truncate(JSON.stringify(results), 220) : '');
      job.progress.nodesDone++;
      this.logLine(job, { ev: 'node-done', kid: node.kid, results });
    } catch (e) {
      state.state = 'failed';
      state.detail = truncate(e.message, 200);
      job.progress.nodesFailed++;
      this.logLine(job, { ev: 'node-error', kid: node.kid, err: truncate(e.message, 300) });
    } finally {
      job.current = job.current.filter((c) => c.kid !== node.kid);
      state.tookSec = Math.round((Date.now() - tStart) / 1000);
      state.finishedAt = Date.now();
      if (page) await page.close().catch(() => {});
    }
  }

  /** 确保模型客户端已能解析出 provider/model（惰性路由） */
  async ensureLlm() {
    if (!this.llm) return false;
    if (typeof this.llm.ensureReady === 'function') {
      await this.llm.ensureReady();
    }
    return !!this.llm.ready;
  }

  saveAnswer(key, rec) {
    const all = this.store.get('answers', {}) || {};
    all[key] = rec;
    this.store.set('answers', all);
  }

  /** 测验节点：cached=只交已缓存答案；auto=让宿主模型作答（低置信度默认不提交） */
  /**
   * 已交但没通过的测验：页面若有「修改答案」入口，就打开重做页重新作答并提交。
   * 返回 null 表示没有重做入口（交给调用方按 skip 处理）。
   */
  async tryQuizReedit(job, ctx, page, node, where, key) {
    let href = '';
    try {
      href = await quizReeditHref(page);
    } catch (e) {
      href = '';
    }
    if (!href) return null;
    const target = chaoxingUrl(href);
    if (!target) {
      job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-reedit-blocked', kid: node.kid, num: where, href: truncate(String(href), 180) });
      return { k: 'quiz-reedit-blocked' };
    }
    href = target;
    this.logLine(job, { ev: 'quiz-reedit', kid: node.kid, num: where, href: truncate(href, 180) });
    try {
      await page.goto(href, { waitMs: 9000, timeoutMs: 35000 });
    } catch (e) {
      this.logLine(job, { ev: 'quiz-reedit-fail', kid: node.kid, num: where, err: truncate(e.message, 160) });
      return { k: 'quiz-reedit-fail' };
    }
    if (await pageIsCaptcha(page)) {
      const cap = await this.runCaptcha(page, ctx, job, 'quiz-reedit');
      if (!cap.ok) return { k: 'quiz-captcha' };
    }
    const data = await fetchQuizOnPage(page, ctx, node.kid);
    if (!data.ok || !(data.items || []).length) {
      job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-reedit-fetch-fail', kid: node.kid, num: where, why: data.reason });
      return { k: 'quiz-reedit-fetch-fail', why: data.reason };
    }
    const cached = (this.store.get('answers', {}) || {})[key];
    let solved;
    // 缓存只在「本次门限不高于生成它时的门限」时复用：否则按新门限重解，不能拿旧的低门限答案交卷。
    const cacheMin = Number.isFinite(Number(cached && cached.minConfidence)) ? Number(cached.minConfidence) : 0.8;
    if (cached && Array.isArray(cached.answers) && cached.answers.length && Number(job.minConfidence) <= cacheMin) {
      solved = { ok: true, plan: cached.answers, answers: cached.answers, gate: { ok: true, min: cacheMin, low: [] } };
      this.logLine(job, { ev: 'quiz-cache-hit', kid: node.kid, num: where, src: 'reedit' });
    } else {
      this.logLine(job, { ev: 'quiz-solve', kid: node.kid, num: where, items: data.items.length, model: (this.llm && this.llm.route && this.llm.route.model) || '', src: 'reedit' });
      solved = await solveQuiz({
        llm: this.llm,
        log: (o) => this.logLine(job, o),
        course: job.course,
        kid: node.kid,
        items: data.items,
        extra: { node: node.name, title: data.title, redo: true },
        minConfidence: job.minConfidence,
      });
    }
    if (!solved || !solved.ok || !(solved.plan || []).length) {
      job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-solve-fail', kid: node.kid, num: where, err: truncate((solved && solved.error) || '', 200), src: 'reedit' });
      return { k: 'quiz-solve-fail', src: 'reedit' };
    }
    const answers = solved.plan;
    const gate = solved.gate || { ok: true, min: 1, low: [] };
    this.saveAnswer(key, { at: new Date().toISOString(), answers, minConfidence: Number(job.minConfidence), gateMin: gate.min, model: (solved.model || '') });
    this.logLine(job, { ev: 'quiz-answer', kid: node.kid, num: where, n: answers.length, min: gate.min, src: 'reedit' });
    if (job.dryRun || !job.autoSubmit) {
      job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-reedit-dry', kid: node.kid, num: where, answers });
      return { k: 'quiz-reedit-dry', min: gate.min, n: answers.length };
    }
    const fill = await fillQuizReedit(page, answers, ctx);
    const g = await this.quizSubmitGate(job, ctx, page, node, where, data.items || [], answers);
    if (!g.ok) {
      this.logLine(job, { ev: 'quiz-blank-abort', kid: node.kid, num: where, src: 'reedit', blanks: g.blanks, saved: g.saved });
      return { k: 'quiz-blank-abort', src: 'reedit', blanks: g.blanks, saved: g.saved };
    }
    const sub = await submitQuiz(page, ctx);
    if (sub.ok) job.progress.quizzesSolved++;
    else job.progress.quizzesSkipped++;
    this.logLine(job, { ev: 'quiz-submit', kid: node.kid, num: where, ok: sub.ok, src: 'reedit', n: answers.length, filled: fill && fill.filled, min: gate.min });
    return { k: 'quiz', ok: sub.ok, src: 'reedit', n: answers.length };
  }

  /**
   * 交卷前闸门：回读页面实际空题数（不信任模型计划），超过允许值就点「保存」存草稿并放弃本次提交。
   * 数不清也按「可能有空题」处理（fail-closed）。
   */
  async quizSubmitGate(job, ctx, page, node, where, items, plan) {
    if (job.blankGuard === false) return { ok: true, skipped: true };
    const counted = await countQuizBlanks(page).catch(() => ({ ok: false, err: 'probe-fail' }));
    // 页内探针只在题数与抓到的题一致时才可信（父框架、练习题、旧卷都会让 total 对不上）
    const probeOk = !!(counted && counted.ok && items.length > 0 && Number(counted.total) === items.length);
    const gate = submitGate({
      items,
      plan,
      blanks: probeOk ? counted.blanks : null,
      countOk: probeOk,
      maxBlanks: job.maxBlanks,
    });
    this.logLine(job, {
      ev: 'quiz-blank-gate',
      kid: node.kid,
      num: where,
      blanks: gate.blanks,
      source: gate.source,
      maxBlanks: job.maxBlanks,
      ok: gate.ok,
      reason: gate.reason || '',
      probe: probeOk ? `total=${counted.total}` : `skip:${truncate(String((counted && counted.err) || 'total-mismatch'), 80)}`,
    });
    if (gate.ok) return gate;
    // 有空题：存草稿（点不到保存按钮就如实返回，绝不退化成提交）
    const saved = await saveQuizDraft(page, ctx).catch(() => null);
    job.progress.quizzesSkipped++;
    return { ...gate, saved: !!(saved && saved.ok), saveReason: (saved && (saved.reason || saved.err)) || '' };
  }

  async solveQuizNode(job, ctx, page, node, p, opts = {}) {
    const cardNum = opts.cardNum != null ? opts.cardNum : p.idx;
    const frameIdx = opts.frameIdx || 0;
    const key = opts.key || quizAnswerKey(job.course, node.kid, cardNum);
    const where = frameIdx ? `${cardNum}/f${frameIdx}` : String(cardNum);
    // 已经在卡片页上（按卡处理）时只抓当前这一个 work 框架；否则自己导航
    const grab = async () => {
      if (opts.onPage) {
        const rooted = await setQuizRoot(page, frameIdx);
        if (!rooted) return { ok: false, reason: 'no-quiz' };
        return fetchQuizHere(page, ctx, node.kid);
      }
      return fetchQuiz(page, job.course, node.kid, cardNum, ctx);
    };
    const cached = (this.store.get('answers', {}) || {})[key];
    const policy = job.quizPolicy;

    if (policy === 'cached') {
      if (!cached || !Array.isArray(cached.answers) || !cached.answers.length) {
        job.progress.quizzesSkipped++;
        this.logLine(job, { ev: 'quiz-skip', kid: node.kid, num: where, why: 'no-cached-answer' });
        return { k: 'quiz-no-answer' };
      }
      // cached 策略同样受 dryRun/autoSubmit 约束：这是「只交缓存答案」，不是「绕过演练模式」。
      if (job.dryRun || !job.autoSubmit) {
        job.progress.quizzesSkipped++;
        this.logLine(job, { ev: 'quiz-dry', kid: node.kid, num: where, src: 'cache', n: cached.answers.length });
        return { k: 'quiz-dry', src: 'cache', n: cached.answers.length };
      }
      const cacheMin = Number.isFinite(Number(cached.minConfidence)) ? Number(cached.minConfidence) : 0.75;
      if (Number(job.minConfidence) > cacheMin) {
        job.progress.quizzesSkipped++;
        this.logLine(job, { ev: 'quiz-skip', kid: node.kid, num: where, why: 'cached-below-threshold', cacheMin, min: Number(job.minConfidence) });
        return { k: 'quiz-low-confidence', min: cacheMin };
      }
      const q = await grab();
      if (!q.ok || q.alreadySubmitted) {
        job.progress.quizzesSkipped++;
        return { k: 'quiz-fetch', q: q.reason || 'submitted' };
      }
      await fillQuiz(page, cached.answers, ctx);
      const g = await this.quizSubmitGate(job, ctx, page, node, where, q.items || [], cached.answers);
      if (!g.ok) {
        this.logLine(job, { ev: 'quiz-blank-abort', kid: node.kid, num: where, src: 'cache', blanks: g.blanks, saved: g.saved });
        return { k: 'quiz-blank-abort', src: 'cache', blanks: g.blanks, saved: g.saved };
      }
      const sub = await submitQuiz(page, ctx);
      if (sub.ok) job.progress.quizzesSolved++;
      else job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-submit', kid: node.kid, num: where, ok: sub.ok, src: 'cache' });
      return { k: 'quiz', ok: sub.ok, src: 'cache' };
    }
    if (policy !== 'auto') return { k: 'quiz-skip' };
    if (!(await this.ensureLlm())) {
      job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-skip', kid: node.kid, num: where, why: 'no-llm' });
      return { k: 'quiz-no-llm' };
    }

    const q = await grab();
    if (!q.ok) {
      job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-fetch-fail', kid: node.kid, num: where, why: q.reason });
      return { k: 'quiz-fetch', q: q.reason };
    }
    if (q.alreadySubmitted) {
      // 已交但没拿到分（目录里还挂着）：页面上有「修改答案」就去重做页再答一次
      const redo = await this.tryQuizReedit(job, ctx, page, node, where, key);
      if (redo) return redo;
      job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-skip', kid: node.kid, num: where, why: 'already-submitted' });
      return { k: 'quiz-already' };
    }
    let solved;
    // 缓存复用前提：本次门限不高于生成缓存时的门限，否则按新门限重解。
    const cacheMin = Number.isFinite(Number(cached && cached.minConfidence)) ? Number(cached.minConfidence) : 0.75;
    if (cached && Array.isArray(cached.answers) && cached.answers.length && Number(job.minConfidence) <= cacheMin) {
      solved = { ok: true, plan: cached.answers, answers: cached.answers, gate: { ok: true, min: cacheMin, low: [] } };
      this.logLine(job, { ev: 'quiz-cache-hit', kid: node.kid, num: where });
    } else {
      this.logLine(job, { ev: 'quiz-solve', kid: node.kid, num: where, items: (q.items || []).length, model: (this.llm.route && this.llm.route.model) || '' });
      solved = await solveQuiz({
        llm: this.llm,
        log: (o) => this.logLine(job, o),
        course: job.course,
        kid: node.kid,
        items: q.items || [],
        extra: { node: node.name, title: q.title },
        minConfidence: job.minConfidence,
      });
    }
    if (!solved || !solved.ok) {
      job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-solve-fail', kid: node.kid, num: where, err: truncate((solved && solved.error) || '', 200) });
      return { k: 'quiz-solve-fail' };
    }
    const answers = solved.plan || solved.answers || [];
    const gate = solved.gate || { ok: true, min: 1, low: [] };
    const dropped = Number.isFinite(Number(solved.dropped)) ? Number(solved.dropped) : (gate.low || []).length;
    this.logLine(job, { ev: 'quiz-answer', kid: node.kid, num: where, n: answers.length, min: gate.min, low: dropped, chunks: solved.chunks || 1 });
    if (!answers.length) {
      job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-skip', kid: node.kid, num: where, why: 'no-confident-answer', min: gate.min });
      return { k: 'quiz-low-confidence', min: gate.min };
    }
    // 只在真正有答案时落缓存；记录本次「请求的门限」，重放时据此判断能不能复用。
    this.saveAnswer(key, { at: new Date().toISOString(), answers, minConfidence: Number(job.minConfidence), gateMin: gate.min, model: (solved.model || '') });
    if (job.dryRun || !job.autoSubmit) {
      job.progress.quizzesSkipped++;
      this.logLine(job, { ev: 'quiz-dry', kid: node.kid, num: where, answers });
      return { k: 'quiz-dry', min: gate.min, n: answers.length };
    }
    await fillQuiz(page, answers, ctx);
    const g = await this.quizSubmitGate(job, ctx, page, node, where, q.items || [], answers);
    if (!g.ok) {
      this.logLine(job, { ev: 'quiz-blank-abort', kid: node.kid, num: where, src: 'llm', blanks: g.blanks, saved: g.saved });
      return { k: 'quiz-blank-abort', src: 'llm', blanks: g.blanks, saved: g.saved };
    }
    const sub = await submitQuiz(page, ctx);
    if (sub.ok) job.progress.quizzesSolved++;
    else job.progress.quizzesSkipped++;
    this.logLine(job, { ev: 'quiz-submit', kid: node.kid, num: where, ok: sub.ok, src: 'llm', n: answers.length, dropped, min: gate.min });
    return { k: 'quiz', ok: sub.ok, src: 'llm', min: gate.min, n: answers.length, dropped };
  }

  /** 作业阶段：列表 → 逐份抓题 → 模型作答 → 回填提交（低置信度 / dryRun 不提交） */
  async runWorks(job, ctx, ctrl) {
    if (!ctrl) return;
    if (!(await this.ensureLlm())) {
      this.logLine(job, { ev: 'works-skip', why: 'no-llm' });
      return;
    }
    const log = (o) => this.logLine(job, o);
    let listed = null;
    for (let attempt = 0; attempt < 2 && !listed; attempt++) {
      const r = await listWorks(ctrl, job.course, ctx, {
        attempts: 2,
        waitMs: attempt ? 6000 : 9000,
        polls: 4,
        pollMs: 1500,
      }).catch((e) => ({ ok: false, reason: e.message }));
      if (r && r.ok) listed = r;
      else {
        this.logLine(job, { ev: 'works-list-retry', attempt: attempt + 1, reason: truncate((r && r.reason) || '', 160) });
        await sleep(3000);
      }
    }
    if (!listed) {
      this.logLine(job, { ev: 'works-list-fail' });
      return;
    }
    const items = Array.isArray(listed.items) ? listed.items : [];
    let pending = items.filter((w) =>
      typeof w.canDo === 'boolean' ? w.canDo : !/已交|已完成|待批阅|已提交|已批改/.test(`${w.text || ''} ${w.title || ''}`),
    );
    if (job.workLimit > 0) pending = pending.slice(0, job.workLimit);
    job.progress.worksPlanned = pending.length;
    this.logLine(job, {
      ev: 'works-list',
      total: items.length,
      pending: pending.length,
      sample: items.slice(0, 5).map((w) => ({ t: truncate(w.title || '', 30), s: w.status || '', url: w.url ? 'yes' : 'no' })),
    });
    for (const w of pending) {
      if (job.stopRequested) break;
      const url = w.url || '';
      try {
        const opened = await openWork(ctrl, { url, ctx });
        if (!opened || opened.ok === false) {
          job.progress.worksFailed++;
          this.logLine(job, { ev: 'work-open-fail', url: truncate(url, 120), reason: truncate((opened && opened.reason) || '', 160) });
          continue;
        }
        const f = await fetchWork(ctrl, ctx);
        if (!f || !f.ok) {
          job.progress.worksFailed++;
          this.logLine(job, { ev: 'work-fetch-fail', url: truncate(url, 120), reason: truncate((f && f.reason) || '', 160) });
          continue;
        }
        const wit = Array.isArray(f.items) ? f.items : [];
        this.logLine(job, { ev: 'work-fetch', url: truncate(url, 120), items: wit.length, title: truncate(w.title || '', 40) });
        if (!wit.length) {
          job.progress.worksSkipped++;
          continue;
        }
        const solved = await solveWork({
          llm: this.llm,
          log,
          course: job.course,
          items: wit,
          extra: { title: w.title || '' },
          minConfidence: job.minConfidence,
        });
        if (!solved || !solved.ok) {
          job.progress.worksFailed++;
          this.logLine(job, { ev: 'work-solve-fail', url: truncate(url, 120), err: truncate((solved && solved.error) || '', 200) });
          continue;
        }
        const answers = solved.plan || solved.answers || [];
        const gate = solved.gate || { ok: false, min: 0, low: [] };
        const works = this.store.get('works', {}) || {};
        works[url] = { at: new Date().toISOString(), url, answers, minConfidence: gate.min };
        this.store.set('works', works);
        job.workRecent = job.workRecent || [];
        job.workRecent.unshift({ url: truncate(url, 90), title: truncate(w.title || '', 40), min: gate.min, n: answers.length, at: new Date().toISOString() });
        job.workRecent = job.workRecent.slice(0, 10);
        this.logLine(job, { ev: 'work-answer', url: truncate(url, 120), n: answers.length, min: gate.min, low: (gate.low || []).length });
        if (!answers.length) {
          job.progress.worksSkipped++;
          this.logLine(job, { ev: 'work-skip', why: 'no-confident-answer', min: gate.min });
          continue;
        }
        if (job.dryRun || !job.autoSubmit) {
          job.progress.worksSkipped++;
          this.logLine(job, { ev: 'work-dry', answers });
          continue;
        }
        const filled = await fillWork(ctrl, answers, ctx);
        const blanks = await countBlanks(ctrl);
        // 重要：空题太多就不要交——交了只会拿低分，还浪费作业次数。
        // 默认 maxBlanks = 0：只要还有空题就放弃提交，改为保存草稿并留日志（用户可手动补交）。
        const maxBlanks = Number.isFinite(Number(job.maxBlanks)) ? Number(job.maxBlanks) : 0;
        // fail-closed：数不清空题（抓题失败/页面结构变化/CDP 超时）时按「有空题」处理，绝不提交。
        if (!blanks || blanks.ok === false || !Number.isFinite(Number(blanks.blanks))) {
          job.progress.worksSkipped++;
          const draft = await saveWorkDraft(ctrl, ctx).catch((e) => ({ ok: false, err: String((e && e.message) || e) }));
          this.logLine(job, {
            ev: 'work-blank-unknown',
            url: truncate(url, 120),
            err: truncate((blanks && blanks.err) || 'blank-count-unavailable', 160),
            filled,
            draftSaved: !!(draft && draft.ok),
          });
          continue;
        }
        this.logLine(job, { ev: 'work-blanks', total: blanks.total, blanks: blanks.blanks, byType: blanks.byType || {}, ids: blanks.ids || [] });
        if (blanks.blanks > maxBlanks) {
          job.progress.worksSkipped++;
          const skipped = await saveWorkDraft(ctrl, ctx);
          this.logLine(job, {
            ev: 'work-blank-abort',
            url: truncate(url, 120),
            blanks: blanks.blanks,
            total: blanks.total,
            byType: blanks.byType || {},
            maxBlanks,
            filled,
            draftSaved: !!(skipped && skipped.ok),
          });
          job.workRecent = job.workRecent || [];
          job.workRecent.unshift({ url: truncate(url, 90), title: truncate(w.title || '', 40), skipped: 'blanks', blanks: blanks.blanks, at: new Date().toISOString() });
          job.workRecent = job.workRecent.slice(0, 10);
          continue;
        }
        const sub = await submitWork(ctrl, ctx);
        if (sub && sub.ok) job.progress.worksSolved++;
        else job.progress.worksFailed++;
        this.logLine(job, { ev: 'work-submit', url: truncate(url, 120), ok: !!(sub && sub.ok), stage: (sub && sub.stage) || '', filled });
        await sleep(randInt(2500, 5000));
      } catch (e) {
        job.progress.worksFailed++;
        this.logLine(job, { ev: 'work-error', url: truncate(url, 120), err: truncate(e.message, 250) });
      }
    }
  }
}

/** 扫描课程：目录 + 逐节点卡片附件（不做任何计点动作） */
export async function scanCourse({ hub, store, python, account, course, concurrency = 2, limit = 0, taskWindow = false, log = () => {}, onProgress = null, shouldStop = null }) {
  const ctx = makeCtx({ store, python });
  ctx.log = (o) => log(o);
  const acc = store.get('accounts', {})[account] || { name: account, port: 9422 };
  const { page: ctrl } = await hub.ensurePage(acc);
  // 先确认登录态：未登录时 readCatalog 只会含糊地报「读取目录失败」，还会白等 5 轮。
  // 注意：导航中 evaluate 偶尔失败（execution context destroyed），此时 probeLogin 会返回
  // loggedIn:false 的兜底值——不能据此判定「未登录」，多试几次、只有真的停在登录页才算。
  let pre = null;
  for (let i = 0; i < 3; i += 1) {
    pre = await ctrl
      .goto('https://i.chaoxing.com/base', { waitMs: 6000 })
      .then(() => probeLogin(ctrl))
      .catch(() => null);
    if (pre && pre.ok) break;
    await sleep(900);
  }
  const preHref = String((pre && pre.href) || '');
  const onLoginPage = !!(pre && pre.onLoginPage && /passport\d?\.chaoxing\.com|\/login/i.test(preHref));
  log({ ev: 'scan-login', href: truncate(preHref, 120), loggedIn: !onLoginPage, probed: !!(pre && pre.ok) });
  if (onLoginPage) {
    await bringToFront(ctrl);
    throw new Error('还没有登录学习通：请点面板「登录」（或 chaoxing_account login），在弹出的 Edge 窗口扫码，登录后再点「扫描」。');
  }
  const resolved = await resolveCourse(ctrl, course, ctx);
  const c = { ...course, ...resolved };
  const catalog = await readCatalog(ctrl, c, ctx);
  const totalPoints = catalog.reduce((a, r) => a + r.points, 0);
  const pendingAll = catalog.filter((r) => r.points > 0);
  const pending = limit > 0 ? pendingAll.slice(0, limit) : pendingAll;
  const nodes = [];
  const k = clamp(concurrency, 1, 3);
  let stopped = false;
  for (let i = 0; i < pending.length; i += k) {
    if (shouldStop && shouldStop()) {
      stopped = true;
      break;
    }
    const batch = pending.slice(i, i + k);
    const out = await Promise.all(
      batch.map(async (node) => {
        let page = null;
        try {
          page = (await hub.openTaskPage(acc, { newWindow: !!taskWindow })).page;
          const args = await readCardArgs(page, c, node.kid, 0, ctx);
          return {
            ...node,
            attachments: args.ok ? args.list : [],
            scanError: args.ok ? '' : args.reason,
          };
        } catch (e) {
          return { ...node, attachments: [], scanError: truncate(e.message, 120) };
        } finally {
          if (page) await page.close().catch(() => {});
        }
      }),
    );
    nodes.push(...out);
    log({ ev: 'scan-batch', done: nodes.length, total: pending.length });
    if (onProgress) onProgress(nodes.length, pending.length);
    await sleep(randInt(1200, 2500));
  }
  const truncated = pendingAll.length > pending.length || stopped;
  const scan = {
    at: new Date().toISOString(),
    account,
    course: c,
    totalPoints,
    pendingPoints: totalPoints,
    nodeCount: catalog.length,
    pendingCount: pendingAll.length,
    scannedCount: nodes.length,
    truncated,
    partial: stopped,
    catalog,
    nodes,
  };
  store.get('scans', {})[`${account}:${course.courseid}`] = scan;
  store.touch();
  return scan;
}
