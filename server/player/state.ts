/**
 * In-memory player state — 方案 C 后的职责收敛。
 *
 * 维护播放状态机（state / currentTrack / queue / currentIndex）+ 两组**设备侧设定**
 * （volume / mode / shuffle），音频输出交给浏览器 `<audio>` 元素。
 * 方案 C 之前这里还负责"模拟播放"（positionSec 推进），现在 positionSec 由前端
 * `audio.currentTime` 驱动，本模块只做状态管理。
 *
 * SSE 推送：每次状态变更通过内部 EventEmitter 通知所有订阅者（/api/player/events
 * SSE 路由订阅后推给前端），前端不再轮询。热重载丢状态、多实例不共享仍是已知
 * 限制（state 存在模块级变量里，HMR 重载模块时重置）——要解决需外部存储。
 *
 * `queue` 初始化为完整音乐库，确保 `next_track` 总有下一首可跳。
 * `currentIndex` 指向 queue 中当前播放项。
 *
 * ── 队列不再恒等于整库（2026-09-17，BLUEPRINT 阶段 3d）─────────────────
 * 从阶段 0 起队列就只有一种形态：整个曲库（`ensureQueue(getSongs())` 每次点播都
 * 这么改回去）。于是「来点安静的」只能一首一首搜着播，而 `next_track` 转眼又
 * 跑回整库顺序 —— 队列不是「用户此刻想听的那一批」，只是个书签。
 * 现在多了 `queueSource`：
 *   - `'library'`（默认）：行为与从前完全一致；
 *   - `'custom'` ：`setQueueAndPlay` 换来的一批，`ensureQueue` 会**主动让路**。
 * 一个字段的代价，换来「按条件组队列」这件事在状态层成立。
 */
import { EventEmitter } from 'node:events';
import { getSongs, type Song } from '../library';
import type { PlaybackMode, PlayerSnapshot, QueueSource } from '../../contract/player';

export type PlayerState = {
	state: 'stopped' | 'playing' | 'paused';
	currentTrack: Song | null;
	positionSec: number;
	queue: Song[];
	currentIndex: number;
	/** 这一批队列从哪来。见 `contract/player.ts` 的 `QueueSource`。 */
	queueSource: QueueSource;
	/** 队列的人话名字（仅 `'custom'` 时有意义）。进 ⑦ 提示词。 */
	queueLabel: string | null;
	/** 音量 0–1（设备侧是真相，这里是镜像，见 `contract/player.ts`）。 */
	volume: number;
	/** 循环方式：顺序 / 列表 / 单曲。 */
	mode: PlaybackMode;
	/** 随机开关（独立于循环方式）。 */
	shuffle: boolean;
};

/** 默认音量。与 `components/player-events.ts` 的 `loadVolume()` 必须一致。 */
export const DEFAULT_VOLUME = 0.8;

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
	queueSource: 'library',
	queueLabel: null,
	volume: DEFAULT_VOLUME,
	mode: 'seq',
	shuffle: false,
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
					// 只带布尔不带封面字节（见 contract/player.ts 的说明）。
					hasCover: currentTrack.hasCover,
				}
			: null,
		positionSec,
		queueSize: queue.length,
		queueIndex: currentIndex,
		queue: queue.map((s) => ({ id: s.id, title: s.title, artist: s.artist })),
		queueSource: state.queueSource,
		queueLabel: state.queueLabel,
		volume: state.volume,
		mode: state.mode,
		shuffle: state.shuffle,
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
 *
 * **自定义队列（`queueSource === 'custom'`）直接让路**：这个函数的存在理由是
 * 「队列等于曲库」这一种形态，而那已经不再是唯一的形态。若不放行，用户刚让
 * agent 组好的「安静的歌」会被下一次点播（前端点一下、或 agent 调 play_track）
 * 悄悄换回整库顺序 —— 不报错、只是那一批歌没了。
 */
export function ensureQueue(songs: Song[]): void {
	if (state.queueSource === 'custom') return; // 见上方说明：这不是本函数的辖区
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

/**
 * 播放一首歌。**队列里没有它就追加到队尾**（音乐 App 的常规语义：
 * 「放这首」= 现在放，放完接着原来的往下走）。
 *
 * 为什么不做「不在队列里就报 404」：队列从前恒等于整库，所以「不在队列里」
 * 不可能发生，这条分支从来没被写过。自定义队列出现之后它**天天会发生**——
 * agent 刚组了一批「安静的歌」，用户说「放荷塘月色」而它不在这批里。
 * 报错会把一件完全合理的事说成失败；换回整库顺序则会**悄悄丢掉那一批**。
 * 追加没有这两个问题，而且不改变 `queueSource`（那批歌还在，只是多了这一首）。
 */
export function playTrack(song: Song): PlayerState {
	const idx = state.queue.findIndex((s) => s.id === song.id);
	if (idx === -1) {
		state.queue = [...state.queue, song];
		state.currentIndex = state.queue.length - 1;
	} else {
		state.currentIndex = idx;
	}
	state.currentTrack = state.queue[state.currentIndex];
	state.positionSec = 0;
	state.state = 'playing';
	emitChange();
	return state;
}

/**
 * 换一批队列并开始放第一首 —— 「按条件组队列」的落点。
 *
 * 为什么「换队列」与「开播」绑在一起：用户说「来点安静的」要的是**听到**，
 * 不是得到一张待播清单。分开成两个动作只会让模型多调一次工具、多一次猜错的机会。
 *
 * `source: 'library'` 用于「别只放这几首了」那种**恢复整库**的请求（见
 * `app/api/player/queue/route.ts`）；默认 `'custom'` 才是组队列的正常路径。
 */
export function setQueueAndPlay(
	songs: Song[],
	opts: { label?: string | null; source?: QueueSource } = {},
): PlayerState | undefined {
	if (songs.length === 0) return undefined; // 空队列不是一种可播放状态，交给调用方报错
	state.queue = [...songs];
	state.queueSource = opts.source ?? 'custom';
	state.queueLabel = opts.label?.trim() ? opts.label.trim() : null;
	state.currentIndex = 0;
	state.currentTrack = state.queue[0];
	state.positionSec = 0;
	state.state = 'playing';
	emitChange();
	return state;
}

/**
 * 改音量（0–1，越界已由路由夹紧）。**返回值里没有「变没变」这回事**：
 * 设成当前值也算成功 —— 幂等，前端拖到哪就是哪，不必先读再比。
 */
export function setVolume(volume: number): PlayerState {
	state.volume = volume;
	emitChange();
	return state;
}

/** 改播放方式（循环方式与随机开关，各自可选）。两者一起改是因为它们在 UI 上就是一组。 */
export function setPlayback(opts: { mode?: PlaybackMode; shuffle?: boolean }): PlayerState {
	if (opts.mode) state.mode = opts.mode;
	if (typeof opts.shuffle === 'boolean') state.shuffle = opts.shuffle;
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

