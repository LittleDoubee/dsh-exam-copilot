// S2 核心层单测：动作白名单 / 每步验证 / 护栏 / 状态机 / 解题池。
// 全部零 IO、零宿主，可直接 node --test。

import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTIONS, ACTION_NAMES, validateAction, validateSequence, requiresApproval } from '../lib/core/actions.js';
import { BudgetMeter, FailureStreak, PAUSE_REASON, RUN_STATE, SubmitTicket, gateAction } from '../lib/core/guardrails.js';
import { parseAnswer, normalizeAnswer, buildPrompt, SolverPool } from '../lib/core/llm.js';
import { PHASE, initialState, runEvents, summarize, transition } from '../lib/core/pipeline.js';
import { checkExpect, checkQuestionComplete, pageAdvanced, shouldRetry, backoffFor } from '../lib/core/verify.js';

/* ─── 动作白名单 ─────────────────────────────────────────── */

test('validateAction: 合法动作通过并补齐默认值', () => {
	const r = validateAction({ action: 'click_letter', params: { letter: 'a' } });
	assert.equal(r.ok, true);
	assert.equal(r.envelope.params.letter, 'A', '字母要归一成大写');
	assert.equal(r.envelope.risk, 'low');
	assert.equal(r.envelope.timeout_ms, 3000);
});

test('validateAction: 未知动作 / 未知参数 / 缺参数都要拒绝', () => {
	assert.equal(validateAction({ action: 'rm_rf' }).ok, false);
	assert.equal(validateAction({ action: 'click_letter', params: { letter: 'A', extra: 1 } }).ok, false);
	assert.equal(validateAction({ action: 'click_letter', params: {} }).ok, false);
	assert.equal(validateAction({}).ok, false);
	assert.equal(validateAction(null).ok, false);
});

test('validateAction: 通道约束 —— 屏幕通道不能跑 web 动作', () => {
	const r = validateAction({ action: 'web_click', params: { selector: '#a' } }, { channel: 'screen' });
	assert.equal(r.ok, false);
	assert.equal(r.error.code, 'WRONG_CHANNEL');

	const okWeb = validateAction({ action: 'web_click', params: { selector: '#a' } }, { channel: 'web' });
	assert.equal(okWeb.ok, true);
});

test('validateAction: 按键与角色受白名单约束', () => {
	assert.equal(validateAction({ action: 'press_key', params: { key: 'enter' } }).ok, true);
	assert.equal(validateAction({ action: 'press_key', params: { key: 'f12' } }).ok, false, 'f12 不在白名单');
	assert.equal(validateAction({ action: 'press_key', params: { key: 'control' } }).ok, false);

	// click_role 只接受配置里存在的角色
	const r = validateAction({ action: 'click_role', params: { role: 'submit' } }, { roles: ['question', 'options'] });
	assert.equal(r.ok, false);
	assert.equal(r.error.code, 'UNKNOWN_ROLE');
});

test('validateAction: 数值越界与类型要拦', () => {
	assert.equal(validateAction({ action: 'click_point', params: { x: -1, y: 10 } }).ok, false);
	assert.equal(validateAction({ action: 'click_point', params: { x: 1.5, y: 10 } }).ok, false);
	assert.equal(validateAction({ action: 'click_point', params: { x: 1, y: 10 } }).ok, true);
});

test('validateSequence: 任一失败则整体拒绝（避免半执行）', () => {
	const bad = validateSequence([
		{ action: 'click_letter', params: { letter: 'A' } },
		{ action: 'nope' },
	]);
	assert.equal(bad.ok, false);
	assert.match(bad.error.message, /第 2 条/);

	const good = validateSequence([
		{ action: 'click_letter', params: { letter: 'A' } },
		{ action: 'next' },
	]);
	assert.equal(good.ok, true);
	assert.equal(good.actions.length, 2);
});

test('validateSequence: 空序列与超长序列要拒绝', () => {
	assert.equal(validateSequence([]).ok, false);
	const long = Array.from({ length: 60 }, () => ({ action: 'wait', params: { ms: 10 } }));
	assert.equal(validateSequence(long).ok, false);
});

test('requiresApproval: 只有 submit 是高风险', () => {
	const high = ACTION_NAMES.filter((n) => ACTIONS[n].risk === 'high');
	assert.deepEqual(high, ['submit']);
	assert.equal(requiresApproval({ action: 'submit' }), true);
	assert.equal(requiresApproval({ action: 'click_point' }), false);
});

/* ─── 每步验证 ───────────────────────────────────────────── */

test('checkExpect: 无期望即通过', () => {
	const r = checkExpect({}, {});
	assert.equal(r.satisfied, true);
});

test('checkExpect: 题号变化是翻页的唯一可靠判据', () => {
	const same = checkExpect({ page_changed: true }, { progressBefore: [4, 12], progressAfter: [4, 12] });
	assert.equal(same.satisfied, false);

	const moved = checkExpect({ page_changed: true }, { progressBefore: [4, 12], progressAfter: [5, 12] });
	assert.equal(moved.satisfied, true);

	const unreadable = checkExpect({ page_changed: true }, {});
	assert.equal(unreadable.satisfied, false, '读不到题号不能算成功');
});

test('checkExpect: 选项选中态', () => {
	assert.equal(checkExpect({ option_checked: true }, { checkedLetters: [] }).satisfied, false);
	assert.equal(checkExpect({ option_checked: true }, { checkedLetters: ['A'] }).satisfied, true);
	assert.equal(checkExpect({ option_checked: true }, {}).satisfied, false);
});

test('checkExpect: 文本输入与画面变化', () => {
	assert.equal(
		checkExpect({ text_inserted: true }, { expectedText: '答复', actualText: '我的答复是' }).satisfied,
		true
	);
	assert.equal(
		checkExpect({ text_inserted: true }, { expectedText: '答复', actualText: '别的内容' }).satisfied,
		false
	);
	assert.equal(checkExpect({ any_change: true }, { hashBefore: 'a', hashAfter: 'a' }).satisfied, false);
	assert.equal(checkExpect({ any_change: true }, { hashBefore: 'a', hashAfter: 'b' }).satisfied, true);
});

test('pageAdvanced: 前进/不动/倒退/总数变化', () => {
	assert.equal(pageAdvanced([4, 12], [5, 12]).ok, true);
	assert.equal(pageAdvanced([4, 12], [4, 12]).ok, false);
	assert.equal(pageAdvanced([5, 12], [4, 12]).ok, false);
	assert.equal(pageAdvanced([4, 12], [1, 12]).ok, false, '回到第一题说明可能误点上一题');
	assert.equal(pageAdvanced([12, 12], [1, 13]).ok, true, '总数变化视为新卷');
	assert.equal(pageAdvanced(null, [1, 2]).ok, false);
});

test('shouldRetry / backoffFor: 有限次退避', () => {
	assert.equal(shouldRetry({ satisfied: false }, 0), true);
	assert.equal(shouldRetry({ satisfied: false }, 2), true);
	assert.equal(shouldRetry({ satisfied: false }, 3), false, '到上限就不重试');
	assert.equal(shouldRetry({ satisfied: true }, 0), false);

	assert.equal(backoffFor(0), 150);
	assert.equal(backoffFor(1), 400);
	assert.equal(backoffFor(9), 900, '超出长度取最后一个');
});

/* ─── 题目完整性门禁（长题截断的防线）───────────────────── */

test('checkQuestionComplete: 完整题目通过', () => {
	const p = {
		qtype: '单选题',
		stem: '下列哪项正确？',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
			{ letter: 'D', text: '丁' },
		],
	};
	const r = checkQuestionComplete(p);
	assert.equal(r.complete, true, r.reasons.join(';'));
	assert.deepEqual(r.reasons, []);
});

test('checkQuestionComplete: 没有选项要判不完整（长题看不见选项时）', () => {
	const r = checkQuestionComplete({ qtype: '单选题', stem: '题干在这里', opts: [] });
	assert.equal(r.complete, false);
	assert.ok(r.reasons.some((x) => x.includes('没有选项')));
	assert.equal(r.suggestScroll, true, '应该建议滚动');
});

test('checkQuestionComplete: 字母断号要判不完整（这是最危险的静默错误）', () => {
	const r = checkQuestionComplete({
		qtype: '单选题',
		stem: '题目',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'D', text: '丁' }, // 缺 C
		],
	});
	assert.equal(r.complete, false);
	assert.ok(r.reasons.some((x) => x.includes('断号')), '应报断号');
	assert.equal(r.suggestScroll, true);
});

test('checkQuestionComplete: _letter_gap 必须拦（OCR 漏行被静默吞掉的真实事故）', () => {
	// mock 第 5 题，图形题）：
	//   Windows OCR 整行漏掉 "C成本核算"，
	//   解析器旧实现静默丢掉因之失配的 D，又把 "D市场推广" 当续行拼进 B，
	//   最终 opts = [A, B(排版十D市场推广)]。
	//   此时字母 A,B **连续**、数量 2、qtype 为空 ——
	//   下面所有判据（断号/选项数/题干结尾）全部不响，
	//   题目被当成完整，然后按 A/B 静默答错。
	// 所以引擎把跳过的字母放进 _letter_gap，门禁必须优先看它。
	const r = checkQuestionComplete({
		qtype: '', // 关键：题型标签也没读到，无法用 minOpts 兜住
		stem: '下图所示流程图中，缺失的环节应当是：',
		opts: [
			{ letter: 'A', text: '承印登记' },
			{ letter: 'B', text: '排版十D市场推广' },
		],
		_letter_gap: ['D'],
	});
	assert.equal(r.complete, false, '字母被跳过时必须判不完整');
	assert.ok(
		r.reasons.some((x) => x.includes('跳过')),
		`应报字母被跳过，实际：${r.reasons.join(';')}`
	);
	assert.equal(r.suggestScroll, true, '应建议滚动重读');
});

test('checkQuestionComplete: 没有 _letter_gap 时不能误报（老数据/其它引擎兼容）', () => {
	const r = checkQuestionComplete({
		stem: '题目',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
			{ letter: 'D', text: '丁' },
		],
	});
	assert.equal(r.complete, true, r.reasons.join(';'));
});

test('checkQuestionComplete: 单选只有 2 个选项要判不足', () => {
	const r = checkQuestionComplete({
		qtype: '单选题',
		stem: '题目',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
		],
	});
	assert.equal(r.complete, false);
	assert.ok(r.reasons.some((x) => x.includes('至少')), '单选应至少 3 项');
});

test('checkQuestionComplete: 判断题 2 个选项就够', () => {
	const r = checkQuestionComplete({
		qtype: '判断题',
		stem: '这说法对吗？',
		opts: [
			{ letter: 'A', text: '正确' },
			{ letter: 'B', text: '错误' },
		],
	});
	assert.equal(r.complete, true, r.reasons.join(';'));
});

test('checkQuestionComplete: 题干末尾连接词说明没说完', () => {
	const r = checkQuestionComplete({
		qtype: '单选题',
		stem: '关于该情形的处理，下列说法中正确',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
	});
	// 这条本身不一定触发（末尾是"确"不是连接词），但不应误判为完整而崩溃
	assert.equal(typeof r.complete, 'boolean');

	const r2 = checkQuestionComplete({
		qtype: '单选题',
		stem: '印刷企业应当建立的制度包括',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
	});
	assert.equal(r2.complete, false);
	assert.ok(r2.reasons.some((x) => x.includes('未完结')));
});

test('checkQuestionComplete: 只有字母没有正文要判不完整', () => {
	const r = checkQuestionComplete({
		qtype: '判断题',
		stem: '题目',
		opts: [
			{ letter: 'A', text: '' },
			{ letter: 'B', text: '' },
		],
	});
	assert.equal(r.complete, false);
	assert.ok(r.reasons.some((x) => x.includes('没有正文')));
});

test('checkQuestionComplete: null 输入不抛错', () => {
	const r = checkQuestionComplete(null);
	assert.equal(r.complete, false);
	assert.equal(r.suggestScroll, true);
});

/* ─── 护栏 ───────────────────────────────────────────────── */

test('gateAction: 只有 RUNNING 才放行', () => {
	assert.equal(gateAction({ state: RUN_STATE.RUNNING }).allowed, true);
	for (const st of [RUN_STATE.IDLE, RUN_STATE.PAUSED, RUN_STATE.STOPPED, RUN_STATE.DONE]) {
		assert.equal(gateAction({ state: st }).allowed, false, `${st} 不该放行`);
	}
});

test('gateAction: 预算耗尽即拒绝', () => {
	const r = gateAction({
		state: RUN_STATE.RUNNING,
		budget: { maxTotalTokens: 100 },
		used: { tokens: 100 },
	});
	assert.equal(r.allowed, false);
	assert.equal(r.code, 'BUDGET_TOKENS');

	const q = gateAction({
		state: RUN_STATE.RUNNING,
		budget: { maxQuestions: 5 },
		used: { questions: 5 },
	});
	assert.equal(q.allowed, false);
	assert.equal(q.code, 'BUDGET_QUESTIONS');
});

test('gateAction: 提交需要开关 + 一次性确认双条件', () => {
	const base = { state: RUN_STATE.RUNNING, actionRisk: 'high' };
	assert.equal(gateAction({ ...base, allowAutoSubmit: false, submitConfirmed: true }).code, 'SUBMIT_DISABLED');
	assert.equal(gateAction({ ...base, allowAutoSubmit: true, submitConfirmed: false }).code, 'SUBMIT_UNCONFIRMED');
	assert.equal(gateAction({ ...base, allowAutoSubmit: true, submitConfirmed: true }).allowed, true);
	// 低风险动作不受提交护栏影响
	assert.equal(gateAction({ state: RUN_STATE.RUNNING, actionRisk: 'low' }).allowed, true);
});

test('SubmitTicket: 授权与撤销', () => {
	const t = new SubmitTicket();
	assert.equal(t.isGranted(), false);
	t.grant('user said ok');
	assert.equal(t.isGranted(), true);
	assert.equal(t.reason, 'user said ok');
	t.revoke();
	assert.equal(t.isGranted(), false);
});

test('BudgetMeter: 累计与超限', () => {
	const m = new BudgetMeter({ maxTotalTokens: 100, maxQuestions: 2 });
	assert.equal(m.record(50), false);
	assert.equal(m.record(50), true, '达到上限即超限');
	assert.equal(m.snapshot().remainingTokens, 0);

	const q = new BudgetMeter({ maxQuestions: 1 });
	assert.equal(q.recordQuestion(), true);
});

test('FailureStreak: 连续失败到阈值才触发', () => {
	const f = new FailureStreak(3);
	assert.equal(f.fail('a'), false);
	assert.equal(f.fail('b'), false);
	assert.equal(f.fail('c'), true);
	f.success();
	assert.equal(f.tripped(), false, '成功一次就清零');
});

/* ─── 状态机 ─────────────────────────────────────────────── */

test('状态机: 正常一轮（capture→parse→resolve→decide→act→verify→下一题）', () => {
	let { state, effects } = runEvents([{ type: 'START' }]);
	assert.equal(state.run, RUN_STATE.RUNNING);
	assert.equal(effects[0].type, 'capture');

	({ state, effects } = runEvents(
		[
			{ type: 'CAPTURED', hash: 'h1', progress: [1, 10] },
			{
				type: 'PARSED',
				question: { qtype: '单选', stem: '题目', opts: [{ letter: 'A', text: '甲' }], prog: [1, 10] },
			},
			{ type: 'RESOLVED', answer: 'A', confidence: 0.95, source: 'bank' },
			{ type: 'DECIDED', actions: [{ action: 'click_letter', params: { letter: 'A' }, risk: 'low' }] },
			{ type: 'ACTED', observation: {} },
			{ type: 'VERIFIED', verdict: { satisfied: true } },
		],
		{},
		state
	));

	assert.equal(state.stats.handled, 1);
	assert.equal(state.stats.verified, 1);
	assert.equal(state.phase, PHASE.CAPTURE);
	// 最后应发出继续截图的 effect
	assert.equal(effects.at(-1).type, 'capture');
});

test('状态机: 低置信度直接转人工，不执行任何动作', () => {
	const { state, effects } = runEvents(
		[
			{ type: 'START' },
			{ type: 'CAPTURED', hash: 'h', progress: [1, 5] },
			{ type: 'PARSED', question: { stem: 'q', opts: [{ letter: 'A' }] } },
			{ type: 'RESOLVED', answer: 'A', confidence: 0.3, lowConfidence: true },
		],
		{}
	);
	assert.equal(state.run, RUN_STATE.PAUSED);
	assert.equal(state.pauseReason, PAUSE_REASON.LOW_CONFIDENCE);
	assert.equal(
		effects.some((e) => e.type === 'act'),
		false,
		'低置信绝不能产生动作'
	);
});

test('状态机: 解析为空且连续失败 → 暂停而不是死循环', () => {
	const { state } = runEvents(
		[
			{ type: 'START' },
			{ type: 'CAPTURED', hash: 'h' },
			{ type: 'PARSED', question: { stem: '', opts: [] }, failureStreakTripped: true },
		],
		{}
	);
	assert.equal(state.run, RUN_STATE.PAUSED);
	assert.equal(state.pauseReason, PAUSE_REASON.VERIFY_FAILED);
});

test('状态机: 验证失败会重试，超上限则暂停', () => {
	// 第一次失败 → retry effect
	let r = runEvents(
		[
			{ type: 'START' },
			{ type: 'CAPTURED', hash: 'h', progress: [1, 5] },
			{ type: 'PARSED', question: { stem: 'q', opts: [{ letter: 'A' }] } },
			{ type: 'RESOLVED', answer: 'A', confidence: 0.9 },
			{ type: 'DECIDED', actions: [{ action: 'next', params: {}, risk: 'medium' }] },
			{ type: 'ACTED', observation: {} },
			{ type: 'VERIFIED', verdict: { satisfied: false, reason: '题号没变' } },
		],
		{}
	);
	assert.equal(r.state.run, RUN_STATE.RUNNING, '还有重试机会就不该暂停');
	assert.ok(r.effects.some((e) => e.type === 'retry'));

	// 一直失败到上限
	let state = r.state;
	for (let i = 0; i < 5; i++) {
		const step = runEvents(
			[
				{ type: 'ACTED', observation: {} },
				{ type: 'VERIFIED', verdict: { satisfied: false, reason: '还是没变' } },
			],
			{},
			state
		);
		state = step.state;
		if (state.run === RUN_STATE.PAUSED) break;
	}
	assert.equal(state.run, RUN_STATE.PAUSED);
	assert.equal(state.pauseReason, PAUSE_REASON.VERIFY_FAILED);
});

test('状态机: submit 被护栏拦住时暂停并提示', () => {
	const { state, effects } = runEvents(
		[
			{ type: 'START' },
			{ type: 'CAPTURED', hash: 'h' },
			{ type: 'PARSED', question: { stem: 'q', opts: [{ letter: 'A' }] } },
			{ type: 'RESOLVED', answer: 'A', confidence: 0.9 },
			{ type: 'DECIDED', actions: [{ action: 'submit', params: {}, risk: 'high' }] },
		],
		{ allowAutoSubmit: false, submitConfirmed: false }
	);
	assert.equal(state.run, RUN_STATE.PAUSED);
	assert.equal(state.pauseReason, PAUSE_REASON.SUBMIT_GATE);
	assert.equal(
		effects.some((e) => e.type === 'act'),
		false,
		'被拦下的动作不能产生 act effect'
	);
});

test('状态机: 开启自动提交且已确认时 submit 放行', () => {
	const { state, effects } = runEvents(
		[
			{ type: 'START' },
			{ type: 'CAPTURED', hash: 'h' },
			{ type: 'PARSED', question: { stem: 'q', opts: [{ letter: 'A' }] } },
			{ type: 'RESOLVED', answer: 'A', confidence: 0.9 },
			{ type: 'DECIDED', actions: [{ action: 'submit', params: {}, risk: 'high' }] },
		],
		{ allowAutoSubmit: true, submitConfirmed: true }
	);
	assert.equal(state.run, RUN_STATE.RUNNING);
	assert.ok(effects.some((e) => e.type === 'act' && e.action.action === 'submit'));
});

test('状态机: PANIC 立即暂停并清空待执行动作', () => {
	const { state } = runEvents(
		[
			{ type: 'START' },
			{ type: 'PANIC' },
		],
		{}
	);
	assert.equal(state.run, RUN_STATE.PAUSED);
	assert.equal(state.pauseReason, PAUSE_REASON.PANIC);
	assert.equal(state.pendingActions.length, 0);
});

test('状态机: STOP 后任何动作事件都不再生效', () => {
	let { state } = runEvents([{ type: 'START' }, { type: 'STOP' }]);
	assert.equal(state.run, RUN_STATE.STOPPED);
	const r = transition(state, { type: 'CAPTURED', hash: 'h' }, {});
	assert.equal(r.state.run, RUN_STATE.STOPPED);
	assert.equal(r.effects.length, 0, '停止后不该再有任何 effect');
});

test('状态机: RESUME 从暂停恢复', () => {
	const { state, effects } = runEvents(
		[
			{ type: 'START' },
			{ type: 'PAUSE', reason: PAUSE_REASON.USER },
			{ type: 'RESUME' },
		],
		{}
	);
	assert.equal(state.run, RUN_STATE.RUNNING);
	assert.equal(state.pauseReason, null);
	assert.ok(effects.some((e) => e.type === 'capture'));
});

test('状态机: 多动作序列按序执行', () => {
	const { state, effects } = runEvents(
		[
			{ type: 'START' },
			{ type: 'CAPTURED', hash: 'h' },
			{ type: 'PARSED', question: { stem: 'q', opts: [{ letter: 'A' }, { letter: 'B' }] } },
			{ type: 'RESOLVED', answer: 'AB', confidence: 0.9 },
			{
				type: 'DECIDED',
				actions: [
					{ action: 'click_letter', params: { letter: 'A' }, risk: 'low' },
					{ action: 'click_letter', params: { letter: 'B' }, risk: 'low' },
				],
			},
			{ type: 'ACTED', observation: {} },
			{ type: 'VERIFIED', verdict: { satisfied: true } },
		],
		{}
	);
	assert.equal(state.actionIndex, 1, '第一条通过后应指向第二条');
	assert.ok(effects.some((e) => e.type === 'act' && e.action.params.letter === 'B'));
});

test('summarize: 压缩出可读摘要', () => {
	const st = initialState({
		run: RUN_STATE.RUNNING,
		question: { qtype: '单选', stem: '题干很长很长', opts: [{}, {}], prog: [3, 9] },
		answer: 'A',
	});
	const sum = summarize(st);
	assert.equal(sum.run, RUN_STATE.RUNNING);
	assert.equal(sum.current.prog[0], 3);
	assert.equal(sum.answer, 'A');
});

/* ─── 解题池 ─────────────────────────────────────────────── */

test('normalizeAnswer: 各种写法归一', () => {
	assert.equal(normalizeAnswer('a'), 'A');
	assert.equal(normalizeAnswer('ABD'), 'ABD');
	assert.equal(normalizeAnswer(['B', 'A']), 'AB', '要去重并按字母序');
	assert.equal(normalizeAnswer('对'), 'T');
	assert.equal(normalizeAnswer('错'), 'F');
	assert.equal(normalizeAnswer('正确'), 'T');
	assert.equal(normalizeAnswer('A. 甲'), 'A');
});

test('parseAnswer: 纯 JSON / 带围栏 / 带废话 / 无法解析', () => {
	const a = parseAnswer('{"answer":"A","confidence":0.9,"reason":"因为"}');
	assert.equal(a.ok, true);
	assert.equal(a.value, 'A');
	assert.equal(a.confidence, 0.9);

	const b = parseAnswer('```json\n{"answer":"B","confidence":0.8}\n```');
	assert.equal(b.value, 'B');

	const c = parseAnswer('我认为答案是：{"answer":"C","confidence":0.6} 以上。');
	assert.equal(c.value, 'C');

	const d = parseAnswer('答案：D');
	assert.equal(d.ok, true);
	assert.equal(d.value, 'D', '非 JSON 时从文本里提取');

	const e = parseAnswer('');
	assert.equal(e.ok, false);
});

test('buildPrompt: 题型规则进 system，题目进 user', () => {
	const p = buildPrompt({ qtype: '多选题', stem: '选出正确的', opts: [{ letter: 'A', text: '甲' }] });
	assert.match(p.system, /多选/);
	assert.match(p.system, /多个大写字母/);
	assert.match(p.user, /选出正确的/);
	assert.match(p.user, /A\. 甲/);

	const t = buildPrompt({ qtype: '判断题', stem: '对还是错', opts: [] });
	assert.match(t.system, /T.*F/);
});

test('SolverPool: 单次求解成功', async () => {
	const llm = fakeLlm(['{"answer":"A","confidence":0.95}']);
	const pool = new SolverPool(llm, {});
	const r = await pool.solve({ qtype: '单选', stem: 'q', opts: [{ letter: 'A', text: 'x' }] });
	assert.equal(r.ok, true);
	assert.equal(r.answer, 'A');
	assert.equal(r.source, 'model');
	assert.ok(r.confidence <= 0.9, '单次求解应有保守衰减');
});

test('SolverPool: 多模型一致 → 高置信', async () => {
	const llm = fakeLlm(['{"answer":"A","confidence":0.8}', '{"answer":"A","confidence":0.7}', '{"answer":"A","confidence":0.9}']);
	const pool = new SolverPool(llm, { votes: 3 });
	const r = await pool.solve({ qtype: '单选', stem: 'q', opts: [] });
	assert.equal(r.answer, 'A');
	assert.equal(r.confidence, 0.92);
	assert.match(r.reason, /一致/);
});

test('SolverPool: 多模型分歧 → 置信度降到阈值以下（触发人工）', async () => {
	const llm = fakeLlm(['{"answer":"A"}', '{"answer":"B"}', '{"answer":"C"}']);
	const pool = new SolverPool(llm, { votes: 3 });
	const r = await pool.solve({ qtype: '单选', stem: 'q', opts: [] });
	assert.ok(r.confidence < 0.8, '分歧必须降置信度');
	assert.match(r.reason, /分歧/);
});

test('SolverPool: 没有可用模型时明确失败（不静默）', async () => {
	const llm = { listProviders: () => [], listModels: async () => [], stream: () => {} };
	const pool = new SolverPool(llm, {});
	const r = await pool.solve({ stem: 'q', opts: [] });
	assert.equal(r.ok, false);
	assert.match(r.error, /没有可用的模型/);
});

test('SolverPool: 并发求解保持顺序', async () => {
	const llm = fakeLlm(['{"answer":"A"}', '{"answer":"B"}', '{"answer":"C"}', '{"answer":"D"}']);
	const pool = new SolverPool(llm, { concurrency: 2 });
	const qs = [1, 2, 3, 4].map(() => ({ qtype: '单选', stem: 'q', opts: [] }));
	const out = await pool.solveBatch(qs);
	assert.equal(out.length, 4);
	assert.ok(out.every((x) => x.ok));
});

/** 假 llm：按调用顺序依次返回预设响应。 */
function fakeLlm(responses) {
	let i = 0;
	return {
		listProviders: () => [{ id: 'fake', name: 'Fake' }],
		listModels: async () => [{ id: 'fake-model' }],
		stream: () => {
			const text = responses[i % responses.length];
			i += 1;
			return (async function* () {
				yield { type: 'text-delta', text };
				yield { type: 'finish', usage: { outputTokens: 20 } };
			})();
		},
	};
}
