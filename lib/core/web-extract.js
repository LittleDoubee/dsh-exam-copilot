// 网页通道的结构化抽取：不认识任何平台，只按通用 DOM 结构找「题干 + 选项 + 控件」。
//
// 分两半：
//   collectPage()   —— 在页面里执行（经 CDP Runtime.evaluate 注入），只读，返回原始结构数据
//   buildQuestion() —— 纯函数，零 ctx，可脱离浏览器单测：配对、判题型、自洽校验
//
// 选项正文与作答控件可能不在一起（正文是一组 <p>，控件在底部作答栏只带字母），
// 所以两路分别收集，再按字母配对。

/** 选项头：A. / A、/ A， / A: / (A) / （A）/ A．  —— 字母后必须有分隔符，避免误认 "A股" */
// 括号包裹时括号本身就是分隔符，后面不必再跟标点
export const RE_OPTION_HEAD = /^\s*(?:[（(]\s*([A-Ha-h])\s*[)）]|([A-Ha-h])\s*[.．、，,:：])\s*/;

/** 题型文案归一化：返回 single | multi | judge | ''（只作辅助，主判据是控件类型） */
export function normalizeQType(text) {
	const t = String(text ?? '');
	if (/不定项|多项选择|多选|multiple/i.test(t)) return 'multi';
	if (/判断|是非|true\s*or\s*false/i.test(t)) return 'judge';
	if (/单项选择|单选|single/i.test(t)) return 'single';
	return '';
}

/** 题号：第N题 / N/M / N、 */
export function parseProgress(text) {
	const t = String(text ?? '');
	let m = t.match(/(\d+)\s*\/\s*(\d+)/);
	if (m) return { index: Number(m[1]), total: Number(m[2]) };
	m = t.match(/第\s*(\d+)\s*题/);
	if (m) return { index: Number(m[1]), total: null };
	return null;
}

/**
 * 在页面内执行的只读采集脚本。用 Function#toString 注入，因此不得引用模块内任何外部变量。
 * @returns {{ url, controlGroups, textGroups, headings, progressTexts }}
 */
export function collectPage() {
	const HEAD = /^\s*(?:[（(]\s*([A-Ha-h])\s*[)）]|([A-Ha-h])\s*[.．、，,:：])\s*/;
	const vis = (el) => {
		if (!el || !el.getBoundingClientRect) return false;
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return false;
		const cs = getComputedStyle(el);
		return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
	};
	const rect = (el) => {
		const r = el.getBoundingClientRect();
		return { x: r.left, y: r.top, w: r.width, h: r.height };
	};
	// 被浮层盖住：中心点命中的不是自身或其祖先/后代
	const covered = (el) => {
		const r = el.getBoundingClientRect();
		const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		if (!hit) return true;
		return !(el === hit || el.contains(hit) || hit.contains(el) || (el.closest('label,span') || el).contains(hit));
	};
	const txt = (el) => (el.innerText ?? el.textContent ?? '').replace(/\u00a0/g, ' ').trim();

	// ① 控件组：按 name 分组；无 name 的按父节点分组
	const groups = new Map();
	for (const el of document.querySelectorAll('input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]')) {
		const type = (el.type || el.getAttribute('role') || '').toLowerCase();
		const key = el.name || `__p${Array.prototype.indexOf.call(document.querySelectorAll('*'), el.parentElement?.parentElement)}`;
		const holder = el.closest('label') || el.parentElement;
		let letter = String(el.value ?? '').trim();
		if (!/^[A-Ha-h]$/.test(letter)) {
			const m = txt(holder).match(/^([A-Ha-h])\b/) || txt(holder).match(HEAD);
			letter = m ? (m[1] || m[2] || '') : '';
		}
		if (!groups.has(key)) groups.set(key, { name: el.name || '', type, controls: [] });
		groups.get(key).controls.push({
			letter: letter.toUpperCase(),
			label: txt(holder).slice(0, 200),
			checked: !!el.checked || el.getAttribute('aria-checked') === 'true',
			visible: vis(holder),
			covered: vis(holder) ? covered(el) : false,
			rect: vis(holder) ? rect(holder) : null,
		});
	}

	// ② 选项正文组：同一父节点下，≥2 个直接子元素以选项头开头
	const textGroups = [];
	const seen = new Set();
	for (const el of document.querySelectorAll('p,div,li,span,label,td')) {
		const parent = el.parentElement;
		if (!parent || seen.has(parent)) continue;
		const kids = Array.from(parent.children).filter((k) => HEAD.test(txt(k)) && txt(k).length < 1000);
		if (kids.length < 2) continue;
		seen.add(parent);
		// 题干：父节点之前、同一题容器里的文本块（向上最多 3 层找前序兄弟）
		let stem = '';
		let node = parent;
		for (let d = 0; d < 3 && node && !stem; d++) {
			let sib = node.previousElementSibling;
			while (sib && !stem) {
				const s = txt(sib);
				if (s.length >= 6) stem = s;
				sib = sib.previousElementSibling;
			}
			node = node.parentElement;
		}
		textGroups.push({
			visible: vis(parent),
			rect: vis(parent) ? rect(parent) : null,
			stem: stem.slice(0, 2000),
			items: kids.map((k) => ({ text: txt(k).slice(0, 1000), visible: vis(k), rect: vis(k) ? rect(k) : null })),
		});
	}

	// ③ 题型/题号候选文本（短文本、可见）
	const headings = [];
	const progressTexts = [];
	for (const el of document.querySelectorAll('p,div,span,h1,h2,h3,h4,li')) {
		if (el.children.length > 2) continue;
		const s = txt(el);
		if (!s || s.length > 80 || !vis(el)) continue;
		if (/选择题|判断题|不定项|单选|多选/.test(s)) headings.push({ text: s, y: el.getBoundingClientRect().top });
		if (/第\s*\d+\s*题|^\s*\d+\s*\/\s*\d+\s*$/.test(s)) progressTexts.push(s);
	}

	// 题号导航格子（"1*" "6?" "10"）的最大值，作为总题数的估计
	let navMax = 0;
	for (const el of document.querySelectorAll('div,li,span,a,button')) {
		if (!vis(el)) continue;
		const m = txt(el).match(/^(\d{1,3})\s*[*?？]?$/);
		if (m) navMax = Math.max(navMax, Number(m[1]));
	}


	// 视口左上角在屏幕上的位置（CSS 像素）。浏览器边框按左右对称估算，顶部差值即标签栏+地址栏高度。
	// 这是近似值：缩放、侧边栏、开发者工具停靠都会让它偏，需由屏幕侧抽查兜底。
	const border = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
	const origin = {
		x: window.screenX + border,
		y: window.screenY + Math.max(0, window.outerHeight - window.innerHeight - border),
	};
	return { url: location.href, dpr: window.devicePixelRatio || 1, origin, navMax, controlGroups: Array.from(groups.values()), textGroups, headings, progressTexts };
}

/**
 * 视口内矩形中心 → 屏幕物理像素。
 * 前提：页面缩放 100%，浏览器所在显示器的缩放与 devicePixelRatio 一致。
 * @returns {{sx:number, sy:number} | {}}
 */
export function toScreenPoint(rect, raw) {
	if (!rect || !raw?.origin) return {};
	const dpr = raw.dpr || 1;
	return {
		sx: Math.round((raw.origin.x + rect.x + rect.w / 2) * dpr),
		sy: Math.round((raw.origin.y + rect.y + rect.h / 2) * dpr),
	};
}

/** 去掉选项头，返回 { letter, body } */
function splitHead(text) {
	const m = String(text ?? '').match(RE_OPTION_HEAD);
	if (!m) return null;
	return { letter: (m[1] || m[2]).toUpperCase(), body: String(text).slice(m[0].length).trim() };
}

function lettersContiguous(letters) {
	return letters.every((l, i) => l === String.fromCharCode(65 + i));
}

/**
 * 由 collectPage() 的原始数据组装当前题。
 * @returns {{ ok:boolean, reasons:string[], question?:object }}
 */
export function buildQuestion(raw) {
	const reasons = [];
	if (!raw) return { ok: false, reasons: ['无采集数据'] };

	// 选项组：控件 ≥2、全部带字母（过滤掉「标记」这类单个 checkbox）
	const optionGroups = (raw.controlGroups ?? []).filter(
		(g) => g.controls.length >= 2 && g.controls.every((c) => /^[A-H]$/.test(c.letter)),
	);
	const visibleGroups = optionGroups.filter((g) => g.controls.some((c) => c.visible));
	if (visibleGroups.length === 0) reasons.push('没有可见的选项控件组');
	if (visibleGroups.length > 1) reasons.push(`可见选项控件组有 ${visibleGroups.length} 个，无法确定当前题`);

	const tg = (raw.textGroups ?? []).filter((g) => g.visible);
	// 正文组优先取与控件数量一致的
	const ctrl = visibleGroups[0];
	const textGroup = (ctrl && tg.find((g) => g.items.length === ctrl.controls.length)) || tg[0];

	let options = [];
	if (textGroup) {
		options = textGroup.items.map((it) => {
			const h = splitHead(it.text);
			return h ? { letter: h.letter, text: h.body, rect: it.rect } : null;
		}).filter(Boolean);
	} else if (ctrl && ctrl.controls.every((c) => c.label.replace(/^[A-H]\s*[.．、，,:：]?\s*/, '').length > 1)) {
		// 控件自带正文（label 里就是完整选项）
		options = ctrl.controls.map((c) => ({ letter: c.letter, text: c.label.replace(/^[A-H]\s*[.．、，,:：]?\s*/, '').trim(), rect: c.rect }));
	}
	if (options.length < 2) reasons.push('选项正文不足 2 个');
	if (!lettersContiguous(options.map((o) => o.letter))) reasons.push('选项字母不连续');

	// 配对：每个选项必须有同字母的可点击控件
	if (ctrl) {
		const byLetter = new Map(ctrl.controls.map((c) => [c.letter, c]));
		for (const o of options) {
			const c = byLetter.get(o.letter);
			if (!c) reasons.push(`选项 ${o.letter} 没有对应控件`);
			else {
				o.click = c.rect;
				if (c.covered) reasons.push(`选项 ${o.letter} 的控件被遮挡`);
			}
		}
		if (ctrl.controls.length !== options.length) reasons.push(`控件 ${ctrl.controls.length} 个，正文 ${options.length} 个`);
	}

	// 题型：控件类型为主，文案为辅
	let qtype = '';
	if (ctrl) qtype = ctrl.type.includes('checkbox') ? 'multi' : 'single';
	if (qtype === 'single' && options.length === 2 && options.every((o) => /^(对|错|正确|错误|是|否|√|×)$/.test(o.text))) qtype = 'judge';
	// 题型文案只取「题目正文上方、离它最近」的一条；含换行的是导航分组（标题 + 题号格子），排除
	const topY = textGroup?.rect?.y ?? Infinity;
	const hintTypes = (raw.headings ?? [])
		.filter((h) => !/\n/.test(h.text) && (h.y ?? -Infinity) <= topY)
		// 分段说明（"二、多项选择题。每题…"）比导航里的短标题更可信：先按长度分档，再按距离
		.sort((a, b) => (b.text.length > 8) - (a.text.length > 8) || (b.y ?? 0) - (a.y ?? 0))
		.map((h) => normalizeQType(h.text))
		.filter(Boolean);
	const hint = hintTypes.find((t) => t === qtype) ?? '';
	if (!qtype && hintTypes.length) qtype = hintTypes[0];

	const stem = (textGroup?.stem ?? '').trim();
	if (stem.length < 4) reasons.push('题干为空或过短');

	const progress = (raw.progressTexts ?? []).map(parseProgress).find(Boolean) ?? null;

	const question = {
		source: 'dom-struct',
		stem,
		// sx/sy 与 OCR 解析器同义：点击点的屏幕物理像素坐标
		opts: options.map((o) => ({ letter: o.letter, text: o.text, click: o.click ?? null, ...toScreenPoint(o.click, raw) })),
		qtype,
		qtypeHintAgrees: !!hint,
		// 与 OCR 解析器同形：[当前, 总数]。页面没写总数时用题号导航的最大值；都没有则为 null
		prog: progress && (progress.total || raw.navMax) ? [progress.index, progress.total || raw.navMax] : null,
		questionKey: ctrl?.name || null,
		dpr: raw.dpr ?? 1,
	};
	return { ok: reasons.length === 0, reasons, question };
}
