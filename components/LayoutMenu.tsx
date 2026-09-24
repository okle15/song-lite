/**
 * LayoutMenu — 顶栏「卡片」按钮 + 布局管理弹层。
 *
 * 「卡片可以隐藏」就必须有找回来的地方，否则一旦隐藏就永久失去，
 * 只能去清 localStorage——这个入口是隐藏功能的必要配套。
 *
 * 这里列出**全部**卡片（`ALL_CARD_IDS`）并支持直接开关显隐（隐藏 → 恢复），
 * 另外提供「重置为默认布局」兜底。
 *
 * ⚠️ 这张表也是**加新卡时的恢复入口**：老用户的 localStorage 里没有新卡，
 * `sanitizeLayout` 会把它补进 `hidden`，于是这里显示为「已隐藏 · 恢复」。
 * 那条路径曾经是断的（`restoreCard` 的守卫会静默吞掉它），见 `panel-layout.ts`。
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { useLayout } from './LayoutProvider';
import { ALL_CARD_IDS, CARD_LABELS, type CardId } from '@/components/panel-layout';
import { useEscapeToClose } from './use-escape-to-close';
import { CheckIcon, GridIcon } from './icons';

const CARD_HINTS: Record<CardId, string> = {
	chat: '用说话的方式放歌、切歌',
	memory: '它记住了你什么，可逐条忘掉',
	nowplaying: '大封面、进度与播放控制',
	queue: '当前播放队列，点击切歌',
	lyrics: '当前曲目歌词，随播放滚动',
	tasks: '排过的定时任务，可撤回',
};

export function LayoutMenu() {
	const { layout, hideCard, restoreCard, resetLayout } = useLayout();
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	// Esc 关闭
	useEscapeToClose(() => setOpen(false), open);

	// 点击外部关闭（pointerdown 而非 click：避免与按钮自身的 click 抢时序）
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener('pointerdown', onDown);
		return () => document.removeEventListener('pointerdown', onDown);
	}, [open]);

	// 当前布局里可见的卡片（用于判断每张卡是「显示」还是「已隐藏」）
	const visible = new Set<CardId>();
	for (const col of layout.columns) {
		for (const pane of col) for (const card of pane.cards) visible.add(card);
	}
	const hiddenCount = ALL_CARD_IDS.length - visible.size;

	const toggle = (card: CardId) => {
		if (visible.has(card)) hideCard(card);
		else restoreCard(card);
	};

	return (
		<div className="relative" ref={wrapRef}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-label="卡片布局管理"
				aria-expanded={open}
				title="显示 / 隐藏卡片，重置布局"
				className="lift flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
			>
				<GridIcon size={15} />
				<span className="hidden lg:inline">卡片</span>
				{hiddenCount > 0 && (
					<span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[9px] font-bold text-white">
						{hiddenCount}
					</span>
				)}
			</button>

			{open && (
				<div className="card scroll-area animate-fade-up absolute right-0 top-12 z-[60] max-h-[70vh] w-72 overflow-y-auto p-3 shadow-xl">
					<div className="mb-1 flex items-center justify-between">
						<span className="text-sm font-semibold">卡片布局</span>
						<button
							type="button"
							onClick={resetLayout}
							className="rounded-md px-1.5 py-0.5 text-[10px] text-muted transition hover:bg-surface-2 hover:text-foreground"
						>
							恢复默认
						</button>
					</div>
					<p className="mb-2 text-[10px] leading-relaxed text-muted">
						点卡片可显示 / 隐藏；拖动卡片之间的分隔条调整大小；面板右上角 ⋯ 可合并成标签页或拆分。
					</p>

					<ul className="space-y-1">
						{ALL_CARD_IDS.map((id) => {
							const on = visible.has(id);
							return (
								<li key={id}>
									<button
										type="button"
										onClick={() => toggle(id)}
										aria-pressed={on}
										className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-surface-2"
									>
										<span
											className={`flex h-4.5 w-4 shrink-0 items-center justify-center rounded-md border transition ${
												on ? 'border-brand bg-brand text-white' : 'border-border bg-transparent text-transparent'
											}`}
										>
											<CheckIcon size={12} strokeWidth={3.5} />
										</span>
										<span className="min-w-0">
											<span className={`block text-xs font-medium ${on ? '' : 'text-muted/60'}`}>
												{CARD_LABELS[id]}
											</span>
											<span className="block truncate text-[10px] text-muted/70">{CARD_HINTS[id]}</span>
										</span>
										<span className="ml-auto shrink-0 text-[10px] text-muted/70">
											{on ? '隐藏' : '恢复'}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</div>
	);
}
