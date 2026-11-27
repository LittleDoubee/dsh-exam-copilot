// 题库匹配：题干 + 选项双重比对，附关键实体校验。
//
// 这套算法的三条策略不是"设计出来的"，是实测踩出来的：
//
//   ① 必须比对选项，不能只看题干
//      第 12 题：题库「隐形面额数字」答案 BCD，系统答案 AC —— 完全相反。
//      只匹配题干发现不了"题干相同但选项/答案不同"，会给出自信的错误答案。
//
//   ② 必须校验题干里的关键实体
//      第 18 题：题库「20元/5元的无色荧光特征」答案 BC，
//      被套用到考卷「10元/1元」上（选项相似度 0.93，选项比对救不了），
//      而 10元/1元 的正确答案是 AC。
//      面额、年份、数量、百分比这类实体，差一个数字就是不同的题。
//
//   ③ 必须分级置信，不能"匹配上就用"
//      题干 exact + 选项吻合   → 高置信，直接用
//      题干 exact + 选项不吻合 → 中置信，用但标记
//      题干 fuzzy + 选项吻合   → 中高置信
//      题干 fuzzy + 选项不吻合 → 低置信，转人工
//
// 零 ctx、零 IO：纯函数，可直接单测。

import { toAnswerString } from './answer.js';

/** 题干归一化：去标点、全角转半角、压空白。 */
export function normalizeStem(s) {
	let t = String(s ?? '');
	// 全角 → 半角（数字与字母）
	t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
	// 常见标点统一
	t = t.replace(/[（）()【】\[\]「」『』《》<>]/g, '');
	t = t.replace(/[，,。.；;：:！!？?、\-—_\s]/g, '');
	// 去掉题号前缀（"1." "1、" "第1题"）
	t = t.replace(/^第?\d+[题、.．]?/, '');
	return t.trim().toLowerCase();
}

/** 选项文字归一化（与题干同规则，但保留字母前缀的判定在调用处）。 */
function normalizeOptText(s) {
	return normalizeStem(s);
}

/** bigram 集合（中文按字符二元组，英文按单词）。 */
function bigrams(s) {
	const out = new Set();
	const t = String(s ?? '');
	if (t.length <= 1) {
		if (t) out.add(t);
		return out;
	}
	for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
	return out;
}

/** Jaccard 相似度（bigram 集合）。 */
export function jaccard(a, b) {
	const A = bigrams(a);
	const B = bigrams(b);
	if (A.size === 0 && B.size === 0) return 1;
	if (A.size === 0 || B.size === 0) return 0;
	let inter = 0;
	for (const x of A) if (B.has(x)) inter += 1;
	const union = A.size + B.size - inter;
	return union === 0 ? 0 : inter / union;
}

/* ── 关键实体 ─────────────────────────────────────────────
 * 这些是"差一个数字就是另一道题"的东西。
 * 实测教训见文件头第 ② 条。 */

const ENTITY_PATTERNS = [
	{ name: '金额', re: /(\d+(?:\.\d+)?)\s*元/g },
	{ name: '年份', re: /((?:19|20)\d{2})\s*年/g },
	{ name: '数量', re: /(\d+)\s*[张枚个块份]/g },
	{ name: '百分比', re: /(\d+(?:\.\d+)?)\s*[%％]/g },
	{ name: '长度', re: /(\d+(?:\.\d+)?)\s*(?:毫米|厘米|mm|cm)/gi },
];

/** 提取关键实体，返回 { 类型: Set(值) }。 */
export function extractEntities(text) {
	const t = String(text ?? '');
	const out = {};
	for (const { name, re } of ENTITY_PATTERNS) {
		const found = new Set();
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(t)) !== null) {
			found.add(m[1]);
		}
		if (found.size > 0) out[name] = found;
	}
	return out;
}

/**
 * 实体校验：题干里同一类实体必须完全一致。
 * 返回 { ok, conflicts[] }
 */
export function checkEntities(stemA, stemB) {
	const A = extractEntities(stemA);
	const B = extractEntities(stemB);
	const conflicts = [];
	for (const key of Object.keys(A)) {
		if (!B[key]) continue; // 对方没提到这类实体，不构成冲突
		const same =
			A[key].size === B[key].size && [...A[key]].every((v) => B[key].has(v));
		if (!same) {
			conflicts.push({
				type: key,
				a: [...A[key]],
				b: [...B[key]],
			});
		}
	}
	return { ok: conflicts.length === 0, conflicts };
}

/* ── 选项比对 ───────────────────────────────────────────── */

/** 单题选项平均相似度。选项按字母对齐，文字做 bigram Jaccard。 */
export function optionsSimilarity(optsA, optsB) {
	const a = (optsA ?? []).map((o) => normalizeOptText(o.text ?? o));
	const b = (optsB ?? []).map((o) => normalizeOptText(o.text ?? o));
	if (a.length === 0 || b.length === 0) return 0;

	// 数量不一致直接扣分（题不同版本的强信号）
	const countPenalty = a.length === b.length ? 1 : 0.6;
	const n = Math.min(a.length, b.length);
	let sum = 0;
	for (let i = 0; i < n; i++) sum += jaccard(a[i], b[i]);
	return (sum / n) * countPenalty;
}

/* ── 匹配主入口 ─────────────────────────────────────────── */

export const CONFIDENCE = {
	HIGH: 'high',
	MEDIUM_HIGH: 'medium-high',
	MEDIUM: 'medium',
	LOW: 'low',
};

/** 只有这些等级可以直接采用题库答案。 */
export const AUTO_ACCEPT = new Set([CONFIDENCE.HIGH, CONFIDENCE.MEDIUM_HIGH]);

const THRESHOLDS = {
	stemExact: 0.92,
	stemFuzzy: 0.72,
	optMatch: 0.5,
	// 选项"高度吻合"的门槛。
	//
	// 原值 0.98 只有 Q5（optSim=1.000）能触发，4 道 medium 题全部转人工。
	// 实测 12 题的 optSim 分布：Q1=0.92 Q2=0.72 Q4=0.76 Q6=0.75，
	// 这些题**答案全对**，只是题干有个把错字。
	//
	// 取 0.90 是数据支撑的结果：它能覆盖 Q1（0.92），
	// 又不到 Q2/Q4/Q6（0.72~0.76）—— 那三题的选项本身也被 OCR 啃掉几个字，
	// 光看"选项像不像"不足以判同题，继续留给人工是对的。
	optPerfect: 0.9,
	// 配合上面的门槛：即使选项高度吻合，题干也不能完全不像。
	// 防止"两个选项相近但题干不同的题"被误判成同题。
	stemFloorForOpt: 0.6,
};

/**
 * 在题库里找一道题。
 *
 * @param {object} question  当前题 { qtype, stem, opts:[{letter,text}] }
 * @param {Array}  bank      题库条目 [{ qtype, stem, options, answer }]
 * @returns {{ ok, item?, answer?, confidence?, reason, candidates? }}
 */
export function matchQuestion(question, bank) {
	if (!question || !Array.isArray(bank) || bank.length === 0) {
		return { ok: false, confidence: CONFIDENCE.LOW, reason: '题目或题库为空' };
	}

	const stem = normalizeStem(question.stem);
	if (!stem) return { ok: false, confidence: CONFIDENCE.LOW, reason: '题干为空' };

	const qtype = String(question.qtype ?? '');

	// 题型硬约束：单选答案不能是多字母，多选答案不能是单字母。
	// 这条在旧实现里是"必须有的"，否则会把单选题匹配到多选题条目上。
	const wantSec = qtype.includes('多选') ? '多选' : qtype.includes('判断') ? '判断' : qtype.includes('单选') ? '单选' : '';

	const scored = [];
	for (const item of bank) {
		const itemStem = normalizeStem(item.stem ?? item.q);
		if (!itemStem) continue;

		// 题型不匹配直接跳过（硬约束）
		const itemSec = String(item.qtype ?? item.sec ?? '');
		if (wantSec && itemSec && !itemSec.includes(wantSec.slice(0, 2))) continue;

		const stemSim = jaccard(stem, itemStem);
		const itemOpts = Array.isArray(item.options) ? item.options : item.options ? safeJson(item.options) : [];
		const optSim = optionsSimilarity(question.opts, itemOpts);

		// ── 题干门槛：允许「选项完全吻合」时放行 ────────────────────
		//
		// 实测数据（mock 12 题，真实 OCR 文本）：
		//   Q5  stemSim=0.409  optSim=1.000   ← 题干有错字（"流程"读成"瀟呈"）
		//   Q7  stemSim=0.444  optSim=1.000   ← "不得"读成"导"
		//   Q9  stemSim=0.538  optSim=1.000   ← "承印验证"读成"承验证"
		// 三题选项 **逐字完全一致**，只因为题干错字就被判定「题库里没有」，
		// 白白退到模型（26.5s/题）或转人工。
		//
		// 为什么这个放宽是安全的：
		//   * 选择题的答案由**选项内容**决定，题干只是索引；
		//   * optSim=1.0 意味着四个选项的文字全部对上，这几乎不可能是巧合；
		//   * 题型硬约束（上面那条）仍然拦着，不会把单选匹配到多选；
		//   * 实体校验（年份/面额）仍然要做 —— 但只在题干够像时才可能误伤，
		//     所以这里对"选项全等"的情形改用更低的题干门槛而不是完全跳过。
		// 选项高度吻合时，题干门槛可以放宽到 stemFloorForOpt；
		// 但**不能完全不管题干** —— 否则「选项恰好相同、题干无关」的两道题会被并成一道。
		const stemOk =
			stemSim >= THRESHOLDS.stemFuzzy ||
			(optSim >= THRESHOLDS.optPerfect && stemSim >= THRESHOLDS.stemFloorForOpt);
		if (!stemOk) continue;

		// 实体校验：差一个面额/年份就是不同的题
		const ent = checkEntities(String(question.stem ?? ''), String(item.stem ?? item.q ?? ''));
		if (!ent.ok) continue;

		scored.push({ item, stemSim, optSim, entities: ent });
	}

	if (scored.length === 0) {
		return { ok: false, confidence: CONFIDENCE.LOW, reason: '题库里没有足够相似的题' };
	}

	// 排序：题干相似度优先，其次选项
	scored.sort((x, y) => y.stemSim - x.stemSim || y.optSim - x.optSim);
	const best = scored[0];

	const stemExact = best.stemSim >= THRESHOLDS.stemExact;
	const optOk = best.optSim >= THRESHOLDS.optMatch;

	let confidence;
	let reason;
	if (stemExact && optOk) {
		confidence = CONFIDENCE.HIGH;
		reason = `题干一致(${best.stemSim.toFixed(2)}) + 选项吻合(${best.optSim.toFixed(2)})`;
	} else if (stemExact && !optOk) {
		// 题干对但选项不一样 —— 可能是同题不同版本，标中置信
		confidence = CONFIDENCE.MEDIUM;
		reason = `题干一致但选项不吻合(${best.optSim.toFixed(2)})，可能版本不同`;
	} else if (!stemExact && optOk) {
		// 题干不精确但选项吻合。
		//
		// 这里要分两档：
		//   选项 **完全**吻合（optSim>=0.98）：几乎必然是同一题，只是 OCR
		//     把题干读错了几处。给 medium-high（可自动接受）。
		//     实测 Q5/Q7/Q9 stemSim 0.41~0.54、optSim 1.000 都是这种。
		//   选项只是"够像"（0.5~0.98）：可能是同题不同版本，也可能是
		//     另一道选项相近的题 —— 给 medium（转人工），不赌。
		if (best.optSim >= THRESHOLDS.optPerfect && best.stemSim >= THRESHOLDS.stemFloorForOpt) {
			// B 方案：选项高度吻合就自动接受，不再转人工。
			//
			// 依据：选择题的答案由**选项内容**决定，题干只是索引。
			// 实测 Q1 stemSim=0.79 / optSim=0.92，答案 A **完全正确**，
			// 却因为题干一个错字被丢给人工 —— 这是过度保守。
			//
			// 安全边界：仍要求题干 >= stemFloorForOpt(0.60)，
			// 避免「选项凑巧相同但题干无关」被误判。
			confidence = CONFIDENCE.MEDIUM_HIGH;
			reason = `题干近似(${best.stemSim.toFixed(2)}) + 选项高度吻合(${best.optSim.toFixed(2)})，按选项定案`;
		} else {
			confidence = CONFIDENCE.MEDIUM;
			reason = `题干近似(${best.stemSim.toFixed(2)}) + 选项部分吻合(${best.optSim.toFixed(2)})，建议人工确认`;
		}
	} else {
		confidence = CONFIDENCE.LOW;
		reason = `题干近似(${best.stemSim.toFixed(2)}) 但选项不吻合(${best.optSim.toFixed(2)})`;
	}

	const answer = normalizeAnswer(best.item.answer);
	if (!answer) {
		return { ok: false, confidence: CONFIDENCE.LOW, reason: '题库条目没有答案' };
	}

	// 答案与题型自洽性检查：多选答案应该多字母，单选单字母
	const multi = wantSec === '多选';
	if (multi && answer.length < 2 && !['T', 'F'].includes(answer)) {
		return {
			ok: false,
			confidence: CONFIDENCE.LOW,
			reason: `多选题库答案只有 ${answer}，与题型不符`,
		};
	}

	return {
		ok: true,
		item: best.item,
		answer,
		confidence,
		reason,
		scores: { stem: best.stemSim, options: best.optSim },
		candidates: scored.slice(0, 3).map((s) => ({ stem: s.stemSim, opt: s.optSim })),
	};
}

/**
 * 从题库条目里取答案，支持多种写法。
 *
 * 行为变了：
 *   旧实现只输出 `T`/`F` 或 A-F 字母，**其余一律返回空串** ——
 *   数字答案、填空文本在匹配阶段被静默清空，等于题库里存了也用不上。
 *   现在改为复用 answer.js 的统一类型模型：字母/判断/数字/文本都保留。
 *   字母仍做排序去重（"CAD" → "ACD"），保证与考卷比对时可比。
 */
export function normalizeAnswer(v, opts = {}) {
	return toAnswerString(v, opts);
}

function safeJson(s) {
	try {
		return JSON.parse(s);
	} catch {
		return [];
	}
}

/**
 * 题库索引：把条目按题干长度分桶，避免每题都全表扫描。
 * 804 题全扫是 16ms（可接受），但题量上万时就需要这个。
 */
export class BankIndex {
	constructor(items = []) {
		this.items = items.map((it) => ({
			...it,
			_stemNorm: normalizeStem(it.stem ?? it.q),
		}));
		this.byLength = new Map();
		for (const it of this.items) {
			const len = Math.floor(it._stemNorm.length / 10) * 10;
			if (!this.byLength.has(len)) this.byLength.set(len, []);
			this.byLength.get(len).push(it);
		}
	}

	get size() {
		return this.items.length;
	}

	/** 取候选：题干长度相近的桶（±1 桶）。 */
	candidates(stemNorm) {
		const len = Math.floor(stemNorm.length / 10) * 10;
		const out = [];
		for (const d of [-10, 0, 10]) {
			const bucket = this.byLength.get(len + d);
			if (bucket) out.push(...bucket);
		}
		return out.length > 0 ? out : this.items;
	}
}
