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

/**
 * 一首歌的播放统计（给「曲库体检 / 单曲详情」用）。
 *
 * 放在**这里**而不是各个读侧各写一条 SQL：`plays` 只有本文件一个读写点
 * （`AGENTS.md` 的目录约定），多一处就多一处漂移。
 *
 * 读失败回 `null`（不是 0）：播放次数读不出来 ≠ 这首歌一次都没播过。
 * 与 `first_token_ms` 用 NULL 不用 0 是同一条 —— **0 是一个结论，null 是不知道**。
 */
export function playStatsFor(trackId: string): PlayStats | null {
	try {
		const row = getDb()
			.prepare(
				'SELECT COUNT(*) AS count, MAX(started_at) AS last FROM plays WHERE track_id = ?',
			)
			.get(trackId) as unknown as { count: number; last: string | null } | undefined;
		if (!row) return null;
		return { count: Number(row.count), lastPlayedAt: row.last };
	} catch (err) {
		console.error('[play-log] failed to read play stats:', err);
		return null;
	}
}

/** 一首歌的播放统计。 */
export type PlayStats = {
	/** 播过几次。 */
	count: number;
	/** 最近一次是什么时候播的。**null = 从没播过**（不是"不知道"）。 */
	lastPlayedAt: string | null;
};

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
