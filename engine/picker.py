"""全屏圈选窗口：在截图上拖框得到一个矩形。

只支持单框：拖一次得到一个矩形，角色由面板指定。
Enter / 双击保存，Esc / 右键取消，R 重画。

键盘处理三重保险：Tk 键绑定（bind_all + 窗口级）、持续夺焦、以及全局键状态轮询。
Windows 前台锁会让跨进程抢焦点失败，此时 Tk 收不到键击，只有 GetAsyncKeyState
能读到物理按键；右键走坐标命中、与焦点无关，作为最后的退出路径。
"""

VK = {"esc": 0x1B, "enter": 0x0D, "r": 0x52}


class ZonePicker:
    """一次圈选会话。run() 阻塞到保存/取消/超时，返回 {"box": (x,y,w,h)|None, "cancelled": bool}。"""

    def __init__(self, shot, tk, ImageTk, ctypes):
        self.shot, self.tk, self.ImageTk, self.ctypes = shot, tk, ImageTk, ctypes
        self.SW, self.SH = shot.size
        self.x0 = self.y0 = 0
        self.rect = None
        self.box = None
        self.result = {"box": None, "cancelled": False}
        self.prev = {k: False for k in VK}

    def run(self, timeout_ms):
        self._build()
        self._bind_mouse()
        self._bind_keys()
        self._schedule_focus()
        self.root.after(80, self.poll)
        self.root.protocol("WM_DELETE_WINDOW", self.cancel)
        self.root.after(timeout_ms, self.root.destroy)
        self.root.mainloop()
        return self.result

    def _finished(self):
        return bool(self.result.get("box") or self.result.get("cancelled"))

    # ── 窗口 ──────────────────────────────────────────
    def _build(self):
        root = self.tk.Tk()
        root.title("圈定区域 — 拖拽画框，Enter 保存，Esc/右键取消，R 重画")
        root.attributes("-fullscreen", True)
        root.attributes("-topmost", True)
        # grab_set：所有输入事件强制进入本窗口，宿主即便抢回前台也不影响键盘投递
        try:
            root.grab_set()
        except Exception:
            pass
        root.configure(cursor="crosshair")
        canvas = self.tk.Canvas(root, width=self.SW, height=self.SH, highlightthickness=0, bg="black")
        canvas.pack(fill="both", expand=True)
        self._photo = self.ImageTk.PhotoImage(self.shot, master=root)
        canvas.create_image(0, 0, anchor="nw", image=self._photo)
        self.root, self.canvas = root, canvas

    # ── 鼠标：拖框 ────────────────────────────────────
    def _bind_mouse(self):
        c = self.canvas
        c.bind("<ButtonPress-1>", self.on_press)
        c.bind("<B1-Motion>", self.on_drag)
        c.bind("<ButtonRelease-1>", self.on_release)
        # 右键取消：键盘焦点被系统抢走时仍可用
        self.root.bind("<Button-3>", self.cancel)
        c.bind("<Button-3>", self.cancel)
        self.root.bind("<Double-Button-1>", self.save)

    def on_press(self, e):
        self.x0, self.y0 = e.x, e.y
        if self.rect:
            self.canvas.delete(self.rect)
        self.rect = self.canvas.create_rectangle(e.x, e.y, e.x, e.y, outline="#22d3ee", width=3)

    def on_drag(self, e):
        if self.rect:
            self.canvas.coords(self.rect, self.x0, self.y0, e.x, e.y)

    def on_release(self, e):
        self.box = (min(self.x0, e.x), min(self.y0, e.y), abs(e.x - self.x0), abs(e.y - self.y0))

    # ── 动作 ──────────────────────────────────────────
    def save(self, _e=None):
        self.result["box"] = self.box
        self.root.destroy()
        return "break"

    def cancel(self, _e=None):
        self.result["cancelled"] = True
        self.root.destroy()
        return "break"

    def clear(self, _e=None):
        self.box = None
        if self.rect:
            self.canvas.delete(self.rect)
            self.rect = None
        return "break"

    # ── 键盘：Tk 绑定 ─────────────────────────────────
    def _bind_keys(self):
        # bind_all 挂到应用级，不依赖哪个控件有焦点；窗口级再绑一份作双保险
        keys = (("<Escape>", self.cancel), ("<Return>", self.save), ("<r>", self.clear), ("<R>", self.clear))
        for seq, fn in keys:
            self.root.bind_all(seq, fn)
            self.root.bind(seq, fn)

    # ── 焦点：-topmost 只保证显示在最上面，不保证接收键盘 ──
    def _grab_focus(self):
        try:
            self.root.focus_force()
            self.canvas.focus_set()
            self.root.lift()
        except Exception:
            pass

    def _keep_focus(self):
        # 宿主最小化后 Windows 可能在数百毫秒内把焦点还给别的窗口，持续抢到有结果为止
        if self._finished():
            return
        self._grab_focus()
        self.root.after(400, self._keep_focus)

    def _schedule_focus(self):
        self._grab_focus()
        self.root.after(60, self._grab_focus)
        self.root.after(250, self._grab_focus)
        self.root.after(600, self._keep_focus)

    # ── 键盘：全局键状态轮询（不经过焦点和消息队列），按下瞬间只触发一次 ──
    def _read_keys(self):
        u32 = self.ctypes.windll.user32
        u32.GetAsyncKeyState.restype = self.ctypes.c_short
        u32.GetAsyncKeyState.argtypes = [self.ctypes.c_int]
        return {k: bool(u32.GetAsyncKeyState(v) & 0x8000) for k, v in VK.items()}

    def poll(self):
        if self._finished():
            return
        try:
            now = self._read_keys()
        except Exception:
            return  # 非 Windows / ctypes 不可用：只靠 Tk 绑定
        pressed = [k for k in ("esc", "enter", "r") if now[k] and not self.prev[k]]
        self.prev.update(now)
        if "esc" in pressed:
            self.cancel()
            return
        if "enter" in pressed:
            self.save()
            return
        if "r" in pressed:
            self.clear()
        self.root.after(60, self.poll)
