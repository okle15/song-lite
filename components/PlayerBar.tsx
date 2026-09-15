/**
 * PlayerBar — 底部统一播放条（替代 APlayer 可视 UI，audio 引擎仍在 APlayerPlayer）。
 *
 * 布局（对齐 redesign-prototype.html）：
 *  - 桌面（md+）三栏：左 = 封面 + 标题/歌手 + 收藏❤；中 = ⏮ ▶ ⏭ + 可拖进度条 + 时间；
 *    右 = 队列按钮 + 可拖音量条。
 *  - 移动（<md）单行：封面 + meta + ❤ + ⏮ ▶ ⏭，顶部 3px 细进度线（同样可拖）。
 *
 * 数据流：
 *  - 快照（队列/当前曲目/播放状态）来自 usePlayerSnapshot（PlayerProvider SSE）。
 *  - 进度监听 'player-time' / 'player-duration'（APlayerPlayer timeupdate 广播），
 *    拖动/点击 → requestSeek(sec) → APlayerPlayer 调 ap.seek，不新增后端 API。
 *  - 音量 → requestVolume(0-1) → APlayerPlayer 设 ap.audio.volume（纯前端）。
 *  - 收藏 → toggleFavorite（localStorage + player-favorites 事件同步各处 UI）。
 *  - 上一首：进度 >3s 先回到 0；否则 jump(queueIndex-1)，队首循环到末尾
 *    （复用既有 /api/player/jump，无需后端改动）。
 */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerSnapshot } from './PlayerProvider';
import {
	PLAYBACK_MODES,
	PLAYER_EVENTS,
	fmtTime,
	isFavorite,
	loadMode,
	loadShuffle,
	loadVolume,
	requestMode,
	requestSeek,
	requestShuffle,
	requestVolume,
	saveMode,
	saveVolume,
	toggleFavorite,
	type PlaybackMode,
} from './player-events';
import type { JSX } from 'react';
import {
	FavIcon,
	FavOnIcon,
	ListLoopIcon,
	MuteIcon,
	NextIcon,
	OneLoopIcon,
	PauseIcon,
	PlayIcon,
	PrevIcon,
	QueueIcon,
	SeqIcon,
	ShuffleIcon,
	VolumeIcon,
} from './icons';

// 当前模式对应的 React 组件（player-events 里是字符串名字）。避免 JSX 中间计算。
const MODE_ICON: Record<
	PlaybackMode,
	(props: { size?: number; className?: string }) => JSX.Element
> = {
	seq: SeqIcon,
	rpt: ListLoopIcon,
	one: OneLoopIcon,
};

export function PlayerBar({ onToggleQueue }: { onToggleQueue?: () => void }) {
	const snap = usePlayerSnapshot();
	const track = snap.currentTrack;
	const isPlaying = snap.state === 'playing';

	const [position, setPosition] = useState(0);
	const [duration, setDuration] = useState(0);
	const [volume, setVolume] = useState(0.8);
	const [liked, setLiked] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [mode, setMode] = useState<PlaybackMode>('seq');
	const [shuffleOn, setShuffleOn] = useState(false);

	const posRef = useRef(0);
	const volBarRef = useRef<HTMLDivElement>(null);
	const dragTargetRef = useRef<'seek' | 'volume' | null>(null);

	// 监听播放时间/时长广播（监听只注册一次）
	useEffect(() => {
		const onTime = (e: Event) => {
			const t = (e as CustomEvent<number>).detail;
			if (typeof t !== 'number') return;
			posRef.current = t;
			// 拖动中不覆盖位置，避免跳变
			if (!dragTargetRef.current) setPosition(t);
		};
		const onDur = (e: Event) => {
			const d = (e as CustomEvent<number>).detail;
			if (typeof d === 'number') setDuration(d);
		};
		window.addEventListener(PLAYER_EVENTS.time, onTime);
		window.addEventListener(PLAYER_EVENTS.duration, onDur);
		return () => {
			window.removeEventListener(PLAYER_EVENTS.time, onTime);
			window.removeEventListener(PLAYER_EVENTS.duration, onDur);
		};
	}, []);

	// 切歌：重置进度 + 同步收藏状态
	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		posRef.current = 0;
		setPosition(0);
		setDuration(0);
		setLiked(isFavorite(track?.id));
	}, [track?.id]);  
	/* eslint-enable react-hooks/set-state-in-effect */

	// 挂载时读取本地音量偏好
	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		setVolume(loadVolume());
		setMode(loadMode());
		setShuffleOn(loadShuffle());
	}, []);
	/* eslint-enable react-hooks/set-state-in-effect */

	// 与 NowPlaying 的模式胶囊组双向同步（任一侧改变都经 player-mode 事件广播）
	useEffect(() => {
		const onMode = (e: Event) => {
			const m = (e as CustomEvent<PlaybackMode>).detail;
			if (m) setMode(m);
		};
		window.addEventListener(PLAYER_EVENTS.mode, onMode);
		return () => window.removeEventListener(PLAYER_EVENTS.mode, onMode);
	}, []);

	// 随机 toggle 同步（与其他入口统一状态）
	useEffect(() => {
		const onShuffle = (e: Event) => {
			const s = (e as CustomEvent<boolean>).detail;
			if (typeof s === 'boolean') setShuffleOn(s);
		};
		window.addEventListener(PLAYER_EVENTS.shuffle, onShuffle);
		return () => window.removeEventListener(PLAYER_EVENTS.shuffle, onShuffle);
	}, []);

	// 音量同步：快捷键 ↑/↓/M 经 player-volume 事件广播，这里跟着更新音量条，
	// 否则按方向键时只有实际音量变了、UI 纹丝不动（像没响应）。
	useEffect(() => {
		const onVol = (e: Event) => {
			const v = (e as CustomEvent<number>).detail;
			if (typeof v === 'number' && v >= 0 && v <= 1) setVolume(v);
		};
		window.addEventListener(PLAYER_EVENTS.volume, onVol);
		return () => window.removeEventListener(PLAYER_EVENTS.volume, onVol);
	}, []);

	// 记住最近一次非零音量：取消静音时恢复它，而不是固定跳回 0.8
	const lastVolRef = useRef(0.8);
	useEffect(() => {
		if (volume > 0) lastVolRef.current = volume;
	}, [volume]);

	/**
	 * 循环模式循环切换（移动端单按钮）：SEQ → RPT → ONE → SEQ。
	 * 桌面端右栏有完整胶囊组，这里给窄屏一个同等能力、占地方最小的入口。
	 */
	const cycleMode = useCallback(() => {
		const i = PLAYBACK_MODES.findIndex((m) => m.value === mode);
		const nextMode = PLAYBACK_MODES[(i + 1) % PLAYBACK_MODES.length].value;
		setMode(nextMode);
		saveMode(nextMode);
		requestMode(nextMode);
	}, [mode]);

	/**
	 * 「随机播放」独立 toggle：开启后，播完一首自动从队列随机挑下一首；
	 * 不再属于循环模式。APlayerPlayer 的 'ended' 处理会读取这个状态。
	 */
	const toggleShuffle = useCallback(() => {
		const next = !shuffleOn;
		setShuffleOn(next);
		requestShuffle(next);
	}, [shuffleOn]);

	const jumpTo = useCallback((index: number) => {
		void fetch('/api/player/jump', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index }),
		}).catch(() => {});
	}, []);

	const togglePlay = useCallback(() => {
		const endpoint = isPlaying ? '/api/player/pause' : '/api/player/resume';
		void fetch(endpoint, { method: 'POST' }).catch(() => {});
	}, [isPlaying]);

	const next = useCallback(() => {
		void fetch('/api/player/next', { method: 'POST' }).catch(() => {});
	}, []);

	const prev = useCallback(() => {
		// 播放超过 3s：先回到开头；否则上一首（队首循环到末尾）
		if (posRef.current > 3) {
			requestSeek(0);
			return;
		}
		if (snap.queue.length === 0) return;
		if (snap.queueIndex <= 0) {
			jumpTo(snap.queue.length - 1);
		} else {
			jumpTo(snap.queueIndex - 1);
		}
	}, [snap.queue.length, snap.queueIndex, jumpTo]);

	const toggleLike = useCallback(() => {
		if (!track) return;
		setLiked(toggleFavorite(track.id).includes(track.id));
	}, [track]);

	// ── 进度条拖动（Pointer Events，capture 保证移出条外仍跟踪） ──
	// 关键：几何计算一律基于被交互元素自身（e.currentTarget），不用共享 ref。
	// 页面里存在两条进度条（移动顶部细线 + 桌面三栏），共用同一个 ref 时
	// React 只会绑定到后挂载的那个，窄屏下它 display:none 导致 rect.width=0，
	// 比值成为 Infinity 被钳到 1 → 拖动直接跳到结尾。
	const seekByClientX = useCallback(
		(bar: HTMLDivElement, clientX: number) => {
			if (duration <= 0) return;
			const rect = bar.getBoundingClientRect();
			if (rect.width <= 0) return;
			const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
			const t = ratio * duration;
			posRef.current = t;
			setPosition(t);
			requestSeek(t);
		},
		[duration],
	);

	const onSeekPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (duration <= 0) return;
		e.preventDefault();
		dragTargetRef.current = 'seek';
		setDragging(true);
		e.currentTarget.setPointerCapture(e.pointerId);
		seekByClientX(e.currentTarget, e.clientX);
	};

	const onSeekPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (dragTargetRef.current !== 'seek') return;
		seekByClientX(e.currentTarget, e.clientX);
	};

	const endDrag = () => {
		dragTargetRef.current = null;
		setDragging(false);
	};

	// ── 音量拖动 ──
	const setVolumeByClientX = useCallback((clientX: number) => {
		const bar = volBarRef.current;
		if (!bar) return;
		const rect = bar.getBoundingClientRect();
		const v = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		setVolume(v);
		saveVolume(v);
		requestVolume(v);
	}, []);

	const onVolPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		dragTargetRef.current = 'volume';
		volBarRef.current?.setPointerCapture(e.pointerId);
		setVolumeByClientX(e.clientX);
	};

	const onVolPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (dragTargetRef.current !== 'volume') return;
		setVolumeByClientX(e.clientX);
	};

	const progress = duration > 0 ? Math.min(1, position / duration) : 0;
	const coverChar = track ? (track.title.trim()[0] ?? '♪') : '♪';

	return (
		<footer className="glass relative shrink-0 border-t border-border">
			{/* 移动端：顶部细进度线（可拖） */}
			<div
				onPointerDown={onSeekPointerDown}
				onPointerMove={onSeekPointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				className="absolute inset-x-0 top-0 h-[3px] cursor-pointer md:hidden"
				role="slider"
				aria-label="播放进度"
				aria-valuemin={0}
				aria-valuemax={Math.round(duration)}
				aria-valuenow={Math.round(position)}
			>
				<div className="h-full bg-surface-2">
					<div
						className="h-full bg-brand transition-[width] duration-150"
						style={{ width: `${progress * 100}%` }}
					/>
				</div>
			</div>

			<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 md:grid-cols-[minmax(170px,1fr)_minmax(300px,2fr)_minmax(190px,1fr)] md:gap-4 md:px-5 md:py-2.5">
				{/* ── 左：封面 + 曲目信息 + 收藏 ── */}
				<div className="flex min-w-0 items-center gap-2.5 md:gap-3">
					<div
						className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-brand-3 text-sm font-bold text-white shadow-sm md:h-11 md:w-11 ${isPlaying ? 'animate-pulse' : ''}`}
						aria-hidden
					>
						{coverChar}
					</div>
					<div className="min-w-0 flex-1">
						<div className="truncate text-xs font-semibold md:text-sm" title={track?.title}>
							{track ? track.title : '还没有在播放'}
						</div>
						<div className="truncate text-[10px] text-muted md:text-xs" title={track?.artist}>
							{track ? track.artist : '对助手说「播放 xxx」试试'}
						</div>
					</div>
					<button
						type="button"
						onClick={toggleLike}
						aria-label={liked ? '取消收藏' : '收藏'}
						aria-pressed={liked}
						className={`lift shrink-0 rounded-full p-1.5 text-sm transition ${liked ? 'text-brand' : 'text-muted hover:text-foreground'}`}
					>
						{liked ? <FavOnIcon size={18} /> : <FavIcon size={18} />}
					</button>
				</div>

				{/* ── 中（md+）：传输控制 + 可拖进度，单行排布更紧凑 ── */}
				<div className="hidden min-w-0 items-center gap-1.5 md:flex">
					<div className="flex shrink-0 items-center gap-1">
						<button
							type="button"
							onClick={prev}
							aria-label="上一首"
							className="flex h-9 w-9 items-center justify-center rounded-full text-foreground/75 transition hover:bg-surface-2 hover:text-foreground active:scale-95"
						>
							<PrevIcon size={18} />
						</button>
						<button
							type="button"
							onClick={togglePlay}
							aria-label={isPlaying ? '暂停' : '播放'}
							className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-white shadow-sm transition hover:bg-brand-strong active:scale-95"
						>
							{isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
						</button>
						<button
							type="button"
							onClick={next}
							aria-label="下一首"
							className="flex h-9 w-9 items-center justify-center rounded-full text-foreground/75 transition hover:bg-surface-2 hover:text-foreground active:scale-95"
						>
							<NextIcon size={18} />
						</button>
					</div>
					<div className="flex min-w-0 flex-1 items-center gap-2.5">
						<span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-muted">{fmtTime(position)}</span>
						<div
							onPointerDown={onSeekPointerDown}
							onPointerMove={onSeekPointerMove}
							onPointerUp={endDrag}
							onPointerCancel={endDrag}
							className="group relative h-4 min-w-0 flex-1 cursor-pointer"
							role="slider"
							aria-label="播放进度"
							aria-valuemin={0}
							aria-valuemax={Math.round(duration)}
							aria-valuenow={Math.round(position)}
						>
							<div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-border">
								<div
									className="h-full rounded-full bg-gradient-to-r from-brand to-brand-3 transition-[width] duration-150"
									style={{ width: `${progress * 100}%` }}
								/>
							</div>
							<div
								className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand bg-background shadow-sm transition-transform ${dragging ? 'scale-110' : 'scale-0 group-hover:scale-100'}`}
								style={{ left: `${progress * 100}%` }}
							/>
						</div>
						<span className="w-10 shrink-0 text-[10px] tabular-nums text-muted">{fmtTime(duration)}</span>
					</div>
				</div>

				{/* ── 移动端传输控制（<md 显示，与左区同行） ── */}
			<div className="flex items-center gap-1 md:hidden">
				<button
					type="button"
					onClick={cycleMode}
					aria-label={`播放模式：${PLAYBACK_MODES.find((m) => m.value === mode)?.zh ?? '顺序'}（点击切换）`}
					title="播放模式"
					className="flex h-8 w-10 flex-col items-center justify-center rounded-full text-foreground/60 transition active:scale-95"
				>
					{MODE_ICON[mode]({ size: 14, className: '' })}
					<span className="text-[9px] font-bold leading-none mt-0.5">
						{PLAYBACK_MODES.find((m) => m.value === mode)?.zh ?? '顺序'}
					</span>
				</button>
				<button
					type="button"
					onClick={toggleShuffle}
					aria-label={shuffleOn ? '关闭随机播放' : '开启随机播放'}
					aria-pressed={shuffleOn}
					title="切歌时随机选下一首"
					className={`flex h-8 w-8 items-center justify-center rounded-full transition active:scale-95 ${shuffleOn ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-foreground'}`}
				>
					<ShuffleIcon size={14} />
				</button>
				<button
					type="button"
					onClick={prev}
					aria-label="上一首"
					className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/75 transition active:scale-95"
				>
					<PrevIcon size={14} />
				</button>
					<button
						type="button"
						onClick={togglePlay}
						aria-label={isPlaying ? '暂停' : '播放'}
						className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-white shadow-sm transition active:scale-95"
					>
						{isPlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
					</button>
					<button
						type="button"
						onClick={next}
						aria-label="下一首"
						className="flex h-8 w-8 items-center justify-center rounded-full text-foreground/75 transition active:scale-95"
					>
						<NextIcon size={14} />
					</button>
				</div>

			{/* ── 右（md+）：模式（md~lg 补位，lg+ 由右栏胶囊组承担）+ 队列 + 音量 ── */}
			<div className="hidden items-center justify-end gap-3 md:flex">
				<button
					type="button"
					onClick={cycleMode}
					aria-label={`播放模式：${PLAYBACK_MODES.find((m) => m.value === mode)?.zh ?? '顺序'}（点击切换）`}
					title="播放模式"
					className="hidden h-9 w-14 flex-col items-center justify-center gap-0.5 rounded-full border border-border text-foreground/65 transition hover:border-brand/40 hover:text-foreground active:scale-95 md:flex lg:hidden"
				>
					{MODE_ICON[mode]({ size: 14, className: '' })}
					<span className="text-[9px] font-bold leading-none">
						{PLAYBACK_MODES.find((m) => m.value === mode)?.zh ?? '顺序'}
					</span>
				</button>
				<button
					type="button"
					onClick={toggleShuffle}
					aria-label={shuffleOn ? '关闭随机播放' : '开启随机播放'}
					aria-pressed={shuffleOn}
					title="切歌时随机选下一首"
					className={`hidden h-9 w-9 items-center justify-center rounded-full transition active:scale-95 md:flex lg:hidden ${shuffleOn ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-foreground'}`}
				>
					<ShuffleIcon size={14} />
				</button>
				<button
					type="button"
					onClick={onToggleQueue}
					aria-label="播放队列"
						aria-expanded={false}
						className="flex h-9 w-9 items-center justify-center rounded-full text-foreground/75 transition hover:bg-surface-2 hover:text-foreground active:scale-95"
					>
						<QueueIcon size={18} />
					</button>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => {
								const v = volume > 0 ? 0 : lastVolRef.current || 0.8;
								setVolume(v);
								saveVolume(v);
								requestVolume(v);
							}}
							aria-label={volume > 0 ? '静音' : '取消静音'}
							className="text-muted transition hover:text-foreground"
						>
							{volume > 0 ? (
								<VolumeIcon size={15} />
							) : (
								<MuteIcon size={15} />
							)}
						</button>
						<div
							ref={volBarRef}
							onPointerDown={onVolPointerDown}
							onPointerMove={onVolPointerMove}
							onPointerUp={endDrag}
							onPointerCancel={endDrag}
							className="group relative h-4 w-24 cursor-pointer"
							role="slider"
							aria-label="音量"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(volume * 100)}
						>
							<div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-border">
								<div className="h-full rounded-full bg-brand" style={{ width: `${volume * 100}%` }} />
							</div>
							<div
								className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand bg-background transition-transform group-hover:scale-110"
								style={{ left: `${volume * 100}%` }}
							/>
						</div>
					</div>
				</div>
			</div>
		</footer>
	);
}
