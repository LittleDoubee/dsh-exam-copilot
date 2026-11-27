// 运行期悬浮窗、倒计时轮询与收尾。由 lib/index.js 的 apply 统一组装，依赖经 d 注入。
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


const OVERLAY_MIN_INTERVAL_MS = 200;

/** 运行期可变状态，每个插件实例一份。 */
function initOverlay() {
	return {
		overlayTimer: null,
		overlayLastText: '',
		overlayLastAt: 0,
		overlayPending: null,
		overlayFlushTimer: null,
		overlayTick: null,
		overlayTimerSeconds: null,
		overlayRunStartedAt: 0,
		overlayTimerAt: 0,
	};
}

/** 推送运行状态变化给面板（面板轮询 run.state 即可，这里只留钩子）。 */
function publishRunState($d, snapshot) {
	const { log, state, pushOverlayState, endRunAndRestore } = $d;
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


/** 把 Runner 快照翻译成"屏幕显示什么"。
 *
 *  实现在 core/overlay-view.js（纯函数、可单测）—— 这里只做转调，
 *  免得视图文案散落在闭包里，改一句提示都要重启宿主才能验证。
 */
function overlayStateOf($d, snap, extra = {}) {
	const { recentLogs } = $d;
	const S = $d.overlay;
	// 步骤流：取本次运行开始后的 [run] 日志
	const steps = [];
	for (const l of recentLogs) {
		if (l.t < S.overlayRunStartedAt) continue;
		const line = toStepLine(l.msg);
		if (line) steps.push(line);
	}
	return buildOverlayState(snap, {
		modeLabel: extra.modeLabel,
		timerSeconds: extra.timerSeconds ?? S.overlayTimerSeconds,
		steps,
	});
}


function pushOverlayState($d, snapshot) {
	const { state, overlayStateOf, pushOverlayState } = $d;
	const S = $d.overlay;
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
	if (now - S.overlayLastAt < OVERLAY_MIN_INTERVAL_MS) {
		S.overlayPending = snapshot;
		if (!S.overlayFlushTimer) {
			S.overlayFlushTimer = setTimeout(() => {
				S.overlayFlushTimer = null;
				const s = S.overlayPending;
				S.overlayPending = null;
				if (s) pushOverlayState(s);
			}, OVERLAY_MIN_INTERVAL_MS - (now - S.overlayLastAt) + 10);
		}
		return;
	}
	if (key === S.overlayLastText && now - S.overlayLastAt < 2000) return;
	S.overlayLastText = key;
	S.overlayLastAt = now;
	state.engine?.client?.overlayUpdate?.(payload).catch(() => {});
}


/** 定期读倒计时区。只在配了 timer 区且运行中才读 —— 它是一次真实 OCR。 */
function startTimerPolling($d, client, profile) {
	const { state, pushOverlayState, stopTimerPolling } = $d;
	const S = $d.overlay;
	stopTimerPolling();
	const zone = zonesByRole(profile?.zones ?? []).timer;
	if (!zone) return;
	const region = [zone.x, zone.y, zone.w, zone.h];
	const every = 5000;
	S.overlayTick = setInterval(async () => {
		// 暂停时用户可能切回 DSH 盖住计时区，读到的只会是空结果
		if (state.runner?.state?.run === RUN_STATE.PAUSED) return;
		try {
			const r = await client.readTimer(region);
			if (r?.ok && Number.isFinite(r.seconds)) {
				S.overlayTimerSeconds = r.seconds;
				S.overlayTimerAt = Date.now();
				// 立刻推一帧，别等下一次 Runner 快照（可能好几百毫秒）
				pushOverlayState(state.lastSnapshot ?? {});
			}
		} catch {
			/* 读不到不影响主流程；悬浮窗显示 "—" */
		}
	}, every);
	S.overlayTick.unref?.();
	// 立刻读一次，否则前 5 秒是空的
	void client
		.readTimer(region)
		.then((r) => {
			if (r?.ok && Number.isFinite(r.seconds)) {
				S.overlayTimerSeconds = r.seconds;
				S.overlayTimerAt = Date.now();
			}
		})
		.catch(() => {});
}


function stopTimerPolling($d) {
	const S = $d.overlay;
	if (S.overlayTick) {
		clearInterval(S.overlayTick);
		S.overlayTick = null;
	}
}


/** 轮询悬浮窗上的按钮点击（暂停/继续、停止并返回）。 */
function startOverlayActionPolling($d, client) {
	const { stopOverlayActionPolling, handleOverlayAction } = $d;
	const S = $d.overlay;
	stopOverlayActionPolling();
	S.overlayTimer = setInterval(async () => {
		try {
			const r = await client.overlayActions();
			for (const a of r?.actions ?? []) {
				await handleOverlayAction(a.action);
			}
		} catch {
			/* 引擎短暂不可用不算错 */
		}
	}, 500);
	S.overlayTimer.unref?.();
}


function stopOverlayActionPolling($d) {
	const S = $d.overlay;
	if (S.overlayTimer) {
		clearInterval(S.overlayTimer);
		S.overlayTimer = null;
	}
}


async function handleOverlayAction($d, action) {
	const { state, endRunAndRestore } = $d;
	if (action === 'toggle_pause') {
		if (!state.runner) return;
		if (state.runner.state.run === RUN_STATE.PAUSED) await $d.handlers['run.resume']();
		else await $d.handlers['run.pause']({ reason: PAUSE_REASON.USER });
		return;
	}
	if (action === 'stop_and_back') {
		// 停止运行 + 恢复 DSH 窗口 + 关掉悬浮窗
		await endRunAndRestore({ reason: 'stopped_from_overlay' });
	}
}


/** 收尾：停 Runner、恢复宿主窗口、隐藏悬浮窗。停止/结束/异常都走这里。 */
async function endRunAndRestore($d, { reason, keepOverlayMs = 0 } = {}) {
	const { state, publishRunState, doEndRunAndRestore } = $d;
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


async function doEndRunAndRestore($d, { reason, keepOverlayMs = 0 } = {}) {
	const { log, state, overlayStateOf, stopTimerPolling, stopOverlayActionPolling } = $d;
	const S = $d.overlay;
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
	S.overlayTimerSeconds = null;
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

function markRunStart($d) {
	const S = $d.overlay;
	S.overlayRunStartedAt = Date.now();
}

export function createOverlay($d) {
	$d.overlay = initOverlay();
	const api = {
		publishRunState: (...a) => publishRunState($d, ...a),
		overlayStateOf: (...a) => overlayStateOf($d, ...a),
		pushOverlayState: (...a) => pushOverlayState($d, ...a),
		startTimerPolling: (...a) => startTimerPolling($d, ...a),
		stopTimerPolling: (...a) => stopTimerPolling($d, ...a),
		startOverlayActionPolling: (...a) => startOverlayActionPolling($d, ...a),
		stopOverlayActionPolling: (...a) => stopOverlayActionPolling($d, ...a),
		handleOverlayAction: (...a) => handleOverlayAction($d, ...a),
		endRunAndRestore: (...a) => endRunAndRestore($d, ...a),
		doEndRunAndRestore: (...a) => doEndRunAndRestore($d, ...a),
		markRunStart: (...a) => markRunStart($d, ...a),
	};
	Object.assign($d, api);
	return api;
}
