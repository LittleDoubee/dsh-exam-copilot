// 整页渲染验证：用一个能真正驱动 useState 的 React 替身，把「拿到数据后」的
// 完整界面渲染出来并断言内容。
//
// 为什么需要这么麻烦：
//   面板能点开、导航项可见，但内容全白。后端 /status 返回 200 数据齐全，
//   所以问题只在客户端渲染层。两类错误都只在真实渲染路径上暴露：
//     1. 组件被当普通函数裸调 → props.children 为 undefined → 内容全丢
//     2. props 为 null 时容器读 props.gap → 抛异常 → 整棵树渲染失败
//   只断言"首屏加载提示"是不够的 —— 必须先让异步 status 落地，再渲染主界面。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'lib', 'client.js');

/* ── 可驱动状态的 React 替身 ───────────────────────────────
 * 维护一个全局 hook 游标；每次渲染同一组件时按调用顺序重放 hooks，
 * setState 把值写回槽位并触发一次重渲染。够用且行为接近真实 React。 */
const hookStore = new Map();
let renderKey = null;

const REACT = {
	createElement(type, props, ...children) {
		const flat = [];
		for (const c of children) {
			if (Array.isArray(c)) flat.push(...c);
			else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c);
		}
		return {
			$$el: true,
			type,
			props: { ...(props ?? {}), ...(flat.length ? { children: flat.length === 1 ? flat[0] : flat } : {}) },
		};
	},
	createContext: () => ({ Provider: 'P', Consumer: 'C' }),
	useState(init) {
		const key = renderKey;
		const slots = hookStore.get(key) ?? { values: [], cursor: 0 };
		hookStore.set(key, slots);
		const i = slots.cursor++;
		if (!(i in slots.values)) slots.values[i] = typeof init === 'function' ? init() : init;
		const setter = (v) => {
			slots.values[i] = typeof v === 'function' ? v(slots.values[i]) : v;
			scheduleRerender();
		};
		return [slots.values[i], setter];
	},
	useEffect(fn) {
		// 首次渲染后立即执行（不实现依赖比较，够用）
		pendingEffects.push(fn);
	},
	useMemo: (fn) => fn(),
	useCallback: (fn) => fn,
	useRef: (v) => ({ current: v }),
	useSyncExternalStore: () => ({}),
	Fragment: 'Fragment',
};

let pendingEffects = [];
let rerenderRequested = false;
function scheduleRerender() {
	rerenderRequested = true;
}

function resetHooks() {
	hookStore.clear();
	renderKey = null;
	pendingEffects = [];
	rerenderRequested = false;
}

/** 渲染元素树为 HTML 字符串。
 *  hooks 槽位按「组件身份 + 每次渲染时的实例序列」区分；
 *  这里用组件函数自身作为 key 就够 —— 测试里每棵树只有一个有状态的 Page 组件。 */
function render(node) {
	if (node === null || node === undefined || node === false || node === true) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(render).join('');
	const { type, props } = node;
	if (typeof type === 'function') {
		const prevKey = renderKey;
		const prevCursor = hookStore.get(type)?.cursor ?? 0;
		renderKey = type;
		// 每次进入组件重置该组件的游标，保证 hook 顺序稳定
		const slots = hookStore.get(type) ?? { values: [], cursor: 0 };
		hookStore.set(type, slots);
		slots.cursor = 0;
		let out;
		try {
			out = type(props);
		} finally {
			renderKey = prevKey;
		}
		return render(out);
	}
	if (type === 'Fragment') return render(props?.children);
	const inner = render(props?.children);
	const extras = [];
	for (const k of ['value', 'placeholder']) {
		const v = props?.[k];
		if (typeof v === 'string' && v) extras.push(v);
	}
	return '<' + type + '>' + extras.join(' ') + inner + '</' + type + '>';
}

/** 递归找出树里所有 onClick 处理器（模拟点击用）。 */
function collectHandlers(node, out = []) {
	if (node === null || node === undefined) return out;
	if (Array.isArray(node)) {
		for (const n of node) collectHandlers(n, out);
		return out;
	}
	if (typeof node !== 'object') return out;
	const { type, props } = node;
	if (typeof type === 'function') {
		const prev = renderKey;
		renderKey = type;
		const slots = hookStore.get(type) ?? { values: [], cursor: 0 };
		hookStore.set(type, slots);
		slots.cursor = 0;
		const out2 = type(props);
		renderKey = prev;
		return collectHandlers(out2, out);
	}
	if (props?.onClick) out.push({ props, node });
	collectHandlers(props?.children, out);
	return out;
}

/** 找到文本匹配某关键字的按钮并"点击"它。 */
async function clickByText(component, keyword) {
	// 反复读当前 UI，找含关键字的可点击元素
	const tree = component();
	const handlers = collectHandlers(tree);
	for (const h of handlers) {
		const kids = h.props.children;
		const text = typeof kids === 'string' ? kids : Array.isArray(kids) ? kids.filter((k) => typeof k === 'string').join('') : '';
		if (text.includes(keyword)) {
			h.props.onClick({ target: { value: '' } });
			return true;
		}
	}
	return false;
}
async function renderSettled(component, maxRounds = 12) {
	let html = '';
	for (let i = 0; i < maxRounds; i++) {
		rerenderRequested = false;
		const effects = pendingEffects;
		pendingEffects = [];
		html = render(component());
		// 执行 effect（其中可能有 fetch → setState）
		for (const fn of effects) {
			try {
				fn();
			} catch {
				/* effect 失败不该影响渲染断言 */
			}
		}
		// 让 microtask 落地（fetch 桩是 Promise）
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		if (!rerenderRequested && i > 0) break;
	}
	return html;
}

/* ── 桩数据（形状必须与 lib/index.js 的 status 一致） ── */
const STATUS = {
	pluginVersion: '0.1.0',
	dataDir: 'X:/data',
	pythonPath: 'python',
	pythonProbe: { python: 'python', ok: true },
	engineRunning: true,
	engine: { ok: true, version: '0.1.0', paused: true, ocrEngines: ['windows', 'rapid'], screen: { w: 1920, h: 1080 } },
	lastError: null,
	uptimeMs: 1000,
};

const PROFILES = [{ id: 'p1', name: '默认配置', channel: 'screen', zoneCount: 3, updatedAt: null }];

const PROFILE = {
	id: 'p1',
	name: '默认配置',
	channel: 'screen',
	display: { w: 1920, h: 1080, dpiScale: 1 },
	zones: [
		{ role: 'question', x: 10, y: 20, w: 300, h: 200 },
		{ role: 'options', x: 10, y: 240, w: 300, h: 180 },
		{ role: 'progress', x: 10, y: 430, w: 80, h: 30 },
	],
};

function makeFetch() {
	return async (url, opts) => {
		let body = {};
		try {
			body = JSON.parse(opts?.body ?? '{}');
		} catch {
			body = {};
		}
		const ep = body.endpoint;
		let value = {};
		if (ep === 'status') value = STATUS;
		else if (ep === 'profiles.list') value = PROFILES;
		else if (ep === 'profiles.get') value = PROFILE;
		else if (ep === 'zones.meta') value = { roles: ['question', 'options', 'progress'], required: ['question', 'options'] };
		return { ok: true, json: async () => ({ ok: true, value }) };
	};
}

function loadComponent() {
	let captured = null;
	const window = {
		__ModuleLoader__: { load: ({ factory }) => { captured = factory((n) => (n === 'react' ? REACT : {})); } },
		setTimeout: () => 0,
		prompt: () => 'x',
	};
	const code = fs.readFileSync(CLIENT, 'utf8');
	new Function('window', 'console', 'fetch', code)(window, { error() {}, log() {}, warn() {} }, makeFetch());

	let component = null;
	captured.apply({
		slots: { inject: (n, fn) => fn(), register: (s, c) => { component = c; return () => {}; } },
	});
	return component;
}

test('首屏渲染可见加载提示（不是空白）', async () => {
	resetHooks();
	const Page = loadComponent();
	// 首屏：effect 还没跑完，status 为 null
	const html = render(Page());
	assert.ok(html.length > 0, '不能渲染出空字符串');
	assert.match(html, /正在读取状态/, '应显示加载提示');
});

test('数据落地后渲染出完整主界面（白屏故障的正面回归）', async () => {
	resetHooks();
	const Page = loadComponent();
	const html = await renderSettled(Page);

	assert.ok(html.length > 0, '主界面不能是空壳');
	// 标题与页签必须在
	assert.match(html, /考试助手/, '缺标题');
	assert.match(html, /总览/, '缺总览页签');
	assert.match(html, /区域/, '缺区域页签');
	assert.match(html, /题库/, '缺题库页签');
	// 引擎状态与按钮必须在
	assert.match(html, /引擎运行中/, '缺引擎状态');
	assert.match(html, /启动引擎/, '缺启动按钮');
	assert.match(html, /停止引擎/, '缺停止按钮');
	// 从 status 来的动态数据必须显示
	assert.match(html, /1920×1080/, '缺屏幕尺寸');
	assert.match(html, /windows\+rapid/, '缺 OCR 引擎列表');
});

test('渲染全程不抛异常', async () => {
	resetHooks();
	const Page = loadComponent();
	await assert.doesNotReject(async () => {
		await renderSettled(Page);
	});
});

/** 逐个页签真实渲染：点一下页签，渲染，断言关键控件存在。
 *
 *  这是 S2 新增运行页的正面回归 —— 上次白屏就是因为没有测"渲染出来的内容"。 */
	test('逐个页签渲染（含新增的安全页）：每个页签都有内容', async () => {
	resetHooks();
	const component = loadComponent();
	await renderSettled(component); // 先让 status 落地

	const tabs = ['总览', '区域', '题库', '模型', '提示词', '运行', '安全'];

	for (const name of tabs) {
		const clicked = await clickByText(component, name);
		assert.equal(clicked, true, `应能点到页签「${name}」`);
		rerenderRequested = false;
		const html = await renderSettled(component, 4);
		assert.ok(html.length > 0, `页签「${name}」渲染为空`);
	}

	// 最后停在「安全」页，检查关键控件
	const safetyHtml = await renderSettled(component, 4);
	assert.match(safetyHtml, /急停与提交/, '安全页必须有提交闸门区块');
	assert.match(safetyHtml, /截图留存/, '安全页必须有截图留存设置');
	assert.match(safetyHtml, /急停方式/, '安全页必须列急停方式');
});
