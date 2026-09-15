/**
 * Player next-track route — 方案 C 后的实际切歌控制。
 *
 * 跳到队列下一首（前端 `<audio>` 收到 SSE 推送后切 src 拉流）。
 * 队列耗尽时返回 `state: "stopped"`。始终返回 200——跳过末尾是合法状态转换。
 *
 * 切歌成功即记一行播放历史；跳到队尾（`currentTrack` 为空）不记。
 */
import { nextTrack } from '@/server/player/state';
import { emptyQueuePayload, playerPayload } from '@/server/player/payload';
import { recordPlay } from '@/server/records/play-log';
import { ok } from '@/server/http';

export async function POST() {
	const updated = nextTrack();
	if (!updated || !updated.currentTrack) {
		// 队列为空 / 已到队尾，无下一首可跳。
		return ok(emptyQueuePayload(), 'queue empty');
	}
	const track = updated.currentTrack;
	recordPlay({ id: track.id, title: track.title, artist: track.artist });
	return ok(playerPayload(updated));
}
