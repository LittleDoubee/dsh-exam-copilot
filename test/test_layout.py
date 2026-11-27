"""engine/layout.py 的单测：用构造的 OCR 行模拟典型考试页面。

运行：python test/test_layout.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))
import layout  # noqa: E402


def row(text, x, y, w=300, h=20):
    return {"text": text, "x": x, "y": y, "w": w, "h": h}


PAGE = [
    row("剩余时间 32:43", 900, 10, 160),
    row("第 4 题 / 共 72 题", 40, 60, 200),
    row("4. 根据《印刷业管理条例》，下列说法正确的是", 40, 110, 600),
    row("（单选题）", 40, 135, 100),
    row("A. 印刷企业可以接受委托印刷", 60, 180),
    row("B. 出版物印刷无需许可", 60, 215),
    row("C. 可以随意复制", 60, 250),
    row("D. 以上都不对", 60, 285),
    row("上一题", 300, 400, 60),
    row("下一题", 400, 400, 60),
    row("交卷", 900, 400, 40),
]


def by_role(res):
    return {z["role"]: z for z in res["zones"]}


class LayoutTest(unittest.TestCase):
    def test_typical_page(self):
        res = layout.detect(PAGE)
        z = by_role(res)
        for role in ("options", "question", "progress", "timer", "next", "prev", "submit"):
            self.assertIn(role, z, role)
        # 选项区覆盖 A-D，不含按钮行
        self.assertLessEqual(z["options"]["y"], 180)
        self.assertGreaterEqual(z["options"]["y"] + z["options"]["h"], 305)
        self.assertLess(z["options"]["y"] + z["options"]["h"], 400)
        # 题干在选项上方、题号下方
        self.assertGreater(z["question"]["y"], 60)
        self.assertLessEqual(z["question"]["y"] + z["question"]["h"], 180)
        self.assertGreaterEqual(z["question"]["conf"], 0.8)
        self.assertEqual(res["score"], 1.0)
        self.assertTrue(all(x["source"] == "auto" for x in res["zones"]))

    def test_timer_not_in_question(self):
        z = by_role(layout.detect(PAGE))
        self.assertGreater(z["question"]["y"], 10 + 20)

    def test_true_false_two_options(self):
        rows = [row("1. 地球是圆的", 40, 100), row("A. 正确", 60, 150), row("B. 错误", 60, 185)]
        z = by_role(layout.detect(rows))
        self.assertIn("options", z)
        self.assertIn("question", z)

    def test_wrapped_option_text_included(self):
        rows = [row("1. 题干", 40, 100), row("A. 很长的选项", 60, 150),
                row("续行文字", 80, 172), row("B. 短", 60, 210)]
        z = by_role(layout.detect(rows))
        self.assertLessEqual(z["options"]["y"], 150)
        self.assertGreaterEqual(z["options"]["y"] + z["options"]["h"], 230)

    def test_no_options(self):
        res = layout.detect([row("欢迎使用考试系统", 40, 40)])
        self.assertNotIn("options", by_role(res))
        self.assertLess(res["score"], 0.5)
        self.assertTrue(res["notes"])

    def test_letters_in_separate_boxes(self):
        """字母在独立圆框里：OCR 把字母和正文拆成两行，中间还夹着框线噪声。"""
        rows = [row("1. 下列说法正确的是", 40, 100, 400),
                row("A", 60, 150, 18, 18), row("甲说法", 100, 150, 200),
                row("|", 300, 175, 4, 10),
                row("B", 60, 200, 18, 18), row("乙说法", 100, 200, 200),
                row("C", 60, 250, 18, 18), row("丙说法", 100, 250, 200),
                row("D", 60, 300, 18, 18), row("丁说法", 100, 300, 200)]
        z = by_role(layout.detect(rows))
        self.assertIn("options", z)
        self.assertGreaterEqual(z["options"]["x"] + z["options"]["w"], 300)
        self.assertGreaterEqual(z["options"]["y"] + z["options"]["h"], 318)
        self.assertLessEqual(z["question"]["y"] + z["question"]["h"], 150)

    def test_glued_letters_and_horizontal_layout(self):
        rows = [row("1. 判断：地球是圆的", 40, 100, 400),
                row("A正确", 60, 150, 80), row("B错误", 300, 152, 80)]
        z = by_role(layout.detect(rows))
        self.assertIn("options", z)
        self.assertGreaterEqual(z["options"]["x"] + z["options"]["w"], 380)

    def test_empty_and_bad_rows(self):
        self.assertEqual(layout.detect([])["zones"], [])
        self.assertEqual(layout.detect([{"text": "x"}, None, {"text": ""}])["zones"], [])

    def test_out_of_order_letters_ignored(self):
        rows = [row("1. 题干", 40, 100), row("C. 先出现", 60, 150), row("A. 甲", 60, 190),
                row("B. 乙", 60, 225)]
        z = by_role(layout.detect(rows))
        self.assertGreaterEqual(z["options"]["y"], 180)


if __name__ == "__main__":
    unittest.main(verbosity=2)
