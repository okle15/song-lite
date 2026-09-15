/**
 * radio/tagger — 曲目标签的 LLM 打标器（边放边判）。
 *
 * 歌曲开播时若还没有 LLM 标签，塞进串行队列后台补标。第一遍播用自带/推断
 * 标签，第二遍起就有模型标签了。省 token：只标你真正听过的歌。
 *
 * LLM 通道经 `server/llm/client.ts` 单点封装（OpenAI 兼容网关，env 收口在
 * 那一处）；结果与 id3/inferred/user 标签按优先级融合。
 *
 * 标签准确率的诚实回答（详见 RADIO.md §10）：
 *  - id3 标签 = 文件自带（准确但经常缺失/粗糙）
 *  - inferred = 按风格推断（「jazz→relaxed」，粗粒度）
 *  - llm      = 模型根据标题/歌手/专辑判断（覆盖面好，但有想象成分，
 *               所以 confidence 记 0.7，且永远可能被 user 标注覆盖）
 */
import { getSongs, type Song } from '@/server/library';
import { chatJson } from '@/server/llm/client';
import { applyTag, llmTaggedTrackIds, normalizeTag, type TagSource } from './memory';

const g = globalThis as unknown as {
	__radioTagger?: {
		queue: string[];
		processing: boolean;
		lastError: string | null;
	};
};

function state() {
	if (!g.__radioTagger) {
		g.__radioTagger = { queue: [], processing: false, lastError: null };
	}
	return g.__radioTagger;
}

/**
 * 受控词表 —— 打标的唯一事实来源。
 *
 * 提示词里列出的可选词、以及入库前的白名单校验，都从这两个常量生成，
 * 避免"提示词改了、校验没跟上"的漂移。
 *
 * 取值必须与 `radio/lexicon.ts` 的中文映射值域对齐：词典能把"欢快"映射到
 * happy/upbeat/energetic，这些词就必须在表内，否则用户搜中文永远命中不了。
 * （已核对：MOOD_LEXICON / GENRE_LEXICON 的全部取值都是本表的子集。）
 */
export const ALLOWED_MOODS = [
	'happy',
	'upbeat',
	'energetic',
	'epic',
	'calm',
	'peaceful',
	'relaxed',
	'gentle',
	'warm',
	'soulful',
	'melancholic',
	'sad',
	'mysterious',
	'hypnotic',
	'cool',
	'smooth',
] as const;

export const ALLOWED_GENRES = [
	'pop',
	'rock',
	'jazz',
	'blues',
	'classical',
	'folk',
	'electronic',
	'hiphop',
	'rnb',
	'soul',
	'ambient',
	'metal',
] as const;

/** 每种标签最多留几个。超过的说明模型在"撒网"，可信度反而低。 */
const MAX_TAGS_PER_KIND = 2;

/**
 * 清洗模型返回的标签：拆词 → 白名单 → 去重 → 截断。
 *
 * 三步都有实测依据，缺一个都会产生废标签：
 *  1. 拆词：模型返回过 `["pop folk"]` / `["happy upbeat"]` 整串，
 *     不拆的话它既不等于 pop 也不等于 folk，等于白打。
 *  2. 白名单：模型返回过 majestic / passionate / nostalgic 这类词表外的值
 *     （实测 3/5 越界）。入库后词典映射不到，用户搜中文永远匹配不上。
 *  3. 截断：要求 1-2 个时模型给过 5 个，标签越多信噪比越低。
 */
export function cleanTags(v: unknown, allowed: readonly string[]): string[] {
	if (!Array.isArray(v)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of v) {
		if (typeof raw !== 'string') continue;
		for (const t of normalizeTag(raw)) {
			if (!allowed.includes(t)) continue;
			if (seen.has(t)) continue;
			seen.add(t);
			out.push(t);
			if (out.length >= MAX_TAGS_PER_KIND) return out;
		}
	}
	return out;
}

/** 调网关拿 JSON 标签（经 server/llm/client 单点，模型默认 TAG_MODEL/agnes-2.5-flash）。失败抛错（由调用方决定重试/记录）。 */
async function callLlm(song: Song): Promise<{ moods: string[]; genres: string[] }> {
	const prompt =
		`标签任务：为下面的歌输出情绪(moods)与风格(genres)标签。\n` +
		`歌名: ${song.title}\n歌手: ${song.artist}\n专辑: ${song.album}\n` +
		// ID3 的 genre 实测高度不可靠（本曲库 6 首中文流行全部被标成 blues），
		// 原样放进提示词会让模型直接照抄错误值，所以明确降权为"仅供参考"。
		`文件自带风格标签（仅供参考，实测经常是错的，与你的判断冲突时以你的判断为准）: ${song.genre}\n\n` +
		`要求：\n` +
		`1. 只输出一个 JSON 对象，格式 {"moods":["..."],"genres":["..."]}，不要任何解释、代码块或推荐。\n` +
		`2. moods 只能从这些词里选（1-${MAX_TAGS_PER_KIND} 个）：${ALLOWED_MOODS.join(' ')}\n` +
		`3. genres 只能从这些词里选（1-${MAX_TAGS_PER_KIND} 个）：${ALLOWED_GENRES.join(' ')}\n` +
		`4. 每个标签必须是**单个词**，多个标签写成数组 ["pop","folk"]，不要写成 "pop folk"。\n` +
		`5. 主要依据歌名/歌手/专辑判断；不确定就少给，绝不编造。`;

	const parsed = await chatJson<{ moods?: unknown; genres?: unknown }>(prompt, {
		temperature: 0.2,
		maxTokens: 800,
	});
	return { moods: cleanTags(parsed.moods, ALLOWED_MOODS), genres: cleanTags(parsed.genres, ALLOWED_GENRES) };
}

/** 把 LLM 结果写入标签表（source=llm, confidence=0.7；永远可被 user 覆盖）。 */
function applyLlmTags(song: Song, tags: { moods: string[]; genres: string[] }): void {
	for (const m of tags.moods) applyTag(song.id, 'mood', m, 'llm' as TagSource, 0.7);
	for (const g of tags.genres) applyTag(song.id, 'genre', g, 'llm' as TagSource, 0.7);
}

/** 单首打标。返回是否成功。 */
export async function labelOne(song: Song): Promise<boolean> {
	try {
		const tags = await callLlm(song);
		applyLlmTags(song, tags);
		return true;
	} catch (err) {
		state().lastError = `${song.title}: ${err instanceof Error ? err.message : String(err)}`;
		return false;
	}
}

/**
 * lazy：把歌塞进串行后台队列（去重）。开播钩子调用，fire-and-forget。
 * 队列在内存里 —— 进程重启即消失，属可接受损耗（下次播放会重新入队）。
 */
export function enqueueLazy(trackId: string): void {
	const s = state();
	if (s.queue.includes(trackId)) return;
	if (s.queue.length > 200) return; // 防失控
	s.queue.push(trackId);
	void processQueue();
}

async function processQueue(): Promise<void> {
	const s = state();
	if (s.processing) return;
	s.processing = true;
	try {
		const songs = await getSongs();
		const byId = new Map(songs.map((x) => [x.id, x]));
		for (;;) {
			const id = s.queue.shift();
			if (!id) break;
			const done = llmTaggedTrackIds();
			if (done.has(id)) continue;
			const song = byId.get(id);
			if (song) await labelOne(song);
		}
	} finally {
		s.processing = false;
	}
}
