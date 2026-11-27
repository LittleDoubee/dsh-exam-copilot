// 协同模式的状态机契约：空动作是「设计如此」，不是故障。
//
// 实测发现的两个连环缺陷：
//
//   ① runner 无条件把 `_decide` 的结果丢给 `validateSequence`。
//      协同模式的 `_decide` 返回 `[]`（本来就不点击），
//      validateSequence([]) 返回 `EMPTY_SEQUENCE` 错误 →
//      走 FAILED 分支 → 重试 3 次 → `paused/error`。
//      **而那时答案已经拿到了**（实测 answer=A）——
//      等于"算出了答案，却因为不需要点击而判自己失败"。
//
//   ② pipeline 的 DECIDED 分支把 `actions.length === 0` 一律当
//      「没算出动作」→ UNKNOWN_QUESTION。同样分不清
//      「协同模式不动作」与「全自动解不出动作」。
//
// 正确契约：
//   空动作 + 有答案 = 正常结束（出答案、pause 等人操作）
//   空动作 + 无答案 = 真异常（转人工）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RUN_STATE, PAUSE_REASON } from '../lib/core/guardrails.js';
import { initialState, summarize, transition } from '../lib/core/pipeline.js';

/** 造一个「正在运行、已解析出题目」的状态。 */
function runningWithQuestion() {
	let state = initialState();
	state = transition(state, { type: 'START' }, {}).state;
	state = transition(state, { type: 'CAPTURED', hash: 'h1', progress: [1, 12], observation: {} }, {}).state;
	state = transition(
		state,
		{
			type: 'PARSED',
			question: {
				stem: '测试题干',
				opts: [
					{ letter: 'A', text: '甲' },
					{ letter: 'B', text: '乙' },
				],
				prog: [1, 12],
			},
		},
		{}
	).state;
	return state;
}

test('空动作 + 有答案 → 正常暂停（协同模式），不能判 error', () => {
	let state = runningWithQuestion();
	state = transition(state, { type: 'RESOLVED', answer: 'A', confidence: 'high', source: 'bank:high' }, {}).state;
	assert.equal(state.answer, 'A');

	const r = transition(state, { type: 'DECIDED', actions: [], noActionByDesign: true }, {});
	const s = r.state;

	assert.equal(s.run, RUN_STATE.PAUSED, '应该是暂停（等人操作），不是别的终态');
	assert.equal(
		s.pauseReason,
		PAUSE_REASON.USER,
		`暂停原因应是 user（用户接手），实际 ${s.pauseReason}。` +
			'若为 error/unknown_question，说明又把"设计如此"当成了故障。'
	);
	assert.equal(s.answer, 'A', '答案必须保留，不能被清空');
	assert.equal(s.stats.failed, 0, '协同模式空动作不该记 failed');
});

test('空动作 + 无答案 → 仍按原逻辑转人工（这是真异常）', () => {
	const state = runningWithQuestion();
	const r = transition(state, { type: 'DECIDED', actions: [], noActionByDesign: false }, {});
	const s = r.state;

	assert.equal(s.run, RUN_STATE.PAUSED);
	assert.equal(
		s.pauseReason,
		PAUSE_REASON.UNKNOWN_QUESTION,
		`没有答案又没有动作，应判 unknown_question，实际 ${s.pauseReason}`
	);
});

test('答案来源与置信度要出现在 summarize 里（否则用户无法判断可信度）', () => {
	let state = runningWithQuestion();
	state = transition(
		state,
		{ type: 'RESOLVED', answer: 'B', confidence: 'medium-high', source: 'bank:medium-high' },
		{}
	).state;

	const snap = summarize(state);
	assert.equal(snap.answer, 'B');
	assert.equal(snap.source, 'bank:medium-high', '必须告诉用户答案来自题库还是模型');
	assert.equal(snap.confidence, 'medium-high', '必须给出置信度');
});

test('协同模式：空动作不能被算进失败计数（否则面板显示「失败 N 次」）', () => {
	let state = runningWithQuestion();
	state = transition(state, { type: 'RESOLVED', answer: 'A', confidence: 0.95, source: 'bank:high' }, {}).state;
	const beforeFailed = state.stats.failed;

	const r = transition(state, { type: 'DECIDED', actions: [], noActionByDesign: true }, {});
	assert.equal(r.state.stats.failed, beforeFailed, 'failed 不该增加');
});
