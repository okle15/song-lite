/**
 * ChatBox — Phase 5.
 *
 * Renders the conversation transcript (user + assistant bubbles) and the
 * composer (textarea + send button). Assistant text streams in token-by-token
 * as `message-delta` chunks arrive. Tool activity (search_songs / play_track
 * etc.) is shown as compact inline chips between bubbles so the user can see
 * what the agent is doing while it thinks.
 *
 * Decision F3: full-chain streaming — the assistant bubble updates on every
 * `message-delta`, not buffered until the turn ends.
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatStatus, ToolActivity } from '@/components/use-chat-stream';
import { SendIcon } from './icons';

type ChatBoxProps = {
	messages: ChatMessage[];
	tools: ToolActivity[];
	status: ChatStatus;
	error?: string;
	onSend: (text: string) => void;
	onStop: () => void;
};

export function ChatBox({ messages, tools, status, error, onSend, onStop }: ChatBoxProps) {
	const [input, setInput] = useState('');
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const busy = status === 'sending' || status === 'streaming';

	// Auto-scroll to bottom as content grows.
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages, tools]);

	// 输入框随内容自动增高（上限由 CSS max-h 控制）。
	const autoGrow = () => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
	};

	useEffect(() => {
		autoGrow();
	}, [input]);

		const submit = (e: React.FormEvent) => {
			e.preventDefault();
			if (!input.trim() || busy) return;
			onSend(input);
			setInput('');
		};

	return (
		<div className="flex h-full flex-col">
			<div ref={scrollRef} className="scroll-area flex-1 space-y-3 overflow-y-auto px-4 py-4">
				{messages.length === 0 && (
					<div className="mx-auto mt-10 max-w-sm text-center">
						<span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-cyan-500 text-2xl shadow-sm">
							🎵
						</span>
						<p className="text-base font-semibold">你好，我是你的音乐助手</p>
						<p className="mt-2 text-sm text-muted">试试对我说：</p>
						<ul className="mt-2 space-y-1.5 text-sm text-muted">
							<li>“找点爵士乐”</li>
							<li>“播放 Take Five”</li>
							<li>“推荐点适合深夜放松的音乐”</li>
						</ul>
					</div>
				)}
				{messages.map((m) =>
					m.role === 'assistant' ? (
						<div key={m.id} className="flex justify-start gap-2">
							<span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-xs text-white shadow-sm">
								🎵
							</span>
							<div className="max-w-[82%] rounded-2xl rounded-tl-sm border border-border bg-surface-2 px-3 py-2 text-sm text-foreground">
								{m.text || (m.streaming ? <span className="animate-pulse text-muted">思考中…</span> : '')}
								{m.streaming && m.text && (
									<span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-brand align-middle" />
								)}
							</div>
						</div>
					) : (
						<div key={m.id} className="flex justify-end">
							<div className="max-w-[82%] rounded-2xl rounded-br-sm bg-foreground px-3 py-2 text-sm text-background">
								{m.text}
							</div>
						</div>
					),
				)}
				{tools.length > 0 && (
					<div className="space-y-1 px-1">
						{tools.map((t) => (
							<div
								key={t.id}
								className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs text-muted"
							>
								<span className="font-mono text-brand">{t.toolName}</span>
								<span className="truncate">{t.output === undefined ? '调用中…' : summary(t)}</span>
							</div>
						))}
					</div>
				)}
				{error && (
					<div className="mx-auto max-w-[90%] rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-center text-xs text-red-500">
						{error}
					</div>
				)}
			</div>

			<form onSubmit={submit} className="flex items-end gap-2 border-t border-border px-3 py-3">
				<textarea
					ref={textareaRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							submit(e);
						}
					}}
					rows={1}
					aria-label="输入消息"
					placeholder="输入消息，Enter 发送，Shift+Enter 换行"
					className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-brand"
				/>
				{busy ? (
					<button
						type="button"
						onClick={onStop}
						className="h-10 shrink-0 rounded-xl bg-surface-2 px-4 text-sm font-medium text-foreground transition hover:bg-border"
					>
						停止
					</button>
				) : (
					<button
						type="submit"
						disabled={!input.trim()}
						aria-label="发送消息"
						className="h-10 shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 text-sm font-medium text-white shadow-sm transition hover:bg-brand-strong disabled:opacity-40 active:scale-95"
					>
						<SendIcon size={16} className="-ml-1" />
						发送
					</button>
				)}
			</form>
		</div>
	);
}

function summary(t: ToolActivity): string {
	const o = t.output;
	if (o && typeof o === 'object') {
		const rec = o as { songs?: unknown[]; state?: string; currentTrack?: { title?: string }; groupCount?: number; trackCount?: number; playlists?: unknown[] };
		if (Array.isArray(rec.songs)) return `${rec.songs.length} 首歌曲`;
		if (rec.state) return `${rec.state}${rec.currentTrack?.title ? ` · ${rec.currentTrack.title}` : ''}`;
		if (typeof rec.groupCount === 'number') return `${rec.groupCount} 组`;
		if (Array.isArray(rec.playlists)) return `${rec.playlists.length} 个歌单`;
	}
	return '完成';
}
