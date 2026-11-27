// 插件日志：环形缓冲 + 本地日志文件。由 lib/index.js 的 apply 统一组装，依赖经 d 注入。
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

export function createLogging(d) {
	const { ctx, PLUGIN_ROOT } = d;
	const logger = ctx.logger ?? console;
	// 最近日志环形缓冲：面板通过 logs.recent 拉取，排查时不用去翻宿主日志
	const recentLogs = [];
	const LOG_CAP = 200;
	// 本地副本：完整记录写到插件目录 .testdata/run.log（不进仓库），供排查时直接读取；引擎每次拉起前清空
	const LOG_FILE = path.join(PLUGIN_ROOT, '.testdata', 'run.log');
	const resetLogFile = () => {
		try {
			fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
			fs.writeFileSync(LOG_FILE, '');
		} catch {
			/* 写不了本地日志不影响主流程 */
		}
	};
	const pushLog = (level, msg) => {
		const t = Date.now();
		recentLogs.push({ t, level, msg: String(msg) });
		if (recentLogs.length > LOG_CAP) recentLogs.splice(0, recentLogs.length - LOG_CAP);
		try {
			fs.appendFileSync(LOG_FILE, `${new Date(t).toLocaleTimeString('zh-CN', { hour12: false })} ${level === 'warn' ? '⚠' : ' '} ${String(msg)}\n`);
		} catch {
			/* ignore */
		}
	};
	const log = (msg) => {
		pushLog('info', msg);
		try {
			logger.info?.(`[exam-copilot] ${msg}`);
		} catch {
			/* 日志失败不影响主流程 */
		}
	};
	const logErr = (msg, err) => {
		pushLog('warn', `${msg}: ${err?.message ?? err}`);
		try {
			logger.warn?.(`[exam-copilot] ${msg}: ${err?.message ?? err}`);
		} catch {
			/* ignore */
		}
	};

	return { logger, recentLogs, LOG_CAP, LOG_FILE, resetLogFile, pushLog, log, logErr };
}
