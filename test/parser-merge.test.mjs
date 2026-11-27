// 解析器：字母与正文被 OCR 拆成两行时的合并逻辑。
//
// （Windows OCR）：
//     'A'               y=94  h=11
//     '印刷经营许可证'    y=93  h=14     ← 正文的 y 比字母还小 1px
//     'B'               y=152 h=11
//     '出版物经营许可证'  y=151 h=14
//
// 按 (y, x) 排序后**正文排在字母前面**，于是：
//   * 第一个正文被算进题干（题干末尾多出"印刷经营许可证"）
//   * 每个选项拿到的是**下一项**的正文 → 整体错位一格
//   * 字母仍然 A,B,C,D 连续 → 完整性门禁不报错 → **静默答错**
//
// 危害等级：这是本轮最危险的一类错误 ——
// 选项文字全错但结构"看起来对"，题库匹配会给 medium（转人工）而不是报错。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function findPython() {
	const cands = [process.env.DSH_PYTHON, process.env.EXAM_PYTHON, 'python'].filter(
		Boolean
	);
	for (const c of cands) {
		try {
			execFileSync(c, ['-c', 'import sys'], { stdio: 'ignore', timeout: 15000 });
			return c;
		} catch {
			continue;
		}
	}
	return null;
}

const PY = findPython();

/** 调 Python 的 parser.parse，返回 JSON。 */
function parse(rows) {
	const script = `
import sys, json
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, r'${path.join(ROOT, 'engine', 'vendor').replace(/\\/g, '\\\\')}')
import parser as P
rows = json.loads(sys.argv[1])
p = P.parse(rows, 0, 0)
print('@@' + json.dumps(p, ensure_ascii=False))
`;
	const raw = execFileSync(PY, ['-c', script, JSON.stringify(rows)], { encoding: 'utf8', timeout: 60000 });
	const line = raw.split('\n').find((l) => l.startsWith('@@'));
	assert.ok(line, `Python 没返回结果: ${raw.slice(0, 300)}`);
	return JSON.parse(line.slice(2));
}

/** 造一题：题干 + 4 个选项（字母与正文分行） */
function splitRows(stem = '1·下列哪项正确？') {
	return [
		{ text: stem, x: 27, y: 33, w: 480, h: 16 },
		{ text: 'A', x: 38, y: 94, w: 9, h: 11 },
		{ text: 'B', x: 38, y: 152, w: 9, h: 11 },
		{ text: 'C', x: 38, y: 211, w: 9, h: 11 },
		{ text: 'D', x: 38, y: 269, w: 9, h: 11 },
		{ text: '印刷经营许可证', x: 60, y: 93, w: 120, h: 14 },
		{ text: '出版物经营许可证', x: 60, y: 151, w: 130, h: 14 },
		{ text: '特种行业许可证', x: 60, y: 209, w: 120, h: 15 },
		{ text: '营业执照即可', x: 60, y: 268, w: 90, h: 13 },
	];
}

test('字母与正文分行时，必须正确配对（不能整体错位一格）', (t) => {
	if (!PY) return t.skip('没有可用的 Python');
	const p = parse(splitRows());
	assert.equal(p.opts.length, 4, `选项数应为 4，实际 ${p.opts.length}`);

	const want = [
		['A', '印刷经营许可证'],
		['B', '出版物经营许可证'],
		['C', '特种行业许可证'],
		['D', '营业执照即可'],
	];
	for (let i = 0; i < 4; i++) {
		assert.equal(p.opts[i].letter, want[i][0], `第 ${i + 1} 项字母错`);
		assert.equal(
			p.opts[i].text,
			want[i][1],
			`第 ${i + 1} 项正文错：期望「${want[i][1]}」，实际「${p.opts[i].text}」。` +
				'整体错位一格会让题库匹配到错误结果（或给 medium 转人工），但不会报错。'
		);
	}
});

test('字母与正文分行时，题干不能被首个选项正文污染', (t) => {
	if (!PY) return t.skip('没有可用的 Python');
	const p = parse(splitRows());
	assert.ok(
		!p.stem.includes('印刷经营许可证'),
		`题干被首个选项正文污染了：「${p.stem}」。` +
			'这会让题干相似度虚低，把本该高置信的题降成 medium。'
	);
});

test('正文 y 比字母大（正常顺序）时同样要配对', (t) => {
	if (!PY) return t.skip('没有可用的 Python');
	// 换成正文 y 比字母大 1px 的情形
	const rows = splitRows().map((r) => {
		if (r.text === '印刷经营许可证') return { ...r, y: 95 };
		if (r.text === '出版物经营许可证') return { ...r, y: 153 };
		return r;
	});
	const p = parse(rows);
	assert.equal(p.opts[0].text, '印刷经营许可证');
	assert.equal(p.opts[1].text, '出版物经营许可证');
});

test('已经合在一行的情况不能被破坏（回归）', (t) => {
	if (!PY) return t.skip('没有可用的 Python');
	// 这是更常见的形态：OCR 直接给出 "A印刷经营许可证"
	const rows = [
		{ text: '1·下列哪项正确？', x: 27, y: 33, w: 480, h: 16 },
		{ text: 'A印刷经营许可证', x: 38, y: 94, w: 130, h: 14 },
		{ text: 'B出版物经营许可证', x: 38, y: 152, w: 140, h: 14 },
		{ text: 'C特种行业许可证', x: 38, y: 211, w: 130, h: 15 },
		{ text: 'D营业执照即可', x: 38, y: 269, w: 100, h: 13 },
	];
	const p = parse(rows);
	assert.equal(p.opts.length, 4);
	assert.equal(p.opts[0].text, '印刷经营许可证');
	assert.equal(p.opts[3].text, '营业执照即可');
});

test('判断题（2 项）分行也要配对', (t) => {
	if (!PY) return t.skip('没有可用的 Python');
	const rows = [
		{ text: '3·这个说法对吗？', x: 27, y: 33, w: 400, h: 16 },
		{ text: 'A', x: 38, y: 94, w: 9, h: 11 },
		{ text: 'B', x: 38, y: 152, w: 9, h: 11 },
		{ text: '正确', x: 60, y: 93, w: 40, h: 14 },
		{ text: '错误', x: 60, y: 151, w: 40, h: 14 },
	];
	const p = parse(rows);
	assert.equal(p.opts.length, 2, `应为 2 项，实际 ${p.opts.length}`);
	assert.equal(p.opts[0].text, '正确');
	assert.equal(p.opts[1].text, '错误');
});
