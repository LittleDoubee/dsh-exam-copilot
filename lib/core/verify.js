// 每步验证：动作执行后必须确认"真的发生了"，否则不能继续下一步。
//
// 为什么这是必需的（不是锦上添花）：
//   全自动答题一旦点错/点空/卡在弹窗，会连锁污染后面所有题。
//   宁可 3 次重试后停下等人，也不要"看起来在跑"地一路错下去。
//
// 判据来源（已实测，别改回去）：
//   翻页必须用 progress 区 OCR 读题号（"4/72"），不能用像素哈希 ——
//   点选答案会让选项变绿，整块哈希跟着变，会被误判成翻页成功。
//
// 零 ctx：判据只吃 observation 对象，可纯单测。

/** 期望类型与默认容差。 */
export const EXPECT_KINDS = {
	page_changed: '题号变化（OCR 读 progress 区）',
	option_checked: '选项出现选中态（颜色采样）',
	text_inserted: '文本确实被输入（OCR 包含预期片段）',
	any_change: '区域内出现任何可见变化',
	dom_changed: '目标元素的文本/选中态变化（web 通道）',
};

/**
 * 判断观察是否满足期望。
 *
 * @param {object} expect  { page_changed?:true, option_checked?:true, ... }
 * @param {object} obs     由通道提供的一次观察快照
 *   {
 *     progressBefore?: [number, number] | null,
 *     progressAfter?:  [number, number] | null,
 *     hashBefore?: string, hashAfter?: string,
 *     checkedLetters?: string[],      // 通道检测到的已选中字母
 *     expectedText?: string,          // 期望被输入的文本
 *     actualText?: string,            // 实际读到的文本
 *     domBefore?: string, domAfter?: string,
 *   }
 * @returns {{ satisfied:boolean, reason:string, checks:Array<{name,ok,detail}> }}
 */
export function checkExpect(expect, obs = {}) {
	const checks = [];
	if (!expect || typeof expect !== 'object' || Object.keys(expect).length === 0) {
		return { satisfied: true, reason: '无期望（动作本身即结果）', checks: [{ name: 'none', ok: true, detail: '' }] };
	}

	// 显式优先级：题号变化最可靠，先判它
	if (expect.page_changed) {
		const before = obs.progressBefore;
		const after = obs.progressAfter;
		if (!before || !after) {
			checks.push({ name: 'page_changed', ok: false, detail: '读不到题号（progress 区未设置或 OCR 失败）' });
		} else if (before[0] === after[0] && before[1] === after[1]) {
			checks.push({ name: 'page_changed', ok: false, detail: `题号未变: ${before.join('/')}` });
		} else {
			checks.push({ name: 'page_changed', ok: true, detail: `${before.join('/')} → ${after.join('/')}` });
		}
	}

	if (expect.option_checked) {
		const checked = Array.isArray(obs.checkedLetters) ? obs.checkedLetters : null;
		if (checked === null) {
			checks.push({ name: 'option_checked', ok: false, detail: '通道未提供选中态' });
		} else if (checked.length === 0) {
			checks.push({ name: 'option_checked', ok: false, detail: '没有任何选项处于选中态' });
		} else {
			checks.push({ name: 'option_checked', ok: true, detail: `已选中: ${checked.join('')}` });
		}
	}

	if (expect.text_inserted) {
		const want = String(obs.expectedText ?? '').trim();
		const got = String(obs.actualText ?? '');
		if (!want) {
			checks.push({ name: 'text_inserted', ok: false, detail: '未提供期望文本，无法验证' });
		} else if (got.includes(want)) {
			checks.push({ name: 'text_inserted', ok: true, detail: '文本匹配' });
		} else {
			checks.push({
				name: 'text_inserted',
				ok: false,
				detail: `期望包含「${want.slice(0, 30)}」，实际「${got.slice(0, 30)}」`,
			});
		}
	}

	if (expect.any_change) {
		if (!obs.hashBefore || !obs.hashAfter) {
			checks.push({ name: 'any_change', ok: false, detail: '缺少前后哈希' });
		} else if (obs.hashBefore === obs.hashAfter) {
			checks.push({ name: 'any_change', ok: false, detail: '画面无变化' });
		} else {
			checks.push({ name: 'any_change', ok: true, detail: '画面有变化' });
		}
	}

	if (expect.dom_changed) {
		const a = obs.domBefore;
		const b = obs.domAfter;
		if (a === undefined || b === undefined) {
			checks.push({ name: 'dom_changed', ok: false, detail: '缺少 DOM 前后值' });
		} else if (a === b) {
			checks.push({ name: 'dom_changed', ok: false, detail: 'DOM 无变化' });
		} else {
			checks.push({ name: 'dom_changed', ok: true, detail: 'DOM 有变化' });
		}
	}

	const failed = checks.filter((c) => !c.ok);
	return {
		satisfied: failed.length === 0,
		reason: failed.length === 0 ? checks.map((c) => c.detail).filter(Boolean).join('；') : failed.map((c) => c.detail).join('；'),
		checks,
	};
}

/**
 * 重试策略：什么样的失败值得重试。
 *
 * 经验规则：
 *   - 读不到数据（OCR 空、哈希缺失）→ 重试（可能是渲染还没完成）
 *   - 明确判定"没变"（题号相同、画面相同）→ 重试（可能点击没生效）
 *   - 判定成功 → 不重试
 *   有上限，超了就转人工，不无限重试。
 */
export const DEFAULT_RETRY = { maxAttempts: 3, backoffMs: [150, 400, 900] };

export function shouldRetry(verdict, attempt, policy = DEFAULT_RETRY) {
	if (verdict?.satisfied) return false;
	return attempt < policy.maxAttempts;
}

export function backoffFor(attempt, policy = DEFAULT_RETRY) {
	const arr = policy.backoffMs ?? [];
	if (arr.length === 0) return 200;
	return arr[Math.min(attempt, arr.length - 1)];
}

/**
 * 翻页验证的专用判定（最常用路径，单独抽出便于单测）。
 * 题目序号必须真的前进；倒退或不动都算失败。
 */
export function pageAdvanced(before, after) {
	if (!Array.isArray(before) || !Array.isArray(after)) return { ok: false, reason: '题号不可读' };
	const [b, bt] = before;
	const [a, at] = after;
	if (bt !== at) return { ok: true, reason: `总题数变化 ${bt} → ${at}` };
	if (a === b) return { ok: false, reason: `题号未变 ${b}/${bt}` };
	if (a < b) return { ok: false, reason: `题号倒退 ${b} → ${a}` };
	return { ok: true, reason: `${b}/${bt} → ${a}/${at}` };
}

/**
 * 题目完整性检查 —— 长题被截断时的最后一道防线。
 *
 * 为什么必须有（）：
 *   长题只能看到半截时，解析器会看到 A、B 两个连续选项，
 *   **不会报错**，它会以为"这题就两个选项"，然后按这个错误假设继续作答。
 *   这比直接失败糟得多 —— 静默的错误会一路污染后面的题。
 *
 * 判据（与 scroll_v2 的实测经验一致，但这里做成纯函数便于单测）：
 *   * 无选项
 *   * 字母断号（A、C 但缺 B）
 *   * 选项数不足（按题型推断下限）
 *   * 题干末尾是连接词（说明话没说完）
 *
 * @returns {{complete:boolean, reasons:string[], suggestScroll:boolean}}
 */
export function checkQuestionComplete(parsed) {
	const reasons = [];
	if (!parsed) return { complete: false, reasons: ['解析结果为空'], suggestScroll: true };

	const opts = Array.isArray(parsed.opts) ? parsed.opts : [];
	const letters = opts.map((o) => String(o.letter ?? '').toUpperCase());
	const qtype = String(parsed.qtype ?? '');
	const stem = String(parsed.stem ?? '').trim();

	// 1. 完全没有选项
	if (opts.length === 0) {
		reasons.push('没有选项');
	}

	// 1.5 引擎报告「有字母被跳过」——这是最危险的一种，必须拦。
	//
	// 图形题 Q5）：Windows OCR 整行漏掉 "C成本核算"，
	// 解析器旧实现**静默丢弃**了因之失配的 D，又把 "D市场推广" 当续行
	// 拼进 B 的正文。最终 opts = [A, B(排版十D市场推广)] ——
	// 字母 A,B 连续、数量 2，下面所有判据都不会响，题目被当成完整，
	// 然后按 A/B 静默答错。
	// 引擎现在把跳过的字母放在 _letter_gap 里，这里必须比字母连续性
	// 更优先地检查它。
	const gap = Array.isArray(parsed._letter_gap) ? parsed._letter_gap : [];
	if (gap.length > 0) {
		reasons.push(`选项字母被跳过（${gap.join(',')}），OCR 可能漏行`);
	}

	// 2. 字母断号：A,B,D 缺 C
	if (letters.length > 0) {
		for (let i = 0; i < letters.length; i++) {
			const expect = String.fromCharCode(65 + i);
			if (letters[i] !== expect) {
				reasons.push(`选项字母断号：期望 ${expect}，实际 ${letters[i]}`);
				break;
			}
		}
	}

	// 3. 选项数不足（按题型下限）
	const minByType = { 单选: 3, 多选: 3, 判断: 2 };
	for (const [key, min] of Object.entries(minByType)) {
		if (qtype.includes(key) && opts.length > 0 && opts.length < min) {
			reasons.push(`${qtype}至少 ${min} 个选项，只有 ${opts.length} 个`);
			break;
		}
	}
	// 题型未知但有选项时，单选风格的题至少该有 2 个才有意义
	if (!qtype && opts.length === 1) {
		reasons.push('只有 1 个选项，题目可能被截断');
	}

	// 4. 题干未完结：末尾是连接词/引导词
	// 覆盖实测见过的形态：的、和、或、在、包括、下列、以下、关于…（话没说完）
	if (stem && /[的、和或与及在从关于对]?$/.test(stem) && /[的、和或与及在从关于对包列]$/.test(stem)) {
		reasons.push(`题干疑似未完结（末尾「${stem.slice(-1)}」）`);
	}
	if (stem && /(包括|下列|以下|如下|是指|关于)$/.test(stem)) {
		reasons.push('题干疑似未完结（末尾是引导词）');
	}

	// 5. 有选项但选项文字为空（只识别到字母，正文没读到）
	if (opts.length > 0 && opts.every((o) => !String(o.text ?? '').trim())) {
		reasons.push('选项只有字母没有正文');
	}

	const complete = reasons.length === 0;
	return {
		complete,
		reasons,
		// 缺选项/断号/字母被跳过 → 值得滚动试试；题干未完结也值得滚
		suggestScroll:
			!complete &&
			(opts.length < 3 ||
				gap.length > 0 ||
				reasons.some((r) => r.includes('断号') || r.includes('跳过') || r.includes('未完结') || r.includes('没有选项'))),
	};
}
