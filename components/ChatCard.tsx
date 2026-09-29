/**
 * ChatCard — 「音乐助手」卡片的内容。
 *
 * 它就是布局系统里的一张普通卡片：可拉伸、可与别的卡合并成标签页、可隐藏。
 * 前一版是右下角的 fixed 浮窗（`AgentMount`），两个问题：
 *   1. 浮层压住「播放队列」面板的底部把手与 ⋯ 菜单，右下角没法拖；
 *   2. 它游离在 `panel-layout` 之外，不参与合并 / 拆分 / 隐藏 / 持久化。
 *
 * 传输（BLUEPRINT §2 的 ⑧ 冻结区）交给 AI SDK 的 `useChat`：读 SSE、增量拼装、
 * 消息状态、中断、错误全部不写。本文件只剩两件事——把 parts 画出来、把输入框做出来。
 *
 * 状态归属（重要）：`useChat` 在 `app/page.tsx` 的 `MainPanels` 里调用，**不在本组件内**。
 * 因为切换标签页会卸载本组件，状态放在这里会连整段对话一起丢。所以这里只接 props。
 */
'use client';
import {
	getToolName,
	isStaticToolUIPart,
	isTextUIPart,
	type ChatStatus,
	type ToolUIPart,
	type UIMessage,
} from 'ai';
import { useEffect, useRef, useState } from 'react';
import type { ToolOutcome } from '@/contract/tool';
import { approvalView } from './approval-view';
import { VoiceButton } from './VoiceButton';
import { voiceInsert } from './voice-capture';

/**
 * 工具名的中文标签；未登记的走原始名。
 *
 * ⚠️ **加工具时这里也要加一行**：漏了不报错、单测也不红，只是轨迹卡上突兀地出现一个
 * 英文下划线名（如 `set_track_tags`）——2026-09-17 就是这么漏掉三个的。
 * 补的时候顺手核对 `agent/tools.ts` 里的键名，两边没有任何机制保证同步。
 */
const TOOL_LABEL: Record<string, string> = {
	search_library: '检索曲库',
	play_track: '播放曲目',
	build_queue: '换一批队列',
	next_track: '下一首',
	pause_playback: '暂停',
	resume_playback: '继续播放',
	jump_in_queue: '队列跳转',
	remove_from_queue: '去掉一首',
	set_volume: '调整音量',
	set_playback_mode: '播放方式',
	recent_plays: '播放历史',
	list_tags: '标签一览',
	remember_preference: '记住偏好',
	forget_preference: '忘掉偏好',
	set_track_tags: '重设标签',
	schedule_task: '排个任务',
	list_scheduled_tasks: '任务清单',
	cancel_scheduled_task: '撤销任务',
};

/**
 * 用户点「算了」时**回给模型**的那句话。
 *
 * 这不是界面文案（界面文案在下面的渲染分支里：「已放弃（你没有批准）」），
 * 它进的是发给模型的 tool result。**为什么必须给**：
 * SDK 把拒答转成 `execution-denied`，而 provider 在没有 `reason` 时只发一句
 * `"Tool call execution denied."`（`@ai-sdk/openai-compatible` 的 tool-result 分支：
 * `contentValue = output.reason ?? "Tool call execution denied."`）。
 *
 * 09-28 端到端实测（探针 F，真模型 + 真浏览器），模型拿到那句光秃秃的英文之后
 * 做了两件都不该做的事：
 *
 *   ① **又问了一遍** —— 同一轮里第二次调 `set_track_tags`，于是界面上在
 *      「已放弃」后面又冒出一个待确认框。用户明明刚说了"算了"。
 *   ② 把它**说成了故障** —— 原话是「工具调用失败了，可能是权限限制」，
 *      于是用户以为系统坏了，而不是"我自己刚拒绝的"。
 *
 * 两件都**不是**安全问题（闸门两次都拦住了、标签一个字节没动 —— 这正是探针里
 * 同时断言「再审一次之后标签依然没动」的原因），但都是**用户看得见的**。
 * 根因只有一个：拒绝这件事**没有任何说明**就传给了模型。
 *
 * 所以这句要说清三件事：谁拒的、为什么没执行（**排除故障与权限**，否则模型会往
 * 那两个方向猜）、以及别重试。⚠️ 措辞上不要把"重试"写成一种选项。
 */
const DENY_REASON =
	'用户点了「算了」，明确拒绝了这一步，所以它没有执行。这不是故障，也不是权限问题，请不要重试。' +
	'请如实告诉用户这一步没有执行。';

/** 轨迹卡片要展示的三样东西。 */
type Trace = { name: string; ok: boolean; ms?: number; text?: string };

/**
 * 从 AI SDK 的 tool part 里取出轨迹。
 *
 * 这里是**业务形状与 SDK 形状的交界**：`output` 就是 `execute` 的返回值，也就是
 * `contract/tool.ts` 的 `ToolOutcome`，所以 `ok` / `ms` 直接可读；工具还没跑完
 * （`input-streaming` / `input-available`）时三者都缺，卡片显示「执行中」。
 *
 * ⚠️ 审批那两种状态（`approval-requested` / `output-denied`）**在渲染里被提前拦掉**
 * 了，走不到下面这个「执行中…」的兜底 —— 否则用户会一直等一件不会发生的事。
 * 这里仍然各给一句，是为了这个函数单独被调用时也是对的。
 */
function traceOf(part: ToolUIPart): Trace {
	const name = getToolName(part);
	if (part.state === 'output-available') {
		const out = part.output as ToolOutcome | undefined;
		return { name, ok: out?.ok ?? true, ms: out?.ms, text: out?.text };
	}
	if (part.state === 'output-error') return { name, ok: false, text: part.errorText };
	if (part.state === 'approval-requested') return { name, ok: true, text: '等你确认' };
	if (part.state === 'output-denied') return { name, ok: false, text: '你没有批准，这一步没有执行' };
	return { name, ok: true };
}

/**
 * 把 `useChat` 的错误变成一句人话。
 *
 * 非 2xx 响应（如「未配置 LLM_API_KEY」的 503）是**原文透传**的：SDK 把响应体整段
 * 塞进 `error.message`，而那是一个 JSON 信封。所以先试着解出信封里的 `message`；
 * 解不动（网关错误 / 网络错误）就用原文。
 */
function friendlyError(err: Error): string {
	try {
		const parsed = JSON.parse(err.message) as { message?: unknown };
		if (typeof parsed?.message === 'string') return parsed.message;
	} catch {
		/* 不是 JSON，用原文 */
	}
	return err.message;
}

function SendIcon({ size = 16 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2.2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<path d="M12 19.5v-15" />
			<path d="M5.5 11 12 4.5 18.5 11" />
		</svg>
	);
}

/** 停止按钮：一个实心方块。 */
function StopIcon({ size = 14 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
			<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
		</svg>
	);
}

type Props = {
	messages: UIMessage[];
	status: ChatStatus;
	error?: Error;
	onSend: (text: string) => void;
	onStop: () => void;
	/**
	 * 回应一次「需要你确认」的请求（`agent/run.ts` 的 `toolApproval` 发起的）。
	 *
	 * ⚠️ 不传 = 界面上不出现批准按钮，而服务端那一轮**会永远停在那里等一个
	 * 不会到来的回答**（界面上看起来只是"它不动了"，没有报错）。所以路由必须接。
	 *
	 * ⚠️ 但只有**最后一条消息**上的确认框会把按钮接到它：`addToolApprovalResponse`
	 * 只更新最后一条消息里的 part，更早的那些框即使留着按钮也是死控件
	 * （选档的规则在 `approval-view.ts`，带单测）。
	 *
	 * `reason` 只有「算了」这一支会带 —— 它是**说给模型听的**（`DENY_REASON`）
	 */
	onApproval?: (id: string, approved: boolean, reason?: string) => void;
};

export function ChatCard({ messages, status, error, onSend, onStop, onApproval }: Props) {
	const [input, setInput] = useState('');
	const listRef = useRef<HTMLDivElement>(null);
	const taRef = useRef<HTMLTextAreaElement>(null);

	/** `submitted` = 已发出、还没等到首字；`streaming` = 正在吐字。两者都算忙。 */
	const busy = status === 'submitted' || status === 'streaming';

	// 流式追加内容后把列表滚到底
	useEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	// 输入框随内容自动增高（上限由 max-h 控制）
	useEffect(() => {
		const el = taRef.current;
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
	}, [input]);

	const send = () => {
		const text = input.trim();
		if (!text || busy) return;
		setInput('');
		onSend(text);
	};

	const errText = error ? friendlyError(error) : null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div
				ref={listRef}
				className="scroll-area flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3"
			>
				{messages.length === 0 && (
					<div className="mx-auto mt-4 max-w-[16rem] text-center">
						<span className="mx-auto mb-2.5 flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-brand-2 text-lg shadow-sm">
							🎵
						</span>
						<p className="text-sm font-semibold">你好，我是你的音乐助手</p>
						<ul className="mt-2 space-y-1 text-xs leading-relaxed text-muted">
							<li>「放一首传奇」</li>
							<li>「现在在放什么」</li>
							<li>「换下一首」</li>
						</ul>
					</div>
				)}

				{messages.map((m, mi) => (
					<div
						key={m.id}
						className={m.role === 'user' ? 'flex justify-end' : 'flex flex-col items-start gap-1.5'}
					>
						{m.parts.map((part, i) => {
							if (isTextUIPart(part)) {
								return (
									<div
										key={`t${i}`}
										className={
											m.role === 'user'
												? 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-brand-soft px-3 py-1.5 text-sm leading-relaxed'
												: 'max-w-[92%] whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground'
										}
									>
										{part.text}
									</div>
								);
							}

							// 只处理**静态**工具 part：本项目全是代码内注册的工具，
							// 不存在 `dynamic-tool`，用 isToolUIPart 会把它的分支也拉进来。
							if (isStaticToolUIPart(part)) {
								const trace = traceOf(part);
								// 这个框该不该给按钮，由**位置**决定而不只是状态（见 `approval-view.ts`）：
								// 非最后一条上的待确认框若渲染成可点按钮就是个**死控件** ——
								// 点下去没有任何反应、也没有任何报错，用户只会以为是网络慢。
								const view = approvalView(part.state, mi === messages.length - 1);

								// 「等你点头」的那一步（见 `agent/run.ts` 的 `toolApproval`）。
								// **不是错误**，所以外观走品牌色 + 两个按钮，而不是失败色 ——
								// 「等你确认」与「工具失败了」是两种完全不同的处境。
								//
								// 后半个条件不是规则的一部分（规则就是 `view === 'buttons'`），
								// 它只是把类型收窄到带 `approval` 的那一支：TS 看不出
								// 「两个字符串相等」这层关系，不写它就取不到 `part.approval.id`。
								if (view === 'buttons' && part.state === 'approval-requested') {
									return (
										<div
											key={part.toolCallId}
											className="w-full rounded-xl border border-brand/40 bg-brand-soft px-2.5 py-2 text-[11px] leading-snug"
										>
											<p>
												<span className="font-medium text-foreground">
													{TOOL_LABEL[trace.name] ?? trace.name}
												</span>
												<span className="ml-1.5 opacity-80">需要你确认</span>
											</p>
											<p className="mt-0.5 text-muted">
												{/* 服务端可以给一句**具体**的理由（`toolApproval` 里那个函数返回的
												    `reason`，到这儿是 `approval.requestReason`）。有它就念它 ——
												    闸门装在不同工具上，"回不来了"这种笼统说法并不总成立
												    （去掉一个标签是能再加回来的），而"要删掉的是哪几个词"
												    才是用户真正要据以点头的信息。没有就保留原来那句。 */}
												{part.approval.requestReason ??
													'这一步做完就回不来了，所以要你点一下。'}
											</p>
											<div className="mt-1.5 flex gap-1.5">
												<button
													type="button"
													onClick={() => onApproval?.(part.approval.id, true)}
													className="rounded-lg bg-brand px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-90"
												>
													执行
												</button>
												<button
													type="button"
													// 拒答要**带上说明**（见 `DENY_REASON`）：不带的话模型只收到
													// 一句光秃秃的 `"Tool call execution denied."`，会去猜
													// （实测既重试过、也把它说成过"故障/权限限制"）。
													onClick={() => onApproval?.(part.approval.id, false, DENY_REASON)}
													className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted transition hover:bg-surface-2 hover:text-foreground"
												>
													算了
												</button>
											</div>
										</div>
									);
								}

								// **已经越过这一步**的待确认框（刷新之后它退到了历史中间）。
								// 不给按钮：`addToolApprovalResponse` 只认最后一条消息，点了不会有
								// 任何事发生。而且必须**说清它没有执行** —— 否则用户会以为自己在
								// 等一件正在跑的事，而服务端那一轮其实早就结束了。
								if (view === 'stale') {
									return (
										<div
											key={part.toolCallId}
											className="w-full rounded-xl border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] leading-snug text-muted"
										>
											<span className="font-medium text-foreground">
												{TOOL_LABEL[trace.name] ?? trace.name}
											</span>
											<span className="ml-1.5">这一步没有执行（这次确认已经作废）</span>
											<p className="mt-0.5 text-[10px] opacity-80">
												只有对话最后一步的确认能点；要真做，再跟助手说一句。
											</p>
										</div>
									);
								}

								// 答复过、但**被拒**的那一步。必须与「还在跑」分开：两者在下面
								// 那一支里都会显示「执行中…」，用户于是会一直等一件不会发生的事。
								if (view === 'denied') {
									return (
										<div
											key={part.toolCallId}
											className="w-full rounded-xl border border-border bg-surface-2 px-2.5 py-1.5 text-[11px] leading-snug text-muted"
										>
											<span className="font-medium text-foreground">
												{TOOL_LABEL[trace.name] ?? trace.name}
											</span>
											<span className="ml-1.5">已放弃（你没有批准）</span>
										</div>
									);
								}

								return (
									<div
										key={part.toolCallId}
										className={`w-full rounded-xl border px-2.5 py-1.5 text-[11px] leading-snug ${
											trace.ok
												? 'border-border bg-surface-2 text-muted'
												: 'border-red-400/30 bg-red-400/10 text-red-400'
										}`}
									>
										<span className="font-medium text-foreground">
											{TOOL_LABEL[trace.name] ?? trace.name}
										</span>
										{trace.ms !== undefined && (
											<span className="ml-1.5 opacity-70">{trace.ms}ms</span>
										)}
										{trace.text ? (
											<p className="mt-0.5 break-words opacity-90" title={trace.text}>
												{trace.text.length > 120 ? `${trace.text.slice(0, 120)}…` : trace.text}
											</p>
										) : (
											<p className="mt-0.5 opacity-70">执行中…</p>
										)}
									</div>
								);
							}

							// 其它 part（reasoning / step-start / data-*）不显示：
							// 服务端已关掉 reasoning，剩下的对界面没有意义。
							return null;
						})}
					</div>
				))}

				{errText && (
					<p className="max-w-[92%] rounded-xl border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 text-[11px] leading-snug text-red-400">
						{errText}
					</p>
				)}

				{busy && <span className="text-[11px] text-muted">正在思考…</span>}
			</div>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					send();
				}}
				className="flex shrink-0 items-end gap-2 border-t border-border p-2"
			>
				<textarea
					ref={taRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							send();
						}
					}}
					rows={1}
					aria-label="输入消息"
					placeholder={busy ? '回复中…' : '说点什么，比如「放一首传奇」'}
					className="max-h-24 min-h-[2.25rem] min-w-0 flex-1 resize-none rounded-xl border border-border bg-surface-2 px-3 py-1.5 text-sm text-foreground outline-none transition placeholder:text-muted focus:border-brand/50"
				/>
				{/* 语音输入：转写结果**接在已有内容后面**、不自动发送（见 VoiceButton 头部的边界）。
				    不支持的浏览器里这个组件自己返回 null，所以这里不必再判能力。 */}
				<VoiceButton
					disabled={busy}
					onText={(text) => setInput((prev) => voiceInsert(prev, text) ?? prev)}
				/>
				{busy ? (
					<button
						type="button"
						onClick={onStop}
						aria-label="停止生成"
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-foreground transition hover:bg-border"
					>
						<StopIcon />
					</button>
				) : (
					<button
						type="submit"
						disabled={!input.trim()}
						aria-label="发送"
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-white shadow-sm transition hover:bg-brand-strong active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
					>
						<SendIcon />
					</button>
				)}
			</form>
		</div>
	);
}
