/**
 * /api/library/favorites —— 收藏的 HTTP 面。
 *
 * 为什么收藏要走路由、而不是像从前那样躺在 `localStorage` 里：
 * **收藏是「人的偏好」，不是「设备的事实」**。存本机的后果是服务端与 agent
 * 完全看不见它 —— 既答不了「我收藏了哪些」，也没法说「帮你收起来了」。
 * 走路由之后 `/api/library/favorites` 与 `/api/library/hidden` 同形，
 * 谁在说话都走同一条路（agent 的工具也一样，见 `agent/tools.ts` 的文件头）。
 *
 * `GET` 返回**整份清单**、`POST` 也返回**整份清单**（不是只回改的那一条）：
 * 写入即真相，调用方拿到就能整份替换本地状态，省掉一层「增量怎么合并」的
 * 判断 —— 而那一层判错时**不会报错**（列表悄悄与服务端不一致）。
 *
 * 校验分工：形状（trackId 给了没有、favorite 是不是布尔）在这里判，错就 400；
 * 语义（同 id 覆盖、写失败要抛）在 `server/library/flags.ts`。
 * 存储层异常一律 500 —— **不吞掉**：收藏是 agent 对用户的承诺。
 */
import { listFlagRows } from '@/server/library/flag-rows';
import { setFlag } from '@/server/library/flags';
import { publishSnapshot } from '@/server/player/state';
import { fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET /api/library/favorites —— 全部收藏（含文件已不在曲库里的那些）。 */
export async function GET() {
	return ok({ rows: await listFlagRows('favorite') });
}

type PostBody = { trackId?: unknown; favorite?: unknown };

/** POST /api/library/favorites —— body `{ trackId, favorite }`，写单个标记并返回整份清单。 */
export async function POST(request: Request) {
	let body: PostBody;
	try {
		body = (await request.json()) as PostBody;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const trackId = typeof body.trackId === 'string' ? body.trackId.trim() : '';
	if (!trackId) return fail('trackId is required', 400);
	if (typeof body.favorite !== 'boolean') return fail('favorite 必须是布尔值', 400);

	try {
		// `changed: false` = 「本来就是这个状态」。**不是失败**，调用方照旧拿全量清单。
		// 回一句「没有变化」而不是当成错误，理由与 `set_track_tags` 里那条一致：
		// 幂等是常态（用户连点两次、两个设备各点一次），把常态报成失败会推着
		// 调用方去编一个补救动作，而这里什么都不用做。
		const changed = setFlag('favorite', trackId, body.favorite);
		// 只推那一次**真的改了**的（`changed === false` 时快照一模一样，
		// 再推一次只是让所有客户端白重绘一遍）。
		if (changed) publishSnapshot();
		return ok({ rows: await listFlagRows('favorite'), changed }, changed ? 'updated' : 'unchanged');
	} catch (err) {
		console.error('[library/favorites] failed to write:', err);
		return fail('收藏写入失败', 500);
	}
}

/** DELETE /api/library/favorites?trackId= —— 取消收藏。 */
export async function DELETE(request: Request) {
	const trackId = new URL(request.url).searchParams.get('trackId')?.trim();
	if (!trackId) return fail('trackId is required', 400);
	try {
		const removed = setFlag('favorite', trackId, false);
		if (removed) publishSnapshot();
		return ok({ trackId, removed });
	} catch (err) {
		console.error('[library/favorites] failed to delete:', err);
		return fail('收藏取消失败', 500);
	}
}
