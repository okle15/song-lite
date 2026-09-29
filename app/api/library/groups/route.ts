/**
 * /api/library/groups —— 曲库分组的 HTTP 面。
 *
 * 两种形状，与 `/api/library/tags` 的 GET 同形：
 *   `?by=artist|album|tag`            → 分桶结果（各组与每组几首）
 *   `?by=…&key=…&limit=&offset=`     → **某一个组里的曲目**
 *
 * ── 为什么分桶在这里做（不在前端）─────────────────────────────────────
 * 前端只有一页（limit 12/50），拿它分桶得到的是「这一页里有哪几个歌手」，
 * 说出来却是「按歌手（N 组）」——**把「本页」说成「全部」**。分桶的真相在整库上。
 * 判据写在 `contract/library-groups.ts` 的文件头。
 *
 * ── 为什么 `by` 非法要 400 而不是回落成 `artist` ───────────────────────
 * 静默回落会让调用方以为「我传的维度生效了」，而它看的是另一份分组。
 * 分组是**浏览**，看错维度不会报错、只会让人得出错误印象（「我库里只有这两个
 * 歌手」）。参数错一律 400 = 模型换个说法就能改（与 tasks 路由同一条口径）。
 *
 * ── `key` 用 `has()` 判而不是判空串 ────────────────────────────────────
 * `tag` 维度下「未打标」那一组的 key 就是**空串**。用 `key === ''` 判"没传"
 * 会让这一组永远取不到 —— 而它恰恰是打标脚本最需要的那一组。
 */
import { isGroupBy } from '@/contract/library-groups';
import { getGroupTracks, getLibraryGroups, GROUP_LIMIT_MAX } from '@/server/library/groups';
import { fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);

	const by = searchParams.get('by');
	if (!isGroupBy(by)) {
		return fail(`by 必须是 artist / album / tag 之一（收到 ${JSON.stringify(by)}）`, 400);
	}

	// 没传 key = 只要分组清单。
	if (!searchParams.has('key')) return ok(await getLibraryGroups(by));

	const key = searchParams.get('key') ?? '';
	const limitParam = searchParams.get('limit');
	const limit = limitParam
		? Math.min(Math.max(Number.parseInt(limitParam, 10) || 20, 1), GROUP_LIMIT_MAX)
		: 20;
	const offsetParam = searchParams.get('offset');
	const offset = offsetParam ? Math.max(Number.parseInt(offsetParam, 10) || 0, 0) : 0;

	return ok(await getGroupTracks(by, key, limit, offset));
}
