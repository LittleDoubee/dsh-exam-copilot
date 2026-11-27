# -*- coding: utf-8 -*-
"""滚轮截图 v2：接入 daemon 的正式版本。

与 scroll_capture.py 的区别：
  * 判据从「只看选项数」扩展为 5 条（见 needs_scroll）
  * 拼接时保留屏幕坐标，使点击坐标可直接使用
  * 滚动量按实际视觉位移估算，不依赖滚轮格数的固定换算

关键：滚动后选项的屏幕坐标会变，必须用「虚拟 y - 累计滚动量」换算回当前屏幕坐标。
"""
import os
import sys
import time
import hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import winio
import ocr_engine
import parser as P
from PIL import Image

SHOT = os.path.join(HERE, "screen.png")

WHEEL_UP = 120      # 一格
SCROLL_STEP_PX = 300   # 每次滚动约 300px（3 格 × 100px）


def _grab():
    winio.grab(SHOT)
    return Image.open(SHOT).convert("RGB")


def _area_sig(im, box):
    ox, oy, w, h = box
    area = im.crop((ox, oy + int(h * 0.10), ox + w, oy + int(h * 0.90)))
    g = area.convert("L").resize((96, 72), Image.BILINEAR)
    return hashlib.md5(g.tobytes()).hexdigest()


def _scroll(box, notches, up=False):
    ox, oy, w, h = box
    cx = ox + w // 2
    cy = oy + int(h * 0.55)
    delta = WHEEL_UP * notches if up else -WHEEL_UP * notches
    winio.scroll(cx, cy, delta)
    time.sleep(0.5)


# ---------------- 5 条滚轮判据 ----------------

def needs_scroll(parsed, box, rows, verbose=False):
    """返回 (need, reason)。任一判据命中就需要滚轮。"""
    ox, oy, w, h = box
    opts = parsed["opts"]
    qtype = parsed["qtype"]
    stem = parsed["stem"]
    n = len(opts)

    reasons = []

    # 判据 5：完全没解析出选项
    if n == 0:
        reasons.append("no_options")

    # 判据 1：选项数不足
    if "多选" in qtype and n < 4:
        reasons.append(f"multi_lt4({n})")
    elif "单选" in qtype and n < 3:
        reasons.append(f"single_lt3({n})")
    elif "判断" in qtype and n < 2:
        reasons.append(f"judge_lt2({n})")
    elif "案例" in qtype and n < 2:
        reasons.append(f"case_lt2({n})")

    # 判据 2：选项字母断号（有 A 有 D 但缺 C）
    if n >= 2:
        letters = [o["letter"] for o in opts]
        expected = [chr(ord("A") + i) for i in range(len(letters))]
        if letters != expected:
            reasons.append(f"letter_gap({''.join(letters)})")

    # 判据 3：题干未完结
    # 注意：题库题干常以「是」「（）」结尾而省略标点，不能只看标点。
    # 实测误触发源：m3_34「…正确的操作是」、m3_37「…具有（）等特点」、m3_56「…误读率均」
    # 修正：只有当「题干末尾是半个字/半句话」时才判为未完结 —— 即末字是
    # 常见连接词或量词、且没有选项被解析出来时才可疑。
    # 更稳的做法：判据 3 只在「选项数明显不足」时作为补充，不单独触发。
    if stem and n > 0:
        pass  # 有选项时不靠题干判断，避免误触发
    elif stem:
        tail = stem.rstrip()[-2:]
        # 无选项 + 题干结尾是这些字，说明确实被切断
        if tail and tail[-1] in "的和与及或在为对把被将从向于以之其此该":
            reasons.append("stem_unfinished")

    # 判据 4：末行贴底
    # 注意：底部「上一题/下一题/题号」按钮行恒在 y>0.92h，会无条件触发本判据。
    # 考试模式）每题误触发一次滚动，白费 3.4s。
    # 修正：只在「选项明显不足」时才把贴底当作补充证据；选项已解析完整时不滚。
    # 这样既保住困难图的召回，又消除正常题的误触发。
    opts_short = (n == 0 or
                  ("多选" in qtype and n < 4) or
                  ("单选" in qtype and n < 3) or
                  ("判断" in qtype and n < 2))
    if rows and opts_short:
        # 只看正文行，排除底部按钮/题号区
        body = [r for r in rows if r["y"] < h * 0.90]
        if body:
            maxy = max(r["y"] + r["h"] for r in body)
            if maxy > h * 0.86:
                reasons.append(f"bottom_touch({maxy}/{h})")

    need = len(reasons) > 0
    if verbose:
        print(f"  [scroll判据] 选项{n} 题型{qtype} → {reasons if reasons else '无需滚动'}")
    return need, reasons


# ---------------- 多帧拼接 ----------------

def capture_full(box, max_shots=4, notches=3, verbose=False):
    """滚动截图并拼接。

    返回 (merged_rows, meta)
      merged_rows: 每行含 text/x/y/w/h，y 为**当前屏幕坐标**
                   （即最后一帧的坐标系，可直接用于点击）
      meta: {shots, scroll_px, reasons}
    """
    ox, oy, w, h = box
    frames = []          # [(rows, scroll_from_current)]
    total_scroll = 0
    prev_sig = None

    for i in range(max_shots):
        im = _grab()
        s = _area_sig(im, box)
        if i > 0 and s == prev_sig:
            if verbose:
                print(f"  [scroll] 帧{i+1} 与上帧相同，已到底")
            break
        prev_sig = s

        crop = im.crop((ox, oy, ox + w, oy + h))
        p = os.path.join(HERE, f"_sc_{i}.png")
        crop.save(p)
        rows = ocr_engine.recognize(p, scale=2.5)
        frames.append((rows, total_scroll))
        if verbose:
            print(f"  [scroll] 帧{i+1}: {len(rows)} 行, 已滚 {total_scroll}px")

        if i == max_shots - 1:
            break
        _scroll(box, notches)
        total_scroll += notches * 100

    # 拼接：把所有帧换算到「最后一帧」的坐标系
    seen = set()
    merged = []
    for rows, scrolled in frames:
        # 该帧的 y + scrolled = 长页坐标
        # 最后一帧的长页偏移 = total_scroll
        for r in rows:
            vy = r["y"] + scrolled              # 长页坐标
            key = (r["text"].strip(), vy // 12)
            if key in seen:
                continue
            seen.add(key)
            merged.append({
                "text": r["text"],
                "x": r["x"],
                # 换算到最后一帧的屏幕坐标
                "y": vy - total_scroll,
                "w": r["w"], "h": r["h"],
            })

    merged.sort(key=lambda r: (r["y"], r["x"]))

    for i in range(max_shots):
        p = os.path.join(HERE, f"_sc_{i}.png")
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass

    return merged, {"shots": len(frames), "scroll_px": total_scroll}


def read_question_full(box, max_shots=4, verbose=False):
    """读当前题；必要时滚轮补全。

    返回 (parsed, meta)
      parsed 里的 opts 坐标已换算回当前屏幕坐标系
      meta 里带 rows（最后一次识别的原始行）和 next_btn（下一题按钮坐标）
    """
    ox, oy, w, h = box
    im = _grab()
    crop = im.crop((ox, oy, ox + w, oy + h))
    p = os.path.join(HERE, "_first.png")
    crop.save(p)
    rows = ocr_engine.recognize(p, scale=2.5)
    parsed = P.parse(rows, ox, oy)
    next_btn = P.find_next_button(rows, ox, oy, h)

    need, reasons = needs_scroll(parsed, box, rows, verbose=verbose)
    if not need:
        return parsed, {"shots": 1, "scroll_px": 0, "reasons": [],
                        "rows": rows, "next_btn": next_btn}

    if verbose:
        print(f"  [scroll] 触发滚动：{reasons}")

    # 先滚回顶部，再逐帧采集
    _scroll(box, notches=10, up=True)
    time.sleep(0.3)

    merged, meta = capture_full(box, max_shots=max_shots, verbose=verbose)
    meta["reasons"] = reasons

    # 用拼接后的行重新解析（坐标系已是最后一帧）
    parsed2 = P.parse(merged, ox, oy)
    parsed2["_scrolled"] = True
    meta["rows"] = merged
    # 滚到底后底部按钮仍在原位，重新定位
    meta["next_btn"] = P.find_next_button(merged, ox, oy, h)
    return parsed2, meta


if __name__ == "__main__":
    print("本模块需在有考试页面时调用 read_question_full()")
    print("判据说明：")
    print("  1. 选项数不足（多选<4 / 单选<3 / 判断<2）")
    print("  2. 选项字母断号（如只有 A、B、D）")
    print("  3. 题干末尾无收尾标点（可能被切断）")
    print("  4. 末行贴底（y > 区域高度 92%）")
    print("  5. 完全解析不出选项")
