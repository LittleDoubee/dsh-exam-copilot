"""全屏预览窗口：确认区域框选位置，并逐区域做 OCR 自检。

预览：全屏显示截图，黑框标出各区域（框内不压暗）；点选区域后在浮动预览窗里
查看放大裁图与自检结论。预览窗可拖标题栏移动、自动避让选中区域、H 隐藏，
放大后可拖图/滚轮平移。Esc 或右键退出。

依赖（tk / PIL / ctypes / 自检函数）由调用方注入，便于在无界面环境下导入本模块。
"""

import queue
import threading

ZOOM_STEPS = [1.0, 1.5, 2.0, 3.0]
RES_H = 150                     # 预览图下方的自检结果区高度
FONT = "Microsoft YaHei UI"
VK_ESC, VK_H, VK_A = 0x1B, 0x48, 0x41
HINT = ("点选区域即自检 ｜ A 自检全部 ｜ 拖标题栏移动 ｜ H 隐藏/显示 ｜ "
        "Ctrl+滚轮 缩放 ｜ 框内拖动/滚轮查看 ｜ Esc 或右键退出")


def _int_box(r, clamp=False):
    """区域 dict → (x, y, w, h) 整数；字段非法返回 None。"""
    try:
        x, y, w, h = (int(r.get(k, 0)) for k in ("x", "y", "w", "h"))
    except Exception:
        return None
    if clamp:
        x, y, w, h = max(0, x), max(0, y), max(1, w), max(1, h)
    return x, y, w, h


def _overlap(a, b):
    """两个 (x, y, w, h) 矩形的重叠面积。"""
    w = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    h = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return max(0, w) * max(0, h)


def _in(box, ev):
    x0, y0, x1, y1 = box
    return x0 <= ev.x <= x1 and y0 <= ev.y <= y1


class ZonePreview:
    """一次全屏预览会话。run() 阻塞到用户退出或超时。"""

    def __init__(self, shot, regions, checker, tk, Image, ImageTk, ctypes):
        self.shot, self.regions, self.checker = shot, regions, checker
        self.tk, self.Image, self.ImageTk, self.ctypes = tk, Image, ImageTk, ctypes
        self.SW, self.SH = shot.size
        # 预览框随屏幕放大：高分屏上固定尺寸放大后几乎看不出什么
        self.PREVIEW_W = max(420, int(self.SW * 0.32))
        self.PREVIEW_H = max(240, int(self.SH * 0.28))
        self.sel = 0 if regions else -1
        self.zoom = 2
        self.pan = [0, 0]           # 可视窗口左上角在「缩放后图」上的位置
        self.scaled = (0, 0)
        self.drag = None            # 框内拖图的起点
        self.move = None            # 拖标题栏的起点
        self.pos = list(self._corners()[0])
        self.hidden = False
        self.pinned = False         # 手动拖过之后不再自动避让
        self.zoom_box = self.title_box = (0, 0, 0, 0)
        self.thumb = None
        self.chrome = []
        self.sum_items = ()
        self.done = {}              # idx -> (ok, 结论, 明细)
        self.pending = set()
        self.check_all = False
        self.dirty = False
        self.dismissed = False
        self.jobs = queue.Queue()
        self.prev_keys = {VK_ESC: False, VK_H: False, VK_A: False}

    # ── 生命周期 ──────────────────────────────────────
    def run(self, timeout_ms):
        self._build()
        threading.Thread(target=self._check_worker, daemon=True).start()
        self.auto_place()
        self.request_check(self.sel)
        self.redraw_all()
        self._bind(timeout_ms)
        self.root.mainloop()
        self.jobs.put(None)
        return {"dismissed": self.dismissed, "picked": self.sel, "checks": self.checks()}

    def _build(self):
        root = self.tk.Tk()
        root.title("预览 — 点选区域看细节，Esc 或右键退出")
        root.attributes("-fullscreen", True)
        root.attributes("-topmost", True)
        try:
            root.grab_set()
        except Exception:
            pass
        canvas = self.tk.Canvas(root, width=self.SW, height=self.SH, highlightthickness=0, bg="#ffffff")
        canvas.pack(fill="both", expand=True)
        self._photo = self.ImageTk.PhotoImage(self.shot)
        canvas.create_image(0, 0, anchor="nw", image=self._photo)
        canvas.create_text(self.SW // 2, self.SH - 20, text=HINT, fill="#000000",
                           font=("Segoe UI", 12, "bold"))
        self.root, self.canvas = root, canvas

    def _bind(self, timeout_ms):
        root, c = self.root, self.canvas
        c.bind("<Button-1>", self.on_press)
        c.bind("<B1-Motion>", self.on_drag)
        c.bind("<ButtonRelease-1>", self.on_release)
        root.bind("<MouseWheel>", self.on_wheel)
        root.bind("<Escape>", self.dismiss)
        root.bind("<Button-3>", self.dismiss)
        c.bind("<Button-3>", self.dismiss)
        root.protocol("WM_DELETE_WINDOW", self.dismiss)
        root.after(80, self.poll)
        root.after(timeout_ms, root.destroy)

    def dismiss(self, _e=None):
        if not self.dismissed:
            self.dismissed = True
            self.jobs.put(None)
            self.root.destroy()
        return "break"

    def checks(self):
        return [{"index": i, "role": str(self.regions[i].get("role") or ""), "ok": v[0], "summary": v[1]}
                for i, v in sorted(self.done.items())]

    # ── 热键：全局键状态轮询，不依赖 Tk 焦点（全屏覆盖窗经常拿不到焦点）──
    def _key_pressed(self, vk):
        down = bool(self.ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000)
        edge = down and not self.prev_keys[vk]
        self.prev_keys[vk] = down
        return edge

    def poll(self):
        if self.dismissed:
            return
        try:
            u32 = self.ctypes.windll.user32
            u32.GetAsyncKeyState.restype = self.ctypes.c_short
            u32.GetAsyncKeyState.argtypes = [self.ctypes.c_int]
            esc, key_h, key_a = [self._key_pressed(k) for k in (VK_ESC, VK_H, VK_A)]
        except Exception:
            return
        if esc:
            self.dismiss()
            return
        if key_h:
            self.toggle_hidden()
        if key_a:
            self.run_all_checks()
        if self.dirty:              # 后台自检出了新结果 → 主线程重画
            self.dirty = False
            self.redraw_preview()
            self.draw_summary()
        self.root.after(50, self.poll)

    # ── 区域框 ────────────────────────────────────────
    def redraw_all(self):
        self.draw_regions()
        self.redraw_preview()
        self.canvas.tag_raise("region")

    def draw_regions(self):
        """重画所有区域框（黑框黑字，选中加粗）。"""
        self.canvas.delete("region")
        for idx, r in enumerate(self.regions):
            box = _int_box(r)
            if box and box[2] > 0 and box[3] > 0:
                self._draw_region(idx, box, str(r.get("role") or ""))

    def _draw_region(self, idx, box, role):
        c, (x, y, w, h) = self.canvas, box
        tags = ("region", "r%d" % idx)
        c.create_rectangle(x, y, x + w, y + h, outline="#000000",
                           width=4 if idx == self.sel else 2, tags=tags)
        if not role:
            return
        # 黑字 + 白底小标签，保证在任何背景上都读得清
        tid = c.create_text(x + 6, max(y - 12, 10), text=role, anchor="w", fill="#000000",
                            font=("Segoe UI", 12, "bold"), tags=tags)
        bb = c.bbox(tid)
        if bb:
            bg = c.create_rectangle(bb[0] - 4, bb[1] - 2, bb[2] + 4, bb[3] + 2,
                                    fill="#ffffff", outline="#000000", width=1, tags=tags)
            c.tag_lower(bg, tid)

    def hit_test(self, ev):
        """点到的区域下标；多个重叠时取面积最小的，避免大框吃掉小框。"""
        best, best_area = -1, None
        for idx, r in enumerate(self.regions):
            box = _int_box(r)
            if not box:
                continue
            x, y, w, h = box
            if x <= ev.x <= x + w and y <= ev.y <= y + h and (best_area is None or w * h < best_area):
                best, best_area = idx, w * h
        return best

    def on_click(self, ev):
        idx = self.hit_test(ev)
        if idx < 0 or idx == self.sel:
            return
        self.sel = idx
        self.pan = [0, 0]           # 换区域从左上角看起
        self.auto_place()
        self.request_check(idx)     # 选中即自检这一块
        self.redraw_all()

    # ── 预览窗位置 ────────────────────────────────────
    def _corners(self):
        m, bottom = 24, self.SH - self.PREVIEW_H - RES_H - 50
        right, left = self.SW - self.PREVIEW_W - m, m + 8
        return [(right, bottom), (left, bottom), (right, 60), (left, 60)]

    def _frame_box(self, corner):
        cx, cy = corner
        return (cx - 8, cy - 30, self.PREVIEW_W + 16, self.PREVIEW_H + RES_H + 46)

    def auto_place(self):
        """放到与选中区域重叠最少的角落（与全部区域的重叠作次要依据）。"""
        if self.pinned:
            return
        boxes = [b for b in (_int_box(r) for r in self.regions) if b]
        sel = _int_box(self.regions[self.sel]) if 0 <= self.sel < len(self.regions) else None

        def cost(corner):
            frame = self._frame_box(corner)
            s = sum(_overlap(frame, b) for b in boxes)
            return s + (1000 * _overlap(frame, sel) if sel else 0)

        self.pos = list(min(self._corners(), key=cost))

    # ── 预览窗绘制 ────────────────────────────────────
    def _add(self, item):
        self.chrome.append(item)
        return item

    def redraw_preview(self):
        for t in self.chrome:
            self.canvas.delete(t)
        self.chrome, self.thumb = [], None
        if self.hidden:
            self._draw_hidden_hint()
            return
        if not 0 <= self.sel < len(self.regions):
            return
        crop = self._zoomed_crop()
        if crop is None:
            return
        self.thumb = self.ImageTk.PhotoImage(crop)
        px, py = self.pos
        self._draw_frame(px, py)
        self._draw_image(px, py, crop.width, crop.height)
        self._draw_scrollbars(px, py)
        self._draw_check_result(px, py)

    def _draw_hidden_hint(self):
        self.zoom_box = self.title_box = (0, 0, 0, 0)
        self._add(self.canvas.create_text(self.SW - 24, self.SH - 48, text="预览已隐藏（按 H 显示）",
                                          anchor="e", fill="#000000", font=("Segoe UI", 11, "bold")))

    def _zoomed_crop(self):
        """选中区域的裁图：先按预览框装下再乘缩放；超出部分按 pan 只取框大小的一块。"""
        box = _int_box(self.regions[self.sel], clamp=True)
        if not box:
            return None
        x, y, w, h = box
        crop = self.shot.crop((x, y, min(x + w, self.SW), min(y + h, self.SH)))
        if crop.width <= 0 or crop.height <= 0:
            return None
        pw, ph = self.PREVIEW_W, self.PREVIEW_H
        scale = min(pw / crop.width, ph / crop.height, 1.0) * ZOOM_STEPS[self.zoom]
        tw, th = max(1, int(crop.width * scale)), max(1, int(crop.height * scale))
        crop = crop.resize((tw, th), self.Image.LANCZOS)
        self.scaled = (tw, th)
        max_x, max_y = max(0, tw - pw), max(0, th - ph)
        self.pan = [min(max(0, int(self.pan[0])), max_x), min(max(0, int(self.pan[1])), max_y)]
        if max_x or max_y:
            ox, oy = self.pan
            crop = crop.crop((ox, oy, ox + min(tw, pw), oy + min(th, ph)))
        return crop

    def _draw_frame(self, px, py):
        """外框 + 标题栏（可拖动）+ ＋ － 检 ✕ 按钮 + 标题文字。"""
        c, pw, ph = self.canvas, self.PREVIEW_W, self.PREVIEW_H
        self._add(c.create_rectangle(px - 8, py - 30, px + pw + 8, py + ph + RES_H + 8,
                                     fill="#ffffff", outline="#000000", width=2))
        self._add(c.create_rectangle(px - 8, py - 30, px + pw + 8, py - 4,
                                     fill="#eeeeee", outline="#000000", width=1))
        self.title_box = (px - 8, py - 30, px + pw - 146, py - 4)
        bx = px + pw - 140
        for i, label in enumerate(("＋", "－", "检", "✕")):
            self._add(c.create_text(bx + 18 + i * 36, py - 17, text=label, fill="#000000",
                                    font=(FONT, 12, "bold")))
        self.zoom_box = (bx, py - 30, bx + 144, py - 4)
        role = str(self.regions[self.sel].get("role") or ("区域 %d" % (self.sel + 1)))
        fw, fh = self.scaled
        hint = "  拖图查看其余" if (fw > pw or fh > ph) else ""
        self._add(c.create_text(px - 2, py - 17, text="⠿ " + role + "  ×%.1f" % ZOOM_STEPS[self.zoom] + hint,
                                anchor="w", fill="#000000", font=("Segoe UI", 11, "bold")))

    def _draw_image(self, px, py, tw, th):
        ix = px + max(0, (self.PREVIEW_W - tw) // 2)
        iy = py + max(0, (self.PREVIEW_H - th) // 2)
        self._add(self.canvas.create_image(ix, iy, anchor="nw", image=self.thumb))

    def _draw_scrollbars(self, px, py):
        """位置指示条：当前看的是整块裁图的哪一部分。"""
        c, pw, ph = self.canvas, self.PREVIEW_W, self.PREVIEW_H
        fw, fh = self.scaled
        if fw > pw:
            bw = max(20, int(pw * pw / fw))
            bx = px + int((pw - bw) * self.pan[0] / max(1, fw - pw))
            self._add(c.create_rectangle(bx, py + ph + 2, bx + bw, py + ph + 6, fill="#000000", outline=""))
        if fh > ph:
            bh = max(20, int(ph * ph / fh))
            by = py + int((ph - bh) * self.pan[1] / max(1, fh - ph))
            self._add(c.create_rectangle(px + pw + 2, by, px + pw + 6, by + bh, fill="#000000", outline=""))

    def _draw_check_result(self, px, py):
        c, ry = self.canvas, py + self.PREVIEW_H + 12
        self._add(c.create_line(px - 8, ry - 4, px + self.PREVIEW_W + 8, ry - 4, fill="#cccccc"))
        chk = self.done.get(self.sel)
        if chk is None:
            msg = "识别中…" if self.sel in self.pending else "点「检」或按 A 自检全部区域"
            self._add(c.create_text(px, ry, text=msg, anchor="nw", fill="#555555", font=(FONT, 10)))
            return
        ok, head, detail = chk
        self._add(c.create_text(px, ry, text=("✓ " if ok else "✗ ") + head, anchor="nw",
                                fill="#0a7a2a" if ok else "#c0262d", font=(FONT, 11, "bold")))
        self._draw_detail_lines(px, ry + 24, py + self.PREVIEW_H + RES_H - 16, detail)

    def _draw_detail_lines(self, px, yy, y_max, detail):
        max_chars = max(10, self.PREVIEW_W // 14)
        for line in detail:
            if yy > y_max:
                self._add(self.canvas.create_text(px, yy, text="…", anchor="nw", fill="#555555"))
                return
            if len(line) > max_chars:
                line = line[:max_chars - 1] + "…"
            self._add(self.canvas.create_text(px, yy, text=line, anchor="nw", fill="#000000", font=(FONT, 10)))
            yy += 20

    # ── 鼠标交互 ──────────────────────────────────────
    def in_preview(self, ev):
        if self.hidden:
            return False
        px, py = self.pos
        return px <= ev.x <= px + self.PREVIEW_W and py <= ev.y <= py + self.PREVIEW_H

    def on_press(self, ev):
        if not self.hidden and _in(self.zoom_box, ev):
            self._press_button(int((ev.x - self.zoom_box[0]) // 36))
        elif not self.hidden and _in(self.title_box, ev):
            self.move = (ev.x, ev.y, self.pos[0], self.pos[1])
            self.pinned = True
        elif self.in_preview(ev):
            self.drag = (ev.x, ev.y, self.pan[0], self.pan[1])
        else:
            self.on_click(ev)

    def _press_button(self, k):
        actions = (self.zoom_in, self.zoom_out, self.run_all_checks, self.toggle_hidden)
        actions[min(max(k, 0), len(actions) - 1)]()

    def on_drag(self, ev):
        if self.move:
            m = self.move
            nx = min(max(8, m[2] + ev.x - m[0]), self.SW - self.PREVIEW_W - 8)
            ny = min(max(34, m[3] + ev.y - m[1]), self.SH - self.PREVIEW_H - RES_H - 16)
            self.pos = [nx, ny]
        elif self.drag:
            d = self.drag
            self.pan = [d[2] - (ev.x - d[0]), d[3] - (ev.y - d[1])]
        else:
            return
        self.redraw_preview()

    def on_release(self, _ev):
        self.drag = self.move = None

    def on_wheel(self, ev):
        if not self.in_preview(ev):
            return
        if ev.state & 0x0004:       # Ctrl + 滚轮 = 缩放
            (self.zoom_in if ev.delta > 0 else self.zoom_out)()
            return
        step = -int(ev.delta / 120) * 60 if ev.delta else 0
        axis = 0 if ev.state & 0x0001 else 1    # Shift + 滚轮 = 横向
        self.pan[axis] += step
        self.redraw_preview()

    def toggle_hidden(self, _e=None):
        self.hidden = not self.hidden
        self.redraw_preview()

    def _rezoom(self, new_idx):
        """缩放时保持可视窗口中心不变，而不是跳回左上角。"""
        k = ZOOM_STEPS[new_idx] / ZOOM_STEPS[self.zoom]
        cx = self.pan[0] + self.PREVIEW_W / 2
        cy = self.pan[1] + self.PREVIEW_H / 2
        self.pan = [cx * k - self.PREVIEW_W / 2, cy * k - self.PREVIEW_H / 2]
        self.zoom = new_idx
        self.redraw_preview()

    def zoom_in(self, _e=None):
        if self.zoom < len(ZOOM_STEPS) - 1:
            self._rezoom(self.zoom + 1)

    def zoom_out(self, _e=None):
        if self.zoom > 0:
            self._rezoom(self.zoom - 1)

    # ── 自检：后台线程只写结果，主线程轮询发现 dirty 后重画（Tk 非线程安全）──
    def _check_worker(self):
        while True:
            i = self.jobs.get()
            if i is None:
                return
            self.done[i] = self._check_one(i)
            self.pending.discard(i)
            self.dirty = True

    def _check_one(self, i):
        r = self.regions[i]
        try:
            x, y, w, h = _int_box(r, clamp=True) or (0, 0, 1, 1)
            crop = self.shot.crop((x, y, min(x + w, self.SW), min(y + h, self.SH)))
            return self.checker(crop, str(r.get("role") or ""), tag=f"chk_{i}")
        except Exception as e:
            return (False, f"识别失败：{e}", [])

    def request_check(self, i):
        if 0 <= i < len(self.regions) and i not in self.done and i not in self.pending:
            self.pending.add(i)
            self.jobs.put(i)

    def run_all_checks(self, _e=None):
        self.check_all = True
        for i in range(len(self.regions)):
            self.request_check(i)
        self.draw_summary()
        self.redraw_preview()

    def _summary_text(self):
        bad = [str(self.regions[i].get("role") or i) for i, v in self.done.items() if not v[0]]
        ok_n = len(self.done) - len(bad)
        text = f"自检：{len(self.regions)} 个区域  ✓{ok_n}  ✗{len(bad)}"
        if self.pending:
            return text + f"  （识别中 {len(self.pending)}）", bad
        return text + ("  未通过：" + "、".join(bad) if bad else "  全部通过"), bad

    def draw_summary(self):
        """顶部汇总条：自检全部后显示通过/失败数。"""
        for it in self.sum_items:
            self.canvas.delete(it)
        self.sum_items = ()
        if not self.check_all:
            return
        text, bad = self._summary_text()
        t = self.canvas.create_text(self.SW // 2, 22, text=text, fill="#c0262d" if bad else "#0a7a2a",
                                    font=(FONT, 13, "bold"))
        bb = self.canvas.bbox(t)
        bg = self.canvas.create_rectangle(bb[0] - 10, bb[1] - 4, bb[2] + 10, bb[3] + 4,
                                          fill="#ffffff", outline="#000000")
        self.canvas.tag_lower(bg, t)
        self.sum_items = (bg, t)
