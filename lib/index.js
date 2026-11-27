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
import { validateZones, emptyProfile, zonesByRole, ROLE_KEYS, ZONE_ROLES, CONTENT_ROLES, toRelative, migrateZones, mergeDetectedZones, resolveZones } from './core/zones.js';
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
import { createLogging } from './plugin/logging.js';
import { createEngine } from './plugin/engine.js';
import { createBankIndex } from './plugin/bank-index.js';
import { createOverlay } from './plugin/overlay.js';
import { createRpc } from './plugin/rpc.js';
import { createRoutes } from './plugin/routes.js';
import { createRegistration } from './plugin/register.js';

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
 * 与"模型答错了"无法区分。
 * @param {object|null} llm - 宿主的 llm 服务
 * @returns {{available: boolean, providers: number, reason?: string}}
 */
function describeLlm(llm) {
	if (!llm) return { available: false, providers: 0, reason: '宿主未提供模型服务（llm 未注入）' };
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
	const d = { ctx, BINARY_EXTS, HERE, PLUGIN_ROOT, ENGINE_DIR, CHANNEL, readPluginVersion, PLUGIN_VERSION, name, ok, fail, resolveDataDir, resolvePython, pythonHasPillow, pickPython, sameOrigin, isLoopbackAuthority, describeLlm, tryGetService, jaccardStr, readJsonBody, waitForEngineInfo, registerTools };
	Object.assign(d, createLogging(d));
	const { log, logErr } = d;
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

	Object.assign(d, { dataDir, store, browserLauncher, bankStore, bankIndexCache, state });
	Object.assign(d, createEngine(d));
	Object.assign(d, createBankIndex(d));
	Object.assign(d, createOverlay(d));
	Object.assign(d, createRpc(d));
	Object.assign(d, createRoutes(d));
	createRegistration(d);
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
