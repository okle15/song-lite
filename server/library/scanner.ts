/**
 * Library scanner —— 递归扫 `MUSIC_DIR`，用 `music-metadata` 解析 ID3。
 *
 * ── 取哪些字段（2026-09-17 起）────────────────────────────────────
 *   title / artist / album / duration / 相对路径   播放链路要的
 *   hasLyrics / hasCover   只记「文件里有没有内嵌歌词与封面」两个布尔
 *                          —— 本曲库实测 6/6 首都有（USLT 与 APIC 帧齐全）。
 *                          正文与字节不在这里：由 `embedded.ts` 按需读，
 *                          免得 `Song` 带着几十 KB 常驻内存、还撑胖列表响应。
 *
 * **不取 genre**：本曲库 ID3 的 genre 全被误标（6 首中文流行全标成 `blues`）。
 * 风格交给 LLM 打底 + 用户覆盖，落在 `track_tags` 表（见 `server/library/tags.ts`）。
 *
 * ── id 为什么是路径 ──────────────────────────────────────────────
 * `id = 相对 MUSIC_DIR 的路径`，如 `全是爱 - 凤凰传奇.mp3`。
 * 它必须**稳定**：`plays` 与 `track_tags` 都拿它当外键，id 一漂，播放历史和标签
 * 就都成孤儿。旧实现是 `slugify(title) || track-N` —— 中文标题 slugify 后为空，
 * 于是全部回落到 `track-N`，而 N 取自**排序前的遍历顺序**，多一首歌就可能让所有
 * id 偏移。路径是唯一同时满足「稳定 / 唯一 / 免费（readdir 就有）」的候选；
 * 用标题或文件名则会在「同名不同版本」「不同歌手的同名曲」上撞车（且不报错）。
 *
 * 已知代价：**改名或移动 = 新 id**，旧标签失联。这是路径寻址的固有性质，
 * 换内容指纹才能免疫，但要读整份音频文件，不划算。
 *
 * ── 缓存 ─────────────────────────────────────────────────────────
 * 扫描是 I/O + 解析，代价高（实测 6 首 34.2MB ≈ 147ms，其中解析占 138ms），
 * 结果在**进程存活期内** memo 一次。因此新增音频文件后需要重启服务才可见
 * （当前体量下这是可接受的最简取舍）。
 *
 * 顺带一提：`parseFile` 在扫描时已经把整个 metadata（含 USLT / APIC 帧）读出来了，
 * 所以判断 `hasLyrics` / `hasCover` 是**零额外 I/O**；但**内容本身刻意不留**
 * —— 代价是命中 embedded 缓存前多一次 `parseFile`（实测 ≈23ms/首），
 * 换来 `Song` 保持轻量、列表响应不被歌词撑胖。
 */
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { parseFile } from 'music-metadata';
import type { Song } from './';
import { resolveMusicDir } from './music-dir';

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.opus', '.aac']);

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
			songs.push({
				// id 就是曲库内的相对路径 —— 见文件头「id 为什么是路径」。
				id: relPath,
				title: common.title ?? basename(filePath, extname(filePath)),
				artist: common.artist ?? 'Unknown Artist',
				album: common.album ?? 'Unknown Album',
				durationSec: Math.round(metadata.format.duration ?? 0),
				filePath: `/${relPath}`,
				// 只记「有没有」—— 字节/文本由 readEmbedded() 按需取（见 embedded.ts）。
				hasLyrics: Boolean(common.lyrics?.some((one) => one.text?.trim())),
				hasCover: (common.picture?.length ?? 0) > 0,
			});
		} catch (err) {
			console.warn(
				`[library-scanner] skipped ${filePath}: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	// 稳定排序：歌手 → 专辑 → 标题。
	songs.sort(
		(a, b) =>
			a.artist.localeCompare(b.artist) ||
			a.album.localeCompare(b.album) ||
			a.title.localeCompare(b.title),
	);

	cachedSongs = songs;
	return songs;
}
