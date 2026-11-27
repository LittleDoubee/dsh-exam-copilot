// 题目预算的时序契约：maxQuestions 是「能答几题」，不是「算到第几题」。
//
//
//   profile.answer.maxQuestions = 1（"只跑一题"的常规用法）
//   跑全自动时：
//     题库命中 → answer=A（算出来了）
//     → gateAction 检查 used.questions(1) >= maxQuestions(1)
//     → 拒绝："题目预算已用尽（1/1）"
//     → pauseReason = error
//
//   也就是说 **maxQuestions=1 时一题都答不了**。
//   根因是 recordQuestion() 在 resolve 阶段就调用 ——
//   把"当前这道题"算进了"已经用掉的额度"，
//   于是这道题自己的动作就被自己的计数拦住了。
//
// 正确语义：
//   maxQuestions = N  →  能完整答完 N 题，第 N+1 题才开始拦。
//   所以计数必须在**本题答完之后**进行（见 runner._verifyCurrent）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BudgetMeter, gateAction } from '../lib/core/guardrails.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('maxQuestions=1 且尚未答完任何题时，动作必须放行', () => {
	// 这是"第 1 题"的状态：预算里 questions 应该是 0
	const budget = new BudgetMeter({ maxQuestions: 1 });
	const gate = gateAction({
		state: 'running',
		allowAutoSubmit: false,
		submitConfirmed: false,
		budget: { maxQuestions: 1, maxTotalTokens: 100000 },
		used: { questions: 0, tokens: 0 },
		actionRisk: 'low',
	});
	assert.equal(gate.allowed, true, `第 1 题就该能答，却被拦：${gate.reason ?? gate.code}`);
});

test('答完 1 题后（questions=1, max=1），第 2 题的动作应被拦', () => {
	const gate = gateAction({
		state: 'running',
		allowAutoSubmit: false,
		submitConfirmed: false,
		budget: { maxQuestions: 1, maxTotalTokens: 100000 },
		used: { questions: 1, tokens: 0 },
		actionRisk: 'low',
	});
	assert.equal(gate.allowed, false);
	assert.equal(gate.code, 'BUDGET_QUESTIONS');
});

test('recordQuestion 累加，而不是覆盖', () => {
	const b = new BudgetMeter({ maxQuestions: 3 });
	assert.equal(b.used.questions, 0);
	b.recordQuestion();
	assert.equal(b.used.questions, 1);
	b.recordQuestion();
	assert.equal(b.used.questions, 2);
	// 尚未到上限
	assert.equal(b.exceeded(), false);
	b.recordQuestion();
	// 到上限后 exceeded 应为 true（用于 done 判定）
	assert.equal(b.exceeded(), true);
});

test('maxQuestions=0 或未设置表示不限，不能误拦', () => {
	const gate = gateAction({
		state: 'running',
		allowAutoSubmit: false,
		submitConfirmed: false,
		budget: { maxQuestions: 0, maxTotalTokens: 100000 },
		used: { questions: 999, tokens: 0 },
		actionRisk: 'low',
	});
	assert.equal(gate.allowed, true, '未设上限时不该被题目预算拦住');
});

test('runner 源码契约：resolve 阶段不得记 question 预算', () => {
	// 这条是"防回归"的静态检查 —— 因为时序 bug 用运行时很难稳定复现
	// （需要恰好 maxQuestions=1 且第一题命中）。
	// 直接检查源码结构：recordQuestion 只能出现在 _verifyCurrent 里。
	const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'core', 'runner.js'), 'utf8');

	const calls = [];
	const lines = src.split('\n');
	lines.forEach((line, i) => {
		if (/this\.budget\.recordQuestion\s*\(/.test(line)) calls.push({ line: i + 1, text: line.trim() });
	});
	assert.ok(calls.length >= 1, '找不到 recordQuestion 调用，代码结构可能已变');

	// 找出 _resolve 方法体的行范围
	const startIdx = lines.findIndex((l) => /async\s+_resolve\s*\(/.test(l));
	assert.ok(startIdx >= 0, '找不到 _resolve 方法');
	let depth = 0;
	let endIdx = startIdx;
	let started = false;
	for (let i = startIdx; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (ch === '{') {
				depth += 1;
				started = true;
			} else if (ch === '}') {
				depth -= 1;
			}
		}
		if (started && depth === 0) {
			endIdx = i;
			break;
		}
	}

	const inResolve = calls.filter((c) => c.line - 1 >= startIdx && c.line - 1 <= endIdx);
	assert.deepEqual(
		inResolve.map((c) => c.line),
		[],
		`recordQuestion 不能出现在 _resolve 里（第 ${inResolve.map((c) => c.line).join(',')} 行）。\n` +
			'否则 maxQuestions=1 时第 1 题刚算出答案就会被自己的计数拦住，一题都答不了。'
	);
});

test('预算达成应表现为正常结束（DONE），而不是 unknown_question', () => {
	// 实测：maxQuestions=1 时第 1 题答完，
	// 循环仍继续抓第 2 题、解析、求解，最后在 gateAction 被拦 →
	// pauseReason 变成 unknown_question，看起来像"失败"，
	// 而实际上第 1 题已完整答对（handled=1/verified=1）。
	// runner 的 _runLoop 现在会在循环开头检查 budget.exceeded() 并 DONE。
	const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'core', 'runner.js'), 'utf8');
	const loopIdx = src.indexOf('async _runLoop()');
	assert.ok(loopIdx >= 0, '找不到 _runLoop');

	// 取 _runLoop 前 40 行看结构
	const head = src.slice(loopIdx, loopIdx + 2000);
	assert.ok(
		/budget\.exceeded\(\)/.test(head),
		'_runLoop 开头缺少预算检查 —— 会导致预算达成后仍多跑一轮，表现为 unknown_question 而非正常结束'
	);
	assert.ok(
		/\{\s*type:\s*'DONE'\s*\}/.test(head),
		'预算达成时应发 DONE 事件（正常结束），而不是让它撞护栏'
	);
});

/* ── 「0 表示不限」的回归─────────────
 * 现象：面板提示「最多处理题数：到数即停。0 表示不限」，用户填 0，
 *       点开始立刻显示「已结束」，一题都不跑。
 * 根因：BudgetMeter.exceeded() 用裸比较，0 >= 0 恒真；
 *       而同语义的 gateAction() 写的是 `if (budget.maxQuestions && ...)`。
 *       两处不一致，且原有单测只覆盖 1/3/500，所以一直是绿的。
 */
test('maxQuestions=0 表示不限：刚启动不能判超限（否则点开始立刻结束）', () => {
	const b = new BudgetMeter({ maxQuestions: 0 });
	assert.equal(b.exceeded(), false, '0 被当成上限 → 一开始就 exceeded → 直接 DONE');
});

test('maxTotalTokens=0 同样表示不限', () => {
	assert.equal(new BudgetMeter({ maxTotalTokens: 0 }).exceeded(), false);
});

test('两个上限都为 0 时也不限（面板允许全填 0）', () => {
	assert.equal(new BudgetMeter({ maxTotalTokens: 0, maxQuestions: 0 }).exceeded(), false);
});

test('maxQuestions=0 时答很多题也不会被判超限', () => {
	const b = new BudgetMeter({ maxQuestions: 0 });
	for (let i = 0; i < 50; i++) b.recordQuestion();
	assert.equal(b.exceeded(), false);
});

test('真实上限仍然生效：3 题上限用满第 3 题才停', () => {
	const b = new BudgetMeter({ maxQuestions: 3 });
	b.recordQuestion();
	b.recordQuestion();
	assert.equal(b.exceeded(), false, '第 2 题时不该停');
	b.recordQuestion();
	assert.equal(b.exceeded(), true, '第 3 题用满后应停');
});

test('maxTokensPerQuestion=0 表示单题不限，不能每题都判超限', () => {
	const b = new BudgetMeter({ maxTokensPerQuestion: 0 });
	assert.equal(b.questionOverBudget(999999), false);
});
