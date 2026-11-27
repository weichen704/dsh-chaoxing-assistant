// 页面级动作：视频播放、文档滚动、框架探测。
import { sleep, truncate } from './util.mjs';
import {
  FRAMES,
  vidNeedExpr,
  vidGeoExpr,
  vstateExpr,
  pdfGeoExpr,
  pdfMetricExpr,
  pptPageExpr,
  KILL,
} from './extract.mjs';

export async function frames(page) {
  try {
    return await page.evaluate(FRAMES);
  } catch {
    return { total: 0, vid: [], pdf: [], work: [] };
  }
}

/** 等页面里的子框架渲染出来（视频/文档 iframe 常常晚于导航完成） */
export async function waitFrames(page, { timeoutMs = 20000, minTotal = 1, log = () => {} } = {}) {
  const t0 = Date.now();
  let f = await frames(page);
  while (Date.now() - t0 < timeoutMs && (!f || (f.total || 0) < minTotal)) {
    await sleep(1000);
    f = await frames(page);
  }
  log({ ev: 'frames', total: f ? f.total : -1, vid: f ? f.vid : [], pdf: f ? f.pdf : [] });
  return f;
}

export async function vidNeed(page, idx) {
  try {
    return await page.evaluate(vidNeedExpr(idx));
  } catch {
    return 'err';
  }
}

export async function vstate(page, idx) {
  try {
    return await page.evaluate(vstateExpr(idx));
  } catch {
    return 'err';
  }
}

async function vidGeo(page, idx) {
  try {
    return await page.evaluate(vidGeoExpr(idx));
  } catch {
    return null;
  }
}

/**
 * 播放第 idx 个视频框架。
 * 计点三要素：真实鼠标点击启动、1x 倍速、播到结束（ended 或 t>=d-2）。
 * 返回 {k:'fin'|'already'|'stuck'|'timeout'|'nogeo'|'nof', d, t, sec, clicks}
 */
export async function playVideo(page, idx, budgetSec = 900, { log = () => {}, onTick, guard } = {}) {
  let g = await vidGeo(page, idx);
  if (!g) return { k: 'nogeo' };
  let st = await vstate(page, idx);
  if (Array.isArray(st) && st[3]) return { k: 'already', d: st[1] };

  const t0 = Date.now();
  let clicks = 0;
  let stuck = 0;
  let zeroDur = 0;
  let last = -1;
  while (Date.now() - t0 < budgetSec * 1000) {
    // 每轮先看有没有人工验证（人脸/活体/实人认证）：命中立即收手，交给上层停机
    if (guard) {
      const hit = await guard().catch(() => null);
      if (hit && hit.hit) return { k: 'human', hit, d: 0, t: 0, clicks };
    }
    st = await vstate(page, idx);
    if (typeof st === 'string') {
      if (st === 'nof') return { k: 'nof' };
    } else if (Array.isArray(st)) {
      const [t, d, paused, ended] = st;
      if (onTick) onTick({ t, d, paused, ended, sec: Math.round((Date.now() - t0) / 1000) });
      if (ended || (d > 0 && t >= d - 2)) {
        return { k: 'fin', d, t, sec: Math.round((Date.now() - t0) / 1000), clicks };
      }
      // 拿不到 duration（d=0）且一直暂停：多半是视频源加载不出来（私有/加密/格式不支持），
      // 再狂点也没用，40 秒左右就放弃，别在一个节点上耗好几分钟。
      if (!(d > 0)) zeroDur++;
      else zeroDur = 0;
      if (zeroDur >= 8) {
        log({ ev: 'video-noduration', idx, t, d, clicks, sec: Math.round((Date.now() - t0) / 1000) });
        return { k: 'nof', d, t, clicks, reason: 'duration-0' };
      }
      if (paused === 1 || t <= 0.2 || t === last) stuck++;
      else stuck = 0;
      last = t;
      if (stuck >= 2) {
        await page.evaluate(KILL).catch(() => {});
        g = await vidGeo(page, idx);
        if (g) await page.click(g[0], g[1]).catch(() => {});
        clicks++;
        if (clicks > (d > 0 ? 14 : 5)) return { k: 'stuck', d, t, clicks };
        stuck = 0;
      }
      if (paused === 1 && t <= 0.2) await sleep(2000);
      else await sleep(5000);
    } else {
      await sleep(3000);
    }
  }
  st = await vstate(page, idx);
  return { k: 'timeout', d: Array.isArray(st) ? st[1] : 0, t: Array.isArray(st) ? st[0] : 0 };
}

/**
 * 滚动第 idx 个文档框架到底（真实滚轮事件）。
 * 返回 {k:'rolled'|'already'|'nogeo', sh, st, wheels}
 */
export async function rollDoc(page, idx, { log = () => {}, maxWheels = 52, step = 760, gapMs = 680, maxMs = 90000 } = {}) {
  const t0 = Date.now();
  // 内层阅读器偶尔会卡住（页面无响应时每次 evaluate 都要等到 20s 超时），
  // 所以这里给单次取度量设短超时，并在总耗时超预算时果断放弃，避免一个文档节点吃掉好几分钟。
  const metric = async () => {
    try {
      return await page.evaluate(pdfMetricExpr(idx), { timeoutMs: 2500 });
    } catch {
      return null;
    }
  };
  let g = await page.evaluate(pdfGeoExpr(idx)).catch(() => null);
  if (!g) return { k: 'nogeo' };
  let m = await metric();
  let st = m ? m[0] : 0;
  let sh = m ? m[1] : 0;
  const ch = m ? m[2] : 0;
  if (sh > 0 && sh > ch + 100 && st + ch >= sh - 6) return { k: 'already', sh, st };

  let wheels = 0;
  let miss = 0;
  let sawMetric = !!(m && (sh > 0 || ch > 0));
  for (let i = 0; i < maxWheels; i++) {
    if (Date.now() - t0 > maxMs) {
      log({ ev: 'doc-rolled', idx, wheels, sh, st, metric: sawMetric, k: 'timeout' });
      return { k: sawMetric ? 'rolled' : 'nogeo', sh, st, wheels, timeout: true };
    }
    // 画面可能滚动后 iframe 位置变化，定期重取坐标
    if (i % 6 === 0) {
      const g2 = await page.evaluate(pdfGeoExpr(idx)).catch(() => null);
      if (g2) g = g2;
    }
    await page.wheel(g[0], g[1], step).catch(() => {});
    wheels++;
    await sleep(gapMs);
    m = await metric();
    if (m) {
      miss = 0;
      st = m[0];
      sh = m[1];
      if (sh > 0 || (m[2] || 0) > 0) sawMetric = true;
      if (sh > (m[2] || 0) + 50 && st + (m[2] || 0) >= sh - 6) break;
    } else if (++miss >= 4) {
      // 连续读不到度量：页面大概率是无响应的错误页，别继续空转
      log({ ev: 'doc-rolled', idx, wheels, sh, st, metric: sawMetric, k: 'nometric' });
      return { k: 'nogeo', sh, st, wheels };
    }
  }
  await sleep(4500); // 等平台上报阅读进度
  log({ ev: 'doc-rolled', idx, wheels, sh, st, metric: sawMetric });
  // 读不到内层滚动容器（sh/st 全 0）：PPT/PDF 是翻页式阅读器，滚动条不存在，
  // 改用「下一页」按钮一页页翻，翻到页码不再变化为止。
  if (!sawMetric) {
    let turns = 0;
    let lastPage = '';
    let same = 0;
    for (let i = 0; i < 90; i++) {
      if (Date.now() - t0 > maxMs * 3) break;
      let r = null;
      try { r = await page.evaluate(pptPageExpr(idx), { timeoutMs: 2500 }); } catch { r = null; }
      if (!r || !r.ok) break;
      turns++;
      await sleep(900);
      if (r.page && r.page === lastPage) { same++; if (same >= 3) break; } else same = 0;
      lastPage = r.page || '';
    }
    await sleep(4000);
    log({ ev: 'doc-ppted', idx, turns, page: lastPage });
    return { k: turns > 0 ? 'pptpaged' : 'nogeo', sh, st, wheels, turns, page: lastPage };
  }
  return { k: 'rolled', sh, st, wheels };
}

/** 当前页面是否还有视频/文档框架，用于判断是否需要继续 */
export async function describeFrames(page) {
  const f = await frames(page);
  return f && f.total ? `iframe×${f.total}（video ${f.vid.length} / pdf ${f.pdf.length} / work ${f.work.length}）` : '无子框架';
}

export function summarizeResult(r) {
  if (!r) return '';
  return truncate(JSON.stringify(r), 160);
}
