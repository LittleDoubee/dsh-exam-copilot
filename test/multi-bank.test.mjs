// 多题库匹配 + miss 记录 的单测。
//
// 对应：「题库存了很多文件，实际运行时如何匹配？
// 需要匹配多个题库又该如何操作？」
// 核心断言：**不能按数组顺序撞第一个命中**，要全局排序取最优。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BankIndex, CONFIDENCE } from '../lib/core/bank.js';
import { matchAcrossBanks, makeMissRecord, summarizeMisses } from '../lib/core/multi-bank.js';

/** 造一个题库：[{stem, options, answer, qtype}] */
function mkBank(items) {
	return new BankIndex(items.map((it) => ({ qtype: '单选题', ...it })));
}

function opts(...texts) {
	return texts.map((t, i) => ({ letter: String.fromCharCode(65 + i), text: t }));
}

const Q = {
	qtype: '单选题',
	stem: '第五套人民币100元纸币的正面主景图案是什么？',
	opts: opts('毛泽东头像', '人民大会堂', '布达拉宫', '桂林山水'),
};

test('多题库：全局取最优，不被数组顺序左右', () => {
	// 库 A：题干近似（差一个字）+ 选项一致 → medium-high
	const bankA = mkBank([
		{
			stem: '第五套人民币100元纸币正面主景图案是什么？',
			options: opts('毛泽东头像', '人民大会堂', '布达拉宫', '桂林山水'),
			answer: 'A',
		},
	]);
	// 库 B：题干完全一致 + 选项完全一致 → high
	const bankB = mkBank([
		{
			stem: '第五套人民币100元纸币的正面主景图案是什么？',
			options: opts('毛泽东头像', '人民大会堂', '布达拉宫', '桂林山水'),
			answer: 'A',
		},
	]);

	// A 在前：旧实现会在这里就返回 medium-high，永远看不到 B
	const r = matchAcrossBanks(Q, [
		{ id: 'A', index: bankA },
		{ id: 'B', index: bankB },
	]);

	assert.equal(r.ok, true);
	assert.equal(r.confidence, CONFIDENCE.HIGH, '应取全局最优（HIGH），而不是第一个库的 MEDIUM_HIGH');
	assert.equal(r.bankId, 'B', '应命中真正高置信的那个库');

	// perBank 应记录两个库各自的成绩，供面板诊断
	assert.equal(r.perBank.length, 2);
	assert.ok(r.perBank.every((b) => b.ok));
});

test('多题库：一个库不匹配、另一个匹配，仍能命中', () => {
	const bankBad = mkBank([
		{ stem: '完全不相关的题目内容', options: opts('甲', '乙'), answer: 'A' },
	]);
	const bankGood = mkBank([
		{
			stem: '第五套人民币100元纸币的正面主景图案是什么？',
			options: opts('毛泽东头像', '人民大会堂', '布达拉宫', '桂林山水'),
			answer: 'A',
		},
	]);

	const r = matchAcrossBanks(Q, [
		{ id: 'bad', index: bankBad },
		{ id: 'good', index: bankGood },
	]);
	assert.equal(r.ok, true);
	assert.equal(r.bankId, 'good');
	assert.equal(r.perBank.find((b) => b.bankId === 'bad').ok, false, '不匹配的库应标记 ok:false');
});

test('多题库：全部不匹配时明确返回未命中，并带上各库诊断', () => {
	const r = matchAcrossBanks(Q, [
		{ id: 'x', index: mkBank([{ stem: '另一道完全无关的题', options: opts('甲', '乙'), answer: 'A' }]) },
		{ id: 'y', index: mkBank([{ stem: '第三道无关题', options: opts('丙', '丁'), answer: 'B' }]) },
	]);
	assert.equal(r.ok, false);
	assert.match(r.reason, /没有足够相似/);
	assert.equal(r.perBank.length, 2, '未命中也要给出各库诊断，否则无法判断该补哪个库');
});

test('多题库：空列表不崩', () => {
	const r = matchAcrossBanks(Q, []);
	assert.equal(r.ok, false);
	assert.match(r.reason, /没有可用/);
});

test('多题库：置信等级压过相似度小数', () => {
	// 库 A：stem 0.99 但选项完全不吻合 → MEDIUM
	// 库 B：stem 0.94 但选项吻合 → MEDIUM_HIGH
	// 正确排序应选 B：题干几乎一样但选项全不同的题最危险。
	const bankA = mkBank([
		{
			stem: '第五套人民币100元纸币的正面主景图案是什么？',
			options: opts('长城', '西湖', '黄山', '长江'),
			answer: 'A',
		},
	]);
	const bankB = mkBank([
		{
			stem: '第五套人民币100元纸币正面主景图案是啥？',
			options: opts('毛泽东头像', '人民大会堂', '布达拉宫', '桂林山水'),
			answer: 'A',
		},
	]);

	const r = matchAcrossBanks(Q, [
		{ id: 'A', index: bankA },
		{ id: 'B', index: bankB },
	]);
	assert.equal(r.ok, true);
	// 只要不是 MEDIUM 压过 MEDIUM_HIGH 就说明排序正确
	const ra = r.perBank.find((b) => b.bankId === 'A');
	const rb = r.perBank.find((b) => b.bankId === 'B');
	assert.ok(rb.options > ra.options, 'B 的选项相似度应更高');
	assert.equal(r.bankId, 'B', '应选选项吻合的那条（MEDIUM_HIGH 压过 MEDIUM）');
});

test('多题库：onHit 只在采纳（高/中高）时回调', () => {
	let hit = null;
	matchAcrossBanks(Q, [{ id: 'only', index: mkBank([{ stem: '完全无关', options: opts('甲', '乙'), answer: 'A' }]) }], {
		onHit: (id, c) => {
			hit = { id, c };
		},
	});
	assert.equal(hit, null, '未命中不该记命中统计');

	hit = null;
	matchAcrossBanks(
		Q,
		[
			{
				id: 'good',
				index: mkBank([
					{
						stem: '第五套人民币100元纸币的正面主景图案是什么？',
						options: opts('毛泽东头像', '人民大会堂', '布达拉宫', '桂林山水'),
						answer: 'A',
					},
				]),
			},
		],
		{ onHit: (id, c) => (hit = { id, c }) }
	);
	assert.deepEqual(hit, { id: 'good', c: CONFIDENCE.HIGH });
});

test('makeMissRecord：只记能用来补题的信息', () => {
	const r = matchAcrossBanks(Q, [
		{ id: 'a', index: mkBank([{ stem: '无关题', options: opts('甲', '乙'), answer: 'A' }]) },
	]);
	const rec = makeMissRecord(Q, r, Date.parse('2026-11-22T10:00:00Z'));

	assert.equal(rec.stem, Q.stem);
	assert.equal(rec.qtype, '单选题');
	assert.equal(rec.opts.length, 4);
	assert.equal(rec.perBank.length, 1);
	assert.equal(rec.at, '2026-11-22T10:00:00.000Z');
	// 不该记截图/整场上下文（体积大且含隐私）
	assert.equal(rec.shot, undefined);
	assert.equal(rec.screenshot, undefined);
});

test('summarizeMisses：按题干聚合，反复 miss 的排前面', () => {
	const recs = [
		{ at: '2026-11-01T00:00:00Z', stem: '题 A', qtype: '单选题', opts: [], reason: 'x' },
		{ at: '2026-11-02T00:00:00Z', stem: '题 B', qtype: '判断题', opts: [], reason: 'x' },
		{ at: '2026-11-03T00:00:00Z', stem: '题 A', qtype: '单选题', opts: [], reason: 'x' },
		{ at: '2026-11-04T00:00:00Z', stem: '题 A', qtype: '单选题', opts: [], reason: 'x' },
	];

	const g = summarizeMisses(recs);
	assert.equal(g.length, 2, '两道不同题干应聚成两组');
	assert.equal(g[0].stem, '题 A');
	assert.equal(g[0].count, 3);
	assert.equal(g[0].firstAt, '2026-11-01T00:00:00Z');
	assert.equal(g[0].lastAt, '2026-11-04T00:00:00Z');
	assert.equal(g[1].count, 1);
});

test('summarizeMisses：minCount 能过滤偶发 miss', () => {
	const recs = [
		{ at: 'a', stem: 'X', qtype: '', opts: [] },
		{ at: 'b', stem: 'X', qtype: '', opts: [] },
		{ at: 'c', stem: 'Y', qtype: '', opts: [] },
	];
	assert.equal(summarizeMisses(recs, { minCount: 2 }).length, 1);
	assert.equal(summarizeMisses(recs, { minCount: 2 })[0].stem, 'X');
});
