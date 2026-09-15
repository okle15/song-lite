/**
 * Library scanner —— 递归扫 `MUSIC_DIR`，用 `music-metadata` 解析 ID3。
 *
 * 取字段：common.title / common.artist / common.album / format.duration / 相对路径。
 * 不取 genre / mood / year —— 详见 `./index.ts` 的 Song 注释。
 *
 * 缓存：扫描是 I/O + 解析，代价高，结果在**进程存活期内** memo 一次。
 * 因此新增音频文件后需要重启服务才可见（当前体量下这是可接受的最简取舍）。
 */
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { parseFile } from 'music-metadata';
import type { Song } from './';
import { resolveMusicDir } from './music-dir';

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.opus', '.aac']);

/** 由标题生成 id；中文标题会被清空，此时调用方回落到 `track-N`。 */
function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** 递归收集 `dir` 下的音频文件绝对路径。 */
async function collectAudioFiles(dir: string): Promise<string[]> {
	const results: string[] = [];
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return results;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		let s;
		try {
			s = await stat(full);
		} catch {
			continue;
		}
		if (s.isDirectory()) {
			results.push(...(await collectAudioFiles(full)));
		} else if (AUDIO_EXTENSIONS.has(extname(entry).toLowerCase())) {
			results.push(full);
		}
	}
	return results;
}

let cachedSongs: Song[] | null = null;

/**
 * 扫描 `MUSIC_DIR` 并返回 `Song[]`。未配置或目录不存在时返回空数组
 * （调用方按「曲库为空」处理，不再有 mock 兜底）。
 */
export async function scanLibrary(): Promise<Song[]> {
	if (cachedSongs) return cachedSongs;

	const musicDir = resolveMusicDir();
	if (!musicDir) return [];

	const files = await collectAudioFiles(musicDir);
	if (files.length === 0) return [];

	const songs: Song[] = [];
	for (const filePath of files) {
		try {
			const metadata = await parseFile(filePath);
			const common = metadata.common;
			const relPath = relative(musicDir, filePath).replace(/\\/g, '/');
			const title = common.title ?? basename(filePath, extname(filePath));
			songs.push({
				// id 由标题派生；中文标题 slugify 后为空 → 用序号兜底。
				// 注意：兜底序号取自**排序前**的遍历顺序，改动这里会让已有 id 漂移。
				id: slugify(title) || `track-${songs.length + 1}`,
				title,
				artist: common.artist ?? 'Unknown Artist',
				album: common.album ?? 'Unknown Album',
				durationSec: Math.round(metadata.format.duration ?? 0),
				filePath: `/${relPath}`,
			});
		} catch (err) {
			console.warn(
				`[library-scanner] skipped ${filePath}: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	// 稳定排序：歌手 → 专辑 → 标题。也让上面那个序号兜底可复现。
	songs.sort(
		(a, b) =>
			a.artist.localeCompare(b.artist) ||
			a.album.localeCompare(b.album) ||
			a.title.localeCompare(b.title),
	);

	cachedSongs = songs;
	return songs;
}
