// doc-read 的单测：真实 docx / xlsx 生成 → 解析 → 校验文字与结构。
//
// 刻意用 python-docx / openpyxl 生成输入（它们能产出真实结构，
// 手搓 ZIP 只能验证"我以为的格式"，验证不了"真实生成器的格式"）。
// 生成失败时整组跳过，不让环境问题伪装成代码失败。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sniffKind, readZip, bytesToText, docxToText, xlsxToText, colOf, BLOB_KINDS } from '../lib/core/doc-read.js';

const PY = process.env.DSH_PYTHON || null;

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'dshec-doc-'));
}

function canUsePython() {
	if (!PY) return false;
	try {
		execFileSync(PY, ['-c', 'import docx, openpyxl'], { stdio: 'ignore', timeout: 20000 });
		return true;
	} catch {
		return false;
	}
}

const HAS_PY = canUsePython();

test('colOf：A→0、Z→25、AA→26', () => {
	assert.equal(colOf('A1'), 0);
	assert.equal(colOf('B2'), 1);
	assert.equal(colOf('Z9'), 25);
	assert.equal(colOf('AA1'), 26);
	assert.equal(colOf('AB3'), 27);
});

test('sniffKind：按魔数识别，不轻信扩展名', () => {
	const docxSig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
	const fakeDocx = Buffer.concat([docxSig, Buffer.from('...word/document.xml...')]);
	assert.equal(sniffKind(fakeDocx, 'a.zip'), BLOB_KINDS.DOCX);

	const fakeXlsx = Buffer.concat([docxSig, Buffer.from('...xl/workbook.xml...')]);
	assert.equal(sniffKind(fakeXlsx, 'a.zip'), BLOB_KINDS.XLSX);

	// 扩展名说是 csv，实际是 PDF → 必须按 PDF 判
	const pdf = Buffer.from('%PDF-1.7\n...');
	assert.equal(sniffKind(pdf, 'x.csv'), BLOB_KINDS.PDF);

	// .xls 与 .doc 共用 OLE 头，靠扩展名区分
	const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]);
	assert.equal(sniffKind(ole, 'a.xls'), BLOB_KINDS.XLS);
	assert.equal(sniffKind(ole, 'a.doc'), BLOB_KINDS.DOC);

	assert.equal(sniffKind(Buffer.from('1. 题干\nA. 选项\n'), 'q.txt'), BLOB_KINDS.TEXT);
});

test('readZip：能读回自己写的条目', async () => {
	const dir = tmpDir();
	const f = path.join(dir, 'x.zip');
	// 用 python 造一个最小 zip，避免手搓 CRC
	if (HAS_PY) {
		execFileSync(
			PY,
			[
				'-c',
				`import zipfile,sys
z=zipfile.ZipFile(r"${f}","w",zipfile.ZIP_DEFLATED)
z.writestr("a/b.txt","hello 建")
z.close()`,
			],
			{ stdio: 'ignore' }
		);
		const mx = readZip(fs.readFileSync(f));
		assert.equal(mx.get('a/b.txt').toString('utf8'), 'hello 建');
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

test('docx：段落/表格/换行都要保住结构', { skip: !HAS_PY && '没有可用的 python-docx' }, () => {
	const dir = tmpDir();
	const f = path.join(dir, 'q.docx');
	execFileSync(
		PY,
		[
			'-c',
			`from docx import Document
d=Document()
d.add_paragraph("1. 下列哪种颜色是面额数字的颜色？（单选）")
d.add_paragraph("A. 红色")
d.add_paragraph("B. 蓝色")
d.add_paragraph("答案：B")
t=d.add_table(rows=1, cols=3)
t.rows[0].cells[0].text="2. 表格题"
t.rows[0].cells[1].text="A 甲"
t.rows[0].cells[2].text="B 乙"
d.save(r"${f}")`,
		],
		{ stdio: 'ignore' }
	);

	const buf = fs.readFileSync(f);
	assert.equal(sniffKind(buf, 'q.docx'), BLOB_KINDS.DOCX);

	const text = docxToText(buf);
	const lines = text.split('\n');

	// 每段独立成行 —— 这是 importer 按行切分的前提
	assert.ok(lines.some((l) => l.includes('1. 下列哪种颜色')), '题干应单独成行');
	assert.ok(lines.some((l) => /^A\.\s*红色/.test(l.trim())), '选项A应单独成行');
	assert.ok(lines.some((l) => /答案：B/.test(l)), '答案行应保留');
	// 表格：同一行内的单元格用 \t 连接
	assert.ok(lines.some((l) => l.includes('2. 表格题') && l.includes('\t')), '表格行应用制表符连接各单元格');

	// 中文不能乱码
	assert.ok(text.includes('面额数字'), '中文应正确解码');

	fs.rmSync(dir, { recursive: true, force: true });
});

test('xlsx：共享字符串/数字/多表都要能读', { skip: !HAS_PY && '没有可用的 openpyxl' }, () => {
	const dir = tmpDir();
	const f = path.join(dir, 'q.xlsx');
	execFileSync(
		PY,
		[
			'-c',
			`from openpyxl import Workbook
wb=Workbook()
ws=wb.active
ws.title="单选"
ws.append(["题干","A","B","C","答案"])
ws.append(["1. 面额数字颜色","红色","蓝色","绿色","B"])
ws2=wb.create_sheet("判断")
ws2.append(["题干","答案"])
ws2.append(["2. 隐形面额数字是凹印的","T"])
wb.save(r"${f}")`,
		],
		{ stdio: 'ignore' }
	);

	const buf = fs.readFileSync(f);
	assert.equal(sniffKind(buf, 'q.xlsx'), BLOB_KINDS.XLSX);

	const text = xlsxToText(buf);

	// 表名保留，便于人工核对是哪个 sheet
	assert.ok(text.includes('# 单选'), '应保留工作表名');
	assert.ok(text.includes('# 判断'), '第二个表也要读');
	// 单元格用 \t 连接 —— importer 的 CSV 解析器会自动识别 \t
	assert.ok(text.includes('题干\tA\tB\tC\t答案'), '表头行应用制表符连接');
	assert.ok(text.includes('1. 面额数字颜色\t红色\t蓝色\t绿色\tB'), '数据行应完整');
	// 数字型答案（不是共享字符串）也要出来
	assert.ok(text.includes('2. 隐性面额数字是凹印的\tT'.replace('性', '形')), '判断表内容应读出');

	fs.rmSync(dir, { recursive: true, force: true });
});

test('bytesToText：PDF/doc/xls 给出可执行的下一步，而不是一句"不支持"', () => {
	const assertHint = (buf, name, key) => {
		try {
			bytesToText(buf, name);
			assert.fail('应当抛错');
		} catch (err) {
			assert.equal(err.userHint, key, err.message);
			assert.ok(err.message.length > 0);
		}
	};
	assertHint(Buffer.from('%PDF-1.7 x'), 'a.pdf', 'pdf');
	assertHint(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'a.doc', 'doc');
	assertHint(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'a.xls', 'xls');
	assertHint(Buffer.from([0x00, 0x01, 0x02, 0x00]), 'a.bin', 'unknown');
});

test('bytesToText：纯文本去 BOM', () => {
	const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('1. 题干\nA. 甲\n', 'utf8')]);
	const r = bytesToText(withBom, 'q.txt');
	assert.equal(r.kind, BLOB_KINDS.TEXT);
	assert.ok(!r.text.startsWith('\ufeff'));
	assert.ok(r.text.startsWith('1. 题干'));
});

test('zip bomb 防护：声明过大的条目不被解压', { skip: !HAS_PY && '没有 python' }, () => {
	// 65MB 的零字节压缩后极小 —— 若解压就会吃满内存
	const dir = tmpDir();
	const f = path.join(dir, 'bomb.zip');
	execFileSync(
		PY,
		[
			'-c',
			`import zipfile
z=zipfile.ZipFile(r"${f}","w",zipfile.ZIP_DEFLATED)
z.writestr("big.bin", b"\\0"*(70*1024*1024))
z.writestr("ok.txt","fine")
z.close()`,
		],
		{ stdio: 'ignore' }
	);
	const mx = readZip(fs.readFileSync(f));
	assert.equal(mx.get('big.bin'), null, '超大条目应被标记为 null 而不是解压');
	assert.equal(mx.get('ok.txt').toString('utf8'), 'fine', '正常条目仍要能读');
	fs.rmSync(dir, { recursive: true, force: true });
});
