/**
 * Player play route — 方案 C 后的实际播放控制。
 *
 * 接收 `{ trackId }`，调用 player-state 切换当前曲目（前端 `<audio>` 收到
 * SSE 推送后自动拉流播放）。返回 404 如果 trackId 不在库中。
 *
 * 「队列里没有这一首」**不是错误**：它会被追加到队尾（详见 state.ts 的
 * `playTrack`）。这条分支是「按条件组队列」上线后才存在的——从前队列恒等于
 * 整库，这个问题不可能发生。
 *
 * 切歌成功即往 `plays` 表记一行播放历史（见 `server/records/play-log.ts`）。
 */
import { getSongs, findSongById } from '@/server/library';
import { playTrack, getPlayerState, ensureQueue } from '@/server/player/state';
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

	// Sync the player queue with the actual library（自定义队列会被它让过，见 state.ts）。
	const songs = await getSongs();
	ensureQueue(songs);

	const song = await findSongById(trackId);
	if (song === undefined) {
		return fail(`track not found: ${trackId}`, 404);
	}

	const updated = playTrack(song);

	const track = updated.currentTrack;
	if (track) recordPlay({ id: track.id, title: track.title, artist: track.artist });

	return ok(playerPayload(updated));
}

export async function GET() {
	// 仅供轮询读取当前状态，不是用户动作，因此不记历史。
	return ok(playerPayload(getPlayerState()));
}
