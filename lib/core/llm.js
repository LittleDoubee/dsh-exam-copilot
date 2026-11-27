// 解题池：走 DSH 模型路由（ctx.llm），不存 API key。
//
// 「多 agent 协同」在这套设计里被还原成两件独立的事，分别开关：
//   ① 并发题解 —— 瓶颈在 26.5s/题 里 95.9% 是网络等待，并发收益最大
//   2 多模型投票 —— 3 个模型各答一次取多数；不一致即低置信，转人工
// 不引入 agent 框架：考试是串行的，能并行的只有上游求解，
// 用 agent 编排只会增加不确定性。
//
// 本模块只依赖传入的 llm 对象（形状：listProviders/listModels/stream），
// 不 import 宿主 —— 便于用假 llm 单测。

/** 解析模型输出。要求模型只回 JSON，尽量宽松地兜住常见格式。 */
export function parseAnswer(text) {
	const raw = String(text ?? '').trim();
	if (!raw) return { ok: false, error: '模型返回为空' };

	// 去掉 ```json 围栏
	let body = raw;
	const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) body = fence[1].trim();

	// 从第一个 { 到最后一个 } 之间尝试解析（模型常带前后废话）
	const first = body.indexOf('{');
	const last = body.lastIndexOf('}');
	if (first >= 0 && last > first) body = body.slice(first, last + 1);

	let obj;
	try {
		obj = JSON.parse(body);
	} catch {
		// 退化：直接从文本里找答案。
		// 必须同时认中文"答案："与 JSON 片段 —— 模型经常只回一行中文，
		// 只认 "answer" 会漏掉最自然的一种输出。
		const patterns = [
			/"?answer"?\s*[:：]\s*"?([A-F]{1,6}|T|F|对|错|正确|错误|√|×)"?/i,
			/(?:答案|正确答案|故选|应选)\s*[:：是为]*\s*([A-F]{1,6}|对|错|正确|错误|√|×)/,
			/\b([A-F]{1,6})\b/, // 最后兜底：全文里唯一的字母串
		];
		for (const re of patterns) {
			const m = raw.match(re);
			if (m) {
				const v = normalizeAnswer(m[1]);
				if (v) return { ok: true, value: v, confidence: 0.5, reason: '非 JSON，从文本提取' };
			}
		}
		return { ok: false, error: '无法解析为 JSON' };
	}

	const answer = obj.answer ?? obj.Answer ?? obj.答案;
	if (answer === undefined) return { ok: false, error: 'JSON 里没有 answer 字段' };

	return {
		ok: true,
		value: normalizeAnswer(answer),
		confidence: clamp01(obj.confidence ?? obj.置信度 ?? 0.7),
		reason: String(obj.reason ?? obj.理由 ?? '').slice(0, 400),
	};
}

/** 把各种写法归一到 "A" / "ABD" / "T" / "F"。 */
export function normalizeAnswer(v) {
	if (Array.isArray(v)) v = v.join('');
	const s = String(v ?? '').trim().toUpperCase();
	if (['对', '正确', 'TRUE', 'T', '√', '是'].includes(s)) return 'T';
	if (['错', '错误', 'FALSE', 'F', '×', '否'].includes(s)) return 'F';
	const letters = s.match(/[A-F]/g);
	if (letters) return [...new Set(letters)].sort().join('');
	return s;
}

function clamp01(v) {
	const n = Number(v);
	if (!Number.isFinite(n)) return 0.7;
	return Math.max(0, Math.min(1, n));
}

/** 单题提示词。刻意短——模型只需要输出 JSON，不需要长篇推理。 */
export function buildPrompt(question, { webSearch = false, hints = '', hasFigure = false, webRefs = '' } = {}) {
	const opts = (question.opts ?? []).map((o) => `${o.letter}. ${o.text}`).join('\n');
	// 题型要同时认中文和网页通道给的英文（multi/single/judge）。
	// 只认「多选」时，网页读到的 'multi' 会落进单选分支，提示词让模型「用单个字母」——
	// 这就是多选题总只答一个字母的原因。
	const rawType = String(question.qtype || '单选');
	const multi = /多选|multi/i.test(rawType);
	const judge = /判断|judge|bool/i.test(rawType);
	const qtype = multi ? '多选题' : judge ? '判断题' : '单选题';

	const rules = [
		`题型：${qtype}`,
		multi ? '多选：至少两个正确选项，answer 用多个大写字母，如 "ABD"，按字母序；逐项判断每个选项是否正确。' : '',
		judge ? '判断：answer 用 "T"（正确）或 "F"（错误）。' : '',
		!multi && !judge ? '单选：answer 用单个大写字母。' : '',
		'只输出 JSON，不要任何解释性前后缀。',
	].filter(Boolean);

	return {
		system: [
			'你是答题助手。只输出一个 JSON 对象，格式：{"answer":"A","confidence":0.9,"reason":"简短依据"}',
			'confidence 是你对该答案的把握，0 到 1。不确定就诚实给低分，不要猜。',
			...rules,
			// 视觉通道：题目带图时明确告诉模型该看图。
			// 不写这句时，模型会忽视附图、只凭题干文字硬猜 ——
			// 图形题的文字部分往往信息不足（如"缺失的环节应当是"）。
			hasFigure
				? '附图中包含题目所需的图形信息（流程图/表格/电路图等）。' +
				  '请**先看图**再作答；若图中信息不足以确定答案，把 confidence 降到 0.3 以下。'
				: '',
			hints ? `额外要求：${hints}` : '',
			webSearch && webRefs
				? '用户消息末尾附有联网检索到的「参考资料」，可能不准确或无关：与题目相符时参考，矛盾时以你的判断为准，不确定时降低 confidence。'
				: webSearch
					? '若题干涉及具体条文或数据，可依据你的知识库作答；不确定时降低 confidence。'
					: '',
		]
			.filter(Boolean)
			.join('\n'),
		user:
			`题目：${question.stem ?? ''}${opts ? `\n\n选项：\n${opts}` : ''}` +
			(webSearch && webRefs ? `\n\n参考资料（联网检索）：\n${webRefs}` : ''),
	};
}

/**
 * 解题池。并发跑多个 (provider, model)，可选投票。
 *
 * @param {object} llm 宿主模型服务（listProviders/listModels/stream）
 * @param {object} opts { concurrency, votes, timeoutMs }
 */
export class SolverPool {
	constructor(llm, opts = {}) {
		this.llm = llm;
		this.concurrency = Math.max(1, Number(opts.concurrency) || 3);
		this.votes = Math.max(0, Number(opts.votes) || 0); // 0 = 不投票
		this.timeoutMs = Number(opts.timeoutMs) || 60_000;
		// 用户面板里选定的模型；空则自动挑第一个可用
		this.target = opts.target && opts.target.provider && opts.target.model ? { ...opts.target } : null;
		// 参与投票的其他模型：[{provider, model, webSearch}]，与主模型重复的剔除
		this.voters = (Array.isArray(opts.voters) ? opts.voters : []).map((v) =>
			v && v.provider && v.model && !(this.target && v.provider === this.target.provider && v.model === this.target.model)
				? { provider: v.provider, model: v.model, webSearch: v.webSearch === true }
				: null
		);
		// 联网检索器（WebSearcher），没有则「允许联网」退化为仅提示词
		this.searcher = opts.searcher ?? null;
		this.active = 0;
	}

	/** 取一个可用的 (provider, model)。优先用户选定的，其次第一个可用的。 */
	async pickTarget(preferred) {
		if (preferred?.provider && preferred?.model) return { ...preferred };
		if (this.target?.provider && this.target?.model) return { ...this.target };
		let providers = [];
		try {
			providers = this.llm.listProviders() ?? [];
		} catch {
			return null;
		}
		for (const p of providers) {
			let models = [];
			try {
				models = (await this.llm.listModels(p.id)) ?? [];
			} catch {
				continue;
			}
			const first = models[0];
			if (first) {
				return { provider: p.id, model: first.id ?? first.name ?? String(first) };
			}
		}
		return null;
	}

	/** 跑一个目标解一道题。 */
	async solveOnce(question, target, opts = {}) {
		const { system, user } = buildPrompt(question, opts);
		const started = Date.now();
		let text = '';
		let tokens = 0;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		// 登记在途请求：用户暂停时 abortAll() 能立刻掐断模型思考
		this._live ??= new Set();
		this._live.add(controller);

		// 视觉通道：把图片放进同一条 user message。
		//
		// 格式必须是 DSH 的 ImageBlock —— 已对照宿主源码确认：
		//   @deepseek-ai/dsh-llm/src/types.ts
		//     export interface ImageBlock {
		//       type: 'image'
		//       attachment: ImageAttachmentRef   ← 是"附件引用"，不是 base64
		//       offloaded?: true
		//     }
		// 而 ImageAttachmentRef 由 ctx.attachments.saveImages() 入库后返回：
		//     { attachmentId, mediaType, bytes, width, height, name? }
		//
		// 也就是说 llm **不接受内联 dataUrl**。第一版写成
		//   { type: 'image', source: dataUrl }
		// 是错的（那是我照 Anthropic 风格猜的），实测查证后改掉。
		// 顺序（文字在前、图在后）：模型先读题干与选项，再看图找缺失处；
		// 反过来容易只描述图片而忘记回答案。
		const content = [{ type: 'text', text: user }];
		if (opts.imageAttachment) {
			content.push({ type: 'image', attachment: opts.imageAttachment });
		}

		try {
			const stream = this.llm.stream({
				provider: target.provider,
				model: target.model,
				maxTokens: opts.maxTokens ?? 800,
				system,
				messages: [{ role: 'user', content }],
				signal: controller.signal,
			});

			// usage 可能不在 finish 块里（finish 块可能不带 usage）：任何块带 usage 都收集
			const types = new Set();
			let usage = null;
			const pickUsage = (c) => c?.usage ?? c?.response?.usage ?? c?.providerMetadata?.usage ?? c?.message?.usage ?? null;
			for await (const chunk of stream) {
				types.add(chunk?.type ?? '?');
				if (chunk?.type === 'text-delta') text += chunk.text ?? '';
				const u0 = pickUsage(chunk);
				if (u0 && typeof u0 === 'object') usage = { ...(usage ?? {}), ...u0 };
				if (chunk?.type === 'finish') break;
			}
			const u = usage ?? {};
			const num = (...ks) => ks.map((k) => Number(u[k])).find((n) => Number.isFinite(n) && n > 0) ?? 0;
			const total = num('totalTokens', 'total_tokens');
			tokens = total || num('inputTokens', 'promptTokens', 'prompt_tokens', 'input_tokens') + num('outputTokens', 'completionTokens', 'completion_tokens', 'output_tokens');
			this.lastUsageShape = usage ? Object.keys(u).join(',') : `(无 usage；块类型 ${[...types].join(',')})`;
			// 宿主完全不给 usage 时按字数估算（中文约 1 字≈1 token），标记为估算
			if (!tokens) {
				this.lastTokensEstimated = true;
				tokens = Math.ceil((system.length + user.length + text.length) * 0.8);
			} else {
				this.lastTokensEstimated = false;
			}
		} catch (err) {
			// 超时中断时 stream 可能直接抛 AbortError，交给下面统一按超时处理
			if (!controller.signal.aborted) throw err;
		} finally {
			clearTimeout(timer);
			this._live.delete(controller);
		}

		// 用户暂停导致的中断：不算超时、不重试
		if (controller._cancelled) {
			return { ok: false, cancelled: true, error: '已暂停，模型请求已取消', provider: target.provider, model: target.model, ms: Date.now() - started, tokens };
		}

		// 超时：以前会因为文字为空被报成「模型返回为空」，误导排查
		if (controller.signal.aborted) {
			return {
				ok: false,
				timeout: true,
				error: `模型超时（${Math.round(this.timeoutMs / 1000)}s）`,
				provider: target.provider,
				model: target.model,
				ms: Date.now() - started,
				tokens,
			};
		}

		const parsed = parseAnswer(text);
		return {
			...parsed,
			provider: target.provider,
			model: target.model,
			ms: Date.now() - started,
			tokens,
			raw: text.slice(0, 500),
		};
	}

	/** 取消所有在途模型请求（用户暂停时调用）。返回取消的数量。 */
	abortAll() {
		let n = 0;
		for (const c of this._live ?? []) {
			c._cancelled = true;
			c.abort();
			n++;
		}
		return n;
	}

	/** 跑一次；超时自动重试一次（偶发慢请求不该让用户手动暂停再继续）。 */
	async _solveWithRetry(question, target, opts, i) {
		let last = null;
		let tokens = 0;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				last = await this.solveOnce(question, target, opts);
			} catch (err) {
				last = { ok: false, error: `第 ${i + 1} 次求解失败: ${err?.message ?? err}` };
			}
			tokens += Number(last?.tokens ?? 0) || 0;
			if (!last?.timeout) break;
		}
		return { ...last, tokens };
	}

	/**
	 * 解一道题。
	 *
	 * votes≥2 时：**同一个模型**独立作答 N 次（并发），按一致性定置信度。
	 * 注意这不是多模型投票 —— 它能滤掉偶然答错，但模型对某题理解有误时会一致地错。
	 * @returns {{ok, answer, confidence, source, votes?, totalTokens, model}}
	 */
	async solve(question, opts = {}) {
		const target = await this.pickTarget(opts.target);
		if (!target) {
			return { ok: false, error: '没有可用的模型（ctx.llm 无 provider 或无 model）' };
		}

		// 0 / 1 = 只答一次；≥2 才多次作答（上限 5）
		const n = this.votes >= 2 ? Math.min(5, this.votes) : 1;
		// 每一票用哪个模型：第 1 票是主模型，其余按面板「参与模型」，没选的由主模型补答。
		// 联网开关按模型各自生效（主模型用 opts.webSearch）。
		const slots = Array.from({ length: n }, (_, i) => {
			const v = i === 0 ? null : this.voters[i - 1];
			if (v?.provider && v?.model) return { target: { provider: v.provider, model: v.model }, webSearch: v.webSearch === true };
			return { target, webSearch: opts.webSearch === true };
		});
		// 联网：任一模型勾了才搜，且同题只搜一次、各模型共用；失败返回 '' 照常答题
		let webRefs = '';
		if (this.searcher && slots.some((s) => s.webSearch)) {
			try {
				webRefs = await this.searcher.search(question.stem);
			} catch {
				webRefs = '';
			}
		}
		// 并发：N 次互不依赖，串行会让每题耗时变成 N 倍
		const tried = await Promise.all(
			slots.map((s, i) =>
				this._solveWithRetry(question, s.target, { ...opts, webSearch: s.webSearch, webRefs: s.webSearch ? webRefs : '' }, i)
			)
		);
		const modelNames = [...new Set(slots.map((s) => s.target.model))];
		const totalTokens = tried.reduce((sum, t) => sum + (Number(t?.tokens) || 0), 0);

		const good = tried.filter((t) => t.ok);
		if (good.length === 0) {
			return { ok: false, error: tried[0]?.error ?? '全部求解失败', votes: tried, totalTokens, model: target.model };
		}

		// 单次作答：采信模型自评，但封顶 0.9（模型自评普遍偏高）
		if (n === 1) {
			const g = good[0];
			return {
				ok: true,
				answer: g.value,
				confidence: Math.min(g.confidence, 0.9),
				reason: g.reason,
				source: 'model',
				tier: 'single',
				votes: tried,
				totalTokens,
				model: target.model,
			};
		}

		// 多次作答但有失败，或成功不足 2 次：一致性无从判断，一律压到阈值以下 → 待复核
		if (good.length < 2 || good.length < tried.length) {
			// 成功的几票里取多数；没有多数（如 1:1）时采用排在最前的成功票（优先主模型），并压低置信度
			const pt = new Map();
			for (const x of good) pt.set(x.value, (pt.get(x.value) ?? 0) + 1);
			const ps = [...pt.entries()].sort((a, b) => b[1] - a[1]);
			const split = ps.length > 1 && ps[0][1] === ps[1][1];
			const pick = split ? good[0].value : ps[0][0];
			const g = good.find((x) => x.value === pick) ?? good[0];
			const failed = tried.length - good.length;
			return {
				ok: true,
				answer: pick,
				confidence: split ? 0.35 : Math.min(g.confidence ?? 0.5, 0.5),
				reason: `多次作答仅 ${good.length}/${tried.length} 次成功（${failed} 次失败）；成功的 ${good.length} 次${ps.length === 1 ? '一致' : `分歧（${ps.map(([a, c]) => `${a}:${c}`).join(' ')}）${split ? '，票数相同，采用主模型答案' : ''}`}`,
				source: 'model-vote',
				tier: 'partial',
				votes: tried,
				totalTokens,
				model: target.model,
			};
		}

		// 多次：计票
		const tally = new Map();
		for (const g of good) {
			tally.set(g.value, (tally.get(g.value) ?? 0) + 1);
		}
		const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
		const [winner, winnerVotes] = sorted[0];
		const agreed = winnerVotes === good.length;
		const majority = winnerVotes > good.length / 2;

		// 不一致时，把置信度压到阈值以下 → 触发转人工
		const confidence = agreed ? 0.92 : majority ? 0.6 : 0.35;

		return {
			ok: true,
			answer: winner,
			confidence,
			reason: agreed
				? `${good.length} 次作答一致`
				: `${good.length} 次作答分歧（${sorted.map(([a, c]) => `${a}:${c}`).join(' ')}）`,
			source: 'model-vote',
			// 置信档位，供校准统计按档算实际正确率
			tier: agreed ? 'agree' : majority ? 'majority' : 'split',
			votes: tried,
			totalTokens,
			model: modelNames.join('+'),
		};
	}

	/** 并发解一批题（题面互不依赖时可批量预处理）。 */
	async solveBatch(questions, opts = {}) {
		const results = new Array(questions.length).fill(null);
		let cursor = 0;

		const worker = async () => {
			while (cursor < questions.length) {
				const i = cursor++;
				results[i] = await this.solve(questions[i], opts);
			}
		};

		const workers = Array.from({ length: Math.min(this.concurrency, questions.length) }, worker);
		await Promise.all(workers);
		return results;
	}
}
