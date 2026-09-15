/**
 * radio/director — 电台编排器：时段栏目、选曲打分、DJ 口播。
 *
 * 设计立场（对应 RADIO.md 的「几厘米」论）：
 *  - 选曲是**确定性算法**（打分 + 排序 + 去重），零 token、零外部依赖、毫秒级；
 *    通用 Agent 每次都要重新理解曲库，而这里直接读私有曲库 + 长期记忆。
 *  - LLM（主 Agent）只在两个地方出场：用户对话里的电台指令（经
 *    radio_control 工具落到同一套 BFF API），以及未来可选的口播润色。
 *    编排主干永远不依赖 LLM 在线——这是「长驻运行」的可靠性前提。
 */
import type { Song } from '@/server/library';
import { readPreferences } from '@/server/user/preferences-store';
import {
	getAllTrackStats,
	memorySummary,
	recentlyPlayedTrackIds,
	type TrackStatRow,
	fusedTags,
} from './memory';

/** 时段栏目：一天被划成若干档，每档有自己的气质与选曲倾向。 */
export type Daypart = {
	id: string;
	name: string;
	/** 起始小时（含）；hours 数组列出本栏覆盖的小时，便于任意划分（如 23,0,1,2） */
	hours: number[];
	/** 亲和的 mood / genre（打分加成项，非硬过滤——曲库小的时候不至于无歌可排） */
	moods: string[];
	genres: string[];
	/** 栏目语气（DJ 口播选用模板组） */
	vibe: 'morning' | 'focus' | 'afternoon' | 'prime' | 'night' | 'latenight';
};

export const DAYPARTS: Daypart[] = [
	{ id: 'dawn', name: '晨间频道', hours: [5, 6, 7, 8], moods: ['gentle', 'peaceful', 'upbeat'], genres: ['classical', 'pop'], vibe: 'morning' },
	{ id: 'morning', name: '通勤节拍', hours: [9, 10, 11], moods: ['energetic', 'upbeat'], genres: ['pop', 'rock'], vibe: 'focus' },
	{ id: 'afternoon', name: '午后电台', hours: [12, 13, 14, 15, 16], moods: ['relaxed', 'calm'], genres: ['jazz', 'ambient'], vibe: 'afternoon' },
	{ id: 'prime', name: '黄金时段', hours: [17, 18, 19, 20, 21], moods: ['epic', 'energetic', 'upbeat'], genres: ['rock', 'pop'], vibe: 'prime' },
	{ id: 'night', name: '深夜书房', hours: [22, 23], moods: ['relaxed', 'melancholic', 'calm'], genres: ['jazz', 'blues', 'ambient'], vibe: 'night' },
	{ id: 'latenight', name: '午夜频率', hours: [0, 1, 2, 3, 4], moods: ['calm', 'peaceful'], genres: ['ambient', 'classical'], vibe: 'latenight' },
];

export function daypartForHour(hour: number): Daypart {
	return DAYPARTS.find((d) => d.hours.includes(hour)) ?? DAYPARTS[4];
}

/** 24 小时亲和度直方图 → 本时段的偏爱度（0~1）。听过的时段越多越爱。 */
function hourAffinity(stat: TrackStatRow, hour: number): number {
	let hist: Record<string, number> = {};
	try {
		hist = JSON.parse(stat.hour_hist) as Record<string, number>;
	} catch {
		hist = {};
	}
	const total = Object.values(hist).reduce((s, n) => s + n, 0);
	if (total === 0) return 0;
	return (hist[String(hour)] ?? 0) / total;
}

export type ScoredTrack = {
	song: Song;
	score: number;
	/** 打分依据（可解释性：状态页/口播可展示） */
	reasons: string[];
};

/**
 * 选曲打分。全部信号来自本地：曲目画像（记忆）、用户偏好（preferences 副本）、
 * 最近节目史（去重）。公式刻意保持简单可解释——壁垒在数据在不在本地，
 * 而不在公式多复杂。
 */
export async function scoreTrack(
	song: Song,
	stat: TrackStatRow | undefined,
	hour: number,
	recent: Set<string>,
	nowMs: number,
): Promise<ScoredTrack> {
	const daypart = daypartForHour(hour);
	const reasons: string[] = [];
	let score = 0.5;

	// 1. 时段气质匹配（mood 权重高于 genre：mood 是听感，genre 只是标签）
	const { genres, moods } = fusedTags(song);
	if (moods.some((m) => daypart.moods.includes(m))) {
		score += 0.18;
		reasons.push(`${daypart.name}·气质相符(${moods[0]})`);
	}
	if (genres.some((g) => daypart.genres.includes(g))) {
		score += 0.1;
		reasons.push(`风格相符(${genres[0]})`);
	}

	// 2. 时段亲和：历史上这个小时听它的比例高 → 它是「这个点的老朋友」
	const aff = stat ? hourAffinity(stat, hour) : 0;
	if (aff > 0.2) {
		score += 0.15 * Math.min(1, aff * 2);
		reasons.push(`${hour} 点常听`);
	}

	// 3. 熟悉度：播放越多越亲（但对数衰减，避免一两首霸榜）
	if (stat && stat.play_count > 0) {
		score += 0.12 * Math.log2(1 + stat.play_count) / 3;
		reasons.push(`听过 ${stat.play_count} 次`);
	}

	// 4. 负反馈：被跳过越多次越靠后；最近被跳过再打一档折扣
	if (stat && stat.skip_count > 0) {
		const ratio = stat.skip_count / Math.max(1, stat.play_count + stat.skip_count);
		score -= 0.35 * ratio;
		reasons.push(`跳过 ${stat.skip_count} 次`);
	}

	// 5. 新鲜感：最近 2 小时节目里播过的回避；画像里 last_played 很近的降权
	if (recent.has(song.id)) {
		score -= 0.5;
		reasons.push('最近播过');
	} else if (stat?.last_played_at) {
		const gapMs = nowMs - new Date(stat.last_played_at).getTime();
		if (gapMs < 45 * 60_000) {
			score -= 0.3;
			reasons.push('刚播过不久');
		}
	}

	return { song, score: Math.round(score * 1000) / 1000, reasons };
}

export type PlanInput = {
	songs: Song[];
	hour: number;
	/** 一档节目编排几首（默认 5） */
	blockSize?: number;
};

export type ProgramPlan = {
	name: string;
	daypartId: string;
	daypartName: string;
	hour: number;
	/** 编排结果：按分数排序的曲目 id 序列 */
	trackIds: string[];
	/** 每首歌的时长（秒），跳过检测 / 口播用 */
	durations: Map<string, number>;
	/** 每首歌的打分依据（状态页可解释性展示） */
	reasons: Map<string, string[]>;
	intro: string;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 编排一档节目：按时段气质打分 → 去掉低分尾部的负反馈曲目 → 截取 blockSize 首。
 * 曲库很小（<blockSize）时允许回填重复曲目，保证电台不停播。
 */
export async function planProgram(input: PlanInput): Promise<ProgramPlan> {
	const { songs, hour } = input;
	const blockSize = input.blockSize ?? 5;
	const daypart = daypartForHour(hour);
	const nowMs = Date.now();
	const recent = recentlyPlayedTrackIds();
	const stats = new Map(getAllTrackStats().map((s) => [s.track_id, s]));
	const prefs = await readPreferences();

	const scored: ScoredTrack[] = [];
	for (const song of songs) {
		const s = await scoreTrack(song, stats.get(song.id), hour, recent, nowMs);
		// 用户显式偏好（agent 记录的 favoriteGenres/Moods）作为额外加成
		const { genres, moods } = fusedTags(song);
		if (moods.some((m) => prefs.favoriteMoods.includes(m))) {
			s.score += 0.12;
			s.reasons.push('偏好·氛围');
		}
		if (genres.some((g) => prefs.favoriteGenres.includes(g))) {
			s.score += 0.08;
			s.reasons.push('偏好·风格');
		}
		if (genres.some((g) => prefs.dislikedGenres.includes(g))) {
			s.score -= 0.3;
			s.reasons.push('偏好·不喜欢该风格');
		}
		scored.push(s);
	}
	scored.sort((a, b) => b.score - a.score);

	// 负反馈兜底：分数太低（<0.25）且曲库够大时直接不排
	let pool = scored;
	if (songs.length >= blockSize * 2) {
		pool = scored.filter((s) => s.score >= 0.25);
		if (pool.length < blockSize) pool = scored;
	}
	const chosen = pool.slice(0, blockSize);
	// 极小曲库回填：不够 blockSize 就从头补（循环但保留打分顺序）
	while (chosen.length < Math.min(blockSize, Math.max(songs.length, 1)) && scored.length > 0) {
		chosen.push(scored[chosen.length % scored.length]);
	}

	const reasons = new Map(chosen.map((s) => [s.song.id, s.reasons]));
	const durations = new Map(chosen.map((s) => [s.song.id, s.song.durationSec]));
	// 可解释性兜底：没有任何信号的曲目也给出综合分，状态页不留空白
	for (const s of chosen) {
		if ((reasons.get(s.song.id)?.length ?? 0) === 0) {
			reasons.set(s.song.id, [`综合评分 ${s.score.toFixed(2)}`]);
		}
	}
	const mem = memorySummary();
	const name = `${daypart.name} · ${pad2(hour)}00 点场`;
	const intro = djIntro(daypart.vibe, {
		programName: name,
		count: chosen.length,
		firstSong: chosen[0]?.song,
		memory: mem,
	});

	return {
		name,
		daypartId: daypart.id,
		daypartName: daypart.name,
		hour,
		trackIds: chosen.map((s) => s.song.id),
		durations,
		reasons,
		intro,
	};
}

/** DJ 开场口播：确定性模板 + 记忆数据。语气按时段栏目分组。 */
export function djIntro(
	vibe: Daypart['vibe'],
	ctx: {
		programName: string;
		count: number;
		firstSong?: Song;
		memory: { knownTracks: number; totalPlays: number; totalSkips: number; programs: number };
	},
): string {
	const t = ctx.firstSong ? `第一首是 ${ctx.firstSong.artist} 的《${ctx.firstSong.title}》` : '歌单已经备好';
	const mem = `这座小站已经陪你播过 ${ctx.memory.programs} 档节目、${ctx.memory.totalPlays} 次播放`;
	const lines: Record<Daypart['vibe'], string[]> = {
		morning: [
			`早上好，这里是你的私人电台。${ctx.programName}开始了，${t}。新的一天，从熟悉旋律里醒过来。`,
			`早安。「${ctx.programName}」已上线，${t}。愿你今天节奏轻快。`,
		],
		focus: [
			`欢迎回到你的私人电台。「${ctx.programName}」现在开播，${t}。把它当背景，专注你自己的事就好。`,
			`这一档是「${ctx.programName}」，${t}。适合戴上半只耳朵干活。`,
		],
		afternoon: [
			`下午好，「${ctx.programName}」准时开播。${t}。给自己十五分钟，喝口水再出发。`,
			`这里是午后电台。「${ctx.programName}」，${t}。慢慢来。`,
		],
		prime: [
			`晚上好，黄金时段到了。「${ctx.programName}」开播，${t}。今天最提神的都排在这一档。`,
			`欢迎收听「${ctx.programName}」，${t}。把音量拧大一点。`,
		],
		night: [
			`夜深了。「${ctx.programName}」开播，${t}。${mem}。今晚也交给我。`,
			`这里是深夜书房。「${ctx.programName}」已上线，${t}。灯留一盏就好。`,
		],
		latenight: [
			`这么晚还没睡？「${ctx.programName}」陪你，${t}。${mem}。睡前的歌我都挑好了。`,
			`午夜频率开播。「${ctx.programName}」，${t}。听完这一档就去休息。`,
		],
	};
	const arr = lines[vibe];
	return arr[Math.floor(Math.random() * arr.length)];
}

/** 换栏目时的收播词。 */
export function djOutro(oldName: string, newName: string): string {
	return `「${oldName}」到这里收播。接下来交给「${newName}」，频率不变，故事继续。`;
}
