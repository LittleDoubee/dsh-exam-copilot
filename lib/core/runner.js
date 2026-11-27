// 运行编排器：把状态机、通道、解题池接起来跑。
//
// 分层约定（照抄 sentinel 的实证经验）：
//   本文件不许出现 ctx —— 全靠构造函数注入 { engine, solver, store, profile, events }。
//   于是可以用假 engine / 假 solver 完整跑一遍流程，不必真点鼠标。
//
// 为什么不是"一个 while 循环"：
//   状态机给出 effects（纯数据），本类负责执行它们。责任清晰：
//   状态机管"该怎么走"，本类管"怎么落地"。出问题能分别定位。

import { validateSequence, requiresApproval } from './actions.js';
import { BudgetMeter, FailureStreak, PAUSE_REASON, RUN_STATE, SubmitTicket, gateAction } from './guardrails.js';
import { PHASE, initialState, summarize, transition } from './pipeline.js';
import { checkExpect, checkQuestionComplete, backoffFor, shouldRetry } from './verify.js';
import { zonesByRole, resolveZones } from './zones.js';
import { shouldUseDom, mergeDomResult } from './dom-assist.js';
import { ANSWER_KIND, parseAnswer } from './answer.js';

/** 默认值，可被 profile 覆盖。 */
/** 悬浮窗步骤轨道：每题固定 5 步。 */
const TRACK_STEPS = [
	['read', '读题'],
	['bank', '题库'],
	['model', '模型'],
	['click', '点击'],
	['next', '翻页'],
];
const QTYPE_TEXT = { single: '单选', multi: '多选', judge: '判断', bool: '判断', fill: '填空' };
const BANK_CONF_TEXT = { high: '高置信', 'medium-high': '中高置信', medium: '中置信', low: '低置信' };

const MANUAL_POLL_MS = 700;
const MANUAL_STABLE_POLLS = 3;
const MANUAL_STABLE_POLLS_MULTI = 6;

const DEFAULTS = {
	maxQuestions: 500,
	maxTotalTokens: 200000,
	maxTokensPerQuestion: 2000,
	captureIntervalMs: 120,
	actionSettleMs: 180,
	confidenceThreshold: 0.8,
};

export class Runner {
	/**
	 * @param {object} p
	 *   { engine, solver, store, profile, log?, onState?, bankMatcher? }
	 *   engine: EngineClient 形状；solver: SolverPool 形状（可为 null）
	 *   bankMatcher: (question) => matchResult | null —— 由宿主注入，
	 *                这样 Runner 不必知道题库怎么存、怎么索引。
	 */
	constructor({
		engine,
		solver = null,
		store = null,
		profile,
		log = () => {},
		onState = () => {},
		bankMatcher = null,
		// Runner 不 import 浏览器，保持纯逻辑可测
		domReader = null,
		structReader = null,
		// 屏幕尺寸 {w,h}，由宿主从引擎 health 注入，用于坐标越界校验。
		// 拿不到时为 null —— 校验会跳过（宁可少拦，也不要误伤老调用方）。
		screenSize = null,
		// DSH 的附件服务（ctx.attachments）。视觉通道要用它把截图入库换
		// ImageAttachmentRef —— llm 不接受内联 base64。
		// 为 null 时视觉通道自动降级为纯文字作答。
		attachments = null,
	} = {}) {
		this.engine = engine;
		this.solver = solver;
		this.store = store;
		this.bankMatcher = bankMatcher;
		this.domReader = domReader;
		this.structReader = structReader;
		this.profile = profile ?? {};
		this.log = log;
		// 悬浮窗步骤轨道 / 已答历史 / 待复核清单
		this._track = null;
		this._trackSeq = 0;
		this._trackAnswer = null;
		this._history = [];
		this._reviews = [];
		// 本次运行的模型调用统计（题数 / 失败 / token）
		this._modelStats = { calls: 0, failed: 0, tokens: 0 };
		this.onState = onState;

		this.state = initialState();
		this.budget = new BudgetMeter({
			maxTotalTokens: this.profile.answer?.maxTotalTokens ?? DEFAULTS.maxTotalTokens,
			maxQuestions: this.profile.answer?.maxQuestions ?? DEFAULTS.maxQuestions,
			maxTokensPerQuestion: this.profile.answer?.maxTokensPerQuestion ?? DEFAULTS.maxTokensPerQuestion,
		});
		// 时间预算：比 token 更贴近用户感知
		this.timeLimits = {
			perQuestionMs: Math.max(0, Number(this.profile.answer?.perQuestionSeconds ?? 0)) * 1000,
			totalMs: Math.max(0, Number(this.profile.answer?.totalMinutes ?? 0)) * 60_000,
		};
		this.startedAtMs = null;
		this.questionStartedAtMs = null;
		this.failureStreak = new FailureStreak(3);
		this.ticket = new SubmitTicket();
		this.zoneMap = zonesByRole(this.profile.zones);

		this.runId = null;
		this._loop = null;
		this._stopRequested = false;
		this._paused = false;
		this._lastAct = null;
		this._lastQuestionKey = null;
		this._stuckRepeats = 0;
		this._manualWatch = null;
		this._manualBusy = false;
		this._maxTotal = 0;
		// 上一次观察到的「已处理题数」，用来在本题真正答完后记 question 预算。
		// 为什么不直接在 resolve 里记：那样 maxQuestions=1 时第 1 题刚算出答案
		// 就会被 gateAction 判成「题目预算已用尽（1/1）」而拒绝执行动作
		// —— answer=A 已出、动作却被拦、pauseReason=error。
		this._lastHandled = 0;
		// 屏幕尺寸：用于拦「坐标离谱」的动作（实测 (999999,999999) 曾被放行）
		this.screenSize = screenSize;
		this.attachments = attachments;
	}

	/* ── 生命周期 ─────────────────────────────────────── */

	/** 按目标窗口当前客户区重新解析区域。返回使用的窗口矩形（没有则 null）。 */
	async refreshZoneMap() {
		const title = this.profile.window?.title || this.profile.target?.title || '';
		let win = null;
		if (title && typeof this.engine.windowRect === 'function') {
			try {
				const r = await this.engine.windowRect(title);
				if (r?.ok && r.rect) win = r.rect;
			} catch (err) {
				this.log?.(`读取窗口位置失败，沿用绝对坐标：${err?.message ?? err}`, 'warn');
			}
		}
		this.zoneMap = zonesByRole(resolveZones(this.profile.zones, win));
		return win;
	}

	/** 启动。每道题一轮，直到 DONE / STOP / 暂停。 */
	async start({ runId } = {}) {
		if (this.state.run === RUN_STATE.RUNNING) return { ok: false, error: '已在运行' };
		this.runId = runId ?? `run-${Date.now().toString(36)}`;
		this._stopRequested = false;
		this._paused = false;
		this.startedAtMs = Date.now();
		this.questionStartedAtMs = Date.now();

		const pre = gateAction({ state: RUN_STATE.RUNNING });
		if (!pre.allowed) return { ok: false, error: pre.reason };

		// 引擎必须实际处于放行状态（默认是暂停的，这是刻意的安全设计）
		try {
			await this.engine.resume();
		} catch (err) {
			return { ok: false, error: `无法放行引擎动作：${err?.message ?? err}` };
		}

		// 区域若存的是窗口相对比例（rel），按目标窗口当前位置解析成绝对坐标。
		// 取不到窗口矩形时沿用旧的绝对坐标，不阻断运行。
		await this.refreshZoneMap();

		this._apply({ type: 'START' });
		this._loop = this._runLoop();
		// 不 await：让 start 立刻返回，运行在后台推进
		this._loop.catch((err) => {
			this.log(`运行异常：${err?.message ?? err}`, 'error');
			this._apply({ type: 'FAILED', reason: err?.message ?? String(err) });
			this._emit();
		});
		return { ok: true, runId: this.runId };
	}

	async stop() {
		this._stopManualWatch();
		this._stopRequested = true;
		this._apply({ type: 'STOP' });
		try {
			await this.engine.panic();
		} catch {
			/* 引擎可能已挂，忽略 */
		}
		this._emit();
		return { ok: true };
	}

	async pause(reason = PAUSE_REASON.USER) {
		this._stopManualWatch();
		this._paused = true;
		// 掐断在途的模型思考，否则暂停后模型仍会给出答案
		try {
			const n = this.solver?.abortAll?.() ?? 0;
			if (n) this.log(`暂停：已取消 ${n} 个进行中的模型请求`);
		} catch {
			/* ignore */
		}
		this._apply({ type: 'PAUSE', reason });
		try {
			await this.engine.panic();
		} catch {
			/* ignore */
		}
		this._emit();
		return { ok: true };
	}

	async resume() {
		if (this.state.run !== RUN_STATE.PAUSED) return { ok: false, error: '当前不在暂停态' };
		// 提交待确认这种暂停，必须用户先 grant 才能恢复
		if (this.state.pauseReason === PAUSE_REASON.SUBMIT_GATE && !this.ticket.isGranted()) {
			return { ok: false, error: '需要先确认本次允许提交' };
		}
		this._stopManualWatch();
		this._paused = false;
		this.failureStreak.reset();
		this._resetQuestionTracking();
		try {
			await this.engine.resume();
		} catch {
			/* ignore */
		}
		// 暂停期间用户可能手动翻页或挪动窗口：区域按当前窗口重算，从读题重新开始
		await this.refreshZoneMap();
		this._apply({ type: 'RESUME' });
		this._loop = this._runLoop();
		this._loop.catch(() => {});
		return { ok: true };
	}

	/** 用户显式确认提交（一次性）。 */
	confirmSubmit(reason = 'user-confirmed') {
		this.ticket.grant(reason);
		this.log('已确认允许提交', 'info');
		return { ok: true, granted: true };
	}

	/* ── 主循环 ───────────────────────────────────────── */

	async _runLoop() {
		while (!this._stopRequested) {
			const st = this.state;
			if (st.run === RUN_STATE.PAUSED || st.run === RUN_STATE.STOPPED || st.run === RUN_STATE.DONE) break;

			// 预算耗尽就在这里停，不要先跑一轮再被护栏拦。
			//
			// 实测：maxQuestions=1 时，第 1 题答完（handled=1）后
			// 循环仍继续抓第 2 题、解析、求解，然后才在 gateAction 被拦 →
			// 最后 pauseReason 变成 unknown_question，看起来像"失败"，
			// 而实际上第 1 题已经完整答对了（handled=1/verified=1）。
			// 语义上 maxQuestions 达成就是正常结束，不该表现为异常。
			if (this.budget.exceeded()) {
				this.log('题目/token 预算已达成，正常结束', 'info');
				this._apply({ type: 'DONE' });
				break;
			}

			const phase = st.phase;
			try {
				if (phase === PHASE.CAPTURE) {
					const obs = await this._capture();
					this._apply({ type: 'CAPTURED', ...obs });
				} else if (phase === PHASE.PARSE) {
					const q = await this._parse();
					if (!q) {
						const tripped = this.failureStreak.fail('解析为空');
						this._apply({ type: 'PARSED', question: null, failureStreakTripped: tripped });
					} else {
						this.failureStreak.success();
						this._apply({ type: 'PARSED', question: q });
					}
				} else if (phase === PHASE.RESOLVE) {
					const resolved = await this._resolve(st.question);
					this._apply({ type: 'RESOLVED', ...resolved });
				} else if (phase === PHASE.DECIDE) {
					const actions = this._decide(st.question, st.answer);
					// 诊断：答案 → 动作，便于定位「出了答案但没点击」
					this.log(
						`决策：答案=${JSON.stringify(st.answer ?? null)}，动作 ${actions.length} 个` +
							(actions.length ? `（${actions.map((a) => a.action + (a.params?.x !== undefined ? `@${a.params.x},${a.params.y}` : '')).join('，')}）` : '') +
							`，选项坐标=${JSON.stringify((st.question?.opts ?? []).map((o) => [o.letter, o.sx ?? null, o.sy ?? null]))}`,
						'info'
					);

					// 空动作 = 协同模式的正常结果（本来就不点击）。
					//
					// 旧代码无条件把空数组丢给
					// validateSequence，它返回 EMPTY_SEQUENCE 错误 →
					// 走 FAILED 分支 → 重试 3 次 → paused/error。
					// 而协同模式**已经拿到答案了**（实测 answer=A），
					// 却因为"没有动作"被判失败 —— 这是把设计当故障。
					//
					// 所以这里在 validateSequence 之前就分流：
					// 空数组 + 有答案 = 正常结束（出答案、等人操作）。
					if (actions.length === 0) {
						this._apply({
							type: 'DECIDED',
							actions: [],
							// 有答案说明是刻意不动作（协同模式）；
							// 没答案才是真异常，交给 pipeline 按原逻辑处理。
							noActionByDesign: Boolean(st.answer),
						});
						break;
					}

					const checked = validateSequence(actions, {
						// 执行通道 ≠ 读题通道：web 通道只是「用 DOM 读题」，
						// 点击仍由引擎在屏幕坐标上物理执行（坐标由 DOM 换算成屏幕像素）。
						// 若按 profile.channel='web' 校验，click_point/click_role 会被判 WRONG_CHANNEL。
						channel: 'screen',
						roles: Object.keys(this.zoneMap),
						// 屏幕尺寸用于拦「坐标离谱」的动作（实测 (999999,999999) 曾被放行）
						screen: this.screenSize ?? null,
					});
					if (!checked.ok) {
						this._apply({ type: 'FAILED', reason: checked.error.message });
					} else {
						this._apply({ type: 'DECIDED', actions: checked.actions });
					}
				} else if (phase === PHASE.ACT) {
					await this._actCurrent();
				} else if (phase === PHASE.VERIFY) {
					await this._verifyCurrent();
				} else {
					break;
				}
			} catch (err) {
				const tripped = this.failureStreak.fail(err?.message ?? String(err));
				this.log(`阶段 ${phase} 异常：${err?.message ?? err}`, 'error');
				this._apply({ type: 'FAILED', reason: err?.message ?? String(err), failureStreakTripped: tripped });
			}

			this._emit();
			if (this.state.run === RUN_STATE.PAUSED) {
				try {
					await this.engine.panic();
				} catch {
					/* ignore */
				}
				this._startManualWatch();
				break;
			}
			await sleep(DEFAULTS.captureIntervalMs);
		}
		this._emit();
	}

	/* ── 各阶段实现 ───────────────────────────────────── */

	async _capture() {
		const region = this._regionOf('question');
		const shot = await this.engine.screenshot(region);
		let progress = null;
		const progRegion = this._regionOf('progress');
		// 读不到题号不算致命，验证阶段会体现为失败
		if (progRegion) progress = await this._readProgressRetry(progRegion, '读题');
		return { hash: shot?.hash ?? null, progress, observation: shot };
	}

	async _parse() {
		this._trackBegin();
		this._step('read', 'active');
		// 网页通道：结构化读题优先；不自洽或连不上则记录原因并回退 OCR
		if (this.structReader) {
			const r = await this.structReader().catch(() => null);
			if (r?.ok) {
				this.log(`结构化读题成功（${r.question.qtype}，${r.question.opts.length} 个选项）`, 'info');
				// 记下题目身份与题号，供翻页验证比对
				this._lastQuestionKey = r.question.questionKey ?? null;
				if (Array.isArray(r.question.prog)) this.state.progressBefore = r.question.prog;
				if (this._track) {
					this._track.prog = Array.isArray(r.question.prog) ? r.question.prog : null;
					this._track.qtype = QTYPE_TEXT[r.question.qtype] ?? r.question.qtype ?? '';
				}
				this._step('read', 'done', `页面结构 · ${r.question.opts.length} 个选项`);
				return { ...r.question, _complete: true, _incompleteReasons: [], _scrolled: false };
			}
			this.log(r ? `结构化读题不自洽（${r.reasons.join('；')}），回退 OCR` : '结构化读题不可用，回退 OCR', 'warn');
		}

		const region = this._contentRegion();
		const optsRegion = this._regionOf('options');
		// 题干与选项分开圈选时，识别范围取两者的并集
		const union = region && optsRegion ? unionRegion(region, optsRegion) : region || optsRegion;
		const offset = union ? [union[0], union[1]] : [0, 0];

		// 排除区：把自己单独圈过的 timer 区从识别结果里剔掉。
		//
		// 为什么必须有：绝大多数人把「整块内容区」圈成 all，
		// 而这块包含页面顶部的「剩余时间 32:43」。于是 OCR 题干变成
		//   "剩余时间32:43模拟考试系统1. 根据《印刷业管理条例》…"
		// 后果一：题干**每秒都在变** → 题库标准化后永远对不上，命中率归零；
		// 后果二：那串与题目无关的字会把解析器带偏。
		// 用户本来就单独圈过 timer 区（用于悬浮窗显示），按它的坐标剔掉即可，
		// 不必要求用户重画 all 区去避开 —— 那每改一次都要重圈。
		const excludeRegions = [];
		const timerZone = this._regionOf('timer');
		if (timerZone && union) {
			// 只在与识别范围有交集时才传，避免传一堆无用区域
			const [tx, ty, tw, th] = timerZone;
			const [ux, uy, uw, uh] = union;
			if (tx < ux + uw && tx + tw > ux && ty < uy + uh && ty + th > uy) {
				excludeRegions.push([tx, ty, tw, th]);
			}
		}

		let res = await this.engine.ocr({
			region: union,
			offset,
			engine: 'auto',
			excludeRegions: excludeRegions.length ? excludeRegions : undefined,
		});
		let parsed = res?.parsed;

		// ── 题目完整性门禁──────────────────────────
		// 长题被截断时解析器"不会报错"，它会以为题目就这么几个选项，
		// 然后按错误假设一路答下去。静默的错误比直接失败糟得多。
		// 策略：先判定完整性；不完整且值得滚动时，让引擎滚动拼接后重解析；
		//       仍不完整则明确标记，交给上层转人工，绝不假装题目是完整的。
		let completeness = checkQuestionComplete(parsed);
		let scrolled = false;

		if (!completeness.complete && completeness.suggestScroll && this.profile?.actions?.allowScroll !== false) {
			try {
				this.log(`题目不完整（${completeness.reasons.join('；')}），尝试滚动补全`, 'warn');
				const fuller = await this.engine.scrollCapture({ region: union, maxShots: 4 });
				if (fuller?.parsed) {
					const fullerComplete = checkQuestionComplete(fuller.parsed);
					// 只在"确实更完整"时才替换：别让滚动把好结果弄坏
					if ((fuller.parsed.opts ?? []).length > (parsed?.opts ?? []).length || fullerComplete.complete) {
						parsed = fuller.parsed;
						completeness = fullerComplete;
						scrolled = true;
						res = fuller;
					}
				}
			} catch (err) {
				this.log(`滚动补全失败：${err?.message ?? err}`, 'warn');
			}
		}

		if (!parsed) return null;

		let question = {
			...parsed,
			stem: String(parsed.stem ?? ''),
			opts: Array.isArray(parsed.opts) ? parsed.opts : [],
			// 完整性结论随题目一起传下去，供上层决定「能不能直接作答」
			_complete: completeness.complete,
			_incompleteReasons: completeness.reasons,
			_scrolled: scrolled,
			_ocrMs: res?.ms,
			_engine: res?.engineUsed,
		};

		// ── DOM 补救（S4）─────────────────────────────────────
		//
		// 为什么是「补救」而不是「替代」：
		//   网页考试常有弹窗、广告、浮层，纯 DOM 会被污染；
		//   而 OCR 通用但会有字形误识。两者结合才对：
		//      OCR 打底 → 可疑时 → DOM 纠正 → 合并
		//
		// 关键约束：
		//   · 只在 shouldUseDom 为真时才连浏览器（不能每题都连，太慢）
		//   · domReader 失败一律忽略，保持 OCR 结果（补救不能变成新的故障点）
		question = await this._applyDomAssist(question);
		if (this._track && Array.isArray(question.prog)) this._track.prog = question.prog;
		this._step('read', question._complete === false ? 'warn' : 'done', `OCR 识别 · ${question.opts.length} 个选项`);
		return question;
	}

	/**
	 * OCR 结果可疑时，用页面 DOM 纠正。
	 *
	 * 做成 try/catch 全包：DOM 通道是**额外**能力，
	 * 它挂了不能影响主答题流程。失败就静默回退到 OCR 结果。
	 */
	async _applyDomAssist(question) {
		if (!this.domReader) return question;
		const need = shouldUseDom(question, {
			threshold: this.profile?.answer?.confidenceThreshold ?? 0.8,
		});
		// 配置里强制开启（channel=web + domAssist=true）时，即使 OCR 看着正常也纠正一次
		const forced =
			this.profile?.channel === 'web' && this.profile?.answer?.domAssist === true;
		if (!need.need && !forced) return question;

		try {
			this.log(
				`OCR 结果可疑（${need.reasons.join('；') || '强制'}），尝试用页面 DOM 纠正`,
				'warn'
			);
			const dom = await this.domReader(question);
			if (!dom) {
				this.log('DOM 补救未取到可用题目，继续用 OCR 结果', 'warn');
				return question;
			}
			const merged = mergeDomResult(question, dom);
			this.log('DOM 补救成功，已用页面真实文本纠正题干/选项', 'info');
			return merged;
		} catch (err) {
			// 补救失败不是致命错误 —— 继续保持 OCR 结果
			this.log(`DOM 补救失败（忽略，继续用 OCR）：${err?.message ?? err}`, 'warn');
			return question;
		}
	}

	/** 内容区：优先 all（整块），其次 question。 */
	_contentRegion() {
		return this._regionOf('all') ?? this._regionOf('question');
	}

	async _resolve(question) {
		if (!question) return { answer: null, source: 'none' };
		const gate = this._resolveGate(question);
		if (gate) return gate;
		// 低置信处理：review（默认）= 照常作答并标记待复核；pause = 停下等人工
		const reviewMode = this.profile.answer?.lowConfidenceMode === 'pause' ? 'pause' : 'review';
		// 题库优先（快、免费、可离线）：高置信命中时完全不需要调模型
		this._step('bank', 'active');
		const fromBank = await this._resolveFromBank(question, reviewMode);
		if (fromBank) return fromBank;
		this._step('bank', 'done', this.profile.answer?.useBank === false || !this.bankMatcher ? '未启用' : '未命中');
		if (!this._modelUsable()) return { answer: null, source: 'none' };
		return (await this._resolveFromModel(question, reviewMode)) ?? { answer: null, source: 'none' };
	}

	/** 作答前的门禁：单题超时、题目不完整。命中则直接返回转人工结果。 */
	_resolveGate(question) {
		// 单题超时：直接放弃这题，别让一道题拖死整场
		if (this._questionTimeExceeded()) {
			this.log('单题等待超时，转人工', 'warn');
			return { answer: null, source: 'timeout' };
		}
		// 不完整的题绝不交给模型：基于缺失选项给出的"看似合理"答案比没有答案更危险
		if (question._complete === false) {
			const why = (question._incompleteReasons || []).join('；') || '题目不完整';
			this.log(`题目不完整，拒绝作答：${why}`, 'warn');
			return { answer: null, source: 'incomplete', lowConfidence: true, confidence: 0, reason: why };
		}
		return null;
	}

	/** 题库通道。命中返回结果；未命中/未启用返回 null。 */
	async _resolveFromBank(question, reviewMode) {
		if (this.profile.answer?.useBank === false || !this.bankMatcher) return null;
		const hit = this._matchBank(question);
		if (!hit) return null;
		const autoAccept = hit.confidence === 'high' || hit.confidence === 'medium-high';
		this.log(`题库${hit.confidence}命中：${hit.answer}（${hit.reason}）`, autoAccept ? 'info' : 'warn');
		// 不在这里记 question 预算：要等本题真正答完（见 _verifyCurrent），
		// 否则 maxQuestions=1 时答案刚出就会被 gateAction 判成预算用尽而拦下动作。
		const conf = hit.confidence === 'high' ? 0.95 : hit.confidence === 'medium-high' ? 0.85 : 0.55;
		const label = `题库${BANK_CONF_TEXT[hit.confidence] ?? hit.confidence}`;
		this._step('bank', autoAccept ? 'done' : 'warn', `${label}：${hit.answer}`);
		this._step('model', 'skip', '题库已给出答案');
		this._markAnswer({ answer: hit.answer, label, review: !autoAccept, confidence: conf, reason: hit.reason });
		if (autoAccept) await this._calibrateAgainstBank(question, hit.answer);
		return {
			answer: hit.answer,
			confidence: conf,
			source: `bank:${hit.confidence}`,
			// 中置信及以下：review 模式照常作答（已记入待复核），pause 模式转人工
			lowConfidence: !autoAccept && reviewMode === 'pause',
			reason: hit.reason,
		};
	}

	/** 校准模式：题库高置信答案视为标准答案，让模型再答一次统计各档位实际正确率（额外消耗 token）。 */
	async _calibrateAgainstBank(question, answer) {
		if (this.profile.answer?.calibrate !== true || !this.solver) return;
		try {
			const r = await this.solver.solve(question, { webSearch: this.profile.answer?.webSearch === true });
			if (r?.ok) this._recordCalib(r, answer);
		} catch (err) {
			this.log(`[calib] 校准作答失败（忽略）：${err?.message ?? err}`, 'warn');
		}
	}

	/** 模型是否可用。不可用时显式记录原因，否则无法区分"没有模型"和"模型答错"。 */
	_modelUsable() {
		if (this.profile.answer?.useModel === false) {
			this.log('模型未启用（useModel=false），跳过', 'info');
			this._step('model', 'skip', '未启用');
			return false;
		}
		if (!this.solver) {
			this.log('模型不可用（solver 为空，宿主未提供 ctx.llm），跳过', 'warn');
			this._step('model', 'warn', '模型不可用');
			return false;
		}
		return true;
	}

	/** 模型通道。成功返回结果；暂停返回 paused；失败返回 null。 */
	async _resolveFromModel(question, reviewMode) {
		this._step('model', 'active', `${this._modelLabel(null)} 思考中`);
		// 视觉通道：图形题的文字部分常信息不足，配了 figure 区时把截图一并交给视觉模型
		const figureRef = await this._captureFigure();
		const r = await this.solver.solve(question, {
			webSearch: this.profile.answer?.webSearch === true,
			hints: this.profile.prompts?.answer ?? '',
			imageAttachment: figureRef,
			hasFigure: Boolean(figureRef),
		});
		// 等待期间点了暂停：丢弃这次结果，不作答、不记统计
		if (this._paused) {
			this._step('model', 'skip', '已暂停，丢弃本次模型结果');
			this.log('暂停期间返回的模型结果已丢弃');
			return { answer: null, confidence: 0, source: 'paused', lowConfidence: true, reason: '用户暂停' };
		}
		this._recordModelStats(r);
		if (!r?.ok) {
			this.log(`模型求解失败：${r?.error ?? '未知'}`, 'warn');
			this._step('model', 'warn', `${this._modelLabel(r)} 求解失败`);
			return null;
		}
		return this._acceptModelAnswer(r, reviewMode);
	}

	/** 累计模型调用统计，并在日志里列出各模型的作答以便核对投票。 */
	_recordModelStats(r) {
		const tokens = Number(r?.totalTokens ?? 0) || 0;
		this._modelStats.calls += 1;
		this._modelStats.tokens += tokens;
		if (!r?.ok) this._modelStats.failed += 1;
		this.log(`模型调用统计：累计 ${this._modelStats.calls} 题，本题 ${tokens} tokens，累计 ${this._modelStats.tokens} tokens`, 'info');
		if (Array.isArray(r?.votes) && r.votes.length > 1) {
			const parts = r.votes.map((t, i) => {
				const who = `${i === 0 ? '主模型' : `模型${i + 1}`} ${t?.model ?? '?'}`;
				const what = t?.ok ? (t.value ?? '空') : t?.cancelled ? '已取消' : `失败(${t?.error ?? '未知'})`;
				return `${who}: ${what}`;
			});
			this.log(`各模型作答：${parts.join(' ｜ ')}`, 'info');
		}
		// token 为 0 时记一次宿主返回的 usage 字段名，便于排查宿主实际给了什么
		if (!(tokens > 0) && !this._usageLogged) {
			this._usageLogged = true;
			this.log(`token 为 0，宿主 usage 字段：${this.solver?.lastUsageShape ?? '未收到 finish 事件'}`, 'warn');
		}
	}

	/** 采纳模型答案：按阈值判定是否待复核，更新步骤与答案标记。 */
	_acceptModelAnswer(r, reviewMode) {
		this.budget.record(r.totalTokens ?? 0);
		const threshold = this.profile.answer?.confidenceThreshold ?? DEFAULTS.confidenceThreshold;
		const low = Number(r.confidence ?? 0) < threshold;
		this.log(`模型作答：${r.answer}，置信度 ${r.confidence ?? '?'}（阈值 ${threshold}）${low ? '，低于阈值将转人工' : ''}`, low ? 'warn' : 'info');
		const confText = Number.isFinite(Number(r.confidence)) ? Number(r.confidence).toFixed(2) : '?';
		const modelName = this._voteSummary(r);
		this._step('model', low ? 'warn' : 'done', `${modelName} · ${r.answer} · ${confText}${low ? ' 待复核' : ''}`);
		this._markAnswer({ answer: r.answer, label: `模型 ${modelName} ${confText}`, review: low, confidence: r.confidence, reason: r.reason });
		// question 预算推迟到本题答完再记（同题库通道）
		return {
			answer: r.answer,
			confidence: r.confidence,
			source: r.source,
			// review 模式：低置信也照常作答，已记入待复核清单
			lowConfidence: low && reviewMode === 'pause',
			reason: r.reason,
		};
	}

	/** 多模型作答时，悬浮窗一行只放汇总，各模型答案逐行列出。单模型直接返回模型名。 */
	_voteSummary(r) {
		const votes = Array.isArray(r.votes) ? r.votes : [];
		if (votes.length <= 1) return this._modelLabel(r);
		const okVotes = votes.filter((v) => v?.ok);
		const same = okVotes.filter((v) => v.value === r.answer).length;
		const fail = votes.length - okVotes.length;
		for (const v of votes) {
			const m = String(v?.model ?? '?').slice(0, 24);
			this._step('model', v?.ok ? 'done' : 'warn', `  ${m} → ${v?.ok ? v.value : '失败'}`);
		}
		return fail
			? `${votes.length} 模型 ${fail} 失败 · ${same}/${okVotes.length} 同答`
			: `${votes.length} 模型 ${same}/${votes.length} 同答`;
	}

	/** 用题库匹配当前题。matcher 由宿主注入，Runner 不关心题库实现。 */
	/**
	 * 截取图形区并入库，返回可直接放进消息的 ImageAttachmentRef。
	 *
	 * 为什么需要这个：图形题（流程图/表格/电路图）的**关键信息在图里**，
	 * OCR 只能读到题干文字与选项，读不出图。实测 Q5
	 * 「下图所示流程图中，缺失的环节应当是：」——
	 * 题干完全不提缺失什么，只有看图才知道是「承印验证 → ??? → 交付印刷」。
	 *
	 * 为什么不能直接传 base64：
	 * 查 DSH 源码确认，ImageBlock 的形状是
	 *     { type:'image', attachment: ImageAttachmentRef }
	 *   而 ImageAttachmentRef 必须由 attachments 服务入库后颁发
	 *   （`{attachmentId, mediaType, bytes, width, height}`）。
	 *   llm.stream 不接受内联 dataUrl —— 第一版写成 `{type:'image',source:dataUrl}`
	 *   是错的，会被静默忽略（模型看不到图，图形题必然答错且不报错）。
	 *
	 * 设计取舍：
	 *   * 只截 figure 区（不截全屏）—— 全屏混着 DSH 界面和无关文字，
	 *     既费 token 又干扰模型；
	 *   * maxWidth 700 —— 足够看清流程框里的字，又不至于输入过大；
	 *   * 任何一步失败都返回 null，**不让截图故障拖垮整题**：
	 *     没有图时模型至少还能凭文字作答，转人工也比抛异常好。
	 *
	 * @returns {Promise<object|null>} 入库后的 ImageAttachmentRef，失败为 null
	 */
	async _captureFigure() {
		const zone = this.zoneMap?.figure;
		if (!zone) return null;

		// 没有 attachments 服务就没法入库 —— 这种情况下视觉通道不可用。
		// 明确记一条日志，而不是让调用方以为"附图成功但模型没看懂"。
		const attachments = this.attachments;
		if (!attachments?.saveImages) {
			this.log('未接入附件服务（ctx.attachments），图形题按纯文字作答', 'warn');
			return null;
		}

		try {
			const shot = await this.engine.screenshot({
				region: [zone.x, zone.y, zone.w, zone.h],
				maxWidth: 700,
			});
			if (!shot?.dataUrl?.startsWith('data:image')) {
				this.log('图形区截图未返回可用图片，本题按纯文字作答', 'warn');
				return null;
			}

			// dataUrl → 原始字节
			const base64 = shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1);
			const data = new Uint8Array(Buffer.from(base64, 'base64'));

			const [ref] = await attachments.saveImages([
				{ data, mediaType: 'image/png', name: 'figure.png' },
			]);
			if (!ref?.attachmentId) {
				this.log('图形截图入库失败（未返回附件引用），本题按纯文字作答', 'warn');
				return null;
			}
			this.log(`图形已入库（${ref.width}x${ref.height}, ${ref.bytes}B），走视觉通道`);
			return ref;
		} catch (err) {
			this.log(`图形区处理失败（${err?.message ?? err}），本题按纯文字作答`, 'warn');
			return null;
		}
	}

	_matchBank(question) {
		if (!this.bankMatcher) return null;
		try {
			const r = this.bankMatcher(question);
			if (!r || !r.ok) return null;
			return r;
		} catch (err) {
			this.log(`题库匹配异常：${err?.message ?? err}`, 'warn');
			return null;
		}
	}

	/** 把答案转成动作序列。这是"操作模型"最终落地的地方。
	 *
	 * 修正：答案不再是"必然是字母"的字符串。
	 *  文本答案（北京）和数字答案（3.14）如果走旧逻辑，会被
	 *  `String(answer).split('')` 当成一串要点的"选项字母"，
	 *  一个都匹配不上 —— 症状是"识别对了、但一个选项都没点"，
	 *  而且没有任何报错。所以这里必须按答案类型分派。
	 */
	_decide(question, answer) {
		if (!question || !answer) return [];
		const actions = [];
		const opts = question.opts ?? [];

		// 用统一的答案类型模型判定，避免各处各判一套
		const parsed = parseAnswer(answer, { optionCount: opts.length });

		if (parsed.kind === ANSWER_KIND.BOOL) {
			// 判断题：T 对应第一个选项，F 对应第二个
			const idx = parsed.bool === 'T' ? 0 : 1;
			const opt = opts[idx];
			if (opt?.sx !== undefined) {
				actions.push({ action: 'click_point', params: { x: opt.sx, y: opt.sy }, expect: { option_checked: true } });
			}
		} else if (parsed.kind === ANSWER_KIND.CHOICE) {
			// 字母题：逐个点选
			for (const letter of parsed.letters) {
				const opt = opts.find((o) => o.letter === letter);
				if (opt?.sx !== undefined) {
					actions.push({ action: 'click_point', params: { x: opt.sx, y: opt.sy }, expect: { option_checked: true } });
				}
			}
			if (actions.length === 0) {
				// 一个选项都没点上 = 必然错题。必须显式报出来，
				// 否则会静默跳题，用户以为"跑完了"。
				this.log(`答案 ${parsed.value} 在本题选项里找不到对应项，跳过点击`, 'warn');
			}
		} else {
			// 文本 / 数字答案：需要往输入框里打字。
			// 当前通道还没有"填答输入框"的动作（BACKLOG B-9 同类缺口），
			// 所以**明确拒绝并转人工**，而不是假装点了点什么。
			this.log(
				`这道题的答案是${parsed.kind === ANSWER_KIND.NUMBER ? '数字' : '文本'}「${parsed.value}」，` +
					`需要填进输入框；当前还不支持自动填写，转人工`,
				'warn'
			);
			return [];
		}

		return this._navActions(actions);
	}

	/** 推进到下一题的动作，追加到 actions 后返回。 */
	_navActions(actions = []) {
		// 已在最后一题：选完就结束，不再点「下一题」
		if (this._onLastQuestion()) return actions;
		// 推进到下一题：两种模式
		//   paged  = 点「下一题」按钮，用题号验证确实翻页了
		//   scroll = 一整页多题，只能滚轮；"翻到下一题"就是滚动，
		//            且**没有题号可验证**（整页没有 4/72 这种标记），
		//            所以验证降级为"画面确实变了"。
		const nav = this.profile.navigation ?? {};
		const mode = nav.mode === 'scroll' ? 'scroll' : 'paged';

		if (mode === 'scroll') {
			const step = Number(nav.scrollStepPx) || 520;
			actions.push({
				action: 'scroll',
				params: { dy: -step, x: 0, y: 0 },
				expect: { any_change: true },
			});
			return actions;
		}

		// paged 模式：优先用配置里的下一题角色
		const nextRole = this.profile.actions?.nextRole ?? 'next';
		if (this.zoneMap[nextRole]) {
			actions.push({ action: 'click_role', params: { role: nextRole }, expect: { page_changed: true }, timeout_ms: 5000 });
			return actions;
		}

		// 没配 next 按钮时退化：按一屏向下滚（仍在 paged 模式下，
		// 但说明用户没圈 next，只能靠滚动推进）
		const step = Number(nav.scrollStepPx) || 520;
		actions.push({ action: 'scroll', params: { dy: -step, x: 0, y: 0 }, expect: { any_change: true } });
		return actions;
	}

	async _actCurrent() {
		const action = this.state.pendingActions[this.state.actionIndex];
		if (!action) return;

		// 高风险动作再过一次闸（状态可能在循环中被改）
		const gate = gateAction({
			state: this.state.run,
			pauseReason: this.state.pauseReason,
			allowAutoSubmit: this.profile.answer?.allowAutoSubmit === true,
			submitConfirmed: this.ticket.isGranted(),
			budget: this.budget.limits,
			used: this.budget.used,
			actionRisk: requiresApproval(action) ? 'high' : 'low',
		});
		if (!gate.allowed) {
			this.log(`动作被门禁拦下：${gate.code}（${action.action}）`, 'warn');
			this._apply({ type: 'PAUSE', reason: gate.code.startsWith('SUBMIT') ? PAUSE_REASON.SUBMIT_GATE : PAUSE_REASON.ERROR });
			return;
		}

		const isClick = action.action === 'click_point' || action.action === 'click_letter';
		if (isClick) this._step('click', 'active', '点击中');
		else this._step('next', 'active', '翻页中');
		const region = this._regionOf('question');
		const envelope = this._materialize(action);
		const res = await this.engine.act(envelope, {
			region,
			settleMs: this.profile.actions?.clickIntervalMs ?? DEFAULTS.actionSettleMs,
		});

		this.log(`执行 ${action.action}：${res?.ok === false ? '失败 ' + (res?.error?.message ?? res?.reason ?? '') : '已发出'}`, res?.ok === false ? 'warn' : 'info');
		if (isClick) {
			const moreClicks = this.state.pendingActions
				.slice(this.state.actionIndex + 1)
				.some((a) => a.action === 'click_point' || a.action === 'click_letter');
			const ans = this._trackAnswer?.answer;
			if (res?.ok === false) this._step('click', 'warn', '点击失败');
			else this._step('click', moreClicks ? 'active' : 'done', ans ? `已点 ${String(ans).split('').join('、')}` : '已点击');
		} else {
			this._step('next', res?.ok === false ? 'warn' : 'done', res?.ok === false ? '翻页失败' : '已翻页');
		}
		// 把执行回执留在状态里，供 verify 使用
		this._lastAct = res;
		this._apply({ type: 'ACTED', observation: res ?? {} });
	}

	async _verifyCurrent() {
		const action = this.state.pendingActions[this.state.actionIndex];
		const expect = action?.expect ?? {};
		const obs = {};

		// 画面哈希（any_change 用）
		obs.hashBefore = this._lastAct?.beforeHash ?? this.state.hashBefore;
		obs.hashAfter = this._lastAct?.afterHash ?? null;

		// 题号（page_changed 用）
		if (expect.page_changed) {
			obs.progressBefore = this.state.progressBefore;
			const progRegion = this._regionOf('progress');
			// 网页通道：翻页后重新结构化读题，用页面题号确认；控件组 name 变化也算翻页
			const after = this.structReader ? await this.structReader().catch(() => null) : null;
			if (after?.question?.prog) {
				obs.progressAfter = after.question.prog;
			} else if (after?.question?.questionKey && this._lastQuestionKey && after.question.questionKey !== this._lastQuestionKey) {
				// 题号读不到但题目身份已变：视为已翻页。
				// 总数取极大值：这个值会写回 progressBefore，[-1,-1] 会让下一题被误判为最后一题
				obs.progressAfter = [-1, Number.MAX_SAFE_INTEGER];
			} else if (progRegion) {
				obs.progressAfter = await this._readProgressRetry(progRegion, '翻页验证');
			}
		}

		// 选中态（option_checked 用）：采样目标点颜色并与"未选中"基准比对
		if (expect.option_checked) {
			obs.checkedLetters = await this._detectChecked(action);
		}

		const verdict = checkExpect(expect, obs);
		if (verdict.satisfied) {
			this.failureStreak.success();
			// 翻页成功后要清掉旧题号，避免下一题误用
			if (expect.page_changed && obs.progressAfter) {
				this.state.progressBefore = obs.progressAfter;
			}
		} else {
			this.failureStreak.fail(verdict.reason);
		}

		// 终止判定（必须有，否则答完最后一题会无限循环）：
		//   ① 这是最后一题（翻页**之前**就已在最后一题）
		//   ② 预算耗尽（token / 题数）
		//   ③ 时间耗尽（单题超时已由求解器处理；这里判总时长）
		//   ④ 翻页后题号连续没变（说明页面卡住 / 已到末尾）
		//
		// ⚠ 判据必须用 progressBefore，不能用 progressAfter。
		//   原写法看翻页之后 `progressAfter[0] >= progressAfter[1]`：
		//   从第 N-1 题点「下一题」之后页面就停在 N/N 了，
		//   于是这一动被判成「到顶」，**第 N 题从来没被作答**。
		//   表现为「跑一跑就结束，最后一题永远是空的」。
		const onLastPage =
			expect.page_changed &&
			Array.isArray(obs.progressBefore) &&
			obs.progressBefore.length === 2 &&
			obs.progressBefore[0] >= obs.progressBefore[1];

		// 最后一题的特殊处理：页面已经没有「下一题」可翻，点下去题号必然不变。
		// 若这里还按「验证失败 → 重试 3 次 → 暂停」处理，就会出现
		// 「已经答完全部题目，却报"验证连续失败"停下」（实测复现）。
		// 语义上：最后一题的点击只要成功执行了，本题就算完成 —— 不需要再翻页。
		if (onLastPage && verdict.satisfied === false && action?.expect?.page_changed) {
			// 把「翻页验证」降级为「本题已答完」：不重试、不报错。
			this.log('已在最后一题，翻页不可用；按本题完成处理', 'info');
			this._apply({
				type: 'VERIFIED',
				verdict: { satisfied: true, reason: 'last_page_no_next', checks: verdict.checks },
				done: true,
			});
			const handledNowLast = Number(this.state?.stats?.handled ?? 0);
			if (handledNowLast > this._lastHandled) {
				this.budget.recordQuestion();
				this._lastHandled = handledNowLast;
			}
			return;
		}

		// 卡住检测只在"翻页"这一动上判定：
		//   pageAttempted = 这一动本来就是翻页
		//   pageSucceeded = 翻页后题号真的变了
		// 点选项这类中间动作不参与 —— 否则多选题（4 个动作）会被误判成卡住。
		const pageAttempted = expect.page_changed === true;
		const pageSucceeded =
			pageAttempted &&
			Array.isArray(obs.progressBefore) &&
			Array.isArray(obs.progressAfter) &&
			(obs.progressBefore[0] !== obs.progressAfter[0] ||
				obs.progressBefore[1] !== obs.progressAfter[1]);

		this._trackStuckRepeats(pageAttempted, pageSucceeded);
		const timeUp = this._totalTimeExceeded();
		if (timeUp) {
			this.log('总时长已达上限，停止', 'warn');
		}

		this._apply({
			type: 'VERIFIED',
			verdict,
			done:
				onLastPage ||
				this.budget.exceeded() ||
				timeUp ||
				this._stuckRepeats >= 3 ||
				// 最后一题不翻页：最后一个动作通过即整场完成
				(verdict.satisfied && !pageAttempted && this.state.actionIndex >= this.state.pendingActions.length - 1 && this._onLastQuestion()),
		});

		// 本题答完才记 question 预算 —— 必须在 _apply 之后，
		// 因为 stats.handled 是 pipeline 在处理 VERIFIED 时增加的。
		// 用增量判断而不是猜"这一动是不是最后一步"：
		// pipeline 才是"本题完成"的唯一判定者，这里只跟随它。
		const handledNow = Number(this.state?.stats?.handled ?? 0);
		if (handledNow > this._lastHandled) {
			this.budget.recordQuestion();
			this._lastHandled = handledNow;
		}
	}

	/** 整场运行是否超时。0 表示不限。 */
	_totalTimeExceeded() {
		const limit = this.timeLimits.totalMs;
		if (!limit) return false;
		if (!this.startedAtMs) return false;
		return Date.now() - this.startedAtMs >= limit;
	}

	/** 单题是否超时。0 表示不限。返回 true 时应放弃该题转人工。 */
	_questionTimeExceeded() {
		const limit = this.timeLimits.perQuestionMs;
		if (!limit) return false;
		if (!this.questionStartedAtMs) return false;
		return Date.now() - this.questionStartedAtMs >= limit;
	}

	/** 连续 3 次读到同一道题，说明页面没动，不能再点下去。
	 *
	 * ⚠ 只在「本题的所有动作都做完、且题号确实没变」时累积。
	 *
	 *  原实现没有这道门，每验证一个动作就累加一次。而一道题本来就有多个动作：
	 *    单选题 = 点选项 + 点下一题 = 2 个动作
	 *    多选题 = 点 3 个选项 + 点下一题 = 4 个动作
	 *  于是「同一道题的 4 个动作」被当成「同一道题连续读了 4 次」，
	 *  `_stuckRepeats >= 3` 成立 → done=true → **答完 1 题就整场结束**。
	 *  这正好解释了「点两题就又结束了」：多选题（ABD）在第 1~2 题就会触发。
	 *
	 *  正确语义是「翻页之后题号仍没变」才算卡住，所以：
	 *    · 只看收尾那一动（翻页 = page_changed），
	 *    · 且必须真的翻页尝试过（否则纯点击不算卡）。
	 *  未翻页的动作一律返回，不累计也不清零 —— 清零会把前面的累积抹掉。
	 */
	_trackStuckRepeats(pageAttempted, pageSucceeded) {
		// 还没走到"翻页"这一动：既不算卡住，也不该重置累积
		if (!pageAttempted) return;
		const key = this._questionKey(this.state.question);
		if (!key) return;
		if (pageSucceeded) {
			// 确实翻页成功 = 换题了，清零
			this._stuckRepeats = 0;
			this._lastQuestionKey = key;
			this.questionStartedAtMs = Date.now();
			return;
		}
		if (key === this._lastQuestionKey) {
			this._stuckRepeats += 1;
		} else {
			this._stuckRepeats = 0;
			this._lastQuestionKey = key;
			this.questionStartedAtMs = Date.now();
		}
	}

	/** 读题号，失败隔 400ms 再读一次；仍失败时把引擎返回写进日志，便于区分区域偏移与识别失败。 */
	async _readProgressRetry(region, stage) {
		let last = null;
		// 题号位数会变（1/12 → 10/12），按单位数时的宽度圈的区域会把末位截掉；读取时向右放宽
		const [rx, ry, rw, rh] = region;
		const wide = [rx, ry, Math.round(rw * 2.2), rh];
		for (let i = 0; i < 2; i++) {
			try {
				last = await this.engine.readProgress(wide);
				const prog = last?.ok && Array.isArray(last.progress) ? last.progress : null;
				if (prog && this._plausibleProgress(prog)) return prog;
				if (prog) last = { ...last, rejected: `题号 ${prog.join('/')} 与已知总数 ${this._maxTotal} 不符` };
			} catch (err) {
				last = { error: err?.message ?? String(err) };
			}
			if (i === 0) await sleep(400);
		}
		const raw = JSON.stringify(last ?? null).slice(0, 200);
		this.log(`${stage}：读不到题号，区域=${JSON.stringify(region)}，引擎返回=${raw}`, 'warn');
		return null;
	}

	/** 题号合理性：当前题不超过总数，总数不小于已见过的最大总数（截断的「10/1」会被拦下）。 */
	_plausibleProgress(prog) {
		const [cur, total] = prog;
		if (!(cur > 0 && total > 0 && cur <= total)) return false;
		if (this._maxTotal && total < this._maxTotal) return false;
		this._maxTotal = Math.max(this._maxTotal || 0, total);
		return true;
	}

	/** 当前题号显示已是最后一题（如 12/12）。 */
	_onLastQuestion() {
		const p = this.state.progressBefore;
		return Array.isArray(p) && p.length === 2 && p[0] > 0 && p[1] > 0 && p[0] >= p[1] && p[1] < Number.MAX_SAFE_INTEGER;
	}

	/** 清掉与「当前题」绑定的跟踪状态。用户手动翻页后旧题号、旧题目标识都不再可信。 */
	_resetQuestionTracking() {
		this._lastQuestionKey = null;
		this._stuckRepeats = 0;
		this.questionStartedAtMs = Date.now();
	}

	/* ── 人工选择 ──────────────────────────────────────
	 * 题库/模型给不出答案而暂停时，监视选项选中态：用户选好后（选中集合连续几次不变）
	 * 由程序点下一题，用户无需自己翻页，避免页面与程序记录的题号错位。
	 */
	_startManualWatch() {
		this._stopManualWatch();
		if (this.profile.answer?.manualAutoNext === false) return;
		const reason = this.state.pauseReason;
		if (reason !== PAUSE_REASON.UNKNOWN_QUESTION && reason !== PAUSE_REASON.LOW_CONFIDENCE) return;
		const q = this.state.question;
		if (!(q?.opts ?? []).some((o) => o.sx !== undefined)) return;
		// 多选题要给用户逐个点选的时间
		const multi = /multi|多选/.test(String(q.qtype ?? ''));
		const need = multi ? MANUAL_STABLE_POLLS_MULTI : MANUAL_STABLE_POLLS;
		let last = '';
		let stable = 0;
		this.log('等待人工选择：选好后程序会自动点下一题', 'info');
		this._manualWatch = setInterval(async () => {
			if (this._manualBusy) return;
			this._manualBusy = true;
			try {
				if (this.state.run !== RUN_STATE.PAUSED || this.state.pauseReason !== reason) {
					this._stopManualWatch();
					return;
				}
				const letters = await this._detectChecked();
				const key = (letters ?? []).slice().sort().join('');
				if (!key) {
					last = '';
					stable = 0;
					return;
				}
				stable = key === last ? stable + 1 : 1;
				last = key;
				if (stable >= need) await this._acceptManualPick(key);
			} catch (err) {
				this.log(`人工选择检测失败：${err?.message ?? err}`, 'warn');
			} finally {
				this._manualBusy = false;
			}
		}, MANUAL_POLL_MS);
		this._manualWatch.unref?.();
	}

	_stopManualWatch() {
		if (this._manualWatch) {
			clearInterval(this._manualWatch);
			this._manualWatch = null;
		}
	}

	async _acceptManualPick(letters) {
		this._stopManualWatch();
		const actions = this._navActions([]);
		this.log(`检测到人工选择：${letters}，自动点下一题`, 'info');
		this._markAnswer({ answer: letters, label: '人工', review: false, confidence: null, reason: '' });
		this._step('click', 'done', `人工 ${letters.split('').join('、')}`);
		this._paused = false;
		this.failureStreak.reset();
		try {
			await this.engine.resume();
		} catch {
			/* ignore */
		}
		this._apply({ type: 'MANUAL_ANSWERED', answer: letters, actions });
		this._emit();
		this._loop = this._runLoop();
		this._loop.catch(() => {});
	}

	_questionKey(q) {
		if (!q) return null;
		const stem = String(q.stem ?? '').trim().slice(0, 80);
		const prog = Array.isArray(q.prog) ? q.prog.join('/') : '';
		return `${prog}|${stem}`;
	}

	/**
	 * 检测哪些选项处于选中态。
	 * 用颜色采样而不是哈希：选项变绿与"页面重绘"在哈希上无法区分。
	 */
	async _detectChecked(action) {
		const question = this.state.question;
		const pts = (question?.opts ?? [])
			.filter((o) => o.sx !== undefined && o.sy !== undefined)
			.map((o) => ({ x: o.sx, y: o.sy, label: o.letter }));
		if (pts.length === 0) return null;

		try {
			const res = await this.engine.probeColors(pts);
			const checked = [];
			// 选中态的判据：绿色通道明显高于蓝色（绿底），或整体亮度低于基线
			for (const p of res?.points ?? []) {
				if (!p.rgb) continue;
				const [r, g, b] = p.rgb;
				const greenish = g > r + 12 && g > b + 8;
				// 蓝色高亮也算选中（有些系统用蓝底）
				const bluish = b > r + 20 && b > g + 10;
				if (greenish || bluish) checked.push(p.label);
			}
			return checked;
		} catch {
			return null;
		}
	}

	/* ── 工具 ─────────────────────────────────────────── */

	/** 把角色动作解析成具体坐标（引擎只认坐标）。 */
	_materialize(action) {
		if (action.action !== 'click_role') return action;
		const z = this.zoneMap[action.params.role];
		if (!z) throw new Error(`配置里没有角色 ${action.params.role}`);
		return {
			...action,
			action: 'click_point',
			params: { x: z.x + Math.floor(z.w / 2), y: z.y + Math.floor(z.h / 2) },
		};
	}

	_regionOf(role) {
		const z = this.zoneMap[role];
		return z ? [z.x, z.y, z.w, z.h] : null;
	}

	/* ── 步骤轨道（悬浮窗用）───────────────────────────────
	 * 每题固定 5 步：读题 → 题库 → 模型 → 点击 → 翻页。
	 * 由 Runner 在每步开始/结束时直接上报，不从日志反推，
	 * 这样「当前正在做哪一步」才准确（模型思考的几十秒也看得见）。
	 */
	_trackBegin() {
		const t = this._track;
		// 同一题重试（上一题还没翻页）不新开轨道，只重置读题这一步
		if (t && t.steps.find((s) => s.key === 'next')?.status !== 'done') return;
		if (t) this._archiveTrack();
		this._trackSeq += 1;
		this._track = {
			id: this._trackSeq,
			prog: null,
			qtype: '',
			steps: TRACK_STEPS.map(([key, label]) => ({ key, label, status: 'todo', detail: '', startedAt: 0 })),
		};
	}

	_archiveTrack() {
		const t = this._track;
		if (!t) return;
		const a = this._trackAnswer;
		this._history.push({ prog: t.prog, answer: a?.answer ?? null, source: a?.label ?? '', review: Boolean(a?.review) });
		if (this._history.length > 50) this._history.shift();
		this._trackAnswer = null;
	}

	_step(key, status, detail = '') {
		const s = this._track?.steps.find((x) => x.key === key);
		if (!s) return;
		if (status === 'active' && s.status !== 'active') s.startedAt = Date.now();
		s.status = status;
		s.detail = String(detail ?? '');
		this._emit();
	}

	/** 记下本题答案；低置信时加入待复核清单。 */
	_markAnswer({ answer, label, review, confidence, reason }) {
		this._trackAnswer = { answer, label, review };
		const seq = this._track?.id ?? null;
		// 同一题重试会再次求解：先去掉这题的旧记录，避免待复核重复
		if (seq !== null) this._reviews = this._reviews.filter((r) => r.seq !== seq);
		if (!review) return;
		const prog = this._track?.prog ?? this.state.progressBefore ?? null;
		this._reviews.push({
			prog: Array.isArray(prog) && prog[0] > 0 ? prog : null,
			seq: this._track?.id ?? this._reviews.length + 1,
			qtype: this._track?.qtype ?? '',
			answer,
			source: label,
			confidence: confidence ?? null,
			reason: reason ? String(reason).slice(0, 60) : '',
		});
	}

	/** 校准统计：按置信档位累计「模型答案 = 标准答案」的比例，结果写日志 */
	_recordCalib(r, truth) {
		const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '').split('').sort().join('');
		const tier = r.tier ?? 'single';
		this._calib ??= {};
		const c = (this._calib[tier] ??= { n: 0, ok: 0 });
		c.n += 1;
		if (norm(r.answer) === norm(truth)) c.ok += 1;
		const NAMES = { agree: '全部一致', majority: '多数一致', split: '各不相同', partial: '有失败', single: '单次' };
		const summary = Object.entries(this._calib)
			.map(([k, v]) => `${NAMES[k] ?? k} ${v.ok}/${v.n}=${((v.ok / v.n) * 100).toFixed(0)}%`)
			.join('；');
		this.log(`[calib] 本题 ${NAMES[tier] ?? tier}：模型 ${r.answer} / 标准 ${truth}。累计：${summary}`);
	}

	_modelLabel(r) {
		return r?.model || this.profile.answer?.model || this.solver?.target?.model || '自动选择';
	}

	_apply(event) {
		const prevLog = this.state?.log ?? [];
		const prevLast = prevLog[prevLog.length - 1];
		const { state } = transition(this.state, event, {
			allowAutoSubmit: this.profile.answer?.allowAutoSubmit === true,
			submitConfirmed: this.ticket.isGranted(),
			budget: this.budget.limits,
			used: this.budget.used,
		});
		this.state = state;
		// 状态机自己的日志（置信度不足 / 暂停原因等）转发到插件日志，面板才看得到。
		// 状态机日志是 200 条的滑动窗口，按"上一轮最后一条"定位新增部分。
		const nextLog = state?.log ?? [];
		let start = 0;
		if (prevLast) {
			const i = nextLog.lastIndexOf(prevLast);
			start = i >= 0 ? i + 1 : 0;
		}
		for (const entry of nextLog.slice(start)) {
			try {
				this.log(`[状态] ${entry.msg}`, 'info');
			} catch {
				/* 日志失败不影响运行 */
			}
		}
	}

	_emit() {
		try {
			this.onState(this.snapshot());
		} catch {
			/* 回调失败不影响运行 */
		}
	}

	snapshot() {
		return {
			runId: this.runId,
			...summarize(this.state),
			budget: this.budget.snapshot(),
			failureStreak: this.failureStreak.count,
			submitGranted: this.ticket.isGranted(),
			channel: this.profile.channel ?? 'screen',
			track: this._track ?? null,
			history: (this._history ?? []).slice(-50),
			reviews: this._reviews ?? [],
			modelStats: { ...(this._modelStats ?? { calls: 0, failed: 0, tokens: 0 }) },
		};
	}
}

function unionRegion(a, b) {
	if (!a) return b;
	if (!b) return a;
	const x = Math.min(a[0], b[0]);
	const y = Math.min(a[1], b[1]);
	const x2 = Math.max(a[0] + a[2], b[0] + b[2]);
	const y2 = Math.max(a[1] + a[3], b[1] + b[3]);
	return [x, y, x2 - x, y2 - y];
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
