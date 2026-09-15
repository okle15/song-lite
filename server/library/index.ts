/**
 * Music library data source.
 *
 * 曲库 = 对 `MUSIC_DIR` 的一次目录扫描（`scanner.ts`），结果在进程内 memo。
 *
 * **曲库不落库**：它的真相永远在文件系统上，再存一份到 SQLite 只会引入
 * 「表里的行和盘上的文件对不上」这类问题。数据库只承载**扫描不出来的**东西
 * ——目前是播放历史（见 `server/db.ts`）。
 */
import { scanLibrary } from './scanner';

/**
 * 一首曲目 —— 只留播放链路真正用到的字段。
 *
 * 刻意**不含** genre / mood / year：它们早期是为电台打标与语义搜索取的，
 * 而本曲库的 ID3 genre 全被误标（6 首中文流行全标成 blues）。没有校正层时
 * 留着这些字段只会误导下游，索性不收。
 */
export type Song = {
	id: string;
	title: string;
	artist: string;
	album: string;
	durationSec: number;
	/** 相对 MUSIC_DIR 的路径，带前导斜杠，如 '/凤鸣传奇.mp3'。 */
	filePath: string;
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
