/**
 * 曲库检索 —— 子串匹配 + 标签匹配。
 *
 * 两层：
 *  1. 标题 / 歌手 / 专辑的**原文子串**命中（大小写不敏感，`q` 已由调用方 trim + lowercase）；
 *  2. **标签**命中（`track_tags` 表，见 `./tags.ts`）—— 风格类请求唯一可能的答案来源。
 * 空 `q` 返回全部 —— 前端曲库抽屉靠这个行为列出整库。
 *
 * 历史值得记一笔：这里曾经有一套「词典归一化 + 融合标签打分」，随电台功能一起删了。
 * 删得对 —— 那套打分的输入是 `fusedTags`，它依赖一个**校正层**；校正层被删之后，
 * 打分就只会拿不可信的 ID3 genre 去匹配，给出一本正经的错误答案。
 * 现在换成显式的 tag 表：**谁写的（ai / user）记录在案**，不再有无名数据。
 *
 * ── 2026-09-28：屏蔽的过滤点不在这里 ────────────────────────────────
 * 本文件**自己不判屏蔽**：它从 `getSongs()` 拿到的就已经是可见曲库
 * （过滤点只有一处，见 `./visible.ts`）。这里做的是**把被过滤掉的那部分数出来**，
 * 因为「匹配 0 首」和「匹配 3 首、但它们都被你屏蔽了」是两件完全不同的事 ——
 * 前者是「库里没有」，后者是「你自己关掉的」。不区分就等于**编一句听起来很
 * 确定的假话**（与「offset 翻过头了必须单独说一句」同一条判据）。
 */
import { getAllSongs, type Song } from './';
import { hiddenIds } from './flags';
import { splitHidden } from './visible';
import { listTrackTags } from './tags';

/**
 * 搜索返回的曲目 = `Song` + 它的标签。
 *
 * 标签在这里合流而不是塞进 `Song`：`Song` 是**扫描产物**（文件里有什么就是什么），
 * 标签是**库里的判断**（谁说的还分 ai / user，见 `./tags.ts`）。
 * 搜索正是「用判断去筛产物」的地方，所以合流点在这里。
 */
export type SongSummary = Song & { tags: string[] };

export interface LibrarySearchResult {
	query: string;
	/** 本页的起始下标（调用方给的翻页位置）。 */
	offset: number;
	/** 本次实际返回的条数（受 limit 限制）。 */
	count: number;
	/** 命中的总条数（未受 limit / offset 限制）。**不含被屏蔽的**。 */
	total: number;
	/**
	 * 同一个 `q` 还能命中、但**已被屏蔽**的条数。`q` 为空时 = 整库被屏蔽的条数。
	 *
	 * 只报一个数字、不给 id：被屏蔽的歌要拿到 id 得走 `GET /api/library/hidden`
	 * （或 `list_hidden` 工具）。放在检索结果里会把「解封出口」变成
	 * 「检索结果的隐藏附赠字段」—— 那条路太容易在重构里被顺手删掉，
	 * 而删掉之后被屏蔽的歌就再也拿不到 id 了（红线③）。
	 */
	hiddenMatches: number;
	songs: SongSummary[];
}

/**
 * 一首歌命中 `q` 吗（含标签）。**匹配规则的唯一实现** —— `visible` 与 `hidden`
 * 两侧必须用同一份，否则 `hiddenMatches` 这个数字会与 `total` 的口径不一致，
 * 而那种不一致只会表现为「数字对不上」，没人知道该改哪边。
 */
function matches(song: Song, q: string, tags: readonly string[]): boolean {
	if (!q) return true; // 空条件 = 无条件（"列出整库"靠它）
	if ([song.title, song.artist, song.album].some((field) => field.toLowerCase().includes(q))) return true;
	return tags.some((tag) => tag.includes(q));
}

/**
 * 搜索曲库。`q` 已由调用方 trim + lowercase；`limit` 已夹紧在 1..50、`offset` ≥ 0。
 *
 * 匹配三个文本字段（曲名 / 歌手 / 专辑）**再加上标签**。加标签这一步是重点：
 * 「有没有适合睡觉的」这类风格请求，文本字段永远答不出来 —— 歌名里不会写着
 * 「舒缓」。标签把「对这首歌的判断」变成了可检索的字段。
 *
 * 标签一次全量读进 Map 而不是逐首点查：标签表最大就是曲库大小，
 * 一次 `SELECT` + 建索引比 N 次往返便宜，也更容易读。
 *
 * `offset` 是 2026-09-17 补的：只有 `limit` 时，「列出全部」（`q` 空）在曲库长过
 * 50 首之后会被**静默截断**——模型看到 50 条会以为那就是全部，还说得很有把握。
 * 翻页参数不会让截断消失，但让「还有更多」变成一件可说、可查的事。
 * ⚠️ `offset` 走的是**可见曲库里的位置**（被屏蔽的根本不在这一列里），
 * 所以「共 N 首、这一页第 a–b 首」这几个数彼此自洽。
 */
export async function searchLibrary(
	q: string,
	limit: number,
	offset = 0,
): Promise<LibrarySearchResult> {
	// 这里取**全部**曲目再自己拆，而不是调 `getSongs()`：本函数两个数字都要
	// （可见的 `total` 与不可见的 `hiddenMatches`），拆一次比"调一次再拆一次"
	// 少一遍过滤、也少一遍读屏蔽集合。用的还是同一个 `splitHidden` ——
	// 过滤谓词只有那一处实现，这里只是**同时要两半**。
	const all = await getAllSongs();
	const { visible, hidden } = splitHidden(all, hiddenIds());
	const tagsById = new Map(listTrackTags().map((t) => [t.trackId, t.tags]));
	const tagOf = (s: Song) => tagsById.get(s.id) ?? [];

	const matched = visible.filter((s) => matches(s, q, tagOf(s)));
	const page = matched.slice(offset, offset + limit);
	const hiddenMatches = hidden.filter((s) => matches(s, q, tagOf(s))).length;

	return {
		query: q,
		offset,
		count: page.length,
		total: matched.length,
		hiddenMatches,
		songs: page.map((s) => ({ ...s, tags: tagOf(s) })),
	};
}
