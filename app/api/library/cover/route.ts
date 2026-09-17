/**
 * /api/library/cover — 封面图端点。
 *
 * `GET /api/library/cover?trackId=<id>` 返回该曲目**内嵌封面**（ID3v2 的 APIC 帧）
 * 的原始字节，前端 `<img>` 直接消费。没有封面时 404 —— 前端据此回落到渐变封面，
 * 所以「无封面」不是错误路径，是正常分支。
 *
 * 为什么按需取、而不在扫描时读进 Song：封面是二进制（每张几十到几百 KB），
 * 随 Song 常驻内存会让曲库稍大就白占几十 MB。扫描只记 `hasCover` 布尔
 * （见 `scanner.ts`），字节由 `server/library/embedded.ts` 按需读并缓存
 * —— 那份读取逻辑与歌词共用（同一个 `parseFile`、同一套兜底）。
 *
 * 路径解析走 `server/player/media.ts` 的 `resolveMusicFile` —— 与音频流 / 歌词
 * 共用同一份防穿越逻辑。
 *
 * 错误：
 * - 400 trackId 缺失
 * - 404 歌曲不在库 / 该曲目没有内嵌封面
 * - 403 路径穿越
 * - 503 未配置 MUSIC_DIR
 */
import { findSongById } from '@/server/library';
import { readEmbedded, type EmbeddedCover } from '@/server/library/embedded';
import { resolveMusicFile } from '@/server/player/media';
import { fail } from '@/server/http';

function imageResponse(cover: EmbeddedCover): Response {
	return new Response(cover.data as unknown as BodyInit, {
		headers: {
			'Content-Type': cover.type,
			'Content-Length': String(cover.data.byteLength),
			// 封面几乎不变；浏览器缓存能省掉曲库网格里几十次重复请求。
			'Cache-Control': 'public, max-age=3600',
		},
	});
}

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
	if (!song.hasCover) {
		return fail('no cover for this track', 404);
	}

	// 用 song.filePath 而不是拿 trackId 直接当路径：`id → 路径` 的映射始终由
	// Song 提供，将来 id 形态变了这里也不用跟着改。
	const resolved = await resolveMusicFile(song.filePath);
	if (!resolved.ok) {
		if (resolved.reason === 'no-music-dir') return fail('MUSIC_DIR not configured', 503);
		if (resolved.reason === 'traversal') return fail('path traversal blocked', 403);
		return fail(`file not on disk: ${song.filePath.replace(/^\/+/, '')}`, 404);
	}

	const cover = (await readEmbedded(resolved.realPath)).cover;
	if (!cover) {
		return fail('no cover for this track', 404);
	}

	return imageResponse(cover);
}
