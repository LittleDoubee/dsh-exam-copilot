// 安全闸门：坐标越界。
//
// 实测
//   `validateAction({action:'click_point', params:{x:999999, y:999999}})`
//   **被放行了**。因为 click_point 的 x/y 只声明了 `min: 0`，没有上限。
//
// 为什么危险：坐标来源是 OCR 与模型，两者都可能给出离谱值。
// 点到一个屏幕外的坐标，行为取决于系统（可能落到副屏、也可能被夹到边缘乱点），
// 而这类动作是不可撤销的 —— 必须在校验层挡住，而不是依赖引擎兜底。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAction, validateSequence } from '../lib/core/actions.js';

const SCREEN = { w: 2560, h: 1600 };

test('click_point：坐标超出屏幕必须拒绝', () => {
	const r = validateAction(
		{ action: 'click_point', params: { x: 999999, y: 999999 } },
		{ channel: 'screen', roles: [], screen: SCREEN }
	);
	assert.equal(r.ok, false, '离谱坐标被放行了 —— 这是不可撤销动作，必须在白名单层挡住');
	assert.equal(r.error.code, 'OUT_OF_SCREEN');
});

test('click_point：只超一个方向也要拒绝', () => {
	const rx = validateAction(
		{ action: 'click_point', params: { x: 3000, y: 100 } },
		{ channel: 'screen', roles: [], screen: SCREEN }
	);
	assert.equal(rx.ok, false);
	assert.equal(rx.error.code, 'OUT_OF_SCREEN');

	const ry = validateAction(
		{ action: 'click_point', params: { x: 100, y: 5000 } },
		{ channel: 'screen', roles: [], screen: SCREEN }
	);
	assert.equal(ry.ok, false);
	assert.equal(ry.error.code, 'OUT_OF_SCREEN');
});

test('click_point：屏幕内的坐标必须放行', () => {
	const r = validateAction(
		{ action: 'click_point', params: { x: 1000, y: 800 } },
		{ channel: 'screen', roles: [], screen: SCREEN }
	);
	assert.equal(r.ok, true, `合法坐标被拦了：${r.error?.code}`);
});

test('click_point：边界值（正好等于屏幕宽高）应放行', () => {
	const r = validateAction(
		{ action: 'click_point', params: { x: SCREEN.w, y: SCREEN.h } },
		{ channel: 'screen', roles: [], screen: SCREEN }
	);
	assert.equal(r.ok, true, '恰好落在右下角边界的点击是合法的');
});

test('拿不到 screen 时不拦（避免误伤老调用方）', () => {
	const r = validateAction(
		{ action: 'click_point', params: { x: 999999, y: 999999 } },
		{ channel: 'screen', roles: [] }
	);
	assert.equal(
		r.ok,
		true,
		'没有屏幕尺寸信息时跳过越界检查 —— 这是刻意的降级：' + '宁可少拦，也不要让所有老调用方突然全部失败'
	);
});

test('validateSequence 也要传递 screen（否则整批动作都绕过越界检查）', () => {
	const r = validateSequence([{ action: 'click_point', params: { x: 999999, y: 999999 } }], {
		channel: 'screen',
		roles: [],
		screen: SCREEN,
	});
	assert.equal(r.ok, false, 'validateSequence 没把 screen 传给 validateAction');
	assert.equal(r.error.code, 'OUT_OF_SCREEN');
});

test('其它动作不受坐标检查影响', () => {
	const r = validateAction({ action: 'wait', params: { ms: 100 } }, { channel: 'screen', roles: [], screen: SCREEN });
	assert.equal(r.ok, true, 'wait 与坐标无关，不该被误拦');
});
