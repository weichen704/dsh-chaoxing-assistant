#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""font-cxsecret 字体反爬映射工具（供 DSH 学习通插件以 subprocess 调用）。

学习通页面的 @font-face 内联 base64 TTF 会把一批 CJK 码点「重绘」成别的字：
浏览器里人眼正常，但 innerText 拿到的是乱码字。本工具把 TTF 里的字形渲染成
一行图片，交给 RapidOCR 认字，输出 {"乱码字": "真字"} 的 JSON 映射，页面上
的乱码文本按该映射还原即可。

用法::

    python fontmap.py --ttf page_xxx.ttf --out mapcache_xxx.json
                      [--chars 垺垻垼...] [--chars-json chars.json]
                      [--batch 24] [--json-stdout]

stdout 约定:
    默认只输出一行 ``RESULT {"need":N,"mapped":M,"out":"路径"}``；
    加 ``--json-stdout`` 时 stdout 只输出完整映射 JSON（便于 ``json.loads``
    整段读取），RESULT 改走 stderr。其余日志一律 stderr。

退出码:
    0  成功（mapped < need 的部分成功也算 0）
    2  字体解析不出 cmap、字符集与字体完全对不上、OCR 引擎初始化失败
       或一条映射都没认出来。

实现要点:
    * cmap 解析同时支持 format 4 与 format 12，**优先 format 12**（format 12
      覆盖 BMP 外码点且更完整；只拿到 format 4 时退化用它）。
    * 一行一张图：size=44、字距 pad=12、白底黑字，LANCZOS 放大 2 倍后识别，
      按检测框 x 坐标排序拼接。
    * 一批 24 字；整批长度对不上就换参数重试，仍不行则逐字单独渲染兜底。
    * RapidOCR 只初始化一次（构造约 0.2s，首个调用含模型加载约 2-4s）。
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time

PROG = 'fontmap.py'
VERSION = '1.0'

# 整批识别的参数组合，按顺序尝试，第一个「识别长度 == 字符数」的组合胜出。
# 第 1 组是默认参数（也最快最准，绝大多数批次一次通过）；
# 后面几组覆盖小字重、笔画粘连、细笔画漏检的情况。
ROW_ATTEMPTS = (
    {'size': 44, 'pad': 12, 'scale': 2, 'bold': False},
    {'size': 64, 'pad': 22, 'scale': 2, 'bold': False},
    {'size': 44, 'pad': 12, 'scale': 3, 'bold': True},
    {'size': 52, 'pad': 16, 'scale': 3, 'bold': False},
)

# 逐字兜底：大字号 + 大倍数放大，单字结果长度必须为 1。
ONE_ATTEMPTS = (
    {'size': 90, 'scale': 4},
    {'size': 64, 'scale': 5},
    {'size': 120, 'scale': 3},
)

DEFAULT_TIMEOUT = 110.0  # 秒；59 字实测 ~10s，留足余量
MAX_BATCH = 200


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
def log(msg: str = '') -> None:
    """所有日志走 stderr，保证 stdout 干净。"""
    print(msg, file=sys.stderr, flush=True)


class FontError(Exception):
    """字体文件无法解析（不是 TTF / 没有 cmap）。"""


def _u16(buf: bytes, off: int, what: str) -> int:
    if off < 0 or off + 2 > len(buf):
        raise FontError('字体数据越界（读取 %s 的 u16 @%d）' % (what, off))
    return struct.unpack('>H', buf[off:off + 2])[0]


def _u32(buf: bytes, off: int, what: str) -> int:
    if off < 0 or off + 4 > len(buf):
        raise FontError('字体数据越界（读取 %s 的 u32 @%d）' % (what, off))
    return struct.unpack('>I', buf[off:off + 4])[0]


def parse_cmap(path: str):
    """解析 TTF/OTF 的 cmap 子表，返回 (码点集合, 实际用的子表格式 4 或 12)。

    表目录: 文件头 0:4 sfnt 版本, 4:6 numTables, 记录从 12 开始每条 16 字节
    （tag 0:4, checksum 4:8, offset 8:12, length 12:16）。
    format 4: segCountX2 @+6, endCode @+14, reservedPad, startCode @+14+segX2+2
    format 12: nGroups @+12, 每组 12 字节 (startCharCode, endCharCode, glyphID)
    """
    try:
        with open(path, 'rb') as fh:
            data = fh.read()
    except OSError as exc:
        raise FontError('无法读取字体文件 %s: %s' % (path, exc))

    if len(data) < 12:
        raise FontError('文件太小（%d 字节），不是 TrueType 字体' % len(data))
    tag = data[0:4]
    if tag not in (b'\x00\x01\x00\x00', b'true', b'OTTO', b'ttcf', b'wOFF'):
        raise FontError('不是字体文件（魔数 %r，期望 \\x00\\x01\\x00\\x00/true/OTTO）' % tag)
    if tag == b'wOFF':
        raise FontError('这是 WOFF/WOFF2 压缩字体，请先解包成 TTF')

    num = _u16(data, 4, 'numTables')
    if num == 0 or num > 4096:
        raise FontError('表数量异常（numTables=%d）' % num)
    if 12 + 16 * num > len(data):
        raise FontError('表目录越界（numTables=%d 但文件只有 %d 字节）' % (num, len(data)))

    cmap_off = None
    for i in range(num):
        rec = data[12 + 16 * i:12 + 16 * i + 16]
        if rec[:4] == b'cmap':
            cmap_off = struct.unpack('>I', rec[8:12])[0]
            break
    if cmap_off is None:
        raise FontError('字体里没有 cmap 表')
    if cmap_off + 4 > len(data):
        raise FontError('cmap 表偏移越界（%d > %d）' % (cmap_off, len(data)))

    n_sub = _u16(data, cmap_off + 2, 'cmap subtable 数')
    sub4 = sub12 = None
    for i in range(n_sub):
        p = cmap_off + 4 + 8 * i
        if p + 8 > len(data):
            break
        _pid, _eid, off = struct.unpack('>HHI', data[p:p + 8])
        fmt = _u16(data, cmap_off + off, 'cmap 子表 format')
        if fmt == 12 and sub12 is None:
            sub12 = cmap_off + off
        elif fmt == 4 and sub4 is None:
            sub4 = cmap_off + off

    # 关键修正：format 12 优先（deobf2.py 的 best 选择 bug 就出在这里）
    best = sub12 if sub12 is not None else sub4
    if best is None:
        raise FontError('cmap 里没有 format 4 / format 12 子表')

    fmt = _u16(data, best, 'cmap format')
    codes = set()
    if fmt == 12:
        n_groups = _u32(data, best + 12, 'format12 nGroups')
        if n_groups > 100000:
            raise FontError('format 12 组数异常（%d）' % n_groups)
        for i in range(n_groups):
            p = best + 16 + 12 * i
            if p + 12 > len(data):
                raise FontError('format 12 组数据越界')
            start, end = struct.unpack('>II', data[p:p + 8])
            if end < start or end - start > 0x1FFFF:
                continue
            codes.update(range(start, end + 1))
    elif fmt == 4:
        seg_x2 = _u16(data, best + 6, 'format4 segCountX2')
        seg = seg_x2 // 2
        if seg <= 0 or seg > 0x8000:
            raise FontError('format 4 段数异常（%d）' % seg)
        endo = best + 14
        starto = endo + seg_x2 + 2
        for i in range(seg):
            end = _u16(data, endo + 2 * i, 'format4 endCode')
            sta = _u16(data, starto + 2 * i, 'format4 startCode')
            if sta == 0xFFFF or end < sta or end - sta > 0xFFFF:
                continue
            codes.update(range(sta, end + 1))
    else:  # pragma: no cover - 上面的选择逻辑已排除了其它格式
        raise FontError('不支持的 cmap format %d' % fmt)

    # 过滤掉无法渲染 / 无意义的码点：控制符、代理区、空格
    clean = set()
    for cp in codes:
        if cp < 0x20 or cp == 0x7F or 0xD800 <= cp <= 0xDFFF or cp == 0xFFFE or cp == 0xFFFF:
            continue
        clean.add(cp)
    if not clean:
        raise FontError('cmap 里没有可用码点')
    return clean, fmt


# --------------------------------------------------------------------------
# 渲染
# --------------------------------------------------------------------------
_FONT_CACHE: dict = {}


def _font(path: str, size: int):
    from PIL import ImageFont
    key = (path, size)
    fnt = _FONT_CACHE.get(key)
    if fnt is None:
        fnt = ImageFont.truetype(path, size)
        _FONT_CACHE[key] = fnt
    return fnt


def render_row(font_path: str, chars: str, size: int = 44, pad: int = 12,
               scale: int = 2, bold: bool = False):
    """把一串字符画成「一行一张图」：白底黑字，LANCZOS 放大 scale 倍。"""
    from PIL import Image, ImageDraw
    font = _font(font_path, size)
    width = int(len(chars) * (size + pad)) + 40
    height = int(size * 1.8) + 20
    img = Image.new('RGB', (max(width, 8), max(height, 8)), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    x = 10
    for ch in chars:
        draw.text((x, 10), ch, font=font, fill=(0, 0, 0),
                  stroke_width=1 if bold else 0, stroke_fill=(0, 0, 0))
        x += size + pad
    if scale != 1:
        img = img.resize((int(img.width * scale), int(img.height * scale)),
                         Image.LANCZOS)
    return img


def render_one(font_path: str, ch: str, size: int = 90, scale: int = 4):
    """单字大图（逐字兜底用）。"""
    from PIL import Image, ImageDraw
    font = _font(font_path, size)
    side = int(size * 1.6)
    img = Image.new('RGB', (side, side), (255, 255, 255))
    ImageDraw.Draw(img).text((int(size * 0.15), int(size * 0.12)), ch,
                             font=font, fill=(0, 0, 0))
    if scale != 1:
        img = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
    return img


# --------------------------------------------------------------------------
# OCR
# --------------------------------------------------------------------------
def _iter_items(res):
    """把 RapidOCR 的返回值统一成 [(minx, text, score)]，按 x 排序。"""
    items = []
    for it in res or []:
        box = txt = None
        score = 0.0
        try:
            box = it[0]
            txt = it[1]
            if len(it) > 2:
                score = float(it[2])
        except (TypeError, IndexError, ValueError):
            box = getattr(it, 'box', None)
            txt = getattr(it, 'txt', '') or getattr(it, 'text', '')
            try:
                score = float(getattr(it, 'score', 0.0))
            except (TypeError, ValueError):
                score = 0.0
        if not txt:
            continue
        try:
            minx = min(float(p[0]) for p in box) if box else 0.0
        except (TypeError, IndexError, ValueError):
            minx = 0.0
        items.append((minx, str(txt), score))
    items.sort(key=lambda t: t[0])
    return items


class Ocr:
    """RapidOCR 封装：一个进程只构造一次。"""

    def __init__(self):
        try:
            from rapidocr_onnxruntime import RapidOCR
        except Exception as exc:  # ImportError 或底层 onnxruntime 加载失败
            raise FontError('无法导入 rapidocr_onnxruntime: %s' % exc)
        try:
            self._engine = RapidOCR()
        except Exception as exc:
            raise FontError('RapidOCR 初始化失败: %s' % exc)
        try:
            import numpy  # noqa: F401  确认 numpy 可用
        except Exception as exc:
            raise FontError('无法导入 numpy: %s' % exc)

    def read(self, img):
        """识别一张图，返回 (拼接文本, 平均置信度, 检测框数)。"""
        import numpy as np
        try:
            res, _elapse = self._engine(np.asarray(img))
        except Exception as exc:
            log('  [warn] OCR 调用失败: %s' % exc)
            return '', 0.0, 0
        items = _iter_items(res)
        if not items:
            return '', 0.0, 0
        text = ''.join(t for _x, t, _s in items)
        conf = sum(s for _x, _t, s in items) / len(items)
        return text, conf, len(items)


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def collect_chars(args, codes) -> list:
    """决定要映射哪些字符：--chars / --chars-json 过滤 cmap，否则全量。"""
    wanted = []
    if args.chars:
        wanted.extend(args.chars)
    if args.chars_json:
        try:
            with open(args.chars_json, 'r', encoding='utf-8') as fh:
                raw = json.load(fh)
        except (OSError, ValueError) as exc:
            raise FontError('无法读取 --chars-json %s: %s' % (args.chars_json, exc))
        if isinstance(raw, str):
            wanted.extend(raw)
        elif isinstance(raw, (list, tuple)):
            for item in raw:
                if isinstance(item, str):
                    wanted.extend(item)
        else:
            raise FontError('--chars-json 必须是字符串数组或字符串')

    if not wanted:
        return [chr(cp) for cp in sorted(codes)]

    out, seen = [], set()
    for ch in wanted:
        if len(ch) != 1 or ch.isspace():
            continue
        if ord(ch) not in codes or ch in seen:
            continue
        seen.add(ch)
        out.append(ch)
    return out


def write_map(path: str, mapping: dict) -> None:
    if not path:
        return
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(mapping, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write('\n')


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog=PROG, add_help=True,
        description='解析 font-cxsecret 字体，OCR 建立 乱码字->真字 映射')
    ap.add_argument('positional', nargs='*', metavar='TTF [OUT]',
                    help='位置参数兜底：字体路径、输出 JSON 路径')
    ap.add_argument('--ttf', default=None, help='TTF 字体路径')
    ap.add_argument('--out', default=None, help='输出 JSON 路径（目录不存在会自动创建）')
    ap.add_argument('--chars', default='', help='只需要映射的乱码字符（字符串）')
    ap.add_argument('--chars-json', default=None, help='JSON 数组文件，元素为乱码字符')
    ap.add_argument('--batch', type=int, default=24, help='每批渲染字符数，默认 24')
    ap.add_argument('--json-stdout', action='store_true',
                    help='stdout 输出完整映射 JSON（RESULT 行改走 stderr）')
    ap.add_argument('--timeout', type=float, default=DEFAULT_TIMEOUT,
                    help='OCR 阶段的整体超时秒数，默认 %.0f' % DEFAULT_TIMEOUT)
    ap.add_argument('--debug-dir', default=None,
                    help='调试：把每批渲染图保存到该目录')
    ap.add_argument('--per-char', action='store_true',
                    help='调试：跳过整批识别，全部逐字渲染')
    ap.add_argument('--version', action='version', version='%s %s' % (PROG, VERSION))
    return ap


def main(argv=None) -> int:
    real_stdout = sys.stdout
    for stream in (real_stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass

    ap = build_parser()
    args, unknown = ap.parse_known_args(argv)
    if unknown:
        log('[warn] 忽略未知参数: %s' % ' '.join(unknown))
    if args.ttf is None and args.positional:
        args.ttf = args.positional.pop(0)
    if args.out is None and args.positional:
        args.out = args.positional.pop(0)
    if not args.ttf:
        log('ERROR: 缺少 --ttf <字体路径>')
        return 2
    if not args.out and not args.json_stdout:
        log('ERROR: 缺少 --out <输出json路径>')
        return 2

    # OCR 期间库的任何 print 都被赶到 stderr，stdout 只留结果
    sys.stdout = sys.stderr

    t_start = time.time()
    batch = args.batch if 1 <= args.batch <= MAX_BATCH else 24

    try:
        codes, fmt = parse_cmap(args.ttf)
    except FontError as exc:
        log('ERROR: 字体解析失败: %s' % exc)
        return 2

    log('%s: cmap format=%d 码点数=%d' % (os.path.basename(args.ttf), fmt, len(codes)))

    explicit = bool(args.chars or args.chars_json)
    try:
        chars = collect_chars(args, codes)
    except FontError as exc:
        log('ERROR: %s' % exc)
        return 2

    need = len(chars)
    log('need=%d batch=%d' % (need, batch))
    if need == 0:
        if explicit:
            log('ERROR: 指定字符在字体 cmap 里一个都不存在，字体与字符集不匹配')
            return 2
        log('[warn] 没有需要映射的字符')
        try:
            write_map(args.out, {})
        except OSError as exc:
            log('ERROR: 写入 %s 失败: %s' % (args.out, exc))
            return 2
        return 0

    try:
        ocr = Ocr()
    except FontError as exc:
        log('ERROR: OCR 引擎不可用: %s' % exc)
        return 2

    deadline = t_start + max(args.timeout, 5.0)
    mapping: dict = {}

    if args.debug_dir:
        try:
            os.makedirs(args.debug_dir, exist_ok=True)
        except OSError as exc:
            log('[warn] 无法创建 --debug-dir: %s' % exc)

    # ---------------- 整批识别 ----------------
    batches = [chars[i:i + batch] for i in range(0, need, batch)]
    if args.per_char:
        batches = []

    for bi, sub in enumerate(batches):
        if time.time() > deadline:
            log('[warn] 超时（%.0fs），剩余 %d 批次跳过'
                % (args.timeout, len(batches) - bi))
            break
        text = None
        for ai, att in enumerate(ROW_ATTEMPTS):
            if time.time() > deadline:
                break
            try:
                img = render_row(args.ttf, sub, **att)
            except Exception as exc:
                log('  [warn] 渲染失败（批次 %d）: %s' % (bi, exc))
                continue
            if args.debug_dir:
                try:
                    img.save(os.path.join(args.debug_dir, 'row_%02d_%d.png' % (bi, ai)))
                except OSError:
                    pass
            got, conf, nbox = ocr.read(img)
            if len(got) == len(sub):
                text = got
                log('  批次 %d/%d 命中参数 size=%d pad=%d scale=%d bold=%s '
                    'conf=%.3f boxes=%d'
                    % (bi + 1, len(batches), att['size'], att['pad'], att['scale'],
                       att['bold'], conf, nbox))
                break
            log('  批次 %d/%d 参数 size=%d pad=%d scale=%d bold=%s: 长度 %d != %d（%.2fs）'
                % (bi + 1, len(batches), att['size'], att['pad'], att['scale'],
                   att['bold'], len(got), len(sub), time.time() - t_start))
        if text is not None:
            for src, dst in zip(sub, text):
                mapping[src] = dst
        else:
            # 逐字兜底交给下面的循环
            pass

    # ---------------- 逐字兜底 ----------------
    todo = [ch for ch in chars if ch not in mapping]
    if todo:
        log('逐字兜底 %d 个字符' % len(todo))
    for i, ch in enumerate(todo):
        if time.time() > deadline:
            log('[warn] 超时，剩余 %d 个字符未处理' % (len(todo) - i))
            break
        got = ''
        used = None
        for att in ONE_ATTEMPTS:
            if time.time() > deadline:
                break
            try:
                img = render_one(args.ttf, ch, **att)
            except Exception as exc:
                log('  [warn] 单字渲染失败 %r: %s' % (ch, exc))
                continue
            if args.debug_dir:
                try:
                    img.save(os.path.join(args.debug_dir,
                                          'one_%d_%d.png' % (i, att['size'])))
                except OSError:
                    pass
            text, _conf, _nbox = ocr.read(img)
            if len(text) == 1:
                got = text
                used = att
                break
        if got:
            mapping[ch] = got
            log('  单字 %r -> %r (size=%s scale=%s)'
                % (ch, got, used['size'] if used else '?', used['scale'] if used else '?'))
        else:
            log('  单字 %r 未识别' % ch)

    # ---------------- 输出 ----------------
    out_map = {ch: mapping[ch] for ch in chars if ch in mapping and len(mapping[ch]) == 1}
    try:
        write_map(args.out, out_map)
    except OSError as exc:
        log('ERROR: 写入 %s 失败: %s' % (args.out, exc))
        return 2

    elapsed = time.time() - t_start
    result = {'need': need, 'mapped': len(out_map), 'out': args.out or ''}
    log('完成 need=%d mapped=%d 用时 %.1fs' % (need, len(out_map), elapsed))

    line = json.dumps(result, ensure_ascii=False, separators=(',', ':'))
    if args.json_stdout:
        real_stdout.write(json.dumps(out_map, ensure_ascii=False,
                                     separators=(',', ':')) + '\n')
        real_stdout.flush()
        log('RESULT ' + line)
    else:
        real_stdout.write('RESULT ' + line + '\n')
        real_stdout.flush()

    if len(out_map) == 0:
        log('ERROR: 一条映射都没认出来（OCR 全部失败）')
        return 2
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log('中断')
        sys.exit(130)
