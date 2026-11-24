// 学习通答题求解器：构造中文提示词 -> 调宿主大模型 -> 容错解析 -> 置信度门限。
// 只做「题目 -> 回填计划」的纯逻辑，不碰浏览器、不提交；提交仍由 quiz.mjs/work.mjs 负责。
// 数据形状（来自 lib/quiz.mjs 的 fetchQuiz / lib/work.mjs 的 fetchWork）：
//   测验 items: { i, stem, opts:[{letter,text}], inputs, type:'single'|'multi'|'fill', correct, graded }
//   作业 items: { i, qid, stem, opts:[{letter,text}], inputs, type:'single'|'multi'|'text' }
//   回填计划:   测验 [{ i, letters?:['A'], texts?:['选项文字前12字'], text?:'填空' }]
//               作业 [{ i, letters?:['A'], text?:'简答' }]
// 解析要足够皮实：模型给围栏、前后废话、大小写混用、letters 是字符串、i 缺失、confidence 缺失、
// 字母不在 opts 里、type 与页面题型不一致，都不能让整批答案报废。

export const PROMPT_VERSION = 'chaoxing-solver/1';

const SYSTEM_QUIZ = [
  '你是学习通（超星）课程题库的解题助手，负责给章节测验作答。',
  '你的输出必须是严格 JSON：不要 markdown、不要代码围栏、不要 JSON 之外的任何文字。',
  '只能依据题目本身和学科知识作答；不确定就降低 confidence，绝不能编造。',
  '选项字母必须以题目 options 里给出的 letter 为准，不要自己发明字母。',
].join('\n');

const SYSTEM_WORK = [
  '你是学习通（超星）课程作业的解题助手，负责给作业题作答。',
  '你的输出必须是严格 JSON：不要 markdown、不要代码围栏、不要 JSON 之外的任何文字。',
  '只能依据题目本身和学科知识作答；不确定就降低 confidence，绝不能编造。',
  '选择题的字母必须以题目 options 里给出的 letter 为准；简答题写成完整、通顺的中文段落。',
].join('\n');

const QUIZ_JSON_EXAMPLE =
  '{"answers":[{"i":0,"type":"single","letters":["A"],"text":"","confidence":0.86,"reason":"知识点依据"}],"notes":""}';
const WORK_JSON_EXAMPLE =
  '{"answers":[{"i":0,"type":"single","letters":["A"],"text":"","confidence":0.86,"reason":"依据"},' +
  '{"i":1,"type":"text","letters":[],"text":"完整的中文答案","confidence":0.82,"reason":"依据"}],"notes":""}';

// ---------------- 小工具 ----------------

function clip(s, n) {
  const t = String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function clamp01(v, def = 0.5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(1, Math.max(0, n));
}

function safeLog(log, payload) {
  if (typeof log !== 'function') return;
  try {
    log(payload);
  } catch {
    /* 日志失败不影响答题 */
  }
}

function courseLabel(course) {
  if (!course) return '（未提供课程信息）';
  if (typeof course === 'string') return clip(course, 120);
  const title = clip(course.title || course.name || '', 120);
  const id = String(course.courseid || course.id || '').trim();
  if (title && id) return `${title}（courseid=${id}）`;
  if (title) return title;
  if (id) return `courseid=${id}`;
  return '（未提供课程信息）';
}

function kidLabel(kid) {
  if (kid === undefined || kid === null) return '';
  if (typeof kid === 'object') return clip(kid.name || kid.kid || '', 120);
  return clip(kid, 120);
}

function extraText(extra) {
  if (extra === undefined || extra === null) return '';
  if (typeof extra === 'string') return clip(extra, 1200);
  try {
    return clip(JSON.stringify(extra), 1200);
  } catch {
    return '';
  }
}

function optionHead(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
}

function quizType(item) {
  const t = String((item && item.type) || '').toLowerCase();
  if (t === 'multi') return 'multi';
  if (t === 'fill' || t === 'text' || t === 'blank') return 'fill';
  if (t === 'single' || t === 'judge' || t === 'choice') return 'single';
  const opts = item && Array.isArray(item.opts) ? item.opts : [];
  return opts.length ? 'single' : 'fill';
}

function workType(item) {
  const t = String((item && item.type) || '').toLowerCase();
  if (t === 'multi') return 'multi';
  if (t === 'text' || t === 'fill' || t === 'short' || t === 'essay') return 'text';
  if (t === 'single' || t === 'judge' || t === 'choice') return 'single';
  const opts = item && Array.isArray(item.opts) ? item.opts : [];
  return opts.length ? 'single' : 'text';
}

/** 模型写的题型归一化，用来和页面题型比较（避免 judge/choice 这类同义词误报）。 */
function normTypeName(t, kind) {
  const s = String(t || '').toLowerCase();
  if (!s) return '';
  if (s === 'judge' || s === 'choice' || s === 'single') return 'single';
  if (s === 'multi' || s === 'multiple') return 'multi';
  if (kind === 'work') return s === 'fill' || s === 'short' || s === 'essay' || s === 'text' ? 'text' : s;
  return s === 'text' || s === 'blank' || s === 'fill' ? 'fill' : s;
}

function outputBudget(kind, n) {
  // 注意：deepseek-flash 会先输出一大段推理再给 JSON，预算太小会在推理阶段就被截断。
  const per = kind === 'quiz' ? 220 : 300;
  const want = 2048 + (Number(n) || 0) * per;
  return Math.max(2048, Math.min(8192, want));
}

function modelLabel(llm) {
  if (!llm) return '';
  try {
    const m = llm.model;
    if (typeof m === 'string' && m) return m;
  } catch {
    /* getter 可能抛 */
  }
  try {
    const route = llm.route;
    if (route && route.model) return String(route.model);
  } catch {
    /* ignore */
  }
  return '';
}

// ---------------- 提示词 ----------------

function serializeQuizItem(it) {
  const out = { i: Number(it && it.i), type: quizType(it), stem: clip(it && it.stem, 1500) };
  const opts = it && Array.isArray(it.opts) ? it.opts : [];
  if (opts.length) {
    out.options = opts.map((o, k) => ({
      letter: String((o && o.letter) || '').trim().toUpperCase() || String.fromCharCode(65 + k),
      text: clip(o && o.text, 400),
    }));
  }
  if (it && it.inputs) out.inputs = Number(it.inputs) || 0;
  return out;
}

function serializeWorkItem(it) {
  const out = { i: Number(it && it.i), type: workType(it), stem: clip(it && it.stem, 2000) };
  if (it && it.qid !== undefined && it.qid !== null && String(it.qid).trim()) out.qid = clip(it.qid, 80);
  const opts = it && Array.isArray(it.opts) ? it.opts : [];
  if (opts.length) {
    out.options = opts.map((o, k) => ({
      letter: String((o && o.letter) || '').trim().toUpperCase() || String.fromCharCode(65 + k),
      text: clip(o && o.text, 400),
    }));
  }
  if (it && it.inputs) out.inputs = Number(it.inputs) || 0;
  return out;
}

/**
 * 章节测验提示词（中文，要求只输出严格 JSON）。
 * @returns {{system:string, user:string}}
 */
export function quizPrompt({ course, kid, items, extra } = {}) {
  const list = Array.isArray(items) ? items : [];
  const payload = list.map(serializeQuizItem);
  const lines = [];
  lines.push(`课程：${courseLabel(course)}`);
  const chapter = kidLabel(kid);
  if (chapter) lines.push(`章节：${chapter}`);
  lines.push(
    `题型：single=单选或判断（只给 1 个字母），multi=多选（给多个字母），fill=填空（给 text）。共 ${list.length} 题。`,
  );
  lines.push('');
  lines.push('题目（JSON 数组；options 里的 letter 就是这道题可用的选项字母）：');
  lines.push(JSON.stringify(payload));
  const ex = extraText(extra);
  if (ex) {
    lines.push('');
    lines.push(`补充要求（来自插件）：${ex}`);
  }
  lines.push('');
  lines.push('只输出下面这个结构的严格 JSON（不要围栏、不要解释文字）：');
  lines.push(QUIZ_JSON_EXAMPLE);
  lines.push(
    '规则：' +
      '1) i 必须与题目编号一致，每题一条，不遗漏、不重复；' +
      '2) 单选/判断的 letters 只写 1 个字母，多选写全部正确字母（2 个及以上）；' +
      '3) 填空题在 text 里写答案，只有一个空就直接写，多个空按顺序用“；”分隔，不要写“答：”或编号；' +
      '4) 字母只能取该题 options 里出现过的 letter，不要自己发明；' +
      '5) 选择题/判断题/填空题即使不确定也要给出最可能的答案（能推理就推理，别留空），用 confidence 如实反映把握；实在无法判断才把 confidence 写到 0.3 以下；reason 用一句话说明知识点依据，不要编造。',
  );
  return { system: SYSTEM_QUIZ, user: lines.join('\n') };
}

/**
 * 作业提示词（中文，要求只输出严格 JSON）。
 * @returns {{system:string, user:string}}
 */
export function workPrompt({ course, items, extra } = {}) {
  const list = Array.isArray(items) ? items : [];
  const payload = list.map(serializeWorkItem);
  const lines = [];
  lines.push(`课程：${courseLabel(course)}`);
  lines.push(
    `题型：single=单选或判断（只给 1 个字母），multi=多选（给多个字母），text=简答/填空（给 text）。共 ${list.length} 题。`,
  );
  lines.push('');
  lines.push('题目（JSON 数组；选择题 options 里的 letter 就是这道题可用的选项字母）：');
  lines.push(JSON.stringify(payload));
  const ex = extraText(extra);
  if (ex) {
    lines.push('');
    lines.push(`补充要求（来自插件）：${ex}`);
  }
  lines.push('');
  lines.push('只输出下面这个结构的严格 JSON（不要围栏、不要解释文字）：');
  lines.push(WORK_JSON_EXAMPLE);
  lines.push(
    '规则：' +
      '1) i 必须与题目编号一致，每题一条，不遗漏、不重复；' +
      '2) 选择题用 letters（单选 1 个字母，多选全部正确字母），字母只能取该题 options 里的 letter；' +
      '3) 简答题在 text 里写一小段完整、通顺的中文答案（一般 80~200 字，按题目要求），不要编号、不要分点符号、不要“答：”；' +
      '4) 选择题即使不确定也要给出最可能的答案（别留空），用 confidence 如实反映把握；实在无法判断才把 confidence 写到 0.3 以下；简答题按题目要求写，reason 一句话说明依据，不要编造。',
  );
  return { system: SYSTEM_WORK, user: lines.join('\n') };
}

/**
 * 复核提示词（v1.7.0）：把第一次作答里置信度偏低的题再让模型审一遍，减少"蒙错"。
 * @returns {{system:string, user:string}}
 */
export function reviewPrompt({ kind, course, items, drafts } = {}) {
  const list = Array.isArray(items) ? items : [];
  const draftMap = drafts && typeof drafts === 'object' ? drafts : {};
  const payload = list.map((it) => {
    const base = kind === 'quiz' ? serializeQuizItem(it) : serializeWorkItem(it);
    const d = draftMap[String(it && it.i)] || {};
    const draft = d.letters && d.letters.length ? { letters: d.letters } : d.text ? { text: clip(d.text, 400) } : {};
    return { ...base, draft };
  });
  const lines = [];
  lines.push(`课程：${courseLabel(course)}`);
  lines.push('下面是若干题目以及第一次作答的初稿（draft，可能有错）。请逐题复核后给出最终答案。');
  lines.push('');
  lines.push('题目（JSON 数组，draft 是初稿）：');
  lines.push(JSON.stringify(payload));
  lines.push('');
  lines.push('只输出严格 JSON，结构如下（不要围栏、不要解释文字）：');
  lines.push(kind === 'quiz' ? QUIZ_JSON_EXAMPLE : WORK_JSON_EXAMPLE);
  lines.push(
    '复核要求：' +
      '1) 每题都必须给最终答案，i 与输入一致；' +
      '2) 若初稿正确可原样返回；若判断有误请改正；' +
      '3) 选择题 letters 只能取该题 options 里的 letter，多选题给全部正确字母；' +
      '4) 判断题按题意选 A 或 B（不要输出“对/错/true/false”这类文字）；' +
      '5) 填空/简答用 text，简洁准确；' +
      '6) reason 写一句判断依据，不要编造。',
  );
  return { system: kind === 'quiz' ? SYSTEM_QUIZ : SYSTEM_WORK, user: lines.join('\n') };
}

// ---------------- 模型输出解析 ----------------

function findBalanced(text) {
  const start = String(text).search(/[{[]/);
  if (start < 0) return '';
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

function stripTrailingCommas(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function parseLooseJson(rawText) {
  const original = String(rawText == null ? '' : rawText).replace(/^\uFEFF/, '').trim();
  if (!original) throw new Error('空文本');
  const tries = [];
  const add = (s) => {
    const t = String(s == null ? '' : s).trim();
    if (t && !tries.includes(t)) tries.push(t);
  };
  const fenced = original.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/);
  if (fenced) add(fenced[1]);
  add(original);
  for (const cand of [...tries]) add(findBalanced(cand));

  let lastErr = null;
  for (const cand of tries) {
    try {
      return JSON.parse(cand);
    } catch (e) {
      lastErr = e;
    }
    const repaired = stripTrailingCommas(cand);
    if (repaired !== cand) {
      try {
        return JSON.parse(repaired);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw new Error(lastErr ? lastErr.message : '没有找到 JSON');
}

function extractModelAnswers(rawText) {
  let parsed;
  try {
    parsed = parseLooseJson(rawText);
  } catch (e) {
    return { list: [], notes: '', error: `无法解析大模型输出为 JSON（${String((e && e.message) || e)}）` };
  }
  if (Array.isArray(parsed)) return { list: parsed, notes: '' };
  if (parsed && typeof parsed === 'object') {
    const list = [parsed.answers, parsed.plan, parsed.data, parsed.items].find(Array.isArray);
    if (!list) return { list: [], notes: clip(parsed.notes, 200), error: '大模型 JSON 里没有 answers 数组' };
    return { list, notes: clip(parsed.notes, 200) };
  }
  return { list: [], notes: '', error: '大模型 JSON 不是对象或数组' };
}

/** 把各种形态的 letters 统一成大写字母数组。 */
function rawLetters(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const cand =
    entry.letters !== undefined
      ? entry.letters
      : entry.letter !== undefined
        ? entry.letter
        : entry.answer !== undefined
          ? entry.answer
          : entry.answers !== undefined
            ? entry.answers
            : entry.choice;
  if (cand === undefined || cand === null) return [];
  const arr = Array.isArray(cand) ? cand : [cand];
  const out = [];
  for (const v of arr) {
    if (typeof v === 'string') {
      out.push(...v.toUpperCase().replace(/[^A-Z]/g, '').split(''));
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      // 数字按 1 基处理：1 -> A
      if (v >= 1 && v <= 26) out.push(String.fromCharCode(65 + Math.round(v) - 1));
    } else if (v && typeof v === 'object') {
      const l = v.letter !== undefined ? v.letter : v.id !== undefined ? v.id : v.value;
      if (typeof l === 'string') out.push(...l.toUpperCase().replace(/[^A-Z]/g, '').split(''));
    }
  }
  return [...new Set(out)].slice(0, 8);
}

function optionMap(item) {
  const opts = item && Array.isArray(item.opts) ? item.opts : [];
  const map = new Map();
  for (let k = 0; k < opts.length; k++) {
    const letter =
      String((opts[k] && opts[k].letter) || '').trim().toUpperCase() || String.fromCharCode(65 + k);
    if (!map.has(letter)) map.set(letter, { letter, text: String((opts[k] && opts[k].text) || '') });
  }
  return map;
}

/**
 * 选项题归一化：保留合法字母；非法字母按位置 fallback；空答案回退到第一个选项。
 * @returns {{chosen:string[], map:Map<string,{letter:string,text:string}>, fuzzy:boolean, fallbackOnly:boolean}}
 */
function normalizeChoice(entry, item, i, warnings) {
  const map = optionMap(item);
  const allowed = [...map.keys()];
  const raw = rawLetters(entry);
  const kept = [];
  let validCount = 0;
  let fuzzy = raw.length === 0;
  for (const letter of raw) {
    if (map.has(letter)) {
      validCount++;
      if (!kept.includes(letter)) kept.push(letter);
      continue;
    }
    fuzzy = true;
    const idx = letter.charCodeAt(0) - 65;
    const fallback = allowed[idx];
    if (fallback && !kept.includes(fallback)) {
      warnings.push(`第 ${i} 题：字母 ${letter} 不在选项中，按位置改用 ${fallback}`);
      kept.push(fallback);
    } else {
      warnings.push(`第 ${i} 题：字母 ${letter} 不在选项中，已忽略`);
    }
  }
  return { chosen: kept, map, fuzzy, fallbackOnly: validCount === 0, allowed };
}

function finishChoice(choice, type, i, conf, warnings) {
  let chosen = choice.chosen;
  if (type === 'multi') {
    if (!chosen.length && choice.allowed.length) {
      chosen = [choice.allowed[0]];
      warnings.push(`第 ${i} 题：没有给出有效多选字母，回退到第一个选项 ${chosen[0]}`);
    }
  } else {
    if (chosen.length > 1) {
      warnings.push(`第 ${i} 题是单选，只保留 ${chosen[0]}（忽略 ${chosen.slice(1).join('、')}）`);
      chosen = [chosen[0]];
    }
    if (!chosen.length && choice.allowed.length) {
      chosen = [choice.allowed[0]];
      warnings.push(`第 ${i} 题：没有给出有效字母，回退到第一个选项 ${chosen[0]}`);
    }
  }
  let confidence = conf;
  if (choice.fallbackOnly) confidence = Math.min(confidence, 0.25);
  else if (choice.fuzzy) confidence = Math.min(confidence, 0.5);
  return { chosen, confidence };
}

function normalizeEntry(entry, pos, list, byI, warnings, kind) {
  if (!entry || typeof entry !== 'object') {
    warnings.push(`第 ${pos + 1} 条答案不是对象，已忽略`);
    return null;
  }
  let item = null;
  const rawI = Number(entry.i ?? entry.index ?? entry.no ?? entry.id);
  if (Number.isFinite(rawI)) item = list.find((it) => Number(it.i) === rawI) || null;
  if (!item) {
    if (Number.isFinite(rawI)) warnings.push(`答案编号 ${rawI} 找不到对应题目，改为按位置对应`);
    const byPos = list[pos];
    item = byPos && !byI.has(Number(byPos.i)) ? byPos : list.find((it) => !byI.has(Number(it.i))) || null;
  }
  if (!item) {
    warnings.push(`第 ${pos + 1} 条答案找不到对应题目，已忽略`);
    return null;
  }
  const i = Number(item.i);
  if (byI.has(i)) {
    warnings.push(`第 ${i} 题出现重复答案，保留第一条`);
    return null;
  }

  const conf = clamp01(entry.confidence ?? entry.conf ?? entry.score, 0.5);
  const reason = clip(entry.reason ?? entry.explain ?? entry.analysis, 240);
  const pageType = kind === 'quiz' ? quizType(item) : workType(item);
  const claimedType = normTypeName(entry.type, kind);
  if (claimedType && claimedType !== pageType) {
    warnings.push(`第 ${i} 题：模型给的题型 ${entry.type} 与页面题型 ${pageType} 不一致，按页面题型处理`);
  }

  if (pageType === 'fill' || pageType === 'text') {
    let text = entry.text ?? entry.fill ?? entry.value ?? entry.answer ?? entry.content;
    if (Array.isArray(text)) {
      text = text
        .map((x) => String(x == null ? '' : x).trim())
        .filter(Boolean)
        .join('；');
    }
    text = String(text == null ? '' : text).trim();
    if (!text) {
      warnings.push(`第 ${i} 题：模型没有给出${pageType === 'fill' ? '填空' : '简答'}答案，已跳过`);
      return { i, plan: null, answer: { i, confidence: 0, reason } };
    }
    if (Array.isArray(entry.letters) && entry.letters.length) {
      warnings.push(`第 ${i} 题是${pageType === 'fill' ? '填空' : '简答'}题，已忽略 letters`);
    }
    const textPlan = item && item.qid ? { i, qid: String(item.qid), text } : { i, text };
    return { i, plan: textPlan, answer: { i, confidence: conf, reason } };
  }

  const choice = normalizeChoice(entry, item, i, warnings);
  const { chosen, confidence } = finishChoice(choice, pageType, i, conf, warnings);
  if (!chosen.length) {
    warnings.push(`第 ${i} 题没有可选项，无法作答`);
    return { i, plan: null, answer: { i, confidence: 0, reason } };
  }
  const plan = item && item.qid ? { i, qid: String(item.qid), letters: chosen.slice() } : { i, letters: chosen.slice() };
  if (kind === 'quiz') {
    const texts = chosen.map((letter) => optionHead(choice.map.get(letter) && choice.map.get(letter).text));
    if (texts.some((t) => t)) plan.texts = texts;
  }
  return { i, plan, answer: { i, confidence, reason } };
}

function parsePlan(rawText, items, kind) {
  const list = Array.isArray(items) ? items : [];
  const warnings = [];
  const extracted = extractModelAnswers(rawText);
  if (extracted.error) warnings.push(extracted.error);
  if (extracted.notes) warnings.push(`模型备注：${clip(extracted.notes, 200)}`);

  const byI = new Map();
  extracted.list.forEach((entry, pos) => {
    const norm = normalizeEntry(entry, pos, list, byI, warnings, kind);
    if (norm) byI.set(norm.i, norm);
  });

  const plan = [];
  const answers = [];
  for (const it of list) {
    const norm = byI.get(Number(it.i));
    if (!norm) continue;
    if (norm.plan) plan.push(norm.plan);
    answers.push(norm.answer);
  }
  const missing = list.filter((it) => !byI.has(Number(it.i))).map((it) => Number(it.i));
  if (missing.length) warnings.push(`以下题目没有答案：${missing.join('、')}`);

  const minConfidence = answers.length ? Math.min(...answers.map((a) => a.confidence)) : 0;
  return { plan, answers, minConfidence, warnings };
}

/**
 * 解析章节测验答案。
 * @returns {{plan:Array<{i:number,letters?:string[],texts?:string[],text?:string}>,
 *            answers:Array<{i:number,confidence:number,reason:string}>,
 *            minConfidence:number, warnings:string[]}}
 */
export function parseQuizPlan(rawText, items) {
  return parsePlan(rawText, items, 'quiz');
}

/**
 * 解析作业答案。
 * @returns {{plan:Array<{i:number,letters?:string[],text?:string}>,
 *            answers:Array<{i:number,confidence:number,reason:string}>,
 *            minConfidence:number, warnings:string[]}}
 */
export function parseWorkPlan(rawText, items) {
  return parsePlan(rawText, items, 'work');
}

/**
 * 置信度门限：低于 minConfidence 的题列入 low，ok 为「有答案且全部达标」。
 * @returns {{ok:boolean, min:number, low:Array<{i:number,confidence:number}>}}
 */
export function gateAnswers(answers, minConfidence = 0.75) {
  const threshold = Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : 0.75;
  const list = Array.isArray(answers) ? answers : [];
  const low = [];
  let min = 1;
  for (const a of list) {
    const v = Number(a && a.confidence);
    const conf = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    if (conf < threshold) low.push({ i: a && a.i, confidence: conf });
    if (conf < min) min = conf;
  }
  return { ok: list.length > 0 && low.length === 0, min: list.length ? min : 0, low };
}

// ---------------- 端到端求解 ----------------

async function runSolve({ kind, llm, log, course, kid, items, extra, minConfidence }) {
  const list = Array.isArray(items) ? items : [];
  const warnings = [];
  const started = Date.now();
  const base = {
    ok: false,
    plan: [],
    answers: [],
    minConfidence: 0,
    gate: { ok: false, min: 0, low: [] },
    text: '',
    usage: null,
    model: '',
    warnings,
  };
  if (!llm || typeof llm.text !== 'function') {
    return { ...base, error: 'llm 客户端不可用（缺少 text()）' };
  }
  if (!list.length) return { ...base, error: '没有可作答的题目' };

  const threshold = Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : 0.75;
  // 大题量必须分批：一次要 100+ 题的 JSON，模型很容易撞 maxTokens 返回截断的坏 JSON。
  const chunkSize = Math.max(4, Math.min(24, Number(process.env.CHAOXING_SOLVE_CHUNK) || 18));
  const chunks = [];
  for (let i = 0; i < list.length; i += chunkSize) chunks.push(list.slice(i, i + chunkSize));

  const answers = [];
  const plan = [];
  const texts = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let model = modelLabel(llm);
  let error = '';
  let chunkFails = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const subset = chunks[ci];
    const prompt =
      kind === 'quiz'
        ? quizPrompt({ course, kid, items: subset, extra })
        : workPrompt({ course, items: subset, extra });
    const maxTokens = outputBudget(kind, subset.length);
    safeLog(log, {
      ev: `solve-${kind}-chunk`,
      chunk: ci + 1,
      chunks: chunks.length,
      questions: subset.length,
      model,
      maxTokens,
    });
    let res;
    try {
      res = await llm.text({ system: prompt.system, user: prompt.user, maxTokens, temperature: 0.1 });
    } catch (e) {
      error = String((e && e.message) || e || 'llm call failed');
      chunkFails += 1;
      safeLog(log, {
        ev: `solve-${kind}-fail`,
        chunk: ci + 1,
        fails: chunkFails,
        ms: Date.now() - started,
        err: error.slice(0, 200),
      });
      // 单块失败不再让整批题目留空：跳过这块继续答后面的；连续 3 次失败才认为是系统性问题
      if (chunkFails >= 3) break;
      continue;
    }
    chunkFails = 0;
    let text = String(res && res.text != null ? res.text : '');
    let parsed = kind === 'quiz' ? parseQuizPlan(text, subset) : parseWorkPlan(text, subset);
    // 输出被截断（推理把 maxTokens 吃光）时，加倍预算重试一次；仍然不行就留证据。
    // 判定只看出 token 是否顶到预算：原来还加了 `|| text.length>0`，等于「只要模型说了话」就恒真。
    const outTok = Number((res && res.usage && res.usage.outputTokens) || 0);
    const truncated = !parsed.answers.length && outTok >= maxTokens * 0.9;
    if (truncated) {
      const retryMax = Math.min(8192, maxTokens * 2);
      const retryUser = `${prompt.user}\n\n上一次回答被截断或不是 JSON。这次不要写任何推理过程，第一个字符必须是 {，只输出 JSON。`;
      safeLog(log, { ev: `solve-${kind}-retry`, chunk: ci + 1, prevOutTokens: outTok, maxTokens: retryMax });
      try {
        const res2 = await llm.text({ system: prompt.system, user: retryUser, maxTokens: retryMax, temperature: 0 });
        const text2 = String(res2 && res2.text != null ? res2.text : '');
        const parsed2 = kind === 'quiz' ? parseQuizPlan(text2, subset) : parseWorkPlan(text2, subset);
        if (parsed2.answers.length) {
          res = res2;
          text = text2;
          parsed = parsed2;
        } else {
          safeLog(log, {
            ev: `solve-${kind}-parsefail`,
            chunk: ci + 1,
            len: text2.length,
            outTokens: (res2 && res2.usage && res2.usage.outputTokens) || 0,
            raw: text2.slice(0, 300),
          });
        }
      } catch (e) {
        safeLog(log, { ev: `solve-${kind}-retryfail`, chunk: ci + 1, err: String((e && e.message) || e).slice(0, 200) });
      }
    }
    // 模型有时只答一部分题（返回的 answers 少于题量）。缺的题通常就是判断题/低把握题，
    // 留空会导致“还有未做完的题”、直接判低分。这里对缺失题逐轮补问，最多 2 轮。
    for (let round = 0; round < 2; round++) {
      const have = new Set(parsed.answers.map((a) => a.i));
      const missing = subset.filter((it) => !have.has(it.i));
      if (!missing.length) break;
      const fp =
        kind === 'quiz'
          ? quizPrompt({ course, kid, items: missing, extra })
          : workPrompt({ course, items: missing, extra });
      const forceUser = `${fp.user}\n\n上一次漏掉了这些题。这次必须为上面列出的每一道题都给出答案（判断题也要给 A 或 B），一题都不能少，仍然只输出 JSON。`;
      safeLog(log, { ev: `solve-${kind}-missing`, chunk: ci + 1, round: round + 1, missing: missing.length });
      try {
        const r3 = await llm.text({ system: fp.system, user: forceUser, maxTokens: outputBudget(kind, missing.length), temperature: 0.1 });
        const p3 = kind === 'quiz' ? parseQuizPlan(String(r3 && r3.text), missing) : parseWorkPlan(String(r3 && r3.text), missing);
        if (!p3.answers.length) break;
        parsed = {
          answers: parsed.answers.concat(p3.answers),
          plan: parsed.plan.concat(p3.plan),
          warnings: parsed.warnings.concat(p3.warnings || []),
        };
        if (r3 && r3.usage) {
          usage.inputTokens += Number(r3.usage.inputTokens) || 0;
          usage.outputTokens += Number(r3.usage.outputTokens) || 0;
          usage.totalTokens += Number(r3.usage.totalTokens) || 0;
        }
      } catch (e) {
        safeLog(log, { ev: `solve-${kind}-missingfail`, chunk: ci + 1, err: String((e && e.message) || e).slice(0, 160) });
        break;
      }
    }
    texts.push(text);
    warnings.push(...parsed.warnings);
    answers.push(...parsed.answers);
    plan.push(...parsed.plan);
    if (res && res.model) model = res.model;
    if (res && res.usage) {
      usage.inputTokens += Number(res.usage.inputTokens) || 0;
      usage.outputTokens += Number(res.usage.outputTokens) || 0;
      usage.totalTokens += Number(res.usage.totalTokens) || 0;
    }
  }

  // 复核一遍“没把握”的题（v1.7.0）：作业准确率低主要来自这些题蒙错，
  // 让模型带着初稿再判断一次，成本不高但能明显提高正确率。
  try {
    if (llm && typeof llm.text === 'function') {
      const planByI = new Map(plan.map((p) => [String(p.i), p]));
      const lowAnswers = answers
        .filter((a) => {
          const p = planByI.get(String(a.i));
          if (!p) return false;
          const conf = Number(a.confidence) || 0;
          return conf < 0.8 && (p.letters || p.text);
        })
        .sort((x, y) => (Number(x.confidence) || 0) - (Number(y.confidence) || 0))
        .slice(0, 24)
        .sort((x, y) => (Number(x.i) || 0) - (Number(y.i) || 0));
      const srcItems = [];
      for (const a of lowAnswers) {
        const it = list.find((x) => Number(x && x.i) === Number(a.i));
        if (it) srcItems.push(it);
      }
      if (srcItems.length) {
        // 复核请求里把题号重排成连续的 0..n-1（模型和解析器都按连续题号处理），结果再映射回原题号。
        const back = new Map();
        const reviewItems = srcItems.map((it, k) => {
          back.set(k, Number(it.i));
          return { ...it, i: k };
        });
        const drafts = {};
        for (const it of reviewItems) {
          const p = planByI.get(String(back.get(Number(it.i))));
          if (p) drafts[String(it.i)] = { letters: p.letters || [], text: p.text || '' };
        }
        const rp = reviewPrompt({ kind, course, items: reviewItems, drafts });
        const rr = await llm.text({
          system: rp.system,
          user: rp.user,
          maxTokens: outputBudget(kind, reviewItems.length),
          temperature: 0,
        });
        const rpParsed = kind === 'quiz' ? parseQuizPlan(String(rr && rr.text), reviewItems) : parseWorkPlan(String(rr && rr.text), reviewItems);
        if (rpParsed.plan.length) {
          const fixed = new Map();
          for (const p of rpParsed.plan) {
            const orig = back.get(Number(p.i));
            if (orig !== undefined) fixed.set(String(orig), { ...p, i: orig });
          }
          const fixedAns = new Map();
          for (const a of rpParsed.answers) {
            const orig = back.get(Number(a.i));
            if (orig !== undefined) fixedAns.set(String(orig), { ...a, i: orig });
          }
          let changedCount = 0;
          for (let k = 0; k < plan.length; k++) {
            const key = String(plan[k].i);
            if (fixed.has(key)) {
              const before = JSON.stringify(plan[k].letters || plan[k].text || '');
              const after = JSON.stringify(fixed.get(key).letters || fixed.get(key).text || '');
              if (before !== after) changedCount += 1;
              plan[k] = fixed.get(key);
            }
          }
          for (let k = 0; k < answers.length; k++) {
            const key = String(answers[k].i);
            if (fixedAns.has(key)) {
              const prev = Number(answers[k].confidence) || 0;
              const next = Number(fixedAns.get(key).confidence) || 0;
              answers[k] = { ...fixedAns.get(key), confidence: Math.max(prev, next) };
            }
          }
          if (rr && rr.usage) {
            usage.inputTokens += Number(rr.usage.inputTokens) || 0;
            usage.outputTokens += Number(rr.usage.outputTokens) || 0;
            usage.totalTokens += Number(rr.usage.totalTokens) || 0;
          }
          safeLog(log, {
            ev: `solve-${kind}-review`,
            asked: lowAnswers.length,
            fixed: fixed.size,
            changed: changedCount,
          });
        }
      }
    }
  } catch (e) {
    safeLog(log, { ev: `solve-${kind}-reviewfail`, err: String((e && e.message) || e).slice(0, 160) });
  }

  const text = texts.join('\n');
  const gate = gateAnswers(answers, threshold);
  // 低置信度处理：
  // - 选择题/判断题（single/multi/fill）即使没把握也照样填：留空会触发“还有未做完的题”，
  //   而且作业/测验常按题扣分，空白一定错，蒙一个还有概率对。
  // - 简答/论述（text）才按置信度过滤，避免把不靠谱的长段落交上去。
  const lowSet = new Set(gate.low.map((x) => x.i));
  const lowConf = new Map(gate.low.map((x) => [x.i, x.confidence]));
  const objective = (a) => a && (a.type === 'single' || a.type === 'multi' || a.type === 'fill');
  // 填空/选择/判断一律保留；简答类只要模型给了实质答案（confidence >= 0.15）也保留，
  // 留空一定是 0 分，写点东西至少可能拿到分。只有模型明确没把握（<0.15）或空答案才丢。
  const fillFloor = Math.max(0.1, Math.min(0.3, threshold * 0.25));
  const keepOne = (a) => {
    if (!lowSet.has(a.i)) return true;
    if (objective(a)) return true;
    const conf = lowConf.get(a.i) || 0;
    const hasText = (a.text && String(a.text).trim()) || (Array.isArray(a.texts) && a.texts.some((t) => String(t || '').trim()));
    return conf >= fillFloor && hasText;
  };
  const keptIdx = new Set(answers.filter(keepOne).map((a) => a.i));
  const confidentPlan = plan.filter((p) => keptIdx.has(p.i));
  const confidentAnswers = answers.filter((a) => keptIdx.has(a.i));
  const keptLow = confidentAnswers.filter((a) => lowSet.has(a.i)).length;
  const ok = confidentPlan.length > 0;
  const result = {
    ok,
    plan: confidentPlan,
    answers: confidentAnswers,
    minConfidence: gate.min,
    gate,
    text,
    usage: usage.inputTokens || usage.outputTokens ? usage : null,
    model,
    warnings,
    chunks: chunks.length,
    dropped: lowSet.size - keptLow,
    keptLow,
  };
  if (!ok) {
    result.error =
      error ||
      (plan.length ? '模型给出的答案都低于置信度门限' : text.trim() ? '大模型没有给出可用答案' : '大模型返回了空文本');
  }
  safeLog(log, {
    ev: `solve-${kind}-done`,
    ok,
    plan: confidentPlan.length,
    answers: answers.length,
    dropped: lowSet.size - keptLow,
    keptLow,
    chunks: chunks.length,
    gate: gate.ok,
    min: gate.min,
    low: gate.low.length,
    ms: Date.now() - started,
    model: result.model,
    inTokens: result.usage && result.usage.inputTokens,
    outTokens: result.usage && result.usage.outputTokens,
  });
  return result;
}

/**
 * 让宿主大模型做一套章节测验。
 * @returns {Promise<{ok:boolean, plan:Array, answers:Array, minConfidence:number,
 *                    gate:{ok:boolean,min:number,low:Array}, text:string, usage:object|null,
 *                    model:string, warnings:string[], error?:string}>}
 */
export async function solveQuiz({ llm, log, course, kid, items, extra, minConfidence = 0.75 } = {}) {
  return runSolve({ kind: 'quiz', llm, log, course, kid, items, extra, minConfidence });
}

/**
 * 让宿主大模型做一次作业。
 * @returns {Promise<{ok:boolean, plan:Array, answers:Array, minConfidence:number,
 *                    gate:{ok:boolean,min:number,low:Array}, text:string, usage:object|null,
 *                    model:string, warnings:string[], error?:string}>}
 */
export async function solveWork({ llm, log, course, items, extra, minConfidence = 0.75 } = {}) {
  return runSolve({ kind: 'work', llm, log, course, kid: '', items, extra, minConfidence });
}
