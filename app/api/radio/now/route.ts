/**
 * GET /api/radio/now — 电台状态面。
 *
 * 「嵌入传统前后端」的示范接口：任何客户端（本站前端、curl、别的后端、
 * 直播间挂件）轮询这里就能拿到 电台开关 / 当前栏目 / 排片与打分依据 /
 * DJ 口播 / 记忆概况。不依赖任何 agent 运行时。
 */
import { getStatusDetailed } from '@/server/radio/station';
import { ok, fail } from '@/server/http';

export async function GET() {
	try {
		const data = await getStatusDetailed();
		return ok(data);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
}
