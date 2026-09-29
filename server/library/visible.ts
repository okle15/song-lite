/**
 * visible —— **「可见曲库」的唯一产出点**。屏蔽态只在这里说了算。
 *
 * ── 这个文件为什么必须存在（而不是把 filter 写在调用方）──────────────
 * 「屏蔽」这个能力最危险的失败方式**不是报错，而是漏掉一条路**：
 * 曲库有六七个出口（检索、整库队列、恢复整库、点播时的 `ensureQueue`…），
 * 只要有一处忘了过滤，被屏蔽的歌就会从那一条路回来 —— 而队列本来就长成
 * 「一批歌」，多一首**看不出来**，测试也不会红。
 *
 * 所以规则被收成两条：
 *   ① **过滤谓词只有一处**：`splitHidden()`（下面）。别的文件不许再写
 *      `!hidden.has(...)`；
 *   ② **整批替换只有一个入口**：`mergePreservingHidden()`。任何「把一整批写
 *      下去」的地方（目前是曲库扫描结果 → 可见曲库）都要从它过一道。
 *
 * ── 「不许绕过 `mergePreservingHidden()`」这条红线在 lite 的形状 ──────
 * 在更复杂的实现里，这条红线守的是「一次整表替换把用户的屏蔽态冲掉」。
 * lite 把曲库做成**不落库**（真相在文件系统），所以屏蔽态本来就不在会被替换的
 * 那一份里 —— 替换冲掉的不是屏蔽态本身，而是**这一次过滤**。绕过的后果因此变成
 * 「这一批里混进了被屏蔽的歌」。判据不变：**整批写下去之前，必须过它。**
 *
 * ── 显式点名的一批**不过**这一道（有意）────────────────────────────
 * 「屏蔽」管的是**自动来源**：曲库列表、检索、以及「整个曲库」这种队列。
 * 它**不是一把锁**：用户或 agent 拿着具体 id 说「就放这首」（`play_track` 带
 * trackId）仍然放得出来。理由是这条：`hidden` 的读取者里有 `search_library`，
 * 而它正是「拿到 trackId 的那条路」——若把显式路径也堵死，被屏蔽的歌就
 * **再也拿不到 id**，解封入口随之消失（红线③「解封出口不许减」）。
 */
import type { Song } from './';

/**
 * 把一批曲目拆成「可见的」与「被屏蔽的」两份。**过滤谓词的唯一实现**。
 *
 * 为什么要拆成两份而不是只给可见的：检索要用那个数字 ——
 * 「匹配 0 首」与「匹配 3 首、但它们都被你屏蔽了」是**两件不同的事**，
 * 说成前者就是在编一句听起来很确定的假话（与「offset 翻过头了必须单独说一句」
 * 同一条判据，见 `agent/tools.ts` 的 `search_library`）。
 */
export function splitHidden(
	songs: readonly Song[],
	hidden: ReadonlySet<string>,
): { visible: Song[]; hidden: Song[] } {
	const visible: Song[] = [];
	const blocked: Song[] = [];
	for (const song of songs) (hidden.has(song.id) ? blocked : visible).push(song);
	return { visible, hidden: blocked };
}

/**
 * **整批替换的唯一合并入口** —— 红线②。
 *
 * 调用方把自己「想写下去的那一批」交进来，拿回**真正该写下去的那一批**。
 * 调用方不必（也不许）自己记得屏蔽这件事：忘一次就是一条静默的漏路。
 */
export function mergePreservingHidden(next: readonly Song[], hidden: ReadonlySet<string>): Song[] {
	return splitHidden(next, hidden).visible;
}
