/**
 * PaneShell — 可配置布局中的单个面板外壳。
 *
 * 一个 Pane 就是用户看到的一张「卡片」：
 *  - 里面只有一张卡 → 标题栏显示这张卡的名字；
 *  - 里面有多张卡（合并后）→ 标题栏变成标签页，点一下切换；
 *  - 右上角 ⋯ 菜单：与相邻面板合并 / 合并到任意面板 / 拆分 / 移到另一列 / 隐藏。
 *
 * 拖拽排序：只在按住左侧手柄时才把面板变成 HTML5 拖拽源，避免影响
 * 面板内的文字选择、输入与点击；dragover 阶段读不到 dataTransfer，
 * 因此用模块级变量共享「当前被拖的是谁」。
 */
'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useEscapeToClose } from './use-escape-to-close';
import { CARD_LABELS, type CardId, type Pane } from '@/components/panel-layout';
import { GripIcon as GripIconSvg, MoreIcon } from './icons';

/** 当前被拖拽的面板 id（HTML5 DnD 的 dragover 阶段读不到 dataTransfer 数据） */
let draggingPaneId: string | null = null;

/** 面板显示名：单卡=卡名，多卡=「A + B」。 */
export function paneLabel(pane: Pane): string {
	return pane.cards.map((c) => CARD_LABELS[c]).join(' + ');
}

type Props = {
	pane: Pane;
	/** 同列内上方 / 下方是否还有面板（决定「与上方/下方合并」是否可用） */
	canMergeUp: boolean;
	canMergeDown: boolean;
	/** 可合并的目标面板（除自己以外） */
	mergeTargets: Pane[];
	/** 标题栏副标题（如歌词卡显示当前曲目） */
	subtitle?: ReactNode;
	/** 卡片高度占列高的比例（宽屏用；由 colFill × flex 权重算出） */
	heightPct?: number;
	/** 当前是否为 A/D 选中（外溢光晕 + 键位提示） */
	focused?: boolean;
	onFocus?: () => void;
	onActive: (card: CardId) => void;
	onMergeUp: () => void;
	onMergeDown: () => void;
	onMergeInto: (targetPaneId: string) => void;
	onSplit: () => void;
	onMoveColumn: () => void;
	onHide: () => void;
	onReorder: (fromPaneId: string, toPaneId: string) => void;
	children: ReactNode;
};

function GripIcon() {
	return <GripIconSvg size={14} />;
}

export function PaneShell({
	pane,
	canMergeUp,
	canMergeDown,
	mergeTargets,
	subtitle,
	heightPct,
	focused,
	onFocus,
	onActive,
	onMergeUp,
	onMergeDown,
	onMergeInto,
	onSplit,
	onMoveColumn,
	onHide,
	onReorder,
	children,
}: Props) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [dropTarget, setDropTarget] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);

	// 点击菜单外关闭
	useEffect(() => {
		if (!menuOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	}, [menuOpen]);

	// Esc 关闭菜单（捕获阶段 + 阻止冒泡，避免顺带关掉外层抽屉）
	useEscapeToClose(() => setMenuOpen(false), menuOpen, {
		capture: true,
		stopPropagation: true,
	});

	const isGroup = pane.cards.length > 1;

	// ── 拖拽排序：手柄按下才武装 draggable，松手 / 拖完即解除 ──
	// 拖动期间顺带禁用文本选择，避免手柄拖拽带出整段选中。
	const armDrag = () => {
		rootRef.current?.setAttribute('draggable', 'true');
		document.body.style.userSelect = 'none';
	};
	const disarmDrag = () => {
		rootRef.current?.removeAttribute('draggable');
		document.body.style.userSelect = '';
	};

	const onDragStart = (e: React.DragEvent) => {
		draggingPaneId = pane.id;
		e.dataTransfer.effectAllowed = 'move';
		try {
			e.dataTransfer.setData('text/plain', pane.id);
		} catch {
			/* 部分浏览器要求 setData 才启动拖拽 */
		}
	};

	const onDragEnd = () => {
		draggingPaneId = null;
		disarmDrag();
		setDropTarget(false);
	};

	const onDragOver = (e: React.DragEvent) => {
		if (!draggingPaneId || draggingPaneId === pane.id) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		setDropTarget(true);
	};

	const onDrop = (e: React.DragEvent) => {
		e.preventDefault();
		if (draggingPaneId && draggingPaneId !== pane.id) onReorder(draggingPaneId, pane.id);
		onDragEnd();
	};

	const itemCls =
		'block w-full rounded-lg px-2 py-1.5 text-left text-xs text-foreground transition hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent';

	return (
		<div
			ref={rootRef}
			data-pane-id={pane.id}
			onPointerDown={onFocus}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			onDragOver={onDragOver}
			onDragLeave={() => setDropTarget(false)}
			onDrop={onDrop}
			className="pane-item group/pane flex min-h-0 min-w-0 flex-col"
			style={{
				'--pane-flex': pane.flex,
				...(heightPct !== undefined ? { '--pane-h': `${heightPct * 100}%` } : {}),
			} as React.CSSProperties}
		>
			<div
				className={`card flex min-h-0 flex-1 flex-col overflow-hidden transition-[box-shadow,outline-color] ${
					dropTarget
						? 'outline-2 outline-offset-[-2px] outline-brand'
						: focused
							? 'pane-focused'
							: ''
				}`}
			>
				{/* ── 面板头 ── */}
				<header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
					<span
						onMouseDown={armDrag}
						onMouseUp={disarmDrag}
						title="按住拖到另一个面板上可交换位置"
						aria-label={`拖动「${paneLabel(pane)}」面板排序`}
						className="flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded text-muted/40 transition hover:text-muted active:cursor-grabbing"
					>
						<GripIcon />
					</span>

					{/* A/D 选中标记：只给合并卡片（多标签）显示，提示可用 A/D 切换标签页 */}
					{focused && isGroup && (
						<span
							title="按 A / D 切换标签页"
							className="flex shrink-0 items-center gap-1 rounded-md border border-brand/40 bg-brand-soft px-1.5 py-0.5 text-[9px] font-semibold leading-none text-brand"
						>
							<kbd className="font-sans">A</kbd>
							<span className="text-brand/60">/</span>
							<kbd className="font-sans">D</kbd>
						</span>
					)}

					{isGroup ? (
						/* 合并态：标签页切换 */
						<div
							className="flex min-w-0 items-center gap-0.5 overflow-hidden rounded-full border border-border bg-surface-2 p-0.5"
							role="tablist"
							aria-label={`${paneLabel(pane)}：切换卡片`}
						>
							{pane.cards.map((card) => (
								<button
									key={card}
									type="button"
									role="tab"
									aria-selected={pane.active === card}
									onClick={() => onActive(card)}
									className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
										pane.active === card
											? 'bg-brand text-white shadow-sm'
											: 'text-muted hover:text-foreground'
									}`}
								>
									{CARD_LABELS[card]}
								</button>
							))}
						</div>
					) : (
						/* 单卡态：标题 + 副标题 */
						<>
							<h3 className="shrink-0 text-sm font-semibold">
								{CARD_LABELS[pane.active]}
							</h3>
							{subtitle && (
								<span className="min-w-0 truncate text-xs text-muted">{subtitle}</span>
							)}
						</>
					)}

					{/* ── 操作菜单：hover/focus 浮现，窄屏无 hover 常显 ── */}
					<div
						ref={menuRef}
						className="relative ml-auto shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover/pane:opacity-100 max-md:opacity-100"
					>
						<button
							type="button"
							onClick={() => setMenuOpen((v) => !v)}
							aria-label={`${paneLabel(pane)}：面板操作`}
							aria-expanded={menuOpen}
							className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition hover:bg-surface-2 hover:text-foreground"
						>
							<MoreIcon size={14} />
						</button>

						{menuOpen && (
							<div
								role="menu"
								className="scroll-area absolute right-0 top-full z-30 mt-1 max-h-72 w-48 overflow-y-auto rounded-xl border border-border bg-[var(--surface)] p-1 shadow-xl backdrop-blur-md"
							>
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										onMergeUp();
										setMenuOpen(false);
									}}
									disabled={!canMergeUp}
									className={itemCls}
								>
									与上方合并为标签页
								</button>
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										onMergeDown();
										setMenuOpen(false);
									}}
									disabled={!canMergeDown}
									className={itemCls}
								>
									与下方合并为标签页
								</button>

								{mergeTargets.length > 0 && (
									<>
										<div className="my-1 h-px bg-border" />
										<div className="px-2 pb-0.5 pt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
											合并到
										</div>
										{mergeTargets.map((target) => (
											<button
												key={target.id}
												type="button"
												role="menuitem"
												onClick={() => {
													onMergeInto(target.id);
													setMenuOpen(false);
												}}
												className={itemCls}
											>
												<span className="block truncate">{paneLabel(target)}</span>
											</button>
										))}
									</>
								)}

								<div className="my-1 h-px bg-border" />
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										onSplit();
										setMenuOpen(false);
									}}
									disabled={!isGroup}
									className={itemCls}
								>
									拆分为独立面板
								</button>
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										onMoveColumn();
										setMenuOpen(false);
									}}
									className={itemCls}
								>
									移到另一列
								</button>
								<div className="my-1 h-px bg-border" />
								<button
									type="button"
									role="menuitem"
									onClick={() => {
										onHide();
										setMenuOpen(false);
									}}
									className={itemCls}
								>
									隐藏「{CARD_LABELS[pane.active]}」
								</button>
							</div>
						)}
					</div>
				</header>

				{/* ── 内容 ──
				    可滚动是「可自由拉伸」的必要兜底：面板被拖小时，内容比面板高的卡片
				    （如正在播放）仍能滚出来看，而不是被裁掉。 */}
				<div
					className="scroll-area flex min-h-0 flex-1 flex-col overflow-y-auto"
					role={isGroup ? 'tabpanel' : undefined}
				>
					{children}
				</div>
			</div>
		</div>
	);
}
