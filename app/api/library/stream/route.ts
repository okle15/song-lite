/**
 * Stream route — 音频流端点。
 *
 * `GET /api/library/stream?trackId=<id>` 返回原始音频字节流，前端 `<audio>`
 * 元素直接消费。支持 HTTP Range 请求（拖动进度条 / seek）。
 *
 * 路径解析与 Range 响应构造走 `server/player/media.ts`，与 `lyrics` 共用同一份安全逻辑。
 *
 * 错误：
 * - 400 trackId 缺失
 * - 404 歌曲不在库 / 文件不存在
 * - 403 路径穿越
 * - 503 未配置 MUSIC_DIR
 */
import { stat } from 'node:fs/promises';
import { findSongById } from '@/server/library';
import { resolveMusicDir } from '@/server/library/music-dir';
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
		return fail('MUSIC_DIR not configured', 503);
	}

	const song = await findSongById(trackId);
	if (!song) {
		return fail(`track not found: ${trackId}`, 404);
	}

	// Song.filePath 形如 '/凤鸣传奇.mp3'，带前导斜杠。
	const relPath = song.filePath;
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

	const contentType = contentTypeFor(song.filePath, CONTENT_TYPES, 'application/octet-stream');

	return mediaResponse(resolved.realPath, size, contentType, request.headers.get('range'));
}
