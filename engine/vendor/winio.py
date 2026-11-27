# -*- coding: utf-8 -*-
"""全屏截图（DPI 感知）与鼠标点击，纯 Python + ctypes。

用法:
  python winio.py grab  <输出png>
  python winio.py click <x> <y>
"""
import sys, ctypes, ctypes.wintypes as wt

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass



def _norm_title(t):
    """标题比对前去掉所有空白：页面标题里「·」两侧的空格常被用户手打时省略。"""
    return "".join(str(t or "").split())


def title_matches(title_part, actual):
    part = _norm_title(title_part)
    return bool(part) and part in _norm_title(actual)

def make_dpi_aware():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def grab(path):
    make_dpi_aware()
    from PIL import ImageGrab
    im = ImageGrab.grab(all_screens=True)
    im.save(path)
    print(f"OK {im.width}x{im.height} -> {path}")
    return 0


def click(x, y):
    make_dpi_aware()
    u32 = ctypes.windll.user32
    u32.SetCursorPos(int(x), int(y))
    ctypes.windll.user32.mouse_event(0x0002, 0, 0, 0, 0)
    ctypes.windll.kernel32.Sleep(40)
    ctypes.windll.user32.mouse_event(0x0004, 0, 0, 0, 0)
    print(f"CLICK {x} {y}")
    return 0


def activate(title_part):
    """按标题片段激活窗口（自绘窗口失焦会暂停渲染，截图前必须先激活）。"""
    make_dpi_aware()
    u32 = ctypes.windll.user32
    found = []

    EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def cb(hwnd, _):
        if not u32.IsWindowVisible(hwnd):
            return True
        n = u32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        u32.GetWindowTextW(hwnd, buf, n + 1)
        if title_matches(title_part, buf.value):
            found.append(hwnd)
        return True

    u32.EnumWindows(EnumProc(cb), 0)
    if not found:
        return False
    h = found[0]
    u32.ShowWindow(h, 9)          # SW_RESTORE
    u32.SetForegroundWindow(h)
    return True


def _rect_of(h):
    """窗口客户区的屏幕矩形（物理像素，需已 DPI aware）。"""
    u32 = ctypes.windll.user32
    r = wt.RECT()
    if not u32.GetClientRect(h, ctypes.byref(r)):
        return None
    pt = wt.POINT(0, 0)
    u32.ClientToScreen(h, ctypes.byref(pt))
    w, hh = r.right - r.left, r.bottom - r.top
    if w <= 0 or hh <= 0:
        return None
    n = u32.GetWindowTextLengthW(h)
    buf = ctypes.create_unicode_buffer(n + 1)
    u32.GetWindowTextW(h, buf, n + 1)
    return {"x": pt.x, "y": pt.y, "w": w, "h": hh, "hwnd": int(h), "title": buf.value}


def foreground_client_rect(skip_titles=("DeepSeek Harness",)):
    """当前前台窗口的客户区矩形。没填窗口标题时用它代替「全屏」。
    前台是 DSH 自己（或最小化）时返回 None。"""
    make_dpi_aware()
    u32 = ctypes.windll.user32
    h = u32.GetForegroundWindow()
    if not h or u32.IsIconic(h):
        return None
    rect = _rect_of(h)
    if not rect or any(s in rect["title"] for s in skip_titles):
        return None
    return rect


def virtual_screen_origin():
    """多显示器时虚拟桌面左上角可能是负坐标（副屏在主屏左/上方）。"""
    u32 = ctypes.windll.user32
    return u32.GetSystemMetrics(76), u32.GetSystemMetrics(77)  # SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN


def client_rect(title_part):
    """按标题片段找窗口，返回其客户区在屏幕坐标下的矩形 {x,y,w,h}；找不到返回 None。

    区域以「相对客户区比例」保存后，运行期用它把比例换回绝对像素，
    这样目标窗口移动或缩放后区域仍然对得上。
    """
    make_dpi_aware()
    u32 = ctypes.windll.user32
    found = []
    EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def cb(hwnd, _):
        if not u32.IsWindowVisible(hwnd) or u32.IsIconic(hwnd):
            return True
        n = u32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        u32.GetWindowTextW(hwnd, buf, n + 1)
        # 跳过 DSH 自己：浏览器标签/面板标题里也可能含有这段文字
        if title_matches(title_part, buf.value) and "DeepSeek Harness" not in buf.value:
            found.append(hwnd)
        return True

    u32.EnumWindows(EnumProc(cb), 0)
    if not found:
        return None
    # 同名多个窗口时取面积最大的（通常是主窗口，而不是同进程的小弹窗/工具条）
    rects = [r for r in (_rect_of(h) for h in found) if r]
    if not rects:
        return None
    return max(rects, key=lambda r: r["w"] * r["h"])


def scroll(x, y, delta):
    """在 (x,y) 处滚动滚轮。delta 为 Windows wheel 单位：
    正数 = 向上滚，负数 = 向下滚。一格 = 120。"""
    make_dpi_aware()
    u32 = ctypes.windll.user32
    u32.SetCursorPos(int(x), int(y))
    ctypes.windll.kernel32.Sleep(60)
    # mouse_event 的 dwData 是 DWORD，负数需转成 32 位无符号
    d = int(delta) & 0xFFFFFFFF
    u32.mouse_event(0x0800, 0, 0, d, 0)   # MOUSEEVENTF_WHEEL
    return True


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    if cmd == "grab" and len(sys.argv) >= 3:
        return grab(sys.argv[2])
    if cmd == "click" and len(sys.argv) >= 4:
        return click(int(sys.argv[2]), int(sys.argv[3]))
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
