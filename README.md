# dsh-exam-copilot

DeepSeek Harness（DSH）的考试辅助插件：识别屏幕或浏览器中的试题，结合题库与大模型给出答案，支持人机协同与全自动作答。

![version](https://img.shields.io/badge/version-0.6.0-blue) ![platform](https://img.shields.io/badge/platform-Windows-lightgrey)

## 功能

- **两种通道**：桌面程序走 OCR；网页优先读取页面结构（DOM），读不到再回落 OCR
- **自动识别区域**：按窗口标题定位考试窗口，自动推断题干、选项、题号、倒计时、翻页与交卷按钮；区域按窗口比例保存，窗口移动或缩放后仍然有效
- **全屏预览 + 自检**：在真实界面上查看各区域框选，并逐块检查 OCR 结果
- **题库优先，模型兜底**：支持 docx / xlsx / txt 等格式导入，多题库匹配；未命中时调用 DSH 已配置的模型作答，可多次作答投票
- **人工作答衔接**：题库与模型都给不出答案时暂停等人；选好选项后由程序自动点下一题，最后一题只作答不翻页
- **运行日志**：运行页可查看实时日志，同时写入插件目录下 `.testdata/run.log`（不进仓库，每次启动引擎前清空）
- **安全护栏**：默认人机协同模式；动作白名单、预算上限、急停（面板按钮 / 鼠标移到左上角 / STOP 文件）

## 环境要求

| 组件      | 要求                                                           |
| ------- | ------------------------------------------------------------ |
| 操作系统    | Windows 10 / 11                                              |
| 宿主      | DeepSeek Harness                                             |
| Node.js | ≥ 18                                                         |
| Python  | 3.10+，需要 `Pillow`；可选 `rapidocr-onnxruntime`（OCR 兜底）、`psutil` |

OCR 默认使用 Windows 自带的 OCR 引擎，无需额外安装。

## 安装

```bash
git clone https://github.com/LittleDoubee/dsh-exam-copilot.git
pip install pillow rapidocr-onnxruntime psutil
```

把插件目录放到 DSH 的插件目录下并启用，控制面板位于 **设置 → 考试助手**。

## 快速开始

1. **区域** 页：新建配置 → 填目标窗口标题 → 点 **自动识别区域**
2. 点 **全屏预览**，点选各区域查看自检结果（✓/✗）；不准的区域用 **圈选一块区域** 手动修正
3. **题库** 页导入题库（可选）
4. **运行** 页选择模式后开始

## 项目结构

```
engine/        Python 引擎（截图、OCR、版面识别、全屏预览、动作执行）
lib/           插件主体（面板、运行状态机、题库、模型调用）
test/          单元测试
```

## 开发

```bash
node --test test/*.test.mjs     # JS 单元测试
python test/test_layout.py      # 版面识别单元测试
```

## 说明

本项目用于练习与学习场景。请遵守所在考试或平台的规则，因使用本工具产生的后果由使用者自行承担。
