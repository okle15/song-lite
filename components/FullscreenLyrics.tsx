/**
 * FullscreenLyrics — 全屏歌词沉浸页。
 *
 * 复用 useLyrics 共享 hook（解析 / 高亮 / seek 逻辑与内嵌面板完全一致，零重复），
 * 只是换了一套更适合「沉浸」的视觉：大字号歌词、当前行品牌色高亮放大、两侧行渐隐、
 * 背景柔光，底栏带可点击进度条与播控。
 *
 * 打开方式：歌词面板右上角的「⤢」按钮，或快捷键 F（由 GlobalHotkeys 派发 lyrics-fullscreen）。
 * 关闭：右上角 × 或 Esc。打开时锁定 body 滚动。
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { useLyrics, useScrollActiveIntoView } from './useLyrics';
import { usePlayerSnapshot } from './PlayerProvider';
import {
	PLAYER_EVENTS,
	fmtTime,
	requestSeek,
	toggleFavorite,
} from './player-events';
import { useEscapeToClose } from './use-escape-to-close';
import { gradientFor } from '@/components/cover';
import {
	CloseIcon,
	FavIcon,
	FavOnIcon,
	NextIcon,
	PauseIcon,
	PlayIcon,
	PrevIcon,
} from './icons';

export function FullscreenLyrics({ open, onClose }: { open: boolean; onClose: () => void }) {
	const snap = usePlayerSnapshot();
	const { track, lines, activeIdx, loading, seekTo } = useLyrics();
	const listRef = useRef<HTMLDivElement>(null);
	useScrollActiveIntoView(listRef, activeIdx);

	const [duration, setDuration] = useState(0);
	const [fav, setFav] = useState(false);
	const dialogRef = useRef<HTMLDivElement>(null);

	// 无障碍：打开时把焦点移入对话框、Tab 锁在内部、关闭后焦点回弹到触发元素。
	// 否则键盘/读屏用户打开后焦点仍停在被遮罩盖住的按钮上，Tab 会溜进背景层。
	useEffect(() => {
		if (!open) return;
		const prevFocus = document.activeElement as HTMLElement | null;
		// 等渲染完成后聚焦对话框本身（首个可聚焦元素）
		const id = window.setTimeout(() => {
			const dlg = dialogRef.current;
			if (dlg) (dlg.querySelector<HTMLElement>('button, [href], input') ?? dlg).focus();
		}, 0);
		return () => {
			window.clearTimeout(id);
			if (prevFocus && prevFocus.isConnected) prevFocus.focus();
		};
	}, [open]);

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'Tab' || !dialogRef.current) return;
		const focusables = Array.from(
			dialogRef.current.querySelectorAll<HTMLElement>(
				'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
			),
		);
		if (focusables.length === 0) {
			e.preventDefault();
			return;
		}
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && active === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	};

	// 时长来自 APlayerPlayer 广播的 player-duration 事件（快照里没有 duration）
	useEffect(() => {
		const onDur = (e: Event) => {
			const d = (e as CustomEvent<number>).detail;
			if (typeof d === 'number') setDuration(d);
		};
		window.addEventListener(PLAYER_EVENTS.duration, onDur);
		return () => window.removeEventListener(PLAYER_EVENTS.duration, onDur);
	}, []);

	// Esc 关闭
	useEscapeToClose(onClose, open);

	// 打开时锁定 body 滚动
	useEffect(() => {
		if (!open) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = prev;
		};
	}, [open]);

	if (!open) return null;

	const pos = snap.positionSec;
	const progress = duration > 0 ? Math.min(1, pos / duration) : 0;
	const isPlaying = snap.state === 'playing';

	const post = (url: string) => fetch(url, { method: 'POST' }).catch(() => {});

	const seekByRatio = (clientX: number, target: HTMLElement) => {
		if (duration <= 0) return;
		const rect = target.getBoundingClientRect();
		const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		requestSeek(ratio * duration);
	};

	const toggleFav = () => {
		if (!track) return;
		setFav((v) => !v);
		toggleFavorite(track.id);
	};

	const btn =
		'flex h-11 w-11 items-center justify-center rounded-full text-foreground/80 transition hover:bg-white/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand';
	const primary = 'flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-lg transition hover:scale-105 active:scale-95';

	return (
		<div
			ref={dialogRef}
			role="dialog"
			aria-modal="true"
			aria-label="全屏歌词"
			tabIndex={-1}
			onKeyDown={onKeyDown}
			className="fixed inset-0 z-[80] flex flex-col overflow-hidden bg-[#0c0a14] text-white outline-none"
		>
			{/* 背景柔光：随当前曲目的封面渐变变色（与曲库卡片同源），更沉浸 */}
			<div
				className={`pointer-events-none absolute -top-24 left-1/4 h-96 w-96 -translate-x-1/2 rounded-full bg-gradient-to-br opacity-50 blur-[120px] ${gradientFor(track?.id ?? '')}`}
			/>
			<div
				className={`pointer-events-none absolute -bottom-24 right-1/4 h-96 w-96 rounded-full bg-gradient-to-br opacity-40 blur-[120px] ${gradientFor(track?.id ?? '')}`}
			/>

			{/* 顶栏：右上角关闭 */}
			<header className="relative z-10 flex items-center justify-end p-4 sm:p-6">
				<button type="button" onClick={onClose} aria-label="关闭全屏歌词" className={btn}>
					<CloseIcon size={24} />
				</button>
			</header>

			{/* 歌词区 */}
			<div className="relative z-10 flex min-h-0 flex-1 flex-col">
				{track && (
					<div className="px-6 pb-2 text-center sm:px-10">
						<h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{track.title}</h2>
						<p className="mt-1 text-sm text-white/55">{track.artist}</p>
					</div>
				)}

				{!track ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-2 text-white/50">
						<span className="text-3xl opacity-60">🎶</span>
						<p className="text-sm">播放一首歌，歌词会在这里沉浸展示</p>
					</div>
				) : loading ? (
					<div className="flex flex-1 items-center justify-center text-sm text-white/50">歌词加载中…</div>
				) : lines.length === 0 ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-2 text-white/50">
						<span className="text-2xl opacity-60">📝</span>
						<p className="text-sm">这首歌暂无歌词</p>
					</div>
				) : (
					<div
						ref={listRef}
						className="lyric-scroll scroll-area min-h-0 flex-1 space-y-3 px-6 py-16 text-center sm:px-16"
					>
						{lines.map((line, i) => {
							const diff = i - activeIdx;
							const isActive = i === activeIdx;
							const dist = Math.abs(diff);
							return (
								<button
									key={i}
									type="button"
									onClick={() => seekTo(line.time)}
									title={`跳转到 ${fmtTime(line.time)}`}
									className={`block w-full cursor-pointer break-words rounded-xl px-2 py-1 text-center transition-all duration-300 ${
										isActive
											? 'text-2xl font-bold text-brand sm:text-3xl'
											: dist === 1
												? 'text-base text-white/70 hover:text-white'
												: 'text-base text-white/35 hover:text-white/70'
									}`}
								>
									{line.text || '♪'}
								</button>
							);
						})}
					</div>
				)}
			</div>

			{/* 底栏：进度 + 播控 */}
			<footer className="relative z-10 flex flex-col gap-3 px-6 pb-6 pt-2 sm:px-10">
				<div
					role="slider"
					aria-label="播放进度"
					aria-valuemin={0}
					aria-valuemax={Math.round(duration)}
					aria-valuenow={Math.round(pos)}
					className="group relative h-5 cursor-pointer"
					onClick={(e) => seekByRatio(e.clientX, e.currentTarget)}
				>
					<div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-white/15">
						<div
							className="h-full rounded-full bg-gradient-to-r from-brand to-brand-2"
							style={{ width: `${progress * 100}%` }}
						/>
					</div>
					<div
						className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover:opacity-100"
						style={{ left: `${progress * 100}%` }}
					/>
				</div>

				<div className="flex items-center justify-center gap-5">
					<button type="button" onClick={() => post('/api/player/next')} aria-label="上一首" className={btn}>
						<PrevIcon size={24} />
					</button>
					<button
						type="button"
						onClick={() => post(isPlaying ? '/api/player/pause' : '/api/player/resume')}
						aria-label={isPlaying ? '暂停' : '播放'}
						className={primary}
					>
						{isPlaying ? <PauseIcon size={28} /> : <PlayIcon size={28} />}
					</button>
					<button type="button" onClick={() => post('/api/player/next')} aria-label="下一首" className={btn}>
						<NextIcon size={24} />
					</button>
					<button
						type="button"
						onClick={toggleFav}
						aria-label={fav ? '取消收藏' : '收藏'}
						aria-pressed={fav}
						className={`${btn} ${fav ? 'text-brand' : ''}`}
					>
						{fav ? <FavOnIcon size={24} /> : <FavIcon size={24} />}
					</button>
				</div>

				<div className="text-center text-xs tabular-nums text-white/45">
					{fmtTime(pos)} / {fmtTime(duration)}
				</div>
			</footer>
		</div>
	);
}
