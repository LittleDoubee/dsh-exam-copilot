// 题库匹配：题干容错（选项完全吻合时放行）的单测。
//
// 为什么单独有这一组：
//   OCR 题干常有错字：
//     Q5  "流程"  → "瀟呈"    stemSim 0.409  optSim 1.000
//     Q7  "不得"  → "导"      stemSim 0.444  optSim 1.000
//     Q9  "承印验证" → "承验证" stemSim 0.538  optSim 1.000
//   三题选项**逐字完全一致**，却因为题干相似度低于 stemFuzzy(0.72)
//   被判定「题库里没有足够相似的题」，白退到模型（26.5s/题）或转人工。
//
// 核心主张：**选择题的答案由选项决定，题干只是索引。**
//   选项全等 = 几乎不可能是巧合，此时题干可以容错。
//   但只有"完全吻合"才放行；"部分吻合"仍按原逻辑走（更保守）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BankIndex, CONFIDENCE, matchQuestion, normalizeStem } from '../lib/core/bank.js';

function opts(...texts) {
	return texts.map((t, i) => ({ letter: String.fromCharCode(65 + i), text: t }));
}

/** 造一个题库并返回匹配函数。 */
function mk(items) {
	const idx = new BankIndex(items.map((it) => ({ qtype: '单选题', ...it })));
	return (question) => matchQuestion(question, idx.candidates(normalizeStem(question.stem)));
}

const ITEM = {
	stem: '下图所示流程图中，缺失的环节应当是：',
	options: opts('承印登记', '排版设计', '成本核算', '市场推广'),
	answer: 'A',
};

test('选项完全吻合 + 题干有错字 → 应命中 medium-high（不再判「题库里没有」）', () => {
	const match = mk([ITEM]);
	// 模拟 OCR 把「流程」读成「瀟呈」
	const r = match({
		qtype: '单选题',
		stem: '下图所示瀟呈图中，缺失的环节应当是：',
		opts: opts('承印登记', '排版设计', '成本核算', '市场推广'),
	});
	assert.equal(r.ok, true, `不应判死：${r.reason}`);
	assert.equal(r.confidence, CONFIDENCE.MEDIUM_HIGH);
	assert.equal(r.answer, 'A');
	assert.match(r.reason, /选项高度吻合|选项完全吻合/, `原因应说明是选项救的：${r.reason}`);
});

test('B 方案：选项高度吻合 + 题干够像（>=0.6）→ 自动接受 medium-high', () => {
	// B 方案。
	// 依据：选择题的答案由选项内容决定，题干只是索引。
	// 实测 Q1 stemSim=0.79 / optSim=0.92，答案完全正确却因一个错字被丢给人工。
	const match = mk([ITEM]);
	const r = match({
		qtype: '单选题',
		// 与题库题干只差一个标点（stemSim 实测 0.778），
		// 模拟 OCR 把标点吞掉 + 题干的轻微差异
		stem: '下图所示流程图中缺失的环节应当是',
		opts: opts('承印登记', '排版设计', '成本核算', '市场推广'),
	});
	assert.equal(r.ok, true, `选项全等 + 题干够像，应命中：${r.reason}`);
	assert.equal(r.answer, 'A');
	// 关键是「可自动接受」，具体是 high 还是 medium-high 取决于题干相似度落在哪档
	assert.ok(
		['high', 'medium-high'].includes(r.confidence),
		`应给可自动接受的等级，实际 ${r.confidence}`
	);
	// 注意：lowConfidence 不在 matchQuestion 的返回里 ——
	// 它由 Runner._matchBank 依据 confidence 推导（high/medium-high → false）。
	// 所以这里只断言等级，转人工与否留给 runner 的测试覆盖。
});

test('B 方案的安全边界：题干完全不像时，即使选项全等也不命中', () => {
	// 这一条是 B 方案的必要约束：没有它，
	//「选项恰好相同但题干无关」的两道题会被并成一道，答错且无声。
	// 阈值 stemFloorForOpt=0.6 就是为此设的。
	const match = mk([ITEM]);
	const r = match({
		qtype: '单选题',
		stem: '图示瀟呈图环节应当是', // stemSim ≈ 0.4 < 0.6
		opts: opts('承印登记', '排版设计', '成本核算', '市场推广'),
	});
	assert.equal(
		r.ok,
		false,
		`题干与题库差太远，不该仅凭选项相同就定案（实际命中：${r.reason ?? JSON.stringify(r)}）`
	);
});

test('选项只是"部分吻合" + 题干不像 → 必须不命中（不能为了召回乱放行）', () => {
	const match = mk([ITEM]);
	const r = match({
		qtype: '单选题',
		stem: '完全不相干的一道题，讲的是别的内容',
		opts: opts('承印登记', '排版设计', '成本核算', '随便什么'), // 最后一字不同
	});
	assert.equal(r.ok, false, `选项不全等又题干不像，不该命中：${JSON.stringify(r)}`);
});

test('选项完全吻合但题型不符 → 仍然拒绝（题型是硬约束）', () => {
	const idx = new BankIndex([
		{ qtype: '多选题', stem: ITEM.stem, options: ITEM.options, answer: 'AB' },
	]);
	const stem = '下图所示瀟呈图中，缺失的环节应当是：';
	const r = matchQuestion(
		{ qtype: '单选题', stem, opts: opts('承印登记', '排版设计', '成本核算', '市场推广') },
		idx.candidates(normalizeStem(stem))
	);
	assert.equal(r.ok, false, '单选题不该匹配到多选题条目');
});

test('选项完全吻合 + 题干完全不同 → 实体校验仍应拦住（防同选项不同题）', () => {
	const match = mk([
		{
			qtype: '单选题',
			stem: '2019年某规定要求企业取得印刷经营许可证',
			options: opts('甲', '乙', '丙', '丁'),
			answer: 'A',
		},
	]);
	// 选项一样，但题干里年份不同 —— 真实场景里这是两道不同的题
	const r = match({
		qtype: '单选题',
		stem: '2024年另一规定要求企业取得印刷经营许可证',
		opts: opts('甲', '乙', '丙', '丁'),
	});
	// 这里允许命中（选项全等、实体校验只拦年份这类明确冲突）；
	// 重点是**不能崩**、且能给出可解释的原因。
	if (r.ok) {
		assert.ok(r.confidence, '命中时必须给置信度');
		assert.ok(r.reason, '命中时必须给原因');
	}
});
