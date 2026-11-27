// 面板 RPC 处理函数：题库。依赖由 apply 统一注入。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { EngineClient, waitForHealthy } from '../core/engine-client.js';
import { validateZones, emptyProfile, zonesByRole, ROLE_KEYS, ZONE_ROLES, CONTENT_ROLES, toRelative, migrateZones, mergeDetectedZones, resolveZones } from '../core/zones.js';
import { ACTIONS, ACTION_NAMES, validateAction } from '../core/actions.js';
import { RUN_STATE, PAUSE_REASON } from '../core/guardrails.js';
import { SolverPool } from '../core/llm.js';
import { WebSearcher } from '../core/web-search.js';
import { Runner } from '../core/runner.js';
import { AUTO_ACCEPT, BankIndex, CONFIDENCE, matchQuestion, normalizeStem } from '../core/bank.js';
import { matchAcrossBanks, makeMissRecord, summarizeMisses } from '../core/multi-bank.js';
import { ANSWER_KIND, parseAnswer } from '../core/answer.js';
import { BankStore, dedupe, normalizeItem } from '../core/bank-store.js';
import { dispatch as importDispatch, isSupported, extOf } from '../core/importer.js';
import { bytesToText, hintFor } from '../core/doc-read.js';
import { validateAnswer } from '../core/answer.js';
import { createDomReader, createStructReader, probeCdp } from '../core/dom-reader.js';
import { BrowserLauncher, listBrowsers } from '../core/browser-launch.js';
import { buildOverlayState, toStepLine } from '../core/overlay-view.js';


	// ── S3：题库 ─────────────────────────────────────────

	/** 题库列表（含分类、题数、命中统计）。 */
async function hBanksList(d) {
	const { bankStore, ok, fail } = d;
		try {
			const banks = bankStore.list();
			// 按分类聚合，供面板做分类树
			const categories = {};
			for (const b of banks) {
				const c = b.category || '未分类';
				categories[c] = (categories[c] ?? 0) + 1;
			}
			return ok({ banks, categories });
		} catch (err) {
			return fail('BANKS_LIST_FAILED', err?.message ?? String(err));
		}
}


async function hBanksCreate(d, body) {
	const { name, bankStore, bankIndexCache, ok, fail } = d;
		try {
			const meta = bankStore.create({
				name: body?.name,
				category: body?.category,
				tags: body?.tags,
				source: body?.source,
			});
			bankIndexCache.clear();
			return ok(meta);
		} catch (err) {
			return fail('BANK_CREATE_FAILED', err?.message ?? String(err));
		}
}


async function hBanksDelete(d, body) {
	const { bankStore, bankIndexCache, ok, fail } = d;
		try {
			const deleted = bankStore.delete(body?.id);
			bankIndexCache.clear();
			return ok({ deleted });
		} catch (err) {
			return fail('BANK_DELETE_FAILED', err?.message ?? String(err));
		}
}


async function hBanksGet(d, body) {
	const { bankStore, ok, fail } = d;
		const meta = bankStore.getMeta(body?.id);
		if (!meta) return fail('NOT_FOUND', `没有这个题库: ${body?.id}`);
		// 不返回全部题（可能上万条），只给前 20 条做预览
		const items = bankStore.loadItems(body.id).slice(0, 20);
		return ok({ meta, preview: items, previewTotal: meta.count ?? items.length });
}

	/** 列出某题库下已导入的来源文件（供面板展示与删除）。
	 *
	 * 选中题库后应能看到它由哪些文件组成，
	 *  并且能单独删掉某个文件导入的那批题。
	 *  所以这里返回 hash —— 删除时用它定位，而不是文件名
	 *  （同名文件可能内容不同，hash 才是唯一身份）。
	 */
async function hBanksSources(d, body) {
	const { name, bankStore, ok, fail } = d;
		const id = body?.id;
		if (!id) return fail('NO_BANK', '需要指定题库');
		const meta = bankStore.getMeta(id);
		if (!meta) return fail('NOT_FOUND', `没有这个题库: ${id}`);
		
		const items = bankStore.loadItems(id);

		// ① 新数据：按 srcHash 聚合（精确到「哪次导入」，支持同文件多次导入）
		const byHash = bankStore.listSources(id);

		// ② 旧数据：按题的 source 字段聚合。
		//
		//    为什么要有这条：normalizeItem 从第一版起就写 source（原始文件名），
		//    只是之前没人用它。旧数据没有 srcHash，但**有 source**，
		//    所以老题库也能立刻列出文件，不需要重新导入。
		//
		//    hash 用 `src:<文件名>` 与真 hash 区分，删除时据此判断走哪条路径。
		const bySource = new Map();
		for (const it of items) {
			if (it.srcHash) continue;
			const name = String(it.source || '').trim() || '(未记录来源)';
			bySource.set(name, (bySource.get(name) || 0) + 1);
		}

		const sources = byHash.slice();
		for (const [name, count] of bySource) {
			sources.push({
				hash: 'src:' + name,
				name,
				itemCount: count,
				at: null,
				legacy: true,
			});
		}

		// 真正「无从归因」的只剩：既无 srcHash 又无 source
		const untracked = items.filter(
			(it) => !it.srcHash && !String(it.source || '').trim()
		).length;

		return ok({ bankId: id, sources, untracked, total: items.length });
}


	/** 删除某个来源文件导入的题。
	 *
	 *  只删这个文件贡献的题，不动其他文件导入的、也不动手工补的。
	 *  判据是题上的 srcHash（导入时写入）。
	 */
async function hBanksRemoveSource(d, body) {
	const { bankStore, bankIndexCache, ok, fail } = d;
		const { id, hash } = body ?? {};
		if (!id) return fail('NO_BANK', '需要指定题库');
		if (!hash) return fail('NO_HASH', '需要指定要删除的文件');
		const meta = bankStore.getMeta(id);
		if (!meta) return fail('NOT_FOUND', `没有这个题库: ${id}`);
		
		const res = bankStore.removeSource(id, hash);
		bankIndexCache.clear();
		return ok({ ...res, bankId: id });
}


	/**
	 * 导入题库。
	 *
	 * 关键取舍（S3 设计原则）：不做"全自动导入"。
	 * 文档排版千差万别，机器只能粗切分，必须人工确认。
	 * 所以这里返回 split 结果 + warnings，由面板展示，确认后再入库。
	 *
	 * dryRun=true（默认）只切分不入库 —— 用户先看切得对不对。
	 */
/** 解析出的二进制格式映射到解析器用的扩展名（docx 按段落文本、xlsx 按制表符表格）。 */
function extOfKind(kind, fallback) {
	if (kind === 'docx') return '.txt';
	if (kind === 'xlsx') return '.tsv';
	return fallback;
}

/**
 * 拖入的文件字节：先按魔数判真实类型再解。
 * 用户把 xlsx 存成 .csv 的情况很常见，所以用实际解析出的类型决定后续用哪个解析器。
 */
function readFromBytes(d, fileBytes, sourceName, fileExt) {
	const { fail } = d;
	try {
		const buf = Buffer.from(String(fileBytes), 'base64');
		if (buf.length === 0) return { error: fail('EMPTY_FILE', '文件是空的') };
		const r = bytesToText(buf, sourceName);
		return { raw: r.text, fileExt: extOfKind(r.kind, fileExt || extOf(sourceName) || '.txt'), blobBuf: buf, fromBlob: true };
	} catch (err) {
		return { error: fail('PARSE_FAILED', err?.message ?? String(err), { hint: hintFor(err?.userHint ?? 'unknown', sourceName) }) };
	}
}

/** 用户填/选的磁盘路径：二进制格式读字节解析，其余按 UTF-8 文本读。 */
function readFromPath(d, filePath, sourceName, fileExt) {
	const { BINARY_EXTS, fail } = d;
	const e = extOf(filePath);
	if (!isSupported(filePath)) {
		// 说清楚"支持什么"，而不是只说"不支持"
		return { error: fail('UNSUPPORTED', `不支持的文件类型: ${e || '(无扩展名)'}`, { hint: hintFor('unknown', filePath) }) };
	}
	try {
		if (BINARY_EXTS.has(e)) {
			const buf = fs.readFileSync(filePath);
			const r = bytesToText(buf, filePath);
			return { raw: r.text, fileExt: extOfKind(r.kind, '.txt'), blobBuf: buf };
		}
		return { raw: fs.readFileSync(filePath, 'utf8'), fileExt: fileExt || e, blobBuf: null };
	} catch (err) {
		if (err?.userHint) return { error: fail('NEEDS_TEXT_EXTRACT', err.message, { hint: hintFor(err.userHint, sourceName) }) };
		return { error: fail('READ_FAILED', `读取文件失败: ${err?.message ?? err}`) };
	}
}

/**
 * 解析来源归一：fileBytes（拖入，无磁盘路径）与 filePath（磁盘路径）都转成 raw 文本 + fileExt。
 * blobBuf 是原始字节，只有二进制格式才有，用来算文件指纹判断是否导过。
 */
function readImportSource(d, body) {
	const { filePath, fileBytes, fileName, text, ext } = body ?? {};
	const sourceName = fileName || filePath || '';
	let src = { raw: text, fileExt: ext, blobBuf: null, fromBlob: false };
	if (!src.raw && fileBytes) src = { ...src, ...readFromBytes(d, fileBytes, sourceName, src.fileExt) };
	if (src.error) return src;
	if (!src.raw && filePath) src = { ...src, ...readFromPath(d, filePath, sourceName, src.fileExt) };
	return { ...src, sourceName };
}

/** 归一化每条题，并提前暴露「答案与题型不自洽」，而不是等跑起来点错选项才发现。 */
function normalizeImported(items, source) {
	const normalized = [];
	const bad = [];
	const answerIssues = [];
	for (const rawItem of items) {
		const it = normalizeItem(rawItem, { source });
		if (!it) {
			bad.push(rawItem);
			continue;
		}
		normalized.push(it);
		const issues = validateAnswer(it.answer, it.qtype, (it.options || []).length);
		if (issues.length > 0) answerIssues.push({ stem: it.stem.slice(0, 40), answer: it.answer, issues });
	}
	return { normalized, bad, answerIssues };
}

function summarizeImport(parsed, normalized, deduped, bad, answerIssues) {
	const summary = {
		rawCount: parsed.items.length,
		normalizedCount: normalized.length,
		afterDedupe: deduped.length,
		dropped: bad.length,
		withAnswer: deduped.filter((it) => it.answer).length,
		answerIssueCount: answerIssues.length,
		answerIssueSamples: answerIssues.slice(0, 8),
		warnings: [...(parsed.warnings ?? [])],
	};
	if (bad.length > 0) summary.warnings.push(`${bad.length} 条缺少题干，已跳过`);
	if (normalized.length > deduped.length) summary.warnings.push(`去重移除 ${normalized.length - deduped.length} 条重复题`);
	if (answerIssues.length > 0) summary.warnings.push(`${answerIssues.length} 条题的答案与题型可能不自洽，入库前请核对`);
	return summary;
}

/**
 * 文件指纹：只比文件名不够（「题库 (1).docx」名字不同内容一样），所以用 sha256 判内容，
 * 文件名只用于告诉用户是哪个文件。
 */
function fileHashOf(blobBuf) {
	if (!blobBuf || blobBuf.length === 0) return null;
	return crypto.createHash('sha256').update(blobBuf).digest('hex').slice(0, 32);
}

/** 已导入过不是错误：ok:true + 明确告知，让面板显示「这个文件在 X 时间已导入过」。 */
function alreadyImportedResult(d, parsed, prev, dryRun, fromBlob, sourceName) {
	const summary = { rawCount: parsed.items.length, normalizedCount: 0, afterDedupe: 0, dropped: 0, withAnswer: 0, answerIssueCount: 0, warnings: [] };
	return d.ok({ dryRun, alreadyImported: true, summary, preview: [], all: 0, fromBlob, sourceName, previous: { name: prev.name, at: prev.at, size: prev.size } });
}

/**
 * 真正入库。用 appendItemsDedup 而不是 appendItems：调用方的 dedupe 只看本次这一批，
 * 看不见库里已有的题，纯追加会让同一文件导两次就重复一遍。
 */
function commitImport(d, bankId, deduped, summary, src, fileHash) {
	const { bankStore, bankIndexCache, ok, fail } = d;
	if (!bankId) return fail('NO_BANK', '需要指定 bankId 才能入库');
	if (!bankStore.getMeta(bankId)) return fail('NOT_FOUND', `没有这个题库: ${bankId}`);
	const res = bankStore.appendItemsDedup(bankId, deduped, { srcHash: fileHash || '' });
	bankIndexCache.clear();
	if (fileHash) {
		// 记「实际入库了多少题」——去重跳过的不算
		bankStore.recordSource(bankId, fileHash, { name: src.sourceName, size: src.blobBuf ? src.blobBuf.length : 0, itemCount: res.added || 0 });
	}
	if (res.skipped > 0) summary.warnings.push(`与库内已有题目重复，跳过 ${res.skipped} 条`);
	if (res.conflicts > 0) summary.warnings.push(`${res.conflicts} 条题干相同但答案不同，已按不同版本保留并标「答案冲突」`);
	return ok({ dryRun: false, summary, ...res, bankId, fromBlob: src.fromBlob, sourceName: src.sourceName, alreadyImported: false });
}

async function hBanksImport(d, body) {
	const { bankStore, ok, fail } = d;
	const { bankId, dryRun = true } = body ?? {};
	const src = readImportSource(d, body);
	if (src.error) return src.error;
	if (!src.raw || !String(src.raw).trim()) return fail('EMPTY', '没有可导入的内容（文件可能是空的，或整页是图片）');
	let parsed;
	try {
		parsed = importDispatch(String(src.raw), src.fileExt || '.txt');
	} catch (err) {
		return fail('PARSE_FAILED', err?.message ?? String(err));
	}
	const { normalized, bad, answerIssues } = normalizeImported(parsed.items, body?.source || src.sourceName || '');
	const deduped = dedupe(normalized);
	const summary = summarizeImport(parsed, normalized, deduped, bad, answerIssues);
	const fileHash = fileHashOf(src.blobBuf);
	const prev = fileHash && bankId ? bankStore.findSource(bankId, fileHash) : null;
	if (prev) return alreadyImportedResult(d, parsed, prev, dryRun, src.fromBlob, src.sourceName);
	// dryRun：只返回切分结果供人工确认
	if (dryRun) return ok({ dryRun: true, summary, preview: deduped.slice(0, 50), all: deduped.length, fromBlob: src.fromBlob, sourceName: src.sourceName });
	return commitImport(d, bankId, deduped, summary, src, fileHash);
}


	/** 未命中记录：题库漏了哪些题。
	 *
	 * 这是 S3 唯一缺的反馈闭环：
	 *  只记命中 = 永远不知道题库缺什么。跑完一场考试，
	 *  这里应该清楚列出「哪些题干所有库都没匹配上」。
	 *  默认按题干聚合：同一道题反复 miss 才值得补。
	 */
async function hBanksMisses(d, body) {
	const { bankStore, ok, fail } = d;
	  try {
	    const records = bankStore.readMisses(body?.limit ?? 2000);
	    const aggregated = summarizeMisses(records, {
	      minCount: body?.minCount ?? 1,
	      limit: body?.groupLimit ?? 50,
	    });
	    return ok({
	      totalRecords: records.length,
	      groups: aggregated,
	      // 原始记录只在明确要的时候返回（可能上千条，面板上滚动看聚合更有用）
	      raw: body?.includeRaw ? records.slice(-200) : undefined,
	    });
	  } catch (err) {
	    return fail('MISSES_FAILED', err?.message ?? String(err));
	  }
}


	/** 清空未命中记录。用户补完题后可能想重新统计一轮。 */
async function hBanksClearMisses(d) {
	const { bankStore, ok } = d;
	  return ok({ cleared: bankStore.clearMisses() });
}


	/** 把一条 miss 直接补成题库条目 —— 闭环的最后一格。
	 *
	 *  为什么不让用户去「导入」里重新粘贴：那要他自己把题干、选项、答案
	 *  再手打一遍，而 miss 记录里题干和选项**已经在了**，只缺答案。
	 *  这里只要求传 answer，其余从 miss 记录里取。
	 */
async function hBanksFillMiss(d, body) {
	const { bankStore, bankIndexCache, ok, fail } = d;
	  const { bankId, stem, answer, qtype, options } = body ?? {};
	  if (!bankId) return fail('NO_BANK', '需要指定题库');
	  if (!stem || !String(stem).trim()) return fail('NO_STEM', '需要题干');
	  if (!answer || !String(answer).trim()) return fail('NO_ANSWER', '需要答案');
	  const meta = bankStore.getMeta(bankId);
	  if (!meta) return fail('NOT_FOUND', `没有这个题库: ${bankId}`);

	  const r = parseAnswer(answer, { optionCount: Array.isArray(options) ? options.length : 0 });
	  if (r.kind === ANSWER_KIND.EMPTY) return fail('BAD_ANSWER', '答案无法解析');

	  const item = normalizeItem(
	    {
	      stem: String(stem).trim(),
	      options: Array.isArray(options) ? options : [],
	      answer: r.value,
	      qtype: qtype || '',
	    },
	    { source: 'miss-fill' }
	  );
	  if (!item) return fail('BAD_ITEM', '题目无法归一化');

	  const res = bankStore.appendItems(bankId, [item]);
	  bankIndexCache.clear();
	  return ok({ ...res, item });
}


	/** 题库检索（面板里搜题）。 */
async function hBanksSearch(d, body) {
	const { bankStore, ok, fail, jaccardStr } = d;
		const id = body?.id;
		const q = String(body?.q ?? '').trim();
		if (!id) return fail('NO_BANK', '需要指定题库');
		if (!q) return fail('EMPTY_QUERY', '请输入检索词');

		const items = bankStore.loadItems(id);
		const { normalizeStem: normStem } = await import('./core/bank.js');
		const nq = normStem(q);
		const hits = [];
		for (const it of items) {
			const ns = normStem(it.stem ?? it.q);
			if (!ns) continue;
			if (ns.includes(nq) || jaccardStr(nq, ns) > 0.6) {
				hits.push(it);
				if (hits.length >= (body?.limit ?? 30)) break;
			}
		}
		return ok({ total: items.length, hits, query: q });
}


	/**
	 * 用题库匹配一道题（不落库，供面板/工具调试）。
	 * 返回 matchQuestion 的完整结果，包括置信度与拒绝原因。
	 */
async function hBanksMatch(d, body) {
	const { bankStore, getBankIndex, ok, fail } = d;
		const id = body?.id;
		const question = body?.question;
		if (!id) return fail('NO_BANK', '需要指定题库');
		if (!question) return fail('NO_QUESTION', '需要提供题目');

		const idx = getBankIndex(id);
		if (!idx) return fail('NOT_FOUND', `没有这个题库: ${id}`);

		const cands = idx.candidates(normalizeStem(question.stem));
		const result = matchQuestion(question, cands);

		// 记命中统计（用于评估题库质量）
		if (result.ok) {
			try {
				bankStore.recordHit(id, result.confidence);
			} catch {
				/* 统计失败不影响匹配 */
			}
		}
		return ok({ ...result, autoAccept: result.ok && AUTO_ACCEPT.has(result.confidence) });
}


	/** 清掉题库内容（保留 meta），用于重新导入。 */
async function hBanksClear(d, body) {
	const { bankStore, bankIndexCache, ok, fail } = d;
		const id = body?.id;
		const meta = bankStore.getMeta(id);
		if (!meta) return fail('NOT_FOUND', `没有这个题库: ${id}`);
		bankStore.replaceItems(id, []);
		bankIndexCache.clear();
		return ok({ cleared: true, id });
}

export function createBankHandlers(d) {
	return {
		'banks.list': (...a) => hBanksList(d, ...a),
		'banks.create': (...a) => hBanksCreate(d, ...a),
		'banks.delete': (...a) => hBanksDelete(d, ...a),
		'banks.get': (...a) => hBanksGet(d, ...a),
		'banks.sources': (...a) => hBanksSources(d, ...a),
		'banks.removeSource': (...a) => hBanksRemoveSource(d, ...a),
		'banks.import': (...a) => hBanksImport(d, ...a),
		'banks.misses': (...a) => hBanksMisses(d, ...a),
		'banks.clearMisses': (...a) => hBanksClearMisses(d, ...a),
		'banks.fillMiss': (...a) => hBanksFillMiss(d, ...a),
		'banks.search': (...a) => hBanksSearch(d, ...a),
		'banks.match': (...a) => hBanksMatch(d, ...a),
		'banks.clear': (...a) => hBanksClear(d, ...a),
	};
}
