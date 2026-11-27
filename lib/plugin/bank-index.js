// 题库索引缓存与多题库匹配器。由 lib/index.js 的 apply 统一组装，依赖经 d 注入。
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
import { createCoreHandlers } from '../handlers/core.js';
import { createZoneHandlers } from '../handlers/zones.js';
import { createBankHandlers } from '../handlers/banks.js';
import { createRunHandlers } from '../handlers/run.js';

export function createBankIndex(d) {
	const { bankStore, bankIndexCache } = d;
	//#region webServer 路由
	/** 面板走这条路：fetch('/plugins/dsh-exam-copilot/rpc', {method:'POST', body:{endpoint,payload}})
	 *
	 *  为什么用 webServer 而不是 connection.rpc：
	 *  路由是宿主最稳的出口，没有握手阶段要管；且能直接用 curl 验证。
	 *  必须做同源闸门 —— 这个路由能截图和点鼠标。 */
	//#region 题库索引
	/** 取（并缓存）某个题库的索引。题库 updatedAt 变化则重建。 */
	function getBankIndex(id) {
		const meta = bankStore.getMeta(id);
		if (!meta) return null;
		const cached = bankIndexCache.get(id);
		if (cached && cached.updatedAt === meta.updatedAt) return cached.index;

		const items = bankStore.loadItems(id);
		const index = new BankIndex(items);
		bankIndexCache.set(id, { updatedAt: meta.updatedAt, index });
		return index;
	}

	/** 判断某题是否该用题库答案。 */
	function shouldUseBank(result, profile) {
		if (!result?.ok) return false;
		const threshold = profile?.answer?.bankMinConfidence;
		// 默认只接受 high / medium-high（medium 及以下当作"参考")
		if (threshold === 'all') return true;
		return AUTO_ACCEPT.has(result.confidence);
	}
	//#endregion

	/** 构造题库匹配器：把 profile 选定的题库（可多个）接进来。
	 *
	 * 重写—— 旧实现有两个真实缺陷：
	 *    ① 按数组顺序逐个库试，第一个 medium-high 命中就返回，
	 *       后面库里的 high 根本没机会比较。库越多偏得越离谱。
	 *    ② 只在单个库 updatedAt 变化时失效缓存；但「启用新题库」改的是
	 *       profile，不碰任何库的 updatedAt，于是新库可能一直读不到。
	 *  现在：所有库都打分 → 全局排序取最优；缓存按**库集合签名**失效。
	 */
	function buildBankMatcher(profile) {
		const bankIds = Array.isArray(profile?.answer?.bankIds)
			? profile.answer.bankIds
			: profile?.answer?.bankId
			? [profile.answer.bankId]
			: [];
		if (bankIds.length === 0) return null;

		return (question) => {
			// 每次现取索引：getBankIndex 内部按 updatedAt + 集合签名判缓存，
			// 命中时只是 Map 查找，不会真的重读文件。
			const banks = [];
			for (const id of bankIds) {
				const idx = getBankIndex(id);
				if (idx) banks.push({ id, index: idx });
			}
			if (banks.length === 0) return null;

			const r = matchAcrossBanks(question, banks, {
				onHit: (bankId, confidence) => bankStore.recordHit(bankId, confidence),
			});

			// 未命中 / 低置信 → 记一条 miss。
			// 这是「题库该补什么」的唯一数据来源：只记命中等于没有反馈闭环。
			if (!r.ok || r.lowConfidence) {
				try {
					bankStore.recordMiss(makeMissRecord(question, r));
				} catch {
					/* 统计失败不影响作答 */
				}
			}

			return r.ok ? r : null;
		};
	}

	function normalizeStemStr(s) {
		return String(s ?? '')
			.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
			.replace(/[（）()【】\[\]「」『』《》<>，,。.；;：:！!？?、\-—_\s]/g, '')
			.replace(/^第?\d+[题、.．]?/, '')
			.trim()
			.toLowerCase();
	}

	return { getBankIndex, shouldUseBank, buildBankMatcher, normalizeStemStr };
}
