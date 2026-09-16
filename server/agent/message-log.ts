/**
 * ⑤ 会话历史 —— 对话消息的持久化读写点（BLUEPRINT §2 的活跃区）。
 *
 * 与 `server/records/play-log.ts` 是同一个形状：表结构在 `server/db.ts`，
 * 本文件只有「写一对读」，域逻辑不碰 HTTP。
 *
 * ── 三个设计决定，都值得知道「为什么」──────────────────────────────
 *
 * 1. **存 `parts` 全文，不存纯文本。** 「历史里的工具轨迹全扔」是**发送层**的
 *    裁剪（见 `agent/run.ts` 的 `pruneMessages`），不是存储层的取舍。分开之后
 *    两个目标同时成立：刷新页面时工具轨迹卡片能原样恢复（库里是全量），
 *    而送给模型的上下文是干净的（发之前才裁）。合成一步就必然要牺牲一个。
 *
 * 2. **`id` 直接当前端生成的消息 id 用，不另发主键。** `useChat` 的每条消息
 *    都自带一个稳定 id，于是 `INSERT ... ON CONFLICT(id) DO UPDATE` 天然幂等
 *    ——同一轮重复上报只会覆盖成同样的内容，不会长出重复行。
 *
 * 3. **顺序用 `rowid`，不用 `id` 也不用 `created_at`。** `id` 是随机串排不了序；
 *    `created_at` 在多条消息同一毫秒落库时会撞车（一轮就是 user + assistant 两条）。
 *    `ON CONFLICT DO UPDATE` 不改 rowid，所以 `ORDER BY rowid` 恰好就是
 *    「首次插入的会话顺序」——这正是回放要的顺序。
 *
 * **不建 `sessions` 表**：单用户单会话，加 `session_id` 是为「以后可能多会话」
 * 提前长架子（BLUEPRINT §6 明令禁止）。真需要多会话时再迁移。
 *
 * 写失败**不抛**（沿用 play-log 的取舍）：记历史是旁路，磁盘满 / 权限不对都不该
 * 把对话打断。读失败返回空数组——刷新后看不到历史，总好过白屏。
 */
import type { UIMessage } from 'ai';
import { getDb } from '../db';

/**
 * 读回上限。只限制**读多少**，不删任何行——历史先让它长着，
 * 真需要清理时再单独加（BLUEPRINT §8 明确不做自动清理）。
 */
const READ_LIMIT = 200;

/** SQL 行的原始形状（`node:sqlite` 返回的对象键名就是列名）。 */
type RawMessageRow = { id: string; role: string; parts: string };

const ROLES = new Set(['system', 'user', 'assistant']);

/** 反序列化 `parts`。结构不对（不是数组 / 不是 JSON）时返回 null，由调用方跳过该行。 */
function parseParts(raw: string): UIMessage['parts'] | null {
	try {
		const value = JSON.parse(raw) as unknown;
		return Array.isArray(value) ? (value as UIMessage['parts']) : null;
	} catch {
		return null;
	}
}

/**
 * 落库一批消息（含本轮 assistant 回复）。**幂等**：id 已存在则覆盖内容，
 * 不动 `created_at`（首次落库时间）也不动 rowid（会话顺序）。
 *
 * `at` 可注入，单测靠它钉时间。
 */
export function appendMessages(messages: UIMessage[], at: Date = new Date()): void {
	if (messages.length === 0) return;
	try {
		const db = getDb();
		const stmt = db.prepare(
			`INSERT INTO messages (id, role, parts, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET role = excluded.role, parts = excluded.parts`,
		);
		const createdAt = at.toISOString();
		// 一轮消息要么全进要么全不进：中途失败留下半截历史，回放时会出现
		// 「有 user 没 assistant」的悬空轮次。
		db.exec('BEGIN');
		try {
			for (const m of messages) {
				stmt.run(m.id, m.role, JSON.stringify(m.parts ?? []), createdAt);
			}
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
	} catch (err) {
		console.error('[message-log] failed to append messages:', err);
	}
}

/**
 * 读回最近 N 条消息，**按会话顺序（早的在前）**——正是 `useChat` 要的顺序。
 * `limit` 夹紧在 1..200，非法值回落 200。
 */
export function recentMessages(limit = READ_LIMIT): UIMessage[] {
	const parsed = Math.trunc(limit);
	const n = Math.min(
		Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : READ_LIMIT, 1),
		READ_LIMIT,
	);
	try {
		const rows = getDb()
			.prepare('SELECT id, role, parts FROM messages ORDER BY rowid DESC LIMIT ?')
			.all(n) as unknown as RawMessageRow[];
		const out: UIMessage[] = [];
		// 倒序取最近 N 条，再翻回正序——比 `ORDER BY rowid ASC LIMIT ?` 更省事，
		// 且不需要先数总数。
		for (const row of rows.reverse()) {
			const parts = parseParts(row.parts);
			if (!parts || !ROLES.has(row.role)) continue; // 坏行跳过，不让一条脏数据拖垮整段回放
			out.push({ id: row.id, role: row.role as UIMessage['role'], parts });
		}
		return out;
	} catch (err) {
		console.error('[message-log] failed to read messages:', err);
		return [];
	}
}
