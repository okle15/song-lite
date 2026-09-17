/**
 * Music library data source.
 *
 * 曲库 = 对 `MUSIC_DIR` 的一次目录扫描（`scanner.ts`），结果在进程内 memo。
 *
 * **曲库不落库**：它的真相永远在文件系统上，再存一份到 SQLite 只会引入
 * 「表里的行和盘上的文件对不上」这类问题。数据库只承载**扫描不出来的**东西
 * —— 播放历史（`plays`）与**风格标签**（`track_tags`：LLM 打底 + 用户覆盖，
 * 见 `./tags.ts`）。两处都按 `Song.id`（即曲库内相对路径）关联。
 */
import { scanLibrary } from './scanner';

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
};

/** 当前曲库（扫描 `MUSIC_DIR`，结果进程内缓存）。 */
export async function getSongs(): Promise<Song[]> {
	return scanLibrary();
}

/** Find a song by id. */
export async function findSongById(id: string): Promise<Song | undefined> {
	const songs = await getSongs();
	return songs.find((song) => song.id === id);
}
