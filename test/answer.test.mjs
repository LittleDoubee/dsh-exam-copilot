// answer.js 单测：覆盖用户明确点出的答案类型（字母 / 数字 / T/F / 文本）。
//
// 这些用例是照着"旧实现会静默丢答案"的写法列的，
// 所以每一条都对应一个真实会出错的输入。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	ANSWER_KIND,
	parseAnswer,
	normalizeBool,
	extractLetters,
	looksNumeric,
	toAnswerString,
	validateAnswer,
} from '../lib/core/answer.js';

test('字母答案：单个 / 多个 / 各种分隔符', () => {
	assert.equal(parseAnswer('A').value, 'A');
	assert.equal(parseAnswer('a').value, 'A', '小写要归一');
	assert.equal(parseAnswer('ABD').value, 'ABD');
	assert.equal(parseAnswer('BAD').value, 'ABD', '要排序');
	assert.equal(parseAnswer('A、C').value, 'AC', '顿号分隔');
	assert.equal(parseAnswer('A,C').value, 'AC', '逗号分隔');
	assert.equal(parseAnswer('A C').value, 'AC', '空格分隔');
	assert.equal(parseAnswer('A和C').value, 'AC', '中文"和"');
	assert.equal(parseAnswer(['B', 'A']).value, 'AB', '数组要合并去重');
	assert.equal(parseAnswer('AAB').value, 'AB', '要去重');
});

test('数字答案：旧实现会直接丢掉，现在必须认出', () => {
	const cases = [
		['3', '3'],
		['3.14', '3.14'],
		['-2', '-2'],
		['1/2', '1/2'],
		['50%', '50%'],
		['０.５', '０.５'], // 全角数字：保留原样，由调用方决定是否转换
	];
	for (const [input, want] of cases) {
		const r = parseAnswer(input);
		assert.equal(r.kind, ANSWER_KIND.NUMBER, `${input} 应识别为数值，实际 ${r.kind}`);
		assert.equal(r.value, want);
	}
	assert.ok(looksNumeric('3'));
	assert.ok(!looksNumeric('3abc'));
	assert.ok(!looksNumeric(''));
});

test('判断题：裸 T/F 与中英文写法都要认', () => {
	const trueForms = ['T', 't', '对', '正确', '√', 'true', '是', 'Y'];
	const falseForms = ['F', 'f', '错', '错误', '×', 'false', '否', 'N'];
	for (const v of trueForms) {
		const r = parseAnswer(v);
		assert.equal(r.kind, ANSWER_KIND.BOOL, `${v} 应为 bool，实际 ${r.kind}`);
		assert.equal(r.value, 'T', `${v} 应归为 T`);
	}
	for (const v of falseForms) {
		const r = parseAnswer(v);
		assert.equal(r.kind, ANSWER_KIND.BOOL, `${v} 应为 bool，实际 ${r.kind}`);
		assert.equal(r.value, 'F', `${v} 应归为 F`);
	}
	assert.equal(normalizeBool('对'), 'T');
	assert.equal(normalizeBool('错'), 'F');
	assert.equal(normalizeBool('可能'), '');
});

test('文本答案：填空/简答不再被丢弃', () => {
	const cases = ['北京', '中国人民银行', '2024年10月1日', '无色荧光油墨'];
	for (const v of cases) {
		const r = parseAnswer(v);
		assert.equal(r.kind, ANSWER_KIND.TEXT, `${v} 应为文本，实际 ${r.kind}`);
		assert.equal(r.value, v, '文本答案必须原样保留');
	}
});

test('空答案', () => {
	assert.equal(parseAnswer('').kind, ANSWER_KIND.EMPTY);
	assert.equal(parseAnswer(null).kind, ANSWER_KIND.EMPTY);
	assert.equal(parseAnswer('   ').kind, ANSWER_KIND.EMPTY);
});

test('extractLetters：不能把单词里的字母当成选项', () => {
	// 关键负例：整词含 A-F 但不是一个字母组合
	assert.equal(extractLetters('HELIX').letters, '', 'HELIX 不该被当成多个选项');
	assert.equal(extractLetters('选项A').letters, 'A');
	assert.equal(extractLetters('（C）').letters, 'C');
	assert.equal(extractLetters('选A或C').letters, 'AC');
	// 已知边界：纯 2-8 个 A-H 字母的组合无法与英文单词区分
	// （FACE 恰好全是 A-H 字母），会被当成选项组合。
	// 这是本设计的已知取舍，由题型/选项数校验兜底 → validateAnswer。
	assert.equal(extractLetters('FACE').letters, 'ACEF');
});

test('选项数消解 T/F 歧义：返回值保持一致，避免上下游分叉', () => {
	// 2 选项时 T 可能是 True/False
	const r2 = parseAnswer('T', { optionCount: 2 });
	assert.equal(r2.kind, ANSWER_KIND.BOOL);
	assert.equal(r2.value, 'T');
	// 4 选项时 T 不是合法选项（只到 D），更像判断题
	const r4 = parseAnswer('T', { optionCount: 4 });
	assert.equal(r4.kind, ANSWER_KIND.BOOL);
});

test('toAnswerString：兼容旧调用点，且不再丢非字母答案', () => {
	assert.equal(toAnswerString('a'), 'A');
	assert.equal(toAnswerString('ABD'), 'ABD');
	assert.equal(toAnswerString('对'), 'T');
	assert.equal(toAnswerString('错'), 'F');
	// 这两条是行为改进的核心：旧实现在这里返回 ''
	assert.equal(toAnswerString('3.14'), '3.14');
	assert.equal(toAnswerString('北京'), '北京');
});

test('validateAnswer：能指出题库脏数据', () => {
	assert.deepEqual(validateAnswer(''), ['答案为空']);
	assert.ok(validateAnswer('A', '多选题', 4).some((s) => s.includes('多选但答案只有 1 个')));
	assert.ok(validateAnswer('AB', '单选题', 4).some((s) => s.includes('单选但答案有 2 个')));
	assert.ok(validateAnswer('D', '单选题', 3).some((s) => s.includes('只有 3 个选项')));
	assert.ok(validateAnswer('北京', '单选题', 4).some((s) => s.includes('文本')));
	assert.deepEqual(validateAnswer('AC', '多选题', 4), [], '合法数据不该报问题');
});
