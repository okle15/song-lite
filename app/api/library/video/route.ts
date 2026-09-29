/**
 * /api/library/video —— **伴生视频**的字节流（`X.mp4` 配 `X.mp3`）。
 *
 * 形状与 `/api/library/stream` 逐条对齐（同一条路径解析 + Range 响应，
 * 走 `server/player/media.ts`），只有两处不同：**取的是 `song.videoPath`**，
 * 以及 content-type 表来自 `server/library/video.ts`（与扩展名清单同一处，
 * 少一行就会被单测拦住）。
 *
 * ── 为什么是独立路由而不是给 `stream` 加个 `type=video` ────────────────
 * `stream` 是**音频**流：它喂 `<audio>` 与 APlayer，也是断点续传 / 进度条那整条
 * 链的输入。把视频塞进同一个 URL 形状，就等于让「音频流」这个说法有了两种含义
 * ——而错的那一次不会报错，只会让播放器静默拿到一段它解不了的字节。
 *
 * ⚠️ **必须走 `findSongById`（不过滤屏蔽）**，与 `stream` / `cover` / `lyrics`
 * 完全同一条理由：「被屏蔽」是**视图过滤**，不是「这首歌不存在了」。正在播的那首
 * 歌被顺手屏蔽之后，它的画面还该放得出来 —— 否则用户得到的是「歌在响、画面没了」
 * （见 `server/library/index.ts` 的 `getAllSongs`）。
 *
 * 错误：400 缺 trackId · 404 歌不在库 / 没有伴生视频 / 文件不在盘上 ·
 *       403 路径穿越 · 503 未配置 MUSIC_DIR。
 */
import { stat } from 'node:fs/promises';
import { findSongById } from '@/server/library';
import { resolveMusicDir } from '@/server/library/music-dir';
import { VIDEO_CONTENT_TYPES } from '@/server/library/video';
import { fail } from '@/server/http';
import { contentTypeFor, mediaResponse, resolveMusicFile } from '@/server/player/media';

export async function GET(request: Request) {
	const url = new URL(request.url);
	const trackId = url.searchParams.get('trackId');
	if (!trackId) {
		return fail('trackId is required', 400);
	}

	const musicDir = resolveMusicDir();
	if (!musicDir) {
		return fail('MUSIC_DIR not configured', 503);
	}

	const song = await findSongById(trackId);
	if (!song) {
		return fail(`track not found: ${trackId}`, 404);
	}

	// 没有伴生视频 = 404，而不是回落到音频：回落到音频会让 `<video>` 拿到一段
	// 它解不了的字节，然后**静默不播** —— 那种"没有反应"比一个 404 难查得多。
	const relPath = song.videoPath;
	if (!relPath) {
		return fail(`no companion video for track: ${trackId}`, 404);
	}

	const resolved = await resolveMusicFile(relPath);
	if (!resolved.ok) {
		if (resolved.reason === 'traversal') return fail('path traversal blocked', 403);
		return fail(`file not on disk: ${relPath.replace(/^\/+/, '')}`, 404);
	}

	let size: number;
	try {
		size = (await stat(resolved.realPath)).size;
	} catch {
		return fail('file stat failed', 404);
	}

	const contentType = contentTypeFor(relPath, VIDEO_CONTENT_TYPES, 'application/octet-stream');

	return mediaResponse(resolved.realPath, size, contentType, request.headers.get('range'));
}
