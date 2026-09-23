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

/** 轨迹卡片要展示的三样东西。 */
type Trace = { name: string; ok: boolean; ms?: number; text?: string };

/**
 * 从 AI SDK 的 tool part 里取出轨迹。
 *
 * 这里是**业务形状与 SDK 形状的交界**：`output` 就是 `execute` 的返回值，也就是
 * `contract/tool.ts` 的 `ToolOutcome`，所以 `ok` / `ms` 直接可读；工具还没跑完
 * （`input-streaming` / `input-available`）时三者都缺，卡片显示「执行中」。
 */
function traceOf(part: ToolUIPart): Trace {
	const name = getToolName(part);
	if (part.state === 'output-available') {
		const out = part.output as ToolOutcome | undefined;
		return { name, ok: out?.ok ?? true, ms: out?.ms, text: out?.text };
	}
	if (part.state === 'output-error') return { name, ok: false, text: part.errorText };
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
};

export function ChatCard({ messages, status, error, onSend, onStop }: Props) {
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

				{messages.map((m) => (
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
