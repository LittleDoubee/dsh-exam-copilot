// 视觉通道（图形题）。
//
// 背景：
//   流程图题示例：「下图所示流程图中，缺失的环节应当是：」
//   图里画的是「承印验证 → ??? → 交付印刷」，答案要看 `???` 处该填什么。
//   OCR 只能读到题干和选项，**读不出图**，所以题库未命中时只能：
//     ① 交给模型 —— 但纯文字模型看不到图，等于瞎猜
//     ② 转人工
//   视觉通道就是补上"把图给模型看"这条路。
//
// 设计要点（这些是契约，不是实现细节）：
//   * 只有配了 figure 区才截图 —— 没配就没有图可给，不该假装有
//   * 截图失败不能让整题失败 —— 退化为纯文字作答，比抛异常好
//   * 图片必须真的进到 message content 里，否则模型看不到
//   * 附了图要在 prompt 里**明确告诉模型**，否则它会忽略图只读文字

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPrompt } from '../lib/core/llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('有图时 prompt 必须明确提示模型先看图', () => {
	const q = { stem: '下图所示流程图中，缺失的环节应当是：', qtype: '单选题', opts: [] };
	const withFig = buildPrompt(q, { hasFigure: true });
	const without = buildPrompt(q, { hasFigure: false });

	assert.match(
		withFig.system,
		/附图|看图/,
		'带图时必须告诉模型去看图 —— 否则图形题的文字部分信息不足，模型只能瞎猜'
	);
	assert.ok(
		!without.system.includes('附图'),
		'没有图时不该提示看图，否则模型会去描述不存在的图'
	);
});

test('有图时要求模型在信息不足时降低 confidence', () => {
	const q = { stem: '下图所示流程图中，缺失的环节应当是：', qtype: '单选题', opts: [] };
	const p = buildPrompt(q, { hasFigure: true });
	assert.match(
		p.system,
		/confidence.*0\.3|不足以|看不清/,
		'图看不清时必须让模型诚实降低置信度，而不是硬猜一个字母'
	);
});

test('prompt 文本不能因为加了图就丢掉题干与选项', () => {
	const q = {
		stem: '下图所示流程图中，缺失的环节应当是：',
		qtype: '单选题',
		opts: [
			{ letter: 'A', text: '承印登记' },
			{ letter: 'B', text: '排版设计' },
		],
	};
	const p = buildPrompt(q, { hasFigure: true });
	assert.ok(p.user.includes(q.stem), '题干必须在 user 里');
	assert.ok(p.user.includes('A. 承印登记'), '选项必须在 user 里');
	assert.ok(p.user.includes('B. 排版设计'));
});

test('solveOnce 源码契约：图片必须进 message content', () => {
	// 静态检查，因为这里的错误是"静默的"：
	// 传了 imageDataUrl 但没放进 content，模型收不到图，
	// 照样会返回一个看起来正常的答案 —— 只有图形题答错时才暴露。
	const src = fs.readFileSync(path.join(ROOT, 'lib', 'core', 'llm.js'), 'utf8');
	const i = src.indexOf('async solveOnce');
	assert.ok(i >= 0, '找不到 solveOnce');
	const body = src.slice(i, i + 3000);

	assert.ok(body.includes('imageAttachment'), 'solveOnce 必须处理 imageAttachment');
	assert.ok(
		/type:\s*'image'/.test(body),
		"必须构造 { type: 'image' } 的内容块，否则图不会被送给模型"
	);
	// 关键：DSH 的 ImageBlock 用 attachment（附件引用），不是内联 base64。
	// 查 @deepseek-ai/dsh-llm/src/types.ts 确认：
	//   interface ImageBlock { type:'image'; attachment: ImageAttachmentRef }
	assert.ok(
		/attachment:\s*opts\.imageAttachment/.test(body),
		'必须写成 { type:"image", attachment: ref } —— 写成 source/dataUrl 会被静默忽略'
	);
	assert.ok(
		/content\.push\(/.test(body) || /content:\s*\[/.test(body),
		'图片必须被加进 content 数组'
	);
});

test('Runner 源码契约：只在配了 figure 区时截图', () => {
	const src = fs.readFileSync(path.join(ROOT, 'lib', 'core', 'runner.js'), 'utf8');
	// 定位方法定义而不是第一个调用点（调用点之后插代码会让窗口够不到方法体）
	const m = /\n\s*(?:async\s+)?_captureFigure\s*\([^)]*\)\s*\{/.exec(src);
	const i = m ? m.index : src.indexOf('_captureFigure');
	assert.ok(i >= 0, '找不到 _captureFigure 方法');
	const body = src.slice(i, i + 4000);

	assert.ok(body.includes('zoneMap?.figure'), '必须检查 figure 区是否存在');
	assert.ok(
		/if\s*\(!zone\)\s*return null/.test(body),
		'没有 figure 区时应返回 null（不做无意义的全屏截图）'
	);
	assert.ok(/try\s*{/.test(body) && /catch/.test(body), '截图失败必须被捕获，不能让整题失败');
	// 图片必须入库换 ImageAttachmentRef —— llm 不接受内联 base64
	assert.ok(
		/saveImages/.test(body),
		'必须调用 attachments.saveImages() 把截图入库；' +
			'直接传 base64 给 llm 会被静默忽略（模型看不到图）'
	);
	assert.ok(
		/attachmentId/.test(body),
		'入库后要校验拿到了 attachmentId（附件引用），否则等于没入库'
	);
});

test('Runner 源码契约：截图失败要退化为纯文字，而不是让整题失败', () => {
	const src = fs.readFileSync(path.join(ROOT, 'lib', 'core', 'runner.js'), 'utf8');
	// 定位方法定义而不是第一个调用点（调用点之后插代码会让窗口够不到方法体）
	const m = /\n\s*(?:async\s+)?_captureFigure\s*\([^)]*\)\s*\{/.exec(src);
	const i = m ? m.index : src.indexOf('_captureFigure');
	const body = src.slice(i, i + 4000);

	assert.ok(
		/return null/.test(body),
		'失败路径必须返回 null —— 调用方据此退回纯文字作答'
	);
	// 关键：不能 throw，否则整个 resolve 阶段挂掉
	const withoutReturns = body.replace(/return null/g, '');
	assert.ok(
		!/throw\s+/.test(withoutReturns),
		'_captureFigure 不该抛异常：截图是"锦上添花"，不该拖垮整题'
	);
});

test('视觉通道只在题库没给出可接受答案时才启用（不浪费 token）', () => {
	const src = fs.readFileSync(path.join(ROOT, 'lib', 'core', 'runner.js'), 'utf8');
	// 题库命中路径应该 return 在前，走不到模型分支
	const bankIdx = src.indexOf('题库${bankResult.confidence}命中');
	const modelIdx = src.indexOf('// 2) 模型');
	assert.ok(bankIdx > 0 && modelIdx > 0, '找不到题库/模型两段');
	assert.ok(
		bankIdx < modelIdx,
		'题库分支必须在模型分支之前 —— 否则高置信命中也会去截图烧 token'
	);
});

test('访问注入服务必须走 tryGetService（直接点会整块 INTERNAL）', () => {
	// Cordis 的注入服务在声明 inject 前直接访问会抛
	//   cannot get property "attachments" without inject
	// 这个异常把**整个 handler** 打成 INTERNAL —— 连 status 这种纯查询都挂了。
	// 所以凡是要"有就用、没有就降级"的服务，必须走 tryGetService。
	const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
	assert.ok(
		/function tryGetService\(/.test(src),
		'缺少 tryGetService 辅助函数'
	);
	// 不允许任何裸的 ctx.attachments 直接属性访问。
	// 先剥掉注释 —— 注释里拿它举例说明是正常的，不该算违规。
	const code = src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
	const bare = [...code.matchAll(/ctx\.attachments/g)];
	assert.deepEqual(
		bare.map((m) => m.index),
		[],
		`发现 ${bare.length} 处裸的 ctx.attachments 访问（会抛 without inject）。` +
			'改用 tryGetService(ctx, "attachments")'
	);
});
