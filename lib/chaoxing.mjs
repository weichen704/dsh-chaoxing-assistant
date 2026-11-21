// 学习通站点层：登录探测、课程发现、目录读取、卡片参数、验证码与字体解码。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sleep, truncate, validEnc, parseCourseParams, nowClock } from './util.mjs';
import { paths } from './paths.mjs';
import { ocrCaptcha, buildFontMap, decodeText } from './python.mjs';
import {
  PAGE_PROBE,
  COURSE_SCAN,
  CATALOG,
  CATALOG_TOTAL,
  CARD_ARGS,
  CAPTCHA_STATE,
  CAPTCHA_IMAGE,
  captchaFillExpr,
  FRAMES,
  vidNeedExpr,
  vidGeoExpr,
  vstateExpr,
  pdfGeoExpr,
  pdfMetricExpr,
  KILL,
  QUIZ_EXTRACT,
  WORK_ENC,
} from './extract.mjs';

export const SITE = {
  mooc: 'https://mooc1.chaoxing.com',
  moocans: 'https://mooc1.chaoxing.com/mooc-ans',
  mooc2: 'https://mooc2-ans.chaoxing.com',
  passport: 'https://passport2.chaoxing.com',
};

export const LOGIN_URL =
  'https://passport2.chaoxing.com/login?fid=&refer=' + encodeURIComponent('https://i.chaoxing.com/base');

/** 课程列表页候选（按命中率排序，逐个尝试） */
export const COURSE_PAGES = [
  'https://mooc2-ans.chaoxing.com/mooc2-ans/visit/interaction',
  'https://mooc1.chaoxing.com/visit/interaction',
  'https://i.chaoxing.com/base',
];

export function catUrl(course) {
  return (
    `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=${course.courseid}` +
    `&clazzid=${course.clazzid}&cpi=${course.cpi || ''}&enc=${course.enc || ''}&pageHeader=1`
  );
}

export function middleUrl(course) {
  return (
    `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${course.courseid}` +
    `&clazzid=${course.clazzid}&cpi=${course.cpi || ''}&ismooc2=1&v=2`
  );
}

/** 兼容旧版入口；2026-11 起 mooc2-ans 的 stucoursemiddle 返回 404，优先 mooc1 */
export function middleUrlLegacy(course) {
  return (
    `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stucoursemiddle?courseid=${course.courseid}` +
    `&clazzid=${course.clazzid}&vc=1&cpi=${course.cpi || ''}&ismooc2=1&v=2`
  );
}

export function cardsUrl(course, kid, num) {
  return (
    `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=${course.clazzid}` +
    `&courseid=${course.courseid}&knowledgeid=${kid}&num=${num}&ut=s&cpi=${course.cpi || ''}&v=20`
  );
}

export function workListUrl(course, enc) {
  return (
    `https://mooc1.chaoxing.com/mooc2/work/list?courseId=${course.courseid}&classId=${course.clazzid}` +
    `&cpi=${course.cpi || ''}&ut=s&enc=${enc || course.enc || ''}`
  );
}

/**
 * 作业列表的 enc 不能复用课程页的 enc（会提示“无权限的操作！”）。
 * 必须先进课程页（mooc1 stucoursemiddle）读隐藏域 #workEnc，每次加载都可能变化。
 */
export async function resolveWorkEnc(page, course, ctx = {}, opts = {}) {
  const log = ctx.log || (() => {});
  const waitMs = Number(opts.waitMs) || 9000;
  const polls = Math.max(1, Number(opts.polls) || 6);
  const pollMs = Number(opts.pollMs) || 1800;
  for (const url of [middleUrl(course), middleUrlLegacy(course)]) {
    try {
      await page.goto(url, { waitMs });
    } catch (e) {
      log({ ev: 'workenc-goto-fail', err: truncate((e && e.message) || e, 120) });
      continue;
    }
    for (let i = 0; i < polls; i++) {
      const r = await page.evaluate(WORK_ENC).catch(() => null);
      if (r && r.enc) {
        log({ ev: 'workenc', enc: r.enc, href: truncate(r.href || '', 90) });
        return r.enc;
      }
      await sleep(pollMs);
    }
    log({ ev: 'workenc-miss', href: truncate((await page.evaluate('location.href').catch(() => '')) || '', 90) });
  }
  return '';
}

export function isCaptchaHref(href) {
  return /antispiderShowVerify|antispider/i.test(String(href || ''));
}

// ---------------- 登录 ----------------

export async function probeLogin(page) {
  let p;
  try {
    p = await page.evaluate(PAGE_PROBE);
  } catch (e) {
    return { ok: false, href: '', onLoginPage: true, loggedIn: false, hint: String(e.message || e) };
  }
  const href = String(p.href || '');
  const text = String(p.text || '');
  const loginish =
    /passport\d?\.chaoxing\.com|passport2|login/i.test(href) || /扫码登录|手机号登录|新用户注册|登录学习通|账号登录/.test(text);
  const nick = (text.match(/(?:你好|欢迎你)[，,：:\s]*([^\n]{1,20})/) || [])[1] || '';
  return { ok: true, href, title: p.title || '', onLoginPage: loginish, loggedIn: !loginish, nick, hint: truncate(text, 160) };
}

export async function waitLogin(page, { timeoutMs = 180000, log = () => {} } = {}) {
  const t0 = Date.now();
  let lastHref = '';
  while (Date.now() - t0 < timeoutMs) {
    const st = await probeLogin(page);
    if (st.href !== lastHref) {
      lastHref = st.href;
      log({ ev: 'login-probe', href: truncate(st.href, 120), loggedIn: st.loggedIn });
    }
    if (st.loggedIn && !/passport/i.test(st.href)) {
      return { ok: true, href: st.href, nick: st.nick, waitedSec: Math.round((Date.now() - t0) / 1000) };
    }
    await sleep(3000);
  }
  const st = await probeLogin(page);
  return { ok: false, href: st.href, nick: st.nick, waitedSec: Math.round((Date.now() - t0) / 1000) };
}

// ---------------- 课程 ----------------

export async function discoverCourses(page, ctx = {}) {
  const log = ctx.log || (() => {});
  const merged = new Map();
  const pages = [];
  for (const url of COURSE_PAGES) {
    pages.push(url);
    try {
      await page.goto(url, { waitMs: 15000 });
    } catch (e) {
      log({ ev: 'course-page-fail', url, err: truncate(e.message, 120) });
      continue;
    }
    await sleep(1200);
    let scan = null;
    try {
      scan = await page.evaluate(COURSE_SCAN);
    } catch (e) {
      log({ ev: 'course-scan-fail', url, err: truncate(e.message, 120) });
    }
    if (!scan) continue;
    const st = await probeLogin(page).catch(() => null);
    for (const c of scan.courses || []) {
      const key = `${c.courseid}:${c.clazzid}`;
      const prev = merged.get(key);
      if (!prev) merged.set(key, { ...c, source: url, loggedIn: st ? st.loggedIn : undefined });
      else {
        if (!prev.cpi && c.cpi) prev.cpi = c.cpi;
        if (!prev.enc && c.enc) prev.enc = c.enc;
        if (!prev.title && c.title) prev.title = c.title;
      }
    }
    log({ ev: 'course-page', url: truncate(url, 80), found: (scan.courses || []).length, total: merged.size });
    // 已经拿到带 cpi 的课程就别再翻页了
    if (merged.size && Array.from(merged.values()).some((c) => c.cpi)) break;
  }
  const courses = Array.from(merged.values()).map((c) => ({
    courseid: c.courseid,
    clazzid: c.clazzid,
    cpi: c.cpi || '',
    enc: validEnc(c.enc) ? c.enc : '',
    title: (c.title || c.courseid).slice(0, 80),
  }));
  let login = null;
  try {
    login = await probeLogin(page);
  } catch {
    login = null;
  }
  return { courses, pagesTried: pages, login };
}

/**
 * 进入课程并解析出 cpi / enc。
 * 首选课程列表里已经带的参数；缺 enc 时走 stucoursemiddle 的 302 拿 enc。
 */
export async function resolveCourse(page, course, ctx = {}) {
  const log = ctx.log || (() => {});
  const c = { ...course };
  if (c.cpi && validEnc(c.enc)) return c;

  if (!c.cpi) {
    // 先回课程列表页把 cpi 补齐
    for (const url of COURSE_PAGES) {
      try {
        await page.goto(url, { waitMs: 12000 });
        const scan = await page.evaluate(COURSE_SCAN);
        const hit = (scan.courses || []).find((x) => x.courseid === c.courseid && x.clazzid === c.clazzid);
        if (hit && hit.cpi) {
          c.cpi = hit.cpi;
          if (!c.enc && validEnc(hit.enc)) c.enc = hit.enc;
          break;
        }
      } catch {
        /* 下一页 */
      }
    }
  }

  if (!validEnc(c.enc) || !c.cpi) {
    // 2026-11 起：mooc1 的 stucoursemiddle 会 302 到带 enc 的 studentcourse；旧 mooc2-ans 入口已 404
    for (const url of [middleUrl(c), middleUrlLegacy(c)]) {
      try {
        await page.goto(url, { waitMs: 9000 });
        const href = await page.evaluate('location.href').catch(() => '');
        const got = parseCourseParams(href);
        log({ ev: 'resolve-mid', href: truncate(href, 120), enc: got.enc ? 'yes' : 'no' });
        if (got.cpi) c.cpi = got.cpi;
        if (validEnc(got.enc)) {
          c.enc = got.enc;
          break;
        }
      } catch {
        /* 换下一个入口 */
      }
    }
  }
  if (!c.cpi) throw new Error(`课程 ${c.courseid} 拿不到 cpi，请先在浏览器里手动进入一次课程再重试`);
  // enc 在 2026-11 后已不是必需（studentcourse / cards 只用 cpi 也能打开），拿不到就继续，由目录读取阶段给出真实诊断
  if (!validEnc(c.enc)) {
    c.encMissing = true;
    log({ ev: 'resolve-noenc', course: c.courseid, hint: 'enc 缺失，直接用 cpi 访问目录' });
  }
  return c;
}

// ---------------- 目录 ----------------

export async function readCatalog(page, course, ctx = {}, opts = {}) {
  const log = ctx.log || (() => {});
  const url = catUrl(course);
  // fast 模式给"全自动发现"用：坏课程最多耗 ~20s，而不是 90s
  const fast = !!opts.fast;
  const attempts = Math.max(1, Number(opts.attempts) || (fast ? 2 : 5));
  const polls = Math.max(1, Number(opts.polls) || (fast ? 3 : 6));
  const pollMs = Math.max(200, Number(opts.pollMs) || (fast ? 1200 : 2500));
  const waitMs = Math.max(2000, Number(opts.waitMs) || (fast ? 7000 : 9000));
  for (let i = 0; i < attempts; i++) {
    await page.goto(url + '&t=' + Date.now(), { waitMs });
    for (let k = 0; k < polls; k++) {
      const href = await page.evaluate('location.href').catch(() => '');
      if (isCaptchaHref(href)) {
        await solveCaptcha(page, ctx);
        break;
      }
      const r = await page.evaluate(CATALOG).catch(() => null);
      if (r && r.length) {
        const total = r.reduce((a, row) => a + (Number(row[1]) || 0), 0);
        return r.map(([kid, points, name]) => ({ kid: String(kid), points: Number(points) || 0, name: String(name || '').slice(0, 80), total }));
      }
      await sleep(pollMs);
    }
    log({ ev: 'catalog-retry', try: i + 1, of: attempts, course: course.courseid });
  }
  const extra = await page
    .evaluate(CATALOG_TOTAL)
    .then((v) => `hiddenTotal=${v}`)
    .catch(() => '');
  throw new Error(`读取课程目录失败（${course.courseid}）。常见原因：enc 失效 / 未登录 / 该课程没有任务点。${extra}`);
}

// ---------------- 卡片（知识点） ----------------

/**
 * 打开 cards 页并读到 attachments。返回
 * { ok:true, count, list:[{type,jobid,passed,duration,name}] } 或 { ok:false, reason }
 */
/** 只读当前已打开卡片页的 window.mArg（不导航）；一张卡可能挂多个附件 */
export async function cardArgsOnPage(page, ctx = {}) {
  let att = await page.evaluate(CARD_ARGS).catch(() => null);
  for (let w = 0; w < 6 && (!att || !att.count); w++) {
    await sleep(1500);
    att = await page.evaluate(CARD_ARGS).catch(() => null);
  }
  return att || null;
}

export async function readCardArgs(page, course, kid, num = 0, ctx = {}) {  const log = ctx.log || (() => {});
  const url = cardsUrl(course, kid, num);
  let att = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(attempt === 0 ? url : url + '&t=' + Date.now(), { waitMs: attempt === 0 ? 11000 : 13000 });
    if (await pageIsCaptcha(page)) {
      const solved = await solveCaptcha(page, ctx);
      if (!solved.ok) return { ok: false, reason: 'captcha' };
    }
    att = await page.evaluate(CARD_ARGS).catch(() => null);
    // 附件可能晚一点渲染：但若 1.5s×2 后仍是空数组且没有 iframe，就认定这是“空节点”
    // （学习通里有些“学习目标”之类的信息页，目录算 1 个点但没有可做的东西），不再重复导航 3 次。
    if (att && att.count === 0) {
      for (let w = 0; w < 2 && att && att.count === 0; w++) {
        await sleep(1500);
        att = (await page.evaluate(CARD_ARGS).catch(() => null)) || att;
      }
      const fr = await page.evaluate(FRAMES).catch(() => null);
      if ((!fr || !fr.total) && att && att.count === 0) {
        log({ ev: 'node-empty', kid, num });
        return { ok: false, reason: 'empty' };
      }
      break;
    }
    for (let w = 0; w < 10 && att === null; w++) {
      await sleep(4000);
      att = await page.evaluate(CARD_ARGS).catch(() => null);
    }
    const frames = await page.evaluate(FRAMES).catch(() => null);
    if (att && frames && frames.total > 0) break;
    log({ ev: 'card-shell-retry', kid, attempt, hasArgs: !!att, frames: frames ? frames.total : -1 });
  }
  if (!att) return { ok: false, reason: 'noarg' };
  if (!att.count) return { ok: false, reason: 'empty' };
  return { ok: true, count: att.count, list: att.list };
}

export async function pageIsCaptcha(page) {
  try {
    const st = await page.evaluate(CAPTCHA_STATE);
    return !!(st && st.inCaptcha);
  } catch {
    return false;
  }
}

// ---------------- 验证码 ----------------

/**
 * 解 9010 验证码：取图 → ddddocr → 填码 → 提交，循环直到通过。
 * 失败时把图片保存到数据目录，返回 { ok:false, imagePath }，由上层决定人工兜底。
 */
export async function solveCaptcha(page, ctx = {}) {
  const log = ctx.log || (() => {});
  const tries = Number(ctx.captchaTries) || 8;
  const dir = paths().captchas;
  let lastImage = '';
  for (let i = 0; i < tries; i++) {
    let img;
    try {
      img = await page.evaluate(CAPTCHA_IMAGE);
    } catch (e) {
      img = { ok: false, err: String(e.message || e) };
    }
    if (!img || !img.ok) {
      if (!(await pageIsCaptcha(page))) return { ok: true, skipped: true, tries: i };
      await sleep(1500);
      continue;
    }
    const b64 = String(img.data || '').split(',')[1] || '';
    const file = path.join(dir, `cap_${Date.now()}_${i}.png`);
    try {
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    } catch {
      /* ignore */
    }
    lastImage = file;
    let text = '';
    try {
      const out = await ocrCaptcha(file, { python: ctx.python });
      text = out.text;
    } catch (e) {
      log({ ev: 'captcha-ocr-fail', try: i + 1, err: truncate(e.message, 140) });
    }
    if (!/^[A-Za-z0-9]{3,6}$/.test(text)) {
      log({ ev: 'captcha-bad-text', try: i + 1, text });
      await sleep(800);
      continue;
    }
    if (ctx.onCaptchaText) await ctx.onCaptchaText(text, file);
    const filled = await page.evaluate(captchaFillExpr(text)).catch((e) => ({ ok: false, err: e.message }));
    await sleep(4500);
    const still = await pageIsCaptcha(page);
    const nowText = await page.evaluate(CAPTCHA_STATE).catch(() => null);
    log({ ev: 'captcha', try: i + 1, text, filled: filled && filled.ok, pass: !still, href: nowText ? truncate(nowText.href, 90) : '' });
    if (!still) return { ok: true, tries: i + 1, text, imagePath: file };
  }
  return { ok: false, tries, imagePath: lastImage, reason: 'captcha-failed' };
}

// ---------------- 字体反爬 ----------------

/** base64 字体 → 映射表（磁盘按 md5 缓存，命中则不跑 OCR） */
export async function resolveFontMap(base64, chars, ctx = {}) {
  const log = ctx.log || (() => {});
  const raw = String(base64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!raw) return { map: {}, md5: '', cached: false };
  const buf = Buffer.from(raw, 'base64');
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  ctx.fontMaps = ctx.fontMaps || new Map();
  if (ctx.fontMaps.has(md5)) return { map: ctx.fontMaps.get(md5), md5, cached: true };

  const dir = paths().fonts;
  const ttf = path.join(dir, `${md5}.ttf`);
  const out = path.join(dir, `${md5}.json`);
  try {
    if (!fs.existsSync(ttf)) fs.writeFileSync(ttf, buf);
  } catch (e) {
    throw new Error(`字体文件写入失败：${e.message}`);
  }
  const t0 = Date.now();
  const r = await buildFontMap(ttf, out, chars, { python: ctx.python });
  ctx.fontMaps.set(md5, r.map);
  log({ ev: 'font-map', md5, chars: (chars || '').length, mapped: Object.keys(r.map).length, cached: !!r.cached, ms: Date.now() - t0 });
  return { map: r.map, md5, cached: !!r.cached };
}

export function decodeWith(map, text) {
  return decodeText(text, map);
}

// ---------------- 其它 ----------------

export function dumpFrames() {
  return FRAMES;
}

export { vidNeedExpr, vidGeoExpr, vstateExpr, pdfGeoExpr, pdfMetricExpr, KILL, QUIZ_EXTRACT };
