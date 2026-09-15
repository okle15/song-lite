/**
 * /api/history — 播放历史读取端点。
 *
 * `GET /api/history?limit=<1..200>`，默认 20，按时间倒序（新的在前）。
 * 与写入侧 `server/records/play-log.ts` 构成唯一的一对「写—读」，
 * 表结构见 `server/db.ts`。
 */
import { recentPlays } from '@/server/records/play-log';
import { ok } from '@/server/http';

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	const raw = Number.parseInt(searchParams.get('limit') ?? '', 10);
	const plays = recentPlays(Number.isFinite(raw) ? raw : 20);
	return ok({ count: plays.length, plays });
}
