/**
 * 可配置面板布局：类型 / 默认值 / 持久化 / 变更操作。
 *
 * 需求：面板里的**每一张卡片**（音乐助手 / 歌词 / 播放历史 / 正在播放 / 播放队列 / 定时任务 / 记忆）要能
 *   1) 自由拉伸（Pane 之间的分隔条调高度，两列之间调宽度）
 *   2) 合并成标签页（一个 Pane 内放多张卡片，Tab 切换）
 *   3) 隐藏 / 恢复
 * 并且要持久化，刷新后保持。
 *
 * 结构：Layout 是「两列，每列若干个 Pane，每个 Pane 内若干张卡片（Tab）」。
 * 尺寸一律用相对 flex 值（不存像素），这样窗口缩放、跨设备读取都不会错位。
 */
import { LS_KEYS } from './storage-keys';

export type CardId = 'chat' | 'history' | 'lyrics' | 'memory' | 'nowplaying' | 'queue' | 'tasks';

export const CARD_LABELS: Record<CardId, string> = {
	chat: '音乐助手',
	history: '播放历史',
	lyrics: '歌词',
	memory: '记忆',
	nowplaying: '正在播放',
	queue: '播放队列',
	tasks: '定时任务',
};

export const ALL_CARD_IDS: CardId[] = [
	'chat',
	'history',
	'lyrics',
	'memory',
	'nowplaying',
	'queue',
	'tasks',
];

export type Pane = {
	id: string;
	/** 本 Pane 内的卡片；多于一张时以 Tab 形式切换。 */
	cards: CardId[];
	/** 当前激活的卡片（Tab 选中项）。 */
	active: CardId;
	/** 高度权重（同列内相对分配）。 */
	flex: number;
};

export type ColumnIndex = 0 | 1;

/**
 * 列内容高度相对**列高**的倍数上限。
 *
 * 为什么必须能大于 1：列内容默认就铺满列高（=1），底部把手若卡在 1，
 * 往下拖就完全没有余量——「列里只剩一张卡」时用户只能把卡片拖小，
 * 再也拖不回去（2026-09-17 实测：单卡列向下拖 100px 零反应）。
 * > 1 表示内容高过列，多出来的部分由 `main` 滚动兜住，等于「把卡片拉高」。
 */
export const MAX_COL_FILL = 3;

export type Layout = {
	columns: [Pane[], Pane[]];
	/** 左列宽度占比（0–1）。 */
	colFlex: number;
	/**
	 * 每列内容高度相对列高的倍数（0.15–`MAX_COL_FILL`，默认 1）。
	 * 列内最后一张卡的底部把手调整的就是它，两个方向都要能用：
	 *  < 1 → 列下方留白（整列卡片变矮）；
	 *  > 1 → 内容高过列（整列卡片变高，页面滚动）。
	 */
	colFill: [number, number];
	/** 被隐藏的卡片（可从布局菜单恢复）。 */
	hidden: CardId[];
};

/** 存储键带项目命名空间（见 storage-keys.ts）：与 song 同源，同名键会互相覆盖。 */
const STORAGE_KEY = LS_KEYS.layout;

/**
 * 默认布局：左列 = 音乐助手 / 歌词 / 记忆 / 播放历史，右列 = 正在播放 / 播放队列 / 定时任务。
 *
 * 每张卡默认各自独立成一格，**不预先合并成标签页**：这样分隔条、拖拽手柄、
 * 合并 / 拆分这些能力一进来就都有可操作对象，而不是藏在一层菜单后面。
 *
 * `tasks`（⑩ 的界面）加在右列**末位**、权重给得比同列邻居小：它是「扫一眼有没有
 * 排期、顺手撤掉一条」的卡，不需要和封面 / 队列平分高度。**放在默认布局里而不是
 * 默认隐藏**——隐藏等于新功能没人知道（`panel-layout.test.ts` 里那条
 * 「与 ALL_CARD_IDS 完全一致」的用例就是为此存在的）。老用户的布局不含这张卡，
 * 走的是另一条路：`sanitizeLayout` 会把它补进 `hidden`，从「卡片」菜单恢复。
 *
 * `memory`（⑥ 的界面）加在**左列** —— 它是「助手记住了我什么」，与对话是同一件事的
 * 两面（一个说、一个记），挨着放才读得出这层关系。
 *
 * `history`（`/api/history` 的界面，2026-09-28）也加在**左列末位**，权重给得最小：
 * 它是「扫一眼最近听过什么」，不需要和歌词平分高度。
 *
 * ⚠️ 但加这一张**真的把整页顶出过一次滚动**（2026-09-28 实测，1440×900：
 * `main.scrollHeight` 792 > `clientHeight` 770 —— 溢出 22px，对照 HEAD 是 0）。
 * 原因不是「同列几张」，而是**同列每张卡都有一块地板**：`.pane-item` 在 lg 下
 * `min-height: 150px`（globals.css）。按权重算出来的高度一旦低于地板，那一格就被顶高，
 * 整列于是比列高还高 —— 而这件事**四处都看不出来**：tsc / eslint / 单测 / 接口冒烟
 * 全绿，挨个看每张卡也都是好的，只有量整页才看得见。
 *
 * 所以「新卡放哪一列、权重给多少」要同时满足两条判据（都不是「同列几张」）：
 *   ① **那张卡的主按钮会不会被挤出可视区**（「卡片里的主按钮必须固定在滚动区之外」）；
 *   ② 参考窗口（1440×900，列高实测 738px，N 张卡 → N 个分隔条各 `SPLIT_HANDLE_PX`）
 *      下，同列**每一格**按权重分到的高度都要**高于地板**：
 *      可分配 = 738 − N×8，某格 = 可分配 × flex / 列内 flex 之和。
 * 下面这组权重就是按 ② 配出来的（左列 4 张：最少的占 0.2195 × 706 ≈ 155px > 150）。
 * `panel-layout.test.ts` 里那条「同列每格都高于地板」的用例守着它 —— 没有它，
 * 下一次加卡或调权重会**静默**再顶出一截滚动。
 *
 * 反向的一格：右列「正在播放」只有 266px，而它声明了 `min-h-[320px]` ——
 * 传输控制要**卡内滚 97px** 才看得全（1920×1080 下还要 30px）。这是**既有状态、
 * 且被接受**：底部 `PlayerBar` 是常驻的统一播放条，播放/暂停从不需要滚；
 * 那张卡是「英雄卡」，滚一下看模式胶囊可以接受。见 `NowPlaying.tsx` 的注释。
 */
export function defaultLayout(): Layout {
	return {
		columns: [
			[
				// 左列 4 张：权重按「每格都高于 150px 地板」配（见上方注释 ②）。
				// 对话给得最多（输入框 + 消息列表），播放历史最少（扫一眼）。
				{ id: 'pane-chat', cards: ['chat'], active: 'chat', flex: 1.2 },
				{ id: 'pane-lyrics', cards: ['lyrics'], active: 'lyrics', flex: 1.05 },
				{ id: 'pane-memory', cards: ['memory'], active: 'memory', flex: 0.95 },
				{ id: 'pane-history', cards: ['history'], active: 'history', flex: 0.9 },
			],
			[
				{ id: 'pane-nowplaying', cards: ['nowplaying'], active: 'nowplaying', flex: 1.25 },
				{ id: 'pane-queue', cards: ['queue'], active: 'queue', flex: 1.25 },
				{ id: 'pane-tasks', cards: ['tasks'], active: 'tasks', flex: 0.85 },
			],
		],
		colFlex: 0.58,
		colFill: [1, 1],
		hidden: [],
	};
}

let paneSeq = 0;
function nextPaneId(): string {
	paneSeq += 1;
	return `pane-${Date.now().toString(36)}-${paneSeq}`;
}

/**
 * 结构校验 + 修复：localStorage 可能被手改、来自旧版本，或由历史 bug 写出
 * （如旧版 mergeInto 曾留下「active 指向已摘走卡片」的悬空引用）。
 * 能修复的一律修复（激活位悬空、卡片重复、空面板、面板 id 冲突、不认识的卡片），
 * 只有结构性损坏（列数不对、某列变空）才回退默认值——
 * 直接整体回退会把用户精心调好的布局一次清空。
 */
function sanitizeLayout(value: unknown): Layout | null {
	if (!value || typeof value !== 'object') return null;
	const v = value as Partial<Layout>;
	if (!Array.isArray(v.columns) || v.columns.length !== 2) return null;
	if (
		typeof v.colFlex !== 'number' ||
		!Number.isFinite(v.colFlex) ||
		v.colFlex <= 0.05 ||
		v.colFlex >= 0.95
	) {
		return null;
	}
	if (!Array.isArray(v.hidden)) return null;

	const seenCards = new Set<CardId>();
	const seenPaneIds = new Set<string>();
	const columns: [Pane[], Pane[]] = [[], []];

	for (const colIdx of [0, 1] as ColumnIndex[]) {
		const col = v.columns[colIdx];
		if (!Array.isArray(col)) return null;
		let orphanFlex = 0;
		for (const rawPane of col) {
			if (!rawPane || typeof rawPane !== 'object') return null;
			const p = rawPane as Partial<Pane>;
			if (!Array.isArray(p.cards) || typeof p.flex !== 'number' || !(p.flex > 0)) return null;
			// 卡片唯一性兜底：重复出现的卡片只保留第一份；
			// 不认识的卡片只丢弃它自己，**不整体回退**——数据可能来自另一个项目
			// 或旧版本（实测 song 的布局含本项目没有的 overview 卡）。
			// 整体回退会把用户精心调好的布局一次清空，代价远大于少一张卡。
			const cards: CardId[] = [];
			for (const c of p.cards) {
				if (!ALL_CARD_IDS.includes(c)) continue;
				if (seenCards.has(c)) continue;
				seenCards.add(c);
				cards.push(c);
			}
			if (cards.length === 0) {
				// 空面板：不留悬空引用，权重并入同列首个幸存面板
				orphanFlex += p.flex;
				continue;
			}
			const baseId = typeof p.id === 'string' && p.id ? p.id : '';
			const id =
				baseId && !seenPaneIds.has(baseId)
					? baseId
					: `pane-fix-${colIdx}-${columns[colIdx].length}-${Date.now().toString(36)}-${seenPaneIds.size}`;
			seenPaneIds.add(id);
			columns[colIdx].push({
				id,
				cards,
				active: p.active !== undefined && cards.includes(p.active) ? p.active : cards[0],
				flex: p.flex,
			});
		}
		if (columns[colIdx].length > 0 && orphanFlex > 0) columns[colIdx][0].flex += orphanFlex;
	}

	// 兜底：丢卡后若某列空了，布局就没有任何可渲染对象（调用方按两列渲染，
	// 空列会渲染成一个没有内容的框），只有这种情况才回退默认。
	if (columns[0].length === 0 || columns[1].length === 0) return null;

	const hidden = v.hidden.filter(
		(c): c is CardId => ALL_CARD_IDS.includes(c) && !seenCards.has(c),
	);
	// 补齐「布局里没有、hidden 里也没有」的已知卡片 —— 这是**加新卡时的升级路径**。
	//
	// 老用户的 localStorage 里存着一份不含新卡的布局：新卡的 id 两个列表都没有，
	// 于是 LayoutMenu 里点「恢复」会撞上 restoreCard 的守卫、**静默无反应**
	// （2026-09-24 加第 5 张卡 `tasks` 时发现——这是"结构自洽但语义错误"的又一个样本）。
	// 补进 hidden 而不是插进某一列：判断权交回用户，而不是替他改一份已经调好的布局
	// （同理见上面「不认识的卡片只丢它自己，不整体回退」）。
	for (const c of ALL_CARD_IDS) {
		if (!seenCards.has(c) && !hidden.includes(c)) hidden.push(c);
	}
	// colFill 旧版本布局可能没有：缺省视为铺满（1）。
	// 上限用 MAX_COL_FILL 而不是 1——> 1 是「卡片比列还高」的合法状态。
	const rawFill = (v as { colFill?: unknown }).colFill;
	const colFill: [number, number] = [1, 1];
	if (Array.isArray(rawFill)) {
		for (const i of [0, 1] as ColumnIndex[]) {
			const n = rawFill[i];
			colFill[i] =
				typeof n === 'number' && Number.isFinite(n)
					? Math.min(MAX_COL_FILL, Math.max(0.15, n))
					: 1;
		}
	}
	return { columns, colFlex: v.colFlex, colFill, hidden };
}

export function loadLayout(): Layout {
	if (typeof window === 'undefined') return defaultLayout();
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return defaultLayout();
		const parsed: unknown = JSON.parse(raw);
		return sanitizeLayout(parsed) ?? defaultLayout();
	} catch {
		return defaultLayout();
	}
}

export function saveLayout(layout: Layout): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
	} catch {
		/* 隐私模式下写入会抛错，布局丢了不影响使用 */
	}
}

/** 找到某卡片所在的列与 Pane 下标。 */
function locate(layout: Layout, card: CardId): { col: ColumnIndex; paneIdx: number } | null {
	for (const col of [0, 1] as ColumnIndex[]) {
		const idx = layout.columns[col].findIndex((p) => p.cards.includes(card));
		if (idx >= 0) return { col, paneIdx: idx };
	}
	return null;
}

/**
 * 按**增量**调整同列内相邻两个 Pane 的高度权重。
 *
 * 为什么不是绝对比例：一列可能有 3 个以上 Pane，分隔条的绝对位置并不等于
 * 这两个 Pane 的占比（还有其它 Pane 和间隙）。用像素增量换算成 flex 增量才准确。
 */
export function shiftPaneFlex(
	layout: Layout,
	col: ColumnIndex,
	upperIdx: number,
	deltaFlex: number,
): Layout {
	const panes = layout.columns[col];
	const upper = panes[upperIdx];
	const lower = panes[upperIdx + 1];
	if (!upper || !lower) return layout;

	const total = upper.flex + lower.flex;
	// 各留 15% 下限，避免某块被拖到完全看不见（那样就找不回来了）
	const min = total * 0.15;
	const clamped = Math.min(total - min, Math.max(min, upper.flex + deltaFlex));
	const nextUpper: Pane = { ...upper, flex: clamped };
	const nextLower: Pane = { ...lower, flex: total - clamped };

	const nextPanes = [...panes];
	nextPanes[upperIdx] = nextUpper;
	nextPanes[upperIdx + 1] = nextLower;
	const nextColumns: [Pane[], Pane[]] = [...layout.columns] as [Pane[], Pane[]];
	nextColumns[col] = nextPanes;
	return { ...layout, columns: nextColumns };
}

/** 调整左右列宽度占比（0.2–0.8）。 */
export function resizeColumns(layout: Layout, colFlex: number): Layout {
	return { ...layout, colFlex: Math.min(0.8, Math.max(0.2, colFlex)) };
}

/** 某列的总高度权重，用于把像素增量换算成 flex 增量。 */
export function columnTotalFlex(layout: Layout, col: ColumnIndex): number {
	return layout.columns[col].reduce((s, p) => s + p.flex, 0);
}

/**
 * 调整某列内容高度相对列高的倍数（0.15–`MAX_COL_FILL`）。
 * 这是「列里只剩一张卡」时唯一的高度入口：< 1 时列下方留白，
 * > 1 时内容溢出列高（由 main 滚动兜住）。
 */
export function setColumnFill(layout: Layout, col: ColumnIndex, fill: number): Layout {
	const clamped = Math.min(MAX_COL_FILL, Math.max(0.15, fill));
	const colFill: [number, number] = [...layout.colFill] as [number, number];
	colFill[col] = clamped;
	return { ...layout, colFill };
}

/** 切换某 Pane 内的激活卡片（Tab 点击）。 */
export function setActiveCard(layout: Layout, paneId: string, card: CardId): Layout {
	const nextColumns = layout.columns.map((col) =>
		col.map((p) => (p.id === paneId ? { ...p, active: card } : p)),
	) as [Pane[], Pane[]];
	return { ...layout, columns: nextColumns };
}

/**
 * 把 source 卡片合并进 targetPaneId 所在 Pane（成为 Tab 组）；
 * 若 source 原本独占一个 Pane，则移除该空 Pane。
 */
export function mergeInto(layout: Layout, source: CardId, targetPaneId: string): Layout {
	const from = locate(layout, source);
	if (!from) return layout;

	const draft = layout.columns.map((col) => col.map((p) => ({ ...p, cards: [...p.cards] }))) as [
		Pane[],
		Pane[],
	];

	// 从原 Pane 摘掉
	const srcPane = draft[from.col][from.paneIdx];
	srcPane.cards = srcPane.cards.filter((c) => c !== source);
	// 摘掉的若是激活卡，激活位必须回退到剩余第一张，否则 renderCard(pane.active)
	// 会把已摘走的卡片再渲染一遍——「合并几次出现很多概览」的根源；
	// 同时也会让 isValidLayout 的 active∈cards 校验失败而丢掉整个布局。
	if (srcPane.cards.length > 0 && !srcPane.cards.includes(srcPane.active)) {
		srcPane.active = srcPane.cards[0];
	}

	// 挂到目标 Pane
	let merged = false;
	for (const col of [0, 1] as ColumnIndex[]) {
		for (const pane of draft[col]) {
			if (pane.id === targetPaneId) {
				if (!pane.cards.includes(source)) pane.cards.push(source);
				pane.active = source; // 合并后直接切到刚合并进来的卡片
				merged = true;
			}
		}
	}
	if (!merged) return layout;

	// 清掉空 Pane，并把它的权重让给同列邻居（没有邻居就让给另一列）
	for (const col of [0, 1] as ColumnIndex[]) {
		const kept: Pane[] = [];
		let orphanFlex = 0;
		for (const pane of draft[col]) {
			if (pane.cards.length === 0) orphanFlex += pane.flex;
			else kept.push(pane);
		}
		if (orphanFlex > 0 && kept.length > 0) {
			kept[0].flex += orphanFlex;
		}
		draft[col] = kept;
	}

	return { ...layout, columns: draft };
}

/** 把卡片从 Tab 组里拆出来，成为同列内的独立 Pane（放在原 Pane 后面）。 */
export function splitOut(layout: Layout, card: CardId): Layout {
	const at = locate(layout, card);
	if (!at) return layout;
	const pane = layout.columns[at.col][at.paneIdx];
	if (pane.cards.length <= 1) return layout; // 本来就独立

	const half = pane.flex / 2;
	const newPane: Pane = { id: nextPaneId(), cards: [card], active: card, flex: half };

	const draft = layout.columns.map((col) => col.map((p) => ({ ...p, cards: [...p.cards] }))) as [
		Pane[],
		Pane[],
	];
	const src = draft[at.col][at.paneIdx];
	src.cards = src.cards.filter((c) => c !== card);
	src.flex = half;
	// 剩余 Tab 组回到第一张卡
	if (src.cards.length > 0) src.active = src.cards[0];
	draft[at.col].splice(at.paneIdx + 1, 0, newPane);

	return { ...layout, columns: draft };
}

/** 找到某 Pane 所在的列与下标。 */
function locatePane(layout: Layout, paneId: string): { col: ColumnIndex; paneIdx: number } | null {
	for (const col of [0, 1] as ColumnIndex[]) {
		const idx = layout.columns[col].findIndex((p) => p.id === paneId);
		if (idx >= 0) return { col, paneIdx: idx };
	}
	return null;
}

/**
 * 把 fromPane 拖到 toPane 所在位置（跨列也可以）。
 * 语义与拖拽直觉一致：源面板插到目标面板的位置，目标及其后的面板顺次后移。
 */
export function movePane(layout: Layout, fromPaneId: string, toPaneId: string): Layout {
	if (fromPaneId === toPaneId) return layout;
	const from = locatePane(layout, fromPaneId);
	const to = locatePane(layout, toPaneId);
	if (!from || !to) return layout;

	const moving = layout.columns[from.col][from.paneIdx];
	const draft = layout.columns.map((col) => col.filter((p) => p.id !== fromPaneId)) as [
		Pane[],
		Pane[],
	];
	const targetIdx = draft[to.col].findIndex((p) => p.id === toPaneId);
	if (targetIdx < 0) return layout;
	draft[to.col].splice(targetIdx, 0, moving);
	return { ...layout, columns: draft };
}

/** 把整个 Pane 搬到另一列末尾（菜单里「移到另一列」用）。 */
export function movePaneToColumn(layout: Layout, paneId: string): Layout {
	const at = locatePane(layout, paneId);
	if (!at) return layout;
	const dest: ColumnIndex = at.col === 0 ? 1 : 0;
	const draft = layout.columns.map((col) => col.filter((p) => p.id !== paneId)) as [Pane[], Pane[]];
	draft[dest].push(layout.columns[at.col][at.paneIdx]);
	return { ...layout, columns: draft };
}

/** 隐藏卡片：从布局摘除并记入 hidden，方便之后恢复。 */
export function hideCard(layout: Layout, card: CardId): Layout {
	const at = locate(layout, card);
	if (!at) return layout;

	const draft = layout.columns.map((col) => col.map((p) => ({ ...p, cards: [...p.cards] }))) as [
		Pane[],
		Pane[],
	];
	const src = draft[at.col][at.paneIdx];
	src.cards = src.cards.filter((c) => c !== card);
	if (src.cards.length > 0) src.active = src.cards[0];

	// 空 Pane 直接移除，权重让给同列首个 Pane
	for (const col of [0, 1] as ColumnIndex[]) {
		const kept: Pane[] = [];
		let orphan = 0;
		for (const pane of draft[col]) {
			if (pane.cards.length === 0) orphan += pane.flex;
			else kept.push(pane);
		}
		if (orphan > 0 && kept.length > 0) kept[0].flex += orphan;
		draft[col] = kept;
	}

	const hidden = layout.hidden.includes(card) ? layout.hidden : [...layout.hidden, card];
	return { ...layout, columns: draft, hidden };
}

/**
 * 确保某卡片出现在布局里：不在布局中（无论是被隐藏、还是根本没被那份布局收录）
 * 就放进较短的那一列末尾；已经在布局里则原样返回。
 *
 * ⚠️ 这里**不能**再要求 `hidden.includes(card)` 才动手。曾经的守卫是
 * 「不在 hidden 里就 return layout」，于是「布局里没有、hidden 里也没有」的卡片
 * 点一下**毫无反应**——加第 5 张卡时老用户的布局正是这个形状（见 `sanitizeLayout`
 * 末尾的补齐逻辑）。语义上「恢复」就是「让它可见」，返回值里本来就会把它从
 * `hidden` 摘掉，不存在残留。
 */
export function restoreCard(layout: Layout, card: CardId, col?: ColumnIndex): Layout {
	if (locate(layout, card)) return layout; // 已在布局中

	const target: ColumnIndex =
		col ?? (layout.columns[0].length <= layout.columns[1].length ? 0 : 1);
	const draft = layout.columns.map((c) => c.map((p) => ({ ...p, cards: [...p.cards] }))) as [
		Pane[],
		Pane[],
	];
	const avg =
		draft[target].length > 0
			? draft[target].reduce((s, p) => s + p.flex, 0) / draft[target].length
			: 1;
	draft[target].push({ id: nextPaneId(), cards: [card], active: card, flex: avg });

	return {
		...layout,
		columns: draft,
		hidden: layout.hidden.filter((c) => c !== card),
	};
}

/**
 * 确保某卡片可见并激活（顶栏「音乐助手」按钮 / ⌘K 用）。
 *
 * 三件事合一，因为调用方只关心「我要看到这张卡」：
 * 被隐藏了就恢复，在合并标签组里就切到它，已经可见且是激活卡则原样返回。
 */
export function ensureVisible(layout: Layout, card: CardId): Layout {
	if (layout.hidden.includes(card)) return restoreCard(layout, card);
	const at = locate(layout, card);
	if (!at) return layout;
	const pane = layout.columns[at.col][at.paneIdx];
	if (pane.active === card) return layout;
	return setActiveCard(layout, pane.id, card);
}
