// 通用小工具：不做任何外部依赖。
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function nowClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function nowISO() {
  return new Date().toISOString();
}

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 人类阅读用的耗时描述：137s -> "2分17秒" */
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}分${r}秒` : `${m}分钟`;
}

export function truncate(s, n = 200) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 从任意字符串（URL / onclick 片段）里抠出课程参数 */
export function parseCourseParams(raw) {
  const s = String(raw || '');
  const pick = (name) => {
    const m = s.match(new RegExp(`[?&]${name}=([^&'"\\s\\\\]+)`, 'i'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const enc = (s.match(/[?&]enc=([0-9a-fA-F]{16,40})/) || [])[1] || '';
  return {
    courseid: pick('courseid') || pick('courseId') || '',
    clazzid: pick('clazzid') || pick('classId') || pick('clazzId') || '',
    cpi: pick('cpi') || '',
    enc: enc.toLowerCase(),
  };
}

export function validEnc(enc) {
  return /^[0-9a-f]{16,40}$/.test(String(enc || ''));
}

export function safeFileName(s) {
  return String(s || 'x').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
}

/** Promise 超时包装 */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 可被外部 abort 的睡眠 */
export async function sleepUnless(ms, isStopped) {
  const step = 250;
  for (let t = 0; t < ms; t += step) {
    if (isStopped && isStopped()) return;
    await sleep(Math.min(step, ms - t));
  }
}

export function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}
