/**
 * /api/library/hidden —— 屏蔽的 HTTP 面。
 *
 * 与 `/api/library/favorites` 同形（只差一个 kind），所以那边的取舍说明不重复，
 * 这里只写**屏蔽这一件事自己**最容易被做错的地方。
 *
 * ── 「屏蔽」到底屏蔽了什么（写清楚，因为这句话定义了整条链）──────────
 * 它管的是**自动来源**：曲库列出的、检索能搜到的、以及「整个曲库」这种队列里
 * 自动挑到的。它**不是一把锁**：拿着具体 id 点名要放（`play_track`）仍然放得出来。
 *
 * 为什么显式路径必须留着：`search_library` 正是「拿到 trackId 的那条路」，
 * 而它现在过滤掉了被屏蔽的歌 —— 若显式路径也堵死，被屏蔽的歌就**再也拿不到
 * id**，解封入口随之消失（红线③「解封出口不许减」）。留下的两个出口：
 *   ① agent 侧：`list_hidden` 工具（带 id 与曲名）；
 *   ② 人这一侧：曲库抽屉的「已屏蔽」视图（同一个 GET）。
 *
 * ── 屏蔽**不动当前队列**（有意的）────────────────────────────────────
 * 用户屏蔽一首正在队列里的歌时，队列一个字节都不改。理由有两条：
 *   ① 队列是**状态**（"此刻的这一批"），不是数据；对它做副作用编辑是
 *      **第二次看不见的改动** —— 而项目里已经有「只动那一项」的入口
 *      （队列卡的 × 与 `remove_from_queue`），那才是改队列的地方；
 *   ② 真去改它就会撞上 `removeFromQueue` 的「内容编辑 = 身份编辑」语义
 *      （从整库队列里去掉一项 → 整批提升为 `custom`），于是**屏蔽一首歌
 *      会让队列从此不再跟随曲库** —— 一件用户无法察觉的副作用。
 * 那么什么时候生效？下一次点播时 `/api/player/play` 会 `ensureQueue(可见曲库)`，
 * 整库队列按新的可见曲库重排，被屏蔽的那首自然就不见了。这是 `ensureQueue`
 * 本来就有的行为，不是为屏蔽新加的。
 *
 * GET 与 POST 都返回**整份清单**（理由同收藏：省掉一层会静默判错的增量合并）。
 */
import { listFlagRows } from '@/server/library/flag-rows';
import { setFlag } from '@/server/library/flags';
import { publishSnapshot } from '@/server/player/state';
import { fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET /api/library/hidden —— 全部屏蔽项。**这是解封入口的一半**（另一半是工具）。 */
export async function GET() {
	return ok({ rows: await listFlagRows('hidden') });
}

type PostBody = { trackId?: unknown; hidden?: unknown };

/** POST /api/library/hidden —— body `{ trackId, hidden }`，屏蔽 / 解除屏蔽并返回整份清单。 */
export async function POST(request: Request) {
	let body: PostBody;
	try {
		body = (await request.json()) as PostBody;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const trackId = typeof body.trackId === 'string' ? body.trackId.trim() : '';
	if (!trackId) return fail('trackId is required', 400);
	if (typeof body.hidden !== 'boolean') return fail('hidden 必须是布尔值', 400);

	try {
		const changed = setFlag('hidden', trackId, body.hidden);
		// 推一次快照：三个消费方（两个 ❤ 与抽屉的「已屏蔽」视图）都从它取值。
		if (changed) publishSnapshot();
		return ok({ rows: await listFlagRows('hidden'), changed }, changed ? 'updated' : 'unchanged');
	} catch (err) {
		console.error('[library/hidden] failed to write:', err);
		return fail('屏蔽写入失败', 500);
	}
}

/** DELETE /api/library/hidden?trackId= —— 解除屏蔽（与 POST hidden:false 等价）。 */
export async function DELETE(request: Request) {
	const trackId = new URL(request.url).searchParams.get('trackId')?.trim();
	if (!trackId) return fail('trackId is required', 400);
	try {
		const removed = setFlag('hidden', trackId, false);
		if (removed) publishSnapshot();
		return ok({ trackId, removed });
	} catch (err) {
		console.error('[library/hidden] failed to delete:', err);
		return fail('解除屏蔽失败', 500);
	}
}
