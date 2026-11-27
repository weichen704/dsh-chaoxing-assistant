// 纯判据（不碰页面、不碰网络），专门给「能不能算完成 / 能不能交卷」这类决定用。
// 借鉴 dsh-cx-learn 的做法：判定逻辑从主循环里抽出来，表驱动测试，避免判据散落各处后改一处漏一处。

/** 视频「看完」阈值：位置到 98.5% 或 ended。平台按观看时长记账，位置到末尾通常已够。 */
export const DONE_RATIO = 0.985;

/** 视频是否播够（t/d 单位秒）。duration 未知时只认 ended。 */
export function videoPlayedEnough({ t = 0, d = 0, ended = false } = {}, ratio = DONE_RATIO) {
  const cur = Number(t) || 0;
  const dur = Number(d) || 0;
  if (ended) return true;
  if (dur <= 0) return false;
  return cur >= dur * ratio;
}

/** 计划里哪些题没答案：items[].i 与 plan[].i 对齐，返回缺失下标。 */
export function countMissingAnswers(items, plan) {
  const list = Array.isArray(items) ? items : [];
  const answers = Array.isArray(plan) ? plan : [];
  const answered = new Set();
  for (const a of answers) {
    const i = Number(a && a.i);
    if (Number.isInteger(i) && i >= 0) answered.add(i);
  }
  const missing = [];
  for (const it of list) {
    const i = Number(it && it.i);
    if (!answered.has(i)) missing.push(i);
  }
  return { total: list.length, answered: list.length - missing.length, blanks: missing.length, missing };
}

/**
 * 提交闸门：页面数得清时以页面为准，数不清时退回「计划覆盖度」。
 * @returns {{ok:boolean, blanks:number, maxBlanks:number, source:'page'|'plan', reason:string}}
 */
export function submitGate({ items, plan, blanks = null, countOk = false, maxBlanks = 0 } = {}) {
  const limit = Math.max(0, Number(maxBlanks) || 0);
  let n;
  let source;
  if (countOk && Number.isInteger(Number(blanks))) {
    n = Math.max(0, Number(blanks));
    source = 'page';
  } else {
    n = countMissingAnswers(items, plan).blanks;
    source = 'plan';
  }
  const ok = n <= limit;
  return {
    ok,
    blanks: n,
    maxBlanks: limit,
    source,
    reason: ok ? '' : n === 0 ? '' : `${n} 道题没有答案（上限 ${limit}）`,
  };
}

/** 连续「播完但平台没记」达到上限就停，避免在同一节点上反复空转。 */
export function shouldStopUnconfirmed(streak, max = 3) {
  const limit = Number(max);
  if (!(limit > 0)) return false; // 0 / 负数 = 关闭确认，永不停机
  const n = Math.max(0, Number(streak) || 0);
  return n >= limit;
}
