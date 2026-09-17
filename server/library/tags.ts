/**
 * 曲目风格标签的读写点（表结构在 `server/db.ts`）。
 *
 * 与 `server/agent/preference-log.ts` 同族，三处语义值得说明：
 *
 * 1. **`track_id` 唯一 = 一首歌一行，同 id 覆盖而不是追加。**
 *    「这首算什么风格」是一个**判断**，不是一串累积的事实。用户改主意时旧标签
 *    必须消失——否则检索「摇滚」和「民谣」会同时命中同一首，而这两条出自两个
 *    不同时间的判断，谁也说不清哪个作数。
 *
 * 2. **`source` 决定谁能覆盖谁：`'ai'` 打底，`'user'` 覆盖。**
 *    AI 批量打标**不会**动用户已设过的行。若允许它覆盖，每重跑一次脚本就会
 *    静默抹掉用户的主观偏好——而按需求，那恰恰是**优先级最高**的那一层。
 *
 * 3. **写失败要抛**（与 `preferences` 同侧，与 `plays` 相反的取舍）：
 *    agent 一旦对用户说了「好，我把它标成民谣」，就必须真标上。静默失败会让用户
 *    下次发现它没记住，却找不到任何线索。
 *
 * 归一化（拆词 / 小写 / 去重 / 排序）在 `contract/track-tags.ts`，
 * 工具侧、存储侧、打标脚本共用同一套 —— `pop folk` 与 `pop`+`folk` 必须是同一条。
 */
import { formatTags, parseTags } from '../../contract/track-tags';
import { getDb } from '../db';

/** 这条标签是谁写的。`user` 永远压过 `ai`。 */
export type TagSource = 'ai' | 'user';

export type TrackTags = {
	/** `Song.id`，即曲库内的相对路径。 */
	trackId: string;
	/** 已归一化的标签，排序后。 */
	tags: string[];
	source: TagSource;
	updatedAt: string;
};

type RawRow = { track_id: string; tags: string; source: string; updated_at: string };

function toTrackTags(row: RawRow): TrackTags {
	return {
		trackId: row.track_id,
		tags: parseTags(row.tags),
		source: row.source === 'user' ? 'user' : 'ai',
		updatedAt: row.updated_at,
	};
}

/**
 * 读全部标签，按 `track_id` 排序。读失败返回空数组：标签是增强，
 * 读不到等于「这批歌暂时没标签」，不该让整次检索挂掉。
 * （与写侧不对称是有意的——写是承诺，读只是增强。）
 */
export function listTrackTags(): TrackTags[] {
	try {
		const rows = getDb()
			.prepare('SELECT track_id, tags, source, updated_at FROM track_tags ORDER BY track_id')
			.all() as unknown as RawRow[];
		return rows.map(toTrackTags);
	} catch (err) {
		console.error('[track-tags] failed to list:', err);
		return [];
	}
}

/** 查一首歌的标签。没有则 null。 */
export function getTrackTags(trackId: string): TrackTags | null {
	const row = getDb()
		.prepare('SELECT track_id, tags, source, updated_at FROM track_tags WHERE track_id = ?')
		.get(trackId) as unknown as RawRow | undefined;
	return row ? toTrackTags(row) : null;
}

/** 写入结果。`applied: false` 表示「AI 想写，但用户已经定过了」。 */
export type SetTagsResult = { applied: boolean; current: TrackTags };

/**
 * 写入一首歌的标签。
 *
 * - `source: 'user'` —— 无条件覆盖（用户的判断永远赢，这也是「重设」的入口）。
 * - `source: 'ai'`   —— 若该曲目已有 `source: 'user'` 的行，**原样保留**并返回
 *   `applied: false`。这不是失败，是预期行为，所以不抛异常。
 *
 * `at` 可注入，单测靠它钉时间（与 `preference-log` 一致）。
 */
export function setTrackTags(
	trackId: string,
	tags: readonly string[],
	source: TagSource,
	at: Date = new Date(),
): SetTagsResult {
	const existing = getTrackTags(trackId);
	if (source === 'ai' && existing?.source === 'user') {
		return { applied: false, current: existing };
	}

	const stored = formatTags(tags);
	const updatedAt = at.toISOString();
	getDb()
		.prepare(
			`INSERT INTO track_tags (track_id, tags, source, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(track_id) DO UPDATE SET
			   tags = excluded.tags, source = excluded.source, updated_at = excluded.updated_at`,
		)
		.run(trackId, stored, source, updatedAt);

	return { applied: true, current: { trackId, tags: parseTags(stored), source, updatedAt } };
}

/** 删掉一首歌的标签（回到「没有标签」）。返回是否真的删掉了。 */
export function removeTrackTags(trackId: string): boolean {
	const result = getDb().prepare('DELETE FROM track_tags WHERE track_id = ?').run(trackId);
	return Number(result.changes) > 0;
}
