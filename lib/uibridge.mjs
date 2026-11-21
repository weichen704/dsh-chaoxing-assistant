// 学习通助手 · 面板数据桥（宿主侧）
// 为什么需要它：客户端面板要"实时进度"，但走 ctx.remote.commands.execute 每查一次
// 都会在会话里留下一条命令记录（用户看到的就是刷屏）。这里在 127.0.0.1 起一个只监听
// 环回地址的小 HTTP 服务，面板用 fetch 轮询/发指令，完全不进会话记录。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseCourseParams } from './util.mjs';
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

export function startUiBridge({ deps, config = {}, log = () => {} }) {
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
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return { course: null };
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
    if (mode === 'web') return webLine;
    return (deskLine ? deskLine : '') + webLine;
  }

  function stateJson() {
    let snap = {};
    try {
      snap = (autopilot && autopilot.snapshot && autopilot.snapshot({ logLines: 0 })) || {};
    } catch {
      /* ignore */
    }
    let jobs = [];
    try {
      jobs = (engine && engine.list ? engine.list() : []).filter((j) => ['starting', 'running', 'need_captcha'].includes(j.state));
    } catch {
      /* ignore */
    }
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
      jobs: jobs.map((j) => ({ id: j.id, state: j.state, course: (j.course && j.course.title) || (j.course && j.course.courseid) })),
    };
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

  /** 桌面版按钮：全部 routed 到学习通客户端（登录/检查/扫描/刷课/作业/锁定课程） */
  async function desktopAction(name, body = {}, account = 'default') {
    const desk = deps.deskEngine;
    if (!desk) return { ok: false, text: '桌面版引擎未就绪：请重启 DSH 后再试' };
    const focus = typeof desk.focus === 'function' ? desk.focus() : [];
    const courses = () => {
      if (Array.isArray(body.courses)) return body.courses.map((s) => String(s).trim()).filter(Boolean);
      if (body.course) return [String(body.course).trim()].filter(Boolean);
      return focus.slice();
    };
    const busy = (what) => ({ ok: true, text: `桌面版正在${what}：点「停止」后可以重新开始` });
    switch (name) {
      case 'login':
        return await desk.login();
      case 'check':
        return await desk.check();
      case 'scan': {
        const r = desk.startScan({ account, courses: courses() });
        if (r.already) return busy('运行任务');
        return { ok: true, text: '桌面版扫描已开始：读客户端里的课程/章节/未完成任务点（点「刷新进度」看结果）' };
      }
      case 'run': {
        const r = desk.start({ account, courses: courses(), kinds: ['video', 'document', 'quiz'], maxMinutes: Number(autoCfg.maxMinutes || 180) });
        if (r.already) return busy('运行任务');
        return { ok: true, text: '桌面版刷课已开始：客户端里逐课刷视频/文档/测验（点「刷新进度」看进度）' };
      }
      case 'works': {
        const r = desk.startWorks({ account, courses: courses(), maxMinutes: Number(autoCfg.maxMinutes || 120) });
        if (r.already) return busy('运行任务');
        return { ok: true, text: '桌面版作业已开始：进各课「作业」列表，未交的逐份做题并提交（点「刷新进度」看进度）' };
      }
      case 'focus': {
        const want = Array.isArray(body.courses) ? body.courses.filter(Boolean)[0] : body.course;
        const got = typeof desk.setFocus === 'function' ? desk.setFocus(want) : [];
        return {
          ok: true,
          text: got.length
            ? `桌面版已锁定《${got[0]}》：扫描 / 刷课 / 作业都只处理这门课`
            : '桌面版已取消课程锁定：扫描 / 刷课 / 作业处理全部课程',
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
          const only = Array.isArray(body.courses) ? body.courses.filter(Boolean) : body.course ? [String(body.course)] : [];
          const r = desk.start({
            account,
            courses: only,
            kinds: ['video', 'document', 'quiz'],
            maxMinutes: Number(autoCfg.maxMinutes || 180),
            dryRun: !!body.dryRun,
          });
          return r.already
            ? { ok: true, text: '桌面版已在运行中（点「停止」可终止）' }
            : { ok: true, text: '桌面版已开始：正在打开学习通客户端 → 进入课程 → 刷课/做题（点「刷新进度」看进度）' };
        }
        const phase = phaseOf();
        const resume = ['stopped', 'done', 'error'].includes(phase);
        if (!['idle', 'stopped', 'done', 'error'].includes(phase)) {
          return { ok: true, text: '全自动已在运行（点「停止」可终止）' };
        }
        await autopilot.start(autoOpts({ resume: true }), 'ui');
        return { ok: true, text: resume ? '已继续上一轮的队列（点「刷新进度」或等自动刷新看阶段）' : '全自动已开始：登录检测 → 扫描 → 刷课 → 做作业/测验' };
      }
      case 'stop': {
        const desk = deps.deskEngine;
        // 桌面版「停止」只停桌面任务：不碰 Edge、不停网页任务、也不会重启客户端
        if (mode === 'desktop') {
          if (desk && typeof desk.running === 'function' && desk.running()) {
            desk.stop();
            return { ok: true, text: '已停止桌面版任务（学习通客户端保持打开，不会再弹窗）' };
          }
          const latest = desk && typeof desk.latest === 'function' ? desk.latest() : null;
          if (latest && ['stopped', 'done', 'error'].includes(latest.state)) {
            return { ok: true, text: '桌面版任务已经停了（不会自动重启）' };
          }
          return { ok: true, text: '桌面版当前没有在跑的任务' };
        }
        // 网页版「停止」只停网页任务
        if (mode === 'web') {
          const stopped = await stopWeb();
          return { ok: true, text: `已停止网页版任务（${stopped} 个）：队列清空，不会自动恢复；桌面客户端不受影响` };
        }
        if (desk && typeof desk.running === 'function' && desk.running()) {
          desk.stop();
          const stopped = await stopWeb();
          return { ok: true, text: `已停止：桌面版任务 + 网页版任务 ${stopped} 个（客户端保持打开）` };
        }
        const stopped = await stopWeb();
        return { ok: true, text: `已停止（任务 ${stopped} 个）：所有任务终止、队列已清空，不会自动恢复` };
      }
      case 'focus': {
        const r = await resolveCourse(body.course, account);
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
        return { ok: false, text: '已打开学习通登录页：请在 Edge 窗口扫码或输密码，登录后再点「检查」' };
      }
      case 'check': {
        const { page } = await hub.ensurePage(accRecord(account), { newWindow: false });
        const st = await probeLogin(page);
        return { ok: !!st.loggedIn, text: st.loggedIn ? `已登录（${st.nick || '未知昵称'}）` : '未登录：点「登录」打开扫码页' };
      }
      case 'scan': {
        const r = await resolveCourse(body.course, account);
        if (r.error) return { ok: false, text: r.error };
        const job = await engine.startScan({ account, course: r.course, concurrency: 2 });
        return { ok: true, text: `扫描已开始（job ${job.id}）` };
      }
      case 'run': {
        const r = await resolveCourse(body.course, account);
        if (r.error) return { ok: false, text: r.error };
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
        return { ok: true, text: `刷课任务已开始（job ${job.id}）` };
      }
      case 'works': {
        const r = await resolveCourse(body.course, account);
        if (r.error) return { ok: false, text: r.error };
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
        return { ok: true, text: `作业任务已开始（job ${job.id}）` };
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
          return { ok: true, text: `已打开学习通网页版${href ? '：' + href : ''}（在你的 Edge 窗口里）` };
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

  const server = http.createServer((req, res) => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Cache-Control': 'no-store',
    };
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { ...headers, 'Content-Type': type });
      res.end(body);
    };
    if (req.method === 'OPTIONS') return send(204, '');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/health') return send(200, JSON.stringify({ ok: true, port, account: accountName() }));

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

    if (req.method === 'GET' && path === '/progress') {
      try {
        const m = url.searchParams.get('mode') || '';
        const mode = m === 'desktop' ? 'desktop' : m === 'web' ? 'web' : '';
        return send(200, progressText(mode), 'text/plain; charset=utf-8');
      } catch (e) {
        return send(500, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    }

    if (req.method === 'GET' && path === '/state') {
      try {
        return send(200, JSON.stringify(stateJson()));
      } catch (e) {
        return send(500, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    }

    if (req.method === 'POST' && path === '/action') {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        chunks.push(c);
        size += c.length;
        if (size > 64 * 1024) req.destroy();
      });
      req.on('end', async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }
        const name = String(body.action || '');
        try {
          const out = await action(name, body);
          log({ ev: 'ui-action', action: name, course: String(body.course || '').slice(0, 60), ok: !!out.ok });
          return send(200, JSON.stringify(out));
        } catch (e) {
          const err = String((e && e.message) || e).slice(0, 300);
          log({ ev: 'ui-action-fail', action: name, err });
          return send(200, JSON.stringify({ ok: false, text: `操作失败：${err}` }));
        }
      });
      return;
    }

    return send(404, JSON.stringify({ ok: false, error: 'not found' }));
  });

  server.on('error', (e) => {
    log({ ev: 'ui-bridge-error', err: String((e && e.message) || e) });
  });
  try {
    server.listen(port, '127.0.0.1');
    log({ ev: 'ui-bridge', port, url: `http://127.0.0.1:${port}/progress` });
  } catch (e) {
    log({ ev: 'ui-bridge-listen-fail', port, err: String((e && e.message) || e) });
  }

  return {
    port,
    close() {
      return new Promise((resolve) => {
        try {
          server.close(() => resolve(true));
          setTimeout(() => resolve(false), 1500).unref?.();
        } catch {
          resolve(false);
        }
      });
    },
  };
}

export const UI_PORT = DEFAULT_PORT;
