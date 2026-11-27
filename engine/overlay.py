# -*- coding: utf-8 -*-
"""运行期置顶悬浮窗：脱离 DSH 的独立原生窗口。

为什么必须脱离 DSH：
  点「开始」后 DSH 必须立刻最小化 —— 否则引擎截图截到的是 DSH 自己，
  OCR 读到的是聊天记录，整场运行必然失败（实测 pauseReason=low_confidence）。
  但 DSH 一最小化，面板就看不见了，用户不知道在跑没在跑、跑到第几题。
  所以状态窗必须由引擎自己画：置顶、无边框、不进 Alt-Tab。

三个 Windows 细节（都本机实测过，别改回去）：

  1. **WDA_EXCLUDEFROMCAPTURE 让本窗口不出现在任何截图里**。
     这是「用户看得见、OCR 看不见」的唯一可靠手段。
     一开始想靠"把悬浮窗放到 OCR 区域之外"回避，但用户随时可以圈选新区域，
     区域一改就失效；而且截图排除是系统级保证，比几何避让可靠。
     ⚠ 前提是进程必须 per-monitor DPI aware（见 ensure_dpi_aware），
     否则坐标按 96dpi 算会偏，探测时会误判成"这个 API 没生效"。

  2. **WS_EX_NOACTIVATE**：点按钮不抢焦点，考试界面不会因为用户点了一下
     悬浮窗就失去输入焦点（自绘考试页失焦会暂停渲染）。

  3. **WS_EX_TOOLWINDOW**：不出现在 Alt-Tab / 任务栏。运行期多出一个
     任务栏图标会让人以为开了第二个程序。

线程模型（必须这样）：
  tkinter 的 mainloop 必须在**创建它的线程**里跑，跨线程调 widget 方法不安全。
  所以 HTTP handler（主线程）只往 self._state 写字典，UI 线程用
  root.after(200) 自己读并重绘。共享的只有普通 dict 赋值，靠 GIL 足够。
"""

import ctypes
import ctypes.wintypes as wt
import threading
import time

# 窗口外观
# 宽度按最长可能文案定：420 是"⚠ 剩余时间不足 1 分钟！ · 置信度不足，请人工确认"
# 这类拼接文案仍能一行放下的宽度。
# 高度不再写死 —— 由 tk 的 reqheight 实测决定（见 _run），
# 因为提示行可能换行成两行，任何固定值都会在某个文案下裁掉内容。
_WIDTH = 420
_MIN_HEIGHT = 150
# 步骤轨道（5 行）+ 历史（3 行）+ 状态栏 + 可展开的待复核清单，320 放不下
_MAX_HEIGHT = 560
# 步骤节奏：每一步变 ✓ 后至少停留这么久，再点亮下一步（秒）
_STEP_DWELL = 0.4
# 同一步超过这么久变黄提示「响应较慢」（秒）
_STEP_SLOW = 60
_SPIN = "◐◓◑◒"
_MARGIN = 24
_NOTE_WRAP = _WIDTH - 34

_BG = "#101318"
_FG = "#e5e7eb"
_DIM = "#9aa4b2"
_OK = "#22c55e"
_WARN = "#f59e0b"
_BAD = "#ef4444"
_ACCENT = "#7dd3fc"

# Win32 常量
GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020  # 仅用于"点击穿透"，本窗不用（要能点按钮）
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WDA_EXCLUDEFROMCAPTURE = 0x00000011
SPI_GETWORKAREA = 0x0030
SW_SHOWNOACTIVATE = 4


def ensure_dpi_aware():
    """声明 per-monitor DPI aware。

    不调用它的话 GetSystemMetrics 返回 96dpi 逻辑尺寸，
    而 ImageGrab / 窗口坐标是物理像素 —— 在多倍缩放屏上会差一倍，
    表现为"窗口明明创建成功了，截图里却找不到"，极难排查。
    """
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def work_area():
    """主屏工作区（排除任务栏）。失败回落整屏尺寸。"""
    try:
        r = wt.RECT()
        ok = ctypes.windll.user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(r), 0)
        if ok and r.right > r.left and r.bottom > r.top:
            return (r.left, r.top, r.right - r.left, r.bottom - r.top)
    except Exception:
        pass
    u32 = ctypes.windll.user32
    return (0, 0, u32.GetSystemMetrics(0), u32.GetSystemMetrics(1))


def _hwnd_of(root):
    """tk 的 winfo_id() 给的是内部子窗口，要往上爬到真正 top-level。"""
    u32 = ctypes.windll.user32
    h = root.winfo_id()
    for _ in range(5):
        p = u32.GetParent(ctypes.c_void_p(h))
        if not p:
            break
        h = p
    return h


class Overlay:
    """置顶状态窗。线程安全：update() 只写 dict，UI 线程自己读。"""

    def __init__(self, log=None):
        self._log = log or (lambda m: None)
        self._lock = threading.Lock()
        self._state = {}
        self._visible = False
        self._want_show = False
        self._want_hide = False
        self._actions = []  # 用户点按钮产生的事件，等宿主取走
        self._thread = None
        self._root = None
        self._hwnd = None
        self._ready = threading.Event()
        self._shown_evt = threading.Event()
        self._failed = None
        self._labels = {}
        self._started_at = time.time()
        self._cur_h = 0

    # ── 对外接口（主线程可调）──────────────────────────────
    def available(self):
        """UI 线程是否真的起来了。False 时宿主应退回"不显示悬浮窗"。"""
        return self._ready.is_set() and self._failed is None

    def error(self):
        return self._failed

    def hwnd(self):
        return self._hwnd

    def show(self, state=None, wait=True):
        """请求显示。wait=True 时等到 UI 线程真的把它显示出来再返回。

        为什么必须等：
          只写 _want_show 就返回的话，调用方会立刻拿到 visible:false ——
          因为 UI 线程每 200ms 才 tick 一次。宿主那边据此判定"悬浮窗没起来"
          就会挂页内悬浮窗，而页内那个在 DSH 最小化时根本看不到，
          等于用户全程没有任何状态显示。
        """
        with self._lock:
            self._want_show = True
            self._want_hide = False
            self._shown_evt.clear()
            if state:
                self._state.update(state)
        if wait:
            self._shown_evt.wait(timeout=3.0)

    def update(self, state):
        with self._lock:
            self._state.update(state or {})

    def hide(self):
        with self._lock:
            self._want_hide = True
            self._want_show = False

    def take_actions(self):
        """取走并清空用户点击产生的事件（宿主轮询用）。"""
        with self._lock:
            out = list(self._actions)
            self._actions = []
            return out

    def is_visible(self):
        return self._visible

    def raise_top(self):
        """把自己重新压到最前。宿主最小化后焦点可能被系统收回，
        光有 -topmost 有时会被别的置顶窗盖住，主动抬一次最稳。"""
        root = self._root
        if root is None:
            return
        try:
            root.attributes("-topmost", True)
            if self._hwnd:
                u32 = ctypes.windll.user32
                u32.SetWindowPos(ctypes.c_void_p(self._hwnd), ctypes.c_void_p(-1),
                                 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)  # NOSIZE|NOMOVE|NOACTIVATE
        except Exception:
            pass

    # ── 生命周期 ─────────────────────────────────────────
    def start(self):
        if self._thread and self._thread.is_alive():
            return True
        self._thread = threading.Thread(target=self._run, name="exam-overlay", daemon=True)
        self._thread.start()
        ok = self._ready.wait(timeout=6.0)
        if not ok:
            self._failed = self._failed or "悬浮窗线程 6 秒内未就绪"
        return self.available()

    def stop(self):
        with self._lock:
            self._want_hide = True
        if self._root is not None:
            try:
                self._root.after(0, self._destroy)
            except Exception:
                pass

    # ── UI 线程 ──────────────────────────────────────────
    def _run(self):
        try:
            import tkinter as tk
        except Exception as e:  # pragma: no cover
            self._failed = f"tkinter 不可用: {e}"
            self._ready.set()
            return

        ensure_dpi_aware()
        try:
            root = tk.Tk()
        except Exception as e:  # pragma: no cover
            self._failed = f"创建窗口失败: {e}"
            self._ready.set()
            return

        try:
            root.withdraw()  # 先藏起来，等 show() 再出现，避免闪一下
            root.overrideredirect(True)
            root.attributes("-topmost", True)
            root.configure(bg=_BG)

            wx, wy, ww, wh = work_area()
            x = max(0, wx + ww - _WIDTH - _MARGIN)

            self._build(root, tk)
            self._root = root
            # 高度按内容实测，不靠估算。
            # 写死 148 时按钮被裁；写死 190 时
            # 提示换行成两行又把提示本身压掉一半。凡是"文案可能变长"的
            # 地方，固定高度迟早出问题 —— 让 tk 自己算需要多高。
            root.update_idletasks()
            need_h = max(_MIN_HEIGHT, root.winfo_reqheight() + 4)
            if need_h > _MAX_HEIGHT:
                need_h = _MAX_HEIGHT
            root.geometry(f"{_WIDTH}x{need_h}+{x}+{max(0, wy + wh - need_h - _MARGIN)}")
            self._cur_h = need_h
            root.update_idletasks()
            root.update()

            self._apply_win32_style(root)
            self._ready.set()
            root.after(200, self._tick)
            root.mainloop()
        except Exception as e:  # pragma: no cover
            self._failed = f"悬浮窗异常: {e}"
            self._ready.set()
            try:
                root.destroy()
            except Exception:
                pass

    def _build(self, root, tk):
        frame = tk.Frame(root, bg=_BG, highlightthickness=0)
        frame.pack(fill="both", expand=True, padx=14, pady=11)

        head = tk.Frame(frame, bg=_BG)
        head.pack(fill="x")
        self._labels["dot"] = tk.Label(head, text="●", fg=_OK, bg=_BG,
                                       font=("Microsoft YaHei", 11))
        self._labels["dot"].pack(side="left")
        self._labels["title"] = tk.Label(head, text="考试助手", fg=_FG, bg=_BG,
                                         font=("Microsoft YaHei", 11, "bold"))
        self._labels["title"].pack(side="left", padx=(6, 0))
        self._labels["clock"] = tk.Label(head, text="—", fg=_ACCENT, bg=_BG,
                                         font=("Consolas", 13, "bold"))
        self._labels["clock"].pack(side="right")

        self._labels["prog"] = tk.Label(frame, text="等待开始", fg=_FG, bg=_BG,
                                        font=("Microsoft YaHei", 10), anchor="w")
        self._labels["prog"].pack(fill="x", pady=(6, 0))

        self._labels["answer"] = tk.Label(frame, text="", fg="#86efac", bg=_BG,
                                          font=("Microsoft YaHei", 12, "bold"), anchor="w")
        self._labels["answer"].pack(fill="x", pady=(2, 0))

        # 按钮行必须 **先** pack 到 side=bottom：tk 的 pack 按调用顺序分配空间，
        # 后 pack 的会被挤出窗口。曾出现：提示行换成两行后，
        # 按钮整行消失，用户看不到也点不到「停止并返回」。
        row = tk.Frame(frame, bg=_BG)
        row.pack(fill="x", side="bottom")

        def mkbtn(text, color, cmd):
            b = tk.Label(row, text=text, fg=color, bg="#1b1f27",
                         font=("Microsoft YaHei", 9), padx=10, pady=4, cursor="hand2")
            b.pack(side="left", padx=(0, 8))
            b.bind("<Button-1>", lambda _e: cmd())
            return b

        self._labels["btnPause"] = mkbtn("暂停", _WARN, lambda: self._push_action("toggle_pause"))
        mkbtn("停止并返回", _BAD, lambda: self._push_action("stop_and_back"))

        # 「待复核」按钮：有待复核题时才出现，点开/收起清单
        self._labels["btnReview"] = mkbtn("待复核", _WARN, self._toggle_review)
        self._labels["btnReview"].pack_forget()
        self._review_open = False

        # 待复核清单（默认收起）。side=bottom 提前 pack，位于按钮之上
        self._labels["reviewList"] = tk.Label(frame, text="", fg=_WARN, bg="#1b1f27",
                                              font=("Microsoft YaHei", 9), anchor="w",
                                              justify="left", wraplength=_NOTE_WRAP, padx=8, pady=6)

        # 底部状态栏：运行中 · 已答 N · 待复核 N · 剩余 mm:ss
        self._labels["status"] = tk.Label(frame, text="", fg=_DIM, bg=_BG,
                                          font=("Microsoft YaHei", 9), anchor="w")
        self._labels["status"].pack(fill="x", side="bottom", pady=(0, 4))

        # 已答题折叠行（最近 3 题）+ 当前题步骤轨道（固定 5 行，不跳动）
        self._labels["history"] = tk.Label(frame, text="", fg=_DIM, bg=_BG,
                                           font=("Microsoft YaHei", 9), anchor="w", justify="left")
        self._labels["history"].pack(fill="x", pady=(6, 0))
        # 暂停/结束后可用滚轮翻看全部已答题（运行中固定显示最近 3 题）
        self._hist_offset = 0
        self._hist_scrollable = False

        def _on_wheel(e):
            if not self._hist_scrollable:
                return
            # 上滚 = 看更早（offset 变大），下滚 = 回到最新；上限在渲染时夹住
            if getattr(e, "delta", 0) > 0:
                self._hist_offset += 1
            else:
                self._hist_offset = max(0, self._hist_offset - 1)
        self._labels["history"].bind("<MouseWheel>", _on_wheel)
        self._labels["trackHead"] = tk.Label(frame, text="", fg=_ACCENT, bg=_BG,
                                             font=("Microsoft YaHei", 9, "bold"), anchor="w")
        self._labels["trackHead"].pack(fill="x", pady=(4, 0))
        self._track_rows = []
        for _ in range(5):
            lb = tk.Label(frame, text="", fg=_DIM, bg=_BG, font=("Microsoft YaHei", 9), anchor="w")
            lb.pack(fill="x")
            self._track_rows.append(lb)
        # 步骤节奏：显示的轨道每次最多推进一格，每格至少停留 _STEP_DWELL 秒
        self._shown_steps = None
        self._step_changed_at = 0.0

        # 提示行放在按钮上方（同样提前 pack，避免被上面的内容挤掉）
        self._labels["note"] = tk.Label(frame, text="", fg=_DIM, bg=_BG,
                                        font=("Microsoft YaHei", 9), anchor="w",
                                        justify="left", wraplength=_NOTE_WRAP)
        self._labels["note"].pack(fill="x", side="bottom", pady=(0, 6))

    def _toggle_review(self):
        """展开 / 收起待复核清单（纯本地 UI，不通知宿主）。"""
        self._review_open = not self._review_open
        lst = self._labels["reviewList"]
        if self._review_open:
            lst.pack(fill="x", side="bottom", pady=(0, 6), before=self._labels["status"])
        else:
            lst.pack_forget()

    def _push_action(self, name):
        with self._lock:
            self._actions.append({"action": name, "at": time.time()})

    def _apply_win32_style(self, root):
        """截图排除 + 不抢焦点 + 不进 Alt-Tab。失败不致命（只是体验降级）。"""
        u32 = ctypes.windll.user32
        try:
            h = _hwnd_of(root)
            self._hwnd = h
            ex = u32.GetWindowLongW(ctypes.c_void_p(h), GWL_EXSTYLE)
            ex |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
            u32.SetWindowLongW(ctypes.c_void_p(h), GWL_EXSTYLE, ex)

            # 改完 EXSTYLE 必须让系统重算窗口框架，否则新的扩展样式
            # 可能不生效 —— 实测表现为"窗口 IsWindowVisible=True、
            # 坐标也对，但屏幕上什么都不画"。用 SWP_FRAMECHANGED 强制刷新。
            #   SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
            u32.SetWindowPos(ctypes.c_void_p(h), None, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020)

            ok = u32.SetWindowDisplayAffinity(ctypes.c_void_p(h), WDA_EXCLUDEFROMCAPTURE)
            if not ok:
                self._log("悬浮窗截图排除设置失败（仍在显示，但截屏里会看到它）")
            else:
                self._log("悬浮窗已就位（置顶 / 不进 Alt-Tab / 不出现在截图里）")
        except Exception as e:  # pragma: no cover
            self._log(f"悬浮窗 Win32 样式设置失败: {e}")

    def debug_dump(self, path):
        """进程内自证：临时取消截图排除 → 自己截一张 → 恢复。

        为什么必须有这个：
          从**别的进程**调 SetWindowDisplayAffinity 改不动已经排除的窗口，
          外部截图永远看不到悬浮窗，于是"到底画没画出来"无法从外部证伪。
          只有窗口所属进程自己才能临时解除并抓一张真实画面。
        """
        u32 = ctypes.windll.user32
        root = self._root
        if root is None or not self._hwnd:
            return {"ok": False, "error": "悬浮窗未创建"}
        try:
            from PIL import ImageGrab

            u32.SetWindowDisplayAffinity(ctypes.c_void_p(self._hwnd), 0)  # WDA_NONE
            root.update_idletasks()
            root.update()
            time.sleep(0.6)
            im = ImageGrab.grab(all_screens=True).convert("RGB")
            r = wt.RECT()
            u32.GetWindowRect(ctypes.c_void_p(self._hwnd), ctypes.byref(r))
            crop = im.crop((max(0, r.left), max(0, r.top), min(im.width, r.right), min(im.height, r.bottom)))
            crop.save(path)
            center = im.getpixel(((r.left + r.right) // 2, (r.top + r.bottom) // 2))
            drawn = sum(center) / 3 < 130
            return {
                "ok": True,
                "path": path,
                "rect": [r.left, r.top, r.right, r.bottom],
                "centerPixel": list(center),
                "rendered": bool(drawn),
                "size": list(crop.size),
            }
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}
        finally:
            try:
                u32.SetWindowDisplayAffinity(ctypes.c_void_p(self._hwnd), WDA_EXCLUDEFROMCAPTURE)
            except Exception:
                pass

    def _destroy(self):
        try:
            if self._root is not None:
                self._root.destroy()
        except Exception:
            pass

    # ── 每 200ms：应用宿主推送的新状态 ───────────────────
    def _tick(self):
        root = self._root
        if root is None:
            return
        try:
            with self._lock:
                st = dict(self._state)
                show = self._want_show
                hide = self._want_hide
                self._want_show = False
                self._want_hide = False

            if hide and self._visible:
                root.withdraw()
                self._visible = False
            elif show and not self._visible:
                root.deiconify()
                root.attributes("-topmost", True)
                root.lift()
                self._visible = True
                self._shown_evt.set()

            if self._visible:
                self._render(st)
                # 文案变化可能让内容变高（提示换行），每次渲染后按需调整高度。
                # 只在需要时改窗口尺寸，避免每 200ms 抖动。
                try:
                    root.update_idletasks()
                    want = min(_MAX_HEIGHT, max(_MIN_HEIGHT, root.winfo_reqheight() + 4))
                    if abs(want - self._cur_h) >= 4:
                        wx, wy, ww, wh = work_area()
                        x = max(0, wx + ww - _WIDTH - _MARGIN)
                        root.geometry(f"{_WIDTH}x{want}+{x}+{max(0, wy + wh - want - _MARGIN)}")
                        self._cur_h = want
                except Exception:
                    pass
        except Exception:
            pass
        try:
            root.after(200, self._tick)
        except Exception:
            pass

    def _render(self, st):
        """渲染一帧。

        字段由 lib/core/overlay-view.js 的 buildOverlayState 决定（单一来源）：
          title / run / prog / handled / failed / answer / answerSource
          / note / timerText / timerLevel / done
        这里**不做任何业务判断**（谁该显示什么由 JS 侧决定），
        只负责把 text 和颜色贴上去 —— 两边各判一次必然不一致。
        """
        L = self._labels
        run = str(st.get("run") or "idle")
        done = bool(st.get("done")) or run in ("done", "stopped")
        paused = run == "paused"

        L["dot"].config(fg=(_OK if run == "running" else (_WARN if paused else _DIM)))
        L["title"].config(text=str(st.get("title") or "考试助手"))

        # 剩余时间：颜色由 JS 给的 timerLevel 决定，不在 Python 里再算阈值
        clock = str(st.get("timerText") or "")
        level = str(st.get("timerLevel") or "normal")
        L["clock"].config(
            text=clock or "—",
            fg=(_BAD if level == "danger" else (_WARN if level == "warn" else (_ACCENT if clock else _DIM))),
        )

        prog = st.get("prog")
        handled = int(st.get("handled") or 0)
        if isinstance(prog, (list, tuple)) and len(prog) == 2 and prog[1]:
            L["prog"].config(text=f"第 {prog[0]}/{prog[1]} 题   ·   已处理 {handled}")
        else:
            L["prog"].config(text=f"已处理 {handled}" if handled else "等待开始")

        ans = st.get("answer")
        src = str(st.get("answerSource") or "")
        if ans:
            L["answer"].config(text=(f"答案 {ans}" + (f"（{src}）" if src else "")), fg="#86efac")
        elif done:
            L["answer"].config(text="未给出答案", fg=_DIM)
        else:
            L["answer"].config(text="", fg=_DIM)

        note = str(st.get("note") or "")
        L["note"].config(text=note, fg=(_BAD if level == "danger" else (_WARN if level == "warn" else _DIM)))

        L["btnPause"].config(text=("继续" if paused else "暂停"), fg=(_OK if paused else _WARN))

        self._render_track(st, run, paused, done)

    # ── 步骤轨道 / 历史 / 状态栏 / 待复核 ───────────────────
    def _pace(self, target):
        """节奏控制：显示的步骤每次最多推进一格，每格至少停留 _STEP_DWELL 秒。

        宿主一秒内可能连推好几步（题库未命中→模型开始），直接照搬会
        「一次性全跳出来」。这里逐格追赶目标状态，眼睛跟得上。
        换题（步骤全回到 todo）时立即切换，不做动画。
        """
        now = time.time()
        if not target:
            self._shown_steps = None
            return []
        sig = [s.get("status") for s in target]
        shown = self._shown_steps
        if shown is None or len(shown) != len(target) or all(x == "todo" for x in sig):
            self._shown_steps = [dict(s) for s in target]
            self._step_changed_at = now
            return self._shown_steps
        # 找第一个与目标不一致的格
        for i, s in enumerate(target):
            cur = shown[i]
            if cur.get("status") != s.get("status") or cur.get("detail") != s.get("detail"):
                # 同一格只是 detail 更新（计秒 / 文案）立即生效；状态推进要等停留时间
                if cur.get("status") == s.get("status") or now - self._step_changed_at >= _STEP_DWELL:
                    if cur.get("status") != s.get("status"):
                        self._step_changed_at = now
                    shown[i] = dict(s)
                break
        return shown

    def _render_track(self, st, run, paused, done):
        L = self._labels
        track = st.get("track") or None
        now = time.time()

        # 已答折叠行（最近 3 题）
        hist = st.get("history") or []
        # 运行中固定最近 3 题；暂停/结束后可滚轮翻看更早的
        self._hist_scrollable = (paused or done) and len(hist) > 3
        if not self._hist_scrollable:
            self._hist_offset = 0
        self._hist_offset = min(self._hist_offset, max(0, len(hist) - 3))
        end = len(hist) - self._hist_offset
        window = hist[max(0, end - 3):end]
        lines = []
        if self._hist_scrollable:
            lines.append(f"（滚轮翻看历史 · {max(1, end - 2)}-{end}/{len(hist)}）")
        for h in window:
            prog = h.get("prog")
            no = f"第 {prog[0]} 题" if isinstance(prog, (list, tuple)) and prog and prog[0] and prog[0] > 0 else "上一题"
            mark = "⚠" if h.get("review") else "✓"
            tail = " · 待复核" if h.get("review") else ""
            lines.append(f"{mark} {no}  {h.get('answer') or '—'}   {h.get('source') or ''}{tail}")
        L["history"].config(text="\n".join(lines))
        if not lines:
            L["history"].pack_forget()
        elif not L["history"].winfo_ismapped():
            L["history"].pack(fill="x", pady=(6, 0), before=L["trackHead"])

        # 当前题轨道
        steps = self._pace((track or {}).get("steps") or [])
        if track:
            prog = track.get("prog")
            head = f"第 {prog[0]}/{prog[1]} 题" if isinstance(prog, (list, tuple)) and len(prog) == 2 and prog[0] > 0 and prog[1] < 10000 else "当前题"
            if track.get("qtype"):
                head += f" · {track['qtype']}"
            L["trackHead"].config(text=head)
        else:
            L["trackHead"].config(text=("已启动，准备读题…" if run == "running" else ""))

        spin = _SPIN[int(now * 2) % len(_SPIN)]
        for i, lb in enumerate(self._track_rows):
            if i >= len(steps):
                lb.config(text="")
                continue
            s = steps[i]
            status = s.get("status") or "todo"
            label = s.get("label") or ""
            detail = s.get("detail") or ""
            if status == "active":
                started = float(s.get("startedAt") or 0) / 1000.0
                secs = int(now - started) if started > 0 else 0
                slow = secs >= _STEP_SLOW
                # 暂停时不转圈，免得看起来像还在跑
                icon = "⏸" if paused else "▶"
                tail = "" if paused else f" {secs}s {spin}"
                extra = "  响应较慢" if slow and not paused else ""
                lb.config(text=f"{icon} {label}   {detail or '进行中…'}{tail}{extra}",
                          fg=(_WARN if slow else _FG))
            elif status == "done":
                lb.config(text=f"✓ {label}   {detail}", fg=_OK)
            elif status == "warn":
                lb.config(text=f"⚠ {label}   {detail}", fg=_WARN)
            elif status == "skip":
                lb.config(text=f"– {label}   {detail}", fg=_DIM)
            else:
                lb.config(text=f"○ {label}", fg=_DIM)

        # 状态栏
        handled = int(st.get("handled") or 0)
        rc = int(st.get("reviewCount") or 0)
        word = "已结束" if done else ("已暂停" if paused else ("运行中" if run == "running" else "等待开始"))
        parts = [word, f"已答 {handled}"]
        if rc:
            parts.append(f"待复核 {rc}")
        clock = str(st.get("timerText") or "")
        if clock:
            parts.append(f"剩余 {clock}")
        L["status"].config(text=" · ".join(parts), fg=(_WARN if paused else _DIM))

        # 待复核按钮 + 清单：有待复核题才出现；答题结束时自动展开一次
        btn = L["btnReview"]
        if rc:
            btn.config(text=(f"收起复核" if self._review_open else f"待复核 {rc} 题"))
            if not btn.winfo_ismapped():
                btn.pack(side="left", padx=(0, 8))

        else:
            btn.pack_forget()
        rows = []
        for r in st.get("reviews") or []:
            conf = r.get("confidence")
            conf_t = f" · {float(conf):.2f}" if isinstance(conf, (int, float)) else ""
            q = f" {r['qtype']}" if r.get("qtype") else ""
            rows.append(f"第 {r.get('no')} 题{q}  答 {r.get('answer') or '—'}  ({r.get('source') or ''}{conf_t})")
        L["reviewList"].config(text=("请交卷前逐题核对：\n" + "\n".join(rows)) if rows else "")
