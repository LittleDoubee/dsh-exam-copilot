// 存储层：JSON 分片，零 ctx，可脱离宿主单测。
//
// 为什么不用 SQLite：
//   bank.json 实测 348KB / 804 题，纯 JSON 完全够用。
//   node:sqlite 在宿主 Node 上属实验特性，better-sqlite3 要 native 编译 ——
//   两者都是"为一个可能装不上的依赖换取用不上的性能"。
//   接口刻意做成可替换：题量过万时换实现，调用方不动。

import fs from 'node:fs';
import path from 'node:path';

/** 递归建目录，已存在不报错。 */
export function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** 原子写：先写 tmp 再 rename，避免半截文件。 */
export function writeJson(file, value) {
	ensureDir(path.dirname(file));
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
	fs.renameSync(tmp, file);
	return value;
}

/** 读 JSON，缺失或损坏都回落到 fallback —— 坏配置不能让插件起不来。 */
export function readJson(file, fallback = null) {
	try {
		const text = fs.readFileSync(file, 'utf8');
		if (text.trim() === '') return fallback;
		return JSON.parse(text);
	} catch {
		return fallback;
	}
}

/** 追加一行 JSON（jsonl）：日志型数据用它，避免每次全量重写。 */
export function appendJsonl(file, record) {
	ensureDir(path.dirname(file));
	fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

/** 读 jsonl，跳过损坏行（中断写入会留半行）。 */
export function readJsonl(file, { limit = 0 } = {}) {
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return [];
	}
	const out = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// 半行/损坏行：跳过而不是整体失败
		}
	}
	return limit > 0 ? out.slice(-limit) : out;
}

/**
 * 存储根。约定：<dataDir>/{settings.json, profiles/, banks/, runs/, shots/, engine.json}
 * dataDir 由宿主注入（~/.dsh/exam-copilot），本模块不认识 ctx。
 */
export class Store {
	constructor(dataDir) {
		this.root = path.resolve(dataDir);
		this.settingsFile = path.join(this.root, 'settings.json');
		this.profilesDir = path.join(this.root, 'profiles');
		this.banksDir = path.join(this.root, 'banks');
		this.runsDir = path.join(this.root, 'runs');
		this.shotsDir = path.join(this.root, 'shots');
		this.cacheDir = path.join(this.root, 'cache');
		ensureDir(this.root);
	}

	// ── settings ────────────────────────────────────────────────
	getSettings() {
		const defaults = {
			// 截图留存：全量保留 N 天 + 总容量上限（用户可改）
			shots: { keepDays: 7, maxTotalMB: 2048 },
			// 危险区：多显示一次确认
			safety: { allowAutoSubmit: false, panicHotkey: 'F12', stopFile: true },
			// 引擎
			engine: { pythonPath: '', idleTtlMs: 900000 },
		};
		const saved = readJson(this.settingsFile, {});
		return deepMerge(defaults, saved ?? {});
	}

	saveSettings(patch) {
		const merged = deepMerge(this.getSettings(), patch ?? {});
		writeJson(this.settingsFile, merged);
		return merged;
	}

	// ── profiles ────────────────────────────────────────────────
	profileFile(id) {
		return path.join(this.profilesDir, `${sanitizeId(id)}.json`);
	}

	listProfiles() {
		ensureDir(this.profilesDir);
		const out = [];
		for (const name of fs.readdirSync(this.profilesDir)) {
			if (!name.endsWith('.json')) continue;
			const p = readJson(path.join(this.profilesDir, name), null);
			if (p && p.id) out.push(summarizeProfile(p));
		}
		return out.sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id), 'zh'));
	}

	getProfile(id) {
		return readJson(this.profileFile(id), null);
	}

	saveProfile(profile) {
		if (!profile?.id) throw new Error('profile.id 必填');
		writeJson(this.profileFile(profile.id), profile);
		return profile;
	}

	deleteProfile(id) {
		const file = this.profileFile(id);
		if (!fs.existsSync(file)) return false;
		fs.rmSync(file, { force: true });
		return true;
	}

	// ── runs ────────────────────────────────────────────────────
	runDir(runId) {
		return path.join(this.runsDir, sanitizeId(runId));
	}

	appendStep(runId, step) {
		appendJsonl(path.join(this.runDir(runId), 'steps.jsonl'), step);
	}

	readSteps(runId, limit = 50) {
		return readJsonl(path.join(this.runDir(runId), 'steps.jsonl'), { limit });
	}

	saveRunMeta(runId, meta) {
		writeJson(path.join(this.runDir(runId), 'meta.json'), meta);
		return meta;
	}

	readRunMeta(runId) {
		return readJson(path.join(this.runDir(runId), 'meta.json'), null);
	}

	shotPath(runId, seq) {
		const dir = path.join(this.shotsDir, sanitizeId(runId));
		ensureDir(dir);
		return path.join(dir, `${String(seq).padStart(5, '0')}.png`);
	}
}

/** profile 列表只回摘要，避免把提示词全文传到面板。 */
export function summarizeProfile(p) {
	return {
		id: p.id,
		name: p.name ?? p.id,
		channel: p.channel ?? 'screen',
		zoneCount: Array.isArray(p.zones) ? p.zones.length : 0,
		updatedAt: p.updatedAt ?? null,
	};
}

/** 只允许安全字符做文件名，防路径穿越。 */
export function sanitizeId(id) {
	const s = String(id ?? '').trim();
	const cleaned = s.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
	return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'unnamed' : cleaned;
}

/** 深合并：数组整体替换（区域组要能被清空，不能按索引合并）。 */
export function deepMerge(base, patch) {
	if (!isPlainObject(base) || !isPlainObject(patch)) return patch ?? base;
	const out = { ...base };
	for (const [k, v] of Object.entries(patch)) {
		out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
	}
	return out;
}

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}
