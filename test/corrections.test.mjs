// OCR 纠错词典的端到端测试（Python 侧）。
//
// 为什么必须有这一组：
//   OCR 常把题干读出偏旁拆字错误：
//     "E卩刷"→印刷   "瀟呈"→流程   "承验证"→承印验证
//     "导印刷"→不得印刷   "蕊止"→禁止   "营艹照"→营业执照
//   这些错字把题干相似度压到 0.41~0.54，题库匹配不到，
//   本该秒答的题被迫退到模型（26.5s/题）或转人工。
//
//   加了词典后，三题相似度升到 0.60~0.68，全部通过。
//   这不是"把测试调宽"，而是**真的修好了识别**——同一张图，同样的 OCR，
//   出来的文字更准了。
//
// 另一个必须守的点：**词典不能误伤正常文本**。
//   例如 "三年" 不该被改成别的，"50%" 不该受影响。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SEED = path.join(ROOT, 'engine', 'corrections.seed.json');

/** 找一个能跑 Python 的解释器。找不到就 skip（不假装通过）。 */
function findPython() {
	const cands = [
		process.env.DSH_PYTHON,
		process.env.EXAM_PYTHON,
		'python',
		'python3',
	].filter(Boolean);
	for (const c of cands) {
		try {
			execFileSync(c, ['-c', 'import PIL'], { stdio: 'ignore', timeout: 20000 });
			return c;
		} catch {
			continue;
		}
	}
	return null;
}

const PY = findPython();

test('纠错词典：seed 文件结构合法（键值都是非空字符串）', () => {
	const raw = JSON.parse(fs.readFileSync(SEED, 'utf8'));
	const pairs = Object.entries(raw).filter(([k]) => !k.startsWith('_'));
	assert.ok(pairs.length >= 15, `词典条目太少（${pairs.length}），可能被误删`);
	for (const [bad, good] of pairs) {
		assert.ok(bad && bad.length > 0, `空键: ${JSON.stringify(bad)}`);
		assert.ok(good && good.length > 0, `空值: ${bad} → ${JSON.stringify(good)}`);
		assert.notEqual(bad, good, `自映射没有意义: ${bad}`);
		// 1 字键风险高（会把正常词也改掉），必须显式说明理由
		if (bad.length === 1) {
			assert.ok(/^[A-Za-z]$|^[^\u4e00-\u9fa5]$/.test(bad), `单字中文键风险太高: ${bad}`);
		}
	}
});

test('纠错词典：能修好实测错字（这是它存在的理由）', (t) => {
	if (!PY) return t.skip('没有可用的 Python');
	const cases = [
		// [输入, 期望包含, 说明]
		['5·下图所示瀟呈图中，的环节应当是', '流程', '瀟呈→流程'],
		['7·出版物E卩刷企业导E卩刷下列哪些内容', '印刷', 'E卩刷→印刷 / 导印刷→不得印刷'],
		['含有法律蕊止内容的出版物', '禁止', '蕊止→禁止'],
		['9·下列哪项不属于承验证制度要-验的材料', '承印验证', '承验证→承印验证'],
		['营艹照即可', '营业执照', '营艹照→营业执照'],
	];
	const script = `
import sys, json
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, r'${path.join(ROOT, 'engine', 'vendor').replace(/\\/g, '\\\\')}')
import ocr_engine as O, os
os.environ['EXAM_CORRECTIONS'] = r'${SEED.replace(/\\/g, '\\\\')}'
O._USER_FIXES_CACHE.update({'path': None, 'mtime': None, 'data': {}})
cases = json.loads(sys.argv[1])
out = []
for s in cases:
    out.append(O.fix_text(s))
print('@@' + json.dumps(out, ensure_ascii=False))
`;
	const inputs = cases.map(([s]) => s);
	const raw = execFileSync(PY, ['-c', script, JSON.stringify(inputs)], {
		encoding: 'utf8',
		timeout: 60000,
	});
	const line = raw.split('\n').find((l) => l.startsWith('@@'));
	assert.ok(line, `Python 没返回结果: ${raw.slice(0, 300)}`);
	const outs = JSON.parse(line.slice(2));

	for (let i = 0; i < cases.length; i++) {
		const [input, expect, why] = cases[i];
		const got = outs[i];
		assert.notEqual(got, input, `${why}：没有改动（输入 ${input}）`);
		assert.ok(got.includes(expect), `${why}：期望包含「${expect}」，实际「${got}」`);
	}
});

test('纠错词典：不能误伤正常文本', (t) => {
	if (!PY) return t.skip('没有可用的 Python');
	// 这些是"看起来像错字但不能动"的正常文本
	const safe = [
		'印刷经营许可证的有效期一般为三年',
		'罚款五十元',
		'正确率 50%',
		'著作权授权证明',
		'法定代表人身份证',
	];
	const script = `
import sys, json, os
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, r'${path.join(ROOT, 'engine', 'vendor').replace(/\\/g, '\\\\')}')
import ocr_engine as O
os.environ['EXAM_CORRECTIONS'] = r'${SEED.replace(/\\/g, '\\\\')}'
O._USER_FIXES_CACHE.update({'path': None, 'mtime': None, 'data': {}})
cases = json.loads(sys.argv[1])
print('@@' + json.dumps([O.fix_text(s) for s in cases], ensure_ascii=False))
`;
	const raw = execFileSync(PY, ['-c', script, JSON.stringify(safe)], { encoding: 'utf8', timeout: 60000 });
	const line = raw.split('\n').find((l) => l.startsWith('@@'));
	assert.ok(line, 'Python 没返回结果');
	const outs = JSON.parse(line.slice(2));
	for (let i = 0; i < safe.length; i++) {
		assert.equal(outs[i], safe[i], `正常文本被改动了：「${safe[i]}」→「${outs[i]}」`);
	}
});
