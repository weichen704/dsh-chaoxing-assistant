// 桌面客户端自动化引擎：在「学习通」客户端里刷课（视频/文档）与做题（测验）
// 依赖 lib/deskv2.mjs（WinRT OCR + 批量 PowerShell 动作）与 lib/deskflow.mjs（页面流程）
import path from 'node:path';
import fs from 'node:fs';
import { DeskV2 } from './deskv2.mjs';
import { DeskFlow, normNum } from './deskflow.mjs';
import { sleep, nowClock, randInt, fmtDur, truncate } from './util.mjs';
import { paths, appendLog } from './paths.mjs';

const APP_CANDIDATES = [
  process.env.CHAOXING_DESKTOP,
  'D:\\软件\\cxstudy\\latest\\cxstudy.exe',
  'C:\\软件\\cxstudy\\latest\\cxstudy.exe',
].filter(Boolean);

const TASK_TABS = /学习目标|视频|章节测验|作业|考试|讨论|资料/;

/** 作业作答页正文区（窗口坐标，按最大化窗口标定）；_doWork 与 _answerWorkScreen 共用 */
const WORK_AREA = { x: 240, y: 220, w: 1150, h: 880 };

export class DeskEngine {
  constructor({ store, config = {}, llm = null, log = () => {}, cu = null }) {
    this.store = store;
    this.config = config || {};
    this.llm = llm;
    this.log = log;
    // @copylee/dsh-computer-use 桥（可选）：有它就让鼠标键盘动作走它的工具
    this.cu = cu || null;
    this.jobs = new Map();
    this._seq = 0;
    this.focusCourses = [];
  }

  /** 当前输入后端信息（面板/日志里展示用） */
  inputBackend() {
    const cu = this.cu;
    if (!cu) return { mode: 'ps', available: false };
    let available = false;
    try {
      available = cu.available();
    } catch {
      available = false;
    }
    return {
      mode: this.config.desktopInput === 'ps' ? 'ps' : available ? 'auto' : 'ps',
      available,
      scale: cu.scale || 0,
      ok: cu.cuOk || 0,
      fail: cu.cuFail || 0,
    };
  }

  /**
   * 输入后端自检：只读操作（截一张图 + 算坐标缩放），不会点任何东西。
   * 用来确认「@copylee/dsh-computer-use 是否真的被接上、坐标换算对不对」。
   */
  async probeInput() {
    const info = this.inputBackend();
    const out = { ...info, at: new Date().toISOString() };
    const cu = this.cu;
    if (!cu || !info.available) {
      out.probe = { ok: false, why: info.available ? 'no-cu' : 'computer-use 工具不可见（未安装/未启用）' };
      return out;
    }
    try {
      // 先拿到窗口（UIA 物理像素矩形），再让 CU 用「同一窗口」在截图坐标里的矩形做换算
      const d = new DeskV2({ log: this.log, cu, input: this.config.desktopInput });
      try {
        await d.ensureWindow(this.appPath(), { force: false, timeoutMs: 20000 });
      } catch {
        /* 没开客户端也能自检截图能力 */
      }
      if (d.rect) cu.setWindowRect(d.rect);
      const ok = await cu.calibrate({ force: true });
      const win = (await cu.windows()) || '';
      const access = await cu.ensureAccess(['学习通']);
      out.probe = {
        ok,
        access,
        agent: cu._agentId || null,
        rect: d.rect || null,
        cuWin: cu.cuWin || null,
        shot: cu.shot || null,
        screen: cu.screen || null,
        scale: cu.scale ? Number(cu.scale.toFixed(4)) : 0,
        lastCall: cu.lastCall || null,
        diag: cu.lastDiag || null,
        examples: cu.scale && d.rect
          ? [
              { window: [100, 100], shot: cu.toShotInRect(d.rect, 100, 100) },
              { window: [900, 500], shot: cu.toShotInRect(d.rect, 900, 500) },
            ]
          : [],
        windowsSeen: String(win).split('\n').filter((l) => /学习通|cxstudy/i.test(l)).slice(0, 3),
      };
      try { d.close(); } catch { /* ignore */ }
      this.log({ ev: 'probe-input', ok, scale: out.probe.scale, cuWin: out.probe.cuWin, access });
    } catch (e) {
      out.probe = { ok: false, why: String((e && e.message) || e).slice(0, 300) };
      this.log({ ev: 'probe-input-fail', err: out.probe.why });
    }
    return out;
  }

  /** 「确定」按钮：锁定只处理某门课（扫描/刷课/作业都按它过滤） */
  setFocus(name) {
    const s = String(name || '').trim();
    this.focusCourses = s ? [s] : [];
    return this.focusCourses;
  }

  focus() {
    return this.focusCourses.slice();
  }

  appPath() {
    for (const p of APP_CANDIDATES) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch {}
    }
    return APP_CANDIDATES[0];
  }

  running() {
    return [...this.jobs.values()].find((j) => j.state === 'running' || j.state === 'starting') || null;
  }

  latest() {
    const list = [...this.jobs.values()];
    return list[list.length - 1] || null;
  }

  snapshot(job, { logLines = 0 } = {}) {
    if (!job) return { ok: true, running: false, phase: 'idle' };
    const out = {
      ok: true,
      id: job.id,
      state: job.state,
      phase: job.phase,
      account: job.account,
      startedAt: job.startedAt,
      elapsedSec: Math.round((Date.now() - job.t0) / 1000),
      elapsed: fmtDur(Math.round((Date.now() - job.t0) / 1000)),
      course: job.course,
      item: job.item,
      kind: job.kind || 'course',
      progress: { ...job.progress },
      report: Array.isArray(job.report) ? job.report.slice(0, 30) : [],
      error: job.error || '',
      logPath: job.logPath,
    };
    if (logLines > 0) out.logTail = job.logs.slice(-logLines);
    return out;
  }

  list() {
    return [...this.jobs.values()].map((j) => this.snapshot(j));
  }

  logLine(job, obj) {
    const rec = { at: nowClock(), ...obj };
    job.logs.push(rec);
    if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
    try {
      appendLog(job.logPath, rec);
    } catch {}
    this.log(rec);
  }

  stop(jobId) {
    const job = jobId ? this.jobs.get(jobId) : this.running();
    if (!job) return { ok: false, err: '没有正在运行的桌面任务' };
    job.stopRequested = true;
    job.state = 'stopped';
    job.phase = 'stopped';
    // 立刻掐掉驱动的后续重试/重启（否则窗口会反复弹出来）
    try {
      job._driver?.abort?.();
    } catch {}
    this.logLine(job, { ev: 'stop-requested' });
    return { ok: true, id: job.id };
  }

  /** 检查：客户端是否在跑、是否已登录（桌面版「检查」按钮） */
  async check() {
    const d = new DeskV2({ log: () => {}, cu: this.cu, input: this.config.desktopInput });
    try {
      const win = await d.ensureWindow(this.appPath());
      if (!win) return { ok: false, text: '学习通客户端没在运行：点「开始」或「登录」会把它拉起来' };
      const top = await d.readRegion({ x: 1300, y: 90, w: 470, h: 110 }, 1);
      const skip = /课程|首页|消息|笔记|云盘|小组|设置|搜索|找资料|邀请码/;
      const name = (top.find((i) => {
        const t = String(i.t || '').trim();
        return t.length >= 2 && t.length <= 16 && !skip.test(t) && /^[\u4e00-\u9fa5A-Za-z0-9_*·]+$/.test(t);
      }) || {}).t || '';
      const body = await d.readRegion({ x: 140, y: 140, w: 1500, h: 320 }, 1);
      const txt = body.map((i) => i.t).join(' ');
      const onList = /我的课程|我学的课|任务点进度/.test(txt);
      if (!onList && /登录|扫码|密码/.test(txt)) {
        return { ok: false, text: `客户端未登录${name ? `（${name}）` : ''}：请在学习通客户端里扫码/输密码，登录后再点「检查」` };
      }
      return { ok: true, text: `客户端已登录${name ? `（${name}）` : ''}${onList ? '，当前在课程列表' : '，窗口已就绪'}` };
    } catch (e) {
      return { ok: false, text: `检查失败：${truncate(String((e && e.message) || e), 120)}` };
    } finally {
      try {
        d.close();
      } catch {}
    }
  }

  /** 登录：确保客户端在前台；未登录时只能由用户在客户端里登录（桌面版不会打开 Edge） */
  async login() {
    const d = new DeskV2({ log: () => {}, cu: this.cu, input: this.config.desktopInput });
    try {
      const ok = await d.ensureWindow(this.appPath(), { force: true });
      if (!ok) return { ok: false, text: `没能打开学习通客户端：请检查安装路径（${this.appPath()}）` };
    } catch (e) {
      return { ok: false, text: `打开客户端失败：${truncate(String((e && e.message) || e), 120)}` };
    } finally {
      try {
        d.close();
      } catch {}
    }
    const chk = await this.check();
    return chk.ok ? chk : { ok: false, text: `${chk.text}（桌面版登录在客户端里做，不会打开 Edge）` };
  }

  /** 启动桌面版全自动：打开客户端 → 课程列表 → 逐课/逐节点刷课 */
  start({ account = 'default', courses = [], maxMinutes = 180, kinds = ['video', 'document', 'quiz'], dryRun = false, only = [] } = {}) {
    return this._startJob('course', { account, courses, kinds, dryRun, maxMinutes, only });
  }

  /** 扫描：只读不刷（课程清单 / 已完成进度 / 章节数），跑完把报告放在 job.report */
  startScan({ account = 'default', courses = [], maxMinutes = 20 } = {}) {
    return this._startJob('scan', { account, courses, maxMinutes, kinds: [], dryRun: true });
  }

  /** 作业：进每门课的「作业」列表，把未交的作业逐份打开做题并提交 */
  startWorks({ account = 'default', courses = [], maxMinutes = 120, dryRun = false } = {}) {
    return this._startJob('works', { account, courses, maxMinutes, kinds: [], dryRun: !!dryRun });
  }

  _startJob(kind, { account, courses = [], kinds = [], dryRun = false, maxMinutes = 180, only = [] }) {
    const cur = this.running();
    if (cur) return { ok: true, already: true, id: cur.id, state: cur.state, phase: cur.phase };
    this._seq += 1;
    const id = `desk_${Date.now().toString(36)}_${this._seq}`;
    const list = (Array.isArray(courses) ? courses : []).filter(Boolean);
    // 面板「确定」锁定的课程：没显式传课时就用它
    if (!list.length && this.focusCourses.length) list.push(...this.focusCourses);
    const job = {
      id,
      kind,
      state: 'starting',
      phase: 'launching',
      account,
      courses: list,
      only,
      kinds,
      dryRun,
      maxMinutes,
      t0: Date.now(),
      startedAt: new Date().toISOString(),
      progress: {
        coursesDone: 0,
        coursesTotal: 0,
        itemsDone: 0,
        itemsFailed: 0,
        itemsSkipped: 0,
        itemsPending: 0,
        videos: 0,
        docs: 0,
        quizzes: 0,
        worksFound: 0,
        worksDone: 0,
      },
      course: '',
      item: '',
      report: [],
      logs: [],
      logPath: path.join(paths().logs, `desk_${id}.jsonl`),
    };
    this.jobs.set(id, job);
    this.logLine(job, { ev: 'start', kind, account, courses: list.length, kinds: kinds.join('+'), dryRun, maxMinutes });
    this._run(job).catch((e) => {
      job.state = 'error';
      job.phase = 'error';
      job.error = truncate(String((e && e.message) || e), 300);
      this.logLine(job, { ev: 'fatal', err: job.error });
    });
    return { ok: true, id, state: job.state, phase: job.phase };
  }

  async _run(job) {
    const d = new DeskV2({ log: (o) => this.logLine(job, { ev: 'driver', ...o }), cu: this.cu, input: this.config.desktopInput });
    job._driver = d;
    const f = new DeskFlow(d, { log: (o) => this.logLine(job, o) });
    const deadline = Date.now() + Math.max(5, job.maxMinutes) * 60000;
    try {
      job.state = 'running';
      job.phase = 'launching';
      const app = this.appPath();
      // 每次开始前重启客户端：保证从「首页」干净起步，避免上次残留的多标签干扰
      d.killAll();
      await new Promise((r) => setTimeout(r, 6000));
      if (job.stopRequested) {
        this.logLine(job, { ev: 'launch-skip', why: 'stopped' });
        return;
      }
      this.logLine(job, { ev: 'launch', app });
      const launched = await d.launch(app, { waitMs: 60000 });
      await new Promise((r) => setTimeout(r, 8000));
      this.logLine(job, { ev: 'launched', ...launched });
      if (job.stopRequested) return;
      if (!launched.ok) throw new Error('学习通客户端窗口没有出现（请确认已安装并能手动打开）');

      job.phase = 'navigating';
      const home = await f.goHome();
      this.logLine(job, { ev: 'home', ok: home.ok });
      const nav = await f.goCourses();
      this.logLine(job, { ev: 'nav', ...nav });

      // 课程清单：用户指定 > store.courses
      let list = Array.isArray(job.courses) ? job.courses.filter(Boolean) : [];
      if (!list.length) {
        const all = this.store.get('courses', {});
        list = Object.entries(all)
          .filter(([k, v]) => k.startsWith(`${job.account}:`) && v && v.title)
          .map(([k, v]) => v.title);
      }
      job.progress.coursesTotal = list.length;
      this.logLine(job, { ev: 'courses', total: list.length, sample: list.slice(0, 6) });

      if (job.kind === 'scan') await this._runScan(job, d, f, deadline, list);
      else if (job.kind === 'works') await this._runWorks(job, d, f, deadline, list);
      else await this._runCourses(job, d, f, deadline, list);
      job.state = job.stopRequested ? 'stopped' : 'done';
      job.phase = job.state;
      this.logLine(job, { ev: 'end', state: job.state, input: d.inputSummary?.() || null, progress: job.progress });
    } catch (e) {
      // 用户点停止导致的 aborted 异常：安静收尾，不打印 fatal
      if (job.stopRequested || (e && e.aborted)) {
        job.state = 'stopped';
        job.phase = 'stopped';
        this.logLine(job, { ev: 'end', state: 'stopped', input: d.inputSummary?.() || null, progress: job.progress });
      } else throw e;
    } finally {
      job._driver = null;
      d.close();
    }
  }

  /** 刷课：逐门课进入 → 逐节点刷 */
  async _runCourses(job, d, f, deadline, list) {
    const one = async (name) => {
      const opened = await f.openCourse(name);
      this.logLine(job, { ev: 'course-open', course: name, ok: opened.ok });
      if (!opened.ok) {
        job.progress.itemsFailed++;
        return;
      }
      await this._runCourse(job, d, f, deadline);
      job.progress.coursesDone++;
      await f.goCourses();
    };
    await this._eachCourse(job, d, f, deadline, list, one);
  }

  /** 扫描：只读不刷，产出课程/进度/章节报告（job.report） */
  /** 客户端被切到托盘 / 崩溃后自愈：重启客户端并回到课程列表（限流，避免反复重启） */
  async _recover(job, d, f, e) {
    const msg = String((e && e.message) || e);
    const recoverable = (e && e.hidden) || /窗口不存在|隐藏/.test(msg);
    if (!recoverable || job.stopRequested || (e && e.aborted)) return false;
    if (job._recoveredAt && Date.now() - job._recoveredAt < 90000) return false;
    job._recoveredAt = Date.now();
    job.progress.recoveries = (job.progress.recoveries || 0) + 1;
    this.logLine(job, { ev: 'window-recover', why: msg.slice(0, 80), n: job.progress.recoveries });
    const ok = await d.ensureWindow(this.appPath(), { force: true });
    this.logLine(job, { ev: 'window-recover-done', ok });
    if (!ok) return false;
    await sleep(6000);
    try {
      await f.goHome();
      await f.goCourses();
    } catch { /* 导航失败就交给下一步重试 */ }
    return true;
  }

  /** 确保回到「课程列表」页：先导航，失败就返回课程再导航，最后重启客户端 */
  async _ensureList(job, d, f) {
    let nav = await f.goCourses();
    if (nav.ok) return nav;
    const back = await f.backToCourse();
    nav = await f.goCourses();
    if (nav.ok) return nav;
    this.logLine(job, { ev: 'list-recover', back: !!back });
    const ok = await d.ensureWindow(this.appPath(), { force: true });
    if (!ok) return { ok: false };
    await sleep(6000);
    await f.goHome();
    return await f.goCourses();
  }

  /** 逐门课执行，遇到「窗口隐藏/丢失」自动重启客户端并重试一次 */
  async _eachCourse(job, d, f, deadline, list, fn) {
    for (const name of list) {
      if (job.stopRequested) break;
      if (Date.now() > deadline) break;
      job.course = name;
      const atList = await this._ensureList(job, d, f);
      this.logLine(job, { ev: 'list-ready', ok: atList.ok, course: name });
      if (!atList.ok) {
        job.progress.itemsFailed++;
        this.logLine(job, { ev: 'list-fail', course: name });
        continue;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await fn(name);
          break;
        } catch (e) {
          if (e && e.aborted) throw e;
          const ok = await this._recover(job, d, f, e);
          this.logLine(job, { ev: 'course-retry', course: name, attempt: attempt + 1, recover: ok, err: String((e && e.message) || e).slice(0, 90) });
          if (!ok) throw e;
        }
      }
    }
  }

  async _runScan(job, d, f, deadline, list) {
    job.phase = 'scanning';
    const report = [];
    const reportOf = (row) => {
      report.push(row);
      job.report = report.slice();
    };
    const one = async (name) => {
      const opened = await f.openCourse(name);
      if (!opened.ok) {
        this.logLine(job, { ev: 'scan-open-fail', course: name });
        reportOf({ course: name, ok: false });
        job.progress.itemsFailed++;
        return;
      }
      const head = await d.readRegion({ x: 300, y: 140, w: 1300, h: 260 });
      const m = head.map((i) => i.t).join(' ').match(/(\d+)\s*[\/／]\s*(\d+)/);
      const chs = await f.chapters();
      const chapters = (chs.chapters || []).length;
      const row = {
        course: name,
        ok: true,
        done: m ? Number(m[1]) : null,
        total: m ? Number(m[2]) : null,
        pending: m ? Math.max(0, Number(m[2]) - Number(m[1])) : null,
        chapters,
      };
      reportOf(row);
      if (row.pending) job.progress.itemsPending += row.pending;
      job.progress.coursesDone++;
      this.logLine(job, { ev: 'scan-course', ...row });
      await f.goCourses();
    };
    await this._eachCourse(job, d, f, deadline, list, one);
    job.phase = 'done';
    this.logLine(job, { ev: 'scan-end', courses: report.length, pending: job.progress.itemsPending, report: report.slice(0, 30) });
  }

  /** 作业：进「作业」列表 → 读列表 → 打开未交 → 页头校验 → 逐屏读题作答 → 提交/暂存 → 回列表，循环到没有未交或超时 */
  async _runWorks(job, d, f, deadline, list) {
    job.phase = 'works';
    const one = async (name) => {
      const opened = await f.openCourse(name);
      if (!opened.ok) {
        this.logLine(job, { ev: 'works-course-fail', course: name });
        return;
      }
      const skip = new Set(); // 本轮已处理过的标题：答不了/已暂存/打开失败都不再重试，避免死循环
      for (let round = 0; round < 24; round++) {
        if (job.stopRequested || Date.now() > deadline) break;
        const nav = await f.goWorks();
        if (!nav.ok) {
          this.logLine(job, { ev: 'works-nav', course: name, ok: false, err: nav.err });
          const back = await f.backFromWork();
          if (!back.ok) break;
          continue;
        }
        const wl = await f.readWorks();
        const all = wl.list || [];
        const pend = all.filter((w) => w.status === '未交');
        const unk = all.filter((w) => !w.status);
        job.progress.worksFound = Math.max(job.progress.worksFound, pend.length + unk.length);
        this.logLine(job, {
          ev: 'works-list',
          course: name,
          all: all.length,
          pending: pend.length,
          unknown: unk.length,
          rows: all.map((w) => `${w.title}|${w.status || '?'}`),
        });
        // 状态没读出来的行也试：打开后由 workCtx 判定是否已有成绩（已交的会被跳过，绝不提交）
        const w = pend.concat(unk).find((x) => !skip.has(x.title));
        if (!w) break;
        job.item = w.title;
        // 用「按标题现找现点」而不是读列表时留下的坐标（列表读完已经滚到底，坐标会指到别的行）
        const openedWork = await f.openWork(w.title);
        this.logLine(job, { ev: 'work-click', title: w.title, ok: openedWork.ok, x: openedWork.x, y: openedWork.y, err: openedWork.err });
        if (!openedWork.ok) {
          skip.add(w.title);
          continue;
        }
        await sleep(3000);
        const ctx = await f.workCtx();
        this.logLine(job, { ev: 'work-open', title: w.title, tab: truncate(ctx.tab, 40), done: ctx.done, isWork: ctx.isWork, expect: ctx.expect });
        if (!ctx.isWork) {
          skip.add(w.title);
          this.logLine(job, { ev: 'work-page', title: w.title, ok: false, why: ctx.done ? 'already-done' : 'not-work-page' });
          const back = await f.backFromWork();
          if (!back.ok) break;
          continue;
        }
        const r = await this._doWork(job, d, f, deadline);
        this.logLine(job, { ev: 'work-end', title: w.title, ...r });
        if (r && r.submitted) job.progress.worksDone++;
        skip.add(w.title);
        const back = await f.backFromWork();
        this.logLine(job, { ev: 'work-back', ok: back.ok, via: back.via });
        await sleep(1200);
      }
      job.progress.coursesDone++;
    };
    await this._eachCourse(job, d, f, deadline, list, one);
    job.phase = 'done';
    this.logLine(job, { ev: 'works-end', found: job.progress.worksFound, done: job.progress.worksDone });
  }

  async _hashArea(d, box) {
    try {
      const r = await d.actions([{ cmd: 'hash', x: box.x, y: box.y, w: box.w, h: box.h }], 60000);
      return (r && r.results && r.results[0] && r.results[0].hash) || '';
    } catch {
      return '';
    }
  }

  /** 作答一份作业：逐屏读题 → 模型作答 → 选择题点选/填空题填文字 → 校验 → 提交或暂时保存 */
  async _doWork(job, d, f, deadline) {
    const ctx = await f.workCtx();
    if (ctx.done) {
      this.logLine(job, { ev: 'work-skip', why: 'page-done' });
      return { ok: true, skipped: true, why: 'page-done' };
    }
    const AREA = { x: 240, y: 220, w: 1150, h: 880 };
    // 回顶部：只滚键盘，不点选项行（点了会误选答案）
    await d.actions([{ cmd: 'key', seq: '{HOME}' }, { cmd: 'sleep', ms: 1200 }]);
    const seen = new Map(); // sig -> 题（已完整解析）
    const seenKeys = new Set(); // 题型#题号（防相邻屏 OCR 字差导致的重复作答）
    const answered = new Set(); // 已作答的 sig
    const answeredKeys = new Set(); // 已作答的「题型#题号」（题干前 16 字撞车时的兜底账）
    const fillTexts = new Map(); // sig -> 填过的文字
    const lateFills = []; // 空位落在屏幕下边缘没填上的：下一屏滚上来后重填
    const secTotals = new Map(); // 分节标题 -> 共N题
    let section = '';
    let noeffect = false; // 作答后画面没变化（输入没生效）
    // 一遍扫描：qs 里除最后一题外都已完整（后面出现了下一题），可以安全作答；
    // 最后一题可能被屏幕底边截断，留到下一屏（小步滚动有重叠）或页尾再答。
    const pass = async (withTail) => {
      const lines = this._lines(await d.readRegion(AREA, 2));
      for (const l of lines) {
        const m = String(l.t || '').replace(/\s+/g, '').match(/共(\d+)题/);
        if (m) {
          const label = String(l.t || '').replace(/\s+/g, '').replace(/共\d+题.*$/, '');
          secTotals.set(label || `s${secTotals.size}`, Number(m[1]));
        }
      }
      const secHit = lines.map((l) => /(单选题|多选题|填空题|判断题)/.exec(String(l.t || ''))).find(Boolean);
      if (secHit) section = secHit[1];
      const qs = extractWorkQuestions(lines, { section });
      // 上一屏因为「贴着下边缘」没填的空位：这一屏它已经滚上 300px，按新坐标重填
      for (let i = lateFills.length - 1; i >= 0; i--) {
        const e = lateFills[i];
        const ny = Math.round(e.y) - 300;
        if (ny < AREA.y + 60) {
          lateFills.splice(i, 1); // 已经滚出屏幕上沿，放弃（记 unfilled 走草稿）
          continue;
        }
        e.y = ny;
        if (ny > AREA.y + AREA.h - 170) continue; // 还在下边缘，再等一屏
        if (await this._fillBlank(job, d, { x: e.x, y: ny }, e.val)) {
          if (e.n === 1) fillTexts.set(e.sig, e.val);
          lateFills.splice(i, 1);
        } else if (ny < AREA.y + 200) lateFills.splice(i, 1); // 快到上沿还填不上，别死磕
      }
      // 只有「被屏幕底边截断」的那题才留到下一屏（小步滚动有重叠，下一屏会重新完整解析）；
      // 之前一律丢最后一题，导致一屏只解析出 1 题时首题永远不答 → 白判「未作答」转草稿。
      const yBot = AREA.y + AREA.h;
      const cutOff = (q) => {
        const ys = q.opts.map((o) => o.y).concat(q.blanks.map((b) => b.y));
        return ys.length ? Math.max(...ys) > yBot - 110 : true;
      };
      const closed = qs.filter((q) => !cutOff(q));
      const tail = qs.length ? qs[qs.length - 1] : null;
      const pick = withTail && tail ? closed.concat([tail]) : closed;
      // 同一道题在相邻两屏的 OCR 会有字差（「易爆」→「勿曰爆」），只按题干去重会重复作答；
      // 多选重复点同一个字母等于取消勾选 → 再用「题型+题号」兜一层（题号是 0 的不算，避免误杀）。
      const qkey = (q) => (Number(q.num) > 0 ? `${q.type}#${Number(q.num)}` : '');
      const fresh = pick.filter((q) => {
        const s = workSig(q);
        if (!s || seen.has(s)) return false;
        const k = qkey(q);
        if (k && seenKeys.has(k)) return false;
        seen.set(s, q);
        if (k) seenKeys.add(k);
        return true;
      });
      this.logLine(job, { ev: 'work-scan', screen: seen.size, lines: lines.length, qs: qs.length, fresh: fresh.map((q) => `${q.num}:${String(q.type).slice(0, 1)}${q.opts.length}/${q.blanks.length}`) });
      if (fresh.length && !job.dryRun) {
        const h0 = await this._hashArea(d, AREA);
        const r = await this._answerWorkScreen(job, d, fresh);
        r.sigs.forEach((s) => answered.add(s));
        (r.keys || []).forEach((k) => k && answeredKeys.add(k));
        for (const [s, t] of r.texts) fillTexts.set(s, t);
        if (r.late && r.late.length) lateFills.push(...r.late);
        // 点选项但画面像素没变 → 点击没生效（cu 失效时会出现），不能当已作答。
        // 填空题另有一路「回读输入框」的校验，不靠像素哈希（光标/滚动会让哈希乱变）。
        if (r.choice && h0 && (await this._hashArea(d, AREA)) === h0) {
          noeffect = true;
          this.logLine(job, { ev: 'work-answer-noeffect', n: r.sigs.length });
        }
      }
      return { tail, hasTail: !!(withTail && tail), text: lines.map((l) => String(l.t || '')).join('\u0001') };
    };
    let screens = 0;
    let same = 0;
    let lastText = '';
    // 一屏 880px 高、每次只滚 300px（滚轮 2 格）：题被下边缘截断时，下一屏它的题干仍在屏内，
    // 整题完整重读（靠跨屏续接的话只有后半截选项，A/B/C 字母会错位 → 点错答案）。
    // 34 题的大作业整页约 13760px，64 屏才够；正常情况靠「本屏原文没变」提前收工。
    let moved = true;
    while (!job.stopRequested && Date.now() < deadline && screens < 64 && same < 2) {
      screens++;
      const r = await pass(false);
      const h0 = await this._hashArea(d, AREA);
      await f.scrollWork(AREA, 'down', 2);
      const h1 = await this._hashArea(d, AREA);
      // 到底了：文字没变，或像素没变（填空光标闪烁会让 hash 一直在变，所以以文字为准）
      moved = r.text !== lastText || (h1 && h0 && h1 !== h0);
      lastText = r.text || '';
      if (!moved) same++;
      else same = 0;
    }
    // 页尾：最后一屏不再滚动，把那道被截断的题也答掉
    if (!job.stopRequested && Date.now() < deadline) await pass(true);
    // 复检：扫描全程可能有个别题「解析到了但没点中 / 填空框贴下边缘被丢弃」。用户实测的
    // 「个别题目没做 + 填空题没完成」就是这么漏的 → 回顶后逐屏再走一遍，只补这些题。
    const pendingList = () => {
      const list = [];
      for (const q of seen.values()) {
        const s = workSig(q);
        if (!s) continue;
        const k = Number(q.num) > 0 ? `${q.type || 'q'}#${Number(q.num)}` : '';
        const doneC = q.opts.length >= 2 ? (answered.has(s) || (k && answeredKeys.has(k))) : true;
        const doneF = q.blanks.length ? (fillTexts.has(s) || (k && answeredKeys.has(k))) : true;
        if (!doneC || !doneF) list.push(q);
      }
      return list;
    };
    if (!job.dryRun && Date.now() < deadline) {
      const pend0 = pendingList();
      if (pend0.length) {
        this.logLine(job, { ev: 'work-revisit', n: pend0.length, nums: pend0.map((q) => q.num) });
        await this._revisitWork(job, d, f, AREA, pendingList, answered, answeredKeys, fillTexts);
      }
    }
    const qsAll = [...seen.values()];
    const secSum = [...secTotals.values()].reduce((a, b) => a + b, 0);
    // 题量三路互校：页头「题量：N」（常读丢 → 0）、分节「共N题」求和（每节都要 OCR 一次，
    // 读到一处错数就把总数抬飞：实测 13 读成 18 → secSum=40 而真值 35 → 永远 okParse=false）、
    // 已解析题号的最大值（35 题作业就是 35）。取「分节求和」与「最大题号」的较小者，
    // 单路读坏不会把阈值抬高；页头读到了则以页头为准（它是页面自己写的总数）。
    const numMax = qsAll.reduce((m, q) => Math.max(m, Number(q.num) || 0), 0);
    const guess = secSum && numMax ? Math.min(secSum, numMax) : secSum || numMax || 0;
    const expect = Math.max(Number(ctx.expect) || 0, guess, qsAll.length);
    const left = pendingList();
    const unfilled = left.filter((q) => q.blanks.length);
    const unanswered = left.filter((q) => q.opts.length >= 2);
    const okParse = qsAll.length >= Math.max(1, Math.ceil(expect * 0.9));
    const okFill = !unfilled.length && !unanswered.length && !noeffect;
    this.logLine(job, {
      ev: 'work-status',
      expect,
      secSum,
      numMax,
      found: qsAll.length,
      answered: answered.size,
      filled: fillTexts.size,
      unfilled: unfilled.map((q) => q.num),
      unanswered: unanswered.map((q) => q.num),
      noeffect,
      okParse,
      okFill,
    });
    if (job.dryRun) return { ok: true, submitted: false, dry: true, found: qsAll.length };
    // 提交前再复核一次页头：绝不在已有成绩/待批阅的页面上点提交
    const again = await f.workCtx();
    if (again.done) {
      this.logLine(job, { ev: 'work-skip', why: 'page-done-after-answer' });
      return { ok: true, skipped: true, why: 'page-done' };
    }
    if (!okParse || !okFill) {
      const why = !okParse ? 'parse-incomplete' : 'answer-incomplete';
      const saved = await this._saveDraft(d);
      this.logLine(job, { ev: 'work-save', ok: saved, why });
      return { ok: true, submitted: false, saved, why };
    }
    return await this._submitWork(job, d, f);
  }

  /** 一屏内：模型作答（solveWork）→ 选择题点选项、填空题点框写文字 */
  /** 复检：回顶后逐屏只补「还没作上/还没填上」的题；每题都用本屏最新坐标重新解析 */
  async _revisitWork(job, d, f, AREA, pendingList, answered, answeredKeys, fillTexts) {
    try {
      await d.actions([{ cmd: 'key', seq: '{HOME}' }, { cmd: 'sleep', ms: 1400 }]);
      let same = 0;
      let screens = 0;
      let last = '';
      while (screens < 64 && same < 2 && !job.stopRequested) {
        screens++;
        const pend = pendingList();
        if (!pend.length) break;
        const pendSet = new Set(pend.map((q) => workSig(q)));
        const lines = this._lines(await d.readRegion(AREA, 2));
        const qs = extractWorkQuestions(lines, {});
        const hit = qs.filter((q) => pendSet.has(workSig(q)));
        if (hit.length) {
          const r = await this._answerWorkScreen(job, d, hit, { minConfidence: 0.35 });
          r.sigs.forEach((s) => answered.add(s));
          (r.keys || []).forEach((k) => k && answeredKeys.add(k));
          for (const [s2, t] of r.texts) fillTexts.set(s2, t);
          if (r.late && r.late.length) {
            for (const e of r.late) {
              if (await this._fillBlank(job, d, { x: e.x, y: e.y }, e.val)) {
                fillTexts.set(e.sig, e.val);
              }
            }
          }
          this.logLine(job, { ev: 'work-revisit-screen', screen: screens, hit: hit.map((q) => q.num), got: r.sigs.length });
        }
        const text = lines.map((l) => String(l.t || '')).join('\u0001');
        same = text === last ? same + 1 : 0;
        last = text;
        await f.scrollWork(AREA, 'down', 2);
      }
      const leftNums = pendingList().map((q) => q.num);
      this.logLine(job, { ev: 'work-revisit-end', left: leftNums });
    } catch (e) {
      this.logLine(job, { ev: 'work-revisit-fail', err: truncate(String(e && e.message), 160) });
    }
  }

  async _answerWorkScreen(job, d, qs, opts = {}) {
    const out = { sigs: [], keys: [], texts: [], choice: 0, late: [] };
    // 「题型#题号」兜底键：题干前 16 字相同的两道题（题库里很常见）sig 会撞车，
    // 只按 sig 记账会把后一道当成已作答 → 复检时报「个别题目没做」。
    const qkey = (q) => (Number(q && q.num) > 0 ? `${q.type || 'q'}#${Number(q.num)}` : '');
    let plan = null;
    try {
      const { solveWork } = await import('./solver.mjs');
      const items = qs.map((q, i) => ({
        i,
        stem: q.stem,
        opts: q.opts.map((o) => ({ letter: o.letter, text: o.text })),
        type: q.opts.length >= 2 ? q.type || 'single' : 'text',
      }));
      const r = await solveWork({ llm: this.llm, log: (o) => this.logLine(job, o), course: job.course, items, extra: { via: 'desktop' }, minConfidence: opts.minConfidence ?? this.config.minConfidence ?? 0.6 });
      plan = r && r.ok ? r.plan : null;
      this.logLine(job, { ev: 'work-solve', ok: !!(r && r.ok), n: plan ? plan.length : 0, err: r && r.error });
    } catch (e) {
      this.logLine(job, { ev: 'work-solve-fail', err: truncate(String(e && e.message), 200) });
      return out;
    }
    if (!plan || !plan.length) return out;
    for (const p of plan) {
      const q = qs[p.i];
      if (!q) continue;
      // 模型给的答案格式不固定（"A" / "A对" / "对" / "AB" / ["A","B"]），先统一成字母表
      const letters = this._answerLetters(p, q);
      if (q.opts.length >= 2 && letters.length) {
        let clicked = 0;
        for (const L of letters) {
          const o = q.opts.find((x) => String(x.letter).toUpperCase() === L);
          if (o) {
            await d.actions([{ cmd: 'click', x: o.x + 6, y: o.y + Math.round((o.h || 20) / 2) }, { cmd: 'sleep', ms: 260 }]);
            clicked++;
          }
        }
        if (clicked) {
          out.sigs.push(workSig(q));
          const k = qkey(q);
          if (k) out.keys.push(k);
          out.choice++;
        } else {
          this.logLine(job, { ev: 'work-answer-miss', num: q.num, type: q.type, letters, opts: q.opts.map((o) => `${o.letter}${String(o.text).slice(0, 4)}`) });
        }
      } else if (q.blanks.length && p.text) {
        // 填空只要「答案本身」，模型爱写成一段话 → 截到第一个句读（≤40 字），太长的句子不填
        const text = this._blankText(p.text);
        const parts = q.blanks.length > 1 ? text.split(/[；;]/).map((s) => s.trim()).filter(Boolean) : [text];
        let ok = 0;
        for (let i = 0; i < q.blanks.length; i++) {
          const b = q.blanks[i];
          const val = parts[i] || parts[0] || text;
          // 空位落在屏幕下边缘（底 -170）时点击会落空或点到页脚 → 记进 late，下一屏滚 300px 后重填
          if (Number(b.y) > WORK_AREA.y + WORK_AREA.h - 170) {
            out.late.push({ sig: workSig(q), n: q.blanks.length, x: b.x, y: b.y, val });
            continue;
          }
          if (await this._fillBlank(job, d, b, val)) ok++;
        }
        const deferred = out.late.some((x) => x.sig === workSig(q));
        // 必须所有空都填上才算这题答完（少一个就转草稿，别硬交）
        if (ok && ok >= q.blanks.length && !deferred) {
          out.sigs.push(workSig(q));
          const k2 = qkey(q);
          if (k2) out.keys.push(k2);
          out.texts.push([workSig(q), text]);
        }
      }
    }
    this.logLine(job, { ev: 'work-fill', n: out.sigs.length, texts: out.texts.map(([, t]) => t).slice(0, 6) });
    return out;
  }

  /**
   * 把模型给的答案统一成选项字母：
   *  ["A"] / "A" / "A、B" / "AB" / "A对" / "对" / "√" / "正确" 都能认；
   * 判断题（选项就是对/错）模型爱直接答「对」「错」，落不到字母上 → 这里补成 A/B。
   */
  _answerLetters(p, q) {
    const raw = [];
    if (Array.isArray(p.letters)) raw.push(...p.letters);
    if (p.text) raw.push(p.text);
    if (Array.isArray(p.texts)) raw.push(...p.texts);
    const set = new Set();
    for (const r of raw) {
      const s = String(r === undefined || r === null ? '' : r).trim();
      if (!s) continue;
      for (const ch of s.split(/[,，、;；/\s]+/)) {
        if (!ch) continue;
        if (/^[A-Fa-f]{2,}$/.test(ch)) {
          for (const c of ch.toUpperCase()) set.add(c);
          continue;
        }
        const m = /^([A-Fa-f])(?![A-Za-z])/.exec(ch);
        if (m) {
          set.add(m[1].toUpperCase());
          continue;
        }
        if (/^(对|√|✓|正确|是|t|true)$/i.test(ch)) set.add('A');
        else if (/^(错|×|✗|错误|否|f|false)$/i.test(ch)) set.add('B');
      }
    }
    // 答的是选项原文（判断题常见）：按文字前缀找字母
    if (!set.size && (p.text || (p.texts && p.texts.length))) {
      const want = String(p.text || p.texts[0] || '').trim();
      if (want) {
        const hit = q.opts.find((o) => String(o.text).trim() === want) || q.opts.find((o) => want && (String(o.text).includes(want) || want.includes(String(o.text).trim())));
        if (hit) set.add(String(hit.letter).toUpperCase());
      }
    }
    return [...set].filter((L) => q.opts.some((o) => String(o.letter).toUpperCase() === L));
  }

  /** 模型填空答案规整：只要答案本身，长句截到第一个句读（≤40 字） */
  _blankText(s) {
    const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
    if (t.length <= 40) return t;
    const m = /^(.{4,40}?)[。；;，,、]/.exec(t);
    return m ? m[1] : t.slice(0, 40);
  }

  /** 填一个空：点「第N空」→ 真实键入 → 回读校验；返回是否确认填上 */
  async _fillBlank(job, d, b, val) {
    // 点进输入框会让内容区自动滚动 → 每次现 OCR 一次「第N空」标签，用最新坐标点，
    // 否则用上一屏的旧 y 去点会点到别的行（实测 y 偏移 ≈113px 就完全点空）。
    let ty = Math.round(b.y);
    try {
      const strip = { x: Math.max(0, Math.round(b.x) - 500), y: Math.max(0, Math.round(b.y) - 160), w: 1000, h: 320 };
      const near = this._lines(await d.readRegion(strip, 2))
        .map((l) => ({ y: Math.round(l.y), t: String(l.t || '').replace(/\s+/g, '') }))
        .filter((l) => /^第\d+空$/.test(l.t) && Math.abs(l.y - b.y) < 170)
        .sort((x, y) => Math.abs(x.y - b.y) - Math.abs(y.y - b.y));
      if (near.length) ty = near[0].y;
    } catch {
      /* 用原坐标 */
    }
    const put = async (px = b.x, py = ty) => {
      // 学习通作业页的填空 input 只认真实键入（CU type），合成 Ctrl+V 会被吞掉
      try {
        if (typeof d.fillInRect === 'function' && d.cu) {
          await d.fillInRect(d.rect, Math.round(px), Math.round(py), val);
          await d.actions([{ cmd: 'sleep', ms: 600 }]);
          return;
        }
      } catch {
        /* 回退到粘贴 */
      }
      await d.actions([
        { cmd: 'click', x: Math.round(px), y: Math.round(py) },
        { cmd: 'sleep', ms: 500 },
        { cmd: 'paste', text: val },
        { cmd: 'sleep', ms: 900 },
      ]);
    };
    // 输入框那一条带：既用来回读（放大 3 倍更清楚），也用来做像素校验
    const band = { x: 300, y: Math.max(0, ty - 26), w: 1000, h: 54 };
    // 校验一：OCR 能不能读出答案开头（读得出就一定填进去了）
    const head = val.slice(0, 6).replace(/\s+/g, '');
    const findIn = async () => {
      if (!head) return false;
      const all = this._lines(await d.readRegion(WORK_AREA, 2)).map((l) => String(l.t || '')).join('').replace(/\s+/g, '');
      if (all.includes(head)) return true;
      // 整页 OCR 常读不清输入框里的小字 → 把这一条带放大 3 倍再读一次
      try {
        const line = (await d.readRegion(band, 3)).map((i) => String(i.t || '')).join('').replace(/\s+/g, '');
        return !!line && line.includes(head.slice(0, 4));
      } catch {
        return false;
      }
    };
    const h0 = await this._hashArea(d, band);
    // 草稿里可能已经是同一句 → 别再粘一遍（会变成两遍）
    if (await findIn()) return true;
    await put();
    let got = await findIn();
    if (!got) {
      await put();
      got = await findIn();
    }
    if (!got) {
      // 换到框体中部再试一次：有的输入框只有点在文字区才聚焦
      await put(Math.round(b.x) + 260);
      got = await findIn();
    }
    if (got) return true;
    const h1 = await this._hashArea(d, band);
    if (h0 && h1 && h1 !== h0) {
      this.logLine(job, { ev: 'work-fill-unverified', x: b.x, y: ty, len: val.length });
      return true;
    }
    this.logLine(job, { ev: 'work-fill-fail', x: b.x, y: ty, len: val.length, h0: !!h0, h1: !!h1 });
    return false;
  }

  /** 页头按钮（暂时保存 / 提交）：先 OCR 小字，认不到就按「提交 = 暂时保存右移 148px」兜底 */
  async _headButtons(d) {
    for (const scale of [2, 3]) {
      const items = await d.readRegion({ x: 1300, y: 100, w: 520, h: 100 }, scale);
      const save = items.find((i) => /^暂时保存$/.test(String(i.t || '').trim()));
      const sub = items.find((i) => /^提交$/.test(String(i.t || '').trim()) || /^提交作业$/.test(String(i.t || '').trim()));
      if (save || sub) {
        const base = save || sub;
        return {
          save: save ? { x: save.x, y: save.y } : { x: base.x - 148, y: base.y },
          submit: sub ? { x: sub.x, y: sub.y } : { x: base.x + 148, y: base.y },
        };
      }
    }
    return null;
  }

  async _saveDraft(d) {
    const btn = await this._headButtons(d);
    if (!btn) return false;
    await d.actions([{ cmd: 'click', x: btn.save.x, y: btn.save.y }, { cmd: 'sleep', ms: 2000 }]);
    // 可能有「确定保存？」二次弹窗
    const tips = await d.readRegion({ x: 400, y: 200, w: 1100, h: 700 }, 1);
    const yes = tips.find((i) => /^(确定|确认|是|保存|继续)$/.test(String(i.t || '').trim()));
    if (yes) await d.actions([{ cmd: 'click', x: yes.x, y: yes.y }, { cmd: 'sleep', ms: 1500 }]);
    // 草稿是兜底动作：点到了就算（不弹 toast 的版本没法像素级确认）
    return true;
  }

  async _submitWork(job, d, f) {
    const btn = await this._headButtons(d);
    if (!btn) {
      this.logLine(job, { ev: 'work-submit-miss' });
      return { ok: false, submitted: false, why: 'submit-button-not-found' };
    }
    await d.actions([{ cmd: 'click', x: btn.submit.x, y: btn.submit.y }, { cmd: 'sleep', ms: 2500 }]);
    // 二次确认弹窗
    const tip = await d.readRegion({ x: 400, y: 250, w: 1100, h: 700 }, 1);
    const tipText = tip.map((i) => i.t).join('');
    const yes = tip.find((i) => /^(确定|确认|是|提交|继续提交)$/.test(String(i.t || '').trim()));
    this.logLine(job, { ev: 'work-submit-dialog', text: truncate(tipText, 120), yes: !!yes });
    if (yes) await d.actions([{ cmd: 'click', x: yes.x, y: yes.y }, { cmd: 'sleep', ms: 2500 }]);
    const after = await f.workCtx();
    // 客户端有的版本提交后直接回列表（页面变成「待批阅」），有的只弹 toast 停在作答页 →
    // 「点到了就算交」但把 verified 写进日志；真正的结果以下次重读列表的状态为准。
    const confirmed = after.done || /提交成功|已提交|待批阅|成绩|已完成/.test(after.head + after.tab);
    this.logLine(job, { ev: 'work-submit', ok: true, verified: confirmed, tab: truncate(after.tab, 40), head: truncate(after.head, 80) });
    return { ok: true, submitted: true, verified: confirmed };
  }

  async _runCourse(job, d, f, deadline) {
    // 课程页：读「已完成任务点：a/b」，b===a 视为整课完成
    const head = await d.readRegion({ x: 300, y: 140, w: 1300, h: 260 });
    const headText = head.map((i) => i.t).join(' ');
    const m = headText.match(/(\d+)\s*[\/／]\s*(\d+)/);
    let before = -1;
    if (m) {
      before = Number(m[1]);
      const total = Number(m[2]);
      this.logLine(job, { ev: 'course-progress', course: job.course, done: before, total });
      if (total > 0 && before >= total) {
        job.progress.itemsSkipped++;
        this.logLine(job, { ev: 'course-skip', why: 'all-done' });
        return;
      }
    }
    // 进入「章节」页（若已经在章节页则直接读目录）
    let chs = await f.chapters();
    this.logLine(job, { ev: 'chapters', course: job.course, count: (chs.chapters || []).length, via: chs.via });
    if (!chs.ok) {
      job.progress.itemsFailed++;
      return;
    }
    // 逐条目：读可见目录 → 打开最靠前未处理的 → 处理 → 返回课程页 → 继续；目录滚到底仍无新条目则结束
    const handled = new Set();
    let emptyPasses = 0;
    for (let guard = 0; guard < 300; guard++) {
      if (job.stopRequested || Date.now() > deadline) break;
      const cur = await f.readChapters();
      if (!cur.ok) {
        const back = await f.backToCourse();
        this.logLine(job, { ev: 'recover-course', ok: back });
        if (!back) break;
        continue;
      }
      const next = cur.chapters.find((c) => !handled.has(normNum(c.t)));
      if (!next) {
        if (emptyPasses >= 2) break;
        emptyPasses++;
        const moved = await f.scrollList();
        this.logLine(job, { ev: 'list-scroll', moved });
        if (!moved) break;
        continue;
      }
      emptyPasses = 0;
      handled.add(normNum(next.t));
      job.item = next.t;
      await f.clickItem(next);
      // 等正文标题切换成目标条目，再判断「任务点已完成」，否则会读到上一条目的状态
      let titled = await f.waitTaskTitle(next.t);
      if (!(await f.isTaskPage())) {
        // 客户端里点条目有时第一次只弹 tooltip（「N个待完成任务点」），再点一次就进去了
        await sleep(500);
        await f.clickItem(next);
        titled = (await f.waitTaskTitle(next.t, { timeoutMs: 6000 })) || titled;
      }
      await sleep(900);
      if (!(await f.isTaskPage())) {
        // 第三次：双击（换个上偏移，避开条目文字被 tooltip 覆盖的位置）
        await f.clickItem(next, { offsetY: -6 });
        await sleep(400);
        await f.clickItem(next);
        titled = (await f.waitTaskTitle(next.t, { timeoutMs: 6000 })) || titled;
        await sleep(800);
      }
      if (!(await f.isTaskPage())) {
        this.logLine(job, { ev: 'item-open-fail', item: next.t, titled });
        job.progress.itemsFailed++;
        await f.backToCourse();
        continue;
      }
      // 条目级「任务点已完成」不可靠（只在当前标签页显示），改为逐个标签页判断
      this.logLine(job, { ev: 'item-open', item: next.t });
      await this._runTaskPage(job, d, f, deadline);
      const back = await f.backToCourse();
      if (!back) {
        // 回不去就重新从课程列表进一次
        const nav = await f.goCourses();
        const op = nav.ok ? await f.openCourse(job.course) : { ok: false };
        const ch2 = op.ok ? await f.chapters() : { ok: false };
        this.logLine(job, { ev: 'renav', nav: nav.ok, course: op.ok, chapters: ch2.ok });
        if (!ch2.ok) break;
      }
    }
    // 收尾对比任务点进度
    const after = await d.readRegion({ x: 300, y: 140, w: 1300, h: 260 });
    const am = after.map((i) => i.t).join(' ').match(/(\d+)\s*[\/／]\s*(\d+)/);
    if (am) this.logLine(job, { ev: 'course-progress-after', course: job.course, done: Number(am[1]), total: Number(am[2]), delta: before >= 0 ? Number(am[1]) - before : null });
  }

  async _runTaskPage(job, d, f, deadline) {
    const kinds = job.kinds || [];
    const tabs = await f.taskTabs();
    this.logLine(job, { ev: 'tabs', tabs: tabs.map((t) => t.label) });
    const want = [];
    for (const t of tabs) {
      const label = t.label || '';
      if (/视频|录像/.test(label) && kinds.includes('video')) want.push({ re: /视频|录像/, kind: 'video', label });
      else if (/学习目标|资料|文档|阅读/.test(label) && kinds.includes('document')) want.push({ re: /学习目标|资料|文档|阅读/, kind: 'document', label });
      else if (/测验|测试|作业|考试/.test(label) && kinds.includes('quiz')) want.push({ re: /测验|测试|作业|考试/, kind: 'quiz', label });
    }

    // 标签没读到（页面结构不同/已滚动）→ 按正文内容猜任务类型
    if (!want.length) {
      const page = await d.readRegion({ x: 300, y: 250, w: 1300, h: 700 });
      const txt = page.map((i) => i.t).join(' ');
      this.logLine(job, { ev: 'tabs-fallback', sample: txt.slice(0, 80) });
      const quizLike = /单选题|多选题|判断题|填空题/.test(txt) && /提交|交卷/.test(txt);
      if (kinds.includes('quiz') && quizLike) want.push({ kind: 'quiz', re: null, label: 'quiz?' });
      else if (kinds.includes('video') && /播放|暂停/.test(txt)) want.push({ kind: 'video', re: null, label: 'video?' });
      else if (kinds.includes('document')) want.push({ kind: 'document', re: null, label: 'doc?' });
    }

    let handled = 0;
    for (const w of want) {
      if (job.stopRequested || Date.now() > deadline) break;
      if (w.re) {
        const r = await f.openTab(w.re);
        this.logLine(job, { ev: 'tab-open', tab: r.tab || w.kind, ok: r.ok, tabs: r.tabs });
        if (!r.ok) continue;
        await sleep(1600);
      }
      // 每个标签页各自判断「这个任务点是否已完成」——整条目完成不等于每个标签都完成
      if (await this._tabDone(d, w.kind)) {
        job.progress.itemsSkipped++;
        this.logLine(job, { ev: 'tab-skip', tab: w.label, kind: w.kind, why: 'done' });
        continue;
      }
      if (w.kind === 'video') await this._doVideo(job, d, f, deadline);
      else if (w.kind === 'document') await this._doDoc(job, d, f, deadline);
      else if (w.kind === 'quiz') await this._doQuiz(job, d, f, deadline);
      handled++;
    }
    if (handled === 0) job.progress.itemsSkipped++;
    else job.progress.itemsDone++;
  }

  /** 当前标签页是否已完成（视频/文档有「任务点已完成」；测验看成绩/已提交） */
  async _tabDone(d, kind) {
    const head = await d.readRegion({ x: 300, y: 240, w: 1200, h: 300 });
    const txt = head.map((i) => i.t).join(' ');
    if (/任务点已完成/.test(txt)) return true;
    if (kind === 'quiz') return /本次成绩|已提交|得分[:：]\s*\d|已完成/.test(txt);
    return false;
  }


  /** 悬停播放器读时间条（时间只在鼠标悬停时显示）：返回 {ok,cur,total} 秒 */
  async _videoPos(d, vbox) {
    await d.actions([{ cmd: 'move', x: Math.round(vbox.x + vbox.w / 2), y: Math.round(vbox.y + vbox.h - 40) }, { cmd: 'sleep', ms: 400 }]);
    const strip = await d.readRegion({ x: vbox.x - 10, y: vbox.y + vbox.h - 90, w: 620, h: 70 }, 1);
    const txt = strip.map((i) => i.t).join(' ');
    const m = txt.match(/(\d{1,2})[:：](\d{2})\s*[/／]\s*(\d{1,2})[:：](\d{2})/);
    if (!m) return { ok: false, txt: txt.slice(0, 60) };
    return { ok: true, cur: Number(m[1]) * 60 + Number(m[2]), total: Number(m[3]) * 60 + Number(m[4]), txt };
  }

  async _doVideo(job, d, f, deadline) {
    // 先看是否已完成（视频页头部有「任务点已完成」）
    let head = await d.readRegion({ x: 300, y: 260, w: 1100, h: 220 });
    if (head.some((i) => /任务点已完成/.test(i.t))) {
      this.logLine(job, { ev: 'video-skip', why: 'done' });
      return;
    }
    const vbox = { x: 420, y: 360, w: 880, h: 600 };
    const cx = Math.round(vbox.x + vbox.w / 2);
    const cy = Math.round(vbox.y + vbox.h / 2);
    // 播放按钮在画面中央偏右（overlay），点几个候选点，直到画面开始变化
    const cands = [
      { x: 973, y: 792 },
      { x: Math.round(vbox.x + vbox.w / 2), y: Math.round(vbox.y + vbox.h / 2) },
      { x: 860, y: 700 },
    ];
    let playing = false;
    for (const c of cands) {
      const h0 = (await d.actions([{ cmd: 'hash', x: vbox.x, y: vbox.y, w: vbox.w, h: vbox.h }], 60000)).results?.[0]?.hash;
      await d.actions([{ cmd: 'click', x: c.x, y: c.y }, { cmd: 'sleep', ms: 2600 }]);
      const h1 = (await d.actions([{ cmd: 'hash', x: vbox.x, y: vbox.y, w: vbox.w, h: vbox.h }], 60000)).results?.[0]?.hash;
      if (h1 && h1 !== h0) { playing = true; this.logLine(job, { ev: 'video-play', x: c.x, y: c.y }); break; }
    }
    if (!playing) this.logLine(job, { ev: 'video-play', x: cands[0].x, y: cands[0].y, warn: 'hash-same' });
    const t0 = Date.now();
    let resumes = 0;
    let elapsed = 0;
    let ticks = 0;
    let lastCur = -1;
    let lastHash = '';
    let same = 0;
    let posOk = null;
    while (!job.stopRequested && Date.now() < deadline && resumes < 30) {
      const a = await this._videoPos(d, vbox);
      if (a.ok) posOk = true;
      await sleep(15000);
      elapsed = Math.round((Date.now() - t0) / 1000);
      ticks++;
      const b = await this._videoPos(d, vbox);
      // 每 45 秒顺带看一眼头部：有的课程播完直接改成「任务点已完成」
      if (ticks % 3 === 0) {
        const head2 = await d.readRegion({ x: 300, y: 260, w: 1100, h: 220 });
        if (head2.some((i) => /任务点已完成/.test(i.t))) {
          this.logLine(job, { ev: 'video-done', elapsed });
          break;
        }
      }
      if (a.ok && b.ok) {
        if (b.total > 0 && b.cur >= b.total - 3) {
          this.logLine(job, { ev: 'video-done', elapsed, pos: `${b.cur}/${b.total}` });
          break;
        }
        if (b.cur > a.cur) {
          if (ticks % 4 === 0) this.logLine(job, { ev: 'video-tick', elapsed, pos: `${b.cur}/${b.total}` });
          continue;
        }
        // 时间没走 = 暂停/卡住 → 点一下播放区继续（此时确实不是"正在播放"，点它不会误暂停）
        resumes++;
        await d.actions([{ cmd: 'click', x: cx, y: cy }, { cmd: 'sleep', ms: 2500 }]);
        this.logLine(job, { ev: 'video-resume', n: resumes, elapsed, pos: `${a.cur}/${a.total}` });
        continue;
      }
      // 读不到时间条 → 退回像素哈希判稳
      const p = await d.actions([{ cmd: 'hash', x: vbox.x, y: vbox.y, w: vbox.w, h: vbox.h }], 60000);
      const h = p.results?.[0]?.hash || '';
      if (h && h === lastHash) {
        same++;
        if (same >= 3) {
          const head3 = await d.readRegion({ x: 300, y: 260, w: 1100, h: 220 });
          if (head3.some((i) => /任务点已完成/.test(i.t))) {
            this.logLine(job, { ev: 'video-done', elapsed, why: 'hash' });
            break;
          }
          resumes++;
          await d.actions([{ cmd: 'click', x: cx, y: cy }, { cmd: 'sleep', ms: 2500 }]);
          this.logLine(job, { ev: 'video-resume', n: resumes, elapsed, why: 'hash' });
          same = 0;
          lastHash = '';
          continue;
        }
      } else same = 0;
      lastHash = h;
      if (ticks % 4 === 0) this.logLine(job, { ev: 'video-tick', elapsed, why: 'hash' });
    }
    job.progress.videos++;
    job.progress.videoSec = (job.progress.videoSec || 0) + elapsed;
    this.logLine(job, { ev: 'video-end', elapsed, resumes, posOk });
    await d.actions([{ cmd: 'key', seq: '{ESC}' }, { cmd: 'sleep', ms: 1000 }]);
  }

  async _doDoc(job, d, f, deadline) {
    const head = await d.readRegion({ x: 300, y: 260, w: 1100, h: 220 });
    if (head.some((i) => /任务点已完成/.test(i.t))) {
      this.logLine(job, { ev: 'doc-skip', why: 'done' });
      return;
    }
    const r = await f.scrollDoc({ maxBatches: 20 });
    this.logLine(job, { ev: 'doc-rolled', ...r });
    job.progress.docs++;
  }

  async _doQuiz(job, d, f, deadline, opts = {}) {
    const tag = opts.work ? 'work' : 'quiz';
    const head = await d.readRegion({ x: 300, y: 300, w: 1100, h: 220 });
    const headText = head.map((i) => i.t).join(' ');
    if (/已完成|已提交|任务点已完成/.test(headText)) {
      this.logLine(job, { ev: `${tag}-skip`, why: 'done' });
      return { ok: true, submitted: false, skipped: true };
    }
    const AREA = { x: 300, y: 380, w: 940, h: 750 };
    let answered = 0;
    let screens = 0;
    const seen = new Set();
    let lastHash = '';
    let same = 0;
    while (!job.stopRequested && Date.now() < deadline && screens < 12 && same < 2) {
      screens++;
      const raw = await d.readRegion(AREA, 1);
      const lines = this._lines(raw);
      const qs = extractQuizLines(lines);
      const fresh = qs.filter((q) => !seen.has(q.num));
      this.logLine(job, { ev: 'quiz-scan', screen: screens, lines: lines.length, qs: qs.length, fresh: fresh.length });
      if (fresh.length) {
        if (job.dryRun) {
          this.logLine(job, { ev: 'quiz-dry', n: fresh.length, sample: fresh.slice(0, 2).map((q) => ({ num: q.num, stem: q.stem.slice(0, 40), opts: q.opts.length, type: q.type })) });
        } else {
          answered += await this._answerScreen(job, d, fresh);
        }
        fresh.forEach((q) => seen.add(q.num));
      }
      // 往下翻一屏
      const h0 = (await d.actions([{ cmd: 'hash', x: AREA.x, y: AREA.y, w: AREA.w, h: AREA.h }], 60000)).results?.[0]?.hash;
      await d.actions([{ cmd: 'click', x: 700, y: 500 }, { cmd: 'key', seq: '{PGDN}' }, { cmd: 'sleep', ms: 1200 }]);
      const h1 = (await d.actions([{ cmd: 'hash', x: AREA.x, y: AREA.y, w: AREA.w, h: AREA.h }], 60000)).results?.[0]?.hash;
      if (h1 && h1 === h0 && h1 === lastHash) same++;
      else same = 0;
      lastHash = h1 || '';
    }
    if (job.dryRun) {
      this.logLine(job, { ev: `${tag}-dry-end`, screens, found: seen.size });
      return { ok: true, submitted: false, items: seen.size };
    }
    this.logLine(job, { ev: `${tag}-fill`, clicked: answered, found: seen.size, screens });
    // 提交（滚到底部找按钮）
    let submit = null;
    for (let i = 0; i < 6 && !submit; i++) {
      const tail = await d.readRegion({ x: 300, y: 420, w: 1400, h: 660 }, 1);
      submit = await this._clickText(tail, /^(提交|交卷|提交答案|确定提交|提交作业)$/);
      if (!submit) await d.actions([{ cmd: 'key', seq: '{PGDN}' }, { cmd: 'sleep', ms: 900 }]);
    }
    if (!submit) {
      this.logLine(job, { ev: `${tag}-submit-miss` });
      return { ok: false, submitted: false, items: seen.size };
    }
    await d.actions([{ cmd: 'click', x: submit.x, y: submit.y }, { cmd: 'sleep', ms: 2200 }]);
    const confirm = await this._clickText(await d.readRegion({ x: 400, y: 300, w: 1100, h: 700 }, 1), /^(确定|确认|是|提交)$/);
    this.logLine(job, { ev: `${tag}-submit`, confirm: !!confirm });
    if (confirm) await d.actions([{ cmd: 'click', x: confirm.x, y: confirm.y }, { cmd: 'sleep', ms: 2500 }]);
    if (!opts.work) job.progress.quizzes++;
    return { ok: true, submitted: true, items: seen.size, answered };
  }

  /** 一屏内：模型作答 → 点选项 */
  async _answerScreen(job, d, qs) {
    let plan = null;
    try {
      const { solveQuiz } = await import('./solver.mjs');
      const items = qs.map((q, i) => ({ i, stem: q.stem, opts: q.opts.map((o) => ({ letter: o.letter, text: o.text })), type: q.type }));
      const r = await solveQuiz({ llm: this.llm, log: (o) => this.logLine(job, o), course: job.course, kid: job.item, items, extra: { via: 'desktop' }, minConfidence: this.config.minConfidence ?? 0.6 });
      plan = r && r.ok ? r.plan : null;
      this.logLine(job, { ev: 'quiz-solve', ok: !!(r && r.ok), n: plan ? plan.length : 0, err: r && r.error });
    } catch (e) {
      this.logLine(job, { ev: 'quiz-solve-fail', err: truncate(String(e && e.message), 200) });
    }
    if (!plan || !plan.length) return 0;
    let clicked = 0;
    for (const p of plan) {
      const q = qs[p.i];
      if (!q) continue;
      for (const L of p.letters || []) {
        const opt = q.opts.find((o) => String(o.letter).toUpperCase() === String(L).toUpperCase());
        if (opt) {
          await d.actions([{ cmd: 'click', x: opt.x + 6, y: opt.y + Math.round((opt.h || 20) / 2) }, { cmd: 'sleep', ms: 220 }]);
          clicked++;
        }
      }
    }
    this.logLine(job, { ev: 'quiz-click', clicked, plan: plan.length });
    return clicked;
  }

  async _clickText(items, re) {
    for (let i = 0; i < 2; i++) {
      const it = (items || []).find((x) => re.test((x.t || '').trim()));
      if (it) return it;
      await sleep(600);
      items = [];
    }
    return null;
  }

  /** 把 OCR 碎片按 y 带合并成整行文本（选项字母与选项文本常被拆成两段） */
  _lines(items) {
    const rows = [];
    for (const it of items || []) {
      const y = Math.round(it.y || 0);
      const t = String(it.t || '').trim();
      if (!t) continue;
      const row = rows.find((r) => Math.abs(r.y - y) <= 12);
      if (row) row.parts.push(it);
      else rows.push({ y, parts: [it] });
    }
    rows.sort((a, b) => a.y - b.y);
    return rows.map((r) => {
      r.parts.sort((a, b) => (a.x || 0) - (b.x || 0));
      return {
        y: r.y,
        x: r.parts[0].x || 0,
        h: r.parts[0].h || 0,
        t: r.parts.map((p) => p.t).join(''),
        parts: r.parts.map((p) => ({ t: p.t, x: p.x, y: p.y, w: p.w })),
      };
    });
  }
}

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractQuiz(lines) {
  const items = [];
  let cur = null;
  for (const l of lines) {
    const t = (l.t || '').trim();
    const qm = t.match(/^(\d{1,2})[.、．]\s*(.+)$/);
    const om = t.match(/^([A-Fa-f])[.、．:：]\s*(.+)$/);
    if (qm && !om) {
      cur = { i: items.length, stem: qm[2], opts: [], type: 'single' };
      items.push(cur);
    } else if (om && cur) {
      cur.opts.push({ letter: om[1].toUpperCase(), text: om[2], x: l.x, y: l.y });
    } else if (cur && t) {
      cur.stem += ' ' + t;
    }
  }
  // 多选判定：题干含多选；否则按选项数
  for (const it of items) {
    if (/多选题|多选/.test(it.stem)) it.type = 'multi';
    if (!it.opts.length) it.type = 'fill';
  }
  return items.filter((it) => it.opts.length > 0 || it.type === 'fill');
}

/** 从合并后的整行文本里抽题目：题干 `1（多选题）…` / 选项 `A、…`（选项 alpha 段带坐标）
 *  OCR 常漏掉选项字母（如 B 被读丢），所以按行序补字母。 */
export function extractQuizLines(lines) {
  const rows = [];
  for (const l of lines) {
    const t = (l.t || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (/^\d{1,2}$/.test(t)) continue; // 侧栏角标数字
    if (/^任务点|^题量|^满分|^本次成绩|^目录|^讨论|^笔记|^标注|^我的答案|^正确答案|^答案解析|^收起|^展开/.test(t)) continue;
    const alpha = (l.parts || []).find((p) => /^([A-Fa-f])[、.．:：]/.test(String(p.t || '').trim()));
    rows.push({ t, y: l.y, x: l.x, h: l.h, alpha });
  }
  const isQ = (t) => /^(\d{1,2})\s*[（(．.、]/.test(t) && (t.length > 8 || /题/.test(t));
  const out = [];
  let cur = null;
  let pending = [];
  const flush = () => {
    if (!cur) { pending = []; return; }
    // 给没有识别出字母的行按顺序补 A/B/C…
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const used = new Set();
    for (const r of pending) if (r.letter) used.add(r.letter);
    let li = 0;
    for (const r of pending) {
      let letter = r.letter;
      if (!letter) {
        while (used.has(letters[li])) li++;
        letter = letters[li] || '';
        if (letter) used.add(letter);
      }
      cur.opts.push({ letter, text: r.text, x: r.x, y: r.y, h: r.h || 20 });
    }
    pending = [];
  };
  for (const r of rows) {
    if (isQ(r.t)) {
      flush();
      const m2 = r.t.match(/^(\d{1,2})\s*[（(]?\s*(单选题|多选题|判断题|填空题|简答题|问答题)?\s*[）)]?\s*(.*)$/);
      cur = { num: Number(m2 ? m2[1] : 0), stem: (m2 ? m2[3] : r.t).trim(), type: m2 && m2[2] ? typeOf(m2[2]) : 'single', opts: [], y: r.y };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const am = r.alpha && String(r.alpha.t).trim().match(/^([A-Fa-f])[、.．:：]\s*(.*)$/);
    // 选项行：带字母，或"像选项"的短/长句（不在题干紧邻行、x 明显右移）
    const looksOpt = !!am || (r.y > cur.y + 20 && r.x >= 380 && r.t.length >= 4);
    if (looksOpt) {
      let text = r.t;
      if (am) {
        const rest = (r.alpha && r.t.slice(r.t.indexOf(am[0]) + am[0].length)) || '';
        text = (am[2] + rest).trim();
      }
      pending.push({ letter: am ? am[1].toUpperCase() : '', text, x: r.alpha ? r.alpha.x : r.x, y: r.alpha ? r.alpha.y : r.y, h: r.h });
    } else {
      cur.stem = (cur.stem + ' ' + r.t).trim();
    }
  }
  flush();
  return out.filter((q) => q.opts.length >= 2);
}

function typeOf(w) {
  if (/多选/.test(w)) return 'multi';
  if (/判断/.test(w)) return 'judge';
  if (/填空|简答|问答/.test(w)) return 'fill';
  return 'single';
}

/** 作业作答页抽题：与章节测验不同，作业的填空是「第N空 + 大输入框」，
 *  所以除了选择题选项，还要收 blanks（空输入框的点击点），且不能把纯填空题丢掉。
 *  输入 = this._lines() 的整行（{t,x,y,h}）。
 *  实测坑：题号常被 OCR 吞掉，行首变成「（单选题）26下列说法…」，所以要认「（题型）」开头的行；
 *  题号和题型被拆成两行时（「25．」+「（单选题）26…」）要合并成一题。 */
export function extractWorkQuestions(lines, opts = {}) {
  const BLANK = /^第\s*\d+\s*空$/;
  const LETTER = /^([A-Fa-f])\s*[、.．:：]?\s*(.+)$/;
  const TYPE_ONLY = /^[（(]\s*(单选题|多选题|判断题|填空题|简答题|问答题)\s*[）)]\s*(.*)$/;
  const SEC_TYPE = /(单选题|多选题|填空题|判断题|简答题|问答题)/;
  /** 选项圆圈字母被 OCR 认错的常见结果（0/o/O/河/c/口/日/田…） */
  const OPT_BADGE = /^[0Oo河cC口日田四巳比]\s*(.+)$/;
  const isSection = (t) => /共\s*\d+\s*题/.test(t) || (/^[一二三四五六七八九十]+\s*[.．、·]?[^\d]/.test(t) && SEC_TYPE.test(t));
  const isQ = (t) => /^(\d{1,2})\s*[（(．.、]/.test(t) || TYPE_ONLY.test(t);
  const out = [];
  let section = String((opts && opts.section) || '');
  const secType = () => (section ? (/简答|问答/.test(section) ? 'short' : typeOf(SEC_TYPE.exec(section)[1])) : '');
  let cur = null;
  // 跨屏续接：上一屏没读完的题（只带题干/题型，选项坐标必须来自本屏）
  if (opts && opts.seed && opts.seed.stem) {
    cur = { num: opts.seed.num || 0, stem: String(opts.seed.stem), type: opts.seed.type || secType() || 'single', opts: [], blanks: [], y: -60, section };
    out.push(cur);
  }
  const close = () => {
    if (!cur) return;
    // 判断题的「B错」行 OCR 基本读不到（实测第十章 11 道判断题，只读到 A对、B错 一条都没有）
    // → 按固定版式补全：选项行距 72px，A 在题干下约 81px；读到其中一行就用它的坐标推另一行。
    if (cur.type === 'judge' && cur.opts.length < 2) {
      const a = cur.opts[0];
      // 选项文字规整成「对/错」：OCR 常把 A对 读成一行，别让模型看到「A对」这种重复字母
      const fix = (o) => {
        const m = /^[A-Fa-f]?\s*([对错木])$/.exec(String(o.text || '').trim());
        if (m) o.text = m[1] === '木' ? '错' : m[1];
        return o;
      };
      if (!a) {
        const ay = Math.round(cur.y + 81);
        cur.opts.push({ letter: 'A', text: '对', x: 280, y: ay, h: 20, synthetic: true });
        cur.opts.push({ letter: 'B', text: '错', x: 280, y: ay + 72, h: 20, synthetic: true });
      } else if (String(a.letter).toUpperCase() === 'A') {
        fix(a);
        cur.opts.push({ letter: 'B', text: '错', x: Math.round(a.x), y: Math.round(a.y) + 72, h: 20, synthetic: true });
      } else {
        fix(a);
        cur.opts.unshift({ letter: 'A', text: '对', x: Math.round(a.x), y: Math.round(a.y) - 72, h: 20, synthetic: true });
      }
    }
    // 填空题没读到「第N空」标签时兜底：输入框就在题干下方约 80px
    if (cur.type === 'fill' && !cur.blanks.length && cur.y >= 0) cur.blanks.push({ x: 760, y: Math.round(cur.y + 80), h: 20, fallback: true });
    cur = null;
  };
  for (const l of lines) {
    const t = String(l.t || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (BLANK.test(t.replace(/\s+/g, ''))) {
      if (cur) cur.blanks.push({ x: 760, y: Math.round(l.y), h: l.h || 20 });
      continue;
    }
    if (isSection(t)) {
      const sm = SEC_TYPE.exec(t);
      if (sm) section = sm[1];
      close();
      continue;
    }
    if (isQ(t)) {
      const qm = t.match(/^(\d{1,2})\s*[（(．.、]+\s*(单选题|多选题|判断题|填空题|简答题|问答题)?\s*[）)]?\s*(.*)$/);
      const tm = TYPE_ONLY.test(t) ? t.match(TYPE_ONLY) : null;
      const num = qm ? Number(qm[1]) : 0;
      const word = (qm && qm[2]) || (tm ? tm[1] : '');
      const type = /简答|问答/.test(word) ? 'short' : word ? typeOf(word) : secType();
      const stem = (qm ? qm[3] : tm ? tm[2] : t).trim();
      // 上一行只是「25．」这种题号残行 → 并进同一题
      if (cur && !cur.stem && !cur.opts.length && !cur.blanks.length) {
        if (num) cur.num = num;
        if (type) cur.type = type;
        cur.stem = stem || t;
        if (cur.y < 0) cur.y = Math.round(l.y);
        continue;
      }
      close();
      cur = { num, stem, type: type || secType() || 'single', opts: [], blanks: [], y: Math.round(l.y), section };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    // 选项行：字母开头（A 工作票制度 / c装设接地线），且不是题干
    // 这家的选项字母画在圆圈徽标里，OCR 常把 A/B/C/D 认成 0/河/c/口/日 → 认不出字母时
    // 按「短行 + 紧跟在题干后 + 顺序」补字母，否则整道选择题会被丢掉（实测第十二章 2 道多选全丢）。
    const am = t.match(LETTER);
    const isChoice = cur.type === 'single' || cur.type === 'multi' || cur.type === 'judge';
    let optText = '';
    let hasLetter = false;
    if (am && am[2].trim().length >= 2 && t.length <= 80) {
      optText = am[2].trim();
      hasLetter = true;
    } else if (isChoice && cur.stem && cur.opts.length < 6) {
      const bm = t.match(OPT_BADGE);
      const s = (bm ? bm[1] : t).trim();
      if (s.length >= 2 && s.length <= 45 && !/[。？?：:]$/.test(s) && !/[（(]\s*[）)]/.test(s)) optText = s;
    }
    if (optText) {
      const letter = hasLetter ? am[1].toUpperCase() : String.fromCharCode(65 + cur.opts.length);
      cur.opts.push({ letter, text: optText, x: Math.round(l.x), y: Math.round(l.y), h: l.h || 20, synthetic: !hasLetter });
    } else if (!cur.opts.length && !cur.blanks.length) {
      cur.stem = (cur.stem + ' ' + t).trim();
      if (cur.y < 0) cur.y = Math.round(l.y);
    }
  }
  close();
  // 简答题（type='short'）没有选项也没有「第N空」，但它是题量的一部分，漏了会让 expect 对不上
  return out.filter((q) => q.opts.length >= 2 || q.blanks.length > 0 || q.type === 'short');
}

/** 题目标识：题干前 16 字（题号常被 OCR 吞掉；滚动跨屏重复出现的题用这个去重） */
export function workSig(q) {
  return String((q && q.stem) || '').replace(/\s+/g, '').slice(0, 16);
}

export default DeskEngine;
