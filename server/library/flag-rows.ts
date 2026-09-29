/**
 * flag-rows —— 把「标记的一串 id」补成「能给人看的行」。
 *
 * 为什么单独一个文件，而不是写在两条路由里各做一遍：两条路由（收藏 / 屏蔽）
 * 的形状**完全一样**，复制一遍就是「同一份规则两处实现」——它们会在
 * 「曲名怎么取」「文件没了怎么显示」这两处慢慢漂移，而且不报错。
 *
 * 为什么不能写在 `flags.ts` 里：`flags.ts` 只碰库（`server/db.ts`），
 * 而这里要按 id 去**曲库**取曲名 —— 而 `server/library/index.ts` 已经
 * import 了 `flags.ts`（它要 `hiddenIds()` 做过滤）。写在那边就是循环依赖。
 *
 * ⚠️ 取曲名走 `getAllSongs()`（**不过滤屏蔽**）。被屏蔽的歌也要能显示曲名 ——
 * 否则屏蔽清单会变成一列光秃秃的路径，用户根本认不出哪首是哪首，
 * 而「解封」这个动作（红线③）就没了可操作的入口。
 */
import type { FlagKind, FlagRow } from '../../contract/library-flags';
import { listFlagIds } from './flags';
import { getAllSongs } from './index';

/**
 * 某一类标记的全部行，顺序**跟着 id 列表**（`listFlagIds` 已排序 → 稳定）。
 *
 * `missing: true` 表示文件已经不在曲库里了。**照旧列出来、不静默丢掉**：
 * 改名或移动 = 新 id（路径寻址的固有性质），于是「收藏过一首后来改名的歌」
 * 会变成一行失效的标记；用户看到它时该明白那是自己的收藏失效了，
 * 而不是界面坏了。要清掉它，用同一个 DELETE。
 */
export async function listFlagRows(kind: FlagKind): Promise<FlagRow[]> {
	const ids = listFlagIds(kind);
	if (ids.length === 0) return [];
	const byId = new Map((await getAllSongs()).map((s) => [s.id, s]));
	return ids.map((trackId) => {
		const song = byId.get(trackId);
		return {
			trackId,
			title: song?.title ?? trackId,
			artist: song?.artist ?? '',
			missing: !song,
		};
	});
}
