/**
 * /api/library/rescan —— **重扫曲库**（丢掉进程内 memo，重新扫一遍 `MUSIC_DIR`）。
 *
 * 为什么要有这条路由：扫描结果在进程存活期内 memo 一次
 * （`server/library/scanner.ts`），于是「往 `data/music/` 里丢一首歌」在重启之前
 * **是不可见的**，而且没有任何地方告诉用户这件事。这条路由把那个落差变成
 * 一句可说的话（「我加了新歌」→ 重扫 → 「现在 7 首了」）。
 *
 * 为什么是 POST：它**改变服务端状态**（缓存），且不是幂等的读取。
 * 用 GET 会被各种预取 / 浏览器缓存顺手打一次。
 *
 * ⚠️ `previousTotal` 为 `null` 时前端与工具**不许**说「新增了 N 首」——
 * null = 这次之前没扫过（无从得知），说成一个数字就是在编。
 */
import { rescanLibrary } from '@/server/library/scanner';
import { ok, fail } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function POST() {
	try {
		return ok(await rescanLibrary());
	} catch (err) {
		console.error('[library/rescan] failed:', err);
		return fail('曲库重扫失败', 500);
	}
}
