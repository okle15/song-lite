/**
 * SplitHandle — 面板之间的可拖拽分隔条。
 *
 * orientation:
 *  - 'horizontal'：条是横的，上下拖动，调整**高度**（同列内相邻 Pane）
 *  - 'vertical'：条是竖的，左右拖动，调整**宽度**（左右两列）
 *
 * 两种回调，调用方按需二选一：
 *  - onRatio：绝对位置模式，ratio 是相对 container 的比例。适合「两列宽度」这类
 *    整体只分两块、比例即位置的场景。
 *  - onDelta：增量模式，给像素增量与容器尺寸，调用方自己换算。
 *    适合「一列里有 3 个以上 Pane」的场景——此时分隔条的绝对位置并不等于
 *    相邻两块的占比，用增量才准确。
 */
'use client';
import { useRef } from 'react';

type Props = {
	orientation: 'horizontal' | 'vertical';
	containerRef: React.RefObject<HTMLElement | null>;
	onRatio?: (ratio: number) => void;
	onDelta?: (deltaPx: number, containerSize: number) => void;
	label: string;
	/**
	 * 当前的真实比例（绝对模式用）。键盘微调必须基于真实值起步，
	 * 否则用户在 0.62 处按一下方向键会先跳回内部的 0.5 初值。
	 */
	currentRatio?: number;
	/** 附加类名（如把「整列内容高度」那条限制在宽屏：窄屏没有列高这个概念）。 */
	className?: string;
};

/** 键盘微调步长（占容器比例）。 */
const KEY_STEP = 0.03;

/**
 * 分隔条厚度（px）——**单一出处**。
 *
 * 组件用它定自己的尺寸，布局侧（`app/home-client.tsx`）也要用它把卡片高度里
 * 被分隔条吃掉的那几像素扣出来。两边各写一遍的话，一列卡片的百分比之和是 100%、
 * 却还要再塞进 N 条 8px 的分隔条，整列必然溢出：最后一个卡片的底边连同底部分隔条
 * 会被推到可视区之外（实测一列 3 张卡时，那条分隔条正好落在播放条底下，完全拖不到）。
 */
export const SPLIT_HANDLE_PX = 8;

export function SplitHandle({
	orientation,
	containerRef,
	onRatio,
	onDelta,
	label,
	currentRatio,
	className = '',
}: Props) {
	const draggingRef = useRef(false);
	const lastPosRef = useRef(0);
	// 记录最近一次比例，供方向键在此基础上微调
	const lastRatioRef = useRef(0.5);

	const isH = orientation === 'horizontal';

	const containerSize = (): number => {
		const el = containerRef.current;
		if (!el) return 0;
		return isH ? el.getBoundingClientRect().height : el.getBoundingClientRect().width;
	};

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!onRatio && !onDelta) return;
		e.preventDefault();
		draggingRef.current = true;
		lastPosRef.current = isH ? e.clientY : e.clientX;
		// 拖动期间禁用文本选择：仅靠 preventDefault 在部分浏览器（如 Firefox）
		// 拦不住从分隔条带出的选区，整页文字被选中非常难看。
		document.body.style.userSelect = 'none';
		// 捕获指针：拖出分隔条范围后仍要收到 move 事件。
		// 个别自动化 / 老内核下会抛错，捕获失败也不该让拖动整体失效。
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			/* 忽略：退化为元素内拖动 */
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) return;
		const pos = isH ? e.clientY : e.clientX;
		const delta = pos - lastPosRef.current;
		lastPosRef.current = pos;

		const el = containerRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const size = isH ? rect.height : rect.width;
		if (size <= 0) return;

		if (onDelta) {
			onDelta(delta, size);
		}
		if (onRatio) {
			const ratio = isH ? (e.clientY - rect.top) / size : (e.clientX - rect.left) / size;
			lastRatioRef.current = Math.min(0.95, Math.max(0.05, ratio));
			onRatio(lastRatioRef.current);
		}
	};

	const endDrag = () => {
		draggingRef.current = false;
		document.body.style.userSelect = '';
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		const dec = isH ? 'ArrowUp' : 'ArrowLeft';
		const inc = isH ? 'ArrowDown' : 'ArrowRight';
		if (e.key !== dec && e.key !== inc) return;
		e.preventDefault();
		const sign = e.key === inc ? 1 : -1;

		if (onRatio) {
			// 有真实值就以真实值为基准，拖动中则以拖动中的值为基准
			const base = draggingRef.current ? lastRatioRef.current : (currentRatio ?? lastRatioRef.current);
			lastRatioRef.current = Math.min(0.95, Math.max(0.05, base + sign * KEY_STEP));
			onRatio(lastRatioRef.current);
		}
		if (onDelta) {
			const size = containerSize();
			if (size > 0) onDelta(sign * KEY_STEP * size, size);
		}
	};

	return (
		<div
			role="separator"
			aria-orientation={isH ? 'horizontal' : 'vertical'}
			aria-label={label}
			tabIndex={0}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onKeyDown={onKeyDown}
			className={[
				// before 伪元素扩大热区：分隔条本体只有 8px，拖动目标太窄容易脱手
				"group relative shrink-0 touch-none select-none before:absolute before:content-['']",
				isH
					? 'cursor-row-resize before:-inset-y-1.5 before:inset-x-0'
					: 'cursor-col-resize before:-inset-x-1.5 before:inset-y-0',
				className,
			].join(' ')}
			style={isH ? { height: SPLIT_HANDLE_PX } : { width: SPLIT_HANDLE_PX }}
			title={`拖动调整${isH ? '高度' : '宽度'}（或用方向键）`}
		>
			{/* 视觉握把：静止时低亮度提示「这里可以拖」，hover / 聚焦 / 拖动时点亮 */}
			<span
				className={[
					'absolute rounded-full bg-brand/60 opacity-30 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
					isH
						? 'left-1/2 top-1/2 h-[3px] w-10 -translate-x-1/2 -translate-y-1/2'
						: 'left-1/2 top-1/2 h-10 w-[3px] -translate-x-1/2 -translate-y-1/2',
				].join(' ')}
			/>
		</div>
	);
}
