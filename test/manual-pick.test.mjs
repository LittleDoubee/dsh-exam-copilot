// 人工作答与暂停恢复：状态机迁移、题号读取重试。

import assert from 'node:assert/strict';
import test from 'node:test';

import { RUN_STATE, PAUSE_REASON } from '../lib/core/guardrails.js';
import { initialState, transition, PHASE } from '../lib/core/pipeline.js';
import { Runner } from '../lib/core/runner.js';

function pausedUnknown() {
	return initialState({ run: RUN_STATE.PAUSED, pauseReason: PAUSE_REASON.UNKNOWN_QUESTION, phase: PHASE.RESOLVE });
}

test('人工作答：暂停态收到 MANUAL_ANSWERED 后只执行翻页动作', () => {
	const next = { action: 'click_role', params: { role: 'next' }, expect: { page_changed: true } };
	const { state, effects } = transition(pausedUnknown(), { type: 'MANUAL_ANSWERED', answer: 'AC', actions: [next] });
	assert.equal(state.run, RUN_STATE.RUNNING);
	assert.equal(state.pauseReason, null);
	assert.equal(state.answer, 'AC');
	assert.equal(state.answerSource, 'manual');
	assert.equal(state.phase, PHASE.ACT);
	assert.deepEqual(state.pendingActions, [next]);
	assert.equal(effects[0].type, 'act');
});

test('人工作答：没有翻页动作时回到读题', () => {
	const { state } = transition(pausedUnknown(), { type: 'MANUAL_ANSWERED', answer: 'B', actions: [] });
	assert.equal(state.run, RUN_STATE.RUNNING);
	assert.equal(state.phase, PHASE.CAPTURE);
});

test('人工作答：非暂停态忽略', () => {
	const s = initialState({ run: RUN_STATE.RUNNING, phase: PHASE.CAPTURE });
	const { state } = transition(s, { type: 'MANUAL_ANSWERED', answer: 'A', actions: [] });
	assert.equal(state.phase, PHASE.CAPTURE);
	assert.equal(state.answerSource ?? null, null);
});

test('恢复运行：从读题重新开始', () => {
	const { state } = transition(pausedUnknown(), { type: 'RESUME' });
	assert.equal(state.run, RUN_STATE.RUNNING);
	assert.equal(state.phase, PHASE.CAPTURE);
});

test('题号读取：首次失败后重试成功', async () => {
	let n = 0;
	const logs = [];
	const self = {
		engine: { async readProgress() { n += 1; return n === 1 ? { ok: false } : { ok: true, progress: [5, 72] }; } },
		log: (m) => logs.push(m),
		_plausibleProgress: Runner.prototype._plausibleProgress,
	};
	const r = await Runner.prototype._readProgressRetry.call(self, [0, 0, 10, 10], '翻页验证');
	assert.deepEqual(r, [5, 72]);
	assert.equal(n, 2);
	assert.equal(logs.length, 0);
});

test('题号读取：两次都失败时记录区域与引擎返回', async () => {
	const logs = [];
	const self = {
		engine: { async readProgress() { return { ok: false, text: '' }; } },
		log: (m) => logs.push(m),
		_plausibleProgress: Runner.prototype._plausibleProgress,
	};
	const r = await Runner.prototype._readProgressRetry.call(self, [1, 2, 3, 4], '翻页验证');
	assert.equal(r, null);
	assert.equal(logs.length, 1);
	assert.match(logs[0], /翻页验证：读不到题号，区域=\[1,2,3,4\]/);
});

test('重置当前题跟踪：清掉旧题目标识与卡住计数', () => {
	const self = { _lastQuestionKey: '3/72|x', _stuckRepeats: 2, questionStartedAtMs: 1 };
	Runner.prototype._resetQuestionTracking.call(self);
	assert.equal(self._lastQuestionKey, null);
	assert.equal(self._stuckRepeats, 0);
	assert.ok(self.questionStartedAtMs > 1);
});

test('题号合理性：截断的「10/1」在已知总数 12 后被拒绝', () => {
	const self = { _maxTotal: 0 };
	const ok = Runner.prototype._plausibleProgress;
	assert.equal(ok.call(self, [9, 12]), true);
	assert.equal(ok.call(self, [10, 1]), false);
	assert.equal(ok.call(self, [12, 12]), true);
	assert.equal(ok.call(self, [13, 12]), false);
});

test('题号读取：读取区域向右放宽', async () => {
	let seen = null;
	const self = {
		engine: { async readProgress(r) { seen = r; return { ok: true, progress: [10, 12] }; } },
		log: () => {},
		_maxTotal: 12,
		_plausibleProgress: Runner.prototype._plausibleProgress,
	};
	const r = await Runner.prototype._readProgressRetry.call(self, [100, 200, 50, 20], '读题');
	assert.deepEqual(r, [10, 12]);
	assert.deepEqual(seen, [100, 200, 110, 20]);
});

test('最后一题：只点选项，不点下一题', () => {
	const self = {
		state: { progressBefore: [12, 12] },
		profile: { actions: {}, navigation: {} },
		zoneMap: { next: { x: 0, y: 0, w: 10, h: 10 } },
		_onLastQuestion: Runner.prototype._onLastQuestion,
	};
	const opt = { action: 'click_point', params: { x: 1, y: 1 } };
	assert.deepEqual(Runner.prototype._navActions.call(self, [opt]), [opt]);
	self.state.progressBefore = [11, 12];
	assert.equal(Runner.prototype._navActions.call(self, [opt]).length, 2);
});
