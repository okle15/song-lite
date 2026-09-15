/**
 * Stream video route — MV / 独立视频流端点。
 *
 * `GET /api/library/stream-video?trackId=<id>`  → 播该曲目配对的 MV（mvPath）
 * `GET /api/library/stream-video?asset=<id>`    → 播独立视频资产
 *
 * 与音频流同款：Range 请求支持拖进度、realpath 防穿越 —— 这两段现在都由
 * `server/player/media.ts` 提供（2026-09-10 抽取），不再是各写一份。视频永远**按需**
 * 拉流 —— 音频照常从 /api/library/stream 出，两种资产彻底分离（音频单独播放
 * 是默认态，视频只在用户点「看 MV」时才有流量）。
 */
import { stat } from 'node:fs/promises';
import { findSongById } from '@/server/library';
import { listVideoAssets } from '@/server/library/scanner';
import { resolveMusicDir } from '@/server/library/music-dir';
import { fail } from '@/server/http';
import { contentTypeFor, mediaResponse, resolveMusicFile } from '@/server/player/media';

const CONTENT_TYPES: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.mov': 'video/quicktime',
	'.mkv': 'video/x-matroska',
	'.webm': 'video/webm',
	'.avi': 'video/x-msvideo',
};

export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;

	const musicDir = resolveMusicDir();
	if (!musicDir) {
		return fail('MUSIC_DIR not configured', 503);
	}

	// trackId → 该曲目配对的 MV；asset → 独立视频资产。两者都没有则 404。
	const trackId = params.get('trackId');
	const assetId = params.get('asset');
	let relPath: string | null = null;
	if (trackId) {
		const song = await findSongById(trackId);
		relPath = song?.mvPath ?? null;
	} else if (assetId) {
		const asset = (await listVideoAssets()).find((v) => v.id === assetId);
		relPath = asset?.filePath ?? null;
	}

	// 解析失败（无 mvPath / 资产不存在 / 文件不在盘 / 路径穿越）一律 404 —— 保持
	// 原行为：这里不区分穿越，避免对外暴露"这个路径存在但被拦了"。
	const notFound = () => fail('video not found (trackId 无 mvPath 或 asset 不存在)', 404);
	if (!relPath) return notFound();

	const resolved = await resolveMusicFile(relPath);
	if (!resolved.ok) return notFound();

	let size: number;
	try {
		size = (await stat(resolved.realPath)).size;
	} catch {
		return fail('file stat failed', 404);
	}

	const contentType = contentTypeFor(resolved.realPath, CONTENT_TYPES, 'video/mp4');

	return mediaResponse(resolved.realPath, size, contentType, request.headers.get('range'));
}
