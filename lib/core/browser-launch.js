// 插件自己启动一个带调试端口的浏览器。
//
// 之前的设计是「让用户自己用 --remote-debugging-port 启动」——用户明确否了：
//   「监测浏览器不应当由用户自行调试，应当由插件完成，并提示用户」
//
// 所以这里改成插件拉起浏览器。但要处理几个真实约束：
//
//   ① 不能碰用户日常用的 profile。
//      用独立 user-data-dir（存在插件数据目录下），
//      好处：不冲突、不动用户书签/历史/登录态、坏了删掉即可。
//      代价：需要用户在这个窗口里登录一次考试系统（登录态是独立的）。
//
//   ② 不能复用已在运行的浏览器。
//      Chrome/Edge 有个行为：如果已有实例在用默认 profile，
//      再传 --remote-debugging-port 会被**忽略**（直接复用旧进程）。
//      所以必须带独立 --user-data-dir，否则端口永远打不开。
//      这是最常见的坑，注释写在这里免得以后又踩。
//
//   ③ 只启动一次。重复点"检测"不应该开一堆窗口。
//     用进程引用 + 端口探测双重判断。
//
//   ④ 不读、不存、不发送任何登录凭据。
//      插件只负责"把浏览器打开、确认调试端口能连"，
//      登录由用户自己在窗口里完成。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CDP_CANDIDATES } from './dom-assist.js';

/** 本机常见浏览器安装位置（Windows）。
 *
 *  为什么一个个列而不是"找默认浏览器"：
 *    用户可能在多个浏览器里考试（比如公司要求 Edge、个人习惯 Chrome）。
 *    让用户选比替他决定更靠谱，也避免"我以为你用默认浏览器"的误判。
 */
const BROWSER_CANDIDATES = [
	{
		id: 'chrome',
		name: 'Google Chrome',
		paths: [
			'C:/Program Files/Google/Chrome/Application/chrome.exe',
			'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
		],
	},
	{
		id: 'edge',
		name: 'Microsoft Edge',
		paths: [
			'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
			'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
		],
	},
	{
		id: 'brave',
		name: 'Brave',
		paths: [
			'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
			'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe',
		],
	},
	{
		id: 'chromium',
		name: 'Chromium',
		paths: [
			'C:/Program Files/Chromium/Application/chrome.exe',
			'C:/Program Files (x86)/Chromium/Application/chrome.exe',
		],
	},
];

/** 列出本机**已安装**的所有浏览器（给面板让用户选）。 */
export function listBrowsers() {
	const out = [];
	for (const b of BROWSER_CANDIDATES) {
		for (const p of b.paths) {
			try {
				if (fs.existsSync(p)) {
					out.push({ id: b.id, name: b.name, exe: p });
					break; // 同一个浏览器只列一次
				}
			} catch {
				/* 权限问题跳过 */
			}
		}
	}
	return out;
}

/** 找第一个存在的浏览器（listBrowsers 的首项）。保留给不关心具体哪款的调用方。 */
export function findBrowser() {
	const all = listBrowsers();
	return all.length > 0 ? all[0] : null;
}

/** 探测某个端口是否已经是可用的 CDP 端点。 */
async function probePort(base, timeoutMs = 600) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(`${base}/json/version`, { signal: ctrl.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** 找一个空闲端口（从 9222 起往上试）。 */
async function findFreePort(startPort = 9222, tries = 6) {
	for (let i = 0; i < tries; i++) {
		const port = startPort + i;
		const busy = await probePort(`http://127.0.0.1:${port}`);
		if (!busy) {
			// 端口探测说没 CDP —— 但可能被非 CDP 程序占用。
			// 用 net 再确认一次"能监听"太麻烦，这里接受误判：
			// 真被占用时浏览器会自己报错，后面探测失败时会提示。
			return port;
		}
	}
	return null;
}

/**
 * 管理"答题用的浏览器"。
 *
 * 生命周期：第一次需要 DOM 补救时启动，插件停止/用户点关闭时退出。
 * 刻意不常驻 —— 用户不开 DOM 补救就一个进程都不起。
 */
export class BrowserLauncher {
	/**
	 * @param {object} opts
	 * @param {string} opts.dataDir 插件数据目录（user-data-dir 放这里）
	 * @param {function} [opts.log]
	 */
	constructor({ dataDir, log = () => {} } = {}) {
		this.dataDir = dataDir;
		this.log = log;
		this.proc = null;
		this.port = null;
		this.browser = null;
	}

	/** 浏览器是否已被本插件启动且还活着。 */
	get running() {
		return !!(this.proc && this.proc.exitCode === null && this.port);
	}

	/** 本次会话用的 user-data-dir。 */
	profileDir() {
		return path.join(this.dataDir, 'browser-profile');
	}

	/**
	 * 确保浏览器已启动并可用。
	 *
	 * @returns {Promise<{ok, port?, browser?, reason?}>}
	 */
	/**
	 * @param {object} [opts]
	 * @param {string} [opts.browserId] 用户在面板里选的浏览器 id（chrome/edge/...）
	 */
	async ensure({ browserId } = {}) {
		// 已经在跑：直接确认端口还活着
		if (this.running) {
			if (await probePort(`http://127.0.0.1:${this.port}`)) {
				return { ok: true, port: this.port, browser: this.browser.name, reused: true };
			}
			// 进程在但端口没了（用户手动关了标签/浏览器崩溃）→ 清理后重启
			this.log('浏览器进程还在但调试端口无响应，重新启动');
			this._kill();
		}

		// 用户指定了浏览器就用它；没指定则用第一个找到的
		const installed = listBrowsers();
		const b = browserId
			? installed.find((x) => x.id === browserId) ?? installed[0]
			: installed[0];
		if (!b) {
			return {
				ok: false,
				reason:
					'没有找到 Chrome 或 Edge。' +
					'请安装其中之一，或用「桌面程序」模式（不需要浏览器）。',
			};
		}

		// 先看有没有别人已经开好的调试端口（比如用户自己开的）
		for (const base of CDP_CANDIDATES) {
			if (await probePort(base)) {
				const port = Number(base.split(':').pop());
				this.port = port;
				this.browser = { id: 'external', name: '已运行的浏览器' };
				this.log(`复用已开启调试端口的浏览器：${base}`);
				return { ok: true, port, browser: '已运行的浏览器', reused: true, external: true };
			}
		}

		const port = await findFreePort();
		if (!port) {
			return { ok: false, reason: '没有空闲的调试端口（9222-9227 都被占用）' };
		}

		const profile = this.profileDir();
		try {
			fs.mkdirSync(profile, { recursive: true });
		} catch (err) {
			return { ok: false, reason: `无法创建浏览器配置目录：${err?.message ?? err}` };
		}

		const args = [
			// 关键：独立 user-data-dir。不带这个，已运行的浏览器会吞掉参数，
			// 调试端口永远打不开（最常见的坑）。
			`--user-data-dir=${profile}`,
			`--remote-debugging-port=${port}`,
			// 不弹"这是自动化软件"的提示条（Chrome 111+ 会加）
			'--disable-blink-features=AutomationControlled',
			// 首屏空白，让用户自己导航到考试系统
			'about:blank',
		];

		try {
			this.proc = spawn(b.exe, args, {
				detached: false,
				stdio: 'ignore',
				windowsHide: false,
			});
		} catch (err) {
			return { ok: false, reason: `启动浏览器失败：${err?.message ?? err}` };
		}

		this.proc.on('exit', () => {
			this.log('答题用浏览器已退出');
			this.proc = null;
			this.port = null;
		});

		// 等端口就绪（Chrome 冷启动约 1-3 秒）
		const base = `http://127.0.0.1:${port}`;
		const deadline = Date.now() + 12_000;
		while (Date.now() < deadline) {
			if (await probePort(base, 400)) {
				this.port = port;
				this.browser = b;
				this.log(`浏览器已就绪：${b.name}，调试端口 ${port}`);
				return {
					ok: true,
					port,
					browser: b.name,
					reused: false,
					hint: '请在打开的浏览器窗口里登录考试系统，然后回到面板点「检测浏览器」。',
				};
			}
			await new Promise((r) => setTimeout(r, 300));
		}

		this._kill();
		return {
			ok: false,
			reason: `浏览器已启动但调试端口 ${port} 未能就绪（12 秒超时）。`,
		};
	}

	/** 关掉本插件启动的浏览器。外部复用的一律不动。 */
	close() {
		if (!this.proc) return { closed: false };
		this._kill();
		return { closed: true };
	}

	_kill() {
		try {
			this.proc?.kill();
		} catch {
			/* ignore */
		}
		this.proc = null;
		this.port = null;
	}
}
