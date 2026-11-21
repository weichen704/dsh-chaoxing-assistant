// 屏幕 OCR 驱动层：截图 -> RapidOCR -> 文本 + 窗口内坐标 -> 点击
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OCR_SCRIPT = path.join(here, '..', 'desktop', 'ocr.py');

const DEFAULT_PY = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');

export class Screen {
  constructor({ driver, python = process.env.CHAOXING_PYTHON || DEFAULT_PY, log = () => {}, tmpDir }) {
    this.driver = driver;
    this.python = python;
    this.log = log;
    this.tmpDir = tmpDir || path.join(os.tmpdir(), 'dsh-chaoxing-shots');
    this.last = { at: 0, items: [], shot: '' };
  }

  async shot(file) {
    const out = file || path.join(this.tmpDir, `screen-${Date.now()}.png`);
    const r = await this.driver.shot(out);
    return r && r.out ? r.out : out;
  }

  async ocr(file) {
    const shot = await this.shot(file);
    const r = spawnSync(this.python, [OCR_SCRIPT, shot], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (r.status !== 0 || !r.stdout) throw new Error('OCR 失败：' + String(r.stderr || r.error || '').slice(0, 300));
    let items;
    try {
      items = JSON.parse(r.stdout.trim());
    } catch {
      throw new Error('OCR 输出不是 JSON：' + r.stdout.slice(0, 200));
    }
    this.last = { at: Date.now(), items, shot };
    return items;
  }

  /** 刷新一次；返回 items */
  async refresh() {
    const rect = await this.driver.rect();
    const items = await this.ocr();
    this.rect = rect;
    return items;
  }

  find(re, { index = 0, minScore = 0.5 } = {}) {
    const items = (this.last.items || []).filter((i) => i.t && i.s >= minScore && re.test(i.t));
    items.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return items[index] || null;
  }

  findAll(re, { minScore = 0.5 } = {}) {
    return (this.last.items || [])
      .filter((i) => i.t && i.s >= minScore && re.test(i.t))
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }

  async clickText(re, opts = {}) {
    const hit = this.find(re, opts);
    if (!hit) return { ok: false, missing: true, items: (this.last.items || []).map((i) => i.t).slice(0, 30) };
    const rect = this.rect || (await this.driver.rect());
    const x = rect.x + hit.x;
    const y = rect.y + hit.y;
    const clicked = await this.driver.click(x, y);
    await sleep(opts.afterMs ?? 2500);
    return { ok: true, text: hit.t, x, y, clicked };
  }

  async clickAt(item, afterMs = 2500) {
    const rect = this.rect || (await this.driver.rect());
    const clicked = await this.driver.click(rect.x + item.x, rect.y + item.y);
    await sleep(afterMs);
    return clicked;
  }

  async waitFor(re, { timeoutMs = 20000, pollMs = 1500 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const items = await this.refresh();
      const hit = items.find((i) => re.test(i.t || ''));
      if (hit) return hit;
      await sleep(pollMs);
    }
    return null;
  }

  async has(re) {
    return !!(await this.find(re));
  }

  async wheel(dy, x, y) {
    const rect = this.rect || (await this.driver.rect());
    return this.driver.wheel(dy, rect.x + (x || Math.round(rect.w / 2)), rect.y + (y || Math.round(rect.h / 2)));
  }

  /** 前 n 行文本，便于诊断 */
  head(n = 20) {
    return (this.last.items || []).slice(0, n).map((i) => i.t);
  }
}
