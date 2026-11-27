// 面板 RPC 处理函数：配置、区域、截图与 OCR。依赖由 apply 统一注入。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../core/store.js';
import { EngineClient, waitForHealthy } from '../core/engine-client.js';
import { validateZones, emptyProfile, zonesByRole, ROLE_KEYS, ZONE_ROLES, CONTENT_ROLES, toRelative, migrateZones, mergeDetectedZones, resolveZones } from '../core/zones.js';
import { ACTIONS, ACTION_NAMES, validateAction } from '../core/actions.js';
import { RUN_STATE, PAUSE_REASON } from '../core/guardrails.js';
import { SolverPool } from '../core/llm.js';
import { WebSearcher } from '../core/web-search.js';
import { Runner } from '../core/runner.js';
import { AUTO_ACCEPT, BankIndex, CONFIDENCE, matchQuestion, normalizeStem } from '../core/bank.js';
import { matchAcrossBanks, makeMissRecord, summarizeMisses } from '../core/multi-bank.js';
import { ANSWER_KIND, parseAnswer } from '../core/answer.js';
import { BankStore, dedupe, normalizeItem } from '../core/bank-store.js';
import { dispatch as importDispatch, isSupported, extOf } from '../core/importer.js';
import { bytesToText, hintFor } from '../core/doc-read.js';
import { validateAnswer } from '../core/answer.js';
import { createDomReader, createStructReader, probeCdp } from '../core/dom-reader.js';
import { BrowserLauncher, listBrowsers } from '../core/browser-launch.js';
import { buildOverlayState, toStepLine } from '../core/overlay-view.js';


async function hProfilesList(d) {
	const { store, ok } = d;
		return ok(store.listProfiles());
}


async function hProfilesGet(d, body) {
	const { store, ok, fail } = d;
		const p = store.getProfile(body?.id);
		return p ? ok(p) : fail('NOT_FOUND', `没有这个配置: ${body?.id}`);
}


	/** 新建 profile。channel: 'screen' | 'web'
	 *
	 * 刻意不再提供「全屏自动截图」选项：
	 *    全屏会把桌面图标、任务栏、其他窗口一起截进来污染 OCR，
	 *    而且区域边界应由使用者确定，不由程序代圈。
	 *    新建后一律是空白配置，必须自己圈选。
	 */
async function hProfilesCreate(d, body) {
	const { store, ok, fail } = d;
		const id = body?.id || `profile-${Date.now().toString(36)}`;
		if (store.getProfile(id)) return fail('EXISTS', `已存在: ${id}`);
		const profile = emptyProfile(id, body?.name || '新建考试配置');
		profile.channel = body?.channel === 'web' ? 'web' : 'screen';
		store.saveProfile(profile);
		return ok(profile);
}


async function hProfilesSave(d, body) {
	const { store, ok, fail } = d;
		const profile = body?.profile;
		if (!profile?.id) return fail('INVALID', 'profile.id 必填');
		// 保存前校验区域组：宁可这里报错，也不要运行时点偏
		const check = validateZones(profile.zones, profile.display);
		if (!check.ok && body?.allowInvalid !== true) {
			return fail('ZONES_INVALID', '区域组校验未通过', check);
		}
		profile.updatedAt = new Date().toISOString();
		store.saveProfile(profile);
		return ok({ profile, warnings: check.warnings });
}


async function hProfilesDelete(d, body) {
	const { store, ok } = d;
		return ok({ deleted: store.deleteProfile(body?.id) });
}


	/** 元信息：可用角色、必需角色。面板据此渲染表单。 */
	/** 元信息：可用角色、必需角色。面板据此渲染角色下拉。
	 *
	 *  踩过的坑：这里曾引用已删除的 REQUIRED_ROLES，导致整个调用抛 ReferenceError，
	 *  面板拿到 {ok:false} 后角色下拉就是空的 —— 表现为"圈完选不了角色"。
	 *  现在只依赖真实存在的导出，并附上 labels 供面板显示中文名。
	 */
async function hZonesMeta(d) {
	const { logErr, ok, fail } = d;
		try {
			return ok({
				roles: ROLE_KEYS,
				labels: Object.fromEntries(ROLE_KEYS.map((k) => [k, ZONE_ROLES[k]?.label ?? k])),
				descs: Object.fromEntries(ROLE_KEYS.map((k) => [k, ZONE_ROLES[k]?.desc ?? ''])),
				contentRoles: CONTENT_ROLES,
			});
		} catch (err) {
			logErr('zones.meta 失败', err);
			return fail('META_FAILED', err?.message ?? String(err));
		}
}


	/** 触发圈选（阻塞，最长 3 分钟）。返回矩形，角色由面板指派。 */
async function hZonesPick(d) {
	const { engineClient, ok, fail } = d;
		try {
			const client = await engineClient();
			const res = await client.pickZones({ timeoutMs: 180_000 });
			return ok(res);
		} catch (err) {
			return fail('PICK_FAILED', err?.message ?? String(err));
		}
}


	/** 截图预览（面板缩略图）。刻意不隐藏宿主窗口 —— 预览只是要一张图，
	 * 为它把整个界面闪一下不值得。
	 *
	 *  注：它把图贴在**面板内**，而面板被 DSH 自己挡着，所以用户看到的往往是
	 *  被挡住的那一块。要看真实效果请用 zones.preview（第十一条）。
	 */
	/** 全屏预览：最小化 DSH，显示截图并高亮圈选区域 + 右下角预览窗。
	 *
	 * 与 screen.preview 的区别：
	 *    screen.preview 把图贴在面板里 —— 而面板被 DSH 自己挡着，
	 *    用户看到的是「被挡住的那一块」，等于没预览。
	 *    这个接口把 DSH 让开，全屏展示 + 高亮框 + 角标预览，
	 *    Esc / 右键退出。
	 *
	 *  regions 由前端传当前配置的 zones（含角色名，用于标签）。
	 */
	/** 自动版面识别：按窗口标题（或区域）截图 → OCR → 推断区域。
	 *
	 *  apply=true 时把结果与该配置现有区域合并（手动圈选的永不被覆盖），
	 *  并按窗口客户区写入 rel 比例坐标后保存；否则只返回检测结果供面板预览确认。
	 */
async function hZonesDetect(d, body) {
	const { store, engineClient, ok, fail } = d;
		try {
			const client = await engineClient();
			const profile = body?.profileId ? store.getProfile(body.profileId) : null;
			const title = String(body?.title ?? profile?.window?.title ?? '');
			const res = await client.detectLayout({ title, region: body?.region ?? null, hideWindows: true });
			if (!res?.ok) return fail('DETECT_FAILED', res?.error || '版面识别失败', res);
			const win = res.window || null;
			let detected = (res.zones || []).map((z) => {
				const out = { ...z, source: 'auto' };
				const rel = win ? toRelative(z, win) : null;
				if (rel) out.rel = rel;
				return out;
			});
			if (body?.apply === true && profile) {
				// 上一次自动识别的结果直接作废（否则旧的错框会因 conf 更高而一直赖着不走）；
				// 只保留手动圈选 / 模板来的区域，它们优先级仍高于本次自动结果。
				const existing = migrateZones(profile.zones, win).filter((z) => z.source !== 'auto' && z.source !== 'legacy');
				profile.zones = mergeDetectedZones(existing, detected);
				// 没填标题时用自动定位到的前台窗口标题，否则运行期无法按窗口换算比例坐标
				const winTitle = title || (win && win.title) || '';
				if (winTitle) profile.window = { ...(profile.window || {}), title: winTitle };
				profile.updatedAt = new Date().toISOString();
				store.saveProfile(profile);
				detected = profile.zones;
			}
			return ok({ zones: detected, score: res.score, notes: res.notes || [], window: win, engine: res.engine, applied: body?.apply === true && !!profile });
		} catch (err) {
			return fail('DETECT_FAILED', err?.message ?? String(err));
		}
}


async function hZonesPreview(d, body) {
	const { engineClient, previewRegions, ok, fail } = d;
		try {
			const client = await engineClient();
			const regions = await previewRegions(client, body);
			const res = await client.previewZones({
				regions,
				timeoutMs: Number(body?.timeoutMs) || 300_000,
			});
			return ok(res);
		} catch (err) {
			return fail('PREVIEW_FAILED', err?.message ?? String(err));
		}
}


async function hScreenPreview(d, body) {
	const { engineClient, ok, fail } = d;
		try {
			const client = await engineClient();
			const shot = await client.shotDataUrl(body?.region ?? null, body?.maxWidth ?? 520);
			if (!shot) return fail('SHOT_EMPTY', '截图失败');
			return ok(shot);
		} catch (err) {
			return fail('SHOT_FAILED', err?.message ?? String(err));
		}
}


	/** 只读识别：S1 的验收动作。截指定区域 → OCR → 结构化题目。 */
	/** 只读识别（配置自检）。
	 *
	 * 关键修正：
	 *    以前每次自检都重新截屏，于是"预览看到的那张图"和"自检识别的那张图"
	 *    是两次独立截图 —— 中间界面一变（滚动、弹窗、切窗口），
	 *    识别内容就和用户看到的完全对不上。
	 *    现在：如果传了 cachedImagePath 就用那张已缓存的图；
	 *    否则实时截图，并把它缓存下来，供下一次自检复用。
	 */
async function hOcrRead(d, body) {
	const { engineClient, ok, fail } = d;
		try {
			const client = await engineClient();
			const cached = body?.cachedImagePath;
			const res = await client.ocr({
				region: body?.region ?? null,
				engine: body?.engine ?? 'auto',
				offset: body?.offset,
				imagePath: cached || null,
				// 用缓存图时不再裁切（图已经是那个区域了）
				reuseCached: Boolean(cached),
			});
			return ok({ ...res, fromCache: Boolean(cached) });
		} catch (err) {
			return fail('OCR_FAILED', err?.message ?? String(err));
		}
}


	/** 预览并缓存截图：返回 dataURL + 落盘路径。
	 *
	 *  面板「截图预览」调这个；缓存路径记在 state 里，
	 *  紧接着的「配置自检」会复用它，保证看到什么就识别什么。 */
async function hScreenPreviewCached(d, body) {
	const { name, dataDir, state, engineClient, ok, fail } = d;
		try {
			const client = await engineClient();
			const region = body?.region ?? null;
			const shot = await client.screenshotToFile(region, {
				maxWidth: body?.maxWidth ?? 720,
				dir: path.join(dataDir, 'cache'),
				name: body?.name || 'preview',
			});
			if (!shot) return fail('SHOT_EMPTY', '截图失败');
			state.lastPreview = { path: shot.path, region, at: Date.now() };
			return ok(shot);
		} catch (err) {
			return fail('SHOT_FAILED', err?.message ?? String(err));
		}
}

export function createZoneHandlers(d) {
	return {
		'profiles.list': (...a) => hProfilesList(d, ...a),
		'profiles.get': (...a) => hProfilesGet(d, ...a),
		'profiles.create': (...a) => hProfilesCreate(d, ...a),
		'profiles.save': (...a) => hProfilesSave(d, ...a),
		'profiles.delete': (...a) => hProfilesDelete(d, ...a),
		'zones.meta': (...a) => hZonesMeta(d, ...a),
		'zones.pick': (...a) => hZonesPick(d, ...a),
		'zones.detect': (...a) => hZonesDetect(d, ...a),
		'zones.preview': (...a) => hZonesPreview(d, ...a),
		'screen.preview': (...a) => hScreenPreview(d, ...a),
		'ocr.read': (...a) => hOcrRead(d, ...a),
		'screen.previewCached': (...a) => hScreenPreviewCached(d, ...a),
	};
}
