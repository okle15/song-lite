/**
 * player/payload — 播放控制路由的响应体与交互日志载荷（**单一出处**）。
 *
 * 这一段原先在 `app/api/player/{play,next,jump,resume,pause,remove}/route.ts`
 * 里各抄了一份（2026-09-14 收敛）。抄六份的代价不只是字数——`result` 的字段名
 * 是**契约**：`currentTrackTitle` 被前端 HistoryPanel 依赖，`currentTrackId` /
 * `queuedTrackIds` 被 Agent 的 `recent_plays` 用来还原"切完之后那一整条队列"。
 * 分头抄写意味着任何一处改了字段名，其余五处**静默失效**（消费者读到
 * `undefined`，不报错）。这跟 `contract/` 的抽取标准是同一条：
 * **出现第二个消费方就抽出来**。
 *
 * 为什么落在 `server/` 而不是 `contract/`：本文件要 `PlayerState`，而
 * `server/player/state.ts` 顶部 import 了 `node:events`——带进浏览器 bundle 是
 * 真实风险。`contract/` 要求零业务依赖，装不下它。
 */
import type { PlayerState } from './state';

/** HTTP 响应体：前端 PlayerControls / 队列面板消费的 wire 形状。 */
export type PlayerPayload = {
	state: PlayerState['state'];
	currentTrack: PlayerState['currentTrack'];
	positionSec: number;
	queueSize: number;
	queueIndex: number;
	/** 仅队列类操作（jump / remove）附带，供队列面板重建列表。 */
	queue?: { id: string; title: string; artist: string }[];
};

/** 空队列快照（next 到队尾时的合法状态：停止，但没有下一首）。 */
export function emptyQueuePayload(): PlayerPayload {
	return { state: 'stopped', currentTrack: null, positionSec: 0, queueSize: 0, queueIndex: -1 };
}

/** 从播放态快照裁出响应体。`withQueue` 只在队列会变化的路由上开。 */
export function playerPayload(s: PlayerState, opts: { withQueue?: boolean } = {}): PlayerPayload {
	return {
		state: s.state,
		currentTrack: s.currentTrack,
		positionSec: s.positionSec,
		queueSize: s.queue.length,
		queueIndex: s.currentIndex,
		...(opts.withQueue
			? { queue: s.queue.map((t) => ({ id: t.id, title: t.title, artist: t.artist })) }
			: {}),
	};
}

/**
 * 写进 `logs.db` 的操作结果 —— 历史面板与 Agent 时间锚点的**共同数据源**。
 *
 * 字段名是契约，别顺手改：`currentTrackTitle` 给 HistoryPanel，
 * `currentTrackId` / `queuedTrackIds` 记录这一轮实际涉及的曲目。
 * `extra` 用于 `jump` 的 `jumpedFromIndex`、`pause` 的 `positionSec`
 * 这类只有单个路由才有的字段。
 */
export function playerLogResult(
	s: PlayerState,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		state: s.state,
		currentTrackTitle: s.currentTrack?.title,
		currentTrackId: s.currentTrack?.id,
		currentTrackArtist: s.currentTrack?.artist,
		currentTrackAlbum: s.currentTrack?.album,
		queuedTrackIds: s.queue.map((t) => t.id),
		queueIndex: s.currentIndex,
		...extra,
	};
}
