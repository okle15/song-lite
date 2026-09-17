/**
 * player-events — 播放器跨组件事件 + 本地偏好 的单一事实来源。
 *
 * 事件契约（window CustomEvent）：
 *  - player-time     (detail: number 秒)   APlayerPlayer timeupdate 广播
 *  - player-duration (detail: number 秒)   APlayerPlayer loadeddata 广播
 *  - player-seek     (detail: number 秒)   任意组件请求跳转（APlayerPlayer 监听）
 *  - player-volume   (detail: number 0-1)  任意组件改音量（APlayerPlayer 监听）
 *  - player-mode     (detail: PlaybackMode) 循环模式变化（仅顺序 / 列表 / 单曲三种）
 *  - player-shuffle  (detail: boolean)      切歌时随机选下一首的独立 toggle
 *  - player-favorites (detail: string[])   收藏集合变化（多控件 UI 同步）
 *  - lyrics-fullscreen (detail: none)      请求开/关全屏歌词沉浸页
 *                                          （GlobalHotkeys 的 F 键派发，LyricsPanel 监听）
 *
 * 本地偏好存 localStorage（音量 / 播放模式 / 随机 / 收藏），APlayerPlayer 初始化时读取。
 * 键名统一取自 storage-keys（带项目命名空间，避免与 song 互相覆盖）。
 *
 * ── 音量与播放方式：本机是真相，服务端是镜像（2026-09-17 加）────────────
 * 这两项从前只活在本文件与 localStorage 里，于是 agent 既看不见也改不动。
 * 现在它们同时出现在播放快照（`contract/player.ts`）里，两个方向各走一条路：
 *   本机改动 → `requestXxx()` 顺手**上报**服务端（`reportSettings`，合流后发一次）
 *   服务端改动 → 快照里的值变了 → APlayerPlayer 调 `applyXxx()` 写回本机 + 广播
 * `apply*` 与 `request*` 的区别只有一条：**apply 不回报**。少了这条，服务端下发
 * 会立刻被回报成一次新请求，形成"下发→回报→下发"的空转。
 */
import type { PlaybackMode } from '@/contract/player';
import { LS_KEYS } from './storage-keys';

/** 重新导出：调用方（PlayerBar / NowPlaying）不必知道自己引入的是契约类型。 */
export type { PlaybackMode };

export const PLAYER_EVENTS = {
	time: 'player-time',
	duration: 'player-duration',
	seek: 'player-seek',
	volume: 'player-volume',
	mode: 'player-mode',
	shuffle: 'player-shuffle',
	favorites: 'player-favorites',
	lyricsFullscreen: 'lyrics-fullscreen',
} as const;

/**
 * 循环方式（顺序 / 列表循环 / 单曲循环）。
 * 「随机播放」独立为 shuffle toggle（player-shuffle 事件），不再混入循环模式。
 *
 * 类型本身定义在 `contract/player.ts`（它已进快照，服务端也在用），这里只转出。
 */
export interface PlaybackModeSpec {
	value: PlaybackMode;
	label: string;
	zh: string;
	icon: 'SeqIcon' | 'ListLoopIcon' | 'OneLoopIcon';
}

export const PLAYBACK_MODES: PlaybackModeSpec[] = [
	{ value: 'seq', label: 'SEQ', zh: '顺序', icon: 'SeqIcon' },
	{ value: 'rpt', label: 'RPT', zh: '列表', icon: 'ListLoopIcon' },
	{ value: 'one', label: 'ONE', zh: '单曲', icon: 'OneLoopIcon' },
];

/** 本模块用到的存储键；值统一来自 storage-keys。 */
const KEYS = {
	volume: LS_KEYS.volume,
	favorites: LS_KEYS.favorites,
	mode: LS_KEYS.mode,
	shuffle: LS_KEYS.shuffle,
} as const;

/** 秒 → m:ss。 */
export function fmtTime(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) sec = 0;
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, '0')}`;
}

export function loadVolume(): number {
	if (typeof window === 'undefined') return 0.8;
	const n = Number(window.localStorage.getItem(KEYS.volume));
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.8;
}

export function saveVolume(v: number): void {
	if (typeof window === 'undefined') return;
	window.localStorage.setItem(KEYS.volume, String(Math.min(1, Math.max(0, v))));
}

export function loadMode(): PlaybackMode {
	if (typeof window === 'undefined') return 'seq';
	const raw = window.localStorage.getItem(KEYS.mode);
	// 兼容旧值 'shf'（4 模式时代的随机模式）：回退到顺序，并默认开启 shuffleOn。
	if (raw === 'shf') {
		saveMode('seq');
		if (window.localStorage.getItem(KEYS.shuffle) === null) saveShuffle(true);
		return 'seq';
	}
	return raw === 'rpt' || raw === 'one' ? raw : 'seq';
}

export function saveMode(mode: PlaybackMode): void {
	if (typeof window === 'undefined') return;
	window.localStorage.setItem(KEYS.mode, mode);
}

/** 切歌时随机选下一首的 toggle（独立于循环模式）。 */
export function loadShuffle(): boolean {
	if (typeof window === 'undefined') return false;
	return window.localStorage.getItem(KEYS.shuffle) === 'on';
}

export function saveShuffle(on: boolean): void {
	if (typeof window === 'undefined') return;
	window.localStorage.setItem(KEYS.shuffle, on ? 'on' : '');
}

export function loadFavorites(): string[] {
	if (typeof window === 'undefined') return [];
	try {
		const raw = window.localStorage.getItem(KEYS.favorites);
		const arr = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

/** 切换收藏并广播 player-favorites 事件。返回最新收藏集合。 */
export function toggleFavorite(trackId: string): string[] {
	const ids = loadFavorites();
	const next = ids.includes(trackId) ? ids.filter((id) => id !== trackId) : [...ids, trackId];
	if (typeof window !== 'undefined') {
		window.localStorage.setItem(KEYS.favorites, JSON.stringify(next));
		window.dispatchEvent(new CustomEvent<string[]>(PLAYER_EVENTS.favorites, { detail: next }));
	}
	return next;
}

export function isFavorite(trackId: string | undefined): boolean {
	return Boolean(trackId) && loadFavorites().includes(trackId as string);
}

/* ── 与 BFF 的同步：上报（本机 → 服务端）与应用（服务端 → 本机）────────── */

/**
 * 上报的合流窗口。音量条拖一下会产生几十个事件，逐个发就是几十个 POST。
 * 播放设置是**状态不是流水**，中间的中间值没有任何意义，取最后一个即可。
 */
const REPORT_THROTTLE_MS = 250;

let pendingPatch: Record<string, unknown> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 把本机设定镜像给服务端 —— 目的只有一个：让 agent 的 ⑦ 看得见「此刻多大声、
 * 怎么放」。**失败了不重试、不提示**：这只是个镜像，最坏的后果是模型这一轮
 * 读到的音量偏旧，而本机播放一切正常；为它弹一个错误提示反而更吵。
 */
export function reportSettings(patch: { volume?: number; mode?: PlaybackMode; shuffle?: boolean }): void {
	if (typeof window === 'undefined') return;
	pendingPatch = { ...pendingPatch, ...patch };
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		const body = pendingPatch;
		pendingPatch = {};
		if (Object.keys(body).length === 0) return;
		void fetch('/api/player/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}).catch(() => {});
	}, REPORT_THROTTLE_MS);
}

/**
 * 服务端下发的设定 → 本机。
 *
 * **不回报**（不调 `reportSettings`）：服务端本来就是这次改动的来源，回报一次
 * 只会再触发一轮广播。除此之外与 `requestXxx` 完全一样——写 localStorage、
 * 广播事件，UI 与 `ap.audio.volume` 都是靠那条事件跟上的。
 */
export function applyVolume(v: number): void {
	saveVolume(v);
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent<number>(PLAYER_EVENTS.volume, { detail: v }));
}

export function applyMode(mode: PlaybackMode): void {
	saveMode(mode);
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent<PlaybackMode>(PLAYER_EVENTS.mode, { detail: mode }));
}

export function applyShuffle(on: boolean): void {
	saveShuffle(on);
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent<boolean>(PLAYER_EVENTS.shuffle, { detail: on }));
}

/* ── 本机改动（写本地 + 广播 + 上报）────────────────────────────────── */

/** 广播 seek / volume / mode 请求。 */
export function requestSeek(sec: number): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent<number>(PLAYER_EVENTS.seek, { detail: sec }));
}

export function requestVolume(v: number): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent<number>(PLAYER_EVENTS.volume, { detail: v }));
	reportSettings({ volume: Math.min(1, Math.max(0, v)) });
}

export function requestMode(mode: PlaybackMode): void {
	if (typeof window === 'undefined') return;
	saveMode(mode);
	window.dispatchEvent(new CustomEvent<PlaybackMode>(PLAYER_EVENTS.mode, { detail: mode }));
	reportSettings({ mode });
}

export function requestShuffle(on: boolean): void {
	if (typeof window === 'undefined') return;
	saveShuffle(on);
	window.dispatchEvent(new CustomEvent<boolean>(PLAYER_EVENTS.shuffle, { detail: on }));
	reportSettings({ shuffle: on });
}
