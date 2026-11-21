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

export function paths() {
  const base = dataDir();
  return {
    base,
    logs: ensureDir(path.join(base, 'logs')),
    profiles: ensureDir(path.join(base, 'profiles')),
    fonts: ensureDir(path.join(base, 'fonts')),
    captchas: ensureDir(path.join(base, 'captchas')),
    shots: ensureDir(path.join(base, 'shots')),
    tmp: ensureDir(path.join(base, 'tmp')),
    stateFile: path.join(base, 'state.json'),
  };
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
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 400);
    this._timer.unref?.();
  }

  flush() {
    try {
      ensureDir(path.dirname(this.file));
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      /* 状态落盘失败不影响主流程 */
    }
  }
}

/** 追加一行 JSON 日志 */
export function appendLog(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}
