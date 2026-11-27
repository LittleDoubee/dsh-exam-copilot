window.__ModuleLoader__.load({
	id: 'dsh-exam-copilot',
	factory: (require) => { // dsh-skip-func-length: 宿主模块加载器要求客户端为单文件单工厂，全部代码只能在此函数内
		var module = { exports: {} };
		var exports = module.exports;

		var react = require('react');

		/* ─── 形态铁律 ─────────────────────────────────────────────
		 * 1. 顶层零声明：全部代码在 factory 内（防 client-modules 聚合拼接撞名）。
		 * 2. 内部命名统一 dshec_ 前缀（同上）。
		 * 3. 不写 JSX：手写 react.createElement，免构建步骤。
		 * 4. 只 require shell 提供的裸说明符（react）。
		 * ──────────────────────────────────────────────────────── */

		var dshec_RPC = '/plugins/dsh-exam-copilot/exam-copilot';
/* 前端构建标识。改 client.js 时**必须一起改这里** ——
 * 它是判断「浏览器加载到的是不是最新前端」的唯一可靠依据：
 * 后端版本号来自 status 接口，与前端缓存无关，看不出前端新旧。 */
var dshec_CLIENT_BUILD = '2026-11-27a';
		/* 导入文件时 <input type=file> 的 accept。
		 * 列全是因为一旦漏了，用户在选择框里看不到自己的文件，
		 * 会以为"这个格式不支持"——而实际上只是被过滤器挡掉了。 */
		var DOC_ACCEPT = '.docx,.xlsx,.txt,.md,.csv,.tsv,.json,.jsonl,.pdf,.doc,.xls';
		var dshec_COLOR = {
			bg: 'var(--dsw-alias-bg-base, #fff)',
			fg: 'var(--dsw-alias-label-primary, #111)',
			dim: 'var(--dsw-alias-label-secondary, #666)',
			line: 'var(--dsw-alias-border-l1, #e5e7eb)',
			accent: 'var(--ds-blue, #4f8cff)',
			ok: 'var(--ds-green, #22c55e)',
			warn: 'var(--ds-amber, #f59e0b)',
			bad: 'var(--ds-red, #ef4444)',
			card: 'var(--dsw-alias-bg-l2, #fafafa)',
		};

		/** 所有面板动作的唯一出口。返回 {ok, value|error}，永不抛。 */
		async function dshec_call(endpoint, payload) {
			try {
				const res = await fetch(dshec_RPC, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ endpoint: endpoint, payload: payload || {} }),
				});
				if (!res.ok) return { ok: false, error: { code: 'HTTP_' + res.status, message: '请求失败 ' + res.status } };
				return await res.json();
			} catch (err) {
				return { ok: false, error: { code: 'NETWORK', message: String((err && err.message) || err) } };
			}
		}

		/* ─── 运行期悬浮窗（内联） ─────────────────────────────
		 * 为什么要内联而不是单独文件：
		 *   client-half 只能通过 __ModuleLoader__ 注册一个模块，
		 *   再拆一个模块要多一处声明和一次加载，而这段代码只有几十行。
		 * 行为：运行中在右下角显示题号/状态/答案 + 停止按钮；
		 *       不拦截整层鼠标（只让按钮可点），否则会挡住考试界面。
		 * ──────────────────────────────────────────────────────── */
		var dshec_OVERLAY_ID = 'dshec-overlay';

		function dshec_removeOverlay() {
			var el = document.getElementById(dshec_OVERLAY_ID);
			if (el && el.parentNode) el.parentNode.removeChild(el);
		}

		function dshec_mountOverlay(opts) {
			var endpoint = (opts && opts.endpoint) || '/plugins/dsh-exam-copilot/overlay-state';
			var intervalMs = (opts && opts.intervalMs) || 1200;
			if (document.getElementById(dshec_OVERLAY_ID)) return dshec_removeOverlay;

			var root = document.createElement('div');
			root.id = dshec_OVERLAY_ID;
			root.style.cssText = [
				'position:fixed',
				'right:16px',
				'bottom:16px',
				'z-index:2147483000',
				'font:13px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif',
				'background:rgba(20,22,26,.92)',
				'color:#f5f7fa',
				'border-radius:10px',
				'padding:10px 12px',
				'min-width:180px',
				'box-shadow:0 6px 24px rgba(0,0,0,.35)',
				'pointer-events:none',
				'display:none',
			].join(';');

			var title = document.createElement('div');
			title.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px';
			var dot = document.createElement('span');
			dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block';
			var label = document.createElement('span');
			label.textContent = '考试助手';
			label.style.cssText = 'font-weight:600';
			title.appendChild(dot);
			title.appendChild(label);

			var line1 = document.createElement('div');
			line1.style.cssText = 'color:#9aa4b2;font-size:12px';
			var line2 = document.createElement('div');
			line2.style.cssText = 'font-size:16px;font-weight:600;margin-top:2px';
			var line3 = document.createElement('div');
			line3.style.cssText = 'color:#9aa4b2;font-size:11px;margin-top:2px';

			var btn = document.createElement('button');
			btn.type = 'button';
			btn.textContent = '停止';
			btn.style.cssText = [
				'margin-top:8px',
				'pointer-events:auto',
				'padding:4px 12px',
				'border-radius:6px',
				'border:1px solid #ef4444',
				'background:transparent',
				'color:#ef4444',
				'cursor:pointer',
				'font-size:12px',
			].join(';');
			btn.addEventListener('click', function () {
				fetch('/plugins/dsh-exam-copilot/exam-copilot', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ endpoint: 'panic', payload: {} }),
				}).catch(function () {});
				btn.textContent = '已停止';
				btn.disabled = true;
			});

			root.appendChild(title);
			root.appendChild(line1);
			root.appendChild(line2);
			root.appendChild(line3);
			root.appendChild(btn);
			document.body.appendChild(root);

			var timer = null;
			var stopped = false;

			function poll() {
				if (stopped) return Promise.resolve();
				// 返回 Promise：调用方（含测试）能等这一次刷新落地，
				// 否则"刚 mount 就断言"会读到一个还没填内容的空壳。
				return fetch(endpoint, { headers: { accept: 'application/json' } })
					.then(function (res) {
						return res.ok ? res.json() : null;
					})
					.then(function (st) {
						if (!st) return;
						if (!st.active) {
							root.style.display = 'none';
							return;
						}
						root.style.display = 'block';
						dot.style.background = st.run === 'running' ? '#22c55e' : '#f59e0b';
						line1.textContent =
							st.prog && st.prog.length ? '第 ' + st.prog[0] + '/' + st.prog[1] + ' 题' : st.phase || '';
						line2.textContent = st.answer ? '答案 ' + st.answer : '—';
						line3.textContent = [
							st.run === 'running' ? '运行中' : '已暂停' + (st.pauseReason ? '（' + st.pauseReason + '）' : ''),
							'已完成 ' + (st.handled || 0),
							st.failed ? '失败 ' + st.failed : '',
						]
							.filter(Boolean)
							.join(' · ');
					})
					.catch(function () {});
			}

			timer = window.setInterval(poll, intervalMs);
			poll();

			return function () {
				stopped = true;
				if (timer) window.clearInterval(timer);
				dshec_removeOverlay();
			};
		}

		/** createElement 的薄封装。
		 *
		 *  额外能力：把第 3 个及以后的参数当作 children 收进 props.children。
		 *  这样 dshec_Box / dshec_Row 这类容器组件可以直接读 props.children，
		 *  调用处也能写成 dshec_el(dshec_Box, null, x, y) 而不必手动包 children。
		 *  （早期版本忘了这一步，容器拿到 undefined → 整页渲染成空白。）
		 */
		function dshec_el(tag, props) {
			const children = [];
			for (let i = 2; i < arguments.length; i++) {
				const c = arguments[i];
				if (c === null || c === undefined || c === false) continue;
				if (Array.isArray(c)) children.push.apply(children, c);
				else children.push(c);
			}
			const useProps = props == null ? {} : props;
			if (children.length === 0) return react.createElement(tag, useProps);
			return react.createElement(tag, useProps, children);
		}

		function dshec_Box(props) {
			return dshec_el(
				'div',
				{
					style: {
						border: '1px solid ' + dshec_COLOR.line,
						borderRadius: '10px',
						padding: '14px 16px',
						marginBottom: '12px',
						background: dshec_COLOR.card,
					},
				},
				props.children
			);
		}

		function dshec_Row(props) {
			return dshec_el(
				'div',
				{
					style: {
						display: 'flex',
						alignItems: 'center',
						gap: '10px',
						flexWrap: 'wrap',
						marginBottom: props.gap === false ? 0 : '10px',
					},
				},
				props.children
			);
		}

		function dshec_Btn(props) {
			const busy = props.busy === true;
			const kind = props.kind || 'normal';
			const bg = kind === 'primary' ? dshec_COLOR.accent : kind === 'danger' ? dshec_COLOR.bad : 'transparent';
			const fg = kind === 'normal' ? dshec_COLOR.fg : '#fff';
			return dshec_el(
				'button',
				{
					type: 'button',
					disabled: busy || props.disabled === true,
					onClick: props.onClick,
					style: {
						padding: '6px 14px',
						borderRadius: '7px',
						border: '1px solid ' + (kind === 'normal' ? dshec_COLOR.line : bg),
						background: bg,
						color: fg,
						cursor: busy || props.disabled ? 'not-allowed' : 'pointer',
						opacity: busy || props.disabled ? 0.55 : 1,
						fontSize: '13px',
						fontWeight: kind === 'normal' ? 400 : 500,
					},
				},
				busy ? '处理中…' : props.label
			);
		}

		function dshec_Title(props) {
			return dshec_el(
				'div',
				{ style: { fontSize: '14px', fontWeight: 600, marginBottom: '6px', color: dshec_COLOR.fg } },
				props.children
			);
		}

		function dshec_Dim(props) {
			return dshec_el(
				'div',
				{ style: { fontSize: '12px', color: dshec_COLOR.dim, lineHeight: 1.6 } },
				props.children
			);
		}

		function dshec_Tag(props) {
			const color = props.color || dshec_COLOR.dim;
			return dshec_el(
				'span',
				{
					style: {
						display: 'inline-block',
						padding: '1px 8px',
						borderRadius: '999px',
						fontSize: '11px',
						border: '1px solid ' + color,
						color: color,
						lineHeight: '18px',
					},
				},
				props.children
			);
		}

		function dshec_Field(props) {
			return dshec_el(
				'label',
				{ style: { display: 'block', marginBottom: '10px' } },
				dshec_el('div', { style: { fontSize: '12px', color: dshec_COLOR.dim, marginBottom: '4px' } }, props.label),
				props.children
			);
		}

		function dshec_Input(props) {
			return dshec_el('input', {
				value: props.value == null ? '' : props.value,
				readOnly: props.readOnly === true,
				onChange: function (e) {
					if (props.readOnly === true) return;
					props.onChange(e.target.value);
				},
				placeholder: props.placeholder || '',
				style: {
					width: '100%',
					boxSizing: 'border-box',
					padding: '7px 10px',
					borderRadius: '7px',
					border: '1px solid ' + dshec_COLOR.line,
					background: dshec_COLOR.bg,
					color: dshec_COLOR.fg,
					fontSize: '13px',
				},
			});
		}

		function dshec_TextArea(props) {
			return dshec_el('textarea', {
				value: props.value == null ? '' : props.value,
				readOnly: props.readOnly === true,
				onChange: function (e) {
					if (props.readOnly === true) return;
					props.onChange(e.target.value);
				},
				rows: props.rows || 5,
				placeholder: props.placeholder || '',
				style: {
					width: '100%',
					boxSizing: 'border-box',
					padding: '8px 10px',
					borderRadius: '7px',
					border: '1px solid ' + dshec_COLOR.line,
					background: dshec_COLOR.bg,
					color: dshec_COLOR.fg,
					fontSize: '13px',
					resize: 'vertical',
					fontFamily: 'inherit',
				},
			});
		}

		/* ─── 主页面 ─────────────────────────────────────────────── */
		/** 「overview」页内容。依赖由 dshec_Page 打包传入。 */
		function dshec_tabOverview(P) {
			const { status, busy, refreshStatus, doStartEngine, doStopEngine } = P;
			return (
				dshec_el(
							dshec_Box,
							null,
							dshec_el(dshec_Title, null, '引擎'),
							dshec_el(dshec_Dim, null, '引擎是独立的 Python 常驻进程，负责截图、OCR 与后续的动作执行。它只在需要时启动。'),
							dshec_el('div', { style: { height: '10px' } }),
							dshec_el(
								dshec_Row,
								null,
								dshec_Btn({
									label: '启动引擎',
									kind: 'primary',
									busy: busy === 'engine',
									onClick: doStartEngine,
								}),
								dshec_Btn({ label: '停止引擎', busy: busy === 'engine', onClick: doStopEngine }),
								dshec_Btn({ label: '刷新状态', onClick: refreshStatus })
							),
							status.lastError
								? dshec_el(
										'div',
										{ style: { fontSize: '12px', color: dshec_COLOR.bad, marginTop: '8px' } },
										'上次错误：' + status.lastError
								  )
								: null,
							dshec_el('div', { style: { height: '8px' } }),
							dshec_el(dshec_Dim, null, 'Python：' + (status.pythonPath || '未找到')),
							dshec_el(dshec_Dim, null, '数据目录：' + status.dataDir)
					  )
			);
		}

		/** 「zones」页内容。依赖由 dshec_Page 打包传入。 */
		function dshec_tabZones(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (				dshec_el(
							'div',
							null,							dshec_tabZones_part1(P),
							warnings.length
								? dshec_el(
										dshec_Box,
										null,
										dshec_el(dshec_Title, null, '校验提示'),
										warnings.map(function (w, i) {
											return dshec_el(
												'div',
												{ key: i, style: { fontSize: '12px', color: dshec_COLOR.warn, lineHeight: 1.7 } },
												'• ' + w
											);
										})
								  )
								: null,							dshec_tabZones_part2(P),

							dshec_tabZones_part3(P))
			);
		}
		function dshec_tabZones_part1(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
							dshec_el(
								dshec_Box,
								null,
								dshec_el(dshec_Title, null, '考试配置'),
								dshec_el(dshec_Dim, null, '每个配置 = 一套区域组 + 提示词 + 作答规则。换考试平台只换配置，不动插件。'),
								dshec_el('div', { style: { height: '10px' } }),
								dshec_el(
									dshec_Row,
									null,
									dshec_el(
										'select',
										{
											value: activeId || '',
											onChange: function (e) {
												setActiveId(e.target.value || null);
											},
											style: {
												padding: '6px 10px',
												borderRadius: '7px',
												border: '1px solid ' + dshec_COLOR.line,
												background: dshec_COLOR.bg,
												color: dshec_COLOR.fg,
												fontSize: '13px',
												minWidth: '200px',
											},
										},
										dshec_el('option', { value: '' }, '— 选择配置 —'),
										profiles.map(function (p) {
											return dshec_el('option', { key: p.id, value: p.id }, p.name + '（' + p.zoneCount + ' 区）');
										})
									),
									dshec_Btn({ label: '新建', kind: 'primary', onClick: doCreateProfile }),
									profile ? dshec_Btn({ label: '保存', busy: busy === 'save', onClick: doSave }) : null,
									profile ? dshec_Btn({ label: '删除', kind: 'danger', onClick: doDeleteProfile }) : null
								),
								// 删除确认（内联，不用 window.confirm —— DSH 里同样是禁用的）
								dshec_el(dshec_InlineInput, {
									open: confirmDelete,
									label: '确认删除「' + ((profile && profile.name) || '') + '」？此操作不可撤销。',
									value: 'DELETE',
									onChange: function () {},
									placeholder: '',
									okLabel: '确认删除',
									readOnly: true,
									onOk: confirmDeleteProfile,
									onCancel: function () {
										setConfirmDelete(false);
									},
								}),
								// 新建配置：内联输入（window.prompt 在 DSH 里静默失效）
								dshec_el(dshec_InlineInput, {
									open: creatingProfile,
									label: '新配置名称',
									value: newProfileName,
									onChange: setNewProfileName,
									placeholder: '例如：某在线考试',
									okLabel: '保存',
									onOk: confirmCreateProfile,
									onCancel: function () {
										setCreatingProfile(false);
									},
								}),
							)
			);
		}
		function dshec_tabZones_part2(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (							profile
								? dshec_el(
										dshec_Box,
										null,
										dshec_el(dshec_Title, null, '区域组'),
										dshec_el('div', { style: { height: '8px' } }),
										dshec_channelMode(),
										dshec_navMode(),
										dshec_el('div', { style: { height: '8px' } }),
										dshec_el(dshec_Dim, null, '圈选后指派角色。识别与点击都按角色取值，不按固定坐标 —— 这是能适配不同平台的前提。'),
										dshec_el('div', { style: { height: '10px' } }),
										// ── 圈选（主操作，独占一行）──────────────────────────────
										// 布局重排：
										//   原来这一行挤了 5 个控件 —— 圈选按钮 / 预览范围下拉 / 截图预览
										//   （更早还有「圈为」下拉和「按此角色圈选」，已删），
										//   flex-wrap 换行位置随机、主次不分，用户看不出哪步是必须的。
										//   现在拆成三段各自成块：
										//     ① 圈选按钮（唯一主操作）
										//     ② 指派表单（圈完才出现）
										//     ③ 区域列表（识别范围在下方「配置自检」里）
										// ⓪ 目标窗口 + 自动识别：先自动，不对的再手动圈选修正
										dshec_tabZones_part2_part2(P),
										dshec_el(dshec_Dim, null, '自动识别会保留你手动圈过的区域；识别不全或不准时，再用下面的「圈选」补上或修正。'),
										dshec_el('div', { style: { height: '8px' } }),										dshec_tabZones_part2_part3(P),
										// 圈选完成后指派角色（同样是内联表单，不用 prompt）
										dshec_tabZones_part2_part4(P),										dshec_tabZones_part2_part5(P),										dshec_tabZones_part2_part6(P))
								: null
			);
		}
		function dshec_tabZones_part2_part1(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
										(profile.zones || []).length === 0
											? dshec_el(dshec_Dim, null, '还没有区域。点「圈选一块区域」开始。')
											: dshec_el(
													'table',
													{ style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } },
													dshec_el(
														'thead',
														null,
														dshec_el(
															'tr',
															null,
															['角色', '位置', '尺寸', ''].map(function (h, i) {
																return dshec_el(
																	'th',
																	{
																		key: i,
																		style: {
																			textAlign: 'left',
																			padding: '6px 8px',
																			borderBottom: '1px solid ' + dshec_COLOR.line,
																			color: dshec_COLOR.dim,
																			fontWeight: 500,
																		},
																	},
																	h
																);
															})
														)
													),
													dshec_el(
														'tbody',
														null,
														(profile.zones || []).map(function (z, i) {
															return dshec_el(
																'tr',
																{ key: i },
																dshec_el('td', { style: { padding: '6px 8px' } }, z.role),
																dshec_el('td', { style: { padding: '6px 8px', color: dshec_COLOR.dim } }, z.x + ',' + z.y),
																dshec_el('td', { style: { padding: '6px 8px', color: dshec_COLOR.dim } }, z.w + '×' + z.h),
																dshec_el(
																	'td',
																	{ style: { padding: '6px 8px' } },
																	dshec_el(
																		'button',
																		{
																			type: 'button',
																			onClick: function () {
																				void doRemoveZone(i);
																			},
																			style: {
																				border: 'none',
																				background: 'transparent',
																				color: dshec_COLOR.bad,
																				cursor: 'pointer',
																				fontSize: '12px',
																			},
																		},
																		'删除'
																	)
																)
															);
														})
													)
											  )
			);
		}
		function dshec_tabZones_part2_part2(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
										dshec_el(
											dshec_Row,
											null,
											dshec_el(
												'div',
												{ style: { flex: '1 1 220px', minWidth: '160px' } },
												dshec_el(dshec_Input, {
													placeholder: '目标窗口标题（片段即可，如「考试系统」）',
													value: (profile && profile.window && profile.window.title) || '',
													onChange: function (t) {
														setProfile(function (prev) {
															return Object.assign({}, prev || {}, { window: Object.assign({}, (prev && prev.window) || {}, { title: t }) });
														});
													},
												})
											),
											dshec_Btn({ label: '自动识别区域', kind: 'primary', busy: busy === 'detect', onClick: doDetectZones })
										)
			);
		}
		function dshec_tabZones_part2_part3(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
										dshec_el(
											dshec_Row,
											null,
											dshec_Btn({ label: '圈选一块区域', busy: busy === 'pick', onClick: doPickZone }),
											// 全屏预览跟圈选是一件事的两步：先框，再看框得对不对。
											// 它要把 DSH 让开，所以单独占一个按钮（不影响识别设置）。
											dshec_Btn({ label: '全屏预览', busy: busy === 'full-preview', onClick: doFullPreview }),
											dshec_el(dshec_Dim, null, '框好后在下方选用途，再保存')
										)
			);
		}
		function dshec_tabZones_part2_part4(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
										pendingZone
											? dshec_el(
													'div',
													null,
													dshec_el(
														dshec_Dim,
														null,
														'刚圈选：' +
															pendingZone.box.w +
															'×' +
															pendingZone.box.h +
															' @(' +
															pendingZone.box.x +
															',' +
															pendingZone.box.y +
															') —— 选它是什么区域：'
													),
													dshec_el(dshec_InlineSelect, {
														open: true,
														label: '区域角色',
														options: (zoneMeta.roles || []).map(function (r) {
															return { value: r, label: r + '（' + ((zoneMeta.labels && zoneMeta.labels[r]) || r) + '）' };
														}),
														value: pendingRole,
														onChange: setPendingRole,
														okLabel: '保存',
														onOk: confirmAssignRole,
														onCancel: function () {
															setPendingZone(null);
														},
													})
											  )
											: null
			);
		}
		function dshec_tabZones_part2_part5(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
										(profile.zones || []).length === 0
											? dshec_el(dshec_Dim, null, '还没有区域。点「圈选一块区域」开始。')
											: dshec_el(
													'table',
													{ style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' } },
													dshec_el(
														'thead',
														null,
														dshec_el(
															'tr',
															null,
															['角色', '位置', '尺寸', ''].map(function (h, i) {
																return dshec_el(
																	'th',
																	{
																		key: i,
																		style: {
																			textAlign: 'left',
																			padding: '6px 8px',
																			borderBottom: '1px solid ' + dshec_COLOR.line,
																			color: dshec_COLOR.dim,
																			fontWeight: 500,
																		},
																	},
																	h
																);
															})
														)
													),
													dshec_el(
														'tbody',
														null,
														(profile.zones || []).map(function (z, i) {
															return dshec_el(
																'tr',
																{ key: i },
																dshec_el('td', { style: { padding: '6px 8px' } }, z.role),
																dshec_el('td', { style: { padding: '6px 8px', color: dshec_COLOR.dim } }, z.x + ',' + z.y),
																dshec_el('td', { style: { padding: '6px 8px', color: dshec_COLOR.dim } }, z.w + '×' + z.h),
																dshec_el(
																	'td',
																	{ style: { padding: '6px 8px' } },
																	dshec_el(
																		'button',
																		{
																			type: 'button',
																			onClick: function () {
																				void doRemoveZone(i);
																			},
																			style: {
																				border: 'none',
																				background: 'transparent',
																				color: dshec_COLOR.bad,
																				cursor: 'pointer',
																				fontSize: '12px',
																			},
																		},
																		'删除'
																	)
																)
															);
														})
													)
											  )
			);
		}
		function dshec_tabZones_part2_part6(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
										preview
											? dshec_el(
													'div',
													{ style: { marginTop: '12px' } },
													dshec_el(
														dshec_Dim,
														null,
														'预览：' +
															(previewInfo && previewInfo.role === '__all__'
																? '全部识别范围'
																: '仅 ' + ((previewInfo && previewInfo.role) || '') + ' 区') +
															(previewInfo && previewInfo.region
																? ' @(' +
																  previewInfo.region[0] +
																  ',' +
																  previewInfo.region[1] +
																  ') ' +
																  previewInfo.region[2] +
																  '×' +
																  previewInfo.region[3]
																: '')
													),
													dshec_el('img', {
														src: preview,
														style: {
															maxWidth: '100%',
															marginTop: '6px',
															borderRadius: '8px',
															border: '1px solid ' + dshec_COLOR.line,
														},
													})
											  )
											: null
								  
			);
		}


		function dshec_tabZones_part3(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
							/* 只读识别：S1 验收动作 */
							profile
								? dshec_el(
										dshec_Box,
										null,
										dshec_el(dshec_Title, null, '配置自检（只识别，不操作）'),
										dshec_el(
											dshec_Dim,
											null,
											'用途：确认「你圈的区域 + OCR 设置」是否真的能读对题。它不参与实际答题，只是排障工具 —— 识别不准时先在这里调，别在全自动里试错。'
										),
									// 第 4 条：识别范围与预览放进自检，顺序是「先选范围 → 看截图 → 再识别」。
									// 颠倒过来会在错误的输入上判断 OCR 效果。
										dshec_tabZones_part3_part2(P),
										dshec_el(
											dshec_Dim,
											null,
											'实际答题请到「运行」页：那里才会走题库/模型作答与点击流程。'
										),
										dshec_el('div', { style: { height: '10px' } }),
										dshec_Btn({ label: '开始识别', kind: 'primary', busy: busy === 'ocr', onClick: doReadOnly }),										dshec_tabZones_part3_part3(P))
								: null
					  
			);
		}
		function dshec_tabZones_part3_part1(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
											dshec_el(
												dshec_Row,
												null,
												dshec_el(
													'select',
													{
														value: previewRole,
														onChange: function (e) {
															setPreviewRole(e.target.value);
														},
														style: {
															padding: '5px 9px',
															borderRadius: '7px',
															border: '1px solid ' + dshec_COLOR.line,
															background: dshec_COLOR.bg,
															color: dshec_COLOR.fg,
															fontSize: '12px',
														},
													},
													dshec_el('option', { value: '__all__' }, '全部识别范围'),
													(profile.zones || []).map(function (z, i) {
														return dshec_el('option', { key: i, value: z.role }, '仅 ' + z.role + ' 区');
													})
												),
												// 面板内预览保留：它更快（不开全屏窗），适合快速确认 OCR 读到了什么。
												dshec_Btn({ label: '面板预览', busy: busy === 'preview', onClick: doPreview }),
											)
										
			);
		}
		function dshec_tabZones_part3_part2(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
										dshec_el(
											'div',
											{
												style: {
													marginTop: '12px',
													paddingTop: '10px',
													borderTop: '1px solid ' + dshec_COLOR.line,
												},
											},
											dshec_el(
												'div',
												{ style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } },
												'校验截图（排障用，不影响答题）'
											),
											dshec_el(
												dshec_Row,
												null,
												dshec_el(
													'select',
													{
														value: previewRole,
														onChange: function (e) {
															setPreviewRole(e.target.value);
														},
														style: {
															padding: '5px 9px',
															borderRadius: '7px',
															border: '1px solid ' + dshec_COLOR.line,
															background: dshec_COLOR.bg,
															color: dshec_COLOR.fg,
															fontSize: '12px',
														},
													},
													dshec_el('option', { value: '__all__' }, '全部识别范围'),
													(profile.zones || []).map(function (z, i) {
														return dshec_el('option', { key: i, value: z.role }, '仅 ' + z.role + ' 区');
													})
												),
												// 面板内预览保留：它更快（不开全屏窗），适合快速确认 OCR 读到了什么。
												dshec_Btn({ label: '面板预览', busy: busy === 'preview', onClick: doPreview }),
											)
										)
			);
		}
		function dshec_tabZones_part3_part3(P) {
			const {
				busy, profiles, activeId, setActiveId, profile, setProfile, zoneMeta, preview, previewInfo, previewRole,
				setPreviewRole, ocrResult, warnings, creatingProfile, setCreatingProfile, newProfileName, setNewProfileName,
				confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole, setPendingRole, dshec_InlineInput,
				dshec_InlineSelect, dshec_navMode, dshec_channelMode, doDeleteProfile, confirmDeleteProfile,
				doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole, doRemoveZone,
				doSave, doPreview, doReadOnly, doFullPreview,
			} = P;
			return (
										ocrResult
											? dshec_el(
													'div',
													{ style: { marginTop: '12px' } },
													dshec_el(dshec_Row, null, dshec_el(dshec_Tag, { color: dshec_COLOR.dim }, ocrResult.engineUsed), dshec_el(dshec_Tag, { color: dshec_COLOR.dim }, Math.round(ocrResult.ms) + 'ms'), ocrResult.parsed && ocrResult.parsed.qtype
															? dshec_el(dshec_Tag, { color: dshec_COLOR.accent }, ocrResult.parsed.qtype)
															: null, ocrResult.parsed && ocrResult.parsed.prog
															? dshec_el(dshec_Tag, { color: dshec_COLOR.dim }, ocrResult.parsed.prog.join('/'))
															: null),
													dshec_el(
														'div',
														{
															style: {
																fontSize: '13px',
																lineHeight: 1.75,
																background: dshec_COLOR.bg,
																border: '1px solid ' + dshec_COLOR.line,
																borderRadius: '8px',
																padding: '10px 12px',
																marginTop: '8px',
															},
														},
														dshec_el('div', { style: { fontWeight: 500, marginBottom: '6px' } }, (ocrResult.parsed && ocrResult.parsed.stem) || '（未解析到题干）'),
														((ocrResult.parsed && ocrResult.parsed.opts) || []).map(function (o, i) {
															return dshec_el(
																'div',
																{ key: i, style: { color: dshec_COLOR.dim, paddingLeft: '4px' } },
																o.letter + '. ' + o.text
															);
														})
													)
											  )
											: null
								  
			);
		}






		/** 「bank」页内容。依赖由 dshec_Page 打包传入。 */
		function dshec_tabBank(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (				dshec_el(
							'div',
							null,
							// 题库列表 + 新建
							dshec_el(
								dshec_Box,
								null,
								dshec_el(dshec_Title, null, '题库'),
								dshec_el(
									dshec_Dim,
									null,
									'支持 .txt / .csv / .json / .jsonl。导入时会先「试切分」给你看，确认无误再入库 —— 文档排版千差万别，全自动导入不可靠。'
								),
								dshec_el('div', { style: { height: '10px' } }),								dshec_tabBank_part1(P),
								// 新建题库表单
								dshec_el(dshec_InlineInput, {
									open: creatingBank,
									label: '题库名称',
									value: newBankName,
									onChange: setNewBankName,
									placeholder: '例如：金融法规题库',
									okLabel: '保存',
									onOk: confirmCreateBank,
									onCancel: function () {
										setCreatingBank(false);
									},
								}),
								// 删除确认
								dshec_el(dshec_InlineInput, {
									open: confirmDeleteBank,
									label: '确认删除题库「' + (selectedBank ? selectedBank.name : '') + '」？题库里所有题目都会删除。',
									value: 'DELETE',
									onChange: function () {},
									readOnly: true,
									okLabel: '确认删除',
									onOk: confirmDeleteBankNow,
									onCancel: function () {
										setConfirmDeleteBank(false);
									},
								})
							),

							// 选中题库的详情
							dshec_tabBank_part2(P),

							// 未命中补题
							// 为什么需要：题库只记命中 = 永远不知道漏了什么。
							// 跑完一场考试，这里应该清楚列出「哪些题干所有库都没匹配上」，
							// 并且能就地补答案 —— 题干和选项已经在记录里，只缺答案。
							dshec_el(
								dshec_Box,
								null,
								dshec_el(
									dshec_Row,
									null,
									dshec_el(dshec_Title, null, '未命中补题'),
									misses && misses.totalRecords
										? dshec_el(dshec_Tag, { color: dshec_COLOR.warn }, misses.totalRecords + ' 条记录')
										: null
								),
								dshec_el(
									dshec_Dim,
									null,
									'运行时会记录「所有题库都没匹配上」的题。按题干聚合后列在这里，' +
										'点「补这条」即可把答案填进当前题库 —— 不用重新导入整个文件。'
								),
								dshec_el('div', { style: { height: '10px' } }),
								dshec_el(
									dshec_Row,
									null,
									dshec_Btn({ label: misses ? '刷新记录' : '查看未命中', busy: busy === 'misses', onClick: loadMisses }),
									misses && misses.totalRecords
										? dshec_Btn({ label: '清空记录', kind: 'danger', busy: busy === 'clear-misses', onClick: doClearMisses })
										: null,
									!bankId ? dshec_el(dshec_Dim, null, '（补题前先在上方选题库）') : null
								),

								// 补答案的内联表单（不用 prompt —— DSH 里 window.prompt 是禁用的）
								dshec_tabBank_part3(P),

								// 聚合列表
								dshec_tabBank_part4(P)),

							// 导入
							// 三种入口：
							//   ① 拖入 —— 浏览器给的是**文件字节，没有磁盘路径**。
							//      这是关键：Electron 新版已删掉 File.path，只能读字节。
							//      所以拖入走 fileBytes（base64）→ 宿主 doc-read 解析，
							//      与「填路径」共用同一条解析链路，不是两套实现。
							//   ② 选文件 —— 同样拿字节。用 <input type=file> 而不是让用户手打路径：
							//      手打路径既容易错，也没法在浏览器里浏览目录。
							//   ③ 填路径 / 粘贴 —— 保留，方便脚本化与无法选文件的场景。
							dshec_tabBank_part7(P))
			);
		}
		function dshec_tabBank_part1(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
								dshec_el(
									dshec_Row,
									null,
									dshec_el(
										'select',
										{
											value: bankId || '',
											onChange: function (e) {
												setBankId(e.target.value || null);
											},
											style: {
												padding: '6px 10px',
												borderRadius: '7px',
												border: '1px solid ' + dshec_COLOR.line,
												background: dshec_COLOR.bg,
												color: dshec_COLOR.fg,
												fontSize: '13px',
												minWidth: '220px',
											},
										},
										dshec_el('option', { value: '' }, '— 选择题库 —'),
										(banks || []).map(function (b) {
											return dshec_el(
												'option',
												{ key: b.id, value: b.id },
												b.name + '（' + (b.count || 0) + ' 题 · ' + (b.category || '未分类') + '）'
											);
										})
									),
									dshec_el(dshec_Btn, { label: '刷新', onClick: refreshBankAll }),
									dshec_el(dshec_Btn, {
										label: '新建题库',
										kind: 'primary',
										onClick: function () {
											setNewBankName('');
											setCreatingBank(true);
										},
									}),
									bankId
										? dshec_el(dshec_Btn, {
												label: '删除',
												kind: 'danger',
												onClick: function () {
													setConfirmDeleteBank(true);
												},
										  })
										: null
								)
			);
		}
		function dshec_tabBank_part2(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (							selectedBank
								? dshec_el(
										dshec_Box,
										null,
										dshec_el(dshec_Title, null, '题库详情'),										dshec_tabBank_part2_part2(P),
										dshec_el('div', { style: { height: '8px' } }),
										// 加入当前配置（供运行页使用）
										dshec_tabBank_part2_part3(P),
										dshec_el('div', { style: { height: '8px' } }),
										// 来源文件
										// 选中题库后列出其来源文件，可逐个删除
										//
										// 为什么要按**文件**删而不是按题删：
										//   导错一个文件（版本不对、格式错乱）时，用户想的是
										//   「把那个文件删掉」，不是「一条条勾选 800 道题」。
										//   所以题在入库时就打了 srcHash，删除时按它精确匹配。
										dshec_tabBank_part2_part4(P),

										// 检索
										dshec_tabBank_part2_part5(P),										dshec_tabBank_part2_part6(P))
								: null
			);
		}
		function dshec_tabBank_part2_part1(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (										bankSources
											? dshec_el(
												'div',
												{
													style: {
														marginTop: '10px',
														padding: '10px',
														borderRadius: '8px',
														border: '1px solid ' + dshec_COLOR.line,
													},
												},
												dshec_el(
													'div',
													{ style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } },
													'已导入的文件（' + bankSources.sources.length + ' 个，共 ' + (bankSources.total || 0) + ' 题）'
												),												dshec_tabBank_part2_part1_part2(P),												dshec_tabBank_part2_part1_part3(P))
											: dshec_el(
												'div',
												{
													style: {
														marginTop: '10px',
														padding: '10px',
														borderRadius: '8px',
														border: '1px dashed ' + dshec_COLOR.line,
													},
												},
												dshec_el(
													'div',
													{ style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } },
													'已导入的文件'
												),
												dshec_el(
													'div',
													{ style: { fontSize: '11px', color: dshec_COLOR.dim, lineHeight: 1.7 } },
													'这个题库的题是在「按文件管理」上线之前导入的，没有记录来源文件。'
												),
												(bankSources && bankSources.untracked) || 0
													? dshec_el(
															'div',
															{ style: { fontSize: '11px', color: dshec_COLOR.warn, marginTop: '4px', lineHeight: 1.7 } },
															'共 ' + (bankSources && bankSources.untracked) || 0 + ' 题为旧数据，无法按文件删除。'
																+ '如需按文件管理，新建一个题库重新导入该文件即可。'
														)
													: null
											)
			);
		}
		function dshec_tabBank_part2_part1_part1(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
													bankSources.sources.map(function (s, i) {
														return dshec_el(
															'div',
															{
																key: i,
																style: {
																	fontSize: '12px',
																	lineHeight: 1.6,
																	padding: '6px 0',
																	borderBottom: '1px solid ' + dshec_COLOR.line,
																	display: 'flex',
																	alignItems: 'center',
																	gap: '8px',
																},
															},
															dshec_el(
																'span',
																{ style: { flex: 1, minWidth: 0 } },
																String(s.name || '(未命名)')
															),
															dshec_el(
																'span',
																{ style: { color: dshec_COLOR.dim, fontSize: '11px' } },
																(s.itemCount || 0) + ' 题'
															),
															dshec_el(
																'span',
																{ style: { color: dshec_COLOR.dim, fontSize: '11px' } },
																// 旧数据没有导入时间（那时还没这个机制），
																// 显示「较早」而不是空白 —— 空白会让人以为渲染坏了
																s.at ? String(s.at).replace('T', ' ').slice(0, 10) : '较早导入'
															),
															pendingDeleteSource === s.hash
																? dshec_el(
																	'span',
																	{ style: { display: 'flex', gap: '6px' } },
																	dshec_Btn({
																		label: '确认删除',
																		kind: 'danger',
																		busy: busy === 'rm-source',
																		onClick: function () {
																			void doRemoveSource(s.hash);
																		},
																	}),
																	dshec_Btn({
																		label: '取消',
																		onClick: function () {
																			setPendingDeleteSource(null);
																		},
																	})
																)
																: dshec_Btn({
																	label: '删除',
																	onClick: function () {
																		setPendingDeleteSource(s.hash);
																	},
																})
															);
													})
												
			);
		}
		function dshec_tabBank_part2_part1_part2(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
												dshec_el(
													'div',
													{ style: { maxHeight: '180px', overflowY: 'auto' } },
													bankSources.sources.map(function (s, i) {
														return dshec_el(
															'div',
															{
																key: i,
																style: {
																	fontSize: '12px',
																	lineHeight: 1.6,
																	padding: '6px 0',
																	borderBottom: '1px solid ' + dshec_COLOR.line,
																	display: 'flex',
																	alignItems: 'center',
																	gap: '8px',
																},
															},
															dshec_el(
																'span',
																{ style: { flex: 1, minWidth: 0 } },
																String(s.name || '(未命名)')
															),
															dshec_el(
																'span',
																{ style: { color: dshec_COLOR.dim, fontSize: '11px' } },
																(s.itemCount || 0) + ' 题'
															),
															dshec_el(
																'span',
																{ style: { color: dshec_COLOR.dim, fontSize: '11px' } },
																// 旧数据没有导入时间（那时还没这个机制），
																// 显示「较早」而不是空白 —— 空白会让人以为渲染坏了
																s.at ? String(s.at).replace('T', ' ').slice(0, 10) : '较早导入'
															),
															pendingDeleteSource === s.hash
																? dshec_el(
																	'span',
																	{ style: { display: 'flex', gap: '6px' } },
																	dshec_Btn({
																		label: '确认删除',
																		kind: 'danger',
																		busy: busy === 'rm-source',
																		onClick: function () {
																			void doRemoveSource(s.hash);
																		},
																	}),
																	dshec_Btn({
																		label: '取消',
																		onClick: function () {
																			setPendingDeleteSource(null);
																		},
																	})
																)
																: dshec_Btn({
																	label: '删除',
																	onClick: function () {
																		setPendingDeleteSource(s.hash);
																	},
																})
															);
													})
												)
			);
		}
		function dshec_tabBank_part2_part1_part3(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
												(bankSources && bankSources.untracked) || 0
													? dshec_el(
															'div',
															{ style: { fontSize: '11px', color: dshec_COLOR.warn, marginTop: '6px' } },
															'另有 ' + ((bankSources && bankSources.untracked) || 0) + ' 题没有记录来源文件，无法归到某个文件下'
														)
													: null
											
			);
		}


		function dshec_tabBank_part2_part2(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
										dshec_el(
											dshec_Row,
											null,
											dshec_el(dshec_Tag, { color: dshec_COLOR.accent }, (selectedBank.count || 0) + ' 题'),
											dshec_el(dshec_Tag, { color: dshec_COLOR.dim }, selectedBank.category || '未分类'),
											selectedBank.stats
												? dshec_el(
														dshec_Tag,
														{ color: dshec_COLOR.dim },
														'命中 ' +
															(selectedBank.stats.hits || 0) +
															'（高置信 ' +
															(selectedBank.stats.highConfidence || 0) +
															'）'
												  )
												: null
										)
			);
		}
		function dshec_tabBank_part2_part3(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
										profile
											? dshec_el(
													dshec_Row,
													null,
													dshec_el(
														'button',
														{
															type: 'button',
															onClick: function () {
																toggleBankInProfile(selectedBank.id);
															},
															style: {
																padding: '6px 14px',
																borderRadius: '7px',
																border:
																	'1px solid ' +
																	((profile.answer && profile.answer.bankIds) || []).indexOf(selectedBank.id) >= 0
																		? dshec_COLOR.ok
																		: dshec_COLOR.line,
																background:
																	((profile.answer && profile.answer.bankIds) || []).indexOf(selectedBank.id) >= 0
																		? dshec_COLOR.ok
																		: 'transparent',
																color:
																	((profile.answer && profile.answer.bankIds) || []).indexOf(selectedBank.id) >= 0
																		? '#fff'
																		: dshec_COLOR.fg,
																cursor: 'pointer',
																fontSize: '12px',
															},
														},
														((profile.answer && profile.answer.bankIds) || []).indexOf(selectedBank.id) >= 0
															? '已启用（点击停用）'
															: '用这个题库答题'
													)
											  )
											: dshec_el(dshec_Dim, null, '先在「区域」页选一个配置，才能把题库挂上去')
			);
		}
		function dshec_tabBank_part2_part4(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (										bankSources
											? dshec_el(
												'div',
												{
													style: {
														marginTop: '10px',
														padding: '10px',
														borderRadius: '8px',
														border: '1px solid ' + dshec_COLOR.line,
													},
												},
												dshec_el(
													'div',
													{ style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } },
													'已导入的文件（' + bankSources.sources.length + ' 个，共 ' + (bankSources.total || 0) + ' 题）'
												),												dshec_tabBank_part2_part4_part2(P),												dshec_tabBank_part2_part4_part3(P))
											: dshec_el(
												'div',
												{
													style: {
														marginTop: '10px',
														padding: '10px',
														borderRadius: '8px',
														border: '1px dashed ' + dshec_COLOR.line,
													},
												},
												dshec_el(
													'div',
													{ style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } },
													'已导入的文件'
												),
												dshec_el(
													'div',
													{ style: { fontSize: '11px', color: dshec_COLOR.dim, lineHeight: 1.7 } },
													'这个题库的题是在「按文件管理」上线之前导入的，没有记录来源文件。'
												),
												(bankSources && bankSources.untracked) || 0
													? dshec_el(
															'div',
															{ style: { fontSize: '11px', color: dshec_COLOR.warn, marginTop: '4px', lineHeight: 1.7 } },
															'共 ' + (bankSources && bankSources.untracked) || 0 + ' 题为旧数据，无法按文件删除。'
																+ '如需按文件管理，新建一个题库重新导入该文件即可。'
														)
													: null
											)
			);
		}
		function dshec_tabBank_part2_part4_part1(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
													bankSources.sources.map(function (s, i) {
														return dshec_el(
															'div',
															{
																key: i,
																style: {
																	fontSize: '12px',
																	lineHeight: 1.6,
																	padding: '6px 0',
																	borderBottom: '1px solid ' + dshec_COLOR.line,
																	display: 'flex',
																	alignItems: 'center',
																	gap: '8px',
																},
															},
															dshec_el(
																'span',
																{ style: { flex: 1, minWidth: 0 } },
																String(s.name || '(未命名)')
															),
															dshec_el(
																'span',
																{ style: { color: dshec_COLOR.dim, fontSize: '11px' } },
																(s.itemCount || 0) + ' 题'
															),
															dshec_el(
																'span',
																{ style: { color: dshec_COLOR.dim, fontSize: '11px' } },
																// 旧数据没有导入时间（那时还没这个机制），
																// 显示「较早」而不是空白 —— 空白会让人以为渲染坏了
																s.at ? String(s.at).replace('T', ' ').slice(0, 10) : '较早导入'
															),
															pendingDeleteSource === s.hash
																? dshec_el(
																	'span',
																	{ style: { display: 'flex', gap: '6px' } },
																	dshec_Btn({
																		label: '确认删除',
																		kind: 'danger',
																		busy: busy === 'rm-source',
																		onClick: function () {
																			void doRemoveSource(s.hash);
																		},
																	}),
																	dshec_Btn({
																		label: '取消',
																		onClick: function () {
																			setPendingDeleteSource(null);
																		},
																	})
																)
																: dshec_Btn({
																	label: '删除',
																	onClick: function () {
																		setPendingDeleteSource(s.hash);
																	},
																})
															);
													})
												
			);
		}
		function dshec_tabBank_part2_part4_part2(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
												dshec_el(
													'div',
													{ style: { maxHeight: '180px', overflowY: 'auto' } },
													bankSources.sources.map(function (s, i) {
														return dshec_el(
															'div',
															{
																key: i,
																style: {
																	fontSize: '12px',
																	lineHeight: 1.6,
																	padding: '6px 0',
																	borderBottom: '1px solid ' + dshec_COLOR.line,
																	display: 'flex',
																	alignItems: 'center',
																	gap: '8px',
																},
															},
															dshec_el(
																'span',
																{ style: { flex: 1, minWidth: 0 } },
																String(s.name || '(未命名)')
															),
															dshec_el(
																'span',
																{ style: { color: dshec_COLOR.dim, fontSize: '11px' } },
																(s.itemCount || 0) + ' 题'
															),
															dshec_el(
																'span',
																{ style: { color: dshec_COLOR.dim, fontSize: '11px' } },
																// 旧数据没有导入时间（那时还没这个机制），
																// 显示「较早」而不是空白 —— 空白会让人以为渲染坏了
																s.at ? String(s.at).replace('T', ' ').slice(0, 10) : '较早导入'
															),
															pendingDeleteSource === s.hash
																? dshec_el(
																	'span',
																	{ style: { display: 'flex', gap: '6px' } },
																	dshec_Btn({
																		label: '确认删除',
																		kind: 'danger',
																		busy: busy === 'rm-source',
																		onClick: function () {
																			void doRemoveSource(s.hash);
																		},
																	}),
																	dshec_Btn({
																		label: '取消',
																		onClick: function () {
																			setPendingDeleteSource(null);
																		},
																	})
																)
																: dshec_Btn({
																	label: '删除',
																	onClick: function () {
																		setPendingDeleteSource(s.hash);
																	},
																})
															);
													})
												)
			);
		}
		function dshec_tabBank_part2_part4_part3(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
												(bankSources && bankSources.untracked) || 0
													? dshec_el(
															'div',
															{ style: { fontSize: '11px', color: dshec_COLOR.warn, marginTop: '6px' } },
															'另有 ' + ((bankSources && bankSources.untracked) || 0) + ' 题没有记录来源文件，无法归到某个文件下'
														)
													: null
											
			);
		}


		function dshec_tabBank_part2_part5(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
										dshec_el(
											dshec_Row,
											null,
											dshec_el(dshec_Input, {
												value: bankQuery,
												onChange: setBankQuery,
												placeholder: '搜题干关键词…',
											}),
											dshec_Btn({ label: '搜索', busy: busy === 'bank-search', onClick: doBankSearch }),
											// 清除：同时清空输入框与已列出的结果。
											// 为什么会需要：搜完想看别的题时，旧结果留在下面会误导 ——
											// 用户以为那是"没搜到"或"这就是全部"。
											// 只在里面有东西时才显示，避免占着一个无用的按钮位。
											(bankQuery || (bankHits || []).length)
												? dshec_Btn({ label: '清除', onClick: clearSearch })
												: null,
										)
			);
		}
		function dshec_tabBank_part2_part6(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
										(bankHits || []).length
											? dshec_el(
													'div',
													{
														// 结果多时限定高度并滚动。
														// 不设上限的话，搜一次 30 条会把下面的「导入」「未命中补题」
														// 全推到屏幕外，用户得滚很久才找得到。
														style: { maxHeight: '320px', overflowY: 'auto', marginTop: '8px' },
													},
													bankHits.map(function (h, i) {
														return dshec_el(
															'div',
															{
																key: i,
																style: {
																	fontSize: '12px',
																	lineHeight: 1.6,
																	padding: '6px 0',
																	borderBottom: '1px solid ' + dshec_COLOR.line,
																},
															},
															dshec_el(
																'span',
																{ style: { color: dshec_COLOR.accent, marginRight: '6px' } },
																String(h.answer || '?')
															),
															String(h.stem || h.q || '').slice(0, 90)
														);
													})
											  )
											: null
								  
			);
		}


		function dshec_tabBank_part3(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
								fillMiss
									? dshec_el(
											'div',
											{
												style: {
													marginTop: '8px',
													padding: '10px',
													borderRadius: '8px',
													border: '1px solid ' + dshec_COLOR.accent,
												},
											},
											dshec_el(
												dshec_Dim,
												null,
												'补：' + String(fillMiss.stem || '').slice(0, 60)
											),
											fillMiss.opts && fillMiss.opts.length
												? dshec_el(
														'div',
														{ style: { fontSize: '11px', color: dshec_COLOR.dim, marginTop: '4px' } },
														fillMiss.opts.map(function (o, i) {
															return dshec_el('div', { key: i }, o.letter + '. ' + o.text);
														})
													  )
												: null,
											dshec_el(dshec_Input, {
												value: fillAnswer,
												onChange: setFillAnswer,
												placeholder: '答案：A / ABC / T / 3.14 / 北京',
											}),
											dshec_el(
												dshec_Row,
												{ style: { marginTop: '8px' } },
												dshec_Btn({ label: '补进当前题库', kind: 'primary', busy: busy === 'fill-miss', onClick: doFillMiss }),
												dshec_Btn({
													label: '取消',
													onClick: function () {
														setFillMiss(null);
														setFillAnswer('');
													},
												}),
												dshec_el(dshec_Dim, null, '答案类型会自动识别（字母/判断/数字/文本）')
											)
										  )
									: null
			);
		}
		function dshec_tabBank_part4(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
								misses && (misses.groups || []).length
									? dshec_el(
											'div',
											{ style: { marginTop: '8px', maxHeight: '300px', overflowY: 'auto' } },
											(misses.groups || []).map(function (g, i) {
												return dshec_el(
													'div',
													{
														key: i,
														style: {
															fontSize: '12px',
															lineHeight: 1.6,
															padding: '7px 0',
															borderBottom: '1px solid ' + dshec_COLOR.line,
															display: 'flex',
															alignItems: 'center',
															gap: '8px',
														},
													},
													dshec_el(
														'span',
														{
															style: {
																color: dshec_COLOR.warn,
																fontWeight: 600,
																minWidth: '42px',
															},
														},
														'×' + g.count
													),
													dshec_el(
														'span',
														{ style: { flex: 1, minWidth: 0 } },
														String(g.stem || '').slice(0, 70)
													),
													g.qtype ? dshec_el(dshec_Tag, { color: dshec_COLOR.dim }, g.qtype) : null,
													dshec_Btn({
														label: '补这条',
														disabled: !bankId,
														onClick: function () {
															setFillMiss(g);
															setFillAnswer('');
														},
													})
												);
											})
										  )
									: misses
									? dshec_el(
											'div',
											null,
											dshec_el(
												dshec_Dim,
												null,
												'还没有未命中记录。跑一场考试后，这里会列出所有题库都没匹配上的题。'
											)
										  )
									: null
							
			);
		}
		function dshec_tabBank_part5(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
								dshec_el(
									'div',
									{
										// 关键：拖入不能只用 React 的 onDragOver/onDrop。
										//
										// 为什么：React 的 stopPropagation 只阻止 **React 树内** 的冒泡；
										// DSH 宿主把自己的 dragover/drop 监听器挂在 document / window 上，
										// React 拦不住 → 用户往面板拖文件时，DSH 自己的「拖入提示蒙版」
										// 会同时弹出盖住整个界面，而那个蒙版不归插件管、用户关不掉。
										//
										// 解法：用 ref 拿真实 DOM，在 **capture 阶段** 注册原生监听器。
										// capture 比宿主挂在冒泡阶段的监听更早执行，一旦命中本元素就
										// preventDefault + stopPropagation + stopImmediatePropagation，
										// 事件到此为止，宿主的蒙版逻辑收不到。
										ref: function (node) {
											dshec_bindDropZone(node);
										},
										style: {
											border: '2px dashed ' + (dragOver ? dshec_COLOR.accent : dshec_COLOR.line),
											borderRadius: '10px',
											padding: '18px',
											textAlign: 'center',
											background: dragOver ? 'rgba(79,140,255,0.06)' : 'transparent',
											transition: 'border-color .15s, background .15s',
										},
									},
									dshec_el(
										'div',
										{ style: { fontSize: '13px', color: dragOver ? dshec_COLOR.accent : dshec_COLOR.fg } },
										dragOver ? '松开即可导入' : '把题库文件拖到这里'
									),

									// 「已收到哪个文件」必须显式显示。
									// 为什么：
									//   上一版选完文件、下面预览也切出来了，但点「确认入库」却说没有文件，
									//   用户完全无从判断到底收没收到。把文件名和大小写在框里，状态就是可见的。
									importBytes
										? dshec_el(
												'div',
												{
													style: {
														fontSize: '12px',
														color: dshec_COLOR.ok,
														marginTop: '8px',
													},
												},
												'已收到：' + importFileName + '（' + Math.round((importBytes.bytes.length * 3) / 4 / 1024) + 'KB，可点「确认入库」）'
											  )
										: null,
									dshec_el(
										'div',
										{ style: { fontSize: '11px', color: dshec_COLOR.dim, marginTop: '6px' } },
										'或 '
									),
									dshec_el(
										'input',
										{
											type: 'file',
											accept: DOC_ACCEPT,
											onChange: function (e) {
												var f = e.target.files && e.target.files[0];
												if (f) void doImportFromFile(f);
												// 清空 value：否则选同一个文件第二次不触发 onChange
												e.target.value = '';
											},
											style: {
												marginTop: '6px',
												fontSize: '11px',
												color: dshec_COLOR.dim,
											},
										},
									)
								)
			);
		}
		function dshec_tabBank_part6(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
								importMoreOpen
									? dshec_el(
											'div',
											{ style: { marginTop: '10px' } },
											dshec_el(
												dshec_Row,
												null,
												dshec_el(
													'select',
													{
														value: importMode,
														onChange: function (e) {
															setImportMode(e.target.value);
														},
														style: {
															padding: '5px 9px',
															borderRadius: '7px',
															border: '1px solid ' + dshec_COLOR.line,
															background: dshec_COLOR.bg,
															color: dshec_COLOR.fg,
															fontSize: '12px',
														},
													},
													dshec_el('option', { value: 'paste' }, '粘贴文本'),
													dshec_el('option', { value: 'file' }, '文件路径')
												)
											),
											importMode === 'file'
												? dshec_el(dshec_Input, {
														value: importPath,
														onChange: setImportPath,
														placeholder: '题库文件的完整路径（.docx / .xlsx / .txt）',
													})
												: dshec_el(dshec_TextArea, {
														value: importText,
														onChange: setImportText,
														rows: 8,
														placeholder: '1. 题干内容\nA. 选项甲\nB. 选项乙\n答案：A',
													})
											)
										: null
			);
		}
		function dshec_tabBank_part7(P) {
			const {
				busy, profile, banks, bankId, setBankId, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, bankSources, pendingDeleteSource,
				setPendingDeleteSource, misses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode,
				setImportMode, importText, setImportText, importPath, setImportPath, importPreview, dragOver,
				importMoreOpen, setImportMoreOpen, importBytes, importFileName, dshec_InlineInput, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doBankSearch, refreshBankAll, doRemoveSource, clearSearch,
				loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone, doImportFromFile, doBankImport, dshec_importPreview,
				selectedBank,
			} = P;
			return (
							dshec_el(
								dshec_Box,
								null,
								dshec_el(dshec_Title, null, '导入题目'),
								dshec_el(
									dshec_Dim,
									null,
									'支持 .docx / .xlsx / .txt / .md / .csv / .tsv / .json / .jsonl。' +
										'先把文件拖进下面的框，或点「选择文件」。' +
										'都先「试切分」看清楚，再「确认入库」。'
								),
								dshec_el('div', { style: { height: '10px' } }),
							
								// ── 拖入区 ────────────────────────────────────────────
								// 用 div + onDragOver/onDrop 自己实现，不用原生 <input> ——
								// 原生 input 的样式改不动，且拖入时看不到"已接收"的反馈。
								dshec_tabBank_part5(P),
							
								// ── 路径 / 粘贴（保留，脚本化与特殊场景用）──────────────
								dshec_el('div', { style: { height: '10px' } }),
								// 默认收起：拖入/选文件已覆盖绝大多数场景，常驻一堆输入框只会让面板杂乱。
								dshec_el(
									'button',
									{
										type: 'button',
										onClick: function () {
											setImportMoreOpen(!importMoreOpen);
										},
										style: {
											border: 'none',
											background: 'transparent',
											color: dshec_COLOR.dim,
											cursor: 'pointer',
											fontSize: '12px',
											padding: '2px 0',
											textDecoration: 'underline',
										},
									},
									(importMoreOpen ? '收起' : '或：直接填路径 / 粘贴文本') + ' ▾'
								),								dshec_tabBank_part6(P),
								
								// 「试切分 / 确认入库」两个动作按钮
								dshec_el(
									dshec_Row,
									{ style: { marginTop: '12px' } },
									dshec_Btn({
										label: '试切分（不入库）',
										kind: 'primary',
										busy: busy === 'bank-dry',
										disabled: !bankId,
										onClick: function () {
											void doBankImport(true);
										},
									}),
									dshec_Btn({
										label: '确认入库',
										busy: busy === 'bank-import',
										disabled: !bankId || !importPreview,
										onClick: function () {
											void doBankImport(false);
										},
									}),
									!bankId ? dshec_el(dshec_Dim, null, '先选或新建一个题库') : null
								),
								
								// 试切分结果
								importPreview ? dshec_importPreview() : null,
							)
					  
			);
		}


		/** 「model」页内容。依赖由 dshec_Page 打包传入。 */
		function dshec_tabModel(P) {
			const { busy, profile, dshec_modelPicker, dshec_num, doSave } = P;
			return (
				dshec_el(
							'div',
							null,
							!profile
								? dshec_el(dshec_Box, null, dshec_el(dshec_Dim, null, '先在「区域」页选一个配置。'))
								: dshec_el(
										dshec_Box,
										null,
										dshec_el(dshec_Title, null, '解题模型'),
										dshec_el(
											dshec_Dim,
											null,
											'走 DSH 模型路由，不需要另配 API key。这些设置随配置保存。'
										),
										dshec_el('div', { style: { height: '12px' } }),

										// 是否用模型作答
										dshec_num(
											'useModel',
											'使用模型作答',
											'关闭后只靠题库与人工（题库在 S3 接入）',
											'bool'
										),

										// 模型选择：列出 DSH 里所有可用 provider/model 供选择
										dshec_modelPicker(),

										// 置信度阈值
										dshec_num(
											'confidenceThreshold',
											'置信度阈值',
											'低于此值转人工，不让模型猜。建议 0.7–0.9',
											'number',
											{ step: 0.05, min: 0, max: 1 }
										),

										// 并发
										dshec_num(
											'concurrency',
											'并发题解数',
											'瓶颈 95% 在网络等待，并发是最有效的提速手段',
											'number',
											{ min: 1, max: 10 }
										),

										// 多次作答与联网开关已并入上方「答题模型」区（每个模型一行）

										// 单次模型请求超时
										dshec_num(
											'timeoutSec',
											'模型超时（秒）',
											'单个模型一次作答最多等多久，超时自动重试一次。思考型或慢模型可调大，默认 60，范围 10–300',
											'number',
											{ step: 10, min: 10, max: 300 }
										),

										// 置信度校准：题库高置信命中的题也让模型答一次，按档位统计实际正确率
										dshec_num(
											'calibrate',
											'置信度校准模式',
											'题库命中的题额外让模型作答一次，对照题库答案统计各置信档位的实际正确率（看日志 [calib]）。会额外消耗 token，校准完请关闭',
											'bool'
										),

										// 预算
										// 用「时间」而不是 token 给用户设预算：
										// token 数对用户不可感知，时间才是他能判断的量。
										// 内部仍换算成 token 上限（见 answer.maxTokens* 的默认推导）。
										dshec_num(
											'perQuestionSeconds',
											'单题最长等待（秒）',
											'超过即放弃该题转人工。0 表示不限',
											'number',
											{ min: 0, max: 600 }
										),
										dshec_num(
											'totalMinutes',
											'整场最长运行（分钟）',
											'到时自动暂停，防止失控',
											'number',
											{ min: 0, max: 600 }
										),
										dshec_num(
											'maxQuestions',
											'最多处理题数',
											'到数即停。0 表示不限',
											'number',
											{ min: 0, max: 1000 }
										),



										dshec_el('div', { style: { height: '6px' } }),
										dshec_el(dshec_Row, null, dshec_Btn({ label: '保存', kind: 'primary', busy: busy === 'model', onClick: doSave }))
								  )
					  )
			);
		}

		/** 「prompts」页内容。依赖由 dshec_Page 打包传入。 */
		function dshec_tabPrompts(P) {
			const { busy, profile, dshec_prompt, doSavePrompt } = P;
			return (
				dshec_el(
							'div',
							null,
							!profile
								? dshec_el(dshec_Box, null, dshec_el(dshec_Dim, null, '先在「区域」页选一个配置。'))
								: dshec_el(
										dshec_Box,
										null,
										dshec_el(dshec_Title, null, '提示词'),
										dshec_el(
											dshec_Dim,
											null,
											'分角色填写。操作模型读「操作」这一段来了解它能做什么 —— 可用动作见下方清单。'
										),
										dshec_el('div', { style: { height: '8px' } }),

										// 可用变量提示
										dshec_el(
											dshec_Dim,
											null,
											'可用变量：{{qtype}} 题型 · {{stem}} 题干 · {{options}} 选项 · {{prog}} 题号'
										),
										dshec_el('div', { style: { height: '10px' } }),

										dshec_prompt('system', '系统角色', '定义模型扮演什么角色，回答风格与禁区。', 4),
										dshec_prompt('parse', '解析题目', '如何理解识别出来的题干与选项（纠错、拆分）。', 3),
										dshec_prompt('answer', '作答策略', '怎么判断答案、不确定时怎么办。', 5),
										dshec_prompt('act', '操作说明', '告诉操作模型它能用哪些动作、按什么顺序操作。', 5),

										dshec_el(
											dshec_Row,
											null,
											dshec_Btn({ label: '保存', kind: 'primary', busy: busy === 'prompt', onClick: doSavePrompt })
										)
								  )
					  )
			);
		}

		/** 「run」页内容。依赖由 dshec_Page 打包传入。 */
		function dshec_tabRun(P) {
			const {
				busy, profiles, activeId, setActiveId, dshec_run, runMode, setRunMode, logLines, logOpen, setLogOpen,
				doRunStart, doRunPause, doRunResume, doRunStop, doPanic, doConfirmSubmit,
			} = P;
			return (				dshec_el(
							'div',
							null,
							// 急停：永远置顶，任何时候都能一眼看到
							dshec_el(
								dshec_Box,
								null,
								dshec_el(
									dshec_Row,
									null,
									dshec_el(
										'div',
										{ style: { fontSize: '14px', fontWeight: 600, color: dshec_COLOR.bad } },
										'急停'
									),
									dshec_el(
										dshec_Btn,
										{ label: '立即停止一切动作', kind: 'danger', busy: busy === 'panic', onClick: doPanic }
									),
									dshec_el(dshec_Dim, null, '也可移到屏幕左上角、或创建数据目录下的 STOP 文件')
								)
							),

							dshec_tabRun_part2(P),

							// 运行状态
							dshec_el(
								dshec_Box,
								null,
								dshec_el(dshec_Title, null, '当前状态'),								dshec_tabRun_part3(P)),
							// 最近日志
							dshec_el(
								'div',
								{ style: { marginTop: '8px' } },
								dshec_Btn({ label: logOpen ? '收起日志' : '查看运行日志', onClick: function () { setLogOpen(!logOpen); } }),
								logOpen
									? dshec_el(
										'pre',
										{ style: { fontSize: '11px', maxHeight: '240px', overflow: 'auto', whiteSpace: 'pre-wrap', marginTop: '6px', padding: '6px', border: '1px solid rgba(128,128,128,.3)', borderRadius: '4px' } },
										logLines.length
											? logLines.slice().reverse().map(function (l) {
													return new Date(l.t).toLocaleTimeString() + (l.level === 'warn' ? ' ⚠ ' : '  ') + l.msg;
											  }).join('\n')
											: '（暂无日志）'
									  )
									: null
							)
					  )
			);
		}
		function dshec_tabRun_part1(P) {
			const {
				busy, profiles, activeId, setActiveId, dshec_run, runMode, setRunMode, logLines, logOpen, setLogOpen,
				doRunStart, doRunPause, doRunResume, doRunStop, doPanic, doConfirmSubmit,
			} = P;
			return (
								dshec_el(
									dshec_Row,
									null,
									dshec_el(
										'select',
										{
											value: activeId || '',
											onChange: function (e) {
												setActiveId(e.target.value || null);
											},
											style: {
												padding: '6px 10px',
												borderRadius: '7px',
												border: '1px solid ' + dshec_COLOR.line,
												background: dshec_COLOR.bg,
												color: dshec_COLOR.fg,
												fontSize: '13px',
												minWidth: '180px',
											},
										},
										dshec_el('option', { value: '' }, '— 选择配置 —'),
										profiles.map(function (p) {
											return dshec_el('option', { key: p.id, value: p.id }, p.name);
										})
									),
									dshec_el(
										'select',
										{
											value: runMode,
											onChange: function (e) {
												setRunMode(e.target.value);
											},
											style: {
												padding: '6px 10px',
												borderRadius: '7px',
												border: '1px solid ' + dshec_COLOR.line,
												background: dshec_COLOR.bg,
												color: dshec_COLOR.fg,
												fontSize: '13px',
											},
										},
										dshec_el('option', { value: 'copilot' }, '人机协同（只识别）'),
										dshec_el('option', { value: 'auto' }, '全自动（会点击）')
									)
								)
			);
		}
		function dshec_tabRun_part2(P) {
			const {
				busy, profiles, activeId, setActiveId, dshec_run, runMode, setRunMode, logLines, logOpen, setLogOpen,
				doRunStart, doRunPause, doRunResume, doRunStop, doPanic, doConfirmSubmit,
			} = P;
			return (
							dshec_el(
								dshec_Box,
								null,
								dshec_el(dshec_Title, null, '运行控制'),
								dshec_el(
									dshec_Dim,
									null,
									'协同模式只识别并输出答案，不点击任何东西；全自动模式受动作白名单 + 每步验证约束。'
								),
								dshec_el(
									dshec_Dim,
									null,
									'点「开始」后 DSH 会立刻最小化（否则截图会截到本界面，识别必失败），' +
										'运行状态改由屏幕右下角的置顶悬浮窗显示；题卡答完或点「停止并返回」时自动恢复。'
								),
								dshec_el('div', { style: { height: '10px' } }),								dshec_tabRun_part1(P),
								dshec_el(
									dshec_Row,
									null,
									dshec_el(dshec_Btn, { label: '开始', kind: 'primary', busy: busy === 'run', onClick: doRunStart }),
									dshec_el(dshec_Btn, { label: '暂停', busy: busy === 'run', onClick: doRunPause }),
									dshec_el(dshec_Btn, { label: '恢复', busy: busy === 'run', onClick: doRunResume }),
									dshec_el(dshec_Btn, { label: '停止', busy: busy === 'run', onClick: doRunStop })
								),
								// 自动提交的第二道人工闸
								dshec_run && dshec_run.submitGranted === false
									? dshec_el(
											dshec_Row,
											null,
											dshec_el(
												dshec_Dim,
												null,
												'本次运行尚未确认允许交卷。只有点了下面这个按钮，submit 动作才可能执行。'
											),
											dshec_el(dshec_Btn, {
												label: '确认允许本次交卷',
												kind: 'danger',
												busy: busy === 'submit',
												onClick: doConfirmSubmit,
											})
									  )
									: dshec_run && dshec_run.submitGranted
									? dshec_el(dshec_Row, null, dshec_el(dshec_Tag, { color: dshec_COLOR.warn }, '已允许本次交卷'))
									: null
							)
			);
		}
		function dshec_tabRun_part3(P) {
			const {
				busy, profiles, activeId, setActiveId, dshec_run, runMode, setRunMode, logLines, logOpen, setLogOpen,
				doRunStart, doRunPause, doRunResume, doRunStop, doPanic, doConfirmSubmit,
			} = P;
			return (
								dshec_run
									? dshec_el(
											'div',
											null,
											dshec_el(
												dshec_Row,
												null,
												dshec_el(
													dshec_Tag,
													{
														color:
															dshec_run.run === 'running'
																? dshec_COLOR.ok
																: dshec_run.run === 'paused'
																? dshec_COLOR.warn
																: dshec_COLOR.dim,
													},
													String(dshec_run.run || 'idle')
												),
												dshec_run.phase ? dshec_el(dshec_Tag, { color: dshec_COLOR.dim }, dshec_run.phase) : null,
												dshec_run.pauseReason
													? dshec_el(dshec_Tag, { color: dshec_COLOR.warn }, '暂停原因: ' + dshec_run.pauseReason)
													: null,
												dshec_run.current && dshec_run.current.prog
													? dshec_el(dshec_Tag, { color: dshec_COLOR.dim }, dshec_run.current.prog.join('/'))
													: null,
												dshec_run.answer
													? dshec_el(dshec_Tag, { color: dshec_COLOR.accent }, '答案 ' + dshec_run.answer)
													: null
											),
											dshec_run.current
												? dshec_el(
														'div',
														{
															style: {
																fontSize: '13px',
																lineHeight: 1.7,
																background: dshec_COLOR.bg,
																border: '1px solid ' + dshec_COLOR.line,
																borderRadius: '8px',
																padding: '9px 11px',
																marginTop: '8px',
															},
														},
														dshec_run.current.stem
												  )
												: null,
											dshec_run.stats
												? dshec_el(
														dshec_Dim,
														null,
														'已处理 ' +
															dshec_run.stats.handled +
															' · 已验证 ' +
															dshec_run.stats.verified +
															' · 失败 ' +
															dshec_run.stats.failed +
															(dshec_run.budget
																? dshec_run.budget.remainingTokens === null
																	? ' · token 不限'
																	: ' · 剩余 token ' + dshec_run.budget.remainingTokens
																: '')
												  )
												: null,
											(dshec_run.recentLog || []).length
												? dshec_el(
														'div',
														{ style: { marginTop: '8px' } },
														dshec_run.recentLog.map(function (l, i) {
															return dshec_el(
																'div',
																{
																	key: i,
																	style: { fontSize: '11px', color: dshec_COLOR.dim, lineHeight: 1.7 },
																},
																'· ' + l.msg
															);
														})
												  )
												: null
									  )
									: dshec_el(dshec_Dim, null, '尚未开始。选一个配置后点「开始」。')
							
			);
		}


		/** 「safety」页内容。依赖由 dshec_Page 打包传入。 */
		function dshec_tabSafety(P) {
			const { status, busy, profile, settings, dshec_num, updateSettings, doSaveSettings, doSave } = P;
			return (				dshec_el(
							'div',
							null,
							dshec_el(
								dshec_Box,
								null,
								dshec_el(dshec_Title, null, '急停与提交'),
								dshec_el(
									dshec_Dim,
									null,
									'自动提交默认是关闭的。即使打开，每次运行仍需在运行页手动确认一次。'
								),
								dshec_el('div', { style: { height: '10px' } }),
								profile
									? dshec_num(
											'allowAutoSubmit',
											'允许自动提交交卷',
											'高危：误提交不可撤销。建议只在模拟考时打开',
											'bool'
									  )
									: dshec_el(dshec_Dim, null, '先在「区域」页选一个配置'),
								profile
									? dshec_el(
											dshec_Row,
											null,
											dshec_Btn({
												label: '保存',
												kind: 'primary',
												busy: busy === 'save',
												onClick: doSave,
											})
									  )
									: null
							),							dshec_tabSafety_part1(P),
							dshec_el(
								dshec_Box,
								null,
								dshec_el(dshec_Title, null, '急停方式'),
								dshec_el(dshec_Dim, null, '· 运行页的大红按钮'),
								dshec_el(dshec_Dim, null, '· 鼠标移到屏幕左上角'),
								dshec_el(dshec_Dim, null, '· 在数据目录下创建名为 STOP 的空文件'),
								dshec_el(
									dshec_Dim,
									null,
									'数据目录：' + ((status && status.dataDir) || '未知')
								)
							)
					  )
			);
		}
		function dshec_tabSafety_part1(P) {
			const { status, busy, profile, settings, dshec_num, updateSettings, doSaveSettings, doSave } = P;
			return (
							dshec_el(
								dshec_Box,
								null,
								dshec_el(dshec_Title, null, '截图留存'),
								dshec_el(
									dshec_Dim,
									null,
									'保留最近若干天的截图与步骤记录，便于事后复盘。超出容量上限会先删最旧的。'
								),
								dshec_el('div', { style: { height: '10px' } }),
								dshec_el(
									'div',
									{ style: { marginBottom: '10px' } },
									dshec_el('div', { style: { fontSize: '13px', marginBottom: '3px' } }, '保留天数'),
									dshec_el('input', {
										type: 'number',
										min: 1,
										max: 90,
										value: String((settings.shots && settings.shots.keepDays) || 7),
										onChange: function (e) {
											updateSettings({ shots: { keepDays: Number(e.target.value) || 7 } });
										},
										style: {
											width: '180px',
											padding: '6px 9px',
											borderRadius: '7px',
											border: '1px solid ' + dshec_COLOR.line,
											background: dshec_COLOR.bg,
											color: dshec_COLOR.fg,
											fontSize: '13px',
										},
									})
								),
								dshec_el(
									'div',
									{ style: { marginBottom: '10px' } },
									dshec_el('div', { style: { fontSize: '13px', marginBottom: '3px' } }, '总容量上限（MB）'),
									dshec_el('input', {
										type: 'number',
										min: 100,
										max: 100000,
										value: String((settings.shots && settings.shots.maxTotalMB) || 2048),
										onChange: function (e) {
											updateSettings({ shots: { maxTotalMB: Number(e.target.value) || 2048 } });
										},
										style: {
											width: '180px',
											padding: '6px 9px',
											borderRadius: '7px',
											border: '1px solid ' + dshec_COLOR.line,
											background: dshec_COLOR.bg,
											color: dshec_COLOR.fg,
											fontSize: '13px',
										},
									})
								),
								dshec_el(
									dshec_Row,
									null,
									dshec_Btn({
										label: '保存',
										kind: 'primary',
										busy: busy === 'settings',
										onClick: doSaveSettings,
									})
								)
							)
			);
		}


		function dshec_act_say(P, kind, text) {
			const {
				setToast,
			} = P;
			setToast({ kind: kind, text: text });
			window.setTimeout(function () {
				setToast(null);
			}, 4000);
		}

		async function dshec_act_doStartEngine(P) {
			const {
				setBusy, say, refreshStatus,
			} = P;
			setBusy('engine');
			const res = await dshec_call('engine.start');
			setBusy('');
			if (res.ok) {
				say('ok', '引擎已就绪 v' + (res.value && res.value.version));
				void refreshStatus();
			} else say('bad', res.error.message);
		}

		async function dshec_act_doStopEngine(P) {
			const {
				setBusy, say, refreshStatus,
			} = P;
			setBusy('engine');
			const res = await dshec_call('engine.stop');
			setBusy('');
			if (res.ok) {
				say('ok', '引擎已停止');
				void refreshStatus();
			} else say('bad', res.error.message);
		}

		/** 通用内联输入条（受控）。
		 *
		 *  刻意做成受控：值由父组件持有，本组件只负责渲染与回调。
		 *  这样有两个好处：① 测试能直接驱动，不必模拟内部 hooks；
		 *  ② 打开/关闭表单时「该带什么初值」由父组件决定，不会残留上次输入。 */
		function dshec_act_dshec_InlineInput(P, props) {
			if (!props.open) return null;
			const val = props.value == null ? '' : props.value;
			return dshec_el(
				'div',
				{
					style: {
						border: '1px solid ' + dshec_COLOR.accent,
						borderRadius: '9px',
						padding: '10px 12px',
						marginTop: '10px',
						background: dshec_COLOR.bg,
					},
				},
				dshec_el(
					'div',
					{ style: { fontSize: '12px', color: dshec_COLOR.dim, marginBottom: '6px' } },
					props.label
				),
				props.multiline
					? dshec_el(dshec_TextArea, {
							value: val,
							onChange: props.onChange,
							rows: props.rows || 3,
							placeholder: props.placeholder || '',
							readOnly: props.readOnly === true,
					  })
					: dshec_el(dshec_Input, {
							value: val,
							onChange: props.onChange,
							placeholder: props.placeholder || '',
							readOnly: props.readOnly === true,
					  }),
				dshec_el(
					dshec_Row,
					null,
					dshec_el(dshec_Btn, {
						label: props.okLabel || '保存',
						kind: 'primary',
						disabled: !String(val || '').trim(),
						onClick: function () {
							props.onOk(String(val).trim());
						},
					}),
					dshec_el(dshec_Btn, { label: '取消', onClick: props.onCancel })
				)
			);
		}

		/** 通用内联下拉（受控）。 */
		function dshec_act_dshec_InlineSelect(P, props) {
			if (!props.open) return null;
			const val = props.value == null ? props.defaultValue || '' : props.value;
			return dshec_el(
				'div',
				{
					style: {
						border: '1px solid ' + dshec_COLOR.accent,
						borderRadius: '9px',
						padding: '10px 12px',
						marginTop: '10px',
						background: dshec_COLOR.bg,
					},
				},
				dshec_el(
					'div',
					{ style: { fontSize: '12px', color: dshec_COLOR.dim, marginBottom: '6px' } },
					props.label
				),
				dshec_el(
					'select',
					{
						value: val,
						onChange: function (e) {
							props.onChange(e.target.value);
						},
						style: {
							width: '100%',
							padding: '7px 10px',
							borderRadius: '7px',
							border: '1px solid ' + dshec_COLOR.line,
							background: dshec_COLOR.bg,
							color: dshec_COLOR.fg,
							fontSize: '13px',
						},
					},
					(props.options || []).map(function (o) {
						const v = typeof o === 'string' ? o : o.value;
						const t = typeof o === 'string' ? o : o.label;
						return dshec_el('option', { key: v, value: v }, t);
					})
				),
				dshec_el(
					dshec_Row,
					null,
					dshec_el(dshec_Btn, {
						label: props.okLabel || '保存',
						kind: 'primary',
						onClick: function () {
							props.onOk(val);
						},
					}),
					dshec_el(dshec_Btn, { label: '取消', onClick: props.onCancel })
				)
			);
		}

		/** 模型选择器：列出 DSH 里所有可用的 provider/model。
		 *
		 * 为什么必须让用户自己选：
		 *    "自动挑第一个可用模型"在有多 provider 时是黑盒 ——
		 *    用户不知道花的是谁的钱、跑的是哪个模型。
		 *    清单来自 ctx.llm.listProviders()/listModels()，是宿主真实可用的那些。
		 */
		function dshec_act_dshec_modelPicker(P) {
			const {
				profile, capabilities, dshec_selStyle, dshec_modelRow, currentModelLabel, updateAnswerPatch,
			} = P;
			const answer = (profile && profile.answer) || {};
			const caps = capabilities || {};
			const providers = (caps.models && caps.models.providers) || [];

			if (!caps.models || !caps.models.available) {
				return dshec_el(
					dshec_Dim,
					null,
					'当前宿主没有可用模型（ctx.llm 为空）。仍可用人工或题库通道。'
				);
			}

			// 多次作答：1–5 次。超过 5 次收益很小（一致性已足够判断），token 与限流风险却线性增长
			const voteN = Math.min(5, Math.max(1, Number(answer.multiVote) || 1));
			const voters = (answer.voters || []).slice(0, voteN - 1);
			while (voters.length < voteN - 1) voters.push({ provider: '', model: '', webSearch: false });
			const mainSel = { provider: answer.provider || '', model: answer.model || '', webSearch: answer.webSearch === true };

			return dshec_el(
				'div',
				{ style: { marginBottom: '12px' } },
				dshec_el(
					'div',
					{ style: { fontSize: '13px', marginBottom: '6px' } },
					'答题模型',
					dshec_el(
						'span',
						{ style: { fontSize: '11px', color: dshec_COLOR.dim, marginLeft: '8px' } },
						'来自 DSH 模型路由，不需要另配 key'
					)
				),
				// 主答模型 + 联网，一行
				dshec_modelRow('main', '主答模型', mainSel, providers, [], function (patch) {
					updateAnswerPatch(patch);
				}),
				currentModelLabel(answer, providers),

				// 多次作答次数（选择框）
				dshec_el(
					'div',
					{ style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '10px 0 6px' } },
					dshec_el('span', { style: { fontSize: '13px' } }, '多次作答'),
					dshec_el(
						'select',
						{
							value: String(voteN),
							onChange: function (e) {
								const k = Number(e.target.value);
								const vs = (answer.voters || []).slice(0, Math.max(0, k - 1));
								while (vs.length < k - 1) vs.push({ provider: '', model: '', webSearch: false });
								updateAnswerPatch({ multiVote: k, voters: vs });
							},
							style: dshec_selStyle('150px'),
						},
						[1, 2, 3, 4, 5].map(function (k) {
							return dshec_el(
								'option',
								{ key: k, value: String(k) },
								k === 1 ? '1 次（只用主模型）' : k === 3 ? '3 次（推荐）' : k + ' 次'
							);
						})
					),
					dshec_el(
						'span',
						{ style: { fontSize: '11px', color: dshec_COLOR.dim } },
						voteN > 1 ? '各模型并发作答，全部一致才算高置信，否则记入待复核；token 约 ' + voteN + ' 倍' : ''
					)
				),

				// 参与模型：不能与主模型或彼此重复；留空则由主模型补答
				voters.map(function (v, i) {
					const exclude = [mainSel].concat(
						voters.filter(function (_x, j) {
							return j !== i;
						})
					);
					return dshec_modelRow('v' + i, '参与模型 ' + (i + 2), v, providers, exclude, function (patch) {
						const vs = voters.slice();
						vs[i] = Object.assign({}, vs[i], patch);
						updateAnswerPatch({ voters: vs });
					});
				}),
				voteN > 1
					? dshec_el(dshec_Dim, null, '参与模型留空时由主模型补答（即同一模型多答一次）')
					: null
			);
		}

		function dshec_act_dshec_selStyle(P, minWidth, disabled) {
			return {
				padding: '6px 9px',
				borderRadius: '7px',
				border: '1px solid ' + dshec_COLOR.line,
				background: dshec_COLOR.bg,
				color: dshec_COLOR.fg,
				fontSize: '13px',
				minWidth: minWidth,
				opacity: disabled ? 0.5 : 1,
			};
		}

		/** 一行：标签 + provider + model + 联网开关。exclude 里的模型不出现在下拉中。 */
		function dshec_act_dshec_modelRow(P, key, label, cur, providers, exclude, onPatch) {
			const {
				dshec_selStyle,
			} = P;
			const isMain = key === 'main';
			const curProvider = cur.provider || '';
			const curModel = cur.model || '';
			const providerEntry = providers.find(function (p) {
				return p.id === curProvider;
			});
			const taken = function (m) {
				return exclude.some(function (x) {
					return x && x.provider === curProvider && x.model === m.id && m.id !== curModel;
				});
			};
			const modelOptions = ((providerEntry && providerEntry.models) || []).filter(function (m) {
				return !taken(m);
			});
			return dshec_el(
				'div',
				{ key: key, style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'nowrap', marginBottom: '6px' } },
				dshec_el('span', { style: { fontSize: '12px', color: dshec_COLOR.dim, minWidth: '70px' } }, label),
				dshec_el(
					'select',
					{
						value: curProvider,
						onChange: function (e) {
							// provider 与 model 一次改：分两次调会被 stale closure 吞掉前一次
							onPatch({ provider: e.target.value, model: '' });
						},
						style: dshec_selStyle('140px'),
					},
					dshec_el('option', { value: '' }, isMain ? '自动（第一个可用）' : '（不选，主模型补答）'),
					providers.map(function (p) {
						return dshec_el('option', { key: p.id, value: p.id }, p.name + '（' + p.id + '）');
					})
				),
				dshec_el(
					'select',
					{
						value: curModel,
						disabled: !curProvider,
						onChange: function (e) {
							onPatch({ model: e.target.value });
						},
						style: dshec_selStyle('170px', !curProvider),
					},
					dshec_el('option', { value: '' }, curProvider ? (isMain ? '自动（该 provider 第一个）' : '请选择模型') : '先选 provider'),
					modelOptions.map(function (m) {
						return dshec_el('option', { key: m.id, value: m.id }, m.name || m.id);
					})
				),
				dshec_el(
					'label',
					{ style: { fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap', cursor: 'pointer' } },
					dshec_el('input', {
						type: 'checkbox',
						checked: cur.webSearch === true,
						onChange: function (e) {
							onPatch({ webSearch: e.target.checked });
						},
					}),
					'允许联网'
				)
			);
		}

		/** 显示「实际会用哪个」—— 选了自动也要让用户知道落地目标。 */
		function dshec_act_currentModelLabel(P, answer, providers) {
			if (answer.provider && answer.model) {
				return dshec_el(dshec_Dim, null, '当前：' + answer.provider + ' / ' + answer.model);
			}
			if (answer.provider) {
				const p = providers.find(function (x) {
					return x.id === answer.provider;
				});
				const first = p && p.models && p.models[0];
				return dshec_el(
					dshec_Dim,
					null,
					'当前：' + answer.provider + ' / ' + (first ? first.id : '（该 provider 无可用模型）')
				);
			}
			const firstProvider = providers[0];
			const firstModel = firstProvider && firstProvider.models && firstProvider.models[0];
			return dshec_el(
				dshec_Dim,
				null,
				firstProvider
					? '当前：自动 → ' + firstProvider.id + ' / ' + (firstModel ? firstModel.id : '?')
					: '当前：没有可用模型'
			);
		}

		/** 页面推进方式选择。
		 *
		 *  两种真实场景：
		 *    paged  —— 一题一页，有「下一题」按钮，能用题号验证翻页
		 *    scroll —— 整页多题，只能滚轮上下滑，没有题号可验证
		 *  这不是"高级选项"，是选错就直接跑不通的核心设置，所以放在区域页显眼处。
		 */
		function dshec_act_dshec_navMode(P) {
			const {
				profile, updateNav,
			} = P;
			const nav = (profile && profile.navigation) || {};
			const mode = nav.mode === 'scroll' ? 'scroll' : 'paged';
			return dshec_el(
				'div',
				{ style: { marginBottom: '12px' } },
				dshec_el(
					'div',
					{ style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } },
					'下一题方式',
					dshec_el(
						'span',
						{ style: { fontSize: '11px', color: dshec_COLOR.dim, marginLeft: '8px' } },
						'选错会跑不通，务必按实际界面选'
					)
				),
				dshec_el(
					dshec_Row,
					null,
					dshec_el(
						'button',
						{
							type: 'button',
							onClick: function () {
								updateNav({ mode: 'paged' });
							},
							style: {
								padding: '6px 14px',
								borderRadius: '7px',
								border: '1px solid ' + (mode === 'paged' ? dshec_COLOR.accent : dshec_COLOR.line),
								background: mode === 'paged' ? dshec_COLOR.accent : 'transparent',
								color: mode === 'paged' ? '#fff' : dshec_COLOR.fg,
								cursor: 'pointer',
								fontSize: '12px',
							},
						},
						'点按钮翻页（一题一页）'
					),
					dshec_el(
						'button',
						{
							type: 'button',
							onClick: function () {
								updateNav({ mode: 'scroll' });
							},
							style: {
								padding: '6px 14px',
								borderRadius: '7px',
								border: '1px solid ' + (mode === 'scroll' ? dshec_COLOR.accent : dshec_COLOR.line),
								background: mode === 'scroll' ? dshec_COLOR.accent : 'transparent',
								color: mode === 'scroll' ? '#fff' : dshec_COLOR.fg,
								cursor: 'pointer',
								fontSize: '12px',
							},
						},
						'滚轮下滑（整页多题）'
					)
				),
				dshec_el(
					dshec_Dim,
					null,
					mode === 'scroll'
						? '整页有多个题、没有翻页按钮时用这个。注意：没有题号可验证，翻页靠"画面变了"判断，可靠性低于 paged 模式。'
						: '一题一页、有「下一题」按钮时用这个。可在下方把按钮圈成 next 角色以获得题号级验证。'
				)
			);
		}

		/**
		 * 考试界面类型（桌面 / 网页）+ DOM 补救开关。
		 *
		 * 为什么要区分：桌面和网页走的是**同一套**截屏+OCR+点击链路
		 * （网页窗口对引擎来说就是一块屏幕区域）。区别只在：
		 * 网页多一个"用 DOM 补精度"的选项。
		 *
		 * 为什么 DOM 是可选补救而不是默认：
		 * 连 CDP 要求用户自己用 --remote-debugging-port 启动浏览器；
		 * 不开启时插件只用 OCR，完全正常。
		 */
		function dshec_act_dshec_channelMode(P) { // dsh-skip-func-length: 通道选择块含局部切换函数且有源码契约测试，保持一体
			const {
				busy, profile, setProfile, browserProbe, browsers, browserId, setBrowserId, doProbeBrowser,
			} = P;
			const ch = profile && profile.channel === 'web' ? 'web' : 'screen';
			const domOn = !!(profile && profile.answer && profile.answer.domAssist);

			function setCh(v) {
				setProfile(function (prev) {
					if (!prev) return prev;
					return Object.assign({}, prev, { channel: v });
				});
			}

			function toggleDom() {
				setProfile(function (prev) {
					if (!prev) return prev;
					const answer = Object.assign({}, prev.answer || {});
					answer.domAssist = !answer.domAssist;
					return Object.assign({}, prev, { answer: answer });
				});
			}

			// 与 dshec_Btn 的默认样式完全一致（与「圈选一块区域」同款）
			function btnStyle(on) {
				return {
					padding: '6px 14px',
					borderRadius: '7px',
					border: '1px solid ' + (on ? dshec_COLOR.accent : dshec_COLOR.line),
					background: on ? dshec_COLOR.accent : 'transparent',
					color: on ? '#fff' : dshec_COLOR.fg,
					cursor: 'pointer',
					fontSize: '13px',
				};
			}

			return dshec_el(
				'div',
				{ style: { marginBottom: '14px' } },

				// 标题
				dshec_el(
					'div',
					{ style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } },
					'考试界面'
				),

				// 两个切换按钮
				dshec_el(
					'div',
					{ style: { display: 'flex', gap: '8px', marginBottom: '6px' } },
					dshec_el(
						'button',
						{ type: 'button', onClick: function () { setCh('screen'); }, style: btnStyle(ch === 'screen') },
						'桌面程序'
					),
					dshec_el(
						'button',
						{ type: 'button', onClick: function () { setCh('web'); }, style: btnStyle(ch === 'web') },
						'网页（浏览器里）'
					)
				),

				// 说明
				dshec_el(
					dshec_Dim,
					null,
					ch === 'web'
						? '网页与桌面走同一套识别（截屏+OCR+点击）。网页可额外用 DOM 补精度。'
						: '桌面程序用截屏+OCR，不需要浏览器。'
				),

				// ── DOM 补救（仅网页模式）──────────────────────────
				ch === 'web'
					? dshec_el(
						'div',
						{
							style: {
								marginTop: '10px',
								paddingTop: '10px',
								borderTop: '1px solid ' + dshec_COLOR.line,
							},
						},

						// 开关
						dshec_el(
							'button',
							{ type: 'button', onClick: toggleDom, style: btnStyle(domOn) },
							domOn ? 'DOM 补救：已开启（点击关闭）' : 'DOM 补救：未开启（点击开启）'
						),

						// 说明
						dshec_el(
							'div',
							{ style: { fontSize: '11px', color: dshec_COLOR.dim, marginTop: '4px', lineHeight: 1.7 } },
							'开启后：先用 OCR 识别，只在结果可疑（题干缺失、选项异常、有噪声）时，' +
								'才连浏览器读 DOM 校正。连不上会自动回退到 OCR，不影响答题。'
						),

						// 选浏览器
						browsers.length > 0
							? dshec_el(
								'div',
								{ style: { marginTop: '10px', marginBottom: '6px' } },
								dshec_el('div', { style: { fontSize: '12px', color: dshec_COLOR.dim, marginBottom: '4px' } }, '用哪个浏览器考试'),
								dshec_el(
									'select',
									{
										value: browserId || '',
										onChange: function (e) {
											setBrowserId(e.target.value);
										},
										style: {
											padding: '5px 9px',
											borderRadius: '7px',
											border: '1px solid ' + dshec_COLOR.line,
											background: dshec_COLOR.bg,
											color: dshec_COLOR.fg,
											fontSize: '12px',
										},
									},
									browsers.map(function (b) {
										return dshec_el('option', { key: b.id, value: b.id }, b.name);
									})
								)
							  )
								: dshec_el(
									dshec_Dim,
									null,
									'没检测到 Chrome / Edge / Brave。装一个，或用「桌面程序」模式。'
								  ),

						// 明确告知：考试系统必须在这个新窗口里开
						dshec_el(
							'div',
							{ style: { fontSize: '11px', color: dshec_COLOR.warn, lineHeight: 1.7, marginTop: '8px' } },
							'点下面按钮会新开一个浏览器窗口（独立配置，不碰你日常的书签和登录）。' +
								'请在打开的浏览器窗口里打开考试系统并登录 —— 只有它带调试端口。' +
								'你平时用的浏览器窗口读不到 DOM。'
						),

						// 启动按钮
						dshec_el(
							'div',
							{ style: { marginTop: '8px' } },
							dshec_Btn({ label: '启动并检测浏览器', busy: busy === 'probe', onClick: doProbeBrowser })
						),

						// 探测结果
						browserProbe
							? dshec_el(
								'div',
								{
									style: {
										fontSize: '11px',
										marginTop: '6px',
										lineHeight: 1.7,
										color: browserProbe.ok ? dshec_COLOR.ok : dshec_COLOR.warn,
									},
								},
								browserProbe.ok
									? '已连上：' + (browserProbe.title || browserProbe.url || '')
									: browserProbe.reason || '未检测到'
							  )
								: null
					  )
						: null
		);
		}

		/** 改 navigation 段（函数式更新，避免 stale closure）。 */
		function dshec_act_updateNav(P, patch) {
			const {
				setProfile,
			} = P;
			setProfile(function (prev) {
				if (!prev) return prev;
				return Object.assign({}, prev, {
					navigation: Object.assign({ mode: 'paged', scrollStepPx: 520, maxScrollPerQuestion: 6 }, prev.navigation || {}, patch),
				});
			});
		}

		/** 数字/布尔设置项。直接改 profile.answer，点保存才落盘。 */
		function dshec_act_dshec_num(P, key, label, hint, kind, extra) {
			const {
				profile, updateAnswer,
			} = P;
			const answer = (profile && profile.answer) || {};
			const cur = answer[key];
			const ex = extra || {};

			if (kind === 'bool') {
				const on = cur === true;
				return dshec_el(
					dshec_Row,
					null,
					dshec_el(
						'button',
						{
							type: 'button',
							onClick: function () {
								updateAnswer(key, !on);
							},
							style: {
								padding: '6px 14px',
								borderRadius: '7px',
								border: '1px solid ' + (on ? dshec_COLOR.ok : dshec_COLOR.line),
								background: on ? dshec_COLOR.ok : 'transparent',
								color: on ? '#fff' : dshec_COLOR.fg,
								cursor: 'pointer',
								fontSize: '13px',
								minWidth: '64px',
							},
						},
						on ? '已开启' : '已关闭'
					),
					dshec_el('span', { style: { fontSize: '13px' } }, label),
					dshec_el('span', { style: { fontSize: '11px', color: dshec_COLOR.dim } }, hint || '')
				);
			}

			return dshec_el(
				'div',
				{ style: { marginBottom: '10px' } },
				dshec_el(
					'div',
					{ style: { fontSize: '13px', marginBottom: '3px' } },
					label,
					dshec_el('span', { style: { fontSize: '11px', color: dshec_COLOR.dim, marginLeft: '8px' } }, hint || '')
				),
				dshec_el('input', {
					type: 'number',
					value: cur == null ? '' : String(cur),
					step: ex.step == null ? 1 : ex.step,
					min: ex.min,
					max: ex.max,
					onChange: function (e) {
						const n = Number(e.target.value);
						updateAnswer(key, Number.isFinite(n) ? n : '');
					},
					style: {
						width: '180px',
						padding: '6px 9px',
						borderRadius: '7px',
						border: '1px solid ' + dshec_COLOR.line,
						background: dshec_COLOR.bg,
						color: dshec_COLOR.fg,
						fontSize: '13px',
					},
				})
			);
		}

		/** 提示词编辑项。 */
		function dshec_act_dshec_prompt(P, key, label, hint, rows) {
			const {
				profile, setProfile,
			} = P;
			const prompts = (profile && profile.prompts) || {};
			return dshec_el(
				'div',
				{ style: { marginBottom: '14px' } },
				dshec_el('div', { style: { fontSize: '13px', fontWeight: 500, marginBottom: '2px' } }, label),
				dshec_el('div', { style: { fontSize: '11px', color: dshec_COLOR.dim, marginBottom: '5px' } }, hint),
				dshec_el(dshec_TextArea, {
					value: prompts[key] || '',
					rows: rows || 4,
					placeholder: '留空则使用内置默认提示词',
					onChange: function (v) {
						setProfile(
							Object.assign({}, profile, {
								prompts: Object.assign({}, prompts, { [key]: v }),
							})
						);
					},
				})
			);
		}

		/** 改 answer 的某个字段（不落盘）。
		 *
		 *  必须用函数式更新：早期写成 setProfile({...profile, ...})，
		 *  连调两次时第二次基于同一份**旧的 profile 快照**覆盖，
		 *  会把第一次的改动写回旧值 —— 表现为"选了 provider 但存不上"。
		 *  这是 React 里典型的 stale closure。
		 */
		function dshec_act_updateAnswer(P, key, val) {
			const {
				setProfile,
			} = P;
			setProfile(function (prev) {
				if (!prev) return prev;
				return Object.assign({}, prev, {
					answer: Object.assign({}, prev.answer || {}, { [key]: val }),
				});
			});
		}

		/** 一次改多个 answer 字段（换 provider 时要同时清 model）。 */
		function dshec_act_updateAnswerPatch(P, patch) {
			const {
				setProfile,
			} = P;
			setProfile(function (prev) {
				if (!prev) return prev;
				return Object.assign({}, prev, {
					answer: Object.assign({}, prev.answer || {}, patch),
				});
			});
		}

		async function dshec_act_doSavePrompt(P) {
			const {
				setBusy, profiles, profile, say,
			} = P;
			if (!profile) return;
			setBusy('prompt');
			const res = await dshec_call('profiles.save', { profile: profile });
			setBusy('');
			if (res.ok) say('ok', '提示词已保存');
			else say('bad', res.error.message);
		}

		/** 改全局设置（不落盘）。 */
		function dshec_act_updateSettings(P, patch) {
			const {
				settings, setSettingsState,
			} = P;
			const next = Object.assign({}, settings, patch);
			if (patch.shots) next.shots = Object.assign({}, settings.shots || {}, patch.shots);
			setSettingsState(next);
		}

		async function dshec_act_doSaveSettings(P) {
			const {
				setBusy, settings, say,
			} = P;
			setBusy('settings');
			const res = await dshec_call('settings.save', { patch: { shots: settings.shots } });
			setBusy('');
			if (res.ok) say('ok', '截图设置已保存');
			else say('bad', res.error.message);
		}

		async function dshec_act_doDeleteProfile(P) {
			const {
				activeId, setConfirmDelete,
			} = P;
			if (!activeId) return;
			// 删除不可撤销，走两步确认（内联，不用 window.confirm —— DSH 里它也是禁用的）
			setConfirmDelete(true);
		}

		async function dshec_act_confirmDeleteProfile(P) {
			const {
				profiles, activeId, setActiveId, setProfile, setConfirmDelete, say, refreshProfiles,
			} = P;
			setConfirmDelete(false);
			const res = await dshec_call('profiles.delete', { id: activeId });
			if (res.ok && res.value && res.value.deleted) {
				say('ok', '已删除该配置');
				setActiveId(null);
				setProfile(null);
				await refreshProfiles();
			} else {
				say('bad', (res.error && res.error.message) || '删除失败');
			}
		}

		async function dshec_act_doCreateProfile(P) {
			const {
				setCreatingProfile, setNewProfileName,
			} = P;
			// 不再用 window.prompt：DSH 里它是静默失效的
			setNewProfileName('新建考试配置');
			setCreatingProfile(true);
		}

		async function dshec_act_confirmCreateProfile(P, name) {
			const {
				profiles, setActiveId, setCreatingProfile, say, refreshProfiles,
			} = P;
			setCreatingProfile(false);
			if (!name) return;
			// 一律创建空白配置：区域必须由用户自己圈，
			// 程序替他选全屏只会把桌面杂物一起截进 OCR
			const res = await dshec_call('profiles.create', { name: name });
			if (res.ok) {
				say('ok', '已创建：' + res.value.name + '，请接着圈选识别区域');
				await refreshProfiles();
				setActiveId(res.value.id);
			} else {
				say('bad', res.error.message);
			}
		}

		/** 圈选一块区域，然后让用户指派角色。 */
		/** 自动识别区域：按配置里的目标窗口标题截图 → OCR → 版面分析。
		 *  结果与现有区域合并（手动圈选的不会被覆盖）并直接保存；
		 *  用户随后可用「全屏预览」确认，不对的再手动圈选修正。 */
		async function dshec_act_doDetectZones(P) {
			const {
				setBusy, profile, setProfile, say,
			} = P;
			if (!profile) {
				say('warn', '先选一个配置');
				return;
			}
			const title = (profile.window && profile.window.title) || '';
			if (!title) say('warn', '未填写目标窗口标题，将按全屏识别（建议填写，窗口移动后区域仍有效）');
			setBusy('detect');
			say('warn', '正在识别版面，请保持考试界面在前台…');
			const res = await dshec_call('zones.detect', { profileId: profile.id, title: title, apply: true });
			setBusy('');
			if (!res.ok) {
				say('bad', '自动识别失败：' + res.error.message + '，请手动圈选');
				return;
			}
			const v = res.value || {};
			setProfile(function (prev) {
				return Object.assign({}, prev || {}, { zones: v.zones || [], window: title ? { title: title } : (prev && prev.window) });
			});
			const n = (v.zones || []).filter(function (z) { return z.source === 'auto'; }).length;
			const score = Math.round((Number(v.score) || 0) * 100);
			if (score >= 80) say('ok', '已自动识别 ' + n + ' 个区域（完整度 ' + score + '%），请用全屏预览确认');
			else say('warn', '只识别出 ' + n + ' 个区域（完整度 ' + score + '%）' + ((v.notes || []).length ? '：' + v.notes.join('；') : '') + '，缺的请手动圈选');
		}

		async function dshec_act_doPickZone(P) {
			const {
				setBusy, profile, zoneMeta, setPendingZone, setPendingRole, say,
			} = P;
			if (!profile) {
				say('warn', '先选一个配置');
				return;
			}
			setBusy('pick');
			say('warn', '即将弹出全屏圈选窗口：拖拽画框，Enter 保存，Esc 取消');
			const res = await dshec_call('zones.pick');
			setBusy('');
			if (!res.ok) {
				say('bad', res.error.message);
				return;
			}
			if (!res.value || res.value.ok === false) {
				// 区分"用户主动取消"和"没圈到"：取消不该弹警告
				if (res.value && res.value.cancelled) {
					say('ok', '已取消圈选');
				} else {
					say('warn', '未圈选（或区域过小）');
				}
				return;
			}
			// 存下待指派区域，交给面板里的下拉表单
			setPendingZone(res.value);
			const roles = zoneMeta.roles || [];
			setPendingRole(profile.zones && profile.zones.length === 0 ? 'question' : roles[1] || 'options');
		}

		/** 待指派区域 → 确认后写入 profile。 */
		function dshec_act_confirmAssignRole(P, role) {
			const {
				profile, setProfile, setPreview, setPreviewInfo, setPreviewPath, setPreviewRole, pendingZone,
				setPendingZone, say,
			} = P;
			if (!pendingZone || !role) return;
			const box = pendingZone.box;
			const display = pendingZone.display;
			// 必须用函数式更新：setProfile(next) 里的 next 基于渲染时的旧 profile 快照，
			// 若其间有其他更新（比如刚改过设置），就会把那些改动覆盖掉。
			setProfile(function (prev) {
				const base = prev || { zones: [] };
				return Object.assign({}, base, {
					display: display || base.display,
					zones: (base.zones || []).concat([{ role: role, x: box.x, y: box.y, w: box.w, h: box.h, source: 'manual' }]),
				});
			});
			setPendingZone(null);
			// 圈完立刻截图。
			// 为什么要立刻截：区域刚圈好时，考试界面就在那个位置；
			// 等用户之后再去点预览，界面可能已经翻页/滚动，截出来的不是当初那块。
			// 这张图同时供「面板预览」和「配置自检」用，省掉一次重复截图。
			void (async function () {
				try {
					const shot = await dshec_call('screen.previewCached', {
						region: [box.x, box.y, box.w, box.h],
						maxWidth: 720,
						name: 'zone-' + role,
					});
					if (shot.ok && shot.value && shot.value.dataUrl) {
						setPreview(shot.value.dataUrl);
						setPreviewInfo({
							role: role,
							region: [box.x, box.y, box.w, box.h],
							w: shot.value.w,
							h: shot.value.h,
						});
						setPreviewPath(shot.value.path || null);
						setPreviewRole(role);
					}
				} catch (err) {
					/* 截图失败不影响圈选本身 */
				}
			})();
		
			say('ok', '已添加区域 ' + role + '，记得点保存');
		}

		async function dshec_act_doRemoveZone(P, idx) {
			const {
				profile, setProfile,
			} = P;
			if (!profile) return;
			const zones = (profile.zones || []).slice();
			zones.splice(idx, 1);
			setProfile(Object.assign({}, profile, { zones: zones }));
		}

		async function dshec_act_doSave(P) {
			const {
				setBusy, profiles, profile, setWarnings, say, refreshProfiles,
			} = P;
			if (!profile) return;
			setBusy('save');
			const res = await dshec_call('profiles.save', { profile: profile });
			setBusy('');
			if (res.ok) {
				setWarnings((res.value.warnings || []));
				say('ok', '已保存');
				void refreshProfiles();
			} else {
				const details = res.error.details || {};
				setWarnings((details.errors || []).concat(details.warnings || []));
				say('bad', res.error.message);
			}
		}

		async function dshec_act_doPreview(P) {
			const {
				setBusy, profile, preview, setPreview, setPreviewInfo, setPreviewPath, previewRole, say, currentReadRegion,
			} = P;
			if (!profile) {
				say('warn', '先选一个配置');
				return;
			}
			const region = currentReadRegion();
			setBusy('preview');
			const res = await dshec_call('screen.previewCached', { region, maxWidth: 720, name: 'preview' });
			setBusy('');
			if (res.ok && res.value && res.value.dataUrl) {
				setPreview(res.value.dataUrl);
				setPreviewInfo({ role: previewRole, region: region, w: res.value.w, h: res.value.h });
				// 记住这张图的路径 —— 紧接着的「配置自检」会复用它
				setPreviewPath(res.value.path || null);
				if (!res.value.path) {
					say('warn', '预览成功，但没能缓存成文件，自检将重新截图');
				}
			} else {
				say('bad', (res.error && res.error.message) || '截图失败');
			}
		}

		/** 当前要读的区域（预览与自检共用同一套判定）。 */
		function dshec_act_currentReadRegion(P) {
			const {
				profile, previewRole, unionOfZones,
			} = P;
			const role = previewRole || '__all__';
			if (role === '__all__') {
				return unionOfZones(profile && profile.zones, ['all', 'question', 'options', 'figure']);
			}
			const z = (profile && profile.zones || []).find(function (x) {
				return x.role === role;
			});
			return z ? [z.x, z.y, z.w, z.h] : null;
		}

		/** 取多个角色的并集区域（屏幕坐标）。用于"整个识别范围"。 */
		function dshec_act_unionOfZones(P, zones, roles) {
			const picked = [];
			(roles || []).forEach(function (r) {
				const z = (zones || []).find(function (x) {
					return x.role === r;
				});
				if (z) picked.push(z);
			});
			if (picked.length === 0) return null;
			if (picked.length === 1) return [picked[0].x, picked[0].y, picked[0].w, picked[0].h];
			const x1 = Math.min.apply(
				null,
				picked.map(function (z) {
					return z.x;
				})
			);
			const y1 = Math.min.apply(
				null,
				picked.map(function (z) {
					return z.y;
				})
			);
			const x2 = Math.max.apply(
				null,
				picked.map(function (z) {
					return z.x + z.w;
				})
			);
			const y2 = Math.max.apply(
				null,
				picked.map(function (z) {
					return z.y + z.h;
				})
			);
			return [x1, y1, x2 - x1, y2 - y1];
		}

		/** S1 的核心验收动作：只读识别，不操作任何东西。 */
		async function dshec_act_doReadOnly(P) {
			const {
				setBusy, profile, previewPath, setOcrResult, say, currentReadRegion,
			} = P;
			if (!profile) {
				say('warn', '先选一个配置');
				return;
			}
			setBusy('ocr');
			const region = currentReadRegion();
			// 有预览缓存就复用；没有就实时截一张，并在结果里明确标注来源。
			// 关键：面板上要让人一眼看出"这次识别的是哪张图"，
			// 否则很容易误以为识别的是旧图。
			const res = await dshec_call('ocr.read', {
				region: region,
				cachedImagePath: previewPath || null,
			});
			setBusy('');
			if (res.ok) {
				setOcrResult(res.value);
				const from = res.value.fromCache ? '（用预览那张图）' : '（实时截图）';
				say('ok', '识别完成 ' + Math.round(res.value.ms) + 'ms' + from);
			} else say('bad', res.error.message);
		}

		function dshec_act_mountOverlayIfNeeded(P) {
			const {
				overlayRef,
			} = P;
			if (overlayRef.current) return;
			try {
				// 延迟 require：悬浮窗只在需要时加载，不拖慢首屏
				const mod = window.__DSHEC_OVERLAY__;
				if (mod && typeof mod.mountOverlay === 'function') {
					overlayRef.current = mod.mountOverlay({});
				}
			} catch {
				/* 悬浮窗失败不能影响主流程 */
			}
		}

		function dshec_act_unmountOverlay(P) {
			const {
				overlayRef,
			} = P;
			if (!overlayRef.current) return;
			try {
				overlayRef.current();
			} catch {
				/* ignore */
			}
			overlayRef.current = null;
		}

		async function dshec_act_doRunStart(P) {
			const {
				setBusy, activeId, runMode, say, refreshRun, mountOverlayIfNeeded,
			} = P;
			if (!activeId) {
				say('warn', '先选一个配置');
				return;
			}
			setBusy('run');
			const res = await dshec_call('run.start', { profileId: activeId, mode: runMode });
			setBusy('');
			if (res.ok) {
				// 顶层原生悬浮窗已接管状态显示（DSH 此时已最小化）。
				// 不要再挂页面内悬浮窗：DSH 恢复后会出现两个重叠的框，
				// 而且页内那个在 DSH 最小化时根本没人看得见。
				const native = res.value.overlay === 'native';
				say(
					'ok',
					'已开始（' +
						res.value.mode +
						'）' +
						(native ? ' — DSH 已最小化，状态见右下角悬浮窗' : ' — 注意：悬浮窗未能显示，请回面板查看状态')
				);
				if (!native) mountOverlayIfNeeded();
				void refreshRun();
			} else say('bad', res.error.message);
		}

		async function dshec_act_doRunPause(P) {
			const {
				setBusy, say, refreshRun,
			} = P;
			setBusy('run');
			const res = await dshec_call('run.pause', {});
			setBusy('');
			if (res.ok) say('ok', '已暂停');
			else say('bad', res.error.message);
			void refreshRun();
		}

		async function dshec_act_doRunResume(P) {
			const {
				setBusy, say, refreshRun,
			} = P;
			setBusy('run');
			const res = await dshec_call('run.resume', {});
			setBusy('');
			if (res.ok) say('ok', '已恢复');
			else say('bad', res.error.message);
			void refreshRun();
		}

		async function dshec_act_doRunStop(P) {
			const {
				setBusy, say, refreshRun, unmountOverlay,
			} = P;
			setBusy('run');
			const res = await dshec_call('run.stop', {});
			setBusy('');
			if (res.ok) say('ok', '已停止');
			else say('bad', res.error.message);
			unmountOverlay();
			void refreshRun();
		}

		/** 急停：不依赖任何状态，永远可用。 */
		async function dshec_act_doPanic(P) {
			const {
				setBusy, say, refreshRun, unmountOverlay,
			} = P;
			setBusy('panic');
			const res = await dshec_call('panic');
			setBusy('');
			if (res.ok) say('warn', '已急停');
			else say('bad', res.error.message);
			// panic 后运行已停，悬浮窗留着只会误导
			unmountOverlay();
			void refreshRun();
		}

		async function dshec_act_doConfirmSubmit(P) {
			const {
				setBusy, say, refreshRun,
			} = P;
			setBusy('submit');
			const res = await dshec_call('run.confirmSubmit', { reason: 'panel-confirmed' });
			setBusy('');
			if (res.ok) say('warn', '已允许本次交卷（仅本次运行有效）');
			else say('bad', res.error.message);
			void refreshRun();
		}

		async function dshec_act_confirmCreateBank(P, name) {
			const {
				banks, setBankId, setCreatingBank, say, loadBanks,
			} = P;
			setCreatingBank(false);
			if (!name) return;
			const res = await dshec_call('banks.create', { name: name });
			if (res.ok) {
				say('ok', '已创建题库：' + res.value.name);
				await loadBanks();
				setBankId(res.value.id);
			} else say('bad', res.error.message);
		}

		async function dshec_act_confirmDeleteBankNow(P) {
			const {
				banks, bankId, setBankId, setBankDetail, setConfirmDeleteBank, say, loadBanks,
			} = P;
			setConfirmDeleteBank(false);
			if (!bankId) return;
			const res = await dshec_call('banks.delete', { id: bankId });
			if (res.ok && res.value.deleted) {
				say('ok', '题库已删除');
				setBankId(null);
				setBankDetail(null);
				await loadBanks();
			} else say('bad', (res.error && res.error.message) || '删除失败');
		}

		/** 把题库挂到当前配置上（供运行页使用）。 */
		function dshec_act_toggleBankInProfile(P, id) {
			const {
				setProfile,
			} = P;
			setProfile(function (prev) {
				if (!prev) return prev;
				const answer = Object.assign({}, prev.answer || {});
				const ids = Array.isArray(answer.bankIds) ? answer.bankIds.slice() : [];
				const i = ids.indexOf(id);
				if (i >= 0) ids.splice(i, 1);
				else ids.push(id);
				answer.bankIds = ids;
				return Object.assign({}, prev, { answer });
			});
		}

		/**
		 * 全屏预览：最小化 DSH，全屏显示截图并高亮圈选区域 + 右下角预览。
		 *
		 * 为什么不在面板里显示：
		 *   面板被 DSH 自己盖着，把截图放进面板，看到的其实是
		 *   「被挡住的那一块」—— 等于没预览。
		 *   所以要 DSH 让开，在全屏画面上确认框选对不对。
		 */
		async function dshec_act_doFullPreview(P) {
			const {
				setBusy, profile, preview, say,
			} = P;
			if (!profile) {
				say('warn', '先选一个配置');
				return;
			}
			setBusy('full-preview');
			say('ok', '即将全屏预览：DSH 会先最小化，Esc 或右键退出');
			const res = await dshec_call('zones.preview', {
				zones: profile.zones || [],
				title: (profile.window && profile.window.title) || (profile.target && profile.target.title) || '',
			});
			setBusy('');
			if (!res.ok) {
				say('bad', res.error.message);
				return;
			}
			if (res.value && res.value.dismissed) say('ok', '已退出预览');
		}

		/** 检测浏览器 DOM 通道是否可用。只读探测，不改任何状态。 */
		async function dshec_act_doProbeBrowser(P) {
			const {
				setBusy, setBrowserProbe, browserId,
			} = P;
			setBusy('probe');
			const res = await dshec_call('browser.probe', { browserId: browserId });
			setBusy('');
			if (res.ok) setBrowserProbe(res.value);
			else setBrowserProbe({ ok: false, reason: res.error.message });
		}

		async function dshec_act_doBankSearch(P) {
			const {
				setBusy, banks, bankId, bankQuery, setBankHits, say,
			} = P;
			if (!bankId) {
				say('warn', '先选题库');
				return;
			}
			setBusy('bank-search');
			const res = await dshec_call('banks.search', { id: bankId, q: bankQuery });
			setBusy('');
			if (res.ok) setBankHits(res.value.hits || []);
			else say('bad', res.error.message);
		}

		/** 拉取某题库的来源文件列表。 */
		async function dshec_act_loadBankSources(P, id) {
			const {
				banks, setBankSources,
			} = P;
			if (!id) {
				setBankSources(null);
				return;
			}
			const res = await dshec_call('banks.sources', { id: id });
			if (res.ok) setBankSources(res.value);
			else setBankSources(null);
		}

		/**
		 * 刷新题库相关的**全部**数据：列表 + 当前库详情 + 来源文件。
		 *
		 * 为什么不能只调 loadBanks：
		 *   loadBanks 只重拉左边那个题库下拉框的数据。
		 *   而"已导入的文件"来自 banks.sources、"N 题"来自 banks.get，
		 *   这两样不刷新，用户导入完点刷新就什么都看不到 ——
		 *   会以为上传失败或刷新按钮坏了。
		 */
		async function dshec_act_refreshBankAll(P) {
			const {
				setBusy, banks, bankId, setBankDetail, loadBanks, loadBankSources,
			} = P;
			setBusy('bank-refresh');
			await loadBanks();
			if (bankId) {
				const res = await dshec_call('banks.get', { id: bankId });
				if (res.ok) setBankDetail(res.value.meta);
				await loadBankSources(bankId);
			}
			setBusy('');
		}

		/** 删除某个文件导入的那批题。 */
		async function dshec_act_doRemoveSource(P, hash) {
			const {
				setBusy, banks, bankId, setPendingDeleteSource, say, loadBankSources, refreshBankAll,
			} = P;
			if (!bankId || !hash) return;
			setBusy('rm-source');
			const res = await dshec_call('banks.removeSource', { id: bankId, hash: hash });
			setBusy('');
			if (!res.ok) {
				say('bad', res.error.message);
				return;
			}
			setPendingDeleteSource(null);
			// 说清楚删了多少 —— 用户最怕的是"点了删除但不知道删了什么"
			say(
				'ok',
				'已删除该文件导入的 ' + (res.value.removed || 0) + ' 题，题库现在 ' + (res.value.remaining || 0) + ' 题'
			);
			await loadBankSources(bankId);
			await refreshBankAll();
		}

		/** 清空搜索：输入框与结果一起清。 */
		function dshec_act_clearSearch(P) {
			const {
				setBankQuery, setBankHits,
			} = P;
			setBankQuery('');
			setBankHits(null);
		}

		/** 拉取未命中记录。聚合后展示，避免上千条刷屏。 */
		async function dshec_act_loadMisses(P) {
			const {
				setBusy, banks, misses, setMisses, say,
			} = P;
			setBusy('misses');
			const res = await dshec_call('banks.misses', { minCount: 1, groupLimit: 30 });
			setBusy('');
			if (res.ok) setMisses(res.value);
			else say('bad', res.error.message);
		}

		/** 把一条 miss 补进当前题库：只缺答案，题干/选项从记录里来。 */
		async function dshec_act_doFillMiss(P) {
			const {
				setBusy, banks, bankId, fillMiss, setFillMiss, fillAnswer, setFillAnswer, say, refreshBankAll,
			} = P;
			if (!bankId) {
				say('warn', '先选题库（补到哪个库）');
				return;
			}
			if (!fillMiss) return;
			if (!fillAnswer.trim()) {
				say('warn', '请填答案');
				return;
			}
			setBusy('fill-miss');
			const res = await dshec_call('banks.fillMiss', {
				bankId: bankId,
				stem: fillMiss.stem,
				answer: fillAnswer.trim(),
				qtype: fillMiss.qtype,
				options: fillMiss.opts,
			});
			setBusy('');
			if (res.ok) {
				say('ok', '已补 ' + (res.value.added || 0) + ' 条，题库现在 ' + (res.value.total || 0) + ' 题');
				setFillMiss(null);
				setFillAnswer('');
				await refreshBankAll();
			} else {
				say('bad', res.error.message);
			}
		}

		/** 清空 miss 记录。补完题后重新统计一轮时用。 */
		async function dshec_act_doClearMisses(P) {
			const {
				setBusy, banks, misses, setMisses, say,
			} = P;
			setBusy('clear-misses');
			const res = await dshec_call('banks.clearMisses', {});
			setBusy('');
			if (res.ok) {
				say('ok', '已清空未命中记录');
				setMisses(null);
			} else {
				say('bad', res.error.message);
			}
		}

		/**
		 * 给拖入区绑定**捕获阶段**的原生拖放监听器。
		 *
		 * 为什么不能用 React 的 onDragOver/onDrop：
		 *   React 的 SyntheticEvent.stopPropagation 只在 React 自己的事件树上生效。
		 *   DSH 宿主的拖入蒙版把监听器挂在 document / window 上，
		 *   React 拦不到 → 用户往面板拖文件时宿主蒙版同时弹出、盖住整个界面，
		 *   而且那个蒙版不归插件管，用户点不掉。
		 *
		 * 解法：useCapture=true。捕获阶段自根向下传，比宿主挂在冒泡阶段（默认）
		 * 的监听更早拿到事件。命中本元素就三个都调：
		 *   preventDefault           —— 阻止浏览器默认行为（直接打开文件）
		 *   stopPropagation          —— 阻止继续传给祖先（宿主收不到）
		 *   stopImmediatePropagation —— 连本元素上后续的监听器也一并掐掉
		 *
		 * 幂等：同一个 node 重复调用只绑一次（React 18 的 ref 回调可能重复触发）。
		 */
		function dshec_act_dshec_bindDropZone(P, node) {
			const {
				setDragOver, doImportFromFile,
			} = P;
			if (!node || node.__dshecDropBound) return;
			node.__dshecDropBound = true;

			const swallow = function (e) {
				e.preventDefault();
				e.stopPropagation();
				if (e.stopImmediatePropagation) e.stopImmediatePropagation();
			};

			// dragover 必须 preventDefault，否则 drop 永远不会触发
			node.addEventListener(
				'dragover',
				function (e) {
					swallow(e);
					// dropEffect 明确告诉 OS：这里是「复制进来」，
					// 不设的话有些环境会显示禁止图标，用户以为不能放。
					try {
						if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
					} catch {
						/* ignore */
					}
					setDragOver(true);
				},
				true
			);

			// dragenter 也要拦：宿主的蒙版通常是靠 dragenter 计数的，
			// 只拦 dragover 不够 —— 蒙版会在 dragenter 那一刻就显示出来。
			node.addEventListener(
				'dragenter',
				function (e) {
					swallow(e);
					setDragOver(true);
				},
				true
			);

			node.addEventListener(
				'dragleave',
				function (e) {
					swallow(e);
					// 只在真正离开本元素时取消高亮（子元素间的移动不算）
					if (!node.contains(e.relatedTarget)) setDragOver(false);
				},
				true
			);

			node.addEventListener(
				'drop',
				function (e) {
					swallow(e);
					setDragOver(false);
					const dt = e.dataTransfer;
					const f = dt && dt.files && dt.files[0];
					if (f) void doImportFromFile(f);
				},
				true
			);
		}

		/**
		 * 拖入 / 选文件：把字节转 base64 交给宿主解析。
		 *
		 * 为什么必须传字节而不是路径：
		 *   Electron 新版已移除 File.path，浏览器安全模型也不允许网页
		 *   拿到本地绝对路径。所以「拖入」能提供的只有**文件内容**。
		 *   宿主侧用 doc-read 按魔数判类型再解析，与「填路径」共用同一链路。
		 *
		 * 体积：docx 题库常见 2-10MB，base64 膨胀 4/3，宿主 body 上限 32MB。
		 * 这里先做本地预检，超限直接提示，而不是让请求 400 掉。
		 */
		async function dshec_act_doImportFromFile(P, file) {
			const {
				setBusy, banks, bankId, importText, importPath, setImportPreview, setImportBytes, setImportFileName,
				say, doBankImport,
			} = P;
			if (!bankId) {
				say('warn', '先选题库');
				return;
			}
			const MAX = 20 * 1024 * 1024;
			if (file.size > MAX) {
				say('bad', '文件太大（' + Math.round(file.size / 1024 / 1024) + 'MB），上限 20MB');
				return;
			}
			setBusy('bank-dry');
			let bytes;
			try {
				// 用 FileReader 而不是 file.arrayBuffer()：后者在旧 Chromium 里没有，
				// 而 DSH 的 WebView 版本不可控。
				const dataUrl = await new Promise(function (resolve, reject) {
					const fr = new FileReader();
					fr.onload = function () {
						resolve(String(fr.result || ''));
					};
					fr.onerror = function () {
						reject(new Error('读取文件失败'));
					};
					fr.readAsDataURL(file);
				});
				bytes = dataUrl.indexOf(',') >= 0 ? dataUrl.slice(dataUrl.indexOf(',') + 1) : '';
			} catch (err) {
				setBusy('');
				say('bad', String((err && err.message) || err));
				return;
			}
		
			const res = await dshec_call('banks.import', {
				bankId: bankId,
				dryRun: true,
				fileBytes: bytes,
				fileName: file.name,
			});
			setBusy('');
			if (!res.ok) {
				say('bad', res.error.message);
				// 宿主对 pdf/doc/xls 会带 hint：直接展示，别只说"失败"
				if (res.error.details && res.error.details.hint) {
					say('warn', res.error.details.hint);
				}
				return;
			}
			// 同内容文件已导过：明确告知，不重复入库
			if (res.value.alreadyImported) {
				say('warn', '《' + file.name + '》之前已导入过（内容完全一致），本次跳过，没有重复入库');
				if (res.value.previous && res.value.previous.at) {
					say('ok', '首次导入时间：' + String(res.value.previous.at).replace('T', ' ').slice(0, 19));
				}
				setImportPreview(null);
				setImportBytes(null);
				setImportFileName('');
				return;
			}

			setImportPreview(res.value);
			say('ok', '《' + file.name + '》切出 ' + res.value.summary.afterDedupe + ' 题（未入库，确认后点「确认入库」）');

			// 关键：字节必须留在 state 里。
			// 上一版到此就把 bytes 丢了 —— 用户接着点「确认入库」时走的是 doBankImport，
			// 那里只读 importPath / importText，两个都是空，于是报「没有文件」。
			setImportBytes({ bytes: bytes, name: file.name });
			setImportFileName(file.name);
		}

		/**
		 * 导入：dryRun=true 只试切分。
		 *
		 * 三种来源按优先级取：
		 *   ① 拖入 / 选文件 → 用已暂存的 importBytes（**这条以前漏了**）
		 *   ② 填路径 → filePath
		 *   ③ 粘贴 → text
		 *
		 * 为什么 ① 必须排最前：用户拖动/选择文件后，
		 * importPath 和 importText 都是空的，若先判它们就会报「没有文件」。
		 */
		async function dshec_act_doBankImport(P, dryRun) {
			const {
				setBusy, banks, bankId, importMode, importText, importPath, setImportPreview, importBytes, setImportBytes,
				importFileName, setImportFileName, say, refreshBankAll,
			} = P;
			if (!bankId) {
				say('warn', '先选题库');
				return;
			}

			// 有暂存字节 = 走拖入/选文件通道
			const fromFile = importBytes && importBytes.bytes;
			if (!fromFile && importMode === 'file' && !importPath.trim()) {
				say('warn', '先拖入文件、点选择文件，或填写路径');
				return;
			}
			if (!fromFile && importMode === 'paste' && !importText.trim()) {
				say('warn', '先粘贴题目文本');
				return;
			}

			setBusy(dryRun ? 'bank-dry' : 'bank-import');
			const payload = { bankId, dryRun };
			if (fromFile) {
				payload.fileBytes = importBytes.bytes;
				payload.fileName = importBytes.name || importFileName;
			} else if (importMode === 'file') {
				payload.filePath = importPath.trim();
			} else {
				payload.text = importText;
			}

			const res = await dshec_call('banks.import', payload);
			setBusy('');
			if (!res.ok) {
				say('bad', res.error.message);
				if (res.error.details && res.error.details.hint) say('warn', res.error.details.hint);
				return;
			}
			// 同内容文件已导过：明确告知，不入库
			if (res.value.alreadyImported) {
				say('warn', '这个文件之前已导入过（内容完全一致），本次跳过，没有重复入库');
				if (res.value.previous && res.value.previous.at) {
					say('ok', '首次导入时间：' + String(res.value.previous.at).replace('T', ' ').slice(0, 19));
				}
				setImportPreview(null);
				setImportBytes(null);
				setImportFileName('');
				return;
			}

			setImportPreview(res.value);
			if (dryRun) {
				say('ok', '试切分完成：' + res.value.summary.afterDedupe + ' 题（未入库）');
			} else {
				// 明确区分「新增」与「库内重复跳过」—— 用户最关心后者
				say('ok', '新增 ' + (res.value.added || 0) + ' 题，题库现在 ' + (res.value.total || 0) + ' 题');
				if (res.value.skipped > 0) {
					say('warn', '有 ' + res.value.skipped + ' 条与库内已有题目重复，已跳过');
				}
				if (res.value.conflicts > 0) {
					say('warn', res.value.conflicts + ' 条题干相同但答案不同，已按不同版本保留');
				}
				setImportPreview(null);
				// 入库成功后清掉暂存，避免用户改动文件后误用旧字节
				setImportBytes(null);
				setImportFileName('');
				await refreshBankAll();
			}
		}

		/**
		 * 试切分结果的渲染。做成组件内函数是为了直接读 importPreview 这些 state，
		 * 不必把一堆 props 层层传下来。
		 *
		 * 展示重点：
		 *   ① 切出多少题、多少题带答案 —— 一眼看出「切分到底有没有用」
		 *   ② 每题的答案类型（字母/判断/数字/文本）—— 这是旧版本静默丢答案的地方
		 *   ③ 答案与题型不自洽的样本 —— 入库前就知道哪几条要人工核对
		 */
		function dshec_act_dshec_importPreview(P) {
			const {
				importPreview,
			} = P;
			if (!importPreview) return null;
			const s = importPreview.summary || {};
			const KIND_LABEL = { choice: '字母', bool: '判断', number: '数字', text: '文本', empty: '无' };
			const KIND_COLOR = {
				choice: dshec_COLOR.ok,
				bool: dshec_COLOR.accent,
				number: dshec_COLOR.warn,
				text: dshec_COLOR.dim,
				empty: dshec_COLOR.bad,
			};

			return (dshec_el(
				'div',
				{ style: { marginTop: '12px' } },
				// 概览
				dshec_act_dshec_importPreview_part3(P),

				// 警告
				dshec_act_dshec_importPreview_part4(P),

				// 答案问题样本
				dshec_act_dshec_importPreview_part5(P),

				// 题目样本
				dshec_act_dshec_importPreview_part6(P),
				(importPreview.all || 0) > 20
					? dshec_el(dshec_Dim, null, '仅显示前 20 条，共 ' + importPreview.all + ' 条')
					: null
			));
		}
		function dshec_act_dshec_importPreview_part1(P) {
			const {
				importPreview,
			} = P;
			return (
					(importPreview.preview || []).slice(0, 20).map(function (it, i) {
						const kind = it.answerKind || (it.answer ? 'choice' : 'empty');
						return dshec_el(
							'div',
							{
								key: i,
								style: {
									fontSize: '12px',
									lineHeight: 1.7,
									padding: '6px 0',
									borderBottom: '1px solid ' + dshec_COLOR.line,
								},
							},
							dshec_el(
								'span',
								{
									style: {
										color: KIND_COLOR[kind] || dshec_COLOR.dim,
										marginRight: '6px',
										fontWeight: 600,
									},
								},
								it.answer || '?'
							),
							dshec_el(
								'span',
								{
									style: { fontSize: '10px', color: dshec_COLOR.dim, marginRight: '6px' },
								},
								(KIND_LABEL[kind] || kind) + ' · ' + (it.qtype || '未判题型')
							),
							dshec_el('span', null, String(it.stem || '').slice(0, 70)),
							dshec_el(
								'span',
								{ style: { color: dshec_COLOR.dim, marginLeft: '6px' } },
								'(' + (it.options || []).length + ' 选项)'
							)
						);
					})
			);
		}
		function dshec_act_dshec_importPreview_part2(P) {
			const {
				importPreview,
			} = P;
			return (
					(importPreview.preview || []).length === 0
						? dshec_el(
								dshec_Dim,
								null,
								'没有切出题目 —— 确认文件里有「1. 题干 / A. 选项 / 答案：A」这样的结构'
							)
						: null
				
			);
		}
		function dshec_act_dshec_importPreview_part3(P) {
			const {
				importPreview,
			} = P;
			return (
				dshec_el(
					dshec_Row,
					null,
					dshec_el(dshec_Tag, { color: dshec_COLOR.ok }, '切出 ' + (s.afterDedupe || 0) + ' 题'),
					dshec_el(
						dshec_Tag,
						{
							color:
								(s.withAnswer || 0) === (s.afterDedupe || 0) ? dshec_COLOR.ok : dshec_COLOR.warn,
						},
						'带答案 ' + (s.withAnswer || 0) + '/' + (s.afterDedupe || 0)
					),
					s.dropped ? dshec_el(dshec_Tag, { color: dshec_COLOR.warn }, '跳过 ' + s.dropped) : null,
					s.answerIssueCount
						? dshec_el(dshec_Tag, { color: dshec_COLOR.bad }, '答案可疑 ' + s.answerIssueCount)
						: null,
					importPreview.sourceName
						? dshec_el(dshec_Dim, null, '来源：' + importPreview.sourceName)
						: null
				)
			);
		}
		function dshec_act_dshec_importPreview_part4(P) {
			const {
				importPreview,
			} = P;
			return (
				(s.warnings || []).map(function (w, i) {
					return dshec_el(
						'div',
						{ key: i, style: { fontSize: '11px', color: dshec_COLOR.warn, lineHeight: 1.6 } },
						'⚠ ' + w
					);
				})
			);
		}
		function dshec_act_dshec_importPreview_part5(P) {
			const {
				importPreview,
			} = P;
			return (
				(s.answerIssueSamples || []).length
					? dshec_el(
							'div',
							{
								style: {
									marginTop: '8px',
									padding: '8px',
									borderRadius: '7px',
									border: '1px solid ' + dshec_COLOR.warn,
								},
							},
							dshec_el(
								'div',
								{ style: { fontSize: '11px', color: dshec_COLOR.warn, marginBottom: '4px' } },
								'这些题的答案与题型不自洽，建议入库后逐条改：'
							),
							(s.answerIssueSamples || []).map(function (it, i) {
								return dshec_el(
									'div',
									{
										key: i,
										style: { fontSize: '11px', lineHeight: 1.7, color: dshec_COLOR.dim },
									},
									'• ' +
										String(it.stem || '').slice(0, 50) +
										'（答案：' +
										(it.answer || '空') +
										'）→ ' +
										(it.issues || []).join('；')
								);
							})
					  )
					: null
			);
		}
		function dshec_act_dshec_importPreview_part6(P) {
			const {
				importPreview,
			} = P;
			return (
				dshec_el(
					'div',
					{ style: { marginTop: '8px', maxHeight: '280px', overflowY: 'auto' } },
					(importPreview.preview || []).slice(0, 20).map(function (it, i) {
						const kind = it.answerKind || (it.answer ? 'choice' : 'empty');
						return dshec_el(
							'div',
							{
								key: i,
								style: {
									fontSize: '12px',
									lineHeight: 1.7,
									padding: '6px 0',
									borderBottom: '1px solid ' + dshec_COLOR.line,
								},
							},
							dshec_el(
								'span',
								{
									style: {
										color: KIND_COLOR[kind] || dshec_COLOR.dim,
										marginRight: '6px',
										fontWeight: 600,
									},
								},
								it.answer || '?'
							),
							dshec_el(
								'span',
								{
									style: { fontSize: '10px', color: dshec_COLOR.dim, marginRight: '6px' },
								},
								(KIND_LABEL[kind] || kind) + ' · ' + (it.qtype || '未判题型')
							),
							dshec_el('span', null, String(it.stem || '').slice(0, 70)),
							dshec_el(
								'span',
								{ style: { color: dshec_COLOR.dim, marginLeft: '6px' } },
								'(' + (it.options || []).length + ' 选项)'
							)
						);
					}),
					(importPreview.preview || []).length === 0
						? dshec_el(
								dshec_Dim,
								null,
								'没有切出题目 —— 确认文件里有「1. 题干 / A. 选项 / 答案：A」这样的结构'
							)
						: null
				)
			);
		}


		function dshec_usePageState1() {
			const [tab, setTab] = react.useState('overview');
			const [status, setStatus] = react.useState(null);
			const [busy, setBusy] = react.useState('');
			const [toast, setToast] = react.useState(null);
			const [profiles, setProfiles] = react.useState([]);
			const [activeId, setActiveId] = react.useState(null);
			const [profile, setProfile] = react.useState(null);
			const [zoneMeta, setZoneMeta] = react.useState({ roles: [], required: [] });
			const [preview, setPreview] = react.useState(null);
			const [previewInfo, setPreviewInfo] = react.useState(null);
			// 预览那张图的落盘路径：自检复用它，做到"看到什么就识别什么"
			const [previewPath, setPreviewPath] = react.useState(null);
			// 预览/识别针对哪个区域：'__all__' = 全部识别范围
			const [previewRole, setPreviewRole] = react.useState('__all__');
			const [ocrResult, setOcrResult] = react.useState(null);
			const [warnings, setWarnings] = react.useState([]);
			// S2：运行相关
			const [dshec_run, setRun] = react.useState(null);
			const [runMode, setRunMode] = react.useState('copilot');
			// 内联表单状态（替代 window.prompt）
			const [creatingProfile, setCreatingProfile] = react.useState(false);
			const [newProfileName, setNewProfileName] = react.useState('');
			const [confirmDelete, setConfirmDelete] = react.useState(false);
			const [pendingZone, setPendingZone] = react.useState(null);
			const [pendingRole, setPendingRole] = react.useState('question');
			// 全局设置（截图留存等），与 profile 分开：它是插件级的
			const [settings, setSettingsState] = react.useState({ shots: { keepDays: 7, maxTotalMB: 2048 } });
			// 能力清单（可用模型、动作白名单），面板据此渲染模型选择器
			const [capabilities, setCapabilities] = react.useState(null);
			return {
				tab, setTab, status, setStatus, busy, setBusy, toast, setToast, profiles, setProfiles, activeId,
				setActiveId, profile, setProfile, zoneMeta, setZoneMeta, preview, setPreview, previewInfo, setPreviewInfo,
				previewPath, setPreviewPath, previewRole, setPreviewRole, ocrResult, setOcrResult, warnings,
				setWarnings, dshec_run, setRun, runMode, setRunMode, creatingProfile, setCreatingProfile, newProfileName,
				setNewProfileName, confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole,
				setPendingRole, settings, setSettingsState, capabilities, setCapabilities,
			};
		}
		function dshec_usePageState2() {
			// S3：题库
			const [banks, setBanks] = react.useState([]);
			const [bankId, setBankId] = react.useState(null);
			const [bankDetail, setBankDetail] = react.useState(null);
			const [creatingBank, setCreatingBank] = react.useState(false);
			const [newBankName, setNewBankName] = react.useState('');
			const [confirmDeleteBank, setConfirmDeleteBank] = react.useState(false);
			const [bankQuery, setBankQuery] = react.useState('');
			const [bankHits, setBankHits] = react.useState(null);
			// 题库的来源文件列表（每个文件导入了多少题、什么时候导的）
			const [bankSources, setBankSources] = react.useState(null);
			// 待删除的来源文件（内联确认，不用 window.confirm）
			const [pendingDeleteSource, setPendingDeleteSource] = react.useState(null);
			// 未命中记录：题库漏了哪些题
			const [misses, setMisses] = react.useState(null);
			// 正在补的那条 miss（内联表单用，不用 prompt）
			const [fillMiss, setFillMiss] = react.useState(null);
			const [fillAnswer, setFillAnswer] = react.useState('');
			const [importMode, setImportMode] = react.useState('paste');
			const [importText, setImportText] = react.useState('');
			const [importPath, setImportPath] = react.useState('');
			const [importPreview, setImportPreview] = react.useState(null);
			// 拖入高亮（拖拽经过时给视觉反馈，否则用户不知道这里能放）
			const [dragOver, setDragOver] = react.useState(false);
			// 浏览器 DOM 通道检测结果（null=没测过）
			const [browserProbe, setBrowserProbe] = react.useState(null);
			// 最近日志（插件 logs.recent），每 2 秒刷新；面板展开时才显示
			const [logLines, setLogLines] = react.useState([]);
			return {
				banks, setBanks, bankId, setBankId, bankDetail, setBankDetail, creatingBank, setCreatingBank,
				newBankName, setNewBankName, confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery,
				bankHits, setBankHits, bankSources, setBankSources, pendingDeleteSource, setPendingDeleteSource,
				misses, setMisses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode, setImportMode,
				importText, setImportText, importPath, setImportPath, importPreview, setImportPreview, dragOver,
				setDragOver, browserProbe, setBrowserProbe, logLines, setLogLines,
			};
		}
		function dshec_usePageState3() {
			const [logOpen, setLogOpen] = react.useState(false);
			// 本机已安装的浏览器（任务 2：让用户选哪个用来考试）
			const [browsers, setBrowsers] = react.useState([]);
			const [browserId, setBrowserId] = react.useState(null);
			// 「高级：填路径 / 粘贴」的展开状态，默认收起
			const [importMoreOpen, setImportMoreOpen] = react.useState(false);
			// 暂存「拖入 / 选文件」拿到的字节与文件名。
			// 为什么要进 state：
			//   上一版把 bytes 只放在 doImportFromFile 的局部变量里，试切分用完就丢；
			//   「确认入库」走另一个函数 doBankImport，它只读 importPath / importText ——
			//   而拖入和选文件时这两个都是空 → 必报「没有可导入的内容」。
			const [importBytes, setImportBytes] = react.useState(null);
			const [importFileName, setImportFileName] = react.useState('');
			return {
				logOpen, setLogOpen, browsers, setBrowsers, browserId, setBrowserId, importMoreOpen, setImportMoreOpen,
				importBytes, setImportBytes, importFileName, setImportFileName,
			};
		}
		function dshec_Page() { // dsh-skip-func-length: React 组件，hook 必须在同一函数顶层按固定顺序调用
			const {
				tab, setTab, status, setStatus, busy, setBusy, toast, setToast, profiles, setProfiles, activeId,
				setActiveId, profile, setProfile, zoneMeta, setZoneMeta, preview, setPreview, previewInfo, setPreviewInfo,
				previewPath, setPreviewPath, previewRole, setPreviewRole, ocrResult, setOcrResult, warnings,
				setWarnings, dshec_run, setRun, runMode, setRunMode, creatingProfile, setCreatingProfile, newProfileName,
				setNewProfileName, confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole,
				setPendingRole, settings, setSettingsState, capabilities, setCapabilities,
			} = dshec_usePageState1();
			const {
				banks, setBanks, bankId, setBankId, bankDetail, setBankDetail, creatingBank, setCreatingBank,
				newBankName, setNewBankName, confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery,
				bankHits, setBankHits, bankSources, setBankSources, pendingDeleteSource, setPendingDeleteSource,
				misses, setMisses, fillMiss, setFillMiss, fillAnswer, setFillAnswer, importMode, setImportMode,
				importText, setImportText, importPath, setImportPath, importPreview, setImportPreview, dragOver,
				setDragOver, browserProbe, setBrowserProbe, logLines, setLogLines,
			} = dshec_usePageState2();
			const {
				logOpen, setLogOpen, browsers, setBrowsers, browserId, setBrowserId, importMoreOpen, setImportMoreOpen,
				importBytes, setImportBytes, importFileName, setImportFileName,
			} = dshec_usePageState3();
			react.useEffect(function () {
				if (!logOpen) return undefined;
				let alive = true;
				function pull() {
					dshec_call('logs.recent', {}).then(function (res) {
						if (alive && res && res.ok) setLogLines(res.value.lines || []);
					});
				}
				pull();
				const timer = setInterval(pull, 2000);
				return function () {
					alive = false;
					clearInterval(timer);
				};
			}, [logOpen]);


			const refreshStatus = react.useCallback(async function () {
				const res = await dshec_call('status');
				if (res.ok) setStatus(res.value);
				else setStatus({ error: res.error });
			}, []);

			const refreshProfiles = react.useCallback(async function () {
				const res = await dshec_call('profiles.list');
				if (res.ok) setProfiles(res.value || []);
			}, []);

			/** 拉取运行状态。运行中时由下面的定时器高频调用。 */
			const refreshRun = react.useCallback(async function () {
				const res = await dshec_call('run.state');
				if (res.ok) setRun(res.value);
			}, []);

			// 运行中轮询：running / paused 时每 1.2s 刷新一次，其余状态不动。
			// 刻意不做 WebSocket —— 面板是配置界面，不需要毫秒级实时，
			// 轮询实现简单且不会因为长连接断开而"看起来在跑其实死了"。
			react.useEffect(
				function () {
					if (tab !== 'run') return;
					void refreshRun();
					const timer = window.setInterval(function () {
						void refreshRun();
					}, 1200);
					return function () {
						window.clearInterval(timer);
					};
				},
				[tab]
			);

			react.useEffect(function () {
				void refreshStatus();
				void refreshProfiles();
				dshec_call('zones.meta').then(function (res) {
					if (res.ok) setZoneMeta(res.value);
				});
				// 全局设置：截图留存等
				dshec_call('settings.get').then(function (res) {
					if (res.ok && res.value) setSettingsState(res.value);
				});
				// 能力清单：可用模型列表（供模型页选择器）
				dshec_call('run.capabilities').then(function (res) {
					if (res.ok) setCapabilities(res.value);
				});
				// 题库列表
				dshec_call('banks.list').then(function (res) {
					if (res.ok) setBanks(res.value.banks || []);
				});
				// 本机已安装的浏览器（任务 2：网页模式让用户选哪个用来考试）
				//
				// 注意：这个请求必须放在**顶层、无条件**的 effect 里。
				// 之前我把它放进 dshec_channelMode()，而那个函数是条件调用的
				// （tab === zones ? … : null），导致 hook 数量随 tab 变化，
				// React 抛错 → 整个卡片白屏。
				dshec_call('browsers.list').then(function (res) {
					if (!res.ok) return;
					const list = (res.value && res.value.browsers) || [];
					setBrowsers(list);
					if (list.length > 0) {
						setBrowserId(function (prev) {
							return prev || list[0].id;
						});
					}
				});
			}, []);

			// 选中 profile 时拉全文
			react.useEffect(
				function () {
					if (!activeId) {
						setProfile(null);
						return;
					}
					dshec_call('profiles.get', { id: activeId }).then(function (res) {
						if (res.ok) setProfile(res.value);
					});
				},
				[activeId]
			);



			/* ── 内联表单：替代 window.prompt ─────────────────────
			 * DSH 的 Electron 设了 disableDialogs:true（防插件用原生弹窗劫持输入），
			 * window.prompt() 会**静默返回 null** —— 既不报错也无提示。
			 * 所以任何需要用户输入的地方都必须用面板内联表单。
			 * 新建配置和圈选指派角色都曾因此点击无反应。
			 * ──────────────────────────────────────────────────── */





























			/* ── S2：运行控制 ── */

			/** 悬浮窗：运行开始时挂载，停下时卸载。
			 *
			 *  为什么在这里挂而不是全局 apply 里挂：
			 *    只有用户真的点了「开始」，才该出现覆盖层；
			 * 常驻一个悬浮窗会挡住考试界面。
			 */
			const overlayRef = react.useRef(null);







			/* ── S3：题库 ── */

			const loadBanks = react.useCallback(async function () {
				const res = await dshec_call('banks.list');
				if (res.ok) setBanks(res.value.banks || []);
			}, []);

			// 选中题库时拉详情
			react.useEffect(
				function () {
					if (!bankId) {
						setBankDetail(null);
						return;
					}
					dshec_call('banks.get', { id: bankId }).then(function (res) {
						if (res.ok) setBankDetail(res.value.meta);
					// 同时拉来源文件列表 —— 用户要能在这看到「这个库由哪些文件组成」，
					// 并单独删掉某个文件导入的题。
					void loadBankSources(bankId);
					// 换题库时把上一次的搜索结果清掉：
					// 不清的话，上一个库的命中会挂在新库下面，用户会以为是新库的题。
					setBankHits(null);
					setBankQuery('');
					});
				},
				[bankId]
			);















			


			/* ── 渲染 ── */
			// 当前选中题库（bankId 对应的条目），供详情区使用
			const selectedBank = (banks || []).find(function (b) {
				return b.id === bankId;
			}) || bankDetail;
			if (!status) {
				return dshec_el('div', { style: { padding: '24px', color: dshec_COLOR.dim } }, '正在读取状态…');
			}

			const engineOk = status.engineRunning && status.engine && status.engine.ok;
			const tabs = [
				['overview', '总览'],
				['zones', '区域'],
				['bank', '题库'],
				['model', '模型'],
				['prompts', '提示词'],
				['run', '运行'],
				['safety', '安全'],
			];

			// 各页渲染函数共享的状态与操作
			const P = {
				tab, setTab, status, setStatus, busy, setBusy, toast, setToast, profiles, setProfiles, activeId,
				setActiveId, profile, setProfile, zoneMeta, setZoneMeta, preview, setPreview, previewInfo, setPreviewInfo,
				previewPath, setPreviewPath, previewRole, setPreviewRole, ocrResult, setOcrResult, warnings,
				setWarnings, dshec_run, setRun, runMode, setRunMode, creatingProfile, setCreatingProfile, newProfileName,
				setNewProfileName, confirmDelete, setConfirmDelete, pendingZone, setPendingZone, pendingRole,
				setPendingRole, settings, setSettingsState, capabilities, setCapabilities, banks, setBanks, bankId,
				setBankId, bankDetail, setBankDetail, creatingBank, setCreatingBank, newBankName, setNewBankName,
				confirmDeleteBank, setConfirmDeleteBank, bankQuery, setBankQuery, bankHits, setBankHits, bankSources,
				setBankSources, pendingDeleteSource, setPendingDeleteSource, misses, setMisses, fillMiss, setFillMiss,
				fillAnswer, setFillAnswer, importMode, setImportMode, importText, setImportText, importPath,
				setImportPath, importPreview, setImportPreview, dragOver, setDragOver, browserProbe, setBrowserProbe,
				logLines, setLogLines, logOpen, setLogOpen, browsers, setBrowsers, browserId, setBrowserId, importMoreOpen,
				setImportMoreOpen, importBytes, setImportBytes, importFileName, setImportFileName, refreshStatus,
				refreshProfiles, refreshRun, overlayRef, loadBanks, selectedBank, engineOk, tabs,
			};
			// 操作函数在工厂层定义，这里按当前渲染的状态绑定
			const acts = {
				say: dshec_act_say, doStartEngine: dshec_act_doStartEngine, doStopEngine: dshec_act_doStopEngine,
				dshec_InlineInput: dshec_act_dshec_InlineInput, dshec_InlineSelect: dshec_act_dshec_InlineSelect,
				dshec_modelPicker: dshec_act_dshec_modelPicker, dshec_selStyle: dshec_act_dshec_selStyle,
				dshec_modelRow: dshec_act_dshec_modelRow, currentModelLabel: dshec_act_currentModelLabel,
				dshec_navMode: dshec_act_dshec_navMode, dshec_channelMode: dshec_act_dshec_channelMode,
				updateNav: dshec_act_updateNav, dshec_num: dshec_act_dshec_num, dshec_prompt: dshec_act_dshec_prompt,
				updateAnswer: dshec_act_updateAnswer, updateAnswerPatch: dshec_act_updateAnswerPatch,
				doSavePrompt: dshec_act_doSavePrompt, updateSettings: dshec_act_updateSettings, doSaveSettings: dshec_act_doSaveSettings,
				doDeleteProfile: dshec_act_doDeleteProfile, confirmDeleteProfile: dshec_act_confirmDeleteProfile,
				doCreateProfile: dshec_act_doCreateProfile, confirmCreateProfile: dshec_act_confirmCreateProfile,
				doDetectZones: dshec_act_doDetectZones, doPickZone: dshec_act_doPickZone, confirmAssignRole: dshec_act_confirmAssignRole,
				doRemoveZone: dshec_act_doRemoveZone, doSave: dshec_act_doSave, doPreview: dshec_act_doPreview,
				currentReadRegion: dshec_act_currentReadRegion, unionOfZones: dshec_act_unionOfZones,
				doReadOnly: dshec_act_doReadOnly, mountOverlayIfNeeded: dshec_act_mountOverlayIfNeeded,
				unmountOverlay: dshec_act_unmountOverlay, doRunStart: dshec_act_doRunStart, doRunPause: dshec_act_doRunPause,
				doRunResume: dshec_act_doRunResume, doRunStop: dshec_act_doRunStop, doPanic: dshec_act_doPanic,
				doConfirmSubmit: dshec_act_doConfirmSubmit, confirmCreateBank: dshec_act_confirmCreateBank,
				confirmDeleteBankNow: dshec_act_confirmDeleteBankNow, toggleBankInProfile: dshec_act_toggleBankInProfile,
				doFullPreview: dshec_act_doFullPreview, doProbeBrowser: dshec_act_doProbeBrowser, doBankSearch: dshec_act_doBankSearch,
				loadBankSources: dshec_act_loadBankSources, refreshBankAll: dshec_act_refreshBankAll,
				doRemoveSource: dshec_act_doRemoveSource, clearSearch: dshec_act_clearSearch, loadMisses: dshec_act_loadMisses,
				doFillMiss: dshec_act_doFillMiss, doClearMisses: dshec_act_doClearMisses, dshec_bindDropZone: dshec_act_dshec_bindDropZone,
				doImportFromFile: dshec_act_doImportFromFile, doBankImport: dshec_act_doBankImport,
				dshec_importPreview: dshec_act_dshec_importPreview,
			};
			Object.keys(acts).forEach(function (k) {
				P[k] = function () {
					return acts[k].apply(null, [P].concat(Array.prototype.slice.call(arguments)));
				};
			});
			const {
				say, doStartEngine, doStopEngine, dshec_InlineInput, dshec_InlineSelect, dshec_modelPicker, dshec_selStyle,
				dshec_modelRow, currentModelLabel, dshec_navMode, dshec_channelMode, updateNav, dshec_num, dshec_prompt,
				updateAnswer, updateAnswerPatch, doSavePrompt, updateSettings, doSaveSettings, doDeleteProfile,
				confirmDeleteProfile, doCreateProfile, confirmCreateProfile, doDetectZones, doPickZone, confirmAssignRole,
				doRemoveZone, doSave, doPreview, currentReadRegion, unionOfZones, doReadOnly, mountOverlayIfNeeded,
				unmountOverlay, doRunStart, doRunPause, doRunResume, doRunStop, doPanic, doConfirmSubmit, confirmCreateBank,
				confirmDeleteBankNow, toggleBankInProfile, doFullPreview, doProbeBrowser, doBankSearch, loadBankSources,
				refreshBankAll, doRemoveSource, clearSearch, loadMisses, doFillMiss, doClearMisses, dshec_bindDropZone,
				doImportFromFile, doBankImport, dshec_importPreview,
			} = P;
			return dshec_el(
				'div',
				{ style: { padding: '4px 2px', color: dshec_COLOR.fg, fontSize: '13px' } },
				// 标题 + 状态
				dshec_el(
					dshec_Row,
					null,
					dshec_el('div', { style: { fontSize: '16px', fontWeight: 600 } }, '考试助手'),
					// 后端版本（来自 status.pluginVersion）
					dshec_el(dshec_Tag, { color: dshec_COLOR.dim }, 'v' + status.pluginVersion),
					// 前端构建标识（写死在 client.js 里）。
					// 为什么要单独一个：上面那个版本号来自**后端**，
					// 只能证明宿主代码是新的，证明不了浏览器加载到的 client.js 是新的。
					// 排查「改了代码但界面没变」时，这两个数字一致才说明真的同步了。
					dshec_el(
						dshec_Tag,
						{ color: dshec_COLOR.accent },
						'前端 ' + dshec_CLIENT_BUILD
					),
					engineOk
						? dshec_el(dshec_Tag, { color: dshec_COLOR.ok }, '引擎运行中')
						: dshec_el(dshec_Tag, { color: dshec_COLOR.bad }, '引擎未启动'),
					status.engine && status.engine.screen
						? dshec_el(dshec_Tag, { color: dshec_COLOR.dim }, status.engine.screen.w + '×' + status.engine.screen.h)
						: null,
					status.engine && status.engine.ocrEngines
						? dshec_el(dshec_Tag, { color: dshec_COLOR.dim }, 'OCR: ' + status.engine.ocrEngines.join('+'))
						: null
				),

				// 页签
				dshec_el(
					dshec_Row,
					null,
					tabs.map(function (t) {
						const on = tab === t[0];
						return dshec_el(
							'button',
							{
								key: t[0],
								type: 'button',
								onClick: function () {
									setTab(t[0]);
								},
								style: {
									padding: '5px 13px',
									borderRadius: '7px',
									border: '1px solid ' + (on ? dshec_COLOR.accent : dshec_COLOR.line),
									background: on ? dshec_COLOR.accent : 'transparent',
									color: on ? '#fff' : dshec_COLOR.fg,
									cursor: 'pointer',
									fontSize: '13px',
								},
							},
							t[1]
						);
					})
				),

				// toast
				toast
					? dshec_el(
							'div',
							{
								style: {
									padding: '8px 12px',
									borderRadius: '8px',
									marginBottom: '10px',
									fontSize: '12px',
									border: '1px solid ' + (toast.kind === 'bad' ? dshec_COLOR.bad : toast.kind === 'warn' ? dshec_COLOR.warn : dshec_COLOR.ok),
									color: toast.kind === 'bad' ? dshec_COLOR.bad : toast.kind === 'warn' ? dshec_COLOR.warn : dshec_COLOR.ok,
								},
							},
							toast.text
					  )
					: null,

				/* ── 总览 ── */
				tab === 'overview' ? dshec_tabOverview(P) : null,

				/* ── 区域 ── */
				tab === 'zones' ? dshec_tabZones(P) : null,

				/* ── 其余页签（S1 占位，S3/S4 落地） ── */
				tab === 'bank' ? dshec_tabBank(P) : null,

				tab === 'model' ? dshec_tabModel(P) : null,

				tab === 'prompts' ? dshec_tabPrompts(P) : null,

				tab === 'run' ? dshec_tabRun(P) : null,

				tab === 'safety' ? dshec_tabSafety(P) : null
			);
		}

		function dshec_apply(ctx) {
			try {
				ctx.slots.inject('settings.section', () =>
					ctx.slots.register(
						{
							name: 'settings.section',
							id: 'dsh-exam-copilot',
							order: 42,
							label: () => '考试助手',
						},
						() => react.createElement(dshec_Page, null)
					)
				);
			} catch (e) {
				// 常驻诊断：页面只显示 "dsh-exam-copilot: failed"，真实异常必须进控制台
				console.error('[dsh-exam-copilot] client apply 失败：', (e && (e.stack || e.message)) || String(e));
				throw e;
			}
		}

		exports.apply = dshec_apply;
		exports.inject = ['slots'];
		exports.name = 'dsh-exam-copilot';
		// 悬浮窗挂载点：主要给面板内部用，同时便于单测直接验证行为。
		// 挂在 window 而非 exports，是因为宿主只读 exports 的 apply/inject/name。
		try {
			window.__DSHEC_OVERLAY__ = { mountOverlay: dshec_mountOverlay, remove: dshec_removeOverlay };
			// 组件引用：让测试能按「组件语义」而不是「DOM 语义」驱动输入。
			// 两者 onChange 的入参不同（前者字符串、后者事件），测试混用会静默丢值。
			window.__DSHEC_UI__ = { Input: dshec_Input, TextArea: dshec_TextArea };
		} catch {
			/* 非浏览器环境下忽略 */
		}
		return module.exports;
	},
});
