// dsh-exam-copilot — 宿主半边
//
// 形态铁律（踩过，勿改）：
// 1. 必须是 `export const name` + `export const inject` + `export function apply`。
//    写成 `export default class` 会让整块功能静默消失：loader 的 unwrapExports 只取 default，
//    于是 name/inject/Config 全丢，cordis 读不到静态 inject，依赖注入为空，
//    且类插件执行路径只调 instance[Symbol.for('cordis.init')]，普通 class 没有 → apply 从不执行。
// 2. apply 不能返回值。返回非 thenable 会被判 `Invalid effect`，fiber 直接标失败。
// 3. inject 刻意留空 + apply 内嵌 ctx.inject(...)：cordis 把 inject 里每一项都当必需，
//    任一缺失整个 fiber 不加载。而 webServer / tools 在不同宿主形态下未必同时存在。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from './core/store.js';
import { EngineClient, waitForHealthy } from './core/engine-client.js';
import { validateZones, emptyProfile, zonesByRole, ROLE_KEYS, ZONE_ROLES, CONTENT_ROLES, toRelative, migrateZones, mergeDetectedZones } from './core/zones.js';
import { ACTIONS, ACTION_NAMES, validateAction } from './core/actions.js';
import { RUN_STATE, PAUSE_REASON } from './core/guardrails.js';
import { SolverPool } from './core/llm.js';
import { WebSearcher } from './core/web-search.js';
import { Runner } from './core/runner.js';
import { AUTO_ACCEPT, BankIndex, CONFIDENCE, matchQuestion, normalizeStem } from './core/bank.js';
import { matchAcrossBanks, makeMissRecord, summarizeMisses } from './core/multi-bank.js';
import { ANSWER_KIND, parseAnswer } from './core/answer.js';
import { BankStore, dedupe, normalizeItem } from './core/bank-store.js';
import { dispatch as importDispatch, isSupported, extOf } from './core/importer.js';
import { bytesToText, hintFor } from './core/doc-read.js';
import { validateAnswer } from './core/answer.js';
import { createDomReader, createStructReader, probeCdp } from './core/dom-reader.js';
import { BrowserLauncher, listBrowsers } from './core/browser-launch.js';
import { buildOverlayState, toStepLine } from './core/overlay-view.js';

/** 需要按字节解析的扩展名（纯文本类以外的）。
 *
 *  刻意包含 pdf/doc/xls：它们现在会走 bytesToText，
 *  由那里返回"能听懂、能照做"的提示，而不是像旧代码那样
 *  用一句 NEEDS_TEXT_EXTRACT 打发（那是个从未实现的占位）。 */
const BINARY_EXTS = new Set(['.docx', '.xlsx', '.pdf', '.doc', '.xls']);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const ENGINE_DIR = path.join(PLUGIN_ROOT, 'engine');
const CHANNEL = '/exam-copilot';

/** 版本号唯一来源：package.json。
 *
 * 为什么要读而不是硬编码：
 *    之前 index.js 写 '0.2.0'、server.py 写 "0.1.0"、package.json 又一份，
 *    面板上显示的引擎版本和插件版本对不上，用户看到自相矛盾的画面。
 *    现在只认 package.json，其余地方全部读它。
 *  读失败时回落 '0.0.0-unknown' —— 宁可显示"未知"，也不要显示一个假的版本。 */
function readPluginVersion() {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
		return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0-unknown';
	} catch {
		return '0.0.0-unknown';
	}
}

const PLUGIN_VERSION = readPluginVersion();

export const name = 'exam-copilot';
export const inject = [];

function ok(value) {
	return { ok: true, value };
}

function fail(code, message, details = {}) {
	return { ok: false, error: { code, message, details } };
}

/** 数据目录：~/.dsh/exam-copilot/
 *  刻意不放进插件目录 —— 插件升级/重装会整个替换目录，用户数据必须独立。 */
function resolveDataDir(ctx) {
	try {
		const home = ctx?.dsh?.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
		return path.join(home, 'exam-copilot');
	} catch {
		return path.join(os.homedir(), '.dsh', 'exam-copilot');
	}
}

/** 找可用 Python：必须带 PIL。
 *
 *  顺序：配置 → 环境变量 → PATH（python3 / python / py）。
 *  刻意不写死任何绝对安装路径 —— 换机器就失效，也不该出现在代码里。
 *  Windows 上额外试 `py -3`，它是最常见的带依赖解释器入口。 */
function resolvePython(configured) {
	const candidates = [
		configured,
		process.env.EXAM_PYTHON,
		'python3',
		'python',
		process.platform === 'win32' ? 'py' : null,
	].filter(Boolean);
	for (const c of candidates) {
		try {
			if (c.includes('/') || c.includes('\\')) {
				if (fs.existsSync(c)) return c;
			} else {
				return c; // 交给 PATH 解析
			}
		} catch {
			/* 探测失败继续下一个 */
		}
	}
	return null;
}

/** 该解释器是否真能用（能 import PIL）。
 *  自动探测出来的候选必须实测，否则会在启动引擎时才报错，错误信息还很难懂。 */
function pythonHasPillow(python) {
	return new Promise((resolve) => {
		const args = python === 'py' ? ['-3', '-c', 'import PIL,sys;print(PIL.__version__)'] : ['-c', 'import PIL,sys;print(PIL.__version__)'];
		try {
			const p = spawn(python, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let out = '';
			p.stdout?.setEncoding?.('utf8');
			p.stdout?.on?.('data', (d) => {
				out += String(d);
			});
			p.on('error', () => resolve(false));
			p.on('exit', (code) => resolve(code === 0 && out.trim().length > 0));
			setTimeout(() => {
				try {
					p.kill();
				} catch {
					/* ignore */
				}
				resolve(false);
			}, 8000);
		} catch {
			resolve(false);
		}
	});
}

/** 依序挑第一个能用的解释器。全部不可用时回 null 并给出明确原因。 */
async function pickPython(configured) {
	const primary = resolvePython(configured);
	if (!primary) return { python: null, reason: '没有配置 Python，也没在 PATH 里找到' };
	if (await pythonHasPillow(primary)) return { python: primary, reason: '' };

	// 主候选不可用，把其余候选全试一遍
	const others = ['python3', 'python', process.platform === 'win32' ? 'py' : null, process.env.EXAM_PYTHON, configured].filter(
		(c) => c && c !== primary
	);
	for (const c of others) {
		if (await pythonHasPillow(c)) return { python: c, reason: `首选 ${primary} 不可用，改用 ${c}` };
	}
	return { python: null, reason: `${primary} 存在但缺少 Pillow，且没有其他可用解释器` };
}

/** webServer 同源闸门：按 Host 判，缺 Origin 时放行。
 *
 *  为什么不能要求 Origin 存在：浏览器同源 GET 从不带 Origin，
 *  DSH Desktop 的代理还会主动剥掉它 —— 要求存在等于卡片永远拿不到数据。
 *  真正的防线是 Host 必须是回环：rebinding 页面伪造不了 Host。 */
function sameOrigin(req) {
	const host = req.headers?.host;
	if (host !== undefined && !isLoopbackAuthority(host)) return false;
	if (req.headers?.['sec-fetch-site'] === 'cross-site') return false;
	const origin = req.headers?.origin;
	if (origin === undefined) return true;
	try {
		const parsed = new URL(origin);
		if (host === undefined) return isLoopbackAuthority(parsed.host);
		return parsed.host === host;
	} catch {
		return false;
	}
}

function isLoopbackAuthority(host) {
	const lower = String(host).toLowerCase();
	const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
	return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * 把 llm 服务的可用性描述成可读对象（诊断用）。
 *
 * 存在的意义：拿不到模型时，插件所有路径的表现都是"没答案 → 转人工"，
 * 与"模型答错了"无法区分。实测为此多跑了好几轮才定位。
 * @param {object|null} llm - 宿主的 llm 服务
 * @returns {{available: boolean, providers: number, reason?: string}}
 */
function describeLlm(llm) {
	if (!llm) return { available: false, providers: 0, reason: 'ctx.llm 不存在（宿主未提供模型服务）' };
	if (typeof llm.stream !== 'function') {
		return { available: false, providers: 0, reason: 'llm 没有 stream 方法（接口形状不符）' };
	}
	let providers = [];
	try {
		providers = llm.listProviders?.() ?? [];
	} catch (err) {
		return { available: false, providers: 0, reason: `listProviders 抛错: ${err?.message ?? err}` };
	}
	return { available: providers.length > 0, providers: providers.length };
}

/**
 * 安全获取宿主服务。
 *
 * 为什么需要这个：Cordis 的注入服务**不能在声明 inject 之前直接访问** ——
 * 写 `ctx.attachments` 会抛 `cannot get property "attachments" without inject`，
 * 而且这个异常会把整个 handler 打成 INTERNAL（
 * 连 status 这种纯查询都挂了）。
 *
 * `ctx.get(name)` 不做注入检查，拿不到就返回 undefined，
 * 正好符合"有就用、没有就降级"的需求。
 * @param {object} ctx - Cordis 上下文
 * @param {string} name - 服务名
 * @returns {any} 服务实例，或 undefined
 */
function tryGetService(ctx, name) {
	try {
		return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
	} catch {
		return undefined;
	}
}

export function apply(ctx) {
	const logger = ctx.logger ?? console;
	// 最近日志环形缓冲：面板通过 logs.recent 拉取，排查时不用去翻宿主日志
	const recentLogs = [];
	const LOG_CAP = 200;
	const pushLog = (level, msg) => {
		recentLogs.push({ t: Date.now(), level, msg: String(msg) });
		if (recentLogs.length > LOG_CAP) recentLogs.splice(0, recentLogs.length - LOG_CAP);
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

	const dataDir = resolveDataDir(ctx);
	const store = new Store(dataDir);

	// 答题用浏览器：由插件自己启动（不该让用户自己开调试端口）。
	// 懒启动 —— 不开 DOM 补救就一个进程都不起。
	const browserLauncher = new BrowserLauncher({
		dataDir,
		log: (m) => log(`[browser] ${m}`),
	});
	const bankStore = new BankStore(store.banksDir);

	// 题库索引缓存：按 bankId 缓存 BankIndex，避免每题都重新解析 800 条。
	// 用 bank 的 updatedAt 做失效判断（改过就重建）。
	const bankIndexCache = new Map();

	const state = {
		startedAt: Date.now(),
		engine: null, // { proc, client, info }
		engineStarting: null,
		lastError: null,
		pythonPath: null,
		// S2：当前运行
		runner: null,
		llm: null, // 宿主模型服务（可选）
		lastSnapshot: null,
		// 运行期悬浮窗是否在显示（原生窗口，脱离 DSH）
		overlayActive: false,
		// 收尾进行中（防止 DONE 快照连续触发两次 restore）
		endingRun: false,
	};

	/** 推送运行状态变化给面板（面板轮询 run.state 即可，这里只留钩子）。 */
	function publishRunState(snapshot) {
		state.lastSnapshot = snapshot;
		// 顶层原生悬浮窗（DSH 已最小化，页面 DOM 悬浮窗看不见）
		pushOverlayState(snapshot);

		// 自然结束（答完全部题 / 预算到）时自动收尾。
		//
		// 为什么必须在这里收：此时 DSH 是最小化状态，用户看不到面板，
		// 也没有别的东西会触发"恢复 DSH"。若不管，用户会面对一个空桌面 ——
		// 悬浮窗一闪就没了、DSH 也不回来，只能去任务栏翻。
		// 停留 3 秒是为了让「已完成 · 答案 X」真的被看到。
		const run = snapshot?.run;
		// 答完（DONE）不再自动关窗：用户要看待复核清单，由用户点「停止并返回」退出。
		// 只有用户主动停止（STOPPED）才收尾并恢复宿主窗口。
		if (run === RUN_STATE.DONE && state.overlayActive && !state.doneAnnounced) {
			state.doneAnnounced = true;
			const ms = snapshot?.modelStats;
			if (ms) log(`[run] 本次模型调用 ${ms.calls} 题，失败 ${ms.failed} 次，共 ${ms.tokens} tokens`);
		}
		if (run === RUN_STATE.STOPPED && state.overlayActive && !state.endingRun) {
			void endRunAndRestore({ reason: `run_${run}`, keepOverlayMs: 0 });
		}
	}

	//#region 运行期悬浮窗
	/** 悬浮窗推流状态。节流到 ≤5 次/秒 —— 引擎每 120ms 出一帧快照，
	 *  逐帧发 HTTP 会把引擎线程打满，而人眼也看不出差别。 */
	let overlayTimer = null;
	let overlayLastText = '';
	let overlayLastAt = 0;
	let overlayPending = null;
	let overlayFlushTimer = null;
	let overlayTick = null;
	let overlayTimerSeconds = null;
	// 本次运行开始时间：悬浮窗步骤流只显示这之后的日志
	let overlayRunStartedAt = 0;
	let overlayTimerAt = 0;

	const OVERLAY_MIN_INTERVAL_MS = 200;

	/** 把 Runner 快照翻译成"屏幕显示什么"。
	 *
	 *  实现在 core/overlay-view.js（纯函数、可单测）—— 这里只做转调，
	 *  免得视图文案散落在闭包里，改一句提示都要重启宿主才能验证。
	 */
	function overlayStateOf(snap, extra = {}) {
		// 步骤流：取本次运行开始后的 [run] 日志
		const steps = [];
		for (const l of recentLogs) {
			if (l.t < overlayRunStartedAt) continue;
			const line = toStepLine(l.msg);
			if (line) steps.push(line);
		}
		return buildOverlayState(snap, {
			modeLabel: extra.modeLabel,
			timerSeconds: extra.timerSeconds ?? overlayTimerSeconds,
			steps,
		});
	}

	function pushOverlayState(snapshot) {
		if (!state.overlayActive) return;
		const now = Date.now();
		const payload = overlayStateOf(snapshot);
		const key = JSON.stringify(payload);
		// 两道限制，缺一不可：
		//   ① 上限：≥200ms 才发一次 —— Runner 每 120ms 一帧，逐帧发会把引擎线程打满；
		//   ② 去重：内容没变就 2 秒才发一次心跳 —— 否则静止时也在白白刷 HTTP。
		// 节流期间**不能丢弃**最新状态：步骤「题库完成→模型开始」常在 200ms 内连发，
		// 丢掉后悬浮窗会一直停在「题库」，直到模型答完才刷新（看起来像题库卡了几十秒）。
		// 所以节流内只记下来，到点补发最后一份。
		if (now - overlayLastAt < OVERLAY_MIN_INTERVAL_MS) {
			overlayPending = snapshot;
			if (!overlayFlushTimer) {
				overlayFlushTimer = setTimeout(() => {
					overlayFlushTimer = null;
					const s = overlayPending;
					overlayPending = null;
					if (s) pushOverlayState(s);
				}, OVERLAY_MIN_INTERVAL_MS - (now - overlayLastAt) + 10);
			}
			return;
		}
		if (key === overlayLastText && now - overlayLastAt < 2000) return;
		overlayLastText = key;
		overlayLastAt = now;
		state.engine?.client?.overlayUpdate?.(payload).catch(() => {});
	}

	/** 定期读倒计时区。只在配了 timer 区且运行中才读 —— 它是一次真实 OCR。 */
	function startTimerPolling(client, profile) {
		stopTimerPolling();
		const zone = zonesByRole(profile?.zones ?? []).timer;
		if (!zone) return;
		const region = [zone.x, zone.y, zone.w, zone.h];
		const every = 5000;
		overlayTick = setInterval(async () => {
			try {
				const r = await client.readTimer(region);
				if (r?.ok && Number.isFinite(r.seconds)) {
					overlayTimerSeconds = r.seconds;
					overlayTimerAt = Date.now();
					// 立刻推一帧，别等下一次 Runner 快照（可能好几百毫秒）
					pushOverlayState(state.lastSnapshot ?? {});
				}
			} catch {
				/* 读不到不影响主流程；悬浮窗显示 "—" */
			}
		}, every);
		overlayTick.unref?.();
		// 立刻读一次，否则前 5 秒是空的
		void client
			.readTimer(region)
			.then((r) => {
				if (r?.ok && Number.isFinite(r.seconds)) {
					overlayTimerSeconds = r.seconds;
					overlayTimerAt = Date.now();
				}
			})
			.catch(() => {});
	}

	function stopTimerPolling() {
		if (overlayTick) {
			clearInterval(overlayTick);
			overlayTick = null;
		}
	}

	/** 轮询悬浮窗上的按钮点击（暂停/继续、停止并返回）。 */
	function startOverlayActionPolling(client) {
		stopOverlayActionPolling();
		overlayTimer = setInterval(async () => {
			try {
				const r = await client.overlayActions();
				for (const a of r?.actions ?? []) {
					await handleOverlayAction(a.action);
				}
			} catch {
				/* 引擎短暂不可用不算错 */
			}
		}, 500);
		overlayTimer.unref?.();
	}

	function stopOverlayActionPolling() {
		if (overlayTimer) {
			clearInterval(overlayTimer);
			overlayTimer = null;
		}
	}

	async function handleOverlayAction(action) {
		if (action === 'toggle_pause') {
			if (!state.runner) return;
			if (state.runner.state.run === RUN_STATE.PAUSED) await handlers['run.resume']();
			else await handlers['run.pause']({ reason: PAUSE_REASON.USER });
			return;
		}
		if (action === 'stop_and_back') {
			// 停止运行 + 恢复 DSH 窗口 + 关掉悬浮窗
			await endRunAndRestore({ reason: 'stopped_from_overlay' });
		}
	}

	/** 收尾：停 Runner、恢复宿主窗口、隐藏悬浮窗。停止/结束/异常都走这里。 */
	async function endRunAndRestore({ reason, keepOverlayMs = 0 } = {}) {
		// 防重入：runner.stop() 会推一次 STOPPED 快照，publishRunState 里
		// 又看到 STOPPED 且 overlayActive 仍为 true，会再进来一次 ——
		// 不加这个 guard 就会递归（实测：一次「停止并返回」触发两遍 restore，
		// DSH 窗口被连续 RESTORE 两次，偶尔会闪）。
		if (state.endingRun) return;
		state.endingRun = true;
		try {
			await doEndRunAndRestore({ reason, keepOverlayMs });
		} finally {
			state.endingRun = false;
		}
	}

	async function doEndRunAndRestore({ reason, keepOverlayMs = 0 } = {}) {
		stopTimerPolling();
		stopOverlayActionPolling();
		const client = state.engine?.client;
		try {
			if (state.runner) {
				// 幂等：run.stop 已停过一次也没关系（stop() 内部只是置标志 + panic 引擎）
				await state.runner.stop();
				state.runner = null;
			}
		} catch {
			/* Runner 可能已结束 */
		}
		// 自然结束（答完/预算到）时让"已完成"停留一会儿再关，
		// 否则用户根本没机会看到最终结果。
		if (keepOverlayMs > 0 && state.overlayActive && client) {
			try {
				await client.overlayUpdate(
					overlayStateOf({ ...(state.lastSnapshot ?? {}), run: RUN_STATE.DONE })
				);
			} catch {
				/* ignore */
			}
			await new Promise((r) => setTimeout(r, keepOverlayMs));
		}
		state.overlayActive = false;
		overlayTimerSeconds = null;
		try {
			await client?.overlayHide?.();
		} catch {
			/* ignore */
		}
		// 恢复 DSH —— 这是"用户能回来"的唯一保证，绝不能跳过
		try {
			await client?.restoreHost?.();
		} catch {
			/* ignore */
		}
		log(`运行结束（${reason ?? 'unknown'}），已恢复宿主窗口`);
	}
	//#endregion

	//#region 引擎生命周期
	/** 读 engine.json（引擎启动后自己写的 port+token）。 */
	function readEngineInfo() {
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

	function isPidAlive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	/** 确保引擎在跑。并发调用共享同一个启动 Promise。 */
	async function ensureEngine() {
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

	async function stopEngine() {
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
	async function engineClient() {
		const engine = await ensureEngine();
		return engine.client;
	}

	//#endregion

	//#region RPC 分发
	/** 所有面板动作的唯一入口。返回 { ok, value } 或 { ok:false, error }。 */
	const handlers = {
		async status() {
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
		},

		async 'engine.start'() {
			try {
				const engine = await ensureEngine();
				return ok(await engine.client.health());
			} catch (err) {
				return fail('ENGINE_START_FAILED', err?.message ?? String(err));
			}
		},

		async 'engine.stop'() {
			await stopEngine();
			return ok({ stopped: true });
		},

		async 'settings.get'() {
			return ok(store.getSettings());
		},

		async 'settings.save'(body) {
			return ok(store.saveSettings(body?.patch ?? {}));
		},

		async 'profiles.list'() {
			return ok(store.listProfiles());
		},

		async 'profiles.get'(body) {
			const p = store.getProfile(body?.id);
			return p ? ok(p) : fail('NOT_FOUND', `没有这个配置: ${body?.id}`);
		},

		/** 新建 profile。channel: 'screen' | 'web'
		 *
		 * 刻意不再提供「全屏自动截图」选项：
		 *    全屏会把桌面图标、任务栏、其他窗口一起截进来污染 OCR，
		 *    而且区域边界应该由用户决定，不该由程序替他圈。
		 *    新建后一律是空白配置，必须自己圈选。
		 */
		async 'profiles.create'(body) {
			const id = body?.id || `profile-${Date.now().toString(36)}`;
			if (store.getProfile(id)) return fail('EXISTS', `已存在: ${id}`);
			const profile = emptyProfile(id, body?.name || '新建考试配置');
			profile.channel = body?.channel === 'web' ? 'web' : 'screen';
			store.saveProfile(profile);
			return ok(profile);
		},

		async 'profiles.save'(body) {
			const profile = body?.profile;
			if (!profile?.id) return fail('INVALID', 'profile.id 必填');
			// 保存前校验区域组：宁可这里报错，也不要运行时点偏
			const check = validateZones(profile.zones, profile.display);
			if (!check.ok && body?.allowInvalid !== true) {
				return fail('ZONES_INVALID', '区域组校验未通过', check);
			}
			profile.updatedAt = new Date().toISOString();
			store.saveProfile(profile);
			return ok({ profile, warnings: check.warnings });
		},

		async 'profiles.delete'(body) {
			return ok({ deleted: store.deleteProfile(body?.id) });
		},

		/** 元信息：可用角色、必需角色。面板据此渲染表单。 */
		/** 元信息：可用角色、必需角色。面板据此渲染角色下拉。
		 *
		 *  踩过的坑：这里曾引用已删除的 REQUIRED_ROLES，导致整个调用抛 ReferenceError，
		 *  面板拿到 {ok:false} 后角色下拉就是空的 —— 表现为"圈完选不了角色"。
		 *  现在只依赖真实存在的导出，并附上 labels 供面板显示中文名。
		 */
		async 'zones.meta'() {
			try {
				return ok({
					roles: ROLE_KEYS,
					labels: Object.fromEntries(ROLE_KEYS.map((k) => [k, ZONE_ROLES[k]?.label ?? k])),
					descs: Object.fromEntries(ROLE_KEYS.map((k) => [k, ZONE_ROLES[k]?.desc ?? ''])),
					contentRoles: CONTENT_ROLES,
				});
			} catch (err) {
				logErr('zones.meta 失败', err);
				return fail('META_FAILED', err?.message ?? String(err));
			}
		},

		/** 触发圈选（阻塞，最长 3 分钟）。返回矩形，角色由面板指派。 */
		async 'zones.pick'() {
			try {
				const client = await engineClient();
				const res = await client.pickZones({ timeoutMs: 180_000 });
				return ok(res);
			} catch (err) {
				return fail('PICK_FAILED', err?.message ?? String(err));
			}
		},

		/** 截图预览（面板缩略图）。刻意不隐藏宿主窗口 —— 预览只是要一张图，
		 * 为它把整个界面闪一下不值得。
		 *
		 *  注：它把图贴在**面板内**，而面板被 DSH 自己挡着，所以用户看到的往往是
		 *  被挡住的那一块。要看真实效果请用 zones.preview（第十一条）。
		 */
		/** 全屏预览：最小化 DSH，显示截图并高亮圈选区域 + 右下角预览窗。
		 *
		 * 与 screen.preview 的区别：
		 *    screen.preview 把图贴在面板里 —— 而面板被 DSH 自己挡着，
		 *    用户看到的是「被挡住的那一块」，等于没预览。
		 *    这个接口把 DSH 让开，全屏展示 + 高亮框 + 角标预览，
		 *    Esc / 右键退出。
		 *
		 *  regions 由前端传当前配置的 zones（含角色名，用于标签）。
		 */
		/** 自动版面识别：按窗口标题（或区域）截图 → OCR → 推断区域。
		 *
		 *  apply=true 时把结果与该配置现有区域合并（手动圈选的永不被覆盖），
		 *  并按窗口客户区写入 rel 比例坐标后保存；否则只返回检测结果供面板预览确认。
		 */
		async 'zones.detect'(body) {
			try {
				const client = await engineClient();
				const profile = body?.profileId ? store.getProfile(body.profileId) : null;
				const title = String(body?.title ?? profile?.window?.title ?? '');
				const res = await client.detectLayout({ title, region: body?.region ?? null, hideWindows: true });
				if (!res?.ok) return fail('DETECT_FAILED', res?.error || '版面识别失败', res);
				const win = res.window || null;
				let detected = (res.zones || []).map((z) => {
					const out = { ...z, source: 'auto' };
					const rel = win ? toRelative(z, win) : null;
					if (rel) out.rel = rel;
					return out;
				});
				if (body?.apply === true && profile) {
					// 上一次自动识别的结果直接作废（否则旧的错框会因 conf 更高而一直赖着不走）；
					// 只保留手动圈选 / 模板来的区域，它们优先级仍高于本次自动结果。
					const existing = migrateZones(profile.zones, win).filter((z) => z.source !== 'auto' && z.source !== 'legacy');
					profile.zones = mergeDetectedZones(existing, detected);
					// 没填标题时用自动定位到的前台窗口标题，否则运行期无法按窗口换算比例坐标
					const winTitle = title || (win && win.title) || '';
					if (winTitle) profile.window = { ...(profile.window || {}), title: winTitle };
					profile.updatedAt = new Date().toISOString();
					store.saveProfile(profile);
					detected = profile.zones;
				}
				return ok({ zones: detected, score: res.score, notes: res.notes || [], window: win, engine: res.engine, applied: body?.apply === true && !!profile });
			} catch (err) {
				return fail('DETECT_FAILED', err?.message ?? String(err));
			}
		},

		async 'zones.preview'(body) {
			try {
				const client = await engineClient();
				const res = await client.previewZones({
					regions: Array.isArray(body?.regions) ? body.regions : [],
					timeoutMs: Number(body?.timeoutMs) || 300_000,
				});
				return ok(res);
			} catch (err) {
				return fail('PREVIEW_FAILED', err?.message ?? String(err));
			}
		},

		async 'screen.preview'(body) {
			try {
				const client = await engineClient();
				const shot = await client.shotDataUrl(body?.region ?? null, body?.maxWidth ?? 520);
				if (!shot) return fail('SHOT_EMPTY', '截图失败');
				return ok(shot);
			} catch (err) {
				return fail('SHOT_FAILED', err?.message ?? String(err));
			}
		},

		/** 只读识别：S1 的验收动作。截指定区域 → OCR → 结构化题目。 */
		/** 只读识别（配置自检）。
		 *
		 * 关键修正：
		 *    以前每次自检都重新截屏，于是"预览看到的那张图"和"自检识别的那张图"
		 *    是两次独立截图 —— 中间界面一变（滚动、弹窗、切窗口），
		 *    识别内容就和用户看到的完全对不上。
		 *    现在：如果传了 cachedImagePath 就用那张已缓存的图；
		 *    否则实时截图，并把它缓存下来，供下一次自检复用。
		 */
		async 'ocr.read'(body) {
			try {
				const client = await engineClient();
				const cached = body?.cachedImagePath;
				const res = await client.ocr({
					region: body?.region ?? null,
					engine: body?.engine ?? 'auto',
					offset: body?.offset,
					imagePath: cached || null,
					// 用缓存图时不再裁切（图已经是那个区域了）
					reuseCached: Boolean(cached),
				});
				return ok({ ...res, fromCache: Boolean(cached) });
			} catch (err) {
				return fail('OCR_FAILED', err?.message ?? String(err));
			}
		},

		/** 预览并缓存截图：返回 dataURL + 落盘路径。
		 *
		 *  面板「截图预览」调这个；缓存路径记在 state 里，
		 *  紧接着的「配置自检」会复用它，保证看到什么就识别什么。 */
		async 'screen.previewCached'(body) {
			try {
				const client = await engineClient();
				const region = body?.region ?? null;
				const shot = await client.screenshotToFile(region, {
					maxWidth: body?.maxWidth ?? 720,
					dir: path.join(dataDir, 'cache'),
					name: body?.name || 'preview',
				});
				if (!shot) return fail('SHOT_EMPTY', '截图失败');
				state.lastPreview = { path: shot.path, region, at: Date.now() };
				return ok(shot);
			} catch (err) {
				return fail('SHOT_FAILED', err?.message ?? String(err));
			}
		},

		// ── S3：题库 ─────────────────────────────────────────

		/** 题库列表（含分类、题数、命中统计）。 */
		async 'banks.list'() {
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
		},

		async 'banks.create'(body) {
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
		},

		async 'banks.delete'(body) {
			try {
				const deleted = bankStore.delete(body?.id);
				bankIndexCache.clear();
				return ok({ deleted });
			} catch (err) {
				return fail('BANK_DELETE_FAILED', err?.message ?? String(err));
			}
		},

		async 'banks.get'(body) {
			const meta = bankStore.getMeta(body?.id);
			if (!meta) return fail('NOT_FOUND', `没有这个题库: ${body?.id}`);
			// 不返回全部题（可能上万条），只给前 20 条做预览
			const items = bankStore.loadItems(body.id).slice(0, 20);
			return ok({ meta, preview: items, previewTotal: meta.count ?? items.length });
		},

		/** 列出本机已安装的浏览器，供面板让用户选择用哪个考试。
		 *
		 * 为什么不替用户选：
		 *    用户可能在多个浏览器里考试（公司要求 Edge / 个人用 Chrome），
		 *    让用户选比替他决定更靠谱。
		 */
		/** 最近日志（最多 200 行）。since=时间戳 时只返回之后的，便于面板增量轮询。 */
		async 'logs.recent'(body) {
			const since = Number(body?.since ?? 0);
			const lines = since ? recentLogs.filter((l) => l.t > since) : recentLogs.slice();
			return ok({ lines, count: lines.length, cap: LOG_CAP });
		},

		async 'browsers.list'() {
			try {
				const list = listBrowsers();
				return ok({ browsers: list, count: list.length });
			} catch (err) {
				return ok({ browsers: [], count: 0, reason: String(err?.message ?? err) });
			}
		},

		/** 浏览器 DOM 通道。
		 *  action：
		 *    ensure（默认）—— 没起就启动一个，然后探测；已起就直接探测
		 *    probe         —— 只探测，不启动
		 *    close         —— 关掉本插件启动的浏览器（外部复用的一律不动）
		 *
		 * 为什么默认是 ensure："不应当由用户自行调试，应当由插件完成"。
		 *  只留 probe 会把启动责任推回给用户。
		 */
		async 'browser.probe'(body) {
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
		},

		/** 关闭答题用浏览器（面板上的「关闭浏览器」按钮）。 */
		async 'browser.close'() {
			try {
				const r = browserLauncher.close();
				return ok(r);
			} catch (err) {
				return ok({ closed: false, reason: String(err?.message ?? err) });
			}
		},
		/** 列出某题库下已导入的来源文件（供面板展示与删除）。
		 *
		 * 选中题库后应能看到它由哪些文件组成，
		 *  并且能单独删掉某个文件导入的那批题。
		 *  所以这里返回 hash —— 删除时用它定位，而不是文件名
		 *  （同名文件可能内容不同，hash 才是唯一身份）。
		 */
		async 'banks.sources'(body) {
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
		},

		/** 删除某个来源文件导入的题。
		 *
		 *  只删这个文件贡献的题，不动其他文件导入的、也不动手工补的。
		 *  判据是题上的 srcHash（导入时写入）。
		 */
		async 'banks.removeSource'(body) {
			const { id, hash } = body ?? {};
			if (!id) return fail('NO_BANK', '需要指定题库');
			if (!hash) return fail('NO_HASH', '需要指定要删除的文件');
			const meta = bankStore.getMeta(id);
			if (!meta) return fail('NOT_FOUND', `没有这个题库: ${id}`);
			
			const res = bankStore.removeSource(id, hash);
			bankIndexCache.clear();
			return ok({ ...res, bankId: id });
		},

		/**
		 * 导入题库。
		 *
		 * 关键取舍（S3 设计原则）：不做"全自动导入"。
		 * 文档排版千差万别，机器只能粗切分，必须人工确认。
		 * 所以这里返回 split 结果 + warnings，由面板展示、让用户确认后再入库。
		 *
		 * dryRun=true（默认）只切分不入库 —— 用户先看切得对不对。
		 */
		async 'banks.import'(body) {
			const { filePath, fileBytes, fileName, text, ext, bankId, dryRun = true } = body ?? {};

			let raw = text;
			let fileExt = ext;
			let sourceName = fileName || filePath || '';
			// 解析来源有两种，必须分开处理，不能都当纯文本读：
			//   fileBytes = 拖进来的文件（浏览器给的是字节，**没有磁盘路径**）
			//   filePath  = 用户填/选的磁盘路径
			// 两者最终都归一到 raw（纯文本）+ fileExt（决定 dispatch 用哪个解析器）。
			let fromBlob = false;
			// 原始字节：用来算文件指纹，判断「这个文件是不是已经导过」。
			// 只有二进制格式（docx/xlsx/…）才有；纯文本走 text 分支时为 null。
			let blobBuf = null;

			if (!raw && fileBytes) {
				// 拖入路径：字节在手里，先按魔数判真实类型再解
				try {
					const buf = Buffer.from(String(fileBytes), 'base64');
					blobBuf = buf;
					if (buf.length === 0) return fail('EMPTY_FILE', '文件是空的');
					const r = bytesToText(buf, sourceName);
					raw = r.text;
					// 关键：用**实际解析出的类型**决定后续 dispatch。
					// 用户把 xlsx 存成 .csv 的情况很常见，按扩展名分派会解析错。
					fileExt = r.kind === 'docx' ? '.txt' : r.kind === 'xlsx' ? '.tsv' : fileExt || extOf(sourceName) || '.txt';
					fromBlob = true;
				} catch (err) {
					return fail('PARSE_FAILED', err?.message ?? String(err), {
						hint: hintFor(err?.userHint ?? 'unknown', sourceName),
					});
				}
			}

			if (!raw && filePath) {
				const e = extOf(filePath);
				if (!isSupported(filePath)) {
					// 说清楚"支持什么"，而不是只说"不支持"
					return fail(
						'UNSUPPORTED',
						`不支持的文件类型: ${e || '(无扩展名)'}`,
						{ hint: hintFor('unknown', filePath) }
					);
				}
				try {
					fileExt = fileExt || e;
					if (BINARY_EXTS.has(e)) {
						// 二进制格式：读字节 → doc-read 解析。
						// 以前这里是直接 return NEEDS_TEXT_EXTRACT 占位（从未实现），
						// 现在 docx/xlsx 真的能读了；pdf/doc/xls 会给出可执行建议。
						const buf = fs.readFileSync(filePath);
						blobBuf = buf;
						const r = bytesToText(buf, filePath);
						raw = r.text;
						fileExt = r.kind === 'docx' ? '.txt' : r.kind === 'xlsx' ? '.tsv' : '.txt';
					} else {
						raw = fs.readFileSync(filePath, 'utf8');
					}
				} catch (err) {
					if (err?.userHint) {
						return fail('NEEDS_TEXT_EXTRACT', err.message, {
							hint: hintFor(err.userHint, sourceName),
						});
					}
					return fail('READ_FAILED', `读取文件失败: ${err?.message ?? err}`);
				}
			}

			if (!raw || !String(raw).trim()) {
				return fail('EMPTY', '没有可导入的内容（文件可能是空的，或整页是图片）');
			}

			let parsed;
			try {
				parsed = importDispatch(String(raw), fileExt || '.txt');
			} catch (err) {
				return fail('PARSE_FAILED', err?.message ?? String(err));
			}

			// 归一化
			const normalized = [];
			const bad = [];
			const answerIssues = [];
			for (const rawItem of parsed.items) {
				const it = normalizeItem(rawItem, { source: body?.source || sourceName || '' });
				if (it) {
					normalized.push(it);
					// 答案质量校验：把"答案与题型不自洽"的问题提前暴露，
					// 而不是等跑起来点错选项才发现
					const issues = validateAnswer(it.answer, it.qtype, (it.options || []).length);
					if (issues.length > 0) {
						answerIssues.push({ stem: it.stem.slice(0, 40), answer: it.answer, issues });
					}
				} else bad.push(rawItem);
			}

			const deduped = dedupe(normalized);

			const summary = {
				rawCount: parsed.items.length,
				normalizedCount: normalized.length,
				afterDedupe: deduped.length,
				dropped: bad.length,
				// 用户最关心的几个数，直接给出，不让人去猜
				withAnswer: deduped.filter((it) => it.answer).length,
				answerIssueCount: answerIssues.length,
				answerIssueSamples: answerIssues.slice(0, 8),
				warnings: [...(parsed.warnings ?? [])],
			};
			if (bad.length > 0) summary.warnings.push(`${bad.length} 条缺少题干，已跳过`);
			if (normalized.length > deduped.length) {
				summary.warnings.push(`去重移除 ${normalized.length - deduped.length} 条重复题`);
			}
			if (answerIssues.length > 0) {
				summary.warnings.push(`${answerIssues.length} 条题的答案与题型可能不自洽，入库前请核对`);
			}

			// ── 文件指纹查重──
			//
			// 为什么不能只比文件名：题库文件常被复制成「题库 (1).docx」，
			// 名字不同内容一样；也可能同名但内容更新过。
			// 所以用 sha256 判内容，文件名只用于**告诉用户是哪个文件**。
			const fileHash =
				blobBuf && blobBuf.length > 0
					? crypto.createHash('sha256').update(blobBuf).digest('hex').slice(0, 32)
					: null;
			
			if (fileHash && bankId) {
				const prev = bankStore.findSource(bankId, fileHash);
				if (prev) {
					// 已导入过：这不是错误，是「你做完了」。
					// 所以 ok:true + 明确告知，而不是弹红字让用户以为失败了。
					return ok({
						dryRun,
						alreadyImported: true,
						summary: {
							rawCount: parsed.items.length,
							normalizedCount: 0,
							afterDedupe: 0,
							dropped: 0,
							withAnswer: 0,
							answerIssueCount: 0,
							warnings: [],
						},
						preview: [],
						all: 0,
						fromBlob,
						sourceName,
						// 让面板能显示「这个文件在 X 时间已导入过」
						previous: { name: prev.name, at: prev.at, size: prev.size },
					});
				}
			}
			
			// dryRun：只返回切分结果供人工确认
			if (dryRun) {
				return ok({ dryRun: true, summary, preview: deduped.slice(0, 50), all: deduped.length, fromBlob, sourceName });
			}

			// 真正入库
			if (!bankId) return fail('NO_BANK', '需要指定 bankId 才能入库');
			const meta = bankStore.getMeta(bankId);
			if (!meta) return fail('NOT_FOUND', `没有这个题库: ${bankId}`);
			// 用 appendItemsDedup 而不是 appendItems：
			// 上一版是纯追加，把同一份文件导第二次会把整份文件再进一遍
			// （调用方的 dedupe 只看「本次这一批」，看不见库里已有的题）。
			const res = bankStore.appendItemsDedup(bankId, deduped, { srcHash: fileHash || '' });
			bankIndexCache.clear();
			
			// 记下这个文件已导入，下次同内容直接拦
			if (fileHash) {
				bankStore.recordSource(bankId, fileHash, {
					name: sourceName,
					size: blobBuf ? blobBuf.length : 0,
					// 记「实际入库了多少题」——去重跳过的不算，
					// 面板上「这个文件贡献了 N 题」用的就是它。
					itemCount: res.added || 0,
				});
			}
			
			// 把「与库内重复被跳过」的量说清楚 —— 用户最关心的就是这个数
			if (res.skipped > 0) {
				summary.warnings.push(`与库内已有题目重复，跳过 ${res.skipped} 条`);
			}
			if (res.conflicts > 0) {
				summary.warnings.push(`${res.conflicts} 条题干相同但答案不同，已按不同版本保留并标「答案冲突」`);
			}
			
			return ok({
				dryRun: false,
				summary,
				...res,
				bankId,
				fromBlob,
				sourceName,
				alreadyImported: false,
			});
		},

		/** 未命中记录：题库漏了哪些题。
		 *
		 * 这是 S3 唯一缺的反馈闭环：
		 *  只记命中 = 永远不知道题库缺什么。跑完一场考试，
		 *  这里应该清楚列出「哪些题干所有库都没匹配上」。
		 *  默认按题干聚合：同一道题反复 miss 才值得补。
		 */
		async 'banks.misses'(body) {
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
		},

		/** 清空未命中记录。用户补完题后可能想重新统计一轮。 */
		async 'banks.clearMisses'() {
		  return ok({ cleared: bankStore.clearMisses() });
		},

		/** 把一条 miss 直接补成题库条目 —— 闭环的最后一格。
		 *
		 *  为什么不让用户去「导入」里重新粘贴：那要他自己把题干、选项、答案
		 *  再手打一遍，而 miss 记录里题干和选项**已经在了**，只缺答案。
		 *  这里只要求传 answer，其余从 miss 记录里取。
		 */
		async 'banks.fillMiss'(body) {
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
		},

		/** 题库检索（面板里搜题）。 */
		async 'banks.search'(body) {
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
		},

		/**
		 * 用题库匹配一道题（不落库，供面板/工具调试）。
		 * 返回 matchQuestion 的完整结果，包括置信度与拒绝原因。
		 */
		async 'banks.match'(body) {
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
		},

		/** 清掉题库内容（保留 meta），用于重新导入。 */
		async 'banks.clear'(body) {
			const id = body?.id;
			const meta = bankStore.getMeta(id);
			if (!meta) return fail('NOT_FOUND', `没有这个题库: ${id}`);
			bankStore.replaceItems(id, []);
			bankIndexCache.clear();
			return ok({ cleared: true, id });
		},

		async panic() {
			try {
				const client = await engineClient();
				// 同时让 Runner 停下：引擎急停但状态机还在跑，等于没停
				if (state.runner) {
					try {
						await state.runner.pause(PAUSE_REASON.PANIC);
					} catch {
						/* Runner 可能已结束 */
					}
				}
				return ok(await client.panic());
			} catch (err) {
				return fail('PANIC_FAILED', err?.message ?? String(err));
			}
		},

		// ── S2：运行控制 ─────────────────────────────────────

		/** 能力清单：面板据此决定显示什么（动作白名单 + 模型可用性）。 */
		async 'run.capabilities'() {
			let models = { available: false, providers: [] };
			if (state.llm) {
				try {
					const providers = state.llm.listProviders() ?? [];
					const detail = [];
					for (const p of providers) {
						let ms = [];
						try {
							ms = (await state.llm.listModels(p.id)) ?? [];
						} catch {
							/* 单个 provider 失败不影响其他 */
						}
						detail.push({
							id: p.id,
							name: p.name ?? p.id,
							models: ms.map((m) => ({
								id: m.id ?? m.name ?? String(m),
								name: m.name ?? m.displayName ?? m.id ?? String(m),
							})),
						});
					}
					models = { available: providers.length > 0, providers: detail };
				} catch (err) {
					models = { available: false, providers: [], error: err?.message ?? String(err) };
				}
			}
			return ok({
				actions: ACTION_NAMES.map((n) => ({ name: n, risk: ACTIONS[n].risk, desc: ACTIONS[n].desc })),
				channels: ['screen', 'web'],
				models,
				states: Object.values(RUN_STATE),
			});
		},

		/** 启动一次运行。mode: 'copilot'（只识别不点击）| 'auto'（全自动） */
		async 'run.start'(body) {
			if (state.runner && state.runner.state.run === RUN_STATE.RUNNING) {
				return fail('ALREADY_RUNNING', '已有运行在进行中');
			}
			const profile = body?.profileId ? store.getProfile(body.profileId) : null;
			if (!profile) return fail('NO_PROFILE', '请先选择并保存一个考试配置');

			const check = validateZones(profile.zones, profile.display);
			if (!check.ok) return fail('ZONES_INVALID', '区域组未通过校验', check);

			const mode = body?.mode === 'auto' ? 'auto' : 'copilot';
			// 协同模式：不执行任何动作。用 allowAutoSubmit=false + 只读通道实现
			const effectiveProfile = mode === 'copilot' ? { ...profile, channel: profile.channel ?? 'screen', _copilot: true } : profile;

			let client;
			try {
				client = await engineClient();
			} catch (err) {
				return fail('ENGINE_UNAVAILABLE', `引擎不可用：${err?.message ?? err}`);
			}

			// 引擎默认暂停，start 时由 Runner 显式放行
			let solver = null;
			if (effectiveProfile.answer?.useModel !== false && state.llm) {
				solver = new SolverPool(state.llm, {
					concurrency: effectiveProfile.answer?.concurrency ?? 3,
					votes: effectiveProfile.answer?.multiVote ?? 0,
					voters: effectiveProfile.answer?.voters ?? [],
					// 单次模型请求超时（秒，面板可调，10~300，默认 60）
					timeoutMs: Math.min(300, Math.max(10, Number(effectiveProfile.answer?.timeoutSec) || 60)) * 1000,
					// 联网检索：宿主 web 服务存在时才启用
					searcher: (() => {
						const web = tryGetService(ctx, 'web');
						return web ? new WebSearcher(web, { log }) : null;
					})(),
					// 用户在面板里选定的模型；空则由 SolverPool 自动挑第一个可用
					target: effectiveProfile.answer?.provider
						? { provider: effectiveProfile.answer.provider, model: effectiveProfile.answer.model }
						: null,
				});
			}

			// 屏幕尺寸：从引擎 health 拿，用于「坐标越界」校验。
			// 拿不到就传 null（Runner 会跳过该检查，不误伤）。
			let screenSize = null;
			try {
				const h = await client.health();
				if (h?.screen?.w > 0 && h?.screen?.h > 0) screenSize = { w: h.screen.w, h: h.screen.h };
			} catch {
				/* health 失败不影响启动，坐标校验降级为不检查 */
			}

			const runner = new Runner({
				engine: client,
				solver,
				store,
				profile: effectiveProfile,
				screenSize,
				// 视觉通道：截图必须经附件服务入库才能进消息
				// （llm 的 ImageBlock 要 ImageAttachmentRef，不接受内联 base64）。
				// ctx 上没有 attachments 时传 null，Runner 会降级为纯文字作答。
				attachments: tryGetService(ctx, 'attachments') ?? null,
				log: (msg, level) => log(`[run] ${msg}${level ? ` (${level})` : ''}`),
				onState: publishRunState,
				// 题库匹配器：把 profile 里选的题库接进来
				bankMatcher: buildBankMatcher(effectiveProfile),
				// DOM 补救（S4）：只在 web 通道时注入。
				// 桌面场景（channel=screen）传 null —— 不连浏览器就没有额外依赖。
				// 具体要不要用由 Runner 的 shouldUseDom 决定（OCR 可疑才连）。
				domReader:
					effectiveProfile?.channel === 'web'
						? createDomReader({ log: (m) => log(`[dom] ${m}`) })
						: null,
				// 结构化读题（S5）：web 通道优先于 OCR
				structReader:
					effectiveProfile?.channel === 'web'
						? createStructReader({ log: (m) => log(`[struct] ${m}`) })
						: null,
			});

			// 协同模式：**只去掉动作，不去掉题库**。
			//
			// 实测发现的原实现缺陷：
			//   旧代码把 `_resolve` 整个覆盖成 "只用 solver.solve()"，
			//   于是协同模式彻底绕过题库 —— 与 README「题库是省时间省钱的主力，
			//   高置信命中时完全不需要调模型」直接矛盾。
			//   例：题库有 medium 命中，但协同模式仍然去问模型，
			//   而且因为模型未被调用（宿主 llm 不可用时 solver 为 null），
			//   最终 answer=null、状态 paused/unknown_question ——
			//   **题库里明明有答案却答不出来。**
			//
			//   正确的协同模式应该是：走和全自动**完全相同**的作答链路
			//   （题库优先 → 模型兜底 → 都不行转人工），只是不产出点击动作。
			//   所以这里不再覆盖 `_resolve`，只覆盖 `_decide` 与 `_verifyCurrent`。
			if (mode === 'copilot') {
				runner._decide = (q, answer) => [];
				// 协同模式不需要翻页：解出答案就停，等用户输入
				runner._verifyCurrent = async () => {
					runner._apply({ type: 'PAUSE', reason: PAUSE_REASON.USER });
				};
			}

			state.runner = runner;
			state.doneAnnounced = false;
			overlayRunStartedAt = Date.now();

			// ── 开跑前的界面切换──────────
			//
			// 顺序不能反：**必须先最小化 DSH，再启动 Runner**。
			//   若先 start，第一帧截图（几十毫秒内）就会截到还没最小化的 DSH，
			//   于是第一题直接判"题目不完整 / 置信度不足" → 一开局就暂停。
			//   手工最小化也来不及，一定会被截图截到。
			//
			// 悬浮窗在最小化之后再显示：先让 DSH 退场，屏幕上立刻出现状态窗，
			// 中间不留"什么都没有"的空档，用户不会以为程序崩了。
			let overlayOk = false;
			try {
				await client.minimizeHost();
			} catch (err) {
				// 最小化失败不阻断启动：用户还能手动最小化，
				// 但第一题很可能识别失败，所以日志要说清楚。
				logErr('最小化宿主窗口失败（请手动最小化 DSH，否则截图会截到它）', err);
			}
			try {
				const ov = await client.overlayShow(
					overlayStateOf(
						{ run: RUN_STATE.RUNNING, current: null, stats: {}, answer: null },
						{ modeLabel: mode === 'auto' ? '考试助手 · 全自动' : '考试助手 · 人机协同' }
					)
				);
				overlayOk = ov?.ok === true;
				state.overlayActive = overlayOk;
				if (!overlayOk) log(`悬浮窗未能显示：${ov?.error ?? '未知原因'}`);
			} catch (err) {
				logErr('悬浮窗启动失败（不影响答题，但运行状态只能回面板看）', err);
			}
			if (overlayOk) {
				startOverlayActionPolling(client);
				startTimerPolling(client, effectiveProfile);
			}

			const res = await runner.start({ runId: `run-${Date.now().toString(36)}` });
			if (!res.ok) {
				state.runner = null;
				// 启动失败必须把界面还原，否则用户被留在一个最小化的 DSH 前面。
				await endRunAndRestore({ reason: 'start_failed' });
				return fail('START_FAILED', res.error);
			}
			return ok({ runId: res.runId, mode, overlay: overlayOk ? 'native' : 'none' });
		},

		async 'run.state'() {
			if (!state.runner) return ok({ run: RUN_STATE.IDLE, phase: null, active: false });
			return ok({ ...state.runner.snapshot(), active: true });
		},

		async 'run.pause'(body) {
			if (!state.runner) return fail('NO_RUN', '当前没有运行');
			const r = await state.runner.pause(body?.reason ?? PAUSE_REASON.USER);
			pushOverlayState(state.runner.snapshot());
			return ok(r);
		},

		async 'run.resume'() {
			if (!state.runner) return fail('NO_RUN', '当前没有运行');
			const r = await state.runner.resume();
			pushOverlayState(state.runner.snapshot());
			return r.ok ? ok(r) : fail('RESUME_FAILED', r.error);
		},

		async 'run.stop'() {
			if (!state.runner) return fail('NO_RUN', '当前没有运行');
			// endRunAndRestore 内部会 stop Runner；不在这里先停一次，
			// 否则同一个 Runner 会被 stop 两遍（幂等但日志会出现两条"停止"）。
			await endRunAndRestore({ reason: 'user_stop', keepOverlayMs: 800 });
			return ok({ stopped: true });
		},

		/** 显式确认允许提交（一次性）。这是"自动提交"的第二道人工闸。 */
		async 'run.confirmSubmit'(body) {
			if (!state.runner) return fail('NO_RUN', '当前没有运行');
			return ok(state.runner.confirmSubmit(body?.reason ?? 'user-confirmed-via-panel'));
		},

		/** 手动执行一个动作（调试/接管用）。仍走白名单，仍受引擎闸门约束。 */
		async 'run.act'(body) {
			const profile = body?.profileId ? store.getProfile(body.profileId) : null;
			const roles = profile ? Object.keys(zonesByRole(profile.zones)) : [];
			const checked = validateAction(body?.envelope, { channel: profile?.channel ?? 'screen', roles });
			if (!checked.ok) return fail(checked.error.code, checked.error.message);
			try {
				const client = await engineClient();
				const res = await client.act(checked.envelope, { region: null });
				return ok(res);
			} catch (err) {
				return fail('ACT_FAILED', err?.message ?? String(err));
			}
		},
	};

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
	//#endregion

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

	//#region 注册
	// 服务出现即挂、消失即卸 —— 插件本体永远能加载
	ctx.inject(['webServer'], (webCtx) => {
		webCtx.effect?.(() => mountHttpRoute(webCtx), 'exam-copilot: http route');
		webCtx.effect?.(() => mountOverlayRoute(webCtx), 'exam-copilot: overlay route');
	});

	// 工具注册（S1 只给只读与状态，动作类在 S2）
	ctx.inject(['tools'], (toolsCtx) => {
		try {
			registerTools(toolsCtx, { store, engineClient, dispatch, state });
		} catch (err) {
			logErr('工具注册失败', err);
		}
	});

	// 模型服务（可选）：宿主有 llm 就挂上，没有就降级成"仅题库/人工"。
	// 刻意不写进 static inject —— cordis 把 inject 每一项都当必需，
	// 缺失会导致整个 fiber 不加载，而 llm 在 TUI / headless 下未必存在。
	ctx.inject(['llm'], (llmCtx) => {
		try {
			const svc = typeof llmCtx.get === 'function' ? llmCtx.get('llm') : llmCtx.llm;
			if (svc) {
				state.llm = svc;
				log('模型服务已可用（可用于解题）');
			}
		} catch (err) {
			logErr('模型服务不可用', err);
		}
		return () => {
			state.llm = null;
		};
	});

	// 卸载时杀掉引擎，避免孤儿进程
	ctx.effect?.(() => () => {
		try {
			state.runner?.stop?.();
		} catch {
			/* ignore */
		}
		void stopEngine();
	}, 'exam-copilot: engine cleanup');

	log(`已加载 v${PLUGIN_VERSION}，数据目录 ${dataDir}`);

	// 联网搜索能力探测（只写日志，不影响答题）：
	// 查宿主是否向插件开放了某种搜索服务，结果决定「允许联网」能否真正落地。
	try {
		const names = ['search', 'webSearch', 'web', 'websearch', 'tools', 'toolRegistry', 'fetch', 'http', 'browser'];
		const found = [];
		for (const n of names) {
			const svc = tryGetService(ctx, n);
			if (svc !== undefined && svc !== null) {
				const keys = typeof svc === 'object' || typeof svc === 'function'
					? Object.keys(svc).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(svc) ?? {})).filter((k) => k !== 'constructor').slice(0, 12)
					: [];
				found.push(`${n}{${keys.join(',')}}`);
			}
		}
		log(`[probe] 联网服务探测：${found.length ? found.join('；') : '未发现 search/web/tools 类服务'}`);
		// 第二轮：web 服务的搜索提供者长什么样（只读形状，不发起搜索）
		const web = tryGetService(ctx, 'web');
		if (web) {
			const shape = (o) => {
				if (!o || (typeof o !== 'object' && typeof o !== 'function')) return String(o);
				const ks = Object.keys(o).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(o) ?? {})).filter((k) => k !== 'constructor');
				return `{${ks.slice(0, 15).join(',')}}`;
			};
			let listed;
			try {
				listed = web.listProviders?.();
			} catch (e) {
				listed = `listProviders 抛错：${e?.message ?? e}`;
			}
			const listedText = (() => {
				try {
					return JSON.stringify(listed, (k, v) => (typeof v === 'function' ? `[fn ${v.length}]` : v)).slice(0, 600);
				} catch {
					return shape(listed);
				}
			})();
			log(`[probe] web.listProviders()：${listedText}`);
			const sp = web.searchProviders;
			const spEntries = sp instanceof Map ? [...sp.entries()] : sp && typeof sp === 'object' ? Object.entries(sp) : [];
			log(`[probe] web.searchProviders：${spEntries.length} 个 · ${spEntries.slice(0, 6).map(([k, v]) => k + ':' + shape(v)).join('；') || shape(sp)}`);
			log(`[probe] web.config：${(() => { try { return JSON.stringify(web.config).slice(0, 300); } catch { return shape(web.config); } })()}`);
			const tools = tryGetService(ctx, 'tools');
			if (tools) {
				let names = [];
				try {
					const v = tools.view?.() ?? tools.root;
					const src = v?.list?.() ?? v?.names?.() ?? (v instanceof Map ? [...v.keys()] : v ? Object.keys(v) : []);
					names = [...src].map((x) => (typeof x === 'string' ? x : x?.name ?? '?'));
				} catch (e) {
					names = [`读取失败：${e?.message ?? e}`];
				}
				log(`[probe] tools 中与搜索相关：${names.filter((n) => /search|fetch|web/i.test(n)).slice(0, 20).join(',') || '（无或无法枚举）'}`);
			}
		}
		// 列出 ctx 上能看到的服务/属性名，便于发现未知命名的搜索服务
		const ctxKeys = new Set();
		for (let o = ctx, depth = 0; o && depth < 3; o = Object.getPrototypeOf(o), depth++) {
			for (const k of Object.getOwnPropertyNames(o)) if (!k.startsWith('_') && k !== 'constructor') ctxKeys.add(k);
		}
		log(`[probe] ctx 可见名：${[...ctxKeys].slice(0, 80).join(',')}`);
		// 模型服务是否接受联网类参数（只看形状，不实际调用）
		const llm = tryGetService(ctx, 'llm');
		if (llm) {
			const llmKeys = Object.keys(llm).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(llm) ?? {})).filter((k) => k !== 'constructor');
			log(`[probe] llm 服务方法：${llmKeys.slice(0, 30).join(',')}`);
		}
	} catch (err) {
		logErr('联网服务探测失败（忽略）', err);
	}
	//#endregion
}

/** 简单字符串 Jaccard（给检索用，避免为了一个函数 import 整个模块）。 */
function jaccardStr(a, b) {
	if (!a || !b) return 0;
	const bg = (s) => {
		const set = new Set();
		for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
		return set;
	};
	const A = bg(a);
	const B = bg(b);
	if (A.size === 0 || B.size === 0) return 0;
	let inter = 0;
	for (const x of A) if (B.has(x)) inter += 1;
	return inter / (A.size + B.size - inter);
}

/** 读取请求体，带大小上限。 */
function readJsonBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('body too large'));
				try {
					req.destroy();
				} catch {
					/* ignore */
				}
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (err) {
				reject(err);
			}
		});
		req.on('error', reject);
	});
}

/** 等 engine.json 出现。引擎冷启动需要时间（PIL import 可能 1-2s）。 */
async function waitForEngineInfo(read, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const info = read();
		if (info?.port && info?.token) return info;
		await new Promise((r) => setTimeout(r, 250));
	}
	return null;
}

/** 注册 agent 工具。让用户能在对话里直接「读一下现在这道题」。 */
function registerTools(toolsCtx, { store, engineClient, state }) {
	const tools = toolsCtx.tools ?? toolsCtx;
	if (!tools?.register) return;

	const register = (def) => {
		try {
			tools.register(def);
		} catch {
			/* 宿主形态不支持时静默跳过，不阻塞插件加载 */
		}
	};

	register({
		name: 'exam_status',
		description: '查看考试助手状态：引擎是否运行、可用的 OCR 引擎、屏幕尺寸、当前配置数量。',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		async execute() {
			const settings = store.getSettings();
			let health = null;
			try {
				const client = await engineClient();
				health = await client.health();
			} catch (err) {
				health = { ok: false, error: err?.message ?? String(err) };
			}
			return {
				ok: true,
				dataDir: store.root,
				settings,
				profiles: store.listProfiles().length,
				engine: health,
			};
		},
	});

	register({
		name: 'exam_read',
		description: '读取指定区域的题目（只识别，不操作）。返回 OCR 行、结构化题目（题干/选项/题号/题型）与耗时。需先用 profile 保存区域组。',
		parameters: {
			type: 'object',
			properties: {
				profileId: { type: 'string', description: '要读取的配置 id；省略则用区域为全屏' },
				engine: { type: 'string', enum: ['auto', 'hybrid', 'rapid', 'windows'], description: 'OCR 引擎，默认 auto' },
			},
			additionalProperties: false,
		},
		async execute(args) {
			const profile = args?.profileId ? store.getProfile(args.profileId) : null;
			const zones = profile ? zonesByRole(profile.zones) : {};
			const target = zones.question ?? zones.options ?? null;
			const region = target ? [target.x, target.y, target.w, target.h] : null;
			try {
				const client = await engineClient();
				const res = await client.ocr({ region, engine: args?.engine ?? 'auto', offset: region ? [region[0], region[1]] : [0, 0] });
				return { ok: true, profileId: profile?.id ?? null, region, result: res };
			} catch (err) {
				return { ok: false, error: err?.message ?? String(err) };
			}
		},
	});

	register({
		name: 'exam_panic',
		description: '立即暂停考试助手的一切自动动作（急停）。等价于点面板上的红色停止按钮。',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		async execute() {
			try {
				const client = await engineClient();
				if (state.runner) {
					try {
						await state.runner.pause('panic');
					} catch {
						/* ignore */
					}
				}
				return { ok: true, result: await client.panic() };
			} catch (err) {
				return { ok: false, error: err?.message ?? String(err) };
			}
		},
	});

	// ── S2：运行控制（让用户能在对话里启动/暂停/看状态）──

	register({
		name: 'exam_run',
		description:
			'启动 / 暂停 / 恢复 / 停止一次考试运行，或查看当前运行状态。默认人机协同（只识别不点击）；全自动需 mode="auto" 且配置已允许。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['start', 'pause', 'resume', 'stop', 'state'], description: '要执行的操作' },
				profileId: { type: 'string', description: 'start 时的配置 id' },
				mode: { type: 'string', enum: ['copilot', 'auto'], description: 'start 时的工作模式，默认 copilot' },
			},
			required: ['action'],
			additionalProperties: false,
		},
		async execute(args) {
			const action = args?.action;
			const res = await dispatch(
				action === 'start' ? 'run.start' : action === 'pause' ? 'run.pause' : action === 'resume' ? 'run.resume' : action === 'stop' ? 'run.stop' : 'run.state',
				{ profileId: args?.profileId, mode: args?.mode }
			);
			return res.ok ? { ok: true, result: res.value } : { ok: false, error: res.error };
		},
	});

	register({
		name: 'exam_confirm_submit',
		description:
			'显式允许本次运行执行"交卷"。这是自动提交的第二道人工闸：即使配置里开了 allowAutoSubmit，也需要调用本工具（或点面板按钮）确认一次。',
		parameters: { type: 'object', properties: { reason: { type: 'string', description: '确认理由，便于复盘' } }, additionalProperties: false },
		async execute(args) {
			const res = await dispatch('run.confirmSubmit', { reason: args?.reason });
			return res.ok ? { ok: true, result: res.value } : { ok: false, error: res.error };
		},
	});
}
