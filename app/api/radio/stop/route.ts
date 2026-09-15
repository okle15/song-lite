/**
 * POST /api/radio/stop — 收播。
 *
 * 停掉调度心跳、归档当前节目到长期记忆。播放器保持现状
 * （正在放的歌继续放，电台不再推进）。
 */
import { stopStation } from '@/server/radio/station';
import { ok, fail } from '@/server/http';

export async function POST() {
	try {
		const data = stopStation();
		return ok(data);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
}
