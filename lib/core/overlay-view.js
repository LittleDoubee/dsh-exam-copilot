// 悬浮窗视图模型：把 Runner 快照翻译成"屏幕上要显示什么"。
//
// 为什么单独成模块（而不是留在 index.js 的闭包里）：
//   这段逻辑有真实的判断分支（暂停原因文案、倒计时配色阈值、答案来源标注），
//   而悬浮窗本身是原生窗口、没法在单测里断言。抽成纯函数后可以脱离
//   宿主、脱离 tkinter 直接测 —— 与 core/ 其它模块同一套约定（零 ctx）。
//
// 安全边界（刻意如此）：
//   只出"题号 / 状态 / 答案 / 剩余时间"。
//   **不放题干原文、不放截图、不放配置项** —— 考试时这块屏幕可能被共享
//   或录制，题干和选项出现在悬浮窗上等于把卷子播出去。

/** 暂停原因 → 人话。用户看不懂 low_confidence 这种内部代号。 */
export const PAUSE_TEXT = {
	low_confidence: '置信度不足，请人工确认',
	unknown_question: '无法确定答案，请人工处理',
	verify_failed: '连续验证失败，已暂停',
	submit_gate: '等待确认交卷',
	error: '运行出错，已暂停',
	panic: '已急停',
	budget: '预算已用尽',
	user: '已暂停',
};

/** 悬浮窗步骤流最多显示的行数。 */
export const STEPS_MAX = 6;

/** 单行步骤最长字数，超出截断（悬浮窗宽度有限）。 */
export const STEP_MAX_CHARS = 34;

/**
 * 把一条运行日志转成悬浮窗步骤行；不该上悬浮窗的返回 null。
 * 只认 Runner 的 [run] 日志，去掉前缀与 (info) 等级后缀，并做长度截断。
 */
export function toStepLine(msg) {
	const s = String(msg ?? '');
	if (!s.startsWith('[run] ')) return null;
	let t = s.slice(6).replace(/\s*\((info|warn|error)\)$/, '').replace(/^\[状态\]\s*/, '');
	// 决策行带坐标明细，悬浮窗只留摘要
	t = t.replace(/，选项坐标=.*$/, '').replace(/（click_point@[^）]*）/, '');
	if (t.length > STEP_MAX_CHARS) t = t.slice(0, STEP_MAX_CHARS - 1) + '…';
	return t;
}

/** 剩余时间分级阈值（秒）。 */
export const TIMER_WARN_SECONDS = 300; // 5 分钟：变黄 + 提示
export const TIMER_DANGER_SECONDS = 60; // 1 分钟：变红 + 强提示

/** 秒 → "mm:ss" 或 "h:mm:ss"。负数/非数字返回 ''。 */
export function formatClock(seconds) {
	if (!Number.isFinite(seconds) || seconds < 0) return '';
	const total = Math.floor(seconds);
	const hh = Math.floor(total / 3600);
	const mm = Math.floor((total % 3600) / 60);
	const ss = total % 60;
	const pad = (n) => String(n).padStart(2, '0');
	return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

/** 剩余时间等级：normal / warn / danger。 */
export function timerLevel(seconds) {
	if (!Number.isFinite(seconds) || seconds < 0) return 'normal';
	if (seconds <= TIMER_DANGER_SECONDS) return 'danger';
	if (seconds <= TIMER_WARN_SECONDS) return 'warn';
	return 'normal';
}

/** 答案来源标注。用户要能分辨"题库命中"和"模型猜的"。 */
export function answerSourceLabel(source) {
	const s = String(source ?? '');
	if (s.startsWith('bank:')) {
		const conf = s.slice(5);
		if (conf === 'high') return '题库高置信';
		if (conf === 'medium-high') return '题库中高置信';
		return '题库';
	}
	if (s === 'model') return '模型';
	if (s === 'manual') return '人工';
	return '';
}

/**
 * 构造悬浮窗状态。
 *
 * @param {object} snap Runner.snapshot()（可为 null）
 * @param {object} extra { modeLabel, timerSeconds }
 */
export function buildOverlayState(snap, extra = {}) {
	const run = snap?.run ?? 'idle';
	const paused = run === 'paused';
	const done = run === 'done' || run === 'stopped';
	const timerSeconds = Number.isFinite(extra.timerSeconds) ? extra.timerSeconds : null;

	const prog = Array.isArray(snap?.current?.prog) ? snap.current.prog : null;
	const handled = Number(snap?.stats?.handled ?? 0);
	const failed = Number(snap?.stats?.failed ?? 0);

	let title = extra.modeLabel || '考试助手';
	if (done) title = '考试助手 · 已结束';
	else if (paused) title = '考试助手 · 已暂停';

	const noteParts = [];
	if (paused && snap?.pauseReason) {
		noteParts.push(PAUSE_TEXT[snap.pauseReason] ?? String(snap.pauseReason));
	}
	if (done) noteParts.push('已完成。核对完待复核后点「停止并返回」退出');

	const level = timerLevel(timerSeconds);
	// 时间提醒优先级最高：它会盖掉普通 note
	if (level === 'danger') noteParts.unshift('⚠ 剩余时间不足 1 分钟！');
	else if (level === 'warn') noteParts.unshift('⚠ 剩余时间不足 5 分钟');

	return {
		run,
		title,
		prog,
		handled,
		failed,
		answer: snap?.answer ?? null,
		answerSource: answerSourceLabel(snap?.source),
		note: noteParts.join(' · '),
		timerText: formatClock(timerSeconds),
		timerLevel: level,
		done,
		// 步骤流：最近几步进度（读题 / 题库 / 模型 / 点击 / 翻页），旧的在上、新的在下。
		// 只放步骤摘要，不放题干原文（见文件头安全边界）。
		steps: Array.isArray(extra.steps) ? extra.steps.slice(-STEPS_MAX) : [],
		// 步骤轨道：当前题固定 5 步（status: todo/active/done/warn/skip）。
		// startedAt 交给悬浮窗自己计秒，插件不必每秒推送。
		track: snap?.track
			? {
					prog: snap.track.prog ?? null,
					qtype: snap.track.qtype ?? '',
					steps: (snap.track.steps ?? []).map((s) => ({
						label: s.label,
						status: s.status,
						detail: String(s.detail ?? '').slice(0, STEP_MAX_CHARS),
						startedAt: s.startedAt || 0,
					})),
			  }
			: null,
		// 已答历史：运行中悬浮窗只显示最近 3 题；暂停/结束后可用滚轮翻看全部（最多 50）
		history: (snap?.history ?? []).slice(-50).map((h) => ({
			prog: h.prog ?? null,
			answer: h.answer ?? null,
			// 别截太短：「模型 deepseek-chat 0.92」截到 20 字会把 0.92 截成 0.9
		source: String(h.source ?? '').slice(0, 40),
			review: Boolean(h.review),
		})),
		// 待复核：悬浮窗只要数量和清单（字母 / 来源 / 置信度，不含题干）
		reviewCount: (snap?.reviews ?? []).length,
		reviews: (snap?.reviews ?? []).map((r) => ({
			no: Array.isArray(r.prog) ? r.prog[0] : r.seq,
			qtype: r.qtype ?? '',
			answer: r.answer ?? null,
			source: String(r.source ?? '').slice(0, 40),
			confidence: r.confidence ?? null,
		})),
	};
}
