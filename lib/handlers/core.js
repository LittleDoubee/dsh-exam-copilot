// 面板 RPC 处理函数：状态、引擎、设置、日志、浏览器。依赖由 apply 统一注入。
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

async function hStatus(d) {
	const { ctx, dataDir, store, state, PLUGIN_VERSION, ok, pickPython, describeLlm, tryGetService } = d;
		const settings = store.getSettings();
		let engineInfo = null;
		if (state.engine?.client) {
			try {
				engineInfo = await state.engine.client.health();
			} catch (err) {
				engineInfo = { ok: false, error: err?.message ?? String(err) };
			}
		}
		// 面板要能回答「为什么启动不了」：探测结果放进 pythonProbe
		const pythonProbe = state.pythonPath
			? { python: state.pythonPath, ok: true }
			: await pickPython(settings.engine?.pythonPath);
		return ok({
			pluginVersion: PLUGIN_VERSION,
			dataDir,
			pythonPath: state.pythonPath ?? pythonProbe.python,
			pythonProbe,
			engineRunning: Boolean(state.engine?.client),
			engine: engineInfo,
			lastError: state.lastError,
			uptimeMs: Date.now() - state.startedAt,
			// 诊断用：模型与附件是否可用。
			//
			// 为什么要把这两个暴露出来：视觉通道和"模型兜底"都依赖它们，
			// 但拿不到时**表现完全一样**（都只是"没答案→转人工"），
			// 从外面看不出根因。曾因分不清
			// "模型没答对"和"根本没有模型"白跑了好几轮。
			ai: {
				llm: describeLlm(state.llm),
				attachments: Boolean(tryGetService(ctx, 'attachments')?.saveImages),
			},
		});
}


async function hEngineStart(d) {
	const { ensureEngine, ok, fail } = d;
		try {
			const engine = await ensureEngine();
			return ok(await engine.client.health());
		} catch (err) {
			return fail('ENGINE_START_FAILED', err?.message ?? String(err));
		}
}


async function hEngineStop(d) {
	const { stopEngine, ok } = d;
		await stopEngine();
		return ok({ stopped: true });
}


async function hSettingsGet(d) {
	const { store, ok } = d;
		return ok(store.getSettings());
}


async function hSettingsSave(d, body) {
	const { store, ok } = d;
		return ok(store.saveSettings(body?.patch ?? {}));
}


	/** 列出本机已安装的浏览器，供面板选择考试用的浏览器。
	 *
	 * 为什么不替用户选：
	 *    用户可能在多个浏览器里考试（公司要求 Edge / 个人用 Chrome），
	 *    让用户选比替他决定更靠谱。
	 */
	/** 最近日志（最多 200 行）。since=时间戳 时只返回之后的，便于面板增量轮询。 */
async function hLogsRecent(d, body) {
	const { recentLogs, LOG_CAP, ok } = d;
		const since = Number(body?.since ?? 0);
		const lines = since ? recentLogs.filter((l) => l.t > since) : recentLogs.slice();
		return ok({ lines, count: lines.length, cap: LOG_CAP });
}


async function hBrowsersList(d) {
	const { ok } = d;
		try {
			const list = listBrowsers();
			return ok({ browsers: list, count: list.length });
		} catch (err) {
			return ok({ browsers: [], count: 0, reason: String(err?.message ?? err) });
		}
}


	/** 浏览器 DOM 通道。
	 *  action：
	 *    ensure（默认）—— 没起就启动一个，然后探测；已起就直接探测
	 *    probe         —— 只探测，不启动
	 *    close         —— 关掉本插件启动的浏览器（外部复用的一律不动）
	 *
	 * 为什么默认是 ensure："不应当由用户自行调试，应当由插件完成"。
	 *  只留 probe 会把启动责任推回给用户。
	 */
async function hBrowserProbe(d, body) {
	const { browserLauncher, ok } = d;
		const action = String(body?.action ?? 'ensure');
		try {
			if (action === 'close') {
				const r = browserLauncher.close();
				return ok({ ok: true, closed: r.closed, action });
			}

			if (action !== 'probe') {
				const launched = await browserLauncher.ensure({ browserId: body?.browserId });
				if (!launched.ok) {
					return ok({ ok: false, reason: launched.reason, action });
				}
				// 启动成功后继续走探测，拿到具体页面信息
			}

			const r = await probeCdp();
			return ok({ ...r, action, launched: action !== 'probe' });
		} catch (err) {
			return ok({ ok: false, reason: `探测失败：${err?.message ?? err}`, action });
		}
}


	/** 关闭答题用浏览器（面板上的「关闭浏览器」按钮）。 */
async function hBrowserClose(d) {
	const { browserLauncher, ok } = d;
		try {
			const r = browserLauncher.close();
			return ok(r);
		} catch (err) {
			return ok({ closed: false, reason: String(err?.message ?? err) });
		}
}

export function createCoreHandlers(d) {
	return {
		status: (...a) => hStatus(d, ...a),
		'engine.start': (...a) => hEngineStart(d, ...a),
		'engine.stop': (...a) => hEngineStop(d, ...a),
		'settings.get': (...a) => hSettingsGet(d, ...a),
		'settings.save': (...a) => hSettingsSave(d, ...a),
		'logs.recent': (...a) => hLogsRecent(d, ...a),
		'browsers.list': (...a) => hBrowsersList(d, ...a),
		'browser.probe': (...a) => hBrowserProbe(d, ...a),
		'browser.close': (...a) => hBrowserClose(d, ...a),
	};
}
