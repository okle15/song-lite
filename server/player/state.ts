/**
 * In-memory player state — 方案 C 后的职责收敛。
 *
 * 维护播放状态机（state / currentTrack / queue / currentIndex），音频输出
 * 交给浏览器 `<audio>` 元素（见 components/PlayerControls.tsx）。方案 C
 * 之前这里还负责"模拟播放"（positionSec 推进），现在 positionSec 由前端
 * `audio.currentTime` 驱动，本模块只做状态管理。
 *
 * SSE 推送：每次状态变更通过内部 EventEmitter 通知所有订阅者（/api/player/events
 * SSE 路由订阅后推给前端），前端不再轮询。热重载丢状态、多实例不共享仍是已知
 * 限制（state 存在模块级变量里，HMR 重载模块时重置）——要解决需外部存储。
 *
 * `queue` 初始化为完整音乐库，确保 `next_track` 总有下一首可跳。
 * `currentIndex` 指向 queue 中当前播放项。
 */
import { EventEmitter } from 'node:events';
import { getSongs, type Song } from '../library';
import type { PlayerSnapshot } from '../../contract/player';

export type PlayerState = {
	state: 'stopped' | 'playing' | 'paused';
	currentTrack: Song | null;
	positionSec: number;
	queue: Song[];
	currentIndex: number;
};

// `PlayerSnapshot` / `QueueItem`（推给前端的 wire 类型）已抽到 `contract/player.ts`，
// 让前端能在不触碰本文件（依赖 node:events）的前提下引用它们。

// ── 状态存放：globalThis，dev 热重载（HMR）安全 ──
// 原因：模块级常量在 HMR 重新求值时会生成全新实例——旧定时器/订阅者还握着
// 旧 state，新代码却读写新 state，表现为「电台开着但队列是空的」。
// 挂到 globalThis 后，重载后的新模块直接收养旧实例，状态连续。
// （生产模式没有 HMR，这只是无操作的安全网；电台 station.ts 同款做法。）
const g = globalThis as unknown as {
	__playerState?: PlayerState;
	__playerQueueInit?: boolean;
	__playerEmitter?: EventEmitter;
};

const state: PlayerState = (g.__playerState ??= {
	state: 'stopped',
	currentTrack: null,
	positionSec: 0,
	queue: [],
	currentIndex: -1,
});

// 队列初始化标记（`__playerQueueInit`）由 `initQueueFromLibrary` 自管：
// 进入时检查、失败时复位（见下方第 129 行附近）。这里不再单独维护一份
// ——此前有一行 `const queueInitialized = (g.__playerQueueInit ??= false)`
// 从未被读取，以及一个无人调用的 `markQueueInitialized()` 导出（2026-09-11 删除）。

// 内部事件总线：state 变更时 emit('change', snapshot) 通知 SSE 订阅者
const emitter = (g.__playerEmitter ??= new EventEmitter());
emitter.setMaxListeners(50); // dev 下多 tab 可能超过默认 10

/** 读取当前快照（精简版，推给前端用）。 */
export function getSnapshot(): PlayerSnapshot {
	const { state: s, currentTrack, positionSec, queue, currentIndex } = state;
	return {
		state: s,
		currentTrack: currentTrack
			? {
					id: currentTrack.id,
					title: currentTrack.title,
					artist: currentTrack.artist,
					album: currentTrack.album,
				}
			: null,
		positionSec,
		queueSize: queue.length,
		queueIndex: currentIndex,
		queue: queue.map((s) => ({ id: s.id, title: s.title, artist: s.artist })),
	};
}

/**
 * 订阅状态变更。返回取消订阅函数。SSE 路由在连接建立时调用，断开时调用返回的函数。
 */
export function subscribeToPlayerState(listener: (snapshot: PlayerSnapshot) => void): () => void {
	emitter.on('change', listener);
	return () => emitter.off('change', listener);
}

/** 内部：状态变更后通知所有订阅者。 */
function emitChange(): void {
	emitter.emit('change', getSnapshot());
}

/** Read the current player state (returned to the model as tool output). */
export function getPlayerState(): PlayerState {
	return state;
}

/**
 * Sync the queue with the actual library (Phase 7). Only replaces the queue
 * if the set of song IDs differs from the current queue, so it's safe to
 * call on every play request without resetting playback position.
 */
export function ensureQueue(songs: Song[]): void {
	const currentIds = new Set(state.queue.map((s) => s.id));
	const newIds = new Set(songs.map((s) => s.id));
	if (currentIds.size === newIds.size && [...currentIds].every((id) => newIds.has(id))) {
		return; // same set, no change needed
	}
	state.queue = [...songs];
	// If the current track is no longer in the new queue, reset.
	if (state.currentTrack && !newIds.has(state.currentTrack.id)) {
		state.state = 'stopped';
		state.currentTrack = null;
		state.positionSec = 0;
		state.currentIndex = -1;
	} else if (state.currentTrack) {
		state.currentIndex = songs.findIndex((s) => s.id === state.currentTrack!.id);
	}
	emitChange();
}

/**
 * 从真实音乐库异步加载队列（扫描 MUSIC_DIR）。
 * 首次调用时扫描并填充队列，后续调用直接返回（避免重复扫描）。
 * SSE events 路由在首次连接时调用此函数，确保队列面板显示真实歌曲而非 mock。
 */
export async function initQueueFromLibrary(): Promise<void> {
	if (g.__playerQueueInit) return;
	g.__playerQueueInit = true; // 先标记，防止并发重复扫描
	try {
		const songs = await getSongs();
		ensureQueue(songs);
	} catch {
		g.__playerQueueInit = false; // 扫描失败，允许下次重试
	}
}

/** Start playing a specific track by id. Returns the updated state. */
export function playTrackById(trackId: string): PlayerState | undefined {
	const idx = state.queue.findIndex((song) => song.id === trackId);
	if (idx === -1) return undefined;
	state.currentIndex = idx;
	state.currentTrack = state.queue[idx];
	state.positionSec = 0;
	state.state = 'playing';
	emitChange();
	return state;
}

/** Pause the current playback. Returns the updated state, or undefined if nothing is playing. */
export function pause(): PlayerState | undefined {
	if (state.state === 'stopped' || !state.currentTrack) return undefined;
	state.state = 'paused';
	emitChange();
	return state;
}

/** Resume playback from paused. Returns the updated state, or undefined if not paused. */
export function resume(): PlayerState | undefined {
	if (state.state !== 'paused' || !state.currentTrack) return undefined;
	state.state = 'playing';
	emitChange();
	return state;
}

/** Skip to the next track in the queue. Returns the updated state, or undefined if queue ended. */
export function nextTrack(): PlayerState | undefined {
	const nextIdx = state.currentIndex + 1;
	if (nextIdx >= state.queue.length) {
		// Queue exhausted — stop.
		state.state = 'stopped';
		state.currentTrack = null;
		state.positionSec = 0;
		state.currentIndex = -1;
		emitChange();
		return state;
	}
	state.currentIndex = nextIdx;
	state.currentTrack = state.queue[nextIdx];
	state.positionSec = 0;
	state.state = 'playing';
	emitChange();
	return state;
}

/**
 * 跳转到队列中指定索引的曲目并开始播放。
 * 用于队列面板点击跳转。返回更新后的 state，或 undefined 如果索引越界。
 */
export function jumpToIndex(index: number): PlayerState | undefined {
	if (index < 0 || index >= state.queue.length) return undefined;
	state.currentIndex = index;
	state.currentTrack = state.queue[index];
	state.positionSec = 0;
	state.state = 'playing';
	emitChange();
	return state;
}

