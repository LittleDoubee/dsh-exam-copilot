// 窗口相对坐标、老配置迁移、自动/手动区域合并的单测。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ZONE_SOURCES,
	fromRelative,
	mergeDetectedZones,
	migrateZones,
	resolveZones,
	toRelative,
} from '../lib/core/zones.js';

const WIN = { x: 100, y: 50, w: 1000, h: 800 };

test('toRelative / fromRelative 往返一致', () => {
	const z = { x: 300, y: 250, w: 500, h: 200 };
	const rel = toRelative(z, WIN);
	assert.deepEqual(rel, { rx: 0.2, ry: 0.25, rw: 0.5, rh: 0.25 });
	assert.deepEqual(fromRelative(rel, WIN), z);
});

test('toRelative: 窗口尺寸无效返回 null', () => {
	assert.equal(toRelative({ x: 0, y: 0, w: 1, h: 1 }, { w: 0, h: 0 }), null);
	assert.equal(toRelative({ x: 0, y: 0, w: 1, h: 1 }, null), null);
});

test('resolveZones: 窗口移动并缩放后按比例重新定位', () => {
	const zones = [{ role: 'question', x: 300, y: 250, w: 500, h: 200, rel: toRelative({ x: 300, y: 250, w: 500, h: 200 }, WIN) }];
	const moved = resolveZones(zones, { x: 0, y: 0, w: 2000, h: 1600 });
	assert.deepEqual([moved[0].x, moved[0].y, moved[0].w, moved[0].h], [400, 400, 1000, 400]);
});

test('resolveZones: 没有 rel 或没有窗口时保持旧坐标', () => {
	const zones = [{ role: 'question', x: 1, y: 2, w: 3, h: 4 }];
	assert.deepEqual(resolveZones(zones, WIN), zones);
	const withRel = [{ ...zones[0], rel: { rx: 0.5, ry: 0.5, rw: 0.1, rh: 0.1 } }];
	assert.equal(resolveZones(withRel, null)[0].x, 1);
});

test('migrateZones: 补 source=legacy 与 rel，且幂等、不改入参', () => {
	const src = [{ role: 'options', x: 300, y: 250, w: 500, h: 200 }];
	const once = migrateZones(src, WIN);
	assert.equal(once[0].source, 'legacy');
	assert.ok(once[0].rel);
	assert.equal(src[0].source, undefined, '入参不能被修改');
	assert.deepEqual(migrateZones(once, { x: 0, y: 0, w: 10, h: 10 }), once, '已有 rel 不重算');
	assert.equal(migrateZones(src)[0].rel, undefined, '无窗口时不生成 rel');
});

test('mergeDetectedZones: 手动区域不会被自动结果覆盖', () => {
	const merged = mergeDetectedZones(
		[{ role: 'question', x: 1, y: 1, w: 10, h: 10 }],
		[
			{ role: 'question', x: 9, y: 9, w: 10, h: 10, conf: 0.99 },
			{ role: 'options', x: 5, y: 5, w: 10, h: 10, conf: 0.7 },
		]
	);
	assert.equal(merged.length, 2);
	assert.equal(merged.find((z) => z.role === 'question').x, 1);
	assert.equal(merged.find((z) => z.role === 'options').source, 'auto');
});

test('mergeDetectedZones: 同为自动来源时取 conf 高者；template 优先于 auto', () => {
	const merged = mergeDetectedZones(
		[{ role: 'options', source: 'auto', x: 0, y: 0, w: 1, h: 1, conf: 0.5 }],
		[{ role: 'options', x: 7, y: 0, w: 1, h: 1, conf: 0.9 }]
	);
	assert.equal(merged[0].x, 7);
	const t = mergeDetectedZones(
		[{ role: 'progress', source: 'template', x: 3, y: 0, w: 1, h: 1 }],
		[{ role: 'progress', x: 8, y: 0, w: 1, h: 1, conf: 1 }]
	);
	assert.equal(t[0].x, 3);
	assert.deepEqual(ZONE_SOURCES, ['manual', 'template', 'auto', 'legacy']);
});
