// 引擎客户端：Node 侧调 Python 常驻服务的唯一出口。
//
// 零 ctx，纯 fetch —— 可用 node --test 直接对着真引擎跑集成测试。
//
// 为什么 HTTP 而不是 stdio pipe：
//   本机沙箱下 spawnSync 默认 stdio:'pipe' 会被拒（EPERM），
//   异步 spawn 的背压 / 半行 / 僵死管理在插件里很难做对。
//   HTTP + token 顺便让引擎能脱离 DSH 用 curl 调试。

export class EngineClient {
	/**
	 * @param {{ port:number, token:string, host?:string }} conn
	 * @param {{ timeoutMs?:number }} [opts]
	 */
	constructor(conn, opts = {}) {
		if (!conn?.port) throw new Error('engine.port 必填');
		this.host = conn.host ?? '127.0.0.1';
		this.port = conn.port;
		this.token = conn.token ?? '';
		this.timeoutMs = opts.timeoutMs ?? 30_000;
	}

	get base() {
		return `http://${this.host}:${this.port}`;
	}

	async request(method, pathname, body, { timeoutMs } = {}) {
		const controller = new AbortController();
		const budget = timeoutMs ?? this.timeoutMs;
		const timer = setTimeout(() => controller.abort(), budget);
		try {
			const res = await fetch(`${this.base}${pathname}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
			const text = await res.text();
			let payload = null;
			try {
				payload = text ? JSON.parse(text) : null;
			} catch {
				payload = { raw: text };
			}
			if (!res.ok) {
				const err = new Error(`引擎 ${pathname} 返回 ${res.status}: ${payload?.error ?? text.slice(0, 200)}`);
				err.status = res.status;
				err.payload = payload;
				throw err;
			}
			return payload;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * 健康检查。它同时承担三个职责：
	 *   1. 判断引擎是否活着（守护进程据此决定是否重启）
	 *   2. 拉取能力清单（哪个 OCR 可用、有几块屏）
	 *   3. 首次启动时确认版本匹配
	 */
	async health() {
		return this.request('GET', '/v1/health', undefined, { timeoutMs: 8000 });
	}

	/** 截图。region 省略则整屏（all_screens）。 */
	async screenshot(region) {
		return this.request('POST', '/v1/screenshot', region ? { region } : {});
	}

	/**
	 * OCR + 解析。
	 * 传 region 让引擎自己裁图 —— 避免大图过 HTTP。
	 *
	 * excludeRegions：这些区域内的 OCR 行会被丢掉（屏幕绝对坐标）。
	 * 典型用途：all 区把页面顶部倒计时也框进来时，倒计时每秒变化会
	 * 污染题干 → 题库标准化后永远对不上。把这个区域传进来即可，
	 * 不必让用户重画 all 区。
	 */
	async ocr({ imagePath, region, engine = 'auto', expectOpts, qtype, offset, excludeRegions } = {}) {
		return this.request(
			'POST',
			'/v1/ocr',
			{ imagePath, region, engine, expectOpts, qtype, offset, excludeRegions },
			{ timeoutMs: 120_000 }
		);
	}

	/** 滚轮多帧截图拼接（选项被截断时用）。 */
	async scrollCapture({ region, maxShots = 4 } = {}) {
		return this.request('POST', '/v1/scroll-capture', { region, maxShots }, { timeoutMs: 120_000 });
	}

	/**
	 * 执行动作（S2）。envelope 必须已经过 actions.validateAction。
	 *
	 * region 用于前后哈希比对：验证"这一步到底有没有让画面变化"。
	 * 返回 { ok, changed, beforeHash, afterHash, actions }
	 */
	async act(envelope, { region, settleMs } = {}) {
		const payload = {
			action: envelope.action,
			params: { ...(envelope.params ?? {}) },
			region,
		};
		if (settleMs !== undefined) payload.params.settleMs = settleMs;
		return this.request('POST', '/v1/act', payload, { timeoutMs: envelope.timeout_ms ?? 20_000 });
	}

	/**
	 * 采样像素颜色，用于判断选项是否被选中。
	 * 比"整块哈希变化"语义明确得多（哈希变了只说明页面动过）。
	 */
	async probeColors(points) {
		return this.request('POST', '/v1/probe-colors', { points }, { timeoutMs: 15_000 });
	}

	/** OCR 读题号区，返回 [当前, 总数] 或 null。翻页验证的唯一可靠依据。 */
	async readProgress(region, { scale } = {}) {
		return this.request('POST', '/v1/read-progress', { region, scale }, { timeoutMs: 30_000 });
	}

	/** 触发圈选：阻塞直到用户画完框或超时。 */
	async pickZones({ timeoutMs = 180_000 } = {}) {
		return this.request('POST', '/v1/zone/pick', { timeoutMs }, { timeoutMs: timeoutMs + 5000 });
	}

	/** 全屏预览：引擎侧会最小化宿主、显示截图、高亮框、右下角预览。 */
	async previewZones({ regions = [], timeoutMs = 300_000 } = {}) {
		return this.request(
			'POST',
			'/v1/zone/preview',
			{ regions, timeoutMs },
			// HTTP 超时必须比 Tk 窗口的存活时间长，否则窗口还在连接就先断了
			{ timeoutMs: timeoutMs + 5000 }
		);
	}


	/** 立即停止一切动作（引擎侧也会清空动作队列）。 */
	async panic() {
		return this.request('POST', '/v1/panic', {}, { timeoutMs: 5000 });
	}

	/**
	 * 放行动作执行。
	 *
	 * 为什么必须有：引擎启动即 `paused=True`，
	 * 动作接口一律 409，这是刻意的安全设计 —— 必须由 Runner 显式放行。
	 * 但 Runner.start()/pause()/resume() 都在调 `this.engine.resume()`，
	 * 而 EngineClient **从来没包过这个方法**，于是：
	 *     run.start → "无法放行引擎动作：this.engine.resume is not a function"
	 * 即：**自动答题完全跑不起来**，而所有单测都是绿的
	 * （单测用假引擎，假引擎有 resume，真引擎没有）。
	 * 引擎侧 `/v1/resume` 一直是存在的，只是这边漏了包装。
	 */
	async resume() {
		return this.request('POST', '/v1/resume', {}, { timeoutMs: 5000 });
	}

	/** 窗口激活（自绘窗口失焦会暂停渲染，截图前必须先激活）。 */
	async focusWindow(title) {
		return this.request('POST', '/v1/window/focus', { title }, { timeoutMs: 10_000 });
	}

	/** 自动版面识别：{title?, region?, imagePath?} → {ok, zones, score, notes, window}。OCR 较慢，给足时间。 */
	detectLayout({ title = '', region = null, imagePath = null, hideWindows = false } = {}) {
		const body = { title, hideWindows };
		if (region) body.region = region;
		if (imagePath) body.imagePath = imagePath;
		return this.request('POST', '/v1/layout/detect', body, { timeoutMs: 60_000 });
	}

	/** 目标窗口客户区的屏幕矩形 {x,y,w,h}；找不到时 ok=false。 */
	windowRect(title) {
		return this.request('POST', '/v1/window/rect', { title }, { timeoutMs: 5_000 });
	}

	/**
	 * 运行期：最小化宿主并**保持**最小化。
	 *
	 * 为什么必须由引擎来做：
	 *   自动答题期间 DSH 一旦露出来，截图就会截到它，OCR 读到聊天记录，
	 *   整场运行必然判成"题目不完整 / 置信度不足"。
	 *   而用户手工最小化"来不及"——点完「开始」到第一次截图只有几十毫秒。
	 *   所以点开始这一刻就必须由程序压下去，并且运行期间不能恢复。
	 */
	async minimizeHost() {
		return this.request('POST', '/v1/host/minimize', {}, { timeoutMs: 8_000 });
	}

	/** 运行结束：恢复被最小化的宿主窗口，并把 DSH 提到前台。 */
	async restoreHost() {
		return this.request('POST', '/v1/host/restore', {}, { timeoutMs: 8_000 });
	}

	/**
	 * 置顶悬浮窗：显示 / 更新 / 隐藏 / 取用户点击。
	 *
	 * 悬浮窗由引擎侧的原生窗口实现（不是浏览器 DOM）：
	 *   ① DSH 已最小化，页面里的 DOM 悬浮窗根本没机会被看到；
	 *   ② 引擎侧窗口可以设 WDA_EXCLUDEFROMCAPTURE —— 用户看得见、
	 *      OCR 永远截不到，比"让悬浮窗躲开识别区域"可靠得多。
	 */
	async overlayShow(state) {
		return this.request('POST', '/v1/overlay/show', { state: state ?? {} }, { timeoutMs: 10_000 });
	}

	async overlayUpdate(state) {
		return this.request('POST', '/v1/overlay/update', { state: state ?? {} }, { timeoutMs: 6_000 });
	}

	async overlayHide() {
		return this.request('POST', '/v1/overlay/hide', {}, { timeoutMs: 6_000 });
	}

	/** 取走用户点「暂停 / 停止并返回」产生的动作。主线程轮询调用。 */
	async overlayActions() {
		return this.request('POST', '/v1/overlay/actions', {}, { timeoutMs: 6_000 });
	}

	/** 读倒计时区，返回 { ok, seconds, text, engine }。 */
	async readTimer(region) {
		return this.request('POST', '/v1/read-timer', { region }, { timeoutMs: 40_000 });
	}

	/** 取回截图（面板预览用）。返回 { dataUrl, w, h } 或 null。 */
	async shotDataUrl(region, maxWidth = 480, { hideWindows = false } = {}) {
		const res = await this.request('POST', '/v1/screenshot', { region, maxWidth, hideWindows });
		if (!res?.dataUrl) return null;
		return { dataUrl: res.dataUrl, w: res.w, h: res.h };
	}

	/** 截图并存成文件，同时返回缩略 dataUrl。
	 *
	 *  为什么要落盘而不只返回 base64：
	 *    预览时截的那张图要能被「配置自检」复用 —— 复用同一张图，
	 *    才能保证"看到的就是识别的"。只传 base64 做不到这点。
	 */
	async screenshotToFile(region, { maxWidth = 720, dir, name = 'shot' } = {}) {
		const pathMod = await import('node:path');
		const fsMod = await import('node:fs');
		const target = dir ? pathMod.join(dir, `${name}.png`) : undefined;
		if (target) fsMod.mkdirSync(pathMod.dirname(target), { recursive: true });

		const body = { region, maxWidth };
		if (target) body.savePath = target;

		const res = await this.request('POST', '/v1/screenshot', body);
		if (!res) return null;
		return { dataUrl: res.dataUrl, w: res.w, h: res.h, path: res.path ?? target ?? null };
	}
}

/** 轮询直到健康（引擎冷启动需要时间）。 */
export async function waitForHealthy(makeClient, { timeoutMs = 20_000, intervalMs = 400 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const client = makeClient();
			if (!client) throw new Error('引擎尚未就绪');
			return await client.health();
		} catch (err) {
			lastError = err;
			await sleep(intervalMs);
		}
	}
	throw lastError ?? new Error('引擎启动超时');
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
