// 答题流水线状态机。纯函数：(state, event) → (nextState, effects[])
//
// 为什么状态机而不是"一个 while 循环"：
//   现有 exam_step.py 是命令式 while 循环 + 一堆 if，出问题只能靠 print 猜。
//   改成显式状态机后，每条迁移都能单测，而且"卡在哪一步、为什么卡"是数据不是日志。
//
// 关键约束：effects 是纯数据描述，由宿主执行。本模块不碰截图、不碰点击、不碰 IO。
//
// 状态流：
//   IDLE → CAPTURE → PARSE → RESOLVE → DECIDE → ACT → VERIFY → (NEXT_CAPTURE | PAUSE | DONE)

import { RUN_STATE, PAUSE_REASON, gateAction } from './guardrails.js';
import { checkExpect, shouldRetry, backoffFor, pageAdvanced } from './verify.js';

/** 流水线阶段（一个"题"内部的步骤）。 */
export const PHASE = {
	CAPTURE: 'capture',
	PARSE: 'parse',
	RESOLVE: 'resolve',
	DECIDE: 'decide',
	ACT: 'act',
	VERIFY: 'verify',
};

/** 初始状态。 */
export function initialState(overrides = {}) {
	return {
		run: RUN_STATE.IDLE,
		phase: null,
		pauseReason: null,

		question: null, // 当前题（parse 产物）
		answer: null, // 决定要选的答案
		// 答案来自哪（bank:high / model / none）与置信度。
		// 面板要给用户看这两个：同样是一个字母，题库 high 命中和模型 low 猜测
		// 的可信度天差地别，不显示等于让人盲信。
		answerSource: null,
		answerConfidence: null,
		pendingActions: [], // 待执行动作队列
		actionIndex: 0,

		attempt: 0, // 当前动作的重试次数
		progressBefore: null,
		progressAfter: null,
		hashBefore: null,
		hashAfter: null,

		// 统计
		stats: { handled: 0, verified: 0, failed: 0, skipped: 0, tokens: 0 },
		log: [], // 最近若干条事件，给面板看
		...overrides,
	};
}

/**
 * 状态迁移。
 * @param {object} state
 * @param {object} event  { type:'START'|'CAPTURED'|'PARSED'|'RESOLVED'|'DECIDED'|'ACTED'|'VERIFIED'|'FAILED'|'PAUSE'|'STOP'|'DONE' , ...payload }
 * @param {object} ctx    运行上下文 { allowAutoSubmit, submitConfirmed, budget, used, profile }
 * @returns {{state:object, effects:Array}}
 */
export function transition(state, event, ctx = {}) {
	const s = { ...state, log: [...state.log] };
	const effects = [];

	const pushLog = (msg) => {
		s.log.push({ at: Date.now(), msg });
		if (s.log.length > 200) s.log.shift();
	};

	switch (event.type) {
		case 'START': {
			if (s.run === RUN_STATE.RUNNING) return { state: s, effects };
			s.run = RUN_STATE.RUNNING;
			s.pauseReason = null;
			s.attempt = 0;
			s.actionIndex = 0;
			s.pendingActions = [];
			s.phase = PHASE.CAPTURE;
			pushLog('开始运行');
			effects.push({ type: 'capture', reason: 'start' });
			break;
		}

		case 'CAPTURED': {
			if (s.run !== RUN_STATE.RUNNING) return { state: s, effects };
			s.hashBefore = event.hash ?? null;
			s.progressBefore = event.progress ?? null;
			s.phase = PHASE.PARSE;
			effects.push({ type: 'parse', observation: event.observation ?? null });
			break;
		}

		case 'PARSED': {
			if (s.run !== RUN_STATE.RUNNING) return { state: s, effects };
			s.question = event.question ?? null;
			s.phase = PHASE.RESOLVE;

			// 解析出空题（题干空且无选项）→ 可能是弹窗、页面没加载完、或已到末尾
			const q = s.question;
			if (!q || (!String(q.stem ?? '').trim() && (q.opts ?? []).length === 0)) {
				s.phase = PHASE.CAPTURE;
				const tripped = event.failureStreakTripped === true;
				if (tripped) {
					s.run = RUN_STATE.PAUSED;
					s.pauseReason = PAUSE_REASON.VERIFY_FAILED;
					pushLog('连续解析失败，转入暂停');
				} else {
					pushLog('解析为空，重试');
					effects.push({ type: 'capture', reason: 'empty_parse' });
				}
				break;
			}
			effects.push({ type: 'resolve', question: q });
			break;
		}

		case 'RESOLVED': {
			if (s.run !== RUN_STATE.RUNNING) return { state: s, effects };
			// event: { answer, confidence, source:'bank'|'model'|'manual', lowConfidence }
			if (event.lowConfidence) {
				s.run = RUN_STATE.PAUSED;
				s.pauseReason = PAUSE_REASON.LOW_CONFIDENCE;
				s.answer = event.answer ?? null;
				s.answerSource = event.source ?? null;
				s.answerConfidence = event.confidence ?? null;
				pushLog(`置信度不足（${event.confidence ?? '?'}），转人工`);
				effects.push({ type: 'notify', level: 'warn', text: '置信度不足，请人工确认' });
				break;
			}
			if (!event.answer) {
				s.run = RUN_STATE.PAUSED;
				s.pauseReason = PAUSE_REASON.UNKNOWN_QUESTION;
				pushLog('无法确定答案，转人工');
				effects.push({ type: 'notify', level: 'warn', text: '无法确定答案' });
				break;
			}
			s.answer = event.answer;
			s.answerSource = event.source ?? null;
			s.answerConfidence = event.confidence ?? null;
			s.phase = PHASE.DECIDE;
			effects.push({ type: 'decide', question: s.question, answer: event.answer, source: event.source });
			break;
		}

		case 'DECIDED': {
			if (s.run !== RUN_STATE.RUNNING) return { state: s, effects };
			// event: { actions: [...], noActionByDesign?: boolean }
			//   已经过 actions.validateSequence
			const actions = Array.isArray(event.actions) ? event.actions : [];

			// 空动作有两种完全不同的含义，必须区分：
			//   ① 全自动模式下解不出动作 → 真异常，转人工
			//   ② **协同模式**下本来就不点击 → 空动作是**设计如此**
			//
			// 旧实现一律按 ① 处理，于是协同模式每次都被判
			// 「动作序列为空」→ 重试 3 次 → paused/error，
			// 而它其实已经拿到答案了（实测 answer=A 却报错停下）。
			// 现在由调用方用 `noActionByDesign` 显式声明 ②：
			// 直接进入"已出答案、停下来等用户"的状态，不重试、不报错。
			if (actions.length === 0) {
				if (event.noActionByDesign === true) {
					s.run = RUN_STATE.PAUSED;
					s.pauseReason = PAUSE_REASON.USER;
					s.stats.handled += 1;
					pushLog(`已给出答案（${s.answer ?? '?'}），等待人工操作`);
					effects.push({ type: 'notify', level: 'info', text: `建议答案：${s.answer ?? '?'}` });
					break;
				}
				s.run = RUN_STATE.PAUSED;
				s.pauseReason = PAUSE_REASON.UNKNOWN_QUESTION;
				pushLog('没有可执行动作');
				break;
			}

			// 护栏：高风险动作必须过闸
			for (const a of actions) {
				const gate = gateAction({
					state: s.run,
					pauseReason: s.pauseReason,
					allowAutoSubmit: ctx.allowAutoSubmit === true,
					submitConfirmed: ctx.submitConfirmed === true,
					budget: ctx.budget,
					used: ctx.used,
					actionRisk: a.risk ?? 'low',
				});
				if (!gate.allowed) {
					s.run = RUN_STATE.PAUSED;
					s.pauseReason = gate.code === 'SUBMIT_DISABLED' || gate.code === 'SUBMIT_UNCONFIRMED' ? PAUSE_REASON.SUBMIT_GATE : PAUSE_REASON.ERROR;
					pushLog(`动作被护栏拦截：${gate.reason}`);
					effects.push({ type: 'notify', level: 'warn', text: gate.reason });
					return { state: s, effects };
				}
			}

			s.pendingActions = actions;
			s.actionIndex = 0;
			s.attempt = 0;
			s.phase = PHASE.ACT;
			effects.push({ type: 'act', action: actions[0] });
			break;
		}

		case 'ACTED': {
			if (s.run !== RUN_STATE.RUNNING) return { state: s, effects };
			s.phase = PHASE.VERIFY;
			effects.push({
				type: 'verify',
				action: s.pendingActions[s.actionIndex] ?? null,
				observation: event.observation ?? {},
			});
			break;
		}

		case 'VERIFIED': {
			if (s.run !== RUN_STATE.RUNNING) return { state: s, effects };
			const verdict = event.verdict ?? { satisfied: true, reason: '' };
			const current = s.pendingActions[s.actionIndex] ?? null;

			if (!verdict.satisfied) {
				// 重试策略：有限次退避重试，超了就暂停
				if (shouldRetry(verdict, s.attempt)) {
					s.attempt += 1;
					s.phase = PHASE.ACT;
					pushLog(`验证未通过（${verdict.reason}），第 ${s.attempt} 次重试`);
					effects.push({
						type: 'retry',
						action: current,
						delayMs: backoffFor(s.attempt - 1),
						attempt: s.attempt,
					});
					return { state: s, effects };
				}
				s.run = RUN_STATE.PAUSED;
				s.pauseReason = PAUSE_REASON.VERIFY_FAILED;
				s.stats.failed += 1;
				pushLog(`验证连续失败，暂停：${verdict.reason}`);
				effects.push({ type: 'notify', level: 'error', text: `验证失败：${verdict.reason}` });
				return { state: s, effects };
			}

			// 这一条动作通过
			s.attempt = 0;
			s.actionIndex += 1;
			if (s.actionIndex < s.pendingActions.length) {
				s.phase = PHASE.ACT;
				effects.push({ type: 'act', action: s.pendingActions[s.actionIndex] });
				break;
			}

			// 全部动作通过 → 本题完成
			s.stats.handled += 1;
			s.stats.verified += 1;
			s.pendingActions = [];
			s.actionIndex = 0;
			s.phase = PHASE.CAPTURE;
			pushLog(`本题完成（累计 ${s.stats.handled}）`);

			if (event.done === true) {
				s.run = RUN_STATE.DONE;
				s.phase = null;
				pushLog('已完成全部题目');
				return { state: s, effects };
			}
			effects.push({ type: 'capture', reason: 'next_question' });
			break;
		}

		case 'FAILED': {
			// 某一步（capture/parse/resolve/decide）抛错
			const reason = event.reason ?? '未知错误';
			const tripped = event.failureStreakTripped === true;
			s.stats.failed += 1;
			if (tripped) {
				s.run = RUN_STATE.PAUSED;
				s.pauseReason = PAUSE_REASON.ERROR;
				pushLog(`连续失败，暂停：${reason}`);
				effects.push({ type: 'notify', level: 'error', text: reason });
				break;
			}
			if (shouldRetry({ satisfied: false }, s.attempt)) {
				s.attempt += 1;
				s.phase = PHASE.CAPTURE;
				pushLog(`步骤失败（${reason}），第 ${s.attempt} 次重试`);
				effects.push({ type: 'retry', delayMs: backoffFor(s.attempt - 1), attempt: s.attempt });
				break;
			}
			s.run = RUN_STATE.PAUSED;
			s.pauseReason = PAUSE_REASON.ERROR;
			pushLog(`步骤连续失败，暂停：${reason}`);
			effects.push({ type: 'notify', level: 'error', text: reason });
			break;
		}

		case 'PAUSE': {
			if (s.run === RUN_STATE.PAUSED) return { state: s, effects };
			s.run = RUN_STATE.PAUSED;
			s.pauseReason = event.reason ?? PAUSE_REASON.USER;
			pushLog(`暂停（${s.pauseReason}）`);
			break;
		}

		case 'RESUME': {
			if (s.run !== RUN_STATE.PAUSED) return { state: s, effects };
			s.run = RUN_STATE.RUNNING;
			s.pauseReason = null;
			s.attempt = 0;
			pushLog('恢复运行');
			// 从当前阶段继续，而不是从头重来
			if (s.pendingActions.length > 0 && s.phase === PHASE.ACT) {
				effects.push({ type: 'act', action: s.pendingActions[s.actionIndex] });
			} else {
				s.phase = PHASE.CAPTURE;
				effects.push({ type: 'capture', reason: 'resume' });
			}
			break;
		}

		case 'STOP': {
			s.run = RUN_STATE.STOPPED;
			s.pauseReason = null;
			s.phase = null;
			s.pendingActions = [];
			pushLog('已停止');
			effects.push({ type: 'notify', level: 'info', text: '已停止' });
			break;
		}

		case 'DONE': {
			s.run = RUN_STATE.DONE;
			s.phase = null;
			pushLog('运行结束');
			break;
		}

		// 引擎侧急停（STOP 文件 / panic 路由）
		case 'PANIC': {
			s.run = RUN_STATE.PAUSED;
			s.pauseReason = PAUSE_REASON.PANIC;
			s.pendingActions = [];
			pushLog('急停触发');
			effects.push({ type: 'notify', level: 'error', text: '已急停' });
			break;
		}

		default: {
			pushLog(`未知事件 ${event.type}`);
			break;
		}
	}

	return { state: s, effects };
}

/**
 * 便捷：连续跑一串事件（单测用，也可用于"重放日志排查问题"）。
 */
export function runEvents(events, ctx = {}, start = initialState()) {
	let state = start;
	const allEffects = [];
	for (const ev of events) {
		const r = transition(state, ev, ctx);
		state = r.state;
		allEffects.push(...r.effects);
	}
	return { state, effects: allEffects };
}

/** 面板用：把状态压成可读摘要。 */
export function summarize(state) {
	return {
		run: state.run,
		phase: state.phase,
		pauseReason: state.pauseReason,
		stats: { ...state.stats },
		current: state.question
			? {
					qtype: state.question.qtype ?? '',
					stem: String(state.question.stem ?? '').slice(0, 120),
					prog: state.question.prog ?? null,
					optCount: (state.question.opts ?? []).length,
			  }
			: null,
		answer: state.answer,
		source: state.answerSource ?? null,
		confidence: state.answerConfidence ?? null,
		pending: state.pendingActions.length,
		recentLog: state.log.slice(-8),
	};
}
