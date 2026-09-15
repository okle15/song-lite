/**
 * Interaction logging — SQLite 后端（迁移自 Phase 9 的 JSONL 实现）。
 *
 * 每次用户交互（chat turn / player 操作 / library 操作）记一条记录到
 * `data/logs.db` 的 `interaction_logs` 表。GET /api/logs 读取用于评估面板。
 *
 * 为什么从 JSONL 迁到 SQLite：
 *  - 范围查询（按时间 / intent / routedTo）从 O(n) 全表扫描变 O(log n) 索引
 *  - 聚合统计（AVG / P95 / GROUP BY）原生 SQL 支持
 *  - 多实例并发写不冲突（WAL 模式多读单写）
 *  - 事务原子性，崩溃不会写半行污染后续数据
 *
 * 后端选 `node:sqlite`（Node 22+ 内置 DatabaseSync）保持与 agent 持久化层一致，
 * 不引入 better-sqlite3 等额外依赖。API 同步但函数签名仍 async（不破坏调用方）。
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { InteractionLog } from '@/contract/types';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'logs.db');
const LEGACY_JSONL = path.join(DATA_DIR, 'logs', 'history.jsonl');

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
	if (db) return db;
	db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA synchronous = NORMAL;');
	db.exec(`
		CREATE TABLE IF NOT EXISTS interaction_logs (
			id            TEXT PRIMARY KEY,
			timestamp     TEXT NOT NULL,
			user_input    TEXT NOT NULL,
			input_type    TEXT NOT NULL,
			intent        TEXT NOT NULL,
			routed_to     TEXT NOT NULL,
			tools_called  TEXT NOT NULL DEFAULT '[]',
			result        TEXT,
			user_satisfied INTEGER,
			error_tag     TEXT,
			cost          REAL,
			latency       INTEGER NOT NULL
		);
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON interaction_logs(timestamp);');
	db.exec('CREATE INDEX IF NOT EXISTS idx_logs_intent ON interaction_logs(intent);');
	db.exec('CREATE INDEX IF NOT EXISTS idx_logs_routed_to ON interaction_logs(routed_to);');
	db.exec('CREATE INDEX IF NOT EXISTS idx_logs_error_tag ON interaction_logs(error_tag) WHERE error_tag IS NOT NULL;');
	return db;
}

// Prepared statements 缓存（同一连接复用）
let stmtInsert: ReturnType<DatabaseSync['prepare']> | null = null;
let stmtRecent: ReturnType<DatabaseSync['prepare']> | null = null;

function getStmtInsert() {
	if (!stmtInsert) {
		stmtInsert = getDb().prepare(`
			INSERT OR REPLACE INTO interaction_logs
				(id, timestamp, user_input, input_type, intent, routed_to,
				 tools_called, result, user_satisfied, error_tag, cost, latency)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
		`);
	}
	return stmtInsert;
}

function getStmtRecent() {
	if (!stmtRecent) {
		// ASC 排序取末尾 limit 条（保持与原 JSONL 行为一致：最新在最后）
		stmtRecent = getDb().prepare(`
			SELECT * FROM (
				SELECT * FROM interaction_logs ORDER BY timestamp DESC LIMIT ?
			) ORDER BY timestamp ASC;
		`);
	}
	return stmtRecent;
}

function rowToLog(row: Record<string, unknown>): InteractionLog {
	return {
		id: row.id as string,
		timestamp: row.timestamp as string,
		userInput: row.user_input as string,
		inputType: row.input_type as 'text' | 'voice',
		intent: row.intent as string,
		routedTo: row.routed_to as 'local' | 'agent',
		toolsCalled: JSON.parse((row.tools_called as string) ?? '[]') as string[],
		result: row.result == null ? null : JSON.parse(row.result as string),
		userSatisfied: row.user_satisfied == null ? undefined : Boolean(row.user_satisfied),
		errorTag: row.error_tag == null ? undefined : (row.error_tag as string),
		cost: row.cost == null ? undefined : (row.cost as number),
		latency: row.latency as number,
	};
}

/**
 * 一次性迁移：若 legacy `history.jsonl` 存在，导入到 SQLite 后改名归档
 * （加 `.migrated` 后缀），避免重启时重复导入。仅模块首次加载时执行一次。
 */
function migrateLegacyJsonlOnce(): void {
	if (!existsSync(LEGACY_JSONL)) return;
	const stmt = getStmtInsert();
	let imported = 0;
	try {
		const raw = readFileSync(LEGACY_JSONL, 'utf8');
		const lines = raw.split('\n').filter((l) => l.trim().length > 0);
		getDb().exec('BEGIN;');
		try {
			for (const line of lines) {
				let record: InteractionLog;
				try {
					record = JSON.parse(line) as InteractionLog;
				} catch {
					continue; // 跳过坏行
				}
				stmt.run(
					record.id,
					record.timestamp,
					record.userInput,
					record.inputType ?? 'text',
					record.intent,
					record.routedTo,
					JSON.stringify(record.toolsCalled ?? []),
					record.result == null ? null : JSON.stringify(record.result),
					record.userSatisfied == null ? null : record.userSatisfied ? 1 : 0,
					record.errorTag ?? null,
					record.cost ?? null,
					record.latency,
				);
				imported += 1;
			}
			getDb().exec('COMMIT;');
		} catch (err) {
			getDb().exec('ROLLBACK;');
			console.error('[interaction-log] migration failed, rolling back:', err);
			return;
		}
		// 归档原文件，避免下次重启重复导入
		try {
			renameSync(LEGACY_JSONL, `${LEGACY_JSONL}.migrated`);
			console.log(`[interaction-log] migrated ${imported} records from history.jsonl → logs.db (jsonl archived as .migrated)`);
		} catch (err) {
			console.warn('[interaction-log] migration succeeded but failed to archive legacy file:', err);
		}
	} catch (err) {
		console.warn('[interaction-log] legacy jsonl exists but unreadable, skipping migration:', err);
	}
}

// 模块加载时初始化 + 一次性迁移
try {
	getDb();
	migrateLegacyJsonlOnce();
} catch (err) {
	console.error('[interaction-log] failed to initialize SQLite:', err);
}

/**
 * Append one interaction record. Never throws — callers use `void` and the
 * returned promise is awaited internally only to sequence writes. A monotonic
 * `id` and ISO `timestamp` are filled if omitted.
 */
export async function appendInteractionLog(
	entry: Partial<InteractionLog> & Pick<InteractionLog, 'userInput' | 'intent' | 'routedTo' | 'latency'>,
): Promise<void> {
	const record: InteractionLog = {
		id: entry.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: entry.timestamp ?? new Date().toISOString(),
		userInput: entry.userInput,
		inputType: entry.inputType ?? 'text',
		intent: entry.intent,
		routedTo: entry.routedTo,
		toolsCalled: entry.toolsCalled ?? [],
		result: entry.result ?? null,
		userSatisfied: entry.userSatisfied,
		errorTag: entry.errorTag,
		cost: entry.cost,
		latency: entry.latency,
	};
	try {
		getStmtInsert().run(
			record.id,
			record.timestamp,
			record.userInput,
			record.inputType,
			record.intent,
			record.routedTo,
			JSON.stringify(record.toolsCalled),
			record.result == null ? null : JSON.stringify(record.result),
			record.userSatisfied == null ? null : record.userSatisfied ? 1 : 0,
			record.errorTag ?? null,
			record.cost ?? null,
			record.latency,
		);
	} catch (err) {
		console.error('[interaction-log] failed to insert:', err);
	}
}

/**
 * Convenience wrapper for the local-route path (player / library). Always
 * `routedTo: 'local'`, `toolsCalled: []`. Fire-and-forget from the caller's
 * side (`void recordLocalInteraction(...)`).
 */
export function recordLocalInteraction(
	entry: Pick<InteractionLog, 'userInput' | 'intent' | 'latency'> &
		Partial<Pick<InteractionLog, 'inputType' | 'result' | 'errorTag'>>,
): Promise<void> {
	return appendInteractionLog({
		userInput: entry.userInput,
		inputType: entry.inputType ?? 'text',
		intent: entry.intent,
		routedTo: 'local',
		toolsCalled: [],
		result: entry.result,
		errorTag: entry.errorTag,
		latency: entry.latency,
	});
}

/**
 * Read the most recent `limit` interaction logs (newest last). Returns `[]`
 * if no records exist.
 */
export async function readInteractionLogs(limit = 50): Promise<InteractionLog[]> {
	try {
		const rows = getStmtRecent().all(Math.min(Math.max(limit, 0), 10000)) as Record<string, unknown>[];
		return rows.map(rowToLog);
	} catch (err) {
		console.error('[interaction-log] failed to read:', err);
		return [];
	}
}

/**
 * 过滤查询交互日志。所有参数可选，未传的字段不过滤。
 * 走索引（idx_logs_timestamp / idx_logs_intent / idx_logs_routed_to / idx_logs_error_tag）。
 *
 * @param opts.limit   最多返回多少条（默认 50，上限 10000）
 * @param opts.intent  按 intent 精确匹配，如 'search' / 'play' / 'pause'
 * @param opts.since   ISO 时间字符串，timestamp >= since
 * @param opts.until   ISO 时间字符串，timestamp <= until
 * @param opts.errorTag 按 error_tag 精确匹配（如 'not_paused'）
 * @param opts.routedTo 'local' | 'agent'
 */
export async function queryInteractionLogs(opts: {
	limit?: number;
	intent?: string;
	since?: string;
	until?: string;
	errorTag?: string;
	routedTo?: 'local' | 'agent';
}): Promise<InteractionLog[]> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 0), 10000);
	const where: string[] = [];
	const params: SQLInputValue[] = [];
	if (opts.intent) {
		where.push('intent = ?');
		params.push(opts.intent);
	}
	if (opts.since) {
		where.push('timestamp >= ?');
		params.push(opts.since);
	}
	if (opts.until) {
		where.push('timestamp <= ?');
		params.push(opts.until);
	}
	if (opts.errorTag) {
		where.push('error_tag = ?');
		params.push(opts.errorTag);
	}
	if (opts.routedTo) {
		where.push('routed_to = ?');
		params.push(opts.routedTo);
	}
	const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
	// 先 DESC 取末尾 limit 条，再 ASC 排序保持 newest last（与 readInteractionLogs 一致）
	const sql = `SELECT * FROM (SELECT * FROM interaction_logs ${whereClause} ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC;`;
	params.push(limit);
	try {
		const stmt = getDb().prepare(sql);
		const rows = stmt.all(...params) as Record<string, unknown>[];
		return rows.map(rowToLog);
	} catch (err) {
		console.error('[interaction-log] query failed:', err);
		return [];
	}
}
