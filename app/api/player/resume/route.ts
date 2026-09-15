/**
 * Player resume route — 方案 C 补全。
 *
 * 从 paused 状态恢复播放。返回 409 如果当前不是 paused（无意义）。
 */
import { resume, getPlayerState } from '@/server/player/state';
import { playerLogResult, playerPayload } from '@/server/player/payload';
import { recordLocalInteraction } from '@/server/records/interaction-log';
import { ok, fail } from '@/server/http';

export async function POST() {
	const startedAt = Date.now();
	const updated = resume();
	if (!updated) {
		void recordLocalInteraction({
			userInput: 'resume',
			intent: 'resume',
			errorTag: 'not_paused',
			result: { state: getPlayerState().state },
			latency: Date.now() - startedAt,
		});
		return fail('not currently paused', 409);
	}
	void recordLocalInteraction({
		userInput: 'resume',
		intent: 'resume',
		result: playerLogResult(updated),
		latency: Date.now() - startedAt,
	});
	return ok(playerPayload(updated));
}
