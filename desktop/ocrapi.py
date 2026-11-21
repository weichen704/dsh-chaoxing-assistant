"""常驻 OCR 服务：stdin 逐行 JSON 请求 → stdout 逐行 JSON 结果（模型只加载一次）。

请求：
  {"img": "D:/x.png"}                                   整图
  {"img": "D:/x.png", "box": [x,y,w,h]}                 只识别图内区域
  {"img": "D:/x.png", "box": [x,y,w,h], "scale": 0.5}   先缩放再识别（提速），坐标自动还原
  {"ping": true}
返回：
  {"ok": true, "items": [{"t","x","y","w","h","s"}], "ms": 123}
"""
import json
import sys
import time

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

_engine = None


def engine():
    global _engine
    if _engine is None:
        _engine = RapidOCR()
    return _engine


def ocr_image(path, box=None, scale=1.0):
    im = Image.open(path).convert("RGB")
    ox = oy = 0
    if box:
        ox, oy, w, h = [int(v) for v in box]
        w = min(w, im.width - ox)
        h = min(h, im.height - oy)
        if w <= 0 or h <= 0:
            return []
        im = im.crop((ox, oy, ox + w, oy + h))
    if scale and abs(float(scale) - 1.0) > 0.01:
        s = float(scale)
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
        k = 1.0 / s
    else:
        k = 1.0
    arr = np.asarray(im)[:, :, ::-1]  # RGB -> BGR，避免落盘
    res, _ = engine()(arr)
    items = []
    for box_pts, text, score in (res or []):
        xs = [p[0] * k for p in box_pts]
        ys = [p[1] * k for p in box_pts]
        items.append(
            {
                "t": text,
                "x": int(sum(xs) / len(xs)) + ox,
                "y": int(sum(ys) / len(ys)) + oy,
                "w": int((max(xs) - min(xs)) * k),
                "h": int((max(ys) - min(ys)) * k),
                "s": round(float(score), 3),
            }
        )
    items.sort(key=lambda i: (i["y"], i["x"]))
    return items


def _decode(raw):
    for enc in ("utf-8", "gbk", "latin1"):
        try:
            return raw.decode(enc)
        except Exception:  # noqa: BLE001
            continue
    return raw.decode("utf-8", errors="replace")


def main():
    # 用二进制读 stdin，避免 Windows 控制台默认使用 GBK 导致中文路径乱码
    for raw in sys.stdin.buffer:
        line = _decode(raw).strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "err": "bad json: %s" % exc}), flush=True)
            continue
        if req.get("ping"):
            print(json.dumps({"ok": True, "pong": True}), flush=True)
            continue
        t0 = time.time()
        try:
            items = ocr_image(req.get("img"), req.get("box"), req.get("scale") or 1.0)
            print(
                json.dumps({"ok": True, "items": items, "ms": int((time.time() - t0) * 1000)}, ensure_ascii=False),
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "err": str(exc)[:300]}), flush=True)


if __name__ == "__main__":
    main()
