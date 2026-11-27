// 多题库匹配：跨库全局打分，而不是"按数组顺序，谁的第一个命中就用谁"。
//
// 为什么必须改：
//   旧实现（index.js buildBankMatcher）是这么走的：
//     for (id of bankIds) { r = match(id); if (高置信) return r }
//   问题很具体 —— **第 1 个库出 medium-high(0.85) 就采纳，
//   第 2 个库其实有 high(0.95) 却没机会比较**。
//   库越多，这个偏差越明显；而题库恰恰是会越攒越多的东西。
//
//   正确做法：所有库都打一遍分 → 全局排序 → 取最优那一条。
//   代价是要多扫几个库，但题库文件都是本地 JSONL，
//   4000 题 × 5 库仍是毫秒级，不值得为这点开销牺牲正确性。
//
// 另外补两件旧实现缺的事：
//   ① **未命中要记录**（misses）。只记命中等于没有反馈闭环：
//      跑完一场考试你不知道漏了哪些题、该补什么。
//   ② 库集合变了要重建索引。旧实现只在单个库 updatedAt 变化时失效，
//      但"启用了新题库"改的是 profile，不碰任何一个库的 updatedAt。

import { CONFIDENCE, matchQuestion } from './bank.js';

/** 置信度排序权重：高置信永远压过低置信，不受相似度小数影响。 */
const CONF_RANK = {
	[CONFIDENCE.HIGH]: 3,
	[CONFIDENCE.MEDIUM_HIGH]: 2,
	[CONFIDENCE.MEDIUM]: 1,
	[CONFIDENCE.LOW]: 0,
};

/** 只有这些等级可直接采用。与 bank.js 的 AUTO_ACCEPT 保持一致。 */
const AUTO_ACCEPT = new Set([CONFIDENCE.HIGH, CONFIDENCE.MEDIUM_HIGH]);

/**
 * 在多个题库里找这道题。
 *
 * @param {object}   question  当前题 { qtype, stem, opts }
 * @param {Array}    banks     [{ id, index }]，index 为 BankIndex（null 表示该库不可用）
 * @param {object}  [opts]
 * @param {boolean} [opts.recordHit] 是否记命中统计（默认 true）
 * @param {function}[opts.onHit]     (bankId, confidence) => void
 * @returns {{
 *   ok: boolean,
 *   item?: object, answer?: string, confidence?: string, reason: string,
 *   bankId?: string, scores?: {stem,options},
 *   // 多库诊断：每个库最好的一条，用于面板展示"哪个库更准"
 *   perBank: Array<{bankId, ok, confidence, stem, options, reason}>
 * }}
 */
export function matchAcrossBanks(question, banks, opts = {}) {
	const list = Array.isArray(banks) ? banks.filter((b) => b && b.index) : [];
	const perBank = [];

	if (list.length === 0) {
		return { ok: false, reason: '没有可用的题库', perBank };
	}

	// ── 1. 每个库各自打分 ──
	const all = [];
	for (const { id, index } of list) {
		const cands = index.candidates(question?.stem ?? '');
		const r = matchQuestion(question, cands);
		perBank.push({
			bankId: id,
			ok: !!r.ok,
			confidence: r.confidence ?? CONFIDENCE.LOW,
			stem: r.scores?.stem ?? 0,
			options: r.scores?.options ?? 0,
			reason: r.reason ?? '',
		});
		if (r.ok) all.push({ ...r, bankId: id });
	}

	if (all.length === 0) {
		return {
			ok: false,
			reason: '所有题库里都没有足够相似的题',
			perBank,
		};
	}

	// ── 2. 全局排序：置信等级 → 题干相似度 → 选项相似度 ──
	//
	// 为什么先按等级而不是直接按 stemSim：
	//   matchQuestion 已经把"题干 exact 但选项对不上"降到 MEDIUM。
	//   如果这里又按 stemSim 排序，一个 stem=0.99 的 MEDIUM 会压过
	//   stem=0.95 的 MEDIUM_HIGH —— 而那正是不想要的：
	//   题干几乎一样但选项完全不同的题，恰恰是最危险的一类。
	all.sort((a, b) => {
		const ra = CONF_RANK[a.confidence] ?? 0;
		const rb = CONF_RANK[b.confidence] ?? 0;
		if (rb !== ra) return rb - ra;
		const sa = a.scores?.stem ?? 0;
		const sb = b.scores?.stem ?? 0;
		if (sb !== sa) return sb - sa;
		return (b.scores?.options ?? 0) - (a.scores?.options ?? 0);
	});

	const best = all[0];
	const accepted = AUTO_ACCEPT.has(best.confidence);

	if (accepted && opts.recordHit !== false && typeof opts.onHit === 'function') {
		try {
			opts.onHit(best.bankId, best.confidence);
		} catch {
			/* 统计失败不该影响作答 */
		}
	}

	return {
		ok: true,
		item: best.item,
		answer: best.answer,
		confidence: best.confidence,
		reason: best.reason,
		bankId: best.bankId,
		scores: best.scores,
		// lowConfidence 由调用方决定怎么处理（转人工 / 继续问模型）
		lowConfidence: !accepted,
		// 竞品诊断：除了最优的，其余库的最好成绩也带上，
		// 面板能显示"这题在 A 库是 high，在 B 库是 medium"
		runnersUp: all.slice(1, 4).map((r) => ({
			bankId: r.bankId,
			confidence: r.confidence,
			scores: r.scores,
		})),
		perBank,
	};
}

/**
 * 单条 miss 记录的字段。
 *
 * 刻意只记"能用来补题"的东西：题干、选项、当时各库的最高分。
 * **不记截图、不记整场上下文** —— 那些体积大且含隐私，
 * 落盘后很难清理干净（BACKLOG B-6 已经因为留存清理缺失吃过教训）。
 */
export function makeMissRecord(question, result, now = Date.now()) {
	return {
		at: new Date(now).toISOString(),
		stem: String(question?.stem ?? '').slice(0, 300),
		qtype: String(question?.qtype ?? ''),
		opts: (question?.opts ?? []).slice(0, 8).map((o) => ({
			letter: o.letter ?? '',
			text: String(o.text ?? '').slice(0, 120),
		})),
		// 各库最高分：判断"是不是题库缺这道题" vs "题库有但没匹配上"
		perBank: (result?.perBank ?? []).map((b) => ({
			bankId: b.bankId,
			confidence: b.confidence,
			stem: round2(b.stem),
			options: round2(b.options),
		})),
		reason: String(result?.reason ?? ''),
	};
}

function round2(n) {
	const v = Number(n);
	return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

/**
 * 把 misses 按题干聚合成"最值得补的题"。
 *
 * 为什么要聚合：同一道题在一场考试里只会出现一次，但在不同场次里会反复出现。
 * 单条 miss 说明不了问题，**同一个题干反复 miss 才说明题库缺了它**。
 */
export function summarizeMisses(records, { minCount = 1, limit = 50 } = {}) {
	const map = new Map();
	for (const r of records) {
		const key = String(r.stem ?? '').trim();
		if (!key) continue;
		const cur = map.get(key);
		if (cur) {
			cur.count += 1;
			cur.lastAt = r.at;
		} else {
			map.set(key, {
				stem: key,
				qtype: r.qtype ?? '',
				count: 1,
				firstAt: r.at,
				lastAt: r.at,
				reason: r.reason ?? '',
				// 只留第一次的选项快照，后续场次可能 OCR 不同
				opts: r.opts ?? [],
			});
		}
	}
	return [...map.values()]
		.filter((x) => x.count >= minCount)
		.sort((a, b) => b.count - a.count || String(b.lastAt).localeCompare(String(a.lastAt)))
		.slice(0, limit);
}
