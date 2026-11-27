// 章节测验：抓题（含反爬字体解码）→ 回填 → 提交 → 校验。
import { sleep, truncate } from './util.mjs';
import {
  QUIZ_EXTRACT,
  QUIZ_STATE,
  FONT_HARVEST,
  quizFillExpr,
  quizReeditFillExpr,
  QUIZ_SUBMIT,
  QUIZ_CONFIRM,
  QUIZ_BLANK_COUNT,
} from './extract.mjs';
import { cardsUrl, pageIsCaptcha, solveCaptcha, resolveFontMap, decodeWith } from './chaoxing.mjs';

export function quizAnswerKey(course, kid, num) {
  return `${course.courseid}:${kid}:${num}`;
}

/** 校验/规整一份答案计划：[{i,letters?:['A'],text?:'...'}] */
export function normalizePlan(answers) {
  if (!Array.isArray(answers)) return [];
  return answers.map((a, idx) => {
    const q = { i: Number(a.i ?? a.index ?? idx) };
    const letters = a.letters || a.answer || a.answers || a.letter;
    if (Array.isArray(letters)) q.letters = letters.map((x) => String(x).trim().toUpperCase()).filter(Boolean);
    else if (typeof letters === 'string' && letters.trim()) q.letters = letters.replace(/[^A-Za-z]/g, '').toUpperCase().split('');
    // 选项文字：页面每次打开都会打乱选项顺序，按文字匹配比按字母可靠
    const texts = a.texts ?? a.optionTexts;
    if (Array.isArray(texts) && texts.length) q.texts = texts.map((x) => String(x ?? ''));
    const text = a.text ?? a.fill ?? a.value;
    if (text !== undefined && text !== null && String(text).trim() !== '') q.text = String(text);
    return q;
  });
}

/**
 * 打开测验页并抓题。返回
 * { ok, items:[{i,stem,opts,type,inputs,correct,graded}], md5, mapped, alreadySubmitted }
 */
export async function fetchQuiz(page, course, kid, num = 0, ctx = {}) {
  const log = ctx.log || (() => {});
  const url = cardsUrl(course, kid, num);
  let raw = null;
  for (let attempt = 0; attempt < 3 && !raw; attempt++) {
    await page.goto(url + (attempt ? '&t=' + Date.now() : ''), { waitMs: 13000 });
    if (await pageIsCaptcha(page)) {
      const solved = await solveCaptcha(page, ctx);
      if (!solved.ok) return { ok: false, reason: 'captcha', imagePath: solved.imagePath };
    }
    // 等题目框架真正渲染：先用轻量探针轮询，命中后只跑一次完整抓取
    // （原来每 2s 重跑一次 QUIZ_EXTRACT，含字体表 base64 + 多次整页 innerText，白烧 CPU）
    for (let w = 0; w < 32; w++) {
      const n = await page.evaluate(`(function(){try{return document.querySelectorAll('.TiMu').length;}catch(e){return 0;}})()`).catch(() => 0);
      if (n > 0) {
        raw = await page.evaluate(QUIZ_EXTRACT).catch(() => null);
        if (raw && raw.ok && raw.items && raw.items.length) break;
        raw = null;
      }
      await sleep(500);
    }
    if (!raw) log({ ev: 'quiz-retry', kid, num, attempt });
  }
  if (!raw) return { ok: false, reason: 'no-quiz' };
  return finalizeQuiz(raw, ctx, kid);
}

/** 把题目解析结果转成对外的 items（含字体解码） */
async function finalizeQuiz(raw, ctx = {}, kid = '') {
  const log = ctx.log || (() => {});
  let map = {};
  let md5 = '';
  let mapped = 0;
  if (raw.font) {
    try {
      const r = await resolveFontMap(raw.font, raw.chars, ctx);
      map = r.map;
      md5 = r.md5;
      mapped = Object.keys(map).length;
    } catch (e) {
      log({ ev: 'quiz-font-fail', kid, err: truncate(e.message, 160) });
    }
  }
  const decode = (s) => decodeWith(map, s);
  const items = (raw.items || []).map((it) => ({
    ...it,
    stem: decode(it.stem),
    opts: (it.opts || []).map((o) => ({ ...o, text: decode(o.text) })),
  }));
  const graded = items.filter((it) => it.graded).length;
  // 只要页面出现「我的答案/得分/待批阅/正确答案」这类回显，就说明这份测验已经交过（可能还没批完）
  const alreadySubmitted = items.length > 0 && (!!raw.attempted || graded >= items.length);
  return {
    ok: true,
    url: raw.url,
    items,
    md5,
    mapped,
    fontFound: !!raw.font,
    alreadySubmitted,
    attempted: !!raw.attempted,
    graded,
    bodySample: decode(raw.bodyTextSample || '').slice(0, 300),
  };
}

/** 当前卡片页里有几个 modules/work 框架（一张卡可能挂多个测验） */
export async function quizFrameCount(page) {
  const n = await page
    .evaluate(
      `(function(){ var all=document.querySelectorAll('iframe'); var c=0; for (var i=0;i<all.length;i++){ if (String(all[i].src||'').indexOf('modules/work')>=0) c++; } return c; })()`,
    )
    .catch(() => 0);
  return Number(n) || 0;
}

/** 把 window.__cxRoot 指向第 frameIdx 个 work 框架，后续抓题/回填/提交都只作用在这个测验上 */
export async function setQuizRoot(page, frameIdx = 0) {
  const ok = await page
    .evaluate(
      `(function(){ var all=document.querySelectorAll('iframe'); var w=[]; for (var i=0;i<all.length;i++){ if (String(all[i].src||'').indexOf('modules/work')>=0) w.push(all[i]); } var f=w[${Number(frameIdx) || 0}]; window.__cxRoot = f && f.contentDocument ? f.contentDocument : null; return !!window.__cxRoot; })()`,
    )
    .catch(() => false);
  return !!ok;
}

/** 已经在卡片页上（且 __cxRoot 已设）时抓当前这一个测验的题目 */
export async function fetchQuizHere(page, ctx = {}, kid = '') {
  const log = ctx.log || (() => {});
  let raw = null;
  for (let w = 0; w < 8; w++) {
    raw = await page.evaluate(QUIZ_EXTRACT).catch(() => null);
    if (raw && raw.ok && raw.items && raw.items.length) break;
    raw = null;
    await sleep(1200);
  }
  if (!raw) {
    log({ ev: 'quiz-here-fail', kid });
    return { ok: false, reason: 'no-quiz' };
  }
  return finalizeQuiz(raw, ctx, kid);
}

/** 把答案回填到测验页（必须已经停在该测验页上） */
export async function fillQuiz(page, plan, ctx = {}) {  const log = ctx.log || (() => {});
  const p = normalizePlan(plan);
  const r = await page.evaluate(quizFillExpr(p)).catch((e) => ({ ok: false, err: String(e.message || e) }));
  await sleep(1200);
  log({ ev: 'quiz-fill', plan: p.length, clicked: r && r.clicked, filled: r && r.filled, missing: (r && r.missing) || [], err: r && r.err });
  return r;
}

/** 点提交 + 二次确认 + 读结果 */
export async function submitQuiz(page, ctx = {}) {
  const log = ctx.log || (() => {});
  const sub = await page.evaluate(QUIZ_SUBMIT).catch((e) => ({ ok: false, err: String(e.message || e) }));
  log({ ev: 'quiz-submit', sub });
  if (!sub || !sub.ok) return { ok: false, stage: 'submit', sub };
  let confirmed = null;
  for (let i = 0; i < 4; i++) {
    const c = await page.evaluate(QUIZ_CONFIRM).catch(() => null);
    if (c && c.ok) {
      confirmed = c;
      break;
    }
    await sleep(1500);
  }
  // 确认后页面可能跳 /work/prompt、直接 window.close()，或停在页面显示"提交成功"
  const OK_TEXT = /(提交成功|已经提交|作业已提交|提交完成|等待老师批阅|待批阅|已批阅|本次得分|您的成绩)/;
  let state = null;
  let navUrl = '';
  for (let i = 0; i < 14; i++) {
    const probe = await page
      .evaluate(
        `(function(){try{return {url:location.href, text:String(document.body?document.body.innerText:'').slice(0,400)};}catch(e){return {url:'',text:''};}})()`,
      )
      .catch(() => null);
    if (!probe) {
      // evaluate 失败也可能只是 CDP 超时：再用轻量探针确认页面真的没了，才当成「已关闭」
      const alive = await page.evaluate('1').then(() => true).catch(() => false);
      if (!alive) {
        navUrl = 'closed';
        break;
      }
      await sleep(1200);
      continue;
    }
    navUrl = probe.url || '';
    if (/\/work\/prompt|\/work\/view|workSubmitSuccess/.test(navUrl) || OK_TEXT.test(probe.text || '')) {
      state = await page.evaluate(QUIZ_STATE).catch(() => null);
      break;
    }
    state = await page.evaluate(QUIZ_STATE).catch(() => null);
    if (state && state.submitted) break;
    await sleep(1200);
  }
  const cap = await pageIsCaptcha(page).catch(() => false);
  // 只有「确认弹窗被点掉」不算提交成功：必须读到已提交/已判分/成功文案/页面跳走。
  // 否则会把一次没真正提交的作答记成 success，导致统计虚高、也不会再补交。
  const ok = !!(
    (state && (state.submitted || (state.total > 0 && state.graded >= state.total))) ||
    navUrl === 'closed' ||
    /\/work\/prompt|\/work\/view|workSubmitSuccess/.test(navUrl)
  );
  log({ ev: 'quiz-result', confirmed, ok, navUrl, state: state && { total: state.total, graded: state.graded, submitted: state.submitted } });
  return { ok, stage: 'done', confirmed, submitted: ok, state, captcha: cap, navUrl };
}

/** 提交前数空题：数不清时返回 {ok:false}，调用方必须当成「可能有空题」处理 */
export async function countQuizBlanks(page) {
  const r = await page.evaluate(QUIZ_BLANK_COUNT).catch((e) => ({ ok: false, err: String((e && e.message) || e) }));
  return r || { ok: false, err: 'no-result' };
}

/** 交卷前发现有空白题时，尽量先点「保存」存草稿（点不到就如实返回，绝不偷偷改成交卷） */
export async function saveQuizDraft(page, ctx = {}) {
  const log = ctx.log || (() => {});
  const r = await page
    .evaluate(
      `(function () {
        var target = null;
        function walk(d, depth) {
          if (target || depth > 4) return;
          try { if (d.querySelectorAll('.TiMu').length) { target = d; return; } } catch (e) {}
          try { var fs = d.querySelectorAll('iframe'); for (var i = 0; i < fs.length; i++) { try { if (fs[i].contentDocument) walk(fs[i].contentDocument, depth + 1); } catch (e) {} } } catch (e) {}
        }
        walk(window.__cxRoot || document, 0);
        if (!target) return { ok: false, reason: 'no-quiz' };
        var all = target.querySelectorAll('a,button,input[type=button],span');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          var t = String(el.innerText || el.value || '').replace(/\\s+/g, '');
          if ((t === '保存' || t === '暂存' || t === '保存草稿' || t === '保存答案') && el.offsetParent !== null) {
            el.click();
            return { ok: true, label: t };
          }
        }
        return { ok: false, reason: 'no-save-button' };
      })()`,
    )
    .catch((e) => ({ ok: false, err: String((e && e.message) || e) }));
  await sleep(1500);
  log({ ev: 'quiz-draft-save', ok: !!(r && r.ok), reason: (r && (r.reason || r.err)) || '' });
  return r;
}

/** 提交后等待判分（章节测验一般立即判分） */
export async function waitQuizGraded(page, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  let state = null;
  while (Date.now() - t0 < timeoutMs) {
    state = await page.evaluate(QUIZ_STATE).catch(() => null);
    if (state && state.ok && state.graded >= state.total && state.total > 0) return { ok: true, state };
    await sleep(2000);
  }
  return { ok: false, state };
}

/** 从已判分的测验页里读回正确答案（用作答案缓存/自查） */
export function extractCorrect(items) {
  return items
    .map((it) => ({ i: it.i, stem: it.stem, correct: it.correct || [] }))
    .filter((x) => x.correct.length);
}

export async function harvestFont(page, ctx = {}) {
  const raw = await page.evaluate(FONT_HARVEST).catch(() => null);
  if (!raw || !raw.font) return { map: {}, md5: '' };
  const r = await resolveFontMap(raw.font, raw.chars, ctx);
  return r;
}

/**
 * 已交但没过的测验会显示「修改答案」按钮（span.reediter onclick=location.href="...reEdit=2..."），
 * 拿它的重做页地址。
 */
export async function quizReeditHref(page) {
  const href = await page
    .evaluate(`(function () {
      var root = window.__cxRoot || document;
      function walk(d, depth) {
        if (depth > 4) return null;
        try {
          var el = d.querySelector('span.reediter, a.reediter, .reediter');
          if (el) {
            var oc = String((el.getAttribute && el.getAttribute('onclick')) || '');
            var m = oc.match(/location\\.href\\s*=\\s*["']([^"']+)/);
            if (m) return m[1];
            // 常见写法 onclick="reediter();"，真正地址在函数体里（可能由多段字符串拼成）
            var fn = oc.match(/^\\s*([A-Za-z_$][\\w$]*)\\s*\\(/);
            var f = fn && d.defaultView ? d.defaultView[fn[1]] : null;
            if (typeof f === 'function') {
              var src = String(f);
              var at = src.indexOf('location.href');
              if (at >= 0) {
                var tail = src.slice(at);
                var re = /["']([^"']*)["']/g;
                var parts = [];
                var mm;
                while ((mm = re.exec(tail))) parts.push(mm[1]);
                var joined = parts.join('');
                if (joined) return joined;
              }
            }
          }
        } catch (e) {}
        try {
          var fs = d.querySelectorAll('iframe');
          for (var i = 0; i < fs.length; i++) {
            try { var r = fs[i].contentDocument && walk(fs[i].contentDocument, depth + 1); if (r) return r; } catch (e) {}
          }
        } catch (e) {}
        return null;
      }
      return walk(root, 0);
    })()`)
    .catch(() => null);
  return href || '';
}

/** 抓当前页面（不做 302 跳转）的题目；用于「修改答案」重做页。 */
export async function fetchQuizOnPage(page, ctx = {}, kid = '') {
  const raw = await page.evaluate(QUIZ_EXTRACT).catch((e) => ({ ok: false, err: String(e.message || e) }));
  if (!raw || !raw.ok) return { ok: false, reason: raw && raw.err === 'no-quiz' ? 'no-quiz' : 'extract-fail', raw };
  return finalizeQuiz(raw, ctx, kid);
}

/** 「修改答案」重做页的回填（走 UEditor 实例 window.answerEditor<qid>_<k>）。 */
export async function fillQuizReedit(page, plan, ctx = {}) {
  const log = ctx.log || (() => {});
  const p = normalizePlan(plan);
  const r = await page.evaluate(quizReeditFillExpr(p)).catch((e) => ({ ok: false, err: String(e.message || e) }));
  await sleep(1500);
  log({ ev: 'quiz-reedit-fill', plan: p.length, filled: r && r.filled, clicked: r && r.clicked, missing: (r && r.missing) || [], err: r && r.err });
  return r;
}
