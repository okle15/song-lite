/**
 * LibraryGrid — 曲库网格视图（顶栏入口 + 大抽屉）。
 *
 * 数据源 GET /api/library/search?q=，服务端搜索 + 250ms debounce（曲库变大后也成立，
 * 不做前端全量过滤）。点击卡片 POST /api/player/play { trackId }，服务端会
 * ensureQueue 后切换曲目，SSE 推送回来驱动播放器，前端无需手动维护队列。
 *
 * 设计要点：
 *  - 封面用「标题首字 + 渐变」而非真实图：库内音频没有封面资源，按 id 稳定 hash
 *    到一组渐变，保证同一首歌每次进来颜色一致（不稳定的话会显得像 bug）。
 *  - hover 才浮出播放按钮（FAB），静态时不遮挡封面。
 *  - 当前播放的卡片常驻高亮 + 音波，让用户知道"正在播这首"。
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { usePlayerSnapshot } from './PlayerProvider';
import { fmtTime } from './player-events';
import { useEscapeToClose } from './use-escape-to-close';
import { gradientFor } from '@/components/cover';
import { CloseIcon, LibraryIcon, PlayIcon, SearchIcon } from './icons';

type Song = {
	id: string;
	title: string;
	artist: string;
	album?: string;
	durationSec?: number;
};

/** 播放中的均衡器动画（复用 globals.css 的 eq keyframes）。 */
function EqBars() {
	return (
		<span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
			{[0, 1, 2].map((i) => (
				<span
					key={i}
					className="w-[2px] rounded-full bg-brand"
					style={{
						height: '100%',
						animation: 'eq 0.9s ease-in-out infinite',
						animationDelay: `${i * 0.15}s`,
					}}
				/>
			))}
		</span>
	);
}

export function LibraryGrid() {
	const snap = usePlayerSnapshot();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [songs, setSongs] = useState<Song[]>([]);
	const [loading, setLoading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// Esc 关闭（与聊天/队列/快捷键面板的 Esc 处理并存：同时打开时会被一起关掉）
	useEscapeToClose(() => setOpen(false), open);

	// 打开后自动聚焦搜索框（曲库第一动作就是找歌）
	useEffect(() => {
		if (!open) return;
		const t = setTimeout(() => inputRef.current?.focus(), 80);
		return () => clearTimeout(t);
	}, [open]);

	// 搜索：仅打开时请求，250ms debounce
	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		const timer = setTimeout(() => {
			fetch(`/api/library/search?q=${encodeURIComponent(query)}`)
				.then((res) => (res.ok ? res.json() : null))
				.then((json) => {
					if (cancelled) return;
					setSongs(json?.data?.songs ?? []);
					setLoading(false);
				})
				.catch(() => {
					if (!cancelled) setLoading(false);
				});
		}, 250);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query, open]);
	/* eslint-enable react-hooks/set-state-in-effect */

	const playSong = (id: string) => {
		void fetch('/api/player/play', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ trackId: id }),
		}).catch(() => {});
	};

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-label="曲库"
				aria-expanded={open}
				title="浏览全部曲目"
				className="lift flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
			>
				<LibraryIcon size={15} />
				<span className="hidden lg:inline">曲库</span>
			</button>

			{open && (
				<div className="fixed inset-0 z-[55] flex justify-center p-0 sm:items-center sm:p-6">
					<div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden="true" />

					<div
						role="dialog"
						aria-modal="true"
						aria-label="曲库"
						className="card animate-fade-up relative flex h-full w-full max-w-3xl flex-col overflow-hidden sm:h-[80vh]"
					>
						{/* 头部：搜索 + 关闭 */}
						<div className="flex items-center gap-2 border-b border-border px-4 py-3">
							<div className="relative flex-1">
								<span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
									<SearchIcon size={15} />
								</span>
								<input
									ref={inputRef}
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder="搜索歌名、歌手、专辑…"
									aria-label="搜索曲库"
									className="w-full rounded-full border border-border bg-surface-2 py-1.5 pl-9 pr-3 text-sm text-foreground outline-none transition placeholder:text-muted/70 focus:border-brand/50"
								/>
							</div>
							<span className="hidden shrink-0 text-xs tabular-nums text-muted sm:block">
								{songs.length} 首
							</span>
							<button
								type="button"
								onClick={() => setOpen(false)}
								aria-label="关闭曲库"
								className="shrink-0 rounded-lg p-1 text-muted transition hover:bg-surface-2 hover:text-foreground"
							>
								<CloseIcon size={18} />
							</button>
						</div>

						{/* 网格 */}
						<div className="scroll-area min-h-0 flex-1 overflow-y-auto p-4">
							{loading && songs.length === 0 ? (
								<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
									{[0, 1, 2, 3, 4, 5].map((i) => (
										<div key={i} className="animate-pulse">
											<div className="aspect-square rounded-xl bg-surface-2" />
											<div className="mt-2 h-3 w-3/4 rounded bg-surface-2" />
											<div className="mt-1 h-2.5 w-1/2 rounded bg-surface-2" />
										</div>
									))}
								</div>
							) : songs.length === 0 ? (
								<div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
									<span className="text-3xl opacity-60">🔍</span>
									<p className="text-sm">{query ? `没有找到「${query}」` : '曲库空空的'}</p>
								</div>
							) : (
								<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
									{songs.map((song) => {
										const isCurrent = snap.currentTrack?.id === song.id;
										return (
											<button
												key={song.id}
												type="button"
												onClick={() => playSong(song.id)}
												aria-label={`播放 ${song.title} - ${song.artist}`}
												aria-current={isCurrent ? 'true' : undefined}
												className={`group text-left transition ${isCurrent ? '' : 'hover:-translate-y-0.5'}`}
											>
												<div
													className={`relative aspect-square overflow-hidden rounded-xl bg-gradient-to-br ${gradientFor(song.id)} shadow-sm`}
												>
													{/* 首字封面 */}
													<span className="absolute inset-0 flex items-center justify-center font-display text-4xl text-white/90">
														{song.title.slice(0, 1)}
													</span>
													{/* hover 悬浮播放 FAB */}
													<span
														className={`absolute inset-0 flex items-center justify-center bg-black/35 transition-opacity ${
															isCurrent ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'
														}`}
													>
														<span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/95 text-brand shadow-lg transition group-hover:scale-105">
															<PlayIcon size={20} className="opacity-90" />
														</span>
													</span>
													{/* 当前播放：常驻标记 */}
													{isCurrent && (
														<span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/50 px-2 py-1 backdrop-blur-sm">
															<EqBars />
														</span>
													)}
												</div>
												<div className="mt-2 min-w-0">
													<div
														className={`truncate text-sm font-medium ${
															isCurrent ? 'text-brand' : 'text-foreground'
														}`}
													>
														{song.title}
													</div>
													<div className="truncate text-xs text-muted">
														{song.artist}
														{song.durationSec ? ` · ${fmtTime(song.durationSec)}` : ''}
													</div>
												</div>
											</button>
										);
									})}
								</div>
							)}
						</div>
					</div>
				</div>
			)}
		</>
	);
}
