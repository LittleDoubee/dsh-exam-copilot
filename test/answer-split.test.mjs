// 切分 + 答案类型 的集成测试。
//
// 这组用例直接对应的核心质疑：
//   「切分是否有用？答案类型有很多种（字母/数字/T/F），切分能全命中吗？」
// 每一条都是一个**旧实现会静默丢答案**的真实写法。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitTextIntoItems, inferQtype } from '../lib/core/importer.js';
import { ANSWER_KIND } from '../lib/core/answer.js';

test('字母答案：单选 / 多选 / 各种分隔符都能命中', () => {
	const text = [
		'1. 单选题干',
		'A. 甲',
		'B. 乙',
		'C. 丙',
		'D. 丁',
		'答案：B',
		'',
		'2. 多选题干',
		'A. 甲',
		'B. 乙',
		'C. 丙',
		'D. 丁',
		'答案：A、C',
		'',
		'3. 多选无分隔',
		'A. 甲',
		'B. 乙',
		'C. 丙',
		'答案：ACD',
	].join('\n');

	const { items } = splitTextIntoItems(text);
	assert.equal(items.length, 3);

	assert.equal(items[0].answer, 'B', '单选题答案应命中');
	assert.equal(items[0].answerKind, ANSWER_KIND.CHOICE);
	assert.equal(items[0].qtype, '单选题');

	assert.equal(items[1].answer, 'AC', '顿号分隔的多选应抓全（旧实现只抓到 A）');
	assert.equal(items[1].qtype, '多选题');

	assert.equal(items[2].answer, 'ACD');
	assert.equal(items[2].qtype, '多选题');
});

test('数字答案：旧实现完全丢，现在必须识别并保留', () => {
	const text = [
		'1. 一张百元券的宽度是多少毫米？',
		'答案：77',
		'',
		'2. 计算结果保留两位小数',
		'答案：3.14',
		'',
		'3. 占比',
		'答案：50%',
	].join('\n');

	const { items } = splitTextIntoItems(text);
	assert.equal(items.length, 3);

	assert.equal(items[0].answer, '77', '数字答案不能为空');
	assert.equal(items[0].answerKind, ANSWER_KIND.NUMBER);

	assert.equal(items[1].answer, '3.14', '小数答案要原样保留');
	assert.equal(items[2].answer, '50%');
});

test('判断题：裸 T/F 与中文写法都要命中', () => {
	const text = [
		'1. 隐形面额数字是凹印的',
		'答案：T',
		'',
		'2. 水印是印刷上去的',
		'答案：F',
		'',
		'3. 安全线是埋入的',
		'答案：对',
		'',
		'4. 光变油墨会变色',
		'答案：错误',
	].join('\n');

	const { items } = splitTextIntoItems(text);
	assert.equal(items.length, 4);
	for (let i = 0; i < items.length; i++) {
		assert.ok(items[i].answer, `第 ${i + 1} 题答案不能为空（旧实现在这里会丢）`);
		assert.equal(items[i].answerKind, ANSWER_KIND.BOOL, `第 ${i + 1} 题应判为 bool`);
	}
	assert.equal(items[0].answer, 'T');
	assert.equal(items[1].answer, 'F');
	assert.equal(items[2].answer, 'T', '"对" 应归一为 T');
	assert.equal(items[3].answer, 'F', '"错误" 应归一为 F');
	// 判断题不该因为答案写法被误判成单选
	assert.equal(items[0].qtype, '判断题');
});

test('文本答案：填空/简答保留原文，不丢弃', () => {
	const text = [
		'1. 我国的中央银行是____。',
		'答案：中国人民银行',
		'',
		'2. 第五套人民币100元券的主色调是____。',
		'答案：红色',
	].join('\n');

	const { items } = splitTextIntoItems(text);
	assert.equal(items.length, 2);
	assert.equal(items[0].answer, '中国人民银行', '文本答案不能被清空');
	assert.equal(items[0].answerKind, ANSWER_KIND.TEXT);
	assert.equal(items[1].answer, '红色');
	// 无选项 + 文本答案 → 简答/填空，而不是空题型
	assert.ok(['简答题', '填空题'].includes(items[0].qtype), `题型不该为空，实际 "${items[0].qtype}"`);
});

test('答案缺失时给明确告警，而不是静默', () => {
	const text = ['1. 这道题没有答案行', 'A. 甲', 'B. 乙'].join('\n');
	const { items, warnings } = splitTextIntoItems(text);
	assert.equal(items.length, 1);
	assert.equal(items[0].answer, '');
	assert.ok(
		warnings.some((w) => w.includes('没有识别到答案')),
		'缺答案必须告警，实际 warnings=' + JSON.stringify(warnings)
	);
});

test('【答案】B 这种行首括号写法', () => {
	const text = ['1. 题干', 'A. 甲', 'B. 乙', '【答案】B'].join('\n');
	const { items } = splitTextIntoItems(text);
	assert.equal(items[0].answer, 'B', '【答案】写法应命中');
});

test('答案行不能把后面的题干吞进来', () => {
	// 关键回归：旧正则是贪婪之外的"只取枚举"，新实现要避免把下一题题干当答案
	const text = [
		'1. 第一题',
		'A. 甲',
		'B. 乙',
		'答案：A',
		'2. 第二题',
		'A. 丙',
		'B. 丁',
		'答案：B',
	].join('\n');
	const { items } = splitTextIntoItems(text);
	assert.equal(items.length, 2, '应为 2 题');
	assert.equal(items[0].answer, 'A');
	assert.equal(items[1].answer, 'B');
	assert.ok(!items[0].answer.includes('第二题'), '答案不该包含下一题题干');
});

test('inferQtype：不再因为答案不是字母就返回空题型', () => {
	assert.equal(inferQtype({ answer: '3.14', options: [] }), '填空题');
	assert.equal(inferQtype({ answer: '北京', options: [] }), '简答题');
	assert.equal(inferQtype({ answer: 'AC', options: [{}, {}, {}, {}] }), '多选题');
	assert.equal(inferQtype({ answer: 'B', options: [{}, {}, {}, {}] }), '单选题');
	assert.equal(inferQtype({ answer: 'T', options: [] }), '判断题');
});
