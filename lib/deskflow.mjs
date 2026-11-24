// 桌面客户端流程：课程 → 章节 → 任务点 → 文档滚动 / 视频播放（基于 WinRT OCR + UIA 坐标点击）
import { sleep, courseSpec } from './util.mjs';

const CONTENT = { x: 190, y: 90, w: 1350, h: 1010 }; // 课程/任务内容区（不含左侧导航）
const CHAPTER_PANEL = { x: 540, y: 240, w: 700, h: 860 }; // 课程页/章节页里的目录列表区域
// 课程卡片网格：上边界跳过「最近使用」横条（点它会进通知详情），右边界止于右侧通知栏，
// 否则 window 级的匹配会把左栏课程名/通知栏文字当成卡片点进去（曾点进「错题集」）
const LIST_BOX = { x: 150, y: 230, w: 1500, h: 870 };
const TASK_PANEL = { x: 540, y: 180, w: 1000, h: 900 }; // 任务页正文区域
const FOOTER = { x: 540, y: 1000, w: 1000, h: 120 };
// 以上坐标按普通窗口 1821×1137 标定；更大窗口由 clip() 自动扩展大区域
const BASE_W = 1821;
const BASE_H = 1137;

/** 课程/章节名归一化：去空白、全角转半角、去书名号与标点，便于模糊匹配 */
export function normName(s) {
  return normNum(String(s || ''))
    .replace(/[\s\u3000]/g, '')
    .replace(/[《》〈〉()（）\[\]【】<>"'“”‘’·,，.、:：;；!！?？\-_—~～]/g, '')
    .toLowerCase();
}

/** 两个归一化字符串的重合度（按较短串计），用于 OCR 断行/漏字时兜底 */
export function sim(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return 0;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  let hit = 0;
  for (const ch of s) if (l.includes(ch)) hit++;
  return hit / s.length;
}

/** 标题里能区分课程的部分：数字 / 拉丁词（I、II、Python…）。
 *  按出现顺序逐个比：同一位置上两边都有序号却对不上 → 是两门课
 *  （大学英语I ≠ 大学英语III、2025-2026 ≠ 2026-2027）。
 *  只有一边多出序号时不判冲突：客户端标题经常带前缀/后缀
 *  （「25级通识选修课程（Python程序设计））」的班级前缀、
 *  「电路与磁路（2024）」「Python程序设计2024」的年份后缀），这些不是另一门课。
 *  这是之前「指定 A 课却打开 B 课」的根因之一：`sim` 对「大学英语I」和「大学英语III」
 *  算出来是 1（短串字符全在长串里），标题全包含又被当成命中，兄弟课因此被当成成功。
 *  注意别把「一边多出」判成冲突：那会让「25级通识选修课程（Python程序设计）」被当成
 *  别的课（_token 位置逐位比时 25 会和 python 对上），真机上表现为点对了课却报 ambiguous-course。 */
export function titleConflict(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb || na === nb) return false;
  const ta = na.match(/[a-z]+|\d+/g) || [];
  const tb = nb.match(/[a-z]+|\d+/g) || [];
  if (!ta.length || !tb.length) return false;
  const shorter = ta.length <= tb.length ? ta : tb;
  const longer = ta.length <= tb.length ? tb : ta;
  // 短的一边是长的一边的前缀/后缀 → 只是多了级别、年份之类的前后缀，不冲突
  const prefix = shorter.every((t, i) => longer[i] === t);
  const suffix = shorter.every((t, i) => longer[longer.length - shorter.length + i] === t);
  if (prefix || suffix) return false;
  if (ta.length !== tb.length) return true;
  return ta.some((t, i) => t !== tb[i]);
}

/** 判断哪个 Document 才是真正显示在屏幕上的那一页。
 *  客户端是「标签页」模型：UIA 会把所有隐藏标签页（旧课程页、通知详情、首页）的元素一起报出来，
 *  坐标还落在同一块屏幕区域；OCR 只认可见像素。两者的同名文字位置重合，就说明这一页是当前活动标签。
 *  做法：每个 OCR 词找中心距 <26px 的同名 UIA 元素，其所属 Document 记一分，分最高者胜出。
 *  一个都对不上（纯 canvas / UIA 不可用）时返回 '' —— 调用方必须退回纯 OCR，
 *  绝不能退回「全部 UIA」，否则又会点到后台标签页的同名坐标上。
 *  这就是「指定 Python 程序设计却打开大学英语I」的根因：首页 Document 的
 *  Python卡片 (324,459) 和列表页的 Python 卡片 (1085,607) 同时在候选里，
 *  按 y 最小取了前者，而 (324,459) 在可见的列表页上正落在大学英语I 卡片内。 */
export function pickVisibleDoc(ui, ocr) {
  const us = Array.isArray(ui) ? ui : [];
  const os = Array.isArray(ocr) ? ocr : [];
  if (!us.length || !os.length) return '';
  const score = new Map();
  for (const o of os) {
    const wt = normName(o && o.t);
    if (wt.length < 2) continue;
    const cx = Number(o.x);
    const cy = Number(o.y);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
    let best = null;
    let bestD = 26;
    for (const it of us) {
      const doc = it && it.doc ? String(it.doc) : '';
      if (!doc) continue;
      const nt = normName(it.t);
      // 同名单：全等，或一方包含另一方（UIA 名字常带教师名/后缀，OCR 又会断行）
      const near = nt === wt || (wt.length >= 4 && nt.includes(wt)) || (nt.length >= 4 && wt.includes(nt));
      if (!near) continue;
      const d = Math.hypot(it.x + (Number(it.w) || 0) / 2 - cx, it.y + (Number(it.h) || 0) / 2 - cy);
      if (d < bestD) {
        bestD = d;
        best = doc;
      }
    }
    if (best) score.set(best, (score.get(best) || 0) + 1);
  }
  let doc = '';
  let top = 0;
  for (const [k, v] of score) {
    if (v > top) {
      top = v;
      doc = k;
    }
  }
  // 只对上 1 个词可能是巧合（两个页面恰好各有一个同名标题），不足以判定哪页可见
  return top >= 2 ? doc : '';
}

/** 导航词/工具条文字：这些出现在页面上不代表「当前是哪门课」 */
const NAV_WORDS =
  /^(首页|课程|任务|章节|讨论|作业|考试|资料|错题集|学习记录|返回课程|章节详情|任务详情|搜索|通知|通知详情|课程门户|链接|ai助教|我学的课|我教的课|新建文件夹|查看更多|排序|全部|个人空间|消息|笔记|云盘|小组|设置|待办|常用|应用中心|最近使用|推荐|刷新|进入微应用|进行中|已结束)$/;

/** 一行字像不像「课程名」（用于判断页面上写的是不是别的课） */
export function looksLikeCourseTitle(s) {
  const t = String(s || '').replace(/[\s\u3000]/g, '').trim();
  if (t.length < 4) return false;
  const n = normName(t);
  if (!n || NAV_WORDS.test(n)) return false;
  if (!/[\u4e00-\u9fa5]/.test(t)) return false;
  return /课程|学年|程序设计/.test(t) || t.length >= 8;
}

/** 判断「当前可见的这一页是哪门课」——只看这一页上真正显示的文字，不看固定像素带。
 *  lines: [{t,y}] 可见页文字（优先来自 pageItems：只含活动标签那一页的 Document）；
 *  strip: 标签栏上的文字；stripY: 标签行的 y。
 *  标签栏上的旧课程名在屏幕上也看得见，必须排除，否则「2026-2027学年第一学期大学英语I」
 *  的旧标签会被当成当前页面 → 明明点开了 Python 课却报 wrong-tab（任务静默结束）。
 *  只有 where='other'（页面上明明写着别的课）才允许判错课；'unknown' 表示没读懂这一页，
 *  交给上层去重试或软放行，别拿它当「错课」。 */
export function judgePage(lines, expect, { strip = [], stripY = 0 } = {}) {
  const want = normName(expect);
  const stripSet = new Set(
    (Array.isArray(strip) ? strip : []).map((s) => normName(typeof s === 'string' ? s : s && s.t)).filter(Boolean),
  );
  const body = (Array.isArray(lines) ? lines : [])
    .map((l) => (typeof l === 'string' ? { t: l, y: 0 } : l || {}))
    .map((l) => ({ t: String(l.t || '').trim(), y: Number(l.y) || 0 }))
    .filter((l) => l.t)
    .filter((l) => {
      // 和标签栏同字，或者就落在标签行上 → 这一行是标签，不是页面内容
      if (stripSet.has(normName(l.t))) return false;
      if (stripY > 0 && l.y > 0 && Math.abs(l.y - stripY) <= 28) return false;
      return true;
    });
  const texts = body.map((l) => l.t);
  // 「首页」上也有课程卡片（常用/最近使用/推荐），别把「首页推荐了这门课」当成「已经进了这门课」
  if (texts.some((t) => /最近使用/.test(t)) && texts.some((t) => /常用|应用中心|待办/.test(t))) {
    return { where: 'list', home: true, texts };
  }
  if (texts.some((t) => /我学的课|新建文件夹/.test(t))) return { where: 'list', texts };
  if (want) {
    const hit = body.find((l) => {
      const n = normName(l.t);
      if (!n) return false;
      const near = n.includes(want) || want.includes(n) || (want.length >= 4 && sim(n, want) >= 0.7);
      return near && !titleConflict(l.t, expect);
    });
    if (hit) return { where: 'course', hit: hit.t, texts };
  }
  // 「别的课」要两种证据之一：像课程名的长标题，或与目标名高度相似但序号对不上（大学英语III vs I）
  const closeButConflict = (t) => {
    if (!want) return false;
    const n = normName(t);
    if (!n || n.length < 4) return false;
    if (sim(n, want) < 0.55) return false;
    return titleConflict(t, expect);
  };
  const other = body.find(
    (l) => (looksLikeCourseTitle(l.t) && titleConflict(l.t, expect)) || closeButConflict(l.t),
  );
  if (other) return { where: 'other', other: other.t, texts };
  return { where: 'unknown', texts };
}

/** 标签栏里当前活动标签的标题：取最长候选（标签写的都是课程名，越长越具体）。
 *  以前直接取 OCR 顺序里的第一个，经常拿到旧标签的断句（「2026」），把正确的课判成 wrong-tab。 */
export function pickTabTitle(items) {
  const list = (Array.isArray(items) ? items : [])
    .map((i) => String((i && i.t) || '').trim())
    .filter((s) => s.length >= 4 && !/^首页$/.test(s) && !/^[+＋×]$/.test(s));
  list.sort((a, b) => b.length - a.length);
  return list[0] || '';
}

export class DeskFlow {
  constructor(driver, { log = () => {} } = {}) {
    this.d = driver;
    this.log = log;
  }

  async t(name, fn) {
    const t0 = Date.now();
    try {
      const r = await fn();
      this.log({ ev: 'desk-step', name, ms: Date.now() - t0, ok: true, r: r && typeof r === 'object' ? r : { v: r } });
      return r;
    } catch (e) {
      this.log({ ev: 'desk-step', name, ms: Date.now() - t0, ok: false, err: String(e && e.message).slice(0, 200) });
      throw e;
    }
  }

  /** 裁到窗口内：OCR 框一旦超出窗口就会把桌面/其它窗口的字一起读进来
   *  （实测读作业列表底部分页时读到了宿主聊天窗口的文字）
   *  窗口比标定尺寸大（用户最大化）时，结构性大框向右/向下铺满新增空间：
   *  学习通是响应式布局，内容区会变宽变高，但左/上起点基本不动；
   *  只放大「大区域」，避免把分页数字、表头这类小框扩到无关区域造成误识别。 */
  clip(box) {
    const r = (this.d && this.d.rect) || {};
    const W = Number(r.w) > 600 ? Number(r.w) : 0;
    const H = Number(r.h) > 400 ? Number(r.h) : 0;
    // w/h 给 0 表示「整个窗口」（见 clickText 的全窗兜底）
    if (W && H && (!(box.w > 0) || !(box.h > 0))) return { x: 0, y: 0, w: W, h: H };
    const x0 = Math.max(0, Math.round(box.x));
    const y0 = Math.max(0, Math.round(box.y));
    let x = x0;
    let y = y0;
    let w = Math.round(box.w);
    let h = Math.round(box.h);
    if (W && H) {
      const dw = Math.max(0, W - BASE_W);
      const dh = Math.max(0, H - BASE_H);
      // 已经按当前窗口算过的框（如 worksBox）坐标会超出标定尺寸，不再二次扩展
      const absolute = box.x + box.w > BASE_W + 8 || box.y + box.h > BASE_H + 8;
      if (!absolute) {
        // 右/下贴边的元素按新增空间平移，保持它仍在右/下边缘
        if (box.x + box.w >= 1700) x = x0 + dw;
        // 只有「正文级」大框才铺满新增宽度：700 宽的目录栏一旦右扩就会吃进右侧通知栏，
        // 把「11月23日 14时47分」这类时间戳读成章节标题（见 chaptersFrom 的噪声过滤）
        else if (w >= 900) w += dw;
        if (box.y + box.h >= 1050 && h < 300) y = y0 + dh;
        else if (h >= 700) h += dh;
      }
      w = Math.min(w, W - x);
      h = Math.min(h, H - y);
    }
    return { x, y, w: Math.max(8, w), h: Math.max(8, h) };
  }

  async ocr(box, scale = 1) {
    const b = this.clip(box);
    const p = await this.d.actions([{ cmd: 'ocr', x: b.x, y: b.y, w: b.w, h: b.h, scale }]);
    const items = p.results?.[0]?.items;
    if (!items) return [];
    return Array.isArray(items) ? items : [items];
  }

  /** UIA 文本项：客户端的 UIA 树是完整的（Chromium 无障碍），名字精确、不像 OCR 会认错字。
   *  返回窗口相对坐标（rx/ry），和 OCR 的坐标系一致，点击逻辑可以共用。
   *  注意 uia2.ps1 的字段名：t=控件类型、n=文字，这里统一成 t=文字、ct=控件类型。 */
  async uiaBox(box) {
    if (typeof this.d.uia !== 'function') return [];
    let raw = [];
    try {
      raw = await this.d.uia();
    } catch {
      return [];
    }
    if (!Array.isArray(raw) || !raw.length) return [];
    const b = this.clip(box);
    const wx = (this.d.rect && this.d.rect.x) || 0;
    const wy = (this.d.rect && this.d.rect.y) || 0;
    const out = [];
    const seen = new Set();
    for (const it of raw) {
      const name = String(it.n || '').trim();
      if (!name) continue;
      const w = Number(it.w) || 0;
      const h = Number(it.h) || 0;
      // 整页容器（Document/Pane）没有定位价值，还会把 OCR 兜底逻辑搅乱
      if (w >= 1000 && h >= 600) continue;
      const x = typeof it.rx === 'number' ? it.rx : (Number(it.x) || 0) - wx;
      const y = typeof it.ry === 'number' ? it.ry : (Number(it.y) || 0) - wy;
      // 用元素中心点判断归属：按「相交」判断会让紧贴边界上方的元素漏进来
      // （顶部标签栏 y≈157 的课程名曾混进 y≥230 的课程网格区域）
      const cx = x + w / 2;
      const cy = y + h / 2;
      if (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) continue;
      const key = `${name}|${x}|${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ t: name, ct: String(it.t || ''), doc: String(it.d || ''), x, y, w, h, src: 'uia' });
    }
    out.sort((p, q) => p.y - q.y || p.x - q.x);
    return out;
  }

  /** 区域文本：UIA 精确文本优先，OCR 只补 UIA 没覆盖到的位置（canvas/图片里的字）。
   *  UIA 拿不到任何东西时行为与以前完全一致（纯 OCR）。 */
  async texts(box, { scale = 1 } = {}) {
    const ui = await this.uiaBox(box);
    if (!ui.length) return await this.ocr(box, scale);
    let extra = [];
    try {
      extra = await this.ocr(box, scale);
    } catch {
      extra = [];
    }
    const covered = (o) =>
      ui.some((u) => {
        const cx = o.x + (o.w || 0) / 2;
        const cy = o.y + (o.h || 0) / 2;
        return cx >= u.x - 8 && cx <= u.x + u.w + 8 && cy >= u.y - 8 && cy <= u.y + u.h + 8;
      });
    return [...ui, ...(extra || []).filter((o) => o && o.t && !covered(o))];
  }

  /** 当前可见页的文本项：只取 pickVisibleDoc() 认定的那个 Document 的 UIA 文字 + OCR 补漏。
   *  texts() 会把隐藏标签页的 UIA 一起返回（坐标还落在当前页面区域内），用它点课程卡片
   *  会点到别的课；判定不出可见页时退回纯 OCR（OCR 只看得到真正显示出来的像素）。 */
  async pageItems(box, { scale = 1 } = {}) {
    const ui = await this.uiaBox(box);
    let oc = [];
    try {
      oc = await this.ocr(box, scale);
    } catch {
      oc = [];
    }
    if (!ui.length) return (oc || []).filter((o) => o && o.t);
    const doc = pickVisibleDoc(ui, oc);
    const own = doc ? ui.filter((i) => i.doc === doc) : [];
    if (!own.length) return (oc || []).filter((o) => o && o.t);
    // OCR 的 x,y 本身就是文字中心，不用再加 w/2（texts() 里那样加会偏右半个词宽）
    const covered = (o) =>
      own.some((u) => o.x >= u.x - 8 && o.x <= u.x + u.w + 8 && o.y >= u.y - 8 && o.y <= u.y + u.h + 8);
    return [...own, ...(oc || []).filter((o) => o && o.t && !covered(o))];
  }

  /** 区域像素哈希（用于判断翻页/滚动是否还在变化） */
  async hash(box) {
    const b = this.clip(box);
    const p = await this.d.actions([{ cmd: 'hash', x: b.x, y: b.y, w: b.w, h: b.h }]);
    return p.results?.[0]?.hash || '';
  }

  clickItem(it, { offsetY = 0, dx = 0 } = {}) {
    return this.d.actions([{ cmd: 'click', x: Math.round(it.x + dx), y: Math.round(it.y + offsetY) }]);
  }

  find(items, re) {
    return (items || []).find((i) => re.test(i.t || ''));
  }

  /** 在内容区找文本并点击（可重试：先整区 OCR，找不到再全窗口） */
  async clickText(re, { box = CONTENT, scale = 1, tries = 3 } = {}) {
    for (let i = 0; i < tries; i++) {
      const items = i <= 1 ? await this.ocr(box, scale) : await this.ocr({ x: 0, y: 0, w: 0, h: 0 }, 1);
      const it = this.find(items, re);
      if (it) {
        await this.clickItem(it);
        return { ok: true, hit: it.t, x: it.x, y: it.y, ms: 0 };
      }
      await sleep(700);
    }
    return { ok: false, err: 'not-found' };
  }

  /** 通过 UIA 找外层壳里的菜单项（课程/章节/作业/考试/资料…） */
  async clickUia(re, { leftOnly = false } = {}) {
    let items = await this.d.uia();
    const rx = this.d.rect?.x || 0;
    if (leftOnly) {
      // 左栏阈值随窗口宽度缩放：以前写死 280，客户端最大化（2582 宽）时左栏起点在 ~270 以外，
      // 「作业/任务」这些菜单项直接被筛掉 → 导航找不到 → 作业流程停在原页面。
      const w = Number(this.d.rect?.w) || BASE_W;
      const lim = Math.max(280, Math.round(w * 0.18));
      items = items.filter((x) => x.x - rx < lim);
    }
    const it = items.find((x) => re.test(x.n || ''));
    if (!it) return { ok: false, err: 'uia-not-found', names: items.slice(0, 12).map((x) => x.n) };
    const r = this.d.rect || { x: 0, y: 0 };
    await this.d.actions([{ cmd: 'click', x: Math.round(it.x + it.w / 2 - r.x), y: Math.round(it.y + it.h / 2 - r.y) }]);
    return { ok: true, hit: it.n };
  }

  /** 回到「我的课程」列表：任务页要先点左上「返回课程」，再点左侧一级导航「课程」 */
  async goCourses() {
    return this.t('go-courses', async () => {
      // 回到「我的课程」列表的总预算：正常 5~6 秒就到；卡住时（客户端停在登录页/弹窗/别的标签）
      // 以前会沿回退链一路 OCR 一两分钟，用户只看到「没有任何进展」。到点就返回可读错误。
      const t0 = Date.now();
      const budget = Math.max(15000, Number(this.navBudgetMs) || 60000);
      const used = () => Date.now() - t0;
      const over = () => used() > budget;
      const timeout = (step) => ({ ok: false, err: 'nav-timeout', step, ms: used() });
      if (!(await this.ensureLoggedIn())) return { ok: false, err: 'login-required', ms: used() };
      if (over()) return timeout('login');
      const navBox = { x: 0, y: 110, w: 210, h: 760 }; // 左侧一级导航（避开顶部同名标签页）
      const listBox = { x: 140, y: 150, w: 1500, h: 620 };
      const topBar = { x: 170, y: 100, w: 460, h: 95 }; // 任务页左上「返回课程」
      // 注意：首页里也有「我的课程」板块，光看这四个字会误判已在课程页 → 必须看到课程页专属元素。
      // 但课程页（章节/任务/错题集）里同样有「任务点进度」这类字，所以只认列表独有的标题，
      // 并且一旦看到课程页专属的侧边栏/工具条就判定「不在列表」。
      const LIST_ONLY = /我学的课|新建文件夹/;
      // 课程页专属、且首页/列表页不会出现的标志（首页也有「课程门户」卡片，不能用它判断）
      const COURSE_PAGE = /选择题型|清空错题集|错题集|返回课程|任务列表/;
      // 页级判断一律只用 OCR：客户端是「标签页」模型，UIA 会把后台标签页（旧课程页/任务页）
      // 的元素也一起报出来，坐标还落在当前页面区域内 —— 实测列表页里混进了后台课程页的
      // 「返回课程」(236,131)，导致 onList 把真正的列表页误判成课程页，随后整条回退链空转。
      const onList = async () => {
        const items = await this.ocr(listBox, 1);
        const txt = items.map((i) => String(i.t || '')).join(' ');
        if (!LIST_ONLY.test(txt)) return null;
        if (COURSE_PAGE.test(txt)) return null;
        return items;
      };
      const clickNav = async (re) => {
        const items = await this.ocr(navBox, 1);
        const it = items.find((i) => re.test(i.t || ''));
        if (!it) return false;
        await this.clickItem(it);
        await sleep(700);
        return true;
      };
      // 客户端是「标签页」模型：课程页开着时，左侧一级导航「课程」点了不切页（它已是激活态），
      // 必须点顶部标签栏里的「课程」标签才能回到课程列表。
      const clickTab = async (re) => {
        const tabs = await this.ocr({ x: 180, y: 55, w: 1300, h: 80 }, 1);
        const it = tabs.find((i) => re.test(String(i.t || '').replace(/\s+/g, '')));
        if (!it) return false;
        await this.clickItem(it);
        // 不固定等 1.5s：切页很快，交给下面 waitList 轮询（看到列表就返回）
        await sleep(350);
        return true;
      };
      let items = await onList();
      if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: 0, ms: used() };
      // 弹窗（异常学习/多终端/账号于…）会挡住所有点击：先关掉再看一次
      await this.dismissModal();
      if (over()) return timeout('modal');
      items = await onList();
      if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: 0, via: 'modal', ms: used() };
      const waitList = async (n = 6) => {
        for (let k = 0; k < n; k++) {
          if (over()) return null;
          const got = await onList();
          if (got) return got;
          await sleep(400);
        }
        return null;
      };
      if (await clickTab(/^课程$/)) {
        items = await waitList();
        if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: 0, via: 'tab', ms: used() };
      }
      if (over()) return timeout('tab');
      // 课程页/任务页 → 点顶部「首页」标签 → 首页「常用」行里的「我的课程」入口。
      // 客户端停在某门课的课程页时：左侧「课程」已是激活态（点了不换页）、顶部也没有「课程」标签，
      // 老回退链会在首页误点后台标签页里的同名元素（20:40 卡死 131 秒就是这么来的）。
      // 首页那一行只认 OCR：UIA 会把后台 Document 的元素也报出来，坐标会点到别处去。
      const viaHomeEntry = async () => {
        const tab = (await this.tabs()).find((i) => /^首页$/.test(normName(i.t)));
        if (tab) {
          await this.clickItem(tab);
          await sleep(1700);
        }
        if (over()) return null;
        const row = await this.ocr({ x: 180, y: 225, w: 1240, h: 150 }, 1);
        const card = row.find((i) => /^我的课程$/.test(normName(i.t)));
        if (!card) return null;
        this.log({ ev: 'go-list-entry', xy: `${card.x},${card.y}` });
        await this.clickItem(card);
        await sleep(2400);
        return await waitList(3);
      };
      items = await viaHomeEntry();
      if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: 0, via: 'home-entry', ms: used() };
      if (over()) return timeout('home-entry');
      // 客户端是标签页模型：上次打开的课程会一直占着活动标签，点「课程」导航也只是回到那门课。
      // 以前这里用 Ctrl+W 关标签，但首页/列表页没有可关的标签时会把整个窗口关到托盘
      // （窗口被销毁，后续所有动作都报 window-not-found）→ 改成完全不碰键盘：
      // 回「首页」点「我的课程」卡片，进入「我学的课」列表。
      const gotoListViaHome = async () => {
        await clickNav(/^首页$/);
        await sleep(1200);
        const home = await this.ocr({ x: 150, y: 150, w: 1500, h: 700 }, 1);
        const card = home
          .filter((i) => /^我的课程$/.test(String(i.t || '').trim()))
          .sort((a, b) => a.y - b.y)[0];
        if (!card) return null;
        this.log({ ev: 'go-list-via-home', xy: `${card.x},${card.y}` });
        await this.clickItem(card);
        await sleep(2400);
        return await waitList(3);
      };
      items = await gotoListViaHome();
      if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: 0, via: 'home-card', ms: used() };
      if (over()) return timeout('home');
      for (let i = 0; i < 2; i++) {
        if (over()) return timeout(`back${i}`);
        await this.d.actions([{ cmd: 'key', seq: '{ESC}' }, { cmd: 'sleep', ms: 200 }]);
        // 1) 任务页左上角「返回课程」（shell 渲染，UIA 不一定看得到 → OCR 点击）
        const tb = await this.texts(topBar, { scale: 1 });
        const backBtn = tb.find((x) => /返回课程|返回/.test(x.t || ''));
        if (backBtn) {
          await this.clickItem(backBtn);
          await sleep(2000);
          items = await onList();
          if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: i + 1, via: 'back' };
        }
        // 2) 左侧一级导航「课程」
        for (const seq of [/^课程$/, /^首页$/]) {
          if (!(await clickNav(seq))) continue;
          items = await waitList();
          if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: i + 1, via: 'nav' };
          if (seq.source === '^首页$') {
            await clickNav(/^课程$/);
            items = await onList();
            if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: i + 1, via: 'home-nav' };
          }
        }
      }
      // 失败时只读列表区：全窗 OCR 在 2582×1622 上要十几秒，而且这些文字对排查帮助不大
      const all = await this.texts(listBox, { scale: 1 });
      return { ok: false, err: 'not-on-list', texts: all.map((t) => t.t).slice(0, 8), ms: used() };
    });
  }

  /** 打开课程（当前在课程列表页）：先看当前屏，再回顶部逐屏向下找课程卡片 */
  /** 点左侧一级导航（首页/课程/消息…） */
  async clickNav(re, box = { x: 40, y: 110, w: 220, h: 800 }) {
    const items = await this.texts(box, { scale: 1 });
    const it = items
      .filter((i) => re.test(String(i.t || '').trim()))
      .sort((a, b) => a.y - b.y)[0];
    if (!it) return false;
    await this.clickItem(it);
    await sleep(1600);
    return true;
  }
  /** 点完课程卡片后确认真的进了课程页（左侧出现 章节/任务 等导航，或正文出现任务点进度） */
  /** 课程卡片可能先停在「课程门户」（有「进入课程」按钮）→ 点进去再验证 */
  async _enterCourse(title, opts = {}) {
    let v = await this._verifyCourse(title, opts);
    if (v.ok) return v;
    await sleep(1500);
    v = await this._verifyCourse(title, opts);
    if (v.ok) return v;
    const page = await this.ocr({ x: 200, y: 100, w: 1450, h: 900 }, 1);
    const btn = this.find(page, /进入课程|进入学习|继续学习/);
    if (btn) {
      await this.clickItem(btn);
      await sleep(3000);
      v = await this._verifyCourse(title, opts);
      if (v.ok) return { ok: true, via: 'portal' };
    }
    return v;
  }
  /** 顶部标签栏里当前活动标签的标题（客户端只渲染活动标签，首页标签除外） */
  async activeTabTitle() {
    // 只用 OCR：UIA 会把后台标签页（同一窗口里的隐藏 webview）也报出来，
    // 那些页面的「章节详情/搜索/返回课程」会被当成活动标签标题，导致课程校验误判。
    return pickTabTitle(await this.tabs());
  }
  /** 标签栏里所有可见标签（按 x 排序，最右通常是当前活动标签） */
  async tabs() {
    // 标签栏的绝对位置会随窗口大小/缩放漂移：按 1821×1137 标定的 y74..116，
    // 在 2582×1622 的窗口上已经压到正文标题行，读出来是空或别的字。
    // 先在全窗口顶部找「首页」这一格（它一定在标签栏上）定出标签行，再取同一行的文字。
    const all = await this.ocr({ x: 140, y: 46, w: 1740, h: 180 }, 1);
    const items = all
      .map((i) => ({ ...i, t: String(i.t || '').trim() }))
      .filter((i) => i.t && i.t.length >= 2 && !/^[+＋×]$/.test(i.t));
    const home = items.find((i) => /^首页$/.test(i.t));
    const y0 = home ? home.y : 0;
    const row = y0
      ? items.filter((i) => Math.abs(i.y - y0) <= 46)
      : items.filter((i) => i.y >= 92 && i.y <= 170);
    return row.sort((a, b) => a.x - b.x);
  }
  /** 点标签栏切到某个标签（re 匹配标签标题）。切不了就返回 false。 */
  async activateTab(re) {
    const tl = await this.tabs();
    const hit = tl.find((i) => re.test(normName(i.t)) || re.test(i.t));
    if (!hit) return false;
    await this.clickItem(hit);
    await sleep(1500);
    return true;
  }
  /** 当前可见页是不是某门课：拿活动标签那一页上的文字判断（见 judgePage）。
   *  不再用固定像素带认课程标题：标签栏/标题栏的位置随窗口大小和缩放漂移，
   *  按 1821×1137 标定的 y108..166 在 2582×1622 上正好压在标签栏，读到的「2026」
   *  把刚打开的 Python 课判成 wrong-tab，_runCourse 直接 itemsFailed++ 结束——
   *  用户看到的就是「指定课程后无操作（0 视频/0 文档）」。
   *  另外标签栏上旧课程的文字也会被 OCR 读到，judgePage 会把它们剔掉。 */
  async pageCourse(expect = '') {
    const strip = await this.tabs();
    const box = { x: 120, y: 155, w: 1900, h: 460 };
    // 判断「当前是哪门课」优先用纯 OCR：UIA 会把后台标签页的文字一起报出来，反而更不可靠，
    // 而且 pageItems 要跑一次 UIA + 一次 OCR（约 0.85s），单跑 OCR 只要 0.27s。
    let items = [];
    try {
      items = await this.ocr(box, 1);
    } catch {
      items = [];
    }
    if (!items || !items.length) {
      try {
        items = await this.pageItems(box);
      } catch {
        items = [];
      }
    }
    const y0 = strip.length ? Math.min(...strip.map((i) => Number(i.y) || 0)) : 0;
    const lines = (items || [])
      .map((i) => ({ t: String(i.t || '').trim(), y: Number(i.y) || 0 }))
      .filter((l) => l.t.length >= 2 && l.y >= 150);
    const j = judgePage(lines, expect, { strip, stripY: y0 });
    this.log({
      ev: 'page-course',
      want: String(expect || '').slice(0, 30),
      where: j.where,
      hit: String(j.hit || j.other || '').slice(0, 40),
      lines: lines.length,
      strip: strip.length,
    });
    return j;
  }
  /** 课程页顶部的标题行（仅用于日志/展示；判断用 pageCourse） */
  async courseHeader() {
    const j = await this.pageCourse('');
    const list = (j.texts || []).filter((t) => looksLikeCourseTitle(t)).slice(0, 2);
    return list.join(' ').slice(0, 200);
  }
  /** 当前页面是不是某门课的课程页（内容证据，比固定像素带可靠） */
  async courseHeaderHas(title) {
    if (!normName(title)) return null;
    const j = await this.pageCourse(title);
    if (j.where === 'course') return { hit: true, head: j.hit, page: j };
    if (j.where === 'other') return { hit: false, head: j.other, page: j };
    if (j.where === 'list') return { hit: false, head: '', list: true, page: j };
    return null;
  }
  async _verifyCourse(title, { card = '' } = {}) {
    // ① 顶部课程标题区最可靠；② 其次是标签栏；③ 最后才是正文/导航启发式。
    const want0 = normName(title);
    // 点的是「卡片名和目标名完全一样」的卡，页面标题稍有残缺也能认；
    // 卡片本身是模糊匹配来的（用户只输了半截名字）时，必须由页面标题确认，不能只凭「在课程页」。
    const exactCard = !!card && normName(card) === want0;
    const hd = await this.courseHeaderHas(title);
    if (hd && hd.hit) return { ok: true, pageTitle: hd.head, titleSim: Number(sim(hd.head, want0).toFixed(2)), via: 'header' };
    const tab = await this.activeTabTitle();
    if (tab) {
      const nt = normName(tab);
      if (nt === want0) return { ok: true, pageTitle: tab, titleSim: 1, via: 'tab' };
      if ((nt.includes(want0) || want0.includes(nt)) && !titleConflict(tab, title)) {
        const s = Number(sim(tab, want0).toFixed(2));
        if (exactCard || s >= 0.9) {
          return { ok: true, pageTitle: tab, titleSim: s, via: 'tab', ...(s < 0.9 ? { ambiguousTitle: tab } : {}) };
        }
        return { ok: false, err: 'ambiguous-course', pageTitle: tab, titleSim: s, via: 'tab' };
      }
      // 顶部标题区明确是别的课，才敢判错课；否则可能只是标签栏还没刷新
      if (want0 && hd && hd.head) {
        return { ok: false, err: 'wrong-course', pageTitle: hd.head, titleSim: Number(sim(hd.head, want0).toFixed(2)), via: 'header' };
      }
    }
    const nav = await this.ocr({ x: 60, y: 120, w: 280, h: 840 }, 1);
    const navText = nav.map((i) => i.t).join(' ');
    const head = await this.texts({ x: 150, y: 140, w: 1400, h: 460 }, { scale: 1 });
    const headText = head.map((i) => i.t).join(' ');
    const inCourse = /章节|任务|作业|考试|资料/.test(navText) || /已完成任务点|目录|课程门户/.test(headText);
    if (!inCourse) return { ok: false, err: 'not-course-page', navText: navText.slice(0, 60) };
    // 同名校验：客户端里常有一批只差一个数字的课（大学英语I / II / III），
    // 光判断「在课程页」会把点错的课当成成功，后面章节全读到别的课去。
    const want = normName(title);
    const cands = head
      .map((i) => String(i.t || ''))
      .filter((s) => /\d|学|课|英语|计算机|政策|心理/.test(s) && s.length >= 6);
    let best = { sim: 0, text: '' };
    for (const c of cands) {
      const s = sim(c, want);
      if (s > best.sim) best = { sim: s, text: c };
    }
    const bn = normName(best.text);
    const near = !!bn && (bn.includes(want) || want.includes(bn));
    // 序号对不上的（大学英语I vs III、2025 vs 2026）不算同一门；只有卡片全等时才敢接受模糊页标题
    if (best.sim >= 0.86 && near && !titleConflict(best.text, title)) {
      return { ok: true, pageTitle: best.text, titleSim: Number(best.sim.toFixed(2)) };
    }
    if (best.sim >= 0.62 && near && exactCard && !titleConflict(best.text, title)) {
      return { ok: true, ambiguousTitle: best.text, titleSim: Number(best.sim.toFixed(2)) };
    }
    if (!best.text) {
      // 页面标题一个字都读不到：卡片名和目标名全等时还能信；卡片是模糊匹配来的就别赌。
      if (!card || exactCard) return { ok: true, titleSim: null };
      return { ok: false, err: 'unverified-course', titleSim: null };
    }
    return {
      ok: false,
      err: near ? 'ambiguous-course' : 'wrong-course',
      pageTitle: best.text,
      titleSim: Number(best.sim.toFixed(2)),
    };
  }
  /** 关掉「多终端登录/异常学习」提示（app 级模态，不关会挡住后续所有点击） */
  async dismissModal() {
    try {
      const items = await this.ocr({ x: 600, y: 200, w: 1300, h: 900 }, 1);
      const txt = items.map((i) => i.t).join(' ');
      if (!/异常学习|多终端|账号于/.test(txt)) return false;
      const ok = this.find(items, /^确定$/);
      if (!ok) return false;
      await this.clickItem(ok);
      await sleep(900);
      return true;
    } catch { return false; }
  }

  async openCourse(rawTitle) {
    // 面板里可能连动作一起填（「python程序设计作业」）：桌面版是拿名字去模糊匹配卡片，
    // 带后缀的「名字」既匹配不到真卡片，又能被 OCR 碎片勉强凑中（真机日志 hit:"hon．"），
    // 于是点进别的页面、作业流程读到 0 行。这里先剥掉动作后缀，再用干净课程名匹配。
    const title = courseSpec(rawTitle) || String(rawTitle == null ? '' : rawTitle);
    await this.dismissModal();
    return this.t('open-course', async () => {
      // 打开课程的时间预算：正常 15 秒左右；找不到时以前要把 8 屏全翻完 + 反复重开（实测 5 分钟），
      // 到点直接返回可读错误，交给上层报「这门课没打开」。
      const t0 = Date.now();
      const deadline = t0 + Math.max(30000, Number(this.openBudgetMs) || 120000);
      // 鼠标滚轮在 Electron webview 内容层无效（无 cu 时），只能「聚焦内容 + 键盘翻屏」
      // 但**绝不能点课程卡片来聚焦**（会误开课程）→ 有 cu 用真实滚轮，否则直接发翻页键（内容区本来就有焦点）
      const grid = { x: 190, y: 235, w: 1350, h: 860 };
      const focus = async (key) => {
        try {
          if (this.d.wheelInRect) {
            await this.d.wheelInRect(grid, {
              direction: /PGDN|down/i.test(key) ? 'down' : 'up',
              amount: 5,
              rx: grid.w * 0.5,
              ry: grid.h * 0.5,
            });
            await sleep(450);
            return;
          }
        } catch {
          /* 没有 cu → 回退键盘 */
        }
        await this.d.actions([{ cmd: 'key', seq: key }, { cmd: 'sleep', ms: 260 }]);
      };
      const want = normName(title);
      // 「这张卡算候选」的门槛：名字必须一大段被目标包含。
      // 以前 3 个字母的 OCR 碎片（「hon」）也能靠 want.includes(t) 命中，而它 y 比真卡片更靠上，
      // 排序后就成了第一个候选 —— 点下去进的不是课程页，作业列表自然读不到。
      const minPart = Math.max(4, Math.ceil(want.length * 0.5));
      const matchAll = (items) =>
        items.filter((i) => {
          const t = normName(i.t);
          if (!t || t.length < 2) return false;
          if (t === want) return true;
          if (t.includes(want)) return true;
          if (want.includes(t)) return t.length >= minPart;
          return t.length >= 4 && sim(t, want) >= 0.75;
        });
      // 课程卡片文字现在是 UIA 的精确名字（OCR 只做兜底），所以「完全相等」是可判定的：
      // 先按精确度排序，避免 大学英语I / 大学英语III 这种兄弟课被模糊匹配抢走。
      const exact = (t) => normName(t) === want;
      // 「最近使用」在最上面，点它会进「通知详情」之类的页面而不是课程主页 → 优先点下方「我的课程」网格里的
      const score = (t) => {
        const n = normName(t);
        if (n === want) return 0;
        if (n.startsWith(want)) return 1;
        if (n.includes(want)) return 2;
        return 3;
      };
      // 同分时先要「名字更长」的那个：完整卡片胜过它的 OCR 碎片（碎片也可能刚好凑到同样的分数）。
      const rank = (a, b) => score(a.t) - score(b.t) || normName(b.t).length - normName(a.t).length || a.y - b.y;
      // 只有卡片体量的元素才可能是课程卡片：整块容器（页面/网格）中心点会乱点，
      // 左栏课程名、通知栏文字也不该被当成卡片。
      const cardish = (i) => (!i.w || i.w <= 760) && (!i.h || i.h <= 120);
      const match = (items) => {
        const all = matchAll(items).filter(cardish);
        if (!all.length) return null;
        const lower = all.filter((i) => i.y >= 250);
        // 精确同名优先（大学英语I / 大学英语III 这种兄弟课只能靠全等区分）
        const pick = (arr) => arr.filter((i) => exact(i.t)).sort((a, b) => a.y - b.y)[0];
        return pick(lower) || pick(all) || (lower.length ? lower : all).sort(rank)[0];
      };
      // 课程列表页可能不在前台（客户端是标签页模型：旧课程页、通知详情页都还开着）。
      // 以前这里不管当前在哪一页都用 texts() 在整块屏幕里找课 —— 它把后台标签页和首页
      // 「最近使用」的文字也当候选，坐标却落在当前页面上，于是「指定 Python 却点开大学英语I」。
      // 现在先确认可见页（OCR 头部）就是课程列表，不是就先回列表；卡片只信当前可见 Document。
      // 也不再走「首页 → 最近使用卡片」：那条路点的是首页推荐位，进的是通知详情而不是课程主页。
      const LIST_ONLY = /我学的课|新建文件夹/;
      const onListPage = async () => {
        const head = await this.ocr({ x: 140, y: 150, w: 1500, h: 260 }, 1);
        return LIST_ONLY.test(head.map((i) => String(i.t || '')).join(' '));
      };
      const toList = async (step) => {
        if (await onListPage()) return null;
        const nav = await this.goCourses();
        if (!nav.ok) {
          return { ok: false, err: 'not-on-list', step, nav: nav.err, texts: (nav.texts || []).slice(0, 8), ms: Date.now() - t0 };
        }
        if (await onListPage()) return null;
        return { ok: false, err: 'not-on-list', step: `${step}-header`, ms: Date.now() - t0 };
      };
      const notList = await toList('open');
      if (notList) return notList;
      // 点开的卡片是兄弟课（大学英语I vs III）时，换屏重试不要重复点同一个坐标
      const tried = new Set();
      const posKey = (i) => `${Math.round(i.x)},${Math.round(i.y)}`;
      // 当前屏可能已经能看到目标课程（上一轮操作留下的位置）
      let items = await this.pageItems(LIST_BOX);
      let hit = match(items.filter((i) => !tried.has(posKey(i))));
      this.log({ ev: 'open-look', hint: want.slice(0, 24), items: items.length, docs: [...new Set(items.map((i) => String(i.doc || '').slice(0, 10)))].length, hit: hit && `${String(hit.t).slice(0, 24)}@${Math.round(hit.x)},${Math.round(hit.y)}` });
      if (hit) {
        tried.add(posKey(hit));
        await this.clickItem(hit);
        await sleep(3000);
        let v = await this._enterCourse(title, { card: hit.t });
        this.log({ ev: 'open-enter', screen: -1, ok: v.ok, err: v.err || '', pageTitle: String(v.pageTitle || '').slice(0, 30) });
        // 点开的是兄弟课（大学英语I vs 大学英语III）时不要重复点同一张卡：
        // 直接进下面的翻屏循环，换一张候选卡片再试。
        if (!v.ok && v.err !== 'wrong-course' && v.err !== 'ambiguous-course' && v.err !== 'unverified-course') {
          // 首次点击可能落在卡片边缘/页面还在加载：再点一次同一张卡，仍不行就走下面的翻屏重试。
          await this.clickItem(hit);
          await sleep(3000);
          v = await this._enterCourse(title, { card: hit.t });
        }
        if (v.ok) return { ok: true, title, hit: hit.t, screen: -1, pageTitle: v.pageTitle, titleSim: v.titleSim, via: v.via || '', ambiguous: v.ambiguousTitle || '', hitCard: hit.t };
      }
      // 那次点击可能已经跳到了别的页面（点偏/页面自己刷新）：翻页之前先确认还在列表上
      const lost = await toList('retry');
      if (lost) return lost;
      // 回顶部
      const top = this.find(await this.ocr({ x: 1450, y: 860, w: 370, h: 280 }, 1), /返回顶部/);
      if (top) await this.clickItem(top);
      await sleep(500);
      for (let i = 0; i < 5; i++) await focus('{PGUP}');
      await sleep(600);
      let last = '';
      for (let screen = 0; screen < 5; screen++) {
        if (Date.now() > deadline) break;
        items = await this.pageItems(LIST_BOX);
        hit = match(items.filter((i) => !tried.has(posKey(i))));
        if (hit) {
          tried.add(posKey(hit));
          await this.clickItem(hit);
          await sleep(2600);
          const v = await this._enterCourse(title, { card: hit.t });
          this.log({ ev: 'open-enter', screen, ok: v.ok, err: v.err || '', pageTitle: String(v.pageTitle || '').slice(0, 30) });
          if (v.ok) return { ok: true, title, hit: hit.t, screen, pageTitle: v.pageTitle, titleSim: v.titleSim, via: v.via || '', ambiguous: v.ambiguousTitle || '', hitCard: hit.t };
          if (v.err === 'wrong-course' || v.err === 'ambiguous-course' || v.err === 'unverified-course') {
            // 点开的是只差一个数字的兄弟课：退回课程列表，翻回同一屏继续找
            await this.goCourses();
            await sleep(1200);
            for (let k = 0; k <= screen; k++) {
              await focus('{PGDN}');
              await sleep(420);
            }
            continue;
          }
          return { ok: false, err: v.err, hit: hit.t, screen };
        }
        const h = await this.hash(grid);
        if (h && h === last) break; // 到底了
        last = h;
        await focus('{PGDN}');
        await sleep(650);
      }
      items = await this.pageItems(LIST_BOX);
      const timedOut = Date.now() > deadline;
      return {
        ok: false,
        err: timedOut ? 'open-timeout' : 'course-not-found',
        texts: items.map((i) => i.t).slice(0, 40),
        ms: Date.now() - t0,
      };
    });
  }

  /** 读目录列表（章节页/任务页都可能已经开着，先 OCR 再决定是否点导航）
   *  expect：期望当前活动标签的课程名。客户端把开过的课都留在隐藏 webview 里，
   *  UIA 会把「后台标签」的章节文字一并返回（影视鉴赏的章节串到电路与磁路身上），
   *  所以只有在标签标题确实是这门课时才相信读到的内容。 */
  async readChapters(expect = '') {
    // 刚读过目录（chapters / backToCourse 确认时）→ 2.5 秒内直接复用，逐条目循环里
    // 每次「返回课程后再读一遍」都要花 ~0.9s，这一笔纯粹是重复劳动。
    const cached = this._chapterCache;
    if (cached && !cached.used && Date.now() - cached.at <= 2500) {
      cached.used = true;
      return { ok: true, chapters: cached.chapters, doc: cached.doc || '', cached: true };
    }
    // 刚由 backToCourse / chapters 确认过「已经回到本课的章节页」时，5 秒内不再跑一遍
    // 页校验（tabs+头部 OCR ≈ 0.55s）——逐条目循环里这一步每次都会白跑。
    if (expect && Date.now() - Number(this._chapterTrustAt || 0) <= 5000) {
      // 信任刚才的校验结果，直接读目录
    } else if (expect) {
      // 只有页面上明明写着「别的课」才拒绝读；读不懂（unknown）时继续读，
      // 以前这里用标签栏兜底判断，标签栏读错一个字就整门课报 wrong-tab。
      const pg = await this.pageCourse(expect);
      if (pg.where === 'other') {
        this.log({ ev: 'read-wrong-page', want: String(expect).slice(0, 30), other: String(pg.other).slice(0, 40) });
        return { ok: false, chapters: [], err: 'wrong-tab', tab: pg.other };
      }
      this._chapterTrustAt = Date.now();
    }
    const boxes = [
      // 整个内容区：每个标签页是独立 Document，下面按 doc 分组挑选，所以盒子要给足
      { x: 170, y: 200, w: 1500, h: 1350 },
      CHAPTER_PANEL,
      { x: 500, y: 220, w: 760, h: 900 },
      { x: 130, y: 130, w: 720, h: 900 },
      // 任务页的「目录」面板常在右侧（影视鉴赏），窄栏也要试
      { x: 1400, y: 200, w: 420, h: 900 },
      { x: 1215, y: 200, w: 600, h: 920 },
    ];
    for (const box of boxes) {
      const items = await this.texts(box, { scale: 1 });
      // 客户端把每个标签页放在独立 Document 里，UIA 会把后台标签的目录文字一起返回 →
      // 按 Document 分组，优先取「有第N章」的那一组（学习通正课结构），其次取条目最多的。
      const groups = new Map();
      for (const it of items) {
        const k = String(it.doc || '');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
      }
      let best = null;
      for (const [k, arr] of groups) {
        const chs = chaptersFrom(arr);
        if (chs.length < 2) continue;
        const head = chs.some((c) => /^第[一二三四五六七八九十百\d]+章/.test(normNum(c.t))) ? 1 : 0;
        const score = head * 1000 + chs.length;
        if (!best || score > best.score) best = { chapters: chs, doc: k, score };
      }
      this._chapterTrustAt = Date.now();
      if (best) {
        this._chapterCache = { at: Date.now(), chapters: best.chapters, doc: best.doc, used: false };
        return { ok: true, chapters: best.chapters, box, doc: best.doc };
      }
      const chapters = chaptersFrom(items);
      if (chapters.length >= 2) {
        this._chapterCache = { at: Date.now(), chapters, doc: '', used: false };
        return { ok: true, chapters, box };
      }
    }
    return { ok: false, chapters: [] };
  }

  /** 进入「章节」页并返回章节条目列表（OCR 左栏） */
  async chapters(expect = '', { force = false } = {}) {
    return this.t('chapters', async () => {
      // 先确认当前页面就是这门课：只有页面上明确写着别的课才停；
      // 页面还没渲染完（unknown）时重试几轮，仍读不懂就软放行——
      // 刚打开课程时立刻校验，旧代码在这里报 wrong-tab 后整门课被跳过（0 视频/0 文档）。
      if (expect) {
        let pg = await this.pageCourse(expect);
        for (let round = 0; round < 3 && pg.where === 'unknown'; round++) {
          await sleep(900);
          pg = await this.pageCourse(expect);
        }
        if (pg.where === 'other') {
          this.log({ ev: 'chapters-wrong-tab', want: String(expect).slice(0, 30), tab: String(pg.other).slice(0, 30) });
          return { ok: false, err: 'wrong-tab', tab: pg.other, chapters: [] };
        }
        if (pg.where !== 'course') this.log({ ev: 'verify-soft', want: String(expect).slice(0, 30), where: pg.where });
        this._chapterTrustAt = Date.now();
      }
      // 有些课程打开就是「章节」页（客户端记住上次标签）→ 先试着直接读
      // 但刚打开的课程首页里常混着别的标签的目录文字，force=true 时跳过这条捷径，先点「章节」再读
      let cur = force ? { ok: false } : await this.readChapters(expect);
      if (cur.ok) return { ok: true, count: cur.chapters.length, chapters: cur.chapters.map((c) => ({ t: c.t, x: c.x, y: c.y })), via: 'already', doc: cur.doc || '' };
      // 课程主页的「章节」在内容区左侧竖排导航里（webview 内容，UIA 看不到）→ 先 OCR 点击
      const navBox = { x: 120, y: 130, w: 260, h: 820 };
      let r = { ok: false };
      // 有的课打开后内容区还在加载，导航点不到 → 重试几轮
      for (let round = 0; round < 3 && !r.ok; round++) {
        if (round) await sleep(1800);
        const nv = await this.openNav('章节', { wait: 'chapters' });
        r = { ok: nv.ok, t: nv.t, via: nv.via };
        if (r.ok) break;
      }
      // openNav 内部已经 sleep 1900ms，这里不再固定等 1700ms：直接读，读不到再做短轮询。
      cur = await this.readChapters(expect);
      for (let k = 0; k < 3 && !cur.ok; k++) {
        await sleep(450);
        // 面板还没出现时不做昂贵的整窗扫描，先看目录区有没有 ≥2 条编号行
        if (chaptersFrom(await this.ocr(CHAPTER_PANEL, 1)).length < 2) continue;
        cur = await this.readChapters(expect);
      }
      if (!cur.ok) {
        // 兜底 1：目录区可能在别的滚动位置 → 全窗 OCR 找编号行
        const all = await this.texts(CONTENT, { scale: 1 });
        const rows = chaptersFrom(all);
        if (rows.length >= 2) {
          return { ok: true, count: rows.length, chapters: rows.map((c) => ({ t: c.t, x: c.x, y: c.y })), via: 'whole' };
        }
        // 兜底 2：「章节」这两个字常被 OCR 漏读（任务↔讨论 之间空出一格）→ 按相邻导航项间距推断位置点一下
        const navItems = (await this.ocr({ x: 180, y: 360, w: 220, h: 700 }, 2))
          .map((i) => ({ t: String(i.t || '').replace(/[^\u4e00-\u9fa5]/g, ''), x: i.x, y: i.y }))
          .filter((i) => i.t.length >= 2 && i.t.length <= 6)
          .sort((a, b) => a.y - b.y);
        for (let i = 0; i < navItems.length - 1; i++) {
          const dy = navItems[i + 1].y - navItems[i].y;
          if (dy < 120 || dy > 230) continue;
          const cx = navItems[i].x + 24;
          const cy = navItems[i].y + Math.round(dy / 2);
          await this.d.actions([{ cmd: 'click', x: cx, y: cy }, { cmd: 'sleep', ms: 2400 }]);
          const c2 = await this.readChapters();
          if (c2.ok) return { ok: true, count: c2.chapters.length, chapters: c2.chapters.map((c) => ({ t: c.t, x: c.x, y: c.y })), via: 'gap' };
          const rows2 = chaptersFrom(await this.texts(CONTENT, { scale: 1 }));
          if (rows2.length >= 2) return { ok: true, count: rows2.length, chapters: rows2.map((c) => ({ t: c.t, x: c.x, y: c.y })), via: 'gap-whole' };
        }
        // 兜底 3：导航确实点开了章节页、只是目录还没渲染/条目不是编号样式 → 软成功（下游按 0 条处理，不整门课失败）
        if (r.ok) {
          const hdr = await this.ocr({ x: 200, y: 100, w: 1400, h: 320 }, 1);
          const txt = hdr.map((i) => i.t).join(' ');
          if (/目录|讨论|笔记|任务点|已完成/.test(txt)) {
            return { ok: true, count: 0, chapters: [], via: 'nav-empty', soft: true };
          }
        }
        return { ok: false, err: 'chapter-tab', clicked: r.ok };
      }
      return { ok: true, count: cur.chapters.length, chapters: cur.chapters.map((c) => ({ t: c.t, x: c.x, y: c.y })), via: r.ok ? 'nav' : 'retry', doc: cur.doc || '' };
    });
  }

  /** 点击某个章节条目（文本匹配） */
  async openChapter(re) {
    return this.t('open-chapter', async () => {
      const cur = await this.readChapters();
      const ch = cur.chapters.find((c) => re.test(normNum(c.t)));
      if (!ch) return { ok: false, err: 'no-chapter', have: cur.chapters.slice(0, 12).map((c) => c.t) };
      await this.clickItem(ch);
      await sleep(2500);
      // 任务页最可靠的标志是顶部标签变成「学生学习页面」（另加正文里的 返回课程/目录）
      const tabs = await this.texts({ x: 240, y: 55, w: 1200, h: 95 }, { scale: 1 });
      const tabTexts = tabs.map((i) => i.t).join(' ');
      const page = await this.ocr({ x: 300, y: 100, w: 1300, h: 320 }, 1);
      const texts = page.map((i) => i.t);
      const isTask =
        /学生学习页面|章节详情/.test(tabTexts) ||
        texts.some((t) => /目录|返回课程|任务点|学习目标|章节测验/.test(t));
      return { ok: isTask, chapter: ch.t, tab: tabTexts.slice(0, 20), texts: texts.slice(0, 6) };
    });
  }

  /** 任务页顶部标签行：1学习目标 / 2视频 / 3章节测验（OCR 常把相邻标签并成一条，这里按数字前缀拆开并估算 x） */
  async taskTabs() {
    const strips = [
      { x: 240, y: 200, w: 1180, h: 200 },
      { x: 300, y: 280, w: 900, h: 130 },
      { x: 240, y: 230, w: 1000, h: 140 },
      { x: 300, y: 300, w: 800, h: 100 },
    ];
    let best = [];
    let bestExact = -1;
    for (const box of strips) {
      const items = await this.ocr(box, 1);
      const out = [];
      for (const it of items) {
        const raw = normNum(it.t || '');
        if (!/学习目标|视频|章节测验|作业|考试|讨论|资料/.test(raw)) continue;
        const parts = raw.split(/(?=\d)/).filter((s) => s && /\d/.test(s[0]));
        if (!parts.length) parts.push(raw);
        const total = parts.reduce((a, p) => a + p.length, 0) || 1;
        let acc = 0;
        for (const p of parts) {
          const startFrac = acc / total;
          const endFrac = (acc + p.length) / total;
          acc += p.length;
          const label = p.replace(/^\d+/, '');
          if (!label) continue;
          const exact = parts.length === 1 ? 1 : 0;
          out.push({
            label,
            x: Math.round(it.x + it.w * ((startFrac + endFrac) / 2)),
            y: Math.round(it.y + it.h / 2),
            raw: p,
            exact,
          });
        }
      }
      const exactN = out.filter((t) => t.exact).length;
      if (out.length >= 2 && exactN > bestExact) {
        best = out;
        bestExact = exactN;
      }
      if (exactN >= 2) break;
    }
    return best;
  }

  /** 点任务页顶部某个标签（学习目标/视频/章节测验），点完用正文哈希校验是否真的切了 */
  async openTab(re) {
    const tabs = await this.taskTabs();
    const hit = tabs.find((t) => re.test(t.label));
    if (!hit) return { ok: false, err: 'tab-not-found', tabs: tabs.map((t) => t.label) };
    const probe = { x: 300, y: 400, w: 900, h: 520 };
    let h0 = await this.hash(probe);
    for (const dx of [0, -22, 22, -40]) {
      const x = Math.round(hit.x + dx);
      await this.d.actions([{ cmd: 'click', x, y: hit.y }, { cmd: 'sleep', ms: 1900 }]);
      const h1 = await this.hash(probe);
      if (h1 && h1 !== h0) return { ok: true, tab: hit.label, x, y: hit.y, moved: true };
      h0 = h1;
    }
    return { ok: true, tab: hit.label, x: hit.x, y: hit.y, moved: false };
  }

  /** 任务页：读正文区文本（判断是文档还是视频/测验） */
  async taskInfo() {
    const items = await this.ocr(TASK_PANEL, 1);
    const texts = items.map((i) => i.t);
    const isVideo = texts.some((t) => /:?\d{1,2}:\d{2}/.test(t)) || texts.some((t) => /播放|暂停/.test(t));
    const isQuiz = texts.some((t) => /单选题|多选题|判断题|提交|测验|答题/.test(t));
    const isDoc = texts.some((t) => /第\s*\d+\s*页|\/\s*\d+\s*页|上一页|下一页/.test(t));
    return { texts: texts.slice(0, 10), isVideo, isQuiz, isDoc, raw: items };
  }

  /** 文档滚动：先点正文让它获得焦点，再用 PageDown 推进（实测 mouse_event/postwheel 在 Electron 内层不生效，键盘可以） */
  async scrollDoc({ maxBatches = 14, keys = 3, box = { x: 800, y: 380, w: 760, h: 600 } } = {}) {
    return this.t('scroll-doc', async () => {
      const b = this.clip(box);
      // 聚焦正文区（点一下就够，之后键盘事件会进 webview）
      await this.d.actions([{ cmd: 'click', x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) }, { cmd: 'sleep', ms: 250 }]);
      let prev = '';
      let same = 0;
      let batches = 0;
      const t0 = Date.now();
      for (let i = 0; i < maxBatches; i++) {
        const acts = [];
        for (let k = 0; k < keys; k++) acts.push({ cmd: 'key', seq: '{PGDN}' }, { cmd: 'sleep', ms: 180 });
        acts.push({ cmd: 'sleep', ms: 250 }, { cmd: 'hash', x: box.x, y: box.y, w: box.w, h: box.h });
        const p = await this.d.actions(acts, 60000);
        const h = p.results?.[p.results.length - 1]?.hash || '';
        batches = i + 1;
        if (h && h === prev) {
          same++;
          if (same >= 2) break;
        } else same = 0;
        prev = h;
      }
      return { batches, ms: Date.now() - t0, endHash: prev };
    });
  }

  /** 视频：点播放，然后按时间文本/画面哈希判断是否在走，直到结束或超时 */
  async playVideo({ maxSec = 900, box = { x: 700, y: 300, w: 800, h: 600 } } = {}) {
    return this.t('play-video', async () => {
      const cb = this.clip(box);
      await this.d.actions([{ cmd: 'click', x: Math.round(cb.x + cb.w / 2), y: Math.round(cb.y + cb.h / 2) }, { cmd: 'sleep', ms: 1500 }]);
      const t0 = Date.now();
      let last = '';
      let same = 0;
      let sec = 0;
      let timeText = '';
      while ((Date.now() - t0) / 1000 < maxSec) {
        await sleep(6000);
        const p = await this.d.actions([{ cmd: 'ocr', x: cb.x, y: cb.y, w: cb.w, h: cb.h }], 60000);
        const list = p.results?.[0]?.items || [];
        const times = list.filter((i) => /\d{1,2}:\d{2}/.test(i.t)).map((i) => i.t);
        const key = times.join('|') || list.map((i) => i.t).slice(0, 3).join('|');
        sec = Math.round((Date.now() - t0) / 1000);
        if (key && key === last) same++;
        else same = 0;
        last = key;
        timeText = times[0] || '';
        if (same >= 2) break;
      }
      return { sec, timeText, lastKey: last };
    });
  }
  /** 回到「我的课程」列表（复用 goCourses，保证从任务页也能回来） */
  /** 客户端重启后会弹「用户登录」对话框（带已保存的头像与「登录」按钮），不点掉就一直停在首页 */
  async ensureLoggedIn() {
    const box = { x: 520, y: 260, w: 860, h: 620 };
    for (let i = 0; i < 3; i++) {
      const items = await this.ocr(box, 1);
      const txt = items.map((it) => String(it.t || '')).join(' ');
      if (!/用户登录|切换账号|扫码登录/.test(txt)) return true;
      const btn = items.find((it) => /^登录$/.test(String(it.t || '').trim()));
      if (btn) {
        this.log({ ev: 'login-click', tries: i + 1 });
        await this.clickItem(btn);
      } else {
        this.log({ ev: 'login-wait', tries: i + 1 });
      }
      await sleep(2600);
    }
    const after = await this.ocr(box, 1);
    const ok = !/用户登录|切换账号/.test(after.map((it) => String(it.t || '')).join(' '));
    this.log({ ev: 'login-done', ok });
    return ok;
  }

  async goHome() {
    return this.goCourses();
  }

  /** 点击目录条目后等正文标题变成该条目名（避免读到上一条目的「任务点已完成」） */
  async waitTaskTitle(name, { timeoutMs = 7000 } = {}) {
    const want = normName(name).slice(0, 6);
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const items = await this.ocr({ x: 300, y: 220, w: 1300, h: 380 }, 1);
      const txt = items.map((i) => normName(i.t)).join(' ');
      if (want && txt.includes(want)) return true;
      await sleep(600);
    }
    return false;
  }

  /** 当前是否在任务页（顶部标签是「学生学习页面」） */
  async isTaskPage() {
    // 先用 OCR（约 0.27s）：标签文字清晰、命中率够；UIA+OCR 的 texts 要 0.8s，
    // 而这个判断每个条目要跑 1~3 次。OCR 没命中再退回 texts，避免误判。
    const box = { x: 240, y: 55, w: 1200, h: 95 };
    const one = await this.ocr(box, 1);
    if (/学生学习页面|章节详情/.test(one.map((i) => i.t).join(' '))) return true;
    const tabs = await this.texts(box, { scale: 1 });
    return /学生学习页面|章节详情/.test(tabs.map((i) => i.t).join(' '));
  }

  /** 任务页 → 点左上「返回课程」回到课程章节页 */
  async backToCourse() {
    for (let i = 0; i < 3; i++) {
      const tb = await this.ocr({ x: 170, y: 100, w: 460, h: 95 }, 1);
      const b = tb.find((x) => /返回课程|返回/.test(x.t || ''));
      if (b) {
        await this.clickItem(b);
        // 点完「返回课程」后轮询目录面板：以前固定 sleep 2200 再读一次，正常情况白等 1.5s+。
        // 面板一出现 ≥2 条编号行就确认，最多等 ~4s，再交给下一轮重试。
        for (let k = 0; k < 8; k++) {
          if (k) await sleep(260);
          const panel = await this.ocr(CHAPTER_PANEL, 1);
          if (chaptersFrom(panel).length < 2) continue;
          const cur = await this.readChapters();
          if (cur.ok) return true;
        }
      }
      await sleep(600);
    }
    return false;
  }

  /** 课程章节列表翻一屏：点列表区右下空白处聚焦 + PGDN，用像素哈希判断是否真的动了 */
  async scrollList(box = { x: 500, y: 220, w: 760, h: 900 }) {
    const cb = this.clip(box);
    const h0 = await this.hash(cb);
    // 优先用 computer-use 发真实滚轮（把鼠标放进列表中部滚动，不点击，避免误点开行）
    if (this.d && typeof this.d.wheelInRect === 'function') {
      try {
        await this.d.wheelInRect(cb, { direction: 'down', amount: 5, rx: Math.round(Math.min(cb.w - 60, 760)), ry: Math.round(cb.h / 2) });
        await new Promise((r) => setTimeout(r, 700));
        const h1 = await this.hash(cb);
        if (h0 !== h1) return true;
      } catch {
        /* 滚轮不可用就走老办法 */
      }
    }
    await this.d.actions([
      // 点列表区右上角空白处聚焦（点在行上会误打开作业/章节）
      { cmd: 'click', x: cb.x + cb.w - 20, y: cb.y + 12 },
      { cmd: 'sleep', ms: 200 },
      { cmd: 'key', seq: '{PGDN}' },
      { cmd: 'sleep', ms: 900 },
    ]);
    const h2 = await this.hash(cb);
    return h0 !== h2;
  }

  /** 任务页「目录」面板里的条目。不同课程/页面目录可能在左栏（电工电子技术）或右栏（影视鉴赏），两边都试 */
  async sidebarItems() {
    const boxes = [
      { x: 150, y: 230, w: 440, h: 890 },
      { x: 1215, y: 240, w: 600, h: 880 },
    ];
    for (const box of boxes) {
      const items = await this.ocr(box, 1);
      const rows = chaptersFrom(items).map((c) => ({ t: c.t, x: c.x, y: c.y, w: c.w, h: c.h, n: normNum(c.t) }));
      if (rows.length >= 2) return { ok: true, rows, box: this.clip(box) };
    }
    return { ok: false, rows: [] };
  }

  /** 目录面板翻页：先点面板空白处聚焦，再用键盘翻页（鼠标滚轮在 webview 内层无效） */
  async scrollSidebar(dy = '{PGDN}') {
    const boxes = [
      { x: 150, y: 230, w: 440, h: 890 },
      { x: 1215, y: 240, w: 600, h: 880 },
    ];
    for (const b of boxes) {
      const items = await this.ocr(b, 1);
      if (chaptersFrom(items).length >= 2) {
        const cb = this.clip(b);
        // 点面板底部空白（最后一行下方 30px 处），避免误点条目
        const rows = chaptersFrom(items);
        const last = rows[rows.length - 1];
        await this.d.actions([
          { cmd: 'click', x: Math.round(last.x), y: Math.round(Math.min(cb.y + cb.h - 20, last.y + 70)) },
          { cmd: 'sleep', ms: 200 },
          { cmd: 'key', seq: dy },
          { cmd: 'sleep', ms: 800 },
        ]);
        return true;
      }
    }
    return false;
  }

  /** 把 OCR 碎片按 y 带合并成整行（同一行被拆成多段文本时用） */
  lines(items) {
    const rows = [];
    for (const it of items || []) {
      const t = String(it.t || '').trim();
      if (!t) continue;
      const y = Math.round(it.y || 0);
      const row = rows.find((r) => Math.abs(r.y - y) <= 12);
      if (row) row.parts.push(it);
      else rows.push({ y, parts: [it] });
    }
    rows.sort((a, b) => a.y - b.y);
    return rows.map((r) => {
      r.parts.sort((a, b) => (a.x || 0) - (b.x || 0));
      return {
        y: r.y,
        x: r.parts[0].x || 0,
        w: r.parts.reduce((s, p) => s + (p.w || 0), 0),
        h: r.parts[0].h || 0,
        t: r.parts.map((p) => p.t).join(''),
        parts: r.parts.map((p) => ({ t: p.t, x: p.x, y: p.y, w: p.w })),
      };
    });
  }

  /** 课程页左侧导航里点某个入口（作业/任务/考试/资料/讨论/章节…） */
  /** 导航文字容错匹配：OCR 常把「章节」认成「童节」、「作业」认成「作亚」等，两字标签允许 1 字差 */
  _labelHit(items, label) {
    const w = normName(label);
    return (items || []).find((i) => {
      const t = normName(i.t);
      if (!t) return false;
      if (t === w) return true;
      if (t.length <= 3 && w.length <= 3) return sim(t, w) >= 0.5;
      return t.includes(w) && t.length <= w.length + 2;
    });
  }

  /** 左侧二级导航竖条（只在 x<400 里找：作业列表行里的蓝色「作业」徽标在 x≈480，
   *  一旦扫到内容区就会「点徽标 = 打开作业」，这是之前误开作业的根因） */
  static get NAV_BOXES() {
    return [
      { x: 190, y: 400, w: 200, h: 700 },
      { x: 120, y: 130, w: 260, h: 820 },
      { x: 150, y: 300, w: 240, h: 760 },
      { x: 150, y: 500, w: 240, h: 560 },
    ];
  }

  async openNav(label, { wait = '' } = {}) {
    const re = new RegExp(`^${label}$`);
    // 点击后默认固定等 1900ms（页面渲染时间不定）。wait='chapters' 时改成轮询目录面板：
    // 面板一出来就返回，常见情况只花 0.3~0.9s，比死等省 1s 以上。
    const settle = async () => {
      if (wait !== 'chapters') {
        await sleep(1900);
        return;
      }
      for (let k = 0; k < 7; k++) {
        if (k) await sleep(280);
        if (chaptersFrom(await this.ocr(CHAPTER_PANEL, 1)).length >= 2) return;
      }
    };
    for (const box of DeskFlow.NAV_BOXES) {
      for (const scale of [2, 1]) {
        const items = await this.ocr(box, scale);
        const hit = this._labelHit(items, label);
        if (hit) {
          await this.clickItem(hit);
          await settle();
          return { ok: true, via: 'ocr', label, t: hit.t };
        }
      }
    }
    const u = await this.clickUia(re, { leftOnly: true });
    if (u && u.ok) {
      await settle();
      return { ok: true, via: 'uia', label, t: u.hit };
    }
    return { ok: false, err: 'nav-not-found', label };
  }

  /** 作业列表页的标志：顶部有「筛选 / 未完成 / 已完成」。返回 {ready, txt}。
   *  「点到了作业导航」不等于「作业列表出来了」：点偏、页面还在加载、客户端停在别的标签时
   *  都只是 ok:true，但列表根本没出现；这时去 readWorks 只会读到 0 行，静默变成「没有未交作业」。 */
  async worksReady({ tries = 4, gap = 900 } = {}) {
    const box = this.worksBox();
    const area = { x: box.x, y: box.y - 40, w: Math.round(box.w * 0.72), h: 300 };
    // 「筛选/未完成/已完成」是灰色小字，1x 截图经常整行读不到（而作业行的「作业05」「余76小时」读得到），
    // 于是页已经切过去了还被判成「停在章节页」。这里放大再认，并接受作业页上稳定可读的几种字样。
    const marker = /筛选|未完成|未交|作业\s*0?\d|大雅|剩余|余\s*\d+\s*(小时|分钟)/;
    let txt = '';
    for (let i = 0; i < Math.max(1, tries); i += 1) {
      if (i) await sleep(gap);
      try {
        const head = await this.ocr(area, i % 2 ? 2 : 3);
        txt = head.map((x) => String(x.t || '')).join(' ');
      } catch {
        txt = '';
      }
      if (marker.test(txt)) return { ready: true, txt };
    }
    return { ready: false, txt };
  }

  /** 课程页 → 作业列表（点导航后必须确认列表真的出来：顶部筛选行是作业页专属）。
   *  以前只返回 nav.ok，点了「作业」其实还停在课程/章节页也当成功，上层随后读到 0 行，
   *  静默报「没有未交作业」——用户看到的就是「指定课程作业，客户端却停在课程章节页」。 */
  async goWorks({ retries = 2 } = {}) {
    this._worksFocus = false;
    this._worksPage = 1;
    let nav = await this.openNav('作业');
    if (!nav.ok) return nav;
    let ready = await this.worksReady();
    if (ready.ready) return { ...nav, ready: true };
    // 没切过去 → 再点一次：先 UIA 直连左栏（OCR 可能把「作业」认成别的字），
    // 再看标签栏里是不是已经开着「作业」标签，最后退回 OCR 导航。
    for (let i = 0; i < Math.max(0, retries); i += 1) {
      const uia = await this.clickUia(/^作业$/, { leftOnly: true });
      if (uia.ok) nav = { ok: true, via: 'uia', label: '作业', t: uia.hit };
      else if (await this.activateTab(/^作业$/)) nav = { ok: true, via: 'tab', label: '作业' };
      else {
        nav = await this.openNav('作业');
        if (!nav.ok) break;
      }
      await sleep(1200);
      ready = await this.worksReady({ tries: 3 });
      if (ready.ready) return { ...nav, ready: true, retries: i + 1 };
    }
    return { ...nav, ready: false, txt: String(ready.txt || '').slice(0, 60) };
  }

  /** 作业列表区域：按窗口尺寸推算（最大化 1821x1137 时 ≈ x400 y170 w1165 h955），不再写死旧分辨率 */
  worksBox() {
    const r = (this.d && this.d.rect) || {};
    const w = Number(r.w) > 600 ? Number(r.w) : 1821;
    const h = Number(r.h) > 400 ? Number(r.h) : 1137;
    return {
      x: Math.round(w * 0.22),
      y: Math.round(h * 0.15),
      w: Math.round(w * 0.64),
      h: Math.round(h * 0.84),
    };
  }

  /** 作业列表滚动一屏：优先真实滚轮（不点击），没有 computer-use 就点表头聚焦 + PGDN/PGUP */
  async scrollWorks(box = this.worksBox(), { direction = 'down' } = {}) {
    const h0 = await this.hash(box);
    if (this.d && typeof this.d.wheelInRect === 'function') {
      try {
        await this.d.wheelInRect(box, { direction, amount: 7, rx: Math.round(box.w * 0.55), ry: Math.round(box.h * 0.6) });
        await sleep(800);
        if (h0 !== (await this.hash(box))) return true;
      } catch {
        /* 没有 computer-use：退回键盘翻页 */
      }
    }
    if (!this._worksFocus) {
      const head = await this.ocr({ x: box.x, y: box.y, w: Math.round(box.w * 0.6), h: 130 }, 2);
      // 只点表头文字（班级名/「筛选」），绝不点列表行，避免把作业点开
      const safe = head.find((i) => /班|筛选/.test(String(i.t || '').trim()));
      if (safe) {
        await this.d.actions([{ cmd: 'click', x: Math.round(safe.x), y: Math.round(safe.y) }, { cmd: 'sleep', ms: 350 }]);
        this._worksFocus = true;
      }
    }
    await this.d.actions([{ cmd: 'key', seq: direction === 'down' ? '{PGDN}' : '{PGUP}' }, { cmd: 'sleep', ms: 1100 }]);
    return h0 !== (await this.hash(box));
  }

  /** 作业作答页滚动：优先真实滚轮小步滚（有重叠，跨屏的题不会被切断），否则 PGDN 整屏 */
  async scrollWork(box, direction = 'down', amount = 4) {
    if (this.d && typeof this.d.wheelInRect === 'function') {
      try {
        await this.d.wheelInRect(box, { direction, amount, rx: Math.round(box.w * 0.5), ry: Math.round(box.h * 0.5) });
        // webview 的滚轮有惯性：画面没停就 OCR/点击，坐标会差出上百像素（实测点空）
        await sleep(1200);
        const h1 = await this.hash(box);
        await sleep(500);
        if (h1 !== (await this.hash(box))) await sleep(900);
        return true;
      } catch {
        /* 没有 computer-use：退回键盘翻页 */
      }
    }
    await this.d.actions([{ cmd: 'key', seq: direction === 'down' ? '{PGDN}' : '{PGUP}' }, { cmd: 'sleep', ms: 1100 }]);
    return true;
  }

  /** 作业列表翻页：底部有 1/2 页码（白字蓝底小圆圈，scale=3 才认得出），点目标页并校验列表变了 */
  async gotoWorksPage(n, box = this.worksBox()) {
    if (this._worksSinglePage) return (this._worksPage || 1) === n;
    if ((this._worksPage || 1) === n) return true;
    const strip = { x: box.x + Math.round(box.w * 0.35), y: box.y + box.h - 170, w: 300, h: 120 };
    let hit = null;
    for (const scale of [3, 2]) {
      const items = await this.ocr(strip, scale);
      hit = items.find((i) => new RegExp(`^${n}$`).test(String(i.t || '').trim()));
      if (hit) break;
    }
    const h0 = await this.hash(box);
    const pt = hit
      ? { x: Math.round(hit.x), y: Math.round(hit.y) }
      : { x: Math.round(box.x + box.w * (n === 1 ? 0.542 : 0.565)), y: Math.round(box.y + box.h - 121) };
    await this.d.actions([{ cmd: 'click', x: pt.x, y: pt.y }, { cmd: 'sleep', ms: 1800 }]);
    this._worksFocus = false;
    if (h0 === (await this.hash(box))) return false;
    this._worksPage = n;
    return true;
  }

  /** 按标题打开作业：先把列表滚回顶部，再按「当前这屏」的坐标点，避免用读列表时留下的过期坐标 */
  async openWork(title) {
    const box = this.worksBox();
    const norm = String(title || '').replace(/\s+/g, '');
    if ((this._worksPage || 1) !== 1) await this.gotoWorksPage(1, box);
    // 回到顶部：点表头聚焦（绝不点列表行）
    await this.scrollWorks(box, { direction: 'up' });
    await this.d.actions([{ cmd: 'key', seq: '{HOME}' }, { cmd: 'sleep', ms: 900 }]);
    for (let i = 0; i < 8; i++) {
      const lines = this.lines(await this.ocr(box, 2));
      const hit = lines.find((l) => String(l.t || '').replace(/\s+/g, '').includes(norm));
      if (hit) {
        const x = Math.round(hit.x);
        const y = Math.round(hit.y);
        await this.d.actions([{ cmd: 'click', x, y }, { cmd: 'sleep', ms: 3000 }]);
        return { ok: true, x, y };
      }
      if (!(await this.scrollWorks(box, { direction: 'down' }))) break;
    }
    return { ok: false, err: 'work-not-found' };
  }

  /** 作业列表：返回 [{title, status, x, y, w, h}]；status ∈ 未交/待批阅/已完成/'' */
  async readWorks({ scroll = true, maxScroll = 12, pages = 3 } = {}) {
    const box = this.worksBox();
    const out = new Map();
    // 客户端会记住上次滚动位置（重进作业页可能停在半截）→ 先回顶部，否则会漏掉上面的行
    if (scroll) {
      await this.scrollWorks(box, { direction: 'up' });
      await this.d.actions([{ cmd: 'key', seq: '{HOME}' }, { cmd: 'sleep', ms: 800 }]);
    }
    const NOISE = /大雅|相似度|智能分析|批阅|修改答案|查看|成绩|得分|筛选|全部|已完成|未完成/;
    const isTitle = (s) => {
      const t = String(s || '').replace(/\s+/g, '');
      if (t.length < 4 || t.length > 40) return false;
      if (!/习题|作业|测试|测验|实验|报告|论文/.test(t)) return false;
      if (NOISE.test(t)) return false;
      if (/^(作业|习题|测试|测验)$/.test(t)) return false;
      return true;
    };
    const titleRows = (lines) => lines.filter((l) => isTitle(l.t) && l.x > box.x - 140 && l.x < box.x + 560);
    // 状态行在标题下方 y+16~74（左对齐，可能和「智能分析」按钮并成一行）
    const statusNear = (lines, t) => {
      for (const l of lines) {
        if (l.y < t.y + 14 || l.y > t.y + 76) continue;
        if (Math.abs((l.x || 0) - t.x) > 220) continue;
        const st = normWorkStatus(l.t);
        if (st) return st;
      }
      return '';
    };
    const once = async () => {
      const lines = this.lines(await this.ocr(box, 2));
      let added = 0;
      for (const t of titleRows(lines)) {
        const norm = t.t.replace(/\s+/g, '');
        const prev = out.get(norm);
        if (!prev) added++;
        let status = statusNear(lines, t);
        if (!status && !(prev && prev.status)) {
          // 状态是灰色小字，整屏 scale=2 常读不到 → 单行条带放大 3 倍补一次
          const strip = { x: Math.max(0, Math.round(t.x - 120)), y: Math.round(t.y + 10), w: 320, h: 62 };
          for (const l of this.lines(await this.ocr(strip, 3))) {
            const st = normWorkStatus(l.t);
            if (st) {
              status = st;
              break;
            }
          }
        }
        if (!prev || (!prev.status && status)) {
          out.set(norm, {
            title: norm,
            status,
            x: Math.round(t.x),
            y: Math.round(t.y),
            w: t.w,
            h: t.h,
          });
        }
      }
      return added;
    };
    await once();
    for (let i = 0; scroll && i < maxScroll; i++) {
      if (!(await this.scrollWorks(box, { direction: 'down' }))) break;
      await once();
    }
    for (let p = 1; scroll && p < pages; p++) {
      if (this._worksSinglePage) break;
      if (!(await this.gotoWorksPage(p + 1, box))) {
        this._worksSinglePage = true;
        break;
      }
      const before = out.size;
      await once();
      for (let i = 0; scroll && i < maxScroll; i++) {
        if (!(await this.scrollWorks(box, { direction: 'down' }))) break;
        await once();
      }
      // 页码「2」常常是禁用态（点了没反应，只触发 hover 高亮）→ 没读到新行就认定单页，别再来回点
      if (out.size === before) {
        this._worksSinglePage = true;
        break;
      }
    }
    // 读完回到第 1 页并滚回顶部，方便调用方直接点行
    if (scroll && !this._worksSinglePage && (this._worksPage || 1) !== 1) await this.gotoWorksPage(1, box);
    const list = [...out.values()];
    if (!list.length) {
      // 一条行都没认出来时把整块 OCR 结果留档：下次调 x/y 阈值、题型门槛不用再靠猜
      try {
        const raw = this.lines(await this.ocr(box, 1))
          .slice(0, 14)
          .map((l) => `${Math.round(l.x)},${Math.round(l.y)} ${String(l.t || '').slice(0, 24)}`);
        this.log({ ev: 'works-ocr', n: raw.length, lines: raw });
      } catch { /* 留档失败不影响主流程 */ }
    }
    return { ok: list.length > 0, list, box, pages: this._worksPage || 1 };
  }

  /** 当前页是否作业作答页：返回 {tab, head, done, isWork}（done=页头已有成绩/待批阅等结果标记） */
  async workCtx() {
    const tabs = await this.texts({ x: 180, y: 55, w: 1300, h: 80 }, { scale: 1 });
    const tab = tabs.map((i) => String(i.t || '')).join('').replace(/\s+/g, '');
    const head = await this.texts({ x: 300, y: 105, w: 1450, h: 265 }, { scale: 1 });
    const headText = head.map((i) => String(i.t || '')).join('').replace(/\s+/g, '');
    const DONE = /成绩|得分|待[扌批比]?[比批]?阅|已提交|已完成|修改答案|查看答案|智能分析|作业详情/;
    const done = DONE.test(tab) || DONE.test(headText);
    const isWork = !done && /暂时保存|提交|题量|作答开始时间|满分/.test(headText);
    // 「题量：65」的小字常被 OCR 读成「量：65」
    const m = headText.match(/(?:题|闯)?量\s*[：:]\s*(\d+)/);
    return { tab, head: headText, done, isWork, expect: m ? Number(m[1]) : 0 };
  }

  /** 关掉作业标签页回列表（标签栏里还有「课程」「课程名」，Ctrl+W 不会关到最后一个） */
  async backFromWork() {
    const tabs = await this.texts({ x: 180, y: 55, w: 1300, h: 80 }, { scale: 1 });
    const names = tabs.map((i) => String(i.t || '').replace(/\s+/g, '')).filter(Boolean);
    if (names.length >= 2 && names.some((t) => /作业/.test(t))) {
      await this.d.actions([{ cmd: 'key', seq: '^w' }, { cmd: 'sleep', ms: 2200 }]);
      this._worksFocus = false;
      return { ok: true, via: 'ctrl-w' };
    }
    const nav = await this.goWorks();
    // ready:false 也是「没回到作业列表」：上层不能接着 readWorks（读到 0 行会伪装成没有作业）
    return {
      ok: !!nav.ok && nav.ready !== false,
      via: 'nav',
      ready: nav.ready !== false,
      ...(nav.ready === false ? { err: 'work-list-not-shown', txt: nav.txt } : {}),
    };
  }

  /** 是否已显示「任务点已完成」 */
  async taskDone() {
    const items = await this.texts({ x: 520, y: 230, w: 900, h: 360 }, { scale: 1 });
    return items.some((i) => /任务点已完成/.test(i.t));
  }

  /** 点右侧目录里的某个条目 */
  async clickSidebarRow(row) {
    await this.clickItem(row);
    await sleep(2200);
    return true;
  }
}

// 作业状态：未交 / 待批阅 / 已完成（灰色小字 OCR 常认成「耒交/末交/待扌比阅」）
const ST_DONE = /待[扌批比]?[比批]?阅|已批阅|查看答案|查看解析/;
const ST_SUBMITTED = /已提交|已完成|已交/;
const ST_PENDING = /未\s*交|末\s*交|耒\s*交|未提交|待交|去完成|立即完成|未完成|待完成|开始答题|未作答/;

export function normWorkStatus(s) {
  const t = String(s || '').replace(/\s+/g, '');
  if (!t) return '';
  if (ST_DONE.test(t)) return '待批阅';
  if (ST_SUBMITTED.test(t)) return '已完成';
  if (ST_PENDING.test(t)) return '未交';
  return '';
}

export function normNum(s) {
  return String(s || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/\s+/g, '');
}

export function chaptersFrom(items) {
  // 「1.1 影视概说」这类编号条目，以及「专题一 …」「第一章 …」这类不带小数的（形势与政策等专题课）
  const isRow = (s) => /^\d+[.．]\d+/.test(s) || /^(专题|第)[一二三四五六七八九十百\d]+/.test(s);
  // 右侧通知栏的时间戳（「11月23日 14时47分」）经 normNum 后是「11.2314：47」，会冒充成 1.x 章节；
  // 作业/进度角标、空标题同理。判定必须「含中文 + 不是时间/状态短语」。
  const NOISE = /结束时间|开课时间|剩余|转发|进入微应用|进行中|已结束|任务点进度|已完成|未交/;
  const isTimeish = (n) => /^\d+[.．]\d+\d{1,2}[:：]\d{2}/.test(n);
  const isChapter = (raw) => {
    const s = String(raw || '').trim();
    if (!s || !/[\u4e00-\u9fa5]/.test(s)) return false;
    if (NOISE.test(s)) return false;
    const n = normNum(s);
    if (!isRow(n)) return false;
    if (isTimeish(n)) return false;
    return true;
  };
  // 窗口更大时 OCR 区域会同时覆盖正文与右侧「目录」，同一章可能被读到两次：按标题去重
  const seen = new Set();
  let picked = (items || []).filter((i) => isChapter(i.t));
  // 客户端会把后台标签页（别的课）的目录也一起暴露给 UIA，同一个盒子里能同时读到
  // 「第一章 电路的基本概念 / 1.1 第一课时」和另一门专题课的「专题一 …」。
  // 学习通的章节结构是「第N章 …」+「N.M …」，所以只要出现「第N章」就直接锁定这一族，
  // 把「专题」等其他课的目录行丢掉。
  const chapHead = picked.some((i) => /^第[一二三四五六七八九十百\d]+章/.test(normNum(i.t)));
  if (chapHead) {
    picked = picked.filter((i) => {
      const n = normNum(i.t);
      return /^第[一二三四五六七八九十百\d]+章/.test(n) || /^\d+[.．]\d+/.test(n);
    });
  }
  const rows = picked
    .filter((i) => {
      const k = normNum(i.t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((i) => {
      // UIA 会把条目右侧的橙色角标（未完成数字）并进名字里：「1.2 第二课时8」→ 标题 + 角标
      let t = String(i.t || '').trim();
      let badge0 = 0;
      const mb = t.match(/^(.*?[^\d])(\d{1,2})$/);
      if (mb && /[\u4e00-\u9fa5]/.test(mb[1])) {
        t = mb[1].trim();
        badge0 = Number(mb[2]);
      }
      return { t, x: i.x, y: i.y, w: i.w, h: i.h, badge: badge0 };
    });
  // 未完成条目右侧有橙色数字角标（已完成是绿勾、无文字），把离得最近的数字当成角标
  const nums = (items || []).filter((i) => /^\d{1,2}$/.test(String(i.t || '').trim()));
  for (const n of nums) {
    let best = null;
    let bestDy = 1e9;
    for (const r of rows) {
      const dy = Math.abs((r.y + (r.h || 20) / 2) - (n.y + (n.h || 20) / 2));
      if (dy < bestDy && n.x > r.x) {
        bestDy = dy;
        best = r;
      }
    }
    if (best && bestDy <= 26) best.badge = Number(String(n.t).trim());
  }
  return rows;
}

export default DeskFlow;
