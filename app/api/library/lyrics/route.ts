/**
 * /api/library/lyrics — 歌词获取端点。
 *
 * `GET /api/library/lyrics?trackId=<id>` 查找同目录下的 .lrc 文件（音频文件
 * 同名，扩展名 .lrc），返回 LRC 文本。前端解析后按 currentTime 高亮。
 *
 * 路径解析（realpath 防穿越）走 `server/player/media.ts` 的 `resolveMusicFile`
 * —— 与音频流 / 视频流共用同一份安全逻辑（2026-09-10 抽取）。
 *
 * 错误：
 * - 400 trackId 缺失
 * - 404 歌曲不在库 / 无歌词文件
 * - 403 路径穿越
 * - 503 未配置 MUSIC_DIR
 */
import { readFile } from 'node:fs/promises';
import { findSongById } from '@/server/library';
import { resolveMusicDir } from '@/server/library/music-dir';
import { ok, fail } from '@/server/http';
import { resolveMusicFile } from '@/server/player/media';

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

	// 替换扩展名为 .lrc
	const relPath = song.filePath.replace(/\.[^.]+$/, '.lrc');
	const resolved = await resolveMusicFile(relPath);
	if (!resolved.ok) {
		if (resolved.reason === 'traversal') return fail('path traversal blocked', 403);
		// .lrc 文件不存在是正常情况（很多歌曲没歌词）
		return fail('no lyrics file for this track', 404);
	}

	let text: string;
	try {
		text = await readFile(resolved.realPath, 'utf8');
	} catch {
		return fail('lyrics file unreadable', 404);
	}

	// APlayer 的 lrcType=1 需要纯 LRC 文本响应（fetch 后直接当 LRC 解析）。
	// `?raw=1` 跳过 JSON 包裹，返回 text/plain 的原始 LRC。
	const raw = url.searchParams.get('raw') === '1';
	if (raw) {
		return new Response(text, {
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}

	return ok({ lrc: text, trackId });
}
