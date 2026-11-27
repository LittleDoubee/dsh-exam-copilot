// Runner 集成测试：用假引擎 + 假解题池把完整流程跑一遍。
//
// 这是 S2 最重要的测试 —— 它证明"在无人盯着的情况下，错了会停下来"。
// 全部零 IO：假引擎记录每次调用，断言"该点的点了、不该点的一个没点"。

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSequence } from '../lib/core/actions.js';
import { RUN_STATE, PAUSE_REASON } from '../lib/core/guardrails.js';
import { Runner } from '../lib/core/runner.js';

/* ── 假引擎 ─────────────────────────────────────────────
 * 按脚本给出题目序列；记录每次 act 调用，供断言"点了什么"。 */
function fakeEngine({ questions, progressStart = 1, failNext = () => false } = {}) {
	let qIndex = 0;
	let progress = progressStart;
	const calls = { screenshot: 0, ocr: 0, act: [], readProgress: 0, panic: 0, resume: 0, probeColors: 0 };

	const engine = {
		async screenshot() {
			calls.screenshot += 1;
			return { ok: true, hash: `h${calls.screenshot}` };
		},
		async ocr() {
			calls.ocr += 1;
			const q = questions[Math.min(qIndex, questions.length - 1)];
			return { ok: true, ms: 800, engineUsed: 'windows', parsed: q };
		},
		async readProgress() {
			calls.readProgress += 1;
			return { ok: true, progress: [progress, questions.length] };
		},
		async act(envelope) {
			calls.act.push(envelope);
			// 只有"翻页"会推进题号；点选项不会
			const isNext = envelope.action === 'click_point' && envelope.expect?.page_changed;
			if (isNext && !failNext(calls.act.length)) {
				progress += 1;
				qIndex += 1;
			}
			return { ok: true, beforeHash: 'a', afterHash: isNext ? 'b' : 'a', changed: isNext };
		},
		async probeColors(points) {
			calls.probeColors += 1;
			// 前两点报"选中"，模拟点中了选项
			return {
				ok: true,
				points: points.map((p, i) => ({
					label: p.label,
					rgb: i < 2 ? [230, 250, 235] : [255, 255, 255],
				})),
			};
		},
		async panic() {
			calls.panic += 1;
			return { ok: true };
		},
		async resume() {
			calls.resume += 1;
			return { ok: true };
		},
	};
	return { engine, calls, getProgress: () => progress };
}

function fakeSolver(answer = 'A', confidence = 0.95) {
	const calls = { solve: 0 };
	return {
		calls,
		async solve() {
			calls.solve += 1;
			return { ok: true, answer, confidence, source: 'model', totalTokens: 30 };
		},
	};
}

function makeProfile(over = {}) {
	return {
		id: 'p1',
		channel: 'screen',
		zones: [
			{ role: 'question', x: 0, y: 0, w: 400, h: 300 },
			{ role: 'options', x: 0, y: 300, w: 400, h: 200 },
			{ role: 'progress', x: 0, y: 500, w: 100, h: 30 },
			{ role: 'next', x: 340, y: 500, w: 60, h: 30 },
		],
		answer: { useModel: true, confidenceThreshold: 0.8, allowAutoSubmit: false },
		actions: { nextRole: 'next', clickIntervalMs: 10 },
		prompts: {},
		...over,
	};
}

const QUESTION = {
	qtype: '单选',
	stem: '测试题目',
	prog: [1, 3],
	opts: [
		{ letter: 'A', text: '甲', sx: 60, sy: 320 },
		{ letter: 'B', text: '乙', sx: 60, sy: 360 },
		{ letter: 'C', text: '丙', sx: 60, sy: 400 },
	],
};

/** 等运行停下来（暂停/停止/完成），或超时。 */
async function settle(runner, timeoutMs = 4000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const st = runner.state.run;
		if (st === RUN_STATE.PAUSED || st === RUN_STATE.STOPPED || st === RUN_STATE.DONE) return runner.state;
		await new Promise((r) => setTimeout(r, 20));
	}
	return runner.state;
}

/* ── 测试 ─────────────────────────────────────────────── */

test('Runner: 正常答完一题并翻页', async () => {
	// 两道题：第 1 题不是最后一题，才会点下一题
	const { engine, calls } = fakeEngine({ questions: [QUESTION, QUESTION] });
	const runner = new Runner({
		engine,
		solver: fakeSolver('A'),
		profile: makeProfile(),
	});
	await runner.start();

	const st = await settle(runner);
	// 点题应包含点选项 + 翻页
	assert.ok(calls.act.length >= 2, `应至少执行 2 个动作，实际 ${calls.act.length}`);
	assert.ok(calls.act[0].action === 'click_point');
	assert.equal(calls.act[0].params.x, 60);
	assert.equal(calls.act[0].params.y, 320);
	assert.equal(st.stats.handled >= 1, true, '应至少完成一题');
	await runner.stop();
});

// 低置信默认改为「照常作答 + 待复核」；旧的「暂停等人」保留为 lowConfidenceMode='pause'
function pauseProfile() {
	const p = makeProfile();
	p.answer = { ...(p.answer ?? {}), lowConfidenceMode: 'pause' };
	return p;
}

test('Runner: 低置信 + pause 模式：不点任何东西，直接暂停等人', async () => {
	const { engine, calls } = fakeEngine({ questions: [QUESTION] });
	const runner = new Runner({
		engine,
		solver: fakeSolver('A', 0.3), // 低于阈值 0.8
		profile: pauseProfile(),
	});
	await runner.start();
	const st = await settle(runner);

	assert.equal(st.run, RUN_STATE.PAUSED);
	assert.equal(st.pauseReason, PAUSE_REASON.LOW_CONFIDENCE);
	assert.equal(calls.act.length, 0, '低置信必须一个动作都不执行');
	await runner.stop();
});

test('Runner: 翻页验证失败 → 重试后暂停（不会一路错下去）', async () => {
	// 必须给 >= 2 题。
	// 原来只给 1 题时 progress 是 [1,1]，本身就是「最后一页」，
	// 点「下一题」翻不动是**正常**的，不会走「验证失败」分支 ——
	// 那样测的其实是「最后一题如何收尾」，不是「翻页失败如何重试」。
	const { engine, calls } = fakeEngine({
		questions: [QUESTION, { ...QUESTION, prog: [2, 3] }, { ...QUESTION, prog: [3, 3] }],
		// 所有翻页点击都"没生效"（题号不变）
		failNext: () => true,
	});
	const runner = new Runner({
		engine,
		solver: fakeSolver('A'),
		profile: makeProfile(),
	});
	await runner.start();
	const st = await settle(runner, 8000);

	assert.equal(st.run, RUN_STATE.PAUSED);
	assert.equal(st.pauseReason, PAUSE_REASON.VERIFY_FAILED);
	// 有重试：翻页点击被反复尝试，但最终停下
	assert.ok(calls.act.length >= 2, '应至少尝试过重试');
	assert.equal(st.stats.handled, 0, '没真正翻页就不该记成完成');
	await runner.stop();
});

test('Runner: 提交被护栏拦住 → 暂停在提交确认', async () => {
	const { engine, calls } = fakeEngine({ questions: [QUESTION] });
	// 让决策层产出 submit：把答案配置成"最后一题"
	const profile = makeProfile({
		zones: [
			{ role: 'question', x: 0, y: 0, w: 400, h: 300 },
			{ role: 'submit', x: 300, y: 500, w: 80, h: 30 },
		],
		answer: { useModel: true, confidenceThreshold: 0.8, allowAutoSubmit: false },
	});
	const runner = new Runner({ engine, solver: fakeSolver('A'), profile });

	// 直接注入一个 submit 动作，验证护栏（绕过决策层）
	runner.state.pendingActions = [{ action: 'submit', params: {}, risk: 'high', expect: {} }];
	runner.state.actionIndex = 0;
	runner.state.run = RUN_STATE.RUNNING;
	await runner._actCurrent();

	assert.equal(runner.state.run, RUN_STATE.PAUSED);
	assert.equal(runner.state.pauseReason, PAUSE_REASON.SUBMIT_GATE);
	assert.equal(
		calls.act.some((a) => a.action === 'submit'),
		false,
		'被拦下的 submit 绝不能真的执行'
	);
	await runner.stop();
});

test('Runner: 确认提交后放行', async () => {
	const { engine, calls } = fakeEngine({ questions: [QUESTION] });
	const profile = makeProfile({
		answer: { useModel: true, confidenceThreshold: 0.8, allowAutoSubmit: true },
	});
	const runner = new Runner({ engine, solver: fakeSolver('A'), profile });
	runner.confirmSubmit('test');

	runner.state.pendingActions = [{ action: 'submit', params: {}, risk: 'high', expect: {} }];
	runner.state.actionIndex = 0;
	runner.state.run = RUN_STATE.RUNNING;
	await runner._actCurrent();

	assert.ok(
		calls.act.some((a) => a.action === 'submit'),
		'开关 + 确认都满足时应真的执行'
	);
	await runner.stop();
});

test('Runner: stop 后不再产生任何动作', async () => {
	const { engine, calls } = fakeEngine({ questions: [QUESTION] });
	const runner = new Runner({ engine, solver: fakeSolver('A'), profile: makeProfile() });
	await runner.start();
	await runner.stop();
	const after = calls.act.length;
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(calls.act.length, after, 'stop 之后不该再有动作');
	assert.equal(runner.state.run, RUN_STATE.STOPPED);
});

test('Runner: pause 会调用引擎 panic（双保险）', async () => {
	const { engine, calls } = fakeEngine({ questions: [QUESTION] });
	const runner = new Runner({ engine, solver: fakeSolver('A'), profile: makeProfile() });
	await runner.start();
	await runner.pause();
	assert.ok(calls.panic >= 1, '暂停时必须让引擎侧也停');
	await runner.stop();
});

test('Runner: 预算耗尽即停', async () => {
	const { engine } = fakeEngine({ questions: [QUESTION, QUESTION, QUESTION] });
	const profile = makeProfile({
		answer: { useModel: true, confidenceThreshold: 0.8, maxQuestions: 1 },
	});
	const runner = new Runner({ engine, solver: fakeSolver('A'), profile });
	await runner.start();
	const st = await settle(runner, 5000);
	// 预算 1 题：做完一题后应结束
	assert.ok(['done', 'paused', 'stopped'].includes(st.run), `预期停下，实际 ${st.run}`);
	await runner.stop();
});

test('Runner: 决策产物能通过 actions 白名单校验', async () => {
	const profile = makeProfile();
	const runner = new Runner({ engine: fakeEngine({ questions: [QUESTION] }).engine, solver: null, profile });
	const actions = runner._decide(QUESTION, 'A');
	const checked = validateSequence(actions, { channel: 'screen', roles: Object.keys(runner.zoneMap) });
	assert.equal(checked.ok, true, `决策产物必须能过白名单: ${JSON.stringify(checked.error)}`);
});

test('Runner: 判断题 T/F 映射到选项位置', () => {
	const profile = makeProfile();
	const runner = new Runner({ engine: fakeEngine({}).engine, solver: null, profile });
	const q = {
		qtype: '判断题',
		stem: '对错',
		opts: [
			{ letter: 'A', text: '正确', sx: 50, sy: 100 },
			{ letter: 'B', text: '错误', sx: 50, sy: 140 },
		],
	};
	const t = runner._decide(q, 'T');
	const f = runner._decide(q, 'F');
	assert.equal(t[0].params.y, 100, 'T 应点第一个选项');
	assert.equal(f[0].params.y, 140, 'F 应点第二个选项');
});

test('Runner: 文本答案不会被当成选项字母去点（旧实现静默全错）', () => {
	// 回归点：
	//   旧实现是 `String(answer).split('')`，'北京' 会被拆成 '北''京'
	//   两个"字母"，在选项里一个都找不到 → 一次点击都不产生，
	//   而且**没有任何报错**，表现成"跑完了但全是没作答"。
	const runner = new Runner({ engine: fakeEngine({}).engine, solver: null, profile: makeProfile() });
	const q = {
		qtype: '简答题',
		stem: '我国的中央银行是____',
		opts: [],
	};
	const nav = runner._decide(q, '中国人民银行');
	// 不应该产生任何 click_point（没有选项可点）
	assert.ok(
		!nav.some((a) => a.action === 'click_point'),
		'文本答案不该产生选项点击，实际: ' + JSON.stringify(nav)
	);
});

test('Runner: 数字答案同样不会被拆成字母点击', () => {
	const runner = new Runner({ engine: fakeEngine({}).engine, solver: null, profile: makeProfile() });
	const q = { qtype: '填空题', stem: '百元券宽度多少毫米', opts: [] };
	const acts = runner._decide(q, '77');
	assert.ok(!acts.some((a) => a.action === 'click_point'), '数字答案不该产生选项点击');
});

test('Runner: 多选字母答案逐一点选（A、C 这种带分隔符的写法）', () => {
	const runner = new Runner({ engine: fakeEngine({}).engine, solver: null, profile: makeProfile() });
	const q = {
		qtype: '多选题',
		stem: '多选',
		opts: [
			{ letter: 'A', text: '甲', sx: 10, sy: 100 },
			{ letter: 'B', text: '乙', sx: 10, sy: 130 },
			{ letter: 'C', text: '丙', sx: 10, sy: 160 },
			{ letter: 'D', text: '丁', sx: 10, sy: 190 },
		],
	};
	const acts = runner._decide(q, 'AC');
	const ys = acts.filter((a) => a.action === 'click_point').map((a) => a.params.y);
	assert.deepEqual(ys, [100, 160], '应点 A 和 C 两项');
});

test('Runner: 题目不完整时拒绝交给模型作答（长题截断防线）', async () => {
	const { engine, calls } = fakeEngine({ questions: [] });
	const solver = fakeSolver('A');
	const runner = new Runner({ engine, solver, profile: makeProfile() });

	const incomplete = {
		qtype: '单选题',
		stem: '题干',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
		],
		_complete: false,
		_incompleteReasons: ['单选题至少 3 个选项，只有 2 个'],
	};

	const r = await runner._resolve(incomplete);
	assert.equal(r.answer, null, '不完整的题不能给出答案');
	assert.equal(r.source, 'incomplete');
	assert.equal(r.lowConfidence, true, '应触发转人工');
	assert.equal(solver.calls.solve, 0, '绝不能调用模型');
	assert.equal(calls.act.length, 0);
});

test('Runner: 完整题目才交给模型', async () => {
	const { engine } = fakeEngine({ questions: [] });
	const solver = fakeSolver('A');
	const runner = new Runner({ engine, solver, profile: makeProfile() });

	const complete = {
		qtype: '单选题',
		stem: '题干',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
		_complete: true,
	};

	const r = await runner._resolve(complete);
	assert.equal(solver.calls.solve, 1, '完整题目应调用模型');
	assert.equal(r.answer, 'A');
});

test('Runner: paged 模式用 next 按钮 + 题号验证', () => {
	const profile = makeProfile();
	profile.navigation = { mode: 'paged' };
	const runner = new Runner({ engine: fakeEngine({}).engine, solver: null, profile });
	const q = {
		qtype: '单选题',
		stem: '题目',
		opts: [
			{ letter: 'A', text: '甲', sx: 10, sy: 10 },
			{ letter: 'B', text: '乙', sx: 10, sy: 40 },
			{ letter: 'C', text: '丙', sx: 10, sy: 70 },
		],
	};
	const acts = runner._decide(q, 'A');
	const last = acts[acts.length - 1];
	assert.equal(last.action, 'click_role', 'paged 应点 next 按钮');
	assert.deepEqual(last.expect, { page_changed: true }, '必须有题号验证');
});

test('Runner: scroll 模式用滚轮推进（整页多题场景）', () => {
	const profile = makeProfile();
	profile.navigation = { mode: 'scroll', scrollStepPx: 600 };
	const runner = new Runner({ engine: fakeEngine({}).engine, solver: null, profile });
	const q = {
		qtype: '单选题',
		stem: '题目',
		opts: [
			{ letter: 'A', text: '甲', sx: 10, sy: 10 },
			{ letter: 'B', text: '乙', sx: 10, sy: 40 },
			{ letter: 'C', text: '丙', sx: 10, sy: 70 },
		],
	};
	const acts = runner._decide(q, 'A');
	const last = acts[acts.length - 1];
	assert.equal(last.action, 'scroll', 'scroll 模式应滚动而不是点按钮');
	assert.equal(Math.abs(last.params.dy), 600, '应使用配置的滚动步长');
	// scroll 模式下没有题号可验证，降级为画面变化
	assert.deepEqual(last.expect, { any_change: true });
});

test('Runner: 没配 next 按钮时退化为滚动（不会什么都不做就卡住）', () => {
	const profile = makeProfile({ zones: [{ role: 'question', x: 0, y: 0, w: 400, h: 300 }] });
	const runner = new Runner({ engine: fakeEngine({}).engine, solver: null, profile });
	const q = {
		qtype: '单选题',
		stem: '题目',
		opts: [
			{ letter: 'A', text: '甲', sx: 10, sy: 10 },
			{ letter: 'B', text: '乙', sx: 10, sy: 40 },
			{ letter: 'C', text: '丙', sx: 10, sy: 70 },
		],
	};
	const acts = runner._decide(q, 'A');
	assert.ok(acts.length >= 2, '至少有点选项 + 推进两个动作');
	assert.equal(acts[acts.length - 1].action, 'scroll', '没有 next 时应退化滚动');
});

/* ── S3：题库优先 ─────────────────────────────────────── */

test('Runner: 题库高置信命中时不调用模型（省钱省时间）', async () => {
	const { engine } = fakeEngine({ questions: [] });
	const solver = fakeSolver('A');
	const bankMatcher = () => ({
		ok: true,
		answer: 'C',
		confidence: 'high',
		reason: '题干一致 + 选项吻合',
		bankId: 'b1',
	});
	const runner = new Runner({ engine, solver, profile: makeProfile(), bankMatcher });

	const q = {
		qtype: '单选题',
		stem: '题库里有这题',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
		_complete: true,
	};

	const r = await runner._resolve(q);
	assert.equal(r.answer, 'C', '应使用题库答案');
	assert.equal(r.source, 'bank:high');
	assert.equal(solver.calls.solve, 0, '高置信命中绝不该调模型');
	assert.equal(r.lowConfidence, false);
});

test('Runner: 低置信 + review 模式（默认）：照常作答并记入待复核', async () => {
	const { engine } = fakeEngine({ questions: [] });
	const runner = new Runner({ engine, solver: fakeSolver('A', 0.3), profile: makeProfile() });
	const r = await runner._resolve({
		qtype: '单选题',
		stem: '题',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
		],
		_complete: true,
	});
	assert.equal(r.answer, 'A');
	assert.equal(r.lowConfidence, false, 'review 模式不应转人工');
	assert.equal(runner.snapshot().reviews.length, 1, '必须记入待复核');
});

test('Runner: 题库低置信 + pause 模式：转人工（不采用）', async () => {
	const { engine } = fakeEngine({ questions: [] });
	const solver = fakeSolver('A');
	const bankMatcher = () => ({
		ok: true,
		answer: 'B',
		confidence: 'low',
		reason: '题干近似但选项不吻合',
	});
	const runner = new Runner({ engine, solver, profile: pauseProfile(), bankMatcher });

	const r = await runner._resolve({
		qtype: '单选题',
		stem: '题',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
		_complete: true,
	});
	assert.equal(r.lowConfidence, true, '低置信必须转人工');
});

test('Runner: 题库未命中则回落到模型', async () => {
	const { engine } = fakeEngine({ questions: [] });
	const solver = fakeSolver('A');
	const bankMatcher = () => ({ ok: false, reason: '没找到' });
	const runner = new Runner({ engine, solver, profile: makeProfile(), bankMatcher });

	const r = await runner._resolve({
		qtype: '单选题',
		stem: '题库没有这题',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
		_complete: true,
	});
	assert.equal(solver.calls.solve, 1, '题库未命中应回落到模型');
	assert.equal(r.answer, 'A');
	assert.match(r.source, /model/);
});

test('Runner: 题库 matcher 抛异常时不影响主流程', async () => {
	const { engine } = fakeEngine({ questions: [] });
	const solver = fakeSolver('A');
	const bankMatcher = () => {
		throw new Error('题库炸了');
	};
	const runner = new Runner({ engine, solver, profile: makeProfile(), bankMatcher });

	const r = await runner._resolve({
		qtype: '单选题',
		stem: '题',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
		_complete: true,
	});
	// 不该崩，应回落到模型
	assert.equal(r.answer, 'A');
	assert.equal(solver.calls.solve, 1);
});

test('Runner: useBank=false 时跳过题库', async () => {
	const { engine } = fakeEngine({ questions: [] });
	const solver = fakeSolver('A');
	let called = 0;
	const bankMatcher = () => {
		called += 1;
		return { ok: true, answer: 'C', confidence: 'high', reason: '' };
	};
	const profile = makeProfile({ answer: { useModel: true, useBank: false, confidenceThreshold: 0.8 } });
	const runner = new Runner({ engine, solver, profile, bankMatcher });

	const r = await runner._resolve({
		qtype: '单选题',
		stem: '题',
		opts: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
			{ letter: 'C', text: '丙' },
		],
		_complete: true,
	});
	assert.equal(called, 0, 'useBank=false 不该调题库');
	assert.equal(solver.calls.solve, 1);
});

/* ── S4：DOM 补救 ─────────────────────────────── */

test('Runner: OCR 正常时不调用 domReader（不能每题都连浏览器）', async () => {
	let domCalled = 0;
	const { engine } = fakeEngine({});
	const runner = new Runner({
		engine,
		solver: null,
		profile: makeProfile(),
		domReader: async (q) => {
			domCalled++;
			return { stem: 'DOM 题干', options: [{ letter: 'A', text: 'DOM 选项' }] };
		},
	});
	// 一个完整、正常的题目
	const q = {
		stem: '人民币的货币符号是什么？',
		opts: [
			{ letter: 'A', text: '人民币符号是¥' },
			{ letter: 'B', text: '美元符号是$' },
			{ letter: 'C', text: '欧元符号是€' },
			{ letter: 'D', text: '英镑符号是£' },
		],
		_complete: true,
	};
	const merged = await runner._applyDomAssist(q);
	assert.equal(domCalled, 0, 'OCR 正常时不该连浏览器');
	assert.equal(merged, q, '应原样返回');
});

test('Runner: OCR 结果可疑时调用 domReader 并合并', async () => {
	let domCalled = 0;
	const { engine } = fakeEngine({});
	const runner = new Runner({
		engine,
		solver: null,
		profile: makeProfile(),
		domReader: async () => {
			domCalled++;
			return {
				stem: '人民币的货币符号是什么？（DOM 真实文本）',
				options: [
					{ letter: 'A', text: '¥' },
					{ letter: 'B', text: '$' },
				],
			};
		},
	});
	const bad = {
		stem: '人民币的货币符叨是（', // 有误识 + 不完整
		opts: [],
		_complete: false,
	};
	const merged = await runner._applyDomAssist(bad);
	assert.equal(domCalled, 1, '可疑时应调用一次');
	assert.equal(merged._domAssisted, true, '应标记已用 DOM 纠正');
	assert.match(merged.stem, /DOM 真实文本/);
});

test('Runner: domReader 抛异常不影响主流程（补救不能变成故障点）', async () => {
	const { engine } = fakeEngine({});
	const runner = new Runner({
		engine,
		solver: null,
		profile: makeProfile(),
		domReader: async () => {
			throw new Error('浏览器连不上');
		},
	});
	const bad = { stem: '可疑题干内容', opts: [], _complete: false };
	const out = await runner._applyDomAssist(bad);
	assert.equal(out, bad, '异常时应原样返回 OCR 结果');
});

test('Runner: domReader 返回 null 时保持 OCR 结果', async () => {
	const { engine } = fakeEngine({});
	const runner = new Runner({
		engine,
		solver: null,
		profile: makeProfile(),
		domReader: async () => null,
	});
	const bad = { stem: '可疑题干内容', opts: [], _complete: false };
	const out = await runner._applyDomAssist(bad);
	assert.equal(out, bad);
});

test('Runner: 没注入 domReader 时完全不尝试 DOM（桌面场景）', async () => {
	const { engine } = fakeEngine({});
	const runner = new Runner({ engine, solver: null, profile: makeProfile() });
	const bad = { stem: '可疑题干', opts: [], _complete: false };
	const out = await runner._applyDomAssist(bad);
	assert.equal(out, bad, '没有 domReader 就直接返回');
});

test('Runner: channel=web + domAssist=true 时强制纠正（即使 OCR 看着正常）', async () => {
	let called = 0;
	const { engine } = fakeEngine({});
	const profile = makeProfile();
	profile.channel = 'web';
	profile.answer = { ...(profile.answer || {}), domAssist: true };
	const runner = new Runner({
		engine,
		solver: null,
		profile,
		domReader: async () => {
			called++;
			return { stem: '强制纠正后的题干', options: [{ letter: 'A', text: '甲' }] };
		},
	});
	const good = {
		stem: '人民币的货币符号是什么？',
		opts: [
			{ letter: 'A', text: '人民币符号是¥' },
			{ letter: 'B', text: '美元符号是$' },
		],
		_complete: true,
	};
	const out = await runner._applyDomAssist(good);
	assert.equal(called, 1, '强制模式应调用');
	assert.equal(out._domAssisted, true);
});


/* ── 「点开始立刻已结束」的回归─────
 * 用户按面板提示把「最多处理题数」填 0（0 表示不限），
 * 结果点开始立刻显示「已结束」，一题都不跑。
 *
 * 注意：本题组要 >= 2 题。只给 1 题时题号会是 [1,1]，
 * reachedLast 判定成立、正常 DONE —— 那是另一回事，会掩盖本 bug。
 */
test('Runner: maxQuestions=0（不限）时不能开局就结束', async () => {
	const q2 = { ...QUESTION, prog: [1, 2] };
	const { engine, calls } = fakeEngine({ questions: [QUESTION, q2] });
	const runner = new Runner({
		engine,
		solver: fakeSolver('A'),
		profile: makeProfile({ answer: { useModel: true, confidenceThreshold: 0.8, maxQuestions: 0 } }),
	});
	await runner.start();
	const st = await settle(runner);

	assert.ok(calls.ocr >= 1, `maxQuestions=0 被当成上限，开局即结束（ocr 调用 ${calls.ocr} 次）`);
	await runner.stop();
});

test('Runner: maxTotalTokens=0（不限）时不能开局就结束', async () => {
	const q2 = { ...QUESTION, prog: [1, 2] };
	const fe = fakeEngine({ questions: [QUESTION, q2] });
	const runner = new Runner({
		engine: fe.engine,
		solver: fakeSolver('A'),
		profile: makeProfile({ answer: { useModel: true, maxTotalTokens: 0 } }),
	});
	await runner.start();
	const st = await settle(runner);
	assert.ok(fe.calls.ocr >= 1, 'maxTotalTokens=0 被当成上限，开局即结束');
	await runner.stop();
});

/* ── 多选导致「点两题就结束」的回归────────────
 * 现场：跑第 1~2 题后整场结束。示例第 2 题答案是 'ABD'（3 个字母）。
 *
 * 根因：_trackStuckRepeats() 每验证**一个动作**就累加一次。
 *   多选题 = 点 3 个选项 + 点下一题 = 4 个动作，
 *   于是同一道题的 4 个动作被当成「同一道题连续读了 4 次」，
 *   `_stuckRepeats >= 3` 成立 → done=true → 整场结束。
 *   单选题只有 2 个动作，所以第 1 题能过、第 2 题（多选）就挂。
 */
test('Runner: 多选题（3 个答案 → 4 个动作）不能因"卡住"提前结束', async () => {
	const N = 4;
	const mkQ = (i) => ({
		qtype: '多选',
		stem: `多选题${i}`,
		prog: [i, N],
		opts: [0, 1, 2, 3].map((k) => ({
			letter: String.fromCharCode(65 + k),
			text: `选项${k}`,
			sx: 600,
			sy: 500 + k * 45,
		})),
	});
	let idx = 1;
	const engine = {
		async screenshot() {
			return { ok: true, hash: 'h' + Math.random() };
		},
		async ocr() {
			return { ok: true, parsed: mkQ(idx), ms: 1, engineUsed: 'windows' };
		},
		async readProgress() {
			return { ok: true, progress: [idx, N] };
		},
		async act(env) {
			if (env.expect?.page_changed && idx < N) idx += 1;
			return { ok: true, changed: true, beforeHash: 'a', afterHash: 'b' };
		},
		async probeColors(p) {
			return { ok: true, points: p.map((x) => ({ label: x.label, rgb: [226, 248, 234] })) };
		},
		async panic() {
			return { ok: true };
		},
		async resume() {
			return { ok: true };
		},
	};
	const runner = new Runner({
		engine,
		solver: { async solve() { return { ok: true, answer: 'ABC', confidence: 0.95, source: 'model', totalTokens: 5 }; } },
		profile: {
			id: 'p',
			channel: 'screen',
			zones: [
				{ role: 'question', x: 0, y: 0, w: 400, h: 300 },
				{ role: 'progress', x: 0, y: 500, w: 100, h: 30 },
				{ role: 'next', x: 340, y: 500, w: 60, h: 30 },
			],
			answer: { useModel: true, confidenceThreshold: 0.8 },
			actions: { nextRole: 'next', clickIntervalMs: 2 },
			navigation: { mode: 'paged' },
			prompts: {},
		},
	});
	await runner.start();
	const st = await settle(runner, 10000);
	assert.equal(
		st.stats.handled,
		N,
		`多选题应在 ${N} 题全部答完，实际只答了 ${st.stats.handled}（stuckRepeats=${runner._stuckRepeats}）`
	);
	await runner.stop();
});

/* ── 最后一题不能被跳过────────────────────────
 * 原判据用 progressAfter：从第 N-1 题点「下一题」后页面就停在 N/N，
 * 于是这一动被判「到顶」，第 N 题从来没被作答。
 */
test('Runner: 最后一题必须真的作答，不能在进入它之前就结束', async () => {
	const N = 3;
	const mkQ = (i) => ({
		qtype: '单选',
		stem: `第${i}题`,
		prog: [i, N],
		opts: [
			{ letter: 'A', text: '甲', sx: 600, sy: 500 },
			{ letter: 'B', text: '乙', sx: 600, sy: 545 },
			{ letter: 'C', text: '丙', sx: 600, sy: 590 },
		],
	});
	let idx = 1;
	const ocrProgs = [];
	const engine = {
		async screenshot() {
			return { ok: true, hash: 'h' + Math.random() };
		},
		async ocr() {
			ocrProgs.push(idx);
			return { ok: true, parsed: mkQ(idx), ms: 1, engineUsed: 'windows' };
		},
		async readProgress() {
			return { ok: true, progress: [idx, N] };
		},
		async act(env) {
			if (env.expect?.page_changed && idx < N) idx += 1;
			return { ok: true, changed: true, beforeHash: 'a', afterHash: 'b' };
		},
		async probeColors(p) {
			return { ok: true, points: p.map((x) => ({ label: x.label, rgb: [226, 248, 234] })) };
		},
		async panic() {
			return { ok: true };
		},
		async resume() {
			return { ok: true };
		},
	};
	const runner = new Runner({
		engine,
		solver: { async solve() { return { ok: true, answer: 'A', confidence: 0.95, source: 'model', totalTokens: 5 }; } },
		profile: {
			id: 'p',
			channel: 'screen',
			zones: [
				{ role: 'question', x: 0, y: 0, w: 400, h: 300 },
				{ role: 'progress', x: 0, y: 500, w: 100, h: 30 },
				{ role: 'next', x: 340, y: 500, w: 60, h: 30 },
			],
			answer: { useModel: true, confidenceThreshold: 0.8 },
			actions: { nextRole: 'next', clickIntervalMs: 2 },
			navigation: { mode: 'paged' },
			prompts: {},
		},
	});
	await runner.start();
	const st = await settle(runner, 10000);
	assert.ok(ocrProgs.includes(N), `最后一题（第 ${N} 题）从未被识别，实际识别过: ${ocrProgs.join(',')}`);
	assert.equal(st.stats.handled, N, `应完成 ${N} 题，实际 ${st.stats.handled}`);
	assert.notEqual(st.pauseReason, 'verify_failed', '最后一题不应因「翻页验证失败」报错停下');
	await runner.stop();
});
