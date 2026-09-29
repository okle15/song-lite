/**
 * 曲库体检 —— 「我的曲库现在什么状况」与「这一首什么状况」。
 *
 * ── 清单里的 `organize` 为什么落地成了「体检」而不是「整理文件」───────
 * 「整理」最直觉的实现是**把文件按歌手 / 专辑挪进子目录、或重命名**。这里刻意
 * 不做，两条判据都足够硬：
 *   ① `Song.id` 就是曲库内的**相对路径**（`scanner.ts` 文件头），改名 / 移动
 *      = **新 id** = `plays` 与 `track_tags` 全部失联。按项目里那条纪律：
 *      **改「唯一标识」= 数据迁移**，第一件事是全量扫持久引用。
 *   ② 本机**没有回收站**（跨项目环境备忘），删除 / 移动不可恢复。
 * 于是「整理」退化成**只读的体检报告**：它说清「库里缺什么」，动哪一处由人决定。
 * 报告里的 `untaggedIds` 是有真实消费者的：`npm run tag:library` 正需要
 * 「还没打标的歌」这份清单 —— **没有消费者的通用机制是负债**，这一项有。
 *
 * ── 两种粒度共用一个入口 ──────────────────────────────────────────────
 * `?trackId=` 给 → 单曲；不给 → 整库体检。与 `/api/library/tags` 的 GET
 * 同形（那边也是"给了 trackId 取单曲、不给取全表"），不另发明一种路由约定。
 *
 * ⚠️ 单曲**不过滤屏蔽**：`findSongById` 走 `getAllSongs()`。理由与音频流同侧 ——
 * 「这首歌被屏蔽了」不等于「这首歌不存在了」，体检要能回答"那首被我屏蔽的歌
 * 还有没有标签"。
 */
import { findSongById, getSongs, type Song } from './';
import { getTrackTags, listTrackTags, type TagSource } from './tags';
import { isFlagged, listFlagIds } from './flags';
import { playStatsFor } from '../records/play-log';

/** 扫描器填不出来的占位值（`scanner.ts` 的兜底）。体检把它们单独数出来。 */
const UNKNOWN_ARTIST = 'Unknown Artist';
const UNKNOWN_ALBUM = 'Unknown Album';

/** 整库体检。 */
export type LibraryReport = {
	/** 可见曲库有几首（**不含**被屏蔽的）。 */
	total: number;
	/**
	 * 被屏蔽了几首（**不在** total 里）。
	 *
	 * 数的是标记表里的行数，所以「屏蔽过一首后来文件被移走的歌」也在这里面 ——
	 * 那是用户**真的屏蔽过**的东西，不该因为文件没了就从数字里消失
	 * （与 `FlagRow.missing` 必须照旧列出来同一条）。
	 */
	hidden: number;
	/** 有标签 / 没标签各几首（两者之和 = total）。 */
	withTags: number;
	withoutTags: number;
	/** 扫描器没能从 ID3 读出歌手 / 专辑的各有几首。 */
	unknownArtist: number;
	unknownAlbum: number;
	/** 库里一共有几个不同的歌手 / 专辑（按可见曲库算）。 */
	artistCount: number;
	albumCount: number;
	/**
	 * 有几首配上了**同名伴生视频**（`X.mp4` 配 `X.mp3`）。
	 *
	 * 它是一个**库事实**，不进 `Song` 的契约面也说得通，但体检的意义正是
	 * 「说清盘上有什么」：用户以为丢了视频时，这里能回答「6 首里 2 首配上了」。
	 * 配对规则只按同名，所以配不上的通常是命名对不齐（见 `./video.ts`）。
	 */
	withVideo: number;
	/**
	 * 还没打标的曲目 id。**打标脚本与 agent 的输入**，所以要给 id 而不是只给数字：
	 * 只说「有 3 首没打标」等于让人自己去猜是哪 3 首（与 `list_hidden` 必须带 id
	 * 同一条判据：**看得见但动不了 = 没给**）。
	 */
	untaggedIds: string[];
};

/** 单曲详情 = 文件事实 + 派生态。 */
export type TrackReport = {
	song: Song;
	/** 标签（可能为空数组 = 还没人标过）。 */
	tags: string[];
	/** 这组标签是谁写的。没有标签时是 `null`。 */
	tagSource: TagSource | null;
	favorite: boolean;
	hidden: boolean;
	/** 播过几次。**null = 读不出来**（不是 0 次）。 */
	playCount: number | null;
	lastPlayedAt: string | null;
};

/**
 * 体检报告本身 —— **纯函数**（输入曲目 / 标签 / 屏蔽条数，输出报告）。
 *
 * 与 `groups.ts` 的 `bucketSongs()` 同一条理由：规则值得单独测，
 * 而喂一份自己造的曲库比真去扫音频文件容易得多。
 *
 * 数字一律从**可见曲库**算（与检索 / 分组同侧），只有 `hidden` 是例外 ——
 * 它说的正是「被排除在外的那部分」，所以它必须在 `total` 之外单列，
 * 否则「库里 6 首、3 首没标签」会与「我屏蔽了 2 首」互相矛盾。
 */
export function buildReport(
	songs: readonly Song[],
	tagsById: ReadonlyMap<string, string[]>,
	hidden: number,
): LibraryReport {
	const untaggedIds: string[] = [];
	let withoutTags = 0;
	for (const song of songs) {
		if ((tagsById.get(song.id) ?? []).length === 0) {
			withoutTags += 1;
			untaggedIds.push(song.id);
		}
	}

	return {
		total: songs.length,
		hidden,
		withTags: songs.length - withoutTags,
		withoutTags,
		unknownArtist: songs.filter((s) => s.artist === UNKNOWN_ARTIST).length,
		unknownAlbum: songs.filter((s) => s.album === UNKNOWN_ALBUM).length,
		artistCount: new Set(songs.map((s) => s.artist)).size,
		albumCount: new Set(songs.map((s) => s.album)).size,
		withVideo: songs.filter((s) => s.videoPath !== null).length,
		untaggedIds,
	};
}

/** 整库体检（取数层：`getSongs()` + 标签表 + 屏蔽条数 → `buildReport`）。 */
export async function inspectLibrary(): Promise<LibraryReport> {
	const songs = await getSongs();
	const tagsById = new Map(listTrackTags().map((t) => [t.trackId, t.tags]));
	return buildReport(songs, tagsById, listFlagIds('hidden').length);
}

/** 单曲详情。曲目不存在（文件不在曲库里了）→ `null`。 */
export async function inspectTrack(trackId: string): Promise<TrackReport | null> {
	const song = await findSongById(trackId);
	if (!song) return null;

	const tags = getTrackTags(trackId);
	const stats = playStatsFor(trackId);

	return {
		song,
		tags: tags?.tags ?? [],
		tagSource: tags?.source ?? null,
		favorite: isFlagged('favorite', trackId),
		hidden: isFlagged('hidden', trackId),
		playCount: stats?.count ?? null,
		lastPlayedAt: stats?.lastPlayedAt ?? null,
	};
}
