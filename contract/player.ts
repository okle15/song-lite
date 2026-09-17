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

/**
 * 循环方式（顺序 / 列表循环 / 单曲循环）。**「随机」不在其中**——它是一枚
 * 独立的开关（`shuffle`），与循环方式是两件事：随机单曲循环和随机顺序播放
 * 都说得通，合成一个四值枚举反而要多解释一句「shf 时循环算什么」。
 *
 * 定义放在 `contract/` 而不是 `components/player-events.ts`（它原本住在那里）：
 * 2026-09-17 起它**进了快照**（agent 要能改播放模式），于是它同时是服务端的
 * 状态取值、wire 上的字段、前端 UI 的取值——三个消费者，只好放契约层。
 * UI 侧的 `PLAYBACK_MODES`（中文名 + 图标）仍留在 player-events。
 */
export type PlaybackMode = 'seq' | 'rpt' | 'one';

/**
 * 播放方式的**中文全名** —— 给「读文字的人/模型」的场合用（工具返回值、
 * 系统提示词）。UI 按钮上的短标签（顺序 / 列表 / 单曲 + 图标）在
 * `components/player-events.ts` 的 `PLAYBACK_MODES`，两处**不是同一份文案**：
 * 一个是「说给人听的一句话」，一个是「图标旁边站得住的两个字」。
 * 但三种取值的**全集**只有这里一处，加第四种模式时不会漏掉某一侧。
 */
export const PLAYBACK_MODE_LABEL: Record<PlaybackMode, string> = {
	seq: '顺序播放',
	rpt: '列表循环',
	one: '单曲循环',
};

/**
 * 队列从哪来。**这个字段决定 `ensureQueue` 敢不敢覆盖它**：
 *  - `'library'`：队列就是整个曲库（默认），`/api/player/play` 每次都会与之同步；
 *  - `'custom'` ：agent 按条件挑出来的一批（"来点安静的"），**谁都不许自动覆盖**，
 *    否则用户刚组好的一批歌会被下一次点播悄悄换成整库。
 */
export type QueueSource = 'library' | 'custom';

/** 推给前端的精简快照（含完整 queue 数组供队列面板显示）。 */
export type PlayerSnapshot = {
	state: 'stopped' | 'playing' | 'paused';
	/**
	 * 当前曲目。`hasCover` 是唯一一个「不是给人读的」字段：前端拿它决定
	 * 「试不试真实封面」，缺了就只能盲发一次注定 404 的请求
	 * （见 `components/TrackCover.tsx`）。带上传送量是一个布尔，可以忽略。
	 */
	currentTrack: {
		id: string;
		title: string;
		artist: string;
		album: string;
		hasCover: boolean;
	} | null;
	positionSec: number;
	queueSize: number;
	queueIndex: number;
	queue: QueueItem[];
	/** 这一批队列从哪来（见 `QueueSource`）。agent 据此知道「整库」还是「刚挑的一批」。 */
	queueSource: QueueSource;
	/**
	 * 队列的人话名字，如「安静的歌（6 首）」。`'library'` 时为空 ——
	 * 「整个曲库」不需要另起名字，那本来就是默认。
	 *
	 * 它进系统提示词（⑦），因为模型需要能对用户说「这批是我按安静挑的」，
	 * 而不是只能说「队列里有 6 首」。
	 */
	queueLabel: string | null;
	/**
	 * 音量 0–1。**为什么服务端要存一份**：音量与播放模式从前是纯前端
	 * localStorage，于是 agent 既看不到（答不了「现在多大声」）、也改不动
	 * （说了「小声点」只能回一句做不到）。存进播放状态后，它与队列一样走
	 * 「改状态 → SSE 广播 → 前端跟上」这条既有的路（见 `agent/tools.ts`）。
	 *
	 * 真相仍在**设备侧**（音量是这台浏览器的音量），服务端这份是镜像：
	 * 前端本机改动即时上报（`player-events.ts`），服务端改动经 SSE 下发。
	 */
	volume: number;
	/** 播放模式。同上：设备侧是真相，这里是镜像，好让 agent 看得见、改得动。 */
	mode: PlaybackMode;
	/** 随机开关（独立于循环模式）。 */
	shuffle: boolean;
};
