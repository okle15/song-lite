/**
 * /api/playlists —— 歌单**集合**的 HTTP 面。
 *
 * 与 `/api/playlists/items` 的分工：**这一条只管「有几份、叫什么」**，
 * 曲目归另一条。分开的理由不是 REST 洁癖，而是**响应大小**：曲库大起来之后，
 * 「列出我的歌单」这个动作不该顺带把每份歌单的几百首歌都拉出来 ——
 * 而那种"顺手带上"的做法在只有几首歌时完全看不出问题。
 *
 * `POST` 可带 `trackIds`，那就是**导入**（一次把一批曲目带进来）。
 * 为什么导入走"新建"而不是"合并进已有的一份"：合并语义要回答
 * 「重复的那首算谁的」，而那件事没有唯一答案（保留旧的？用新的位置？）。
 * 新建 + 让用户自己删，比替他猜要诚实。
 *
 * ⚠️ **这里没有 PUT，是故意的**：整份替换「曲目列表」会把调用方看得见的那一页
 * 当成全部，悄悄换走其余那些（见 `contract/playlist.ts` 文件头）。
 * 改内容一律走 `items` 那条路由的追加 / 按 id 删。
 */
import { createPlaylist, deletePlaylist, getPlaylist, listPlaylists } from '@/server/library/playlists';
import { PLAYLIST_NAME_MAX, type PlaylistSummary } from '@/contract/playlist';
import { fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET /api/playlists —— 全部歌单（含每份的曲目数）。 */
export async function GET() {
	return ok({ playlists: listPlaylists() });
}

type PostBody = { name?: unknown; trackIds?: unknown };

/** POST /api/playlists —— body `{ name, trackIds? }`。带 trackIds 即导入。 */
export async function POST(request: Request) {
	let body: PostBody;
	try {
		body = (await request.json()) as PostBody;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name) return fail('name is required', 400);
	// 名字是**显示字段**不是标识，所以不查重（同名两份是合法的）。
	// 但长度要管：长名字会把界面上的按钮撑破，而截断比报错更糟（用户认不出它）。
	if (name.length > PLAYLIST_NAME_MAX) {
		return fail(`歌单名最长 ${PLAYLIST_NAME_MAX} 个字`, 400);
	}

	if (body.trackIds !== undefined && !Array.isArray(body.trackIds)) {
		return fail('trackIds 必须是数组', 400);
	}
	const trackIds = (body.trackIds ?? []).filter((x): x is string => typeof x === 'string' && x.trim() !== '');

	try {
		const playlist = createPlaylist(name, trackIds);
		return ok({ playlist }, 'created');
	} catch (err) {
		console.error('[playlists] failed to create:', err);
		return fail('歌单创建失败', 500);
	}
}

/** DELETE /api/playlists?id= —— 删掉整份歌单（连带它的曲目）。 */
export async function DELETE(request: Request) {
	const id = new URL(request.url).searchParams.get('id')?.trim();
	if (!id) return fail('id is required', 400);
	try {
		// 删之前先取一份：删完就查不到了，而「删掉了什么」值得回给调用方
		// （模型据此复述「已删掉『跑步』」，而不是干巴巴一句"已删除"）。
		const before: PlaylistSummary | null = getPlaylist(id);
		const removed = deletePlaylist(id);
		if (!removed) return fail('没有这份歌单', 404);
		return ok({ id, removed, name: before?.name ?? null }, 'deleted');
	} catch (err) {
		console.error('[playlists] failed to delete:', err);
		return fail('歌单删除失败', 500);
	}
}
