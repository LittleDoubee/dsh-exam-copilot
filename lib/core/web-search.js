/**
 * 联网检索：调用宿主 ctx.get('web') 的搜索提供者。
 *
 * 探测结果：web.searchProviders 是 Map/对象，每个提供者 {id, available, ready?, search}。
 * search 的入参/返回结构尚未实测，这里写得宽松：
 *   入参依次尝试 search({query, limit, signal}) → search(query, {limit, signal})
 *   返回兼容 数组 / {results} / {items} / {data}，字段兼容 title/name、snippet/content/description/summary、url/link。
 * 首次搜索会把返回结构写进日志，确认后再收紧。
 */

const ORDER = ['ddg', 'anysearch', 'deepseek-search-api'];

function flag(v) {
	try {
		return typeof v === 'function' ? v() !== false : v !== false;
	} catch {
		return false;
	}
}

function toList(res) {
	if (Array.isArray(res)) return res;
	if (!res || typeof res !== 'object') return [];
	// ddg 返回 {sources:[{url,title,snippet}]}
	for (const k of ['sources', 'results', 'items', 'data', 'hits', 'organic']) {
		if (Array.isArray(res[k])) return res[k];
	}
	return [];
}

export function normalizeResults(res, max = 5) {
	return toList(res)
		.map((r) => ({
			title: String(r?.title ?? r?.name ?? '').trim(),
			snippet: String(r?.snippet ?? r?.content ?? r?.description ?? r?.summary ?? r?.text ?? '').trim(),
			url: String(r?.url ?? r?.link ?? r?.href ?? ''),
		}))
		.filter((r) => r.title || r.snippet)
		.slice(0, max);
}

/** 把结果拼成「参考资料」，总长封顶 */
export function formatRefs(list, cap = 1500) {
	let out = '';
	list.forEach((r, i) => {
		const line = `[${i + 1}] ${r.title}${r.snippet ? `：${r.snippet}` : ''}\n`;
		if (out.length + line.length <= cap) out += line;
	});
	return out.trim();
}

export class WebSearcher {
	/** @param {object} web 宿主 web 服务；@param {Function} log */
	constructor(web, { log = () => {}, timeoutMs = 8000, max = 5 } = {}) {
		this.web = web;
		this.log = log;
		this.timeoutMs = timeoutMs;
		this.max = max;
		this.shapeLogged = false;
		this.cache = new Map(); // 同题只搜一次
	}

	pickProvider() {
		const sp = this.web?.searchProviders;
		const get = (id) => (sp instanceof Map ? sp.get(id) : sp?.[id]);
		for (const id of ORDER) {
			const p = get(id);
			if (p && typeof p.search === 'function' && flag(p.available) && ('ready' in p ? flag(p.ready) : true)) return p;
		}
		return null;
	}

	async _call(p, query, signal) {
		try {
			return await p.search({ query, limit: this.max, signal });
		} catch (e1) {
			if (signal.aborted) throw e1;
			return await p.search(query, { limit: this.max, signal });
		}
	}

	/** @returns {Promise<string>} 参考资料文本；失败/超时返回 '' */
	async search(query) {
		const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
		if (!q) return '';
		if (this.cache.has(q)) return this.cache.get(q);
		const task = this._search(q);
		this.cache.set(q, task);
		if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
		return task;
	}

	async _search(q) {
		const p = this.pickProvider();
		if (!p) {
			this.log('[web] 无可用搜索提供者，按不联网作答');
			return '';
		}
		const started = Date.now();
		const ctl = new AbortController();
		let timer;
		try {
			const res = await Promise.race([
				this._call(p, q, ctl.signal),
				new Promise((_, rej) => {
					timer = setTimeout(() => {
						ctl.abort();
						rej(new Error(`超时 ${this.timeoutMs / 1000}s`));
					}, this.timeoutMs);
				}),
			]);
			const list = normalizeResults(res, this.max);
			this.log(`[web] ${p.id} 搜到 ${list.length} 条，${Date.now() - started}ms`);
			return formatRefs(list);
		} catch (err) {
			this.log(`[web] ${p.id} 搜索失败（${err?.message ?? err}），按不联网作答`);
			return '';
		} finally {
			clearTimeout(timer);
		}
	}
}
