// 悬浮窗单测：用假 DOM 验证它的关键行为。
//
// 最要紧的两条（这是"能不挡用户"的核心）：
//   ① 整层不接收鼠标事件（pointer-events:none），只有停止按钮可点
//   ② 运行结束后自动隐藏，不留一个空壳挡住考试界面

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'lib', 'client.js');

/* ── 极简假 DOM ─────────────────────────────────────── */
function makeDom() {
	const nodes = [];

	function makeEl(tag) {
		const el = {
			tagName: String(tag).toUpperCase(),
			children: [],
			style: { cssText: '' },
			attributes: {},
			_text: '',
			get textContent() {
				return this._text;
			},
			set textContent(v) {
				this._text = String(v);
			},
			setAttribute(k, v) {
				this.attributes[k] = v;
			},
			getAttribute(k) {
				return this.attributes[k];
			},
			appendChild(c) {
				this.children.push(c);
				c.parentNode = this;
				return c;
			},
			removeChild(c) {
				this.children = this.children.filter((x) => x !== c);
				c.parentNode = null;
			},
			addEventListener(type, fn) {
				this._listeners = this._listeners ?? {};
				(this._listeners[type] = this._listeners[type] ?? []).push(fn);
			},
			click() {
				for (const fn of this._listeners?.click ?? []) fn({});
			},
		};
		nodes.push(el);
		return el;
	}

	const byId = new Map();
	const body = makeEl('body');
	body.appendChild = function (c) {
		this.children.push(c);
		c.parentNode = this;
		if (c.id) byId.set(c.id, c);
		return c;
	};

	const document = {
		body,
		createElement: makeEl,
		getElementById(id) {
			if (byId.has(id)) return byId.get(id);
			// 也扫一遍 body 的子节点
			const found = body.children.find((c) => c.id === id);
			return found ?? null;
		},
	};

	return { document, body, nodes, byId };
}

/** 在假环境里执行 client.js，取回 mountOverlay。 */
function loadOverlay(dom, fetchImpl) {
	let captured = null;
	const window = {
		__ModuleLoader__: {
			load({ factory }) {
				captured = factory((n) => (n === 'react' ? fakeReact() : {}));
			},
		},
		setInterval: (fn, ms) => {
			// 不真的跑定时器；测试里手动触发 poll
			window.__polls = window.__polls ?? [];
			window.__polls.push(fn);
			return 1;
		},
		clearInterval: () => {},
		setTimeout: () => 0,
		prompt: () => null,
	};

	const code = fs.readFileSync(CLIENT, 'utf8');
	const fn = new Function('window', 'document', 'console', 'fetch', 'setInterval', 'clearInterval', code);
	fn(window, dom.document, { error() {}, log() {}, warn() {} }, fetchImpl, window.setInterval, window.clearInterval);

	// 从模块作用域拿到挂载函数：通过 apply 之后的副作用无法直接取，
	// 这里改为读取 window 上暴露的引用（client.js 里刻意没暴露），
	// 所以退一步：直接 eval 出 dshec_mountOverlay 的等价实现太重。
	// 改为：把 mountOverlay 通过 window.__DSHEC_OVERLAY__ 暴露（见 client.js）。
	return { window, captured };
}

function fakeReact() {
	return {
		createElement: () => ({ type: 'div', props: {} }),
		useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
		useEffect: () => {},
		useMemo: (f) => f(),
		useCallback: (f) => f,
		useRef: (v) => ({ current: v }),
	};
}

test('悬浮窗：整层不拦截鼠标，只有按钮可点', async () => {
	const dom = makeDom();
	const { window } = loadOverlay(dom, async () => ({ ok: true, json: async () => ({ active: false }) }));

	// client.js 把挂载函数挂在 window 上供面板调用
	const mount = window.__DSHEC_OVERLAY__?.mountOverlay;
	assert.equal(typeof mount, 'function', '必须暴露 mountOverlay');

	mount({});
	const el = dom.document.getElementById('dshec-overlay');
	assert.ok(el, '悬浮窗应被插入 DOM');

	// 关键断言：容器不吃鼠标事件（否则会挡住考试界面）
	assert.match(el.style.cssText, /pointer-events:none/);

	// 但停止按钮必须可点
	const btn = el.children.find((c) => c.tagName === 'BUTTON');
	assert.ok(btn, '必须有停止按钮');
	assert.match(btn.style.cssText, /pointer-events:auto/);
});

test('悬浮窗：运行结束后隐藏，不留空壳', async () => {
	const dom = makeDom();
	let active = true;
	const { window } = loadOverlay(dom, async () => ({
		ok: true,
		json: async () => (active ? { active: true, run: 'running', prog: [3, 10], answer: 'A', handled: 2 } : { active: false }),
	}));

	window.__DSHEC_OVERLAY__.mountOverlay({ intervalMs: 5 });
	const el = dom.document.getElementById('dshec-overlay');
	assert.ok(el);

	// mount 时会立刻 poll 一次；等它落地。
	// 注意：这里读 style.display 而不是 cssText —— 假 DOM 不模拟 CSS 级联，
	// 真实浏览器里 el.style.display = 'block' 就会生效。
	await tick();
	assert.equal(el.style.display, 'block', '运行中应显示');

	// 运行结束：手动再 poll 一次
	active = false;
	const poll = window.__polls?.at(-1);
	assert.equal(typeof poll, 'function');
	await poll();
	await tick();
	assert.equal(el.style.display, 'none', '结束后必须隐藏');
});

test('悬浮窗：状态数据能正确显示题号与答案', async () => {
	const dom = makeDom();
	const { window } = loadOverlay(dom, async () => ({
		ok: true,
		json: async () => ({ active: true, run: 'running', prog: [7, 20], answer: 'BD', handled: 6, failed: 1 }),
	}));

	window.__DSHEC_OVERLAY__.mountOverlay({ intervalMs: 5 });
	const poll = window.__polls?.at(-1);
	await poll();
	await tick();

	const el = dom.document.getElementById('dshec-overlay');
	const texts = [];
	const walk = (n) => {
		if (n._text) texts.push(n._text);
		(n.children ?? []).forEach(walk);
	};
	walk(el);
	const joined = texts.join(' | ');
	assert.match(joined, /7\/20/, '应显示题号进度: ' + joined);
	assert.match(joined, /BD/, '应显示答案: ' + joined);
});

test('悬浮窗：网络失败不影响自身，也不抛错', async () => {
	const dom = makeDom();
	const { window } = loadOverlay(dom, async () => {
		throw new Error('network down');
	});
	window.__DSHEC_OVERLAY__.mountOverlay({ intervalMs: 5 });
	const poll = window.__polls?.at(-1);
	await assert.doesNotReject(async () => {
		await poll();
		await tick();
	});
	// 依然存在（只是没数据）
	assert.ok(dom.document.getElementById('dshec-overlay'));
});

function tick() {
	return new Promise((r) => setTimeout(r, 10));
}
