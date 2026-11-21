#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""学习通 9010 验证码识别工具（4 位字母数字，供 DSH 插件 subprocess 调用）。

页面把验证码画在 canvas 上导出 PNG，插件落盘后调用本工具：

    python captcha.py --image cap.png [--digits 4] [--json-stdout]

stdout 只输出一行 JSON：
    成功 ``{"text":"abcd","engine":"ddddocr","variants":N}``
    失败 ``{"text":"","engine":"none"}``（退出码 1）

策略（按代价从低到高）：
    1. ddddocr 直接读原图字节（最快，~0.02s/张）。
    2. 原图结果长度不对 / 非字母数字时，做预处理变体再读：
       灰度放大 2~3 倍、Otsu 二值化、紧贴文字裁剪、去白边、反色。
    3. 仍然不行再拉 rapidocr_onnxruntime 当第二引擎。
    多个可用结果按「大写后投票」合并，平票时优先原图结果。
    单张图总耗时目标 < 8s（模型首次加载 1~3s 属正常）。
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time

PROG = 'captcha.py'
VERSION = '1.0'

DEFAULT_DIGITS = 4
DEFAULT_TIMEOUT = 8.0
ALNUM = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')


def log(msg: str = '') -> None:
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# 图像预处理
# --------------------------------------------------------------------------
def load_rgb(path: str):
    """读图并铺到白底上（验证码常是带 alpha 的 PNG，透明背景要先变白）。"""
    from PIL import Image
    with open(path, 'rb') as fh:
        raw = fh.read()
    im = Image.open(io.BytesIO(raw))
    im.load()
    if im.mode in ('RGBA', 'LA', 'P', 'PA'):
        im = im.convert('RGBA')
        bg = Image.new('RGB', im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert('RGB')
    return raw, im


def _otsu(gray):
    import numpy as np
    hist = np.bincount(gray.ravel(), minlength=256).astype('float64')
    total = hist.sum()
    if total <= 0:
        return 127
    sum_all = float((np.arange(256) * hist).sum())
    w_b = 0.0
    sum_b = 0.0
    best_var = -1.0
    thr = 127
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f <= 0:
            break
        sum_b += t * hist[t]
        m_b = sum_b / w_b
        m_f = (sum_all - sum_b) / w_f
        var = w_b * w_f * (m_b - m_f) ** 2
        if var > best_var:
            best_var = var
            thr = t
    return thr


def _scaled(img, k):
    from PIL import Image
    return img.resize((max(1, int(img.width * k)), max(1, int(img.height * k))),
                      Image.LANCZOS)


def tight_crop(gray):
    """按暗色像素包围盒裁掉白边，四周补 6px 白。"""
    import numpy as np
    from PIL import Image, ImageOps
    arr = np.asarray(gray)
    mask = arr < 200
    if not mask.any():
        return None
    ys, xs = np.where(mask)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    # 裁得太狠（可能把噪点当文字）就放弃这个变体
    if (x1 - x0 + 1) * (y1 - y0 + 1) < 0.25 * arr.shape[0] * arr.shape[1]:
        return None
    cropped = gray.crop((max(0, x0 - 4), max(0, y0 - 4),
                         min(gray.width, x1 + 5), min(gray.height, y1 + 5)))
    return ImageOps.expand(cropped, border=6, fill=255)


def _to_png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def build_variants(raw: bytes, rgb):
    """产出 (名称, PNG 字节)。第一个是原图原始字节，其余是预处理变体。"""
    from PIL import Image, ImageOps
    import numpy as np
    yield 'raw', raw
    gray = ImageOps.grayscale(rgb)
    try:
        thr = _otsu(np.asarray(gray, dtype=np.uint8))
    except Exception:
        thr = 128
    bw = gray.point(lambda v: 255 if v > thr else 0)

    cropped = None
    try:
        cropped = tight_crop(gray)
    except Exception:
        cropped = None

    plans = (
        ('gray_x3', _scaled(gray, 3)),
        ('gray_x2', _scaled(gray, 2)),
        ('bw_x2', _scaled(bw, 2)),
        ('bw_x3', _scaled(bw, 3)),
        ('crop_x2', _scaled(cropped, 2) if cropped is not None else None),
        ('pad_x2', _scaled(ImageOps.expand(gray, border=8, fill=255), 2)),
        ('invert_x2', _scaled(ImageOps.invert(gray), 2)),
    )
    for name, img in plans:
        if img is None:
            continue
        try:
            yield name, _to_png(img)
        except Exception as exc:  # pragma: no cover
            log('  [warn] 生成变体 %s 失败: %s' % (name, exc))


# --------------------------------------------------------------------------
# 识别引擎
# --------------------------------------------------------------------------
def ok_text(text: str, digits: int) -> bool:
    return len(text) == digits and all(c in ALNUM for c in text)


class DdddEngine:
    name = 'ddddocr'

    def __init__(self):
        try:
            import ddddocr
        except Exception as exc:
            raise RuntimeError('无法导入 ddddocr: %s' % exc)
        try:
            self._ocr = ddddocr.DdddOcr(show_ad=False)
        except Exception as exc:
            raise RuntimeError('ddddocr 初始化失败: %s' % exc)

    def read(self, png: bytes) -> str:
        try:
            out = self._ocr.classification(png)
        except Exception as exc:
            log('  [warn] ddddocr 读图失败: %s' % exc)
            return ''
        return ''.join(c for c in str(out or '') if c in ALNUM)


class RapidEngine:
    name = 'rapidocr'

    def __init__(self):
        try:
            from rapidocr_onnxruntime import RapidOCR
        except Exception as exc:
            raise RuntimeError('无法导入 rapidocr_onnxruntime: %s' % exc)
        try:
            self._engine = RapidOCR()
        except Exception as exc:
            raise RuntimeError('RapidOCR 初始化失败: %s' % exc)

    def read(self, png: bytes) -> str:
        import numpy as np
        from PIL import Image, ImageOps
        try:
            im = Image.open(io.BytesIO(png)).convert('RGB')
            big = _scaled(im, max(1.0, 120.0 / max(1, im.height)))
            res, _ = self._engine(np.asarray(big))
        except Exception as exc:
            log('  [warn] rapidocr 读图失败: %s' % exc)
            return ''
        items = []
        for it in res or []:
            try:
                box, txt = it[0], it[1]
                minx = min(float(p[0]) for p in box)
            except (TypeError, IndexError, ValueError):
                txt, minx = str(getattr(it, 'txt', '')), 0.0
            if txt:
                items.append((minx, str(txt)))
        items.sort(key=lambda t: t[0])
        joined = ''.join(t for _x, t in items)
        return ''.join(c for c in joined if c in ALNUM)


# --------------------------------------------------------------------------
# 决策
# --------------------------------------------------------------------------
def pick(cands, digits, prefer='raw'):
    """cands: [(variant_name, text)]，按尝试顺序。

    只保留长度/charset 合法的候选；大写后投票，平票时优先 prefer 变体。
    没有合法候选时退化：先按长度挑最常见的，再不行用最长的。
    """
    from collections import Counter
    valid = [(n, t) for n, t in cands if ok_text(t, digits)]
    if not valid:
        len_ok = [(n, t) for n, t in cands if t and len(t) == digits]
        pool = len_ok or [(n, t) for n, t in cands if t]
        if not pool:
            return '', None
        votes = Counter(t.upper() for _n, t in pool)
        top = votes.most_common(1)[0][1]
        for n, t in pool:                      # 同票取最先出现的
            if votes[t.upper()] == top:
                return t, n
        return pool[0][1], pool[0][0]

    votes = Counter(t.upper() for _n, t in valid)
    # 原图结果只要跟最高票并列，就采信原图
    for n, t in valid:
        if n == prefer and votes[t.upper()] >= votes.most_common(1)[0][1]:
            return t, n
    best_key = votes.most_common(1)[0][0]
    for n, t in valid:
        if t.upper() == best_key:
            return t, n
    return valid[0][1], valid[0][0]


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog=PROG, add_help=True,
        description='学习通 9010 验证码识别（4 位字母数字）')
    ap.add_argument('positional', nargs='*', metavar='IMAGE',
                    help='位置参数兜底：图片路径')
    ap.add_argument('--image', default=None, help='验证码 PNG 路径')
    ap.add_argument('--digits', type=int, default=DEFAULT_DIGITS,
                    help='验证码位数，默认 %d' % DEFAULT_DIGITS)
    ap.add_argument('--json-stdout', action='store_true',
                    help='兼容此开关：本工具 stdout 始终只有一行 JSON')
    ap.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT,
                    help='单张图耗时上限秒数，默认 %.0f' % DEFAULT_TIMEOUT)
    ap.add_argument('--no-rapid', action='store_true', help='禁用 rapidocr 第二引擎')
    ap.add_argument('--version', action='version', version='%s %s' % (PROG, VERSION))
    return ap


def emit(real_stdout, payload) -> None:
    real_stdout.write(json.dumps(payload, ensure_ascii=False,
                                 separators=(',', ':')) + '\n')
    real_stdout.flush()


def main(argv=None) -> int:
    real_stdout = sys.stdout
    for stream in (real_stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass

    args, unknown = build_parser().parse_known_args(argv)
    if unknown:
        log('[warn] 忽略未知参数: %s' % ' '.join(unknown))
    image = args.image or (args.positional[0] if args.positional else None)
    digits = args.digits if 1 <= args.digits <= 12 else DEFAULT_DIGITS
    if not image:
        log('ERROR: 缺少 --image <图片路径>')
        emit(real_stdout, {'text': '', 'engine': 'none'})
        return 1
    if not os.path.isfile(image):
        log('ERROR: 图片不存在: %s' % image)
        emit(real_stdout, {'text': '', 'engine': 'none'})
        return 1

    # 库的任何 print 都不能污染 stdout
    sys.stdout = sys.stderr
    t0 = time.time()
    deadline = t0 + max(args.timeout, 2.0)
    tried = 0

    try:
        raw, rgb = load_rgb(image)
    except Exception as exc:
        log('ERROR: 读图失败 %s: %s' % (image, exc))
        emit(real_stdout, {'text': '', 'engine': 'none'})
        return 1
    log('image=%s size=%dx%d mode=%s' % (os.path.basename(image),
                                         rgb.width, rgb.height, rgb.mode))

    cands = []
    engine = 'none'

    # ---- 1. ddddocr ----
    try:
        ddd = DdddEngine()
    except RuntimeError as exc:
        ddd = None
        log('[warn] %s' % exc)

    if ddd is not None:
        for name, png in build_variants(raw, rgb):
            if time.time() > deadline:
                log('[warn] 超时，停止 ddddocr 变体尝试')
                break
            text = ddd.read(png)
            if name != 'raw':
                tried += 1
            log('  %-9s -> %r' % (name, text))
            cands.append((name, text))
            if name == 'raw' and ok_text(text, digits):
                break                      # 原图直接命中，不再折腾
            if len(cands) >= 7:
                break
        text, via = pick(cands, digits)
        if ok_text(text, digits):
            engine = 'ddddocr'
            if via != 'raw':
                log('  ddddocr 采用变体 %s' % via)
    else:
        text, via = '', None

    # ---- 2. rapidocr 第二引擎 ----
    if not ok_text(text, digits) and not args.no_rapid:
        if time.time() > deadline - 2.5:
            log('[warn] 时间不够，跳过 rapidocr 第二引擎')
        else:
            try:
                rap = RapidEngine()
            except RuntimeError as exc:
                rap = None
                log('[warn] %s' % exc)
            if rap is not None:
                backups = []
                for name, png in build_variants(raw, rgb):
                    if name not in ('raw', 'gray_x3', 'bw_x2', 'crop_x2'):
                        continue
                    if time.time() > deadline:
                        break
                    tried += 1
                    rtext = rap.read(png)
                    log('  rapid:%-8s -> %r' % (name, rtext))
                    backups.append(('rapid_' + name, rtext))
                if backups:
                    cands.extend(backups)
                    rtext, rvia = pick(backups, digits)
                    if ok_text(rtext, digits):
                        text, engine = rtext, 'rapidocr'
                        log('  rapidocr 采用变体 %s' % rvia)

    # ---- 3. 输出 ----
    elapsed = time.time() - t0
    if ok_text(text, digits):
        log('OK %r engine=%s variants=%d 用时 %.2fs' % (text, engine, tried, elapsed))
        emit(real_stdout, {'text': text, 'engine': engine, 'variants': tried})
        return 0

    log('FAIL 未能识别出 %d 位验证码，用时 %.2fs' % (digits, elapsed))
    emit(real_stdout, {'text': '', 'engine': 'none'})
    return 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log('中断')
        sys.exit(130)
