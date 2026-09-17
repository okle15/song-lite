/**
 * /api/player/queue —— **换一批队列**（BLUEPRINT 阶段 3d 的落点）。
 *
 * 在这条路由出现之前，队列只有一种形态：整个曲库（每次点播都由 `ensureQueue`
 * 同步回来）。于是「来点安静的」只能搜一首播一首，`next_track` 转眼又跑回整库
 * 顺序——队列不是「用户此刻想听的那一批」，只是一个书签。
 *
 * 两种入参，两种语义：
 *   `{ trackIds: [...] }` → 自定义队列（`source: 'custom'`，附 `label`）
 *   `{ trackIds: [] }` 或省略 → **恢复整个曲库**（`source: 'library'`）
 *
 * 「空数组 = 恢复整库」是一条**成文的规则**，不是巧合：`'library'` 就是「没有
 * 条件」的那一批，用空条件表达它比再发明一个 `{ all: true }` 少一个概念。
 * 代价是打错一个空数组会静默变成"整库"——所以响应体里回报了 `queueSource` 与
 * `queueSize`，调用方（工具）据此把结果复述出来，看的人立刻能发现不对。
 *
 * **本路由不解析条件**（不做 `q=安静` 这种事）：条件 → 曲目列表是
 * `/api/library/search` 的职责，一个请求里塞两种职责就没人说得清
 * 「为什么这条路由会懂标签」。工具负责先搜后组（见 `agent/tools.ts`）。
 */
import { getSongs, findSongById, type Song } from '@/server/library';
import { setQueueAndPlay } from '@/server/player/state';
import { playerPayload } from '@/server/player/payload';
import { recordPlay } from '@/server/records/play-log';
import { ok, fail } from '@/server/http';

type Body = { trackIds?: unknown; label?: unknown };

export async function POST(request: Request) {
	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const raw = body.trackIds;
	if (raw !== undefined && !Array.isArray(raw)) {
		return fail('trackIds 必须是数组（空数组表示恢复整个曲库）', 400);
	}
	const label = typeof body.label === 'string' ? body.label : null;

	// ── 恢复整库 ──
	if (raw === undefined || raw.length === 0) {
		const songs = await getSongs();
		const updated = setQueueAndPlay(songs, { label: null, source: 'library' });
		if (!updated) return fail('曲库是空的，没有可播放的内容', 409);
		const track = updated.currentTrack;
		if (track) recordPlay({ id: track.id, title: track.title, artist: track.artist });
		return ok(playerPayload(updated, { withQueue: true }), 'queue reset to library');
	}

	// ── 自定义队列：把 id 解析成曲目。**库里找不到的丢掉并计数**，不报 404 ——
	// 一批里有一首失效不该让整批失败（曲库是活的，扫描期间的增删都正常）。
	const ids = raw.filter((id): id is string => typeof id === 'string');
	const resolved: Song[] = [];
	const missing: string[] = [];
	for (const id of ids) {
		const song = await findSongById(id);
		if (song) resolved.push(song);
		else missing.push(id);
	}
	if (resolved.length === 0) {
		return fail('这批曲目一首都不在曲库里', 404);
	}

	const updated = setQueueAndPlay(resolved, { label, source: 'custom' });
	if (!updated) return fail('队列不能为空', 400);
	const track = updated.currentTrack;
	if (track) recordPlay({ id: track.id, title: track.title, artist: track.artist });

	return ok({ ...playerPayload(updated, { withQueue: true }), missing }, 'queue replaced');
}
