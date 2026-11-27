// 动作白名单：模型只能从这个封闭集合里选动作，参数必须过 schema 校验。
//
// 三重收益（这是 S2 的地基，不是可选项）：
//   ① 安全 —— 模型无法为所欲为，`submit` 这类高风险动作还要额外过护栏
//   ② 可回放 —— 动作日志即轨迹，能复现、能复盘
//   ③ 可测 —— 用假通道注入就能跑端到端，不必真点鼠标
//
// 零 ctx：本模块不认识宿主，纯函数，可 node --test 直接跑。

/**
 * 动作定义。
 *  - params：字段名 → 规格。`required` 决定缺省时是否报错。
 *  - risk：low 直接放行；medium 记账；high 必须过 guardrails 显式许可。
 *  - channels：允许在哪些通道上执行（screen=屏幕坐标，web=DOM）
 *  - expect：该动作默认期望，用于 verify（可由调用方覆盖）
 */
export const ACTIONS = {
	click_point: {
		desc: '在屏幕坐标处点击',
		risk: 'low',
		channels: ['screen'],
		params: {
			x: { type: 'int', min: 0, required: true },
			y: { type: 'int', min: 0, required: true },
		},
		expect: {},
	},
	click_letter: {
		desc: '点击某个选项字母（按解析出的实测坐标）',
		risk: 'low',
		channels: ['screen', 'web'],
		params: {
			letter: { type: 'letter', required: true },
		},
		expect: { option_checked: true },
	},
	click_role: {
		desc: '点击某个语义角色区域（如 next / submit / prev）',
		risk: 'low',
		channels: ['screen'],
		params: {
			role: { type: 'role', required: true },
		},
		expect: {},
	},
	type_text: {
		desc: '输入文本（填空题用）',
		risk: 'medium',
		channels: ['screen', 'web'],
		params: {
			text: { type: 'string', maxLength: 4000, required: true },
		},
		expect: { text_inserted: true },
	},
	press_key: {
		desc: '按键（如 Tab / Enter / Escape）',
		risk: 'medium',
		channels: ['screen'],
		params: {
			key: { type: 'key', required: true },
		},
		expect: {},
	},
	scroll: {
		desc: '滚动（读长题用）',
		risk: 'low',
		channels: ['screen'],
		params: {
			dy: { type: 'int', min: -5000, max: 5000, required: true },
		},
		expect: {},
	},
	wait: {
		desc: '等待（给界面渲染时间）',
		risk: 'low',
		channels: ['screen', 'web'],
		params: {
			ms: { type: 'int', min: 0, max: 10000, required: true },
		},
		expect: {},
	},
	focus_window: {
		desc: '按标题激活窗口（自绘窗口失焦会暂停渲染）',
		risk: 'medium',
		channels: ['screen'],
		params: {
			title: { type: 'string', maxLength: 200, required: true },
		},
		expect: {},
	},
	next: {
		desc: '翻到下一题，并验证题号确实变化',
		risk: 'medium',
		channels: ['screen', 'web'],
		params: {},
		expect: { page_changed: true },
	},
	web_click: {
		desc: '按 CSS 选择器点击（浏览器通道，比坐标可靠）',
		risk: 'low',
		channels: ['web'],
		params: {
			selector: { type: 'string', maxLength: 500, required: true },
		},
		expect: {},
	},
	web_fill: {
		desc: '按 CSS 选择器填入文本',
		risk: 'medium',
		channels: ['web'],
		params: {
			selector: { type: 'string', maxLength: 500, required: true },
			text: { type: 'string', maxLength: 4000, required: true },
		},
		expect: { text_inserted: true },
	},
	submit: {
		desc: '交卷。高风险：必须同时满足 profile 开关 + 运行期确认 + 护栏许可',
		risk: 'high',
		channels: ['screen', 'web'],
		params: {},
		expect: { any_change: true },
	},
};

export const ACTION_NAMES = Object.keys(ACTIONS);

/** 按键白名单：只允许这些键，其他一律拒绝（防模型乱按键）。 */
export const ALLOWED_KEYS = new Set([
	'enter',
	'tab',
	'escape',
	'space',
	'backspace',
	'delete',
	'up',
	'down',
	'left',
	'right',
	'home',
	'end',
	'pageup',
	'pagedown',
]);

const LETTERS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'T', 'F_']);

/**
 * 校验一个动作信封。
 * @param {{action:string, params?:object, expect?:object, timeout_ms?:number}} envelope
 * @param {{channel?:'screen'|'web', roles?:string[]}} ctx
 * @returns {{ok:true, envelope:object} | {ok:false, error:{code,message,field?}}}
 */
export function validateAction(envelope, ctx = {}) {
	if (!envelope || typeof envelope !== 'object') {
		return err('INVALID_ENVELOPE', '动作信封必须是对象');
	}
	const name = envelope.action;
	if (typeof name !== 'string' || !name) {
		return err('MISSING_ACTION', '缺少 action 字段');
	}
	const spec = ACTIONS[name];
	if (!spec) {
		return err('UNKNOWN_ACTION', `未知动作: ${name}（可用: ${ACTION_NAMES.join('/')}）`);
	}

	// 通道约束：在屏幕通道上执行 web 动作必然失败，提前拒绝比运行期报错好
	const channel = ctx.channel ?? 'screen';
	if (spec.channels && !spec.channels.includes(channel)) {
		return err('WRONG_CHANNEL', `动作 ${name} 不支持通道 ${channel}（支持: ${spec.channels.join('/')}）`);
	}

	const params = envelope.params ?? {};
	if (typeof params !== 'object' || Array.isArray(params)) {
		return err('INVALID_PARAMS', 'params 必须是对象');
	}

	// 未知参数：宁可报错，也不要静默忽略（否则模型以为生效了）
	for (const key of Object.keys(params)) {
		if (!spec.params[key]) {
			return err('UNKNOWN_PARAM', `动作 ${name} 没有参数 ${key}（可用: ${Object.keys(spec.params).join('/') || '无'}）`, key);
		}
	}

	const clean = {};
	for (const [field, rule] of Object.entries(spec.params)) {
		const raw = params[field];
		if (raw === undefined || raw === null) {
			if (rule.required) return err('MISSING_PARAM', `动作 ${name} 缺少参数 ${field}`, field);
			continue;
		}
		const checked = checkValue(raw, rule, field, name);
		if (!checked.ok) return checked;
		clean[field] = checked.value;
	}

	// 角色类动作：必须是 profile 里真实存在的角色
	if (name === 'click_role' && Array.isArray(ctx.roles) && !ctx.roles.includes(clean.role)) {
		return err('UNKNOWN_ROLE', `配置里没有角色 ${clean.role}（已定义: ${ctx.roles.join('/') || '无'}）`, 'role');
	}

	// ── 坐标必须落在屏幕内────────────────
	//
	// 旧实现 click_point 的 x/y 只有 min:0，**没有上限**。
	// 于是 (999999,999999) 这样的坐标会被放行 ——
	// 真点上去等于点到屏幕外的未知位置（可能落到副屏、也可能被系统夹到边缘乱点）。
	// 坐标来源是 OCR 与模型，它们都可能给出离谱值，必须在这里挡。
	//
	// 屏幕尺寸由调用方从引擎 health 拿（ctx.screen = {w,h}）。
	// 拿不到尺寸时不拦（早期调用方没传，宁可少拦也不要误伤），
	// 但要留清晰注释说明这是"已知缺口"，方便日后收紧。
	if (name === 'click_point' && ctx.screen && Number(ctx.screen.w) > 0 && Number(ctx.screen.h) > 0) {
		const sw = Number(ctx.screen.w);
		const sh = Number(ctx.screen.h);
		if (clean.x > sw || clean.y > sh) {
			return err(
				'OUT_OF_SCREEN',
				`click_point 坐标 (${clean.x},${clean.y}) 超出屏幕 ${sw}x${sh} —— 疑似识别或模型给了离谱坐标`,
				clean.x > sw ? 'x' : 'y'
			);
		}
	}

	const expect = envelope.expect ?? spec.expect ?? {};
	const timeoutMs = clampInt(envelope.timeout_ms, 200, 30_000, 3000);

	return {
		ok: true,
		envelope: {
			action: name,
			params: clean,
			expect: expect && typeof expect === 'object' ? expect : {},
			timeout_ms: timeoutMs,
			risk: spec.risk,
			note: typeof envelope.note === 'string' ? envelope.note.slice(0, 200) : '',
		},
	};
}

function checkValue(raw, rule, field, action) {
	switch (rule.type) {
		case 'int': {
			const n = Number(raw);
			if (!Number.isFinite(n) || !Number.isInteger(n)) {
				return err('BAD_TYPE', `${action}.${field} 必须是整数`, field);
			}
			if (rule.min !== undefined && n < rule.min) return err('OUT_OF_RANGE', `${action}.${field} 不能小于 ${rule.min}`, field);
			if (rule.max !== undefined && n > rule.max) return err('OUT_OF_RANGE', `${action}.${field} 不能大于 ${rule.max}`, field);
			return { ok: true, value: n };
		}
		case 'string': {
			const s = String(raw);
			if (rule.maxLength && s.length > rule.maxLength) {
				return err('TOO_LONG', `${action}.${field} 超过 ${rule.maxLength} 字符`, field);
			}
			return { ok: true, value: s };
		}
		case 'letter': {
			const s = String(raw).trim().toUpperCase();
			if (!/^[A-F]$/.test(s)) return err('BAD_LETTER', `${action}.${field} 必须是 A-F`, field);
			return { ok: true, value: s };
		}
		case 'key': {
			const s = String(raw).trim().toLowerCase();
			if (!ALLOWED_KEYS.has(s)) {
				return err('BAD_KEY', `不支持的按键 ${s}（可用: ${[...ALLOWED_KEYS].join('/')}）`, field);
			}
			return { ok: true, value: s };
		}
		case 'role': {
			const s = String(raw).trim();
			if (!/^[a-z_]{2,20}$/.test(s)) return err('BAD_ROLE', `${action}.${field} 角色名不合法`, field);
			return { ok: true, value: s };
		}
		default:
			return err('BAD_RULE', `内部错误：未知规格 ${rule.type}`, field);
	}
}

/**
 * 批量校验一串动作。任一条失败即整体拒绝 ——
 * 半执行的动作序列比完全不执行更难排查。
 */
export function validateSequence(list, ctx = {}) {
	if (!Array.isArray(list)) return err('INVALID_SEQUENCE', '动作序列必须是数组');
	if (list.length === 0) return err('EMPTY_SEQUENCE', '动作序列为空');
	if (list.length > 50) return err('SEQUENCE_TOO_LONG', '单轮动作不能超过 50 条');

	const out = [];
	for (let i = 0; i < list.length; i++) {
		const r = validateAction(list[i], ctx);
		if (!r.ok) {
			return err(r.error.code, `第 ${i + 1} 条：${r.error.message}`, r.error.field);
		}
		out.push(r.envelope);
	}
	return { ok: true, actions: out };
}

/** 是否需要护栏显式许可才能执行。 */
export function requiresApproval(envelope) {
	return ACTIONS[envelope?.action]?.risk === 'high';
}

function err(code, message, field) {
	return { ok: false, error: { code, message, ...(field ? { field } : {}) } };
}

function clampInt(v, min, max, fallback) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}
