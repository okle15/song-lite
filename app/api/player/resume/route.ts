/**
 * Player resume route — 方案 C 补全。
 *
 * 从 paused 状态恢复播放。返回 409 如果当前不是 paused（无意义）。
 *
 * 续播**不记**播放历史：同一首歌接着放，不是新的一次播放。
 */
import { resume } from '@/server/player/state';
import { playerPayload } from '@/server/player/payload';
import { ok, fail } from '@/server/http';

export async function POST() {
	const updated = resume();
	if (!updated) {
		return fail('not currently paused', 409);
	}
	return ok(playerPayload(updated));
}
