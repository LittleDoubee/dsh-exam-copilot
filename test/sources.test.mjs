// 按来源文件管理题库的单测。
//
//
//   选中题库后列出其来源文件，可逐个删除。
//
// 关键约束：删除某个文件时，**只删这个文件导入的题**，
// 不能误删其他文件导入的、也不能删用户手工补的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BankStore } from '../lib/core/bank-store.js';

function tmpStore() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshec-src-'));
	return { store: new BankStore(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function q(stem, answer = 'A') {
	return {
		qtype: '单选题',
		stem,
		options: [
			{ letter: 'A', text: '甲' },
			{ letter: 'B', text: '乙' },
		],
		answer,
	};
}

const HASH_A = 'aaaa1111aaaa1111aaaa1111aaaa1111';
const HASH_B = 'bbbb2222bbbb2222bbbb2222bbbb2222';

test('listSources：列出文件、题数、时间', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '库' });
		store.appendItemsDedup(meta.id, [q('A1'), q('A2')], { srcHash: HASH_A });
		store.recordSource(meta.id, HASH_A, { name: 'a.docx', size: 100, itemCount: 2 });

		const list = store.listSources(meta.id);
		assert.equal(list.length, 1);
		assert.equal(list[0].hash, HASH_A);
		assert.equal(list[0].name, 'a.docx');
		assert.equal(list[0].itemCount, 2);
		assert.ok(list[0].at, '应有导入时间');
	} finally {
		cleanup();
	}
});

test('removeSource：只删这个文件导入的题', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '库' });
		store.appendItemsDedup(meta.id, [q('A1'), q('A2')], { srcHash: HASH_A });
		store.recordSource(meta.id, HASH_A, { name: 'a.docx', size: 1, itemCount: 2 });
		store.appendItemsDedup(meta.id, [q('B1')], { srcHash: HASH_B });
		store.recordSource(meta.id, HASH_B, { name: 'b.docx', size: 1, itemCount: 1 });

		assert.equal(store.loadItems(meta.id).length, 3);

		const r = store.removeSource(meta.id, HASH_A);
		assert.equal(r.removed, 2, '应删掉 A 的两题');
		assert.equal(r.remaining, 1, 'B 的题要留着');

		const left = store.loadItems(meta.id);
		assert.equal(left.length, 1);
		assert.equal(left[0].stem, 'B1', '留下的必须是 b 文件那题');

		// 来源表里 A 也应被移除
		assert.equal(store.listSources(meta.id).length, 1);
		assert.equal(store.listSources(meta.id)[0].hash, HASH_B);
	} finally {
		cleanup();
	}
});

test('removeSource：不误删没有 srcHash 的题（手工补的）', () => {
	// 关键安全约束：老数据/手补的题没有 srcHash，
	// 按文件删除时**不能**把它们一起干掉。
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '库' });
		store.appendItemsDedup(meta.id, [q('文件里的题')], { srcHash: HASH_A });
		store.recordSource(meta.id, HASH_A, { name: 'a.docx', size: 1, itemCount: 1 });
		// 手工补一条（无 srcHash）
		store.appendItems(meta.id, [q('手工补的题')]);

		const r = store.removeSource(meta.id, HASH_A);
		assert.equal(r.removed, 1, '只删文件里那条');
		const left = store.loadItems(meta.id);
		assert.equal(left.length, 1);
		assert.equal(left[0].stem, '手工补的题', '手工补的不能被删');
	} finally {
		cleanup();
	}
});

test('removeSource：不存在的 hash 不改变任何东西', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '库' });
		store.appendItemsDedup(meta.id, [q('A1')], { srcHash: HASH_A });
		store.recordSource(meta.id, HASH_A, { name: 'a.docx', size: 1, itemCount: 1 });

		const r = store.removeSource(meta.id, 'ffff0000ffff0000ffff0000ffff0000');
		assert.equal(r.removed, 0);
		assert.equal(r.remaining, 1);
		assert.equal(store.loadItems(meta.id).length, 1);
	} finally {
		cleanup();
	}
});

test('recordSource：同文件二次导入累加题数，保留首次时间', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '库' });
		store.recordSource(meta.id, HASH_A, { name: 'a.docx', size: 10, itemCount: 5 });
		const first = store.listSources(meta.id)[0];

		store.recordSource(meta.id, HASH_A, { name: 'a.docx', size: 10, itemCount: 3 });
		const after = store.listSources(meta.id)[0];

		assert.equal(after.itemCount, 8, '题数应累加 5+3');
		assert.equal(after.at, first.at, '首次导入时间要保留');
	} finally {
		cleanup();
	}
});

test('来源记录：跨库隔离', () => {
	const { store, cleanup } = tmpStore();
	try {
		const a = store.create({ name: '库A' });
		const b = store.create({ name: '库B' });
		store.recordSource(a.id, HASH_A, { name: 'x.docx', size: 1, itemCount: 1 });

		assert.equal(store.listSources(a.id).length, 1);
		assert.equal(store.listSources(b.id).length, 0, 'B 不应看到 A 的文件');

		// 删 A 的文件不应影响 B
		store.appendItems(b.id, [q('B的题')]);
		store.removeSource(a.id, HASH_A);
		assert.equal(store.loadItems(b.id).length, 1, 'B 的题不该被动');
	} finally {
		cleanup();
	}
});

test('appendItemsDedup：srcHash 落盘到题上', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '库' });
		store.appendItemsDedup(meta.id, [q('X')], { srcHash: HASH_A });
		const items = store.loadItems(meta.id);
		assert.equal(items[0].srcHash, HASH_A, '题上必须带来源标记，否则无法按文件删');
	} finally {
		cleanup();
	}
});

test('appendItemsDedup：不传 srcHash 时不写这个字段', () => {
	// 粘贴文本导入没有文件指纹，写个空串进去只会让数据变脏。
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '库' });
		store.appendItemsDedup(meta.id, [q('Y')]);
		const items = store.loadItems(meta.id);
		assert.equal(items[0].srcHash, undefined, '不该写空 srcHash');
	} finally {
		cleanup();
	}
});

/* ── 旧数据：按题的 source 字段聚合 ────────────────── */

test('旧数据（无 srcHash 但有 source）也能列出文件', async () => {
	// 场景：题目全来自一个 docx，但旧版导入没有 srcHash，
	// sources.json 为空 → 文件列表空白 → 用户以为功能没做。
	// 题上其实一直有 source 字段（原始文件名），据此聚合即可。
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '旧库' });
		// 模拟旧导入：只有 source，无 srcHash
		store.appendItems(meta.id, [
			{ ...q('旧题1'), source: '补充资料.docx' },
			{ ...q('旧题2'), source: '补充资料.docx' },
			{ ...q('旧题3'), source: '另一批.xlsx' },
		]);

		// 复刻 banks.sources 的聚合逻辑
		const items = store.loadItems(meta.id);
		const bySource = new Map();
		for (const it of items) {
			if (it.srcHash) continue;
			const name = String(it.source || '').trim() || '(未记录来源)';
			bySource.set(name, (bySource.get(name) || 0) + 1);
		}

		assert.equal(bySource.size, 2, '应聚出两个文件');
		assert.equal(bySource.get('补充资料.docx'), 2);
		assert.equal(bySource.get('另一批.xlsx'), 1);
	} finally {
		cleanup();
	}
});

test('removeSource 支持 src: 前缀（按 source 删除旧数据）', async () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '旧库' });
		store.appendItems(meta.id, [
			{ ...q('旧题1'), source: 'a.docx' },
			{ ...q('旧题2'), source: 'a.docx' },
			{ ...q('旧题3'), source: 'b.docx' },
		]);

		const r = store.removeSource(meta.id, 'src:a.docx');
		assert.equal(r.removed, 2, '应只删 a.docx 的两题');
		assert.equal(r.remaining, 1);

		const left = store.loadItems(meta.id);
		assert.equal(left.length, 1);
		assert.equal(left[0].stem, '旧题3', 'b.docx 的题要留着');
	} finally {
		cleanup();
	}
});

test('removeSource 按 src: 删除时不动新数据（有 srcHash 的）', async () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '混合库' });
		store.appendItemsDedup(meta.id, [{ ...q('新题') }], { srcHash: 'HASH_A' });
		store.recordSource(meta.id, 'HASH_A', { name: 'new.docx', size: 1, itemCount: 1 });
		store.appendItems(meta.id, [{ ...q('旧题'), source: 'old.docx' }]);

		const r = store.removeSource(meta.id, 'src:old.docx');
		assert.equal(r.removed, 1, '只删旧的那条');
		const left = store.loadItems(meta.id);
		assert.equal(left.length, 1);
		assert.equal(left[0].stem, '新题', '新数据不能被旧数据删除波及');
	} finally {
		cleanup();
	}
});
