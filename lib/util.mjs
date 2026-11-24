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
