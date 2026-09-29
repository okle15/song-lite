/**
 * /api/library/inspect —— 曲库体检的 HTTP 面。
 *
 * 两种粒度（与 `/api/library/tags` 的 GET 同形）：
 *   `GET /api/library/inspect`                 → 整库体检（几首 / 几首没标签 / 未知歌手…）
 *   `GET /api/library/inspect?trackId=…`       → 单曲详情（文件事实 + 标签 + 收藏 + 播过几次）
 *
 * ── 为什么单曲走**不过滤**的那条路 ────────────────────────────────────
 * `inspectTrack` 内部用 `findSongById`，它走 `getAllSongs()`。被屏蔽的歌仍然
 * 要能体检到（否则「那首被我屏蔽的歌还有没有标签」无从回答）—— 与音频流同侧：
 * **屏蔽过滤的是「列出什么」，不是「这首歌存不存在」**。
 *
 * ── 曲目不在曲库里 = 404，不是空对象 ──────────────────────────────────
 * 文件被移走 / 改名之后，id 就变了（路径寻址的固有性质）。返回一个"空的体检
 * 结果"会让调用方以为「这首有 0 个标签」，而真相是**这首歌不在了** —— 两件事
 * 渲染出来都是空白，下一步却相反（一件是去别处找，一件是再试一次）。
 */
import { inspectLibrary, inspectTrack } from '@/server/library/inspect';
import { fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	const trackId = new URL(request.url).searchParams.get('trackId')?.trim();

	if (!trackId) return ok(await inspectLibrary());

	const report = await inspectTrack(trackId);
	if (!report) return fail(`曲目不在曲库里：${trackId}`, 404);
	return ok(report);
}
