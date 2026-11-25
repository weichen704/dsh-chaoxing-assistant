// 真实 Edge 浏览器的发现、启动与状态检查。
// 设计原则：插件从不关闭用户已有的浏览器窗口，只关闭自己创建的标签页；
// 只有通过 start 由插件启动的进程才会记录 pid（供 stop 使用）。
import fs from 'node:fs';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { browserInfo } from './cdp.mjs';
import { paths } from './paths.mjs';
import { safePort, safeStartUrl, sleep } from './util.mjs';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  '/usr/bin/microsoft-edge',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/** Edge 只可能安装在这些目录下（Windows）。 */
function edgeRoots() {
  return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((r) => path.join(r, 'Microsoft', 'Edge', 'Application'));
}

/**
 * 校验可执行文件确实是 Microsoft Edge：
 * - 必须是 msedge.exe（mac/Linux 为 Microsoft Edge 可执行名）；
 * - 拒绝 UNC、相对路径、以 `-` 开头的值（Chromium 会把它们当启动开关）；
 * - 严格模式下 realpath 必须位于 Edge 安装目录内（edgePath 参数用严格模式）。
 */
function trustedEdge(p, { strict = true } = {}) {
  if (!p) return '';
  const s = String(p).trim();
  if (!s || s.startsWith('-') || /^\\\\|^\/\//.test(s)) return '';
  let abs;
  try {
    abs = path.resolve(s);
  } catch {
    return '';
  }
  const base = path.basename(abs).toLowerCase();
  const posix = process.platform !== 'win32';
  if (posix ? !['microsoft-edge', 'microsoft edge'].includes(base) : base !== 'msedge.exe') return '';
  if (!strict) return abs;
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return '';
  }
  if (posix) return real;
  const ok = edgeRoots().some((root) => {
    const rel = path.relative(path.resolve(root), real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  return ok ? abs : '';
}

export function findEdge(explicit) {
  // 显式参数与环境变量优先，但都要过白名单；环境变量不强制位于安装目录（便携版场景）
  const fromEnv = trustedEdge(process.env.CHAOXING_EDGE, { strict: false });
  for (const p of [explicit]) {
    const t = trustedEdge(p);
    if (t) return t;
  }
  if (fromEnv) return fromEnv;
  for (const p of EDGE_CANDIDATES) {
    const t = trustedEdge(p);
    if (t) return t;
  }
  return '';
}

function tcpOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish('open'));
    sock.once('timeout', () => finish('timeout'));
    sock.once('error', (e) => finish(e && e.code === 'ECONNREFUSED' ? 'closed' : 'error'));
  });
}

/**
 * 选一个可用的调试端口：默认端口没人监听就用它，否则顺序 +1 找空位。
 * 如果默认端口上已经有 CDP，则直接复用（返回既有的 browser 信息）。
 */
export async function ensurePort(preferred) {
  const raw = preferred === undefined || preferred === null || preferred === '' ? 9422 : Number(preferred);
  const base = safePort(raw);
  // 只允许插件专用段：9222 之类的端口上通常运行着用户自己的浏览器调试实例，
  // 复用等于把带登录态的浏览器交给插件（也可能被当成提权通道）。
  if (!base) throw new Error('调试端口必须在 9300-9499 之间（插件专用段）');
  for (let i = 0; i < 40 && base + i <= 9499; i++) {
    const port = base + i;
    // 先做 400ms 的 TCP 探测：绝大多数情况（端口空着）立刻返回，
    // 不必每个端口都先付一次 4s 的 HTTP 探测
    const st = await tcpOpen(port);
    if (st === 'closed') return { port, info: null, reused: false };
    if (st === 'open') {
      const info = await browserInfo(port);
      if (info) return { port, info, reused: true };
    }
    // timeout / error：被别的程序占着或半开连接，换下一个端口
  }
  throw new Error(`从 ${base} 起 40 个端口都被占用，请在参数里指定其它调试端口（9300-9499）`);
}

/** 启动一个带远程调试端口的 Edge 窗口（真实可见窗口）。 */
export async function launchEdge({ port, profileDir, edgePath, startUrl, timeoutMs = 30000, headless = false, extraArgs = [] }) {
  const portN = safePort(port);
  if (!portN) throw new Error('调试端口必须在 9300-9499 之间（插件专用段）');
  const exe = findEdge(edgePath);
  if (!exe) throw new Error('没有找到 msedge.exe：edgePath 只接受 Edge 安装目录下的 msedge.exe，或设置环境变量 CHAOXING_EDGE');
  const profile = path.resolve(profileDir);
  // 二次校验（accountGet 已校验）：--user-data-dir 指向用户已有 Edge 配置会直接复用其登录态
  const profileRoot = path.resolve(paths().profiles);
  let realProfile = profile;
  let realRoot = profileRoot;
  try { realProfile = fs.realpathSync(profile); } catch { /* 目录可能还不存在 */ }
  try { realRoot = fs.realpathSync(profileRoot); } catch { /* ignore */ }
  const rel = path.relative(realRoot, realProfile);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`profileDir 必须位于 ${realRoot} 之下`);
  }
  try {
    fs.mkdirSync(profile, { recursive: true });
  } catch {
    /* ignore */
  }

  const info0 = await browserInfo(portN);
  if (info0) return { port: portN, pid: 0, reused: true, version: info0.Browser || '', profile };

  const args = [
    `--remote-debugging-port=${portN}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 绝对不能加 --remote-allow-origins=*：那会关掉 DevTools WebSocket 的 Origin 校验，
    // 任何网页只要拿到 target id 就能连上带登录态的 Edge 执行 CDP。
    // 插件自己的 ws 客户端握手不带 Origin（lib/ws.mjs），不需要这个开关。
    '--disable-session-crashed-bubble',
    '--disable-features=msEdgeSessionRestore',
    // 后台标签页也保持正常计时/渲染，任务页用标签而不是新窗口时视频仍能正常推进
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (headless) args.push('--headless=new');
  args.push(...extraArgs);
  // 只允许 http(s)：绝不能把 --xxx 开关或 file:// 塞进这个位置
  args.push(safeStartUrl(startUrl) || 'about:blank');

  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref?.();
  const pid = child.pid || 0;

  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    const info = await browserInfo(portN);
    if (info) return { port: portN, pid, reused: false, version: info.Browser || '', profile };
    if (exited) {
      throw new Error(
        `Edge 启动后立刻退出（profile: ${profile}）。通常是这个 profile 已被另一个 Edge 窗口占用、但没有开调试端口：请先关闭该窗口（或换一个 profile），再重试。`,
      );
    }
    await sleep(500);
  }
  // 超时不能把刚拉起来的 Edge 留在那儿：它会占着调试端口和 profile，
  // 下次 ensurePort 被挤到下一个端口，profile 还会不断叠加
  killEdgeTree(pid);
  throw new Error(`等待 Edge 调试端口 ${portN} 超时（${Math.round(timeoutMs / 1000)}s）`);
}

export function killEdgeTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return true;
    }
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export async function edgeStatus(port) {
  const info = await browserInfo(port);
  if (!info) return { port, running: false, version: '' };
  return { port, running: true, version: info.Browser || '', wsUrl: info.webSocketDebuggerUrl || '' };
}
