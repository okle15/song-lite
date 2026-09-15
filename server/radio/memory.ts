/**
 * radio/memory — 电台的长期记忆层（SQLite，node:sqlite 同步驱动）。
 *
 * 电台的三块壁垒之一：**长期记忆**。所有「听过什么、什么时候听、听多久就跳、
 * 哪个时段听了什么」都沉淀在这里，供编排器（director）打分选歌。
 *
 * 两张表：
 *  - track_stats   每首歌的长期画像：播放/跳过次数、最近播放时间、24 小时亲和度直方图
 *  - radio_programs 节目史：每次编排的栏目、时段、曲目单 —— 既是「最近播过」的
 *    去重依据，也是可回放/可审计的运行轨迹
 *
 * 与 interaction-log 同一套约定：单用户场景，WAL 模式，prepared statement 复用。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'radio.db');

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
	if (db) return db;
	mkdirSync(DATA_DIR, { recursive: true });
	db = new DatabaseSync(DB_PATH);
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA synchronous = NORMAL;');
	db.exec(`
		CREATE TABLE IF NOT EXISTS track_stats (
			track_id       TEXT PRIMARY KEY,
			play_count     INTEGER NOT NULL DEFAULT 0,
			skip_count     INTEGER NOT NULL DEFAULT 0,
			last_played_at TEXT,
			last_skipped_at TEXT,
			total_sec      REAL NOT NULL DEFAULT 0,
			hour_hist      TEXT NOT NULL DEFAULT '{}'
		);
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS radio_programs (
			id          TEXT PRIMARY KEY,
			started_at  TEXT NOT NULL,
			ended_at    TEXT,
			name        TEXT NOT NULL,
			daypart_id  TEXT NOT NULL,
			hour        INTEGER NOT NULL,
			track_ids   TEXT NOT NULL DEFAULT '[]',
			dj_line     TEXT
		);
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_prog_started ON radio_programs(started_at);');
	// 带来源的标签表：回答「这个标签是谁给的」。
	// source: id3(文件自带) / inferred(风格推断) / llm(模型打标) / user(用户标注)
	// 同一 (track,kind,tag) 冲突时按 confidence 高者保留 —— 用户标注永远最高。
	db.exec(`
		CREATE TABLE IF NOT EXISTS track_tags (
			track_id    TEXT NOT NULL,
			kind        TEXT NOT NULL,
			tag         TEXT NOT NULL,
			source      TEXT NOT NULL,
			confidence  REAL NOT NULL DEFAULT 0.5,
			created_at  TEXT NOT NULL,
			PRIMARY KEY (track_id, kind, tag)
		);
	`);
	db.exec('CREATE INDEX IF NOT EXISTS idx_tags_track ON track_tags(track_id);');
	return db;
}

// ── prepared statement 惰性缓存 ──
let _get: ReturnType<DatabaseSync['prepare']> | null = null;
function getStmtGetStats(): ReturnType<DatabaseSync['prepare']> {
	if (!_get) _get = getDb().prepare('SELECT * FROM track_stats WHERE track_id = ?');
	return _get;
}
let _upsert: ReturnType<DatabaseSync['prepare']> | null = null;
function getStmtUpsert(): ReturnType<DatabaseSync['prepare']> {
	if (!_upsert) {
		_upsert = getDb().prepare(`
			INSERT INTO track_stats (track_id, play_count, skip_count, last_played_at, last_skipped_at, total_sec, hour_hist)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(track_id) DO UPDATE SET
				play_count = excluded.play_count,
				skip_count = excluded.skip_count,
				last_played_at = excluded.last_played_at,
				last_skipped_at = excluded.last_skipped_at,
				total_sec = excluded.total_sec,
				hour_hist = excluded.hour_hist
		`);
	}
	return _upsert;
}
let _allStats: ReturnType<DatabaseSync['prepare']> | null = null;
function getStmtAllStats(): ReturnType<DatabaseSync['prepare']> {
	if (!_allStats) _allStats = getDb().prepare('SELECT * FROM track_stats');
	return _allStats;
}
let _insertProg: ReturnType<DatabaseSync['prepare']> | null = null;
function getStmtInsertProg(): ReturnType<DatabaseSync['prepare']> {
	if (!_insertProg) {
		_insertProg = getDb().prepare(`
			INSERT INTO radio_programs (id, started_at, ended_at, name, daypart_id, hour, track_ids, dj_line)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
	}
	return _insertProg;
}
let _endProg: ReturnType<DatabaseSync['prepare']> | null = null;
function getStmtEndProg(): ReturnType<DatabaseSync['prepare']> {
	if (!_endProg) _endProg = getDb().prepare('UPDATE radio_programs SET ended_at = ? WHERE id = ?');
	return _endProg;
}
let _recentProgs: ReturnType<DatabaseSync['prepare']> | null = null;
function getStmtRecentProgs(): ReturnType<DatabaseSync['prepare']> {
	if (!_recentProgs) {
		_recentProgs = getDb().prepare(
			'SELECT * FROM radio_programs ORDER BY started_at DESC LIMIT ?',
		);
	}
	return _recentProgs;
}
let _progCount: ReturnType<DatabaseSync['prepare']> | null = null;
function getStmtProgCount(): ReturnType<DatabaseSync['prepare']> {
	if (!_progCount) _progCount = getDb().prepare('SELECT COUNT(*) AS c FROM radio_programs');
	return _progCount;
}

export type TrackStatRow = {
	track_id: string;
	play_count: number;
	skip_count: number;
	last_played_at: string | null;
	last_skipped_at: string | null;
	total_sec: number;
	hour_hist: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

/** 读取单首歌的画像；没听过则返回零值行。 */
export function getTrackStat(trackId: string): TrackStatRow {
	const row = getStmtGetStats().get(trackId) as TrackStatRow | undefined;
	return (
		row ?? {
			track_id: trackId,
			play_count: 0,
			skip_count: 0,
			last_played_at: null,
			last_skipped_at: null,
			total_sec: 0,
			hour_hist: '{}',
		}
	);
}

/** 全部画像（编排器打分用，表很小，全读无妨）。 */
export function getAllTrackStats(): TrackStatRow[] {
	return getStmtAllStats().all() as TrackStatRow[];
}

/** 记一次完整播放（听到结束或超过 80%）：+1 播放、更新时段直方图。 */
export function recordPlay(trackId: string, playedSec: number, at = new Date()): void {
	const row = getTrackStat(trackId);
	let hist: Record<string, number> = {};
	try {
		hist = JSON.parse(row.hour_hist) as Record<string, number>;
	} catch {
		hist = {};
	}
	const h = String(at.getHours());
	hist[h] = (hist[h] ?? 0) + 1;
	getStmtUpsert().run(
		trackId,
		row.play_count + 1,
		row.skip_count,
		nowIso(),
		row.last_skipped_at,
		row.total_sec + Math.max(0, playedSec),
		JSON.stringify(hist),
	);
}

/**
 * 记一次跳过（没听完就切走）。skip_count 与 last_skipped_at 是负反馈信号，
 * 编排器会降低频繁被跳过的歌的权重。
 */
export function recordSkip(trackId: string): void {
	const row = getTrackStat(trackId);
	getStmtUpsert().run(
		trackId,
		row.play_count,
		row.skip_count + 1,
		row.last_played_at,
		nowIso(),
		row.total_sec,
		row.hour_hist,
	);
}

export type ProgramRow = {
	id: string;
	started_at: string;
	ended_at: string | null;
	name: string;
	daypart_id: string;
	hour: number;
	track_ids: string;
	dj_line: string | null;
};

/** 写入一档新节目，返回节目 id。 */
export function insertProgram(p: {
	name: string;
	daypartId: string;
	hour: number;
	trackIds: string[];
	djLine: string;
	at?: Date;
}): string {
	const id = `prog-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	getStmtInsertProg().run(
		id,
		(p.at ?? new Date()).toISOString(),
		null,
		p.name,
		p.daypartId,
		p.hour,
		JSON.stringify(p.trackIds),
		p.djLine,
	);
	return id;
}

/** 节目收播（换栏目 / 关台时调用）。 */
export function endProgram(programId: string): void {
	getStmtEndProg().run(nowIso(), programId);
}

/** 最近 N 档节目（编排器做「最近播过」去重 + 状态页展示）。 */
export function recentPrograms(limit = 10): ProgramRow[] {
	return getStmtRecentProgs().all(limit) as unknown as ProgramRow[];
}

/** 累计节目数（状态页 / DJ 口播素材）。 */
export function programCount(): number {
	const row = getStmtProgCount().get() as { c: number };
	return Number(row.c);
}

/**
 * 汇总最近 windowMs 内被播过的曲目 id（跨节目去重用）。
 * 从节目史反推，避免再维护一张播放明细表。
 */
export function recentlyPlayedTrackIds(windowMs = 2 * 3600_000): Set<string> {
	const cutoff = Date.now() - windowMs;
	const out = new Set<string>();
	for (const p of recentPrograms(20)) {
		if (new Date(p.started_at).getTime() < cutoff) break;
		try {
			for (const id of JSON.parse(p.track_ids) as string[]) out.add(id);
		} catch {
			/* 坏行跳过 */
		}
	}
	return out;
}

/** 记忆库整体概况（状态页 + DJ 口播素材）。 */
export function memorySummary(): {
	knownTracks: number;
	totalPlays: number;
	totalSkips: number;
	programs: number;
} {
	const rows = getAllTrackStats();
	return {
		knownTracks: rows.length,
		totalPlays: rows.reduce((s, r) => s + r.play_count, 0),
		totalSkips: rows.reduce((s, r) => s + r.skip_count, 0),
		programs: programCount(),
	};
}

// ────────────────────────── 带来源的标签 ──────────────────────────

export type TagSource = 'id3' | 'inferred' | 'llm' | 'user';

export type TrackTag = {
	trackId: string;
	kind: 'mood' | 'genre' | 'scene';
	tag: string;
	source: TagSource;
	confidence: number;
};

const SOURCE_PRIORITY: Record<TagSource, number> = { user: 4, llm: 3, id3: 2, inferred: 1 };

let _tagsByTrack: ReturnType<DatabaseSync['prepare']> | null = null;
let _llmTagged: ReturnType<DatabaseSync['prepare']> | null = null;

/** 某首歌的标签，按来源优先级排序（user > llm > id3 > inferred）。 */
export function getTrackTags(trackId: string): TrackTag[] {
	if (!_tagsByTrack) {
		_tagsByTrack = getDb().prepare('SELECT * FROM track_tags WHERE track_id = ?');
	}
	const rows = _tagsByTrack.all(trackId) as Array<{
		track_id: string;
		kind: string;
		tag: string;
		source: string;
		confidence: number;
	}>;
	return rows
		.map((r) => ({
			trackId: r.track_id,
			kind: r.kind as TrackTag['kind'],
			tag: r.tag,
			source: r.source as TagSource,
			confidence: r.confidence,
		}))
		.sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source]);
}

/**
 * 把单个标签规范化成标签数组。
 *
 * 模型有时会把多个标签塞进一个字符串（实测出现过 `"pop folk"` / `"happy upbeat"`），
 * 直接入库的话它既不等于 `pop` 也不等于 `folk`，等于这个标签废了。
 * 读写两侧都要过一遍：写侧拆分，读侧兜住历史脏数据。
 */
export function normalizeTag(raw: string): string[] {
	return raw
		.toLowerCase()
		.split(/[\s,，、;；/|]+/)
		.map((t) => t.trim())
		.filter(Boolean);
}

export interface FusedTags {
	genres: string[];
	moods: string[];
}

/**
 * **融合标签视图**：一首歌实际生效的 genre / mood。
 *
 * 优先级 `user > llm > 原字段(id3)`，关键点是**取代而非并集**：
 * ID3 的 genre 经常是错的——实测本曲库 6 首中文流行全部被标成 `blues`，
 * 一旦把原字段并进来，"布鲁斯"就会命中全库，融合也就失去意义了。
 *
 * 所有需要"这首歌是什么风格/情绪"的地方（搜索匹配、电台编排、点播、
 * 注入给 Agent 的环境信息、空结果提示）都必须走这里，不要直接读 `song.genre`。
 */
export function fusedTags(song: { id: string; genre?: string; mood?: string }): FusedTags {
	const tags = getTrackTags(song.id);
	const pick = (kind: TrackTag['kind'], fallback?: string): string[] => {
		// 只认 user/llm：inferred 是从 genre 推的，源头错了它跟着错，不算独立证据。
		const authored = tags.filter((t) => t.kind === kind && (t.source === 'user' || t.source === 'llm'));
		const vals = [...new Set(authored.flatMap((t) => normalizeTag(t.tag)))];
		if (vals.length > 0) return vals;
		return fallback && fallback !== 'unknown' ? normalizeTag(fallback) : [];
	};
	return { genres: pick('genre', song.genre), moods: pick('mood', song.mood) };
}

/** 写入/更新一个标签：同键更高优先级（或更高置信度）才覆盖。 */
export function applyTag(
	trackId: string,
	kind: TrackTag['kind'],
	tag: string,
	source: TagSource,
	confidence = 0.5,
): void {
	const prio = SOURCE_PRIORITY[source];
	const existing = getTrackTags(trackId).find((t) => t.kind === kind && t.tag === tag);
	if (existing && SOURCE_PRIORITY[existing.source] > prio) return; // 低优先级不覆盖高优先级
	if (existing && SOURCE_PRIORITY[existing.source] === prio && existing.confidence >= confidence)
		return;
	getStmtTagInsert().run(trackId, kind, tag, source, confidence, nowIso());
}

let _tagInsert: ReturnType<DatabaseSync['prepare']> | null = null;
function getStmtTagInsert(): ReturnType<DatabaseSync['prepare']> {
	if (!_tagInsert) {
		_tagInsert = getDb().prepare(`
			INSERT INTO track_tags (track_id, kind, tag, source, confidence, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(track_id, kind, tag) DO UPDATE SET
				source = excluded.source,
				confidence = excluded.confidence,
				created_at = excluded.created_at
		`);
	}
	return _tagInsert;
}

/** 已有 LLM 标签的曲目集合（打标进度/跳过用）。 */
export function llmTaggedTrackIds(): Set<string> {
	if (!_llmTagged) {
		_llmTagged = getDb().prepare("SELECT DISTINCT track_id FROM track_tags WHERE source = 'llm'");
	}
	const rows = _llmTagged.all() as Array<{ track_id: string }>;
	return new Set(rows.map((r) => r.track_id));
}
