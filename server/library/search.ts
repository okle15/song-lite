/**
 * 曲库搜索 —— 词法匹配 + 词典归一化打分（从 `app/api/library/search/route.ts` 迁出，2026-09-10）。
 *
 * 查询分两层处理（盘活本地曲库的第一步）：
 *  1. 原文子串匹配（title / artist / album），老行为不变；
 *  2. **词典归一化**（`server/radio/lexicon`）：中文主观词与专业术语映射到
 *     曲库的英文标签 ——「爵士」命中 genre=jazz，「欢快」命中 mood=upbeat。
 *     两层结果合并（综合分排序，每条带 matchReason 可解释）。
 *
 * 兜底顺序：ID3 标签 → MOOD_BY_GENRE 推断 → 长期听歌记忆（radio 的 track_stats 打分）。
 *
 * 迁出理由：这是纯域逻辑（打分规则 + 空结果话术），放在路由里既不可单测，
 * 也让「app/ 不写业务实现」这条边界失效。路由现在只做「解析参数 → 调用 → 封装信封」。
 */

import { getSongs, type Song } from './';
import { parseQuery } from '../radio/lexicon';
import { fusedTags, getAllTrackStats } from '../radio/memory';

export type SongWithReason = Song & { matchReason?: string };

/**
 * 返回给调用方的曲目形态：在 Song 之上补齐标签视图。
 *
 * `genre`/`mood` 是单值字符串（Song 原有字段），回填融合后的**首选**值；
 * `genres`/`moods` 是完整数组，供需要全量标签的调用方使用。
 * 两者都来自 `fusedTags`，不直接透传 ID3 原值。
 */
export type SongWithTags = SongWithReason & { genres: string[]; moods: string[] };

/** 搜索响应体。`parsed` / `hint` 为可选键——无值时序列化会整键省略，与原行为一致。 */
export interface LibrarySearchResult {
	query: string;
	parsed?: { moods: string[]; genres: string[] };
	count: number;
	total: number;
	songs: SongWithTags[];
	hint?: string;
}

/**
 * 空结果提示：告诉调用方"库里实际有什么"。
 *
 * 面向 agent：它拿到空数组时唯一能做的只有换关键词重试；给了真实分布，
 * 它就能直接告诉用户"库里没有 X，目前是这些风格"。
 */
function buildEmptyHint(songs: Song[], q: string): string {
	const uniq = (xs: string[], n: number) => [...new Set(xs.filter(Boolean).map((x) => x.toLowerCase()))].slice(0, n);
	// 用融合视图，不是 s.genre：后者是未校正的 ID3（本曲库 6 首全是 blues）。
	const fused = songs.map((s) => fusedTags(s));
	const genres = uniq(fused.flatMap((f) => f.genres), 6);
	const moods = uniq(fused.flatMap((f) => f.moods), 6);
	const samples = songs.slice(0, 3).map((s) => `${s.title}（${s.artist}）`);
	const parts = [`库中 ${songs.length} 首，没有匹配「${q}」的结果`];
	if (genres.length) parts.push(`可用风格：${genres.join('、')}`);
	if (moods.length) parts.push(`可用情绪：${moods.join('、')}`);
	if (samples.length) parts.push(`例如 ${samples.join('、')}`);
	parts.push('不要再换关键词重试，直接基于上述信息答复用户');
	return parts.join('；');
}

/**
 * 搜索曲库。`q` 由调用方 trim + lowercase 后传入，`limit` 已夹紧在 1..50。
 */
export async function searchLibrary(q: string, limit: number): Promise<LibrarySearchResult> {
	const songs = await getSongs();
	const parsed = q ? parseQuery(q) : null;

	let result: SongWithReason[] = songs;
	if (q && parsed) {
		const stats = new Map(getAllTrackStats().map((s) => [s.track_id, s]));
		const scored: { song: SongWithReason; score: number }[] = [];

		for (const song of songs) {
			const rec = song as SongWithReason;
			let score = 0;
			let reason = '';
			// 1. 原文子串（标题/歌手/专辑）
			if ([song.title, song.artist, song.album].some((f) => f.toLowerCase().includes(q))) {
				score += 1.0;
				reason = '名称命中';
			}
			// 2. 词典归一化标签（中文语义 → 融合标签视图）
			//    必须走 fusedTags：它有 user/llm 时**取代** ID3 原字段而不是并集——
			//    本曲库 ID3 的 genre 全被误标成 blues，并进来的话"布鲁斯"命中全库。
			const fused = fusedTags(song);
			const songGenres = fused.genres;
			const songMoods = fused.moods;
			const genreIdx = parsed.genres.findIndex((g) => songGenres.includes(g));
			if (parsed.genres.length > 0 && genreIdx >= 0) {
				score += genreIdx === 0 ? 0.8 : 0.4;
				reason = reason ? `${reason}+风格(${songGenres[genreIdx]})` : `风格(${songGenres[genreIdx]})`;
			}
			const moodIdx = parsed.moods.findIndex((m) => songMoods.includes(m));
			if (parsed.moods.length > 0 && moodIdx >= 0) {
				score += moodIdx === 0 ? 0.6 : 0.3;
				reason = reason ? `${reason}+情绪(${songMoods[moodIdx]})` : `情绪(${songMoods[moodIdx]})`;
			}
			// 3. 长期记忆微调（常听靠前、常跳靠后）——**只能重排，不能入选**。
			//
			// 必须在"有实质匹配"的前提下才加：score 此时若仍为 0，说明名称/风格/
			// 情绪一条都没命中，这首歌与查询无关。旧写法无条件累加，导致
			// `q=蓝调`（parsed.genres=['blues']，而 fusedTags 永远不返回 blues）
			// 会把**零命中的歌**捞进结果——实测返回 2 首 `matchReason:""` 的歌，
			// Agent 拿到"结果数组里有歌"就推断"库里这些歌是蓝调"，进而报出
			// `6 首 Blues` 的幻觉（typ-014 近 8 次只过 3 次的主因）。
			if (score > 0) {
				const stat = stats.get(song.id);
				if (stat) {
					score += Math.min(0.1, 0.03 * stat.play_count);
					score -= 0.1 * (stat.skip_count / Math.max(1, stat.play_count + stat.skip_count));
				}
				rec.matchReason = reason;
				scored.push({ song: rec, score });
			}
		}
		scored.sort((a, b) => b.score - a.score);
		result = scored.map((s) => s.song);
	}

	// 返回体回填融合标签：匹配层走 fusedTags（user/llm 取代 ID3），但 Song 的
	// genre/mood 原字段仍是 ID3 值——本曲库 6 首全是 blues，不回填的话调用方会
	// 读到 `"genre":"blues"` 配 `"matchReason":"风格(pop)"` 的自相矛盾数据
	// （历史上 agent 照此报过"蓝调"）。回填首选值 + 完整数组两种形态。
	const withTags: SongWithTags[] = result.slice(0, limit).map((song) => {
		const fused = fusedTags(song);
		return {
			...song,
			genre: fused.genres[0] ?? song.genre,
			mood: fused.moods[0] ?? song.mood,
			genres: fused.genres,
			moods: fused.moods,
		};
	});

	const data: LibrarySearchResult = {
		query: q,
		parsed: parsed ? { moods: parsed.moods, genres: parsed.genres } : undefined,
		count: withTags.length,
		total: result.length,
		songs: withTags,
	};

	// 空结果必须"可行动"。只回一个空数组的话，模型拿不到任何下一步线索，
	// 只能换个关键词再搜——实测"找点爵士乐"在无爵士的小曲库里能连搜 5 次，
	// 单轮延迟翻倍。把库里真实存在的风格/情绪/样例一起给它，它就能直接作答。
	if (result.length === 0) data.hint = buildEmptyHint(songs, q);

	return data;
}
