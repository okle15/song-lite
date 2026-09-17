/**
 * 数据层 —— 全项目**唯一**的 SQLite 连接与建表处。
 *
 * 为什么是 SQLite（不是 JSON 文件、也不是纯内存）：唯一需要跨进程存活的只有
 * 「播放历史」，而它的读取形态天生是「按时间倒序取最近 N 条」——SQL 一行
 * `ORDER BY id DESC LIMIT ?` 就够，JSON 得每次全量读进内存再排序。后续要加
 * 索引、加表，也都是 SQL 的常规动作。
 *
 * 为什么是 `node:sqlite`（不是 better-sqlite3 / sqlite3）：Node 22 内置，
 * 零原生依赖、零编译、零 npm 包——本仓库的 dependencies 因此保持 4 个。
 *
 * 位置：`data/app.db`。运行时派生数据，删掉即归零、服务按需重建，
 * `.gitignore` 已忽略。刻意**不开 WAL**：默认 journal 模式下落盘只有单个
 * `.db` 文件，不留 `-wal` / `-shm` 尾巴——「删一个文件就干净」是有意保留的性质。
 *
 * ── 表结构（2026-09-17 加 agent_turns）─────────────────────────────────
 *   plays        播放历史，一行 = 一次「开始播放某首歌」
 *   messages     对话历史，一行 = 一条 UI 消息（user 或 assistant）
 *   preferences  ⑥ 记忆，一行 = 一条关于用户的持久偏好（key 唯一，再记即覆盖）
 *   track_tags   曲目风格标签，一行 = 一首歌（track_id 唯一，指 `Song.id`）
 *                `source` 记这行是谁写的：'ai' 打底 / 'user' 覆盖；
 *                **AI 不会覆盖用户已设的标签**（见 `server/library/tags.ts`）。
 *                为什么它必须落库：ID3 里那个 genre 字段本身是不可信的
 *                （本曲库 6 首中文流行全被标成 blues），而「这首算什么风格」
 *                既需要模型判断、又需要尊重用户的主观偏好 —— 两者都不在文件里。
 *   agent_turns  ⑨ 观测，一行 = **一轮对话**（不是一条消息）。`id` 就是那一轮
 *                assistant 消息的 id，与 `messages` 表同一个主键，可直接 join。
 *                为什么落库：⑨ 存在的意义是「事后能回答它哪次答错、慢在哪、
 *                花了多少」——而这三件事在一轮结束的那一刻全都还在手上
 *                （步数、工具耗时、token、有没有被截断），过后就散了。
 *
 * 五张表的**失败语义不同**，不是不一致而是有意：
 *   plays / messages / agent_turns 是旁路记录，写失败只 log 不抛（不该打断播放或对话）；
 *   preferences / track_tags 是 agent 对用户的**承诺**（它说了「记住了」就该真记住），
 *   所以写失败要抛到路由 → 变成工具失败 → 模型据实告诉用户。
 *
 * 之后要加表（歌单 / 标签 / 电台编排…）就往 `migrate()` 里追加一条
 * `CREATE TABLE IF NOT EXISTS`。**建表语句只在本文件出现**——一旦别处也写一份，
 * 两处必然漂移（历史上 `logs.db` 与 `eval.db` 的双份表定义就是这么来的）。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 挂 globalThis：dev 热重载时模块重新求值也不会新建第二条连接。 */
const g = globalThis as unknown as { __appDb?: DatabaseSync };

/**
 * 数据库文件位置。默认 `<cwd>/data/app.db`；`APP_DB_PATH` 可覆盖
 * ——单测靠它指到临时文件，免得污染真实历史。
 *
 * 每次调用重新求值（不在模块加载时定死），否则进程启动后改环境变量就不生效了。
 */
function resolveDbPath(): string {
	const override = process.env.APP_DB_PATH;
	if (override) return path.resolve(override);
	return path.join(process.cwd(), 'data', 'app.db');
}

/** 建表。幂等，每次开连接跑一遍。 */
function migrate(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS plays (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			track_id   TEXT NOT NULL,
			title      TEXT NOT NULL,
			artist     TEXT NOT NULL,
			started_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS messages (
			id         TEXT PRIMARY KEY,
			role       TEXT NOT NULL,
			parts      TEXT NOT NULL,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS preferences (
			key        TEXT PRIMARY KEY,
			value      TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS track_tags (
			track_id   TEXT PRIMARY KEY,
			tags       TEXT NOT NULL,
			source     TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS agent_turns (
			id            TEXT PRIMARY KEY,
			created_at    TEXT NOT NULL,
			user_text     TEXT NOT NULL,
			steps         INTEGER NOT NULL,
			tool_calls    INTEGER NOT NULL,
			tools         TEXT NOT NULL,
			truncated     INTEGER NOT NULL,
			aborted       INTEGER NOT NULL,
			finish_reason TEXT,
			ms            INTEGER NOT NULL,
			input_tokens  INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			error         TEXT
		);
	`);
}

/** 取连接（首次调用时建目录、建库、建表）。`node:sqlite` 是同步 API。 */
export function getDb(): DatabaseSync {
	if (g.__appDb) return g.__appDb;
	const file = resolveDbPath();
	mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	migrate(db);
	g.__appDb = db;
	return db;
}

/**
 * 关闭连接并丢弃缓存。单测在换 `APP_DB_PATH` 时必须先调它，
 * 否则拿到的是上一条连接。生产进程退出时无需显式调用。
 */
export function closeDb(): void {
	g.__appDb?.close();
	g.__appDb = undefined;
}
