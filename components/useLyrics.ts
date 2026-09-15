/**
 * useLyrics — 歌词的「数据 + 高亮索引」逻辑，供内嵌面板与全屏沉浸页共用。
 *
 * 为什么要抽：全屏歌词视图需要完全相同的解析 / 时间同步 / seek 逻辑。
 * 各写一份意味着以后改 LRC 解析规则或时间来源要同步改两处，必然漂移。
 *
 * 刻意**不包含**滚动行为——两个视图的滚动容器不同（内嵌是卡片内的 div，
 * 全屏是整屏容器），滚动交给下面的 useScrollActiveIntoView，由调用方传入自己的 ref。
 */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerSnapshot } from './PlayerProvider';
import { PLAYER_EVENTS, requestSeek } from './player-events';

export type LrcLine = {
	time: number;
	text: string;
};

export type TrackInfo = {
	id: string;
	title: string;
	artist: string;
};

/** 解析 LRC 文本为 { time, text }[]，按时间排序。跳过 [ti:]/[ar:] 等元数据行。 */
function parseLrc(text: string): LrcLine[] {
	const lines = text.split('\n');
	const result: LrcLine[] = [];
	const timeRe = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;

	for (const line of lines) {
		if (/^\[(ti|ar|al|by|offset|kuwo|ver):/i.test(line.trim())) continue;

		const times: number[] = [];
		let match: RegExpExecArray | null;
		timeRe.lastIndex = 0;
		while ((match = timeRe.exec(line)) !== null) {
			const min = parseInt(match[1], 10);
			const sec = parseInt(match[2], 10);
			const ms = match[3] ? parseInt(match[3].padEnd(3, '0'), 10) : 0;
			times.push(min * 60 + sec + ms / 1000);
		}
		if (times.length === 0) continue;
		const lyricText = line.replace(timeRe, '').trim();
		for (const t of times) {
			result.push({ time: t, text: lyricText });
		}
	}
	result.sort((a, b) => a.time - b.time);
	return result;
}

/** 二分查找：找到当前时间对应的歌词行索引。 */
function findActiveIndex(lines: LrcLine[], currentSec: number): number {
	if (lines.length === 0) return -1;
	if (currentSec < lines[0].time) return -1;
	let lo = 0;
	let hi = lines.length - 1;
	let result = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (lines[mid].time <= currentSec) {
			result = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return result;
}

export function useLyrics() {
	const snap = usePlayerSnapshot();
	const track: TrackInfo | null = snap.currentTrack
		? { id: snap.currentTrack.id, title: snap.currentTrack.title, artist: snap.currentTrack.artist }
		: null;

	const [lines, setLines] = useState<LrcLine[]>([]);
	const [activeIdx, setActiveIdx] = useState(-1);
	const [loading, setLoading] = useState(false);
	// 用 ref 镜像最新歌词行，使 player-time 监听只需注册一次
	const linesRef = useRef<LrcLine[]>([]);

	useEffect(() => {
		linesRef.current = lines;
	}, [lines]);

	// 曲目变化时 fetch LRC
	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		if (!track) {
			setLines([]);
			setActiveIdx(-1);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setLines([]);
		setActiveIdx(-1);
		fetch(`/api/library/lyrics?trackId=${encodeURIComponent(track.id)}&raw=1`)
			.then((res) => (res.ok ? res.text() : ''))
			.then((text) => {
				if (cancelled) return;
				setLines(parseLrc(text));
				setLoading(false);
			})
			.catch(() => {
				if (cancelled) return;
				setLines([]);
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps
	/* eslint-enable react-hooks/set-state-in-effect */

	// 监听播放时间 → 更新高亮行（行数据走 ref，监听只注册一次）
	useEffect(() => {
		const onTime = (e: Event) => {
			const t = (e as CustomEvent<number>).detail;
			if (typeof t !== 'number') return;
			setActiveIdx(findActiveIndex(linesRef.current, t));
		};
		window.addEventListener(PLAYER_EVENTS.time, onTime);
		return () => window.removeEventListener(PLAYER_EVENTS.time, onTime);
	}, []);

	const seekTo = useCallback((time: number) => {
		requestSeek(time);
	}, []);

	return { track, lines, activeIdx, loading, seekTo };
}

/**
 * 把高亮行滚动到容器中间。
 *
 * 刻意用容器 scrollTo 而不是 el.scrollIntoView()——后者会连带滚动整个页面，
 * 在内嵌面板里表现为「歌词一滚动，整页跟着往上跑」。
 *
 * ⚠️ 这条规则的适用范围**只有「列表内部的跟随滚动」**（歌词跟唱、队列跟随当前曲）。
 * 另一种场景——「把某个面板/卡片滚进视口」（如按 L 键定位歌词面板、键盘切换聚焦卡片）
 * ——滚动页面本身**就是目的**，此时 `scrollIntoView({ block: 'nearest' })` 才是对的：
 * `nearest` 保证元素已在视口内时不做任何滚动，不会误伤。
 * 2026-09-11 复核：`GlobalHotkeys.tsx`（L 键）与 `app/page.tsx`（键盘聚焦）的两处
 * 曾被当成违规，实为误报——它们属于后者，改成容器 scrollTo 反而会让功能失效。
 */
export function useScrollActiveIntoView(
	containerRef: React.RefObject<HTMLElement | null>,
	activeIdx: number,
) {
	useEffect(() => {
		if (activeIdx < 0 || !containerRef.current) return;
		const container = containerRef.current;
		const activeEl = container.children[activeIdx] as HTMLElement | undefined;
		if (!activeEl) return;
		const targetTop =
			activeEl.offsetTop - container.clientHeight / 2 + activeEl.clientHeight / 2;
		container.scrollTo({ top: targetTop, behavior: 'smooth' });
	}, [activeIdx, containerRef]);
}
