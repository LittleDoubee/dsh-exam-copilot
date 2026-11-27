// 文档字节 → 纯文本。零依赖、纯 Node。
//
// 为什么自己在 Node 里解，而不是调 python：
//   ① 引擎跑的是「PATH 上带 PIL 的那个 python」，本机实测它**没有**
//      python-docx / openpyxl / pandas —— 让引擎解析会直接 ImportError。
//   ② DSH 自带的 python 运行时确实有这些库，但它的路径属于宿主私有实现，
//      插件去猜等于把"能导入"绑死在某台机器的安装布局上。
//   ③ docx/xlsx 本质都是 ZIP + XML，Node 自带 zlib 足够，不必引入依赖。
//
// 只做"把文字抽出来"这一件事。切分题目是 importer.js 的职责，两者分开：
//   doc-read 只保证"字节 → 尽量干净的文本行"，不做任何题型判断。

import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/** 单文件解压上限。防 zip bomb：声明大小 4GB 的条目一律拒绝。 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** 文件类型：不只看扩展名，也看魔数（扩展名会骗人）。 */
export const BLOB_KINDS = {
	DOCX: 'docx',
	XLSX: 'xlsx',
	PDF: 'pdf',
	DOC: 'doc',
	XLS: 'xls',
	TEXT: 'text',
	UNKNOWN: 'unknown',
};

/**
 * 按魔数判断真实类型。
 *
 * 为什么要看魔数：用户把 .xlsx 改名成 .csv、把 .doc 存成 .docx 都很常见。
 * 只信扩展名会在 `readZip` 里抛一个看不懂的错。
 */
export function sniffKind(buf, name = '') {
	if (!buf || buf.length < 4) return BLOB_KINDS.UNKNOWN;
	const b = buf;
	// ZIP：PK\x03\x04（或空档 PK\x05\x06）
	if (b[0] === 0x50 && b[1] === 0x4b) {
		// 用内容里的目录名区分 docx / xlsx，比扩展名可靠
		if (buf.includes(Buffer.from('word/document.xml'))) return BLOB_KINDS.DOCX;
		if (buf.includes(Buffer.from('xl/workbook.xml'))) return BLOB_KINDS.XLSX;
		const ext = String(name).toLowerCase();
		if (ext.endsWith('.docx')) return BLOB_KINDS.DOCX;
		if (ext.endsWith('.xlsx')) return BLOB_KINDS.XLSX;
		return BLOB_KINDS.UNKNOWN;
	}
	// %PDF
	if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return BLOB_KINDS.PDF;
	// OLE 复合文档：.doc / .xls 都是这个头
	if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
		const ext = String(name).toLowerCase();
		return ext.endsWith('.xls') ? BLOB_KINDS.XLS : BLOB_KINDS.DOC;
	}
	// 文本：前 4KB 没有 NUL 就当文本
	const probe = buf.subarray(0, Math.min(4096, buf.length));
	if (!probe.includes(0)) return BLOB_KINDS.TEXT;
	return BLOB_KINDS.UNKNOWN;
}

/* ── ZIP ──────────────────────────────────────────────────
 * 只读，不支持 zip64 / 加密。docx/xlsx 不会用到这两样。
 * 返回 Map<entryName, Buffer>，按需解压（惰性）会更省内存，
 * 但题库文件一般几百 KB，全解更快也更好调试。 */

export function readZip(buf) {
	const eocd = findEocd(buf);
	if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）');

	const count = buf.readUInt16LE(eocd + 10);
	const cdSize = buf.readUInt32LE(eocd + 12);
	const cdOff = buf.readUInt32LE(eocd + 16);
	if (cdOff === 0xffffffff) throw new Error('暂不支持 zip64 格式');

	const out = new Map();
	let p = cdOff;
	const cdEnd = Math.min(cdOff + cdSize, buf.length);
	while (p + 46 <= cdEnd && buf.readUInt32LE(p) === SIG_CEN) {
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const uncompSize = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const locOff = buf.readUInt32LE(p + 42);
		const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
		p += 46 + nameLen + extraLen + commentLen;

		if (!name || name.endsWith('/')) continue; // 目录条目
		if (uncompSize > MAX_ENTRY_BYTES) {
			out.set(name, null); // 标记为"过大不读"，调用方跳过
			continue;
		}
		if (locOff + 30 > buf.length || buf.readUInt32LE(locOff) !== SIG_LOC) continue;

		const lNameLen = buf.readUInt16LE(locOff + 26);
		const lExtraLen = buf.readUInt16LE(locOff + 28);
		const dataStart = locOff + 30 + lNameLen + lExtraLen;
		if (dataStart + compSize > buf.length) continue;

		const raw = buf.subarray(dataStart, dataStart + compSize);
		try {
			if (method === 0) out.set(name, Buffer.from(raw));
			else if (method === 8) out.set(name, zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
			else out.set(name, null); // 不支持的压缩算法
		} catch {
			out.set(name, null); // 单条坏了不影响其他条目
		}
	}
	return out;
}

function findEocd(buf) {
	// EOCD 在文件末尾，注释最长 65535
	const min = Math.max(0, buf.length - 65557);
	for (let i = buf.length - 22; i >= min; i--) {
		if (buf.readUInt32LE(i) === SIG_EOCD) return i;
	}
	return -1;
}

/* ── XML 小工具 ─────────────────────────────────────────────
 * 刻意不引 XML 库：docx/xlsx 的正文抽取只需要"按标签切"，
 * 上完整解析器反而要处理命名空间、实体、CDATA 一堆与本任务无关的东西。 */

export function xmlUnescape(s) {
	return String(s)
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, d) => safeFromCode(Number(d)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCode(parseInt(h, 16)))
		.replace(/&amp;/g, '&');
}

function safeFromCode(n) {
	try {
		return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
	} catch {
		return '';
	}
}

/* ── DOCX ───────────────────────────────────────────────── */

/**
 * 抽 docx 正文。
 *
 * 关键点：必须按 `<w:p>` 分段、`<w:tab/>` 转 \t、`<w:br/>` 转换行，
 * 否则整篇会粘成一长行，importer 的"按行切分"直接失效。
 * 表格在 docx 里是 `<w:tbl><w:tr><w:tc>`，每个 `</w:tc>` 补一个 \t，
 * 这样一行表格会变成 "题干\t选项A\t选项B" —— 正好是 importer 能吃的形态。
 */
export function docxToText(buf) {
	const zip = readZip(buf);
	const xmlBuf = zip.get('word/document.xml');
	if (!xmlBuf) throw new Error('docx 里找不到 word/document.xml（文件可能已损坏）');
	let xml = xmlBuf.toString('utf8');

	xml = xml.replace(/<w:tab\s*\/>/g, '\t');
	xml = xml.replace(/<w:br\s*\/>/g, '\n');

	// 顺序是这类解析最容易错的地方，实测踩过：
	//   docx 里**每个表格单元格内部都是一个完整的 <w:p>**。
	//   如果先把 </w:p> 换成 \n，再换 </w:tc> 成 \t，
	//   制表符就会落到下一行的行首，表格变成「标题\n\tA 甲\n\tB 乙」，
	//   importer 拿到的是一堆错行，切分全乱。
	//   正确做法：先把"单元格内最后一段"的 </w:p> 吞掉（不产生换行），
	//   再让 </w:tc> 输出 \t，这样一行表格才真的是一行。
	xml = xml.replace(/<\/w:p>(?=\s*<\/w:tc>)/g, '');
	xml = xml.replace(/<\/w:tc>/g, '\t');
	xml = xml.replace(/<\/w:p>/g, '\n');
	xml = xml.replace(/<\/w:tr>/g, '\n');

	// 去掉所有标签，只留文字
	xml = xml.replace(/<[^>]+>/g, '');
	let text = xmlUnescape(xml);

	// 收拾空白：
	//   * 行尾空白（含表格行尾多出来的 \t）去掉，否则 importer 的
	//     /^\s*(\d+)[.、]/ 会因尾随空格匹配出脏数据；
	//   * 行首缩进去掉 —— docx 里的首行缩进对切题没有意义，
	//     留着只会让题号不在行首；
	//   * 连续空行压成一个，避免空行把一道题切成两半。
	text = text
		.split('\n')
		.map((l) => l.trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n');

	return text.trim();
}

/* ── XLSX ───────────────────────────────────────────────── */

/** 列号：A→0, B→1 … AA→26。 */
export function colOf(ref) {
	const m = String(ref).match(/^([A-Z]+)/i);
	if (!m) return 0;
	let n = 0;
	for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

/** 读 xlsx 的共享字符串表（单元格 t="s" 时 v 是这里的下标）。 */
function readSharedStrings(zip) {
	const b = zip.get('xl/sharedStrings.xml');
	if (!b) return [];
	const xml = b.toString('utf8');
	const out = [];
	// 每个 <si> 可能由多个 <t> 拼成（富文本分片），要全接起来
	const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
	let m;
	while ((m = siRe.exec(xml)) !== null) {
		const parts = [];
		const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
		let t;
		while ((t = tRe.exec(m[1])) !== null) parts.push(t[1]);
		// 自闭合 <t/> 视为空串
		out.push(xmlUnescape(parts.join('')));
	}
	return out;
}

/** 工作表名 → 内部部件路径（走 workbook.xml + rels）。 */
function sheetPaths(zip) {
	const wb = zip.get('xl/workbook.xml');
	const rels = zip.get('xl/_rels/workbook.xml.rels');
	const paths = [];
	if (wb) {
		const xml = wb.toString('utf8');
		const order = [];
		const sRe = /<sheet\b([^>]*)\/?>/g;
		let m;
		while ((m = sRe.exec(xml)) !== null) {
			const attrs = m[1];
			const name = /name="([^"]*)"/.exec(attrs)?.[1] ?? '';
			const rid = /r:id="([^"]*)"/.exec(attrs)?.[1] ?? '';
			order.push({ name: xmlUnescape(name), rid });
		}
		const relMap = new Map();
		if (rels) {
			const rxml = rels.toString('utf8');
			const rRe = /<Relationship\b([^>]*)\/?>/g;
			let r;
			while ((r = rRe.exec(rxml)) !== null) {
				const id = /Id="([^"]*)"/.exec(r[1])?.[1];
				const target = /Target="([^"]*)"/.exec(r[1])?.[1];
				if (id && target) relMap.set(id, target);
			}
		}
		for (const { name, rid } of order) {
			let target = relMap.get(rid) ?? '';
			if (!target) continue;
			target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
			const full = target.startsWith('worksheets/') ? `xl/${target}` : `xl/${target}`;
			if (zip.has(full)) paths.push({ name, path: full });
		}
	}
	// 兜底：直接按文件名找（少数生成器不写 rels）
	if (paths.length === 0) {
		for (const k of zip.keys()) {
			if (/^xl\/worksheets\/sheet\d+\.xml$/.test(k)) paths.push({ name: k, path: k });
		}
		paths.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
	}
	return paths;
}

/**
 * 抽 xlsx 正文。每个工作表按「行 → 制表符连接」输出，表与表之间空一行 + 表名。
 *
 * 为什么要保留表结构：题库常见的 Excel 是「题干 | A | B | C | D | 答案」，
 * 转成 TSV 后 importer 的 parseCsv（分隔符自动识别 \t）能直接吃。
 */
export function xlsxToText(buf) {
	const zip = readZip(buf);
	const shared = readSharedStrings(zip);
	const sheets = sheetPaths(zip);
	if (sheets.length === 0) throw new Error('xlsx 里找不到工作表');

	const blocks = [];
	for (const { name, path } of sheets) {
		const b = zip.get(path);
		if (!b) continue;
		const xml = b.toString('utf8');
		const rows = [];

		const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
		let rm;
		while ((rm = rowRe.exec(xml)) !== null) {
			const cells = [];
			const cRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
			let cm;
			while ((cm = cRe.exec(rm[1])) !== null) {
				const attrs = cm[1];
				const body = cm[2] ?? '';
				const ref = /r="([^"]*)"/.exec(attrs)?.[1] ?? '';
				const t = /t="([^"]*)"/.exec(attrs)?.[1] ?? '';
				const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
				let val = '';
				if (t === 's') {
					val = shared[Number(v)] ?? '';
				} else if (t === 'inlineStr') {
					const parts = [];
					const itRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
					let it;
					while ((it = itRe.exec(body)) !== null) parts.push(it[1]);
					val = xmlUnescape(parts.join(''));
				} else if (v !== undefined) {
					val = xmlUnescape(v);
				}
				if (val !== '') cells[colOf(ref)] = val.replace(/[\t\r\n]+/g, ' ');
			}
			// 去掉行尾空列，避免整行都是 \t
			while (cells.length && (cells[cells.length - 1] === undefined || cells[cells.length - 1] === '')) {
				cells.pop();
			}
			if (cells.length) rows.push(cells.map((c) => c ?? '').join('\t'));
		}

		if (rows.length) blocks.push(`# ${name}\n${rows.join('\n')}`);
	}

	if (blocks.length === 0) throw new Error('xlsx 里没有可读的单元格数据');
	return blocks.join('\n\n');
}

/* ── 统一入口 ───────────────────────────────────────────── */

/**
 * 字节 → 文本。不可解析时抛错，错误信息直接面向用户（说明该怎么办）。
 *
 * 刻意不做 PDF / .doc / .xls：
 *   * .doc/.xls 是 OLE 复合文档，要解 piece table + BIFF 记录，
 *     投入产出比极差，而且做出来很容易"能导入但内容错乱"——比明确拒绝更坏。
 *   * PDF 分两种：有文本层的要解 xref/内容流/CID 字体映射；扫描版根本没文字，
 *     只能走 OCR。两种情况都不适合塞进这一轮的导入链路。
 *   这三个都给出可执行的下一步，而不是一句"不支持"。
 */
export function bytesToText(buf, name = '') {
	const kind = sniffKind(buf, name);
	switch (kind) {
		case BLOB_KINDS.DOCX:
			return { text: docxToText(buf), kind };
		case BLOB_KINDS.XLSX:
			return { text: xlsxToText(buf), kind };
		case BLOB_KINDS.TEXT: {
			// 去掉 BOM，统一成 UTF-8 读；非 UTF-8 的乱码交给下游 warnings 暴露
			let s = buf.toString('utf8');
			if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
			return { text: s, kind };
		}
		case BLOB_KINDS.PDF:
			throw Object.assign(new Error('PDF 暂不支持直接导入。'), { userHint: 'pdf' });
		case BLOB_KINDS.DOC:
			throw Object.assign(new Error('旧版 .doc 暂不支持。'), { userHint: 'doc' });
		case BLOB_KINDS.XLS:
			throw Object.assign(new Error('旧版 .xls 暂不支持。'), { userHint: 'xls' });
		default:
			throw Object.assign(new Error('无法识别的文件格式。'), { userHint: 'unknown' });
	}
}

/** 给用户的下一步建议（与 bytesToText 的 userHint 对应）。 */
export function hintFor(kind, name = '') {
	switch (kind) {
		case 'pdf':
			return (
				'PDF 里的文字可能有两种情况：' +
				'① 能选中文字（有文本层）→ 用任意 PDF 阅读器「另存为 / 导出为 .txt」，再导入这个 txt；' +
				'② 扫描件（整页是图片）→ 没有文字可抽，请导出题目的截图，用「识别」通道处理。' +
				'（自动解析 PDF 排在下一阶段，见 BACKLOG。）'
			);
		case 'doc':
			return '这是 2003 版 .doc（老二进制格式）。在 Word 里「另存为」→ 选「Word 文档 (.docx)」后重新拖入即可。';
		case 'xls':
			return '这是 2003 版 .xls。在 Excel 里「另存为」→ 选「Excel 工作簿 (.xlsx)」后重新拖入即可。';
		default:
			return `无法识别「${name}」。支持：.docx / .xlsx / .txt / .md / .csv / .tsv / .json / .jsonl`;
	}
}
