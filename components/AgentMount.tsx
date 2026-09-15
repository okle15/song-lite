/**
 * AgentMount —— 最小对话面板（右下浮层）。
 *
 * 传输（BLUEPRINT §2 的 ⑧ 冻结区）交给 AI SDK 的 `useChat`：读 SSE、增量拼装、
 * 消息状态、中断、错误，**全部不写**。本文件因此只剩两件事——把播放状态带上、
 * 把 parts 画出来。
 *
 * 为什么是浮层而不是布局系统里的一张卡片：`components/panel-layout.ts`、
 * `LayoutProvider`、`LayoutMenu` 都是已冻结的面板基建，往那里加卡片要改四个文件；
 * 浮层只需 `app/page.tsx` 里一行 `<AgentMount />`。等对话形态定下来之后再考虑搬进去。
 *
 * 与播放器的关系：本组件**只读**播放状态（`usePlayerSnapshot`），把它随消息一起发给
 * 服务端，让 agent 知道「现在在放什么」。控制播放则是 agent 在服务端调
 * `/api/player/*`，前端通过既有的 SSE 广播自动跟上——本组件不参与，也不需要参与。
 *
 * 图标内联在文件里（而非 `components/icons/index.tsx`）：这样整个对话功能是自包含的，
 * 删掉它就等于删掉全部改动。定稿后再把图标挪进图标库。
 */
'use client';
import { useChat } from '@ai-sdk/react';
import {
	DefaultChatTransport,
	getToolName,
	isStaticToolUIPart,
	isTextUIPart,
	type ToolUIPart,
} from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolOutcome } from '@/contract/tool';
import { usePlayerSnapshot } from './PlayerProvider';
import { useEscapeToClose } from './use-escape-to-close';

/** 工具名的中文标签；未登记的走原始名。 */
const TOOL_LABEL: Record<string, string> = {
	search_library: '检索曲库',
	play_track: '播放曲目',
	next_track: '下一首',
	pause_playback: '暂停',
	resume_playback: '继续播放',
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

function SparkIcon({ size = 20 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.4l-1.9-5.6L4.5 10.9 10.1 9z" />
			<path d="M18.6 3.2v3M17.1 4.7h3" />
		</svg>
	);
}

function SendIcon({ size = 18 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
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
function StopIcon({ size = 16 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
			<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
		</svg>
	);
}

export function AgentMount() {
	const snapshot = usePlayerSnapshot();
	const [open, setOpen] = useState(false);
	const [input, setInput] = useState('');

	// 传输只建一次：它内部是没有可变状态的配置对象，重建等于把在途的流丢掉。
	const transport = useMemo(() => new DefaultChatTransport({ api: '/api/agent' }), []);
	const { messages, sendMessage, status, error, clearError, stop } = useChat({ transport });

	/** `submitted` = 已发出、还没等到首字；`streaming` = 正在吐字。两者都算忙。 */
	const busy = status === 'submitted' || status === 'streaming';

	const listRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEscapeToClose(() => setOpen(false), open);

	// 打开时聚焦输入框
	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	// 流式追加内容后把列表滚到底
	useEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	const send = () => {
		const text = input.trim();
		if (!text || busy) return;
		setInput('');
		clearError();
		// 快照随消息带上——服务端据此知道「现在在放什么」，省掉一次读状态往返。
		void sendMessage({ text }, { body: { snapshot } });
	};

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-label="打开音乐助手对话"
				className="glass lift fixed bottom-20 right-3 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-border text-brand shadow-lg transition hover:border-brand/40 sm:bottom-24 sm:right-5"
			>
				<SparkIcon />
			</button>
		);
	}

	const errText = error ? friendlyError(error) : null;

	return (
		<section
			aria-label="音乐助手对话"
			className="glass fixed bottom-20 right-3 z-40 flex h-[min(70vh,520px)] w-[min(94vw,380px)] flex-col overflow-hidden rounded-2xl border border-border shadow-2xl sm:bottom-24 sm:right-5"
		>
			<header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
				<div className="flex items-center gap-2 text-brand">
					<SparkIcon size={16} />
					<h2 className="text-sm font-semibold text-foreground">音乐助手</h2>
				</div>
				<button
					type="button"
					onClick={() => setOpen(false)}
					aria-label="关闭对话"
					className="rounded-lg px-2 py-1 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
				>
					关闭
				</button>
			</header>

			<div ref={listRef} className="scroll-area flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
				{messages.length === 0 && (
					<p className="mt-6 text-center text-xs leading-relaxed text-muted">
						试试「放一首传奇」
						<br />
						「现在在放什么」
						<br />
						「换下一首」
					</p>
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
												? 'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-brand-soft px-3 py-1.5 text-xs leading-relaxed'
												: 'max-w-[92%] whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground'
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
										{trace.ms !== undefined && <span className="ml-1.5 opacity-70">{trace.ms}ms</span>}
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

			<div className="flex shrink-0 items-center gap-2 border-t border-border p-2">
				<input
					ref={inputRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							send();
						}
					}}
					placeholder={busy ? '回复中…' : '说点什么，比如「放一首传奇」'}
					className="min-w-0 flex-1 rounded-xl border border-border bg-surface-2 px-3 py-1.5 text-xs text-foreground outline-none transition placeholder:text-muted focus:border-brand/50 disabled:opacity-60"
				/>
				{busy ? (
					<button
						type="button"
						onClick={() => stop()}
						aria-label="停止生成"
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-foreground transition hover:bg-border"
					>
						<StopIcon />
					</button>
				) : (
					<button
						type="button"
						onClick={send}
						disabled={!input.trim()}
						aria-label="发送"
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
					>
						<SendIcon />
					</button>
				)}
			</div>
		</section>
	);
}
