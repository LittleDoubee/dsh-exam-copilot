# -*- coding: utf-8 -*-
"""OCR 引擎：预处理 + 识别 + 纠错。

针对屏幕考卷页面的实测优化：
  * 2.5x 放大 —— Windows OCR 在 1x 下会把「排」认成「扌非」、「绿」认成「纟录」
  * 灰度 + 对比度增强 + 锐化 —— 提升细笔画识别率
  * 常见偏旁拆字纠正表
"""
import os
import subprocess
import json

HERE = os.path.dirname(os.path.abspath(__file__))
OCR_PS1 = os.path.join(HERE, "ocr2.ps1")

# Windows OCR 常见偏旁拆字误识（实测收集）
# 注意：不要包含 "0" → "（）"，那会把题号 1/300 变成 1/3（）（）；改由 normalize_text 按语境处理
FIXES = {
    "纟录": "绿", "纟工": "红", "纟氏": "纸", "纟屯": "纯",
    "扌非": "排", "扌丸": "执", "扌丁": "打", "扌是": "提",
    "亻呆": "保", "亻立": "位", "亻吏": "使",
    "讠方": "访", "讠殳": "设", "讠果": "课",
    "钅艮": "银", "钅失": "铁", "钅同": "铜",
    "氵去": "法", "氵冘": "沉", "氵则": "测",
    "兀": "元", "疋": "定", "厶丶": "公",
    "仮": "假", "墽": "缴",
    "凸": "包",   # 「包含」常被认成「包凸」
    "占": "点",
    # （补答时发现的关键误识）
    "包版": "凸版",     # 印刷方式「凸版」被认成「包版」，导致答题判断错误
    "包印": "凸印",
    "包刷": "凸刷",
    "凹包": "凹凸",
    "躬": "第",         # 「第一版」被认成「躬一版」
    "亻〕市兰": "",
    "＝同丰": "",
    "于日讠天": "错误",
    "钅昔讠吴": "错误",
    # 模拟页
    "里条亻列": "管理条例",   # 「印刷业管理条例」被拆成 里条亻列
    "里条例": "管理条例",
}

# 单字级别的可疑替换（只在明显语境下用，避免误伤）
CHAR_FIX = {
    "疋": "定",
}


def fix_text(s):
    if not s:
        return s
    for bad, good in FIXES.items():
        s = s.replace(bad, good)
    # 用户扩展词典（可选）：<data-dir>/corrections.json
    # 设计上必须可扩展 —— OCR 误识与具体领域/字体强相关，
    # 内置表只覆盖实测过的通用偏旁拆字，专业术语必须由用户自己补。
    for bad, good in _user_fixes().items():
        s = s.replace(bad, good)
    return s


_USER_FIXES_CACHE = {"path": None, "mtime": None, "data": {}}


def _user_fixes():
    """读用户纠错词典，按 mtime 缓存（每次识别都读盘太浪费）。"""
    import json
    path = os.environ.get("EXAM_CORRECTIONS", "")
    if not path or not os.path.exists(path):
        return {}
    try:
        mtime = os.path.getmtime(path)
        c = _USER_FIXES_CACHE
        if c["path"] == path and c["mtime"] == mtime:
            return c["data"]
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        # 兼容 {"bad":"good"} 与 [{"bad":..,"good":..}] 两种写法
        if isinstance(data, list):
            data = {str(it.get("bad")): str(it.get("good")) for it in data if it.get("bad")}
        data = {str(k): str(v) for k, v in (data or {}).items()}
        _USER_FIXES_CACHE.update({"path": path, "mtime": mtime, "data": data})
        return data
    except Exception:
        return {}


def preprocess(src, dst, scale=2.5):
    """放大 + 增强对比度 + 锐化，显著提升中文小字识别率。"""
    from PIL import Image, ImageEnhance, ImageFilter
    im = Image.open(src).convert("L")          # 灰度
    w, h = im.size
    im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    im = ImageEnhance.Contrast(im).enhance(1.8)
    im = ImageEnhance.Sharpness(im).enhance(2.0)
    im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=3))
    im.save(dst)


def recognize(img_path, scale=2.5, timeout=60):
    """返回 OCR 行列表 [{text,x,y,w,h}]，坐标已换算回原图尺度。"""
    # 关键：全程用绝对路径，PowerShell 的 CWD 与 Python 不一定相同
    img_abs = os.path.abspath(img_path)
    tmp = img_abs + ".ocr.png"
    try:
        preprocess(img_abs, tmp, scale)
    except Exception:
        tmp = img_abs
        scale = 1.0

    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", OCR_PS1, tmp],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return []
    finally:
        if tmp != img_abs and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass

    out = (r.stdout or "").strip()
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        data = []
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    data.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    if isinstance(data, dict):
        data = [data]

    rows = []
    for r0 in data:
        t = (r0.get("text") or "").strip()
        if not t:
            continue
        rows.append({
            "text": fix_text(t),
            "x": int(r0["x"] / scale),
            "y": int(r0["y"] / scale),
            "w": int(r0["w"] / scale),
            "h": int(r0["h"] / scale),
        })
    return rows
