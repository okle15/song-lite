/**
 * Player play route — 方案 C 后的实际播放控制。
 *
 * 接收 `{ trackId }`，调用 player-state 切换当前曲目（前端 `<audio>` 收到
 * SSE 推送后自动拉流播放）。返回 404 如果 trackId 不在库中。
 */
import { getSongs, findSongById } from '@/server/library';
import { playTrackById, getPlayerState, ensureQueue } from '@/server/player/state';
import { playerLogResult, playerPayload } from '@/server/player/payload';
import { recordLocalInteraction } from '@/server/records/interaction-log';
import { ok, fail } from '@/server/http';

export async function POST(request: Request) {
	const startedAt = Date.now();
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

	// Sync the player queue with the actual library (Phase 7: scanned or mock).
	const songs = await getSongs();
	ensureQueue(songs);

	if ((await findSongById(trackId)) === undefined) {
		return fail(`track not found: ${trackId}`, 404);
	}

	const updated = playTrackById(trackId);
	if (!updated) {
		return fail(`track not in queue: ${trackId}`, 404);
	}

	void recordLocalInteraction({
		userInput: `play ${trackId}`,
		intent: 'play',
		result: playerLogResult(updated),
		latency: Date.now() - startedAt,
	});

	return ok(playerPayload(updated));
}

export async function GET() {
	// Polling read (PlayerControls refreshes every 3s) — not a user action,
	// so not logged to the interaction log to avoid flooding it.
	return ok(playerPayload(getPlayerState()));
}
