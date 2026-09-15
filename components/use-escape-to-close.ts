'use client';

import { useEffect, useRef } from 'react';

/** 事件对象的最小形状（Node 里没有 `KeyboardEvent`，单测用假对象即可）。 */
export type EscapeKeyLike = {
	key: string;
	stopPropagation?: () => void;
};

/** 监听目标的最小形状（`window` / `document` / 测试桩都满足）。 */
export type EscapeTargetLike = {
	addEventListener(
		type: string,
		listener: (e: EscapeKeyLike) => void,
		capture?: boolean,
	): void;
	removeEventListener(
		type: string,
		listener: (e: EscapeKeyLike) => void,
		capture?: boolean,
	): void;
};

export type EscapeOptions = {
	/** 捕获阶段监听。默认 false。 */
	capture?: boolean;
	/** 命中后阻止继续传播。默认 false。 */
	stopPropagation?: boolean;
};

/**
 * 挂上 Esc 监听，返回解绑函数。**不依赖 React**，单独抽出来是为了可单测——
 * 9 处弹层重复这段逻辑时，最容易犯的错是「忘了解绑」和「capture 参数
 * add/remove 写不对称」（后者不会报错，只会让监听悄悄泄漏），这两条只有单测得出来。
 *
 * @param target 监听目标，通常是 `window`
 * @param onClose 命中 Esc 时调用
 */
export function attachEscape(
	target: EscapeTargetLike,
	onClose: () => void,
	options: EscapeOptions = {},
): () => void {
	const { capture = false, stopPropagation = false } = options;
	const onKey = (e: EscapeKeyLike) => {
		if (e.key !== 'Escape') return;
		if (stopPropagation) e.stopPropagation?.();
		onClose();
	};
	target.addEventListener('keydown', onKey, capture);
	return () => target.removeEventListener('keydown', onKey, capture);
}

/**
 * Esc 关闭弹层 —— 全站弹层的统一入口。
 *
 * 抽出来的原因：这个 effect 此前被手抄了 **9 遍**（FullscreenLyrics / HistoryPanel /
 * LayoutMenu / LibraryGrid / PreferencePanel / ShortcutsPanel / ThemePanel / PaneShell /
 * app/page.tsx 的队列抽屉），而且抄得并不一致：
 *
 *  - 4 处挂 `document`、5 处挂 `window`（冒泡链上相邻，本页实际等价，但新人会困惑该用哪个）；
 *  - `PaneShell` 额外用了**捕获阶段 + stopPropagation**（Esc 只关内层菜单，不许顺带关掉外层抽屉）；
 *  - 有的把 `onClose` 放进依赖数组、有的不放——传内联箭头函数时前者会每次渲染重挂监听。
 *
 * 这里统一成：`onClose` 走 latest-ref（变化不重挂监听），依赖只有开关与选项。
 *
 * ⚠️ 重要语义：**`enabled` 为 false 时完全不挂监听**。多个弹层可以同时打开，
 * 关掉的那个必须是「当时打开的那些」；未打开的绝不能响应 Esc。
 * 多个同时打开时会一起关掉，这是刻意的（Esc = 收起当前所有浮层），
 * 唯一例外是 `stopPropagation: true` 的内层菜单。
 */
export function useEscapeToClose(
	onClose: () => void,
	enabled: boolean,
	options: EscapeOptions = {},
): void {
	const { capture = false, stopPropagation = false } = options;

	// latest-ref：让调用方可以安心传内联箭头函数，不必自己 useCallback
	const onCloseRef = useRef(onClose);
	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		if (!enabled) return;
		// 传 wrapper 而非 onCloseRef.current：监听只挂一次，但每次触发都读最新的回调
		return attachEscape(
			window,
			() => onCloseRef.current(),
			{ capture, stopPropagation },
		);
	}, [enabled, capture, stopPropagation]);
}
