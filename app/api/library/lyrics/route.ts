/**
 * /api/library/lyrics — 歌词获取端点。
 *
 * `GET /api/library/lyrics?trackId=<id>` 返回 LRC 文本（前端解析后按 currentTime 高亮）。
 * 数据源**两步回退**：
 *   ① 音频文件内嵌（ID3v2 的 USLT 帧）—— 本曲库实测 6/6 首都有，读取零成本
 *   ② 同目录同名的 .lrc 文件 —— 给「没内嵌歌词」的曲库兜底
 *
 * ① 优先的理由是**归属**：内嵌歌词跟着音频文件走，改歌名 / 挪目录都不会失联，
 * 也不会出现「两份各存一套、久了不一致」的分裂（本机实测这两份逐字相同）。
 *
 * 路径解析（realpath 防穿越）走 `server/player/media.ts` 的 `resolveMusicFile`
 * —— 与音频流 / 封面共用同一份安全逻辑（2026-09-10 抽取）。
 *
 * 错误：
 * - 400 trackId 缺失
 * - 404 歌曲不在库 / 无歌词（内嵌与 .lrc 都没有）
 * - 403 路径穿越
 * - 503 未配置 MUSIC_DIR（仅回退路径需要）
 */
import { readFile } from 'node:fs/promises';
import { findSongById } from '@/server/library';
import { readEmbedded } from '@/server/library/embedded';
import { resolveMusicDir } from '@/server/library/music-dir';
import { ok, fail } from '@/server/http';
import { resolveMusicFile } from '@/server/player/media';

export async function GET(request: Request) {
	const url = new URL(request.url);
	const trackId = url.searchParams.get('trackId');
	if (!trackId) {
		return fail('trackId is required', 400);
	}

	const song = await findSongById(trackId);
	if (!song) {
		return fail(`track not found: ${trackId}`, 404);
	}

	// ① 内嵌优先：mp3 的 ID3v2 USLT 帧里通常就带着完整 LRC 文本。
	//    好处是这份歌词**跟着音频文件走** —— 改歌名 / 挪目录都不会让它失联，
	//    也不会出现「.lrc 与文件内各存一份、久了还不一致」的分裂。
	let text: string | null = null;
	if (song.hasLyrics) {
		const resolved = await resolveMusicFile(song.filePath);
		if (resolved.ok) {
			text = (await readEmbedded(resolved.realPath)).lyrics;
		}
	}

	// ② 回退：同目录同名的 .lrc 文件（别的曲库未必内嵌歌词，这条不能删）。
	if (!text) {
		const musicDir = resolveMusicDir();
		if (!musicDir) {
			return fail('MUSIC_DIR not configured', 503);
		}

		// 替换扩展名为 .lrc
		const relPath = song.filePath.replace(/\.[^.]+$/, '.lrc');
		const resolved = await resolveMusicFile(relPath);
		if (!resolved.ok) {
			if (resolved.reason === 'traversal') return fail('path traversal blocked', 403);
			// .lrc 文件不存在是正常情况（很多歌曲没歌词）
			return fail('no lyrics file for this track', 404);
		}

		try {
			// 去掉 BOM：本机 .lrc 带 BOM 而 USLT 不带，两条路产出保持一致。
			text = (await readFile(resolved.realPath, 'utf8')).replace(/^\uFEFF/, '');
		} catch {
			return fail('lyrics file unreadable', 404);
		}
	}

	if (!text) {
		// 走不到这里（② 的每个分支都已 return）；这行只为让类型从 `string | null` 收窄。
		return fail('no lyrics for this track', 404);
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
