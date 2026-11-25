// 桌面客户端 v2 驱动：常驻 OCR + 批量 PowerShell 动作（低延迟）
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, renameSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './util.mjs';
import { pythonPath } from './python.mjs';
import { paths } from './paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PS1 = path.join(here, '..', 'desktop', 'uia2.ps1');
export const COREPS1 = path.join(here, '..', 'desktop', 'uia2core.ps1');
export const SRVPS1 = path.join(here, '..', 'desktop', 'uia2srv.ps1');
// 常驻 PowerShell 入口：每次动作不再启动新进程（实测单次调用 1.5s → 0.03~0.25s）。
// CHAOXING_PS_WORKER=0 可强制回到「每次都起进程」的老路径。
const PS_WORKER_ON = String(process.env.CHAOXING_PS_WORKER || '') !== '0';
const WORKER_RETRY_MS = 60000;

/** 读常驻进程写出的结果文件。PowerShell 是先建文件、再写内容：文件刚出现就同步读会读到
 *  半截 JSON（真机日志里的「常驻 PowerShell 响应不是 JSON：Unexpected end of JSON input」
 *  就是这么来的），随后整批动作退回「每次都起进程」（每批 1.5s+），作业流程 20 多个 OCR
 *  因此从几秒拖到 47 秒。这里用很短的间隔重读到能解析为止，彻底失败才报错。 */
export async function readJsonReady(file, { tries = 60, gap = 10 } = {}) {
  let last = null;
  for (let i = 0; i < Math.max(1, tries); i += 1) {
    try {
      return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      last = e;
      await sleep(gap);
    }
  }
  throw new Error('常驻 PowerShell 响应不是 JSON：' + String((last && last.message) || last).slice(0, 120));
}

// 源脚本可能被杀软/同步盘短时锁定或截断，PowerShell 读到半截会报「字符串缺少终止符」。
// 每次调用前在 workDir 里保留一份内容完全一致的副本，从副本执行，避开锁文件竞态。
// 副本按内容哈希命名：并发/滚动窗口里旧副本永远不会被就地截断（就地重写会让正在启动的
// PowerShell 读到半个文件，报「无法将 …uia2.cache.ps1 识别为 cmdlet、脚本文件」）。
function stableCopy(src, workDir, prefix) {
  try {
    const buf = readFileSync(src);
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 12);
    const dst = path.join(workDir, `${prefix}.${hash}.ps1`);
    try {
      // 长度相同不算数：必须逐字节一致才复用，否则可写目录里同长度的伪造脚本会被执行
      const cur = readFileSync(dst);
      if (cur.equals(buf)) return dst;
    } catch {}
    const tmp = `${dst}.${process.pid}.tmp`;
    writeFileSync(tmp, buf);
    try {
      renameSync(tmp, dst);
    } catch {
      try { unlinkSync(tmp); } catch {}
      // 另一进程刚建好同名副本（内容必然一致）：直接用
    }
    return dst;
  } catch {
    return src;
  }
}
function stablePs1(workDir) {
  return stableCopy(PS1, workDir, 'uia2');
}
function stableCore(workDir) {
  return stableCopy(COREPS1, workDir, 'uia2core');
}
function stableSrv(workDir) {
  return stableCopy(SRVPS1, workDir, 'uia2srv');
}
export const OCRAPI = path.join(here, '..', 'desktop', 'ocrapi.py');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// 异步执行子进程：替代同步 spawn，等待期间不再冻住事件循环。
// 返回形态与原同步调用对齐（stdout/stderr/status/signal/error）；超时先 kill 子进程，再等 close 事件收尾。
function spawnCapture(cmd, args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    let hardTimer = null;
    let timedOut = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({ stdout, stderr, status: null, signal: null, error: null, ...r });
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ error: e });
      return;
    }
    // 数据分片自行拼接；setEncoding 走 StringDecoder，不会把多字节字符截断
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({ error: timedOut || e }));
    child.on('close', (code, signal) => finish({ status: code, signal, error: timedOut }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = new Error(`spawn ${cmd} ETIMEDOUT`);
        timedOut.code = 'ETIMEDOUT';
        try { child.kill(); } catch {}
        // 极端情况下 kill 不生效：最多再等 5s 就返回，避免调用方永久挂起
        hardTimer = setTimeout(() => finish({ error: timedOut, signal: 'SIGTERM' }), 5000);
      }, timeoutMs);
    }
  });
}

export async function findAppPid(name = 'cxstudy') {
  const r = await spawnCapture('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH']);
  const line = String(r.stdout || '').split(/\r?\n/).find((l) => /\.exe/i.test(l));
  if (!line) return 0;
  const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ''));
  const pid = parseInt(cols[1], 10);
  return Number.isFinite(pid) ? pid : 0;
}

export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^ELECTRON_/i.test(k)) delete env[k];
  delete env.NODE_OPTIONS;
  return env;
}

export class DeskV2 {
  constructor({ python = '', workDir, log = () => {}, cu = null, input = 'auto' } = {}) {
    // 不再硬编码用户名：pythonPath 会依次尝试显式路径、CHAOXING_PYTHON、捆绑运行时与 PATH
    this.python = pythonPath(python || process.env.CHAOXING_PYTHON || '');
    // 默认放到插件数据目录下的 tmp（~/.dsh-chaoxing/tmp）：这里会落 PowerShell 脚本副本
    // 并用 -File 执行，不能放在用户工作区这种可能被其它进程写入的位置。
    this.workDir = workDir || process.env.CHAOXING_WORKDIR || paths().tmp;
    this.log = log;
    // 输入后端：'auto' = 有 @copylee/dsh-computer-use 就用它，否则用内置 PowerShell(UIA)；
    // 'cu' = 只用 computer-use；'ps' = 只用 PowerShell（老行为）
    this.cu = cu || null;
    this.inputMode = input === 'cu' || input === 'ps' ? input : 'auto';
    this.rect = null;
    this.pid = 0;
    this._ocr = null;
    this._ocrBuf = '';
    this._ocrWaiters = [];
    this._seq = 0;
    this._fgAt = 0;
    // 常驻 PowerShell 进程（uia2srv.ps1）。启动失败或超时就回退一次性 spawn，
    // _psWorkerFailAt 之后 WORKER_RETRY_MS 内不再尝试，避免每一步都白等一次启动。
    this._psWorker = null;
    this._psWorkerReady = false;
    this._psWorkerFailAt = 0;
    this._psWorkerSeq = 0;
    // 用户点「停止」时置 true：之后不再重试、不再重启客户端（避免反复弹窗）
    this.abortFlag = false;
  }

  abort() {
    this.abortFlag = true;
  }

  _checkAbort() {
    if (this.abortFlag) {
      const e = new Error('桌面任务已停止');
      e.aborted = true;
      throw e;
    }
  }

  // ---------- 常驻 OCR ----------
  startOcr() {
    if (this._ocr?.pid) return;
    const proc = spawn(this.python, [OCRAPI], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
    this._ocr = proc;
    this._ocrBuf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this._ocrBuf += chunk;
      let idx;
      while ((idx = this._ocrBuf.indexOf('\n')) >= 0) {
        const line = this._ocrBuf.slice(0, idx).trim();
        this._ocrBuf = this._ocrBuf.slice(idx + 1);
        if (!line) continue;
        const w = this._ocrWaiters.shift();
        if (!w) {
          this.log({ ev: 'ocr-stray', line: line.slice(0, 120) });
          continue;
        }
        try {
          w.resolve(JSON.parse(line));
        } catch (e) {
          w.reject(new Error('ocr json: ' + line.slice(0, 200)));
        }
      }
    });
    proc.stderr.on('data', (d) => this.log({ ev: 'ocr-stderr', err: String(d).slice(0, 200) }));
    // 进程退出/启动失败：把所有在等的请求一次性失败掉，避免每个请求都空等 60s
    const failAll = (why) => {
      if (this._ocr !== proc) return;
      this._ocr = null;
      this._ocrBuf = '';
      for (const w of this._ocrWaiters.splice(0)) w.reject(new Error(why));
    };
    proc.on('error', (e) => {
      this.log({ ev: 'ocr-error', err: String(e).slice(0, 200) });
      failAll('OCR 进程启动失败');
    });
    proc.on('exit', (code) => {
      this.log({ ev: 'ocr-exit', code });
      failAll('OCR 进程已退出');
    });
  }

  ocrReq(req, timeoutMs = 60000) {
    this.startOcr();
    return new Promise((resolve, reject) => {
      const drop = () => {
        const i = this._ocrWaiters.indexOf(waiter);
        if (i >= 0) this._ocrWaiters.splice(i, 1);
      };
      const waiter = {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
      const t = setTimeout(() => {
        // 超时必须把自己从队列里摘掉，否则下一条 OCR 结果会喂给已死的请求，之后所有响应错位一格
        drop();
        reject(new Error('OCR 超时'));
      }, timeoutMs);
      this._ocrWaiters.push(waiter);
      try {
        this._ocr.stdin.write(JSON.stringify(req) + '\n');
      } catch (e) {
        drop();
        waiter.reject(e);
      }
    });
  }

  close() {
    this._killWorker();
    const proc = this._ocr;
    this._ocr = null;
    this._ocrBuf = '';
    for (const w of this._ocrWaiters.splice(0)) w.reject(new Error('OCR 已关闭'));
    try {
      proc?.stdin.end();
      proc?.kill();
    } catch {}
  }

  // ---------- 批量动作（输入类走 computer-use，其余走 PowerShell） ----------
  async actions(list, timeoutMs = 90000) {
    const wantCu = !!this.cu && !!this.rect && (this.inputMode === 'cu' || (this.inputMode === 'auto' && this.cu.available()));
    if (!wantCu) return this.actionsPs(list, timeoutMs);
    const results = [];
    let buf = [];
    const flush = async () => {
      if (!buf.length) return;
      const p = await this.actionsPs(buf, timeoutMs);
      const rs = p && p.results ? p.results : [];
      for (let i = 0; i < buf.length; i++) results.push(rs[i] ?? null);
      buf = [];
    };
    for (const a of list) {
      const cmd = a && a.cmd;
      if (cmd === 'click' || cmd === 'clicknow' || cmd === 'move' || cmd === 'key' || cmd === 'paste') {
        await flush();
        results.push(
          await this._input(cmd === 'clicknow' ? 'click' : cmd, a, async () => {
            const r = this.rect;
            if (cmd === 'click' || cmd === 'clicknow') {
              await this.cu.clickInRect(r, a.x, a.y);
              return { ok: true, via: 'cu' };
            }
            if (cmd === 'move') {
              await this.cu.moveInRect(r, a.x, a.y);
              return { ok: true, via: 'cu' };
            }
            if (cmd === 'key') {
              await this.cu.press(this.cuSeq(a.seq));
              return { ok: true, via: 'cu' };
            }
            await this.cu.typeText(a.text);
            return { ok: true, via: 'cu' };
          }),
        );
      } else if (cmd === 'sleep') {
        await flush();
        await sleep(Number(a.ms) || 200);
        results.push({ ok: true });
      } else {
        buf.push(a);
      }
    }
    await flush();
    return { ok: true, results, rect: this.rect };
  }

  // ---------- PowerShell 批量动作 ----------
  async actionsPs(list, timeoutMs = 90000) {
    this._checkAbort();
    // 常驻进程：正常时单批动作 30~250ms（一次性 spawn 固定 ~1.5s）。
    // 只有传输层失败才回退并暂时停用；窗口不存在/隐藏这类业务错误走下面的一次性路径与重试循环。
    if (PS_WORKER_ON && Date.now() - this._psWorkerFailAt > WORKER_RETRY_MS) {
      try {
        const payload = await this._workerCall(list, Math.max(8000, Math.min(timeoutMs, 60000)));
        return this._applyPayload(payload);
      } catch (e) {
        if (e && e.aborted) throw e;
        if (!(e && (e.hidden || e.windowMissing))) {
          this.log({ ev: 'ps-worker-fallback', err: String((e && e.message) || e).slice(0, 160) });
          this._psWorkerFailAt = Date.now();
          this._killWorker();
        }
      }
    }
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      this._checkAbort();
      try {
        return await this._actionsOnce(list, timeoutMs);
      } catch (e) {
        lastErr = e;
        const msg = String((e && e.message) || e);
        if (e && e.hidden) throw e; // 托盘隐藏：交给引擎重启客户端，不要在这里盲目重试
        if (!/窗口不存在|进程不存在/.test(msg)) throw e;
        this._checkAbort();
        // 客户端启动时 splash 会先关、主窗口后建；也可能自己重启（pid 变化）→ 等窗口回来再试
        const p = await findAppPid('cxstudy');
        if (p) {
          this.pid = p;
          if (await this.waitWindow(12000)) continue;
        }
        this._checkAbort();
        await sleep(800);
        // 进程还在但没有窗口（切标签到托盘 / 崩溃）→ 重启一次客户端
        if (this.appPath && attempt < 2 && !(await this.ensure())) {
          this._checkAbort();
          await this.ensureWindow(this.appPath, { force: true });
        }
      }
    }
    throw lastErr || new Error('学习通动作失败');
  }

  /** 窗口不在就恢复（先「唤醒」托盘里的实例，再不行才重启进程） */
  async ensureWindow(appPath, { force = false } = {}) {
    if (this.abortFlag) return false;
    if (!force && (await this.ensure())) return true;
    this.log({ ev: 'ensure-window', relaunch: true });
    const r = await this.launch(appPath || this.appPath || '', { waitMs: 30000 });
    return !!r.ok;
  }

  // ---------- 常驻 PowerShell 进程（uia2srv.ps1） ----------
  _workerUsable() {
    return PS_WORKER_ON && !!this._psWorker && this._psWorkerReady && this._psWorker.exitCode === null;
  }

  _killWorker() {
    const proc = this._psWorker;
    this._psWorker = null;
    this._psWorkerReady = false;
    this._psToken = null;
    try { proc?.kill(); } catch {}
  }

  async _startWorker(timeoutMs = 15000) {
    if (this._workerUsable()) return;
    this._killWorker();
    const dir = path.join(this.workDir, 'psq');
    try { mkdirSync(dir, { recursive: true }); } catch {}
    // 清掉上一轮残留的请求/响应（进程崩溃时会留下）
    try {
      for (const f of readdirSync(dir)) {
        if (/^(req|res)-.*\.json$/.test(f) || f === 'ready.txt') {
          try { unlinkSync(path.join(dir, f)); } catch {}
        }
      }
    } catch {}
    const srv = stableSrv(this.workDir);
    const core = stableCore(this.workDir);
    // 每次启动生成一次性 token：请求文件名、请求内容、响应都要带它。
    // 这样即使 workDir 指向共享/可写目录，其它进程也不能投放 req 让常驻进程执行动作，
    // 或抢先写 res 伪造「执行成功」。
    const token = randomBytes(16).toString('hex');
    this._psToken = token;
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', srv, '-ServerDir', dir, '-AppPid', String(this.pid || 0), '-CorePs1', core, '-Token', token, '-OutDir', this.workDir];
    const proc = spawn(PS, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this._psWorker = proc;
    this._psWorkerReady = false;
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => this.log({ ev: 'ps-worker-stderr', err: String(d).slice(0, 200) }));
    proc.on('error', (e) => {
      if (this._psWorker === proc) { this._psWorker = null; this._psWorkerReady = false; }
      this.log({ ev: 'ps-worker-error', err: String((e && e.message) || e).slice(0, 160) });
    });
    proc.on('exit', (code) => {
      if (this._psWorker === proc) { this._psWorker = null; this._psWorkerReady = false; }
      this.log({ ev: 'ps-worker-exit', code });
    });
    const ready = path.join(dir, 'ready.txt');
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (existsSync(ready)) {
        this._psWorkerReady = true;
        this.log({ ev: 'ps-worker-start', ms: Date.now() - t0 });
        return;
      }
      if (this._psWorker !== proc) break;
      await sleep(30);
    }
    this._killWorker();
    throw new Error('常驻 PowerShell 启动失败');
  }

  /** 通过常驻进程执行一批动作（只负责传输；payload 里的窗口错误交给 _applyPayload） */
  async _workerCall(list, timeoutMs = 20000) {
    if (!this._workerUsable()) await this._startWorker();
    const dir = path.join(this.workDir, 'psq');
    const token = this._psToken;
    if (!token) throw new Error('常驻 PowerShell 未就绪');
    const id = `${String(Date.now()).padStart(13, '0')}-${String(this._psWorkerSeq++).padStart(6, '0')}`;
    const req = path.join(dir, `req-${id}.${token}.json`);
    const res = path.join(dir, `res-${id}.${token}.json`);
    writeFileSync(req, '\uFEFF' + JSON.stringify({ token, actions: list }), 'utf8');
    const t0 = Date.now();
    try {
      while (Date.now() - t0 < timeoutMs) {
        if (existsSync(res)) {
          const payload = await readJsonReady(res);
          if (!payload || payload.t !== token) throw new Error('常驻 PowerShell 响应校验失败（token 不符）');
          if (payload && payload.ok === false) throw new Error('常驻 PowerShell 报错：' + String(payload.err || '').slice(0, 160));
          return payload;
        }
        if (!this._workerUsable()) throw new Error('常驻 PowerShell 已退出');
        await sleep(8);
      }
      throw new Error(`常驻 PowerShell 超时（${timeoutMs}ms）`);
    } finally {
      try { unlinkSync(req); } catch {}
      try { unlinkSync(res); } catch {}
    }
  }

  /** 统一处理 payload：窗口消失/隐藏抛出专用错误，正常时刷新 rect */
  _applyPayload(payload) {
    if (payload.err === 'window-not-found' || payload.err === 'window-rect-invalid') {
      this.pid = 0;
      this.rect = null;
      const tops = payload.tops || [];
      const names = tops.map((w) => w.name || w.class).filter(Boolean).slice(0, 8).join(' / ');
      const e = new Error(`学习通窗口不存在（${payload.err}；可用窗口：${names}）`);
      e.windowMissing = true;
      throw e;
    }
    if (payload.rect) this.rect = payload.rect;
    // 隐藏到托盘的主窗口：rect 还在、但屏幕上没有它 —— 继续 OCR/点击只会把别的窗口（比如 DSH 自己）当成学习通
    if (payload.rect && payload.rect.visible === false) {
      this.hiddenAt = Date.now();
      const e = new Error('桌面窗口已隐藏（被切到托盘了），需要重启学习通客户端');
      e.hidden = true;
      throw e;
    }
    return payload;
  }

  async _actionsOnce(list, timeoutMs = 60000) {
    const id = `${process.pid}-${Date.now()}-${this._seq++}`;
    const af = path.join(this.workDir, `act-${id}.json`);
    const of = path.join(this.workDir, `act-${id}.out.json`);
    // PowerShell 5.1 读取无 BOM 的 UTF-8 会按 ANSI 解析（中文路径会乱码），必须带 BOM
    writeFileSync(af, '\uFEFF' + JSON.stringify(list), 'utf8');
    const ps1 = stablePs1(this.workDir);
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-AppPid', String(this.pid || 0), '-Actions', af, '-Out', of, '-CorePs1', stableCore(this.workDir)];
    let r = await spawnCapture(PS, args, { timeoutMs });
    // 极少数情况下 PowerShell 仍会读到脚本的半截内容，重跑一次通常就好
    if (!r || /缺少终止符|UnterminatedString|ParserError|字符串缺少/.test(String((r && r.stderr) || ''))) {
      try { unlinkSync(of); } catch {}
      r = await spawnCapture(PS, args, { timeoutMs });
    }
    let payload = null;
    try {
      payload = JSON.parse(readFileSync(of, 'utf8'));
    } catch {
      payload = null;
    }
    try { unlinkSync(af); } catch {}
    try { unlinkSync(of); } catch {}
    if (!payload) {
      const raw = String(r.stdout || '').trim();
      if (raw.startsWith('[')) {
        const wins = JSON.parse(raw);
        this.pid = 0;
        this.windows = wins;
        throw new Error('学习通窗口不存在（可用窗口：' + wins.map((w) => w.name || w.class).join(' / ') + '）');
      }
      throw new Error('PowerShell 动作失败：' + String(r.stderr || raw).slice(0, 300));
    }
    return this._applyPayload(payload);
  }

  /** 关掉所有 cxstudy 进程（让自动化从干净的「首页」开始） */
  async killAll() {
    try {
      await spawnCapture('taskkill', ['/IM', 'cxstudy.exe', '/F', '/T'], { timeoutMs: 20000 });
    } catch { /* ignore */ }
    // 客户端有单实例锁：进程刚被杀时立刻重启会被判为「已在运行」而静默退出，必须等它真的退干净。
    // 用 await sleep 让出事件循环，避免原来的 Atomics.wait 忙等把 WS/OCR 回调一起冻住 5s。
    for (let i = 0; i < 20; i++) {
      if (!(await findAppPid('cxstudy'))) break;
      await sleep(250);
    }
    this.pid = 0;
    this.rect = null;
    return true;
  }

  async ensure(pid = 0) {
    this.pid = pid || (await findAppPid('cxstudy'));
    if (!this.pid) return false;
    try {
      const p = await this._actionsOnce([{ cmd: 'rect' }]);
      return !!p.rect;
    } catch {
      return false;
    }
  }

  async _ensureLegacy(pid = 0) {
    this.pid = pid || (await findAppPid('cxstudy'));
    if (!this.pid) return false;
    try {
      const p = this.actions([{ cmd: 'rect' }]);
      return !!p.rect;
    } catch {
      return false;
    }
  }

  async waitWindow(timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await this.ensure()) return true;
      await sleep(700);
    }
    return false;
  }

  /** 全窗口截图（返回文件路径；必须 await 落盘，否则调用方会读到上一帧或空文件）。
   * 只接受纯文件名：PowerShell 侧会强制压掉目录部分并落到 workDir，避免任意路径写入。 */
  async shot(out) {
    const name = out ? path.basename(String(out)) : `shot-${Date.now()}.png`;
    const p = await this.actions([{ cmd: 'shot', out: name }]);
    return (p && p.results && p.results[0] && p.results[0].out) || path.join(this.workDir, name);
  }

  /** 区域 OCR（WinRT 内置 OCR，约 150~300ms，坐标已换算成窗口坐标） */
  async readRegion(box, o = {}) {
    // 兼容历史调用方传数字（原来会被当成对象解构，scale 恒为 1，放大请求全部失效）
    const opt = typeof o === 'number' ? { scale: o } : (o || {});
    const scale = Math.max(1, Math.min(4, Number(opt.scale) || 1));
    const p = await this.actions([{ cmd: 'ocr', x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), scale }]);
    const items = p.results?.[0]?.items;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
  }

  /** 全窗口 OCR */
  async readAll(opts = {}) {
    return this.readRegion({ x: 0, y: 0, w: 0, h: 0 }, opts);
  }

  /** 区域内像素哈希（判断页面是否变化，非常快） */
  async hash(box) {
    const p = await this.actions([{ cmd: 'hash', x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }]);
    return p.results?.[0]?.hash || '';
  }

  /**
   * 把 PowerShell SendKeys 风格的按键串（^a / %F4 / {PGDN} / {ENTER}）翻成 computer-use 认识的名字
   * （ctrl+a / Alt+F4 / PageDown / Return）。认不出来的原样返回，交给 PS 回退。
   */
  cuSeq(seq) {
    const s = String(seq == null ? '' : seq).trim();
    if (!s) return s;
    const brace = {
      PGDN: 'PageDown',
      PAGEUP: 'PageUp',
      ENTER: 'Return',
      RETURN: 'Return',
      TAB: 'Tab',
      ESC: 'Escape',
      HOME: 'Home',
      END: 'End',
      DEL: 'Delete',
      DELETE: 'Delete',
      BS: 'Backspace',
      BACKSPACE: 'Backspace',
      UP: 'Up',
      DOWN: 'Down',
      LEFT: 'Left',
      RIGHT: 'Right',
      SPACE: 'Space',
    };
    const one = (tok) => {
      let m = /^\{([A-Za-z0-9]+)\}$/.exec(tok);
      if (m) {
        const k = m[1].toUpperCase();
        if (brace[k]) return brace[k];
        if (/^F\d{1,2}$/.test(k)) return k;
        return tok;
      }
      m = /^([\^%+])([A-Za-z0-9])$/.exec(tok);
      if (m) {
        const mod = m[1] === '^' ? 'ctrl' : m[1] === '%' ? 'alt' : 'shift';
        return `${mod}+${m[2]}`;
      }
      return tok;
    };
    return s.split(/\s+/).map(one).join('+');
  }

  /**
   * 输入后端分流：需要点鼠标/敲键盘时，优先调用 @copylee/dsh-computer-use 的工具（真实
   * SendInput + 截图坐标换算），工具不可用（没装/没授权/报错）就退回内置 PowerShell(UIA) 驱动。
   */
  async _input(name, args, cuFn) {
    this._checkAbort();
    if (this.cu && typeof this.cu.setWindowRect === 'function') this.cu.setWindowRect(this.rect);
    const wantCu = !!this.cu && (this.inputMode === 'cu' || (this.inputMode === 'auto' && this.cu.available()));
    if (wantCu) {
      try {
        const r = await cuFn();
        this.lastInput = 'cu';
        this.cuOk = (this.cuOk || 0) + 1;
        return r;
      } catch (e) {
        this.cuFail = (this.cuFail || 0) + 1;
        this.log({ ev: 'cu-input-fail', name, err: String((e && e.message) || e).slice(0, 200) });
        if (this.inputMode === 'cu') throw e;
      }
    }
    this.lastInput = 'ps';
    // 注意：这里必须直接用 PowerShell 通道（actionsPs），不能再走 actions()，
    // 否则 auto 模式下会再次尝试 CU → 失败 → 再回退，形成无限递归。
    if (name === 'move') return this.actionsPs([{ cmd: 'move', ...args }]);
    return this.actionsPs([{ cmd: name, ...args }]);
  }

  /**
   * 在窗口内某区域中心发一次真实滚轮（不点击，避免误点开行）。
   * 鼠标滚轮在 Electron webview 内层只有真实 SendInput 才生效，所以必须走 computer-use。
   */
  async wheelInRect(rect, { direction = 'down', amount = 5, rx = null, ry = null } = {}) {
    this._checkAbort();
    if (!this.cu) throw new Error('没有可用的 computer-use，滚轮不可用');
    if (typeof this.cu.setWindowRect === 'function') this.cu.setWindowRect(this.rect);
    if (!(await this.cu.calibrate())) throw new Error('CU 校准失败，滚轮不可用');
    const cx = rx == null ? Math.round(rect.w / 2) : Math.round(rx);
    const cy = ry == null ? Math.round(rect.h / 2) : Math.round(ry);
    const p = this.cu.toShotInRect(this.rect, cx, cy);
    // 先把鼠标移到目标点再滚，保证滚的是这个区域
    await this._input('move', null, () => this.cu.moveShot(p.x, p.y));
    const r = await this._input('scroll', null, () => this.cu.scroll(direction, amount, p));
    return r;
  }

  /** 本次任务用了哪个输入后端、成功/失败各几次（写进日志和面板） */
  inputSummary() {
    const cuAvailable = (() => {
      try {
        return !!this.cu && this.cu.available();
      } catch {
        return false;
      }
    })();
    return {
      mode: this.inputMode,
      cu: cuAvailable,
      ok: this.cuOk || 0,
      fail: this.cuFail || 0,
      last: this.lastInput || '',
      scale: this.cu && this.cu.scale ? Number(this.cu.scale.toFixed(4)) : 0,
    };
  }

  click(x, y) {
    this._fgAt = Date.now();    return this._input('click', { x: Math.round(x), y: Math.round(y) }, async () => {
      await this.cu.clickInRect(this.rect, x, y);
      return { ok: true, via: 'cu' };
    });
  }

  clickFast(x, y) {
    return this._input('click', { x: Math.round(x), y: Math.round(y) }, async () => {
      await this.cu.clickInRect(this.rect, x, y);
      return { ok: true, via: 'cu' };
    });
  }

  /** 只移动鼠标（不点击）：用于让播放器控制条浮现 */
  move(x, y) {
    return this._input('move', { x: Math.round(x), y: Math.round(y) }, async () => {
      await this.cu.moveInRect(this.rect, x, y);
      return { ok: true, via: 'cu' };
    });
  }

  wheel(dy, x, y) {
    return this.actions([{ cmd: 'wheel', x: Math.round(x), y: Math.round(y), dy: Math.round(dy) }]);
  }

  postWheel(dy, x, y) {
    return this.actions([{ cmd: 'postwheel', x: Math.round(x), y: Math.round(y), dy: Math.round(dy) }]);
  }

  key(seq) {
    return this._input('key', { seq }, async () => {
      await this.cu.press(seq);
      return { ok: true, via: 'cu' };
    });
  }

  paste(text) {
    return this._input('paste', { text }, async () => {
      await this.cu.typeText(text);
      return { ok: true, via: 'cu' };
    });
  }

  /**
   * 在某点「点进去 + 清空 + 重新输入」。学习通作业页的填空 input 只认真实键入，
   * 合成 Ctrl+V（剪贴板粘贴）会被吞掉，所以这里走 computer-use 的 type。
   */
  async fillInRect(rect, rx, ry, text, { clear = true } = {}) {
    this._checkAbort();
    if (this.cu && typeof this.cu.setWindowRect === 'function') this.cu.setWindowRect(this.rect);
    if (!(await this.cu.calibrate())) throw new Error('CU 校准失败，无法输入');
    await this.cu.clickInRect(rect, rx, ry);
    await new Promise((r) => setTimeout(r, 350));
    if (clear) {
      try {
        await this.cu.press('ctrl+a');
        await new Promise((r) => setTimeout(r, 120));
        await this.cu.press('Delete');
      } catch {
        /* 清空失败直接输入 */
      }
    }
    await this.cu.typeText(String(text ?? ''));
    this.lastInput = 'cu';
    this.cuOk = (this.cuOk || 0) + 1;
    return { ok: true, via: 'cu' };
  }

  scrollUia(x, y, direction = 'down', count = 5) {
    return this.actions([{ cmd: 'scrolluia', x: Math.round(x), y: Math.round(y), direction, count }]);
  }

  async uia() {
    const p = await this.actions([{ cmd: 'uia' }], 90000);
    return p.results?.[0]?.items || [];
  }

  // ---------- 高层语义 ----------
  find(items, re) {
    const list = (items || []).filter((i) => re.test(i.t || ''));
    list.sort((a, b) => a.y - b.y || a.x - b.x);
    return list[0] || null;
  }

  findAll(items, re) {
    return (items || []).filter((i) => re.test(i.t || '')).sort((a, b) => a.y - b.y || a.x - b.x);
  }

  async launch(appPath, { waitMs = 25000, tries = 3 } = {}) {
    if (appPath) this.appPath = appPath;
    let started = false;
    for (let attempt = 1; attempt <= tries; attempt++) {
      let pid = await findAppPid('cxstudy');
      // 有残留进程但没有可用窗口（托盘隐藏/上次异常退出）→ 先「唤醒」已有实例，
      // 再启动一次会把它的窗口调出来（Electron 单实例语义），这样能保住登录态且更快。
      if (pid && !(await this.ensure())) {
        this.log({ ev: 'stale-app', pid, attempt });
        if (appPath) {
          try {
            const w = spawn(appPath, [], { detached: true, stdio: 'ignore', env: cleanEnv(), cwd: path.dirname(appPath) });
            w.on('error', () => {});
            w.unref();
          } catch {}
          for (let i = 0; i < 10; i++) {
            await sleep(500);
            if (await this.ensure()) {
              this.log({ ev: 'app-woken', pid: this.pid });
              return { ok: true, pid: this.pid, started: false, attempts: attempt, rect: this.rect, via: 'wake' };
            }
          }
        }
        this.log({ ev: 'stale-app-kill', pid, attempt });
        await this.killAll();
        pid = 0;
      }
      if (!pid) {
        const child = spawn(appPath, ['--force-renderer-accessibility'], { detached: true, stdio: 'ignore', env: cleanEnv(), cwd: path.dirname(appPath) });
        child.on('error', (e) => this.log({ ev: 'spawn-error', err: String(e).slice(0, 200) }));
        child.unref();
        started = true;
        for (let i = 0; i < 20 && !pid; i++) {
          await sleep(500);
          pid = await findAppPid('cxstudy');
        }
      }
      this.pid = pid || (await findAppPid('cxstudy'));
      // 等窗口稳定：连续两次拿到 rect，且间隔 1.2s 仍然在（避开 splash 一闪而过）
      const t0 = Date.now();
      while (Date.now() - t0 < waitMs) {
        if (await this.ensure()) {
          await sleep(1200);
          if (await this.ensure()) return { ok: true, pid: this.pid, started, attempts: attempt, rect: this.rect };
        }
        await sleep(700);
      }
      this.log({ ev: 'launch-retry', attempt, pid: this.pid });
      await this.killAll();
    }
    return { ok: false, pid: this.pid, started, rect: this.rect };
  }
}

export default DeskV2;
