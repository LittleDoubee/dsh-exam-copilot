// 多模型投票的验收测试。
//
// S4 要求：「投票能识别低置信并转人工」。
//
// 设计意图（读 llm.js 得出，这里逐条验证）：
//   全票一致 → 0.92（高于阈值 0.8，直接采用）
//   多数一致 → 0.6（低于阈值，转人工）
//   全部分歧 → 0.35（转人工）
//
// 为什么要这三档而不是简单的「多数即采用」：
//   2/3 一致看起来是"多数"，但考试场景里 1/3 的反对很可能意味着
//   OCR 读错或题目有歧义。宁可转人工，也不要自信地错。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SolverPool, parseAnswer, buildPrompt } from '../lib/core/llm.js';

/** 造一个每次都返回指定答案的假 solver。 */
function fakePool(answers, { failAt = [] } = {}) {
	// 注意签名：SolverPool(llm, opts) —— 第一个参数是 llm 服务，不是 opts。
	const fakeLlm = { listProviders: () => [], listModels: async () => [], stream: async function* () {} };
	const pool = new SolverPool(fakeLlm, { votes: answers.length });
	let i = 0;
	pool.pickTarget = async () => ({ provider: 'fake', model: 'fake-model' });
	pool.solveOnce = async () => {
		const idx = i++;
		if (failAt.includes(idx)) throw new Error('故意失败 ' + idx);
		return { ok: true, value: answers[idx], confidence: 0.9, reason: 'fake', tokens: 100 };
	};
	return pool;
}

const Q = { qtype: '单选题', stem: '测试题干', opts: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }] };

test('投票：三次全部一致 → 置信 0.92（可直接采用）', async () => {
	const pool = fakePool(['A', 'A', 'A']);
	const r = await pool.solve(Q);

	assert.equal(r.ok, true);
	assert.equal(r.answer, 'A');
	assert.equal(r.confidence, 0.92, '全票一致应给 0.92');
	assert.equal(r.source, 'model-vote');
	assert.match(r.reason, /一致/);
	// 0.92 > 默认阈值 0.8 → 不会被判低置信
	assert.ok(r.confidence > 0.8);
});

test('投票：2/3 多数 → 置信 0.6（低于阈值，转人工）', async () => {
	const pool = fakePool(['A', 'A', 'B']);
	const r = await pool.solve(Q);

	assert.equal(r.ok, true);
	assert.equal(r.answer, 'A', '应取多数票');
	assert.equal(r.confidence, 0.6, '多数但不是全票 → 0.6');
	assert.match(r.reason, /分歧/);
	// 关键：0.6 < 0.8，runner 会判 lowConfidence 并转人工
	assert.ok(r.confidence < 0.8, '多数票也必须低于阈值 —— 宁可转人工也不要自信地错');
});

test('投票：三次各不相同 → 置信 0.35（明显转人工）', async () => {
	const pool = fakePool(['A', 'B', 'C']);
	const r = await pool.solve(Q);

	assert.equal(r.ok, true);
	assert.equal(r.confidence, 0.35, '完全分歧 → 0.35');
	assert.ok(r.confidence < 0.8);
});

test('投票：两次一致一次失败 → 有失败即降到阈值以下，记入待复核', async () => {
	// 规则：多次作答中只要有任何一次失败，
	// 一致性就不完整，一律压到 ≤0.5 进入待复核，而不是按成功的票算全票一致。
	const pool = fakePool(['A', 'A', 'A'], { failAt: [2] });
	const r = await pool.solve(Q);

	assert.equal(r.ok, true);
	assert.equal(r.answer, 'A');
	assert.ok(r.confidence <= 0.5, '有失败时置信必须压到阈值以下');
	assert.match(r.reason, /2\/3/);
});

test('投票：全部失败 → ok:false，不产生答案', async () => {
	const pool = fakePool(['A', 'A', 'A'], { failAt: [0, 1, 2] });
	const r = await pool.solve(Q);

	assert.equal(r.ok, false);
	assert.ok(r.error);
});

test('单次求解（votes=0）→ 置信上限 0.9，不会冒充全票一致', async () => {
	const pool = fakePool(['A']);
	const r = await pool.solve(Q);

	assert.equal(r.ok, true);
	assert.equal(r.source, 'model');
	assert.ok(r.confidence <= 0.9, '单模型置信不应超过 0.9');
});

test('投票结果带上每票明细（便于面板排查）', async () => {
	const pool = fakePool(['A', 'A', 'B']);
	const r = await pool.solve(Q);

	assert.ok(Array.isArray(r.votes), 'votes 应有明细');
	assert.equal(r.votes.length, 3);
	assert.ok(r.votes.every((v) => v.ok));
});

test('投票：token 统计是成功票之和', async () => {
	const pool = fakePool(['A', 'A', 'A']);
	const r = await pool.solve(Q);
	// 每票 100 tokens，3 票全成功
	assert.equal(r.totalTokens, 300);
});
