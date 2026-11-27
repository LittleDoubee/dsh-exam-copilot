// 宿主机侧的 DOM 读取实现：连本地 CDP 端口，取当前页面的文本行。
//
// 边界（重要）：
//   * **不启动浏览器、不登录取 cookie、不填账号密码**。
//     只连「用户自己已经打开、且自己开了远程调试端口」的浏览器。
//   * 连不上就返回 null，由 Runner 继续用 OCR 结果。
//     这条通道是"锦上添花"，不允许变成新的故障点。
//   * 只读：只调 Runtime.evaluate 取 document.body.innerText，不做点击、不导航。
//
// 为什么用 CDP 而不是 ego/wincu：
//   那两个是**独立插件**，它们的能力（ego_js / mcp__wincu__*）是给 AI 用的工具，
//   不是插件之间能调的服务。本插件没注入浏览器服务，直接连 CDP 最干净，
//   且不依赖别的插件是否安装、是否开启。

import { CDP_CANDIDATES, pickExamTab } from './dom-assist.js';

/** 单次探测超时。太长会拖慢答题。 */
const PROBE_TIMEOUT = 800;

/** 取文本的超时。 */
const EVAL_TIMEOUT = 3000;

/** fetch 一个 URL，带超时；失败返回 null 而不抛。 */
async function tryFetchJson(url, timeoutMs = PROBE_TIMEOUT) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctrl.signal });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 找一个可用的 CDP 端点。
 *
 * @param {string[]} [candidates] 覆盖默认端口清单（测试用）
 * @returns {Promise<{base, tab}|null>}
 */
export async function findCdpTab(candidates = CDP_CANDIDATES) {
	for (const base of candidates) {
		const list = await tryFetchJson(`${base}/json/list`);
		if (!Array.isArray(list)) continue;
		const tab = pickExamTab(list);
		if (tab) return { base, tab };
	}
	return null;
}

/**
 * 用 CDP WebSocket 在页面里求值。
 *
 * 为什么自己写而不用 puppeteer：
 *   只做一件事（取 innerText），引一个几十 MB 的依赖不值。
 *   Node 24 自带 WebSocket，够用。
 */
async function evaluateOnTab(wsUrl, expression, timeoutMs = EVAL_TIMEOUT) {
	return new Promise((resolve) => {
		let done = false;
		const finish = (v) => {
			if (done) return;
			done = true;
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			resolve(v);
		};

		let ws;
		try {
			ws = new WebSocket(wsUrl);
		} catch {
			return resolve(null);
		}

		const timer = setTimeout(() => finish(null), timeoutMs);

		ws.addEventListener('open', () => {
			try {
				ws.send(
					JSON.stringify({
						id: 1,
						method: 'Runtime.evaluate',
						params: {
							expression,
							returnByValue: true,
							awaitPromise: false,
						},
					})
				);
			} catch {
				finish(null);
			}
		});

		ws.addEventListener('message', (ev) => {
			let msg;
			try {
				msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
			} catch {
				return;
			}
			if (msg.id !== 1) return;
			clearTimeout(timer);
			const v = msg.result?.result?.value;
			finish(typeof v === 'string' ? v : null);
		});

		ws.addEventListener('error', () => {
			clearTimeout(timer);
			finish(null);
		});
		ws.addEventListener('close', () => {
			clearTimeout(timer);
			finish(null);
		});
	});
}

/**
 * 取页面可见文本行。
 *
 * 为什么用 innerText 而不是 textContent：
 *   innerText 只返回**渲染可见**的内容，天然过滤掉 display:none 的
 *   弹窗骨架、隐藏的广告位、script 内容。这正是需要的。
 */
const EXTRACT_EXPR = `(() => {
  try {
    const t = document.body ? document.body.innerText : '';
    return t;
  } catch (e) {
    return '';
  }
})()`;

/**
 * 造一个给 Runner 用的 domReader。
 *
 * 返回的函数签名：(question) => Promise<{stem, options}|null>
 * 失败一律返回 null，绝不抛。
 *
 * @param {object} opts
 * @param {string[]} [opts.candidates] CDP 端口候选
 * @param {function} [opts.log]
 */
export function createDomReader({ candidates = CDP_CANDIDATES, log = () => {} } = {}) {
	return async function domReader(question) {
		try {
			const found = await findCdpTab(candidates);
			if (!found) {
				log('没有找到开启调试端口的浏览器（需手动开启），跳过 DOM 补救');
				return null;
			}
			const text = await evaluateOnTab(found.tab.webSocketDebuggerUrl, EXTRACT_EXPR);
			if (!text || !text.trim()) return null;

			const lines = text
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean);

			// 取出题目的逻辑放在 dom-assist.js（纯函数、可单测），
			// 这里只负责"拿到文本行"这件事。
			const { pickQuestionFromLines } = await import('./dom-assist.js');
			return pickQuestionFromLines(lines, question ?? {});
		} catch (err) {
			log(`DOM 读取异常（已忽略）：${err?.message ?? err}`);
			return null;
		}
	};
}

/**
 * 结构化读题（S5）：注入 collectPage()，返回 buildQuestion() 的结果。
 *
 * 返回 (）=> Promise<{ ok, reasons, question } | null>。
 * 连不上浏览器返回 null；抽取不自洽返回 ok=false 和原因，由 Runner 决定回退 OCR。
 * 只读：采集脚本只查询 DOM，不点击、不导航、不改页面。
 */
export function createStructReader({ candidates = CDP_CANDIDATES, log = () => {} } = {}) {
	return async function structReader() {
		try {
			const found = await findCdpTab(candidates);
			if (!found) {
				log('没有找到开启调试端口的浏览器，结构化读题跳过');
				return null;
			}
			const { collectPage, buildQuestion } = await import('./web-extract.js');
			const expr = `(() => { try { return JSON.stringify((${collectPage.toString()})()); } catch (e) { return ''; } })()`;
			const text = await evaluateOnTab(found.tab.webSocketDebuggerUrl, expr);
			if (!text) return null;
			return buildQuestion(JSON.parse(text));
		} catch (err) {
			log(`结构化读题异常（已忽略）：${err?.message ?? err}`);
			return null;
		}
	};
}

/** 探测当前环境是否有可用的 CDP 端点（给面板"检测浏览器"按钮用）。 */
export async function probeCdp(candidates = CDP_CANDIDATES) {
	const found = await findCdpTab(candidates);
	if (!found) {
		return {
			ok: false,
			reason:
				'没有检测到已开启调试端口的浏览器。' +
				'如需 DOM 补救：用 --remote-debugging-port=9222 启动 Chrome/Edge，' +
				'或用带该参数的快捷方式打开。插件不会替你启动浏览器，也不会读取登录凭据。',
			tried: candidates,
		};
	}
	return {
		ok: true,
		base: found.base,
		url: found.tab.url,
		title: found.tab.title ?? '',
	};
}
