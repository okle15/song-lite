/**
 * 曲库检索 —— 纯文本匹配。
 *
 * 只做一层：标题 / 歌手 / 专辑的**原文子串**命中（大小写不敏感，`q` 由调用方
 * 预先 trim + lowercase）。空 `q` 返回全部——前端曲库抽屉靠这个行为列出整库。
 *
 * 曾经的「词典归一化 + 融合标签打分」随电台一起删掉了：那套打分的输入是
 * `fusedTags`（user/llm 校正过的标签），校正层没了之后它只会拿未校正的 ID3
 * genre 去匹配，反而给错答案。
 */
import { getSongs, type Song } from './';

export interface LibrarySearchResult {
	query: string;
	/** 本次实际返回的条数（受 limit 限制）。 */
	count: number;
	/** 命中的总条数（未受 limit 限制）。 */
	total: number;
	songs: Song[];
}

/** 搜索曲库。`q` 已由调用方 trim + lowercase；`limit` 已夹紧在 1..50。 */
export async function searchLibrary(q: string, limit: number): Promise<LibrarySearchResult> {
	const songs = await getSongs();
	const matched = q
		? songs.filter((s) =>
				[s.title, s.artist, s.album].some((field) => field.toLowerCase().includes(q)),
			)
		: songs;

	return {
		query: q,
		count: Math.min(matched.length, limit),
		total: matched.length,
		songs: matched.slice(0, limit),
	};
}
