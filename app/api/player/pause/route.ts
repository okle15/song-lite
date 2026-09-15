/**
 * Player pause route — 方案 C 后的实际暂停控制。
 *
 * 通过 player-state 切到 paused（前端 `<audio>` 收到 SSE 推送后暂停）。
 * 返回 409 如果当前没有播放中的曲目（暂停无意义）。
 */
import { pause, getPlayerState } from '@/server/player/state';
import { playerLogResult, playerPayload } from '@/server/player/payload';
import { recordLocalInteraction } from '@/server/records/interaction-log';
import { ok, fail } from '@/server/http';

export async function POST() {
	const startedAt = Date.now();
	const updated = pause();
	if (!updated) {
		void recordLocalInteraction({
			userInput: 'pause',
			intent: 'pause',
			errorTag: 'nothing_playing',
			result: { state: getPlayerState().state },
			latency: Date.now() - startedAt,
		});
		return fail('nothing is currently playing', 409);
	}
	void recordLocalInteraction({
		userInput: 'pause',
		intent: 'pause',
		// 暂停也算"播放事件"，记下当时在播什么、听到哪（给"我上次听到哪停的"等回放意图用）。
		result: playerLogResult(updated, { positionSec: updated.positionSec }),
		latency: Date.now() - startedAt,
	});
	return ok(playerPayload(updated));
}
