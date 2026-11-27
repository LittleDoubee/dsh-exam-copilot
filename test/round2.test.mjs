//
//
// 1. 考试界面/下一题方式 按钮形状与「圈选一块区域」一致（方形圆角，非胶囊）
// 2. 列出本机已安装浏览器让用户选（不自启新 profile、不生成快捷方式）
// 3. 全屏预览：黑框黑字、不压暗、可点选、可缩放、预览框更大
// 4. 圈选后立刻截图；识别范围+预览移进自检块
// 5. 刷新按钮必须刷新来源文件列表（否则导入后看不到文件）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CLIENT = path.join(process.cwd(), 'lib', 'client.js');
const SERVER = path.join(process.cwd(), 'engine', 'server.py');
const LAUNCH = path.join(process.cwd(), 'lib', 'core', 'browser-launch.js');

const client = () => fs.readFileSync(CLIENT, 'utf8');
const server = () => fs.readFileSync(SERVER, 'utf8');

/* ── 1. 按钮形状 ───────────────────────────────── */

test('按钮形状：不再用胶囊（999px），统一为 7px 圆角', () => {
	const src = client();
	// 只允许 Tag 组件保留 999px（它是小标签，本来就该是胶囊）
	const capsuleUses = (src.match(/999px/g) || []).length;
	assert.equal(capsuleUses, 1, '除 Tag 外不应再有胶囊按钮，实际 999px 出现 ' + capsuleUses + ' 次');

	// 基准：dshec_Btn 的 6px 14px + 7px + 13px
	assert.match(src, /padding: '6px 14px',[\s\S]{0,120}borderRadius: '7px'/, '按钮基准样式应保留');
});

test('按钮形状：两个自定义按钮的内联样式与基准一致', () => {
	const src = client();
	// navMode 的两个原生 button
	assert.ok(!/padding: '5px 14px'/.test(src), "不该再有 '5px 14px'（那是旧胶囊内距）");

	// channelMode 的 btnStyle
	const i = src.indexOf('function btnStyle(on)');
	assert.ok(i > 0);
	const body = src.slice(i, i + 600);
	assert.match(body, /padding: '6px 14px'/, 'btnStyle 内距要跟基准一致');
	assert.match(body, /borderRadius: '7px'/, 'btnStyle 圆角要跟基准一致');
	assert.match(body, /fontSize: '13px'/, 'btnStyle 字号要跟基准一致');
});

/* ── 2. 浏览器列表 ─────────────────────────────── */

test('浏览器：提供 listBrowsers，列出所有已安装的（不只是第一个）', async () => {
	const m = await import('file://' + LAUNCH.replace(/\\/g, '/'));
	assert.equal(typeof m.listBrowsers, 'function', '必须导出 listBrowsers');

	const all = m.listBrowsers();
	assert.ok(Array.isArray(all));
	for (const b of all) {
		assert.ok(b.id && b.name && b.exe, '每项要有 id/name/exe');
		assert.ok(fs.existsSync(b.exe), '路径必须真实存在: ' + b.exe);
	}
	// 去重：同一个浏览器只列一次
	const ids = all.map((x) => x.id);
	assert.equal(new Set(ids).size, ids.length, '不同浏览器不应重复列出');
});

test('浏览器：ensure 支持指定 browserId', async () => {
	const m = await import('file://' + LAUNCH.replace(/\\/g, '/'));
	const bl = new m.BrowserLauncher({ dataDir: path.join(process.cwd(), '.private') });
	// 只验证签名接受参数，不真的启动
	assert.equal(typeof bl.ensure, 'function');
	const src = fs.readFileSync(LAUNCH, 'utf8');
	assert.match(src, /async ensure\(\{ browserId \} = \{\}\)/, 'ensure 必须接受 browserId');
	assert.match(src, /installed\.find\(\(x\) => x\.id === browserId\)/, '必须优先用用户选的那个');
});

test('浏览器：不生成快捷方式', () => {
	const src = fs.readFileSync(LAUNCH, 'utf8');
	assert.ok(!/\.lnk/.test(src), '不应生成 .lnk 快捷方式');
	assert.ok(!/WScript\.Shell/.test(src), '不应调用 WScript.Shell 创建快捷方式');
});

test('浏览器：面板有选浏览器的 UI 与提示', () => {
	const src = client();
	assert.match(src, /browsers\.list/, '必须调 browsers.list');
	// 断言点：必须明确告诉用户「新窗口 + 在里面登录」，
	// 因为 Chrome 136+ 的默认 profile 不让开调试端口，
	// 不说明这点用户会以为插件在读他日常浏览器的 DOM。
	assert.match(src, /请在打开的浏览器窗口里/, '必须提示用户去新窗口');
	assert.match(src, /只有它带调试端口/, '必须说清为什么必须用那个窗口');
	assert.match(src, /不碰你日常的书签和登录/, '必须说明独立配置、不碰日常数据');
	assert.match(src, /DOM 补救/, '仍保留 DOM 补救开关');
});

/* ── 3. 全屏预览 ───────────────────────────────── */

test('全屏预览：黑框黑字（不是青色）', () => {
	const body = server().slice(server().indexOf('def _zone_preview'), server().indexOf('def _zone_pick'));
	assert.match(body, /outline="#000000"/, '框必须是黑色');
	assert.match(body, /fill="#000000"/, '文字必须是黑色');
	assert.ok(!/#22d3ee/.test(body), '不应再有青色');
});

test('全屏预览：不压暗、鼠标保持原状态', () => {
	const body = server().slice(server().indexOf('def _zone_preview'), server().indexOf('def _zone_pick'));
	assert.ok(!/stipple="gray50"/.test(body), '不应再压暗框外/框内（用户要看原图）');
	assert.ok(!/cursor="crosshair"/.test(body), '鼠标不应变成十字');
});

test('全屏预览：支持点选区域 + 缩放按钮 + 更大预览框', () => {
	const body = server().slice(server().indexOf('def _zone_preview'), server().indexOf('def _zone_pick'));
	assert.match(body, /def hit_test/, '需要命中判定（点选）');
	assert.match(body, /def zoom_in/, '需要放大');
	assert.match(body, /def zoom_out/, '需要缩小');
	assert.match(body, /PREVIEW_W = max\(420,/, '预览框宽至少 420（比之前 360 更大，且随屏幕放大）');
	assert.match(body, /PREVIEW_H = max\(240,/, '预览框高至少 240（下方还要放自检结果）');
	assert.match(body, /def on_drag/, '放大后要能拖动查看（否则超出部分看不见）');
	assert.match(body, /st\["pan"\]/, '放大后按 pan 裁出可视部分');
	assert.match(body, /ZOOM_STEPS/, '要有缩放档位');
});

test('全屏预览：Esc 全局轮询 + 右键退出仍保留', () => {
	const body = server().slice(server().indexOf('def _zone_preview'), server().indexOf('def _zone_pick'));
	assert.match(body, /GetAsyncKeyState/, 'Esc 用全局轮询');
	assert.match(body, /Button-3/, '右键兜底');
	assert.match(body, /restore_windows\(hidden\)/, '必须恢复宿主');
});

/* ── 4. 圈选后立刻截图 + 移进自检 ──────────────── */

test('圈选后立刻截图（不等用户再点预览）', () => {
	const src = client();
	const i = src.indexOf('function confirmAssignRole(role)');
	assert.ok(i > 0);
	const body = src.slice(i, i + 3000);
	assert.match(body, /screen\.previewCached/, '选完区名后必须立刻截图');
	assert.match(body, /setPreview\(/, '截图要存进预览状态');
	assert.match(body, /setPreviewPath\(/, '要记住文件路径给自检复用');
});

test('识别范围与预览已移进「配置自检」块', () => {
	const src = client();
	const iSelf = src.indexOf("'配置自检（只识别，不操作）'");
	assert.ok(iSelf > 0, '必须有自检块');

	// 取自检块之后的一大段，里面应该能找到识别范围下拉
	const after = src.slice(iSelf, iSelf + 12000);
	assert.match(after, /__all__/, '自检块里应有「全部识别范围」选项');
	assert.match(after, /previewRole/, '自检块里应有识别范围选择');
	assert.match(after, /面板预览/, '自检块里应有面板预览按钮');

	// 反向确认：圈选按钮紧邻区域不该再有识别范围下拉
	const iPick = src.indexOf("label: '圈选一块区域'");
	const near = src.slice(iPick, iPick + 1500);
	assert.ok(!/全部识别范围/.test(near), '圈选按钮下方不该再有识别范围下拉（已移走）');
});

/* ── 5. 刷新按钮 ───────────────────────────────── */

test('刷新按钮必须刷新来源文件列表（不只是题库下拉）', () => {
	const src = client();

	// refreshBankAll 必须同时做三件事
	const i = src.indexOf('async function refreshBankAll');
	assert.ok(i > 0, '必须有 refreshBankAll');
	const body = src.slice(i, i + 1200);
	assert.match(body, /loadBanks\(\)/, '要刷新题库列表');
	assert.match(body, /banks\.get/, '要刷新题库详情（题数）');
	assert.match(body, /loadBankSources/, '要刷新来源文件列表 —— 这正是用户报的问题');

	// 刷新按钮不能还是裸的 loadBanks
	assert.ok(!/label: '刷新', onClick: loadBanks \}/.test(src), '刷新按钮不该只调 loadBanks');
	assert.match(src, /label: '刷新', onClick: refreshBankAll/, '刷新按钮应调 refreshBankAll');
});

test('导入成功后也要刷新全部（否则看不到刚上传的文件）', () => {
	const src = client();
	// 找导入成功那段
	const i = src.indexOf("say('ok', '新增 '");
	assert.ok(i > 0, '应能找到导入成功的提示');
	const body = src.slice(i, i + 1200);
	assert.match(body, /refreshBankAll\(\)/, '导入成功后必须刷新全部，不能只 loadBanks');
});

/* ── 白屏回归：Hooks 规则 ─────────────────────── */

test('渲染辅助函数里不能有 hook（否则切换 tab 会白屏）', () => {
	// 我把 react.useEffect 写进了 dshec_channelMode()，
	// 而它是 `tab === 'zones' ? dshec_channelMode() : null` 这样条件调用的普通函数。
	// 切 tab 时 hook 数量变化 → React 抛
	// 「Rendered more hooks than during the previous render」→ 整块卸载 → 卡片空白。
	const src = client();

	// 找出所有 dshec_xxx() 形式的"渲染辅助函数"定义
	const fns = [];
	for (const m of src.matchAll(/function (dshec_\w+)\(/g)) {
		fns.push(m[1]);
	}
	assert.ok(fns.length > 0, '应能找到渲染辅助函数');

	// dshec_Page 是**真正的组件**（由 react.createElement 渲染），里面的 hook 合法。
	// 其余 dshec_xxx 都是被条件调用的纯渲染辅助函数，不能有 hook。
	const COMPONENTS = new Set(['dshec_Page']);

	for (const fn of fns) {
		if (COMPONENTS.has(fn)) continue;
		const i = src.indexOf('function ' + fn + '(');
		assert.ok(i > 0, '应能找到 ' + fn);
		// 用大括号配平划出函数体：从函数签名后的第一个 { 开始数。
		// 不能用"下一个 function 定义"当边界 —— 函数体内常有嵌套回调
		// （onChange: function (v) {...}），会把边界算到文件后部。
		let k = src.indexOf('{', i);
		let depth = 0;
		let j = src.length;
		for (let p2 = k; p2 < src.length; p2++) {
			const ch = src[p2];
			if (ch === '{') depth++;
			else if (ch === '}') {
				depth--;
				if (depth === 0) {
					j = p2 + 1;
					break;
				}
			}
		}
		const body = src.slice(i, j);
		for (const hook of ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef']) {
			assert.ok(
				!body.includes('react.' + hook),
				fn + '() 里不能再有 react.' + hook + '（它是条件调用的普通函数，会违反 Hooks 规则导致白屏）'
			);
		}
	}
});

test('浏览器列表在顶层无条件 effect 里加载', () => {
	const src = client();
	// 找那个 [] 依赖的初始化 effect
	const i = src.indexOf("dshec_call('banks.list')");
	assert.ok(i > 0);
	const around = src.slice(i, i + 1200);
	assert.match(around, /browsers\.list/, '浏览器列表应在这个无条件 effect 里拉');
});

/* ── 白屏回归 2：dshec_el 参数顺序 ─────────────── */

test('dshec_el 调用里不能有「对象当 children」（白屏根因）', () => {
	// 「点击网页按钮后仍旧白屏」。
	// 根因：dshec_el('div', <浏览器下拉>, <提示>, {style:...}, <按钮>)
	// —— style 落到了第 3 个孩子的位置。React 的 children 不能是对象字面量，
	// 渲染时抛 "Objects are not valid as a React child" → 整块卸载（白屏）。
	//
	// 规则：dshec_el(tag, props?, ...children)
	//       第 1 个参数是标签，第 2 个可选是 props（对象），
	//       从第 3 个起不能是纯对象字面量。
	const src = client();
	const lines = src.split(/\r?\n/);

	function splitArgs(text) {
		// 按顶层逗号切参数（忽略括号/字符串内的逗号）
		const out = [];
		let cur = '';
		let depth = 0;
		let q = null;
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (q) {
				cur += c;
				if (c === q && text[i - 1] !== '\\') q = null;
				continue;
			}
			if (c === '"' || c === "'" || c === '`') {
				q = c;
				cur += c;
				continue;
			}
			if (c === '(' || c === '[' || c === '{') depth++;
			if (c === ')' || c === ']' || c === '}') depth--;
			if (c === ',' && depth === 0) {
				out.push(cur.trim());
				cur = '';
				continue;
			}
			cur += c;
		}
		if (cur.trim()) out.push(cur.trim());
		return out;
	}

	function extractCall(text, startIdx) {
		// 从 'dshec_el(' 的 '(' 开始，取出到配对 ')' 的内容
		let depth = 0;
		let q = null;
		for (let i = startIdx; i < text.length; i++) {
			const c = text[i];
			if (q) {
				if (c === q && text[i - 1] !== '\\') q = null;
				continue;
			}
			if (c === '"' || c === "'" || c === '`') {
				q = c;
				continue;
			}
			if (c === '(') depth++;
			else if (c === ')') {
				depth--;
				if (depth === 0) return text.slice(startIdx + 1, i);
			}
		}
		return null;
	}

	let checked = 0;
	const bad = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		const m = l.match(/dshec_el\(/);
		if (!m) continue;
		const startIdx = src.indexOf(l) + m.index + 'dshec_el'.length;
		const inner = extractCall(src, startIdx);
		if (!inner) continue;
		const args = splitArgs(inner);
		checked++;
		// 第 3 个参数起（index >= 2）不能是纯对象字面量
		for (let a = 2; a < args.length; a++) {
			const v = args[a].trim();
			if (v.startsWith('{') && v.endsWith('}')) {
				bad.push('第 ' + (i + 1) + ' 行：第 ' + (a + 1) + ' 个参数是对象 -> ' + v.slice(0, 60));
			}
		}
	}

	assert.ok(checked > 50, '应检查到足够多的 dshec_el 调用，实际 ' + checked);
	assert.deepEqual(bad, [], '存在对象当 children 的调用（会导致白屏）：\n' + bad.join('\n'));
});

test('网页模式的 UI 契约完整（白屏修好后该有的都在）', () => {
	const src = client();
	const i = src.indexOf('function dshec_channelMode()');
	const j = src.indexOf('\n\t\t\t}\n', i);
	const body = src.slice(i, j > 0 ? j : i + 8000);

	// DOM 补救块必须受 ch === 'web' 控制
	assert.match(body, /ch === 'web'\s*\n\s*\? dshec_el\(/, 'DOM 补救块要受 web 控制');
	assert.match(body, /DOM 补救/, '要有开关');
	assert.match(body, /用哪个浏览器考试/, '要有浏览器选择');
	assert.match(body, /browsers\.map/, '要列出浏览器选项');
	assert.match(body, /启动并检测浏览器/, '要有启动按钮');
	assert.match(body, /只有它带调试端口/, '要说清为什么必须用新窗口');
	assert.match(body, /doProbeBrowser/, '按钮要真的调探测');
});
