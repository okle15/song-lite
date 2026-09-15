/**
 * Player play route — 方案 C 后的实际播放控制。
 *
 * 接收 `{ trackId }`，调用 player-state 切换当前曲目（前端 `<audio>` 收到
 * SSE 推送后自动拉流播放）。返回 404 如果 trackId 不在库中。
 *
 * 切歌成功即往 `plays` 表记一行播放历史（见 `server/records/play-log.ts`）。
 */
import { getSongs, findSongById } from '@/server/library';
import { playTrackById, getPlayerState, ensureQueue } from '@/server/player/state';
import { playerPayload } from '@/server/player/payload';
import { recordPlay } from '@/server/records/play-log';
import { ok, fail } from '@/server/http';

export async function POST(request: Request) {
	let body: { trackId?: unknown };
	try {
		body = await request.json();
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const trackId = typeof body.trackId === 'string' ? body.trackId : '';
	if (!trackId) {
		return fail('trackId is required', 400);
	}

	// Sync the player queue with the actual library.
	const songs = await getSongs();
	ensureQueue(songs);

	if ((await findSongById(trackId)) === undefined) {
		return fail(`track not found: ${trackId}`, 404);
	}

	const updated = playTrackById(trackId);
	if (!updated) {
		return fail(`track not in queue: ${trackId}`, 404);
	}

	const track = updated.currentTrack;
	if (track) recordPlay({ id: track.id, title: track.title, artist: track.artist });

	return ok(playerPayload(updated));
}

export async function GET() {
	// 仅供轮询读取当前状态，不是用户动作，因此不记历史。
	return ok(playerPayload(getPlayerState()));
}
