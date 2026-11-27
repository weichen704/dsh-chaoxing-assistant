// 人工验证（人脸/活体/实人认证）识别：命中即硬停，绝不尝试绕过、绝不自动点击。
// 借鉴 dsh-cx-learn：把「人机验证」从普通弹窗里区分出来，误报要少、命中要狠。
import { truncate } from './util.mjs';

// 明确是「要求本人做动作」的 UI 文案，出现在课程正文里的概率极低
const STRONG = [
  /请正对摄像头/,
  /请完成人脸识别/,
  /请?进行人脸识别/,
  /开始人脸识别/,
  /人脸识别失败/,
  /活体检测失败/,
  /请?进行活体检测/,
  /实人认证/,
  /人脸核验/,
  /刷脸验证/,
  /请勿遮挡(面部|脸部|摄像头)/,
  /请?(眨眼|张嘴|摇头|点头).{0,12}(验证|识别)/,
  /人脸识别(中|进行中|已开启)/,
];
const FACE = /(人脸|面部|刷脸|活体)/;
// 只认"验证/采集"语境，避免「第 1 章 人脸识别概述」这类目录标题误停
const VERIFY_CTX = /(验证|核验|认证|检测|采集|摄像头|面部|刷脸|正对|眨眼|张嘴)/;
// 课程正文里常出现「人脸识别技术」这类词，必须带上动作/祈使语境才算
const BODY_STRONG = /(请|需|须|立即|重新)?(完成|进行|开始|通过)?(人脸|面部|刷脸)(识别|验证|核验|认证)/;

/** 单个文本片段是否属于人工验证提示。where: body|dialog|button|frame */
export function detectHumanVerificationText(text, { where = 'body', url = '' } = {}) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return { hit: false };
  for (const re of STRONG) {
    if (where !== 'body' || s.length <= 240) {
      const m = s.match(re);
      if (m) return { hit: true, label: m[0], where, url };
    }
  }
  if (FACE.test(s) && VERIFY_CTX.test(s)) {
    if (where === 'dialog' || where === 'button') {
      return { hit: true, label: '人脸/活体验证', where, url };
    }
    if (where === 'frame' && s.length <= 240) {
      return { hit: true, label: '人脸/活体验证', where, url };
    }
    if (where === 'body' && s.length <= 240 && /face|verify|realname|shiming|renzheng/i.test(url)) {
      return { hit: true, label: '人脸/活体验证', where, url };
    }
  }
  if (where === 'body' && s.length <= 600 && BODY_STRONG.test(s) && /face|verify|realname|shiming|renzheng/i.test(url)) {
    return { hit: true, label: '人脸核验页', where, url };
  }
  return { hit: false };
}

/** 把页面探针结果分类（纯函数，便于单测）。raw: {url, dialogs, buttons, frames, body} */
export function classifyHumanScan(raw) {
  if (!raw) return { hit: false };
  const url = String(raw.url || '');
  const dialogs = Array.isArray(raw.dialogs) ? raw.dialogs : [];
  const buttons = Array.isArray(raw.buttons) ? raw.buttons : [];
  const frames = Array.isArray(raw.frames) ? raw.frames : [];
  const body = String(raw.body || '');
  for (const t of dialogs) {
    const r = detectHumanVerificationText(t, { where: 'dialog', url });
    if (r.hit) return r;
  }
  for (const t of frames) {
    const r = detectHumanVerificationText(t, { where: 'frame', url });
    if (r.hit) return r;
  }
  for (const t of buttons) {
    const r = detectHumanVerificationText(t, { where: 'button', url });
    if (r.hit) return r;
  }
  return detectHumanVerificationText(body, { where: 'body', url });
}

// 页面探针：只收集文本，不做判断（判断放在 Node 侧纯函数里，方便回归测试）。
export const HUMAN_SCAN_EXPR = `(function () {
  function txt(el) {
    try { return String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim(); } catch (e) { return ''; }
  }
  var dialogs = [];
  var buttons = [];
  var frames = [];
  var dsels = ['.mask', '.popup', '.dialog', '.modal', '[role=dialog]', '.layui-layer', '.aui_state_focus',
    '.colorbox', '.face-box', '.faceDetect', '#faceDiv', '.verify-box', '.captcha-box'];
  for (var s = 0; s < dsels.length; s++) {
    var els = [];
    try { els = document.querySelectorAll(dsels[s]); } catch (e) { els = []; }
    for (var i = 0; i < els.length && dialogs.length < 12; i++) {
      var t = txt(els[i]);
      if (t && els[i].offsetParent !== null) dialogs.push(t.slice(0, 300));
    }
  }
  var bs = [];
  try { bs = document.querySelectorAll('a,button,[role=button],input[type=button],span.btn'); } catch (e) { bs = []; }
  for (var b = 0; b < bs.length && buttons.length < 40; b++) {
    var bt = txt(bs[b]) || String((bs[b] && bs[b].value) || '');
    if (bt && bt.length <= 16 && bs[b].offsetParent !== null) buttons.push(bt.trim());
  }
  try {
    var fs = document.querySelectorAll('iframe');
    for (var f = 0; f < fs.length && frames.length < 8; f++) {
      var d = null;
      try { d = fs[f].contentDocument; } catch (e) { d = null; }
      if (!d || !d.body) continue;
      var ft = txt(d.body);
      if (ft && /(人脸|面部|刷脸|活体)/.test(ft)) frames.push(ft.slice(0, 300));
    }
  } catch (e) {}
  var body = '';
  try { body = txt(document.body).slice(0, 1200); } catch (e) { body = ''; }
  return { url: String(location.href || ''), dialogs: dialogs, buttons: buttons, frames: frames, body: body };
})()`;

/** 扫当前页（含同源 iframe）是否出现人工验证。 */
export async function scanHumanVerification(page) {
  const raw = await page.evaluate(HUMAN_SCAN_EXPR).catch(() => null);
  const r = classifyHumanScan(raw);
  if (r.hit) r.url = truncate(r.url || '', 140);
  return r;
}
