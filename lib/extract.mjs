// 注入页面执行的脚本片段（已在旧版脚本里实测过的写法，尽量保持原样）。
// 约定：所有脚本都是自包含 IIFE，可由 Runtime.evaluate 直接执行；
// 需要参数的脚本通过字符串拼接/JSON 内联构造。

export const READY = `document.readyState`;

export const PAGE_PROBE = `(() => {
  let text = '';
  try { text = (document.body ? document.body.innerText : '') || ''; } catch (e) {}
  const links = [];
  try {
    document.querySelectorAll('a[href]').forEach((a) => {
      if (links.length < 60) links.push(String(a.getAttribute('href')).slice(0, 300));
    });
  } catch (e) {}
  return { href: location.href, title: document.title, text: text.slice(0, 2500), links, frames: document.querySelectorAll('iframe').length };
})()`;

// ---- 课程列表：从当前页（含同源 iframe）里扫出所有 courseid/clazzid/cpi ----
export const COURSE_SCAN = `(() => {
  const out = new Map();
  const put = (raw, name) => {
    try {
      const s = String(raw || '');
      const g = (re) => { const m = s.match(re); return m ? decodeURIComponent(m[1]) : ''; };
      const courseid = g(/[?&]courseid=(\\d+)/i);
      const clazzid = g(/[?&]clazzid=(\\d+)/i) || g(/[?&]classid=(\\d+)/i);
      if (!courseid || !clazzid) return;
      const cpi = g(/[?&]cpi=(\\d+)/i);
      const enc = g(/[?&]enc=([0-9a-fA-F]{16,40})/);
      const key = courseid + ':' + clazzid;
      const prev = out.get(key) || {};
      out.set(key, {
        courseid,
        clazzid,
        cpi: cpi || prev.cpi || '',
        enc: (enc || prev.enc || '').toLowerCase(),
        title: (name || '').replace(/\\s+/g, ' ').trim() || prev.title || '',
      });
    } catch (e) {}
  };
  const near = (el) => {
    try {
      let box = el;
      for (let i = 0; i < 6 && box; i++) {
        const t = (box.innerText || '').replace(/\\s+/g, ' ').trim();
        if (t && t.length >= 2 && t.length <= 60) return t;
        box = box.parentElement;
      }
    } catch (e) {}
    return '';
  };
  const docs = [document];
  try {
    document.querySelectorAll('iframe').forEach((f) => { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} });
  } catch (e) {}
  for (const d of docs) {
    try {
      d.querySelectorAll('a[href], area[href]').forEach((a) => put(a.getAttribute('href'), near(a)));
      d.querySelectorAll('[onclick]').forEach((el) => put(el.getAttribute('onclick'), near(el)));
      d.querySelectorAll('[data-courseid], [data-clazzid]').forEach((el) => {
        const cid = el.getAttribute('data-courseid') || '';
        const zid = el.getAttribute('data-clazzid') || '';
        if (cid && zid) put('?courseid=' + cid + '&clazzid=' + zid + '&cpi=' + (el.getAttribute('data-cpi') || ''), near(el));
      });
      d.querySelectorAll('input[value*="courseid"], [data-url*="courseid"]').forEach((el) => {
        put(el.getAttribute('value') || el.getAttribute('data-url'), near(el));
      });
    } catch (e) {}
  }
  return { href: location.href, title: document.title, courses: Array.from(out.values()) };
})()`;

// ---- 目录页：读取每个节点的任务点数字 ----
export const CATALOG = `(function () {
  var ns = document.querySelectorAll('.chapter_item[id^=cur]');
  if (!ns.length) return null;
  var out = [];
  for (var i = 0; i < ns.length; i++) {
    var n = ns[i];
    var sp = n.querySelector('.catalog_points_yi');
    var p = sp ? parseInt(String(sp.textContent).replace(/[^0-9]/g, '')) || 0 : 0;
    var nm = n.querySelector('.posCatalog_name');
    out.push([n.id.replace('cur', ''), p, nm ? String(nm.textContent).trim().replace(/[ \\t\\r\\n]+/g, ' ') : '']);
  }
  return out;
})()`;

// 目录页里隐藏的任务点总数（备用判断）
export const CATALOG_TOTAL = `(() => {
  const el = document.querySelector('input.knowledgeJobCount');
  return el ? Number(el.value) || 0 : 0;
})()`;

// ---- 卡片页：window.mArg.attachments ----
export const CARD_ARGS = `(function () {
  try {
    if (!window.mArg) return null;
    var a = window.mArg.attachments || [];
    return {
      count: a.length,
      list: a.map(function (x) {
        return {
          type: x.type || '',
          jobid: (x.property && x.property._jobid) || '',
          passed: x.isPassed ? 1 : 0,
          duration: Math.round(x.attDuration || 0),
          name: (x.property && (x.property.name || x.property.title)) || '',
        };
      }),
    };
  } catch (e) { return null; }
})()`;

// 当前页面各子框架概况（类型 + 下标）
export const FRAMES = `(function () {
  var f = document.querySelectorAll('iframe');
  var vid = [], pdf = [], work = [];
  for (var i = 0; i < f.length; i++) {
    var u = String(f[i].src || '');
    if (u.indexOf('modules/video') >= 0) vid.push(i);
    else if (u.indexOf('modules/pdf') >= 0) pdf.push(i);
    else if (u.indexOf('modules/work') >= 0) work.push(i);
  }
  return { total: f.length, vid: vid, pdf: pdf, work: work };
})()`;

export function vidNeedExpr(idx) {
  return `(function () {
    try {
      var f = document.querySelectorAll('iframe'); var a = [];
      for (var i = 0; i < f.length; i++) if ((f[i].src || '').indexOf('modules/video') >= 0) a.push(f[i]);
      var el = a[${idx}]; if (!el) return 'nof';
      var w = el.contentWindow;
      if (w && typeof w.isUnFinishJob === 'function') { try { return w.isUnFinishJob() ? 'need' : 'done'; } catch (e) {} }
      return 'unk';
    } catch (e) { return 'err'; }
  })()`;
}

export function vidGeoExpr(idx) {
  return `(function () {
    var f = document.querySelectorAll('iframe'); var a = [];
    for (var i = 0; i < f.length; i++) if ((f[i].src || '').indexOf('modules/video') >= 0) a.push(f[i]);
    var el = a[${idx}]; if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  })()`;
}

export function vstateExpr(idx) {
  return `(function () {
    try {
      var f = document.querySelectorAll('iframe'); var a = [];
      for (var i = 0; i < f.length; i++) if ((f[i].src || '').indexOf('modules/video') >= 0) a.push(f[i]);
      var el = a[${idx}]; if (!el) return 'nof';
      var d = el.contentDocument; if (!d) return 'nod';
      var v = d.querySelector('video'); if (!v) return 'nov';
      return [Math.round(v.currentTime * 10) / 10, Math.round((v.duration || 0) * 10) / 10, v.paused ? 1 : 0, v.ended ? 1 : 0, v.playbackRate];
    } catch (e) { return 'err'; }
  })()`;
}

// 关掉视频弹题/继续观看之类的挡路层
export const KILL = `(function () {
  var ts = ['继续学习', '继续观看', '继续播放', '我知道了', '知道了', '确定', '关闭', '跳过'];
  var n = 0;
  function go(doc) {
    try {
      doc.querySelectorAll('a,button,span,div').forEach(function (e) {
        var t = (e.textContent || '').trim();
        if (t && t.length <= 6 && ts.indexOf(t) >= 0 && e.offsetParent) { e.click(); n++; }
      });
    } catch (e) {}
  }
  go(document);
  try { document.querySelectorAll('iframe').forEach(function (f) { try { if (f.contentDocument) go(f.contentDocument); } catch (e) {} }); } catch (e) {}
  return n;
})()`;

export function pdfGeoExpr(idx) {
  return `(function () {
    var f = document.querySelectorAll('iframe'); var el = f[${idx}]; if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  })()`;
}

export function pdfMetricExpr(idx) {
  return `(function () {
    try {
      var f = document.querySelectorAll('iframe'); var el = f[${idx}]; if (!el) return null;
      var d = el.contentDocument; if (!d) return null;
      // 真实文档节点是三层嵌套：cards -> ananas/modules/pdf/index.html -> mooc-ans/screen/file（真正滚动的是最内层 HTML）
      // 逐层下钻，取滚动范围最大的那个文档；避免只取到第一层 0x0 的空壳 iframe。
      function best(doc, depth) {
        var se = doc.scrollingElement || doc.documentElement;
        var cur = se ? { st: Math.round(se.scrollTop || 0), sh: Math.round(se.scrollHeight || 0), ch: Math.round(se.clientHeight || 0) } : null;
        if (depth < 3) {
          var fs = [];
          try { fs = doc.querySelectorAll('iframe'); } catch (e) {}
          for (var i = 0; i < fs.length; i++) {
            var sub = null;
            try { sub = fs[i].contentDocument; } catch (e) {}
            if (!sub) continue;
            var got = best(sub, depth + 1);
            if (!got) continue;
            var curRange = cur ? (cur.sh - cur.ch) : -1;
            if ((got.sh - got.ch) > 60 && (got.sh - got.ch) > curRange) cur = got;
          }
        }
        return cur;
      }
      var got = best(d, 0);
      if (!got) return null;
      return [got.st, got.sh, got.ch];
    } catch (e) { return null; }
  })()`;
}

// 元素几何（顶层视口坐标），用于通用点击
export function boundsExpr(selectorJson) {
  return `(function () {
    var el = document.querySelector(${JSON.stringify(selectorJson)});
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  })()`;
}

// ---- 验证码（9010）----
export const CAPTCHA_STATE = `(function () {
  var u = location.href;
  var body = document.body ? (document.body.innerText || '') : '';
  var img = document.querySelector('#ccc') || document.querySelector('img[src*="processVerifyPng"]');
  return {
    inCaptcha: u.indexOf('antispider') >= 0 || body.indexOf('9010') >= 0 || !!img,
    href: u,
    hasInput: !!document.querySelector('#ucode'),
    hasImg: !!img,
    text: body.slice(0, 300),
  };
})()`;

// 用 canvas 把验证码图片画出来（同源，唯一可靠取图方式）
export const CAPTCHA_IMAGE = `(function () {
  try {
    var img = document.querySelector('#ccc') || document.querySelector('img[src*="processVerifyPng"]');
    if (!img) return { ok: false, err: 'no-img' };
    if (!img.complete || !img.naturalWidth) return { ok: false, err: 'img-not-loaded', w: img.naturalWidth || 0 };
    var c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { ok: true, data: c.toDataURL('image/png'), w: c.width, h: c.height, src: img.getAttribute('src') || '' };
  } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
})()`;

export function captchaFillExpr(code) {
  return `(function () {
    try {
      var inp = document.querySelector('#ucode');
      if (!inp) return { ok: false, err: 'no-input' };
      inp.value = ${JSON.stringify(String(code))};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      var form = inp.form || document.querySelector('form');
      var btn = document.querySelector('input[type=submit], button[type=submit], #verifyBtn, .verify-btn');
      if (btn) { btn.click(); return { ok: true, via: 'button' }; }
      if (form) { form.submit(); return { ok: true, via: 'form' }; }
      return { ok: false, err: 'no-submit' };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  })()`;
}

// ---- 测验（chapter quiz）----
// 递归找到含 .TiMu 的 document（可能是多层 iframe）
export const FIND_QUIZ = `(function () {
  var found = null;
  function walk(d, depth) {
    if (found || depth > 4) return;
    try { if (d.querySelectorAll('.TiMu').length) { found = d; return; } } catch (e) {}
    try {
      var fs = d.querySelectorAll('iframe');
      for (var i = 0; i < fs.length; i++) { try { if (fs[i].contentDocument) walk(fs[i].contentDocument, depth + 1); } catch (e) {} }
    } catch (e) {}
  }
  walk(window.__cxRoot || document, 0);
  return !!found;
})()`;

export const QUIZ_EXTRACT = `(function () {
  var target = null;
  function walk(d, depth) {
    if (target || depth > 4) return;
    try { if (d.querySelectorAll('.TiMu').length) { target = d; return; } } catch (e) {}
    try {
      var fs = d.querySelectorAll('iframe');
      for (var i = 0; i < fs.length; i++) { try { if (fs[i].contentDocument) walk(fs[i].contentDocument, depth + 1); } catch (e) {} }
    } catch (e) {}
  }
  walk(window.__cxRoot || document, 0);
  if (!target) return { ok: false, err: 'no-quiz' };

  // 字体反爬：收集 @font-face 里的 base64 字体
  var font = '';
  try {
    for (var s = 0; s < target.styleSheets.length; s++) {
      var ss = target.styleSheets[s];
      var rules = null;
      try { rules = ss.cssRules; } catch (e) { rules = null; }
      if (!rules) continue;
      for (var r = 0; r < rules.length; r++) {
        var cssText = rules[r].cssText || '';
        if (cssText.indexOf('font-cxsecret') >= 0 || cssText.indexOf('base64,') >= 0) {
          var m = cssText.match(/base64,([A-Za-z0-9+\\/=]+)/);
          if (m) { font = m[1]; break; }
        }
      }
      if (font) break;
    }
  } catch (e) {}

  function txt(el) { return el ? String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  var items = [];
  var nodes = target.querySelectorAll('.TiMu');
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var stem = txt(n.querySelector('.Zy_TItle')) || txt(n.querySelector('.mark_name'));
    var ans = n.querySelector('.Py_answer');
    var isReview = !!ans;
    var opts = [];
    var placeholder = /^(我的答案|正确答案|第[一二三四五六七八九十\\d]+空)[：:]/;
    var lis = n.querySelectorAll('ul.Zy_ulTop li, ul li');
    for (var j = 0; j < lis.length; j++) {
      var li = lis[j];
      if (ans && ans.contains(li)) continue;
      var letterEl = li.querySelector('i');
      var letter = letterEl ? String(letterEl.innerText || '').replace(/[^A-Za-z]/g, '') : '';
      var body = txt(li);
      if (!body) continue;
      if (body === stem) continue;
      if (placeholder.test(body)) continue;
      opts.push({ letter: letter || String.fromCharCode(65 + opts.length), text: body });
    }
    var inputs = n.querySelectorAll('input[type=text], textarea, [contenteditable=true]').length;
    var blanks = (String(stem || '').match(/____+/g) || []).length;
    var correct = [];
    if (ans) {
      var t = txt(ans);
      var mm = t.match(/正确答案[：:]\\s*([A-Za-z]+)/);
      if (mm) correct = mm[1].split('');
    }
    var type = 'single';
    if ((n.className || '').indexOf('multi') >= 0 || /多选题/.test(stem || '')) type = 'multi';
    else if (/【\\s*(填空题|填空|简答题|简答|论述题|名词解释|计算题|分析题)/.test(stem || '')) type = blanks > 0 ? 'fill' : 'text';
    else if (!opts.length) type = (inputs || blanks) ? 'fill' : 'text';
    items.push({ i: i, stem: stem, opts: opts, inputs: inputs, blanks: blanks, type: type, correct: correct, graded: isReview });
  }
  var bodyAll = txt(target.body || target.documentElement);
  var attempted = target.querySelectorAll('.Py_answer').length > 0 ||
    /(我的答案|得分[：:]|待批阅|待批改|已完成|提交成功|正确答案|再测|重做)/.test(bodyAll);
  return {
    ok: true,
    url: location.href,
    title: document.title,
    font: font,
    attempted: attempted,
    chars: (function () {
      var set = {};
      var all = txt(target.body || target.documentElement);
      for (var i = 0; i < all.length; i++) { var c = all[i]; if (c >= '\\u4e00' && c <= '\\u9fff') set[c] = 1; }
      return Object.keys(set).join('');
    })(),
    items: items,
    bodyTextSample: txt(target.body || target.documentElement).slice(0, 600),
  };
})()`;

// 已作答/已判分状态
export const QUIZ_STATE = `(function () {
  var target = null;
  function walk(d, depth) {
    if (target || depth > 4) return;
    try { if (d.querySelectorAll('.TiMu').length) { target = d; return; } } catch (e) {}
    try { var fs = d.querySelectorAll('iframe'); for (var i = 0; i < fs.length; i++) { try { if (fs[i].contentDocument) walk(fs[i].contentDocument, depth + 1); } catch (e) {} } } catch (e) {}
  }
  walk(window.__cxRoot || document, 0);
  if (!target) return { ok: false, err: 'no-quiz' };
  var graded = target.querySelectorAll('.Py_answer').length;
  var total = target.querySelectorAll('.TiMu').length;
  var body = (target.body || target.documentElement).innerText || '';
  return {
    ok: true,
    total: total,
    graded: graded,
    submitted: /已完成|提交成功|等待批阅/.test(body),
    text: body.slice(0, 400),
    buttons: (function () {
      var out = [];
      target.querySelectorAll('a,button,input[type=button]').forEach(function (el) {
        var t = String(el.innerText || el.value || '').replace(/\\s+/g, '');
        if (/提交|确认|继续/.test(t) && out.length < 12) out.push({ text: t.slice(0, 12), cls: String(el.className || '').slice(0, 40), visible: !!el.offsetParent });
      });
      return out;
    })(),
  };
})()`;

export function quizFillExpr(plan) {
  return `(function () {
    var plan = ${JSON.stringify(plan)};
    var target = null;
    function walk(d, depth) {
      if (target || depth > 4) return;
      try { if (d.querySelectorAll('.TiMu').length) { target = d; return; } } catch (e) {}
      try { var fs = d.querySelectorAll('iframe'); for (var i = 0; i < fs.length; i++) { try { if (fs[i].contentDocument) walk(fs[i].contentDocument, depth + 1); } catch (e) {} } } catch (e) {}
    }
    walk(window.__cxRoot || document, 0);
    if (!target) return { ok: false, err: 'no-quiz' };
    var nodes = target.querySelectorAll('.TiMu');
    var out = { clicked: 0, filled: 0, missing: [] };
    for (var p = 0; p < plan.length; p++) {
      var q = plan[p];
      var n = nodes[q.i];
      if (!n) { out.missing.push(q.i); continue; }
      if (q.letters && q.letters.length) {
        var lis = n.querySelectorAll('ul.Zy_ulTop li, ul li');
        var ans = n.querySelector('.Py_answer');
        for (var li = 0; li < lis.length; li++) {
          if (ans && ans.contains(lis[li])) continue;
          var letterEl = lis[li].querySelector('i');
          var letter = letterEl ? String(letterEl.innerText || '').replace(/[^A-Za-z]/g, '').toUpperCase() : String.fromCharCode(65 + li);
          var text = String(lis[li].innerText || '').replace(/\\s+/g, ' ').trim();
          for (var a = 0; a < q.letters.length; a++) {
            var want = String(q.letters[a]).toUpperCase();
            var matchByLetter = letter === want;
            var matchByText = q.texts && q.texts[a] && text.indexOf(String(q.texts[a]).slice(0, 12)) >= 0;
            if (matchByLetter || matchByText) { lis[li].click(); out.clicked++; }
          }
        }
      }
      var fillTexts = [];
      if (Array.isArray(q.texts) && q.texts.length) fillTexts = q.texts.map(function (x) { return String(x == null ? '' : x); });
      else if (q.text !== undefined && q.text !== null && String(q.text) !== '') fillTexts = String(q.text).split(/[；;\\n]+/);
      if (fillTexts.length && !(q.letters && q.letters.length)) {
        // 填空题：按空依次写；简答题：整段写进第一个输入框/编辑器
        var fields = [];
        var plain = n.querySelectorAll('input[type=text], textarea, [contenteditable=true]');
        for (var f = 0; f < plain.length; f++) fields.push(plain[f]);
        var ues = n.querySelectorAll('iframe');
        for (var u = 0; u < ues.length; u++) {
          try {
            var ed = ues[u].contentDocument && ues[u].contentDocument.querySelector('body[contenteditable], .edui-body-container');
            if (ed) fields.push(ed);
          } catch (e) {}
        }
        for (var k = 0; k < fields.length; k++) {
          var el = fields[k];
          var val = fillTexts[k] !== undefined ? fillTexts[k] : (fillTexts.length === 1 ? fillTexts[0] : '');
          if (!val) continue;
          try {
            if (el.getAttribute && el.getAttribute('contenteditable') === 'true') el.innerText = val;
            else el.value = val;
            ['input', 'change', 'blur'].forEach(function (t) { try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
            out.filled++;
          } catch (e) {}
        }
      }
    }
    return { ok: true, clicked: out.clicked, filled: out.filled, missing: out.missing };
  })()`;
}

// “修改答案”重做页（doHomeWorkNew?reEdit=2）：按 qid 找 window.answerEditor<qid>_<k> 编辑器填内容
export function quizReeditFillExpr(plan) {
  return `(function () {
    var plan = ${JSON.stringify(plan)};
    var out = { clicked: 0, filled: 0, missing: [], editors: 0 };
    var nodes = document.querySelectorAll('.TiMu');
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    for (var p = 0; p < plan.length; p++) {
      var q = plan[p];
      var n = nodes[q.i];
      if (!n) { out.missing.push(q.i); continue; }
      var qid = String(n.getAttribute('data') || n.id || '').replace(/^question/, '');
      // 选择题：点选项 li
      if (q.letters && q.letters.length) {
        var lis = n.querySelectorAll('ul.Zy_ulTop li, ul.Zy_ulTk li');
        for (var li = 0; li < lis.length; li++) {
          var letterEl = lis[li].querySelector('i');
          var letter = letterEl ? String(letterEl.innerText || '').replace(/[^A-Za-z]/g, '').toUpperCase() : String.fromCharCode(65 + li);
          if (q.letters.join('').toUpperCase().indexOf(letter) >= 0) { lis[li].click(); out.clicked++; }
        }
      }
      var texts = [];
      if (Array.isArray(q.texts) && q.texts.length) texts = q.texts.map(function (x) { return String(x == null ? '' : x); });
      else if (q.text != null && String(q.text) !== '') texts = String(q.text).split(/[；;\\n]+/);
      for (var k = 0; k < texts.length; k++) {
        var name = 'answerEditor' + qid + '_' + (k + 1);
        var ed = window[name];
        if (ed && typeof ed.setContent === 'function') {
          try {
            ed.setContent('<p>' + esc(texts[k]) + '</p>');
            if (typeof ed.sync === 'function') ed.sync();
            out.filled++; out.editors++;
            continue;
          } catch (e) {}
        }
        // 兜底：第 k 个 contenteditable / input
        var fields = n.querySelectorAll('input[type=text], textarea, [contenteditable=true]');
        if (fields[k]) {
          try {
            if (fields[k].getAttribute('contenteditable') === 'true') fields[k].innerText = texts[k];
            else fields[k].value = texts[k];
            ['input', 'change', 'blur'].forEach(function (t) { try { fields[k].dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
            out.filled++;
          } catch (e) {}
        }
      }
    }
    return { ok: true, clicked: out.clicked, filled: out.filled, missing: out.missing, editors: out.editors };
  })()`;
}

// 点“提交”按钮（章节测验：a.Btn_blue_1 / onclick 含 btnBlueSubmit）
export const QUIZ_SUBMIT = `(function () {
  var target = null;
  function walk(d, depth) {
    if (target || depth > 4) return;
    try { if (d.querySelectorAll('.TiMu').length) { target = d; return; } } catch (e) {}
    try { var fs = d.querySelectorAll('iframe'); for (var i = 0; i < fs.length; i++) { try { if (fs[i].contentDocument) walk(fs[i].contentDocument, depth + 1); } catch (e) {} } } catch (e) {}
  }
  walk(window.__cxRoot || document, 0);
  if (!target) return { ok: false, err: 'no-quiz' };
  var cands = target.querySelectorAll('a,button,input[type=button],div');
  for (var i = 0; i < cands.length; i++) {
    var el = cands[i];
    var oc = String(el.getAttribute('onclick') || '');
    var t = String(el.innerText || el.value || '').replace(/\\s+/g, '');
    if (oc.indexOf('btnBlueSubmit') >= 0 || /^(提交|提交答案|交卷)$/.test(t)) {
      if (!el.offsetParent) continue;
      el.click();
      return { ok: true, text: t.slice(0, 10), via: oc ? 'onclick' : 'text' };
    }
  }
  return { ok: false, err: 'no-submit-button' };
})()`;

// 提交后的二次确认（submitCheckTimes / popok / 文本是“确定”的按钮）
export const QUIZ_CONFIRM = `(function () {
  var target = null;
  function walk(d, depth) {
    if (target || depth > 4) return;
    try { if (d.querySelectorAll('.TiMu').length) { target = d; return; } } catch (e) {}
    try { var fs = d.querySelectorAll('iframe'); for (var i = 0; i < fs.length; i++) { try { if (fs[i].contentDocument) walk(fs[i].contentDocument, depth + 1); } catch (e) {} } } catch (e) {}
  }
  walk(window.__cxRoot || document, 0);
  var docs = [document];
  if (target) docs.push(target);
  for (var k = 0; k < docs.length; k++) {
    var d = docs[k];
    try {
      var a = d.querySelector('a[onclick*=submitCheckTimes]');
      if (a && a.offsetParent) { a.click(); return { ok: true, via: 'submitCheckTimes' }; }
    } catch (e) {}
    try {
      var pop = d.getElementById('popok');
      if (pop && pop.offsetParent) { pop.click(); return { ok: true, via: 'popok' }; }
    } catch (e) {}
    try {
      var all = d.querySelectorAll('a,button,span,div');
      for (var i = 0; i < all.length; i++) {
        var t = String(all[i].innerText || '').replace(/\\s+/g, '');
        if (/^(确定|确认|提交|是|继续答题|关闭)$/.test(t) && all[i].offsetParent) { all[i].click(); return { ok: true, via: 'text', text: t }; }
      }
    } catch (e) {}
  }
  return { ok: false, err: 'no-confirm' };
})()`;

// 通用：从当前页（含同源 iframe）收集 @font-face 内联字体 base64 与可见文字的汉字集合
export const FONT_HARVEST = `(function () {
  var font = '';
  var docs = [document];
  try { document.querySelectorAll('iframe').forEach(function (f) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} }); } catch (e) {}
  for (var k = 0; k < docs.length && !font; k++) {
    var d = docs[k];
    try {
      for (var s = 0; s < d.styleSheets.length; s++) {
        var rules = null;
        try { rules = d.styleSheets[s].cssRules; } catch (e) { rules = null; }
        if (!rules) continue;
        for (var r = 0; r < rules.length; r++) {
          var cssText = rules[r].cssText || '';
          if (cssText.indexOf('font-cxsecret') >= 0) {
            var m = cssText.match(/base64,([A-Za-z0-9+\\/=]+)/);
            if (m) { font = m[1]; break; }
          }
        }
        if (font) break;
      }
    } catch (e) {}
  }
  var set = {};
  for (var i = 0; i < docs.length; i++) {
    try {
      var all = (docs[i].body || docs[i].documentElement).innerText || '';
      for (var j = 0; j < all.length; j++) { var c = all[j]; if (c >= '\\u4e00' && c <= '\\u9fff') set[c] = 1; }
    } catch (e) {}
  }
  return { font: font, chars: Object.keys(set).join('') };
})()`;

// ---- 作业 ----
// 真实作业列表项（2026-11 实测）：<li onclick="goTask(this);" data="https://mooc1.../mooc2/work/task?...">
//   URL 在裸 data 属性里，li 内没有 <a href>；aria-label="标题 ; 未交"。
export const WORK_ENC = `(function () {
  var v = '';
  // 优先精确的 #workEnc（真实页面里它是作业列表专用 enc，和课程 enc 不同；顺序必须是精确优先，
  // 否则 input[id*=enc] 会先匹配到别的 enc，拼出来的作业列表会显示“无权限的操作！”）
  var exact = [document.querySelector('input#workEnc'), document.querySelector('input[name=workEnc]'), document.querySelector('#workEnc'), document.querySelector('input#enc'), document.querySelector('input[name=enc]')];
  for (var k = 0; k < exact.length; k++) {
    var el = exact[k];
    if (!el) continue;
    var val = String(el.value || el.getAttribute('value') || '');
    if (/^[0-9a-fA-F]{8,}$/.test(val)) { v = val; break; }
  }
  if (!v) {
    var cands = document.querySelectorAll('input[id*=enc], input[name*=enc]');
    for (var i = 0; i < cands.length; i++) {
      var v2 = String(cands[i].value || cands[i].getAttribute('value') || '');
      if (/^[0-9a-fA-F]{8,}$/.test(v2)) { v = v2; break; }
    }
  }
  if (!v) {
    var a = document.querySelector('a[href*="work/list"], a[href*="/work/"]');
    if (a) {
      var m = String(a.getAttribute('href') || '').match(/[?&]enc=([0-9a-fA-F]{8,})/);
      if (m) v = m[1];
    }
  }
  return { enc: v, href: location.href };
})()`;

export const WORK_LIST = `(function () {
  function txt(el) { return el ? String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  var out = [];
  try {
    var lis = document.querySelectorAll('li[onclick*=goTask], li[onclick*=workTask], .work-list li, ul.ulDiv li, li[aria-label]');
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      var oc = String(li.getAttribute('onclick') || '');
      var url = String(li.getAttribute('data') || '').trim();
      if (!url) { var a = li.querySelector('a[href]'); if (a) url = String(a.getAttribute('href') || '').trim(); }
      if (oc.indexOf('goTask') < 0 && !/\\/work\\//.test(url)) continue;
      if (/^\\/[^\\/]/.test(url)) url = 'https://mooc1.chaoxing.com' + url;
      var t = txt(li);
      var aria = String(li.getAttribute('aria-label') || '').trim();
      var status = '';
      var sm = (aria + ' ' + t).match(/(未交|待批阅|已完成|已提交|已批改|已过期|未开始|未完成)/);
      if (sm) status = sm[1];
      var title = aria ? aria.split(';')[0].trim() : t.replace(/\\s*[;；]\\s*(未交|待批阅|已完成|已提交|已批改|已过期|未开始|未完成).*$/, '').trim();
      out.push({ i: out.length, url: url, title: title.slice(0, 100), status: status, onclick: oc.slice(0, 200), text: t.slice(0, 300) });
    }
  } catch (e) {}
  var body = document.body ? (document.body.innerText || '') : '';
  return { href: location.href, items: out, text: body.slice(0, 1800), frames: document.querySelectorAll('iframe').length };
})()`;

// 真实作答页（2026-11 实测）：题目容器是 div.questionLi（id="question<qid>" data="<qid>" typename="单选题|多选题|填空题|判断题|简答题"）；
// 注意 div#fanyaMarking 也带 TiMu class，是整个页面的外壳，必须排除。选项是 div.answerBg（点它会触发 addChoice/addMultipleChoice），
// 字母在 span.num_option（多选 span.num_option_dx）或 span[data="A"]。简答：textarea#answer<qid> 或 UEditor iframe#answerEditor<qid>1。
export const WORK_EXTRACT = `(function () {
  function txt(el) { return el ? String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  function letterOf(box, idx) {
    var el = box.querySelector('.num_option, .num_option_dx') || box.querySelector('i') || box.querySelector('span[data]');
    // 判断题的 span[data] 是 "true"/"false"，真正字母在 innerText（A/B）里，必须先看文字
    var label = el ? String(el.innerText || el.textContent || '').replace(/\\s+/g, '') : '';
    if (/^[A-Za-z]$/.test(label)) return label.toUpperCase();
    var raw = el ? String(el.getAttribute ? (el.getAttribute('data') || '') : '') : '';
    raw = raw.replace(/\\s+/g, '');
    if (/^[A-Za-z]$/.test(raw)) return raw.toUpperCase();
    return String.fromCharCode(65 + idx);
  }
  var nodes = Array.prototype.slice.call(document.querySelectorAll('div.questionLi'));
  var viewMode = false;
  if (!nodes.length) { nodes = Array.prototype.slice.call(document.querySelectorAll('div.mark_item')); viewMode = true; }
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.id === 'fanyaMarking') continue;
    var qid = String(n.getAttribute('data') || n.getAttribute('data-qid') || n.id || '').replace(/^question/, '');
    var typename = String(n.getAttribute('typename') || '').trim();
    var stemEl = n.querySelector('.mark_name, .Zy_TItle, h3, .questionTitle');
    var stem = txt(stemEl) || txt(n).slice(0, 300);
    var opts = [];
    var boxes = n.querySelectorAll('div.answerBg');
    for (var b = 0; b < boxes.length; b++) {
      var box = boxes[b];
      var l = letterOf(box, b);
      var body = box.querySelector('.answer_p, p') || box;
      var tx = txt(body) || txt(box);
      opts.push({ letter: l, text: tx.slice(0, 200) });
    }
    var tas = n.querySelectorAll('textarea');
    var ues = n.querySelectorAll('iframe[id*=ueditor], iframe');
    var type = 'unknown';
    if (typename.indexOf('多选') >= 0 || String(n.className || '').indexOf('multi') >= 0) type = 'multi';
    else if (typename) {
      if (typename.indexOf('填空') >= 0 || typename.indexOf('简答') >= 0 || typename.indexOf('论述') >= 0) type = 'text';
      else type = opts.length ? 'single' : 'text';
    } else {
      type = opts.length ? 'single' : ((tas.length || ues.length) ? 'text' : 'unknown');
    }
    var imgs = n.querySelectorAll('img').length;
    var short = '';
    try { var sn = n.querySelector('.Py_answer, .answer_p'); if (sn) short = txt(sn).slice(0, 120); } catch (e) {}
    out.push({ i: out.length, qid: qid, typename: typename, stem: stem, opts: opts, inputs: tas.length, editors: ues.length, imgs: imgs, type: type, view: viewMode, short: short });
  }
  return { ok: nodes.length > 0, url: location.href, count: nodes.length, items: out, bodyText: txt(document.body).slice(0, 700) };
})()`;

export function workFillExpr(plan) {
  return `(function () {
    var plan = ${JSON.stringify(plan)};
    var out = { ok: true, clicked: 0, filled: 0, missing: [], details: [] };
    var containers = Array.prototype.slice.call(document.querySelectorAll('div.questionLi'));
    if (!containers.length) containers = Array.prototype.slice.call(document.querySelectorAll('div.mark_item'));
    function txt(el) { return el ? String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
    function byQid(qid) {
      if (!qid) return null;
      return (
        document.querySelector('div.questionLi[data="' + qid + '"]') ||
        document.getElementById('question' + qid) ||
        document.querySelector('[id="question' + qid + '"]')
      );
    }
    for (var p = 0; p < plan.length; p++) {
      var q = plan[p];
      var scope = byQid(q.qid) || containers[q.i];
      if (!scope) { out.missing.push(q.i); continue; }
      var qid = String(scope.getAttribute('data') || scope.id || '').replace(/^question/, '');
      var hit = [];
      if (q.letters && q.letters.length) {
        var boxes = scope.querySelectorAll('div.answerBg');
        for (var b = 0; b < boxes.length; b++) {
          var el = boxes[b].querySelector('.num_option, .num_option_dx');
          if (!el) el = boxes[b].querySelector('i');
          var label = el ? String(el.innerText || el.textContent || '').replace(/\\s+/g, '') : '';
          var raw = el ? String(el.getAttribute('data') == null ? '' : el.getAttribute('data')).trim() : '';
          var letter = '';
          // 判断题的 span[data] 是 "true"/"false"，真正字母在 innerText（A/B）里，必须先看文字
          if (/^[A-Za-z]$/.test(label)) letter = label.toUpperCase();
          else if (/^[A-Za-z]$/.test(raw)) letter = raw.toUpperCase();
          else letter = String.fromCharCode(65 + b);
          if (q.letters.indexOf(letter) >= 0) {
            var tag = String(boxes[b].getAttribute('onclick') || '') || 'none';
            boxes[b].click();
            out.clicked++;
            hit.push(letter + '@' + (tag.indexOf('addMultipleChoice') >= 0 ? 'multi' : 'single'));
          }
        }
      }
      if (q.text) {
        var ok = false;
        try {
          if (window.UE && qid) {
            var ed = UE.getEditor('answerEditor' + qid + '1') || UE.getEditor('answer' + qid);
            if (ed && ed.setContent) {
              ed.setContent('<p>' + String(q.text).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>');
              try { ed.sync(); } catch (e) {}
              ok = true;
            }
          }
        } catch (e) {}
        if (!ok) {
          var ta = scope.querySelector('textarea[id^=answer], textarea');
          if (ta) {
            ta.value = String(q.text);
            ['input', 'change', 'blur'].forEach(function (t) { try { ta.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
            ok = true;
          }
        }
        if (ok) out.filled++;
      }
      out.details.push({ i: q.i, qid: qid, hit: hit, text: !!q.text, answered: (function () {
        var hid = qid ? document.getElementById('answer' + qid) : null;
        var v = hid ? String(hid.value || '').trim() : '';
        if (v) return v.slice(0, 8);
        var ta = scope.querySelector('textarea[id^=answer]');
        if (ta && String(ta.value || '').trim()) return 'textarea';
        return '';
      })() });
    }
    return out;
  })()`;
}

// 真实提交按钮：#submitFocus a.completeBtn（onclick="submitValidate();"），旁边是「暂时保存」(saveWork)。
// a.jb_btn 命中的全是隐藏弹层按钮（知道了/确定/取消），不能优先用。
export const WORK_SUBMIT = `(function () {
  function vis(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }
  var el = document.querySelector('#submitFocus a.completeBtn, a.completeBtn, a[onclick*=submitValidate]');
  if (!vis(el)) {
    el = null;
    var all = document.querySelectorAll('a,button,input[type=button]');
    for (var i = 0; i < all.length; i++) {
      var t = String(all[i].innerText || all[i].value || '').replace(/\\s+/g, '');
      if (/^(提交|提交作业)$/.test(t) && vis(all[i])) { el = all[i]; break; }
    }
  }
  if (!el) return { ok: false, err: 'no-submit' };
  el.click();
  return { ok: true, text: String(el.innerText || el.value || '').replace(/\\s+/g, '').slice(0, 10), id: String(el.id || ''), cls: String(el.className || '').slice(0, 60) };
})()`;

// 提交后可能弹出图片验证码（#workVerifyImg，不是 9010）；也有提交次数提示 #addTimes。
export const WORK_STATE = `(function () {
  function vis(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }
  var body = document.body ? (document.body.innerText || '') : '';
  var img = document.querySelector('#workVerifyImg, img[id*=verify], img[src*=verifyCode]');
  var times = document.querySelector('#addTimes, .addTimes');
  var href = location.href;
  var pop = document.getElementById('workpop');
  var popstyle = pop ? window.getComputedStyle(pop) : null;
  var popok = document.getElementById('popok');
  return {
    href: href,
    success: href.indexOf('/work/prompt') >= 0 || /提交成功|等待教师批阅|作业已提交|已提交/.test(body),
    verify: !!(img && (img.offsetWidth || img.offsetHeight)),
    verifyNeed: /请输入验证码|验证码/.test(body) && !!(img && (img.offsetWidth || img.offsetHeight)),
    pop: {
      visible: !!(pop && popstyle && popstyle.display !== 'none' && (pop.offsetWidth || pop.offsetHeight)),
      text: pop ? String((document.getElementById('popcontent') || {}).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160) : '',
      okText: popok ? String(popok.innerText || '').trim().slice(0, 12) : '',
      okVisible: !!(popok && vis(popok)),
    },
    times: times ? String(times.innerText || times.value || '').trim() : '',
    text: body.slice(0, 500),
    buttons: (function () {
      var out = [];
      document.querySelectorAll('a,button').forEach(function (el) {
        if (/确定|知道了|关闭|返回|继续/.test(String(el.innerText || '')) && out.length < 8) out.push(String(el.innerText).replace(/\\s+/g, '').slice(0, 8));
      });
      return out;
    })(),
  };
})()`;

// 提交确认弹层：#workpop（提示文字 + #popok/#popno），ready2Submit 会用 workPop("确认提交？", "提交", "取消", cb)
// —— 确认按钮文字是「提交」不是「确定」，必须按 id 点，不能按文字匹配。
export const WORK_POP = `(function () {
  function vis(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }
  var pop = document.getElementById('workpop');
  var ok = document.getElementById('popok');
  var no = document.getElementById('popno');
  var style = pop ? window.getComputedStyle(pop) : null;
  var visible = !!(pop && style && style.display !== 'none' && (pop.offsetWidth || pop.offsetHeight || pop.getClientRects().length));
  return {
    visible: visible,
    text: pop ? String((document.getElementById('popcontent') || {}).innerText || pop.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160) : '',
    okText: ok ? String(ok.innerText || '').trim().slice(0, 12) : '',
    okVisible: !!(ok && vis(ok)),
    noText: no ? String(no.innerText || '').trim().slice(0, 12) : '',
  };
})()`;

export function workPopConfirmExpr() {
  return `(function () {
    var ok = document.getElementById('popok');
    if (!ok) return { ok: false, reason: 'no-popok' };
    var t = String(ok.innerText || '').trim();
    ok.click();
    return { ok: true, text: t };
  })()`;
}

export const WORK_CAPTCHA_IMAGE = `(function () {
  var img = document.querySelector('#workVerifyImg, img[id*=verify], img[src*=verifyCode]');
  if (!img) return { ok: false, reason: 'no-image' };
  try {
    var w = img.naturalWidth || img.width || 120, h = img.naturalHeight || img.height || 40;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return { ok: true, data: c.toDataURL('image/png'), src: String(img.getAttribute('src') || '') };
  } catch (e) {
    return { ok: false, reason: 'canvas', err: String(e && e.message), src: String(img.getAttribute('src') || '') };
  }
})()`;

export function workVerifyFillExpr(code) {
  return `(function () {
    var code = ${JSON.stringify(String(code || ''))};
    function vis(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }
    var cands = document.querySelectorAll('#workVerifyCode, input[name*=verify], input[id*=verify], input[name*=code], input[id*=code], input[maxlength="4"], input[maxlength="6"]');
    var el = null;
    for (var i = 0; i < cands.length; i++) {
      if (vis(cands[i]) && String(cands[i].type || '').toLowerCase() !== 'hidden') { el = cands[i]; break; }
    }
    if (!el) return { ok: false, reason: 'no-input' };
    el.value = code;
    ['input', 'change', 'blur'].forEach(function (t) { try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
    var btn = null;
    var all = document.querySelectorAll('a,button,input[type=button]');
    for (var j = 0; j < all.length; j++) {
      var tx = String(all[j].innerText || all[j].value || '').replace(/\\s+/g, '');
      if (/^(确定|确认|提交|提交作业)$/.test(tx) && vis(all[j])) { btn = all[j]; break; }
    }
    if (btn) { btn.click(); return { ok: true, id: String(el.id || el.name || ''), submitted: true, btn: String(btn.innerText || btn.value || '').slice(0, 8) }; }
    return { ok: true, id: String(el.id || el.name || ''), submitted: false };
  })()`;
}
