"""自动版面识别：对整窗 OCR 行做规则分析，推断各语义区域（zone）。

输入：OCR 行列表，每行 {text, x, y, w, h}（屏幕坐标或图内坐标均可，输出与输入同坐标系）。
输出：{"zones": [{role, x, y, w, h, conf, source:"auto"}], "score": 0..1, "notes": [...]}

角色与 lib/core/zones.js 的 ZONE_ROLES 一致：question / options / progress / timer / nav。
这里只做「定位」，不做题目解析；解析仍走 parser_v2/v3，保证下游不变。

识别规则（有意保持简单、可解释，便于在失败时让用户圈选修正）：
  * options  ：行首是 A-H 选项字母（A. / A、 / (A) / A：），按 y 递增且字母连续
  * progress ：「第 N 题」「N/M」「N / M 题」
  * timer    ：「剩余时间」「倒计时」或 hh:mm(:ss)
  * nav      ：上一题 / 下一题 / 提交 / 交卷 / 标记
  * question ：选项块上方、progress 下方的文字行
"""

import re

OPT_RE = re.compile(r"^\s*[\(（]?([A-Ha-h])[\)）]?\s*[\.．、:：]\s*\S|^\s*[\(（]([A-Ha-h])[\)）]\s*\S")
PROG_RE = re.compile(r"第\s*\d+\s*[题道]|(?<!\d)\d{1,3}\s*/\s*\d{1,3}(?!\d)")
TIMER_RE = re.compile(r"剩余时间|倒计时|(?<!\d)\d{1,2}\s*[:：∶]\s*\d{2}(\s*[:：∶]\s*\d{2})?(?!\d)")
NAV_RE = re.compile(r"上一题|下一题|提交|交卷|标记|跳过")
QNUM_RE = re.compile(r"^\s*\d{1,3}\s*[\.．、]\s*\S")
QTYPE_RE = re.compile(r"单选|多选|判断|填空")


def _box(rows, pad=4):
    x0 = min(r["x"] for r in rows)
    y0 = min(r["y"] for r in rows)
    x1 = max(r["x"] + r["w"] for r in rows)
    y1 = max(r["y"] + r["h"] for r in rows)
    return {"x": int(x0 - pad), "y": int(y0 - pad), "w": int(x1 - x0 + 2 * pad), "h": int(y1 - y0 + 2 * pad)}


def _norm(rows):
    out = []
    for r in rows or []:
        try:
            t = str(r.get("text") or "").strip()
            if not t:
                continue
            out.append({"text": t, "x": float(r["x"]), "y": float(r["y"]),
                        "w": float(r["w"]), "h": float(r["h"])})
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    out.sort(key=lambda r: (r["y"], r["x"]))
    return out


# 字母单独成行：选项字母画在自己的圆框/方框里时，OCR 往往把「A」和正文拆成两行，
# 或者干脆不带标点（「A正确」）。这些形态都要算作选项字母。
BARE_LETTER_RE = re.compile(r"^\s*[\(（\[【]?\s*([A-Ha-h])\s*[\)）\]】]?\s*[\.．、:：]?\s*$")
# OCR 常把大写 C 认成小写 c（字形只差大小），紧贴汉字时大小写一并接受
GLUED_LETTER_RE = re.compile(r"^\s*([A-Ha-h])(?=[\u4e00-\u9fa5])")


def _opt_letter(text):
    m = OPT_RE.match(text)
    if m:
        return (m.group(1) or m.group(2)).upper()
    m = BARE_LETTER_RE.match(text)
    if m:
        return m.group(1).upper()
    m = GLUED_LETTER_RE.match(text)
    if m:
        return m.group(1).upper()
    return None


def _same_line(a, b):
    """两行在纵向上大部分重叠 → 视为同一视觉行（字母框与正文框并排）。"""
    top = max(a["y"], b["y"])
    bot = min(a["y"] + a["h"], b["y"] + b["h"])
    return bot - top >= 0.5 * min(a["h"], b["h"])


def _reading_key(rows):
    """阅读顺序：先按视觉行（纵向重叠归为一行），行内按 x。
    这样横排的「A 正确   B 错误」也能按 A→B 排好。"""
    lines = []
    for r in sorted(rows, key=lambda r: r["y"]):
        for ln in lines:
            if _same_line(ln[0], r):
                ln.append(r)
                break
        else:
            lines.append([r])
    order = {}
    k = 0
    for ln in lines:
        for r in sorted(ln, key=lambda r: r["x"]):
            order[id(r)] = k
            k += 1
    return order


def _option_block(rows):
    """找最长的连续字母选项序列（A,B,C… 按阅读顺序递增）。

    选项之间允许夹杂别的行（选项框边线、换行的正文、图标噪声），
    只要求字母本身按 A,B,C… 依次出现。返回 (块内所有行, 选项字母行)。
    """
    order = _reading_key(rows)
    cands = [(r, _opt_letter(r["text"])) for r in rows]
    cands = [(r, l) for r, l in cands if l]
    cands.sort(key=lambda c: order[id(c[0])])
    best = []
    for start, (r0, l0) in enumerate(cands):
        if l0 != "A":
            continue
        seq = [r0]
        want = ord("B")
        for r, l in cands[start + 1:]:
            if ord(l) == want:
                seq.append(r)
                want += 1
        if len(seq) > len(best):
            best = seq
    if len(best) < 2:
        return [], []
    opt_rows = best
    # 字母单独成行时，把与它同一视觉行、在它右侧的正文并进来
    paired = []
    for o in opt_rows:
        paired.append(o)
        for r in rows:
            if r is not o and r["x"] > o["x"] and _same_line(o, r):
                paired.append(r)
    y_first = min(r["y"] for r in paired)
    y_last = max(r["y"] for r in paired)
    line_h = max(1.0, sum(r["h"] for r in opt_rows) / len(opt_rows))
    left = min(r["x"] for r in opt_rows)
    block = [r for r in rows
             if (r in paired) or (y_first - 1 <= r["y"] <= y_last + line_h * 1.8 and r["x"] >= left - line_h
                                  and not NAV_RE.search(r["text"]) and not _opt_letter(r["text"]))]
    return block, opt_rows
    # 选项正文可能换行：把相邻两个选项之间、x 不明显靠左的行也并入选项块
    y_first, y_last = opt_rows[0]["y"], opt_rows[-1]["y"]
    line_h = max(1.0, sum(r["h"] for r in opt_rows) / len(opt_rows))
    left = min(r["x"] for r in opt_rows)
    block = [r for r in rows
             if y_first - 1 <= r["y"] <= y_last + line_h * 1.8 and r["x"] >= left - line_h
             and not NAV_RE.search(r["text"])]
    return block, opt_rows


def detect(rows, frame=None):
    """frame = 可选 {w,h}，用于把明显在边角的 timer/progress 置信度调高。"""
    rows = _norm(rows)
    zones, notes = [], []
    if not rows:
        return {"zones": [], "score": 0.0, "notes": ["没有 OCR 行"]}

    used = set()

    block, opt_rows = _option_block(rows)
    if opt_rows:
        n = len(opt_rows)
        zones.append({"role": "options", **_box(block), "conf": round(min(0.95, 0.55 + 0.1 * n), 2)})
        used.update(id(r) for r in block)
    else:
        notes.append("未找到连续的 A/B/C 选项行")

    timer_rows = [r for r in rows if id(r) not in used and TIMER_RE.search(r["text"])]
    if timer_rows:
        r = timer_rows[0]
        zones.append({"role": "timer", **_box([r]), "conf": 0.8 if "剩余" in r["text"] or "倒计时" in r["text"] else 0.6})
        used.add(id(r))

    prog_rows = [r for r in rows if id(r) not in used and PROG_RE.search(r["text"])]
    if prog_rows:
        r = prog_rows[0]
        zones.append({"role": "progress", **_box([r]), "conf": 0.75})
        used.add(id(r))
    else:
        notes.append("未找到题号/进度")

    # 按钮：角色与 zones.js 对齐（next / prev / submit），每个只取第一个匹配
    nav_rows = []
    for role, pat in (("next", r"下一题"), ("prev", r"上一题"), ("submit", r"交卷|提交")):
        hit = [r for r in rows if id(r) not in used and re.search(pat, r["text"]) and len(r["text"]) <= 8]
        if hit:
            zones.append({"role": role, **_box(hit[:1], pad=2), "conf": 0.7})
            used.add(id(hit[0]))
            nav_rows.append(hit[0])

    # 题干：选项块上方，进度/计时下方，未被占用的行
    if opt_rows:
        top_limit = opt_rows[0]["y"]
        floor = max([r["y"] + r["h"] for r in prog_rows[:1] + timer_rows[:1]
                     if r["y"] < top_limit] or [float("-inf")])
        q_rows = [r for r in rows if id(r) not in used and floor <= r["y"] < top_limit]
        # 只取紧邻选项块的那一段：自下而上，遇到大段空白就停
        q_rows.sort(key=lambda r: r["y"])
        seg = []
        for r in reversed(q_rows):
            if seg and seg[-1]["y"] - (r["y"] + r["h"]) > max(r["h"], seg[-1]["h"]) * 2.5:
                break
            seg.append(r)
        seg.reverse()
        if seg:
            conf = 0.6
            if QNUM_RE.match(seg[0]["text"]) or QTYPE_RE.search(seg[0]["text"]):
                conf = 0.85
            zones.append({"role": "question", **_box(seg), "conf": conf})
        else:
            notes.append("选项上方没有题干文字")

    for z in zones:
        z["source"] = "auto"

    roles = {z["role"] for z in zones}
    score = 0.0
    if "options" in roles:
        score += 0.45
    if "question" in roles:
        score += 0.35
    if "progress" in roles:
        score += 0.1
    if "timer" in roles or "next" in roles:
        score += 0.1
    return {"zones": zones, "score": round(score, 2), "notes": notes}
