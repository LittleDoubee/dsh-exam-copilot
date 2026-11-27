// 答案类型模型：把「答案」从"一个字符串"变成"一个带类型的值"。
//
// 为什么必须改：
//   旧实现里答案只有一个字符串，且所有解析都假设它是 A-F 字母。
//   实测会静默丢答案的写法：
//     答案：3       → 数字题，正则 [A-F]{1,6} 不匹配，答案为空
//     答案：T       → 判断题的裸 T/F，正则枚举里没有，答案为空
//     答案：3.14    → 同上
//     答案：北京     → 填空题文本，完全不匹配
//     答案：A、C    → 多选带顿号，只抓到 A，丢一半
//   更糟的是 bank.js 的 normalizeAnswer 也只会输出 A-F/T/F，
//   所以就算上面切出来了，入库时仍会被清空 —— 双重丢失。
//
// 设计取舍：**不引入"题型"作为唯一判据**。
//   真实题库里"答案：A"到底单选还是多选、"答案：T"到底判断题还是
//   选了 T 这个选项，光看答案本身判断不了。所以这里只做
//   「把值按最保守的类型解析出来」，题型由调用方结合选项数决定。

/** 答案类型。用字符串常量而不是 TS enum，方便直接 JSON 落库。 */
export const ANSWER_KIND = {
	CHOICE: 'choice', // 选择：一个或多个选项字母
	BOOL: 'bool', // 判断：真/假
	NUMBER: 'number', // 数值：3 / 3.14 / -2 / 1/2（分数按原文保留）
	TEXT: 'text', // 文本：填空、简答
	EMPTY: 'empty', // 没有答案
};

/* ── 判断型写法 ───────────────────────────────────────────
 * 这一类必须最先判：单个 "T"/"F" 也是合法选项字母的表象，
 * 但在判断题语境下它是对错。这里按"最常见的语义"取判断，
 * 调用方若已知是选择题，会用 letters 字段区分（见 parseAnswer 返回）。 */

const TRUE_FORMS = new Set(['对', '正确', '是', '真', '√', '✓', 'TRUE', 'T', 'YES', 'Y', '1']);
const FALSE_FORMS = new Set(['错', '错误', '否', '假', '×', '✗', 'X', 'FALSE', 'F', 'NO', 'N', '0']);

/** 判断题统一成 'T' / 'F'，其他返回 ''。 */
export function normalizeBool(v) {
	const s = String(v ?? '').trim().toUpperCase();
	if (!s) return '';
	if (TRUE_FORMS.has(s)) return 'T';
	if (FALSE_FORMS.has(s)) return 'F';
	return '';
}

/* ── 数值型 ───────────────────────────────────────────────
 * 保留原始写法（不转 float）：题库里 "1/2"、"3.14"、"０.５" 都要原样留住，
 * 转成浮点会丢精度、也会让"跟考卷上不一样的写法"变成误判。 */

const NUM_RE = /^[-+]?[\d０-９]+(?:[.．][\d０-９]+)?(?:\/[\d０-９]+)?%?$/;

export function looksNumeric(v) {
	const s = String(v ?? '')
		.trim()
		.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
		.replace(/．/g, '.')
		.replace(/[％]/g, '%');
	return NUM_RE.test(s) && s.length > 0;
}

/* ── 选项字母 ─────────────────────────────────────────────
 * 只能认 A-H。超过 H 的选项在真实考试里极罕见，放宽会让
 * "答案是 HELIX 这种词"被误当成 5 个选项。 */

const MAX_LETTERS = 'ABCDEFGH';

/**
 * 从任意写法里抽出选项字母集合。
 *
 * 支持：ABC / A,B,C / A、B、C / A B C / （A）（C）/ 选项A和C / A或C
 * 返回 { letters:'AC', hadSeparators:bool }
 */
export function extractLetters(v) {
	const raw = String(v ?? '').toUpperCase();
	if (!raw.trim()) return { letters: '', hadSeparators: false };

	// 先看是否"整串就是字母组合"——最常见、也最安全
	const tight = raw.replace(/[\s,，、;；/&和与或]/g, '');
	if (/^[A-H]{1,8}$/.test(tight)) {
		return {
			letters: uniqSorted(tight),
			hadSeparators: /[\s,，、;；/&和与或]/.test(raw),
		};
	}

	// 再处理带前缀/后缀的：选项A、第B项、（C）、选A
	// 只在"字母单独成词"时才收，避免把单词里的大写字母算进来
	const found = [];
	const re = /(?:^|[^A-Z0-9])([A-H])(?=$|[^A-Z0-9])/g;
	let m;
	while ((m = re.exec(raw)) !== null) found.push(m[1]);

	// "选项A和C" 这种：A 前面有中文，C 是孤立的，上面那遍能抓全
	if (found.length > 0) {
		return { letters: uniqSorted(found.join('')), hadSeparators: true };
	}
	return { letters: '', hadSeparators: false };
}

function uniqSorted(s) {
	return [...new Set(String(s).split(''))].sort().join('');
}

/* ── 主入口 ─────────────────────────────────────────────── */

/**
 * 解析答案。
 *
 * @param {*} value            原始答案（字符串/数组/数字）
 * @param {object} [opts]
 * @param {number} [opts.optionCount] 该题选项数。用于消解 "T" 的歧义：
 *   4 个选项时 "T" 几乎不可能是选项字母（一般只有 A-D），更像判断题的"真"；
 *   而 2 个选项时 "T"/"F" 更可能是选项字母（True/False 两选一）。
 * @returns {{
 *   kind: string,        // ANSWER_KIND.*
 *   value: string,       // 规范化后的展示值：'AC' / 'T' / '3.14' / '北京'
 *   letters: string,     // 仅 choice 有意义
 *   bool: string,        // 仅 bool 有意义：'T'/'F'
 *   raw: string,         // 原始输入（排查用）
 *   reason: string       // 为什么判成这个类型（面板上给人看）
 * }}
 */
export function parseAnswer(value, opts = {}) {
	const raw = Array.isArray(value) ? value.join('') : value == null ? '' : String(value);
	const s = raw.trim();
	const empty = { kind: ANSWER_KIND.EMPTY, value: '', letters: '', bool: '', raw, reason: '答案为空' };
	if (!s) return empty;

	const optionCount = Number(opts.optionCount);

	// ① 多字母：一定是选择题。必须先判，否则 "AB" 会被下面的判断型逻辑吃掉半个
	const letters = extractLetters(s);
	if (letters.letters.length >= 2) {
		return {
			kind: ANSWER_KIND.CHOICE,
			value: letters.letters,
			letters: letters.letters,
			bool: '',
			raw,
			reason: `识别为 ${letters.letters.length} 个选项`,
		};
	}

	// ② 判断型写法
	const b = normalizeBool(s);
	if (b) {
		// 2 选项 + 答案是 T/F 时存在歧义：可能是 True/False，
		// 也可能是选了选项 T（少数平台会把选项标成 T/F）。
		// 统一判成 bool —— 下游 _decide 对 bool 会按"第 1/第 2 个选项"点击，
		// 与"选 T/F 选项"在 2 选项场景下落点相同，因此这个歧义无害。
		return {
			kind: ANSWER_KIND.BOOL,
			value: b,
			letters: b === 'T' ? 'A' : 'B',
			bool: b,
			raw,
			reason: b === 'T' ? '判断为真' : '判断为假',
		};
	}

	// ③ 单字母：选择题
	if (letters.letters.length === 1) {
		// 只有一个选项的题很可能是题库脏数据，仍然如实记下
		return {
			kind: ANSWER_KIND.CHOICE,
			value: letters.letters,
			letters: letters.letters,
			bool: '',
			raw,
			reason: optionCount === 1 ? '单选项' : '单个选项',
		};
	}

	// ④ 数值
	if (looksNumeric(s)) {
		return { kind: ANSWER_KIND.NUMBER, value: s, letters: '', bool: '', raw, reason: '数值答案' };
	}

	// ⑤ 其余一律当文本（填空/简答）。**不再丢弃** ——
	//    旧实现在这里 return ''，导致所有非字母答案静默消失。
	return {
		kind: ANSWER_KIND.TEXT,
		value: s,
		letters: '',
		bool: '',
		raw,
		reason: '文本答案（填空/简答）',
	};
}

/**
 * 兼容层：把 parseAnswer 的结果压回「单个字符串」。
 *
 * 仍然保留这个函数，因为已有调用点（runner/面板/落库）都期待字符串。
 * 行为改进：不再丢掉非字母答案 —— 数值和文本原样返回。
 */
export function toAnswerString(value, opts = {}) {
	const r = parseAnswer(value, opts);
	if (r.kind === ANSWER_KIND.BOOL) return r.bool;
	return r.value;
}

/**
 * 校验答案与题型是否自洽。返回问题描述数组（空数组 = 没问题）。
 *
 * 这条是为了把"题库脏数据"在上传时就暴露出来，而不是等到跑的时候
 * 点错选项才被发现。
 */
export function validateAnswer(value, qtype = '', optionCount = 0) {
	const issues = [];
	const r = parseAnswer(value, { optionCount });
	const t = String(qtype ?? '');

	if (r.kind === ANSWER_KIND.EMPTY) {
		issues.push('答案为空');
		return issues;
	}
	if (r.kind === ANSWER_KIND.CHOICE) {
		if (t.includes('多选') && r.letters.length < 2) {
			issues.push(`多选但答案只有 1 个选项（${r.value}）`);
		}
		if (t.includes('单选') && r.letters.length > 1) {
			issues.push(`单选但答案有 ${r.letters.length} 个选项（${r.value}）`);
		}
		if (optionCount > 0) {
			const max = String.fromCharCode(64 + optionCount);
			for (const ch of r.letters) {
				// 注意：这里必须用 includes / 码点比较，不能用 `ch > MAX_LETTERS`。
				// 字符串比较是逐字符的：'C' > 'ABCDEFGH' 为 true（'C' > 'A'），
				// 会把合法答案 C 误报成越界。
				if (!MAX_LETTERS.includes(ch) || ch.charCodeAt(0) > max.charCodeAt(0)) {
					issues.push(`答案含 ${ch}，但该题只有 ${optionCount} 个选项（最多到 ${max}）`);
				}
			}
		}
	}
	if (r.kind === ANSWER_KIND.TEXT && (t.includes('单选') || t.includes('多选'))) {
		issues.push(`选择题的答案是文本「${r.value.slice(0, 20)}」，可能切分错行`);
	}
	return issues;
}
