/**
 * 歌单的读写点（表结构在 `server/db.ts`）。
 *
 * ── 这个文件最重要的决定：**没有「整表替换」的入口** ──────────────────
 * 写侧只有两个动作：`addPlaylistTracks()`（追加）与 `removePlaylistTrack()`
 * （**按 id 删那一行**）。刻意不提供 `setPlaylistTracks(id, ids)`。
 *
 * 理由是项目里反复出事的那一族（`MEMORY.md` §2.4）：
 *
 *     调用方（尤其是模型）只看得到清单的**一页**。给它一个"把这一批写回去"的
 *     入口，它会把自己看得见的那部分当成全部 —— 用户原来那一整批被悄悄换走，
 *     而**两次都不报错**。判据：每个内容编辑都要有一个只动那一项的入口。
 *
 * 「去掉一首」还额外有一条：**不许拿「换一批」代替**。所以删只收 `trackId`
 * （最坏 404，调用方看得见），**不收下标** —— 下标是"某一份视图"里的位置，
 * 视图一变就指到另一首歌（同一族的另一半见 `remove_from_queue`）。
 *
 * ── 失败语义 ──────────────────────────────────────────────────────
 * 与 `favorites` / `hidden` 同侧：**写失败要抛**（agent 说了「建好了」就该真有）。
 * 读侧同样 fail-open 吗？**不** —— 这里读失败也抛：歌单读不出来时，界面显示
 * 「读不到歌单」比显示「你还没有歌单」诚实（后者会让用户以为自己的歌单没了），
 * 而曲库那侧之所以要 fail-open，是因为它错了会让**整个曲库打不开**。
 * 同样是读失败，后果不同 → 取舍不同。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import type { PlaylistAddResult, PlaylistDetail, PlaylistSummary, PlaylistTrack } from '../../contract/playlist';
import { getAllSongs } from './index';

type PlaylistRow = { id: string; name: string; created_at: string; updated_at: string };
type ItemRow = { track_id: string; position: number };

/** 一批的行 → 带曲名的条目。**曲名现查**（曲库不落库，真相在文件系统上）。 */
async function withTitles(rows: ItemRow[]): Promise<PlaylistTrack[]> {
	if (rows.length === 0) return [];
	const byId = new Map((await getAllSongs()).map((s) => [s.id, s]));
	return rows.map((r) => {
		const song = byId.get(r.track_id);
		return {
			trackId: r.track_id,
			title: song?.title ?? r.track_id,
			artist: song?.artist ?? '',
			missing: !song,
		};
	});
}

/** 全部歌单，按创建时间升序。**计数用 SQL 数**，不是"我这次取了几条"。 */
export function listPlaylists(): PlaylistSummary[] {
	const rows = getDb()
		.prepare(
			`SELECT p.id, p.name, p.created_at, p.updated_at, COUNT(i.track_id) AS count
			 FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id = p.id
			 GROUP BY p.id ORDER BY p.created_at, p.id`,
		)
		.all() as unknown as (PlaylistRow & { count: number })[];
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		count: r.count,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	}));
}

/** 一份歌单的摘要（找不到返回 null）。 */
export function getPlaylist(id: string): PlaylistSummary | null {
	const row = getDb()
		.prepare(
			`SELECT p.id, p.name, p.created_at, p.updated_at, COUNT(i.track_id) AS count
			 FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id = p.id
			 WHERE p.id = ? GROUP BY p.id`,
		)
		.get(id) as unknown as (PlaylistRow & { count: number }) | undefined;
	if (!row) return null;
	return { id: row.id, name: row.name, count: row.count, createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * 新建歌单。`trackIds` 可选 —— **给了就是「导入」**（一次带一批进来）。
 *
 * 名字允许重复（它不是标识），但**空名字不行**：一份没有名字的歌单在界面上
 * 就是一行空白，用户认不出它。
 */
export function createPlaylist(name: string, trackIds: readonly string[] = [], opts: { at?: Date } = {}): PlaylistSummary {
	const at = (opts.at ?? new Date()).toISOString();
	const id = randomUUID();
	const db = getDb();
	db.prepare('INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, at, at);
	// 位置从 0 起自增；`addPlaylistTracks` 也用它，所以两者的语义一致。
	const insert = db.prepare(
		'INSERT INTO playlist_items (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
	);
	trackIds.forEach((trackId, i) => insert.run(id, trackId, i, at));
	return { id, name, count: new Set(trackIds).size, createdAt: at, updatedAt: at };
}

/** 删掉整份歌单（连带它的曲目）。返回有没有真的删掉。 */
export function deletePlaylist(id: string): boolean {
	const db = getDb();
	const res = db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
	// 曲目一起清：留着就是孤儿行（没有歌单认领它们，却永远占着计数）。
	db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id);
	return res.changes === 1;
}

/** 追加曲目。**幂等**：已经在这份里的跳过（`skipped`），不算失败。 */
export function addPlaylistTracks(
	id: string,
	trackIds: readonly string[],
	opts: { at?: Date } = {},
): PlaylistAddResult {
	if (!getPlaylist(id)) throw new Error(`歌单不存在：${id}`);
	const at = (opts.at ?? new Date()).toISOString();
	const db = getDb();
	const next = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM playlist_items WHERE playlist_id = ?').get(id) as unknown as { pos: number };
	const insert = db.prepare(
		'INSERT INTO playlist_items (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
	);
	const touch = db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?');

	let added = 0;
	let skipped = 0;
	let pos = next.pos;
	// 同一批里重复出现的 id 也只算一次（`ON CONFLICT` 不会报，但计数会虚高）。
	const seen = new Set<string>();
	for (const raw of trackIds) {
		const trackId = raw.trim();
		if (!trackId || seen.has(trackId)) {
			if (trackId) skipped += 1;
			continue;
		}
		seen.add(trackId);
		const res = insert.run(id, trackId, pos, at);
		if (res.changes === 1) {
			added += 1;
			pos += 1;
		} else {
			skipped += 1;
		}
	}
	if (added > 0) touch.run(at, id);
	return { added, skipped };
}

/**
 * 从歌单里**删一首**。返回有没有真的删掉（本来就没有 = false，**不是失败**）。
 *
 * ⚠️ 只收 `trackId`。收下标的那一天就是「删掉另一首歌」的那一天 ——
 * 下标是某一份视图里的位置，而视图会变（排序 / 过滤 / 翻页）。
 */
export function removePlaylistTrack(id: string, trackId: string): boolean {
	const res = getDb()
		.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND track_id = ?')
		.run(id, trackId);
	if (res.changes === 1) {
		getDb().prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
	}
	return res.changes === 1;
}

/** 一份歌单的详情（含曲目，带曲名）。找不到返回 null。 */
export async function getPlaylistDetail(id: string): Promise<PlaylistDetail | null> {
	const summary = getPlaylist(id);
	if (!summary) return null;
	const rows = getDb()
		.prepare('SELECT track_id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position, track_id')
		.all(id) as unknown as ItemRow[];
	return { ...summary, tracks: await withTitles(rows) };
}
