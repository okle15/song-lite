/**
 * Music assistant home — 应用外壳。
 *
 * 布局（响应式）：
 *  - 顶部 glass header：品牌标识（Private Music Hub / 私人音乐平台）+ 操作区
 *    （曲库 / 背景主题 / 快捷键 / 卡片）。
 *  - 主区域：可自由拉伸、可合并、可隐藏的面板布局（LayoutProvider 管理）：
 *      · 两列结构，列之间与同列面板之间都有可拖动分隔条；
 *      · 每个面板可容纳多张卡片，多于一张时以标签页切换；
 *      · 面板标题栏 ⋯ 菜单支持与相邻面板合并 / 合并到任意面板 / 拆分 / 移到另一列 / 隐藏；
 *      · 按住标题栏左侧手柄拖到其它面板上可交换位置。
 *      布局持久化到 localStorage，刷新后保持。
 *  - 队列抽屉：底部滑出（点播放条队列按钮；移动端主入口）。
 *  - 底部：自绘 PlayerBar 统一播放条；APlayer 仅作 sr-only 音频引擎。
 *
 * 背景色由 ThemeProvider 在运行时写入 --bg* 变量，可在右上角「背景」切换 / 自定义。
 */
'use client';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { APlayerPlayer } from '@/components/APlayerPlayer';
import { GlobalHotkeys } from '@/components/GlobalHotkeys';
import { LayoutMenu } from '@/components/LayoutMenu';
import { LayoutProvider, useLayout } from '@/components/LayoutProvider';
import { LibraryGrid } from '@/components/LibraryGrid';
import { LyricsPanel } from '@/components/LyricsPanel';
import { NowPlaying } from '@/components/NowPlaying';
import { PaneShell, paneLabel } from '@/components/PaneShell';
import { PlayerBar } from '@/components/PlayerBar';
import { PlayerProvider, usePlayerSnapshot } from '@/components/PlayerProvider';
import { QueueList } from '@/components/QueueList';
import { ShortcutsPanel } from '@/components/ShortcutsPanel';
import { CloseIcon } from '@/components/icons';
import { SplitHandle } from '@/components/SplitHandle';
import { ThemePanel } from '@/components/ThemePanel';
import { ThemeProvider } from '@/components/ThemeProvider';
import { useEscapeToClose } from '@/components/use-escape-to-close';
import { hasModifier, isTypingTarget } from '@/components/keyboard';
import type { CardId, ColumnIndex } from '@/components/panel-layout';

/**
 * 主区可配置面板布局。
 * 必须挂在 PlayerProvider 内部才能读播放快照（歌词 / 队列标题需要曲目信息）。
 */
function MainPanels() {
	const {
		layout,
		resizePanes,
		resizeCols,
		resizeColumnFill,
		setActiveCard,
		mergeInto,
		splitOut,
		hideCard,
		movePane,
		movePaneToColumn,
	} = useLayout();
	const snap = usePlayerSnapshot();
	const track = snap.currentTrack;

	const rootRef = useRef<HTMLDivElement>(null);
	const col0Ref = useRef<HTMLDivElement>(null);
	const col1Ref = useRef<HTMLDivElement>(null);
	const colRefOf = (col: ColumnIndex) => (col === 0 ? col0Ref : col1Ref);

	// ── A/D 标签页切换 ──
	// 鼠标点哪张（合并）卡片，A/D 就在哪张卡片内循环切换标签页；
	// 焦点卡片只有一张卡（无标签可切）时，退化为移动到相邻卡片。
	// 焦点存 pane id，选中的卡片外溢淡色光晕、标题栏旁显示 A/D 徽标。
	const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);

	const allPanes = useMemo(() => [...layout.columns[0], ...layout.columns[1]], [layout]);
	const focusedPaneExists = focusedPaneId !== null && allPanes.some((p) => p.id === focusedPaneId);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const k = e.key.toLowerCase();
			if (k !== 'a' && k !== 'd') return;
			if (hasModifier(e) || isTypingTarget(e.target)) return;
			const panes = [...layout.columns[0], ...layout.columns[1]];
			if (panes.length === 0) return;
			e.preventDefault();

			const focused = panes.find((p) => p.id === focusedPaneId);
			// 尚无焦点：D 从第一张开始，A 从最后一张开始
			if (!focused) {
				setFocusedPaneId(panes[k === 'd' ? 0 : panes.length - 1].id);
				return;
			}
			// 合并卡片（≥2 个标签）：在标签页之间循环
			if (focused.cards.length > 1) {
				const idx = focused.cards.indexOf(focused.active);
				const next =
					k === 'd'
						? (idx + 1) % focused.cards.length
						: (idx - 1 + focused.cards.length) % focused.cards.length;
				setActiveCard(focused.id, focused.cards[next]);
				return;
			}
			// 单卡面板：没有标签可切，移动焦点到相邻卡片（循环）
			const idx = panes.findIndex((p) => p.id === focused.id);
			const next =
				k === 'd' ? (idx + 1) % panes.length : (idx - 1 + panes.length) % panes.length;
			setFocusedPaneId(panes[next].id);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [layout, focusedPaneId, setActiveCard]);

	// 键盘切换后把选中卡片滚进视口（点击聚焦时本来就在视口内，no-op）。
	// 用 `block:'nearest'`：已在视口内则完全不滚动，不会误伤整页布局。
	// 与「歌词/列表跟随滚动禁用 scrollIntoView」是两回事，见 `useLyrics.ts` 注释。
	useEffect(() => {
		if (!focusedPaneId) return;
		document
			.querySelector(`[data-pane-id="${focusedPaneId}"]`)
			?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}, [focusedPaneId]);

	const renderCard = (card: CardId) => {
		switch (card) {
			case 'lyrics':
				return <LyricsPanel />;
			case 'nowplaying':
				return <NowPlaying />;
			case 'queue':
				return <QueueList />;
		}
	};

	/** 标题栏副标题：只给单卡面板用，合并态显示标签页就够了 */
	const subtitleOf = (card: CardId) => {
		if (card === 'lyrics') return track ? `${track.title} · ${track.artist}` : undefined;
		if (card === 'queue') return `${snap.queue.length} 首`;
		return undefined;
	};

	const [left, right] = layout.columns;

	const renderColumn = (col: ColumnIndex) => {
		const panes = layout.columns[col];
		if (panes.length === 0) return null;
		const colRef = colRefOf(col);
		const totalFlex = panes.reduce((s, p) => s + p.flex, 0);
		// 列内容高度占比：最后一张卡底部的把手调整的就是它（<1 时列下方留白）
		const fill = layout.colFill[col];

		return (
			<div
				ref={colRef}
				className={`layout-col layout-col--${col === 0 ? 'left' : 'right'} flex flex-col`}
			>
				{panes.map((pane, i) => (
					<Fragment key={pane.id}>
						<PaneShell
								pane={pane}
								canMergeUp={i > 0}
								canMergeDown={i < panes.length - 1}
								mergeTargets={allPanes.filter((p) => p.id !== pane.id)}
								subtitle={subtitleOf(pane.active)}
								heightPct={totalFlex > 0 ? (fill * pane.flex) / totalFlex : undefined}
							focused={focusedPaneExists && focusedPaneId === pane.id}
							onFocus={() => setFocusedPaneId(pane.id)}
							onActive={(card) => setActiveCard(pane.id, card)}
							onMergeUp={() => mergeInto(pane.active, panes[i - 1].id)}
							onMergeDown={() => mergeInto(pane.active, panes[i + 1].id)}
							onMergeInto={(targetPaneId) => mergeInto(pane.active, targetPaneId)}
							onSplit={() => splitOut(pane.active)}
							onMoveColumn={() => movePaneToColumn(pane.id)}
							onHide={() => hideCard(pane.active)}
							onReorder={movePane}
						>
							{renderCard(pane.active)}
						</PaneShell>

						{i < panes.length - 1 ? (
							/* 卡片之间：上下交换高度权重 */
							<SplitHandle
								key="sep-mid"
								orientation="horizontal"
								containerRef={colRef}
								onDelta={(deltaPx, size) => resizePanes(col, i, deltaPx, size)}
								label={`调整「${paneLabel(panes[i + 1])}」与上方面板的高度`}
								className="hidden lg:block"
							/>
						) : (
							/* 最后一张卡的底部：调整整列内容高度占比（单卡列唯一的高度入口） */
							<SplitHandle
								key="sep-end"
								orientation="horizontal"
								containerRef={colRef}
								onDelta={(deltaPx, size) => resizeColumnFill(col, deltaPx, size)}
								label={`调整「${paneLabel(panes[i])}」的高度（列内无其它卡片时也可用）`}
								className="hidden lg:block"
							/>
						)}
					</Fragment>
				))}
			</div>
		);
	};

	const hasLeft = left.length > 0;
	const hasRight = right.length > 0;

	if (!hasLeft && !hasRight) {
		return (
			<div className="flex flex-col items-center justify-center gap-2 py-20 text-center text-muted">
				<span className="text-3xl opacity-60">🗂️</span>
				<p className="text-sm">所有卡片都已隐藏</p>
				<p className="text-xs text-muted/70">点击顶栏「卡片」按钮恢复显示</p>
			</div>
		);
	}

	// 只有一列有内容时，让这一列占满宽度（另一列 flex-grow 为 0，自然隐形）
	const leftFlex = !hasLeft ? 0 : !hasRight ? 1 : layout.colFlex;

	return (
		<div
			ref={rootRef}
			className="flex min-h-0 flex-col gap-2 lg:h-full lg:flex-row lg:gap-0"
			style={{ '--col-left': String(leftFlex) } as React.CSSProperties}
		>
			{renderColumn(0)}

			{hasLeft && hasRight && (
				<SplitHandle
					orientation="vertical"
					containerRef={rootRef}
					onRatio={resizeCols}
					currentRatio={layout.colFlex}
					label="调整左右两列宽度"
					className="hidden lg:block"
				/>
			)}

			{renderColumn(1)}
		</div>
	);
}

export default function Home() {
	const [queueOpen, setQueueOpen] = useState(false);

	// Esc 关闭队列抽屉（仅当抽屉打开时挂载监听）
	useEscapeToClose(() => setQueueOpen(false), queueOpen);

	return (
		<ThemeProvider>
			<PlayerProvider>
				<LayoutProvider>
					<div className="app-shell flex h-dvh flex-col text-foreground">
						{/* ── 顶部栏 ── */}
						<header className="glass sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4">
							<div className="flex min-w-0 items-center gap-2.5">
								<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-brand-2 text-base shadow-sm">
									🎧
								</span>
								<div className="min-w-0 leading-tight">
									<h1 className="hidden truncate text-sm font-semibold tracking-tight min-[420px]:block sm:text-base">
										Private Music <span className="text-brand-gradient">Hub</span>
									</h1>
									<p className="hidden text-[10px] text-muted sm:block">私人音乐平台</p>
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
								<LibraryGrid />
								<ThemePanel />
								<ShortcutsPanel />
								<LayoutMenu />
							</div>
						</header>

						{/* ── 主区域：可拉伸 / 可合并 / 可隐藏的面板布局 ── */}
						<main className="scroll-area min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
							<MainPanels />
						</main>

						{/* ── 队列抽屉（底部滑出，移动端主入口） ── */}
						<div
							className={`fixed inset-0 z-40 bg-black/30 transition-opacity ${queueOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
							onClick={() => setQueueOpen(false)}
							aria-hidden={!queueOpen}
						/>
						<aside
							className={`fixed inset-x-0 bottom-0 z-50 transition-transform duration-300 ${queueOpen ? 'translate-y-0' : 'translate-y-full'}`}
							aria-label="播放队列"
							aria-hidden={!queueOpen}
						>
							<div className="glass mx-auto max-w-xl rounded-t-3xl border-t border-border shadow-2xl">
								<div className="flex items-center justify-between border-b border-border px-4 py-2.5">
									<h2 className="text-sm font-semibold">播放队列</h2>
									<button
										type="button"
										onClick={() => setQueueOpen(false)}
										aria-label="关闭队列"
										className="rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-foreground"
									>
										<CloseIcon size={18} />
									</button>
								</div>
								<div className="flex h-[52vh] max-h-[420px] min-h-0 flex-col">
									<QueueList />
								</div>
							</div>
						</aside>

						{/* ── 音频引擎（视觉隐藏）+ 自绘底部播放条 ── */}
						<APlayerPlayer />
						<PlayerBar onToggleQueue={() => setQueueOpen((v) => !v)} />

						{/* ── 全局快捷键（必须挂在 PlayerProvider 内部以读取播放快照）── */}
						<GlobalHotkeys />
					</div>
				</LayoutProvider>
			</PlayerProvider>
		</ThemeProvider>
	);
}
