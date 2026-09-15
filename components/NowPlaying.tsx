/**
 * NowPlaying — 「正在播放」英雄卡（桌面右栏）。
 *
 * 对齐 redesign-prototype.html：渐变大封面 + 辉光 + 音波动画 + eyebrow +
 * 可拖进度 + 随机/上一首/播放/下一首/循环 + 播放模式胶囊组（SEQ/RPT/ONE/SHF）。
 *
 * 数据流（零新增后端 API）：
 *  - 快照来自 PlayerProvider（SSE）；进度监听 'player-time' / 'player-duration'。
 *  - 拖动/点击进度 → requestSeek(sec) → APlayerPlayer 调 ap.seek。
 *  - 上一首 >3s 先回 0，否则 jump(queueIndex-1)（队首循环到末尾）。
 *  - 随机播放 = jump 到随机索引（排除当前）。
 *  - 播放模式 = requestMode 写 localStorage + 'player-mode' 事件；
 *    APlayerPlayer 在 'ended' 时按模式决定自动连播行为。
 */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerSnapshot } from './PlayerProvider';
import {
	PLAYBACK_MODES,
	PLAYER_EVENTS,
	fmtTime,
	loadMode,
	loadShuffle,
	requestSeek,
	requestMode,
	requestShuffle,
	type PlaybackMode,
} from './player-events';
import { gradientFor } from '@/components/cover';
import {
	ListLoopIcon,
	NextIcon,
	OneLoopIcon,
	PauseIcon,
	PlayIcon,
	PrevIcon,
	SeqIcon,
	ShuffleIcon,
} from './icons';

const MODE_NOWPLAYING_ICON = {
	seq: SeqIcon,
	rpt: ListLoopIcon,
	one: OneLoopIcon,
} as const;

export function NowPlaying() {
	const snap = usePlayerSnapshot();
	const track = snap.currentTrack;
	// 封面配色与曲库卡片 / 全屏歌词同源：同一首歌三处颜色恒定（素材感知封面）
	const coverCls = track ? gradientFor(track.id) : 'from-brand to-brand-3';
	const isPlaying = snap.state === 'playing';

	const [position, setPosition] = useState(0);
	const [duration, setDuration] = useState(0);
	const [mode, setMode] = useState<PlaybackMode>('seq');
	const [shuffleOn, setShuffleOn] = useState(false);
	const [dragging, setDragging] = useState(false);

	const posRef = useRef(0);
	const barRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef(false);

	// 监听时间/时长广播（监听只注册一次）
	useEffect(() => {
		const onTime = (e: Event) => {
			const t = (e as CustomEvent<number>).detail;
			if (typeof t !== 'number') return;
			posRef.current = t;
			if (!dragRef.current) setPosition(t);
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

	// 切歌重置进度
	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		posRef.current = 0;
		setPosition(0);
		setDuration(0);
	}, [track?.id]);
	/* eslint-enable react-hooks/set-state-in-effect */

	// 挂载读本地播放模式 / 随机 toggle，并监听变化
	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		setMode(loadMode());
		setShuffleOn(loadShuffle());
		const onMode = (e: Event) => {
			const m = (e as CustomEvent<PlaybackMode>).detail;
			if (m === 'seq' || m === 'rpt' || m === 'one') setMode(m);
		};
		const onShuffle = (e: Event) => {
			const s = (e as CustomEvent<boolean>).detail;
			if (typeof s === 'boolean') setShuffleOn(s);
		};
		window.addEventListener(PLAYER_EVENTS.mode, onMode);
		window.addEventListener(PLAYER_EVENTS.shuffle, onShuffle);
		return () => {
			window.removeEventListener(PLAYER_EVENTS.mode, onMode);
			window.removeEventListener(PLAYER_EVENTS.shuffle, onShuffle);
		};
	}, []);
	/* eslint-enable react-hooks/set-state-in-effect */

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
		if (posRef.current > 3) {
			requestSeek(0);
			return;
		}
		if (snap.queue.length === 0) return;
		if (snap.queueIndex <= 0) jumpTo(snap.queue.length - 1);
		else jumpTo(snap.queueIndex - 1);
	}, [snap.queue.length, snap.queueIndex, jumpTo]);

	// ── 进度拖动 ──
	const seekByClientX = useCallback(
		(clientX: number) => {
			const bar = barRef.current;
			if (!bar || duration <= 0) return;
			const rect = bar.getBoundingClientRect();
			const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
			const t = ratio * duration;
			posRef.current = t;
			setPosition(t);
			requestSeek(t);
		},
		[duration],
	);

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (duration <= 0) return;
		e.preventDefault();
		dragRef.current = true;
		setDragging(true);
		barRef.current?.setPointerCapture(e.pointerId);
		seekByClientX(e.clientX);
	};
	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (dragRef.current) seekByClientX(e.clientX);
	};
	const endDrag = () => {
		dragRef.current = false;
		setDragging(false);
	};

	const progress = duration > 0 ? Math.min(1, position / duration) : 0;
	const coverChar = track ? (track.title.trim()[0] ?? '♪') : '♪';

	if (!track) {
		return (
			<div className="relative flex h-full min-h-[120px] items-center justify-center overflow-hidden p-5">
				<div className="pointer-events-none absolute -top-16 left-1/2 h-40 w-64 -translate-x-1/2 rounded-full bg-brand/20 blur-3xl" />
				<div className="relative flex items-center gap-4">
					<div className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${coverCls} text-2xl text-white shadow-md`}>
						♪
					</div>
					<div className="min-w-0">
						<div className="truncate text-sm font-semibold">还没有在播放</div>
						<div className="truncate text-xs text-muted">对助手说「播放 xxx」或去队列里挑一首</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		// min-h 保证封面 + 进度条 + 传输控制 + 模式胶囊在面板被拖小时仍完整，
		// 超出部分由 PaneShell 的内容区滚动兜住，而不是被 overflow-hidden 裁掉。
		<div className="relative h-full min-h-[320px] overflow-hidden text-center">
			{/* 顶部辉光：播放时增强 */}
			<div
				className={`pointer-events-none absolute -top-20 left-1/2 h-48 w-72 -translate-x-1/2 rounded-full bg-gradient-to-br ${coverCls} blur-3xl transition-opacity duration-500 ${isPlaying ? 'opacity-30' : 'opacity-10'}`}
				aria-hidden
			/>

			<div className="relative p-5">
				{/* 渐变大封面 + 旋转黑胶角标 */}
				<div className="relative mx-auto w-fit">
					<div
						className={`flex h-32 w-32 items-center justify-center rounded-3xl bg-gradient-to-br ${coverCls} text-5xl font-bold text-white transition-transform duration-500 ${isPlaying ? 'shadow-[0_16px_40px_-12px] shadow-brand/60' : 'scale-95 shadow-md'}`}
						aria-hidden
					>
						{coverChar}
					</div>
					<div
						className={`absolute -bottom-1.5 -right-1.5 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-3 text-sm shadow-sm ${isPlaying ? 'animate-[spin_3s_linear_infinite]' : ''}`}
						aria-hidden
					>
						💿
					</div>
				</div>

				<p className="mt-3 text-[10px] tracking-[0.3em] text-muted">正在播放</p>
				<h3 className="mt-1 truncate text-lg font-bold" title={track.title}>
					{track.title}
				</h3>
				<p className="mt-0.5 truncate text-xs text-muted" title={`${track.artist} · ${track.album}`}>
					{track.artist}
					{track.album ? <span className="opacity-70"> · {track.album}</span> : null}
				</p>

				{/* 可拖进度条 */}
				<div className="mt-4 px-1">
					<div
						ref={barRef}
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={endDrag}
						onPointerCancel={endDrag}
						className="group relative h-4 cursor-pointer"
						role="slider"
						aria-label="播放进度"
						aria-valuemin={0}
						aria-valuemax={Math.round(duration)}
						aria-valuenow={Math.round(position)}
					>
						<div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-border">
							<div
								className="h-full rounded-full bg-gradient-to-r from-brand to-brand-3"
								style={{ width: `${progress * 100}%` }}
							/>
						</div>
						<div
							className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand bg-background shadow-sm transition-transform ${dragging ? 'scale-110' : 'scale-0 group-hover:scale-100'}`}
							style={{ left: `${progress * 100}%` }}
						/>
					</div>
					<div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted">
						<span>{fmtTime(position)}</span>
						<span>{fmtTime(duration)}</span>
					</div>
				</div>

				{/* 传输控制：随机 toggle / 上一首 / 播放 / 下一首 */}
				<div className="mt-3 flex items-center justify-center gap-3">
					<button
						type="button"
						onClick={() => requestShuffle(!shuffleOn)}
						aria-label={shuffleOn ? '关闭随机播放' : '开启随机播放'}
						aria-pressed={shuffleOn}
						className={`flex h-9 w-9 items-center justify-center rounded-full transition active:scale-95 ${shuffleOn ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-foreground'}`}
					>
						<ShuffleIcon size={15} />
					</button>
					<button
						type="button"
						onClick={prev}
						aria-label="上一首"
						className="flex h-9 w-9 items-center justify-center rounded-full text-foreground/75 transition hover:bg-surface-2 active:scale-95"
					>
						<PrevIcon size={18} />
					</button>
					<button
						type="button"
						onClick={togglePlay}
						aria-label={isPlaying ? '暂停' : '播放'}
						className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-3 text-white shadow-lg shadow-brand/40 transition hover:brightness-105 active:scale-95"
					>
						{isPlaying ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
					</button>
					<button
						type="button"
						onClick={next}
						aria-label="下一首"
						className="flex h-9 w-9 items-center justify-center rounded-full text-foreground/75 transition hover:bg-surface-2 active:scale-95"
					>
						<NextIcon size={18} />
					</button>
				</div>

				{/* 音波动画（播放中律动） */}
				<div className="mt-3 flex h-5 items-end justify-center gap-[3px]" aria-hidden>
					{[8, 16, 11, 20, 7, 14, 9, 17].map((h, i) => (
						<i
							key={i}
							className={`w-[3px] origin-bottom rounded-sm bg-brand/80 ${isPlaying ? 'animate-[eq_1s_ease-in-out_infinite]' : 'opacity-40'}`}
							style={{ height: `${h}px`, animationDelay: `${i * 0.12}s` }}
						/>
					))}
				</div>

				{/* 播放模式胶囊组 */}
				<div className="mt-3 flex justify-center border-t border-border pt-3">
					<div className="flex gap-1 rounded-full border border-border bg-surface-2 p-1" role="radiogroup" aria-label="播放模式">
						{PLAYBACK_MODES.map((m) => {
							const Icon = MODE_NOWPLAYING_ICON[m.value];
							return (
								<button
									key={m.value}
									type="button"
									role="radio"
									aria-checked={mode === m.value}
									onClick={() => requestMode(m.value)}
									className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${mode === m.value ? 'bg-brand text-white shadow-sm shadow-brand/40' : 'text-muted hover:text-foreground'}`}
								>
									<Icon size={12} />
									<span>{m.zh}</span>
								</button>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
}
