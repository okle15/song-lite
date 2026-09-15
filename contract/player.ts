/**
 * 播放器 wire 类型 —— 服务端 `getSnapshot()` 产出、前端直接消费的形状。
 *
 * 为什么单独成文件：这两个类型由 `server/player/state.ts` 生产、由
 * `components/APlayerPlayer.tsx` 与 `components/PlayerProvider.tsx` 消费，
 * 属于典型的**前后端共享契约**。原先它们与生产方同住一个模块，而那个模块
 * 顶部 `import { EventEmitter } from 'node:events'`——前端只 `import type`
 * 才侥幸没把 Node 内置模块拖进浏览器 bundle。抽到零依赖的本文件后，
 * 前端引类型不再触碰任何服务端代码。
 *
 * 同源约定：SSE `/api/player/events` 推的就是 `PlayerSnapshot`。
 */

/** 队列项精简版（只含 UI 需要的字段，减少 SSE 传输量）。 */
export type QueueItem = {
	id: string;
	title: string;
	artist: string;
};

/** 推给前端的精简快照（含完整 queue 数组供队列面板显示）。 */
export type PlayerSnapshot = {
	state: 'stopped' | 'playing' | 'paused';
	currentTrack: { id: string; title: string; artist: string; album: string } | null;
	positionSec: number;
	queueSize: number;
	queueIndex: number;
	queue: QueueItem[];
};
