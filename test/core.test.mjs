// 纯逻辑单测：无需宿主、无需 Python。
// 针对 S1 最容易出错的三处：区域校验、存储原子性、hash/merge 语义。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Store, deepMerge, readJson, readJsonl, sanitizeId, writeJson } from '../lib/core/store.js';
import {
	CONTENT_ROLES,
	ROLE_KEYS,
	clampZone,
	emptyProfile,
	validateZones,
	zonesByRole,
} from '../lib/core/zones.js';

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'exam-copilot-'));
}

test('validateZones: 合法区域组通过', () => {
	const zones = [
		{ role: 'question', x: 10, y: 20, w: 300, h: 200 },
		{ role: 'options', x: 10, y: 240, w: 300, h: 180 },
		{ role: 'progress', x: 10, y: 430, w: 80, h: 30 },
	];
	const r = validateZones(zones, { w: 1920, h: 1080 });
	assert.equal(r.ok, true);
	assert.deepEqual(r.errors, []);
});

test('validateZones: 没有任何内容区必须报错（不能静默启动）', () => {
	const r = validateZones([{ role: 'next', x: 0, y: 0, w: 100, h: 100 }], {});
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => e.includes('内容区')), '应指出缺内容区');
});

test('validateZones: all 与 question 都算内容区', () => {
	for (const role of CONTENT_ROLES) {
		const r = validateZones([{ role, x: 0, y: 0, w: 100, h: 100 }], {});
		assert.equal(r.ok, true, `只有 ${role} 也应是合法配置`);
	}
});

test('validateZones: 空数组 / 未知角色 / 非数字都要拦', () => {
	assert.equal(validateZones([], {}).ok, false);
	assert.equal(validateZones([{ role: 'nope', x: 0, y: 0, w: 10, h: 10 }], {}).ok, false);
	const bad = validateZones(
		[
			{ role: 'question', x: 'abc', y: 0, w: 100, h: 100 },
			{ role: 'options', x: 0, y: 0, w: 100, h: 100 },
		],
		{}
	);
	assert.equal(bad.ok, false);
});

test('validateZones: 缺 progress 只警告不拦（有的界面确实没题号）', () => {
	const r = validateZones(
		[
			{ role: 'question', x: 0, y: 0, w: 100, h: 100 },
			{ role: 'options', x: 0, y: 100, w: 100, h: 100 },
		],
		{}
	);
	assert.equal(r.ok, true);
	assert.ok(r.warnings.some((w) => w.includes('progress')));
});

test('zonesByRole: 重复角色先出现的优先', () => {
	const map = zonesByRole([
		{ role: 'question', x: 1, y: 1, w: 10, h: 10 },
		{ role: 'question', x: 99, y: 99, w: 10, h: 10 },
	]);
	assert.equal(map.question.x, 1);
});

test('clampZone: 越界要裁到屏幕内', () => {
	const z = clampZone({ role: 'question', x: 1900, y: 1000, w: 500, h: 500 }, { w: 1920, h: 1080 });
	assert.ok(z.x + z.w <= 1920);
	assert.ok(z.y + z.h <= 1080);
	assert.ok(z.w > 0 && z.h > 0);
});

test('ROLE_KEYS / CONTENT_ROLES 自洽', () => {
	// 每个"内容区"角色都必须是已定义角色，否则校验会永远失败
	for (const r of CONTENT_ROLES) assert.ok(ROLE_KEYS.includes(r), `${r} 必须在 ROLE_KEYS 里`);
	assert.ok(CONTENT_ROLES.includes('all'), '必须支持 all（整块内容区）');
});

test('emptyProfile: 结构完整且 id 正确', () => {
	const p = emptyProfile('t1', '测试配置');
	assert.equal(p.id, 't1');
	assert.equal(p.name, '测试配置');
	assert.ok(Array.isArray(p.zones));
	assert.equal(p.answer.useBank, true);
	// 默认必须偏安全：不自动提交、不联网
	assert.equal(p.answer.webSearch, false);
	assert.equal(p.answer.allowAutoSubmit, false);
});



test('Store: 设置读写与深合并（数组整体替换）', () => {
	const dir = tmpDir();
	const s = new Store(dir);
	const d = s.getSettings();
	assert.equal(d.shots.keepDays, 7);
	assert.equal(d.safety.allowAutoSubmit, false);

	s.saveSettings({ shots: { keepDays: 3, maxTotalMB: 512 } });
	const after = s.getSettings();
	assert.equal(after.shots.keepDays, 3);
	assert.equal(after.shots.maxTotalMB, 512);
	// 未覆盖的字段要保留
	assert.equal(after.safety.allowAutoSubmit, false);
});

test('Store: profile CRUD 与安全 id', () => {
	const dir = tmpDir();
	const s = new Store(dir);
	s.saveProfile(emptyProfile('p1', '一号'));
	assert.equal(s.listProfiles().length, 1);
	assert.equal(s.getProfile('p1').name, '一号');
	assert.equal(s.deleteProfile('p1'), true);
	assert.equal(s.getProfile('p1'), null);
	assert.equal(s.deleteProfile('p1'), false);
});

test('sanitizeId: 阻止路径穿越', () => {
	assert.equal(sanitizeId('../../etc/passwd').includes('/'), false);
	assert.equal(sanitizeId('..'), 'unnamed');
	assert.equal(sanitizeId(''), 'unnamed');
	assert.equal(sanitizeId('中文-配置_1'), '中文-配置_1');
});

test('readJson: 损坏文件回落 fallback 而不是抛', () => {
	const dir = tmpDir();
	const f = path.join(dir, 'bad.json');
	fs.writeFileSync(f, '{ not json');
	assert.equal(readJson(f, { ok: 1 }).ok, 1);
	assert.equal(readJson(path.join(dir, 'missing.json'), null), null);
	// 空文件也要回落
	fs.writeFileSync(f, '   ');
	assert.deepEqual(readJson(f, []), []);
});

test('writeJson: 原子写不留 tmp 残渣', () => {
	const dir = tmpDir();
	const f = path.join(dir, 'a.json');
	writeJson(f, { v: 1 });
	const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
	assert.deepEqual(leftovers, []);
});

test('readJsonl: 跳过损坏行（中断写入会留半行）', () => {
	const dir = tmpDir();
	const f = path.join(dir, 's.jsonl');
	fs.writeFileSync(f, '{"a":1}\n{"b":\n{"c":3}\n');
	const rows = readJsonl(f);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].a, 1);
	assert.equal(rows[1].c, 3);
});

test('readJsonl: limit 取尾部', () => {
	const dir = tmpDir();
	const f = path.join(dir, 's.jsonl');
	fs.writeFileSync(f, [1, 2, 3, 4, 5].map((n) => JSON.stringify({ n })).join('\n'));
	assert.deepEqual(
		readJsonl(f, { limit: 2 }).map((r) => r.n),
		[4, 5]
	);
});

test('deepMerge: 嵌套合并，数组替换而非按索引合并', () => {
	const base = { a: 1, nest: { x: 1, y: 2 }, arr: [1, 2, 3] };
	const patch = { nest: { y: 9 }, arr: [7] };
	const out = deepMerge(base, patch);
	assert.equal(out.a, 1);
	assert.equal(out.nest.x, 1);
	assert.equal(out.nest.y, 9);
	assert.deepEqual(out.arr, [7]);
});
