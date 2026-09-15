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
 */
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
 */
export type PlaybackMode = 'seq' | 'rpt' | 'one';

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

const KEYS = {
	volume: 'music-volume',
	favorites: 'music-favorites',
	mode: 'music-playback-mode',
	shuffle: 'music-playback-shuffle',
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

export function requestShuffle(on: boolean): void {
	if (typeof window === 'undefined') return;
	saveShuffle(on);
	window.dispatchEvent(new CustomEvent<boolean>(PLAYER_EVENTS.shuffle, { detail: on }));
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

/** 广播 seek / volume / mode 请求。 */
export function requestSeek(sec: number): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent<number>(PLAYER_EVENTS.seek, { detail: sec }));
}

export function requestVolume(v: number): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent<number>(PLAYER_EVENTS.volume, { detail: v }));
}

export function requestMode(mode: PlaybackMode): void {
	if (typeof window === 'undefined') return;
	saveMode(mode);
	window.dispatchEvent(new CustomEvent<PlaybackMode>(PLAYER_EVENTS.mode, { detail: mode }));
}
