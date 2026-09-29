/**
 * Music library data source.
 *
 * 曲库 = 对 `MUSIC_DIR` 的一次目录扫描（`scanner.ts`），结果在进程内 memo。
 *
 * **曲库不落库**：它的真相永远在文件系统上，再存一份到 SQLite 只会引入
 * 「表里的行和盘上的文件对不上」这类问题。数据库只承载**扫描不出来的**东西
 * —— 播放历史（`plays`）、**风格标签**（`track_tags`：LLM 打底 + 用户覆盖，
 * 见 `./tags.ts`）与**收藏 / 屏蔽**（`favorites` / `hidden`，见 `../library/flags.ts`）。
 * 三处都按 `Song.id`（即曲库内相对路径）关联。
 *
 * ⚠️ 本文件导出的 `getSongs()` **不是**扫描结果的原文，而是「可见曲库」
 * （屏蔽过滤之后）。要未过滤的那一份用 `getAllSongs()`。两者的分工写在
 * `getAllSongs` 的注释里 —— 那是本文件最容易用错的一处。
 */
import { scanLibrary } from './scanner';
import { hiddenIds } from './flags';
import { mergePreservingHidden } from './visible';

/**
 * 一首曲目 —— 「能直接从文件里读出来」的那部分。
 *
 * 刻意**不含** genre：ID3 的该字段在本曲库全被误标（6 首中文流行全标成 blues），
 * 不可信。风格改由 `track_tags` 表承载（LLM 打底 + 用户覆盖，见 `./tags.ts`）。
 *
 * 这条边界值得记住：**`Song` = 扫描产物，派生数据一律走库。**
 * 曲名 / 歌手 / 专辑 / 时长 / 歌词 / 封面都在文件里，所以不落库；
 * 只有「LLM 判断出来的」和「用户设定的」才落库。
 */
export type Song = {
	/**
	 * 曲库内的相对路径，如 `全是爱 - 凤凰传奇.mp3`（不带前导斜杠）。
	 *
	 * 必须**稳定**：`plays` 与 `track_tags` 都拿它当外键，id 一漂，播放历史与标签
	 * 就都成孤儿。选路径而不是标题，是因为标题会撞（同名不同版本、不同歌手的同名曲），
	 * 而路径由文件系统保证唯一。详见 `scanner.ts` 文件头。
	 */
	id: string;
	title: string;
	artist: string;
	album: string;
	durationSec: number;
	/** 相对 MUSIC_DIR 的路径，带前导斜杠，如 '/凤鸣传奇.mp3'。 */
	filePath: string;
	/**
	 * 文件里有没有内嵌歌词（ID3v2 的 USLT 帧）/ 封面（APIC 帧）。
	 *
	 * 只留布尔、不留内容：正文与字节都由 `./embedded.ts` 按需读。
	 * 若把歌词正文塞进 `Song`，每次「列出整库」的响应都会带上十几 KB × N 首。
	 */
	hasLyrics: boolean;
	hasCover: boolean;
	/**
	 * **同名的伴生视频**（`X.mp4` 配 `X.mp3`）的曲库内相对路径，带前导斜杠；
	 * 没有配对就是 `null`。
	 *
	 * ⚠️ 它**不参与 `id`** —— id 永远只是音频的相对路径。这是「伴生」的定义：
	 * 视频是这首歌的一个**表面**，不是第二个实体（不单独进队列、不单独记 `plays`）。
	 * 于是给一首歌加 / 删视频文件**不是数据迁移**，`plays` 与 `track_tags` 一行不动。
	 *
	 * 配对规则（同名同目录、扩展名优先级）与理由在 `./video.ts`。
	 */
	videoPath: string | null;
};

/**
 * **全部**曲目（含被屏蔽的）—— 曲库扫描的原始结果。
 *
 * 与下面 `getSongs()` 的分工是本文件最重要的一条约定：**按 id 取单曲走这里。**
 * 因为「被屏蔽」是一种**视图过滤**，不是「这首歌不存在了」：文件还在盘上，
 * 音频流要放得出来、歌词封面要读得到、屏蔽清单要能显示它的曲名。
 * 若按 id 也查不到被屏蔽的歌，`/api/library/stream` 会对一首**正在播**的歌 404。
 */
export async function getAllSongs(): Promise<Song[]> {
	return scanLibrary();
}

/**
 * **可见曲库** —— 屏蔽过滤之后的那一份。**「列出 / 检索 / 组队列」一律走它。**
 *
 * 为什么过滤点放在**这里**而不是各个调用方：曲库有六七个出口（检索、
 * 整库队列、恢复整库、点播时的 `ensureQueue`…），在一处写过滤、在别处忘掉，
 * 后果是「被屏蔽的歌从某一条路回来了」——而队列本来就长成「一批歌」，
 * 多一首**看不出来**、测试也不红。做成 `getSongs()` 的语义之后，
 * **所有既有调用点一行都不用改**就都对了（它们本来就都在调它）。
 *
 * 反过来说，`findSongById` 与 `getAllSongs` 必须**不过滤**（见上面的说明）：
 * 过滤的是「列出什么」，不是「这首歌存不存在」。
 *
 * 规则本身（以及红线「不许绕过 `mergePreservingHidden()`」）在 `./visible.ts`。
 */
export async function getSongs(): Promise<Song[]> {
	return mergePreservingHidden(await scanLibrary(), hiddenIds());
}

/** Find a song by id. **不过滤屏蔽**（理由见 `getAllSongs`）。 */
export async function findSongById(id: string): Promise<Song | undefined> {
	const songs = await getAllSongs();
	return songs.find((song) => song.id === id);
}
