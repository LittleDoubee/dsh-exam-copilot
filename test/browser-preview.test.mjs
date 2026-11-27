// 浏览器启动器与全屏预览的测试。
//
// 覆盖：
//   第 4 条「监测浏览器不应当由用户自行调试，应当由插件完成，并提示用户」
//   第 5 条「截图预览被 dsh 挡住 → 最小化 + 高亮 + 右下角预览 + Esc/右键退出」

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findBrowser, BrowserLauncher } from '../lib/core/browser-launch.js';

test('findBrowser：能找到 Chrome 或 Edge，且返回真实存在的路径', () => {
	const b = findBrowser();
	if (b === null) {
		// 机器上确实没装浏览器 —— 这是合法结果，但至少要说明清楚
		console.log('本机未安装 Chrome/Edge（测试跳过浏览器相关断言）');
		return;
	}
	assert.ok(['chrome', 'edge'].includes(b.id));
	assert.ok(fs.existsSync(b.exe), '返回的路径必须真实存在: ' + b.exe);
	assert.match(b.name, /Chrome|Edge/);
});

test('BrowserLauncher：profileDir 在插件数据目录下（不碰用户日常 profile）', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshec-bl-'));
	try {
		const bl = new BrowserLauncher({ dataDir: dir });
		const p = bl.profileDir();
		// 关键：必须是 dataDir 的子目录。
		// 用独立 profile 是为了不动用户的书签/历史/登录态，也不会因为
		// 用户已有浏览器在跑而让 --remote-debugging-port 被忽略。
		assert.ok(p.startsWith(dir), 'profile 必须在插件数据目录内: ' + p);
		assert.match(p, /browser-profile/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('BrowserLauncher：未启动时 running=false，close 是安全的空操作', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshec-bl2-'));
	try {
		const bl = new BrowserLauncher({ dataDir: dir });
		assert.equal(bl.running, false);
		assert.deepEqual(bl.close(), { closed: false }, '没启动过就不该报"已关闭"');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('BrowserLauncher：没有浏览器时给出可执行的下一步', async () => {
	// 模拟"找不到浏览器"：临时把候选清空做不到（模块常量），
	// 所以这里只验证 ensure 在找不到浏览器时的返回结构。
	// 用真实的 findBrowser 结果决定断言方向，避免在装了浏览器的机器上假失败。
	const has = findBrowser();
	if (has) {
		// 装了浏览器就不启动（会真的开窗口），只验证结构契约
		const bl = new BrowserLauncher({ dataDir: os.tmpdir() });
		assert.equal(typeof bl.ensure, 'function');
		return;
	}
	const bl = new BrowserLauncher({ dataDir: os.tmpdir() });
	const r = await bl.ensure();
	assert.equal(r.ok, false);
	assert.match(r.reason, /Chrome|Edge/, '应告诉用户装什么');
	assert.match(r.reason, /桌面程序/, '应给出替代方案');
});

/* ── 引擎侧全屏预览的源码契约 ───────────────────── */

const SERVER = path.join(process.cwd(), 'engine', 'server.py');

test('引擎有 /v1/zone/preview 路由与实现', () => {
	const src = fs.readFileSync(SERVER, 'utf8');
	assert.match(src, /"\/v1\/zone\/preview":\s*self\._zone_preview/, '必须有路由');
	assert.match(src, /def _zone_preview\(self, req\):/, '必须有实现');
});

test('全屏预览：先最小化再截图（顺序不能反）', () => {
	const src = fs.readFileSync(SERVER, 'utf8');
	const i = src.indexOf('def _zone_preview');
	const body = src.slice(i, src.indexOf('def _zone_pick', i));
	// 顺序检查：hide_own_windows 必须在 ImageGrab.grab 之前
	const iHide = body.indexOf('hide_own_windows()');
	const iGrab = body.indexOf('ImageGrab.grab');
	assert.ok(iHide > 0 && iGrab > 0, '两者都要有');
	assert.ok(iHide < iGrab, '必须先隐藏宿主再截图，否则会截到 DSH 自己');
});

test('全屏预览：Esc 用全局轮询（不依赖 Tk 焦点）', () => {
	const src = fs.readFileSync(SERVER, 'utf8');
	const i = src.indexOf('def _zone_preview');
	const body = src.slice(i, src.indexOf('def _zone_pick', i));
	assert.match(body, /GetAsyncKeyState/, '必须用全局键状态轮询');
	assert.match(body, /Button-3/, '必须有右键兜底');
});

test('全屏预览：右下角预览窗 + 高亮框', () => {
	const src = fs.readFileSync(SERVER, 'utf8');
	const i = src.indexOf('def _zone_preview');
	const body = src.slice(i, src.indexOf('def _zone_pick', i));
	assert.match(body, /预览：/, '必须有右下角预览标题');
	assert.match(body, /create_rectangle/, '必须画高亮框');
	assert.match(body, /outline="#000000"/, '框要用黑色（用户在浅色界面上看不清青色）');
});

test('全屏预览：结束时一定恢复宿主（放在 finally）', () => {
	const src = fs.readFileSync(SERVER, 'utf8');
	const i = src.indexOf('def _zone_preview');
	const body = src.slice(i, src.indexOf('def _zone_pick', i));
	// finally 里必须有 restore_windows
	const iFinally = body.lastIndexOf('finally:');
	assert.ok(iFinally > 0, '必须有 finally');
	const after = body.slice(iFinally, iFinally + 600);
	assert.match(after, /restore_windows\(hidden\)/, '恢复必须放 finally，否则异常会导致 DSH 回不来');
});
