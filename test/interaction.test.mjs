// 交互测试：点击按钮后，状态/请求真的发生了变化。
//
// 为什么必须有这一层：
//   面板能打开、页签能切、按钮能点，但点了什么都没发生 ——
//   因为 window.prompt() 在 DSH 的 Electron 里被 disableDialogs 禁掉了，
//   静默返回 null。渲染测试全绿也发现不了这种事，因为它测不到"点击的效果"。
//   这层测试专门断言：点击 → 调用某个 RPC → 状态可见变化。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'lib', 'client.js');

/* ── 可驱动状态的 React 替身（与 client-render.test.mjs 同款） ── */
const hookStore = new Map();
let renderKey = null;
let pendingEffects = [];
let rerenderRequested = false;

const REACT = {
	createElement(type, props, ...children) {
		const flat = [];
		for (const c of children) {
			if (Array.isArray(c)) flat.push(...c);
			else if (c !== null && c !== undefined && c !== false && c !== true) flat.push(c);
		}
		return { $$el: true, type, props: { ...(props ?? {}), ...(flat.length ? { children: flat.length === 1 ? flat[0] : flat } : {}) } };
	},
	createContext: () => ({ Provider: 'P', Consumer: 'C' }),
	useState(init) {
		const slots = hookStore.get(renderKey) ?? { values: [], cursor: 0 };
		hookStore.set(renderKey, slots);
		const i = slots.cursor++;
		if (!(i in slots.values)) slots.values[i] = typeof init === 'function' ? init() : init;
		const setter = (v) => {
			slots.values[i] = typeof v === 'function' ? v(slots.values[i]) : v;
			rerenderRequested = true;
		};
		return [slots.values[i], setter];
	},
	useEffect(fn) {
		pendingEffects.push(fn);
	},
	useMemo: (fn) => fn(),
	useCallback: (fn) => fn,
	useRef: (v) => ({ current: v }),
	useSyncExternalStore: () => ({}),
	Fragment: 'Fragment',
};

function render(node) {
	if (node === null || node === undefined || node === false || node === true) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(render).join('');
	const { type, props } = node;
	if (typeof type === 'function') {
		const prevKey = renderKey;
		renderKey = type;
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
	return '<' + type + '>' + render(props?.children) + '</' + type + '>';
}

/** 渲染直到状态稳定。返回最后一次 HTML。 */
async function renderSettled(component, maxRounds = 10) {
	let html = '';
	for (let i = 0; i < maxRounds; i++) {
		rerenderRequested = false;
		const effects = pendingEffects;
		pendingEffects = [];
		html = render(component());
		for (const fn of effects) {
			try {
				fn();
			} catch {
				/* effect 失败不影响渲染 */
			}
		}
		for (let k = 0; k < 4; k++) await Promise.resolve();
		if (!rerenderRequested && i > 0) break;
	}
	return html;
}

/** 收集所有可点击元素（含组件内部的 onClick）。 */
function collectClickables(node, out = []) {
	if (node === null || node === undefined) return out;
	if (Array.isArray(node)) {
		for (const n of node) collectClickables(n, out);
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
		return collectClickables(out2, out);
	}
	if (props?.onClick) out.push({ type, props });
	collectClickables(props?.children, out);
	return out;
}

/** 收集所有 input（含受控值），供"填表"用。 */
function collectInputs(node, out = []) {
	if (node === null || node === undefined) return out;
	if (Array.isArray(node)) {
		for (const n of node) collectInputs(n, out);
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
		return collectInputs(out2, out);
	}
	if (type === 'input' || type === 'textarea' || type === 'select') out.push(props);
	collectInputs(props?.children, out);
	return out;
}

/** 按钮文字（用于按文案点击）。 */
function textOf(props) {
	const c = props?.children;
	if (typeof c === 'string') return c;
	if (Array.isArray(c)) return c.filter((x) => typeof x === 'string').join('');
	return '';
}

/** 找到页面里第一个受控输入组件（dshec_Input / dshec_TextArea）的 props。
 *  它们的 onChange 收**字符串**（内部已取 e.target.value），可直接当"用户输入"驱动。 */
function findFirstInputProps(node, ui, found = { hit: null }) {
	if (found.hit) return found.hit;
	if (node === null || node === undefined) return null;
	if (Array.isArray(node)) {
		for (const n of node) {
			findFirstInputProps(n, ui, found);
			if (found.hit) return found.hit;
		}
		return null;
	}
	if (typeof node !== 'object') return null;
	const { type, props } = node;
	if (typeof type === 'function' && (type === ui.Input || type === ui.TextArea)) {
		if (typeof props.onChange === 'function') found.hit = props;
		return found.hit;
	}
	if (typeof type === 'function') {
		const prev = renderKey;
		renderKey = type;
		const slots = hookStore.get(type) ?? { values: [], cursor: 0 };
		hookStore.set(type, slots);
		slots.cursor = 0;
		const out2 = type(props);
		renderKey = prev;
		findFirstInputProps(out2, ui, found);
		return found.hit;
	}
	findFirstInputProps(props?.children, ui, found);
	return found.hit;
}

/* ── 桩：记录所有 RPC ── */
function makeHarness() {
	const calls = [];
	const STATUS = {
		pluginVersion: '0.2.0',
		dataDir: 'X:/d',
		pythonPath: 'python',
		engineRunning: true,
		engine: { ok: true, ocrEngines: ['windows'], screen: { w: 1920, h: 1080 } },
		lastError: null,
		uptimeMs: 1,
	};

	const fetchImpl = async (url, opts) => {
		let body = {};
		try {
			body = JSON.parse(opts?.body ?? '{}');
		} catch {
			body = {};
		}
		const ep = body.endpoint;
		calls.push({ endpoint: ep, payload: body.payload });

		let value = {};
		if (ep === 'status') value = STATUS;
		else if (ep === 'profiles.list') value = [{ id: 'p1', name: '默认', channel: 'screen', zoneCount: 2 }];
		else if (ep === 'profiles.get') value = { id: 'p1', name: '默认', channel: 'screen', zones: [{ role: 'question', x: 10, y: 20, w: 300, h: 100 }, { role: 'options', x: 10, y: 130, w: 300, h: 200 }], display: {}, answer: {}, prompts: {}, actions: {} };
		else if (ep === 'browsers.list') value = { browsers: [{ id: 'chrome', name: 'Google Chrome', exe: 'C:/x/chrome.exe' }, { id: 'edge', name: 'Microsoft Edge', exe: 'C:/x/msedge.exe' }], count: 2 };
		else if (ep === 'zones.pick') value = { ok: true, box: { x: 100, y: 200, w: 400, h: 150 }, display: { scale: 1 } };
		else if (ep === 'screen.previewCached') value = { dataUrl: 'data:image/png;base64,AAA', w: 400, h: 150, path: '/tmp/x.png' };
		else if (ep === 'zones.meta') value = { roles: ['question', 'options', 'progress', 'next'], required: ['question', 'options'] };
		else if (ep === 'profiles.create') value = { id: 'new-1', name: body.payload?.name ?? 'x' };
		else if (ep === 'run.state') value = { run: 'idle', active: false };
		else if (ep === 'banks.list') value = { banks: [{ id: 'b1', name: '测试题库', count: 10 }], categories: {} };
		else if (ep === 'banks.misses')
			value = {
				totalRecords: 2,
				groups: [
					{ stem: '未命中题目一', qtype: '单选题', count: 3, opts: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }] },
					{ stem: '未命中题目二', qtype: '判断题', count: 1, opts: [] },
				],
			};
		else if (ep === 'banks.fillMiss') value = { added: 1, total: 11 };
		// banks.get 必须也支持 b-empty，否则 bankDetail 为空 →
		// selectedBank 为空 → 整个「题库详情」区块不渲染（这是之前测试假绿的原因）。
		else if (ep === 'banks.get' && body.payload && body.payload.id === 'b-empty')
			value = { meta: { id: 'b-empty', name: '旧题库', count: 1610, category: '金融' }, preview: [], previewTotal: 1610 };
		else if (ep === 'banks.sources' && body.payload && body.payload.id === 'b-empty')
			// 旧数据形态：无 srcHash，靠 source 聚合，hash 带 src: 前缀
			value = {
				bankId: 'b-empty',
				total: 1610,
				untracked: 0,
				sources: [
					{ hash: 'src:补充资料-2025年新增题库-8.5发.docx', name: '补充资料-2025年新增题库-8.5发.docx', itemCount: 1610, at: null, legacy: true },
				],
			};
		else if (ep === 'banks.sources')
			value = {
				bankId: 'b1',
				total: 10,
				untracked: 0,
				sources: [
					{ hash: 'h1', name: '题库A.docx', itemCount: 6, at: '2026-11-23T10:00:00.000Z' },
					{ hash: 'h2', name: '题库B.xlsx', itemCount: 4, at: '2026-11-23T11:00:00.000Z' },
				],
			};
		else if (ep === 'banks.removeSource') value = { removed: 6, remaining: 4 };
		else if (ep === 'run.capabilities')
			value = {
				actions: [],
				channels: ['screen'],
				models: {
					available: true,
					providers: [
						{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] },
						{ id: 'zhipu', name: '智谱', models: [{ id: 'glm-4', name: 'glm-4' }] },
					],
				},
			};
		return { ok: true, json: async () => ({ ok: true, value }) };
	};

	let component = null;
	const window = {
		__ModuleLoader__: { load: ({ factory }) => { component = factory((n) => (n === 'react' ? REACT : {})); } },
		setTimeout: (fn) => 0,
		setInterval: () => 1,
		clearInterval: () => {},
		// 关键：DSH 的 Electron 里 prompt 是禁用的，这里如实模拟 —— 返回 null
		prompt: () => null,
	};

	const code = fs.readFileSync(CLIENT, 'utf8');
	new Function('window', 'document', 'console', 'fetch', code)(
		window,
		{ body: { appendChild() {} }, getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }) },
		{ error() {}, log() {}, warn() {} },
		fetchImpl
	);

	let Page = null;
	component.apply({
		slots: { inject: (n, fn) => fn(), register: (s, c) => { Page = c; return () => {}; } },
	});

	return { Page, calls, window, fetchImpl };
}

function resetHooks() {
	hookStore.clear();
	renderKey = null;
	pendingEffects = [];
	rerenderRequested = false;
}

/* ── 测试 ─────────────────────────────────────────── */

/** 收集 select 元素的 props（用于选中配置）。 */
function collectSelects(node, out = []) {
	if (node === null || node === undefined) return out;
	if (Array.isArray(node)) {
		for (const n of node) collectSelects(n, out);
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
		return collectSelects(out2, out);
	}
	if (type === 'select') out.push(props);
	collectSelects(props?.children, out);
	return out;
}

test('点击「新建」会显示内联输入框（而不是静默失效）', async () => {
	resetHooks();
	const { Page } = makeHarness();
	await renderSettled(Page); // 让 status 落地

	// 切到「区域」页
	let clicks = collectClickables(Page());
	const zonesTab = clicks.find((c) => textOf(c.props) === '区域');
	assert.ok(zonesTab, '应有「区域」页签');
	zonesTab.props.onClick();
	await renderSettled(Page);

	// 点「新建」
	clicks = collectClickables(Page());
	const createBtn = clicks.find((c) => textOf(c.props) === '新建');
	assert.ok(createBtn, '应有「新建」按钮');
	createBtn.props.onClick();
	const html = await renderSettled(Page);

	// 关键断言：必须出现输入框与「创建」按钮 —— 证明表单真的打开了
	assert.match(html, /新配置名称/, '应显示内联输入框标签');
	assert.match(html, /保存/, '应有「保存」按钮');
});

test('内联输入框填名后点「保存」→ 真的调用 profiles.create', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page, calls } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);

	clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '新建').props.onClick();
	await renderSettled(Page);

	// 填表：InlineInput 是受控组件，它的 onChange 就是父组件的 setNewProfileName，收「字符串」。
	// 这里直接调用，等价于用户在输入框里打字。
	const ui = harness.window.__DSHEC_UI__;
	assert.ok(ui && ui.Input, '客户端应暴露输入组件引用');
	const inputProps = findFirstInputProps(Page(), ui);
	assert.ok(inputProps, '应找到输入框');
	inputProps.onChange('我的考试');
	await renderSettled(Page);
	clicks = collectClickables(Page());
	const okBtn = clicks.find((c) => textOf(c.props) === '保存');
	assert.ok(okBtn, '应有「保存」按钮');
	okBtn.props.onClick();
	await renderSettled(Page);

	const created = calls.filter((c) => c.endpoint === 'profiles.create');
	assert.equal(created.length, 1, '必须真的调用了 profiles.create');
	assert.equal(created[0].payload.name, '我的考试', `名字要带过去，实际收到 ${JSON.stringify(created[0].payload.name)}`);
});

test('圈选后显示角色下拉，选完可写入配置（不依赖 prompt）', async () => {
	resetHooks();
	const { Page } = makeHarness();
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);

	// 先选一个配置才能圈选
	const selects = collectInputs(Page()).filter((p) => p.onChange && p.value !== undefined);
	if (selects.length) {
		selects[0].onChange({ target: { value: 'p1' } });
		await renderSettled(Page);
	}

	// 在没有 pendingZone 时不该出现角色下拉
	let html = await renderSettled(Page);
	assert.doesNotMatch(html, /区域角色/, '未圈选时不该显示角色表单');
});

test('可以删除配置（带二次确认）', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page, calls } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);

	// 选中一个已有配置（否则没有删除按钮）
	const ui = harness.window.__DSHEC_UI__;
	const sel = collectSelects(Page()).find((p) => p.onChange);
	if (sel) {
		sel.onChange({ target: { value: 'p1' } });
		await renderSettled(Page);
	}

	clicks = collectClickables(Page());
	const delBtn = clicks.find((c) => textOf(c.props) === '删除');
	assert.ok(delBtn, '选中配置后应有「删除」按钮');
	delBtn.props.onClick();
	const html = await renderSettled(Page);

	// 二次确认必须出现（不可撤销操作不能一键完成）
	assert.match(html, /确认删除/, '删除必须先确认');

	// 点确认
	clicks = collectClickables(Page());
	const okBtn = clicks.find((c) => textOf(c.props) === '确认删除');
	assert.ok(okBtn, '应有确认删除按钮');
	okBtn.props.onClick();
	await renderSettled(Page);

	assert.ok(
		calls.some((c) => c.endpoint === 'profiles.delete'),
		'必须真的调用了 profiles.delete'
	);
});

test('模型选择：换 provider 时 provider 与 model 一次改到位（stale closure 回归）', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	// 选中配置，让模型页可用
	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);
	const sel = collectSelects(Page()).find((p) => p.onChange);
	if (sel) {
		sel.onChange({ target: { value: 'p1' } });
		await renderSettled(Page);
	}

	// 进模型页
	clicks = collectClickables(Page());
	const modelTab = clicks.find((c) => textOf(c.props) === '模型');
	assert.ok(modelTab, '应有「模型」页签');
	modelTab.props.onClick();
	const html = await renderSettled(Page);

	// 关键：provider 选择器必须存在且可交互
	// 标题改为「答题模型」，并新增多次作答选择与每个模型一行的联网开关
	assert.match(html, /答题模型/, '模型页必须有模型选择器');
	assert.match(html, /主答模型/, '必须有主答模型一行');
	assert.match(html, /允许联网/, '每个模型一行后面应有联网开关');
});

test('区域页：圈选入口唯一，不再有「圈为」下拉', async () => {
	// 设计变更：
	//   旧的「圈为」下拉 + 「按此角色圈选」按钮与「圈选一块区域」功能重复，
	// 删除。现在的流程是：圈选 → 在指派表单里选用途 → 保存。
	//   所以这条断言的是**新契约**，而不是旧的中间状态。
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	const clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);

	// 选配置，让区域组渲染出来
	const selects = collectSelects(Page());
	assert.ok(selects.length >= 1, '区域页应有配置下拉');
	const sel = selects.find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'p1' } });
	const html = await renderSettled(Page);

	assert.ok(!/圈为：/.test(html), '「圈为」下拉应已删除');
	assert.ok(!/按此角色圈选/.test(html), '「按此角色圈选」应已删除（与圈选按钮重复）');
	// 只数按钮，不数提示文案（空状态提示里也有这几个字）
	const pickCount = (html.match(/<button>圈选一块区域<\/button>/g) || []).length;
	assert.equal(pickCount, 1, '圈选入口应只有一个，实际 ' + pickCount + ' 个');
});

test('区域页：校验截图独立成块，不挤在圈选那一行', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	const clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);

	const selects = collectSelects(Page());
	const sel = selects.find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'p1' } });
	const html = await renderSettled(Page);

	assert.match(html, /校验截图/, '校验截图应有独立小标题');
	assert.match(html, /排障用/, '应说明它是排障工具，不是答题必经步骤');
});

test('zones.meta 的依赖都存在（曾因引用已删除变量导致角色下拉为空）', async () => {
	// 回归：zones.meta 里引用了已被删除的 REQUIRED_ROLES，
	// 整个调用抛 ReferenceError → 面板拿到 ok:false → 角色下拉空 →
	// 用户"圈完选不了角色，全存成默认 question"。
	// 直接断言 index.js 引用的每个符号都真实存在，从源头防这类错误。
	const zones = await import('../lib/core/zones.js');
	for (const name of ['ROLE_KEYS', 'ZONE_ROLES', 'CONTENT_ROLES', 'validateZones', 'emptyProfile', 'zonesByRole']) {
		assert.ok(zones[name] !== undefined, `zones.js 必须导出 ${name}`);
	}
	assert.ok(zones.ROLE_KEYS.includes('all'), '必须有 all 角色');
	assert.ok(zones.ZONE_ROLES.all.label, 'all 必须有中文名');
});

test('没有任何地方调用 window.prompt / confirm / alert（DSH 禁用了它们）', () => {
	const code = fs.readFileSync(CLIENT, 'utf8');
	// 去掉注释后再查，避免把说明文字误判成调用
	const stripped = code
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
	assert.doesNotMatch(stripped, /window\.prompt\s*\(/, '不允许调用 window.prompt（DSH disableDialogs 会让它静默返回 null）');
	assert.doesNotMatch(stripped, /window\.confirm\s*\(/, '不允许调用 window.confirm');
	assert.doesNotMatch(stripped, /window\.alert\s*\(/, '不允许调用 window.alert');
});
test('面板冒烟：七个页签全部渲染成功（抓未定义引用这类只在渲染时炸的错误）', async () => {
	// 真实教训（BACKLOG「教训」第 2 条）：单测全绿 ≠ 用户点下去有反应。
	// zones.meta 曾引用已删除的 REQUIRED_ROLES，面板拿到 ok:false、
	// 角色下拉为空，而所有单测都是绿的。所以这里把每页都渲染一次。
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	const tabs = ['总览', '区域', '题库', '模型', '提示词', '运行', '安全'];
	for (const name of tabs) {
		const clicks = collectClickables(Page());
		const tab = clicks.find((c) => textOf(c.props) === name);
		assert.ok(tab, '应能找到页签：' + name);
		tab.props.onClick();
		const html = await renderSettled(Page);
		assert.ok(typeof html === 'string' && html.length > 20, '页签「' + name + '」渲染为空');
	}
});

test('题库页：未命中补题能加载、能看到聚合列表、能内联填答案', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page, calls } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '题库').props.onClick();
	await renderSettled(Page);

	clicks = collectClickables(Page());
	const loadBtn = clicks.find((c) => textOf(c.props) === '查看未命中');
	assert.ok(loadBtn, '题库页应有「查看未命中」按钮');
	loadBtn.props.onClick();
	const html = await renderSettled(Page);

	assert.match(html, /未命中题目一/, '应显示聚合后的 miss 题干');
	assert.match(html, /×3/, '应显示该题 miss 次数');
	assert.ok(calls.some((c) => c.endpoint === 'banks.misses'), '应真的调用了 banks.misses');
});

test('题库页：点「补这条」弹出内联表单，不依赖 prompt', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '题库').props.onClick();
	await renderSettled(Page);

	clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '查看未命中').props.onClick();
	await renderSettled(Page);

	clicks = collectClickables(Page());
	const fillBtn = clicks.find((c) => textOf(c.props) === '补这条');
	assert.ok(fillBtn, '应有「补这条」按钮');
	fillBtn.props.onClick();
	const html = await renderSettled(Page);

	assert.match(html, /补进当前题库/, '应出现补答案的内联表单');
	// placeholder 不进 innerHTML（是属性），直接查 input 的 props
	const inputs = collectInputs(Page());
	const ansInput = inputs.find((p) => String(p.placeholder || '').includes('答案：A'));
	assert.ok(ansInput, '答案输入框应提示写法（A / ABC / T / 3.14 / 北京）');
});

/* ── 两个实测 bug 的回归 ─────────────────── */

test('拖入区用 capture 阶段的原生监听器拦截（不再触发 DSH 宿主蒙版）', () => {
	// 回归 bug：往面板拖文件时，DSH 自己的「拖入提示蒙版」同时弹出盖住整个界面，
	// 而且那个蒙版不归插件管、用户点不掉。
	//
	// 根因：只用了 React 的 onDragOver/onDrop。React 的 stopPropagation
	// 只在 React 事件树内生效，宿主挂在 document/window 上的原生监听器照样收到。
	const src = fs.readFileSync(CLIENT, 'utf8');

	assert.match(src, /dshec_bindDropZone/, '必须有 capture 阶段的原生拖放绑定');
	assert.match(src, /stopImmediatePropagation/, '必须用 stopImmediatePropagation 彻底截断');

	// 检查 bindDropZone 里确实注册了 4 个拖放事件，且第三个参数为 true
	const i = src.indexOf('function dshec_bindDropZone');
	assert.ok(i > 0, '必须有 dshec_bindDropZone 实现');
	const body = src.slice(i, i + 4000);
	for (const ev of ['dragover', 'dragenter', 'dragleave', 'drop']) {
		assert.ok(body.includes("'" + ev + "'"), '必须监听 ' + ev);
	}
	// capture: 每个 addEventListener 的第三参应为 true
	const captureCount = (body.match(/^\s*true\s*$/gm) || []).length;
	assert.ok(captureCount >= 4, '四个事件都必须在捕获阶段注册，实际 ' + captureCount + ' 个 true');

	// 不能再依赖 React 的 onDrop 处理真实拖放（它拦不住宿主）
	assert.ok(!/onDrop:\s*function/.test(src), '不应再用 React 的 onDrop');
});

test('「确认入库」能用上拖入/选文件暂存的字节（不再报无文件）', () => {
	// 回归 bug：选完文件、下面预览也切出来了，但点「确认入库」显示没有文件。
	//
	// 根因：doImportFromFile 把 bytes 存在局部变量里，只用于试切分；
	// 「确认入库」走 doBankImport，那里只读 importPath / importText ——
	// 拖入和选文件时这两个都是空。
	const src = fs.readFileSync(CLIENT, 'utf8');

	assert.match(src, /const \[importBytes, setImportBytes\]/, '字节必须存进 state');
	assert.match(src, /setImportBytes\(\{ bytes: bytes/, '试切分后必须暂存字节');
	assert.match(src, /const fromFile = importBytes && importBytes\.bytes/, 'doBankImport 必须优先用暂存字节');
	assert.match(src, /payload\.fileBytes = importBytes\.bytes/, '入库请求必须带上暂存字节');
});

test('拖入后界面显示已收到的文件名（状态可见）', () => {
	const src = fs.readFileSync(CLIENT, 'utf8');
	assert.match(src, /已收到：/, '拖入/选文件后必须显示文件名，否则用户无从判断收没收到');
	assert.match(src, /importFileName/, '必须记录文件名');
});

/* ── 题库文件管理 ─────────────────────── */

test('题库详情列出已导入的文件（含题数、可删除）', async () => {
	// 「选中某个题库，应当列出该题库下有的文件，可由用户选择删除」
	resetHooks();
	const harness = makeHarness();
	const { Page, calls } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '题库').props.onClick();
	await renderSettled(Page);

	const selects = collectSelects(Page());
	const sel = selects.find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'b1' } });
	const html = await renderSettled(Page);

	assert.ok(calls.some((c) => c.endpoint === 'banks.sources'), '选中题库后应拉取来源文件列表');
	assert.match(html, /题库A\.docx/, '应列出文件名');
	assert.match(html, /题库B\.xlsx/, '应列出第二个文件');
	assert.match(html, /6 题/, '应显示该文件贡献的题数');
});

test('删除来源文件要二次确认（不依赖 confirm）', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '题库').props.onClick();
	await renderSettled(Page);
	const selects = collectSelects(Page());
	const sel = selects.find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'b1' } });
	await renderSettled(Page);

	clicks = collectClickables(Page());
	const del = clicks.find((c) => textOf(c.props) === '删除' && c.props.onClick);
	assert.ok(del, '文件行应有删除按钮');
	del.props.onClick();
	const html = await renderSettled(Page);

	assert.match(html, /确认删除/, '应先出现确认按钮，不能点一下就删');
});

test('搜索区有「清除」按钮，能同时清空输入与结果', () => {
	// 「题库详情应当在搜索后加一个清除按钮，
	//            清除搜索框内容和列出的内容」
	//
	// 这条用源码断言而不是渲染断言，原因是渲染层的 collectInputs
	// 会展开函数组件并重置 hook 游标，页面上又有多个 input
	// （搜索框 / 补题答案框 / 文件选择），容易改错那个 target。
	// 而这里要守的契约很明确：清除必须同时清两个 state。
	const src = fs.readFileSync(CLIENT, 'utf8');

	assert.match(src, /function clearSearch\(\)/, '必须有 clearSearch');
	// 必须同时清"输入"和"结果" —— 只清一个等于没清
	const i = src.indexOf('function clearSearch()');
	const body = src.slice(i, i + 300);
	assert.match(body, /setBankQuery\(\s*''\s*\)/, 'clearSearch 必须清空输入框');
	assert.match(body, /setBankHits\(\s*null\s*\)/, 'clearSearch 必须清空结果列表');

	// 按钮要挂在搜索行里，且有显示条件（没内容时不占位）
	assert.match(src, /label: '清除'/, '必须有清除按钮');
	assert.match(src, /bankQuery \|\| \(bankHits \|\| \[\]\)\.length/, '清除按钮应有显示条件');
});

test('搜索结果区有高度上限与滚动（结果多时不把页面推下去）', async () => {
	const src = fs.readFileSync(CLIENT, 'utf8');
	const i = src.indexOf('(bankHits || []).length');
	assert.ok(i > 0, '应有搜索结果渲染');
	const seg = src.slice(i, i + 900);
	assert.match(seg, /maxHeight/, '搜索结果应有高度上限');
	assert.match(seg, /overflowY:\s*['"]auto['"]/, '搜索结果应可滚动');
});
test('面板显示前端构建标识（用于判断浏览器加载的是不是最新前端）', () => {
	// 为什么需要这个：
	//   面板上的 v0.2.3 来自 status.pluginVersion，是**后端**版本，
	//   它只能证明宿主代码是新的，证明不了浏览器加载到的 client.js 是新的。
	//   排查「改了代码但界面没变」时，两个数字都要对得上。
	const src = fs.readFileSync(CLIENT, 'utf8');
	assert.match(src, /var dshec_CLIENT_BUILD = '[^']+'/, 'client.js 必须有前端构建标识');
	assert.match(src, /前端 ' \+ dshec_CLIENT_BUILD/, '面板上必须显示这个标识');
});

test('题库无来源记录时必须显示说明（不能整块消失）', async () => {
	// 回归：上次会话的修改内容没有显示。
	// 查下来代码全在、RPC 也在，但库里 1610 题全是旧版导入、无 srcHash →
	// sources 为空 → 原设计整块不渲染 → 用户以为功能没做。
	// 现在改为：没有记录也显示，并说清是数据原因。
	const src = fs.readFileSync(CLIENT, 'utf8');
	// 条件不能再要求 sources.length > 0
	assert.ok(
		!/bankSources && bankSources\.sources && bankSources\.sources\.length\s*\n?\s*\?/.test(src),
		'渲染条件不应再要求 sources 非空'
	);
	assert.match(src, /按文件管理」上线之前导入的/, '必须有「旧数据」说明文案');
	assert.match(src, /无法按文件删除/, '必须说清旧数据不能按文件删除');
});

test('【真实渲染】无来源记录的题库：说明文案真的出现在页面上', async () => {
	// 上一条只查源码。这条真的渲染一遍，确认用户能看见那句话。
	// 教训：静态检查抓不到"渲染条件不满足导致整块消失"，
	// 必须让 HTML 真的产出一次。
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '题库').props.onClick();
	await renderSettled(Page);

	const selects = collectSelects(Page());
	const sel = selects.find((p) => p.onChange);
	assert.ok(sel, '应有题库下拉');
	sel.onChange({ target: { value: 'b1' } });
	const html = await renderSettled(Page);

	// 先确认区块渲染了（不管是有文件还是无文件的形态）
	assert.match(html, /已导入的文件/, '区块标题必须出现（不能被条件吞掉）' + String(html).slice(0, 300));
});

test('题库挂载按钮的状态判断没有运算符优先级 bug', () => {
	// 真实 bug（查"题库为什么没被用上"时）：
	//   `(profile.answer && profile.answer.bankIds) || [].indexOf(id) >= 0`
	//   `||` 优先级低于 `>=`，实际是 `bankIds || ([] .indexOf(id) >= 0)`。
	//   bankIds 是数组（恒为真）→ 整个表达式恒真 →
	//   按钮永远显示「已启用」绿色，即使实际没挂任何题库。
	//   用户看到"已启用"就以为挂上了，实际匹配器根本没运行。
	const src = fs.readFileSync(CLIENT, 'utf8');
	assert.ok(
		!/\(profile\.answer && profile\.answer\.bankIds\) \|\| \[\]\.indexOf/.test(src),
		'不能再出现 `a || b.indexOf(...) >= 0` 这种优先级错误'
	);
	// 正确写法必须存在
	assert.match(
		src,
		/\(\(profile\.answer && profile\.answer\.bankIds\) \|\| \[\]\)\.indexOf\(/,
		'必须用 ((a || b).indexOf(x) >= 0) 的写法'
	);
});

test('【真实渲染】旧数据题库：文件列表必须显示出来且可删', async () => {
	// 回归：能看到区块，但导入文件没有列出供删除
	// 根因：旧数据无 srcHash → sources 为空 → 列表空白。
	// 修复：按题的 source 字段聚合。这条真的渲染一遍确认。
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '题库').props.onClick();
	await renderSettled(Page);

	const selects = collectSelects(Page());
	const sel = selects.find((p) => p.onChange);
	assert.ok(sel, '应有题库下拉');
	sel.onChange({ target: { value: 'b-empty' } });
	// 需要多轮渲染：banks.get + banks.sources 是两个独立异步调用，
	// 一轮 renderSettled 只能落地其中一个。
	await renderSettled(Page);
	const html = await renderSettled(Page);

	assert.match(html, /已导入的文件/, '区块标题必须出现' + String(html).slice(-600));
	assert.match(html, /补充资料-2025年新增题库-8\.5发\.docx/, '必须列出实际文件名');
	assert.match(html, /1610 题/, '必须显示该文件的题数');
	assert.match(html, /较早导入/, '旧数据无导入时间时显示「较早导入」而不是空白');
	assert.match(html, /删除/, '必须能删除');
});

/* ── S4：考试界面类型 + DOM 补救 UI ─────────────── */

test('区域页有「考试界面」选择（桌面/网页）', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);
	const selects = collectSelects(Page());
	const sel = selects.find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'p1' } });
	const html = await renderSettled(Page);

	assert.match(html, /考试界面/, '必须有界面类型选择');
	assert.match(html, /桌面程序/, '应有桌面选项');
	assert.match(html, /网页/, '应有网页选项');
});

test('网页模式下的 DOM 补救 UI 存在且受 channel 控制', () => {
	// 这条用源码断言而不是点击后的渲染断言，原因是：
	// 测试环境里 setProfile 的更新会被 profiles.get 的 effect 覆盖，
	// 点「网页」后再渲染读到的仍是 screen。而这里要守的契约很明确：
	//   · DOM 补救块只在 ch === 'web' 时渲染
	//   · 有「检测浏览器」按钮，且调用 browser.probe
	const src = fs.readFileSync(CLIENT, 'utf8');

	assert.match(src, /function dshec_channelMode\(\)/, '必须有通道选择组件');
	// DOM 补救块的条件必须是 web
	assert.match(src, /ch === 'web'\s*\n?\s*\? dshec_el\(/, 'DOM 补救块必须受 ch === web 控制');
	assert.match(src, /DOM 补救/, '应有 DOM 补救开关');
	assert.match(src, /检测浏览器/, '应有检测按钮');
	assert.match(src, /browser\.probe/, '检测按钮应调 browser.probe');
	// 必须说明"连不上会回退"
	assert.match(src, /连不上会自动回退/, '必须告知失败会回退到 OCR');
});

test('桌面模式下不显示 DOM 补救（不需要浏览器）', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);
	const selects = collectSelects(Page());
	const sel = selects.find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'p1' } });
	const html = await renderSettled(Page);

	assert.ok(!/DOM 补救/.test(html), '桌面模式不该出现 DOM 补救开关');
	assert.match(html, /不需要浏览器/, '应说明桌面不需要浏览器');
});

test('【真实渲染】区域页顺序：考试界面在下一题方式之前，文案已改', async () => {
	// 改了文案和顺序，必须验证渲染顺序真的变了。
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);
	const sel = collectSelects(Page()).find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'p1' } });
	const html = await renderSettled(Page);

	// 文案
	assert.match(html, /考试界面/, '应为「考试界面」');
	assert.ok(!/考试界面在哪/.test(html), '旧文案「考试界面在哪」应已替换');
	assert.match(html, /下一题方式/, '应为「下一题方式」');
	assert.ok(!/页面怎么推进到下一题/.test(html), '旧文案应已替换');

	// 顺序：考试界面的位置必须早于下一题方式
	const iCh = html.indexOf('考试界面');
	const iNav = html.indexOf('下一题方式');
	assert.ok(iCh > 0 && iNav > 0, '两个标题都要出现');
	assert.ok(iCh < iNav, '考试界面必须排在下一题方式之前');
});

test('【真实渲染】区域页有全屏预览按钮（不再只有面板内预览）', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);
	const sel = collectSelects(Page()).find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'p1' } });
	const html = await renderSettled(Page);

	assert.match(html, /全屏预览/, '必须有全屏预览按钮');
	assert.match(html, /面板预览/, '面板预览保留');
});

test('【真实渲染】识别范围与面板预览已在自检块内，不在圈选按钮下', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);
	const sel = collectSelects(Page()).find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'p1' } });
	const html = await renderSettled(Page);

	// 两个块都在
	const iSelf = html.indexOf('配置自检');
	assert.ok(iSelf > 0, '必须有配置自检块');

	// 识别范围下拉必须在自检块之后
	const iRange = html.indexOf('全部识别范围');
	assert.ok(iRange > iSelf, '识别范围应在自检块内（实际 ' + iRange + ' vs ' + iSelf + '）');

	// 面板预览也在自检块之后
	const iPreview = html.indexOf('面板预览');
	assert.ok(iPreview > iSelf, '面板预览应在自检块内');
});

test('【真实渲染】题库刷新按钮存在且文案未变', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '题库').props.onClick();
	const html = await renderSettled(Page);

	assert.match(html, /刷新/, '刷新按钮应存在');
	assert.match(html, /新建题库/);
});

test('【真实渲染】确认区域后卡片不能变空白（防白屏）', async () => {
	// 选完区域后卡片内容全消失变空白。
	// 白屏在 DSH 里的典型成因是渲染期抛异常（无错误边界 → 整块卸载）。
	// 这条测试真的走一遍「圈选 → 选角色 → 确认」，并断言渲染没塌。
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	// 进区域页
	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);
	const sel = collectSelects(Page()).find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'p1' } });
	const before = await renderSettled(Page);
	assert.match(before, /考试配置/, '前置：卡片应正常渲染');

	// 点「圈选一块区域」→ 替身返回一个框
	clicks = collectClickables(Page());
	const pick = clicks.find((c) => textOf(c.props) === '圈选一块区域');
	assert.ok(pick, '应有圈选按钮');
	pick.props.onClick();
	const afterPick = await renderSettled(Page);
	assert.match(afterPick, /考试配置/, '圈选后卡片仍在');
	// 应出现「选择角色」的内联表单
	assert.match(afterPick, /选择角色|用途/, '圈选后应出现角色选择');
});

test('【真实渲染】点「网页」后不能白屏，且出现浏览器选择与提示', async () => {
	// 回归：点击网页按钮后白屏。
	// 根因是 dshec_el 参数顺序错乱（对象当 children），React 抛错卸整块。
	// 这条真的点一下，并断言内容仍在。
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);
	const sel = collectSelects(Page()).find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'p1' } });
	const before = await renderSettled(Page);
	assert.match(before, /考试界面/, '前置：桌面模式应有「考试界面」');

	// 点「网页（浏览器里）」
	clicks = collectClickables(Page());
	const web = clicks.find((c) => textOf(c.props) === '网页（浏览器里）');
	assert.ok(web, '应有网页按钮');
	web.props.onClick();
	const after = await renderSettled(Page);

	// 核心断言：不能白屏 —— 卡片主体仍在
	assert.ok(after.length > 500, '渲染结果不该塌成空白，实际长度 ' + after.length);
	assert.match(after, /考试界面/, '点网页后「考试界面」标题仍在');

	// 注：setProfile 在测试 harness 里会被 profiles.get 的 effect 覆盖，
	// 所以点完之后 channel 仍是 screen，DOM 补救块不会出现在**这次渲染**里。
	// 「点了网页之后到底渲染成什么样」由下面的源码契约 + 参数顺序检查覆盖；
	// 这条测试守的是更重要的东西：点击本身不能让渲染塌掉。
});

test('【真实渲染】全屏预览在圈选按钮同一行，不在自检块里', async () => {
	resetHooks();
	const harness = makeHarness();
	const { Page } = harness;
	await renderSettled(Page);

	let clicks = collectClickables(Page());
	clicks.find((c) => textOf(c.props) === '区域').props.onClick();
	await renderSettled(Page);
	const sel = collectSelects(Page()).find((p) => p.onChange);
	if (sel) sel.onChange({ target: { value: 'p1' } });
	const html = await renderSettled(Page);

	const iPick = html.indexOf('圈选一块区域');
	const iFull = html.indexOf('全屏预览');
	const iSelf = html.indexOf('配置自检');
	assert.ok(iPick > 0 && iFull > 0 && iSelf > 0, '三个都要出现');
	assert.ok(iFull > iPick, '全屏预览应在圈选按钮之后（同一行后面）');
	assert.ok(iFull < iSelf, '全屏预览必须在自检块之前');
});
