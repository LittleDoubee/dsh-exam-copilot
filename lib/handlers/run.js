// 面板 RPC 处理函数：运行控制。依赖由 apply 统一注入。
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


async function hPanic(d) {
	const { state, engineClient, ok, fail } = d;
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
}


	// ── S2：运行控制 ─────────────────────────────────────

	/** 能力清单：面板据此决定显示什么（动作白名单 + 模型可用性）。 */
async function hRunCapabilities(d) {
	const { name, state, ok } = d;
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
}


/** 启动前的前置校验。通过返回 { profile, mode }，否则返回 { error }。 */
function prepareRunStart(d, body) {
	const { store, state, fail } = d;
	if (state.runner && state.runner.state.run === RUN_STATE.RUNNING) {
		return { error: fail('ALREADY_RUNNING', '已有运行在进行中') };
	}
	const profile = body?.profileId ? store.getProfile(body.profileId) : null;
	if (!profile) return { error: fail('NO_PROFILE', '请先选择并保存一个考试配置') };
	const check = validateZones(profile.zones, profile.display);
	if (!check.ok) return { error: fail('ZONES_INVALID', '区域组未通过校验', check) };
	const mode = body?.mode === 'auto' ? 'auto' : 'copilot';
	// 协同模式：不执行任何动作。用 allowAutoSubmit=false + 只读通道实现
	const effectiveProfile = mode === 'copilot' ? { ...profile, channel: profile.channel ?? 'screen', _copilot: true } : profile;
	return { profile: effectiveProfile, mode };
}

/** 模型解题池；未启用模型或宿主没有模型服务时返回 null。 */
function buildSolver(d, profile) {
	const { ctx, log, state, tryGetService } = d;
	if (profile.answer?.useModel === false || !state.llm) return null;
	const web = tryGetService(ctx, 'web');
	return new SolverPool(state.llm, {
		concurrency: profile.answer?.concurrency ?? 3,
		votes: profile.answer?.multiVote ?? 0,
		voters: profile.answer?.voters ?? [],
		// 单次模型请求超时（秒，面板可调，10~300，默认 60）
		timeoutMs: Math.min(300, Math.max(10, Number(profile.answer?.timeoutSec) || 60)) * 1000,
		// 联网检索：宿主 web 服务存在时才启用
		searcher: web ? new WebSearcher(web, { log }) : null,
		// 用户在面板里选定的模型；空则由 SolverPool 自动挑第一个可用
		target: profile.answer?.provider ? { provider: profile.answer.provider, model: profile.answer.model } : null,
	});
}

/** 屏幕尺寸用于「坐标越界」校验；拿不到返回 null，Runner 会跳过该检查。 */
async function readScreenSize(client) {
	try {
		const h = await client.health();
		if (h?.screen?.w > 0 && h?.screen?.h > 0) return { w: h.screen.w, h: h.screen.h };
	} catch {
		/* health 失败不影响启动，坐标校验降级为不检查 */
	}
	return null;
}

function createRunner(d, client, profile, solver, screenSize) {
	const { ctx, log, store, publishRunState, buildBankMatcher, tryGetService } = d;
	const web = profile?.channel === 'web';
	return new Runner({
		engine: client,
		solver,
		store,
		profile,
		screenSize,
		// 视觉通道：截图必须经附件服务入库才能进消息（llm 的 ImageBlock 要 ImageAttachmentRef）。
		// ctx 上没有 attachments 时传 null，Runner 会降级为纯文字作答。
		attachments: tryGetService(ctx, 'attachments') ?? null,
		log: (msg, level) => log(`[run] ${msg}${level ? ` (${level})` : ''}`),
		onState: publishRunState,
		bankMatcher: buildBankMatcher(profile),
		// DOM 补救与结构化读题只在 web 通道注入；桌面场景不连浏览器
		domReader: web ? createDomReader({ log: (m) => log(`[dom] ${m}`) }) : null,
		structReader: web ? createStructReader({ log: (m) => log(`[struct] ${m}`) }) : null,
	});
}

/**
 * 协同模式：只去掉动作，不去掉题库。
 * 走和全自动完全相同的作答链路（题库优先 → 模型兜底 → 都不行转人工），
 * 所以不覆盖 `_resolve`，只覆盖 `_decide` 与 `_verifyCurrent`。
 */
function applyMode(runner, mode) {
	if (mode === 'copilot') {
		runner._decide = (q, answer) => [];
		// 协同模式不需要翻页：解出答案就停，等用户输入
		runner._verifyCurrent = async () => {
			runner._apply({ type: 'PAUSE', reason: PAUSE_REASON.USER });
		};
	}
}

/**
 * 开跑前的界面切换。顺序不能反：必须先最小化 DSH，再启动 Runner，
 * 否则第一帧截图会截到还没最小化的 DSH。悬浮窗在最小化之后显示，中间不留空档。
 */
async function showRunOverlay(d, client, profile, mode) {
	const { log, logErr, state, overlayStateOf, startTimerPolling, startOverlayActionPolling } = d;
	try {
		await client.minimizeHost();
	} catch (err) {
		logErr('最小化宿主窗口失败（请手动最小化 DSH，否则截图会截到它）', err);
	}
	let overlayOk = false;
	try {
		const label = mode === 'auto' ? '考试助手 · 全自动' : '考试助手 · 人机协同';
		const ov = await client.overlayShow(overlayStateOf({ run: RUN_STATE.RUNNING, current: null, stats: {}, answer: null }, { modeLabel: label }));
		overlayOk = ov?.ok === true;
		state.overlayActive = overlayOk;
		if (!overlayOk) log(`悬浮窗未能显示：${ov?.error ?? '未知原因'}`);
	} catch (err) {
		logErr('悬浮窗启动失败（不影响答题，但运行状态只能回面板看）', err);
	}
	if (overlayOk) {
		startOverlayActionPolling(client);
		startTimerPolling(client, profile);
	}
	return overlayOk;
}

/** 启动一次运行。mode: 'copilot'（只识别不点击）| 'auto'（全自动） */
async function hRunStart(d, body) {
	const { state, endRunAndRestore, engineClient, markRunStart, ok, fail } = d;
	const prep = prepareRunStart(d, body);
	if (prep.error) return prep.error;
	const { profile, mode } = prep;
	let client;
	try {
		client = await engineClient();
	} catch (err) {
		return fail('ENGINE_UNAVAILABLE', `引擎不可用：${err?.message ?? err}`);
	}
	// 引擎默认暂停，start 时由 Runner 显式放行
	const runner = createRunner(d, client, profile, buildSolver(d, profile), await readScreenSize(client));
	applyMode(runner, mode);
	state.runner = runner;
	state.doneAnnounced = false;
	markRunStart();
	const overlayOk = await showRunOverlay(d, client, profile, mode);
	const res = await runner.start({ runId: `run-${Date.now().toString(36)}` });
	if (!res.ok) {
		state.runner = null;
		// 启动失败必须把界面还原，否则用户被留在一个最小化的 DSH 前面
		await endRunAndRestore({ reason: 'start_failed' });
		return fail('START_FAILED', res.error);
	}
	return ok({ runId: res.runId, mode, overlay: overlayOk ? 'native' : 'none' });
}


async function hRunState(d) {
	const { state, ok } = d;
		if (!state.runner) return ok({ run: RUN_STATE.IDLE, phase: null, active: false });
		return ok({ ...state.runner.snapshot(), active: true });
}


async function hRunPause(d, body) {
	const { state, pushOverlayState, ok, fail } = d;
		if (!state.runner) return fail('NO_RUN', '当前没有运行');
		const r = await state.runner.pause(body?.reason ?? PAUSE_REASON.USER);
		pushOverlayState(state.runner.snapshot());
		return ok(r);
}


async function hRunResume(d) {
	const { state, pushOverlayState, ok, fail } = d;
		if (!state.runner) return fail('NO_RUN', '当前没有运行');
		const r = await state.runner.resume();
		pushOverlayState(state.runner.snapshot());
		return r.ok ? ok(r) : fail('RESUME_FAILED', r.error);
}


async function hRunStop(d) {
	const { state, endRunAndRestore, ok, fail } = d;
		if (!state.runner) return fail('NO_RUN', '当前没有运行');
		// endRunAndRestore 内部会 stop Runner；不在这里先停一次，
		// 否则同一个 Runner 会被 stop 两遍（幂等但日志会出现两条"停止"）。
		await endRunAndRestore({ reason: 'user_stop', keepOverlayMs: 800 });
		return ok({ stopped: true });
}


	/** 显式确认允许提交（一次性）。这是"自动提交"的第二道人工闸。 */
async function hRunConfirmSubmit(d, body) {
	const { state, ok, fail } = d;
		if (!state.runner) return fail('NO_RUN', '当前没有运行');
		return ok(state.runner.confirmSubmit(body?.reason ?? 'user-confirmed-via-panel'));
}


	/** 手动执行一个动作（调试/接管用）。仍走白名单，仍受引擎闸门约束。 */
async function hRunAct(d, body) {
	const { store, engineClient, ok, fail } = d;
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
}

export function createRunHandlers(d) {
	return {
		panic: (...a) => hPanic(d, ...a),
		'run.capabilities': (...a) => hRunCapabilities(d, ...a),
		'run.start': (...a) => hRunStart(d, ...a),
		'run.state': (...a) => hRunState(d, ...a),
		'run.pause': (...a) => hRunPause(d, ...a),
		'run.resume': (...a) => hRunResume(d, ...a),
		'run.stop': (...a) => hRunStop(d, ...a),
		'run.confirmSubmit': (...a) => hRunConfirmSubmit(d, ...a),
		'run.act': (...a) => hRunAct(d, ...a),
	};
}
