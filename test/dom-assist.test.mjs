// DOM 补救通道的测试。
//
//
//   「网页答题可能会有各类弹窗、广告，如果单靠 OCR 会造成识别上的错误，
//     应该是先 OCR，识别不准确的时候用 DOM 调整精度」
//
// 所以这块的核心不是"能不能取 DOM"，而是：
//   ① 什么时候**值得**去取（不乱调、不拖慢每次答题）
//   ② 取到后怎么和 OCR 结果合并才不出错

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	shouldUseDom,
	pickQuestionFromLines,
	mergeDomResult,
	pickExamTab,
	CDP_CANDIDATES,
} from '../lib/core/dom-assist.js';

/* ── 触发条件 ─────────────────────────────────── */

test('正常的 OCR 结果不需要 DOM（不能每次都去连浏览器）', () => {
	const q = {
		stem: '《中国人民银行货币鉴别及假币收缴、鉴定管理办法》中所指的人民币（）。',
		opts: [
			{ letter: 'A', text: '指中国人民银行发行的法定货币' },
			{ letter: 'B', text: '指正在流通的人民币' },
			{ letter: 'C', text: '指中国人民银行发行的法定货币，包括流通币和纪念币' },
			{ letter: 'D', text: '指人民币纸币' },
		],
		qtype: '单选题',
	};
	const r = shouldUseDom(q);
	assert.equal(r.need, false, '正常题目不该触发 DOM：' + r.reasons.join('；'));
});

test('题干为空 → 需要 DOM', () => {
	assert.equal(shouldUseDom({ stem: '', opts: [{ letter: 'A', text: '甲' }] }).need, true);
});

test('选项文字异常（全是单字符）→ 需要 DOM', () => {
	// 典型 OCR 失败：把选项文字读成了单个字符或符号
	const q = {
		stem: '下列哪个是正确的？',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
	};
	const r = shouldUseDom(q);
	assert.equal(r.need, true);
	assert.ok(r.reasons.includes('选项文字异常'));
});

test('题干含噪声字符（竖线重复/乱码）→ 需要 DOM', () => {
	const q = {
		stem: '下列哪项||是正确的＿＿的？',
		opts: [{ letter: 'A', text: '选项一' }, { letter: 'B', text: '选项二' }],
	};
	const r = shouldUseDom(q);
	assert.equal(r.need, true);
	assert.ok(r.reasons.includes('题干含噪声字符'));
});

test('没有选项 → 需要 DOM', () => {
	const r = shouldUseDom({ stem: '这是一道没有选项的题', opts: [] });
	assert.equal(r.need, true);
});

test('题目被判不完整 → 需要 DOM', () => {
	const q = {
		stem: '某题干',
		opts: [{ letter: 'A', text: '选项甲' }],
		_complete: false,
	};
	const r = shouldUseDom(q);
	assert.equal(r.need, true);
	assert.ok(r.reasons.some((x) => x.includes('不完整')));
});

test('解析置信度低于阈值 → 需要 DOM', () => {
	const q = {
		stem: '正常的题干内容在这里',
		opts: [{ letter: 'A', text: '选项甲文字' }, { letter: 'B', text: '选项乙文字' }],
		confidence: 0.4,
	};
	const r = shouldUseDom(q, { threshold: 0.8 });
	assert.equal(r.need, true);
	assert.ok(r.reasons.some((x) => x.includes('置信度')));
});

/* ── 从文本行提取题目 ─────────────────────────── */

test('能从页面文本里按 OCR 题干锚点找到题目', () => {
	const lines = [
		'首页 | 我的考试 | 帮助',
		'广告：限时优惠，点击领取',
		'1. 人民币的货币符号是（）。',
		'A. ¥',
		'B. $',
		'C. €',
		'D. £',
		'2. 下一道题的内容',
	];
	const ocr = { stem: '人民币的货币符号是（）。', opts: [] };
	const r = pickQuestionFromLines(lines, ocr);

	assert.ok(r, '应找到题目');
	assert.match(r.stem, /人民币的货币符号/);
	assert.equal(r.options.length, 4);
	assert.equal(r.options[0].letter, 'A');
	assert.equal(r.options[0].text, '¥');
	assert.equal(r.source, 'dom');
});

test('找不到锚点时返回 null（不把广告当题干）', () => {
	const lines = ['广告：限时优惠', '点击领取红包', '立即购买'];
	const r = pickQuestionFromLines(lines, { stem: '完全不同的题干内容' });
	assert.equal(r, null, '宁可不救，也不要把广告文案当题目');
});

test('选项收集到下一题题号就停', () => {
	const lines = [
		'1. 第一题题干内容',
		'A. 甲',
		'B. 乙',
		'2. 第二题题干内容',
		'A. 丙',
		'B. 丁',
	];
	const r = pickQuestionFromLines(lines, { stem: '第一题题干内容' });
	assert.equal(r.options.length, 2, '不该把第二题的选项算进来');
	assert.deepEqual(r.options.map((o) => o.letter), ['A', 'B']);
});

test('选项续行能合并（多行选项）', () => {
	// 题干要够长（锚点匹配要求前 4 个字符，太短会拒绝匹配 —— 这是有意的保护）
	const lines = [
		'1. 人民币的货币符号是什么？',
		'A. 这是一个很长的选项，',
		'占了第二行',
		'B. 另一个选项',
	];
	const r = pickQuestionFromLines(lines, { stem: '人民币的货币符号是什么？' });
	assert.ok(r, '应找到题目');
	assert.equal(r.options.length, 2);
	assert.match(r.options[0].text, /占了第二行/, '续行应合并进上一个选项');
});

/* ── 合并 ─────────────────────────────────────── */

test('合并：DOM 选项更多时用 DOM 的', () => {
	const ocr = { stem: '题干', opts: [{ letter: 'A', text: '甲' }], answer: 'A' };
	const dom = {
		stem: '题干',
		options: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
	};
	const m = mergeDomResult(ocr, dom);
	assert.equal(m.opts.length, 3, '取更多的那份');
	assert.equal(m._domAssisted, true, '应标记来源');
});

test('合并：OCR 选项更多时保留 OCR 的（DOM 可能被浮层干扰）', () => {
	const ocr = {
		stem: '题干',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
	};
	const dom = { stem: '题干', options: [{ letter: 'A', text: '甲' }] };
	const m = mergeDomResult(ocr, dom);
	assert.equal(m.opts.length, 3, '不该因为 DOM 少就丢选项');
});

test('合并：题干用 DOM 的（真实文本比看图猜字可信）', () => {
	const ocr = { stem: '人民币的货币符叨是（）', opts: [{ letter: 'A', text: '¥' }] };
	const dom = { stem: '人民币的货币符号是（）。', options: [{ letter: 'A', text: '¥' }] };
	const m = mergeDomResult(ocr, dom);
	assert.match(m.stem, /符号/);
});

test('合并：答案不由 DOM 决定（页面上通常没有答案）', () => {
	const ocr = { stem: '题干', opts: [{ letter: 'A', text: '甲' }], answer: 'A' };
	const dom = { stem: '题干', options: [{ letter: 'A', text: '甲' }] };
	const m = mergeDomResult(ocr, dom);
	assert.equal(m.answer, 'A', '答案必须保留原值');
});

test('合并：DOM 为空时原样返回 OCR 结果', () => {
	const ocr = { stem: '题干', opts: [{ letter: 'A', text: '甲' }] };
	const m = mergeDomResult(ocr, null);
	assert.equal(m, ocr);
});

/* ── CDP 探测 ─────────────────────────────────── */

test('CDP 候选端口清单存在且都是回环地址', () => {
	assert.ok(CDP_CANDIDATES.length >= 2);
	for (const u of CDP_CANDIDATES) {
		assert.match(u, /^http:\/\/127\.0\.0\.1:\d+$/, '只允许回环地址，不能连外部');
	}
});

test('pickExamTab：跳过空白页与 devtools', () => {
	const tabs = [
		{ type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://1' },
		{ type: 'page', url: 'devtools://x', webSocketDebuggerUrl: 'ws://2' },
		{ type: 'page', url: 'https://exam.example.com/paper/1', webSocketDebuggerUrl: 'ws://3' },
	];
	const t = pickExamTab(tabs);
	assert.ok(t);
	assert.match(t.url, /exam\.example\.com/);
});

test('pickExamTab：没有可用页面时返回 null', () => {
	assert.equal(pickExamTab([{ type: 'page', url: 'about:blank' }]), null);
	assert.equal(pickExamTab([]), null);
	assert.equal(pickExamTab(null), null);
});

test('pickExamTab：多个页面时取最近激活的', () => {
	const tabs = [
		{ type: 'page', url: 'https://a.com', webSocketDebuggerUrl: 'ws://a', lastActiveTime: 100 },
		{ type: 'page', url: 'https://b.com', webSocketDebuggerUrl: 'ws://b', lastActiveTime: 200 },
	];
	assert.match(pickExamTab(tabs).url, /b\.com/);
});
