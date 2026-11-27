// 服务注册：webServer / tools / llm、卸载清理与能力探测。由 lib/index.js 的 apply 统一组装，依赖经 d 注入。

/** 服务出现即挂、消失即卸 —— 插件本体永远能加载。 */
function registerServices(d) {
	const { ctx, registerTools, log, logErr, store, state, engineClient, dispatch, mountOverlayRoute, mountHttpRoute } = d;
	ctx.inject(['webServer'], (webCtx) => {
		webCtx.effect?.(() => mountHttpRoute(webCtx), 'exam-copilot: http route');
		webCtx.effect?.(() => mountOverlayRoute(webCtx), 'exam-copilot: overlay route');
	});

	// 工具注册（S1 只给只读与状态，动作类在 S2）
	ctx.inject(['tools'], (toolsCtx) => {
		try {
			registerTools(toolsCtx, { store, engineClient, dispatch, state });
		} catch (err) {
			logErr('工具注册失败', err);
		}
	});

	// 模型服务（可选）：宿主有 llm 就挂上，没有就降级成"仅题库/人工"。
	// 刻意不写进 static inject —— cordis 把 inject 每一项都当必需，
	// 缺失会导致整个 fiber 不加载，而 llm 在 TUI / headless 下未必存在。
	ctx.inject(['llm'], (llmCtx) => {
		try {
			const svc = typeof llmCtx.get === 'function' ? llmCtx.get('llm') : llmCtx.llm;
			if (svc) {
				state.llm = svc;
				log('模型服务已可用（可用于解题）');
			}
		} catch (err) {
			logErr('模型服务不可用', err);
		}
		return () => {
			state.llm = null;
		};
	});
}

/** 卸载时杀掉引擎，避免孤儿进程。 */
function registerCleanup(d) {
	const { ctx, state, stopEngine } = d;
	ctx.effect?.(() => () => {
		try {
			state.runner?.stop?.();
		} catch {
			/* ignore */
		}
		void stopEngine();
	}, 'exam-copilot: engine cleanup');
}

/** 对象的属性与原型方法名（只看形状，不调用）。 */
function keysOf(o, limit) {
	if (!o || (typeof o !== 'object' && typeof o !== 'function')) return [];
	return Object.keys(o)
		.concat(Object.getOwnPropertyNames(Object.getPrototypeOf(o) ?? {}))
		.filter((k) => k !== 'constructor')
		.slice(0, limit);
}

function shapeOf(o) {
	if (!o || (typeof o !== 'object' && typeof o !== 'function')) return String(o);
	return `{${keysOf(o, 15).join(',')}}`;
}

function safeJson(v, max) {
	try {
		return JSON.stringify(v, (k, x) => (typeof x === 'function' ? `[fn ${x.length}]` : x)).slice(0, max);
	} catch {
		return shapeOf(v);
	}
}

/** 第一轮：常见命名的搜索类服务是否存在。 */
function probeServiceNames(d) {
	const { ctx, tryGetService, log } = d;
	const names = ['search', 'webSearch', 'web', 'websearch', 'tools', 'toolRegistry', 'fetch', 'http', 'browser'];
	const found = [];
	for (const n of names) {
		const svc = tryGetService(ctx, n);
		if (svc !== undefined && svc !== null) found.push(n + '{' + keysOf(svc, 12).join(',') + '}');
	}
	log(`[probe] 联网服务探测：${found.length ? found.join('；') : '未发现 search/web/tools 类服务'}`);
}

/** tools 服务里与搜索相关的工具名。 */
function probeToolNames(d) {
	const { ctx, tryGetService, log } = d;
	const tools = tryGetService(ctx, 'tools');
	if (!tools) return;
	let names = [];
	try {
		const v = tools.view?.() ?? tools.root;
		const src = v?.list?.() ?? v?.names?.() ?? (v instanceof Map ? [...v.keys()] : v ? Object.keys(v) : []);
		names = [...src].map((x) => (typeof x === 'string' ? x : x?.name ?? '?'));
	} catch (e) {
		names = [`读取失败：${e?.message ?? e}`];
	}
	log(`[probe] tools 中与搜索相关：${names.filter((n) => /search|fetch|web/i.test(n)).slice(0, 20).join(',') || '（无或无法枚举）'}`);
}

/** 第二轮：web 服务的搜索提供者长什么样（只读形状，不发起搜索）。 */
function probeWebService(d) {
	const { ctx, tryGetService, log } = d;
	const web = tryGetService(ctx, 'web');
	if (!web) return;
	let listed;
	try {
		listed = web.listProviders?.();
	} catch (e) {
		listed = `listProviders 抛错：${e?.message ?? e}`;
	}
	log(`[probe] web.listProviders()：${safeJson(listed, 600)}`);
	const sp = web.searchProviders;
	const spEntries = sp instanceof Map ? [...sp.entries()] : sp && typeof sp === 'object' ? Object.entries(sp) : [];
	const spText = spEntries.slice(0, 6).map(([k, v]) => k + ':' + shapeOf(v)).join('；') || shapeOf(sp);
	log(`[probe] web.searchProviders：${spEntries.length} 个 · ${spText}`);
	log(`[probe] web.config：${safeJson(web.config, 300)}`);
	probeToolNames(d);
}

/** ctx 上能看到的服务/属性名，以及模型服务的方法形状。 */
function probeCtxAndLlm(d) {
	const { ctx, tryGetService, log } = d;
	const ctxKeys = new Set();
	for (let o = ctx, depth = 0; o && depth < 3; o = Object.getPrototypeOf(o), depth++) {
		for (const k of Object.getOwnPropertyNames(o)) if (!k.startsWith('_') && k !== 'constructor') ctxKeys.add(k);
	}
	log(`[probe] ctx 可见名：${[...ctxKeys].slice(0, 80).join(',')}`);
	const llm = tryGetService(ctx, 'llm');
	if (llm) log(`[probe] llm 服务方法：${keysOf(llm, 30).join(',')}`);
}

/** 联网搜索能力探测（只写日志，不影响答题）：结果决定「允许联网」能否真正落地。 */
function probeSearchCapability(d) {
	try {
		probeServiceNames(d);
		probeWebService(d);
		probeCtxAndLlm(d);
	} catch (err) {
		d.logErr('联网服务探测失败（忽略）', err);
	}
}

export function createRegistration(d) {
	registerServices(d);
	registerCleanup(d);
	d.log(`已加载 v${d.PLUGIN_VERSION}，数据目录 ${d.dataDir}`);
	probeSearchCapability(d);
}
