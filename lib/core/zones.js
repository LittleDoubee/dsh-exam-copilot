// 区域组（Zone Set）：S1 的核心数据结构，替代原 region.json 的单矩形。
//
// 为什么必须换
//   现有 region.json 只有一个矩形，但真实界面至少有 题干/选项/题号/提交 四块，
//   且不同平台布局完全不同。按坐标硬编码 = 换平台必重写。
//   按"语义角色"取值后，换平台只需重画区域，内核代码不动。
//   —— 这是"通用可配置框架"成立的技术前提，不是可选项。

/** 角色的语义与用途。解析与点击都按角色取，不按固定坐标。 */
export const ZONE_ROLES = {
	all: { label: '整块内容区', desc: '一大块内容，不假定里面是什么（题干+选项+图都可能）' },
	question: { label: '题干区', desc: '题目正文所在区域' },
	options: { label: '选项区', desc: 'A/B/C/D 选项所在区域' },
	figure: { label: '图形区', desc: '图片、图表、公式（OCR 无效，需视觉通道）' },
	progress: { label: '题号区', desc: '如 "4/72"，兼作翻页验证依据' },
	next: { label: '下一题按钮', desc: '翻页按钮位置' },
	prev: { label: '上一题按钮', desc: '' },
	submit: { label: '交卷按钮', desc: '高风险，受护栏约束' },
	timer: { label: '倒计时区', desc: '兼作题面区上边界，切掉浏览器 chrome' },
};

export const ROLE_KEYS = Object.keys(ZONE_ROLES);

/** 必需角色：缺了这些，识别链路无法成立。
 *
 *  只要求「有个内容区」—— 满足其一即可：all / question 都算。
 *  不再要求独立的 options 区：很多界面的选项就嵌在题面里，
 * 强行要求会让合法配置校验失败。 */
export const REQUIRED_ROLES = []; // 由校验函数按 CONTENT_ROLES 判断

/** 被视为「内容区」的角色，有其一即可。 */
export const CONTENT_ROLES = ['all', 'question'];

/**
 * 区域校验。返回 { ok, errors[], warnings[] }
 * 宁可启动前报错，也不要运行时点偏 30px。
 */
export function validateZones(zones, display = {}) {
	const errors = [];
	const warnings = [];
	if (!Array.isArray(zones) || zones.length === 0) {
		errors.push('区域组为空');
		return { ok: false, errors, warnings };
	}

	const seen = new Set();
	const dupRoles = [];
	let hasContent = false;
	const screenW = Number(display.w) || 0;
	const screenH = Number(display.h) || 0;

	for (const z of zones) {
		if (!z || typeof z !== 'object') {
			errors.push('区域项不是对象');
			continue;
		}
		if (!ROLE_KEYS.includes(z.role)) {
			errors.push(`未知角色: ${z.role}（可用: ${ROLE_KEYS.join('/')}）`);
			continue;
		}
		if (seen.has(z.role)) {
			// 重复角色是"两个选项块"这类错误的典型症状：
			// 圈完忘记改角色，全都存成同一个。必须明确警告，不能静默忽略。
			dupRoles.push(z.role);
			warnings.push(`角色重复: ${z.role}（只取第一个，其余请在表格里删掉或改角色）`);
		}
		seen.add(z.role);

		for (const k of ['x', 'y', 'w', 'h']) {
			if (!Number.isFinite(Number(z[k]))) errors.push(`${z.role}.${k} 不是数字`);
		}
		if (Number(z.w) <= 0 || Number(z.h) <= 0) errors.push(`${z.role} 宽高必须为正`);
		// 太小几乎必然是误操作
		if (Number(z.w) < 8 || Number(z.h) < 8) warnings.push(`${z.role} 尺寸过小 (${z.w}x${z.h})`);
		if (screenW > 0 && (Number(z.x) + Number(z.w) > screenW + 1)) {
			warnings.push(`${z.role} 超出屏幕右边界`);
		}
		if (screenH > 0 && (Number(z.y) + Number(z.h) > screenH + 1)) {
			warnings.push(`${z.role} 超出屏幕下边界`);
		}
	}

	for (const role of CONTENT_ROLES) {
		if (seen.has(role)) {
			hasContent = true;
			break;
		}
	}
	if (!hasContent) {
		errors.push(`缺少内容区：至少要有 ${CONTENT_ROLES.join(' 或 ')} 之一`);
	}
	// 题号区缺失时无法可靠验证翻页 —— 提醒但不拦（有的界面确实没有题号）
	if (!seen.has('progress')) {
		warnings.push('未设置 progress 区：翻页验证将退化为区域哈希比对，可靠性下降');
	}
	return { ok: errors.length === 0, errors, warnings };
}

/** 按角色取区域，忽略重复项（先出现的优先）。 */
export function zonesByRole(zones) {
	const map = {};
	for (const z of Array.isArray(zones) ? zones : []) {
		if (!z?.role || map[z.role]) continue;
		map[z.role] = { x: Number(z.x), y: Number(z.y), w: Number(z.w), h: Number(z.h) };
	}
	return map;
}

/**
 * 把区域裁切到屏幕内。
 * 多显示器 + DPI 缩放下，用户圈选可能越过主屏边界，必须裁。
 */
export function clampZone(z, display) {
	const w = Number(display?.w) || 1e9;
	const h = Number(display?.h) || 1e9;
	const x = Math.max(0, Math.min(Number(z.x) || 0, w - 1));
	const y = Math.max(0, Math.min(Number(z.y) || 0, h - 1));
	return {
		...z,
		x,
		y,
		w: Math.max(1, Math.min(Number(z.w) || 1, w - x)),
		h: Math.max(1, Math.min(Number(z.h) || 1, h - y)),
	};
}

/* ── 窗口相对坐标 ─────────────────────────────────────
 *
 * 区域坐标以屏幕绝对像素存储时，窗口一移动或缩放就失效。
 * 这里引入可选的 rel 字段：相对目标窗口客户区的比例 (0..1)。
 * 有 rel 且给了当前窗口矩形时，按 rel 解析出绝对坐标；否则沿用 x/y/w/h，
 * 所以老配置无需任何改动即可继续工作。
 */

/** 区域来源。manual 优先级最高，自动结果不得覆盖手动结果。 */
export const ZONE_SOURCES = ['manual', 'template', 'auto', 'legacy'];
// legacy：这个功能上线前存下的区域（没有 source 字段）。分不清是不是人工确认过，
// 所以优先级最低 —— 用户主动点「自动识别」时应被新结果替换，否则旧错框永远赖着不走。
const SOURCE_RANK = { manual: 3, template: 2, auto: 1, legacy: 0 };

function clamp01(v) {
	const n = Number(v);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

/** 绝对坐标 → 相对窗口客户区比例。win = {x,y,w,h}（屏幕坐标下的客户区）。 */
export function toRelative(z, win) {
	const W = Number(win?.w) || 0;
	const H = Number(win?.h) || 0;
	if (W <= 0 || H <= 0) return null;
	return {
		rx: clamp01((Number(z.x) - Number(win.x || 0)) / W),
		ry: clamp01((Number(z.y) - Number(win.y || 0)) / H),
		rw: clamp01(Number(z.w) / W),
		rh: clamp01(Number(z.h) / H),
	};
}

/** 相对比例 → 当前窗口下的绝对坐标（四舍五入到整像素）。 */
export function fromRelative(rel, win) {
	const W = Number(win?.w) || 0;
	const H = Number(win?.h) || 0;
	return {
		x: Math.round(Number(win?.x || 0) + clamp01(rel.rx) * W),
		y: Math.round(Number(win?.y || 0) + clamp01(rel.ry) * H),
		w: Math.max(1, Math.round(clamp01(rel.rw) * W)),
		h: Math.max(1, Math.round(clamp01(rel.rh) * H)),
	};
}

/**
 * 按当前窗口矩形解析区域组为绝对坐标。
 * 没有 win 或区域没有 rel 时原样返回 x/y/w/h —— 与旧行为一致。
 */
export function resolveZones(zones, win) {
	const hasWin = Number(win?.w) > 0 && Number(win?.h) > 0;
	return (Array.isArray(zones) ? zones : []).map((z) => {
		if (!z || typeof z !== 'object') return z;
		if (hasWin && z.rel && typeof z.rel === 'object') return { ...z, ...fromRelative(z.rel, win) };
		return z;
	});
}

/**
 * 老配置迁移：给每个区域补 source（缺省 manual）与 rel（给了窗口矩形时）。
 * 幂等：已有 rel / source 的区域不改。返回新数组，不修改入参。
 */
export function migrateZones(zones, win) {
	return (Array.isArray(zones) ? zones : []).map((z) => {
		if (!z || typeof z !== 'object') return z;
		const out = { ...z };
		if (!ZONE_SOURCES.includes(out.source)) out.source = 'legacy';
		if (!out.rel && win) {
			const rel = toRelative(out, win);
			if (rel) out.rel = rel;
		}
		return out;
	});
}

/**
 * 合并自动检测结果与现有区域：同一角色按来源优先级取高者；
 * 同来源时取 conf 更高者。manual 永远不会被 auto/template 覆盖。
 */
export function mergeDetectedZones(existing, detected) {
	const byRole = new Map();
	const order = [];
	const put = (z) => {
		if (!z?.role) return;
		const cur = byRole.get(z.role);
		if (!cur) {
			byRole.set(z.role, z);
			order.push(z.role);
			return;
		}
		const a = SOURCE_RANK[cur.source] ?? 3;
		const b = SOURCE_RANK[z.source] ?? 3;
		if (b > a || (b === a && Number(z.conf ?? 0) > Number(cur.conf ?? 0))) byRole.set(z.role, z);
	};
	for (const z of Array.isArray(existing) ? existing : []) put({ source: 'manual', ...z });
	for (const z of Array.isArray(detected) ? detected : []) put({ source: 'auto', ...z });
	return order.map((r) => byRole.get(r));
}

/** 生成一个空白 profile，面板"新建"用。 */
export function emptyProfile(id, name = '新建考试配置') {
	return {
		id,
		name,
		channel: 'screen', // 'screen' | 'web'
		display: { index: 0, dpiScale: 1, w: 0, h: 0 },
		// 目标窗口（桌面程序）：标题片段。填了它，区域按窗口相对比例解析，窗口移动/缩放不失效
		window: { title: '' },
		zones: [],
		// 题型规则：不同题型的作答约束
		qtypes: {
			单选: { expect: 'single', minOpts: 3 },
			多选: { expect: 'multi', minOpts: 3 },
			判断: { expect: 'tf', minOpts: 2 },
		},
		// 提示词（操作模型读这一段了解怎么干活）
		prompts: {
			system: '',
			parse: '',
			answer: '',
			act: '',
		},
		answer: {
			useBank: true, // 先用题库
			useModel: true, // 未命中问模型
			multiVote: 0, // 0/1=只答一次；≥2=同一模型并发作答 N 次，答案一致才算高置信
			webSearch: false, // 是否联网查询
			confidenceThreshold: 0.8, // 低于此值转人工
			concurrency: 3,
			maxTokensPerQuestion: 2000,
			maxTotalTokens: 200000,
			maxQuestions: 500,
			allowAutoSubmit: false,
		},
		// 页面推进方式（有的网页是一整页、靠滚动看题，没有"下一页"）
		//   paged  = 一题一页，点「下一题」翻页（默认）
		//   scroll = 一整页多题，只靠滚轮上下滑
		navigation: {
			mode: 'paged', // 'paged' | 'scroll'
			scrollStepPx: 520, // scroll 模式的每次滚动距离
			maxScrollPerQuestion: 6, // 单题最多滚几次（防止无限下滑）
		},
		// 动作映射：角色 → 具体动作参数，平台差异收敛于此
		actions: {
			nextRole: 'next',
			submitRole: 'submit',
			clickIntervalMs: 60,
		},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}
