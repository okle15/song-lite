/**
 * ChatCard — 「AI 对话」卡片内容（原 HomeCarousel 的第二页）。
 *
 * 去掉了原来的横向 scroll-snap 轮播：页面切换现在由 PaneShell 的标签页承担，
 * 合并后点「AI 对话」标签即可切过来，单独成卡时则直接常驻。
 */
'use client';
import { ChatBox } from './ChatBox';
import type { useChatStream } from '@/components/use-chat-stream';

export function ChatCard({ chat }: { chat: ReturnType<typeof useChatStream> }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ChatBox
				messages={chat.messages}
				tools={chat.tools}
				status={chat.status}
				error={chat.error}
				onSend={chat.send}
				onStop={chat.stop}
			/>
		</div>
	);
}
