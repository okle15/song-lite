/**
 * Lightweight SSE chat hook — Phase 5；2026-09-10 起直读 AI SDK 原生流。
 *
 * Decision F1: write our own React hook instead of depending on the retired
 * framework's React package (which pulled in its SDK — a workspace source
 * package without a built dist — see Phase 4 learning #1). This hook talks
 * to the BFF `/api/chat` SSE stream and assembles AI SDK `UIMessageChunk`
 * parts into chat state.
 *
 * 线格式就是 AI SDK 自己的（`JsonToSseTransformStream`）：
 * `data: <json>\n\n` 每帧，`data: [DONE]\n\n` 收尾。原先的翻译层
 * （fullStream → 自有 `message-delta` / `tool-input` 词汇表）已删除。
 *
 * Part handling (SSE → UI):
 * - `text-delta` (`.delta`) → append to the current assistant message.
 *   The model also emits `reasoning-delta` carrying its thinking; those must
 *   never reach the bubble (measured: ~78% of delta chars on a typical turn).
 *   Same rule is applied server-side in `telemetry/collector.ts` so logs and
 *   UI agree. Both live in the shared reducer `contract/chat-chunks.ts`.
 * - `tool-input-available` / `tool-output-available` → recorded in `tools`
 *   for inline activity display. Output is attached to the most recent input
 *   still missing one (they are emitted in order per tool call).
 * - `error` (`.errorText`) → surfaces an error. `abort` 视为用户中断，不报错。
 * - `[DONE]` sentinel from the BFF → stream fully consumed.
 *
 * One assistant message per `send()`: a turn may contain multiple text parts
 * (one per LLM round, e.g. 「我先搜一下」→ tool → final reply), but this app
 * renders a single bubble, so only the **last** text part is shown —
 * see `contract/chat-chunks.ts`.
 */
'use client';
import { useCallback, useRef, useState } from 'react';
import {
	type ReplyAssembler,
	type UIChunk,
	emptyReply,
	reduceReply,
	visibleReply,
} from '@/contract/chat-chunks';

export type ChatMessage = {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	streaming?: boolean;
};

export type ToolActivity = {
	id: string;
	toolName: string;
	input: unknown;
	output?: unknown;
};

export type ChatStatus = 'idle' | 'sending' | 'streaming' | 'error';

/** AI SDK 原生 UI message stream part（`UIMessageChunk` 的结构化视图）。 */
type ChatChunk = UIChunk;

let counter = 0;
const nextId = () => `m${Date.now()}_${counter++}`;

export function useChatStream(userId: string) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [tools, setTools] = useState<ToolActivity[]>([]);
	const [status, setStatus] = useState<ChatStatus>('idle');
	const [error, setError] = useState<string | undefined>();
	const abortRef = useRef<AbortController | null>(null);
	/**
	 * 回复装配器。一次 turn 会有多个文本块（每轮 LLM 一块，工具调用也切块），
	 * 只有最后一块才是真正给用户的回答——模型在调工具前说的「我先搜一下」
	 * 之类的中间话不该留在气泡里。规则见 contract/chat-chunks.ts。
	 * 用 ref 而非 state：它是流的累加器，不需要触发额外渲染（气泡由 setMessages 驱动）。
	 */
	const replyRef = useRef<ReplyAssembler>(emptyReply());

	const send = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed || status === 'sending' || status === 'streaming') return;

			setError(undefined);
			setStatus('sending');

			const userMsg: ChatMessage = { id: nextId(), role: 'user', text: trimmed };
			const asstId = nextId();
			const asstMsg: ChatMessage = { id: asstId, role: 'assistant', text: '', streaming: true };
			setMessages((prev) => [...prev, userMsg, asstMsg]);

			const controller = new AbortController();
			abortRef.current = controller;
			// 每轮重置装配器，避免上一轮的文本块串到这一轮。
			replyRef.current = emptyReply();

			const syncBubble = (state: ReplyAssembler) => {
				const text = visibleReply(state);
				setMessages((prev) => prev.map((m) => (m.id === asstId ? { ...m, text } : m)));
			};

			const handleChunk = (chunk: ChatChunk) => {
				// 文本装配统一走共享 reducer，再按当前状态刷新气泡。
				const next = reduceReply(replyRef.current, chunk);
				if (next !== replyRef.current) {
					replyRef.current = next;
					syncBubble(next);
				}
				switch (chunk.type) {
					case 'tool-input-available':
					case 'tool-input-error':
						setTools((prev) => [
							...prev,
							{ id: nextId(), toolName: String(chunk.toolName ?? 'unknown'), input: chunk.input, output: undefined },
						]);
						break;
					case 'tool-output-available':
						setTools((prev) => {
							// Attach to the most recent tool call still missing its output.
							let realIdx = -1;
							for (let i = prev.length - 1; i >= 0; i--) {
								if (prev[i].output === undefined) {
									realIdx = i;
									break;
								}
							}
							if (realIdx === -1) return prev;
							const copy = [...prev];
							copy[realIdx] = { ...copy[realIdx], output: chunk.output };
							return copy;
						});
						break;
					case 'error':
						setError(String(chunk.errorText ?? 'Agent 执行失败，请重试'));
						break;
				}
			};

			try {
				const res = await fetch('/api/chat', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ message: trimmed, userId }),
					signal: controller.signal,
				});

				if (!res.ok || !res.body) {
					let msg = `请求失败 (${res.status})`;
					try {
						const j = (await res.json()) as { code?: number; message?: string };
						if (j?.message) msg = j.message;
					} catch {
						/* keep default */
					}
					throw new Error(msg);
				}

				setStatus('streaming');
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let idx: number;
					while ((idx = buffer.indexOf('\n\n')) !== -1) {
						const raw = buffer.slice(0, idx).trim();
						buffer = buffer.slice(idx + 2);
						if (!raw.startsWith('data:')) continue;
						const data = raw.slice(raw.indexOf(':') + 1).trim();
						if (data === '[DONE]') {
							buffer = '';
							break;
						}
						let chunk: ChatChunk;
						try {
							chunk = JSON.parse(data) as ChatChunk;
						} catch {
							continue;
						}
						handleChunk(chunk);
					}
				}
			} catch (err) {
				if (!controller.signal.aborted) {
					setError(err instanceof Error ? err.message : String(err));
					setStatus('error');
					setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
					return;
				}
			}

			setStatus('idle');
			setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
		},
		[status, userId],
	);

	const stop = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	return { messages, tools, status, error, send, stop };
}
