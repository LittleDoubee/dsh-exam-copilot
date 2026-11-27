// 宿主侧 DOM 读取的测试。
//
// 关键约束（都要守）：
//   · 连不上 → 返回 null，不抛（补救不能变成故障点）
//   · 只读不写：只调 Runtime.evaluate，不做点击/导航
//   · 不启动浏览器、不碰凭据
//
// 这里用一个**假 CDP 服务器**（HTTP + WebSocket）来验证协议交互，
// 不需要真的浏览器。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

import { findCdpTab, createDomReader, probeCdp } from '../lib/core/dom-reader.js';

/** 起一个假 CDP 服务：/json/list + WebSocket 求值。 */
function startFakeCdp({ tabs, evalResult = '题干文本\nA. 甲\nB. 乙', failWs = false } = {}) {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			if (req.url === '/json/list') {
				res.writeHead(200, { 'content-type': 'application/json' });
				// PLACEHOLDER 在响应时替换成真实端口 —— 端口要 listen 后才知道，
				// 而 JSON 是每次请求现序列化的，改这里最直接。
				const port = server.address()?.port;
				res.end(JSON.stringify(tabs).replace(/PLACEHOLDER/g, `ws://127.0.0.1:${port}/devtools/page/1`));
				return;
			}
			res.writeHead(404);
			res.end();
		});

		// 记下所有 socket：测试结束时必须主动销毁，
		// 否则 server.close() 会一直等连接关闭 → 测试进程挂住。
		const sockets = new Set();
		server.on('connection', (s) => {
			sockets.add(s);
			s.on('close', () => sockets.delete(s));
		});

		// 极简 WebSocket 握手 + 帧解析（只为测试，只支持文本帧）
		server.on('upgrade', (req, socket) => {
			sockets.add(socket);
			if (failWs) {
				socket.destroy();
				return;
			}
			const key = req.headers['sec-websocket-key'];
			const accept = crypto
				.createHash('sha1')
				.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
				.digest('base64');
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\n' +
					'Upgrade: websocket\r\n' +
					'Connection: Upgrade\r\n' +
					`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
			);

			socket.on('data', (buf) => {
				// 解出一个客户端文本帧（未分片、有 mask）
				const len0 = buf[1] & 0x7f;
				let offset = 2;
				let payloadLen = len0;
				if (len0 === 126) {
					payloadLen = buf.readUInt16BE(2);
					offset = 4;
				}
				const mask = buf.subarray(offset, offset + 4);
				offset += 4;
				const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
				for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

				let msg;
				try {
					msg = JSON.parse(payload.toString('utf8'));
				} catch {
					return;
				}

				// 回一个 result 帧（服务端帧不加 mask）
				const body = Buffer.from(
					JSON.stringify({
						id: msg.id,
						result: { result: { value: evalResult } },
					}),
					'utf8'
				);
				const header =
					body.length < 126
						? Buffer.from([0x81, body.length])
						: Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
				socket.write(Buffer.concat([header, body]));
			});

			socket.on('error', () => {});
		});

		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			resolve({
				port,
				base: `http://127.0.0.1:${port}`,
				close: () =>
					new Promise((r) => {
						for (const s of sockets) {
							try {
								s.destroy();
							} catch {
								/* ignore */
							}
						}
						sockets.clear();
						server.close(() => r());
						// 兜底：不依赖回调（有些环境 close 回调不触发）
						setTimeout(r, 50);
					}),
			});
		});
	});
}

test('findCdpTab：没端口时返回 null，不抛', async () => {
	const r = await findCdpTab(['http://127.0.0.1:59999']); // 无人监听
	assert.equal(r, null);
});

test('findCdpTab：能从假 CDP 找到考试页', async () => {
	const srv = await startFakeCdp({
		tabs: [
			{ type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://x' },
			{ type: 'page', url: 'https://exam.test/paper', title: '考试', webSocketDebuggerUrl: 'ws://y' },
		],
	});
	try {
		const r = await findCdpTab([srv.base]);
		assert.ok(r);
		assert.match(r.tab.url, /exam\.test/);
	} finally {
		await srv.close();
	}
});

test('domReader：端到端能从假 CDP 取出题目', async () => {
	// 端口要在 listen 后才知道，所以先用占位符，起完再替换。
	const srv = await startFakeCdp({
		tabs: [
			{
				type: 'page',
				url: 'https://exam.test/paper/1',
				webSocketDebuggerUrl: 'PLACEHOLDER',
			},
		],
		evalResult:
			'首页 | 帮助\n' +
			'人民币的货币符号是什么？\n' +
			'A. ¥\n' +
			'B. $\n' +
			'C. €\n' +
			'D. £\n' +
			'2. 下一题',
	});
	try {
		// webSocketDebuggerUrl 要指到假服务的 ws 端口

		const reader = createDomReader({ candidates: [srv.base], log: () => {} });
		const q = await reader({ stem: '人民币的货币符号是什么？' });

		assert.ok(q, '应取到题目');
		assert.match(q.stem, /人民币的货币符号/);
		assert.equal(q.options.length, 4, '应取到 4 个选项');
		assert.equal(q.source, 'dom');
	} finally {
		await srv.close();
	}
});

test('domReader：连不上时返回 null，不抛异常', async () => {
	const reader = createDomReader({ candidates: ['http://127.0.0.1:59998'], log: () => {} });
	const q = await reader({ stem: '某题干' });
	assert.equal(q, null);
});

test('domReader：WebSocket 握手失败时返回 null', async () => {
	const srv = await startFakeCdp({
		tabs: [{ type: 'page', url: 'https://exam.test/a', webSocketDebuggerUrl: 'ws://127.0.0.1:1/x' }],
		failWs: true,
	});
	try {
		const reader = createDomReader({ candidates: [srv.base], log: () => {} });
		const q = await reader({ stem: '题干' });
		assert.equal(q, null, '连不上 WS 也要返回 null 而不是抛');
	} finally {
		await srv.close();
	}
});

test('probeCdp：探测失败时给出可执行的下一步', async () => {
	const r = await probeCdp(['http://127.0.0.1:59997']);
	assert.equal(r.ok, false);
	assert.match(r.reason, /remote-debugging-port/, '应告诉用户怎么开启');
	assert.match(r.reason, /不会替你启动浏览器/, '应说明插件不越界');
});

test('probeCdp：探测成功时返回页面信息', async () => {
	const srv = await startFakeCdp({
		tabs: [{ type: 'page', url: 'https://exam.test/x', title: '在线考试', webSocketDebuggerUrl: 'ws://z' }],
	});
	try {
		const r = await probeCdp([srv.base]);
		assert.equal(r.ok, true);
		assert.match(r.url, /exam\.test/);
		assert.equal(r.title, '在线考试');
	} finally {
		await srv.close();
	}
});
