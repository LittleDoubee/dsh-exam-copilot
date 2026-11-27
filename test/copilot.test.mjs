// 协同模式（copilot）的契约测试。
//
// 实测发现的真实缺陷：
//   `run.start` 在 copilot 模式下把 `runner._resolve` **整个覆盖**成
//   「只用 solver.solve()」：
//
//       runner._resolve = async (q) => {
//         const r = solver ? await solver.solve(q, ...) : null;
//         ...
//       };
//
//   这等于把**题库整条通道**从协同模式里摘掉了。后果：
//     * 与 README「题库是省时间省钱的主力，高置信命中时完全不需要调模型」
//       直接矛盾；
//     * 实测 mock 第 1 题：题库有 medium-high 命中（答案 A），
//       但协同模式仍然去问模型；而宿主 llm 不可用时 solver 为 null，
//       于是 answer=null → paused/unknown_question。
//       **题库里明明有答案却答不出来。**
//
// 正确契约：协同模式 = 全自动 **去掉点击动作**，
//   作答链路（题库优先 → 模型兜底 → 转人工）必须完全一致。
//   所以 copilot 只能覆盖 `_decide`（不产出动作）和 `_verifyCurrent`（不翻页）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INDEX_SRC = path.join(ROOT, 'lib', 'index.js');

function readIndex() {
	return fs.readFileSync(INDEX_SRC, 'utf8');
}

/** 取出 `if (mode === 'copilot') { ... }` 这一块的函数体（括号配对）。 */
function copilotBlock(src) {
	const idx = src.indexOf("if (mode === 'copilot')");
	if (idx < 0) return null;
	const start = src.indexOf('{', idx);
	let depth = 0;
	let q = null;
	for (let i = start; i < src.length; i++) {
		const c = src[i];
		if (q) {
			if (c === q && src[i - 1] !== '\\') q = null;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			q = c;
			continue;
		}
		if (c === '{') depth += 1;
		else if (c === '}') {
			depth -= 1;
			if (depth === 0) return src.slice(start + 1, i);
		}
	}
	return null;
}

test('协同模式：不能覆盖 _resolve（否则题库通道被摘掉）', () => {
	const src = readIndex();
	const block = copilotBlock(src);
	assert.ok(block, "找不到 `if (mode === 'copilot')` 代码块，正则/结构可能已变");
	assert.ok(
		!/_resolve\s*=/.test(block),
		'协同模式又覆盖了 _resolve —— 这会让题库整条通道失效，' +
			'表现为「题库里明明有答案却答不出」。正确做法是只覆盖 _decide 与 _verifyCurrent。'
	);
});

test('协同模式：必须覆盖 _decide（不产出点击动作）', () => {
	const src = readIndex();
	const block = copilotBlock(src);
	assert.ok(block);
	assert.ok(
		/_decide\s*=/.test(block),
		'协同模式没覆盖 _decide —— 那会真的去点鼠标，违背「人机协同只识别不点击」的承诺'
	);
});

test('协同模式：必须让运行停下来（不自动翻页）', () => {
	const src = readIndex();
	const block = copilotBlock(src);
	assert.ok(block);
	assert.ok(
		/_verifyCurrent\s*=/.test(block),
		'协同模式没覆盖 _verifyCurrent —— 那会继续翻页，而不是解出答案就停'
	);
	assert.ok(
		/PAUSE/.test(block),
		'协同模式应该通过 PAUSE 精确暂停，而不是继续循环'
	);
});

test('协同模式的安全承诺：UI 上明确写了「不点击」', () => {
	const clientSrc = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
	// 面板上必须把这个承诺写给用户看，否则用户无从判断该选哪个模式
	assert.ok(
		clientSrc.includes('人机协同') && /不点击|只识别/.test(clientSrc),
		'面板缺少「人机协同只识别不点击」的说明'
	);
});
