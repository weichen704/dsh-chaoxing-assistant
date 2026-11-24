// 调用捆绑 Python 做 OCR（验证码 / 反爬字体映射），纯本地、无网络。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { captchaScript, fontmapScript } from './paths.mjs';

let cachedPython = '';
let scanAt = 0;

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 找可用 python：环境变量 > 用户 .dsh 运行时的捆绑 python > PATH */
export function pythonPath(explicit) {
  for (const p of [explicit, process.env.CHAOXING_PYTHON, cachedPython]) {
    if (exists(p)) return p;
  }
  // 只缓存「真实存在」的绝对路径；PATH 里的裸名字不算命中。
  // 刚扫过仍没找到时短期直接返回 PATH 兜底，避免每次 OCR 都 readdir 一遍运行时目录。
  if (scanAt && Date.now() - scanAt < 60000) return 'python';
  scanAt = Date.now();
  const home = os.homedir();
  const runtimes = path.join(home, '.dsh', 'dsh-runtimes');
  try {
    for (const dir of fs.readdirSync(runtimes)) {
      for (const rel of [
        ['dependencies', 'python', 'python.exe'],
        ['dependencies', 'python', 'bin', 'python3'],
        ['python', 'python.exe'],
      ]) {
        const p = path.join(runtimes, dir, ...rel);
        if (exists(p)) {
          cachedPython = p;
          return p;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return 'python';
}

export function runPython(script, args, { timeoutMs = 300000, python } = {}) {
  const exe = pythonPath(python);
  if (!exe) return Promise.reject(new Error('找不到可用的 python，请设置环境变量 CHAOXING_PYTHON'));
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [script, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error(`python 脚本超时（${timeoutMs}ms）：${path.basename(script)}`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8').slice(-4000),
      });
    });
  });
}

function lastJsonLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const idx = line.indexOf('{');
    if (idx < 0) continue;
    try {
      return JSON.parse(line.slice(idx));
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 识别 4 位验证码图片 → { text, engine } */
export async function ocrCaptcha(imagePath, opts = {}) {
  const r = await runPython(captchaScript, ['--image', imagePath], { timeoutMs: opts.timeoutMs || 30000, python: opts.python });
  const json = lastJsonLine(r.stdout);
  if (!json || !json.text) {
    throw new Error(`验证码识别失败（code=${r.code}）：${(r.stderr || r.stdout || '').slice(-300)}`);
  }
  return { text: String(json.text).trim(), engine: json.engine || 'ddddocr', raw: r.stdout.slice(-300) };
}

/**
 * 建立字体映射：ttf → { 乱码字: 真字 }。
 * outJson 已存在且字符覆盖时直接复用。
 */
export async function buildFontMap(ttfPath, outJson, chars, opts = {}) {
  if (exists(outJson)) {
    try {
      const cached = JSON.parse(fs.readFileSync(outJson, 'utf8'));
      const need = Array.from(String(chars || '')).filter((c) => c && !(c in cached));
      if (!chars || need.length === 0) return { map: cached, cached: true };
    } catch {
      /* 缓存坏了就重建 */
    }
  }
  const args = ['--ttf', ttfPath, '--out', outJson];
  if (chars && String(chars).trim()) args.push('--chars', String(chars));
  const r = await runPython(fontmapScript, args, { timeoutMs: opts.timeoutMs || 300000, python: opts.python });
  if (r.code !== 0) {
    throw new Error(`字体映射失败（code=${r.code}）：${(r.stderr || r.stdout).slice(-400)}`);
  }
  let map = {};
  try {
    map = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  } catch (e) {
    throw new Error(`字体映射结果读不出来：${e.message}`);
  }
  return { map, cached: false, stdout: r.stdout.slice(-200) };
}

/** 用映射表解码一串乱码文字 */
export function decodeText(text, map) {
  if (!text || !map) return String(text || '');
  let out = '';
  for (const ch of String(text)) out += Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch;
  return out;
}
