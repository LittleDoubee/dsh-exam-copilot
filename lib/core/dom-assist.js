// 浏览器 DOM 通道：在 OCR 读不准时提供“高精度更正”。
//
// 为什么是「补精度」而不是「替代 OCR」：
//   ① 网页考试常有弹窗、广告、浮层。纯 DOM 取文本会被这些杂项污染
//      （或者要写一堆选择器规则，每个平台一套，永远追不上）。
//   ② OCR 是通用的：什么界面都能看一眼，不需要知道 DOM 结构。
//   ③ 于是正确分工是：
//        OCR 打底  → 永远先跑，拿到"大概是什么题"
//        DOM 纠正  → 只在 OCR 结果可疑时，用它把题干/选项/答案对齐到真实文本
//
// 触发条件（都不满足就不调 DOM，省时间）：
//   · 解析出的题目不完整（缺题干/缺选项/选项数不合理）
//   · 题干或选项含明显的 OCR 噪声（乱码字符、单字符选项、重复标点）
//   · 配置里显式开启 domAssist
//
// 安全：本模块**不碰账号密码**。它只连「用户自己已经打开、且开了调试端口」
// 的浏览器，或者完全不做——绝不自己去登录取 cookie。

/** 常见 OCR 噪声：这些字符出现在题干里基本可以判定识别错了。 */
const NOISE_RE = /[|¦│┃_＿]{2,}|[\uFFFD]|[ｱ-ﾝ]{2,}/;

/**
 * 判断 OCR 结果是否"可疑到值得用 DOM 纠正"。
 *
 * 为什么用启发式而不是"全部都用 DOM"：
 *   全用 DOM 就要连浏览器，而连浏览器要登录态、要开调试端口，
 *   每一步都是用户成本。只在真正需要时才要求，用户才愿意开。
 *
 * @returns {{ need: boolean, reasons: string[] }}
 */
export function shouldUseDom(question, { threshold = 0.8 } = {}) {
	const reasons = [];
	const opts = question?.opts ?? [];
	const stem = String(question?.stem ?? '');

	// 1) 没题干 / 题干过短
	if (!stem.trim()) reasons.push('题干为空');
	else if (stem.trim().length < 4) reasons.push('题干过短');

	// 2) 没有选项（选择题必然有选项；判断题会在别处处理）
	if (opts.length === 0) reasons.push('没有选项');

	// 3) 选项文字异常：单个字符、或全是符号
	if (opts.length > 0) {
		const bad = opts.filter((o) => {
			const t = String(o.text ?? '').trim();
			return t.length <= 1 || !/[\u4e00-\u9fa5A-Za-z0-9]/.test(t);
		});
		if (bad.length >= Math.ceil(opts.length / 2)) reasons.push('选项文字异常');
	}

	// 4) 明显噪声字符
	if (NOISE_RE.test(stem)) reasons.push('题干含噪声字符');

	// 5) 题目被判不完整
	if (question?._complete === false) reasons.push('题目不完整');

	// 6) 解析置信度不足
	const conf = Number(question?.confidence);
	if (Number.isFinite(conf) && conf < threshold) reasons.push('解析置信度低');

	return { need: reasons.length > 0, reasons };
}

/**
 * 从页面 DOM 里提取题目候选。
 *
 * 这是**纯函数**：传入已经拿到的文本行数组，不负责连接浏览器。
 * 这样可以在没有浏览器的环境里单测，也方便以后换别的取文本方式。
 *
 * 策略：不过度猜测 DOM 结构，而是把页面上的文本按行收集，
 * 交给与 OCR 相同的解析器（importer 的 splitTextIntoItems）处理。
 * 好处：一个解析器、两路输入，行为一致，不会出现"DOM 解出来和 OCR 解出来不一样"。
 *
 * @param {string[]} lines 页面文本行
 * @param {object} question  当前 OCR 得到的题目（用于对齐）
 * @returns {{ stem, options:[{letter,text}], qtype, source:'dom' } | null}
 */
export function pickQuestionFromLines(lines, question = {}) {
	if (!Array.isArray(lines) || lines.length === 0) return null;

	// 找"和当前题干最像"的那一行作为锚点。
	// 为什么要对齐而不是直接取第一段：页面上还有导航、广告、按钮文案。
	const target = String(question?.stem ?? '').trim();
	let anchor = -1;

	if (target) {
		const norm = (s) => String(s).replace(/[\s\u3000]/g, '').replace(/[，,。.；;：:！!？?、（）()【】[\]]/g, '');
		const t = norm(target);
		// 取前 10 个字符做匹配（OCR 常错在尾部，头部相对可靠）
		const head = t.slice(0, 10);
		if (head.length >= 4) {
			for (let i = 0; i < lines.length; i++) {
				if (norm(lines[i]).includes(head)) {
					anchor = i;
					break;
				}
			}
		}
	}

	// 没找到锚点：不猜，返回 null 让调用方继续用 OCR 结果。
	// 宁可少救一次，也不要把广告文案当成题干。
	if (anchor < 0) return null;

	const stem = String(lines[anchor]).trim();
	if (!stem) return null;

	// 锚点之后收集选项行。遇到下一个"题号行"就停 —— 那是下一题。
	const RE_NEXT_Q = /^\s*(?:第\s*)?\d{1,4}\s*[.、．)）:：]/;
	const options = [];
	for (let i = anchor + 1; i < lines.length && options.length < 8; i++) {
		const line = String(lines[i]).trim();
		if (!line) continue;
		if (RE_NEXT_Q.test(line)) break; // 到下一题了
		// 选项：A. / A、/ A) / (A) —— 与 importer 的 RE_OPTION 保持一致
		const m = line.match(/^\s*[（(]?\s*([A-Ha-h])\s*[.、．)）]\s*(.*)$/);
		if (m) {
			options.push({ letter: m[1].toUpperCase(), text: (m[2] ?? '').trim() });
		} else if (options.length > 0) {
			// 选项续行
			const last = options[options.length - 1];
			last.text = (last.text + ' ' + line).trim();
		}
	}

	if (options.length === 0) return null;

	return {
		stem,
		options,
		qtype: question?.qtype ?? '',
		source: 'dom',
	};
}

/**
 * 把 DOM 结果与 OCR 结果合并。
 *
 * 合并原则（按证据强度）：
 *   题干——DOM 优先（DOM 是真实文本，OCR 是"看图猜字"，同位置时 DOM 更可信）
 *   选项——两边都留，取**更多**的那份（OCR 可能漏选项，DOM 可能被浮层干扰）
 *   答案——不由 DOM 决定（页面上通常没有答案），保留原值
 *
 * @returns {object} 合并后的题目
 */
export function mergeDomResult(ocrQuestion, domQuestion) {
	if (!domQuestion) return ocrQuestion;
	if (!ocrQuestion) return domQuestion;

	const ocrOpts = ocrQuestion.opts ?? [];
	const domOpts = domQuestion.options ?? domQuestion.opts ?? [];

	// 选项取更多的那份；数量相同则用 DOM（文本更准）
	const useDomOpts = domOpts.length >= ocrOpts.length;
	const mergedOpts = useDomOpts ? domOpts : ocrOpts;

	return {
		...ocrQuestion,
		stem: domQuestion.stem || ocrQuestion.stem,
		opts: mergedOpts,
		qtype: ocrQuestion.qtype || domQuestion.qtype,
		// 标记来源，便于面板排查"这题是靠 DOM 救回来的"
		_domAssisted: true,
		_domReason: 'OCR 结果可疑，已用页面 DOM 纠正',
	};
}

/**
 * 生成本地 CDP 连接的探测清单。
 *
 * 为什么需要：用户的浏览器必须**主动开启**远程调试才有端口，
 * 而且默认端口（9222）常被别的工具占用。所以要探测多个位置。
 *
 * 注意：这里只探测，不启动任何程序、不改任何配置。
 */
export const CDP_CANDIDATES = [
	'http://127.0.0.1:9222', // Chrome/Edge 默认调试端口
	'http://127.0.0.1:9223', // 常见备用
	'http://127.0.0.1:9224',
	'http://127.0.0.1:9333', // 部分工具链用
];

/**
 * 从 CDP 的 /json/list 响应里挑出"像考试页面"的标签页。
 *
 * 只做筛选，不导航、不点击。
 */
export function pickExamTab(tabs) {
	if (!Array.isArray(tabs)) return null;
	const pages = tabs.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl);
	if (pages.length === 0) return null;

	// 优先非空白页，再按最后激活时间
	const scored = pages
		.filter((t) => {
			const u = String(t.url ?? '');
			return u && u !== 'about:blank' && !u.startsWith('devtools://');
		})
		.sort((a, b) => (b.lastActiveTime ?? 0) - (a.lastActiveTime ?? 0));

	return scored[0] ?? null;
}
