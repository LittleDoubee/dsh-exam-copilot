// 题库存储：分片 JSONL + 分类元数据。
//
// 为什么用 JSONL 而不是 JSON 数组或 SQLite：
//   * JSONL 可以追加（导入一批只 append，不重写整个文件）——上万题时不卡
//   * 单行损坏不影响其他行（readJsonl 已实现跳过坏行）
//   * 不需要 SQLite 的 native 编译（better-sqlite3 要编译，node:sqlite 是实验特性）
//   * 真要换 SQLite 时，接口不变：调用方只用 listBanks/loadItems/saveItems
//
// 零 ctx：路径由 Store 注入。

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonl, ensureDir, readJson, readJsonl, sanitizeId, writeJson } from './store.js';

/** 题库元数据：名称、分类、来源、题数、命中统计。 */
const META_VERSION = 1;

export class BankStore {
	constructor(banksDir) {
		this.root = banksDir;
		ensureDir(this.root);
	}

	bankDir(id) {
		return path.join(this.root, sanitizeId(id));
	}

	metaFile(id) {
		return path.join(this.bankDir(id), 'meta.json');
	}

	itemsFile(id) {
		return path.join(this.bankDir(id), 'questions.jsonl');
	}

	/** 列出所有题库（只读 meta，不读题）。 */
	list() {
		ensureDir(this.root);
		const out = [];
		for (const name of fs.readdirSync(this.root)) {
			const dir = path.join(this.root, name);
			if (!fs.statSync(dir).isDirectory()) continue;
			const meta = readJson(path.join(dir, 'meta.json'), null);
			if (meta?.id) out.push(meta);
		}
		return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
	}

	getMeta(id) {
		return readJson(this.metaFile(id), null);
	}

	saveMeta(meta) {
		if (!meta?.id) throw new Error('bank.id 必填');
		meta.version = META_VERSION;
		meta.updatedAt = new Date().toISOString();
		ensureDir(this.bankDir(meta.id));
		writeJson(this.metaFile(meta.id), meta);
		return meta;
	}

	/** 创建题库。分类用于日后归类（同一题库一个主分类 + 若干标签）。 */
	create({ id, name, category = '未分类', tags = [], source = '' }) {
		const bid = id ? sanitizeId(id) : `bank-${Date.now().toString(36)}`;
		if (this.getMeta(bid)) throw new Error(`题库已存在: ${bid}`);
		const meta = {
			id: bid,
			name: name || '未命名题库',
			category,
			tags: Array.isArray(tags) ? tags : [],
			source,
			count: 0,
			createdAt: new Date().toISOString(),
			updatedAt: null,
			version: META_VERSION,
			// 命中统计：用于"这个题库有用吗"
			stats: { hits: 0, highConfidence: 0, lowConfidence: 0 },
		};
		this.saveMeta(meta);
		ensureDir(this.bankDir(bid));
		// 建空文件，避免后续 append 时目录/文件不存在
		if (!fs.existsSync(this.itemsFile(bid))) fs.writeFileSync(this.itemsFile(bid), '', 'utf8');
		return meta;
	}

	delete(id) {
		const dir = this.bankDir(id);
		if (!fs.existsSync(dir)) return false;
		fs.rmSync(dir, { recursive: true, force: true });
		return true;
	}

	/** 读全部题（含归一化题干，供匹配用）。题量大时只应调用一次并缓存。 */
	loadItems(id) {
		const rows = readJsonl(this.itemsFile(id));
		return rows.filter((r) => r && (r.stem || r.q));
	}

	/** 追加一批题（不重写已有内容）。 */
	appendItems(id, items) {
		if (!Array.isArray(items) || items.length === 0) return { added: 0 };
		const file = this.itemsFile(id);
		ensureDir(this.bankDir(id));
		const lines = items.map((it) => JSON.stringify(it)).join('\n') + '\n';
		fs.appendFileSync(file, lines, 'utf8');
		const meta = this.getMeta(id) ?? { id, count: 0 };
		meta.count = (meta.count ?? 0) + items.length;
		this.saveMeta(meta);
		return { added: items.length, total: meta.count };
	}

	/**
	 * 追加并**与库内已有内容去重**。
	 *
	 * 为什么不能在调用方做：调用方的 dedupe() 只处理"本次导入的这一批"，
	 * 把同一个文件导第二次时，库里已有的题它根本看不见 ——
	 * appendItems 是纯追加，于是整份文件又进一遍。
	 *
	 * 去重键与 dedupe() 保持一致（归一化题干），但**与库内比对**时多一层判断：
	 *   · 题干相同 + 答案相同 → 视为重复，跳过
	 *   · 题干相同 + 答案不同 → 两条都留，标 '答案冲突'
	 *     （同题不同版本是真实存在的，静默覆盖会丢数据）
	 *   · 题干不同 → 新增
	 *
	 * @returns {{ added, skipped, conflicts, total }}
	 */
	appendItemsDedup(id, items, { srcHash = '' } = {}) {
		if (!Array.isArray(items) || items.length === 0) {
			return { added: 0, skipped: 0, conflicts: 0, total: this.getMeta(id)?.count ?? 0 };
		}

		// 库内已有题干 → 答案集合。用 Map<归一化题干, Set<答案>>
		const existing = new Map();
		for (const row of this.loadItems(id)) {
			const k = simpleNorm(row.stem ?? row.q);
			if (!k) continue;
			if (!existing.has(k)) existing.set(k, new Set());
			existing.get(k).add(String(row.answer ?? ''));
		}

		const toAdd = [];
		let skipped = 0;
		let conflicts = 0;

		for (const it of items) {
			const k = simpleNorm(it.stem);
			if (!k) continue;
			const answers = existing.get(k);

			if (!answers) {
				// 库里没有这道题
				toAdd.push(withSrc(it, srcHash));
				existing.set(k, new Set([String(it.answer ?? '')]));
				continue;
			}

			const ans = String(it.answer ?? '');
			if (answers.has(ans)) {
				skipped += 1; // 完全重复
				continue;
			}

			// 题干同、答案不同 —— 可能是不同版本，保留但打标
			conflicts += 1;
			answers.add(ans);
			toAdd.push(withSrc({ ...it, tags: [...(it.tags ?? []), '答案冲突'] }, srcHash));
		}

		if (toAdd.length === 0) {
			return { added: 0, skipped, conflicts, total: this.getMeta(id)?.count ?? 0 };
		}

		const file = this.itemsFile(id);
		ensureDir(this.bankDir(id));
		const lines = toAdd.map((it) => JSON.stringify(it)).join('\n') + '\n';
		fs.appendFileSync(file, lines, 'utf8');

		const meta = this.getMeta(id) ?? { id, count: 0 };
		// count 以**实际行数**为准，不再累加 —— 累加在去重场景下会虚高
		meta.count = this.loadItems(id).length;
		this.saveMeta(meta);

		return { added: toAdd.length, skipped, conflicts, total: meta.count };
	}

	/* ── 导入来源（文件指纹）─────────────────────────────────
	 * 文件名一样就去重。
	 *
	 * 但"文件名一样"不能只看名字：题库文件常被复制成
	 * 「题库.docx」「题库 (1).docx」，名字不同内容一样；
	 * 也可能同名但内容不同（更新了版本）。
	 * 所以记三层：
	 *   name  —— 文件名（用户视角的判断依据）
	 *   size  —— 字节数（同名的快速区分）
	 *   hash  —— 内容 sha256（真正的判断依据）
	 * 判断"这个文件导过没"用 hash；报错信息里用 name，让用户看得懂。
	 */

	sourcesFile() {
		return path.join(this.root, 'sources.json');
	}

	/** 读已导入来源表：{ [bankId]: { [hash]: {name,size,at} } } */
	readSources() {
		return readJson(this.sourcesFile(), {}) ?? {};
	}

	/**
	 * 查这个文件是否已导入过某个库。
	 *
	 * @returns {null | { name, size, at, bankId }}  命中则返回首次导入信息
	 */
	findSource(bankId, hash) {
		const all = this.readSources();
		const perBank = all[bankId];
		if (!perBank || !perBank[hash]) return null;
		return { ...perBank[hash], bankId };
	}

	/** 记录一次成功导入。
	 *
	 *  itemCount 记「这一次实际入库了多少题」，不是整个文件切出多少 ——
	 *  去重跳过的不算。面板上「这个文件贡献了 N 题」用的就是它。
	 */
	recordSource(bankId, hash, info) {
		try {
			ensureDir(this.root);
			const all = this.readSources();
			all[bankId] = all[bankId] ?? {};
			const prev = all[bankId][hash];
			if (prev) {
				// 已存在：累加题数（同一文件可能分两次导入不同部分），
				// 但保留首次时间 —— 用户想知道「最早什么时候导的」
				prev.itemCount = (prev.itemCount ?? 0) + (info.itemCount ?? 0);
				// 文件名可能变了（用户改名后再导），用最新的更好懂
				if (info.name) prev.name = info.name;
			} else {
				all[bankId][hash] = {
					name: info.name ?? '',
					size: info.size ?? 0,
					at: new Date().toISOString(),
					itemCount: info.itemCount ?? 0,
				};
			}
			writeJson(this.sourcesFile(), all);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 列出某个题库已导入的所有来源文件。
	 *
	 * @returns {Array<{hash, name, size, at, itemCount}>} 按导入时间倒序
	 */
	listSources(bankId) {
		const perBank = this.readSources()[bankId] ?? {};
		return Object.entries(perBank)
			.map(([hash, v]) => ({ hash, ...v }))
			.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
	}

	/**
	 * 删除某个来源文件导入的题。
	 *
	 * 判断依据是题上的 `srcHash` 标记（导入时写入）。
	 * 老数据没有这个字段，所以额外给一条兜底：
	 *   srcHash 缺失时，**不删**（宁可少删，也不要错删用户手补的题）。
	 *
	 * @returns {{ removed, remaining, sourcesDeleted }}
	 */
	removeSource(bankId, hash) {
		const items = this.loadItems(bankId);

		// 两种 key：
		//   真 hash  → 按 srcHash 删（新导入的数据）
		//   src:名字 → 按题的 source 字段删（旧数据，没有 srcHash 但记得原文件名）
		// 旧数据支持：题目可能全来自一个 docx，
		// 但都是旧版导入、无 srcHash，导致文件列表里看不到、也删不掉。
		const isLegacy = String(hash).startsWith('src:');
		const legacyName = isLegacy ? String(hash).slice(4) : '';
		const keep = isLegacy
			? items.filter((it) => {
					if (it.srcHash) return true; // 新数据不动
					const n = String(it.source || '').trim() || '(未记录来源)';
					return n !== legacyName;
			  })
			: items.filter((it) => it.srcHash !== hash);
		const removed = items.length - keep.length;

		if (removed > 0) this.replaceItems(bankId, keep);

		// 清掉来源记录
		let sourcesDeleted = 0;
		try {
			const all = this.readSources();
			// 旧数据的 key 不在 sources.json 里，无需清理
			if (!isLegacy && all[bankId] && all[bankId][hash]) {
				delete all[bankId][hash];
				if (Object.keys(all[bankId]).length === 0) delete all[bankId];
				writeJson(this.sourcesFile(), all);
				sourcesDeleted = 1;
			}
		} catch {
			/* 来源表损坏不该阻塞删题 */
		}

		return { removed, remaining: keep.length, sourcesDeleted };
	}

	/** 全量替换（用于去重整理）。 */
	replaceItems(id, items) {
		const file = this.itemsFile(id);
		ensureDir(this.bankDir(id));
		const lines = items.map((it) => JSON.stringify(it)).join('\n') + (items.length ? '\n' : '');
		fs.writeFileSync(file, lines, 'utf8');
		const meta = this.getMeta(id) ?? { id };
		meta.count = items.length;
		this.saveMeta(meta);
		return { total: items.length };
	}

	/** 命中统计：每次匹配后调用，用于评估题库质量。 */
	recordHit(id, confidence) {
		const meta = this.getMeta(id);
		if (!meta) return;
		meta.stats = meta.stats ?? { hits: 0, highConfidence: 0, lowConfidence: 0 };
		meta.stats.hits += 1;
		if (confidence === 'high' || confidence === 'medium-high') meta.stats.highConfidence += 1;
		else meta.stats.lowConfidence += 1;
		this.saveMeta(meta);
	}

	/* ── 未命中记录──────────────────────────
	 * 旧实现只记命中，于是"题库到底漏了哪些题"永远无从得知。
	 * 这里把 miss 落到**题库根目录**下的 misses.jsonl，
	 * 而不是某个库内部 —— miss 的本质是"所有库都没有"，
	 * 记在某个库下会误导用户以为那个库该补。
	 */

	missesFile() {
		return path.join(this.root, 'misses.jsonl');
	}

	/** 追加一条未命中记录。失败不抛（统计问题不该中断答题）。 */
	recordMiss(record) {
		try {
			ensureDir(this.root);
			fs.appendFileSync(this.missesFile(), JSON.stringify(record) + '\n', 'utf8');
			return true;
		} catch {
			return false;
		}
	}

	/** 读未命中记录。超上限时只读尾部 —— 长跑久了文件会很大。 */
	readMisses(limit = 2000) {
		try {
			if (!fs.existsSync(this.missesFile())) return [];
			const text = fs.readFileSync(this.missesFile(), 'utf8');
			const lines = text.split('\n').filter((l) => l.trim());
			// 只读尾部：记录是按时间追加的，新的在最后
			const tail = lines.slice(-limit);
			const out = [];
			for (const line of tail) {
				try {
					out.push(JSON.parse(line));
				} catch {
					/* 跳过坏行：与 readJsonl 一致的策略 */
				}
			}
			return out;
		} catch {
			return [];
		}
	}

	/** 清空未命中记录（用户补完题之后可能想重来一次统计）。 */
	clearMisses() {
		try {
			if (fs.existsSync(this.missesFile())) fs.rmSync(this.missesFile(), { force: true });
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * 题目归一化：把各种来源的题目统一成内部结构。
 *
 * 输入示例（不同来源格式差异很大）：
 *   { q: '题干', options: "[{'letter':'A','text':'甲'}]", answer: 'C', sec: '单选' }
 *   { stem: '题干', opts: [{letter:'A', text:'甲'}], answer: 'C', qtype: '单选' }
 * 输出统一为 { qtype, stem, options:[{letter,text}], answer, source, tags }
 */
export function normalizeItem(raw, { source = '', tags = [] } = {}) {
	if (!raw || typeof raw !== 'object') return null;
	const stem = String(raw.stem ?? raw.q ?? raw.question ?? '').trim();
	if (!stem) return null;

	let options = raw.options ?? raw.opts ?? [];
	if (typeof options === 'string') {
		// 兼容 JSON 字符串（旧题库就是这么存的）
		try {
			options = JSON.parse(options.replace(/'/g, '"'));
		} catch {
			options = [];
		}
	}
	options = (Array.isArray(options) ? options : [])
		.map((o) => {
			if (typeof o === 'string') {
				// "A 甲" / "A、甲" / "A.甲"
				const m = o.match(/^([A-F])\s*[.、．:：]?\s*(.*)$/);
				return m ? { letter: m[1].toUpperCase(), text: m[2].trim() } : null;
			}
			const letter = String(o.letter ?? o.key ?? '').trim().toUpperCase();
			const text = String(o.text ?? o.value ?? o.content ?? '').trim();
			return /^[A-F]$/.test(letter) ? { letter, text } : null;
		})
		.filter(Boolean);

	const qtype = String(raw.qtype ?? raw.sec ?? raw.type ?? '').trim();
	const answer = String(raw.answer ?? raw.ans ?? raw.correct ?? '').trim().toUpperCase();

	return {
		qtype,
		stem,
		options,
		answer,
		source,
		tags: [...(raw.tags ?? []), ...tags],
		// 保留原始题号，便于追溯
		no: raw.n ?? raw.no ?? null,
	};
}

/**
 * 去重：题干归一化后相同、且答案相同 → 视为同一条。
 * 题干相同但答案不同 → 保留两条（可能是不同版本），并在 tags 上标注。
 */
export function dedupe(items) {
	const seen = new Map();
	const out = [];
	for (const it of items) {
		// 用归一化题干做 key（延迟 import 避免循环依赖）
		const key = simpleNorm(it.stem);
		const prev = seen.get(key);
		if (!prev) {
			seen.set(key, it);
			out.push(it);
			continue;
		}
		// 已有：答案不同则两条都留（不同版本），答案相同则跳过
		if (prev.answer !== it.answer) {
			out.push({ ...it, tags: [...(it.tags ?? []), '答案冲突'] });
		}
	}
	return out;
}

/** 给题打上来源文件指纹。
 *
 *  为什么要这道标记：用户要能「删掉某个文件导入的题」。
 *  题本身必须知道「我来自哪个文件」，否则删除时无从判断。
 *  空 hash（粘贴文本导入）时不写，保持数据干净。
 */
function withSrc(item, srcHash) {
	if (!srcHash) return item;
	return { ...item, srcHash };
}

function simpleNorm(s) {
	return String(s ?? '')
		.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
		.replace(/[，,。.；;：:！!？?、\s（）()【】\[\]]/g, '')
		.replace(/^第?\d+[题、.．]?/, '')
		.toLowerCase();
}
