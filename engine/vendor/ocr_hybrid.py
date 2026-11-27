# -*- coding: utf-8 -*-
"""混合 OCR：Windows OCR 主力 + RapidOCR 兜底。

设计依据：

  Windows OCR + v2 解析器：  17/17 = 100%，842ms   ← 主力
  RapidOCR   + v3 解析器：   14/17 = 82.4%，2082ms ← 兜底

主力用 Windows OCR，只在以下情况回落到 RapidOCR：
  * 解析出的选项数明显不足（多选题 <4、单选 <3、判断 <2）
  * 选项字母断号（有 A、C 但缺 B）
  * 完全无选项

重要经验：
  * RapidOCR **不能**加放大预处理（会合并相邻行，23.5%）
  * RapidOCR 需要 box_thresh=0.2、unclip_ratio=1.5 才能最大程度分行
  * RapidOCR 用 parser_v3（字母独立段的配对逻辑）

对外接口：
  recognize(path, box=None, expect_opts=None, qtype=None) -> (rows, parsed, engine_used)
"""
import os
import sys
import subprocess
import json
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import ocr_engine          # Windows OCR（含预处理 + 纠错）
import parser as P2        # v2：适配 Windows OCR
import parser_v3 as P3     # v3：适配 RapidOCR

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ── RapidOCR 的调用方式（重构：去掉硬编码路径 + 缓存实例）─────────────
#
# 原实现写死一个绝对路径的系统 Python，并且每次兜底都起子进程重新加载模型：
#   * 绝对路径换机器就失效，也不该出现在代码里；
#   * 每次兜底重新加载模型，实测让单题从 764ms 涨到 5413ms。
#
# 现在引擎本身就跑在用户指定的 Python 上，所以优先【同进程导入 + 缓存实例】：
#   * 不需要任何硬编码路径；
#   * 模型只加载一次，兜底成本大幅下降。
# 仅当本进程没有 rapidocr、但用户用 EXAM_RAPID_PYTHON 指定了另一个解释器时，才走子进程。
RAPID_HELPER = os.path.join(HERE, "_rapid_helper.py")

_rapid_engine = None
_rapid_checked = False
_rapid_ok = False


def rapid_available():
    """检查 RapidOCR 是否可用（同进程优先，其次显式指定的子进程解释器）。"""
    global _rapid_checked, _rapid_ok
    if _rapid_checked:
        return _rapid_ok
    _rapid_checked = True

    try:
        import rapidocr  # noqa: F401

        _rapid_ok = True
        return True
    except Exception:
        pass

    alt = os.environ.get("EXAM_RAPID_PYTHON", "")
    if alt and os.path.exists(alt):
        try:
            r = subprocess.run([alt, "-c", "import rapidocr; print('ok')"],
                               capture_output=True, text=True, timeout=20)
            _rapid_ok = "ok" in (r.stdout or "")
        except Exception:
            _rapid_ok = False
    return _rapid_ok


def _get_rapid_engine():
    """取（并缓存）同进程的 RapidOCR 实例。模型加载要数秒，绝不能每次重来。"""
    global _rapid_engine
    if _rapid_engine is not None:
        return _rapid_engine
    from rapidocr import RapidOCR

    _rapid_engine = RapidOCR()
    return _rapid_engine
    _rapid_engine = RapidOCR()
    return _rapid_engine


def _ensure_helper():
    """写出 RapidOCR 子进程脚本（仅在需要跨解释器时使用）。"""
    code = r'''# -*- coding: utf-8 -*-
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
'''
    if not os.path.exists(RAPID_HELPER) or \
       open(RAPID_HELPER, encoding="utf-8").read() != code:
        with open(RAPID_HELPER, "w", encoding="utf-8") as f:
            f.write(code)


def _rows_from_result(result):
    """把 RapidOCR 的返回对象规整成 [{text,x,y,w,h}]。

    兼容两种返回形态（不同版本差异很大，不能只按一种写）：
      * 老版：result.boxes / result.txts
      * 新版：result 是 (boxes, txts, scores) 三元组
    """
    boxes = txts = None
    if hasattr(result, "boxes"):
        boxes, txts = result.boxes, getattr(result, "txts", None)
    elif isinstance(result, (list, tuple)) and len(result) >= 2:
        boxes, txts = result[0], result[1]
    if boxes is None or txts is None:
        return []

    rows = []
    for box, txt in zip(boxes, txts):
        try:
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
        except Exception:
            continue
        # 纠错词典同样要作用于 RapidOCR 的结果。
        #
        # fix_text 原本只在 ocr_engine.recognize()
        # （Windows 路径）里调用，RapidOCR 的行**完全没经过纠错**。
        # 于是同一处错字（如 "E卩刷"）在 Windows 路径被修好、在 RapidOCR
        # 路径漏过去 —— 而兜底恰恰是靠 RapidOCR 救场的，等于白兜。
        rows.append({
            "text": ocr_engine.fix_text(str(txt).strip()),
            "x": int(min(xs)), "y": int(min(ys)),
            "w": int(max(xs) - min(xs)), "h": int(max(ys) - min(ys)),
        })
    return rows


def rapid_recognize(path, timeout=90):
    """用 RapidOCR 识别。

    同进程优先（模型已缓存，毫秒级）；只有本进程没有 rapidocr
    且用户用 EXAM_RAPID_PYTHON 指定了别的解释器时才走子进程。
    """
    if not rapid_available():
        return []

    # ── 同进程路径 ──
    try:
        eng = _get_rapid_engine()
        # box_thresh / unclip_ratio 是实测调出来的：不加就无法足够细分行
        result = eng(path, box_thresh=0.2, unclip_ratio=1.5)
        rows = _rows_from_result(result)
        if rows:
            return rows
    except Exception:
        pass

    # ── 子进程路径（兜底）──
    alt = os.environ.get("EXAM_RAPID_PYTHON", "")
    if not alt or not os.path.exists(alt):
        return []
    _ensure_helper()
    try:
        r = subprocess.run([alt, RAPID_HELPER, os.path.abspath(path)],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return []
    except Exception:
        return []
    for line in (r.stdout or "").splitlines():
        if line.startswith("@@ROWS@@"):
            try:
                rows = json.loads(line[len("@@ROWS@@"):])
            except Exception:
                return []
            # 子进程路径同样要过纠错（与同进程路径保持一致）
            for row in rows:
                row["text"] = ocr_engine.fix_text(str(row.get("text") or ""))
            return rows
    return []


def _opts_insufficient(parsed, expect=None):
    """判断选项解析是否不足，需要兜底。

    这是"为什么识别不够准"的真正答案：
      旧实现只看 qtype 推断期望选项数。但 qtype 是从**题型标签行**读出来的，
      而标签常常不在用户圈的内容区里（或 OCR 没读到）→ qtype 为空 →
      三个 if 全不匹配 → 直接 return False，"够了，不用兜底"。

      实测 Q5（图形题）：
        * Windows OCR 整行漏掉 "C成本核算"，返回 5 行
        * 解析后 opts=[A, B]（字母居然连续：A,B）
        * qtype='' → 本函数返回 False → **RapidOCR 兜底从未触发**
        * 而 RapidOCR 对同一张图读出 13 行，C 和 成本核算 都在 ——
          本来完全可以救回来。

      所以必须补充不依赖 qtype 的判据：
        1. 解析器自报 letter_gap（_letter_gap）—— 最直接
        2. 选项数落在"可疑区间"：单选/多选通常 3-4 个，只有 1-2 个先兜底再说
        3. 选项正文疑似被下一项污染（如 "排版十D市场推广" 里混进了下一个字母）
           —— 这是漏行被拼进上一项的症状

      兜底成本已经很低（模型同进程缓存，实测 500ms 级），
      误兜底一次远比静默答错便宜。
    """
    n = len(parsed.get("opts") or [])
    qtype = parsed.get("qtype") or ""

    if n == 0:
        return True, "no_options"

    # ① 解析器自报字母被跳过（最可靠，不依赖 qtype）
    gap = parsed.get("_letter_gap") or []
    if gap:
        return True, f"letter_gap_skipped({','.join(gap)})"

    # ② 字母断号
    letters = [o["letter"] for o in parsed["opts"]]
    expected = [chr(ord("A") + i) for i in range(len(letters))]
    if letters != expected:
        return True, f"letter_gap({''.join(letters)})"

    # ③ 选项正文里混进了别的字母（漏行的典型症状）
    #    例：Windows OCR 漏掉 C 行时，"D市场推广" 被当成 B 的续行 →
    #    B 的正文变成 "排版设计D市场推广"
    for o in parsed["opts"]:
        body = str(o.get("text") or "")
        if _has_embedded_letter(body):
            return True, f"embedded_letter({o['letter']})"

    if expect:
        if n < expect:
            return True, f"opts_{n}_lt_{expect}"
        return False, ""

    # ④ 按题型推断期望值（原有逻辑）
    if "多选" in qtype and n < 4:
        return True, f"multi_{n}_lt_4"
    if "单选" in qtype and n < 3:
        return True, f"single_{n}_lt_3"
    if "判断" in qtype and n < 2:
        return True, f"judge_{n}_lt_2"

    # ⑤ 只有 **1 个**选项 —— 任何题型都不成立，必然漏读。
    #
    # 这一条用实测数据调出来的，前后调整过：
    #   v1（错）：n <= 2 且无 qtype 就兜底
    #            → 把**所有判断题**都送去 RapidOCR（判断题正常就是 2 个），
    #              而 RapidOCR 在这份界面上更差，11/12 掉到 6/12。
    #   v2（对）：只有 n == 1 才兜底
    #            → 实测 Q3/Q8/Q12（判断题）的失败形态正是"只解析出 A"：
    #              Windows OCR 把 "B错误" 整行读成了 "00"，
    #              于是 B 消失、A 的正文被污染成 "正确00"。
    #              这种题本来 1 个选项就不成立，RapidOCR 能救回来。
    # 结论：判断"可疑"要挑**数学上不可能**的数量（1 个），
    #       而不是"看起来偏少"的数量（2 个）。
    if n == 1:
        return True, "only_one_opt"

    return False, ""


# 选项正文里"夹着一个字母+中文"的形态，例如 "排版设计D市场推广"。
# 只认 A-F 后紧跟中文的情况，避免把正常正文（如 "A股"）误判。
import re as _re

_EMBEDDED_LETTER = _re.compile(r"[\u4e00-\u9fa5][A-F][\u4e00-\u9fa5]")


def _has_embedded_letter(body):
    """正文中间是否夹着一个选项字母。

    为什么要这条：OCR 漏掉一整行时，下一行会被当成上一项的续行拼进来，
    拼完的正文形如 "排版设计D市场推广" —— 字母前后都是中文。
    正常选项正文几乎不会出现这种形态。
    """
    if not body:
        return False
    return bool(_EMBEDDED_LETTER.search(body))


def recognize(path, box=None, expect_opts=None, verbose=False):
    """混合识别。

    返回 (rows, parsed, engine_used, reason)
      engine_used: "windows" | "rapid" | "windows_fallback"
      reason: 切换原因（空字符串表示未切换）
    """
    # ---- 1. Windows OCR ----
    rows = ocr_engine.recognize(path, scale=2.5)
    parsed = P2.parse(rows, *(box[:2] if box else (0, 0)))

    need, why = _opts_insufficient(parsed, expect_opts)
    if not need:
        return rows, parsed, "windows", ""

    if verbose:
        print(f"  [hybrid] Windows OCR 不足({why})，尝试 RapidOCR")

    # ---- 2. RapidOCR 兜底 ----
    rrows = rapid_recognize(path)
    if not rrows:
        if verbose:
            print("  [hybrid] RapidOCR 不可用，沿用 Windows 结果")
        return rows, parsed, "windows", why

    rparsed = P3.parse(rrows, *(box[:2] if box else (0, 0)))
    rneed, rwhy = _opts_insufficient(rparsed, expect_opts)

    # ── 谁更好用谁 ─────────────────────────────────────────
    #
    # 旧判据是「选项数更多就更优」，这是**错的**。
    #
    # 真实反例（mock 第 12 题，判断题）：
    #   Windows  → rows: [题干, "A正确", "00"]        opts = [A]        1 个
    #   RapidOCR → rows: [假B, 题干, "A 正确", "B", "错误", ...]
    #              opts = [B:'', B:'错误']             2 个 ← 数量多但全错
    # 原因是 RapidOCR 把页面上「判断题」这个题型标签的外框误认成了字母 B，
    # 而解析器把它当成了第一个选项（字母 B），真正的 A 反而被跳过。
    #
    # 所以「数量多」不等于「更好」。必须要求：
    #   ① 结构合法：字母从 A 开始连续（不能是 B,B 这种）
    #   ② 每项都有正文（空正文的是噪声）
    #   ③ 且数量确实更多
    # 三者全满足才换。否则宁可沿用 Windows。
    def _quality(p):
        """返回 (是否结构合法, 有效选项数)。

        判据来自一组真实反例，每条对应一个具体错误形态：

          形态 A（RapidOCR 多出假选项）：
            页面上「判断题」标签的边框被认成字母 B，
            该行的几何是 x=64 y=2 w=10 h=5 —— **10x5 的碎块**，
            而真实字母是 x=41 y=149 w=18 h=18。
            → 用尺寸判据（见下）筛掉。

          形态 B（Windows 漏行被拼进上一项）：
            漏掉 B 行，把下一行残渣 "00" 拼进 A → opts=[A:'正确00']
            → 用"中文+尾部两位纯数字"判据筛掉。

          形态 C（正常）：
            opts=[A:'正确', B:'错误'] → 合法
        """
        opts = p.get("opts") or []
        if not opts:
            return False, 0
        # ① 字母必须从 A 起连续
        letters = [str(o.get("letter") or "").upper() for o in opts]
        expected = [chr(ord("A") + i) for i in range(len(letters))]
        if letters != expected:
            return False, 0
        # ② 每项都必须有正文
        if any(not str(o.get("text") or "").strip() for o in opts):
            return False, 0
        # ③ 选项锚点不能是碎块。
        #    parser 给的 sx/sy 是字母位置，但拿不到宽高；这里改用
        #    opts 上如果带 _w/_h（parser 会附）就判，否则跳过。
        for o in opts:
            w = o.get("_w")
            h = o.get("_h")
            if w is not None and h is not None and (w < 10 or h < 10):
                return False, 0  # 字母框太小 → 是噪声
        # ④ 正文不能被"上一项漏行"污染（"正确00"）。
        import re as _re

        for o in opts:
            body = str(o.get("text") or "").strip()
            if _re.search(r"[\u4e00-\u9fa5]\d{2,}$", body):
                return False, 0
        return True, len(opts)

    w_ok, w_n = _quality(parsed)
    r_ok, r_n = _quality(rparsed)

    if r_ok and (not w_ok or r_n > w_n):
        if verbose:
            print(f"  [hybrid] RapidOCR 更优：结构合法且 {r_n} 个选项（Windows {w_n}）")
        return rrows, rparsed, "rapid", why

    if verbose:
        print(f"  [hybrid] RapidOCR 不可用为优(r_ok={r_ok},r_n={r_n} vs w_ok={w_ok},w_n={w_n})，沿用 Windows")
    return rows, parsed, "windows", why


if __name__ == "__main__":
    # 自测
    tests = ["m3_43.png", "m3_44.png", "m3_32.png", "m3_54.png"]
    print("RapidOCR 可用:", rapid_available())
    for f in tests:
        p = os.path.join(HERE, f)
        if not os.path.exists(p):
            continue
        t0 = time.perf_counter()
        rows, parsed, eng, why = recognize(p, verbose=True)
        dt = (time.perf_counter() - t0) * 1000
        print(f"{f}: {len(parsed['opts'])} 选项 via {eng} "
              f"({why or '无需兜底'}) {dt:.0f}ms")
