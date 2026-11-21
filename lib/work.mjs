// 作业：列表 → 打开 → 抓题（含字体解码）→ 回填 → 提交。
// 真实页面（2026-11 实测）要点：
//   * 列表地址的 enc 不能用课程 enc，必须先进课程页读 #workEnc（见 resolveWorkEnc）；
//   * 列表项是 li[onclick=goTask(this)]，URL 在裸 data 属性里；
//   * 题目容器是 div.questionLi（不是 .TiMu 外壳），选项是 div.answerBg；
//   * 提交按钮是 #submitFocus a.completeBtn，提交后可能弹图片验证码 #workVerifyImg。
import fs from 'node:fs';
import path from 'node:path';
import { sleep, truncate } from './util.mjs';
import { paths } from './paths.mjs';
import { ocrCaptcha } from './python.mjs';
import {
  workListUrl,
  resolveWorkEnc,
  pageIsCaptcha,
  solveCaptcha,
  resolveFontMap,
  decodeWith,
} from './chaoxing.mjs';
import {
  WORK_LIST,
  WORK_EXTRACT,
  WORK_STATE,
  WORK_SUBMIT,
  WORK_CAPTCHA_IMAGE,
  WORK_POP,
  FONT_HARVEST,
  workFillExpr,
  workVerifyFillExpr,
  workPopConfirmExpr,
} from './extract.mjs';

const DONE_STATUS = /已完成|已提交|已批改|待批阅/;

/** 打开课程作业列表（自动取 #workEnc） */
export async function listWorks(page, course, ctx = {}, opts = {}) {
  const log = ctx.log || (() => {});
  const attempts = Math.max(1, Number(opts.attempts) || 3);
  const waitMs = Number(opts.waitMs) || 12000;
  const polls = Math.max(1, Number(opts.polls) || 6);
  const pollMs = Number(opts.pollMs) || 2200;
  const out = [];
  let probe = null;
  let enc = '';
  let url = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    enc = await resolveWorkEnc(page, course, ctx, opts);
    if (!enc) {
      log({ ev: 'work-enc-missing', courseid: course.courseid });
      enc = String(course.enc || '');
    }
    url = workListUrl(course, enc);
    await page.goto(attempt ? url + '&t=' + Date.now() : url, { waitMs });
    if (await pageIsCaptcha(page)) {
      const solved = await solveCaptcha(page, ctx);
      if (!solved.ok) return { ok: false, reason: 'captcha', items: [], imagePath: solved.imagePath };
    }
    let raw = null;
    for (let w = 0; w < polls; w++) {
      raw = await page.evaluate(WORK_LIST).catch(() => null);
      if (raw && raw.items && raw.items.length) break;
      raw = null;
      await sleep(pollMs);
    }
    probe = raw;
    if (!raw) {
      log({ ev: 'work-list-retry', attempt, href: await page.evaluate('location.href').catch(() => '') });
      continue;
    }
    for (const it of raw.items) {
      out.push({
        title: it.title || '(未命名作业)',
        status: it.status || '',
        text: truncate(it.text || '', 200),
        url: it.url || '',
        canDo: !DONE_STATUS.test(it.status || ''),
      });
    }
    break;
  }
  const href = await page.evaluate('location.href').catch(() => url);
  if (!probe) {
    return {
      ok: false,
      reason: 'no-list',
      href,
      sample: probe ? truncate(probe.text || '', 600) : '',
      hint: '作业列表没解析出来：可能这门课没有作业，或页面结构与预期不同（需要看页面样本定位选择器）',
    };
  }
  return { ok: true, href, enc, items: out, sample: truncate(probe.text || '', 800) };
}

/** 打开某次作业 */
export async function openWork(page, { url, ctx = {} } = {}) {
  const log = ctx.log || (() => {});
  if (!url) throw new Error('作业地址为空，无法打开');
  const target = /^https?:\/\//i.test(url) ? url : 'https://mooc1.chaoxing.com' + url;
  await page.goto(target, { waitMs: 14000 });
  if (await pageIsCaptcha(page)) {
    const solved = await solveCaptcha(page, ctx);
    if (!solved.ok) return { ok: false, reason: 'captcha', imagePath: solved.imagePath };
  }
  log({ ev: 'work-open', href: truncate(await page.evaluate('location.href').catch(() => target), 120) });
  return { ok: true };
}

/** 抓作业题目（字体反爬一起解） */
export async function fetchWork(page, ctx = {}) {
  const log = ctx.log || (() => {});
  let raw = null;
  for (let w = 0; w < 8; w++) {
    raw = await page.evaluate(WORK_EXTRACT).catch(() => null);
    if (raw && raw.ok && raw.items && raw.items.length) break;
    await sleep(2500);
  }
  if (!raw || !raw.ok) {
    const probe = await page.evaluate(WORK_STATE).catch(() => null);
    return {
      ok: false,
      reason: 'no-questions',
      href: raw ? raw.url : '',
      sample: probe ? truncate(probe.text || '', 800) : '',
    };
  }
  let map = {};
  let md5 = '';
  try {
    const f = await page.evaluate(FONT_HARVEST).catch(() => null);
    if (f && f.font) {
      const r = await resolveFontMap(f.font, f.chars, ctx);
      map = r.map;
      md5 = r.md5;
    }
  } catch (e) {
    log({ ev: 'work-font-fail', err: truncate(e.message, 160) });
  }
  const decode = (s) => decodeWith(map, s);
  const items = (raw.items || []).map((it) => ({
    ...it,
    stem: decode(it.stem),
    opts: (it.opts || []).map((o) => ({ ...o, text: decode(o.text) })),
  }));
  return {
    ok: true,
    url: raw.url,
    items,
    md5,
    mapped: Object.keys(map).length,
    viewMode: !!(raw.items && raw.items[0] && raw.items[0].view),
    text: decode(raw.bodyText || '').slice(0, 400),
  };
}

export async function fillWork(page, plan, ctx = {}) {
  const log = ctx.log || (() => {});
  const p = (Array.isArray(plan) ? plan : []).map((a, idx) => {
    const q = { i: Number(a.i ?? idx) };
    const letters = a.letters || a.answer;
    if (Array.isArray(letters)) q.letters = letters.map((x) => String(x).trim().toUpperCase());
    else if (typeof letters === 'string') q.letters = letters.replace(/[^A-Za-z]/g, '').toUpperCase().split('').filter(Boolean);
    if (a.text !== undefined) q.text = String(a.text);
    return q;
  });
  const r = await page.evaluate(workFillExpr(p)).catch((e) => ({ ok: false, err: String(e.message || e) }));
  await sleep(1200);
  log({ ev: 'work-fill', clicked: r && r.clicked, filled: r && r.filled, missing: (r && r.missing) || [], err: r && r.err });
  return r;
}

/** 提交后弹图片验证码 → 取图 OCR → 填码提交 */
export async function solveWorkCaptcha(page, ctx = {}) {
  const log = ctx.log || (() => {});
  const img = await page.evaluate(WORK_CAPTCHA_IMAGE).catch((e) => ({ ok: false, err: String(e.message || e) }));
  if (!img || !img.ok) return { ok: false, reason: (img && img.reason) || 'no-image' };
  const b64 = String(img.data || '').split(',')[1] || '';
  const dir = paths().captchas;
  const file = path.join(dir, `work_${Date.now()}.png`);
  try {
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  } catch {
    /* ignore */
  }
  let text = '';
  try {
    const out = await ocrCaptcha(file, { python: ctx.python });
    text = out.text;
  } catch (e) {
    log({ ev: 'work-captcha-ocr-fail', err: truncate(e.message, 140) });
  }
  if (!/^[A-Za-z0-9]{3,6}$/.test(text)) return { ok: false, reason: 'bad-text', text, imagePath: file };
  const filled = await page.evaluate(workVerifyFillExpr(text)).catch((e) => ({ ok: false, err: String(e.message || e) }));
  log({ ev: 'work-captcha', text, filled: filled && filled.ok, submitted: filled && filled.submitted, imagePath: file });
  return { ok: !!(filled && filled.ok), text, imagePath: file, filled };
}

/**
 * 提交作业。真实流程（2026-11 抓 JS 确认）：
 *   点 #submitFocus a.completeBtn → submitValidate() → GET /work/validate
 *   → ready2Submit() 逐题校验 → workPop("确认提交？/您还有未做完的…", "提交", "取消", cb)
 *   → 点 #popok（文字是「提交」，不是「确定」！）→ submitCheckTimes()
 *   → 若 addTimes 超限弹图片验证码（#workVerifyImg），否则 500ms 后 submitWork() 发 ajax
 *   → 成功后：submitStep=1 跳 /work/prompt，否则 window.close() 关掉本页
 * 所以必须按 id 点 #popok，并且把「页面被关掉」也当成提交成功。
 */
export async function submitWork(page, ctx = {}) {
  const log = ctx.log || (() => {});
  const sub = await page.evaluate(WORK_SUBMIT).catch((e) => ({ ok: false, err: String(e.message || e) }));
  log({ ev: 'work-submit-click', sub });
  if (!sub || !sub.ok) return { ok: false, stage: 'submit', sub };
  await sleep(2500);
  let verifyTried = 0;
  let pops = 0;
  const started = Date.now();
  while (Date.now() - started < 90000) {
    let st = null;
    let closed = false;
    try {
      st = await page.evaluate(WORK_STATE);
    } catch (e) {
      closed = true; // 页面被 window.close() 关掉：submitStep 非 1 的成功路径
    }
    if (closed) return { ok: true, stage: 'closed', verifyTried, pops };
    if (st && st.success) return { ok: true, stage: 'done', state: st, verifyTried, pops };
    if (st && st.verify && verifyTried < 3) {
      verifyTried++;
      const r = await solveWorkCaptcha(page, ctx);
      log({ ev: 'work-verify', try: verifyTried, ok: r.ok, text: r.text || '', reason: r.reason || '' });
      await sleep(4000);
      continue;
    }
    if (st && st.verify && verifyTried >= 3) {
      return { ok: false, stage: 'verify', state: st, reason: 'work-captcha-failed', verifyTried, pops };
    }
    if (st && st.pop && st.pop.visible) {
      const popView = await page.evaluate(WORK_POP).catch(() => null);
      const r = await page.evaluate(workPopConfirmExpr()).catch(() => ({ ok: false }));
      pops++;
      log({ ev: 'work-pop-confirm', n: pops, tip: (popView && popView.text) || '', btn: (popView && popView.okText) || (r && r.text) || '', clicked: !!(r && r.ok) });
      await sleep(2500);
      continue;
    }
    await sleep(900);
  }
  const st = await page.evaluate(WORK_STATE).catch(() => null);
  return { ok: !!(st && st.success), stage: 'timeout', state: st, verifyTried, pops };
}

/** 只保存不提交（「暂时保存」saveWork），用于没把握时留草稿 */
export async function saveWorkDraft(page, ctx = {}) {
  const log = ctx.log || (() => {});
  const r = await page
    .evaluate(
      `(function () {
        function vis(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }
        var all = document.querySelectorAll('#submitFocus a, a, button');
        for (var i = 0; i < all.length; i++) {
          var t = String(all[i].innerText || '').replace(/\\s+/g, '');
          if (/^暂时保存$/.test(t) && vis(all[i])) { all[i].click(); return { ok: true, text: t }; }
        }
        return { ok: false, reason: 'no-save' };
      })()`,
    )
    .catch((e) => ({ ok: false, err: String(e.message || e) }));
  await sleep(3500);
  log({ ev: 'work-draft-save', ok: r && r.ok, reason: (r && r.reason) || (r && r.err) || '' });
  return r;
}

/** 统计仍未作答的题数（提交前判断能不能交；以隐藏域 #answer<qid> 为准，判断题也一样） */
export async function countBlanks(page) {
  const r = await page
    .evaluate(
      `(function () {
        var out = 0, byType = {}, ids = [];
        var qs = document.querySelectorAll('div.questionLi');
        for (var i = 0; i < qs.length; i++) {
          var q = qs[i];
          var type = String(q.getAttribute('typename') || '?');
          var hid = null;
          var inputs = q.querySelectorAll('input[type=hidden]');
          for (var k = 0; k < inputs.length; k++) {
            if (/^answer\\d+$/.test(String(inputs[k].id || ''))) { hid = inputs[k]; break; }
          }
          var val = hid ? String(hid.value || '').trim() : '';
          var ta = q.querySelector('textarea[id^=answer]');
          var taVal = ta ? String(ta.value || '').trim() : '';
          var edOk = false;
          try {
            var frames = q.querySelectorAll('iframe');
            for (var f = 0; f < frames.length; f++) {
              var body = frames[f].contentDocument && frames[f].contentDocument.body;
              if (body && !(frames[f].contentDocument.body.getAttribute('aria-hidden') === 'true') && (body.innerText || '').trim().length > 0) { edOk = true; break; }
            }
          } catch (e) {}
          var blank = val === '' && taVal === '' && !edOk;
          if (blank) { out++; byType[type] = (byType[type] || 0) + 1; if (ids.length < 10) ids.push((q.getAttribute('data') || q.id) + ':' + type); }
        }
        return { total: qs.length, blanks: out, byType: byType, ids: ids };
      })()`,
    )
    .catch((e) => ({ ok: false, err: String(e.message || e) }));
  return r || { total: 0, blanks: 0, byType: {}, ids: [] };
}
