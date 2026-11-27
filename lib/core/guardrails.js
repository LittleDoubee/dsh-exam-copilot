// 护栏：急停、预算、提交许可。所有"能不能动手"的判断集中在这里。
//
// 设计原则：默认拒绝。任何不确定的状态都不放行动作 ——
// 全自动误操作在考试场景不可逆，代价远高于"停下来问一句"。
//
// 零 ctx，可直接单测。

/** 运行时状态机里的运行态。 */
export const RUN_STATE = {
	IDLE: 'idle',
	RUNNING: 'running',
	PAUSED: 'paused',
	STOPPED: 'stopped',
	DONE: 'done',
};

/** 暂停原因，决定 UI 上怎么提示用户。 */
export const PAUSE_REASON = {
	USER: 'user', // 用户主动暂停
	VERIFY_FAILED: 'verify_failed', // 连续验证失败
	BUDGET: 'budget', // 预算耗尽
	LOW_CONFIDENCE: 'low_confidence', // 置信度不足，转人工
	UNKNOWN_QUESTION: 'unknown_question', // 题库未命中且模型不可用
	ERROR: 'error', // 意外异常
	PANIC: 'panic', // 急停
	SUBMIT_GATE: 'submit_gate', // 等待提交确认
};

/**
 * 护栏门禁。每次执行动作前调用。
 *
 * @param {object} p
 *   { state, pauseReason, allowAutoSubmit, submitConfirmed, budget, used, actionRisk }
 * @returns {{ allowed:boolean, reason?:string, code?:string }}
 */
export function gateAction({
	state,
	pauseReason,
	allowAutoSubmit = false,
	submitConfirmed = false,
	budget,
	used = {},
	actionRisk = 'low',
} = {}) {
	if (state === RUN_STATE.STOPPED) {
		return deny('STOPPED', '运行已停止');
	}
	if (state === RUN_STATE.PAUSED || pauseReason) {
		return deny('PAUSED', `运行已暂停（${pauseReason || '未知原因'}）`);
	}
	if (state !== RUN_STATE.RUNNING) {
		return deny('NOT_RUNNING', `当前状态 ${state ?? '未知'} 不允许执行动作`);
	}

	// 预算：超了就停，不要"再试一题"
	if (budget) {
		const tokens = Number(used.tokens ?? 0);
		const questions = Number(used.questions ?? 0);
		if (budget.maxTotalTokens && tokens >= budget.maxTotalTokens) {
			return deny('BUDGET_TOKENS', `token 预算已用尽（${tokens}/${budget.maxTotalTokens}）`);
		}
		if (budget.maxQuestions && questions >= budget.maxQuestions) {
			return deny('BUDGET_QUESTIONS', `题目预算已用尽（${questions}/${budget.maxQuestions}）`);
		}
	}

	// 提交：三重条件同时满足才放行
	if (actionRisk === 'high') {
		if (!allowAutoSubmit) {
			return deny('SUBMIT_DISABLED', '配置未开启自动提交（profile.answer.allowAutoSubmit 为 false）');
		}
		if (!submitConfirmed) {
			return deny('SUBMIT_UNCONFIRMED', '本次运行尚未确认提交（需要一次性确认）');
		}
	}

	return { allowed: true };
}

function deny(code, reason) {
	return { allowed: false, code, reason };
}

/**
 * 提交确认令牌。
 *
 * 为什么需要"一次性"：用户开了 allowAutoSubmit 并不意味着"就此以后永久随便交"。
 * 每次运行开始前确认一次，运行结束即失效 —— 减少"上次开了忘关"的风险。
 */
export class SubmitTicket {
	constructor() {
		this.granted = false;
		this.grantedAt = null;
		this.reason = '';
	}

	/** 用户显式确认。必须带理由，便于事后复盘是谁、为什么放行的。 */
	grant(reason = 'user-confirmed') {
		this.granted = true;
		this.grantedAt = Date.now();
		this.reason = reason;
		return this;
	}

	revoke() {
		this.granted = false;
		this.grantedAt = null;
		this.reason = '';
		return this;
	}

	isGranted() {
		return this.granted === true;
	}
}

/**
 * 预算追踪。
 * 每题 token 上限 + 总量上限，超了即暂停（不是"降级继续"）。
 */
export class BudgetMeter {
	constructor({ maxTokensPerQuestion = 2000, maxTotalTokens = 200000, maxQuestions = 500 } = {}) {
		this.limits = { maxTokensPerQuestion, maxTotalTokens, maxQuestions };
		this.used = { tokens: 0, questions: 0 };
	}

	/** 记一次解题消耗。返回是否已超限。 */
	record(tokens) {
		const t = Math.max(0, Number(tokens) || 0);
		this.used.tokens += t;
		return this.exceeded();
	}

	recordQuestion() {
		this.used.questions += 1;
		return this.exceeded();
	}

	exceeded() {
		// 「0 表示不限」—— 必须显式判非零。
		//
		// 原写法是裸比较：
		//   used.tokens >= maxTotalTokens || used.questions >= maxQuestions
		// 面板上「最多处理题数」的提示写的是「到数即停。0 表示不限」，
		// 用户照着填 0 之后，0 >= 0 立刻为真 → 循环开头的守卫直接 DONE，
		// **点开始就立刻「已结束」，一题都不跑**。
		// 而同样含义的 gateAction() 里写的是 `if (budget.maxQuestions && ...)`，
		// 两处对 0 的语义不一致，所以单测（用的是 1/3/500）全绿也发现不了。
		const t = this.limits.maxTotalTokens;
		const q = this.limits.maxQuestions;
		if (t && this.used.tokens >= t) return true;
		if (q && this.used.questions >= q) return true;
		return false;
	}

	/** 单题超限判断，用于"这一题就别问了"。 */
	questionOverBudget(tokens) {
		const cap = this.limits.maxTokensPerQuestion;
		// 同样：0 = 不限，不能把每道题都判成超限
		if (!cap) return false;
		return Number(tokens) >= cap;
	}

	snapshot() {
		const unlimited = !this.limits.maxTotalTokens;
		return {
			limits: { ...this.limits },
			used: { ...this.used },
			// 不限（0）时不再算「剩余」，否则会显示成 0 让人以为预算用光了。
			// 前端展示成 null 更诚实 —— 与「0 表示不限」的语义一致。
			remainingTokens: unlimited
				? null
				: Math.max(0, this.limits.maxTotalTokens - this.used.tokens),
		};
	}
}

/**
 * 连续的验证失败后必须停机。
 * 单次失败可以重试；连续 N 题都失败说明环境变了（弹窗、掉登录、崩了），
 * 继续点只会更糟。
 */
export class FailureStreak {
	constructor(limit = 3) {
		this.limit = limit;
		this.count = 0;
		this.lastReason = '';
	}

	fail(reason = '') {
		this.count += 1;
		this.lastReason = reason;
		return this.tripped();
	}

	success() {
		this.count = 0;
		this.lastReason = '';
	}

	tripped() {
		return this.count >= this.limit;
	}

	reset() {
		this.count = 0;
		this.lastReason = '';
	}
}
