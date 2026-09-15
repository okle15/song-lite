/**
 * GlobalHotkeys — 全局键盘快捷键层（对齐 redesign-prototype.html 的键盘习惯）。
 *
 * 为什么是组件而不是 hook：Home 组件渲染在 <PlayerProvider> 外层，
 * 读不到播放快照，所以快捷键必须作为子组件挂在 Provider 内部。
 *
 * 快捷键（本组件负责行为；面向用户的展示清单见 components/keyboard.ts 的 SHORTCUTS，
 * 两者语义必须一致——改键时同时看这两处，别再在本注释里手抄一份）：
 *  - 空格          播放 / 暂停
 *  - ← / →         快退 / 快进 5 秒
 *  - ↑ / ↓         音量 +/-
 *  - M             静音切换
 *  - N / P         下一首 / 上一首
 *  - L             滚动到歌词区
 *  - F             全屏歌词沉浸
 *
 * 不在本组件：`?` 打开快捷键清单、Esc 关闭当前面板，都在各自面板内实现。
 *
 *  guarded：在输入框 / 文本域 / 可编辑元素聚焦时，单键快捷键一律不触发，
 *  避免打字时误操作。
 */
'use client';
import { useEffect, useRef } from 'react';
import { usePlayerSnapshot } from './PlayerProvider';
import {
	PLAYER_EVENTS,
	loadVolume,
	requestSeek,
	requestVolume,
	saveVolume,
} from './player-events';
import { hasModifier, isTypingTarget } from '@/components/keyboard';

const SEEK_STEP = 5; // 秒
const VOL_STEP = 0.05;

export function GlobalHotkeys() {
	const snap = usePlayerSnapshot();
	// 用 ref 镜像最新快照与播放位置，使 keydown 监听只注册一次
	const snapRef = useRef(snap);
	const posRef = useRef(0);
	const volRef = useRef(loadVolume());

	useEffect(() => {
		snapRef.current = snap;
	}, [snap]);

	useEffect(() => {
		const onTime = (e: Event) => {
			const t = (e as CustomEvent<number>).detail;
			if (typeof t === 'number') posRef.current = t;
		};
		window.addEventListener(PLAYER_EVENTS.time, onTime);
		return () => window.removeEventListener(PLAYER_EVENTS.time, onTime);
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// 带修饰键或在输入中，一律不拦截
			if (hasModifier(e) || isTypingTarget(e.target)) return;

			const post = (url: string) => {
				void fetch(url, { method: 'POST' }).catch(() => {});
			};

			switch (e.key) {
				case ' ': {
					// 空格默认会滚动页面，必须拦截
					e.preventDefault();
					post(snapRef.current.state === 'playing' ? '/api/player/pause' : '/api/player/resume');
					break;
				}
				case 'ArrowLeft': {
					e.preventDefault();
					requestSeek(Math.max(0, posRef.current - SEEK_STEP));
					break;
				}
				case 'ArrowRight': {
					e.preventDefault();
					requestSeek(posRef.current + SEEK_STEP);
					break;
				}
				case 'ArrowUp': {
					e.preventDefault();
					const v = Math.min(1, volRef.current + VOL_STEP);
					volRef.current = v;
					saveVolume(v);
					requestVolume(v);
					break;
				}
				case 'ArrowDown': {
					e.preventDefault();
					const v = Math.max(0, volRef.current - VOL_STEP);
					volRef.current = v;
					saveVolume(v);
					requestVolume(v);
					break;
				}
				case 'n':
				case 'N':
					post('/api/player/next');
					break;
				case 'p':
				case 'P':
					// 与 PlayerBar 的「上一首」保持一致：超过 3s 先回到开头
					if (posRef.current > 3) {
						requestSeek(0);
					} else {
						const { queue, queueIndex } = snapRef.current;
						if (queue.length === 0) break;
						const idx = queueIndex <= 0 ? queue.length - 1 : queueIndex - 1;
						void fetch('/api/player/jump', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ index: idx }),
						}).catch(() => {});
					}
					break;
				case 'm':
				case 'M': {
					const v = volRef.current > 0 ? 0 : 0.8;
					volRef.current = v;
					saveVolume(v);
					requestVolume(v);
					break;
				}
				case 'l':
				case 'L': {
					// 歌词区在窄屏可能不在视口内，把它滚进视口。
					// 这里**刻意**用 scrollIntoView：`block:'nearest'` 保证已在视口内时
					// 完全不滚动，且滚动页面正是本键位的目的。
					// （`useLyrics` 那条「禁用 scrollIntoView」的规则只管歌词列表内部的
					//   跟随滚动——那里滚动会连带整页，与本场景不同。）
					const el = document.querySelector('[data-lyrics-panel]');
					el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
					break;
				}
				case 'f':
				case 'F': {
					// 全屏歌词沉浸页（实际开关状态在 LyricsPanel 内，这里只派发事件）
					window.dispatchEvent(new CustomEvent(PLAYER_EVENTS.lyricsFullscreen));
					break;
				}
				default:
					break;
			}
		};

		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	return null; // 纯行为组件，不渲染任何 UI
}
