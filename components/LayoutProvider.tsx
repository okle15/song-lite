/**
 * LayoutProvider — 主区「可拉伸 / 可合并 / 可隐藏」布局的唯一状态源。
 *
 * 数据结构见 components/panel-layout.ts：
 *   两列 → 每列若干 Pane → 每个 Pane 内若干张卡片（>1 张时以标签页切换）。
 *
 * 与 SSR 的一致性：首帧用 defaultLayout()（和服务端渲染结果一致），
 * 挂载后再从 localStorage 还原，避免水合警告；ready 之前不写回存储，
 * 否则会用默认值覆盖掉用户上次的布局。
 */
'use client';
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from 'react';
import {
	columnTotalFlex,
	defaultLayout,
	ensureVisible,
	hideCard as hideCardOp,
	loadLayout,
	mergeInto as mergeIntoOp,
	movePane as movePaneOp,
	movePaneToColumn as movePaneToColumnOp,
	resizeColumns,
	restoreCard as restoreCardOp,
	saveLayout,
	setActiveCard as setActiveCardOp,
	setColumnFill as setColumnFillOp,
	shiftPaneFlex,
	splitOut as splitOutOp,
	type CardId,
	type ColumnIndex,
	type Layout,
} from '@/components/panel-layout';

interface LayoutValue {
	layout: Layout;
	/** 分隔条拖动：同列内相邻两个 Pane 调高度（增量模式）。 */
	resizePanes: (col: ColumnIndex, upperIdx: number, deltaPx: number, containerPx: number) => void;
	/** 分隔条拖动：调整左右两列宽度（绝对比例模式）。 */
	resizeCols: (ratio: number) => void;
	/** 列底部把手：增量调整整列内容高度占比（列里只剩一张卡时也能调高度）。 */
	resizeColumnFill: (col: ColumnIndex, deltaPx: number, containerPx: number) => void;
	setActiveCard: (paneId: string, card: CardId) => void;
	mergeInto: (source: CardId, targetPaneId: string) => void;
	splitOut: (card: CardId) => void;
	hideCard: (card: CardId) => void;
	restoreCard: (card: CardId) => void;
	movePane: (fromPaneId: string, toPaneId: string) => void;
	movePaneToColumn: (paneId: string) => void;
	ensureCard: (card: CardId) => void;
	resetLayout: () => void;
}

const LayoutContext = createContext<LayoutValue | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
	const [layout, setLayout] = useState<Layout>(defaultLayout);
	const [ready, setReady] = useState(false);

	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		setLayout(loadLayout());
		setReady(true);
	}, []);

	useEffect(() => {
		if (!ready) return;
		saveLayout(layout);
	}, [layout, ready]);
	/* eslint-enable react-hooks/set-state-in-effect */

	const resizePanes = useCallback(
		(col: ColumnIndex, upperIdx: number, deltaPx: number, containerPx: number) => {
			if (containerPx <= 0) return;
			setLayout((prev) => {
				const total = columnTotalFlex(prev, col);
				if (total <= 0) return prev;
				return shiftPaneFlex(prev, col, upperIdx, (deltaPx / containerPx) * total);
			});
		},
		[],
	);

	const resizeCols = useCallback((ratio: number) => {
		setLayout((prev) => resizeColumns(prev, ratio));
	}, []);

	const resizeColumnFill = useCallback((col: ColumnIndex, deltaPx: number, containerPx: number) => {
		if (containerPx <= 0) return;
		// 与 resizePanes 同理：增量必须在 updater 内基于 prev 计算。
		// 若用渲染闭包里的 layout.colFill，同一帧内连续多个 pointermove 会
		// 共享同一个旧值、互相覆盖（拖动距离被吞）。
		setLayout((prev) => setColumnFillOp(prev, col, prev.colFill[col] + deltaPx / containerPx));
	}, []);

	const setActiveCard = useCallback((paneId: string, card: CardId) => {
		setLayout((prev) => setActiveCardOp(prev, paneId, card));
	}, []);

	const mergeInto = useCallback((source: CardId, targetPaneId: string) => {
		setLayout((prev) => mergeIntoOp(prev, source, targetPaneId));
	}, []);

	const splitOut = useCallback((card: CardId) => {
		setLayout((prev) => splitOutOp(prev, card));
	}, []);

	const hideCard = useCallback((card: CardId) => {
		setLayout((prev) => hideCardOp(prev, card));
	}, []);

	const restoreCard = useCallback((card: CardId) => {
		setLayout((prev) => restoreCardOp(prev, card));
	}, []);

	const movePane = useCallback((fromPaneId: string, toPaneId: string) => {
		setLayout((prev) => movePaneOp(prev, fromPaneId, toPaneId));
	}, []);

	const movePaneToColumn = useCallback((paneId: string) => {
		setLayout((prev) => movePaneToColumnOp(prev, paneId));
	}, []);

	const ensureCard = useCallback((card: CardId) => {
		setLayout((prev) => ensureVisible(prev, card));
	}, []);

	const resetLayout = useCallback(() => setLayout(defaultLayout()), []);

	const value = useMemo<LayoutValue>(
		() => ({
			layout,
			resizePanes,
			resizeCols,
			resizeColumnFill,
			setActiveCard,
			mergeInto,
			splitOut,
			hideCard,
			restoreCard,
			movePane,
			movePaneToColumn,
			ensureCard,
			resetLayout,
		}),
		[
			layout,
			resizePanes,
			resizeCols,
			resizeColumnFill,
			setActiveCard,
			mergeInto,
			splitOut,
			hideCard,
			restoreCard,
			movePane,
			movePaneToColumn,
			ensureCard,
			resetLayout,
		],
	);

	return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutValue {
	const ctx = useContext(LayoutContext);
	if (!ctx) throw new Error('useLayout must be used within LayoutProvider');
	return ctx;
}
