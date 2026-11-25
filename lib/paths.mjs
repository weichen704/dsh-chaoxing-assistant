// 数据目录、状态存储与插件内资源路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const pluginRoot = path.resolve(here, '..');
export const pythonDir = path.join(pluginRoot, 'python');
export const fontmapScript = path.join(pythonDir, 'fontmap.py');
export const captchaScript = path.join(pythonDir, 'captcha.py');

/** 插件数据目录：默认 ~/.dsh-chaoxing，可用环境变量覆盖 */
export function dataDir() {
  const env = process.env.CHAOXING_DATA_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.dsh-chaoxing');
}

export function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* ignore */
  }
  return p;
}

let cachedBase = '';
let cachedPaths = null;

export function paths() {
  const base = dataDir();
  // 记忆化：pushLog 每条日志都会调用 paths()，而 ensureDir×6 的同步 mkdir 是纯开销。
  // 目录被外部删掉时，appendLog 的 catch 会调用 resetPathsCache() 自愈。
  if (cachedPaths && cachedBase === base) return cachedPaths;
  const p = {
    base,
    logs: ensureDir(path.join(base, 'logs')),
    profiles: ensureDir(path.join(base, 'profiles')),
    fonts: ensureDir(path.join(base, 'fonts')),
    captchas: ensureDir(path.join(base, 'captchas')),
    shots: ensureDir(path.join(base, 'shots')),
    tmp: ensureDir(path.join(base, 'tmp')),
    stateFile: path.join(base, 'state.json'),
  };
  cachedBase = base;
  cachedPaths = p;
  return p;
}

export function resetPathsCache() {
  cachedBase = '';
  cachedPaths = null;
}

function emptyState() {
  return { version: 1, accounts: {}, courses: {}, scans: {}, answers: {}, works: {}, notes: {} };
}

/** 极简 JSON 状态仓库：读时同步、写时原子替换 + 去抖批量落盘。 */
export class Store {
  constructor(file) {
    this.file = file || paths().stateFile;
    this.data = emptyState();
    this._timer = null;
    this._dirty = false;
    this._logs = { llm: [], auto: [] };
    this.load();
  }

  /** 插件级事件日志：内存环形缓冲（给工具读）+ 追加到 <logs>/plugin.jsonl */
  pushLog(channel, obj) {
    const rec = { at: new Date().toISOString(), ch: channel, ...obj };
    const buf = this._logs[channel] || (this._logs[channel] = []);
    buf.push(rec);
    if (buf.length > 200) buf.splice(0, buf.length - 200);
    try {
      appendLog(path.join(paths().logs, 'plugin.jsonl'), rec);
    } catch {
      /* ignore */
    }
    return rec;
  }

  logs(channel, limit = 40) {
    const buf = this._logs[channel] || [];
    return buf.slice(-Math.max(0, limit));
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { ...emptyState(), ...parsed };
        for (const k of ['accounts', 'courses', 'scans', 'answers', 'works', 'notes']) {
          if (!this.data[k] || typeof this.data[k] !== 'object') this.data[k] = {};
        }
      }
    } catch {
      // 解析失败时先把坏文件留档，避免下一次 flush 把账号/课程/答案缓存无声覆盖成空
      try {
        if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.bad-${Date.now()}`);
      } catch {
        /* ignore */
      }
      this.data = emptyState();
    }
    return this.data;
  }

  get(key, fallback) {
    const v = this.data[key];
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    this.data[key] = value;
    this.touch();
    return value;
  }

  touch() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 400);
    this._timer.unref?.();
  }

  flush() {
    // 先取消去抖定时器：否则 set()+flush() 会立刻写一遍、400ms 后再整档写第二遍
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return;
    try {
      ensureDir(path.dirname(this.file));
      const tmp = `${this.file}.${process.pid}.tmp`;
      // 状态档只给机器读：去掉缩进能少写 ~35% 的字节（141KB → ~90KB），整档同步写更快。
      // mode 0600：state.json 里有账号目录、答案缓存，POSIX 下别让同机其他用户读（Windows 忽略 mode）
      fs.writeFileSync(tmp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch {
      /* 状态落盘失败不影响主流程 */
    }
  }

  /** 卸载/热重载时调用：取消挂起的去抖写，避免旧 Store 覆盖新 Store 的数据 */
  dispose() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    // 卸载/热重载前把缓冲日志落盘，避免最后几行丢在内存里
    try {
      flushLogsSync();
    } catch {
      /* ignore */
    }
  }
}

/** 追加一行 JSON 日志
 * 日志只给人排障、程序内快照都走内存环形缓冲，所以按文件做 250ms 批量落盘：
 * 刷课时每秒可能几十条 logLine，逐条 appendFileSync 会把事件循环拖住。 */
const LOG_BUFFER = new Map(); // file -> string[]（尚未落盘的行）
const LOG_BUFFER_MAX = 400;   // 单文件积压上限：超过就立刻落盘，避免长跑时内存增长
let logTimer = null;
let logExitHooked = false;

function writeBuffered(file) {
  const lines = LOG_BUFFER.get(file);
  if (!lines || !lines.length) return;
  LOG_BUFFER.set(file, []);
  const chunk = lines.join('');
  try {
    fs.appendFileSync(file, chunk, 'utf8');
  } catch {
    // 目录被外部清掉或磁盘抖动：重建一次再试，别把日志静默丢掉
    try {
      resetPathsCache();
      ensureDir(path.dirname(file));
      fs.appendFileSync(file, chunk, 'utf8');
    } catch {
      return;
    }
  }
  // 落盘时顺手检查体积，超过 8MB 滚动一份，避免日志无限增长
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024) {
      try {
        fs.unlinkSync(`${file}.1`);
      } catch {
        /* ignore */
      }
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* ignore */
  }
}

/** 立即把缓冲里的日志落盘（退出/卸载/工具读日志前调用） */
export function flushLogsSync() {
  if (logTimer) {
    clearTimeout(logTimer);
    logTimer = null;
  }
  for (const file of Array.from(LOG_BUFFER.keys())) writeBuffered(file);
}

export function appendLog(file, obj) {
  let line;
  try {
    line = JSON.stringify(obj) + '\n';
  } catch {
    return;
  }
  let buf = LOG_BUFFER.get(file);
  if (!buf) {
    buf = [];
    LOG_BUFFER.set(file, buf);
  }
  buf.push(line);
  if (buf.length >= LOG_BUFFER_MAX) {
    writeBuffered(file);
    return;
  }
  if (!logTimer) {
    logTimer = setTimeout(() => {
      logTimer = null;
      flushLogsSync();
    }, 250);
    logTimer.unref?.();
  }
  if (!logExitHooked) {
    logExitHooked = true;
    process.once('exit', () => {
      try {
        flushLogsSync();
      } catch {
        /* ignore */
      }
    });
  }
}
