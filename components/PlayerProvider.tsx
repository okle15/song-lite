/**
 * PlayerProvider — 全局播放状态上下文。
 *
 * 原本 APlayerPlayer 与 LyricsPanel 各自打开一条 `/api/player/events`
 * EventSource，造成重复连接 + 重复快照解析。这里收敛为**单条** SSE 连接：
 * Provider 挂载时建立一次长连接，把最新 PlayerSnapshot 放进 context，
 * 任意需要的组件通过 `usePlayerSnapshot()` 读取，避免多连接、单点真相。
 *
 * 浏览器 EventSource 自带断线重连，无需手写重连逻辑。
 */
'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import type { PlayerSnapshot } from '@/contract/player';

const EMPTY: PlayerSnapshot = {
	state: 'stopped',
	currentTrack: null,
	positionSec: 0,
	queueSize: 0,
	queueIndex: -1,
	queue: [],
	queueSource: 'library',
	queueLabel: null,
	// 与 `server/player/state.ts` 的初始值一致：SSE 连上之前先按默认值渲染，
	// 这个窗口只有几十毫秒，不一致也不会被谁看见。
	volume: 0.8,
	mode: 'seq',
	shuffle: false,
};

const PlayerSnapshotContext = createContext<PlayerSnapshot>(EMPTY);

/** 读取最新播放快照（当前曲目 / 队列 / 播放状态）。 */
export function usePlayerSnapshot(): PlayerSnapshot {
	return useContext(PlayerSnapshotContext);
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
	const [snapshot, setSnapshot] = useState<PlayerSnapshot>(EMPTY);

	useEffect(() => {
		let closed = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let attempts = 0;
		let es: EventSource | null = null;

		/**
		 * 建立（或重建）SSE 连接。
		 *
		 * 为什么需要手动重建：浏览器只对「连接中(0)/已连接(1)」状态的断线自动重连，
		 * 一旦 readyState 变成 CLOSED(2) 就不再重试，播放条会永久停在旧快照上。
		 * 这里选择重建 EventSource 而不是整页刷新——后者会丢掉用户正在输入的聊天内容。
		 * 退避策略：3s → 6s → 12s → 24s → 30s（封顶），最多 5 次后放弃，避免无限循环。
		 */
		const connect = () => {
			if (closed) return;
			es = new EventSource('/api/player/events');
			es.onopen = () => {
				attempts = 0; // 连接稳定后重置退避计数
			};
			es.onmessage = (e) => {
				try {
					setSnapshot(JSON.parse(e.data) as PlayerSnapshot);
				} catch {
					/* 忽略解析错误 */
				}
			};
			es.onerror = () => {
				// readyState: 0=连接中（会自动重连） 2=已关闭（需手动重建）
				if (es?.readyState !== EventSource.CLOSED) return;
				es.close();
				if (closed || retryTimer) return;
				if (attempts >= 5) {
					console.warn('[PlayerProvider] SSE 重连失败次数过多，停止重试');
					return;
				}
				const delay = Math.min(30000, 3000 * 2 ** attempts);
				attempts += 1;
				retryTimer = setTimeout(() => {
					retryTimer = null;
					connect();
				}, delay);
			};
		};

		connect();
		return () => {
			closed = true;
			if (retryTimer) clearTimeout(retryTimer);
			es?.close();
		};
	}, []);

	return (
		<PlayerSnapshotContext.Provider value={snapshot}>
			{children}
		</PlayerSnapshotContext.Provider>
	);
}
