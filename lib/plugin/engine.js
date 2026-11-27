// 引擎生命周期：启动、复用、停止。由 lib/index.js 的 apply 统一组装，依赖经 d 注入。
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

//#region 引擎生命周期
/** 读 engine.json（引擎启动后自己写的 port+token）。 */
function readEngineInfo($d) {
	const { dataDir, isPidAlive } = $d;
	const file = path.join(dataDir, 'engine.json');
	try {
		const info = JSON.parse(fs.readFileSync(file, 'utf8'));
		// pid 存活校验：进程没了就别信这个文件
		if (info?.pid && !isPidAlive(info.pid)) return null;
		return info;
	} catch {
		return null;
	}
}


function isPidAlive($d, pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}


/** 确保引擎在跑。并发调用共享同一个启动 Promise。 */
async function ensureEngine($d) {
	const { ENGINE_DIR, pickPython, waitForEngineInfo, recentLogs, resetLogFile, log, logErr, dataDir, store, state, readEngineInfo, stopEngine } = $d;
	if (state.engine?.client) {
		try {
			await state.engine.client.health();
			return state.engine;
		} catch {
			log('引擎无响应，重启');
			await stopEngine();
		}
	}
	if (state.engineStarting) return state.engineStarting;

	state.engineStarting = (async () => {
		const settings = store.getSettings();
		const picked = await pickPython(settings.engine?.pythonPath);
		if (!picked.python) {
			state.lastError = `找不到可用的 Python（需要 Pillow）：${picked.reason}`;
			throw new Error(state.lastError);
		}
		if (picked.reason) log(picked.reason);
		const py = picked.python;
		state.pythonPath = py;

		// 复用还活着的引擎：engine.json 里的 pid 有效就直接连
		const existing = readEngineInfo();
		if (existing?.port && existing?.token) {
			const client = new EngineClient(existing, { timeoutMs: 30_000 });
			try {
				const health = await client.health();
				state.engine = { proc: null, client, info: existing, health };
				log(`复用已运行引擎 pid=${existing.pid} port=${existing.port}`);
				return state.engine;
			} catch {
				log('engine.json 指向的引擎无响应，重新拉起');
			}
		}

		const serverPath = path.join(ENGINE_DIR, 'server.py');
		if (!fs.existsSync(serverPath)) throw new Error(`引擎脚本缺失: ${serverPath}`);

		resetLogFile();
		recentLogs.length = 0;
		const proc = spawn(py, [serverPath, '--data-dir', dataDir], {
			cwd: ENGINE_DIR,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
		});

		// 把引擎日志转到宿主日志，便于排查"没反应"
		proc.stdout?.setEncoding?.('utf8');
		proc.stderr?.setEncoding?.('utf8');
		proc.stdout?.on?.('data', (d) => log(`engine: ${String(d).trim()}`));
		proc.stderr?.on?.('data', (d) => logErr('engine stderr', String(d).trim()));

		proc.on('exit', (code) => {
			log(`引擎退出 code=${code}`);
			if (state.engine?.proc === proc) state.engine = null;
		});

		// 等 engine.json 出现
		const info = await waitForEngineInfo(readEngineInfo, 25_000);
		if (!info) {
			try {
				proc.kill();
			} catch {
				/* ignore */
			}
			throw new Error('引擎启动超时（未写出 engine.json）');
		}

		const client = new EngineClient(info, { timeoutMs: 30_000 });
		const health = await waitForHealthy(() => client, { timeoutMs: 20_000 });
		state.engine = { proc, client, info, health };
		state.lastError = null;
		log(`引擎就绪 v${health.version} port=${info.port}`);
		return state.engine;
	})()
		.catch((err) => {
			state.lastError = err?.message ?? String(err);
			logErr('引擎启动失败', err);
			throw err;
		})
		.finally(() => {
			state.engineStarting = null;
		});

	return state.engineStarting;
}


async function stopEngine($d) {
	const { state } = $d;
	const engine = state.engine;
	state.engine = null;
	if (!engine?.proc) return;
	try {
		engine.proc.kill();
	} catch {
		/* ignore */
	}
	await new Promise((r) => setTimeout(r, 300));
}


/** 取引擎客户端；没起过就先起。所有需要引擎的接口都走它。 */
async function engineClient($d) {
	const { ensureEngine } = $d;
	const engine = await ensureEngine();
	return engine.client;
}

export function createEngine($d) {
	const api = {
		readEngineInfo: (...a) => readEngineInfo($d, ...a),
		isPidAlive: (...a) => isPidAlive($d, ...a),
		ensureEngine: (...a) => ensureEngine($d, ...a),
		stopEngine: (...a) => stopEngine($d, ...a),
		engineClient: (...a) => engineClient($d, ...a),
	};
	Object.assign($d, api);
	return api;
}
