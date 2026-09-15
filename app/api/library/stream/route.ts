/**
 * Stream route — 方案 C 音频流端点。
 *
 * `GET /api/library/stream?trackId=<id>` 返回原始音频字节流，前端 `<audio>`
 * 元素直接消费。支持 HTTP Range 请求（拖动进度条 / seek）。
 *
 * 路径解析与 Range 响应构造已抽到 `server/player/media.ts`（2026-09-10）——原先这段
 * 与 `stream-video`、`lyrics` 三处各抄一份，抽出来时已发现两处漂移。
 *
 * 错误：
 * - 400 trackId 缺失
 * - 404 歌曲不在库 / 文件不存在（mock 歌曲）
 * - 403 路径穿越
 * - 503 未配置 MUSIC_DIR 且无演示目录
 */
import { stat } from 'node:fs/promises';
import { findSongById } from '@/server/library';
import { resolveMusicDir } from '@/server/library/music-dir';
import { enqueueLazy } from '@/server/radio/tagger';
import { fail } from '@/server/http';
import { contentTypeFor, mediaResponse, resolveMusicFile } from '@/server/player/media';

const CONTENT_TYPES: Record<string, string> = {
	'.wav': 'audio/wav',
	'.mp3': 'audio/mpeg',
	'.flac': 'audio/flac',
	'.ogg': 'audio/ogg',
	'.m4a': 'audio/mp4',
	'.opus': 'audio/opus',
	'.aac': 'audio/aac',
};

export async function GET(request: Request) {
	const url = new URL(request.url);
	const trackId = url.searchParams.get('trackId');
	if (!trackId) {
		return fail('trackId is required', 400);
	}

	const musicDir = resolveMusicDir();
	if (!musicDir) {
		return fail('MUSIC_DIR not configured and no demo library present', 503);
	}

	const song = await findSongById(trackId);
	if (!song) {
		return fail(`track not found: ${trackId}`, 404);
	}

	// 「边放边判断」钩子：任何真实播放都会经过这里拉流 —— 顺手把还没
	// LLM 标签的歌塞进串行后台队列（fire-and-forget，不阻塞音频响应）。
	enqueueLazy(trackId);

	// Song.filePath 形如 '/jazz/take-five.wav'，带前导斜杠。
	const relPath = song.filePath;
	const resolved = await resolveMusicFile(relPath);
	if (!resolved.ok) {
		if (resolved.reason === 'traversal') return fail('path traversal blocked', 403);
		return fail(`file not on disk: ${relPath.replace(/^\/+/, '')} (mock song?)`, 404);
	}

	let size: number;
	try {
		size = (await stat(resolved.realPath)).size;
	} catch {
		return fail('file stat failed', 404);
	}

	const contentType = contentTypeFor(song.filePath, CONTENT_TYPES, 'application/octet-stream');

	return mediaResponse(resolved.realPath, size, contentType, request.headers.get('range'));
}
