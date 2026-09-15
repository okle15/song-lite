/**
 * Player next-track route — 方案 C 后的实际切歌控制。
 *
 * 跳到队列下一首（前端 `<audio>` 收到 SSE 推送后切 src 拉流）。
 * 队列耗尽时返回 `state: "stopped"`。始终返回 200——跳过末尾是合法状态转换。
 */
import { nextTrack } from '@/server/player/state';
import { emptyQueuePayload, playerLogResult, playerPayload } from '@/server/player/payload';
import { recordLocalInteraction } from '@/server/records/interaction-log';
import { ok } from '@/server/http';

export async function POST() {
	const startedAt = Date.now();
	const updated = nextTrack();
	if (!updated) {
		// 队列为空，无下一首可跳。
		return ok(emptyQueuePayload(), 'queue empty');
	}
	void recordLocalInteraction({
		userInput: 'next',
		intent: 'next',
		result: playerLogResult(updated),
		latency: Date.now() - startedAt,
	});
	return ok(playerPayload(updated));
}
