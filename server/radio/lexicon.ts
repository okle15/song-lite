/**
 * radio/lexicon — 语义词典：把用户嘴里的词接到本地曲库的标签上。
 *
 * 用户的请求长这样：「来一首欢快的爵士」「放点安静的钢琴曲」「来首丧的」。
 * 两类词要分开处理：
 *
 *  - **主观形容词**（欢快/安静/丧）→ 归一化到 mood 标签（happy/calm/...）。
 *    一个形容词对应一簇近义 mood，带权重：直接同义 > 情绪邻域。
 *  - **专业术语**（爵士/布鲁斯/古典/金属）→ 归一化到 genre 标签。
 *    术语是离散类别，词典做别名折叠（爵士/Jazz/jazz → jazz）。
 *
 * 曲库标签贫瘠（genre 常缺、mood 几乎没有）——词典 + 打分关联是盘活它们
 * 的第一层；第二层是**边播边打标**（见 RADIO.md §10），第三层是听歌记忆。
 *
 * 词典还认「学到的新词」：`data/lexicon-learned.json` 里的映射由 parseQuery
 * 一并读入，且**优先于内置词典**（教过的覆盖内置）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LEARNED_PATH = path.join(process.cwd(), 'data', 'lexicon-learned.json');

/** 主观形容词 → mood 标签簇（顺序即权重：越靠前越直接）。 */
export const MOOD_LEXICON: Record<string, string[]> = {
	欢快: ['happy', 'upbeat', 'energetic'],
	开心: ['happy', 'upbeat'],
	快乐: ['happy', 'upbeat'],
	愉悦: ['happy', 'relaxed'],
	轻快: ['upbeat', 'energetic'],
	活泼: ['upbeat', 'energetic'],
	兴奋: ['energetic', 'epic'],
	热血: ['energetic', 'epic'],
	燃: ['energetic', 'epic'],
	动感: ['energetic', 'upbeat'],
	安静: ['calm', 'peaceful', 'relaxed'],
	宁静: ['peaceful', 'calm'],
	放松: ['relaxed', 'calm'],
	舒缓: ['calm', 'relaxed'],
	轻柔: ['gentle', 'relaxed'],
	温柔: ['gentle', 'warm'],
	温暖: ['warm', 'soulful'],
	抒情: ['melancholic', 'relaxed'],
	伤感: ['melancholic', 'sad'],
	伤心: ['sad', 'melancholic'],
	难过: ['sad', 'melancholic'],
	丧: ['melancholic', 'sad'],
	忧郁: ['melancholic'],
	深夜: ['calm', 'melancholic'],
	催眠: ['hypnotic', 'calm'],
	恢弘: ['epic'],
	史诗: ['epic'],
	神秘: ['mysterious'],
	浪漫: ['warm', 'soulful'],
	怀旧: ['warm', 'melancholic'],
};

/** 专业术语 → genre 标签（别名折叠：中英混写都进同一桶）。 */
export const GENRE_LEXICON: Record<string, string[]> = {
	爵士: ['jazz'],
	jazz: ['jazz'],
	布鲁斯: ['blues'],
	blues: ['blues'],
	蓝调: ['blues'],
	摇滚: ['rock'],
	rock: ['rock'],
	金属: ['metal'],
	metal: ['metal'],
	古典: ['classical'],
	classical: ['classical'],
	交响: ['classical'],
	钢琴曲: ['classical'],
	流行: ['pop'],
	pop: ['pop'],
	民谣: ['folk'],
	folk: ['folk'],
	电子: ['electronic'],
	电音: ['electronic'],
	electronic: ['electronic'],
	嘻哈: ['hiphop'],
	说唱: ['hiphop'],
	嘻哈说唱: ['hiphop'],
	hiphop: ['hiphop'],
	'hip-hop': ['hiphop'],
	说唱嘻哈: ['hiphop'],
	rnb: ['rnb'],
	'r&b': ['rnb'],
	节奏布鲁斯: ['rnb'],
	灵魂乐: ['soul'],
	soul: ['soul'],
	氛围: ['ambient'],
	环境音乐: ['ambient'],
	ambient: ['ambient'],
};

/** 解析结果：只保留搜索真正会用的两个标签数组。 */
export type ParsedQuery = {
	/** 归一化后的 mood 标签（按命中权重排序） */
	moods: string[];
	/** 归一化后的 genre 标签 */
	genres: string[];
};

/** 读已学到的词（跨进程记忆，教一次永久生效）。 */
function loadLearned(): Record<string, { kind: 'mood' | 'genre'; tags: string[] }> {
	try {
		if (!existsSync(LEARNED_PATH)) return {};
		return JSON.parse(readFileSync(LEARNED_PATH, 'utf8')) as Record<
			string,
			{ kind: 'mood' | 'genre'; tags: string[] }
		>;
	} catch {
		return {};
	}
}

/**
 * 解析自然语言点播：「来一首欢快的爵士」。
 * 贪心长词匹配：词典按词长降序，命中且不与已命中区间重叠即消费。
 * 刻意不依赖 LLM —— 解析是确定性的纯函数。
 */
export function parseQuery(raw: string): ParsedQuery {
	const text = raw.trim().toLowerCase();
	const matched: { term: string; kind: 'mood' | 'genre'; tags: string[] }[] = [];
	const spans: [number, number][] = [];

	// 词典全集（内置 + learned，learned 优先级更高 → 排前面）
	const entries: { term: string; kind: 'mood' | 'genre'; tags: string[] }[] = [];
	for (const [term, v] of Object.entries(loadLearned())) {
		entries.push({ term, kind: v.kind, tags: v.tags });
	}
	for (const [term, tags] of Object.entries(MOOD_LEXICON)) entries.push({ term, kind: 'mood', tags });
	for (const [term, tags] of Object.entries(GENRE_LEXICON)) entries.push({ term, kind: 'genre', tags });
	entries.sort((a, b) => b.term.length - a.term.length);

	for (const e of entries) {
		let from = 0;
		for (;;) {
			const idx = text.indexOf(e.term, from);
			if (idx < 0) break;
			from = idx + Math.max(1, e.term.length);
			// 与已命中区间重叠则放弃（长词优先已占位）
			if (spans.some(([s, t]) => idx < t && idx + e.term.length > s)) continue;
			spans.push([idx, idx + e.term.length]);
			matched.push({ term: e.term, kind: e.kind, tags: e.tags });
		}
	}

	const moods: string[] = [];
	const genres: string[] = [];
	for (const m of matched) {
		for (const tag of m.tags) {
			if (m.kind === 'mood' && !moods.includes(tag)) moods.push(tag);
			if (m.kind === 'genre' && !genres.includes(tag)) genres.push(tag);
		}
	}

	return { moods, genres };
}
