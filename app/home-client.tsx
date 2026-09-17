/**
 * Music assistant home — **客户端主体**（应用外壳）。
 *
 * 为什么和 `app/page.tsx` 分成两个文件（2026-09-16，BLUEPRINT 阶段 3）：
 * 对话历史要在**首屏 HTML 里就存在**，否则刷新后会先渲染「你好，我是你的音乐助手」
 * 再补上历史——那次可见的状态切换就是用户说的「闪」。而读库必须在服务端做，
 * server component 又没法用 `useState` / `useChat`。于是各退一步：
 *
 *   app/page.tsx        服务端：读一次 SQLite，把历史当 props 递下来（约 15 行）
 *   app/home-client.tsx 浏览器：拿 `initialMessages` 初始化 useChat，其余全在这里
 *
 * `props` 而不是「往 HTML 里塞一段 JSON 让客户端自己解析」，是因为**信息要在读者
 * 眼前**：打开本文件就知道历史从哪来。隐式通道正是 BLUEPRINT §7 错题本
 * （`setApiBase` 那条）记的禁忌——「看不见来源」就是黑盒的起点。
 *
 * 布局（响应式）：
 *  - 顶部 glass header：品牌标识（Private Music Hub / 私人音乐平台）+ 操作区
 *    （曲库 / 背景主题 / 快捷键 / 卡片 / 音乐助手）。
 *  - 主区域：可自由拉伸、可合并、可隐藏的面板布局（LayoutProvider 管理）：
 *      · 两列结构。宽屏：列之间调宽度、同列卡片之间调高度，最后一张卡底部还能
 *        调整整列内容的缩放倍数；窄屏：单列纵向铺开，列宽条不适用，但卡片高度
 *        同样由权重决定，同列卡片之间的分隔条照常可拖（1:1 跟手）；
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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { APlayerPlayer } from '@/components/APlayerPlayer';
import { ChatCard } from '@/components/ChatCard';
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
import { ChatIcon, CloseIcon } from '@/components/icons';
import { SPLIT_HANDLE_PX, SplitHandle } from '@/components/SplitHandle';
import { ThemePanel } from '@/components/ThemePanel';
import { ThemeProvider } from '@/components/ThemeProvider';
import { useEscapeToClose } from '@/components/use-escape-to-close';
import { hasModifier, isTypingTarget } from '@/components/keyboard';
import type { CardId, ColumnIndex } from '@/components/panel-layout';

/** 「唤起音乐助手卡」的窗口事件名（⌘K 与顶栏按钮共用，勿写字面量）。 */
const OPEN_CHAT_CARD_EVENT = 'open-chat-card';

/**
 * 主区可配置面板布局。
 * 必须挂在 PlayerProvider 内部才能读播放快照（歌词 / 队列标题需要曲目信息）。
 */
function MainPanels({ initialMessages }: { initialMessages: UIMessage[] }) {
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
		ensureCard,
	} = useLayout();
	const snap = usePlayerSnapshot();
	const track = snap.currentTrack;

	// ── 音乐助手会话 ──
	// `useChat` 在**这里**调用而不是在 ChatCard 内：切标签页会卸载 ChatCard，
	// 状态放在里面会把整段对话一起丢掉。本组件位于 LayoutProvider 内且始终挂载。
	const transport = useMemo(() => new DefaultChatTransport({ api: '/api/agent' }), []);
	// `messages` 是**初始值**，之后由 useChat 自己维护。服务端渲染与本组件 hydrate
	// 拿到的是同一份 props，所以 React 找不到需要重画的东西——这就是「无闪」的全部机制。
	const chat = useChat({ transport, messages: initialMessages });
	const { sendMessage } = chat;

	// 快照用 ref 镜像，`sendToAgent` 因此不必随每次播放进度变化而重建。
	const snapRef = useRef(snap);
	useEffect(() => {
		snapRef.current = snap;
	}, [snap]);

	const sendToAgent = useCallback(
		(text: string) => {
			// 快照随消息带上——服务端据此知道「现在在放什么」，省掉一次读状态的往返。
			void sendMessage({ text }, { body: { snapshot: snapRef.current } });
		},
		[sendMessage],
	);

	// 「音乐助手」按钮 / ⌘K：确保助手卡可见并切到它所在的标签页
	useEffect(() => {
		const onOpenChat = () => ensureCard('chat');
		window.addEventListener(OPEN_CHAT_CARD_EVENT, onOpenChat);
		return () => window.removeEventListener(OPEN_CHAT_CARD_EVENT, onOpenChat);
	}, [ensureCard]);

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
			case 'chat':
				return (
					<ChatCard
						messages={chat.messages}
						status={chat.status}
						error={chat.error}
						onSend={sendToAgent}
						onStop={chat.stop}
					/>
				);
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
		// 列内容高度倍数：最后一张卡底部的把手调整的就是它（<1 留白，>1 溢出滚动）
		const fill = layout.colFill[col];
		// 分隔条也在这列里占位（N 张卡 → (N-1) 个中间条 + 1 个底部条）。
		// 卡片的百分比之和是 100%，若不把这几条的高度扣出来，整列就恒溢出 8N px，
		// 最后一个卡片的底边连同它的分隔条会被挤出可视区（详见 SPLIT_HANDLE_PX）。
		const sepTotalPx = panes.length * SPLIT_HANDLE_PX;
		/** 单张卡的高度 = 占比% − 这一格按权重分摊到的分隔条 px。 */
		const paneHeightOf = (flex: number) => {
			if (totalFlex <= 0) return undefined;
			const share = flex / totalFlex;
			return `calc(${(fill * share * 100).toFixed(4)}% - ${(sepTotalPx * share).toFixed(3)}px)`;
		};

		return (
			<div
				ref={colRef}
				className={`layout-col layout-col--${col === 0 ? 'left' : 'right'} flex flex-col`}
				// 列级下发 colFill：宽屏走 --pane-h（JS 已把 colFill 算进去），
				// 窄屏走 --col-fill（CSS 用它乘权重 × 40dvh）。
				// 窄屏不乘的话，底部分隔条调 colFill 就是个空动作。
				style={{ '--col-fill': fill } as React.CSSProperties}
			>
				{panes.map((pane, i) => (
					<Fragment key={pane.id}>
						<PaneShell
								pane={pane}
								canMergeUp={i > 0}
								canMergeDown={i < panes.length - 1}
								mergeTargets={allPanes.filter((p) => p.id !== pane.id)}
								subtitle={subtitleOf(pane.active)}
								paneHeight={paneHeightOf(pane.flex)}
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
							/* 卡片之间：上下交换高度权重。窄屏也保留——那里的卡片高度同样
							   由权重定（CSS 用 `权重 × 单位高度`），拖起来一样是 1:1。 */
							<SplitHandle
								key="sep-mid"
								orientation="horizontal"
								containerRef={colRef}
								onDelta={(deltaPx, size) => resizePanes(col, i, deltaPx, size)}
								label={`调整「${paneLabel(panes[i + 1])}」与上方面板的高度`}
							/>
						) : (
							/* 最后一张卡的底部：调整整列内容高度倍数（colFill）。
							   窄屏也必须有它——「一列只剩一张卡」时（隐藏过别的卡、
							   或把两张卡合并成标签页）这是**唯一**的高度入口，
							   曾经它在窄屏被 hidden 掉，那列就一条分隔条都不剩。 */
							<SplitHandle
								key="sep-end"
								orientation="horizontal"
								containerRef={colRef}
								onDelta={(deltaPx, size) => resizeColumnFill(col, deltaPx, size)}
								label={`调整「${paneLabel(panes[i])}」的高度（列内无其它卡片时也可用）`}
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

export function Home({ initialMessages }: { initialMessages: UIMessage[] }) {
	const [queueOpen, setQueueOpen] = useState(false);

	// Esc 关闭队列抽屉（仅当抽屉打开时挂载监听）
	useEscapeToClose(() => setQueueOpen(false), queueOpen);

	// 「音乐助手」按钮 / ⌘K：唤起助手卡片（MainPanels 监听该事件）
	const openChatCard = useCallback(() => {
		window.dispatchEvent(new CustomEvent(OPEN_CHAT_CARD_EVENT));
	}, []);

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
								<button
									type="button"
									onClick={openChatCard}
									aria-label="打开音乐助手"
									title="唤起音乐助手卡片（⌘K / Ctrl+K）"
									className="lift flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-brand-strong active:scale-95"
								>
									<ChatIcon size={14} />
									<span className="hidden sm:inline">音乐助手</span>
								</button>
							</div>
						</header>

						{/* ── 主区域：可拉伸 / 可合并 / 可隐藏的面板布局 ── */}
						<main className="scroll-area min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
							<MainPanels initialMessages={initialMessages} />
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
						<GlobalHotkeys onOpenChat={openChatCard} />
					</div>
				</LayoutProvider>
			</PlayerProvider>
		</ThemeProvider>
	);
}
