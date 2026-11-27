# -*- coding: utf-8 -*-
"""dsh-exam-copilot 引擎服务：常驻 HTTP，复用已实测的识别模块。

为什么是常驻进程 + HTTP：
  * 必须常驻 —— RapidOCR 加载模型需数秒，每次 spawn 撑不住 842ms/题 的节奏。
  * 必须 HTTP 而非 stdio pipe —— 本机沙箱下 spawnSync 默认 pipe 会被拒（EPERM），
    异步 spawn 的背压 / 半行 / 僵死管理在插件里很难做对。
  * 附带好处：可脱离 DSH 用 curl 调试；崩溃可被 health 探测发现。

安全：
  * 端口由系统随机分配（bind 0），只监听 127.0.0.1。
  * 每次启动生成随机 token，写入 engine.json（0600），调用方必须带 Bearer。
  * /v1/act 在 paused 状态下拒绝一切动作。

用法（一般由插件拉起，不手动运行）：
  python server.py --data-dir <dir> [--port 0]
"""
import argparse
import base64
import io
import json
import os
import secrets
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
# vendor/ 放复用的实测模块；必须先进 sys.path，否则 import 全失败
VENDOR = os.path.join(HERE, "vendor")
for _p in (VENDOR, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

def read_plugin_version():
    """版本号唯一来源：插件的 package.json。

    引擎不该有自己的独立版本号 —— 之前 server.py 写死 "0.1.0"，
    而插件已经是 0.2.0，面板上两个版本号对不上，用户会以为装错了。
    引擎只是插件的一部分，版本跟随插件。
    """
    pkg = os.path.join(os.path.dirname(HERE), "package.json")
    try:
        with open(pkg, encoding="utf-8") as f:
            import json as _json
            return str(_json.load(f).get("version") or "0.0.0-unknown")
    except Exception:
        return "0.0.0-unknown"


VERSION = read_plugin_version()

# 复用已实测模块（不做重写）
try:
    import winio
except Exception as e:  # pragma: no cover
    winio = None
    print(f"[engine] winio 不可用: {e}", file=sys.stderr)

try:
    import ocr_engine
    import parser as P2
except Exception as e:  # pragma: no cover
    ocr_engine = None
    P2 = None
    print(f"[engine] ocr_engine/parser 不可用: {e}", file=sys.stderr)

try:
    import ocr_hybrid
except Exception as e:  # pragma: no cover
    ocr_hybrid = None
    print(f"[engine] ocr_hybrid 不可用: {e}", file=sys.stderr)

try:
    import parser_v3
except Exception as e:  # pragma: no cover
    parser_v3 = None
    print(f"[engine] parser_v3 不可用: {e}", file=sys.stderr)

try:
    import overlay as overlay_mod
except Exception as e:  # pragma: no cover
    overlay_mod = None
    print(f"[engine] overlay 不可用: {e}", file=sys.stderr)

# 全局状态：动作闸门。paused 为真时拒绝一切 act。
STATE = {
    "startedAt": time.time(),
    "paused": True,          # 默认暂停 —— 启动后必须先显式放行，绝不"默认能点"
    "actions": 0,
    "lastAction": None,
    "stopFile": None,
    # 运行期置顶悬浮窗（overlay.Overlay）。None = 未启动。
    "overlay": None,
    # 被最小化的宿主窗口句柄。run 期间一直保持最小化，
    # 不能在每帧截图后恢复 —— 否则中间那一下就可能截到 DSH。
    "hostMinimized": [],
}


def log(msg):
    print(f"[engine {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def dpi_aware():
    if winio:
        try:
            winio.make_dpi_aware()
        except Exception:
            pass


def hide_own_windows(exclude=None):
    """临时隐藏本进程所属应用（DSH）的可见窗口，截图/圈选完成后再恢复。

    为什么需要：
      用户要在 DSH 里点「圈选」，而 DSH 窗口本身就盖在考试界面上，
      圈选时框到的是 DSH 自己；截图预览也会把 DSH 截进去。
      必须先把宿主窗口藏起来，等拿到图再还原。

    实现要点：
      * 只藏"本进程树"的窗口 —— 按 PID 找，绝不枚举全部窗口乱藏，
        否则可能藏掉用户正在看的别的程序。
      * 用 SW_MINIMIZE 而不是 SW_HIDE：最小化后任务栏还在，
        用户看得见"它去哪了"，不会以为程序崩了。
      * 调用方必须 guarantee 恢复（finally）。
      * **exclude 必须包含置顶悬浮窗的 hwnd**：
        悬浮窗由本进程创建，按 PID 一定命中。若不排除，
        每次截图都会把状态窗一起最小化 —— 用户看到的就是"启动引擎后
        悬浮窗闪一下又没了"，而且截完还把它恢复回来，来回抽搐。
    """
    if not winio:
        return []
    import ctypes
    import ctypes.wintypes as wt

    u32 = ctypes.windll.user32
    my_pid = os.getpid()
    pids = {my_pid}
    skip = set(exclude or [])
    ov = STATE.get("overlay")
    if ov is not None:
        try:
            h = ov.hwnd()
            if h:
                skip.add(h)
        except Exception:
            pass

    # 祖先进程（引擎由宿主 spawn，父进程即 DSH）
    try:
        import psutil  # 可选依赖

        proc = psutil.Process(my_pid)
        for anc in proc.parents()[:4]:
            pids.add(anc.pid)
    except Exception:
        pass

    found = []
    EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def cb(hwnd, _):
        if hwnd in skip:
            return True
        if not u32.IsWindowVisible(hwnd):
            return True
        pid = wt.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        n = u32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        u32.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value
        if pid.value in pids or "DeepSeek Harness" in title:
            found.append(hwnd)
        return True

    u32.EnumWindows(EnumProc(cb), 0)

    hidden = []
    for hwnd in found:
        try:
            u32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
            hidden.append(hwnd)
        except Exception:
            pass
    if hidden:
        log(f"临时最小化 {len(hidden)} 个宿主窗口（截图后恢复）")
        time.sleep(0.35)  # 等窗口动画结束，避免截到残影
    return hidden


def minimize_host_windows():
    """把宿主窗口最小化并**保持在最小化**（运行期用，与临时隐藏不同）。

    为什么要单独一个函数：
      自动答题期间 DSH 必须一直最小化。用 hide_own_windows 那套
      "藏一下、截完马上恢复"的做法不行 —— 恢复的那一瞬间，
      下一帧截图的时机只要稍晚一点就又会截到 DSH。
      手工最小化跟不上这个节奏。
      所以运行开始时压一次，直到 stop 才恢复。
    """
    if not winio:
        return []
    import ctypes
    import ctypes.wintypes as wt

    u32 = ctypes.windll.user32
    my_pid = os.getpid()
    pids = {my_pid}
    skip = set()
    ov = STATE.get("overlay")
    if ov is not None:
        try:
            h = ov.hwnd()
            if h:
                skip.add(h)
        except Exception:
            pass
    try:
        import psutil

        proc = psutil.Process(my_pid)
        for anc in proc.parents()[:4]:
            pids.add(anc.pid)
    except Exception:
        pass

    found = []
    EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def cb(hwnd, _):
        if hwnd in skip:
            return True
        if not u32.IsWindowVisible(hwnd):
            return True
        pid = wt.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        n = u32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        u32.GetWindowTextW(hwnd, buf, n + 1)
        if pid.value in pids or "DeepSeek Harness" in buf.value:
            found.append(hwnd)
        return True

    u32.EnumWindows(EnumProc(cb), 0)
    for hwnd in found:
        try:
            u32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
        except Exception:
            pass
    # 悬浮窗必须重新压到最前：宿主最小化时可能把焦点还给了别处
    if ov is not None:
        try:
            ov.raise_top()
        except Exception:
            pass
    if found:
        log(f"运行开始：已最小化 {len(found)} 个宿主窗口（运行期保持）")
        time.sleep(0.45)
    return found


def restore_host_windows(handles):
    """恢复运行开始时最小化的宿主窗口，并把 DSH 提到前台。

    与 restore_windows 的分工（别混用）：
      · restore_windows          —— 临时隐藏（预览/圈选）用，运行期会被压回去
      · restore_host_windows     —— 运行结束用，无条件恢复，因为它在
                                    STATE["hostMinimized"] 清空之后才调
    """
    if not handles:
        return 0
    import ctypes

    u32 = ctypes.windll.user32
    for hwnd in handles:
        try:
            u32.ShowWindow(hwnd, 9)  # SW_RESTORE
        except Exception:
            pass
    try:
        u32.SetForegroundWindow(handles[0])
    except Exception:
        pass
    log(f"运行结束：已恢复 {len(handles)} 个宿主窗口")
    return len(handles)


def restore_windows(handles):
    """恢复被最小化的窗口。必须放在 finally 里。

    **运行期不得恢复**：
      自动答题期间宿主必须一直最小化。但 hide_own_windows/restore_windows
      这对临时函数在别处还有调用点（预览、圈选、临时截图）。
      只要运行期走到任何一个，DSH 就会被弹回前台 ——
      下一帧截图立刻截到它，识别当场坏掉，而且是偶发的、极难复现。
      所以这里判断：若当前处于"运行期保持最小化"状态，就把这批句柄
      重新压回去，而不是恢复。
    """
    if not handles:
        return
    import ctypes

    u32 = ctypes.windll.user32
    keep = set(STATE.get("hostMinimized") or [])
    kept = 0
    for hwnd in handles:
        try:
            if hwnd in keep:
                # 运行期：压回去，绝不恢复
                u32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
                kept += 1
            else:
                u32.ShowWindow(hwnd, 9)  # SW_RESTORE
        except Exception:
            pass
    if kept:
        log(f"运行期保持最小化：{kept} 个宿主窗口未被恢复（避免截到 DSH）")
    if len(handles) - kept > 0:
        log(f"已恢复 {len(handles) - kept} 个宿主窗口")


def screen_size():
    """返回主屏/虚拟屏尺寸。多显示器用 all_screens 实测，不猜。"""
    try:
        from PIL import ImageGrab
        dpi_aware()
        im = ImageGrab.grab(all_screens=True)
        return im.width, im.height
    except Exception:
        return 0, 0


def grab_image(region=None):
    """截图。region=(x,y,w,h) 则裁切。返回 PIL Image。"""
    from PIL import ImageGrab
    dpi_aware()
    im = ImageGrab.grab(all_screens=True)
    if region:
        x, y, w, h = [int(v) for v in region]
        # all_screens 截图的 (0,0) 是虚拟桌面左上角，不一定是主屏原点：
        # 副屏在主屏左/上方时它是负坐标，不换算的话裁出来的位置会整体错开
        try:
            vx, vy = winio.virtual_screen_origin() if winio else (0, 0)
        except Exception:
            vx, vy = 0, 0
        x, y = x - vx, y - vy
        x = max(0, min(x, im.width - 1))
        y = max(0, min(y, im.height - 1))
        w = max(1, min(w, im.width - x))
        h = max(1, min(h, im.height - y))
        im = im.crop((x, y, x + w, y + h))
    return im


def image_hash(im):
    """轻量感知哈希：判断画面是否变化（变化检测省 90% OCR 开销）。

    必须用 8x8 而不是 32x32：1024 bit 转十六进制是 256 字符，
    若再截断取前 16 字符，实际只反映了最上面两行像素 ——
    顶部是白底标题栏时哈希恒定不变，会漏判所有内容变化。
    8x8 = 64 bit = 16 hex 字符，正好一一对应，无需截断。
    """
    try:
        small = im.convert("L").resize((8, 8))
        px = list(small.getdata())
        avg = sum(px) / len(px)
        bits = 0
        for p in px:
            bits = (bits << 1) | (1 if p > avg else 0)
        return f"{bits:016x}"
    except Exception:
        return ""


def to_data_url(im, max_width=None):
    if max_width and im.width > max_width:
        ratio = max_width / im.width
        im = im.resize((max_width, max(1, int(im.height * ratio))))
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def rows_to_parsed(rows, ox, oy, engine_used):
    """按 OCR 引擎选择解析器 —— 这一步不能混用（v2/v3 逻辑不同）。"""
    if engine_used == "rapid" and parser_v3 is not None:
        try:
            return parser_v3.parse(rows, ox, oy)
        except Exception as e:
            log(f"parser_v3 失败，回落 v2: {e}")
    if P2 is not None:
        return P2.parse(rows, ox, oy)
    return {"stem": "", "opts": [], "prog": None, "qtype": ""}


BUTTON_WORDS = ("下一题", "上一题", "交卷", "提交")


def reread_buttons(img_path, rows, res, ox=0, oy=0):
    """版面缺 next/submit 时，对按钮所在横条做一次增强补读。

    为什么需要：Windows OCR 对「蓝底白字」「白底浅橙细字」这类按钮常整块漏读，
    而混合 OCR 只在「选项不够」时才换 RapidOCR，按钮漏读不会触发兜底。

    做法（只处理一条横带，耗时可控）：
      1. 横带 = 已识别到的 prev 按钮所在行；没有就取图底部 18%
      2. 依次尝试：反色灰度、自动对比度、RapidOCR 原图 —— 任一读到按钮字就收
      3. 只收按钮关键词所在行，且与已有行不重复（中心点不落在已有行里）
    返回新增的行（与 rows 同一坐标系，即已加 ox/oy）。
    """
    roles = {z["role"] for z in res.get("zones", [])}
    if "next" in roles and "submit" in roles:
        return []
    from PIL import Image, ImageOps

    im = Image.open(img_path).convert("RGB")
    W, H = im.size
    prev = next((z for z in res.get("zones", []) if z["role"] == "prev"), None)
    if prev:
        cy = prev["y"] - oy + prev["h"] / 2
        band_h = max(60, prev["h"] * 3)
        y0 = int(max(0, cy - band_h / 2))
        y1 = int(min(H, cy + band_h / 2))
    else:
        y0, y1 = int(H * 0.82), H
    if y1 - y0 < 10:
        return []
    band = im.crop((0, y0, W, y1))
    # 放大 2 倍：按钮字通常偏小，放大后两种 OCR 都更稳
    band = band.resize((band.width * 2, band.height * 2), Image.LANCZOS)

    gray = band.convert("L")
    variants = [
        ("invert", ImageOps.invert(ImageOps.autocontrast(gray))),
        ("contrast", ImageOps.autocontrast(gray, cutoff=2)),
    ]
    existing = [(r["x"], r["y"], r["w"], r["h"]) for r in rows]

    def dup(x, y, w, h):
        cx, cy = x + w / 2, y + h / 2
        return any(ex <= cx <= ex + ew and ey <= cy <= ey + eh for ex, ey, ew, eh in existing)

    found = {}

    def collect(rr):
        for r in rr or []:
            t = str(r.get("text") or "").strip()
            word = next((w for w in BUTTON_WORDS if w in t), None)
            if not word or word in found:
                continue
            try:
                # 横带坐标 → 原图坐标（缩放 2 倍 + 横带上边距）→ 屏幕坐标
                x = float(r["x"]) / 2 + ox
                y = float(r["y"]) / 2 + y0 + oy
                w = float(r["w"]) / 2
                h = float(r["h"]) / 2
            except Exception:
                continue
            if dup(x, y, w, h):
                continue
            found[word] = {"text": word, "x": x, "y": y, "w": w, "h": h, "_reread": True}

    def need():
        have = set(found) | {w for w in BUTTON_WORDS if any(w in str(r.get("text") or "") for r in rows)}
        return not ("下一题" in have and ("交卷" in have or "提交" in have))

    for name, img in variants:
        if not need():
            break
        p = os.path.join(HERE, f"_band_{name}.png")
        img.save(p)
        try:
            collect(ocr_engine.recognize(p) if ocr_engine is not None else [])
        except Exception as e:
            log(f"按钮补读（{name}）失败：{e}")
    if need() and ocr_hybrid is not None and hasattr(ocr_hybrid, "rapid_recognize"):
        p = os.path.join(HERE, "_band_rapid.png")
        band.save(p)
        try:
            collect(ocr_hybrid.rapid_recognize(p))
        except Exception as e:
            log(f"按钮补读（rapid）失败：{e}")
    return list(found.values())


def selfcheck_rows(rows, role):
    """按区域角色判定 OCR 结果是否可用。返回 (ok, 一句结论, 明细行)。

    判据与运行期一致：选项要从 A 起连续且 ≥2 个；题干不能为空；
    题号/倒计时要读出数字；按钮要读到对应文字。
    """
    import re as _re
    rows = sorted(rows or [], key=lambda r: (float(r.get("y") or 0), float(r.get("x") or 0)))
    texts = [t for t in (str(r.get("text") or "").strip() for r in rows) if t]
    joined = "".join(texts)
    if role == "options":
        try:
            import layout as _L
            letter = _L._opt_letter
        except Exception:
            def letter(_t):
                return None
        found = [(letter(t), t) for t in texts]
        found = [(l, t) for l, t in found if l]
        seq = [l for l, _ in found]
        exp = [chr(65 + i) for i in range(len(seq))]
        if len(seq) < 2:
            return False, f"只识别到 {len(seq)} 个选项字母", texts[:4]
        if seq != exp:
            return False, "选项字母不连续：" + "".join(seq), [t for _, t in found]
        return True, f"{len(seq)} 个选项：" + "".join(seq), [t for _, t in found]
    if role in ("question", "all"):
        if len(joined) < 6:
            return False, "题干为空或过短", texts
        return True, f"题干 {len(joined)} 字", texts
    if role == "progress":
        m = _re.search(r"第\s*\d+\s*[题道]|\d{1,3}\s*/\s*\d{1,3}", joined)
        return (True, "题号：" + m.group(0), texts) if m else (False, "没读到题号（如 4/72）", texts)
    if role == "timer":
        # OCR 常把冒号读成全角「：」或「∶」
        m = _re.search(r"\d{1,2}\s*[:：∶]\s*\d{2}(\s*[:：∶]\s*\d{2})?", joined)
        return (True, "倒计时：" + m.group(0), texts) if m else (False, "没读到时间", texts)
    if role in ("next", "prev", "submit"):
        want = {"next": ("下一题",), "prev": ("上一题",), "submit": ("交卷", "提交")}[role]
        hit = next((w for w in want if w in joined), None)
        return (True, "按钮：" + hit, texts) if hit else (False, "没读到「" + "/".join(want) + "」", texts)
    return bool(joined), (f"读到 {len(joined)} 字" if joined else "没读到文字"), texts


def check_region_image(crop, role, tag="chk"):
    """对一块区域截图做 OCR 并自检（全屏预览里的「自检」用）。

    小区域先放大：按钮/题号这类几十像素高的块，不放大 OCR 经常读空。
    按钮读不到时再反色读一次（蓝底白字）。
    """
    from PIL import Image, ImageOps
    if role == "figure":
        return True, "图形区（OCR 无效，走视觉通道）", []
    im = crop.convert("RGB")
    if im.height < 60:
        k = min(4, max(2, int(60 / max(1, im.height)) + 1))
        im = im.resize((im.width * k, im.height * k), Image.LANCZOS)
    p = os.path.join(HERE, f"_{tag}.png")
    im.save(p)
    rows = []
    if ocr_hybrid is not None:
        rows = ocr_hybrid.recognize(p, box=None)[0]
    elif ocr_engine is not None:
        rows = ocr_engine.recognize(p)
    out = selfcheck_rows(rows, role)
    # 没通过时反色再读一次：彩底白字（按钮、顶部绿条里的倒计时）Windows OCR 常读空
    if not out[0] and ocr_engine is not None:
        p2 = os.path.join(HERE, f"_{tag}_inv.png")
        ImageOps.invert(ImageOps.autocontrast(im.convert("L"))).save(p2)
        inv = selfcheck_rows(list(rows) + list(ocr_engine.recognize(p2) or []), role)
        if inv[0]:
            return inv[0], inv[1] + "（反色补读）", inv[2]
    return out


def drop_rows_in_regions(rows, regions, ox=0, oy=0):
    """丢掉落在指定区域内的 OCR 行（按行中心点判定）。

    为什么需要：
      用户常把「整块内容区」圈成 all，而这块里包含页面顶部的倒计时
      「剩余时间 32:43」。于是 OCR 题干变成
        "剩余时间32:43模拟考试系统1. 根据《印刷业管理条例》…"
      两个后果都是致命的：
        ① 题干**每秒都在变** → 题库标准化后永远对不上，命中率归零；
        ② 那串与题目无关的字会把解析器带偏。
      倒计时区用户本来就单独圈过（role=timer），所以按它的坐标把这行剔掉，
      比让用户手工把 all 区缩到刚好避开更可靠 —— 后者改一次就要重圈一次。
    """
    if not rows or not regions:
        return rows
    out = []
    for r in rows:
        try:
            cx = float(r.get("x") or 0) + float(r.get("w") or 0) / 2.0 + ox
            cy = float(r.get("y") or 0) + float(r.get("h") or 0) / 2.0 + oy
        except Exception:
            out.append(r)
            continue
        drop = False
        for reg in regions:
            try:
                rx, ry, rw, rh = [float(v) for v in reg[:4]]
            except Exception:
                continue
            if rx <= cx <= rx + rw and ry <= cy <= ry + rh:
                drop = True
                break
        if not drop:
            out.append(r)
    return out


def locate_target_window(title, notes):
    """按标题找窗口并激活；找不到时退回前台窗口。"""
    win = None
    if title and hasattr(winio, "client_rect"):
        # 先激活再取矩形：最小化的窗口不参与匹配，激活后才能拿到真实位置
        try:
            if winio.activate(title):
                time.sleep(0.3)
        except Exception:
            pass
        win = winio.client_rect(title)
        if not win:
            notes.append(f"没找到标题含「{title}」的窗口，改用前台窗口")
    if not win and hasattr(winio, "foreground_client_rect"):
        win = winio.foreground_client_rect()
    return win


def layout_ocr_rows(tmp, ox, oy):
    """OCR 整张图，返回换算到屏幕坐标的行与所用引擎。"""
    if ocr_hybrid is not None:
        rows, _p, used, _why = ocr_hybrid.recognize(tmp, box=None)
    else:
        rows, used = ocr_engine.recognize(tmp), "windows"
    shifted = []
    for r in rows or []:
        try:
            shifted.append({**r, "x": float(r["x"]) + ox, "y": float(r["y"]) + oy})
        except Exception:
            continue
    return shifted, used


LAYOUT_COLORS = {"options": (220, 40, 40), "question": (40, 120, 220), "progress": (40, 170, 70),
                 "timer": (200, 140, 0), "next": (150, 60, 200), "prev": (150, 60, 200), "submit": (0, 0, 0)}


def layout_debug_image(tmp, rows, res, ox, oy):
    """诊断图：灰框为 OCR 行、彩框为推断区域，用来区分坐标偏差与归并规则问题。返回 (路径, 尺寸)。"""
    try:
        from PIL import Image as _Image, ImageDraw as _Draw
        dim = _Image.open(tmp).convert("RGB")
        d = _Draw.Draw(dim)
        for r in rows:
            x, y = r["x"] - ox, r["y"] - oy
            d.rectangle([x, y, x + float(r["w"]), y + float(r["h"])], outline=(150, 150, 150))
        for z in res.get("zones", []):
            x, y = z["x"] - ox, z["y"] - oy
            c = LAYOUT_COLORS.get(z["role"], (255, 0, 255))
            d.rectangle([x, y, x + z["w"], y + z["h"]], outline=c, width=3)
            d.text((x + 3, y + 3), f'{z["role"]} {z.get("conf", "")}', fill=c)
        path = os.path.join(HERE, "_layout_debug.png")
        dim.save(path)
        return path, list(dim.size)
    except Exception as e:
        log(f"版面诊断图生成失败：{e}")
        return None, None



class Handler(BaseHTTPRequestHandler):
    server_version = f"ExamEngine/{VERSION}"
    token = ""

    # 安静：默认 BaseHTTPRequestHandler 会把每个请求打到 stderr
    def log_message(self, fmt, *args):
        return

    def _auth(self):
        if not self.token:
            return True
        auth = self.headers.get("authorization") or ""
        return auth == f"Bearer {self.token}"

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # ── 路由 ────────────────────────────────────────────────
    def do_GET(self):
        if not self._auth():
            return self._send(401, {"error": "unauthorized"})
        if self.path.startswith("/v1/health"):
            return self._health()
        if self.path.startswith("/v1/ping"):
            return self._send(200, {"ok": True, "ts": time.time()})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth():
            return self._send(401, {"error": "unauthorized"})
        routes = {
            "/v1/screenshot": self._screenshot,
            "/v1/ocr": self._ocr,
            "/v1/scroll-capture": self._scroll_capture,
            "/v1/act": self._act_envelope,
            "/v1/probe-colors": self._probe_colors,
            "/v1/read-progress": self._read_progress,
            "/v1/panic": self._panic,
            "/v1/resume": self._resume,
            "/v1/zone/pick": self._zone_pick,
            "/v1/zone/preview": self._zone_preview,
            "/v1/window/focus": self._window_focus,
            "/v1/window/rect": self._window_rect,
            "/v1/layout/detect": self._layout_detect,
            "/v1/overlay/show": self._overlay_show,
            "/v1/overlay/update": self._overlay_update,
            "/v1/overlay/hide": self._overlay_hide,
            "/v1/overlay/actions": self._overlay_actions,
            "/v1/overlay/debug": self._overlay_debug,
            "/v1/host/minimize": self._host_minimize,
            "/v1/host/restore": self._host_restore,
            "/v1/read-timer": self._read_timer,
        }
        for path, fn in routes.items():
            if self.path.startswith(path):
                try:
                    return fn(self._read_json())
                except Exception as e:
                    log(f"ERROR {path}: {e}\n{traceback.format_exc()}")
                    return self._send(500, {"error": f"{type(e).__name__}: {e}"})
        return self._send(404, {"error": "not found"})

    # ── 实现 ────────────────────────────────────────────────
    def _health(self):
        w, h = screen_size()
        engines = []
        if ocr_engine is not None:
            engines.append("windows")
        if ocr_hybrid is not None:
            try:
                if ocr_hybrid.rapid_available():
                    engines.append("rapid")
            except Exception:
                pass
        return self._send(200, {
            "ok": True,
            "version": VERSION,
            "python": sys.version.split()[0],
            "uptime": round(time.time() - STATE["startedAt"], 1),
            "paused": STATE["paused"],
            "actions": STATE["actions"],
            "ocrEngines": engines,
            "screen": {"w": w, "h": h},
            "platform": sys.platform,
        })

    def _screenshot(self, req):
        """截图。

        关于是否隐藏宿主窗口：
          不需要"先缩小 DSH 再展开"的抖动 —— 预览/自检只想要一张图，
          为此把整个界面闪一下很烦。
          所以默认**不隐藏**；只有圈选（用户要在干净画面上画框）才藏。
          需要干净画面时，调用方显式传 hideWindows:true。
        """
        region = req.get("region")
        hidden = []
        if req.get("hideWindows") is True:
            hidden = hide_own_windows()
        try:
            im = grab_image(region)
        finally:
            restore_windows(hidden)
        payload = {
            "ok": True,
            "w": im.width,
            "h": im.height,
            "hash": image_hash(im),
        }
        # 可以同时要"落盘"和"缩略图"：预览要 dataUrl 给人看，
        # 自检要同一个文件来识别 —— 同一张图，才能"看到什么就识别什么"。
        out = req.get("savePath")
        if out:
            im.save(out)
            payload["path"] = out
        if req.get("maxWidth"):
            payload["dataUrl"] = to_data_url(im, int(req["maxWidth"]))
        elif not out:
            payload["dataUrl"] = to_data_url(im, 1280)
        return self._send(200, payload)

    def _ocr(self, req):
        region = req.get("region")
        engine = req.get("engine") or "auto"
        # offset 语义：OCR 行坐标要加上的屏幕原点偏移。
        # 注意 ocr_hybrid.recognize(box=region) 内部已经把 region 原点加过了，
        # 再让 rows_to_parsed 加一次就是双重偏移 —— 表现为"识别位置偏了一整个区域的距离"。
        # 所以这里只在【不传 box】的路径上手动加偏移。
        offset = req.get("offset") or (region[:2] if region else (0, 0))
        ox, oy = int(offset[0]), int(offset[1])
        # 排除区：这些区域内的 OCR 行不参与解析（屏幕绝对坐标）。
        # 典型用途：all 区包含顶部倒计时，倒计时每秒变化会污染题干。
        exclude_regions = req.get("excludeRegions") or []

        # 有 imagePath 就直接识别该文件（回归测试 / 离线复现用）；
        # 否则截图 → 临时 PNG（ocr_engine 接口收路径）
        image_path = req.get("imagePath")
        if image_path:
            tmp = image_path
            if region and not req.get("reuseCached"):
                # 对已有大图按区域裁切（回归测试 / 离线复现用）
                from PIL import Image as _Image
                _im = _Image.open(tmp).convert("RGB")
                x, y, w, h = [int(v) for v in region]
                x = max(0, min(x, _im.width - 1))
                y = max(0, min(y, _im.height - 1))
                w = max(1, min(w, _im.width - x))
                h = max(1, min(h, _im.height - y))
                _im = _im.crop((x, y, x + w, y + h))
                # 裁切后这张图的原点就是 (x, y) —— 必须用裁切后的实际原点
                ox, oy = x, y
                cropped = os.path.join(HERE, "_work_crop.png")
                _im.save(cropped)
                tmp = cropped
            elif req.get("reuseCached"):
                # 复用缓存图：这张图**本身就是目标区域**，不能再加任何偏移，
                # 否则识别出的坐标会整体偏移一个区域的距离。
                ox, oy = 0, 0
            # 图已就位（裁切或复用），不能再让 ocr_hybrid 按 region 加偏移
            box_for_ocr = None
            im = None
        else:
            # 实时截图识别。
            # 默认**不隐藏**宿主窗口：识别区域是用户自己圈的，
            # 已经避开了 DSH 界面；为了 OCR 再把界面闪一下毫无必要。
            # （hideWindows:true）。
            hidden = []
            if req.get("hideWindows") is True:
                hidden = hide_own_windows()
            try:
                im = grab_image(region)
            finally:
                restore_windows(hidden)
            tmp = os.path.join(HERE, "_work.png")
            im.save(tmp)
            # 图已被 grab_image 裁成 region 大小，图内坐标 + region 原点 = 屏幕坐标。
            # 不能把 region 当 box 传（会再加一次）。
            box_for_ocr = None

        t0 = time.perf_counter()
        rows, used = [], "none"
        # 统一口径（关键，别再改乱）：
        #   tmp 这张图**已经被裁成 region 大小**，所以 OCR 行坐标是图内相对坐标。
        #   屏幕坐标 = 图内坐标 + (ox, oy)，其中 ox/oy 是裁切的实际原点。
        #   因此：
        #     * 不能把 region 当 box 传给 ocr_hybrid（它会再加一次 → 双重偏移）
        #     * 必须由 rows_to_parsed(rows, ox, oy) 施加偏移
        if ocr_hybrid is not None and engine in ("auto", "hybrid", "rapid"):
            rows, _parsed_unused, used, _why = ocr_hybrid.recognize(tmp, box=None)
            # 剔掉落在「排除区」里的行（典型：all 区把倒计时也框进去了）。
            # 必须在解析**之前**剔 —— 解析器一旦把那串字拼进题干，就补不回来了。
            rows = drop_rows_in_regions(rows, exclude_regions, ox, oy)
            parsed = rows_to_parsed(rows, ox, oy, used)
        elif ocr_engine is not None:
            rows = ocr_engine.recognize(tmp)
            used = "windows"
            rows = drop_rows_in_regions(rows, exclude_regions, ox, oy)
            parsed = rows_to_parsed(rows, ox, oy, used)
        else:
            return self._send(503, {"error": "没有可用的 OCR 引擎"})
        ms = (time.perf_counter() - t0) * 1000

        if im is None:
            try:
                from PIL import Image as _Image
                im = _Image.open(tmp)
            except Exception:
                im = None

        return self._send(200, {
            "ok": True,
            "rows": rows,
            "parsed": parsed,
            "engineUsed": used,
            "ms": round(ms, 1),
            "hash": image_hash(im) if im is not None else "",
        })

    def _scroll_capture(self, req):
        if P2 is None:
            return self._send(503, {"error": "解析器不可用"})
        import scroll_v2
        region = req.get("region")
        parsed, meta = scroll_v2.read_question_full(
            tuple(int(v) for v in region), max_shots=int(req.get("maxShots") or 4)
        )
        return self._send(200, {"ok": True, "parsed": parsed, "meta": meta})

    def _panic(self, req):
        STATE["paused"] = True
        return self._send(200, {"ok": True, "paused": True})

    def _resume(self, req):
        STATE["paused"] = False
        return self._send(200, {"ok": True, "paused": False})

    def _zone_preview(self, req):
        """全屏预览：让开 DSH → 截整屏 → 交给 ZonePreview 显示区域框与逐区域自检。

        为什么是全屏而不是只给裁图：确认"框有没有框对"必须在整屏上下文里看。
        截图前先隐藏宿主窗口（否则截到的是 DSH 自己），结束时一定恢复。
        """
        try:
            import ctypes
            import tkinter as tk
            from PIL import Image, ImageGrab, ImageTk
            from preview import ZonePreview
        except Exception as e:
            return self._send(503, {"error": f"预览依赖不可用: {e}"})
        dpi_aware()
        regions = req.get("regions") or []
        timeout_ms = int(req.get("timeoutMs") or 300000)

        hidden = hide_own_windows()
        time.sleep(0.15)
        try:
            shot = ImageGrab.grab(all_screens=True)
        except Exception as e:
            restore_windows(hidden)
            return self._send(503, {"error": f"截图失败: {e}"})
        try:
            view = ZonePreview(shot, regions, check_region_image, tk, Image, ImageTk, ctypes)
            out = view.run(timeout_ms)
        finally:
            restore_windows(hidden)
            if hidden:
                try:
                    time.sleep(0.1)
                    ctypes.windll.user32.SetForegroundWindow(hidden[0])
                except Exception:
                    pass
        return self._send(200, {"ok": True, **out, "screen": {"w": shot.size[0], "h": shot.size[1]}})

    def _zone_pick(self, req):
        """圈选：起一个 Tk 全屏窗口让用户拖框，返回区域组。

        顺序：最小化宿主 → 截底图 → 保持宿主最小化弹全屏圈选窗 → 结束后恢复宿主。
        交互细节见 picker.ZonePicker。
        """
        try:
            import ctypes
            dpi_aware()
            from PIL import Image, ImageGrab, ImageTk
            import tkinter as tk
        except Exception as e:
            return self._send(503, {"error": f"圈选依赖不可用: {e}"})

        dpi_aware()

        # 截图后不能立刻恢复宿主：宿主回到前台会抢走圈选窗的键盘焦点，底图也可能截到宿主
        hidden = hide_own_windows()
        # 多等一会：Windows 的最小化动画约 200-350ms，抢早了会截到残影
        time.sleep(0.15)
        try:
            shot = ImageGrab.grab(all_screens=True)
        except Exception as e:
            restore_windows(hidden)
            return self._send(503, {"error": f"截图失败: {e}"})
        SW, SH = shot.size
        timeout_ms = int(req.get("timeoutMs") or 180000)
        result = {"box": None, "cancelled": False}
        try:
            from picker import ZonePicker

            result = ZonePicker(shot, tk, ImageTk, ctypes).run(timeout_ms)
        finally:
            # 无论保存、取消、超时还是异常都要恢复宿主
            restore_windows(hidden)
            # 把 DSH 窗口提到前台，避免"圈完了但界面还在后面"
            if hidden:
                try:
                    import ctypes

                    time.sleep(0.1)
                    ctypes.windll.user32.SetForegroundWindow(hidden[0])
                except Exception:
                    pass

        box = result["box"]
        if result.get("cancelled"):
            return self._send(200, {"ok": False, "cancelled": True, "error": "已取消", "screen": {"w": SW, "h": SH}})
        if not box or box[2] < 20 or box[3] < 20:
            return self._send(200, {"ok": False, "error": "未圈选或区域过小", "screen": {"w": SW, "h": SH}})
        return self._send(200, {
            "ok": True,
            "box": {"x": box[0], "y": box[1], "w": box[2], "h": box[3]},
            "display": {"w": SW, "h": SH},
        })

    def _window_focus(self, req):
        if not winio:
            return self._send(503, {"error": "winio 不可用"})
        ok = winio.activate(str(req.get("title") or ""))
        return self._send(200, {"ok": bool(ok)})

    def _layout_detect(self, req):
        """自动版面识别：截图（或用 imagePath）→ OCR 原始行 → layout.detect。

        参数：region=[x,y,w,h]（屏幕坐标，可省略=全屏）、或 title（按窗口客户区截）、
              imagePath（离线图，坐标为图内坐标）。
        返回的 zones 是屏幕绝对坐标；若按窗口截图，同时返回 window 矩形，
        调用方可用 zones.js 的 toRelative 存成比例坐标。
        """
        try:
            import layout as layout_mod
        except Exception as e:
            return self._send(503, {"error": f"layout 模块不可用：{e}"})
        if ocr_hybrid is None and ocr_engine is None:
            return self._send(503, {"error": "没有可用的 OCR 引擎"})

        res_cap = self._layout_capture(req)
        if res_cap.get("error"):
            return self._send(503, {"error": res_cap["error"]})
        tmp, ox, oy, win = res_cap["tmp"], res_cap["ox"], res_cap["oy"], res_cap["win"]

        t0 = time.perf_counter()
        shifted, used = layout_ocr_rows(tmp, ox, oy)
        res = layout_mod.detect(shifted)
        # 按钮补读：彩底白字（下一题）、浅色细字（交卷）Windows OCR 常整块漏掉
        try:
            extra = reread_buttons(tmp, shifted, res, ox, oy)
            if extra:
                shifted = shifted + extra
                res = layout_mod.detect(shifted)
                res["notes"] = list(res.get("notes") or []) + [f"按钮补读新增 {len(extra)} 行：" + "、".join(r["text"] for r in extra)]
        except Exception as e:
            log(f"按钮补读失败：{e}")
        debug_path, size = layout_debug_image(tmp, shifted, res, ox, oy)
        return self._send(200, {
            "debugImage": debug_path,
            "imageSize": size,
            "ok": True,
            "engine": used,
            "ms": round((time.perf_counter() - t0) * 1000, 1),
            "window": win,
            "rows": len(shifted),
            **res,
            "notes": res_cap["notes"] + list(res.get("notes") or []),
        })

    def _layout_capture(self, req):
        """确定识别区域并截图。返回 {tmp, ox, oy, win, notes}；ox/oy 为图内坐标到屏幕坐标的偏移。"""
        region = req.get("region")
        title = str(req.get("title") or "")
        image_path = req.get("imagePath")
        notes, win = [], None
        if image_path:
            return {"tmp": image_path, "ox": 0, "oy": 0, "win": None, "notes": notes}
        hidden = hide_own_windows() if req.get("hideWindows") is True else []
        try:
            # 定位目标窗口要在 DSH 让开之后做：此时前台才是考试窗口
            if not region and winio:
                win = locate_target_window(title, notes)
                if win:
                    region = [win["x"], win["y"], win["w"], win["h"]]
                else:
                    notes.append("没定位到目标窗口，按整屏识别")
            im = grab_image(region)
        finally:
            restore_windows(hidden)
        tmp = os.path.join(HERE, "_layout.png")
        im.save(tmp)
        if region:
            ox, oy = int(region[0]), int(region[1])
        else:
            # 整屏截图的 (0,0) 是虚拟桌面左上角，多屏时可能是负坐标
            try:
                ox, oy = winio.virtual_screen_origin() if winio else (0, 0)
            except Exception:
                ox, oy = 0, 0
        return {"tmp": tmp, "ox": ox, "oy": oy, "win": win, "notes": notes}

    def _window_rect(self, req):
        """返回目标窗口客户区的屏幕矩形，供区域按比例坐标解析。"""
        if not winio or not hasattr(winio, "client_rect"):
            return self._send(503, {"error": "winio 不可用"})
        rect = winio.client_rect(str(req.get("title") or ""))
        if not rect:
            return self._send(200, {"ok": False, "error": "未找到窗口或窗口已最小化"})
        return self._send(200, {"ok": True, "rect": rect})

    # ── 运行期悬浮窗──────────────────────────
    def _overlay_get(self, create=False):
        """取（必要时创建并启动）悬浮窗控制器。"""
        if overlay_mod is None:
            return None, "overlay 模块不可用（缺少 tkinter/Pillow）"
        ov = STATE.get("overlay")
        if ov is None and create:
            ov = overlay_mod.Overlay(log=log)
            STATE["overlay"] = ov
            if not ov.start():
                err = ov.error() or "悬浮窗启动失败"
                STATE["overlay"] = None
                return None, err
        return ov, None

    def _overlay_show(self, req):
        """显示悬浮窗并可选地立刻写入首帧状态。

        为什么要"创建即显示"：用户点「开始」后 DSH 立刻最小化，
        中间不能有一段时间屏幕上什么都没有 —— 那会让人以为程序退了。
        """
        ov, err = self._overlay_get(create=True)
        if ov is None:
            return self._send(503, {"ok": False, "error": err})
        ov.show(req.get("state") or {})
        return self._send(200, {
            "ok": True,
            "visible": bool(ov.is_visible()),
            "capture_excluded": True,
        })

    def _overlay_update(self, req):
        ov, err = self._overlay_get(create=False)
        if ov is None:
            return self._send(200, {"ok": False, "error": err or "悬浮窗未启动"})
        ov.update(req.get("state") or {})
        return self._send(200, {"ok": True})

    def _overlay_hide(self, req):
        ov = STATE.get("overlay")
        if ov is not None:
            ov.hide()
            time.sleep(0.1)
        return self._send(200, {"ok": True})

    def _overlay_actions(self, req):
        """宿主轮询用户点了悬浮窗上的哪个按钮。"""
        ov = STATE.get("overlay")
        if ov is None:
            return self._send(200, {"ok": True, "actions": []})
        return self._send(200, {"ok": True, "actions": ov.take_actions()})

    def _overlay_debug(self, req):
        """进程内自证：临时解除截图排除并抓一张，确认窗口真的画出来了。

        只有窗口所属进程能解除排除 —— 外部截图永远看不到它，
        所以"到底渲染没有"必须由引擎自己回答。
        """
        ov = STATE.get("overlay")
        if ov is None:
            return self._send(200, {"ok": False, "error": "悬浮窗未创建"})
        path = req.get("savePath") or os.path.join(HERE, "_overlay.png")
        return self._send(200, ov.debug_dump(path))

    def _host_minimize(self, req):
        """运行开始：最小化宿主并保持。返回句柄，等 stop 时恢复。"""
        handles = minimize_host_windows()
        STATE["hostMinimized"] = handles
        return self._send(200, {"ok": True, "count": len(handles)})

    def _host_restore(self, req):
        handles = STATE.get("hostMinimized") or []
        n = restore_host_windows(handles)
        STATE["hostMinimized"] = []
        return self._send(200, {"ok": True, "count": n})

    def _read_timer(self, req):
        """读倒计时区（悬浮窗显示考试剩余时间）。

        为什么单独一个端点而不是复用 _read_progress：
          题号是 "4/72"（数字/数字），倒计时是 "剩余时间 32:43"（时:分），
          正则不同，而且倒计时区是白字绿底小字号，需要更大放大倍数。

        scale 为什么必须是 3.0：
          默认 2.5 时同一块区域 Windows OCR 返回空串；
          3.0 时稳定读到 "剩余时间32:43"。这跟 _read_progress 用 3.0
          是同一个原因 —— 小字号数字必须放大才认得准。
        """
        import re as _re
        import ocr_engine as _ocr

        region = req.get("region")
        if not region:
            return self._send(400, {"error": "region 必填（timer 区坐标）"})
        try:
            im = grab_image(region)
            tmp = os.path.join(HERE, "_timer.png")
            im.save(tmp)
        except Exception as e:
            return self._send(503, {"error": f"截图失败: {e}"})

        rows = []
        used = "none"
        try:
            rows = _ocr.recognize(tmp, scale=3.0)
            used = "windows"
        except Exception as e:
            log(f"timer OCR(windows) 失败: {e}")
        # Windows 读不到时才找 RapidOCR 兜底 —— 大多数机器上 rapid 是可选的
        if not rows and ocr_hybrid is not None:
            try:
                rows = ocr_hybrid.rapid_recognize(tmp) or []
                if rows:
                    used = "rapid"
            except Exception as e:
                log(f"timer OCR(rapid) 失败: {e}")

        text_all = " ".join(str(r.get("text") or "") for r in rows).strip()
        # OCR 常把 ":" 读成全角冒号，统一一下再解析
        norm = text_all.replace("：", ":")
        secs = None
        m = _re.search(r"(\d{1,2})\s*:\s*(\d{1,2})", norm)
        if m:
            secs = int(m.group(1)) * 60 + int(m.group(2))
        else:
            m2 = _re.search(r"(\d{1,2})\s*小时\s*(\d{1,2})\s*分", text_all)
            if m2:
                secs = int(m2.group(1)) * 3600 + int(m2.group(2)) * 60

        return self._send(200, {
            "ok": secs is not None,
            "seconds": secs,
            "text": text_all,
            "engine": used,
        })

    def _probe_colors(self, req):
        """采样像素颜色，用于判断"选项是否被选中"。

        为什么不用像素哈希判选中：
          点选答案会让选项底色变化，但整块哈希也会跟着变 ——
          既无法区分"选项被选中"和"页面刚重绘"，又会误判翻页成功。
          直接采样目标点颜色再与"未选中色"比对，语义才明确。

        入参 points: [{x, y, label?}]  screen 坐标
        返回每点的 RGB 与是否偏离基准色。
        """
        try:
            from PIL import ImageGrab
        except Exception as e:
            return self._send(503, {"error": f"PIL 不可用: {e}"})

        points = req.get("points") or []
        if not isinstance(points, list) or not points:
            return self._send(400, {"error": "points 必填且非空"})

        dpi_aware()
        im = ImageGrab.grab(all_screens=True).convert("RGB")
        out = []
        for p in points[:64]:
            try:
                x, y = int(p["x"]), int(p["y"])
            except Exception:
                continue
            if x < 0 or y < 0 or x >= im.width or y >= im.height:
                out.append({"label": p.get("label"), "error": "out_of_bounds"})
                continue
            # 取 3x3 均值，抗单像素噪声
            rs = gs = bs = n = 0
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    r, g, b = im.getpixel((x + dx, y + dy))
                    rs += r
                    gs += g
                    bs += b
                    n += 1
            out.append({
                "label": p.get("label"),
                "x": x,
                "y": y,
                "rgb": [round(rs / n), round(gs / n), round(bs / n)],
            })
        return self._send(200, {"ok": True, "points": out})

    def _read_progress(self, req):
        """OCR 读取 progress 区，解析出 "4/72"。翻页验证的唯一可靠依据。"""
        import re as _re
        import ocr_engine as _ocr

        region = req.get("region")
        if not region:
            return self._send(400, {"error": "region 必填（progress 区坐标）"})
        im = grab_image(region)
        tmp = os.path.join(HERE, "_prog.png")
        im.save(tmp)
        # 小字号数字要放大，否则 OCR 常把 "/" 丢掉
        rows = _ocr.recognize(tmp, scale=float(req.get("scale") or 3.0))
        for r in rows:
            text = str(r.get("text") or "")
            m = _re.search(r"(\d+)\s*[/／]\s*(\d+)", text)
            if m:
                return self._send(200, {
                    "ok": True,
                    "progress": [int(m.group(1)), int(m.group(2))],
                    "text": text,
                })
        return self._send(200, {"ok": False, "progress": None, "text": "", "error": "未识别到题号"})

    def _act_envelope(self, req):
        """执行一个动作信封（插件侧已校验过白名单，这里再做一层防御性校验）。

        引擎不认识"模型"也不认识"策略"，只做三件事：
          1. 闸门（paused / STOP 文件）
          2. 白名单（动作名必须是本引擎实现的那些）
          3. 执行 + 回执（前后哈希，供上层验证）
        """
        if STATE["paused"]:
            return self._send(409, {"ok": False, "error": "paused", "reason": "引擎处于暂停状态"})
        if STATE["stopFile"] and os.path.exists(STATE["stopFile"]):
            STATE["paused"] = True
            return self._send(409, {"ok": False, "error": "stopped", "reason": "检测到 STOP 文件"})
        if not winio:
            return self._send(503, {"error": "winio 不可用"})

        action = str(req.get("action") or "")
        params = req.get("params") or {}
        region = req.get("region")

        try:
            before_im = grab_image(region)
            before_hash = image_hash(before_im)
        except Exception:
            before_hash = ""

        try:
            if action == "click_point":
                winio.click(int(params["x"]), int(params["y"]))
            elif action == "scroll":
                x = params.get("x", 0)
                y = params.get("y", 0)
                winio.scroll(int(x), int(y), int(params.get("dy", -120)))
            elif action == "focus_window":
                winio.activate(str(params.get("title") or ""))
            elif action == "press_key":
                self._press_key(str(params.get("key") or ""))
            elif action == "type_text":
                self._type_text(str(params.get("text") or ""))
            elif action == "wait":
                time.sleep(min(10.0, max(0.0, float(params.get("ms", 100)) / 1000.0)))
            else:
                return self._send(400, {"ok": False, "error": f"引擎不支持的动作: {action}"})
        except Exception as e:
            return self._send(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

        STATE["actions"] += 1
        STATE["lastAction"] = {"action": action, "params": params, "at": time.time()}

        if params.get("settleMs"):
            time.sleep(min(3.0, float(params["settleMs"]) / 1000.0))

        try:
            after_hash = image_hash(grab_image(region))
        except Exception:
            after_hash = ""

        return self._send(200, {
            "ok": True,
            "actions": STATE["actions"],
            "beforeHash": before_hash,
            "afterHash": after_hash,
            "changed": before_hash != after_hash,
        })

    def _press_key(self, key):
        """按键。用 Win32 keybd_event，避免额外依赖。"""
        import ctypes

        MAP = {
            "enter": 0x0D,
            "tab": 0x09,
            "escape": 0x1B,
            "space": 0x20,
            "backspace": 0x08,
            "delete": 0x2E,
            "up": 0x26,
            "down": 0x28,
            "left": 0x25,
            "right": 0x27,
            "home": 0x24,
            "end": 0x23,
            "pageup": 0x21,
            "pagedown": 0x22,
        }
        vk = MAP.get(str(key).lower())
        if vk is None:
            raise ValueError(f"不支持的按键: {key}")
        u32 = ctypes.windll.user32
        u32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.03)
        u32.keybd_event(vk, 0, 2, 0)  # KEYEVENTF_KEYUP

    def _type_text(self, text):
        """输入文本。走剪贴板粘贴，比逐字符 keybd_event 稳（中文/特殊字符都行）。"""
        if not text:
            return
        try:
            import ctypes

            u32 = ctypes.windll.user32
            k32 = ctypes.windll.kernel32
            # 打开剪贴板
            for _ in range(10):
                if u32.OpenClipboard(None):
                    break
                time.sleep(0.05)
            else:
                raise RuntimeError("无法打开剪贴板")
            try:
                u32.EmptyClipboard()
                data = text.encode("utf-16-le") + b"\x00\x00"
                GMEM_MOVEABLE = 0x0002
                h = k32.GlobalAlloc(GMEM_MOVEABLE, len(data))
                p = k32.GlobalLock(h)
                ctypes.memmove(p, data, len(data))
                k32.GlobalUnlock(h)
                CF_UNICODETEXT = 13
                u32.SetClipboardData(CF_UNICODETEXT, h)
            finally:
                u32.CloseClipboard()
            time.sleep(0.05)
            VK_CONTROL, VK_V = 0x11, 0x56
            u32.keybd_event(VK_CONTROL, 0, 0, 0)
            u32.keybd_event(VK_V, 0, 0, 0)
            time.sleep(0.03)
            u32.keybd_event(VK_V, 0, 2, 0)
            u32.keybd_event(VK_CONTROL, 0, 2, 0)
        except Exception as e:
            raise RuntimeError(f"文本输入失败: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, help="引擎状态目录（写 engine.json）")
    ap.add_argument("--port", type=int, default=0, help="0 = 系统随机分配")
    ap.add_argument("--token", default="")
    args = ap.parse_args()

    os.makedirs(args.data_dir, exist_ok=True)
    token = args.token or secrets.token_urlsafe(24)
    Handler.token = token
    STATE["stopFile"] = os.path.join(args.data_dir, "STOP")
    # 用户纠错词典（可选）：存在则 ocr_engine 自动叠加到内置表上
    corrections = os.path.join(args.data_dir, "corrections.json")
    os.environ["EXAM_CORRECTIONS"] = corrections
    # 临时文件目录：必须在数据目录下，vendor/ 在插件安装目录里可能只读
    os.environ.setdefault("TMP", os.environ.get("TEMP", args.data_dir))

    # 只监听回环地址：这个服务能截图和点鼠标，绝不能暴露到网络
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    port = httpd.server_address[1]

    info = {
        "port": port,
        "token": token,
        "pid": os.getpid(),
        "version": VERSION,
        "python": sys.version.split()[0],
        "startedAt": time.time(),
    }
    info_path = os.path.join(args.data_dir, "engine.json")
    tmp = info_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=1)
    try:
        os.chmod(tmp, 0o600)
    except Exception:
        pass
    os.replace(tmp, info_path)

    log(f"监听 127.0.0.1:{port}  data-dir={args.data_dir}")
    log(f"engine.json 已写入（含 token，权限 0600）")

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    try:
        while True:
            time.sleep(1.0)
            # STOP 文件 = 第三种急停手段，外部 touch 即可
            if STATE["stopFile"] and os.path.exists(STATE["stopFile"]):
                if not STATE["paused"]:
                    STATE["paused"] = True
                    log("检测到 STOP 文件，已暂停所有动作")
    except KeyboardInterrupt:
        log("收到退出信号")
    finally:
        # 引擎退出前必须收掉悬浮窗并恢复宿主窗口，
        # 否则用户会看到"DSH 不见了、只剩一个小黑框"的僵尸状态。
        try:
            ov = STATE.get("overlay")
            if ov is not None:
                ov.stop()
        except Exception:
            pass
        try:
            restore_host_windows(STATE.get("hostMinimized") or [])
            STATE["hostMinimized"] = []
        except Exception:
            pass
        httpd.shutdown()
        return 0


if __name__ == "__main__":
    sys.exit(main())
