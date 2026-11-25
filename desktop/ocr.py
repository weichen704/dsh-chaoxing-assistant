# 对学习通桌面客户端截图做 OCR，输出文字与窗口内坐标（供点击用）
import sys, json, os, tempfile
from rapidocr_onnxruntime import RapidOCR

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "desk-chapters.png")
ocr = RapidOCR()
res, _ = ocr(path)
items = []
for box, text, score in (res or []):
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    items.append({
        "t": text,
        "x": int(sum(xs) / len(xs)),
        "y": int(sum(ys) / len(ys)),
        "w": int(max(xs) - min(xs)),
        "h": int(max(ys) - min(ys)),
        "s": round(float(score), 3),
    })
items.sort(key=lambda i: (i["y"], i["x"]))
print(json.dumps(items, ensure_ascii=False))
