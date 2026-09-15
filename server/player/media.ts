/**
 * 媒体文件解析 + HTTP Range 响应 —— 音频流（`library/stream`）与歌词
 * （`library/lyrics`）共用。
 *
 * 抽出来的理由（2026-09-10）：`realpath + 防穿越` 这段**安全逻辑**原本在两个路由
 * 各抄一份；`Range 三态响应`（206 Partial / 416 Unsatisfiable / 200 Full）
 * 也近乎逐字重复。重复本身不疼，疼的是漂移——这里漂移一次的代价是
 * 「路径穿越被放行」或「进度条 seek 静默失效」，都极难在人工点测里发现。
 *
 * 依赖纪律：只用 `node:*` 与 Web 标准全局（`Response` / `ReadableStream`），
 * **不 import `next/server`**（那是 `server/http.ts` 的专属例外）。
 */

import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { resolveMusicDir } from '../library/music-dir';

/** 解析失败的三种原因，由调用方各自映射成自己的状态码与文案（历史文案不同，保留）。 */
export type MediaResolveFailure = 'no-music-dir' | 'not-found' | 'traversal';

export type MediaResolveResult =
	| { ok: true; realPath: string }
	| { ok: false; reason: MediaResolveFailure };

/**
 * 把曲库内的**相对路径**解析成 musicDir 内的绝对真实路径。
 *
 * 入参形如 `'/荷塘月色 - 凤凰传奇.mp3'`（`Song.filePath` / `song.mvPath` 的形态，
 * 带前导斜杠也认）。防穿越的做法：先 `realpath`（解掉符号链接），再要求结果
 * 仍以 `realpath(musicDir)` 开头——只做字符串前缀判断在符号链接下是能被绕过的。
 *
 * 不做 `stat`：三个调用方对「文件不存在」的文案不同，且歌词路由不需要 size。
 */
export async function resolveMusicFile(relPath: string): Promise<MediaResolveResult> {
	const musicDir = resolveMusicDir();
	if (!musicDir) return { ok: false, reason: 'no-music-dir' };

	const absPath = join(musicDir, relPath.replace(/^\/+/, ''));

	let realAbs: string;
	try {
		realAbs = await realpath(absPath);
	} catch {
		return { ok: false, reason: 'not-found' };
	}

	const realRoot = await realpath(musicDir);
	if (!realAbs.startsWith(realRoot)) return { ok: false, reason: 'traversal' };

	return { ok: true, realPath: realAbs };
}

/**
 * 按扩展名查 Content-Type，未命中回落 `fallback`。
 *
 * 传**路径**而不是扩展名：调用方手上的路径形态不一（`Song.filePath` 是相对路径，
 * 视频流拿的是 realpath 结果），在扩展名相同的前提下两者等价，传路径可以少一次
 * 取扩展名的重复逻辑。
 */
export function contentTypeFor(
	pathLike: string,
	table: Record<string, string>,
	fallback: string,
): string {
	const ext = pathLike.slice(pathLike.lastIndexOf('.')).toLowerCase();
	return table[ext] ?? fallback;
}

/**
 * 构造支持 HTTP Range 的媒体响应。
 *
 * `rangeHeader` 直接传 `request.headers.get('range')`：
 *  - 合法且越界 → 416 + `Content-Range: bytes *\/<size>`（body 为空）
 *  - 合法且可满足 → 206 + 该区间字节
 *  - 缺失 / 不合法（不是 `bytes=a-b` 形状）→ 忽略，回落 200 整文件
 *
 * 响应头统一带 `Accept-Ranges: bytes` 与 `Cache-Control: no-cache`：媒体文件体积大，
 * 一旦被浏览器整块缓存，改文件后前端会长时间拿到旧内容。
 */
export function mediaResponse(
	realPath: string,
	size: number,
	contentType: string,
	rangeHeader: string | null,
): Response {
	if (rangeHeader) {
		const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
		if (match) {
			const start = Number(match[1]);
			const end = match[2] ? Number(match[2]) : size - 1;
			if (start >= size || end >= size || start > end) {
				return new Response(null, {
					status: 416,
					headers: { 'Content-Range': `bytes */${size}` },
				});
			}
			const chunkSize = end - start + 1;
			const stream = createReadStream(realPath, { start, end });
			return new Response(Readable.toWeb(stream) as ReadableStream, {
				status: 206,
				headers: {
					'Content-Type': contentType,
					'Content-Length': String(chunkSize),
					'Content-Range': `bytes ${start}-${end}/${size}`,
					'Accept-Ranges': 'bytes',
					'Cache-Control': 'no-cache',
				},
			});
		}
	}

	const stream = createReadStream(realPath);
	return new Response(Readable.toWeb(stream) as ReadableStream, {
		status: 200,
		headers: {
			'Content-Type': contentType,
			'Content-Length': String(size),
			'Accept-Ranges': 'bytes',
			'Cache-Control': 'no-cache',
		},
	});
}
