# -*- coding: utf-8 -*-
"""考卷页面解析器 v3 —— 适配 RapidOCR 的输出形态。

与 v2 的关键差异：
  Windows OCR：字母常与文字合并成一行，如 "A 国务院；" 或 "A对情节…"
  RapidOCR：  **字母独立成段**（x≈33, w≈50），文字在右侧（x≈118），
              y 坐标相差 5~8px

v3 策略：
  1. 把「纯字母段」（A-F 单字）与「文字段」分开
  2. 每个字母段与 y 最接近的文字段配对
  3. 配对失败时，字母单独成选项（文字为空，仍可点击）
  4. 同时兼容 v2 的「字母+文字同行」形态
"""
import re

LETTER_ONLY = re.compile(r'^[A-Fa-f]$')
LETTER_HEAD = re.compile(r'^([A-Fa-f])(?:[\s.、．:：]+)?(\S.*)$')
PROG = re.compile(r'(\d+)\s*/\s*(\d+)')
COUNTDOWN = re.compile(r'倒\s*计\s*时')

NOISE_EXACT = {"O×", "囗×", "口×", "×", "考试中", "上一题", "下一题"}
NOISE_SUB = ("倒计时", "上一题", "下一题", "答题卡", "交卷", "提交", "考试中",
             "试题解析", "您选择")
NOISE_PREFIX = ("DSH", "Esc")

Q_TYPES = ("单选题", "多选题", "判断题", "案例分析题")


def is_noise_text(t):
    if not t:
        return True
    if t in NOISE_EXACT:
        return True
    if any(k in t for k in NOISE_SUB):
        return True
    if any(t.startswith(p) for p in NOISE_PREFIX):
        return True
    return False


def parse(rows, ox=0, oy=0):
    """返回 dict(stem, opts, prog, qtype)。

    opts: [{"letter","text","sx","sy"}]，sx/sy 是屏幕坐标。
    """
    # ---- 1. 用倒计时条切掉顶部 chrome ----
    countdown_y = None
    for r in rows:
        if COUNTDOWN.search(r.get("text") or ""):
            countdown_y = r["y"]
            break
    if countdown_y is None:
        countdown_y = 0

    lines = []
    for r in rows:
        t = (r.get("text") or "").strip()
        if not t or is_noise_text(t):
            continue
        if r["y"] < countdown_y:
            continue
        if r["w"] <= 8 and r["h"] <= 8:
            continue
        lines.append({"text": t, "x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"]})

    # ---- 2. 题号 ----
    prog = None
    for l in list(lines):
        m = PROG.search(l["text"])
        if m:
            prog = [int(m.group(1)), int(m.group(2))]
            lines.remove(l)
            break

    # ---- 3. 题型 ----
    qtype = ""
    for l in list(lines):
        for k in Q_TYPES:
            if k in l["text"]:
                qtype = k
                l["text"] = l["text"].replace(k, "").strip()
                if not l["text"]:
                    lines.remove(l)
                break
        if qtype:
            break

    lines.sort(key=lambda l: (l["y"], l["x"]))

    # ---- 4. 分离「纯字母段」与「其它段」----
    letter_lines = []   # [(index, letter, line)]
    other = []
    for i, l in enumerate(lines):
        t = l["text"].strip()
        if LETTER_ONLY.match(t):
            letter_lines.append((i, t, l))
        else:
            other.append((i, l))

    # ---- 5a. RapidOCR 形态：字母独立 ----
    if len(letter_lines) >= 2:
        # 字母按 y 排序，取从 A 开始的连续序列
        letter_lines.sort(key=lambda x: x[2]["y"])
        seq = []
        expect = "A"
        for (idx, lt, ln) in letter_lines:
            if lt == expect:
                seq.append((idx, lt, ln))
                expect = chr(ord(expect) + 1)
        if len(seq) < 2:
            seq = [(i, lt, ln) for (i, lt, ln) in letter_lines[:6]]

        # 每个字母配对 y 最接近、x 在其右侧的文字段
        used = set()
        opts = []
        for (idx, lt, ln) in seq:
            best = None
            best_dy = 1e9
            for (oidx, o) in other:
                if oidx in used:
                    continue
                if o["x"] < ln["x"]:
                    continue      # 必须在字母右侧
                dy = abs(o["y"] - ln["y"])
                if dy <= 30 and dy < best_dy:
                    best_dy = dy
                    best = (oidx, o)
            body = ""
            if best:
                used.add(best[0])
                body = best[1]["text"]
            opts.append({
                "letter": lt,
                "text": body,
                "sx": ox + ln["x"] + 20,
                "sy": oy + ln["y"] + ln["h"] // 2,
            })

        # 题干 = 未用作选项的段
        stem_parts = [o["text"] for (oidx, o) in other if oidx not in used]
        stem_parts.sort(key=lambda t: 0)
        stem = "".join(stem_parts)
        return {"stem": stem.strip(), "opts": opts, "prog": prog, "qtype": qtype}

    # ---- 5b. 兼容 v2 形态：字母与文字同行 ----
    starts = []
    for i, l in enumerate(lines):
        t = l["text"].strip()
        m = LETTER_HEAD.match(t)
        if m:
            starts.append((i, m.group(1).upper(), m.group(2)))
    seq = []
    expect = "A"
    for item in starts:
        if item[1] == expect:
            seq.append(item)
            expect = chr(ord(expect) + 1)

    if not seq:
        return {"stem": "".join(l["text"] for l in lines), "opts": [],
                "prog": prog, "qtype": qtype}

    first = seq[0][0]
    stem = "".join(l["text"] for l in lines[:first])

    opts = []
    for k, (idx, letter, extra) in enumerate(seq):
        end = seq[k + 1][0] if k + 1 < len(seq) else len(lines)
        body = extra
        for l in lines[idx + 1:end]:
            body += l["text"]
        head = lines[idx]
        opts.append({
            "letter": letter,
            "text": body.strip(),
            "sx": ox + head["x"] + 20,
            "sy": oy + head["y"] + head["h"] // 2,
        })

    return {"stem": stem.strip(), "opts": opts, "prog": prog, "qtype": qtype}


def find_next_button(rows, ox=0, oy=0, h=None):
    if h is None:
        h = max((r["y"] + r["h"] for r in rows), default=0)
    cands = []
    for r in rows:
        t = (r.get("text") or "").replace(" ", "")
        if not t or r["y"] < h * 0.75:
            continue
        if "下一题" in t and "上一题" not in t:
            return (ox + r["x"] + r["w"] // 2, oy + r["y"] + r["h"] // 2)
        if "下一题" in t and "上一题" in t:
            return (ox + r["x"] + int(r["w"] * 0.78), oy + r["y"] + r["h"] // 2)
        if "下" in t:
            cands.append(r)
    if cands:
        d = max(cands, key=lambda r: r["x"])
        return (ox + d["x"] + int(d["w"] * 0.8), oy + d["y"] + d["h"] // 2)
    return None
