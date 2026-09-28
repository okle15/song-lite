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
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SPLIT_HANDLE_PX } from './SplitHandle';
import {
	ALL_CARD_IDS,
	MAX_COL_FILL,
	defaultLayout,
	ensureVisible,
	hideCard,
	loadLayout,
	mergeInto,
	restoreCard,
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

test('defaultLayout：全部卡片各占一格，与 ALL_CARD_IDS 完全一致', () => {
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
	assert.ok(!(allCards(l) as string[]).includes('overview'), '未知卡片应被丢弃');
	// 不变式：**每张已知卡片要么在布局里、要么在可恢复列表里**，不能凭空消失。
	// 比原来的「一张都不能少」更准确 —— 缺席的卡（这份外来布局里没有 `tasks`）
	// 该去 hidden，而不是被塞进用户调好的列里。
	assert.deepEqual(
		[...allCards(l), ...l.hidden].sort(),
		[...ALL_CARD_IDS].sort(),
		'已知卡片只能在「布局里」或「可恢复列表里」这两处之一',
	);
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

/**
 * **加新卡时的升级路径**（2026-09-24 加第 5 张卡 `tasks` 时才有这个形状）。
 *
 * 老用户的 localStorage 里是一份不含新卡的布局：新卡的 id **两个列表都没有**。
 * 若不处理，`LayoutMenu` 里点「恢复」会撞上 `restoreCard` 的守卫、静默无反应 ——
 * 又一次「结构自洽但语义错误」：状态、控制台、类型检查三处都看不出不对。
 *
 * ⚠️ 加第 6 张卡（`memory`）时这条**真的红了一次**，而它红得对：它原本把期望写成
 * 字面量 `['tasks']`，那是把**当天的快照**当成了判据。判据其实是「**凡缺席的**已知
 * 卡片都进可恢复列表」，所以下面改成从 `ALL_CARD_IDS` 推 —— 下一次加卡它只会因为
 * 「真出了这个问题」而红，不会因为「少改了一个字面量」而红。
 */
test('老布局升级：缺席的已知卡片会进可恢复列表，点一下能真的恢复', () => {
	// 一份更早版本的布局：只收录了当时存在的四张，`tasks` / `memory` 都还没有
	const l = loadWithStored({
		columns: [
			[
				{ id: 'pane-chat', cards: ['chat'], active: 'chat', flex: 1.1 },
				{ id: 'pane-lyrics', cards: ['lyrics'], active: 'lyrics', flex: 1.5 },
			],
			[
				{ id: 'pane-nowplaying', cards: ['nowplaying'], active: 'nowplaying', flex: 1.25 },
				{ id: 'pane-queue', cards: ['queue'], active: 'queue', flex: 1.25 },
			],
		],
		colFlex: 0.58,
		colFill: [1, 1],
		hidden: [],
	});

	// 1) 不擅自改用户已经调好的布局：缺席的卡进 hidden，而不是插进某一列
	assert.deepEqual(
		allCards(l),
		['chat', 'lyrics', 'nowplaying', 'queue'],
		'恢复默认之外的卡片不该被凭空塞进列里',
	);
	// 期望从 `ALL_CARD_IDS` 推，不写字面量 —— 判据是「**凡**缺席的已知卡片都进
	// 可恢复列表」，所以这一版会同时覆盖 `tasks` 与 `memory` 两张。写死列表的话，
	// 加下一张卡时它会红，而那次红**不代表出了问题**（是快照过期），白白消耗一次注意力。
	assert.deepEqual(
		l.hidden,
		ALL_CARD_IDS.filter((c) => !allCards(l).includes(c)),
		'缺席的卡必须**全部**出现在「可恢复」列表里',
	);

	// 2) 从菜单点「恢复」必须真的把它放回来（旧实现会静默 return layout）
	const restored = restoreCard(l, 'tasks');
	assert.ok(allCards(restored).includes('tasks'), '「恢复」必须真的把它放进布局');
	// 只断言**这一张**出去了：`hidden` 里还有别的缺席卡（这个场景里是 `memory`），
	// 那是它们本来就该在的地方，用 `deepEqual(hidden, [])` 会把「恢复了一张」
	// 与「恢复完了」混为一谈。
	assert.ok(!restored.hidden.includes('tasks'), '恢复过的那张不该还留在 hidden 里');
});

/**
 * `restoreCard` 的守卫本身也是判据所在：它曾经要求 `hidden.includes(card)` 才动手。
 * 于是「既不在布局、也不在 hidden」的卡片点一下**什么都没发生**，而且不报错。
 */
test('restoreCard：既不在布局、也不在 hidden 的卡片也要能恢复（不许静默无反应）', () => {
	// 形状自洽（active 都指向自己 cards 里的卡片），但两处都没有 tasks
	const l: Layout = {
		columns: [
			[{ id: 'p1', cards: ['chat'], active: 'chat', flex: 1 }],
			[{ id: 'p2', cards: ['queue'], active: 'queue', flex: 1 }],
		],
		colFlex: 0.58,
		colFill: [1, 1],
		hidden: [],
	};
	assert.ok(!allCards(l).includes('tasks'), '前置条件：布局里没有 tasks');
	assert.ok(!l.hidden.includes('tasks'), '前置条件：hidden 里也没有（这正是那个形状）');

	const restored = restoreCard(l, 'tasks');
	assert.ok(allCards(restored).includes('tasks'), '不能原样返回 —— 用户会以为按钮坏了');
	assert.equal(restored.columns.length, 2, '列数不该变');

	// 已经在布局里的卡仍是空操作，不重复添加
	assert.equal(restoreCard(restored, 'tasks'), restored);
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

/**
 * 从 globals.css 里读**宽屏（lg）下 `.pane-item` 的 min-height 地板**。
 *
 * 为什么不在这里再写一个 `150`：地板是 CSS 里的事实，抄一份到测试就等于
 * 有第二个出处，改了 CSS 这边不会知道。解析不出来返回 `null`，
 * 调用方**断言失败**——「读数失败」与「数值合格」必须分开，
 * 否则改了 CSS 结构之后这条用例会静静地永远通过。
 */
function lgPaneMinHeight(css: string): number | null {
	const media = css.match(/@media\s*\(min-width:\s*1024px\)\s*\{([\s\S]*?)\n\}/);
	if (!media) return null;
	const rule = media[1].match(/\.pane-item\s*\{([\s\S]*?)\}/);
	if (!rule) return null;
	const mh = rule[1].match(/min-height:\s*(\d+(?:\.\d+)?)px/);
	return mh ? Number(mh[1]) : null;
}

/**
 * 默认布局必须**在参考窗口下铺得下**——这是一条几何判据，不是感觉。
 *
 * 为什么需要它：`.pane-item` 在 lg 下有一块 **min-height 地板**。按权重分到的
 * 高度一旦低于地板，那一格会被顶高，整列就比列高还高 → **main 出现滚动条**。
 * 2026-09-28 给左列加第 4 张卡时正是这么顶出 22px 的，而 tsc / eslint / 单测 /
 * 接口冒烟**四处全绿**，挨个看每张卡也都是好的 —— 只有量整页才看得见。
 *
 * 参考值（1440×900 实测，出处见 `panel-layout.ts` 的 `defaultLayout` 注释）：
 * 列高 738px；同列 N 张卡 → N 条分隔条各占 `SPLIT_HANDLE_PX`。
 * 所以「整列铺得下」= **每一格**分到的高度都 ≥ 地板。
 */
test('默认布局：同列每格分到的高度都高于地板（否则整列被顶高、整页出滚动条）', () => {
	const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
	const floor = lgPaneMinHeight(css);
	assert.ok(
		floor !== null,
		'读不出 lg 下 `.pane-item` 的 min-height —— globals.css 的结构变了就要同步改这条用例（不许降级成「跳过」）',
	);

	const REF_COL_H = 738; // 1440×900 实测的列高
	for (const [colIdx, col] of defaultLayout().columns.entries()) {
		const totalFlex = col.reduce((s, p) => s + p.flex, 0);
		const usable = REF_COL_H - col.length * SPLIT_HANDLE_PX;
		for (const pane of col) {
			const px = (usable * pane.flex) / totalFlex;
			assert.ok(
				px >= floor,
				`列${colIdx} 的 ${pane.id} 只分到 ${px.toFixed(1)}px，低于地板 ${floor}px —— ` +
					'这一格会被地板顶高、整列比列高还高，main 于是出现滚动条（不报错）',
			);
		}
	}
});
