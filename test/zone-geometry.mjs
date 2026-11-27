/**
 * 从浏览器 DOM 几何推算 profile 区域坐标（屏幕物理像素）。
 *
 * 为什么需要它：
 *   mock 页的 .exam 是 `max-width:960px; margin:28px auto` —— **水平居中**。
 *   窗口宽度一变，页面在屏幕上的 x 就整体平移（实测从 153 漂到 473，差 320px）。
 *   手算 `窗口原点 + DOM 坐标` 只要漏掉"居中"这一项，全部区域都会偏，
 *   而现象是"OCR 读到别处的字"，极容易被误判成 OCR 不准 —— 白查很久。
 *
 * 所以坐标一律由这个脚本产出，不再手算。
 *
 * 换算公式：
 *   屏幕X = window.screenX + 边框宽 + DOM.x
 *   屏幕Y = window.screenY + 工具栏高 + DOM.y
 * 其中「边框宽/工具栏高」= Chrome 的客户区偏移，由
 *   (outerW - innerW) / 2            → 左右各一半边框
 *   outerH - innerH                  → 标题栏 + 地址栏 + 底边
 * 经验值：Windows Chrome 的顶部 chrome 约等于 outerH-innerH（含底边可忽略）。
 */

/** Chrome 客户区偏移（经验值，实测校准）。 */
export function chromeInsets(dom) {
	const borderX = Math.round((dom.outerW - dom.innerW) / 2);
	const chromeY = dom.outerH - dom.innerH;
	return { borderX, chromeY };
}

/**
 * 把 DOM 里的一个矩形换算成屏幕物理像素。
 * @param {object} dom   由 collectDomGeometry() 得到的几何
 * @param {{x:number,y:number,w:number,h:number}} rect DOM 坐标（CSS 像素，相对 viewport）
 */
export function toScreen(dom, rect) {
	const { borderX, chromeY } = chromeInsets(dom);
	const k = dom.dpr || 1;
	return [
		Math.round((dom.screenX + borderX + rect.x) * k),
		Math.round((dom.screenY + chromeY + rect.y) * k),
		Math.round(rect.w * k),
		Math.round(rect.h * k),
	];
}

/** 与 mock/index.html 的 DOM 结构一一对应。改 mock 页要同步改这里。 */
export const MOCK_SELECTORS = {
	all: '#qbody',
	progress: '#prog',
	next: '#next',
	submit: '#submit',
	timer: '#timer',
};

/** 区域外扩量：OCR 对"贴边"的文字识别率明显下降，题号尤其明显。 */
export const PADDING = {
	all: 0,
	progress: 26, // 题号字太小，必须留白；实测 28x22 读不出，向外扩到 ~110x70 才稳
	next: 0,
	submit: 0,
	timer: 0,
};

/** 生成可直接写进 profile 的 zones 数组。 */
export function buildZones(dom, domRects) {
	const zones = [];
	for (const [role, sel] of Object.entries(MOCK_SELECTORS)) {
		const rect = domRects[sel];
		if (!rect) continue;
		const pad = PADDING[role] ?? 0;
		const padded = {
			x: rect.x - pad,
			y: rect.y - pad,
			w: rect.w + pad * 2,
			h: rect.h + pad * 2,
		};
		const [x, y, w, h] = toScreen(dom, padded);
		zones.push({ role, x, y, w, h });
	}
	return zones;
}
