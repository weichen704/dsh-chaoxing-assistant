// 真实 Edge 浏览器的发现、启动与状态检查。
// 设计原则：插件从不关闭用户已有的浏览器窗口，只关闭自己创建的标签页；
// 只有通过 start 由插件启动的进程才会记录 pid（供 stop 使用）。
import fs from 'node:fs';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { browserInfo } from './cdp.mjs';
import { sleep } from './util.mjs';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  '/usr/bin/microsoft-edge',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

export function findEdge(explicit) {
  for (const p of [explicit, process.env.CHAOXING_EDGE, ...EDGE_CANDIDATES]) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
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
  const base = Number(preferred) || 9422;
  for (let i = 0; i < 40; i++) {
    const port = base + i;
    const info = await browserInfo(port);
    if (info) return { port, info, reused: true };
    const st = await tcpOpen(port);
    if (st === 'closed') return { port, info: null, reused: false };
  }
  throw new Error(`从 ${base} 起 40 个端口都被占用，请在参数里指定其它调试端口`);
}

/** 启动一个带远程调试端口的 Edge 窗口（真实可见窗口）。 */
export async function launchEdge({ port, profileDir, edgePath, startUrl, timeoutMs = 30000, headless = false, extraArgs = [] }) {
  const exe = findEdge(edgePath);
  if (!exe) throw new Error('没有找到 msedge.exe，请用 edgePath 参数指定 Edge 路径，或设置环境变量 CHAOXING_EDGE');
  const profile = path.resolve(profileDir);
  try {
    fs.mkdirSync(profile, { recursive: true });
  } catch {
    /* ignore */
  }

  const info0 = await browserInfo(port);
  if (info0) return { port, pid: 0, reused: true, version: info0.Browser || '', profile };

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
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
  args.push(startUrl || 'about:blank');

  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref?.();
  const pid = child.pid || 0;

  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    const info = await browserInfo(port);
    if (info) return { port, pid, reused: false, version: info.Browser || '', profile };
    if (exited) {
      throw new Error(
        `Edge 启动后立刻退出（profile: ${profile}）。通常是这个 profile 已被另一个 Edge 窗口占用、但没有开调试端口：请先关闭该窗口（或换一个 profile），再重试。`,
      );
    }
    await sleep(500);
  }
  throw new Error(`等待 Edge 调试端口 ${port} 超时（${Math.round(timeoutMs / 1000)}s）`);
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
