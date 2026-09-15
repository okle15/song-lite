/**
 * 播放历史 —— 全项目唯一的持久化读写点。
 *
 * 写入时机：**一次「开始播放」记一行**，即 `/api/player/{play,next,jump}`
 * 成功切歌时。`pause` / `resume` 不算新的播放（同一首接着放），不入表——
 * 否则「听了多少首」会随暂停次数虚高。
 *
 * 写失败**不抛**：记历史是旁路，磁盘满 / 权限不对都不该把播放打断。
 * 这是从早期的本地操作流水继承下来的取舍（当时的教训：日志写失败把整条链路带崩）。
 *
 * 表结构见 `server/db.ts`。
 */
import { getDb } from '../db';

/** 一行播放历史（对外用 camelCase，与 SQL 的 snake_case 解耦）。 */
export type PlayRow = {
	id: number;
	trackId: string;
	title: string;
	artist: string;
	startedAt: string;
};

/** SQL 行的原始形状（`node:sqlite` 返回的对象键名就是列名）。 */
type RawPlayRow = {
	id: number;
	track_id: string;
	title: string;
	artist: string;
	started_at: string;
};

/**
 * 记一次播放。`at` 可注入（单测钉时间），默认当前时刻。
 *
 * 曲名 / 歌手在此**冗余存一份**：历史要能在曲目被移出曲库、甚至重命名之后
 * 依然可读；只存 `track_id` 的话那些行就变成了指不到任何东西的悬空引用。
 */
export function recordPlay(
	track: { id: string; title: string; artist: string },
	at: Date = new Date(),
): void {
	try {
		getDb()
			.prepare('INSERT INTO plays (track_id, title, artist, started_at) VALUES (?, ?, ?, ?)')
			.run(track.id, track.title, track.artist, at.toISOString());
	} catch (err) {
		console.error('[play-log] failed to record play:', err);
	}
}

/** 最近 N 次播放，新的在前。`limit` 夹紧在 1..200，非法值回落 20。 */
export function recentPlays(limit = 20): PlayRow[] {
	const parsed = Math.trunc(limit);
	const n = Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 20, 1), 200);
	try {
		const rows = getDb()
			.prepare('SELECT id, track_id, title, artist, started_at FROM plays ORDER BY id DESC LIMIT ?')
			.all(n) as unknown as RawPlayRow[];
		return rows.map((r) => ({
			id: r.id,
			trackId: r.track_id,
			title: r.title,
			artist: r.artist,
			startedAt: r.started_at,
		}));
	} catch (err) {
		console.error('[play-log] failed to read plays:', err);
		return [];
	}
}
