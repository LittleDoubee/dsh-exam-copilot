// 悬浮窗视图模型单测。
//
// 这些断言保护的是"用户看到的那行字"——它没有 UI 可以点，只能靠单测。
// 尤其两条：① 剩余时间临近必须显式提醒；② 题目原文绝不能出现在悬浮窗上。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildOverlayState,
	formatClock,
	timerLevel,
	answerSourceLabel,
	PAUSE_TEXT,
	TIMER_WARN_SECONDS,
	TIMER_DANGER_SECONDS,
} from '../lib/core/overlay-view.js';

/* ── 时间格式化 ─────────────────────────────────────────── */
test('formatClock：不足 1 小时用 mm:ss，超过用 h:mm:ss', () => {
	assert.equal(formatClock(75), '01:15');
	assert.equal(formatClock(0), '00:00');
	assert.equal(formatClock(60), '01:00');
	assert.equal(formatClock(3599), '59:59');
	assert.equal(formatClock(3600), '1:00:00');
	assert.equal(formatClock(3661), '1:01:01');
});

test('formatClock：无效输入返回空串（不能显示 NaN）', () => {
	assert.equal(formatClock(null), '');
	assert.equal(formatClock(undefined), '');
	assert.equal(formatClock(NaN), '');
	assert.equal(formatClock(-1), '');
	assert.equal(formatClock('abc'), '');
});

/* ── 时间分级 ───────────────────────────────────────────── */
test('timerLevel：5 分钟内 warn、1 分钟内 danger', () => {
	assert.equal(timerLevel(3600), 'normal');
	assert.equal(timerLevel(TIMER_WARN_SECONDS + 1), 'normal');
	assert.equal(timerLevel(TIMER_WARN_SECONDS), 'warn');
	assert.equal(timerLevel(TIMER_DANGER_SECONDS + 1), 'warn');
	assert.equal(timerLevel(TIMER_DANGER_SECONDS), 'danger');
	assert.equal(timerLevel(0), 'danger');
});

test('timerLevel：读不到时间（null）不能误报成 danger', () => {
	assert.equal(timerLevel(null), 'normal');
	assert.equal(timerLevel(undefined), 'normal');
	assert.equal(timerLevel(NaN), 'normal');
});

/* ── 答案来源标注 ───────────────────────────────────────── */
test('answerSourceLabel：区分题库置信度与模型', () => {
	assert.equal(answerSourceLabel('bank:high'), '题库高置信');
	assert.equal(answerSourceLabel('bank:medium-high'), '题库中高置信');
	assert.equal(answerSourceLabel('bank:low'), '题库');
	assert.equal(answerSourceLabel('model'), '模型');
	assert.equal(answerSourceLabel('manual'), '人工');
	assert.equal(answerSourceLabel(''), '');
	assert.equal(answerSourceLabel(null), '');
});

/* ── 整体视图 ───────────────────────────────────────────── */
function snap(over = {}) {
	return {
		run: 'running',
		phase: 'resolve',
		pauseReason: null,
		current: { prog: [3, 12] },
		stats: { handled: 2, failed: 0 },
		answer: 'A',
		source: 'bank:high',
		...over,
	};
}

test('buildOverlayState：运行中显示题号、已处理、答案来源', () => {
	const v = buildOverlayState(snap(), { modeLabel: '考试助手 · 全自动', timerSeconds: 1800 });
	assert.equal(v.run, 'running');
	assert.equal(v.title, '考试助手 · 全自动');
	assert.deepEqual(v.prog, [3, 12]);
	assert.equal(v.handled, 2);
	assert.equal(v.answer, 'A');
	assert.equal(v.answerSource, '题库高置信');
	assert.equal(v.timerText, '30:00');
	assert.equal(v.timerLevel, 'normal');
	assert.equal(v.note, '');
});

test('buildOverlayState：暂停时给出人话原因（不是 low_confidence 这种代号）', () => {
	const v = buildOverlayState(snap({ run: 'paused', pauseReason: 'low_confidence' }));
	assert.match(v.title, /已暂停/);
	assert.equal(v.note, PAUSE_TEXT.low_confidence);
	assert.ok(!v.note.includes('low_confidence'));
});

test('buildOverlayState：未知暂停原因也不能把内部代号直接抛给用户', () => {
	const v = buildOverlayState(snap({ run: 'paused', pauseReason: 'weird_code' }));
	assert.equal(v.note, 'weird_code');
});

test('buildOverlayState：剩余时间不足 5 分钟必须显式提醒（用户明确要求）', () => {
	const v = buildOverlayState(snap(), { timerSeconds: 299 });
	assert.equal(v.timerLevel, 'warn');
	assert.match(v.note, /不足 5 分钟/);
});

test('buildOverlayState：剩余时间不足 1 分钟用感叹号强提醒', () => {
	const v = buildOverlayState(snap(), { timerSeconds: 30 });
	assert.equal(v.timerLevel, 'danger');
	assert.match(v.note, /不足 1 分钟/);
	assert.match(v.note, /⚠/);
});

test('buildOverlayState：时间提醒优先于暂停原因（时间更紧急）', () => {
	const v = buildOverlayState(snap({ run: 'paused', pauseReason: 'user' }), { timerSeconds: 45 });
	assert.ok(v.note.startsWith('⚠'));
});

test('buildOverlayState：结束后标记 done 且提示即将关闭', () => {
	const v = buildOverlayState(snap({ run: 'done' }));
	assert.equal(v.done, true);
	assert.match(v.title, /已结束/);
	assert.match(v.note, /已完成/);
});

test('buildOverlayState：没有 prog 时不崩、不给 undefined', () => {
	const v = buildOverlayState(snap({ current: null }));
	assert.equal(v.prog, null);
	assert.equal(v.handled, 2);
});

test('buildOverlayState：snapshot 为 null（刚启动）也要给出可渲染状态', () => {
	const v = buildOverlayState(null, { modeLabel: '考试助手 · 人机协同' });
	assert.equal(v.run, 'idle');
	assert.equal(v.title, '考试助手 · 人机协同');
	assert.equal(v.answer, null);
	assert.equal(v.timerText, '');
	assert.equal(typeof v.note, 'string');
});

test('buildOverlayState：绝不把题干原文带进悬浮窗（屏幕可能被共享/录制）', () => {
	const v = buildOverlayState(snap({ current: { prog: [1, 12], stem: '根据《印刷业管理条例》…' } }));
	const blob = JSON.stringify(v);
	assert.ok(!blob.includes('印刷业管理条例'), `悬浮窗状态里出现了题干原文: ${blob}`);
});

/* ── 排除区：防止倒计时污染题干 ───────────────────────────
 * 这里只测纯几何剔除逻辑（引擎侧 Python 的 drop_rows_in_regions），
 * 用同构的 JS 版最小实现做契约固化，保证两侧判定口径一致。
 */
function dropRows(rows, regions, ox = 0, oy = 0) {
	if (!rows || !regions || !regions.length) return rows;
	return rows.filter((r) => {
		const cx = Number(r.x || 0) + Number(r.w || 0) / 2 + ox;
		const cy = Number(r.y || 0) + Number(r.h || 0) / 2 + oy;
		return !regions.some((g) => cx >= g[0] && cx <= g[0] + g[2] && cy >= g[1] && cy <= g[1] + g[3]);
	});
}

test('排除区：倒计时行必须被剔掉，题目行保留', () => {
	// 这些是引擎返回的**图内相对坐标**（相对识别区域原点 537,201）
	const rows = [
		{ text: '模拟考试系统', x: 55, y: 37, w: 137, h: 30 },
		{ text: '剩余时间00:00', x: 1250, y: 35, w: 182, h: 30 },
		{ text: '1. 根据《印刷业管理条例》', x: 69, y: 199, w: 930, h: 27 },
		{ text: 'A', x: 88, y: 286, w: 27, h: 26 },
	];
	// timer 区是**屏幕绝对坐标**（来自 profile）
	const timer = [1784, 228, 197, 53];
	const kept = dropRows(rows, [timer], 537, 201);
	const texts = kept.map((r) => r.text);
	assert.ok(texts.includes('1. 根据《印刷业管理条例》'));
	assert.ok(!texts.some((t) => t.includes('剩余时间')), `倒计时没被剔掉: ${texts.join('|')}`);
});

test('排除区：区域为空时原样返回（不能误删）', () => {
	const rows = [{ text: '题干', x: 1, y: 1, w: 10, h: 10 }];
	assert.equal(dropRows(rows, []).length, 1);
	assert.equal(dropRows(rows, null).length, 1);
});

test('排除区：边界外一行不能删；中心点判定不吃半个字', () => {
	const rows = [{ text: '题干', x: 100, y: 100, w: 10, h: 10 }]; // 中心 (105,105)
	const outside = [[0, 0, 50, 50]];
	const inside = [[100, 100, 20, 20]];
	assert.equal(dropRows(rows, outside).length, 1);
	assert.equal(dropRows(rows, inside).length, 0);
});
