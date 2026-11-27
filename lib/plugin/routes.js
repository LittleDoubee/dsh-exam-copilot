// webServer 路由：面板 RPC 与悬浮窗数据。由 lib/index.js 的 apply 统一组装，依赖经 d 注入。
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

export function createRoutes(d) {
	const { CHANNEL, ok, fail, sameOrigin, readJsonBody, store, state, dispatch } = d;
	//#region 悬浮窗数据路由
	/**
	 * 运行期悬浮窗的数据源。刻意用 GET + 极简 JSON，不复用 RPC：
	 *   * 悬浮窗是注入到页面里的裸 <script>，做不了 RPC 握手；
	 *   * 数据量极小（题号/状态/答案），一次 GET 就够；
	 *   * 运行结束后返回 { active:false }，悬浮窗自行隐藏。
	 *
	 * 安全：只暴露"第几题 / 什么状态 / 答案"，不暴露题干原文、截图、配置，
	 * 因为这些可能出现在用户正在共享的屏幕上。
	 */
	function mountOverlayRoute(webCtx) {
		const dispose = webCtx.webServer.register({
			kind: 'exact',
			path: '/plugins/dsh-exam-copilot/overlay-state',
			handler: async (req, res) => {
				if (!sameOrigin(req)) {
					res.statusCode = 403;
					res.end();
					return;
				}
				if (req.method !== 'GET') {
					res.statusCode = 405;
					res.end();
					return;
				}
				let payload;
				try {
					const snap = state.runner?.snapshot?.() ?? null;
					payload = snap
						? {
								active: snap.run === RUN_STATE.RUNNING || snap.run === RUN_STATE.PAUSED,
								run: snap.run,
								phase: snap.phase,
								pauseReason: snap.pauseReason,
								prog: snap.current?.prog ?? null,
								answer: snap.answer ?? null,
								handled: snap.stats?.handled ?? 0,
								failed: snap.stats?.failed ?? 0,
						  }
						: { active: false };
				} catch (err) {
					payload = { active: false, error: err?.message ?? String(err) };
				}
				const body = JSON.stringify(payload);
				res.statusCode = 200;
				res.setHeader('content-type', 'application/json; charset=utf-8');
				res.setHeader('cache-control', 'no-store');
				res.end(body);
			},
		});
		return () => dispose?.();
	}
	//#endregion

	function mountHttpRoute(webCtx) {
		const dispose = webCtx.webServer.register({
			kind: 'exact',
			path: `/plugins/dsh-exam-copilot${CHANNEL}`,
			handler: async (req, res) => {
				if (!sameOrigin(req)) {
					res.statusCode = 403;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ ok: false, error: { code: 'ORIGIN_NOT_TRUSTED' } }));
					return;
				}
				if (req.method !== 'POST') {
					res.statusCode = 405;
					res.end();
					return;
				}
				const ct = String(req.headers?.['content-type'] ?? '');
				if (!ct.includes('application/json')) {
					res.statusCode = 415;
					res.end();
					return;
				}
				let body;
				try {
					// 体积上限从 4MB 提到 32MB：
					// 拖入导入要把文件字节（base64）一起传上来，一本 docx 题库
					// 常见 2-10MB，base64 膨胀 4/3 后 4MB 明显不够。
					// 32MB 对 JSON body 属于安全区间；真正解析时
					// doc-read 还有单条目 64MB 的 zip bomb 防线。
					body = await readJsonBody(req, 32 * 1024 * 1024);
				} catch {
					res.statusCode = 400;
					res.end();
					return;
				}
				let result;
				try {
					result = await dispatch(body?.endpoint, body?.payload);
				} catch (err) {
					result = fail('INTERNAL', err?.message ?? String(err));
				}
				const payload = JSON.stringify(result ?? { ok: false });
				res.statusCode = 200;
				res.setHeader('content-type', 'application/json; charset=utf-8');
				res.setHeader('cache-control', 'no-store');
				res.end(payload);
			},
		});
		return () => dispose?.();
	}
	//#endregion

	return { mountOverlayRoute, mountHttpRoute };
}
