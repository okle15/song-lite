/**
 * `components/panel-layout.ts` 单测 —— 布局的纯函数。
 *
 * 为什么值得测：这里的每一步操作（隐藏 / 恢复 / 合并 / 切标签）都可能产出
 * **结构自洽但语义错误**的状态，而且它们全都不报错：
 *  - `active` 指向已被摘走的卡片 → 面板渲染成空白（历史 bug，见 `mergeInto` 注释）；
 *  - 同一张卡出现在两个 Pane → 渲染两次、分隔条数量对不上；
 *  - 隐藏后 `ensureVisible` 没把它放回来 → 按 ⌘K 没反应，看起来像快捷键坏了。
 *
 * 这些断言把「结构自洽」升级为「语义正确」，也是**唯一**能覆盖
 * 「⌘K 唤起音乐助手卡」这类交互逻辑的地方（真正的渲染交给浏览器验收）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	ALL_CARD_IDS,
	MAX_COL_FILL,
	defaultLayout,
	ensureVisible,
	hideCard,
	loadLayout,
	mergeInto,
	setActiveCard,
	setColumnFill,
	splitOut,
	type CardId,
	type Layout,
} from './panel-layout';
import { LS_KEYS } from './storage-keys';

/**
 * 装上假的 window.localStorage 跑 loadLayout()。
 *
 * sanitizeLayout 是模块私有的，只有从这里进去才能覆盖「读到一份外来的
 * 布局数据会怎样」——而这正是本项目踩过的坑（同源下读到 song 的布局）。
 */
function loadWithStored(raw: unknown): Layout {
	const store = new Map<string, string>();
	if (raw !== undefined) store.set(LS_KEYS.layout, JSON.stringify(raw));
	const g = globalThis as { window?: unknown };
	const prev = g.window;
	g.window = {
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: () => {},
			removeItem: () => {},
		},
	};
	try {
		return loadLayout();
	} finally {
		g.window = prev;
	}
}

/** 布局里出现过的全部卡片（含重复），按出现顺序。 */
function allCards(layout: Layout): CardId[] {
	return layout.columns.flatMap((col) => col.flatMap((p) => p.cards));
}

/** 某卡片所在的 Pane。 */
function paneOf(layout: Layout, card: CardId) {
	return layout.columns.flatMap((c) => c).find((p) => p.cards.includes(card));
}

test('defaultLayout：四张卡各占一格，与 ALL_CARD_IDS 完全一致', () => {
	const l = defaultLayout();
	assert.deepEqual(allCards(l).sort(), [...ALL_CARD_IDS].sort());
	// 每张卡各自独立成格：新加的卡片若被漏在默认布局外，用户只能去菜单里「恢复」，
	// 那条路径没测过就等于没实现。
	for (const pane of l.columns.flatMap((c) => c)) {
		assert.equal(pane.cards.length, 1, `${pane.id} 默认应是单卡面板`);
		assert.equal(pane.active, pane.cards[0]);
	}
});

test('defaultLayout：默认没有卡片是隐藏状态', () => {
	assert.deepEqual(defaultLayout().hidden, []);
});

test('defaultLayout：列宽与高度占比都在允许区间内', () => {
	const l = defaultLayout();
	assert.ok(l.colFlex > 0.05 && l.colFlex < 0.95, 'colFlex 越界会被 sanitizeLayout 判为损坏');
	for (const fill of l.colFill) assert.ok(fill >= 0.15 && fill <= 1);
});

test('ensureVisible：被隐藏的卡会被恢复出来', () => {
	const hiddenLayout = hideCard(defaultLayout(), 'chat');
	assert.ok(!allCards(hiddenLayout).includes('chat'), '前置条件：hideCard 应先把它摘掉');
	assert.ok(hiddenLayout.hidden.includes('chat'));

	const shown = ensureVisible(hiddenLayout, 'chat');
	assert.ok(allCards(shown).includes('chat'), '⌘K 唤起后卡片必须回到布局里');
	assert.ok(!shown.hidden.includes('chat'));
});

test('ensureVisible：卡在合并标签组里但不是激活项 → 切成激活，结构不变', () => {
	const merged = mergeInto(defaultLayout(), 'chat', 'pane-lyrics');
	const pane = paneOf(merged, 'chat');
	assert.ok(pane, '前置条件：合并后 chat 应在 pane-lyrics 里');
	assert.deepEqual([...pane.cards].sort(), ['chat', 'lyrics']);

	// 切回到 lyrics，模拟「用户手动切了标签页」
	const onLyrics = setActiveCard(merged, pane.id, 'lyrics');
	const before = onLyrics.columns.flatMap((c) => c).length;

	const shown = ensureVisible(onLyrics, 'chat');
	assert.equal(paneOf(shown, 'chat')?.active, 'chat', '应切到 chat 标签');
	assert.equal(shown.columns.flatMap((c) => c).length, before, '切标签不应改变面板数量');
	assert.deepEqual(allCards(shown).sort(), allCards(onLyrics).sort(), '卡片集合不应变化');
});

test('ensureVisible：已经是激活卡 → 原样返回同一引用', () => {
	// 引用相等很重要：⌘K 是高频动作，如果每次都 setState 出新对象，
	// 就会白跑一轮重渲染并多写一次 localStorage。
	const l = defaultLayout();
	assert.equal(ensureVisible(l, 'chat'), l);
});

test('mergeInto → splitOut：往返后卡片不重不漏', () => {
	const merged = mergeInto(defaultLayout(), 'chat', 'pane-lyrics');
	const split = splitOut(merged, 'chat');

	assert.deepEqual(allCards(split).sort(), [...ALL_CARD_IDS].sort());
	// 拆分后两张卡都在，但不再同处一格
	const pane = paneOf(split, 'chat');
	assert.deepEqual(pane?.cards, ['chat']);
	assert.deepEqual(paneOf(split, 'lyrics')?.cards, ['lyrics']);
});

test('hideCard：摘走卡片后不留空面板（否则会渲染出一个没有内容的框）', () => {
	const l = hideCard(defaultLayout(), 'nowplaying');
	for (const col of l.columns) {
		for (const pane of col) assert.ok(pane.cards.length > 0, `${pane.id} 是空面板`);
	}
	assert.ok(!allCards(l).includes('nowplaying'));
});

/**
 * 外来布局数据（另一个项目 / 旧版本写的）里的未知卡片：
 * 只丢弃那一张，**不整体回退**——整体回退会把用户调好的布局一次清空。
 */
test('未知卡片：只丢那一张，其余布局原样保留', () => {
	// song 的布局形状：含本项目不认识的 overview 卡。
	// colFlex 特意用 0.7（默认是 0.58），以便断言「确实没有回退默认」。
	const l = loadWithStored({
		columns: [
			[
				{ id: 'pane-overview', cards: ['overview', 'chat'], active: 'overview', flex: 1.5 },
				{ id: 'pane-lyrics', cards: ['lyrics'], active: 'lyrics', flex: 1.5 },
			],
			[
				{ id: 'pane-nowplaying', cards: ['nowplaying'], active: 'nowplaying', flex: 1.25 },
				{ id: 'pane-queue', cards: ['queue'], active: 'queue', flex: 1.25 },
			],
		],
		colFlex: 0.7,
		colFill: [0.6, 1],
		hidden: [],
	});

	assert.equal(l.colFlex, 0.7, '不应整体回退默认');
	assert.deepEqual(l.colFill, [0.6, 1], '不应整体回退默认');
	assert.deepEqual(allCards(l).sort(), [...ALL_CARD_IDS].sort(), '本项目的卡片一张都不能少');
	assert.ok(!(allCards(l) as string[]).includes('overview'), '未知卡片应被丢弃');
	// 幸存的 pane 保留，激活位回退到剩余卡片（原本指向 overview）
	const pane = l.columns[0].find((p) => p.id === 'pane-overview');
	assert.deepEqual(pane?.cards, ['chat']);
	assert.equal(pane?.active, 'chat');
});

test('未知卡片：把某列清空时才回退默认（空列会渲染成空框）', () => {
	const l = loadWithStored({
		columns: [
			[{ id: 'pane-overview', cards: ['overview'], active: 'overview', flex: 1 }],
			[{ id: 'pane-queue', cards: ['queue'], active: 'queue', flex: 1 }],
		],
		colFlex: 0.7,
		colFill: [1, 1],
		hidden: [],
	});
	assert.deepEqual(l, defaultLayout());
});

test('未知卡片：hidden 里的未知 id 被过滤掉', () => {
	const l = loadWithStored({
		columns: defaultLayout().columns,
		colFlex: 0.58,
		colFill: [1, 1],
		hidden: ['overview', 'queue'],
	});
	// overview 不认识 → 过滤；queue 已在布局里 → 也不算隐藏
	assert.deepEqual(l.hidden, []);
});

test('重复卡片：只保留第一份，不整体回退', () => {
	const l = loadWithStored({
		columns: [
			[{ id: 'p1', cards: ['chat', 'chat'], active: 'chat', flex: 1 }],
			[{ id: 'p2', cards: ['chat', 'queue'], active: 'chat', flex: 1 }],
		],
		colFlex: 0.58,
		colFill: [1, 1],
		hidden: [],
	});
	assert.equal(allCards(l).filter((c) => c === 'chat').length, 1);
	assert.ok(allCards(l).includes('queue'));
});

test('结构性损坏：列数不对 → 回退默认', () => {
	const l = loadWithStored({ columns: [[]], colFlex: 0.58, colFill: [1, 1], hidden: [] });
	assert.deepEqual(l, defaultLayout());
});

/**
 * 列内容高度倍数必须**两个方向都能拖**。
 *
 * 这是 2026-09-17 用户报的「拖拽改变不了卡片大小」的根因：倍数被夹在 ≤ 1，
 * 而列内容默认就铺满列高，于是「列里只剩一张卡」时底部把手往下拖是空动作，
 * 卡片只能变小、再也拖不回去。> 1 是合法状态（内容高过列，由 main 滚动兜住）。
 */
test('setColumnFill：向下能变大（> 1 不被夹回 1），向上留 15% 下限', () => {
	const l = defaultLayout();

	const taller = setColumnFill(l, 0, 1.4);
	assert.equal(taller.colFill[0], 1.4, '> 1 必须原样保留，否则底部把手是单向的');
	assert.equal(taller.colFill[1], 1, '另一列不该被带上');

	assert.equal(setColumnFill(l, 0, 0.05).colFill[0], 0.15);
	assert.equal(setColumnFill(l, 0, 99).colFill[0], MAX_COL_FILL, '上限要收住无穷拖拽');
});

test('外来布局的 colFill > 1：保留，不回退默认', () => {
	const l = loadWithStored({
		columns: defaultLayout().columns,
		colFlex: 0.58,
		colFill: [1.8, 0.6],
		hidden: [],
	});
	assert.deepEqual(l.colFill, [1.8, 0.6]);
});
