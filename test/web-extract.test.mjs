import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildQuestion, normalizeQType, parseProgress, RE_OPTION_HEAD } from '../lib/core/web-extract.js';

const fx = (n) => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), 'utf8');
const R = (x, y) => ({ x, y, w: 100, h: 20 });

// collectPage() 在众合页面上的输出形态（字段与真实页面一致，坐标为示意）
function zhongheRaw({ type, name, stem, opts, section }) {
	return {
		dpr: 1,
		navMax: 10,
		controlGroups: [
			{ name: '', type: 'checkbox', controls: [{ letter: '', label: '标记', visible: true, covered: false, rect: R(500, 1400) }] },
			{
				name, type,
				controls: ['A', 'B', 'C', 'D'].map((l, i) => ({ letter: l, label: l, visible: true, covered: false, rect: R(1400 + i * 60, 1480) })),
			},
		],
		textGroups: [{ visible: true, rect: R(570, 600), stem, items: opts.map((t, i) => ({ text: t, visible: true, rect: R(570, 600 + i * 60) })) }],
		headings: [
			{ text: '单项选择题\n\n1*\n2*\n3*\n4*\n5', y: 370 },
			{ text: '单项选择题', y: 370 },
			{ text: '多项选择题\n\n6*\n7*', y: 520 },
			{ text: '多项选择题', y: 520 },
			{ text: section, y: 430 },
		],
		progressTexts: [/第\s*\d+\s*题/.exec(fx(type === 'radio' ? 'zhonghe-q1.html' : 'zhonghe-q6.html'))[0]],
	};
}

const pOpts = (html) => [...html.matchAll(/<p>([A-D]\.[^<]+)<\/p>/g)].map((m) => m[1]);
const stemOf = (html) => /e1NVmFEclPKzadevSDfY8A==">([^<]+)</.exec(html)[1];

test('众合第1题：radio 单选，过滤「标记」，四选项配对', () => {
	const html = fx('zhonghe-q1.html');
	const r = buildQuestion(zhongheRaw({ type: 'radio', name: 'question37081', stem: stemOf(html), opts: pOpts(html), section: '一、单项选择题。每题所设选项中只有一个正确答案' }));
	assert.equal(r.ok, true, r.reasons.join(';'));
	assert.equal(r.question.qtype, 'single');
	assert.equal(r.question.qtypeHintAgrees, true);
	assert.deepEqual(r.question.opts.map((o) => o.letter), ['A', 'B', 'C', 'D']);
	assert.match(r.question.opts[1].text, /^中国法的现代化进程始于19世纪末/);
	assert.match(r.question.stem, /^关于法律发展的路径与特征/);
	assert.deepEqual(r.question.prog, [1, 10]);
	assert.equal(r.question.questionKey, 'question37081');
	assert.ok(r.question.opts.every((o) => o.click));
});

test('众合第6题：checkbox 多选，导航里的「单项选择题」不干扰', () => {
	const html = fx('zhonghe-q6.html');
	const r = buildQuestion(zhongheRaw({ type: 'checkbox', name: 'question37082', stem: stemOf(html), opts: pOpts(html), section: '二、多项选择题。每题所设选项中至少有两个正确答案' }));
	assert.equal(r.ok, true, r.reasons.join(';'));
	assert.equal(r.question.qtype, 'multi');
	assert.equal(r.question.qtypeHintAgrees, true);
	assert.equal(r.question.opts.length, 4);
	assert.deepEqual(r.question.prog, [6, 10]);
});

test('无原生控件时，题型取离题目最近的分段标题而非导航分组', () => {
	const html = fx('zhonghe-q6.html');
	const raw = zhongheRaw({ type: 'checkbox', name: 'q', stem: stemOf(html), opts: pOpts(html), section: '二、多项选择题。每题所设选项中至少有两个正确答案' });
	raw.controlGroups = [];
	const r = buildQuestion(raw);
	assert.equal(r.question.qtype, 'multi');
	assert.equal(r.ok, false); // 没有可点击控件，不能直接放行
});

test('控件被遮挡 → 不自洽', () => {
	const html = fx('zhonghe-q1.html');
	const raw = zhongheRaw({ type: 'radio', name: 'q', stem: stemOf(html), opts: pOpts(html), section: '' });
	raw.controlGroups[1].controls[2].covered = true;
	const r = buildQuestion(raw);
	assert.equal(r.ok, false);
	assert.ok(r.reasons.some((x) => x.includes('C') && x.includes('遮挡')));
});

test('控件与正文数量不一致 → 不自洽', () => {
	const html = fx('zhonghe-q1.html');
	const raw = zhongheRaw({ type: 'radio', name: 'q', stem: stemOf(html), opts: pOpts(html).slice(0, 3), section: '' });
	assert.equal(buildQuestion(raw).ok, false);
});

test('选项头：常见分隔符都认，"A股" 不认', () => {
	for (const s of ['A.x', 'A、x', 'A，x', 'A,x', 'A：x', '(A) x', '（B）x', 'C．x']) assert.ok(RE_OPTION_HEAD.test(s), s);
	assert.ok(!RE_OPTION_HEAD.test('A股市场'));
});

test('题型归一化与题号', () => {
	assert.equal(normalizeQType('1、单项选择题'), 'single');
	assert.equal(normalizeQType('二、多项选择题'), 'multi');
	assert.equal(normalizeQType('不定项选择'), 'multi');
	assert.equal(normalizeQType('判断题'), 'judge');
	assert.deepEqual(parseProgress('4/72'), { index: 4, total: 72 });
	assert.deepEqual(parseProgress('第 1 题'), { index: 1, total: null });
	assert.equal(parseProgress('答题耗时:00:03:03'), null);
});
