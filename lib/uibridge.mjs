// 学习通助手 · 面板数据桥（宿主侧）
// 为什么需要它：客户端面板要"实时进度"，但走 ctx.remote.commands.execute 每查一次
// 都会在会话里留下一条命令记录（用户看到的就是刷屏）。这里在 127.0.0.1 起一个只监听
// 环回地址的小 HTTP 服务，面板用 fetch 轮询/发指令，完全不进会话记录。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseCourseParams, courseSpec } from './util.mjs';
import { LOGIN_URL, probeLogin, discoverCourses } from './chaoxing.mjs';

const DEFAULT_PORT = 9483;

// 学习通桌面客户端（cxstudy）常见安装位置。
// 注意：安装目录顶层那个几百 KB 的 cxstudy.exe 只是启动器/更新器，直接运行它会打开
// "网页版"；真正的桌面客户端在安装目录的 latest\cxstudy.exe（Electron 主程序，200MB+）。
function desktopCandidates() {
  const env = process.env;
  const dirs = [
    'D:\\软件\\cxstudy',
    'C:\\软件\\cxstudy',
    'C:\\Program Files\\cxstudy',
    'C:\\Program Files (x86)\\cxstudy',
    path.join(env.LOCALAPPDATA || '', 'cxstudy'),
    path.join(env.APPDATA || '', 'cxstudy'),
  ].filter(Boolean);
  const list = [env.CHAOXING_DESKTOP];
  for (const dir of dirs) {
    list.push(path.join(dir, 'latest', 'cxstudy.exe'));
    list.push(path.join(dir, 'cxstudy.exe'));
  }
  return list.filter(Boolean);
}

function findDesktopApp(extra) {
  const list = [extra, ...desktopCandidates()].filter(Boolean);
  for (const p of list) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* ignore */
    }
  }
  // 再扫一层常见软件的安装父目录（兼容装在别的子目录/中文目录）
  const parents = ['D:\\软件', 'C:\\软件', 'D:\\Program Files', 'C:\\Program Files', 'C:\\Program Files (x86)'];
  for (const parent of parents) {
    try {
      for (const dir of fs.readdirSync(parent)) {
        for (const rel of [path.join('latest', 'cxstudy.exe'), 'cxstudy.exe']) {
          const exe = path.join(parent, dir, rel);
          if (fs.existsSync(exe)) return exe;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return '';
}

function norm(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000:：,，.。()（）\[\]【】\-_*"'"'、/\\]/g, '')
    .toLowerCase();
}

function firstAccount(store) {
  try {
    const accounts = store.get('accounts', {}) || {};
    const names = Object.keys(accounts);
    return names.length ? names[0] : '';
  } catch {
    return '';
  }
}

function splitSpec(text) {
  const out = { courseid: '', clazzid: '', cpi: '', enc: '' };
  const parts = String(text || '').split(':');
  if (parts[0]) out.courseid = parts[0].replace(/\D/g, '');
  if (parts[1]) out.clazzid = parts[1].replace(/\D/g, '');
  if (parts[2]) out.cpi = parts[2].replace(/\D/g, '');
  if (parts[3]) out.enc = /^[0-9a-fA-F]{16,40}$/.test(parts[3]) ? parts[3] : '';
  return out;
}

export function startUiBridge({ deps, config = {}, log = () => {}, webServer = null }) {
  const { store, hub, engine, autopilot } = deps;
  const autoCfg = config.auto || {};
  const port = Number(config.uiPort || DEFAULT_PORT);
  const accountName = () => config.autoAccount || autoCfg.account || firstAccount(store) || 'default';

  // 取"完整"的账号记录（含 port/profileDir）。只传 {name} 会让 ensureBrowser 用默认
  // 9422 + 空 profile 另起一个浏览器，历史 bug 就是这么来的。
  function accRecord(name) {
    const key = name || accountName();
    try {
      const acc = (store.get('accounts', {}) || {})[key];
      if (acc) return acc;
    } catch {
      /* ignore */
    }
    return { name: key };
  }

  function courseMap(account) {
    const rows = [];
    try {
      const all = store.get('courses', {}) || {};
      for (const [key, value] of Object.entries(all)) {
        if (!value) continue;
        const acc = key.includes(':') ? key.slice(0, key.indexOf(':')) : '';
        if (acc && acc !== account) continue;
        rows.push({ ...value, key });
      }
    } catch {
      /* ignore */
    }
    return rows;
  }

  function enrich(course, account) {
    const out = { ...course };
    if (!out.courseid) return out;
    try {
      const hit = (store.get('courses', {}) || {})[`${account}:${out.courseid}`];
      if (hit) {
        if (!out.clazzid && hit.clazzid) out.clazzid = hit.clazzid;
        if (!out.cpi && hit.cpi) out.cpi = hit.cpi;
        if (!out.enc && hit.enc) out.enc = hit.enc;
        if (!out.title && hit.title) out.title = hit.title;
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  async function refreshCourses(account) {
    try {
      const { page } = await hub.ensurePage(accRecord(account), { newWindow: false });
      const found = await discoverCourses(page, { log, account });
      const courses = (found && found.courses) || [];
      const map = { ...(store.get('courses', {}) || {}) };
      for (const c of courses) {
        if (!c || !c.courseid) continue;
        map[`${account}:${c.courseid}`] = {
          courseid: String(c.courseid),
          clazzid: String(c.clazzid || ''),
          cpi: String(c.cpi || ''),
          enc: c.enc || '',
          title: c.title || map[`${account}:${c.courseid}`]?.title || '',
          at: new Date().toISOString(),
        };
      }
      store.set('courses', map);
      store.flush();
      return courses.length;
    } catch (e) {
      log({ ev: 'ui-courses-fail', err: String((e && e.message) || e).slice(0, 200) });
      return 0;
    }
  }

  async function resolveCourse(raw, account) {
    // 面板里「扫描/刷课/作业」传的是 courses: [课程名]，命令行传的是 course —— 两种都认
    const rawOne = Array.isArray(raw) ? raw.filter(Boolean)[0] : raw;
    // 「python程序设计作业」这种连动作一起写的课程名先剥成「python程序设计」：
    // 课程标题里不会有「作业」后缀，带后缀一定匹配不到（面板上就是「找不到课程」）。
    const text = courseSpec(String(rawOne == null ? '' : rawOne).trim());
    if (!text) return { error: '请先在「目标课程」里填课程名（或留空后改点「开始」跑全部课程）' };
    if (/^https?:\/\//i.test(text)) {
      const p = parseCourseParams(text);
      const course = { courseid: p.courseid || '', clazzid: p.clazzid || '', cpi: p.cpi || '', enc: p.enc || '' };
      if (!course.courseid) return { error: '网址里没有课程 id，请检查是不是课程页面链接' };
      return { course: enrich(course, account) };
    }
    if (/^\d+(:\d+){1,3}$/.test(text)) {
      const p = splitSpec(text);
      return { course: enrich(p, account) };
    }
    if (/^\d{4,}$/.test(text)) return { course: enrich({ courseid: text }, account) };

    const q = norm(text);
    const pick = () => courseMap(account).filter((c) => norm(c.title).includes(q) || String(c.courseid) === text);
    let hits = pick();
    if (!hits.length) {
      const n = await refreshCourses(account);
      hits = pick();
      if (!hits.length && n === 0) {
        return { error: `找不到课程「${text}」：课程列表也没读到（可能未登录），请先点「登录」扫码，再试。` };
      }
    }
    if (!hits.length) {
      const names = courseMap(account)
        .map((c) => c.title)
        .filter(Boolean)
        .slice(0, 6)
        .join('、');
      return { error: `找不到课程「${text}」。可选课程名：${names || '（暂无）'}` };
    }
    if (hits.length > 1) {
      const exact = hits.filter((c) => norm(c.title) === q);
      if (exact.length === 1) hits = exact;
      else return { error: `「${text}」匹配到多门课：${hits.slice(0, 5).map((c) => `${c.title}(${c.courseid})`).join('、')}，请输入更完整的名字或 courseid` };
    }
    return { course: hits[0] };
  }

  function autoOpts(extra = {}) {
    return {
      account: accountName(),
      concurrency: 2,
      maxMinutes: Number(autoCfg.maxMinutes || 180),
      kinds: ['video', 'document'],
      solveQuizzes: autoCfg.solveQuizzes !== false,
      solveWorks: autoCfg.solveWorks !== false,
      minConfidence: Number(autoCfg.minConfidence || 0.6),
      autoSubmit: autoCfg.autoSubmit !== false,
      dryRun: false,
      loginWaitMinutes: 30,
      ...extra,
    };
  }

  function phaseOf() {
    try {
      return (autopilot && autopilot.phase) || 'idle';
    } catch {
      return 'idle';
    }
  }

  function progressText(mode = '') {
    const desk = deps.deskEngine;
    let deskLine = '';
    let webLine = '';
    try {
      if (desk && typeof desk.snapshot === 'function') {
        const job = (typeof desk.running === 'function' && desk.running()) || (typeof desk.latest === 'function' && desk.latest());
        const d = desk.snapshot(job, { logLines: 0 });
        if (d && ['running', 'starting', 'stopped', 'done', 'error'].includes(d.state)) {
          const head = d.state === 'running' || d.state === 'starting' ? d.phase || d.state : d.state === 'done' ? '已完成' : d.state === 'error' ? '出错' : '已停止';
          deskLine =
            '▸ 桌面版 ' + head + (d.elapsed ? ' · ' + d.elapsed : '') +
            '\n▸ 课程 ' + (d.course || '-') + ' · 节点 ' + (d.item || '-') +
            '\n▸ 视频 ' + (d.progress.videos || 0) + ' · 文档 ' + (d.progress.docs || 0) + ' · 测验 ' + (d.progress.quizzes || 0) + '\n';
          // 导航失败/课程打不开时把原因直接写在进度里，别只显示「出错」
          if (d.state === 'error' && d.error) deskLine += '▸ 原因：' + String(d.error).slice(0, 240) + '\n';
          // 扫描报告 / 作业统计
          const p = d.progress || {};
          if (p.itemsPending) deskLine += '▸ 未完成任务点 ' + p.itemsPending + '\n';
          if (p.worksFound || p.worksDone) deskLine += '▸ 作业 未交 ' + (p.worksFound || 0) + ' · 已提交 ' + (p.worksDone || 0) + '\n';
          const rep = Array.isArray(d.report) ? d.report : [];
          if (rep.length) {
            const rows = rep
              .slice(0, 8)
              .map((r) => `  · ${r.course}${r.done != null ? ` ${r.done}/${r.total}` : ''}${r.pending ? `（还差 ${r.pending}）` : ''}${r.chapters ? ` · ${r.chapters} 节` : ''}`);
            deskLine += '▸ 扫描结果\n' + rows.join('\n') + '\n';
          }
        }
      }
    } catch { /* ignore */ }
    if (typeof deps.progressText === 'function') {
      try {
        webLine = deps.progressText() || '';
      } catch {
        webLine = '';
      }
    }
    if (!webLine) {
      const snap = (autopilot && autopilot.snapshot && autopilot.snapshot({ logLines: 0 })) || {};
      webLine = `▸ 网页版 阶段 ${snap.phase || 'idle'}（${snap.running ? '运行中' : '空闲'}）`;
    }
    // 只有网页版浏览器窗口才由网页版按钮控制；桌面版按钮不显示网页版进度
    if (mode === 'desktop') return deskLine || '▸ 桌面版 空闲（点「开始」启动学习通客户端）';
    if (mode === 'web') return webLine + scanLine();
    return (deskLine ? deskLine : '') + webLine;
  }

  /** 网页版扫描结果摘要：store.scans 里最新的那条（面板原先只在桌面版显示扫描结果） */
  function scanLine() {
    try {
      const scans = store.get('scans', {}) || {};
      const acc = accountName();
      const rows = Object.entries(scans)
        .filter(([k, v]) => v && typeof v === 'object')
        .filter(([k]) => {
          const a = k.includes(':') ? k.slice(0, k.indexOf(':')) : '';
          return !a || a === acc;
        })
        .map(([, v]) => v)
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      // 刷课任务也会写这条记录，但只存目录（没有附件名）——优先挑带附件名的扫描记录，
      // 这样面板里显示的是「扫描」那次的可读标题，而不是一堆 knowledgeid
      const rich = rows.find((r) => Array.isArray(r.nodes) && r.nodes.some((n) => n && ((Array.isArray(n.attachments) && n.attachments.length) || String(n.name || '').trim())));
      const s = rich || rows[0];
      if (!s) return '';
      const pendTotal = s.pendingCount != null ? s.pendingCount : (Array.isArray(s.nodes) ? s.nodes.filter((r) => r && Number(r.points) > 0).length : null);
      const title = (s.course && (s.course.title || s.course.courseid)) || '-';
      const when = String(s.at || '').slice(5, 16).replace('T', ' ');
      let out = `\n▸ 最近扫描 《${title}》 任务点 ${s.totalPoints != null ? s.totalPoints : '-'} · 未完成 ${pendTotal != null ? pendTotal : '-'}（${when}）`;
      // 待完成节点标题：优先扫描到的节点（标题在 attachments[].name 里，且带 <font> 高亮标签）
      const clean = (t) => String(t || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      const pend = (Array.isArray(s.nodes) ? s.nodes : [])
        .filter((r) => r && Number(r.points) > 0)
        .slice(0, 5)
        .map((r) => {
          const att = (Array.isArray(r.attachments) ? r.attachments : []).find((a) => a && a.name);
          return clean(att && att.name) || clean(r.name) || String(r.kid || '');
        })
        .filter(Boolean);
      if (pend.length) out += '\n' + pend.map((t) => '  · ' + t).join('\n');
      const more = Number(pendTotal || 0) - pend.length;
      if (more > 0) out += `\n  · …还有 ${more} 个未完成节点`;
      return out;
    } catch {
      return '';
    }
  }

  const ACTIVE_STATES = ['starting', 'running', 'need_captcha'];

  /** 只取活跃任务：历史任务不参与 /state，避免每次轮询都给全部历史 job 算 snapshot */
  function activeJobs() {
    if (!engine) return [];
    try {
      if (engine.jobs && typeof engine.jobs.values === 'function') {
        const out = [];
        for (const j of engine.jobs.values()) {
          if (j && ACTIVE_STATES.includes(j.state)) out.push(j);
        }
        return out;
      }
      if (typeof engine.list === 'function') return engine.list().filter((j) => ACTIVE_STATES.includes(j.state));
      return [];
    } catch {
      return [];
    }
  }

  function stateJson() {
    let snap = {};
    try {
      snap = (autopilot && autopilot.snapshot && autopilot.snapshot({ logLines: 0 })) || {};
    } catch {
      /* ignore */
    }
    const jobs = activeJobs();
    return {
      ok: true,
      at: new Date().toISOString(),
      phase: snap.phase || 'idle',
      running: !!snap.running,
      stats: snap.stats || {},
      queue: (snap.queue || []).slice(0, 12),
      current: snap.current || null,
      // 鼠标键盘后端：装了 @copylee/dsh-computer-use 时 mode=auto、available=true
      input: (() => {
        try {
          const de = deps.deskEngine;
          return de && de.inputBackend ? de.inputBackend() : null;
        } catch {
          return null;
        }
      })(),
      // 桌面版结构化状态：面板据此渲染阶段/统计，不用再从展示文本里正则刮
      desktop: (() => {
        try {
          const de = deps.deskEngine;
          if (!de || typeof de.snapshot !== 'function') return null;
          const job = (typeof de.running === 'function' && de.running()) || (typeof de.latest === 'function' && de.latest());
          if (!job) return null;
          const d = de.snapshot(job, { logLines: 0 }) || {};
          const p = d.progress || {};
          return {
            id: d.id,
            state: d.state,
            phase: d.phase,
            kind: d.kind || 'course',
            course: d.course || '',
            item: d.item || '',
            elapsedSec: d.elapsedSec || 0,
            progress: {
              itemsPending: p.itemsPending || 0,
              videos: p.videos || 0,
              docs: p.docs || 0,
              quizzes: p.quizzes || 0,
              worksFound: p.worksFound || 0,
              worksDone: p.worksDone || 0,
            },
            report: (Array.isArray(d.report) ? d.report : []).slice(0, 6).map((r) => ({
              course: r.course,
              done: r.done,
              total: r.total,
              pending: r.pending,
              chapters: r.chapters,
            })),
            error: d.error || '',
          };
        } catch {
          return null;
        }
      })(),
      jobs: jobs.slice(0, 8).map((j) => ({ id: j.id, state: j.state, course: (j.course && j.course.title) || (j.course && j.course.courseid) })),
    };
  }

  // 面板每 2.5 秒轮询一次；/progress 与 /state 会各自重算同一份 snapshot。
  // 这里按 400ms 做一层记忆，并让 /snapshot 一次取齐「进度文本 + 状态」，把请求数减半。
  const MEMO_MS = 400;
  let stateMemo = { at: 0, val: null };
  let textMemo = { at: 0, mode: '\u0000', val: '' };

  /** 任何会改状态的操作结束后清掉记忆，保证面板下一次立刻看到新状态 */
  function invalidateMemo() {
    stateMemo = { at: 0, val: null };
    textMemo = { at: 0, mode: '\u0000', val: '' };
  }

  function memoState() {
    const now = Date.now();
    if (stateMemo.val && now - stateMemo.at < MEMO_MS) return stateMemo.val;
    let val;
    try {
      val = stateJson();
    } catch (e) {
      val = { ok: false, at: new Date().toISOString(), phase: 'idle', running: false, stats: {}, jobs: [], error: String((e && e.message) || e) };
    }
    stateMemo = { at: now, val };
    return val;
  }

  function memoText(mode) {
    const now = Date.now();
    if (textMemo.mode === mode && now - textMemo.at < MEMO_MS) return textMemo.val;
    let val;
    try {
      val = progressText(mode);
    } catch (e) {
      val = '▸ 进度读取失败：' + String((e && e.message) || e);
    }
    textMemo = { at: now, mode, val: String(val || '') };
    return textMemo.val;
  }

  function snapshotPayload(mode) {
    return { ok: true, at: Date.now(), text: memoText(mode), state: memoState() };
  }

  /** 只停网页版（autopilot + 网页任务），不碰桌面客户端 */
  async function stopWeb() {
    let stopped = 0;
    try {
      for (const job of engine.list()) {
        if (['starting', 'running', 'need_captcha'].includes(job.state)) {
          try {
            engine.stop(job.id);
            stopped += 1;
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (autopilot) {
        if (typeof autopilot.abort === 'function') await autopilot.abort('ui-stop');
        else await autopilot.stop('ui-stop');
      }
    } catch {
      /* ignore */
    }
    return stopped;
  }

  const WEB_BUSY = ['starting', 'running', 'need_captcha'];

  function webBusyJobs() {
    try {
      return (typeof engine.list === 'function' ? engine.list() : []).filter((j) => WEB_BUSY.includes(j.state));
    } catch {
      return [];
    }
  }

  /** 网页版同一时间只跑一个任务：这次要跑别的课程时，先停掉旧任务并等它真的退出。
   *  以前「扫描/刷课/作业」直接 engine.start，撞上「同账号已有任务在跑」只回一句「已开始」，
   *  用户以为换了课，实际上旧队列（常常是全量清单）还在继续打开别的课程。
   *  返回 null = 没有旧任务要停；{victims, still} = 停了哪些、是否还没退干净。 */
  async function stopWebOther(course) {
    const want = String((course && course.courseid) || '');
    const victims = [];
    for (const job of webBusyJobs()) {
      const jc = String((job.course && (job.course.courseid || job.course)) || '');
      if (want && jc === want) continue; // 同一门课已经在跑：保留它
      try {
        if (typeof engine.stop === 'function') engine.stop(job.id);
      } catch {
        /* 停不掉就交给下面的复查 */
      }
      victims.push({ id: job.id, title: (job.course && job.course.title) || jc });
    }
    if (!victims.length) return null;
    const left = () => webBusyJobs().filter((j) => victims.some((v) => v.id === j.id));
    const until = Date.now() + 8000;
    while (Date.now() < until && left().length) await new Promise((r) => setTimeout(r, 400));
    return { victims, still: left().length > 0 };
  }

  /** 全自动循环正在跑别的课程时先停掉：不然后台还在「登录 → 扫描 → 刷课」地打开其他课程 */
  async function replaceWebLoop(why) {
    const phase = phaseOf();
    if (!autopilot || ['idle', 'stopped', 'done', 'error'].includes(phase)) return false;
    try {
      if (typeof autopilot.abort === 'function') await autopilot.abort(why);
      else await autopilot.stop(why);
    } catch {
      return false;
    }
    const until = Date.now() + 8000;
    while (Date.now() < until && !['idle', 'stopped', 'done', 'error'].includes(phaseOf())) {
      await new Promise((r) => setTimeout(r, 400));
    }
    return true;
  }

  /** engine.start 的真实结果：以前的三个入口不看它，busy 时也回「已开始（job xxx）」 */
  function webStartReply(job, okText) {
    if (!job || job.ok === false || job.already) {
      return { ok: false, text: (job && job.text) || '同一账号已有任务在跑：先点「停止」或等它结束' };
    }
    return { ok: true, text: `${okText}（job ${job.id}）` };
  }

  function webStillReply(rep) {
    const names = (rep.victims || []).map((v) => v.title || v.id).join('、');
    return { ok: false, text: `上一轮网页版任务（${names}）还没停干净：等几秒再点一次（不会再去开别的课）` };
  }

  /** 用户点「停止」后清掉本轮任务的临时数据（任务真正退出后 cleaner 会再补一刀） */
  async function cleanupAfterStop(where) {
    try {
      const c = deps.cleanup;
      if (!c || typeof c.afterStop !== 'function') return null;
      return c.afterStop(where) || null;
    } catch {
      return null;
    }
  }

  function cleanupSuffix(cleaned) {
    const n = Number(cleaned && cleaned.deleted) || 0;
    return n > 0 ? `；已清理 ${n} 个临时文件` : '';
  }

  /** 跑着的桌面任务和这次指定的不是同一门课时，先停干净再开新的。
   *  以前 _startJob 见到有任务在跑就直接 return {already:true}，用户填了课程点「开始/扫描/刷课」
   *  却继续跑上一轮的课程清单 —— 面板上就是「指定了 A 课，却一直打开 B 课」。
   *  停完之后必须复查：旧任务可能正卡在 openCourse（一次 40~70 秒）里没退出来，
   *  这时绝不能开新任务 —— 两个任务同时点同一个客户端，旧任务会继续打开别的课程。 */
  async function stopIfOther(desk, courses) {
    const list = (Array.isArray(courses) ? courses : []).map((s) => String(s || '').trim()).filter(Boolean);
    if (!list.length || typeof desk.running !== 'function') return null;
    const cur = desk.running();
    if (!cur) return null;
    const old = (Array.isArray(cur.courses) ? cur.courses : []).map((s) => String(s || '').trim()).filter(Boolean);
    const same = old.length === list.length && old.every((t) => list.some((x) => norm(x) === norm(t)));
    if (same) return null;
    let r;
    try {
      r = typeof desk.stopAndWait === 'function' ? await desk.stopAndWait(cur.id, 15000) : (desk.stop(cur.id), { ok: true });
    } catch {
      r = { ok: false };
    }
    let still = false;
    try {
      still = !!(r && r.still) || !!desk.running();
    } catch {
      still = !!(r && r.still);
    }
    return { old, ok: !!(r && r.ok), waited: !!(r && r.waited), still, id: cur.id };
  }

  /** 旧任务没停干净时的统一回包：宁可让用户再点一次，也不要开第二个任务去抢同一个客户端 */
  function stillStopping(swapped) {
    return {
      ok: false,
      text: `上一轮任务（${oldLabel(swapped)}）还没停干净：正在离开上一门课，等几秒再点一次（不会再去开别的课）`,
    };
  }

  function oldLabel(swapped) {
    const names = (swapped && swapped.old) || [];
    const shown = names.slice(0, 2).join('、') || '全部课程';
    return names.length > 2 ? `${shown} 等 ${names.length} 门` : shown;
  }

  /** 桌面版按钮：全部 routed 到学习通客户端（登录/检查/扫描/刷课/作业/锁定课程） */
  async function desktopAction(name, body = {}, account = 'default') {
    const desk = deps.deskEngine;
    if (!desk) return { ok: false, text: '桌面版引擎未就绪：请重启 DSH 后再试' };
    const focus = typeof desk.focus === 'function' ? desk.focus() : [];
    // 面板课程框里常连动作一起写（「python程序设计作业」）：先剥掉后缀，再拿去匹配/开课，
    // 否则桌面版会点到 OCR 碎片、网页版会报「找不到课程」。
    const courses = () => {
      if (Array.isArray(body.courses)) return body.courses.map((s) => courseSpec(String(s == null ? '' : s).trim())).filter(Boolean);
      if (body.course) return [courseSpec(String(body.course).trim())].filter(Boolean);
      return focus.slice();
    };
    const busy = (what, r) => ({ ok: true, text: (r && r.text) || `桌面版正在${what}：点「停止」后可以重新开始` });
    switch (name) {
      case 'login':
        return await desk.login();
      case 'check':
        return await desk.check();
      case 'scan': {
        const list = courses();
        const swapped = await stopIfOther(desk, list);
        if (swapped && swapped.still) return stillStopping(swapped);
        const r = desk.startScan({ account, courses: list });
        if (r.already) return busy('运行任务', r);
        return {
          ok: true,
          text: swapped
            ? `已停止上一轮任务（${oldLabel(swapped)}），桌面版扫描已开始：只处理这次指定的课程`
            : '桌面版扫描已开始：读客户端里的课程/章节/未完成任务点（点「刷新进度」看结果）',
        };
      }
      case 'run': {
        const list = courses();
        const swapped = await stopIfOther(desk, list);
        if (swapped && swapped.still) return stillStopping(swapped);
        const r = desk.start({ account, courses: list, kinds: ['video', 'document', 'quiz'], maxMinutes: Number(autoCfg.maxMinutes || 180) });
        if (r.already) return busy('运行任务', r);
        return {
          ok: true,
          text: swapped
            ? `已停止上一轮任务（${oldLabel(swapped)}），桌面版刷课已开始：只处理这次指定的课程`
            : '桌面版刷课已开始：客户端里逐课刷视频/文档/测验（点「刷新进度」看进度）',
        };
      }
      case 'works': {
        const list = courses();
        const swapped = await stopIfOther(desk, list);
        if (swapped && swapped.still) return stillStopping(swapped);
        const r = desk.startWorks({ account, courses: list, maxMinutes: Number(autoCfg.maxMinutes || 120) });
        if (r.already) return busy('运行任务', r);
        return {
          ok: true,
          text: swapped
            ? `已停止上一轮任务（${oldLabel(swapped)}），桌面版作业已开始${list.length ? `：只处理《${list.join('》《')}》的作业` : ''}`
            : `桌面版作业已开始${list.length ? `：只处理《${list.join('》《')}》的作业` : ''}（点「刷新进度」看进度）`,
        };
      }
      case 'focus': {
        const want = courseSpec(String((Array.isArray(body.courses) ? body.courses.filter(Boolean)[0] : body.course) || ''));
        const got = typeof desk.setFocus === 'function' ? desk.setFocus(want) : [];
        if (!got.length) {
          return { ok: true, text: '桌面版已取消课程锁定：扫描 / 刷课 / 作业处理全部课程' };
        }
        // 「确定」= 优先完成这门课（README）：正在跑别的课程/全部课程时先停掉，
        // 否则旧任务会继续打开其他课程，用户看到的就是「指定了课程却开了别的课」。
        const swapped = await stopIfOther(desk, got);
        if (swapped && swapped.still) {
          return {
            ok: false,
            text: `已锁定《${got[0]}》，但上一轮任务（${oldLabel(swapped)}）还没停干净：等几秒再点「作业」/「开始」，不会再去开别的课`,
          };
        }
        return {
          ok: true,
          text: swapped
            ? `已停止正在运行的上一轮任务（${oldLabel(swapped)}），并锁定《${got[0]}》：之后扫描 / 刷课 / 作业只处理这门课`
            : `桌面版已锁定《${got[0]}》：扫描 / 刷课 / 作业都只处理这门课`,
        };
      }
      default:
        return null;
    }
  }

  async function action(name, body = {}) {
    const account = accountName();
    const mode = body.mode === 'desktop' ? 'desktop' : body.mode === 'web' ? 'web' : '';
    // 网页版和桌面版是两套独立操作：同一套按钮，各自只作用于自己的系统
    // —— 桌面版的分支全部走「学习通客户端」，不会打开 Edge
    if (mode === 'desktop') {
      const r = await desktopAction(name, body, account);
      if (r) return r;
    }
    switch (name) {
      case 'start': {
        if (mode === 'desktop') {
          const desk = deps.deskEngine;
          if (!desk) return { ok: false, text: '桌面版引擎未就绪：请重启 DSH 后再试' };
          const only = Array.isArray(body.courses)
            ? body.courses.map((s) => courseSpec(String(s == null ? '' : s))).filter(Boolean)
            : body.course
              ? [courseSpec(String(body.course))].filter(Boolean)
              : [];
          const eff = only.length ? only : typeof desk.focus === 'function' ? desk.focus() : [];
          const swapped = await stopIfOther(desk, eff);
          if (swapped && swapped.still) return stillStopping(swapped);
          const r = desk.start({
            account,
            courses: only,
            kinds: ['video', 'document', 'quiz'],
            maxMinutes: Number(autoCfg.maxMinutes || 180),
            dryRun: !!body.dryRun,
          });
          return r.already
            ? { ok: true, text: r.text || '桌面版已在运行中（点「停止」可终止）' }
            : {
                ok: true,
                text: swapped
                  ? `已停止上一轮任务（${oldLabel(swapped)}），桌面版已开始：只处理这次指定的课程`
                  : '桌面版已开始：正在打开学习通客户端 → 进入课程 → 刷课/做题（点「刷新进度」看进度）',
              };
        }
        const phase = phaseOf();
        const resume = ['stopped', 'done', 'error'].includes(phase);
        const runningNow = !['idle', 'stopped', 'done', 'error'].includes(phase);
        // 面板里填了「目标课程」就只跑这门：以前这里完全不读课程输入，
        // 用户填了课程点「开始」仍会跑全部课程/续跑旧队列。
        const rawCourse =
          Array.isArray(body.courses) && body.courses.filter(Boolean).length
            ? body.courses.filter(Boolean)[0]
            : body.course != null && String(body.course).trim()
              ? body.course
              : '';
        if (rawCourse) {
          const r = await resolveCourse(rawCourse, account);
          if (r.error) return { ok: false, text: r.error };
          const title = r.course.title || r.course.courseid;
          // 正在跑上一轮（常常是「全部课程」队列）时，用户新填的课程不能只回一句「已在运行」——
          // 旧队列会继续打开其他课程，看起来就是「指定了 A 课却一直开 B 课」。这里先停旧循环再只跑这门。
          let replaced = false;
          if (runningNow && autopilot) {
            try {
              if (typeof autopilot.abort === 'function') await autopilot.abort('ui-course-replace');
              else await autopilot.stop('ui-course-replace');
              replaced = true;
            } catch {
              /* 停不掉就让 start 自己判断 */
            }
          }
          await autopilot.start(autoOpts({ courses: [String(r.course.courseid)], resume: false }), replaced ? 'ui-course-replace' : 'ui-course');
          return {
            ok: true,
            text: replaced
              ? `已停止上一轮任务，改为只处理《${title}》：登录检测 → 扫描章节/作业 → 刷课`
              : `已开始《${title}》：只处理这门课（登录检测 → 扫描章节/作业 → 刷课）`,
          };
        }
        if (runningNow) {
          return { ok: true, text: '全自动已在运行（点「停止」可终止；要换课程请填课程名再点「开始」）' };
        }
        await autopilot.start(autoOpts({ resume }), 'ui');
        return { ok: true, text: resume ? '已继续上一轮的队列（点「刷新进度」或等自动刷新看阶段）' : '全自动已开始：登录检测 → 扫描 → 刷课 → 做作业/测验' };
      }
      case 'stop': {
        const desk = deps.deskEngine;
        // 桌面版「停止」只停桌面任务：不碰 Edge、不停网页任务、也不会重启客户端
        if (mode === 'desktop') {
          if (desk && typeof desk.running === 'function' && desk.running()) {
            desk.stop();
            const cleaned = await cleanupAfterStop('ui-stop-desktop');
            // stop 只是「请求停止」：这一轮可能还卡在 openCourse 里（实测 40~70 秒）。
            // 说清楚它还在收尾，用户就不会以为已经停了、马上再点一次去开别的课。
            const stillGoing = !!(typeof desk.running === 'function' && desk.running());
            return {
              ok: true,
              text: stillGoing
                ? `正在停止桌面版任务（还在离开当前课程，几秒后收尾）：这段时间点「作业/开始」会先提示等它停完，不会去开别的课${cleanupSuffix(cleaned)}`
                : `已停止桌面版任务（学习通客户端保持打开，不会再弹窗）${cleanupSuffix(cleaned)}`,
            };
          }
          const latest = desk && typeof desk.latest === 'function' ? desk.latest() : null;
          const cleaned = await cleanupAfterStop('ui-stop-desktop');
          if (latest && ['stopped', 'done', 'error'].includes(latest.state)) {
            return { ok: true, text: `桌面版任务已经停了（不会自动重启）${cleanupSuffix(cleaned)}` };
          }
          return { ok: true, text: `桌面版当前没有在跑的任务${cleanupSuffix(cleaned)}` };
        }
        // 网页版「停止」只停网页任务
        if (mode === 'web') {
          const stopped = await stopWeb();
          const cleaned = await cleanupAfterStop('ui-stop-web');
          return { ok: true, text: `已停止网页版任务（${stopped} 个）：队列清空，不会自动恢复；桌面客户端不受影响${cleanupSuffix(cleaned)}` };
        }
        if (desk && typeof desk.running === 'function' && desk.running()) {
          desk.stop();
          const stopped = await stopWeb();
          const cleaned = await cleanupAfterStop('ui-stop-all');
          return { ok: true, text: `已停止：桌面版任务 + 网页版任务 ${stopped} 个（客户端保持打开）${cleanupSuffix(cleaned)}` };
        }
        const stopped = await stopWeb();
        const cleaned = await cleanupAfterStop('ui-stop-all');
        return { ok: true, text: `已停止（任务 ${stopped} 个）：所有任务终止、队列已清空，不会自动恢复${cleanupSuffix(cleaned)}` };
      }
      case 'focus': {
        const r = await resolveCourse(body.course != null ? body.course : body.courses, account);
        if (r.error) return { ok: false, text: r.error };
        const c = r.course;
        const title = c.title || c.courseid;
        const phase = phaseOf();
        if (!['idle', 'stopped', 'done', 'error'].includes(phase)) {
          try {
            if (typeof autopilot.abort === 'function') await autopilot.abort('ui-focus');
            else await autopilot.stop('ui-focus');
          } catch {
            /* ignore */
          }
        }
        await autopilot.start(autoOpts({ courses: [String(c.courseid)], resume: false }), 'ui-focus');
        return { ok: true, text: `已优先处理《${title}》：先扫该课程的章节任务，再刷课/做作业` };
      }
      case 'login': {
        const { page } = await hub.ensurePage(accRecord(account), { newWindow: false });
        const st = await probeLogin(page);
        if (st.loggedIn) return { ok: true, text: `已登录（${st.nick || '未知昵称'}）` };
        await page.goto(LOGIN_URL, { waitMs: 5000, timeoutMs: 30000 }).catch(() => {});
        // 二维码会过期：把窗口提到最前，并让 CDP 重新加载一次拿新码
        try {
          await page.send?.('Page.reload', { ignoreCache: true });
          await page.send?.('Page.bringToFront');
        } catch {
          try {
            await page.send?.('Page.bringToFront');
          } catch {
            /* ignore */
          }
        }
        return { ok: false, text: '已打开学习通登录页（窗口已提到最前面，二维码是刚刷新的）：请在 Edge 窗口扫码，登录后再点「检查」' };
      }
      case 'check': {
        const acc = accRecord(account);
        let { page } = await hub.ensurePage(acc, { newWindow: false });
        let st = await probeLogin(page);
        // 扫码登录后浏览器里通常同时留着「登录页」和「个人空间」两个标签；
        // 若控制器页正好停在登录页，check 会误报未登录 → 丢掉缓存页、重挑一个已登录标签再探一次
        if (!st.loggedIn) {
          try {
            if (typeof hub.invalidatePage === 'function') hub.invalidatePage(acc);
            ({ page } = await hub.ensurePage(acc, { newWindow: false }));
            const st2 = await probeLogin(page);
            if (st2.loggedIn) st = st2;
          } catch {
            /* 重挑失败就用第一次的结果 */
          }
        }
        return { ok: !!st.loggedIn, text: st.loggedIn ? `已登录（${st.nick || '未知昵称'}）` : '未登录：点「登录」打开扫码页', href: st.href || '' };
      }
      case 'scan': {
        const r = await resolveCourse(body.course != null ? body.course : body.courses, account);
        if (r.error) return { ok: false, text: r.error };
        const title = r.course.title || r.course.courseid;
        await replaceWebLoop('ui-course-replace');
        const replaced = await stopWebOther(r.course);
        if (replaced && replaced.still) return webStillReply(replaced);
        const job = await engine.startScan({ account, course: r.course, concurrency: 2 });
        return webStartReply(job, `扫描已开始：只扫描《${title}》`);
      }
      case 'run': {
        const r = await resolveCourse(body.course != null ? body.course : body.courses, account);
        if (r.error) return { ok: false, text: r.error };
        const title = r.course.title || r.course.courseid;
        await replaceWebLoop('ui-course-replace');
        const replaced = await stopWebOther(r.course);
        if (replaced && replaced.still) return webStillReply(replaced);
        const job = await engine.start({
          account,
          course: r.course,
          kinds: ['video', 'document'],
          concurrency: 2,
          maxMinutes: Number(autoCfg.maxMinutes || 120),
          quizPolicy: 'auto',
          solveWorks: autoCfg.solveWorks !== false,
          minConfidence: Number(autoCfg.minConfidence || 0.6),
          autoSubmit: true,
          dryRun: false,
        });
        return webStartReply(job, `刷课已开始：只刷《${title}》`);
      }
      case 'works': {
        const r = await resolveCourse(body.course != null ? body.course : body.courses, account);
        if (r.error) return { ok: false, text: r.error };
        const title = r.course.title || r.course.courseid;
        await replaceWebLoop('ui-course-replace');
        const replaced = await stopWebOther(r.course);
        if (replaced && replaced.still) return webStillReply(replaced);
        const job = await engine.start({
          account,
          course: r.course,
          kinds: [],
          concurrency: 1,
          maxMinutes: Number(autoCfg.maxMinutes || 60),
          quizPolicy: 'skip',
          solveWorks: true,
          minConfidence: Number(autoCfg.minConfidence || 0.6),
          autoSubmit: true,
          dryRun: false,
        });
        return webStartReply(job, `作业任务已开始：只做《${title}》的作业`);
      }
      // 面板「刷新」按钮：直接回当前进度文本（不再往会话里发命令）
      case 'refresh':
      case 'progress':
        return { ok: true, text: progressText(mode) };
      // 「网页入口」：在插件驱动的 Edge 窗口里打开学习通网页版（复用登录态）
      case 'web': {
        try {
          const { page } = await hub.openTaskPage(
            accRecord(account),
            { url: 'https://i.chaoxing.com/base', newWindow: false, width: 1400, height: 900 }
          );
          const href = await page.evaluate('String(location.href)').catch(() => '');
          // 未登录时 i.chaoxing.com/base 会跳到 passport 登录页：把窗口提到前面并直说下一步
          const needLogin = /passport\d*\.chaoxing\.com|passport2|\/login/i.test(href);
          try {
            await page.send?.('Page.bringToFront');
          } catch {
            /* ignore */
          }
          return {
            ok: true,
            text: needLogin
              ? '已打开学习通网页版：还没登录，请在刚弹到前面的 Edge 窗口里扫码登录，登录后点「检查」'
              : `已打开学习通网页版${href ? '：' + href : ''}（在你的 Edge 窗口里）`,
          };
        } catch (e) {
          return { ok: false, text: `打开网页版失败：${String((e && e.message) || e)}` };
        }
      }
      // 「桌面入口」：启动学习通桌面客户端 cxstudy.exe
      case 'desktop': {
        const exe = findDesktopApp(config.desktopPath || autoCfg.desktopPath);
        if (!exe) {
          return { ok: false, text: '没找到学习通桌面客户端（cxstudy.exe）。可在插件配置里设置 desktopPath，或把 cxstudy.exe 加到 PATH 同名目录' };
        }
        try {
          // 关键：DSH 宿主（Electron）环境里带 ELECTRON_RUN_AS_NODE=1，子进程继承后
          // cxstudy.exe 会以纯 Node 模式跑（秒退、不显示界面、不写日志）。启动桌面客户端
          // 必须把这些 ELECTRON_* 变量清掉。
          const env = { ...process.env };
          for (const k of Object.keys(env)) {
            if (/^ELECTRON_/i.test(k) || k === 'NODE_OPTIONS') delete env[k];
          }
          const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', env });
          child.unref();
          await new Promise((r) => setTimeout(r, 1500));
          const alive = child.exitCode === null;
          return {
            ok: true,
            text: alive
              ? `已启动学习通桌面客户端：${exe}`
              : `已请求启动学习通桌面客户端：${exe}（进程已退出：可能已有一个实例在运行，或客户端启动失败）`,
          };
        } catch (e) {
          return { ok: false, text: `启动桌面客户端失败：${String((e && e.message) || e)}` };
        }
      }
      default:
        return { ok: false, text: `未知操作 ${name}` };
    }
  }

  // 只给本机/局域网页面开 CORS：以前是 `*`，任何网页都能 POST /action 把任务停掉。
  const LOCAL_ORIGIN = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i;
  // DSH 桌面端把渲染进程托管在自定义协议 dsh-app://app 下（Electron registerSchemesAsPrivileged
  // standard:true/secure:true/corsEnabled:true），页面带的是真实 Origin 而不是 null。
  // v2.2.2 之前这里只认 http(s) 与 null，于是面板每个请求都被 403 掉 → 永远「未连接」、按钮点了没反应。
  const DESK_APP_ORIGIN = /^dsh-app:\/\/[a-z0-9][a-z0-9.-]*$/i;

  function originOf(req) {
    const raw = String((req.headers && req.headers.origin) || '').trim();
    return raw;
  }

  /** 空 Origin（本机 curl / node 工具）放行；loopback、私网、dsh-app://、null 放行 */
  function originAllowed(origin) {
    if (!origin) return true;
    if (origin === 'null') return true;
    if (DESK_APP_ORIGIN.test(origin)) return true;
    return LOCAL_ORIGIN.test(origin);
  }

  // 一个请求处理器，两个入口：
  //  - 127.0.0.1:9483 的独立 HTTP 服务（旧面板 / 外部脚本 / 自测用）
  //  - DSH 自己 webServer 上的 /chaoxing/* 同源路由（面板首选，无 CORS、无额外端口）
  const ROUTE_PREFIX = '/chaoxing';
  // 面板连通过来的请求计数：/health 里能直接看到面板到底有没有在轮询（诊断「未连接」用）
  const hits = { server: 0, route: 0 };

  const makeHandler = (via) => (req, res) => {
    const origin = originOf(req);
    const allowed = originAllowed(origin);
    const headers = {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      // Chrome 的 Private Network Access 预检会要求这个响应头，否则跨源到 127.0.0.1 仍会被拦
      'Access-Control-Allow-Private-Network': 'true',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    };
    if (allowed && origin) headers['Access-Control-Allow-Origin'] = origin;
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(code, { ...headers, 'Content-Type': type });
      res.end(body);
    };
    res.on('error', () => {});
    if (req.method === 'OPTIONS') return send(204, '');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let path = url.pathname.replace(/\/+$/, '') || '/';
    // 同源路由以 /chaoxing 为前缀，去掉后与独立端口的路径语义完全一致
    if (path === ROUTE_PREFIX || path.startsWith(ROUTE_PREFIX + '/')) {
      path = path.slice(ROUTE_PREFIX.length) || '/';
    }
    if (via === 'server') hits.server += 1;
    else hits.route += 1;
    const hit = via === 'server' ? hits.server : hits.route;
    if (via !== 'server') {
      // 轮询 /snapshot 只在前几次和每 40 次记一行，避免日志刷屏
      if (path !== '/snapshot' || hit <= 3 || hit % 40 === 0) {
        log({ ev: 'ui-req', via, method: req.method, path, origin: origin || '-', hit });
      }
    }

    if (!allowed) {
      return send(403, JSON.stringify({ ok: false, error: 'origin-not-allowed' }));
    }

    if (req.method === 'GET' && path === '/health') {
      return send(200, JSON.stringify({ ok: true, port, account: accountName(), hits: { ...hits }, route: routeDisposers.length > 0 }));
    }

    // 输入后端自检（只读）：确认是否接上 @copylee/dsh-computer-use、坐标换算比例
    if (req.method === 'GET' && path === '/input') {
      req.setTimeout?.(0);
      const de = deps.deskEngine;
      if (!de || typeof de.probeInput !== 'function') return send(200, JSON.stringify({ ok: false, why: 'desk-engine-missing' }));
      de
        .probeInput()
        .then((r) => send(200, JSON.stringify({ ok: true, ...r })))
        .catch((e) => send(500, JSON.stringify({ ok: false, error: String((e && e.message) || e) })));
      return;
    }

    // 一次取齐进度文本 + 状态：面板每 tick 只发 1 个请求
    if (req.method === 'GET' && path === '/snapshot') {
      try {
        const m = url.searchParams.get('mode') || '';
        const mode = m === 'desktop' ? 'desktop' : m === 'web' ? 'web' : '';
        return send(200, JSON.stringify(snapshotPayload(mode)));
      } catch (e) {
        return send(500, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    }

    if (req.method === 'GET' && path === '/progress') {
      try {
        const m = url.searchParams.get('mode') || '';
        const mode = m === 'desktop' ? 'desktop' : m === 'web' ? 'web' : '';
        return send(200, memoText(mode), 'text/plain; charset=utf-8');
      } catch (e) {
        return send(500, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    }

    if (req.method === 'GET' && path === '/state') {
      try {
        return send(200, JSON.stringify(memoState()));
      } catch (e) {
        return send(500, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    }

    if (req.method === 'POST' && path === '/action') {
      // 只接受 application/json：跨站「简单请求」无法带这个头，必须先过 preflight
      const ctype = String((req.headers && req.headers['content-type']) || '').toLowerCase();
      if (ctype && !ctype.includes('application/json')) {
        return send(415, JSON.stringify({ ok: false, text: 'Content-Type 必须是 application/json' }));
      }
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        if (tooBig) return;
        size += c.length;
        if (size > 64 * 1024) {
          tooBig = true;
          chunks.length = 0;
          return;
        }
        chunks.push(c);
      });
      req.on('end', async () => {
        if (tooBig) return send(413, JSON.stringify({ ok: false, text: '请求体过大' }));
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }
        const name = String(body.action || '');
        // 同一个动作在飞时直接拒绝，避免两个面板/两个标签页重复 start/stop；
        // 不同动作串行执行，避免 start 与 stop 交错。
        if (inflight.has(name)) {
          return send(200, JSON.stringify({ ok: false, busy: true, text: `「${ACTION_LABELS[name] || name}」正在执行，请稍候再试` }));
        }
        inflight.add(name);
        const run = actionChain.then(() => action(name, body));
        actionChain = run.then(
          () => undefined,
          () => undefined,
        );
        try {
          const out = await run;
          log({ ev: 'ui-action', action: name, course: String(body.course || '').slice(0, 60), ok: !!out.ok });
          return send(200, JSON.stringify(out));
        } catch (e) {
          const err = String((e && e.message) || e).slice(0, 300);
          log({ ev: 'ui-action-fail', action: name, err });
          return send(200, JSON.stringify({ ok: false, text: `操作失败：${err}` }));
        } finally {
          inflight.delete(name);
          invalidateMemo();
        }
      });
      return;
    }

    return send(404, JSON.stringify({ ok: false, error: 'not found' }));
  };

  const server = http.createServer(makeHandler('server'));

  // DSH 同源路由：面板在 dsh-app://app 下直接 fetch('/chaoxing/snapshot')，
  // 与页面同源 → 不受 CORS / Private Network Access 约束，也不需要额外端口。
  // 插件启动时 webServer 服务往往还没就绪（宿主里它是后注册的兄弟插件），
  // 所以对外暴露 attachWebServer()，由 index.js 用 ctx.inject(['webServer']) 在服务就绪时接入。
  const routeDisposers = [];
  const disposeRoutes = () => {
    while (routeDisposers.length) {
      const off = routeDisposers.pop();
      try {
        if (typeof off === 'function') off();
      } catch {
        /* ignore */
      }
    }
  };
  const attachWebServer = (ws) => {
    if (!ws || typeof ws.register !== 'function') {
      log({ ev: 'ui-route-skip', why: 'no-web-server' });
      return false;
    }
    // 热重载 / 重复接入：先撤旧路由，否则 register 会因前缀重复而抛错
    disposeRoutes();
    try {
      const off = ws.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: makeHandler('route') });
      if (typeof off === 'function') routeDisposers.push(off);
      log({ ev: 'ui-route', path: ROUTE_PREFIX });
      return true;
    } catch (e) {
      log({ ev: 'ui-route-fail', err: String((e && e.message) || e).slice(0, 200) });
      return false;
    }
  };
  if (webServer) attachWebServer(webServer);
  else log({ ev: 'ui-route-skip', why: 'no-web-server-yet' });

  const ACTION_LABELS = {
    start: '开始',
    stop: '停止',
    login: '登录',
    check: '检查',
    scan: '扫描',
    run: '刷课',
    works: '作业',
    refresh: '刷新进度',
    focus: '锁定课程',
    progress: '刷新进度',
    web: '网页版',
    desktop: '桌面版',
  };
  const inflight = new Set();
  let actionChain = Promise.resolve();

  let listenTimer = null;
  let listenTries = 0;
  const listen = () => {
    try {
      server.listen(port, '127.0.0.1');
    } catch (e) {
      log({ ev: 'ui-bridge-listen-fail', port, err: String((e && e.message) || e) });
    }
  };
  server.on('listening', () => {
    listenTries = 0;
    log({ ev: 'ui-bridge', port, url: `http://127.0.0.1:${port}/progress` });
  });
  server.on('error', (e) => {
    const code = (e && e.code) || '';
    log({ ev: 'ui-bridge-error', code, err: String((e && e.message) || e) });
    // listen 的 EADDRINUSE 是异步错误：旧进程还没释放端口时退避重试同一端口
    // （客户端 client.js 把 9483 写死了，不能换端口）
    if (code === 'EADDRINUSE' && listenTries < 40) {
      listenTries += 1;
      listenTimer = setTimeout(listen, 3000);
      listenTimer.unref?.();
    }
  });
  listen();

  return {
    port,
    attachWebServer,
    detachWebServer() {
      disposeRoutes();
    },
    close() {
      disposeRoutes();
      if (listenTimer) {
        clearTimeout(listenTimer);
        listenTimer = null;
      }
      return new Promise((resolve) => {
        try {
          server.close(() => resolve(true));
          setTimeout(() => {
            // 有在飞的 /action（scan/run 会 await）时，别让连接拖住插件重载
            try {
              server.closeIdleConnections?.();
              server.closeAllConnections?.();
            } catch {
              /* ignore */
            }
            resolve(false);
          }, 1500).unref?.();
        } catch {
          resolve(false);
        }
      });
    },
  };
}

export const UI_PORT = DEFAULT_PORT;
