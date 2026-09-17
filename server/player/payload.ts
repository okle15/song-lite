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
import { getPlayerState, type PlayerState } from './state';

/** HTTP 响应体：前端播放控制与队列面板消费的 wire 形状。 */
export type PlayerPayload = {
	state: PlayerState['state'];
	currentTrack: PlayerState['currentTrack'];
	positionSec: number;
	queueSize: number;
	queueIndex: number;
	/** 仅队列类操作（jump / queue）附带，供队列面板重建列表。 */
	queue?: { id: string; title: string; artist: string }[];
	/**
	 * 队列的来源与名字。**带在响应里是给调用方核对的**：`/api/player/queue`
	 * 的「空数组 = 恢复整个曲库」是一条成文的规则，打错一个空数组就会静默变成
	 * "整库"——调用方（工具、冒烟脚本）据这两个字段一看就知道换成了哪一批。
	 */
	queueSource: PlayerState['queueSource'];
	queueLabel: string | null;
	/**
	 * 音量与播放方式。**带在响应里是为了让调用方能回读**：
	 * `set_volume` 报「已设为 30%」之前要确认服务端真的收到了 30%（越界会被夹紧），
	 * 报一个没生效的数字是用户当场能发现、代码却不会红的错。
	 */
	volume: PlayerState['volume'];
	mode: PlayerState['mode'];
	shuffle: PlayerState['shuffle'];
};

/** 空队列快照（next 到队尾时的合法状态：停止，但没有下一首）。 */
export function emptyQueuePayload(): PlayerPayload {
	// 音量 / 播放方式从**当前状态**读，不写死默认值：它们与「有没有下一首」
	// 无关，一场播完不该让响应体顺手把用户的音量说成 80%。
	const { volume, mode, shuffle } = getPlayerState();
	return {
		state: 'stopped',
		currentTrack: null,
		positionSec: 0,
		queueSize: 0,
		queueIndex: -1,
		queueSource: 'library',
		queueLabel: null,
		volume,
		mode,
		shuffle,
	};
}

/** 从播放态快照裁出响应体。`withQueue` 只在队列会变化的路由上开。 */
export function playerPayload(s: PlayerState, opts: { withQueue?: boolean } = {}): PlayerPayload {
	return {
		state: s.state,
		currentTrack: s.currentTrack,
		positionSec: s.positionSec,
		queueSize: s.queue.length,
		queueIndex: s.currentIndex,
		queueSource: s.queueSource,
		queueLabel: s.queueLabel,
		volume: s.volume,
		mode: s.mode,
		shuffle: s.shuffle,
		...(opts.withQueue
			? { queue: s.queue.map((t) => ({ id: t.id, title: t.title, artist: t.artist })) }
			: {}),
	};
}
