// 重复入库去重的单测。
//
// 「存在重复入库的问题，如果文件名一样，应该去重」。
//
// 两个层面都要守：
//   ① 同一份文件（内容指纹相同）再导一次 → 直接拒绝，不入库
//   ② 不同文件但题目重合 → 逐题比对库内已有内容，跳过重复的

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { BankStore } from '../lib/core/bank-store.js';

function tmpStore() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshec-dedup-'));
	const store = new BankStore(dir);
	return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function q(stem, answer = 'A', opts = 4) {
	return {
		qtype: '单选题',
		stem,
		options: Array.from({ length: opts }, (_, i) => ({ letter: String.fromCharCode(65 + i), text: '选项' + i })),
		answer,
	};
}

test('appendItemsDedup：同一批题导两次，第二次全部跳过', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '测试库' });
		const items = [q('第一题'), q('第二题'), q('第三题')];

		const r1 = store.appendItemsDedup(meta.id, items);
		assert.equal(r1.added, 3);
		assert.equal(r1.skipped, 0);
		assert.equal(r1.total, 3);

		// 再导一遍同样的题
		const r2 = store.appendItemsDedup(meta.id, items);
		assert.equal(r2.added, 0, '第二次不应新增');
		assert.equal(r2.skipped, 3, '三条都应被识别为重复');
		assert.equal(r2.total, 3, '库内题数不应增长');

		assert.equal(store.loadItems(meta.id).length, 3);
	} finally {
		cleanup();
	}
});

test('appendItemsDedup：部分重复只加新的', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '测试库' });
		store.appendItemsDedup(meta.id, [q('第一题'), q('第二题')]);

		const r = store.appendItemsDedup(meta.id, [q('第二题'), q('第三题')]);
		assert.equal(r.added, 1, '只有「第三题」是新的');
		assert.equal(r.skipped, 1, '「第二题」应跳过');
		assert.equal(r.total, 3);
	} finally {
		cleanup();
	}
});

test('appendItemsDedup：题干同但答案不同 → 保留两条并标「答案冲突」', () => {
	// 同题不同版本是真实存在的，静默覆盖会丢数据。
	// 所以不能简单"题干相同就跳过"，必须看答案。
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '测试库' });
		store.appendItemsDedup(meta.id, [q('某道题', 'A')]);

		const r = store.appendItemsDedup(meta.id, [q('某道题', 'B')]);
		assert.equal(r.added, 1, '答案不同应保留');
		assert.equal(r.conflicts, 1);
		assert.equal(r.skipped, 0);

		const items = store.loadItems(meta.id);
		assert.equal(items.length, 2, '两个版本都在');
		const conflictItem = items.find((it) => it.answer === 'B');
		assert.ok(
			(conflictItem.tags || []).includes('答案冲突'),
			'新加的那条应标 答案冲突，实际 tags=' + JSON.stringify(conflictItem?.tags)
		);
	} finally {
		cleanup();
	}
});

test('appendItemsDedup：题干标点/空白差异算同一题', () => {
	// 归一化题干（去标点、全角转半角）后相同 → 应判为重复。
	// 这是必要的：OCR/不同来源的标点常有差异。
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '测试库' });
		store.appendItemsDedup(meta.id, [q('１．下列哪种颜色？')]);

		const r = store.appendItemsDedup(meta.id, [q('1. 下列哪种颜色')]);
		assert.equal(r.added, 0, '标点/全角差异应视为同一题');
		assert.equal(r.skipped, 1);
	} finally {
		cleanup();
	}
});

test('appendItemsDedup：空输入不改变库', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '测试库' });
		const r = store.appendItemsDedup(meta.id, []);
		assert.equal(r.added, 0);
		assert.equal(r.total, 0);
	} finally {
		cleanup();
	}
});

/* ── 文件指纹 ─────────────────────────────────────── */

function hashOf(content) {
	return crypto.createHash('sha256').update(Buffer.from(content)).digest('hex').slice(0, 32);
}

test('文件指纹：同内容第二次导入能被识别', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '测试库' });
		const content = '题库文件内容';
		const h = hashOf(content);

		assert.equal(store.findSource(meta.id, h), null, '首次导入前应查不到');

		store.recordSource(meta.id, h, { name: '题库.docx', size: content.length });
		const hit = store.findSource(meta.id, h);
		assert.ok(hit, '记录后应能查到');
		assert.equal(hit.name, '题库.docx');
		assert.equal(hit.bankId, meta.id);
		assert.ok(hit.at, '应记录导入时间');
	} finally {
		cleanup();
	}
});

test('文件指纹：不同内容不会误判为已导入', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '测试库' });
		store.recordSource(meta.id, hashOf('版本一'), { name: '题库.docx', size: 3 });

		// 同名文件但内容变了（用户更新了题库）→ 必须允许导入
		assert.equal(store.findSource(meta.id, hashOf('版本二')), null, '内容不同应视为新文件');
	} finally {
		cleanup();
	}
});

test('文件指纹：不同题库互不影响', () => {
	const { store, cleanup } = tmpStore();
	try {
		const a = store.create({ name: '库A' });
		const b = store.create({ name: '库B' });
		const h = hashOf('同一份内容');

		store.recordSource(a.id, h, { name: 'x.docx', size: 5 });
		assert.equal(store.findSource(b.id, h), null, 'A 导过的文件不影响 B');
	} finally {
		cleanup();
	}
});

test('文件指纹：重复记录不覆盖首次时间', () => {
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '测试库' });
		const h = hashOf('内容');
		store.recordSource(meta.id, h, { name: 'a.docx', size: 2 });
		const first = store.findSource(meta.id, h).at;

		// 隔一会再记一次（正常不该发生，但要保证不把"首次导入时间"冲掉）
		store.recordSource(meta.id, h, { name: 'a.docx', size: 2 });
		assert.equal(store.findSource(meta.id, h).at, first, '应保留首次导入时间');
	} finally {
		cleanup();
	}
});

test('count 以实际行数为准，去重场景下不虚高', () => {
	// 旧实现是 meta.count += items.length（累加），
	// 去重后若有跳过，累加就会虚高，面板显示的题数对不上。
	const { store, cleanup } = tmpStore();
	try {
		const meta = store.create({ name: '测试库' });
		store.appendItemsDedup(meta.id, [q('A题'), q('B题')]);
		store.appendItemsDedup(meta.id, [q('A题'), q('B题')]); // 全重复
		store.appendItemsDedup(meta.id, [q('C题')]);

		const m = store.getMeta(meta.id);
		assert.equal(m.count, 3, 'meta.count 应等于实际题数 3');
		assert.equal(store.loadItems(meta.id).length, 3);
	} finally {
		cleanup();
	}
});
