/**
 * Player pause route — 方案 C 后的实际暂停控制。
 *
 * 通过 player-state 切到 paused（前端 `<audio>` 收到 SSE 推送后暂停）。
 * 返回 409 如果当前没有播放中的曲目（暂停无意义）。
 *
 * 暂停**不记**播放历史：同一首歌接着放，不是新的一次播放。
 */
import { pause } from '@/server/player/state';
import { playerPayload } from '@/server/player/payload';
import { ok, fail } from '@/server/http';

export async function POST() {
	const updated = pause();
	if (!updated) {
		return fail('nothing is currently playing', 409);
	}
	return ok(playerPayload(updated));
}
