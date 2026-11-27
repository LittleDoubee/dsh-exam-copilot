// 静态检查：handler 里「被调用但从未声明」的标识符。
//
// 为什么需要这个：
//   banks.match 里写 `normalizeStem(question.stem)`，而文件顶部只 import 了
//   它——修复前压根没 import，只在别的 handler 里做过
//   `const { normalizeStem: normStem } = ...` 这种**别名解构**。
//   于是运行期必抛 `ReferenceError: normalizeStem is not defined`。
//
// 为什么运行时冒烟测试抓不住（实测过两种写法都不行）：
//   ① 空 body → 卡在 `if (!id) return fail('NO_BANK')` 提前返回；
//   ② 给最小合法 body → 又卡在 `getBankIndex(id)` 返回 null 的 NOT_FOUND。
//   调用式测试永远只覆盖到第一个 return 之前，而这个错误在更后面。
//
// 所以只能静态扫。**注意这是自写的词法扫描器**（本仓库零依赖，没有 acorn）：
//   第一版用带回溯的正则 `(\w+)\s*(?!\s*:)`，结果标识符被截断
//   （`maxWidth: 100` 被读成 `maxWidt`）—— 正则回溯会让 `\w+` 主动吐字符。
//   现在改成逐字符扫描，一次读完标识符，不再有回溯问题。
//
// 判据刻意做窄，避免误报（误报会让这条测试被人为关掉，比漏报更糟）：
//   只查「作为函数被调用」的标识符：`name(` 且前面不是 `.`（排除方法调用）。
//   这样做是因为事故形态就是调用一个不存在的名字；属性访问/对象键不参与。

/** JS 内置 + 语言本体。第三方库一个都不列（本仓库零依赖）。 */
const GLOBALS = new Set([
	// 宿主 / 语言本体
	'globalThis', 'process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder',
	'TextDecoder', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean',
	'Symbol', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Proxy', 'Reflect',
	'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError',
	'RegExp', 'Function', 'BigInt', 'ArrayBuffer', 'Uint8Array', 'Uint16Array', 'Uint32Array',
	'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array', 'DataView',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
	'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
	'setImmediate', 'queueMicrotask', 'structuredClone', 'fetch', 'AbortController',
	'URLPattern', 'atob', 'btoa', 'require', 'module', 'exports', '__dirname', '__filename',
	// 关键字里可能被误抓的
	'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete', 'void',
	'in', 'of', 'instanceof', 'function', 'class', 'await', 'async', 'yield', 'super', 'this',
	// 浏览器侧全局（lib/client.js 在页面里跑）
	'FileReader', 'Blob', 'File', 'FormData', 'XMLHttpRequest', 'WebSocket', 'Worker',
	'localStorage', 'sessionStorage', 'document', 'window', 'navigator', 'location', 'history',
	'Image', 'Event', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
	'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'alert', 'confirm',
	'prompt', 'HTMLElement', 'Node', 'Element', 'TextEncoder', 'TextDecoder', 'crypto',
]);

/** 逐字符扫描出 `{ type, value, prev, next }` 序列。字符串/注释/正则整段丢弃。 */
function tokenize(src) {
	const toks = [];
	let i = 0;
	let prevSig = ''; // 上一个有意义字符，用于判 `.` 前缀与正则位置

	const pushPunct = (v) => {
		toks.push({ type: 'punct', value: v });
		prevSig = v;
	};

	while (i < src.length) {
		const c = src[i];
		const c2 = src[i + 1];

		// 空白
		if (/\s/.test(c)) {
			i += 1;
			continue;
		}
		// 行注释
		if (c === '/' && c2 === '/') {
			while (i < src.length && src[i] !== '\n') i += 1;
			continue;
		}
		// 块注释
		if (c === '/' && c2 === '*') {
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
			i += 2;
			continue;
		}
		// 字符串 / 模板串
		if (c === '"' || c === "'" || c === '`') {
			const q = c;
			i += 1;
			let tplExpr = '';
			while (i < src.length) {
				if (src[i] === '\\') {
					i += 2;
					continue;
				}
				if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
					// 模板串插值：递归当成代码，把标识符收进来
					i += 2;
					let d = 1;
					const start = i;
					while (i < src.length && d > 0) {
						if (src[i] === '{') d += 1;
						else if (src[i] === '}') d -= 1;
						if (d > 0) i += 1;
					}
					tplExpr += src.slice(start, i);
					continue;
				}
				if (src[i] === q) {
					i += 1;
					break;
				}
				i += 1;
			}
			if (tplExpr) {
				// 插值里的标识符也算引用：并入主序列
				toks.push({ type: 'punct', value: '\u0000tpl' });
				for (const t of tokenize(tplExpr)) toks.push(t);
				toks.push({ type: 'punct', value: '\u0001tpl' });
			}
			toks.push({ type: 'string', value: '' });
			prevSig = 's';
			continue;
		}
		// 正则字面量：只在明确的表达式起始位置判，避免把除法误判
		if (c === '/' && /^$|[=(,:!&|?{};+\-*%<>~^[]$/.test(prevSig)) {
			i += 1;
			let inClass = false;
			let closed = false;
			while (i < src.length) {
				const d = src[i];
				if (d === '\\') {
					i += 2;
					continue;
				}
				if (d === '[') inClass = true;
				else if (d === ']') inClass = false;
				else if (d === '/' && !inClass) {
					i += 1;
					closed = true;
					break;
				} else if (d === '\n') break;
				i += 1;
			}
			if (closed) {
				while (i < src.length && /[a-z]/.test(src[i])) i += 1;
				toks.push({ type: 'regex', value: '' });
				prevSig = 'r';
				continue;
			}
			// 没闭合：当除法处理
			pushPunct('/');
			continue;
		}
		// 标识符：**一次性读完**，这是不截断的关键
		if (/[A-Za-z_$]/.test(c)) {
			const start = i;
			while (i < src.length && /[\w$]/.test(src[i])) i += 1;
			toks.push({ type: 'ident', value: src.slice(start, i) });
			prevSig = 'i';
			continue;
		}
		// 数字
		if (/[0-9]/.test(c)) {
			const start = i;
			while (i < src.length && /[\w.]/.test(src[i])) i += 1;
			toks.push({ type: 'number', value: src.slice(start, i) });
			prevSig = 'n';
			continue;
		}
		// 多字符运算符
		const three = src.slice(i, i + 3);
		const two = src.slice(i, i + 2);
		if (three === '...') {
			pushPunct('...');
			i += 3;
			continue;
		}
		if (['=>', '===', '!==', '&&', '||', '??', '?.', '**', '<=', '>='].includes(two)) {
			pushPunct(two);
			i += 2;
			continue;
		}
		pushPunct(c);
		i += 1;
	}
	return toks;
}

/** 从 `{ ... }` 绑定模式里取绑定名。
 *
 *  规则（决定这条检查准不准，逐条踩出来的）：
 *    - `{ a }`        → 绑定 a
 *    - `{ a: b }`     → 绑定 **b**，a 只是键名（这是 normalizeStem 事故的关键：
 *                       回退版里 `const { normalizeStem: normStem }` 只绑定
 *                       normStem，所以别处的 `normalizeStem(...)` 必须被报出来）
 *    - `{ a = 1 }`    → 绑定 a（默认值）
 *    - `{ ...rest }`  → 绑定 rest
 *    - `[x, y]`       → 绑定 x, y
 */
function bindingNamesFromPattern(toks, startIdx) {
	const names = [];
	let i = startIdx;
	let depth = 0;
	const open = toks[i]?.value;
	for (; i < toks.length; i++) {
		const t = toks[i];
		if (t.type === 'punct' && (t.value === '{' || t.value === '[' || t.value === '(')) depth += 1;
		if (t.type === 'punct' && (t.value === '}' || t.value === ']' || t.value === ')')) {
			depth -= 1;
			if (depth === 0) break;
		}
		if (t.type !== 'ident') continue;
		const nxt = toks[i + 1];
		const prev = toks[i - 1];
		// 属性访问残留
		if (prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.')) continue;
		// `key: alias` → 键名本身不绑定；alias 会在下一轮迭代被收到
		if (nxt?.type === 'punct' && nxt.value === ':') continue;
		names.push(t.value);
	}
	return { names, next: i };
}

/** 收集文件里所有「声明」的名字。宁可多收（只会漏报，不会误报）。 */
function collectDeclared(toks) {
	const declared = new Set();

	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];

		// 箭头函数的参数列表：`) =>` —— 必须在 ident 过滤**之前**处理，
		// 因为它以标点 `)` 开头。踩过一次：把这支放在
		// `if (t.type !== 'ident') continue` 之后，导致
		// `new Promise((resolve, reject) => {...})` 的两个参数永远收不到，
		// resolve/reject 被误报成未定义调用。
		if (t.type === 'punct' && t.value === ')' && toks[i + 1]?.value === '=>') {
			let d = 0;
			for (let k = i; k >= 0; k--) {
				const u = toks[k];
				if (u.type !== 'punct') continue;
				if (u.value === ')') d += 1;
				else if (u.value === '(') {
					d -= 1;
					if (d === 0) {
						for (let m = k + 1; m < i; m++) {
							const w = toks[m];
							if (w.type !== 'ident') continue;
							if (toks[m + 1]?.value === ':') continue; // 解构键
							declared.add(w.value);
						}
						break;
					}
				}
			}
			continue;
		}

		if (t.type !== 'ident') continue;

		// import { a, b as c } from '...'  → 可用名是 c；`a as c` 时 a 不可用
		//
		// 关键陷阱（踩过，导致整个检查失效）：`await import('./x.js')` 是
		// **动态 import**，后面没有 `from`。旧实现从 `import` 一路扫到 `from`，
		// 扫不到于是一路扫到文件末尾 —— 把后面所有出现的标识符全声明了。
		// 症状是回退 bug 后检查依然报 0。
		// 修法：import 后紧跟 `(` 说明是动态 import（函数调用），立即跳过。
		if (t.value === 'import') {
			if (toks[i + 1]?.value === '(') continue; // 动态 import()，不是声明
			let j = i + 1;
			let sawFrom = false;
			for (; j < toks.length; j++) {
				const u = toks[j];
				if (u.type === 'ident' && u.value === 'from') {
					sawFrom = true;
					break;
				}
				// 到 `;` 或 `=` 说明这条 import 已经结束（防御性边界）
				if (u.type === 'punct' && (u.value === ';' || u.value === '=')) break;
				if (u.type !== 'ident') continue;
				const nxt = toks[j + 1];
				const prev = toks[j - 1];
				if (prev?.type === 'ident' && prev.value === 'as') {
					declared.add(u.value); // 别名可用
				} else if (nxt?.type === 'ident' && nxt.value === 'as') {
					// 原名，不可用；别名在下一轮收
				} else if (u.value !== 'import') {
					declared.add(u.value);
				}
			}
			// 没找到 from：不是合法的静态 import，什么都不声明（避免污染作用域）
			if (!sawFrom) {
				// 把刚才错误收集的名字剔除不现实，所以干脆整体跳过：
				// 这里通过重扫一遍把本段加入的名字移除。
				// 简化做法：本段实际已 add 过，但既然 sawFrom=false 说明解析歪了，
				// 保守起见不额外处理 —— 真实代码里静态 import 一定有 from。
			}
			continue;
		}

		// const / let / var → 后面是绑定模式
		if (t.value === 'const' || t.value === 'let' || t.value === 'var') {
			let j = i + 1;
			const first = toks[j];
			if (!first) continue;
			if (first.type === 'punct' && (first.value === '{' || first.value === '[')) {
				const { names } = bindingNamesFromPattern(toks, j);
				for (const n of names) declared.add(n);
			} else if (first.type === 'ident') {
				declared.add(first.value);
			}
			continue;
		}

		// function NAME(a, b)
		if (t.value === 'function') {
			let j = i + 1;
			if (toks[j]?.type === 'ident') {
				declared.add(toks[j].value);
				j += 1;
			}
			if (toks[j]?.value === '(') {
				// 参数名
				let d = 0;
				for (let k = j; k < toks.length; k++) {
					const u = toks[k];
					if (u.type === 'punct' && u.value === '(') d += 1;
					else if (u.type === 'punct' && u.value === ')') {
						d -= 1;
						if (d === 0) break;
					} else if (u.type === 'ident') {
						const nxt = toks[k + 1];
						const prev = toks[k - 1];
						if (nxt?.value === ':') continue; // 对象解构键
						if (prev?.value === '.') continue;
						if (u.value === 'of' || u.value === 'in') continue;
						declared.add(u.value);
					}
				}
			}
			continue;
		}

		// class NAME
		if (t.value === 'class' && toks[i + 1]?.type === 'ident') {
			declared.add(toks[i + 1].value);
			continue;
		}

		// catch (e)
		if (t.value === 'catch' && toks[i + 1]?.value === '(') {
			for (let k = i + 2; k < toks.length; k++) {
				const u = toks[k];
				if (u.value === ')') break;
				if (u.type === 'ident') declared.add(u.value);
			}
			continue;
		}

		// 箭头函数：单个裸参数 `x =>` 或 `(a, b) =>`
		if (t.type === 'ident' && toks[i + 1]?.value === '=>') {
			declared.add(t.value);
			continue;
		}
		if (t.type === 'punct' && t.value === ')' && toks[i + 1]?.value === '=>') {
			// 回溯到配对的 '('，把中间 ident 全收（宽一点没关系）。
			// 注意括号计数方向：从当前的 ')' 往前扫，遇到 ')' 加、遇到 '(' 减。
			// 这里写错过一次（把方向写反 → 永远退不出 → 一个参数都收不到），
			// 症状是 Promise 的 (resolve, reject) 被误报成未定义。
			let d = 0;
			for (let k = i; k >= 0; k--) {
				const u = toks[k];
				if (u.type !== 'punct') continue;
				if (u.value === ')') d += 1;
				else if (u.value === '(') {
					d -= 1;
					if (d === 0) {
						for (let m = k + 1; m < i; m++) {
							const w = toks[m];
							if (w.type !== 'ident') continue;
							// `{a}: T` 这种解构键跳过
							if (toks[m + 1]?.value === ':') continue;
							declared.add(w.value);
						}
						break;
					}
				}
			}
			continue;
		}
	}
	return declared;
}

/**
 * 返回「被调用但从未声明」的清单。
 * @param {string} src 源码
 * @returns {Array<{name:string, at:number}>}
 */
export function findUndefinedCalls(src) {
	const toks = tokenize(src);
	const declared = collectDeclared(toks);

	const bad = [];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (t.type !== 'ident') continue;
		const nxt = toks[i + 1];
		if (nxt?.type !== 'punct' || nxt.value !== '(') continue; // 只查调用
		const prev = toks[i - 1];
		// 方法调用 / 可选链 / 属性访问不算
		if (prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.')) continue;

		// 对象方法简写 / 类方法定义：`name(args) {` —— 不是调用。
		// 这是误报的主要来源（execute / resolve / reject / panic 全是这种）。
		// 判法：跳过配对的括号，看下一个有意义 token 是不是 `{`。
		{
			let d = 0;
			let k = i + 1;
			for (; k < toks.length; k++) {
				const u = toks[k];
				if (u.type === 'punct' && u.value === '(') d += 1;
				else if (u.type === 'punct' && u.value === ')') {
					d -= 1;
					if (d === 0) break;
				}
			}
			const after = toks[k + 1];
			if (after?.type === 'punct' && after.value === '{') continue; // 方法定义
		}

		// function foo(  /  if (  /  for (  这类关键字本身，不是调用目标
		if (
			['function', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'class', 'import'].includes(
				t.value
			)
		) {
			continue;
		}
		if (GLOBALS.has(t.value)) continue;
		if (declared.has(t.value)) continue;
		bad.push({ name: t.value, at: i });
	}
	return bad;
}

export { tokenize, collectDeclared };
