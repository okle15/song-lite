/**
 * Library search route —— 薄适配层。
 *
 * `GET /api/library/search?q=<query>&limit=<1..50>&offset=<n>`，
 * limit 默认 10、上限 50；offset 默认 0。空 `q` 返回整库——曲库抽屉的首屏就靠它。
 * 匹配规则在 `server/library/search.ts`，路由只做「解析参数 → 调域逻辑 → 包信封」。
 */
import { searchLibrary } from '@/server/library/search';
import { ok } from '@/server/http';

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	const q = (searchParams.get('q') ?? '').trim().toLowerCase();
	const limitParam = searchParams.get('limit');
	const limit = limitParam ? Math.min(Math.max(Number.parseInt(limitParam, 10) || 10, 1), 50) : 10;
	// 翻页位置。负数无意义，夹到 0 —— 而不是 400：调用方（工具）传了个 -
	// 之类的脏值时，给第一页比给一个错误更能让对话继续下去。
	const offsetParam = searchParams.get('offset');
	const offset = offsetParam ? Math.max(Number.parseInt(offsetParam, 10) || 0, 0) : 0;

	return ok(await searchLibrary(q, limit, offset));
}
