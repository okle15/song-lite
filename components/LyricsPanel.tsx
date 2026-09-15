/**
 * LyricsPanel — 大歌词面板，显示在左侧面板的「歌词」卡里。
 *
 * 歌词的「数据 + 高亮索引 + 滚动」逻辑全部来自 useLyrics / useScrollActiveIntoView
 * （components/useLyrics.ts），本组件只负责渲染与视觉层次（焦点渐变 + 三级淡化）。
 *
 * 数据流：
 *  - SSE 推送当前曲目 → useLyrics 自动 fetch /api/library/lyrics 并解析 LRC
 *  - APlayer timeupdate → dispatch 'player-time' → useLyrics 同步高亮行
 *  - 点击歌词行 → dispatch 'player-seek' → APlayer 监听后 seek
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { useLyrics, useScrollActiveIntoView } from './useLyrics';
import { PLAYER_EVENTS, fmtTime } from './player-events';
import { FullscreenLyrics } from './FullscreenLyrics';
import { FullscreenIcon } from './icons';

export function LyricsPanel() {
	// 数据 / 高亮索引 / seek 全部由共享 hook 提供（全屏沉浸页会复用同一份）
	const { track, lines, activeIdx, loading, seekTo } = useLyrics();
	const listRef = useRef<HTMLDivElement>(null);
	const [fullscreen, setFullscreen] = useState(false);
	// 快捷键 F 唤起全屏沉浸页（由 GlobalHotkeys 派发）
	useEffect(() => {
		const onToggle = () => setFullscreen((v) => !v);
		window.addEventListener(PLAYER_EVENTS.lyricsFullscreen, onToggle);
		return () => window.removeEventListener(PLAYER_EVENTS.lyricsFullscreen, onToggle);
	}, []);
	// 滚动行为交给共享 hook：用容器 scrollTo 而非 scrollIntoView，
	// 避免「歌词一滚，整页跟着跑」。
	useScrollActiveIntoView(listRef, activeIdx);

	// 展开按钮 + 全屏沉浸页始终可用（无曲目时也能打开看空态），
	// 因此放在最外层，各分支只决定卡片主体内容。
	return (
		<div data-lyrics-panel className="relative flex h-full flex-col">
			<button
				type="button"
				onClick={() => setFullscreen(true)}
				aria-label="全屏歌词沉浸"
				title="全屏歌词沉浸（快捷键 F）"
				className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2/80 text-muted backdrop-blur transition hover:bg-surface-2 hover:text-foreground"
			>
				<FullscreenIcon size={15} />
			</button>

			{!track ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
					<span className="text-3xl opacity-60">🎶</span>
					<p className="text-sm">暂无播放曲目</p>
					<p className="max-w-[16rem] text-center text-xs text-muted/70">
						点击右上角「曲库」挑一首，或对助手说「播放 xxx」，歌词会在这里同步滚动
					</p>
				</div>
			) : loading ? (
				<div className="flex flex-1 items-center justify-center text-sm text-muted">歌词加载中...</div>
			) : lines.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
					<span className="text-2xl opacity-60">📝</span>
					<p className="text-sm">这首歌暂无歌词</p>
				</div>
			) : (
				<div
					ref={listRef}
					className="lyric-scroll scroll-area flex-1 overflow-y-auto px-3 py-6"
				>
					<div className="space-y-0.5">
						{lines.map((line, i) => {
							// 距当前行越远越淡，形成焦点层级（当前行 → 邻行 → 远行）
							const diff = Math.abs(i - activeIdx);
							const isActive = i === activeIdx;
							return (
								<button
									key={i}
									type="button"
									onClick={() => seekTo(line.time)}
									title={`跳转到 ${fmtTime(line.time)}`}
									className={`relative block w-full cursor-pointer rounded-lg py-2 pl-4 pr-3 text-left leading-relaxed transition-all duration-300 ${
										isActive
											? 'bg-brand-soft/70 text-[17px] font-bold text-brand'
											: diff === 1
												? 'text-sm text-foreground/75 hover:bg-surface-2'
												: 'text-sm text-muted/60 hover:bg-surface-2 hover:text-foreground'
									}`}
								>
									{isActive && (
										<span
											aria-hidden="true"
											className="absolute left-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-gradient-to-b from-brand to-brand-2"
										/>
									)}
									{line.text || '♪'}
								</button>
							);
						})}
					</div>
				</div>
			)}

			<FullscreenLyrics open={fullscreen} onClose={() => setFullscreen(false)} />
		</div>
	);
}
