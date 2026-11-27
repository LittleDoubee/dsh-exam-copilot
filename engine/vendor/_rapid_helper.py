# -*- coding: utf-8 -*-
import sys, json, os
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from rapidocr import RapidOCR

path = sys.argv[1]
eng = RapidOCR()
r = eng(path, box_thresh=0.2, unclip_ratio=1.5)
rows = []
if hasattr(r, "boxes") and r.boxes is not None:
    for box, txt in zip(r.boxes, r.txts):
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        rows.append({
            "text": str(txt).strip(),
            "x": int(min(xs)), "y": int(min(ys)),
            "w": int(max(xs) - min(xs)), "h": int(max(ys) - min(ys)),
        })
print("@@ROWS@@" + json.dumps(rows, ensure_ascii=False))
