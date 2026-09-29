/**
 * /api/playlists/items —— **歌单内容**的 HTTP 面（追加 / 按 id 删 / 读）。
 *
 * ── 这一条路由存在的全部理由：**每个内容编辑都要有一个只动那一项的入口** ──
 * 加一首 = 追加一行；去掉一首 = 删那一行（按 `trackId`）。
 * 于是「改内容」这件事**不需要**经过「把整份清单重写一遍」。
 *
 * 为什么这条这么要紧：调用方（尤其是模型）只看得到清单的一页。给它一个
 * "写回这一批"的入口，它会把自己看得见的那部分当成全部 —— 用户的歌单被悄悄
 * 换走，而**两次都不报错**（`MEMORY.md` §2.4 的同一条）。
 *
 * ── 删只收 `trackId`，不收下标 ──────────────────────────────────────
 * 下标是"某一份视图"里的位置：排序 / 过滤 / 翻页一变，它就指到另一首歌，
 * 于是**删掉的是另一首**，且不报错。用 id 的最坏结果是 404 —— 看得见。
 * （同一族的另一半见 `remove_from_queue`。）
 *
 * `missing` 的条目**照旧列出**：文件被改名 / 移走之后，用户该看见「这份歌单里
 * 有一首已经不在了」，而不是它凭空消失。
 */
import { addPlaylistTracks, getPlaylistDetail, removePlaylistTrack } from '@/server/library/playlists';
import { fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET /api/playlists/items?id= —— 一份歌单的曲目（带曲名）。 */
export async function GET(request: Request) {
	const id = new URL(request.url).searchParams.get('id')?.trim();
	if (!id) return fail('id is required', 400);
	try {
		const playlist = await getPlaylistDetail(id);
		if (!playlist) return fail('没有这份歌单', 404);
		return ok({ playlist });
	} catch (err) {
		console.error('[playlists/items] failed to read:', err);
		return fail('歌单读取失败', 500);
	}
}

type PostBody = { id?: unknown; trackIds?: unknown };

/** POST /api/playlists/items —— body `{ id, trackIds }`。追加，**幂等**。 */
export async function POST(request: Request) {
	let body: PostBody;
	try {
		body = (await request.json()) as PostBody;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const id = typeof body.id === 'string' ? body.id.trim() : '';
	if (!id) return fail('id is required', 400);
	if (!Array.isArray(body.trackIds)) return fail('trackIds 必须是数组', 400);
	const trackIds = body.trackIds.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
	if (trackIds.length === 0) return fail('trackIds 不能是空数组（删请用 DELETE）', 400);

	try {
		const result = addPlaylistTracks(id, trackIds);
		const playlist = await getPlaylistDetail(id);
		if (!playlist) return fail('没有这份歌单', 404);
		// `skipped` 不是失败：重复添加是常态（点两次、两个入口各加一次）。
		// 把它报成失败会推着调用方去编一个补救动作，而这里什么都不用做。
		return ok({ playlist, ...result }, result.added > 0 ? 'added' : 'unchanged');
	} catch (err) {
		console.error('[playlists/items] failed to add:', err);
		return fail('加入歌单失败', 500);
	}
}

/** DELETE /api/playlists/items?id=&trackId= —— 从歌单里去掉**这一首**。 */
export async function DELETE(request: Request) {
	const sp = new URL(request.url).searchParams;
	const id = sp.get('id')?.trim();
	const trackId = sp.get('trackId')?.trim();
	if (!id) return fail('id is required', 400);
	if (!trackId) return fail('trackId is required（只按 id 删，不接受位置）', 400);

	try {
		const removed = removePlaylistTrack(id, trackId);
		const playlist = await getPlaylistDetail(id);
		if (!playlist) return fail('没有这份歌单', 404);
		// `removed: false` = 这份歌单里本来就没有它。**不是失败**，但也不许说成"已删除"。
		return ok({ trackId, removed, playlist }, removed ? 'removed' : 'unchanged');
	} catch (err) {
		console.error('[playlists/items] failed to remove:', err);
		return fail('从歌单里去掉失败', 500);
	}
}
