// 文档导入：把 PDF/DOCX/XLSX/TXT/MD 变成结构化题目。
//
// 务实的设计取舍：
//   文档切分不可能"全自动、通用、零误判"。真实题库文件的排版千差万别：
//   PDF 双栏、表格题、图片题、跨页题、答案单独一页……
//   所以这里的分工是：
//     * 机器做**粗切分**（能覆盖常见格式，目标是"少漏不少收"）
//     * 再由**人工在面板里确认/修正**（S3 的必须环节，不是可选）
//   "全自动导入 100% 正确"是做不到的，承诺它只会让人失望。
//
// 零 ctx：只做字符串/字节处理，解析库调用通过参数注入或动态 import。

import { ANSWER_KIND, parseAnswer } from './answer.js';

/**
 * 支持的文件类型。
 *
 * 补齐：
 *   * 加 .docx / .xlsx 的实际支持（此前只列名不实现）
 *   * 加 .tsv（dispatch 早就有 .tsv 分支，SUPPORTED_EXT 却漏了 —— 下拉/校验会拒）
 *   * 加 .doc / .xls / .pdf 但**不静默接受**：它们能进到 bytesToText，
 *     由那里给出"另存为 .docx"这类可执行提示，而不是笼统报"不支持"。
 */
export const SUPPORTED_EXT = [
	'.txt',
	'.md',
	'.json',
	'.jsonl',
	'.csv',
	'.tsv',
	'.docx',
	'.xlsx',
	'.pdf',
	'.doc',
	'.xls',
];

export function extOf(file) {
	const m = String(file ?? '').match(/(\.[A-Za-z0-9]+)$/);
	return m ? m[1].toLowerCase() : '';
}

export function isSupported(file) {
	return SUPPORTED_EXT.includes(extOf(file));
}

/* ── 题号与选项的识别模式 ─────────────────────────────── */

// 题号：1. / 1、/ 第1题 / (1) / １．
const RE_QUESTION_NO = /^\s*(?:第\s*)?(\d{1,4})\s*[.、．)）:：]\s*(.*)$/;
const RE_QUESTION_NO2 = /^\s*[（(]\s*(\d{1,4})\s*[）)]\s*(.*)$/;
// 选项：A. / A、/ A) / A ／ (A)
const RE_OPTION = /^\s*[（(]?\s*([A-Fa-f])\s*[.、．)）:：]?\s+(.*)$/;
const RE_OPTION_TIGHT = /^\s*([A-F])\s*[.、．)）]\s*(.*)$/;
// 答案行：答案：A / 【答案】A / 正确答案是 A / 答案：3 / 答案：北京
//
// 旧实现是两个错误叠加：
//   ① 只允许 `[A-F]{1,6}|对|错|正确|错误|√|×` ——
//      数字（3、3.14）、裸 T/F、填空文本（北京）全都匹配不上，答案直接空。
//   ② 用 `A-F` 抓多选会把「A、C」只取到 A，丢一半。
// 现在改成「先切出答案段原文，交给 answer.js 判类型」，正则只负责定位。
const RE_ANSWER_LINE = /(?:答案|正确答案|参考答案|标准答案)\s*[】\]:：]?\s*(.{0,120})/;
// 兜底：有些题库把答案单独放在行首，如 "【答案】B"
const RE_ANSWER_BRACKET = /^[【\[]\s*(?:答案|正确答案)\s*[】\]]\s*(.{0,120})/;
// 题型标记
const RE_QTYPE = /^\s*(单选题|多选题|判断题|案例分析题|不定项选择题)\s*$/;

/**
 * 把纯文本切分成题目。
 *
 * 策略：以"题号"为分隔符；每块内再抽选项、答案、题型。
 * 兼容没有题号的题库（用空行分隔 + 选项存在来判定）。
 *
 * @param {string} text
 * @returns {{ items: Array, warnings: string[] }}
 */
export function splitTextIntoItems(text) {
	const warnings = [];
	const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

	// 状态机：把「题型行 / 题号行 / 选项行 / 答案行 / 正文」分开处理。
	// 关键教训：
	//   1. 题型行本身**永远不是题干** —— 否则会出现空题干、题数虚高
	//   2. 题型行可能出现在题号前，也可能在上题答案后 —— 都要归给"下一题"
	//   3. 只有块里真有题干才算一道题
	let cur = null;
	let pendingQtype = '';
	let sawNumbered = false;
	const blocks = [];

	const flush = () => {
		if (cur && String(cur.stem ?? '').trim()) blocks.push(cur);
		cur = null;
	};

	const newBlock = (no, stem) => ({
		no,
		stem: String(stem ?? '').trim(),
		options: [],
		answer: '',
		qtype: pendingQtype || '',
	});

	for (const raw of lines) {
		const line = raw.replace(/\t/g, ' ').trim();
		if (!line) {
			// 空行只在"当前块已经有选项"时断块，避免把多行题干切断
			if (cur && cur.options.length > 0) flush();
			continue;
		}

		// ── 1. 题型行（最高优先级，永远不当题干）──
		const mType = line.match(RE_QTYPE);
		if (mType) {
			if (cur && !cur.answer && cur.options.length === 0) {
				// 当前题还没选项/答案 → 这是本题的题型
				cur.qtype = cur.qtype || mType[1];
			} else {
				// 否则归给下一题
				pendingQtype = mType[1];
				if (cur && cur.answer) flush();
			}
			continue;
		}

		// ── 2. 题号行 ──
		const mNo = line.match(RE_QUESTION_NO) ?? line.match(RE_QUESTION_NO2);
		if (mNo) {
			sawNumbered = true;
			flush();
			cur = newBlock(Number(mNo[1]), (mNo[2] ?? '').trim());
			pendingQtype = '';
			if (!cur.stem) cur.stem = '';
			continue;
		}

		// ── 3. 还没有块：这一行就是题干 ──
		if (!cur) {
			cur = newBlock(null, line);
			pendingQtype = '';
			continue;
		}

		// ── 4. 答案行 ──
		// 先按行定位（不再在正则里硬编码答案枚举），再交给 parseAnswer 判类型。
		const mAns = line.match(RE_ANSWER_BRACKET) ?? line.match(RE_ANSWER_LINE);
		if (mAns) {
			const parsed = parseAnswer(mAns[1]);
			if (parsed.kind !== ANSWER_KIND.EMPTY) {
				// 用规范化后的值落库：字母排序去重、T/F 统一大小写。
				// 文本/数字答案原样保留 —— 这是旧实现丢答案的修复点。
				cur.answer = parsed.value;
				cur.answerKind = parsed.kind;
				continue;
			}
			// 定位到"答案"但后面没内容：说明这题的答案在别处（下一行 / 答案汇总页）
			cur.answerMissing = true;
			continue;
		}

		// ── 5. 选项行 ──
		const mOpt = line.match(RE_OPTION) ?? line.match(RE_OPTION_TIGHT);
		if (mOpt) {
			cur.options.push({ letter: mOpt[1].toUpperCase(), text: (mOpt[2] ?? '').trim() });
			continue;
		}

		// ── 6. 普通文本 ──
		if (cur.options.length > 0) {
			// 选项续行
			const last = cur.options[cur.options.length - 1];
			last.text = (last.text + ' ' + line).trim();
		} else if (!cur.stem) {
			cur.stem = line;
		} else {
			// 题干续行
			cur.stem = (cur.stem + ' ' + line).trim();
		}
	}
	flush();

	if (!sawNumbered && blocks.length > 1) {
		warnings.push('未发现题号，按空行/选项切分，请人工核对题目边界');
	}

	const items = blocks.map((b) => {
		const normalized = normalizeAnswerForItem(b);
		return {
			qtype: b.qtype || inferQtype(b),
			stem: b.stem,
			options: b.options,
			answer: normalized.value,
			answerKind: normalized.kind,
			no: b.no,
		};
	});

	if (items.length === 0) {
		warnings.push('没有切分出任何题目：确认文件里有"1. 题干 / A. 选项 / 答案：A"这样的结构');
	}

	// 答案缺失/异常要显式告警 —— 静默丢掉是最坏的失败方式
	const noAnswer = items.filter((it) => !it.answer).length;
	if (noAnswer > 0) {
		warnings.push(`${noAnswer} 道题没有识别到答案（可用「答案：」行补，或入库后在面板里逐条补录）`);
	}
	const textAns = items.filter((it) => it.answerKind === ANSWER_KIND.TEXT).length;
	if (textAns > 0) {
		warnings.push(`${textAns} 道题的答案是文本（填空/简答），会自动保留，但需确认没有误吞下一行题干`);
	}

	return { items, warnings };
}

/**
 * 按题目自身的选项数重新判定答案类型。
 *
 * 为什么要二次判定：切分时答案行先于"后面还有几个选项"被读到，
 * 那时还不知道 optionCount。而 "T"/"F" 的类型依赖选项数
 * （2 选 1 场景下 T 可能是选项名，4 选项场景下一定是判断题）。
 */
function normalizeAnswerForItem(b) {
	const raw = String(b.answer ?? '').trim();
	if (!raw) return { value: '', kind: ANSWER_KIND.EMPTY };
	const r = parseAnswer(raw, { optionCount: (b.options ?? []).length });
	return { value: r.value, kind: r.kind };
}

export function inferQtype(block) {
	const n = (block.options ?? []).length;
	// 关键修复：不再只看"答案长得像不像 A-F"。
	// 旧实现里文本答案（北京）、数字答案（3.14）都会落到最后的 return ''，
	// 于是这种题连题型都没有，入库后既不能按题型匹配、也没法补录。
	const ans = parseAnswer(block.answer, { optionCount: n });

	// 1) 判断型答案 → 判断题（与选项数无关：写着"对/错"就是判断题）
	if (ans.kind === ANSWER_KIND.BOOL) return '判断题';
	// 2) 多字母 → 多选题（优先级高于选项数）
	if (ans.kind === ANSWER_KIND.CHOICE && ans.letters.length >= 2) return '多选题';
	// 3) 无选项、答案是文本/数值 → 填空/简答
	if (n === 0 && (ans.kind === ANSWER_KIND.TEXT || ans.kind === ANSWER_KIND.NUMBER)) {
		return ans.kind === ANSWER_KIND.NUMBER ? '填空题' : '简答题';
	}
	// 4) 仅 2 个选项且答案单字母：两选一，按判断题处理更贴近实际
	if (n === 2) return '判断题';
	// 5) 3 个以上选项 + 单字母 → 单选
	if (n >= 3 && ans.kind === ANSWER_KIND.CHOICE) return '单选题';
	// 6) 有选项但答案类型对不上（文本/缺答案）→ 至少按选项数给个兜底题型，
	//    不要留空让下游无从下手
	if (n >= 3) return '单选题';
	if (n > 0) return '判断题';
	return '';
}

/* ── CSV / TSV ─────────────────────────────────────────── */

/**
 * 解析 CSV/TSV。支持带表头的 "题干,选项A,选项B,...,答案" 结构。
 */
export function parseCsv(text, { delimiter } = {}) {
	const t = String(text ?? '').replace(/\r\n?/g, '\n');
	const firstLine = t.split('\n')[0] ?? '';
	const d = delimiter ?? (firstLine.includes('\t') ? '\t' : ',');

	const rows = [];
	let field = '';
	let row = [];
	let inQuote = false;

	for (let i = 0; i < t.length; i++) {
		const c = t[i];
		if (inQuote) {
			if (c === '"') {
				if (t[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					inQuote = false;
				}
			} else {
				field += c;
			}
			continue;
		}
		if (c === '"') {
			inQuote = true;
			continue;
		}
		if (c === d) {
			row.push(field);
			field = '';
			continue;
		}
		if (c === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			continue;
		}
		field += c;
	}
	if (field || row.length) {
		row.push(field);
		rows.push(row);
	}

	if (rows.length === 0) return { items: [], warnings: ['CSV 为空'] };

	// 识别表头
	const header = rows[0].map((h) => h.trim().toLowerCase());
	const hasHeader = header.some((h) => /题干|题目|stem|question/.test(h));
	const body = hasHeader ? rows.slice(1) : rows;

	const warnings = [];
	const col = (names) => header.findIndex((h) => names.some((n) => h.includes(n)));
	const iStem = hasHeader ? col(['题干', '题目', 'stem', 'question']) : 0;
	const iAnswer = hasHeader ? col(['答案', 'answer']) : -1;
	const iQtype = hasHeader ? col(['题型', 'type']) : -1;

	// 选项列：A/B/C/D 或 选项A
	const optCols = [];
	for (let i = 0; i < header.length; i++) {
		const h = header[i];
		const m = h.match(/^(?:选项)?\s*([a-f])$/);
		if (m) optCols.push({ index: i, letter: m[1].toUpperCase() });
	}

	const items = [];
	for (const r of body) {
		const stem = String(r[iStem] ?? '').trim();
		if (!stem) continue;
		const options = optCols
			.map(({ index, letter }) => ({ letter, text: String(r[index] ?? '').trim() }))
			.filter((o) => o.text);
		items.push({
			stem,
			options,
			answer: iAnswer >= 0 ? String(r[iAnswer] ?? '').trim().toUpperCase() : '',
			qtype: iQtype >= 0 ? String(r[iQtype] ?? '').trim() : '',
		});
	}
	if (optCols.length === 0) warnings.push('未识别到选项列（表头需含 A/B/C/D 或 选项A/选项B）');
	if (iAnswer < 0) warnings.push('未识别到答案列');
	return { items, warnings };
}

/* ── JSON / JSONL ──────────────────────────────────────── */

export function parseJsonBank(text) {
	const t = String(text ?? '').trim();
	const warnings = [];
	let data;
	try {
		data = JSON.parse(t);
	} catch {
		// 尝试 JSONL
		const items = [];
		for (const line of t.split('\n')) {
			const s = line.trim();
			if (!s) continue;
			try {
				items.push(JSON.parse(s));
			} catch {
				/* 跳过坏行 */
			}
		}
		if (items.length === 0) return { items: [], warnings: ['JSON 解析失败'] };
		warnings.push('按 JSONL 解析');
		return { items, warnings };
	}

	// 兼容 {items:[...]} / {questions:[...]} / 直接数组
	if (Array.isArray(data)) return { items: data, warnings };
	if (data && typeof data === 'object') {
		for (const key of ['items', 'questions', 'data', 'list']) {
			if (Array.isArray(data[key])) return { items: data[key], warnings };
		}
	}
	return { items: [], warnings: ['JSON 结构里找不到题目数组（期望 items/questions/直接数组）'] };
}

/**
 * 统一入口：按扩展名分派。
 *
 * 二进制格式（docx/pdf/xlsx）需要外部解析，这里返回一个"需要外部解析"的标记，
 * 由宿主侧用 python 或专用库处理后再回来调 splitTextIntoItems。
 * 这样做是为了保持 core 层零依赖、可单测。
 */
export function dispatch(text, ext) {
	const e = String(ext ?? '').toLowerCase();
	if (e === '.json') return parseJsonBank(text);
	if (e === '.jsonl') return parseJsonBank(text);
	if (e === '.csv') return parseCsv(text);
	if (e === '.tsv') return parseCsv(text, { delimiter: '\t' });
	// .txt / .md 以及二进制格式抽取出的纯文本
	return splitTextIntoItems(text);
}
