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
 */
import { getSongs, type Song } from './';
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
	/** 命中的总条数（未受 limit / offset 限制）。 */
	total: number;
	songs: SongSummary[];
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
 */
export async function searchLibrary(
	q: string,
	limit: number,
	offset = 0,
): Promise<LibrarySearchResult> {
	const songs = await getSongs();
	const tagsById = new Map(listTrackTags().map((t) => [t.trackId, t.tags]));

	const matched = q
		? songs.filter((s) => {
				const hitText = [s.title, s.artist, s.album].some((field) =>
					field.toLowerCase().includes(q),
				);
				if (hitText) return true;
				return (tagsById.get(s.id) ?? []).some((tag) => tag.includes(q));
			})
		: songs;

	const page = matched.slice(offset, offset + limit);
	return {
		query: q,
		offset,
		count: page.length,
		total: matched.length,
		songs: page.map((s) => ({ ...s, tags: tagsById.get(s.id) ?? [] })),
	};
}
