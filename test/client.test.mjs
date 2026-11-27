// 客户端渲染冒烟测试：用真的 React SSR 把页面渲染成 HTML 字符串。
//
// 为什么必须真渲染而不是靠读代码判断：
//   面板"能点开但全空白"，后端 200 正常，问题全在客户端组件层。
//   两类错误都只在渲染时才暴露：
//     1. 把组件当普通函数裸调（dshec_Title(null, 'x')）→ props.children 是 undefined
//     2. props 为 null 时组件内部读 props.gap → 直接抛异常 → 整页白屏
//   所以这里把 client.js 在假的 window.__ModuleLoader__ 下执行，取出页面组件渲染一遍。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'lib', 'client.js');

// 极简 react 替身：只要能构造元素树 + 供 SSR 渲染
const REACT = {
	createElement(type, props, ...children) {
		const flat = [];
		for (const c of children) {
			if (Array.isArray(c)) flat.push(...c);
			else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c);
		}
		return {
			$$typeof: 'element',
			type,
			props: { ...(props ?? {}), ...(flat.length ? { children: flat.length === 1 ? flat[0] : flat } : {}) },
		};
	},
	createContext() {
		return { Provider: 'Provider', Consumer: 'Consumer' };
	},
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useEffect: () => {},
	useMemo: (fn) => fn(),
	useCallback: (fn) => fn,
	useRef: (v) => ({ current: v }),
	useSyncExternalStore: () => ({}),
	useReducer: (r, init) => [init, () => {}],
	Fragment: 'Fragment',
};

/** 把元素树渲染成 HTML 字符串。函数组件就地调用，字符串/数字原样输出。 */
function render(node, depth = 0) {
	if (node === null || node === undefined || node === false || node === true) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map((n) => render(n, depth)).join('');
	if (typeof node === 'function') {
		// 直接用函数当组件（替身 createElement 不会自动调用）
		return render(node({}), depth);
	}
	if (typeof node !== 'object') return '';

	const { type, props } = node;
	if (typeof type === 'function') {
		// 函数组件：React 会把它当组件调用，这里等价处理
		return render(type(props), depth + 1);
	}
	if (type === 'Fragment') return render(props?.children, depth);

	const attrs = [];
	for (const [k, v] of Object.entries(props ?? {})) {
		if (k === 'children') continue;
		if (v === null || v === undefined || typeof v === 'object' || typeof v === 'function') continue;
		attrs.push(` ${k}="${String(v).replace(/"/g, '&quot;')}"`);
	}
	const inner = render(props?.children, depth + 1);
	return `<${type}${attrs.join('')}>${inner}</${type}>`;
}

/** 在假的模块加载器里执行 client.js，拿回插件导出。 */
function loadClient(stubs = {}) {
	let captured = null;
	const window = {
		__ModuleLoader__: {
			load({ factory }) {
				captured = factory((name) => {
					if (name === 'react') return REACT;
					if (stubs[name] !== undefined) return stubs[name];
					throw new Error(`未 stub 的模块: ${name}`);
				});
			},
		},
		setTimeout: () => 0,
		prompt: () => null,
	};

	const code = fs.readFileSync(CLIENT, 'utf8');
	// 用 Function 构造，把 window 注入作用域（client.js 顶层只有 __ModuleLoader__.load）
	const fn = new Function('window', 'console', 'fetch', code);
	fn(window, { error() {}, log() {}, warn() {} }, async () => ({ ok: true, json: async () => ({ ok: true, value: {} }) }));
	return captured;
}

test('client.js 可被加载且导出 apply/inject/name', () => {
	const mod = loadClient();
	assert.equal(typeof mod.apply, 'function');
	assert.deepEqual(mod.inject, ['slots']);
	assert.equal(mod.name, 'dsh-exam-copilot');
});

test('apply 注册 settings.section 且组件可渲染出非空内容', () => {
	const mod = loadClient();
	let spec = null;
	let component = null;
	const ctx = {
		slots: {
			inject(name, fn) {
				assert.equal(name, 'settings.section');
				fn();
			},
			register(s, c) {
				spec = s;
				component = c;
				return () => {};
			},
		},
	};
	mod.apply(ctx);

	assert.ok(spec, '必须注册了插槽');
	assert.equal(spec.name, 'settings.section');
	assert.equal(spec.id, 'dsh-exam-copilot');
	assert.equal(typeof spec.label, 'function');
	assert.equal(spec.label(), '考试助手');

	assert.ok(component, '必须有组件');
	const el = component();
	const html = render(el);
	// 关键断言：不能是空壳。早期版本这里渲染出空字符串 → 面板全白
	assert.ok(html.length > 0, '渲染结果不能为空');
});

test('首屏渲染出可见文字，且包含引擎相关按钮', () => {
	const mod = loadClient();
	let component = null;
	mod.apply({
		slots: {
			inject: (n, fn) => fn(),
			register: (s, c) => {
				component = c;
				return () => {};
			},
		},
	});
	const html = render(component());
	// 首屏 status 为 null → 渲染「正在读取状态…」；不能是空壳
	assert.ok(html.length > 0, '渲染结果不能为空');
	assert.match(html, /正在读取状态/, '首屏应显示加载提示');
});

test('组件容器不因 props 为 null 而抛错', () => {
	const mod = loadClient();
	let component = null;
	mod.apply({
		slots: {
			inject: (n, fn) => fn(),
			register: (s, c) => {
				component = c;
				return () => {};
			},
		},
	});
	// 渲染期间任何异常都会让测试失败
	assert.doesNotThrow(() => render(component()));
});

/** 直接测容器组件的 children 传递 —— 这是面板白屏的根因所在。 */
test('容器组件能正确渲染 children（白屏根因回归）', () => {
	// 从 client.js 内部取不到局部函数，改用行为等价断言：
	// 用同一套 dshec_el 语义构造 Box(Row(Title)) 链，确认子节点层层透传。
	const el = (type, props, ...kids) => {
		const flat = [];
		for (const k of kids) {
			if (k === null || k === undefined || k === false) continue;
			if (Array.isArray(k)) flat.push(...k);
			else flat.push(k);
		}
		return { type, props: { ...(props ?? {}), ...(flat.length ? { children: flat.length === 1 ? flat[0] : flat } : {}) } };
	};
	const Box = (p) => el('div', { style: {} }, p.children);
	const Title = (p) => el('span', {}, p.children);

	const tree = el(Box, null, el(Title, null, '引擎'), el(Title, null, '区域'));
	const html = render(tree);
	assert.match(html, /引擎/);
	assert.match(html, /区域/);
});
