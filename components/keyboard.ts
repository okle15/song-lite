/**
 * 键盘相关公共工具 + 快捷键清单（单一事实来源）。
 *
 * `isTypingTarget` 被 GlobalHotkeys（决定单键快捷键是否让位给文字输入）与
 * ShortcutsPanel（决定 ? 键是否唤起帮助）共用，放在这里避免两处各写一份判断。
 *
 * `SHORTCUTS` 是**面向用户展示**的快捷键清单，只被 ShortcutsPanel 渲染。
 * 之所以放在这里而不是写在 ShortcutsPanel 内：GlobalHotkeys 的头部注释过去
 * 手抄了一份同样的清单，两处已经漂移过（注释漏了 F 与 ?）——凡「必须人工同步
 * 的清单」都是漂移源。改快捷键行为时同步改这张表即可。
 *
 * 注意：`?`（打开本清单）与 `Esc`（关闭当前面板）由 ShortcutsPanel 自身实现，
 * 其中 `?` 刻意不进这张表——面板里再列一行「按 ? 打开快捷键」属于自指噪音。
 */

/** 焦点是否在可输入元素内（此时全局快捷键应让位给打字）。 */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return (
		tag === 'INPUT' ||
		tag === 'TEXTAREA' ||
		tag === 'SELECT' ||
		target.isContentEditable
	);
}

/**
 * 是否按下了修饰键（带修饰键的组合交给浏览器/应用自身处理）。
 *
 * 用 Boolean() 包一层是为了兑现 `boolean` 返回类型：`e.metaKey || e.ctrlKey || e.altKey`
 * 在字段缺失时（合成事件 / 测试里手搓的事件对象）会返回 undefined，
 * 虽然 `!hasModifier(e)` 仍能工作，但把 undefined 当布尔值传出去是隐患。
 */
export function hasModifier(e: KeyboardEvent): boolean {
	return Boolean(e.metaKey || e.ctrlKey || e.altKey);
}

/** 快捷键说明行的展示数据（keys 为逐键渲染的键帽文本）。 */
export interface ShortcutSpec {
	keys: string[];
	desc: string;
}

/** 展示用快捷键清单。行为实现在 GlobalHotkeys（含 F），请保持两者语义一致。 */
export const SHORTCUTS: ShortcutSpec[] = [
	{ keys: ['空格'], desc: '播放 / 暂停' },
	{ keys: ['←', '→'], desc: '快退 / 快进 5 秒' },
	{ keys: ['↑', '↓'], desc: '音量 + / -' },
	{ keys: ['M'], desc: '静音切换' },
	{ keys: ['N'], desc: '下一首' },
	{ keys: ['P'], desc: '上一首' },
	{ keys: ['L'], desc: '定位到歌词' },
	{ keys: ['F'], desc: '全屏歌词沉浸' },
	{ keys: ['Esc'], desc: '关闭当前面板' },
];
