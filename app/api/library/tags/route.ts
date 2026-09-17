/**
 * /api/library/tags —— 曲目风格标签的 HTTP 面。
 *
 * 为什么标签要经路由、而不是让 agent 直接改库：与 `/api/preferences` 同一理由 ——
 * agent 的工具一律用 HTTP 打自家 BFF，**agent 与浏览器因此共用同一个 API 面**。
 * 将来前端加「改标签」的入口，走的是同一条路径、同一套校验、同一个信封。
 *
 * **`source` 在这层定死，不由请求体传**：
 *   POST 走 HTTP = 有人在说话 → `'user'`（无条件覆盖 AI）；
 *   AI 打标是离线的批处理（`scripts/auto-tag.mts`，`npm run tag:library`），直接调
 *   `server/library/tags.ts`，不经过这里。
 * 这样「这行是谁写的」就不是一个调用方可以随口声明的字段 —— 它由**入口**决定。
 *
 * 校验分工：形状（trackId / tags 给全没有）在这里判，错就 400；
 * 归一化（拆词 / 小写 / 去重 / 排序）在 `contract/track-tags.ts`，不在这里另写一份。
 * 存储层异常一律 500 —— **不吞掉**：标签是 agent 对用户的承诺。
 */
import { normalizeTags } from '@/contract/track-tags';
import { getTrackTags, listTrackTags, removeTrackTags, setTrackTags } from '@/server/library/tags';
import { fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET /api/library/tags —— 全部标签；带 `?trackId=` 则只取那一条。 */
export async function GET(request: Request) {
	const trackId = new URL(request.url).searchParams.get('trackId');
	if (trackId) {
		return ok({ tag: getTrackTags(trackId) });
	}
	return ok({ tags: listTrackTags() });
}

type PostBody = { trackId?: unknown; tags?: unknown };

/** POST /api/library/tags —— 重设某首歌的标签。body `{ trackId, tags }`，tags 可为字符串或数组。 */
export async function POST(request: Request) {
	let body: PostBody;
	try {
		body = (await request.json()) as PostBody;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const trackId = typeof body.trackId === 'string' ? body.trackId.trim() : '';
	if (!trackId) return fail('trackId is required', 400);

	const raw = body.tags;
	const input =
		typeof raw === 'string'
			? raw
			: Array.isArray(raw)
				? raw.filter((one): one is string => typeof one === 'string')
				: null;
	if (input === null) return fail('tags 必须是字符串或字符串数组', 400);

	const tags = normalizeTags(input);
	if (tags.length === 0) return fail('至少要给一个标签', 400);

	try {
		const { current } = setTrackTags(trackId, tags, 'user');
		return ok({ tag: current }, 'updated');
	} catch (err) {
		console.error('[library/tags] failed to write:', err);
		return fail('标签写入失败', 500);
	}
}

/** DELETE /api/library/tags?trackId= —— 清掉一首歌的标签（回到「没有标签」）。 */
export async function DELETE(request: Request) {
	const trackId = new URL(request.url).searchParams.get('trackId')?.trim();
	if (!trackId) return fail('trackId is required', 400);
	try {
		return ok({ trackId, removed: removeTrackTags(trackId) });
	} catch (err) {
		console.error('[library/tags] failed to delete:', err);
		return fail('标签删除失败', 500);
	}
}
