// 桌面客户端流程：课程 → 章节 → 任务点 → 文档滚动 / 视频播放（基于 WinRT OCR + UIA 坐标点击）
import { sleep } from './util.mjs';

const CONTENT = { x: 190, y: 90, w: 1350, h: 1010 }; // 课程/任务内容区（不含左侧导航）
const CHAPTER_PANEL = { x: 540, y: 240, w: 700, h: 860 }; // 课程页/章节页里的目录列表区域
const TASK_PANEL = { x: 540, y: 180, w: 1000, h: 900 }; // 任务页正文区域
const FOOTER = { x: 540, y: 1000, w: 1000, h: 120 };

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
   *  （实测读作业列表底部分页时读到了宿主聊天窗口的文字） */
  clip(box) {
    const r = (this.d && this.d.rect) || {};
    const W = Number(r.w) > 600 ? Number(r.w) : 0;
    const H = Number(r.h) > 400 ? Number(r.h) : 0;
    // w/h 给 0 表示「整个窗口」（见 clickText 的全窗兜底）
    if (W && H && (!(box.w > 0) || !(box.h > 0))) return { x: 0, y: 0, w: W, h: H };
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    let w = Math.round(box.w);
    let h = Math.round(box.h);
    if (W && H) {
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
    let items = this.d.uia();
    const rx = this.d.rect?.x || 0;
    if (leftOnly) items = items.filter((x) => x.x - rx < 280);
    const it = items.find((x) => re.test(x.n || ''));
    if (!it) return { ok: false, err: 'uia-not-found', names: items.slice(0, 12).map((x) => x.n) };
    const r = this.d.rect || { x: 0, y: 0 };
    await this.d.actions([{ cmd: 'click', x: Math.round(it.x + it.w / 2 - r.x), y: Math.round(it.y + it.h / 2 - r.y) }]);
    return { ok: true, hit: it.n };
  }

  /** 回到「我的课程」列表：任务页要先点左上「返回课程」，再点左侧一级导航「课程」 */
  async goCourses() {
    return this.t('go-courses', async () => {
      const navBox = { x: 0, y: 110, w: 210, h: 760 }; // 左侧一级导航（避开顶部同名标签页）
      const listBox = { x: 140, y: 150, w: 1500, h: 620 };
      const topBar = { x: 170, y: 100, w: 460, h: 95 }; // 任务页左上「返回课程」
      // 注意：首页里也有「我的课程」板块，光看这四个字会误判已在课程页 → 必须看到课程页专属元素
      const onList = async () => {
        const items = await this.ocr(listBox, 1);
        return items.some((t) => /我学的课|新建文件夹|任务点进度/.test(t.t)) ? items : null;
      };
      const clickNav = async (re) => {
        const items = await this.ocr(navBox, 1);
        const it = items.find((i) => re.test(i.t || ''));
        if (!it) return false;
        await this.clickItem(it);
        await sleep(1600);
        return true;
      };
      // 客户端是「标签页」模型：课程页开着时，左侧一级导航「课程」点了不切页（它已是激活态），
      // 必须点顶部标签栏里的「课程」标签才能回到课程列表。
      const clickTab = async (re) => {
        const tabs = await this.ocr({ x: 180, y: 55, w: 1300, h: 80 }, 1);
        const it = tabs.find((i) => re.test(String(i.t || '').replace(/\s+/g, '')));
        if (!it) return false;
        await this.clickItem(it);
        await sleep(1500);
        return true;
      };
      let items = await onList();
      if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: 0 };
      if (await clickTab(/^课程$/)) {
        items = await onList();
        if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: 0, via: 'tab' };
      }
      for (let i = 0; i < 2; i++) {
        await this.d.actions([{ cmd: 'key', seq: '{ESC}' }, { cmd: 'sleep', ms: 200 }]);
        // 1) 任务页左上角「返回课程」（shell 渲染，UIA 不一定看得到 → OCR 点击）
        const tb = await this.ocr(topBar, 1);
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
          items = await onList();
          if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: i + 1, via: 'nav' };
          if (seq.source === '^首页$') {
            await clickNav(/^课程$/);
            items = await onList();
            if (items) return { ok: true, texts: items.map((t) => t.t).slice(0, 6), tries: i + 1, via: 'home-nav' };
          }
        }
      }
      const all = await this.ocr({ x: 0, y: 0, w: 0, h: 0 }, 1);
      return { ok: false, texts: all.map((t) => t.t).slice(0, 8) };
    });
  }

  /** 打开课程（当前在课程列表页）：先看当前屏，再回顶部逐屏向下找课程卡片 */
  /** 点完课程卡片后确认真的进了课程页（左侧出现 章节/任务 等导航，或正文出现任务点进度） */
  /** 课程卡片可能先停在「课程门户」（有「进入课程」按钮）→ 点进去再验证 */
  async _enterCourse(title) {
    let v = await this._verifyCourse(title);
    if (v.ok) return v;
    const page = await this.ocr({ x: 200, y: 100, w: 1450, h: 900 }, 1);
    const btn = this.find(page, /进入课程|进入学习|继续学习/);
    if (btn) {
      await this.clickItem(btn);
      await sleep(3000);
      v = await this._verifyCourse(title);
      if (v.ok) return { ok: true, via: 'portal' };
    }
    return v;
  }
  async _verifyCourse(title) {
    const nav = await this.ocr({ x: 60, y: 120, w: 280, h: 840 }, 1);
    const navText = nav.map((i) => i.t).join(' ');
    const head = await this.ocr({ x: 200, y: 240, w: 1200, h: 400 }, 1);
    const headText = head.map((i) => i.t).join(' ');
    const inCourse = /章节|任务|作业|考试|资料/.test(navText) || /已完成任务点|目录|课程门户/.test(headText);
    if (!inCourse) return { ok: false, err: 'not-course-page', navText: navText.slice(0, 60) };
    return { ok: true };
  }
  async openCourse(title) {
    return this.t('open-course', async () => {
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
      const matchAll = (items) =>
        items.filter((i) => {
          const t = normName(i.t);
          if (!t || t.length < 2) return false;
          return t.includes(want) || want.includes(t) || (t.length >= 4 && sim(t, want) >= 0.75);
        });
      // 「最近使用」在最上面，点它会进「通知详情」之类的页面而不是课程主页 → 优先点下方「我的课程」网格里的
      const match = (items) => {
        const all = matchAll(items);
        if (!all.length) return null;
        const lower = all.filter((i) => i.y >= 250);
        return (lower.length ? lower : all).sort((a, b) => a.y - b.y)[0];
      };
      // 当前屏可能已经能看到目标课程（上一轮操作留下的位置）
      let items = await this.ocr(grid, 1);
      let hit = match(items);
      if (hit) {
        await this.clickItem(hit);
        await sleep(2600);
        const v = await this._enterCourse(title);
        return v.ok ? { ok: true, title, hit: hit.t, screen: -1 } : { ok: false, err: v.err, hit: hit.t, screen: -1 };
      }
      // 回顶部
      const top = this.find(await this.ocr({ x: 1450, y: 860, w: 370, h: 280 }, 1), /返回顶部/);
      if (top) await this.clickItem(top);
      await sleep(500);
      for (let i = 0; i < 5; i++) await focus('{PGUP}');
      await sleep(600);
      let last = '';
      for (let screen = 0; screen < 8; screen++) {
        items = await this.ocr(grid, 1);
        hit = match(items);
        if (hit) {
          await this.clickItem(hit);
          await sleep(2600);
          const v = await this._enterCourse(title);
          return v.ok ? { ok: true, title, hit: hit.t, screen } : { ok: false, err: v.err, hit: hit.t, screen };
        }
        const h = await this.hash(grid);
        if (h && h === last) break; // 到底了
        last = h;
        await focus('{PGDN}');
        await sleep(650);
      }
      items = await this.ocr(grid, 1);
      return { ok: false, err: 'course-not-found', texts: items.map((i) => i.t).slice(0, 40) };
    });
  }

  /** 读目录列表（章节页/任务页都可能已经开着，先 OCR 再决定是否点导航） */
  async readChapters() {
    const boxes = [
      CHAPTER_PANEL,
      { x: 500, y: 220, w: 760, h: 900 },
      { x: 130, y: 130, w: 720, h: 900 },
      // 任务页的「目录」面板常在右侧（影视鉴赏），窄栏也要试
      { x: 1400, y: 200, w: 420, h: 900 },
      { x: 1215, y: 200, w: 600, h: 920 },
    ];
    for (const box of boxes) {
      const items = await this.ocr(box, 1);
      const chapters = chaptersFrom(items);
      if (chapters.length >= 2) return { ok: true, chapters, box };
    }
    return { ok: false, chapters: [] };
  }

  /** 进入「章节」页并返回章节条目列表（OCR 左栏） */
  async chapters() {
    return this.t('chapters', async () => {
      // 有些课程打开就是「章节」页（客户端记住上次标签）→ 先试着直接读
      let cur = await this.readChapters();
      if (cur.ok) return { ok: true, count: cur.chapters.length, chapters: cur.chapters.map((c) => ({ t: c.t, x: c.x, y: c.y })), via: 'already' };
      // 课程主页的「章节」在内容区左侧竖排导航里（webview 内容，UIA 看不到）→ 先 OCR 点击
      const navBox = { x: 120, y: 130, w: 260, h: 820 };
      let r = { ok: false };
      // 有的课打开后内容区还在加载，导航点不到 → 重试几轮
      for (let round = 0; round < 3 && !r.ok; round++) {
        if (round) await sleep(1800);
        const nv = await this.openNav('章节');
        r = { ok: nv.ok, t: nv.t, via: nv.via };
        if (r.ok) break;
      }
      await sleep(1700);
      cur = await this.readChapters();
      if (!cur.ok) {
        // 兜底 1：目录区可能在别的滚动位置 → 全窗 OCR 找编号行
        const all = await this.ocr(CONTENT, 1);
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
          const rows2 = chaptersFrom(await this.ocr(CONTENT, 1));
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
      return { ok: true, count: cur.chapters.length, chapters: cur.chapters.map((c) => ({ t: c.t, x: c.x, y: c.y })), via: r.ok ? 'nav' : 'retry' };
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
      const tabs = await this.ocr({ x: 240, y: 55, w: 1200, h: 95 }, 1);
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
      // 聚焦正文区（点一下就够，之后键盘事件会进 webview）
      await this.d.actions([{ cmd: 'click', x: box.x + box.w / 2, y: box.y + box.h / 2 }, { cmd: 'sleep', ms: 250 }]);
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
      await this.d.actions([{ cmd: 'click', x: box.x + box.w / 2, y: box.y + box.h / 2 }, { cmd: 'sleep', ms: 1500 }]);
      const t0 = Date.now();
      let last = '';
      let same = 0;
      let sec = 0;
      let timeText = '';
      while ((Date.now() - t0) / 1000 < maxSec) {
        await sleep(6000);
        const p = await this.d.actions([{ cmd: 'ocr', x: box.x, y: box.y, w: box.w, h: box.h }], 60000);
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
    const tabs = await this.ocr({ x: 240, y: 55, w: 1200, h: 95 }, 1);
    return /学生学习页面|章节详情/.test(tabs.map((i) => i.t).join(' '));
  }

  /** 任务页 → 点左上「返回课程」回到课程章节页 */
  async backToCourse() {
    for (let i = 0; i < 3; i++) {
      const tb = await this.ocr({ x: 170, y: 100, w: 460, h: 95 }, 1);
      const b = tb.find((x) => /返回课程|返回/.test(x.t || ''));
      if (b) {
        await this.clickItem(b);
        await sleep(2200);
        const cur = await this.readChapters();
        if (cur.ok) return true;
      }
      await sleep(700);
    }
    return false;
  }

  /** 课程章节列表翻一屏：点列表区右下空白处聚焦 + PGDN，用像素哈希判断是否真的动了 */
  async scrollList(box = { x: 500, y: 220, w: 760, h: 900 }) {
    const h0 = await this.hash(box);
    // 优先用 computer-use 发真实滚轮（把鼠标放进列表中部滚动，不点击，避免误点开行）
    if (this.d && typeof this.d.wheelInRect === 'function') {
      try {
        await this.d.wheelInRect(box, { direction: 'down', amount: 5, rx: Math.round(box.w - 60), ry: Math.round(box.h / 2) });
        await new Promise((r) => setTimeout(r, 700));
        const h1 = await this.hash(box);
        if (h0 !== h1) return true;
      } catch {
        /* 滚轮不可用就走老办法 */
      }
    }
    await this.d.actions([
      // 点列表区右上角空白处聚焦（点在行上会误打开作业/章节）
      { cmd: 'click', x: box.x + box.w - 20, y: box.y + 12 },
      { cmd: 'sleep', ms: 200 },
      { cmd: 'key', seq: '{PGDN}' },
      { cmd: 'sleep', ms: 900 },
    ]);
    const h2 = await this.hash(box);
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
      if (rows.length >= 2) return { ok: true, rows, box };
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
        // 点面板底部空白（最后一行下方 30px 处），避免误点条目
        const rows = chaptersFrom(items);
        const last = rows[rows.length - 1];
        await this.d.actions([
          { cmd: 'click', x: Math.round(last.x), y: Math.round(Math.min(b.y + b.h - 20, last.y + 70)) },
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

  async openNav(label) {
    const re = new RegExp(`^${label}$`);
    for (const box of DeskFlow.NAV_BOXES) {
      for (const scale of [2, 1]) {
        const items = await this.ocr(box, scale);
        const hit = this._labelHit(items, label);
        if (hit) {
          await this.clickItem(hit);
          await sleep(1900);
          return { ok: true, via: 'ocr', label, t: hit.t };
        }
      }
    }
    const u = await this.clickUia(re, { leftOnly: true });
    if (u && u.ok) {
      await sleep(1900);
      return { ok: true, via: 'uia', label, t: u.hit };
    }
    return { ok: false, err: 'nav-not-found', label };
  }

  /** 课程页 → 作业列表（点导航后等列表真的出来：顶部筛选行是作业页专属） */
  async goWorks() {
    this._worksFocus = false;
    this._worksPage = 1;
    const nav = await this.openNav('作业');
    if (!nav.ok) return nav;
    const box = this.worksBox();
    for (let i = 0; i < 4; i++) {
      const head = await this.ocr({ x: box.x, y: box.y - 40, w: Math.round(box.w * 0.72), h: 300 }, 1);
      const txt = head.map((x) => String(x.t || '')).join('');
      if (/筛选|未完成|已完成/.test(txt)) return { ...nav, ready: true };
      await sleep(900);
    }
    return { ...nav, ready: false };
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
    const titleRows = (lines) => lines.filter((l) => isTitle(l.t) && l.x > box.x + 90 && l.x < box.x + 560);
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
    return { ok: list.length > 0, list, box, pages: this._worksPage || 1 };
  }

  /** 当前页是否作业作答页：返回 {tab, head, done, isWork}（done=页头已有成绩/待批阅等结果标记） */
  async workCtx() {
    const tabs = await this.ocr({ x: 180, y: 55, w: 1300, h: 80 }, 1);
    const tab = tabs.map((i) => String(i.t || '')).join('').replace(/\s+/g, '');
    const head = await this.ocr({ x: 300, y: 105, w: 1450, h: 265 }, 1);
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
    const tabs = await this.ocr({ x: 180, y: 55, w: 1300, h: 80 }, 1);
    const names = tabs.map((i) => String(i.t || '').replace(/\s+/g, '')).filter(Boolean);
    if (names.length >= 2 && names.some((t) => /作业/.test(t))) {
      await this.d.actions([{ cmd: 'key', seq: '^w' }, { cmd: 'sleep', ms: 2200 }]);
      this._worksFocus = false;
      return { ok: true, via: 'ctrl-w' };
    }
    const nav = await this.goWorks();
    return { ok: nav.ok, via: 'nav' };
  }

  /** 是否已显示「任务点已完成」 */
  async taskDone() {
    const items = await this.ocr({ x: 520, y: 230, w: 900, h: 360 }, 1);
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
  const rows = (items || [])
    .filter((i) => isRow(normNum(i.t)))
    .map((i) => ({ t: i.t, x: i.x, y: i.y, w: i.w, h: i.h, badge: 0 }));
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
