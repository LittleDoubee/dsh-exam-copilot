// 面板 RPC：处理函数表与分发入口。由 lib/index.js 的 apply 统一组装，依赖经 d 注入。
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

export function createRpc(d) {
	const { fail, logErr } = d;
	/** 预览用的绝对区域：传了 zones 时按目标窗口当前位置解析比例坐标，与运行时一致。 */
	async function previewRegions(client, body) {
		if (!Array.isArray(body?.zones)) return Array.isArray(body?.regions) ? body.regions : [];
		let win = null;
		const title = String(body?.title || '');
		if (title) {
			try {
				const r = await client.windowRect(title);
				if (r?.ok && r.rect) win = r.rect;
			} catch {
				/* 取不到窗口时沿用绝对坐标 */
			}
		}
		return resolveZones(body.zones, win).map((z) => ({ role: z.role, x: z.x, y: z.y, w: z.w, h: z.h }));
	}

	async function dispatch(endpoint, payload) {
		const fn = handlers[endpoint];
		if (!fn) return fail('UNKNOWN_ENDPOINT', `未知接口: ${endpoint}`);
		try {
			return await fn(payload ?? {});
		} catch (err) {
			logErr(`handler ${endpoint} 异常`, err);
			return fail('INTERNAL', err?.message ?? String(err));
		}
	}

	d.previewRegions = previewRegions;
	d.dispatch = dispatch;
	const handlers = {
		...createCoreHandlers(d),
		...createZoneHandlers(d),
		...createBankHandlers(d),
		...createRunHandlers(d),
	};
	return { previewRegions, dispatch, handlers };
}
