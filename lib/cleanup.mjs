// 临时数据清理：用户点「停止」立即清；没点停止则超过 TTL（默认 24 小时）自动清。
// 只清理插件自己产生的运行产物（任务日志 / 验证码 / 截图 / 桌面临时动作文件 / 坏档备份），
// 绝不碰 profiles（Edge 登录态）、fonts、state.json 主档以及账号/课程/答案/作业缓存。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pathsMod from './paths.mjs';

const { paths } = pathsMod;

const HOUR = 3600 * 1000;
const ACTIVE_ENGINE = new Set(['starting', 'running', 'need_captcha']);
const ACTIVE_DESK = new Set(['starting', 'running']);
const RUN_LOG_RE = /^(?:job|desk)_.+\.jsonl$/i;
const BAD_STATE_RE = /^state\.json\.bad-\d+$/i;
const WORK_TEMP_RE = /^(?:act-.+\.json|act-.+\.out\.json|uia2\.cache\.ps1|shot-\d+\.png|screen-\d+\.png)$/i;
const DEFAULT_WORKDIR = path.join(os.tmpdir(), 'dsh-chaoxing-shots');

function toInt(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : d;
}

function fileStat(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

/**
 * 插件临时数据清理器。
 * - start()：启动 5 秒后扫一次，之后每 intervalMinutes 扫一次（只清超过 ttlHours 的）
 * - afterStop()：用户点「停止」时同步清一次；任务真正退出前还会写最后几行日志，
 *   所以 10s/45s/5min 后再按“停止时刻已存在的路径”补刀，新任务的新文件不会误删
 * - dispose()：清掉所有 timer（插件卸载时调用；未清完的交给下次启动的 TTL 扫描）
 */
export class TempCleaner {
  constructor({ deps = {}, config = {}, log = () => {} } = {}) {
    this.deps = deps;
    this.log = typeof log === 'function' ? log : () => {};
    const raw = config && typeof config === 'object' ? config : {};
    const c = raw.cleanup && typeof raw.cleanup === 'object' ? raw.cleanup : {};
    this.enabled = raw.cleanup !== false && c.enabled !== false;
    this.ttlMs = Math.max(1, toInt(c.ttlHours ?? process.env.CHAOXING_TEMP_TTL_HOURS, 24)) * HOUR;
    this.intervalMs = Math.max(1, toInt(c.intervalMinutes, 30)) * 60 * 1000;
    const defer = Array.isArray(c.deferMs)
      ? c.deferMs.map((n) => toInt(n, -1)).filter((n) => n >= 0)
      : null;
    this.deferMs = defer && defer.length ? defer : [10 * 1000, 45 * 1000, 5 * 60 * 1000];
    // 桌面临时目录（DeskV2/Screen 的默认目录，可用环境变量覆盖）
    this.workDir = String(c.workDir || process.env.CHAOXING_WORKDIR || DEFAULT_WORKDIR).trim() || DEFAULT_WORKDIR;
    this._timers = new Set();
    this._interval = null;
    this._busy = false;
    this._started = false;
    this._lastSweep = 0;
  }

  start() {
    if (!this.enabled || this._started) return this;
    this._started = true;
    // 启动时先让插件跑起来，5 秒后再扫，避免和 DSH 启动/浏览器拉起抢 IO
    this._schedule(() => this.sweep('startup'), 5000);
    this._interval = setInterval(() => this.sweep('interval'), this.intervalMs);
    if (typeof this._interval.unref === 'function') this._interval.unref();
    return this;
  }

  dispose() {
    this._started = false;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  /** 启动时/定时扫描：只删“最后修改时间”超过 TTL 的文件 */
  sweep(why = 'interval') {
    if (!this.enabled) return { ok: true, enabled: false, deleted: 0, bytes: 0, skipped: 0 };
    if (this._busy) return { ok: true, busy: true, deleted: 0, bytes: 0, skipped: 0 };
    const cutoff = Date.now() - this.ttlMs;
    const out = this._purge({
      forceLogs: false,
      stopping: false,
      sharedCutoff: cutoff,
      pruneLog: true,
    });
    this._lastSweep = Date.now();
    const note = {
      ev: 'temp-cleanup',
      why: String(why || 'interval').slice(0, 40),
      files: out.deleted,
      bytes: out.bytes,
      skipped: out.skipped,
    };
    if (out.pruned) note.prunedLines = out.pruned;
    if (out.deleted || out.pruned) this._note(note);
    return {
      ok: true,
      deleted: out.deleted,
      bytes: out.bytes,
      skipped: out.skipped,
      pruned: out.pruned,
    };
  }

  /** 用户点「停止」：立即清本轮/历史任务产物，并安排三次延迟补刀 */
  afterStop(reason = 'stop') {
    if (!this.enabled) return { ok: true, enabled: false, deleted: 0, bytes: 0, skipped: 0 };
    if (this._busy) return { ok: true, busy: true, deleted: 0, bytes: 0, skipped: 0 };
    const now = Date.now();
    const why = String(reason || 'stop').slice(0, 80);
    // 停止中的 job（stopRequested=true）视为可清，其他仍在跑的 job 的日志/共享临时文件保留
    const first = this._purge({
      forceLogs: true,
      stopping: true,
      sharedCutoff: now,
      pruneLog: false,
      collectShared: true,
    });
    if (first.deleted) {
      this._note({
        ev: 'temp-cleanup',
        why: `stop:${why}`,
        files: first.deleted,
        bytes: first.bytes,
        skipped: first.skipped,
      });
    }
    // 任务退出前还会 append 一行 end 日志，立即删掉后该文件会重新出现；
    // 只重试“停止那一刻已存在”的路径，新任务的 job 文件名唯一，不会误删。
    const stopLogs = first.runLogs;
    const stopShared = first.shared;
    for (const ms of this.deferMs) {
      this._schedule(() => {
        const out = this._purge({
          exactRunLogs: stopLogs,
          exactShared: stopShared,
          forceLogs: true,
          stopping: true,
          sharedCutoff: now,
          pruneLog: false,
        });
        if (out.deleted) {
          this._note({
            ev: 'temp-cleanup',
            why: `stop-delayed:${why}`,
            files: out.deleted,
            bytes: out.bytes,
            skipped: out.skipped,
          });
        }
      }, ms);
    }
    return {
      ok: true,
      deleted: first.deleted,
      bytes: first.bytes,
      skipped: first.skipped,
      deferred: this.deferMs.length,
    };
  }

  _schedule(fn, ms) {
    const t = setTimeout(() => {
      this._timers.delete(t);
      try {
        fn();
      } catch (e) {
        this._note({ ev: 'temp-cleanup-error', err: String((e && e.message) || e).slice(0, 300) });
      }
    }, Math.max(0, ms));
    if (typeof t.unref === 'function') t.unref();
    this._timers.add(t);
    return t;
  }

  /**
   * 核心清理。返回 {deleted, bytes, skipped, pruned, runLogs, shared}。
   * @param {object} opts
   * @param {boolean} opts.forceLogs  true=停止时清所有非活跃 job 日志；false=只清超过 TTL 的
   * @param {boolean} opts.stopping   是否把 stopRequested=true 的 job 视为“已停”
   * @param {number} opts.sharedCutoff 共享目录（验证码/截图/tmp/workDir）文件的 mtime 上限
   * @param {boolean} opts.pruneLog    是否裁剪 plugin.jsonl 旧行 + 清坏档/轮转日志
   * @param {string[]|null} opts.exactRunLogs 只重试这些任务日志路径
   * @param {boolean} opts.collectShared 是否先记录（不一定删除）共享目录旧文件，供延迟补刀
   * @param {string[]|null} opts.exactShared 只重试这些共享文件路径
   */
  _purge({
    forceLogs,
    stopping,
    sharedCutoff,
    pruneLog,
    exactRunLogs = null,
    collectShared = false,
    exactShared = null,
  }) {
    if (this._busy) return { deleted: 0, bytes: 0, skipped: 0, pruned: 0, runLogs: [], shared: [] };
    this._busy = true;
    const out = { deleted: 0, bytes: 0, skipped: 0, pruned: 0, runLogs: [], shared: [] };
    try {
      // 插件日志是 250ms 批量落盘的（见 paths.mjs）；先落盘再删，避免删完又被缓冲区重新写出来
      try {
        if (typeof pathsMod.flushLogsSync === 'function') pathsMod.flushLogsSync();
      } catch {
        /* 旧版 paths.mjs 没有这个导出也不影响清理 */
      }
      const p = paths();
      const active = this._activeIds({ includeStopping: !stopping });
      // 点停止时，stopRequested=true 的 job 已经在退出路上，不应再挡住共享临时文件清理；
      // TTL 扫描仍把它们算作存活，避免任务还没退完就被删了日志/验证码。
      const hasLive = this._hasLiveJobs({ includeStopping: !stopping });

      // 1) 任务日志：job_<engine id>.jsonl / desk_<desk id>.jsonl
      const candidates = exactRunLogs ? exactRunLogs.slice() : this._jobLogFiles(p.logs);
      for (const file of candidates) {
        const id = this._jobIdFromLog(file);
        if (id && active.has(id)) continue;
        if (!exactRunLogs) out.runLogs.push(file);
        if (!forceLogs) {
          const st = fileStat(file);
          if (!st || !st.isFile() || st.mtimeMs > sharedCutoff) continue;
        }
        this._unlink(file, out);
      }

      // 2) 共享临时目录：只有完全没有在跑的任务时才删，避免删掉别的任务正在用的验证码/截图
      // 点停止时不受 mtime 限制：同一毫秒内刚生成的文件 mtime 可能晚于 now，也要收进补刀清单。
      const sharedCut = stopping ? Number.POSITIVE_INFINITY : sharedCutoff;
      let sharedFiles = [];
      if (exactShared) {
        sharedFiles = exactShared.slice();
      } else if (collectShared || !hasLive) {
        for (const dir of [p.captchas, p.shots, p.tmp]) {
          for (const file of this._walk(dir, 2)) {
            if (this._olderThan(file, sharedCut)) sharedFiles.push(file);
          }
        }
        for (const file of this._walk(this.workDir, 2)) {
          if (!WORK_TEMP_RE.test(path.basename(file))) continue;
          if (this._olderThan(file, sharedCut)) sharedFiles.push(file);
        }
      }
      out.shared = sharedFiles;
      if (!hasLive) {
        for (const file of sharedFiles) this._unlink(file, out);
      }

      // 3) 全局旧档只在 TTL 扫描时清（点停止时保留，方便排查）
      if (pruneLog) {
        for (const name of this._readdir(p.base)) {
          if (!BAD_STATE_RE.test(name)) continue;
          const file = path.join(p.base, name);
          if (!this._olderThan(file, sharedCutoff)) continue;
          this._unlink(file, out);
        }
        const rotated = path.join(p.logs, 'plugin.jsonl.1');
        if (this._olderThan(rotated, sharedCutoff)) this._unlink(rotated, out);
        this._prunePluginLog(sharedCutoff, out);
      }
      return out;
    } finally {
      this._busy = false;
    }
  }

  /** 正在运行的任务 id 集合（engine + desktop） */
  _activeIds({ includeStopping }) {
    const out = new Set();
    try {
      for (const job of this.deps.engine?.jobs?.values?.() || []) {
        if (!job || !ACTIVE_ENGINE.has(job.state)) continue;
        if (!includeStopping && job.stopRequested) continue;
        out.add(String(job.id));
      }
    } catch {
      /* ignore */
    }
    try {
      for (const job of this.deps.deskEngine?.jobs?.values?.() || []) {
        if (!job || !ACTIVE_DESK.has(job.state)) continue;
        if (!includeStopping && job.stopRequested) continue;
        out.add(String(job.id));
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  _hasLiveJobs({ includeStopping = true } = {}) {
    try {
      for (const job of this.deps.engine?.jobs?.values?.() || []) {
        if (!job || !ACTIVE_ENGINE.has(job.state)) continue;
        if (!includeStopping && job.stopRequested) continue;
        return true;
      }
    } catch {
      /* ignore */
    }
    try {
      for (const job of this.deps.deskEngine?.jobs?.values?.() || []) {
        if (!job || !ACTIVE_DESK.has(job.state)) continue;
        if (!includeStopping && job.stopRequested) continue;
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  _jobLogFiles(dir) {
    const out = [];
    for (const name of this._readdir(dir)) {
      if (!RUN_LOG_RE.test(name)) continue;
      out.push(path.join(dir, name));
    }
    return out;
  }

  _jobIdFromLog(file) {
    const name = path.basename(file);
    if (!RUN_LOG_RE.test(name)) return '';
    // desk 的日志是 desk_<job id>.jsonl，而 job id 本身就以 desk_ 开头（desk_xxx），
    // 所以只剥一层前缀，得到的正好是 jobs Map 里的 id。
    return name.replace(/^(?:job|desk)_/i, '').replace(/\.jsonl$/i, '');
  }

  _olderThan(file, cutoff) {
    const st = fileStat(file);
    return !!(st && st.isFile() && st.mtimeMs <= cutoff);
  }

  _walk(dir, depth, out = []) {
    for (const name of this._readdir(dir)) {
      const full = path.join(dir, name);
      const st = fileStat(full);
      if (!st) continue;
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth > 0) this._walk(full, depth - 1, out);
        continue;
      }
      if (st.isFile()) out.push(full);
    }
    return out;
  }

  _readdir(dir) {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  }

  _unlink(file, out) {
    const st = fileStat(file);
    if (!st || !st.isFile()) return false;
    try {
      fs.unlinkSync(file);
      out.deleted += 1;
      out.bytes += st.size;
      return true;
    } catch {
      // Windows 上文件可能正被 Edge/PowerShell 占用：静默跳过，交给延迟补刀或 TTL 下次扫描
      out.skipped += 1;
      return false;
    }
  }

  /** 按行时间戳裁剪 plugin.jsonl（小文件不动，避免频繁重写） */
  _prunePluginLog(cutoff, out) {
    const file = path.join(paths().logs, 'plugin.jsonl');
    const st = fileStat(file);
    if (!st || !st.isFile() || st.size < 32 * 1024) return;
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const keep = [];
    let dropped = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let at = 0;
      try {
        const rec = JSON.parse(line);
        at = Date.parse(rec.at || rec.t || '');
      } catch {
        at = 0;
      }
      if (at && at < cutoff) {
        dropped += 1;
        continue;
      }
      keep.push(line);
    }
    if (!dropped) return;
    try {
      const tmp = `${file}.${process.pid}.clean.tmp`;
      fs.writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '', 'utf8');
      fs.renameSync(tmp, file);
      out.pruned += dropped;
    } catch {
      out.skipped += 1;
    }
  }

  _note(obj) {
    try {
      this.log(obj);
    } catch {
      /* ignore */
    }
  }
}
