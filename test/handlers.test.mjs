// 宿主半边（lib/index.js）的 handler 冒烟测试。
//
// 为什么必须单独有这一组：
//   `banks.match` 里写成了 `normalizeStem(question.stem)`，而文件顶部只
//   import 了它（修复前甚至没 import，只在别的 handler 里做过局部解构别名）。
//   于是每次调用都抛 `ReferenceError: normalizeStem is not defined`。
//
//   这个 bug 的特征是致命的：
//     * 287 项单测全绿 —— 因为没有任何一项调用过 lib/index.js 的 handler
//     * import 正常 —— 错误在运行期才炸，模块加载阶段看不出来
//     * 只有实际点击才暴露，而面板上没有任何入口会直接调 banks.match
//
// 所以这里补的是**结构性盲区**：所有 handler 都至少被调用一次。
//
// 两个刻意的设计：
//   ① 名单不手写。从源码正则抓 handler 名 + 抓 handler 体，
//      「体内出现 engineClient( / browserLauncher」就自动跳过 ——
//      手写清单正是这类 bug 的温床（新增 handler 会漏）。
//   ② 判据只认「代码级错误」（is not defined / is not a function）。
//      NOT_FOUND / NO_PROFILE / ENGINE_UNAVAILABLE 都是**正常业务返回**，
//      因为这个测试刻意不提供引擎、模型、配置。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findUndefinedCalls } from './_static-udf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 示例题库由使用者自备（不随仓库发布）；缺失时跳过依赖它的用例
const SAMPLE_BANK = path.join(ROOT, 'mock', 'mock-12.json');
const HAS_SAMPLE = fs.existsSync(SAMPLE_BANK);
const INDEX_SRC = path.join(ROOT, 'lib', 'index.js');

/**
 * 从源码里抓出每个 handler 的名字与函数体。
 *
 * 为什么要解析函数体而不是维护「跳过清单」：
 *   跳过清单会随代码演进失效，而真正的判据是「这个 handler 会不会起外部进程」，
 *   那个信息就写在体内（engineClient / browserLauncher）。
 */
function scanHandlers(src) {
	const out = [];
	const re = /async '([a-zA-Z.]+)'\([^)]*\)\s*\{/g;
	let m;
	while ((m = re.exec(src))) {
		const name = m[1];
		const bodyStart = m.index + m[0].length;
		// 括号配对，取出完整函数体（跳过字符串内的括号）
		let depth = 1;
		let i = bodyStart;
		let q = null;
		while (i < src.length && depth > 0) {
			const c = src[i];
			if (q) {
				if (c === q && src[i - 1] !== '\\') q = null;
			} else if (c === '"' || c === "'" || c === '`') {
				q = c;
			} else if (c === '{') {
				depth += 1;
			} else if (c === '}') {
				depth -= 1;
			}
			i += 1;
		}
		out.push({ name, body: src.slice(bodyStart, i - 1) });
	}
	return out;
}

/**
 * 给每个 handler 一份「能推进到实现体」的最小合法 body。
 *
 * 为什么需要（踩过）：空 body 会在入口的前置校验被拦下，
 *   例如 banks.match 的 `if (!id) return fail('NO_BANK', ...)`，
 *   此时 normalizeStem 那行压根没执行，测试绿着、bug 还在。
 *   实测回退修复后空 body 版本仍全绿 —— 它只证明「handler 不崩」。
 *
 * 这里按名字给最小入参。给不准的（不存在的 id / 空数组）没关系：
 * 目标是让流程**走进实现体**，随后正常返回 NOT_FOUND 等业务错误。
 * 判据只认代码级错误，所以业务错误完全不算失败。
 */
function minimalBody(name) {
	const bankId = 'bank-nonexistent';
	const base = { id: bankId, bankIds: [bankId], profileId: 'profile-nonexistent' };
	switch (name) {
		// ── 题库：必须同时给 id + question，否则走不到匹配实现 ──
		case 'banks.match':
			return {
				...base,
				question: {
					stem: '这是一道用于冒烟测试的题干',
					qtype: '单选题',
					opts: [
						{ letter: 'A', text: '甲' },
						{ letter: 'B', text: '乙' },
					],
				},
			};
		case 'banks.search':
			return { ...base, q: '冒烟' };
		case 'banks.fillMiss':
			return { ...base, question: { stem: '冒烟题干', options: [] }, answer: 'A' };
		case 'banks.import':
			// 不给 filePath/fileBytes：走「没内容可导入」分支，但会先跑完类型分派
			return { bankId, dryRun: true };
		case 'banks.get':
		case 'banks.delete':
		case 'banks.sources':
		case 'banks.removeSource':
		case 'banks.misses':
		case 'banks.clear':
			return base;
		case 'profiles.get':
		case 'profiles.delete':
			return { id: 'profile-nonexistent' };
		case 'profiles.save':
			return { profile: { id: 'profile-smoke', name: 'smoke', zones: [] } };
		case 'settings.save':
			return { patch: {} };
		case 'run.act':
			return { ...base, envelope: { action: 'wait', params: { ms: 1 } } };
		case 'run.pause':
			return { reason: 'smoke' };
		case 'run.confirmSubmit':
			return { reason: 'smoke' };
		case 'ocr.read':
			return { region: null, engine: 'auto' };
		case 'screen.preview':
		case 'screen.previewCached':
			return { region: null, maxWidth: 100 };
		case 'zones.preview':
			return { regions: [], timeoutMs: 1 };
		default:
			return base;
	}
}

/** 起一个最小宿主，返回 { rpc, cleanup }。数据目录是临时目录，跑完即删。 */
async function bootHost() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshec-h-'));
	const home = path.join(tmp, 'dsh-home');
	fs.mkdirSync(home, { recursive: true });

	const routes = new Map();
	const ctx = {
		logger: { info: () => {}, warn: () => {} },
		dsh: { home },
		effect: (fn) => {
			const dispose = fn?.();
			return typeof dispose === 'function' ? dispose : () => {};
		},
		inject: (deps, cb) => {
			if (deps.includes('webServer')) {
				cb({
					webServer: {
						register: (spec) => {
							routes.set(spec.path, spec.handler);
							return () => {};
						},
					},
					effect: (fn) => {
						const dispose = fn?.();
						return typeof dispose === 'function' ? dispose : () => {};
					},
				});
			} else if (deps.includes('tools')) {
				cb({ tools: { register: () => {} } });
			}
			// llm 刻意不注入：测试不需要真模型，缺了插件也必须能加载
		},
	};

	const mod = await import('../lib/index.js');
	mod.apply(ctx);

	const handler = routes.get('/plugins/dsh-exam-copilot/exam-copilot');
	if (!handler) throw new Error('HTTP 路由没挂上：' + [...routes.keys()].join(','));

	/** 模拟宿主 req/res 调一次 RPC。超时不判失败（见上方 ②）。 */
	function rpc(endpoint, payload = {}, timeoutMs = 5000) {
		return new Promise((resolve) => {
			const body = Buffer.from(JSON.stringify({ endpoint, payload }), 'utf8');
			let done = false;
			const finish = (v) => {
				if (done) return;
				done = true;
				resolve(v);
			};
			const timer = setTimeout(() => finish({ __timeout: true }), timeoutMs);
			timer.unref?.();

			const req = {
				method: 'POST',
				headers: { host: '127.0.0.1:11246', 'content-type': 'application/json' },
				on: (ev, fn) => {
					if (ev === 'data') fn(body);
					else if (ev === 'end') fn();
					return req;
				},
				destroy: () => {},
			};
			const chunks = [];
			const res = {
				statusCode: 0,
				setHeader: () => {},
				end: (s) => {
					if (s) chunks.push(String(s));
				},
			};
			Promise.resolve(handler(req, res))
				.then(() => {
					clearTimeout(timer);
					const text = chunks.join('');
					try {
						finish(JSON.parse(text));
					} catch {
						finish({ __bad: text.slice(0, 200) });
					}
				})
				.catch((err) => {
					clearTimeout(timer);
					finish({ __thrown: err?.message ?? String(err) });
				});
		});
	}

	return { rpc, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('handler 扫描器：能抓到足够多的 handler（防止正则失效后本组静默空跑）', () => {
	const src = fs.readFileSync(INDEX_SRC, 'utf8');
	const handlers = scanHandlers(src);
	assert.ok(handlers.length >= 30, `只抓到 ${handlers.length} 个 handler，正则可能失效`);
	// 抽查几个必须存在的，确认名字抓对了
	const names = handlers.map((h) => h.name);
	for (const must of ['banks.match', 'banks.import', 'run.state', 'profiles.list', 'zones.meta']) {
		assert.ok(names.includes(must), `漏了 handler: ${must}`);
	}
});

test('静态：handler 里不能调用未声明的标识符（抓 is not defined）', () => {
	// 这条是本组里**唯一真正可靠**地抓住本次事故的检查。
	//
	// 为什么另外两种写法都不行（都实测过）：
	//   ① 空 body 调 handler → banks.match 在 `if (!id) return fail('NO_BANK')`
	//      就返回，normalizeStem 那行压根没执行 → 绿着、bug 还在。
	//   ② 按名字给最小合法 body → 又卡在 getBankIndex(id) 返回 null 的
	//      NOT_FOUND 上 → 还是绿。调用式冒烟永远只覆盖到第一个 return 之前。
	// 而 `x is not defined` 是**纯静态**性质，与运行时能否走到无关。
	const src = fs.readFileSync(INDEX_SRC, 'utf8');
	const bad = findUndefinedCalls(src);
	assert.deepEqual(
		bad.map((b) => b.name),
		[],
		`lib/index.js 调用了未声明的标识符（运行期必抛 is not defined）：${bad.map((b) => b.name).join(', ')}`
	);

	// 自检：分析器必须真的能判别，而不是永远返回空数组。
	// 这里构造一个「只删掉 import」的版本，必须被抓到 —— 等价于本次事故。
	const reverted = src.replace(
		"import { AUTO_ACCEPT, BankIndex, CONFIDENCE, matchQuestion, normalizeStem } from './core/bank.js';",
		"import { AUTO_ACCEPT, BankIndex, CONFIDENCE, matchQuestion } from './core/bank.js';"
	);
	assert.notEqual(reverted, src, '自检失败：找不到那行 import，分析器可能已与实际代码脱节');
	assert.ok(
		findUndefinedCalls(reverted).some((b) => b.name === 'normalizeStem'),
		'自检失败：分析器抓不到「删除 import 后的 normalizeStem」，说明它不可信'
	);
});

test('引擎客户端必须与 Runner 的调用面一致（resume 缺失导致整个自动答题跑不起来）', async () => {
	// run.start 直接失败
	//   "无法放行引擎动作：this.engine.resume is not a function"
	// 引擎侧 /v1/resume 一直存在，但 EngineClient 从没包装过它。
	// 单测全绿是因为单测用**假引擎**，假引擎有 resume，真引擎没有 ——
	// 这类"接口面不对齐"用运行时测不出来，只能静态比对。
	const { EngineClient } = await import('../lib/core/engine-client.js');
	const runnerSrc = fs.readFileSync(path.join(ROOT, 'lib', 'core', 'runner.js'), 'utf8');

	// 抓 runner 里所有 this.engine.xxx( 的调用
	const used = new Set([...runnerSrc.matchAll(/this\.engine\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
	assert.ok(used.size >= 5, `只抓到 ${used.size} 个引擎调用，正则可能失效`);

	const missing = [];
	for (const name of used) {
		if (typeof EngineClient.prototype[name] !== 'function') missing.push(name);
	}
	assert.deepEqual(
		missing,
		[],
		`Runner 调用了 EngineClient 上不存在的方法（运行期必抛 "is not a function"）：${missing.join(', ')}`
	);

	// 顺带确认几个关键方法确实在（防止 rename 后悄悄漏掉）
	for (const must of ['health', 'screenshot', 'ocr', 'act', 'panic', 'resume', 'readProgress']) {
		assert.equal(typeof EngineClient.prototype[must], 'function', `EngineClient 缺 ${must}()`);
	}
});

test('所有不依赖引擎的 handler 都不能抛代码级错误（覆盖盲区）', async () => {
	const src = fs.readFileSync(INDEX_SRC, 'utf8');
	const handlers = scanHandlers(src);
	const { rpc, cleanup } = await bootHost();
	try {
		const failures = [];
		let called = 0;
		let skipped = 0;
		for (const h of handlers) {
			// 会起 Python 引擎 / 浏览器 / 全屏窗的，单测里不能碰
			if (/engineClient\(|browserLauncher/.test(h.body)) {
				skipped += 1;
				continue;
			}
			called += 1;
			// 传「最小合法 body」而不是空 body。
			//
			// 为什么必须这样（这是本条测试自己的真实缺陷，踩过一次）：
			//   空 body 会命中入口的前置校验并提前 return，例如 banks.match：
			//       if (!id) return fail('NO_BANK', ...);
			//   于是 normalizeStem 那行根本没执行 —— 测试「绿」，bug 还在。
			//   实测把修复回退后，空 body 版本依然全绿，说明它只证明了
			//   「handler 不崩」，没证明「handler 真的跑到了实现」。
			//   所以按 handler 名给最小合法入参，把流程推进到实现体。
			const res = await rpc(h.name, minimalBody(h.name));
			if (res.__thrown) {
				failures.push({ name: h.name, thrown: res.__thrown });
				continue;
			}
			if (res.__bad) {
				failures.push({ name: h.name, badResponse: res.__bad });
				continue;
			}
			const msg = String(res?.error?.message ?? '');
			if (/is not defined/.test(msg) || /is not a function/.test(msg)) {
				failures.push({ name: h.name, code: res.error.code, message: msg });
			}
		}
		assert.ok(called >= 15, `实际只调用了 ${called} 个 handler，覆盖率太低`);
		assert.deepEqual(failures, [], `handler 里有代码级错误：\n${JSON.stringify(failures, null, 1)}`);
		console.log(`    [handler 冒烟] 调用 ${called} 个，跳过 ${skipped} 个（需引擎/浏览器）`);
	} finally {
		cleanup();
	}
});

test('banks.match：修复后必须能命中（normalizeStem 未定义回归）', { skip: !HAS_SAMPLE }, async () => {
	const { rpc, cleanup } = await bootHost();
	try {
		const created = await rpc('banks.create', { name: 'match-regression' });
		assert.equal(created.ok, true, JSON.stringify(created.error));
		const bankId = created.value.id;

		const imp = await rpc('banks.import', {
			filePath: path.join(ROOT, 'mock', 'mock-12.json'),
			bankId,
			dryRun: false,
		});
		assert.equal(imp.ok, true, JSON.stringify(imp.error));
		assert.equal(imp.value.summary.normalizedCount, 12);
		assert.equal(imp.value.summary.withAnswer, 12, '12 题都必须切出答案');

		// ★ 修复前这里返回 { ok:false, error:{ code:'INTERNAL',
		//    message:'normalizeStem is not defined' } }
		const matched = await rpc('banks.match', {
			id: bankId,
			question: {
				stem: '根据《印刷业管理条例》，从事出版物印刷经营活动的企业，应当取得下列哪项许可？',
				qtype: '单选题',
				opts: [
					{ letter: 'A', text: '印刷经营许可证' },
					{ letter: 'B', text: '出版物经营许可证' },
					{ letter: 'C', text: '特种行业许可证' },
					{ letter: 'D', text: '营业执照即可' },
				],
			},
		});
		assert.equal(matched.ok, true, `banks.match 崩了：${JSON.stringify(matched.error)}`);
		assert.equal(matched.value.answer, 'A');
		assert.equal(matched.value.confidence, 'high');
		assert.equal(matched.value.autoAccept, true, 'high 必须落在 AUTO_ACCEPT 里');
	} finally {
		cleanup();
	}
});

test('banks.match：示例题库逐条全中（题库通道确实能用）', { skip: !HAS_SAMPLE }, async () => {
	const { rpc, cleanup } = await bootHost();
	try {
		const created = await rpc('banks.create', { name: 'match-all' });
		const bankId = created.value.id;
		await rpc('banks.import', {
			filePath: path.join(ROOT, 'mock', 'mock-12.json'),
			bankId,
			dryRun: false,
		});

		const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'mock', 'mock-12.json'), 'utf8')).items;
		assert.equal(items.length, 12, '示例题库应该是 12 题');

		const fails = [];
		for (const it of items) {
			const r = await rpc('banks.match', {
				id: bankId,
				question: { stem: it.stem, qtype: it.qtype, opts: it.options },
			});
			const v = r.value ?? {};
			const ok = r.ok && v.answer === it.answer && (v.confidence === 'high' || v.confidence === 'medium-high');
			if (!ok) fails.push({ no: it.no, want: it.answer, got: v.answer, conf: v.confidence, err: r.error });
		}
		assert.deepEqual(fails, [], `题库匹配失败：\n${JSON.stringify(fails, null, 1)}`);
	} finally {
		cleanup();
	}
});

test('banks.sources：文本/JSON 导入的题也能列出来源（不能整块消失）', { skip: !HAS_SAMPLE }, async () => {
	const { rpc, cleanup } = await bootHost();
	try {
		const created = await rpc('banks.create', { name: 'sources-regression' });
		const bankId = created.value.id;
		await rpc('banks.import', {
			filePath: path.join(ROOT, 'mock', 'mock-12.json'),
			bankId,
			dryRun: false,
		});

		const src = await rpc('banks.sources', { id: bankId });
		assert.equal(src.ok, true, JSON.stringify(src.error));
		// 关键：哪怕没有 srcHash，也必须能从题的 source 字段聚合出来。
		// 旧实现返回空数组 → 面板整块消失，用户以为功能没做。
		assert.ok(Array.isArray(src.value.sources), 'sources 必须是数组，不能是 undefined');
		assert.equal(src.value.sources.length, 1);
		assert.match(src.value.sources[0].name, /mock-12\.json$/);
		assert.equal(src.value.total, 12);
	} finally {
		cleanup();
	}
});
