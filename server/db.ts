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
 *                `prompt_version` / `prompt_disabled` 记**那一轮用的是哪份提示词**
 *                （2026-09-23 加）：它是「带 / 不带某条 prompt 补丁各跑一遍」这组
 *                对比能按版本分组的前提（见 `agent/prompt.ts` 的文件头）。
 *                加列之前的老行这两列是 **NULL** —— "无从得知"，而空串会被读成
 *                "那一轮没关任何补丁"这个**真实的结论**，两者不能混。
 *                它们是**后加的列**，所以同时登记在 `ADDED_COLUMNS` 里（见下）。
 *                `model` / `cost_micro` / `first_token_ms` 同日加（2026-09-23）：
 *                **成本列必须与 model 列同时存在** —— 换过模型之后，一条价格曲线会把
 *                两种价目混在一起，那种数字看了比不看更坏（与 `prompt_version` 同一个道理）；
 *                `cost_micro` 存**微美元整数**（浮点进 SQLite 会带上 0.1+0.2 那种尾巴），
 *                NULL = **没配价目表**，不是 0 —— 0 会被读成「这一轮免费」；
 *                `first_token_ms` NULL = 这一轮**一个字都没吐过**（被掐掉 / 中断）。
 *   tasks        ⑩ 触发器，一行 = 一件**跨轮的目标**（不是一次工具调用）。
 *                `goal` 是模型自己写下的一句话（"用户想让我做到什么"），
 *                `due_at` 是"什么时候该做"，`repeat` 有 none / daily / weekly 三档，
 *                `repeat_days` 是 weekly 的"哪几天"（JSON 数字数组，0=周日…6=周六；
 *                空 = 不适用，且 `weekly` + 空 = "每周同一天"，由 `due_at` 的星期决定）。
 *                ⚠️ 它是**后加的列**（2026-09-23，BLUEPRINT §9 的"只在某几天"），
 *                所以同时登记在 `ADDED_COLUMNS` 里 —— 漏一处老库就静默少一列。
 *                `status` 与 `attempts` 支撑**原子认领**（见 `server/agent/tasks.ts`）：
 *                没有认领，两个 tick 同时跑就会把同一件事做两遍，而它对用户表现为
 *                「它怎么又把同一句话说了一遍」——**不报错，只是重复**。
 *   agent_spans  ⑨ 观测的**下钻**，一行 = 一轮里的一步（`turn_id` + `idx`，父子关系）。
 *                为什么要它：`agent_turns.tools` 已经能说「哪个工具慢」，但答不了
 *                「这一步里是模型慢还是工具慢」——而那是**同一句话要往两个方向改**
 *                的分岔点（收提示词 vs 优化工具）。⚠️ 本表**不存"模型耗时"**：
 *                它只能算成残差（轮耗时 − 工具耗时），里面还混着网络与排队，
 *                叫成"模型耗时"就是把推算说成实测（见 `turn-log.ts` 的 `summarizeSpans`）。
 *
 * 七张表的**失败语义不同**，不是不一致而是有意：
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

/**
 * **建表之后才加的列** —— 老库升级用。
 * ⚠️ 新增一列时，除了改上面的 `CREATE TABLE`，**这里也要补一条**：前者只对新库生效。
 */
const ADDED_COLUMNS: Record<string, { name: string; ddl: string }[]> = {
	agent_turns: [
		{ name: 'prompt_version', ddl: 'TEXT' },
		{ name: 'prompt_disabled', ddl: 'TEXT' },
		{ name: 'model', ddl: 'TEXT' },
		{ name: 'cost_micro', ddl: 'INTEGER' },
		{ name: 'first_token_ms', ddl: 'INTEGER' },
	],
	tasks: [
		// weekly 的"哪几天"。老库里已有的任务都是 none / daily，这一列为 NULL 正是
		// 它们该有的样子（`tasks.ts` 的 `parseRepeatDays` 把 NULL 读成"没有指定"）。
		{ name: 'repeat_days', ddl: 'TEXT' },
	],
};

/**
 * 给**已经存在的**表补齐后加的列。
 *
 * 为什么必须有这一段：`CREATE TABLE IF NOT EXISTS` 对已存在的表是**空操作**，
 * 所以「在 CREATE 里加一列」只对新库成立。老库升上来时那一列不存在，而写入侧
 * （`recordTurn`）走的是**流水语义**（`try/catch` 只 log）——后果不是报错，
 * 是观测**静默停摆**：一行都进不来了，表还在那儿，没有任何提示。
 *
 * 判据取 `PRAGMA table_info`，只对真正缺的列 ALTER，所以每次开连接跑一遍也安全。
 * ⚠️ **不加 `NOT NULL DEFAULT`**：老行确实无从得知那一轮用的是哪版提示词，
 * 留 NULL 是有信息量的（与 `turn-log.ts` 的 `ms` 用 null 不用 0 同构）；
 * 给个空串则会被读成「那一轮没关任何补丁」这个**真实的结论**，两者不能混。
 */
function ensureAddedColumns(db: DatabaseSync): void {
	for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
		const have = new Set(rows.map((r) => r.name));
		for (const col of columns) {
			if (have.has(col.name)) continue;
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.ddl}`);
		}
	}
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
			id              TEXT PRIMARY KEY,
			created_at      TEXT NOT NULL,
			user_text       TEXT NOT NULL,
			steps           INTEGER NOT NULL,
			tool_calls      INTEGER NOT NULL,
			tools           TEXT NOT NULL,
			truncated       INTEGER NOT NULL,
			aborted         INTEGER NOT NULL,
			finish_reason   TEXT,
			ms              INTEGER NOT NULL,
			input_tokens    INTEGER NOT NULL,
			output_tokens   INTEGER NOT NULL,
			error           TEXT,
			prompt_version  TEXT,
			prompt_disabled TEXT,
			model           TEXT,
			cost_micro      INTEGER,
			first_token_ms  INTEGER
		);

		CREATE TABLE IF NOT EXISTS tasks (
			id          TEXT PRIMARY KEY,
			goal        TEXT NOT NULL,
			due_at      TEXT NOT NULL,
			repeat      TEXT NOT NULL,
			repeat_days TEXT,
			status      TEXT NOT NULL,
			attempts    INTEGER NOT NULL,
			last_error  TEXT,
			result      TEXT,
			created_at  TEXT NOT NULL,
			last_run_at TEXT
		);

		CREATE TABLE IF NOT EXISTS agent_spans (
			turn_id       TEXT NOT NULL,
			idx           INTEGER NOT NULL,
			tools         TEXT NOT NULL,
			tool_ms       INTEGER NOT NULL,
			finish_reason TEXT,
			PRIMARY KEY (turn_id, idx)
		);
	`);

	// 建表只管新库；老库缺的列由这里补（理由见上面 `ensureAddedColumns`）。
	ensureAddedColumns(db);
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
