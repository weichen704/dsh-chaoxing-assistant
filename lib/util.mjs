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

// 面板「目标课程」里常把动作一起写进去：「python程序设计作业」「大学英语Ⅰ 的作业」「作业点」。
// 桌面版按课程名模糊匹配课程卡片、网页版按标题匹配课程，带「作业」后缀时：
//   ① 真卡片只「部分」对得上 → 得分和 OCR 碎片一样差，按 y 排序还会先点碎片；
//   ② 网页版 resolveCourse 直接找不到这门课。
// 真机回归（2026-11-24）：用户填「python程序设计作业」点「作业」，open-look 命中 "hon．@1152,478"
// （卡片标题被 OCR 切剩三个字母），客户端停在一个非课程页面上，最后报「0 份作业」。
const WORK_TAIL =
  /^(.*?)[\s\u3000·,，、:：;；\-—_]*[（(【\[]?\s*(?:的)?(?:作业|习题)(?:点|列表|页|界面)?\s*[）)】\]]?$/;

/** 去掉面板输入里的「作业/习题」动作后缀，只留课程名。
 *  剥完不足 4 字就原样返回（「作业」这种也可能是真课程名，宁可不动）。 */
export function courseSpec(raw) {
  let s = String(raw == null ? '' : raw).trim();
  for (let i = 0; i < 3; i += 1) {
    const m = WORK_TAIL.exec(s);
    if (!m) break;
    const rest = String(m[1] || '').trim();
    if (rest.length < 4) break;
    s = rest;
  }
  return s;
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

/**
 * 置信度门限：缺省/非法值用 fallback，0 是合法值（=不卡门限）。
 * 旧写法 `Number(x) || 0.75` 会把调用方明确传的 0 悄悄变成 0.75。
 */
export function confThreshold(x, fallback = 0.75) {
  if (x == null || x === '') return fallback;
  const v = Number(x);
  return Number.isFinite(v) ? clamp(v, 0, 1) : fallback;
}

// 只允许学习通域名的 http(s) 地址。
// 页面（作业列表 data 属性、测验「修改答案」onclick）给出的链接必须过这一关才能导航：
// 否则页面内容可以把自动化浏览器带到任意外域，随后在那里点「提交/确定」。
const CHAOXING_HOST = /(^|\.)chaoxing\.com$/i;

export function chaoxingUrl(raw, base = 'https://mooc1.chaoxing.com') {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s, base);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (!CHAOXING_HOST.test(u.hostname)) return '';
  return u.toString();
}

/**
 * 启动/导航用的网址：只允许绝对 http(s)，且拒绝以 `-` 开头的值。
 * Chromium 会把命令行里任何 `--foo` 当成启动开关（edge.mjs 的 argv 里还有 --user-data-dir），
 * 所以 startUrl 必须先过这一关，不能原样塞进 spawn 参数。
 * 返回 '' 表示非法；空输入返回 fallback。
 */
export function safeStartUrl(raw, fallback = 'https://i.chaoxing.com/base') {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return fallback;
  if (s.length > 2048 || s.startsWith('-')) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (!u.hostname || u.username || u.password) return '';
  return u.toString();
}

// 账号别名会拼进 profiles 下的目录名，也会作为 state.json 里的对象键：
// 只允许安全字符，并显式挡掉原型链上的特殊键（accounts['__proto__'] 会拿到 Object.prototype）。
const ACCOUNT_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function safeAccountName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!ACCOUNT_NAME_RE.test(s) || PROTO_KEYS.has(s)) {
    throw new Error('账号名只能是 1-32 位字母、数字、下划线或短横线');
  }
  return s;
}

/** 调试端口只允许插件专用段 9300-9499：避免用 9222 之类接管用户已有浏览器的调试实例。返回 0 表示非法。 */
export function safePort(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 9300 || n > 9499) return 0;
  return n;
}
