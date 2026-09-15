/**
 * Library scanner — Phase 7.
 *
 * Decision H1/H2: uses the `music-metadata` npm package to scan the directory
 * pointed at by `MUSIC_DIR` (env) and returns a `Song[]` that drop-in
 * replaces the Phase 2 hardcoded `SONGS` array.
 *
 * Audio metadata fields → Song mapping:
 * - common.title   → title
 * - common.artist  → artist
 * - common.album   → album
 * - common.year    → year
 * - common.genre   → genre (first entry; lowercased)
 * - format.duration → durationSec (rounded)
 * - file path      → filePath + id (slugified)
 * - common.comment → mood (if comment contains "mood:xxx", extract xxx;
 *   otherwise derive from genre via MOOD_BY_GENRE fallback map)
 *
 * Caching: scanning is I/O-heavy, so the result is memoized per-process.
 * A dev-mode cache buster is exposed via `invalidateScanCache()` so a
 * file watcher or manual "rescan" button could force a refresh.
 */
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { parseFile } from 'music-metadata';
import type { Song } from './';
import { resolveMusicDir } from './music-dir';

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.opus', '.aac']);
/** 视频资产（MV）。电台的音频编排不排它们，但作为「看 MV」资源与独立资产索引。 */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi']);

/** Fallback mood when the file has no `mood:` comment. keyed by genre. */
const MOOD_BY_GENRE: Record<string, string> = {
	jazz: 'relaxed',
	rock: 'energetic',
	classical: 'peaceful',
	pop: 'upbeat',
	ambient: 'calm',
	electronic: 'hypnotic',
	rnb: 'smooth',
	soul: 'soulful',
	folk: 'warm',
};

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Recursively collect audio file paths under `dir`. */
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

/** Recursively collect video (MV) file paths under `dir`. */
async function collectVideoFiles(dir: string): Promise<string[]> {
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
			results.push(...(await collectVideoFiles(full)));
		} else if (VIDEO_EXTENSIONS.has(extname(entry).toLowerCase())) {
			results.push(full);
		}
	}
	return results;
}

/** 配对/索引用的标题归一化：小写 + 去空白标点（中英通用）。 */
function normalizeTitle(s: string): string {
	return s
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 从 MV 文件名解析「歌手 - 标题」约定（也容忍单段「标题」）。
 * 「周杰伦 - 晴天.mp4」→ { artist: '周杰伦', title: '晴天' }
 * 「晴天(Live).mp4」   → { artist: '', title: '晴天(Live)' }
 */
function parseVideoName(fileName: string): { artist: string; title: string } {
	const stem = basename(fileName, extname(fileName));
	const dash = stem.split(/\s[-–—]\s/);
	if (dash.length >= 2) {
		return { artist: dash[0].trim(), title: dash.slice(1).join(' - ').trim() };
	}
	return { artist: '', title: stem.trim() };
}

/** Extract mood from the comment field ("mood:xxx") or fall back to genre. */
function resolveMood(comments: unknown, genre: string): string {
	if (Array.isArray(comments)) {
		for (const c of comments) {
			if (typeof c !== 'string') continue;
			const match = c.match(/mood:\s*([a-z]+)/i);
			if (match) return match[1].toLowerCase();
		}
	}
	return MOOD_BY_GENRE[genre] ?? 'neutral';
}

let cachedSongs: Song[] | null = null;
let cachedVideoAssets: VideoAsset[] | null = null;

/** Invalidate the in-memory cache so the next `loadLibrary()` rescans. */
export function invalidateScanCache(): void {
	cachedSongs = null;
	cachedVideoAssets = null;
}

/** 独立 MV 资产（没配对到任何音频曲目的视频）：可检索、可后续做视频播放页。 */
export type VideoAsset = {
	id: string;
	title: string;
	artist: string;
	filePath: string;
};

export async function listVideoAssets(): Promise<VideoAsset[]> {
	if (cachedVideoAssets) return cachedVideoAssets;
	const musicDir = resolveMusicDir();
	if (!musicDir) return [];
	const videos = await collectVideoFiles(musicDir);
	const assets: VideoAsset[] = videos.map((filePath, i) => {
		const { artist, title } = parseVideoName(filePath);
		const relPath = relative(musicDir, filePath).replace(/\\/g, '/');
		return {
			id: `mv-${slugify(title) || i}`,
			title,
			artist,
			filePath: `/${relPath}`,
		};
	});
	cachedVideoAssets = assets;
	return assets;
}

/**
 * Scan `MUSIC_DIR` and return a `Song[]`. Returns an empty array if
 * `MUSIC_DIR` is unset or the directory doesn't exist (caller should fall
 * back to mock data in that case).
 *
 * Results are cached for the lifetime of the process; call
 * `invalidateScanCache()` to force a rescan.
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
			const title = common.title ?? basename(filePath, extname(filePath));
			const artist = common.artist ?? 'Unknown Artist';
			const album = common.album ?? 'Unknown Album';
			const year = common.year ?? 0;
			const genre = (common.genre?.[0] ?? 'unknown').toLowerCase();
			const durationSec = Math.round(metadata.format.duration ?? 0);
			const mood = resolveMood(common.comment as unknown, genre);
			const relPath = relative(musicDir, filePath).replace(/\\/g, '/');
			const id = slugify(title) || `track-${songs.length + 1}`;

			songs.push({
				id,
				title,
				artist,
				album,
				year,
				genre,
				mood,
				durationSec,
				filePath: `/${relPath}`,
			});
		} catch (err) {
			// Skip unparseable files but log to server console for debugging.
			console.warn(`[library-scanner] skipped ${filePath}: ${err instanceof Error ? err.message : err}`);
		}
	}

	// Sort by artist then album then title for stable ordering.
	songs.sort((a, b) =>
		a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || a.title.localeCompare(b.title),
	);

	// ── MV 配对：视频按「歌手 - 标题」或标题归一化后挂到对应音频曲目上 ──
	// 「晴天.mp4」/「周杰伦 - 晴天.mp4」→ 晴天.mvPath。配不上的视频留在
	// listVideoAssets() 里作为独立资产（不参与音频电台编排）。
	try {
		const musicDir2 = resolveMusicDir();
		if (musicDir2) {
			const videos = await collectVideoFiles(musicDir2);
			const byTitle = new Map<string, Song>(songs.map((s) => [normalizeTitle(s.title), s]));
			const paired = new Set<string>();
			for (const v of videos) {
				const { artist, title } = parseVideoName(v);
				const relPath = relative(musicDir2, v).replace(/\\/g, '/');
				const key = normalizeTitle(title);
				const hit = byTitle.get(key);
				if (hit && !hit.mvPath) {
					// 标题一致即配对；解析得出歌手名一致则更稳（但不强求——现场版命名花样多）
					if (!artist || normalizeTitle(artist) === normalizeTitle(hit.artist)) {
						hit.mvPath = `/${relPath}`;
						paired.add(v);
					}
				}
			}
			cachedVideoAssets = videos
				.filter((v) => !paired.has(v))
				.map((filePath, i) => {
					const { artist, title } = parseVideoName(filePath);
					const relPath = relative(musicDir2, filePath).replace(/\\/g, '/');
					return { id: `mv-${slugify(title) || i}`, title, artist, filePath: `/${relPath}` };
				});
		}
	} catch (err) {
		console.warn(`[library-scanner] mv pairing skipped: ${err instanceof Error ? err.message : err}`);
	}

	cachedSongs = songs;
	return songs;
}
