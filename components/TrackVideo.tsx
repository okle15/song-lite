/**
 * TrackVideo — 伴生视频的**画面**：把封面那块地方换成动图（2026-09-28 加）。
 *
 * 它回答的问题只有一个：**「这首歌有视频吗」→「有就把封面那块地方给它」**。
 * 配对规则不在前端（同名同目录、扩展名优先级都在 `server/library/video.ts`），
 * 这里只消费一个布尔 `hasVideo`（由播放快照 / 曲库接口带过来）。
 *
 * ── 它**不拥有播放** ──────────────────────────────────────────────
 * 这是本文件最重要的一条，也是最容易在后续改动里丢掉的一条：
 *   声音来自 APlayer 的 `<audio>`，视频只是**跟着它走的一个表面**。
 *   - **永远 `muted`**：不静音就会有两路声音叠在一起 —— 而且不报错，
 *     听起来只是"有回声"，很难归因到这里。
 *   - **不用原生 `controls`**：那块控件里有一颗自己的播放键，与底部播放条
 *     是两个真相；用户点哪一个都"生效"，然后两边开始各说各话。
 *   - **位置跟 `player-time` 事件、播放态跟快照的 `state`**：绝不让它自己播。
 *     偏差超过 `MAX_DRIFT_SEC` 才硬拉一次 `currentTime` —— 每个 timeupdate
 *     都写一次会让浏览器不停重新 seek，画面抖得像掉帧。
 *   - **不可交互**（`pointer-events-none`）：既然播放不归它管，让它接点击
 *     就只是给"看起来能点"留位置。
 * 这几条由 `architecture.test.ts` 的「画面不拥有播放」一条钉着。
 *
 * ── 为什么加载失败要回落封面 ────────────────────────────────────────
 * `hasVideo` 是**扫描那一刻**的事实（与 `hasCover` 同一条）。盘上文件事后被删
 * 或被改名，它就过期了 —— 此时回落到 `TrackCover` 比留一块黑屏体面
 * （同 `TrackCover` 留 `onError` 的理由）。
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { TrackCover } from './TrackCover';
import { videoUrl } from './cover';
import { PLAYER_EVENTS } from './player-events';
import { usePlayerSnapshot } from './PlayerProvider';

/**
 * 画面与音频时钟的最大允许偏差（秒）。
 *
 * 取 0.35：小到看不出唇音错位，大到不会因为 timeupdate 的 250ms 粒度
 * （以及 seek 后浏览器还没站稳的那几帧）反复触发硬拉。判据是**偏差**而不是
 * "每次都同步"——后者等于每 250ms 让 `<video>` 重新 seek 一次。
 */
const MAX_DRIFT_SEC = 0.35;

type TrackVideoProps = {
	/** 曲目 id（曲库内相对路径）。视频路径不进 URL，服务端自己按 id 查。 */
	id: string;
	/** 视频失败回落封面时取首字用（与 `TrackCover` 同名同义）。 */
	title: string;
	/** 该曲目有没有内嵌封面 —— 只在回落那条路上用到。 */
	hasCover: boolean;
	/** 尺寸 / 圆角 / 阴影。渐变底与 `overflow-hidden` 由组件自理（与 `TrackCover` 一致）。 */
	className?: string;
	/** 回落首字的字号与字重（传给 `TrackCover`）。 */
	charClassName?: string;
	/**
	 * 画面怎么放进这个框：
	 *  - `cover`（默认，英雄卡那种正方形小框）：裁掉多余部分，填满；
	 *  - `contain`（全屏沉浸页）：完整放进框里，留黑边 —— 全屏时裁掉画面两侧
	 *    比留黑边难看得多。
	 */
	fit?: 'cover' | 'contain';
};

export function TrackVideo({
	id,
	title,
	hasCover,
	className = '',
	charClassName,
	fit = 'cover',
}: TrackVideoProps) {
	const snap = usePlayerSnapshot();
	const videoRef = useRef<HTMLVideoElement>(null);
	// 记「哪一首的视频失败了」，而不是一个布尔：换歌时本组件不会重新挂载，
	// 布尔会把上一首的失败状态带过来，让新歌也无缘无故走封面。
	const [failedId, setFailedId] = useState<string | null>(null);
	const isPlaying = snap.state === 'playing';

	// 位置跟随音频时钟（监听只注册一次）。
	useEffect(() => {
		const onTime = (e: Event) => {
			const t = (e as CustomEvent<number>).detail;
			const v = videoRef.current;
			if (!v || typeof t !== 'number') return;
			// 未就绪时写 currentTime 会抛（或把 seek 排队），所以先比偏差再写。
			if (Math.abs(v.currentTime - t) <= MAX_DRIFT_SEC) return;
			try {
				v.currentTime = t;
			} catch {
				/* 元数据还没到：下一帧的 timeupdate 会再试 */
			}
		};
		window.addEventListener(PLAYER_EVENTS.time, onTime);
		return () => window.removeEventListener(PLAYER_EVENTS.time, onTime);
	}, []);

	// 播放 / 暂停跟随快照。`id` 也在依赖里：换歌后 `src` 变了，得重新起播。
	useEffect(() => {
		const v = videoRef.current;
		if (!v) return;
		if (!isPlaying) {
			v.pause();
			return;
		}
		// play() 在「还没拿到元数据」或「刚被 pause 打断」时会 reject，
		// 那是正常竞态不是错误（同 APlayerPlayer 对 AbortError 的处理）。
		void v.play().catch(() => {});
	}, [isPlaying, id]);

	if (failedId === id) {
		return (
			<TrackCover
				id={id}
				title={title}
				hasCover={hasCover}
				className={className}
				charClassName={charClassName}
			/>
		);
	}

	return (
		<div className={`relative overflow-hidden bg-black ${className}`}>
			{/* 原生的 `controls` / 自动播放都不给：播放权在 APlayer 的 audio 上。
			    只看，不点（`pointer-events-none`）—— 见文件头。 */}
			<video
				ref={videoRef}
				src={videoUrl(id)}
				muted
				playsInline
				preload="metadata"
				onError={() => setFailedId(id)}
				className={`pointer-events-none absolute inset-0 h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`}
			/>
		</div>
	);
}
