// DSH 宿主插件入口：注册学习通工具，串起账号/浏览器/后台任务/模型作答/全自动托管。
import { Store, paths, ensureDir } from './lib/paths.mjs';
import { AccountHub } from './lib/browser.mjs';
import { Engine } from './lib/engine.mjs';
import { pythonPath } from './lib/python.mjs';
import { createToolDefinitions } from './lib/tools.mjs';
import { LlmClient } from './lib/llm.mjs';
import { Autopilot } from './lib/autopilot.mjs';
import { registerChaoxingCommands } from './lib/commands.mjs';
import { DeskEngine } from './lib/deskengine.mjs';
import { ComputerUse } from './lib/cu.mjs';
import { startUiBridge } from './lib/uibridge.mjs';

export const name = 'chaoxing-assistant';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  if (config && typeof config.dataDir === 'string' && config.dataDir.trim()) {
    process.env.CHAOXING_DATA_DIR = config.dataDir.trim();
  }
  const p = paths();
  ensureDir(p.base);
  const store = new Store(p.stateFile);
  const hub = new AccountHub(store);
  const logs = (ch) => (o) => store.pushLog(ch, o);

  // 宿主 LLM 服务（可选）：拿不到就降级为“不自动做题”，刷课/文档不受影响
  let llm = null;
  try {
    const svc = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm;
    if (svc) {
      llm = new LlmClient({
        ctx,
        log: logs('llm'),
        provider: config.llm && config.llm.provider,
        model: config.llm && config.llm.model,
        reasoningEffort: config.llm && config.llm.reasoningEffort,
      });
      // 预热路由（路由解析可能是异步的；不阻塞 apply）
      Promise.resolve(llm.ensureReady()).then((ok) => {
        if (ok) store.pushLog('llm', { ev: 'ready', route: llm.route });
        else store.pushLog('llm', { ev: 'unavailable', reason: 'no provider/model route' });
      }).catch(() => {});
    }
  } catch {
    llm = null;
  }

  const engine = new Engine({ hub, store, python: pythonPath(config.python), llm });
  // 鼠标键盘后端：装了 @copylee/dsh-computer-use 就自动改用它（真实 SendInput），
  // 没有就继续用内置 PowerShell(UIA) 驱动。config.desktopInput = 'ps' 可强制走老路径。
  const cu = new ComputerUse({ ctx, log: logs('cu'), enabled: config.desktopInput !== 'ps' });
  const deskEngine = new DeskEngine({ store, config, llm, log: (o) => store.pushLog('desk', o), cu });
    const autopilot = new Autopilot({
    store,
    hub,
    engine,
    llm,
    paths,
    log: logs('auto'),
    config: config.auto || {},
  });

  const deps = { store, hub, engine, llm, autopilot, deskEngine, cu, paths, config };
  const disposers = [];

  // 右侧栏面板与工具共用同一套操作：注册 /chaoxing 命令
  try {
    disposers.push(registerChaoxingCommands(ctx, deps, config));
  } catch (e) {
    store.pushLog('command', { ev: 'register-failed', err: String((e && e.message) || e) });
  }

  try {
    for (const tool of createToolDefinitions(deps)) {
      disposers.push(ctx.tools.register(tool));
    }
  } catch (e) {
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    throw e;
  }

  // 面板数据桥（v1.7.0）：右侧栏面板通过 127.0.0.1 上的小 HTTP 服务读实时进度、发指令，
  // 不再用 ctx.remote.commands.execute（那条通道每调一次都会在会话里留一条记录 → 刷屏）。
  let uiBridge = null;
  try {
    uiBridge = startUiBridge({ deps, config, log: logs('ui') });
    disposers.push(() => {
      try {
        uiBridge.close();
      } catch {
        /* ignore */
      }
    });
  } catch (e) {
    store.pushLog('ui', { ev: 'bridge-fail', err: String((e && e.message) || e) });
  }

  // 启动语义（v1.5.0，按用户要求）：
  //  - 默认「不自启动」：插件启用（DSH 启动）时什么都不跑，必须用户点「开始」或调用
  //    chaoxing_auto start / 「/chaoxing auto」才开始；
  //  - 只有 config.autoStart === true 时才启用下面的自启动 + 重试逻辑（保留给需要的人手动打开）；
  //  - 面板「停止」= 硬停止：终止当前任务 + 清空队列，之后不会自动恢复（autoResumeMinutes 默认 0）；
  //  - 一轮跑完后默认也不自动重新扫描（autoRepeatMinutes 默认 0）。
  let autoTimer = null;
  let autoRetryTimer = null;
  let autoKeepAliveTimer = null;
  const autoCfg = config.auto || {};
  const autoEnabled = config.autoStart === true;
  const keepAliveMs = Math.max(15000, Number(config.autoKeepAliveMs || 45000));
  const resumeDelayMs = Math.max(0, Number(config.autoResumeMinutes ?? 0) * 60000);
  const repeatDelayMs = Math.max(0, Number(config.autoRepeatMinutes ?? 0) * 60000);
  const autoState = { last: '', stoppedAt: 0, doneAt: 0, errorAt: 0, failures: 0 };

  const autoOpts = () => ({
    account: config.autoAccount || autoCfg.account || 'default',
    courses: autoCfg.courses || [],
    concurrency: autoCfg.concurrency,
    maxMinutes: autoCfg.maxMinutes,
    kinds: autoCfg.kinds,
    solveQuizzes: autoCfg.solveQuizzes !== false,
    solveWorks: autoCfg.solveWorks !== false,
    minConfidence: autoCfg.minConfidence,
    autoSubmit: autoCfg.autoSubmit !== false,
    dryRun: !!autoCfg.dryRun,
    worksOnly: !!autoCfg.worksOnly,
    loginWaitMinutes: autoCfg.loginWaitMinutes,
    scanLimit: autoCfg.scanLimit,
    startUrl: autoCfg.startUrl,
  });

  const retryAuto = (attempt, err) => {
    const msg = String((err && err.message) || err);
    store.pushLog('auto', { ev: 'autostart-fail', attempt, err: msg });
    if (attempt >= 3) {
      store.pushLog('auto', { ev: 'autostart-giveup', err: msg });
      return;
    }
    autoRetryTimer = setTimeout(() => startAuto(attempt + 1), attempt * 8000);
    autoRetryTimer.unref?.();
  };

  const startAuto = (attempt = 1, why = 'enable') => {
    if (!autopilot) {
      store.pushLog('auto', { ev: 'autostart-skip', why: 'no-autopilot' });
      return;
    }
    const cur = autopilot.phase;
    if (cur && cur !== 'idle' && cur !== 'stopped' && cur !== 'done' && cur !== 'error') {
      store.pushLog('auto', { ev: 'autostart-skip', why: 'already-running', phase: cur });
      return;
    }
    try {
      const r = autopilot.start(autoOpts(), why);
      autoState.failures = 0;
      store.pushLog('auto', { ev: 'autostart-ok', attempt, why, account: config.autoAccount || autoCfg.account || 'default', resumed: cur === 'stopped' || cur === 'done' });
      if (r && typeof r.catch === 'function') r.catch((e) => retryAuto(attempt, e));
    } catch (e) {
      retryAuto(attempt, e);
    }
  };

  // keep-alive 看门狗（仅在 autoStart === true 时启用）：空闲自动拉起、报错 60s 重试；
  // 暂停后的自动继续 / 完成后的自动重扫默认关闭（对应配置为 0）。
  const keepAlive = (why = 'keep-alive') => {
    if (!autoEnabled || !autopilot) return;
    let snap;
    try {
      snap = autopilot.snapshot({ logLines: 0 });
    } catch {
      snap = { phase: 'idle' };
    }
    const phase = String((snap && snap.phase) || 'idle');
    const now = Date.now();
    if (phase !== autoState.last) {
      if (phase === 'stopped') autoState.stoppedAt = now;
      if (phase === 'done') autoState.doneAt = now;
      if (phase === 'error') autoState.errorAt = now;
      autoState.last = phase;
    }
    if (phase === 'idle' || phase === 'error') {
      const since = phase === 'error' ? now - autoState.errorAt : Infinity;
      if (phase === 'idle' || since >= 60000) startAuto(1, why);
      return;
    }
    if (phase === 'done') {
      if (repeatDelayMs > 0 && now - autoState.doneAt >= repeatDelayMs) startAuto(1, 'repeat');
      return;
    }
    if (phase === 'stopped') {
      if (resumeDelayMs > 0 && now - autoState.stoppedAt >= resumeDelayMs) {
        store.pushLog('auto', { ev: 'autoresume', afterMin: Math.round((now - autoState.stoppedAt) / 60000) });
        startAuto(1, 'autoresume');
      }
    }
  };

  if (autoEnabled) {
    autoTimer = setTimeout(() => startAuto(1, 'enable'), Math.max(0, Number(config.autoDelayMs ?? 1500)));
    autoTimer.unref?.();
    autoKeepAliveTimer = setInterval(() => {
      try {
        keepAlive('keep-alive');
      } catch (e) {
        store.pushLog('auto', { ev: 'keepalive-error', err: String((e && e.message) || e) });
      }
    }, keepAliveMs);
    autoKeepAliveTimer.unref?.();
  }
  store.pushLog('auto', {
    ev: autoEnabled ? 'autostart-armed' : 'autostart-off',
    note: autoEnabled ? '' : '插件不会自动运行：请点面板「开始」或调用 chaoxing_auto start',
  });
  deps.keepAlive = keepAlive;

  const dispose = () => {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    if (autoRetryTimer) {
      clearTimeout(autoRetryTimer);
      autoRetryTimer = null;
    }
    if (autoKeepAliveTimer) {
      clearInterval(autoKeepAliveTimer);
      autoKeepAliveTimer = null;
    }
    try {
      autopilot.stop('plugin-dispose');
    } catch {
      /* ignore */
    }
    for (const d of disposers.reverse()) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    // 让后台任务尽快收尾；不强行 kill 浏览器（登录态和用户窗口要留着）
    try {
      for (const job of engine.jobs.values()) {
        job.stopRequested = true;
        if (job.captcha && job.captcha.resolve) job.captcha.resolve('');
      }
    } catch {
      /* ignore */
    }
    try {
      store.flush();
    } catch {
      /* ignore */
    }
  };

  if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
  return dispose;
}

export default { name, inject, apply };
