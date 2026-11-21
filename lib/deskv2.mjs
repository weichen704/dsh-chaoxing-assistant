// 桌面客户端 v2 驱动：常驻 OCR + 批量 PowerShell 动作（低延迟）
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PS1 = path.join(here, '..', 'desktop', 'uia2.ps1');
export const OCRAPI = path.join(here, '..', 'desktop', 'ocrapi.py');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const DEFAULT_PY = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

export function findAppPid(name = 'cxstudy') {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
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
  constructor({ python = process.env.CHAOXING_PYTHON || DEFAULT_PY, workDir, log = () => {}, cu = null, input = 'auto' } = {}) {
    this.python = python;
    this.workDir = workDir || path.join(os.tmpdir(), 'dsh-chaoxing-shots');
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
    this._ocr = spawn(this.python, [OCRAPI], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
    this._ocr.stdout.setEncoding('utf8');
    this._ocr.stdout.on('data', (chunk) => {
      this._ocrBuf += chunk;
      let idx;
      while ((idx = this._ocrBuf.indexOf('\n')) >= 0) {
        const line = this._ocrBuf.slice(0, idx).trim();
        this._ocrBuf = this._ocrBuf.slice(idx + 1);
        if (!line) continue;
        const w = this._ocrWaiters.shift();
        try {
          w?.resolve(JSON.parse(line));
        } catch (e) {
          w?.reject(new Error('ocr json: ' + line.slice(0, 200)));
        }
      }
    });
    this._ocr.stderr.on('data', (d) => this.log({ ev: 'ocr-stderr', err: String(d).slice(0, 200) }));
    this._ocr.on('exit', (code) => {
      this.log({ ev: 'ocr-exit', code });
      this._ocr = null;
    });
  }

  ocrReq(req, timeoutMs = 60000) {
    this.startOcr();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('OCR 超时')), timeoutMs);
      this._ocrWaiters.push({
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this._ocr.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  close() {
    try {
      this._ocr?.stdin.end();
      this._ocr?.kill();
    } catch {}
    this._ocr = null;
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
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      this._checkAbort();
      try {
        return this._actionsOnce(list, timeoutMs);
      } catch (e) {
        lastErr = e;
        const msg = String((e && e.message) || e);
        if (e && e.hidden) throw e; // 托盘隐藏：交给引擎重启客户端，不要在这里盲目重试
        if (!/窗口不存在|进程不存在/.test(msg)) throw e;
        this._checkAbort();
        // 客户端启动时 splash 会先关、主窗口后建；也可能自己重启（pid 变化）→ 等窗口回来再试
        const p = findAppPid('cxstudy');
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

  /** 窗口不在就重启（进程残留但无窗口、托盘隐藏、崩溃都走这里） */
  async ensureWindow(appPath, { force = false } = {}) {
    if (this.abortFlag) return false;
    if (!force && (await this.ensure())) return true;
    this.log({ ev: 'ensure-window', relaunch: true });
    this.killAll();
    await sleep(2200);
    const r = await this.launch(appPath || this.appPath || '', { waitMs: 30000 });
    return !!r.ok;
  }

  _actionsOnce(list, timeoutMs = 60000) {
    const id = `${process.pid}-${Date.now()}-${this._seq++}`;
    const af = path.join(this.workDir, `act-${id}.json`);
    const of = path.join(this.workDir, `act-${id}.out.json`);
    // PowerShell 5.1 读取无 BOM 的 UTF-8 会按 ANSI 解析（中文路径会乱码），必须带 BOM
    writeFileSync(af, '\uFEFF' + JSON.stringify(list), 'utf8');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-AppPid', String(this.pid || 0), '-Actions', af, '-Out', of];
    const r = spawnSync(PS, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
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
    if (payload.err === 'window-not-found' || payload.err === 'window-rect-invalid') {
      this.pid = 0;
      this.rect = null;
      const tops = payload.tops || [];
      const names = tops.map((w) => w.name || w.class).filter(Boolean).slice(0, 8).join(' / ');
      throw new Error(`学习通窗口不存在（${payload.err}；可用窗口：${names}）`);
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

  /** 关掉所有 cxstudy 进程（让自动化从干净的「首页」开始） */
  killAll() {
    try {
      spawnSync('taskkill', ['/IM', 'cxstudy.exe', '/F', '/T'], { windowsHide: true, timeout: 20000 });
    } catch { /* ignore */ }
    // 客户端有单实例锁：进程刚被杀时立刻重启会被判为「已在运行」而静默退出，必须等它真的退干净
    for (let i = 0; i < 20; i++) {
      if (!findAppPid('cxstudy')) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    this.pid = 0;
    this.rect = null;
    return true;
  }

  async ensure(pid = 0) {
    this.pid = pid || findAppPid('cxstudy');
    if (!this.pid) return false;
    try {
      const p = this._actionsOnce([{ cmd: 'rect' }]);
      return !!p.rect;
    } catch {
      return false;
    }
  }

  async _ensureLegacy(pid = 0) {
    this.pid = pid || findAppPid('cxstudy');
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

  /** 全窗口截图（返回文件路径） */
  shot(out) {
    const file = out || path.join(this.workDir, `shot-${Date.now()}.png`);
    this.actions([{ cmd: 'shot', out: file }]);
    return file;
  }

  /** 区域 OCR（WinRT 内置 OCR，约 150~300ms，坐标已换算成窗口坐标） */
  async readRegion(box, { scale = 1 } = {}) {
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
  hash(box) {
    const p = this.actions([{ cmd: 'hash', x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }]);
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

  uia() {
    const p = this.actions([{ cmd: 'uia' }], 90000);
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
      let pid = findAppPid('cxstudy');
      // 有残留进程但没有可用窗口（托盘残留/上次异常退出）→ 先杀干净再启动
      if (pid && !(await this.ensure())) {
        this.log({ ev: 'stale-app', pid, attempt });
        this.killAll();
        pid = 0;
      }
      if (!pid) {
        const child = spawn(appPath, ['--force-renderer-accessibility'], { detached: true, stdio: 'ignore', env: cleanEnv(), cwd: path.dirname(appPath) });
        child.on('error', (e) => this.log({ ev: 'spawn-error', err: String(e).slice(0, 200) }));
        child.unref();
        started = true;
        for (let i = 0; i < 20 && !pid; i++) {
          await sleep(500);
          pid = findAppPid('cxstudy');
        }
      }
      this.pid = pid || findAppPid('cxstudy');
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
      this.killAll();
    }
    return { ok: false, pid: this.pid, started, rect: this.rect };
  }
}

export default DeskV2;
