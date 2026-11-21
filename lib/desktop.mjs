// 学习通桌面客户端（Electron）驱动：UIA + 模拟鼠标
// 依赖 desktop/uia.ps1（PowerShell + UIAutomationClient），每条命令起一个 PowerShell 进程，输出 JSON。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, clamp } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DESKTOP_SCRIPT = path.join(here, '..', 'desktop', 'uia.ps1');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const APP_NAME = '学习通';
const UI_FLAG = '--force-renderer-accessibility';

export function findDesktopApp(extra = []) {
  const cands = [];
  if (process.env.CHAOXING_DESKTOP) cands.push(process.env.CHAOXING_DESKTOP);
  const roots = [
    'D:\\软件\\cxstudy',
    'C:\\软件\\cxstudy',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'cxstudy'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'cxstudy'),
    'C:\\Program Files\\cxstudy',
    'C:\\Program Files (x86)\\cxstudy',
  ];
  for (const r of roots) {
    if (!r) continue;
    cands.push(path.join(r, 'latest', 'cxstudy.exe'));
    cands.push(path.join(r, 'cxstudy.exe'));
  }
  for (const c of extra) if (c) cands.push(c);
  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch {}
  }
  return null;
}

/** 清掉会让 Electron 以 Node 身份运行的环境变量 */
export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^ELECTRON_/i.test(k)) delete env[k];
  delete env.NODE_OPTIONS;
  return env;
}

export class DesktopDriver {
  constructor({ log = () => {}, appPath } = {}) {
    this.log = log;
    this.appPath = appPath || findDesktopApp();
  }

  /** 执行一条 UIA 命令（同步，单进程） */
  run(cmd, args = {}, timeoutMs = 30000) {
    if (!existsSync(DESKTOP_SCRIPT)) throw new Error(`UIA 脚本不存在：${DESKTOP_SCRIPT}`);
    const argv = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DESKTOP_SCRIPT, '-Cmd', cmd];
    const map = { pid: '-AppPid', name: '-Name', index: '-Index', x: '-X', y: '-Y', out: '-Out', max: '-Max' };
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null || v === '') continue;
      const flag = map[k];
      if (!flag) continue;
      argv.push(flag, String(v));
    }
    const r = spawnSync(PS, argv, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: cleanEnv(), maxBuffer: 32 * 1024 * 1024 });
    if (r.error) throw new Error(`UIA 调用失败: ${r.error.message}`);
    const out = String(r.stdout || '').trim();
    const line = out.split(/\r?\n/).filter(Boolean).pop() || '';
    let obj;
    try { obj = JSON.parse(line); } catch { throw new Error(`UIA 输出无法解析: ${out.slice(0, 300)}`); }
    return obj;
  }

  windows() { return this.run('windows').windows || []; }

  findWindow(pid = 0) {
    const wins = this.windows();
    return wins.find((w) => (pid ? w.pid === pid : w.name === APP_NAME)) || null;
  }

  /** 启动客户端（带无障碍开关，UIA 才能看到页面内容） */
  async launch({ waitMs = 30000 } = {}) {
    if (!this.appPath) throw new Error('找不到学习通桌面客户端（可设 CHAOXING_DESKTOP 指向 cxstudy.exe）');
    const win0 = this.findWindow();
    if (win0) {
      this.run('foreground', { pid: win0.pid });
      return { ok: true, pid: win0.pid, reused: true, app: this.appPath };
    }
    const child = spawn(this.appPath, [UI_FLAG], { cwd: path.dirname(this.appPath), detached: true, stdio: 'ignore', env: cleanEnv() });
    child.unref();
    const started = Date.now();
    while (Date.now() - started < waitMs) {
      await sleep(1200);
      const win = this.findWindow();
      if (win) {
        this.log({ ev: 'desktop-launched', pid: win.pid, app: this.appPath });
        this.run('foreground', { pid: win.pid });
        return { ok: true, pid: win.pid, reused: false, app: this.appPath };
      }
    }
    throw new Error('学习通客户端没有在预期时间内出现窗口');
  }

  async ensure() {
    const win = this.findWindow();
    if (!win) {
      // 已启动但没有无障碍开关时，UIA 内容读不到；提示用户通过「桌面版」按钮启动。
      throw new Error('学习通客户端未运行或不是由插件启动的（请先点「桌面版」按钮，我会带无障碍开关启动它）');
    }
    return win;
  }

  async appPid() {
    const win = await this.ensure();
    return win.pid;
  }

  async text(max = 400) {
    const pid = await this.appPid();
    const r = this.run('text', { pid, max }, 40000);
    return { items: r.items || [], count: r.count || 0 };
  }

  async find(name) {
    const pid = await this.appPid();
    const r = this.run('find', { pid, name }, 40000);
    return r.items || [];
  }

  async clickName(name, index = 0) {
    const pid = await this.appPid();
    return this.run('clickName', { pid, name, index }, 30000);
  }

  async click(x, y) {
    const pid = (this.findWindow() || {}).pid || 0;
    return this.run('click', { pid, x: Math.round(x), y: Math.round(y) }, 25000);
  }

  async rect() {
    const pid = await this.appPid();
    return this.run('rect', { pid }, 20000);
  }

  async shot(outPath) {
    const pid = await this.appPid();
    return this.run('shot', { pid, out: outPath }, 40000);
  }

  async foreground() {
    const pid = await this.appPid();
    return this.run('foreground', { pid }, 20000);
  }

  async wheel(dy, x, y) {
    const pid = await this.appPid();
    return this.run('wheel', { pid, x: Math.round(x), y: Math.round(y), dy: Math.round(dy) }, 20000);
  }

  async key(seq) {
    const pid = await this.appPid();
    return this.run('key', { pid, name: seq }, 20000);
  }

  async waitFor(name, { timeoutMs = 20000, pollMs = 1200 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const { items } = await this.text().catch(() => ({ items: [] }));
      const hit = items.find((it) => String(it.n || '').includes(name));
      if (hit) return hit;
      await sleep(pollMs);
    }
    return null;
  }

  static names(page) {
    return (page.items || []).map((it) => String(it.n || '').trim()).filter(Boolean);
  }

  static find(page, needle) {
    return (page.items || []).filter((it) => String(it.n || '').includes(needle));
  }
}

export function clampClick(x, y) {
  return [clamp(Math.round(x), 0, 10000), clamp(Math.round(y), 0, 10000)];
}
