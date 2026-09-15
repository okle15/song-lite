/**
 * player/payload — 播放控制路由的**响应体**（单一出处）。
 *
 * 这一段原先在 `app/api/player/{play,next,jump,resume,pause}/route.ts` 里各抄一份，
 * 抄多份的代价不只是字数——字段名是**契约**，前端 `PlayerBar` / `QueueList` /
 * `NowPlaying` 都按它取值。分头抄写意味着任何一处改了字段名，其余几处**静默失效**
 * （消费者读到 `undefined`，不报错）。抽取标准和 `contract/` 一致：
 * **出现第二个消费方就抽出来**。
 *
 * 为什么落在 `server/` 而不是 `contract/`：本文件要 `PlayerState`，而
 * `server/player/state.ts` 顶部 import 了 `node:events`——带进浏览器 bundle 是
 * 真实风险。`contract/` 要求零业务依赖，装不下它。
 */
import type { PlayerState } from './state';

/** HTTP 响应体：前端播放控制与队列面板消费的 wire 形状。 */
export type PlayerPayload = {
	state: PlayerState['state'];
	currentTrack: PlayerState['currentTrack'];
	positionSec: number;
	queueSize: number;
	queueIndex: number;
	/** 仅队列类操作（jump）附带，供队列面板重建列表。 */
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
