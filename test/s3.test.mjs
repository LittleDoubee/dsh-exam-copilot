// S3 题库核心测试：匹配算法 / 存储 / 导入切分。
//
// 重点关注"会给出自信错误答案"的路径 —— 这是实测踩过的坑区：
//   第 12 题：题干相同但选项/答案相反
//   第 18 题：选项相似度 0.93 但面额不同（10元 vs 20元）

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
	AUTO_ACCEPT,
	BankIndex,
	CONFIDENCE,
	checkEntities,
	extractEntities,
	jaccard,
	matchQuestion,
	normalizeAnswer,
	normalizeStem,
	optionsSimilarity,
} from '../lib/core/bank.js';
import { BankStore, dedupe, normalizeItem } from '../lib/core/bank-store.js';
import { dispatch, inferQtype, isSupported, parseCsv, splitTextIntoItems } from '../lib/core/importer.js';

function tmp() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'bank-test-'));
}

/* ── 归一化 ───────────────────────────────────────────── */

test('normalizeStem: 去题号/标点/全角，压空白', () => {
	const a = normalizeStem('1. 《中国人民银行法》中，人民币的单位是（）？');
	const b = normalizeStem('《中国人民银行法》中 人民币的单位是');
	assert.equal(a, b, `应归一化成同一串，实际:\n${a}\n${b}`);
});

test('normalizeAnswer: 各种答案写法', () => {
	assert.equal(normalizeAnswer('C'), 'C');
	assert.equal(normalizeAnswer('c'), 'C');
	assert.equal(normalizeAnswer('ABD'), 'ABD');
	assert.equal(normalizeAnswer(['B', 'A']), 'AB');
	assert.equal(normalizeAnswer('对'), 'T');
	assert.equal(normalizeAnswer('错误'), 'F');
	assert.equal(normalizeAnswer(''), '');
});

test('jaccard: 相似度基本性质', () => {
	assert.equal(jaccard('abc', 'abc'), 1);
	assert.equal(jaccard('abc', 'xyz'), 0);
	assert.ok(jaccard('人民币的单位是元', '人民币的单位是角') > 0.5);
});

/* ── 关键实体（实测第 18 题的防线）───────────────────── */

test('extractEntities: 抽出面额/年份/数量/百分比', () => {
	const e = extractEntities('2019年版10元纸币，5张，含50%的纤维');
	assert.deepEqual([...e.金额], ['10']);
	assert.deepEqual([...e.年份], ['2019']);
	assert.deepEqual([...e.数量], ['5']);
	assert.deepEqual([...e.百分比], ['50']);
});

test('checkEntities: 面额不同必须判冲突（第 18 题场景）', () => {
	const a = '20元和5元的无色荧光特征是什么？';
	const b = '10元和1元的无色荧光特征是什么？';
	const r = checkEntities(a, b);
	assert.equal(r.ok, false, '面额不同必须冲突');
	assert.ok(r.conflicts.some((c) => c.type === '金额'));
});

test('checkEntities: 同类实体一致时不冲突', () => {
	const r = checkEntities('2019年版100元纸币', '2019年版100元纸币的防伪特征');
	assert.equal(r.ok, true);
});

/* ── 选项比对（实测第 12 题的防线）───────────────────── */

test('optionsSimilarity: 数量一致 + 文字一致 → 高', () => {
	const sim = optionsSimilarity(
		[{ letter: 'A', text: '甲方案' }, { letter: 'B', text: '乙方案' }],
		[{ letter: 'A', text: '甲方案' }, { letter: 'B', text: '乙方案' }]
	);
	assert.ok(sim > 0.9, `实际 ${sim}`);
});

test('optionsSimilarity: 数量不一致要扣分', () => {
	const four = [
		{ letter: 'A', text: '甲' },
		{ letter: 'B', text: '乙' },
		{ letter: 'C', text: '丙' },
		{ letter: 'D', text: '丁' },
	];
	const sim = optionsSimilarity(four, four.slice(0, 2));
	assert.ok(sim < 0.7, `少两个选项应明显降分，实际 ${sim}`);
});

/* ── 匹配主入口 ───────────────────────────────────────── */

const BANK = [
	{
		qtype: '单选题',
		stem: '《中国人民银行法》规定，人民币的单位是什么？',
		options: [
			{ letter: 'A', text: '元' },
			{ letter: 'B', text: '角' },
			{ letter: 'C', text: '分' },
			{ letter: 'D', text: '厘' },
		],
		answer: 'A',
	},
	{
		qtype: '多选题',
		stem: '下列属于人民币防伪特征的有？',
		options: [
			{ letter: 'A', text: '水印' },
			{ letter: 'B', text: '安全线' },
			{ letter: 'C', text: '光变油墨' },
			{ letter: 'D', text: '普通胶印' },
		],
		answer: 'ABC',
	},
	{
		qtype: '判断题',
		stem: '人民币是我国法定货币。',
		options: [
			{ letter: 'A', text: '正确' },
			{ letter: 'B', text: '错误' },
		],
		answer: 'T',
	},
];

test('matchQuestion: 完全一致的题给高置信', () => {
	const q = {
		qtype: '单选题',
		stem: '《中国人民银行法》规定，人民币的单位是什么？',
		opts: BANK[0].options,
	};
	const r = matchQuestion(q, BANK);
	assert.equal(r.ok, true);
	assert.equal(r.confidence, CONFIDENCE.HIGH);
	assert.equal(r.answer, 'A');
	assert.ok(AUTO_ACCEPT.has(r.confidence));
});

test('matchQuestion: 题干一致但选项相反 → 中置信（第 12 题场景）', () => {
	const q = {
		qtype: '单选题',
		stem: '《中国人民银行法》规定，人民币的单位是什么？',
		// 选项完全换了
		opts: [
			{ letter: 'A', text: '美元' },
			{ letter: 'B', text: '欧元' },
			{ letter: 'C', text: '日元' },
			{ letter: 'D', text: '英镑' },
		],
	};
	const r = matchQuestion(q, BANK);
	assert.equal(r.ok, true);
	assert.equal(r.confidence, CONFIDENCE.MEDIUM, '题干对但选项全不同，必须降级');
	assert.equal(AUTO_ACCEPT.has(r.confidence), false, '中置信不能自动采用');
});

test('matchQuestion: 题干面额不同 → 不匹配（第 18 题场景）', () => {
	const bank = [
		{
			qtype: '单选题',
			stem: '20元和5元的无色荧光特征是什么？',
			options: [
				{ letter: 'A', text: '甲' },
				{ letter: 'B', text: '乙' },
				{ letter: 'C', text: '丙' },
			],
			answer: 'BC',
		},
	];
	const q = {
		qtype: '单选题',
		stem: '10元和1元的无色荧光特征是什么？',
		opts: bank[0].options,
	};
	const r = matchQuestion(q, bank);
	assert.equal(r.ok, false, '面额不同绝不能让实体校验通过');
});

test('matchQuestion: 题型硬约束 —— 单选不会匹配到多选条目', () => {
	const q = {
		qtype: '单选题',
		stem: '下列属于人民币防伪特征的有？',
		opts: BANK[1].options,
	};
	const r = matchQuestion(q, BANK);
	// 不该返回多选条目（ABC）
	if (r.ok) {
		assert.notEqual(r.answer, 'ABC', '单选不能拿到多选答案');
	}
});

test('matchQuestion: 不相似的题返回未命中', () => {
	const r = matchQuestion({ qtype: '单选题', stem: '今天天气怎么样？', opts: [] }, BANK);
	assert.equal(r.ok, false);
});

test('matchQuestion: 空题库/空题不崩', () => {
	assert.equal(matchQuestion(null, BANK).ok, false);
	assert.equal(matchQuestion({ stem: 'x' }, []).ok, false);
	assert.equal(matchQuestion({ stem: '' }, BANK).ok, false);
});

test('BankIndex: 按长度分桶仍能找到正确答案', () => {
	const idx = new BankIndex(BANK);
	assert.equal(idx.size, 3);
	const stemNorm = normalizeStem('《中国人民银行法》规定，人民币的单位是什么？');
	const cands = idx.candidates(stemNorm);
	assert.ok(cands.length > 0, '应能取到候选');
	// 用候选跑匹配，结果应与全表一致
	const r = matchQuestion(
		{ qtype: '单选题', stem: '《中国人民银行法》规定，人民币的单位是什么？', opts: BANK[0].options },
		cands
	);
	assert.equal(r.answer, 'A');
});

/* ── 存储 ─────────────────────────────────────────────── */

test('BankStore: 创建/追加/读取/删除', () => {
	const dir = tmp();
	const s = new BankStore(dir);

	const meta = s.create({ id: 'b1', name: '货金题库', category: '金融' });
	assert.equal(meta.name, '货金题库');
	assert.equal(meta.count, 0);

	s.appendItems('b1', [{ stem: '题1', answer: 'A' }, { stem: '题2', answer: 'B' }]);
	assert.equal(s.getMeta('b1').count, 2);

	const items = s.loadItems('b1');
	assert.equal(items.length, 2);
	assert.equal(items[0].stem, '题1');

	assert.equal(s.list().length, 1);
	assert.equal(s.delete('b1'), true);
	assert.equal(s.list().length, 0);
});

test('BankStore: 追加不重写已有内容（题量大时的关键）', () => {
	const dir = tmp();
	const s = new BankStore(dir);
	s.create({ id: 'b2', name: 'x' });
	s.appendItems('b2', [{ stem: 'A' }]);
	const before = fs.readFileSync(s.itemsFile('b2'), 'utf8');
	s.appendItems('b2', [{ stem: 'B' }]);
	const after = fs.readFileSync(s.itemsFile('b2'), 'utf8');
	assert.ok(after.startsWith(before), '追加不应破坏已有内容');
	assert.equal(s.getMeta('b2').count, 2);
});

test('BankStore: 命中统计累加', () => {
	const dir = tmp();
	const s = new BankStore(dir);
	s.create({ id: 'b3', name: 'x' });
	s.recordHit('b3', 'high');
	s.recordHit('b3', 'low');
	const m = s.getMeta('b3');
	assert.equal(m.stats.hits, 2);
	assert.equal(m.stats.highConfidence, 1);
	assert.equal(m.stats.lowConfidence, 1);
});

test('normalizeItem: 兼容旧题库格式（options 是 JSON 字符串）', () => {
	const raw = {
		n: '1',
		q: '题干在这里',
		options: "[{'letter': 'A', 'text': '甲'}, {'letter': 'B', 'text': '乙'}]",
		answer: 'A',
		sec: '单选',
	};
	const it = normalizeItem(raw);
	assert.equal(it.stem, '题干在这里');
	assert.equal(it.qtype, '单选');
	assert.equal(it.options.length, 2);
	assert.equal(it.options[0].letter, 'A');
	assert.equal(it.answer, 'A');
});

test('normalizeItem: 选项是 "A 甲" 字符串也能解析', () => {
	const it = normalizeItem({ stem: '题', options: ['A 甲', 'B、乙', 'C.丙'], answer: 'A' });
	assert.deepEqual(
		it.options.map((o) => o.letter),
		['A', 'B', 'C']
	);
	assert.equal(it.options[1].text, '乙');
});

test('normalizeItem: 没有题干返回 null', () => {
	assert.equal(normalizeItem({}), null);
	assert.equal(normalizeItem(null), null);
});

test('dedupe: 同题干同答案去重，不同答案保留（版本冲突）', () => {
	const items = [
		{ stem: '同一个题干', answer: 'A' },
		{ stem: '同一个题干', answer: 'A' },
		{ stem: '同一个题干', answer: 'B' },
	];
	const out = dedupe(items);
	assert.equal(out.length, 2, '相同答案去重，不同答案保留');
	assert.ok(out.some((x) => (x.tags ?? []).includes('答案冲突')));
});

/* ── 导入切分 ─────────────────────────────────────────── */

const SAMPLE_TEXT = `
单选题
1. 《中国人民银行法》规定，人民币的单位是什么？
A. 元
B. 角
C. 分
D. 厘
答案：A

2. 下列属于人民币防伪特征的有？
A. 水印
B. 安全线
C. 光变油墨
D. 普通胶印
答案：ABC
多选题

判断题
3. 人民币是我国法定货币。
A. 正确
B. 错误
答案：对
`;

test('splitTextIntoItems: 切出 3 题，含题干/选项/答案/题型', () => {
	const { items, warnings } = splitTextIntoItems(SAMPLE_TEXT);
	assert.equal(items.length, 3, `应切出 3 题，实际 ${items.length}；警告: ${warnings.join(';')}`);

	assert.match(items[0].stem, /人民币的单位/);
	assert.equal(items[0].options.length, 4);
	assert.equal(items[0].answer, 'A');
	assert.equal(items[0].qtype, '单选题');

	assert.equal(items[1].options.length, 4);
	assert.equal(items[1].answer, 'ABC');

	assert.equal(items[2].options.length, 2);
});

test('splitTextIntoItems: 没题号时按选项推断边界', () => {
	const text = `第一题的题干在这里
A. 甲
B. 乙
答案：A

第二题的题干在这里
A. 丙
B. 丁
答案：B
`;
	const { items, warnings } = splitTextIntoItems(text);
	assert.ok(items.length >= 1, `至少切出一题，实际 ${items.length}`);
	assert.ok(warnings.some((w) => w.includes('未发现题号')) || items.length >= 2);
});

test('splitTextIntoItems: 空文本给出明确警告', () => {
	const { items, warnings } = splitTextIntoItems('');
	assert.equal(items.length, 0);
	assert.ok(warnings.length > 0);
});

test('inferQtype: 按答案与选项数推断', () => {
	assert.equal(inferQtype({ answer: 'T', options: [] }), '判断题');
	assert.equal(inferQtype({ answer: 'AB', options: [{}, {}] }), '多选题');
	assert.equal(inferQtype({ answer: 'A', options: [{}, {}, {}] }), '单选题');
});

test('parseCsv: 表头 + 选项列 + 答案列', () => {
	const csv = `题干,A,B,C,D,答案
人民币的单位,元,角,分,厘,A
防伪特征,水印,安全线,光变油墨,胶印,ABC
`;
	const { items, warnings } = parseCsv(csv);
	assert.equal(items.length, 2, `警告: ${warnings.join(';')}`);
	assert.equal(items[0].stem, '人民币的单位');
	assert.equal(items[0].options.length, 4);
	assert.equal(items[0].answer, 'A');
	assert.equal(items[1].answer, 'ABC');
});

test('parseCsv: 带引号与逗号的内容', () => {
	const csv = `题干,答案
"甲，乙，丙",A
"含""引号""的题干",B
`;
	const { items } = parseCsv(csv);
	assert.equal(items.length, 2);
	assert.equal(items[0].stem, '甲，乙，丙');
	assert.match(items[1].stem, /引号/);
});

test('parseCsv: 缺选项列时给出警告', () => {
	const { items, warnings } = parseCsv('题干,答案\n题目,A\n');
	assert.equal(items.length, 1);
	assert.ok(warnings.some((w) => w.includes('选项列')));
});

test('isSupported / dispatch: 扩展名分派', () => {
	assert.equal(isSupported('a.json'), true);
	assert.equal(isSupported('a.pdf'), true);
	assert.equal(isSupported('a.exe'), false);

	const r = dispatch('[{"stem":"题","answer":"A"}]', '.json');
	assert.equal(r.items.length, 1);

	const r2 = dispatch(SAMPLE_TEXT, '.txt');
	assert.equal(r2.items.length, 3);
});
