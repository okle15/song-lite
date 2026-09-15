/**
 * POST /api/radio/start — 开台。
 *
 * 启动长驻调度器：编排当前时段栏目、接管播放器队列并开播。
 * 幂等：已在播则直接返回当前状态。
 */
import { startStation } from '@/server/radio/station';
import { ok, fail } from '@/server/http';

export async function POST() {
	try {
		const data = await startStation();
		return ok(data);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
}
