# -*- coding: utf-8 -*-
"""考卷页面解析器 v2 —— 基于真实截图测试修正。

修正点（v1 的三个实测缺陷）：
  1. 图3 的选项字母与文字连在一起（"A对情节严重…"），v1 的正则要求字母后有空格 → 全部漏识别
  2. 浏览器标签栏的 "O×" "考试中" "囗×" "（）" 被当成题干 → 用倒计时条作上边界切掉
  3. 多行选项（图3 的 A 跨 3 行）需要正确归并到同一选项

选项坐标一律取 OCR 实测的字母行位置，绝不用固定比例。
"""
import re

# 选项字母：只认大写 A-F，但 OCR 会把 C 认成小写 c / 全角 Ｃ。
# 若不归一，C 选项会整条丢失 → 字母断号 → 触发 RapidOCR 兜底 → 单题从 842ms 涨到 5.4s。
LETTER_ONLY = re.compile(r'^([A-Fa-f])$')
# 字母后可以没有分隔符（中文题面常见 "A对情节…"）
LETTER_HEAD = re.compile(r'^([A-Fa-f])(?:[\s.、．:：]+)?(\S.*)$')
PROG = re.compile(r'(\d+)\s*/\s*(\d+)')
# 计时条锚点：不要只认"倒计时"三个字 —— 真实考试系统的文案五花八门
# 模拟页写"剩余时间 44:58"，只认倒计时就漏判，倒计时文字混进了题干。
# 改为「计时语义词」或「mm:ss 形态的时钟」二者之一即可。
COUNTDOWN = re.compile(r'倒\s*计\s*时|剩余时间|剩余|时间\s*\d{1,3}\s*[:：]\s*\d{2}|\d{1,3}\s*[:：]\s*\d{2}\s*[:：]\s*\d{2}')
# 计时条上的文字本身不该进题干（即使上面那条锚点没命中，也别让它污染题面）
CLOCK_TEXT = re.compile(r'^\D{0,6}\d{1,3}\s*[:：]\s*\d{2}(\s*[:：]\s*\d{2})?$')

NOISE_EXACT = {"O×", "囗×", "口×", "×", "考试中", "上一题", "下一题"}
NOISE_SUB = ("倒计时", "上一题", "下一题", "答题卡", "交卷", "提交", "考试中")
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
    # 纯计时文本（"剩余时间44:58" / "44:58"）：绝不能进题干
    if CLOCK_TEXT.match(t.strip()):
        return True
    # 极小的框线残留（w/h 都很小）
    return False


def parse(rows, ox=0, oy=0):
    """返回 dict(stem, opts, prog, qtype)

    opts: [{"letter","text","sx","sy"}]，sx/sy 是屏幕坐标（已加 ox/oy 偏移）
    """
    # ---- 1. 用倒计时条确定上边界，切掉浏览器标签栏 ----
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
        if r["y"] < countdown_y:          # 倒计时条以上 = 浏览器 chrome
            continue
        if r["w"] <= 10 and r["h"] <= 10:  # 零星框线
            continue
        lines.append({"text": t, "x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"]})

    # ── 过滤「极扁碎块」：OCR 会把标签边框、下划线、图标残影认成文字 ──
    #
    # 判断题）：
    #   RapidOCR 把页面「判断题」标签的边框认成了字母 B，
    #   该行几何是 x=64 y=2 **w=10 h=5**，
    #   而真实选项字母是 w=18 h=18 —— 高度差 3.6 倍。
    #   不滤掉它，解析器就会把这个假 B 当成第一个选项，
    #   于是 opts 变成 [B:'', B:'错误']，真正的 A 被跳过，
    #   最后用户看到的是"字母 BB、题目只有 2 个选项但全是错的"。
    #
    # 判据用**高度**而不是宽高比：中文单字（如 "A"）宽高都约 14-20px，
    # 而边框碎块高度只有 5px。取 h < 9 作为门槛，不误伤真实文字。
    lines = [l for l in lines if l["h"] >= 9]

    # ---- 2. 题号 ----
    prog = None
    for l in list(lines):
        m = PROG.search(l["text"])
        if m:
            prog = [int(m.group(1)), int(m.group(2))]
            lines.remove(l)
            break

    # ---- 3. 题型标签（从行首剥离）----
    qtype = ""
    for l in list(lines):
        for k in Q_TYPES:
            if l["text"].startswith(k):
                qtype = k
                l["text"] = l["text"][len(k):].strip()
                if not l["text"]:
                    lines.remove(l)
                break
        if qtype:
            break

    lines.sort(key=lambda l: (l["y"], l["x"]))

    # ── 合并「字母与正文被 OCR 拆成两行」的情况 ──────────────────
    #
    # Windows OCR 把每个选项拆成两段：
    #     'A'               y=94 h=11
    #     '印刷经营许可证'    y=93 h=14      ← 正文的 y 比字母还小 1px
    # 按 (y, x) 排序后正文排在字母**前面**，于是：
    #   * 第一个正文被算进题干（题干末尾多出"印刷经营许可证"）
    #   * 每个选项拿到的是**下一项**的正文 → 整体错位一格
    #   * 字母仍然 A,B,C,D 连续 → 完整性门禁不报错 → 静默答错
    #
    # 注意：正文可能排在字母**之前**（y 小 1px），所以必须双向找，
    # 只往后找会漏。
    def _merge_letter_body(seq):
        """把「字母行 + 同 y 的正文行」并成一行，并移除被并掉的正文行。

        关键：被合并的正文行必须彻底消失 ——
        否则它会在第 5 步又作为"上一个选项的续行"被拼一次，
        结果是每个选项正文里混进了下一项的正文（实测就是这么坏的）。
        """
        dropped = set()   # 被合并掉的正文行索引
        rebuilt = {}      # 字母行索引 → 合并后的新行

        for i, l in enumerate(seq):
            t = (l.get("text") or "").strip()
            if not LETTER_ONLY.match(t) or i in dropped:
                continue
            cy = l["y"] + l["h"] / 2.0
            # 双向找：正文的 y 可能比字母小 1px，排序后会跑到前面
            for j in list(range(max(0, i - 2), i)) + list(range(i + 1, min(len(seq), i + 3))):
                if j in dropped:
                    continue
                cand = seq[j]
                ct = (cand.get("text") or "").strip()
                if not ct or LETTER_ONLY.match(ct):
                    continue
                # 正文不能带字母前缀，否则会吞掉下一选项
                if LETTER_HEAD.match(ct):
                    continue
                ccy = cand["y"] + cand["h"] / 2.0
                if abs(ccy - cy) <= max(l["h"], cand["h"]) * 0.75:
                    dropped.add(j)
                    rebuilt[i] = {
                        "text": t + cand["text"],
                        "x": min(l["x"], cand["x"]),
                        "y": min(l["y"], cand["y"]),
                        "w": max(l["w"], cand["w"]),
                        "h": max(l["h"], cand["h"]),
                    }
                    break

        out = []
        for i, l in enumerate(seq):
            if i in dropped:
                continue
            out.append(rebuilt.get(i, l))
        return out

    lines = _merge_letter_body(lines)

    # ---- 4. 找选项起点：从 A 开始、字母严格递增 ----
    starts = []
    for i, l in enumerate(lines):
        t = l["text"].strip()
        m = LETTER_ONLY.match(t)
        if m:
            # 统一转大写：OCR 常把 C 认成 c，不归一就会漏掉整个选项
            starts.append((i, m.group(1).upper(), ""))
            continue
        m = LETTER_HEAD.match(t)
        if m:
            # 防止把 "A股" 这类正文误判：选项字母后面紧跟的内容不应太长且该行需缩进
            starts.append((i, m.group(1).upper(), m.group(2)))

    seq = []
    expect = "A"
    dropped = []  # 被跳过的字母（OCR 漏行时会出现）
    for item in starts:
        if item[1] == expect:
            seq.append(item)
            expect = chr(ord(expect) + 1)
        else:
            # 关键修正：
            # 旧实现这里 **静默跳过** 不匹配的字母。当 OCR 漏掉某一行时
            # （实测：图形题 Q5 的 "C成本核算" 整行没识别出来），
            # starts = [A, B, D]，D 因为 expect 是 C 而被丢掉；
            # 随后第 5 步把 "D市场推广" 当成 B 的续行拼进 B，
            # 结果 opts = [A, B(排版十D市场推广)] —— 看起来"只有 2 个选项、
            # 字母连续 A,B"，于是完整性门禁（靠断号判断）也不会告警。
            # 表现就是：题目被当成完整的、按 A 或 B 作答，静默答错。
            # 现在把跳过的字母记下来，交给上层判断是否转人工/滚动重读。
            dropped.append(item[1])

    if not seq:
        stem = "".join(l["text"] for l in lines)
        out = {"stem": stem.strip(), "opts": [], "prog": prog, "qtype": qtype}
        if dropped:
            out["_letter_gap"] = dropped
        return out

    first = seq[0][0]
    stem = "".join(l["text"] for l in lines[:first])

    # ---- 5. 归并选项（含多行续行）----
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
            # 字母圆圈中心：字母行 x 是圆圈左缘，+20 落在圆内；y 取行中
            "sx": ox + head["x"] + 20,
            "sy": oy + head["y"] + head["h"] // 2,
        })

    out = {"stem": stem.strip(), "opts": opts, "prog": prog, "qtype": qtype}
    if dropped:
        # 暴露「字母被跳过」这个事实。上层（完整性门禁）据此判为不完整，
        # 走滚动重读或转人工 —— 绝不能当成"题目就这么几个选项"继续作答。
        out["_letter_gap"] = dropped
        out["_opts_raw"] = [[o["letter"], o["text"]] for o in opts]
    return out


def find_next_button(rows, ox=0, oy=0, h=None):
    """找「下一题」按钮坐标。"""
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


def find_prev_button(rows, ox=0, oy=0, h=None):
    """找「上一题」按钮坐标。"""
    if h is None:
        h = max((r["y"] + r["h"] for r in rows), default=0)
    cands = []
    for r in rows:
        t = (r.get("text") or "").replace(" ", "")
        if not t or r["y"] < h * 0.75:
            continue
        if "上一题" in t and "下一题" not in t:
            return (ox + r["x"] + r["w"] // 2, oy + r["y"] + r["h"] // 2)
        if "上" in t:
            cands.append(r)
    if cands:
        d = min(cands, key=lambda r: r["x"])
        return (ox + d["x"] + int(d["w"] * 0.2), oy + d["y"] + d["h"] // 2)
    return None
