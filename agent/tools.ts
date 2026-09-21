/**
 * ③ 工具集 —— 模型能做的每一件事，一个工具一件。
 *
 * 这是 BLUEPRINT §2 里的**活跃区**：加功能绝大多数时候是在这里加一个元素。
 *
 * 关键取舍：工具**不走进程内直调**，而是用 HTTP 打自家 BFF 路由
 * （`/api/player/play` 等）。理由有二：
 *  1. agent 与浏览器因此共用**同一个 API 面**——前端按钮能做的事，agent 走的是
 *     同一条路径、同一套校验、同一个信封。不存在「第二套入口」，也就没有
 *     「两边校验各自演化、最后不一致」这个失败模式；
 *  2. `agent/` 不必 import 任何 `server/` 域逻辑，层级干净（域逻辑改了签名，
 *     这里只会以一个 400 暴露，而不是编译期耦合）。
 * 代价是多一次本机回环 HTTP（<1ms），这个场景可以忽略。
 *
 * 上下文**按请求构造**（`createTools(ctx)`），不是模块级常量：BFF 的 origin 以
 * 参数显式传入，读单个工具时也看得见它从哪来。旧项目在这里用的是一个模块级可变
 * 全局（`setApiBase`）——读工具代码时看不见 base 的来源，信息没有到达读者眼前，
 * 就是黑盒的起点。
 *
 * 工具定义与执行体写在**同一个对象**里，而不是两个平行清单：分开写时最容易发生
 * 的漂移是「schema 加了参数、执行体没读」，模型于是永远填了一个被忽略的字段，
 * 而且不报错。参数说明写进 `.describe()`，与 schema 同源。
 *
 * ⚠️ **两条会静默失败的书写约束**（TS 报错位置极具误导性，2026-09-15 踩）：
 *  1. `execute` 必须**就地内联**在 `tool({...})` 里。写成 `execute: exec(fn)` 这种
 *     泛型包装时，包装函数的参数与 `inputSchema` 互相等对方先确定，TS 解不开，
 *     把 `INPUT` 推成 `never`——**却报在 `inputSchema` 上**（"ZodObject 不能赋给
 *     FlexibleSchema<never>"），看起来像 zod 版本问题。
 *  2. `toModelOutput` 必须写在 `execute` **之后**，且参数**不写注解**。
 *     `output` 的类型由 `execute` 的返回值反推，写在前面时拿到的是 `unknown`；
 *     自己写注解 `{ output: ToolOutcome }` 则会打断推导，直接让整个 `tool()` 调用
 *     不匹配任何重载。正确写法见下方 `toModelOutput: ({ output }) => ...`。
 */
import { tool } from 'ai';
import { z } from 'zod';
import { PLAYBACK_MODE_LABEL } from '../contract/player';
import { normalizePreferenceKey, type Preference } from '../contract/preference';
import type { ToolOutcome } from '../contract/tool';
import { normalizeTags } from '../contract/track-tags';

export type ToolRunContext = {
	/** 自家 BFF 的 origin，由路由从 `request.url` 取——不硬编码端口。 */
	baseUrl: string;
};

/* ── 信封与格式小工具 ─────────────────────────────────────────── */

type Envelope<T> = { code: number; data?: T; message?: string };

/**
 * 调自家 BFF。**成功判据是 `code === 0`，不是 `res.ok`**——
 * 本项目信封的约定是成功 `code: 0`、失败时 `code` 才等于 HTTP status。
 * 按「200 即成功」写会漏掉「HTTP 200 但 code 非 0」的情形。
 */
async function callBff<T>(
	ctx: ToolRunContext,
	path: string,
	init?: RequestInit,
	signal?: AbortSignal,
): Promise<{ ok: boolean; data?: T; message: string }> {
	try {
		const res = await fetch(new URL(path, ctx.baseUrl), { ...init, signal });
		const body = (await res.json().catch(() => null)) as Envelope<T> | null;
		if (!res.ok || !body || body.code !== 0) {
			return { ok: false, message: body?.message ?? `HTTP ${res.status}` };
		}
		return { ok: true, data: body.data, message: body.message ?? 'ok' };
	} catch (err) {
		return { ok: false, message: `请求失败：${err instanceof Error ? err.message : String(err)}` };
	}
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** 把秒数写成 `3:07`，比 `187` 更容易被模型正确复述。 */
function mmss(sec: number): string {
	if (!Number.isFinite(sec) || sec <= 0) return '--:--';
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, '0')}`;
}

/** 各 BFF 路由返回的 data 形状（只取用得到的字段）。 */
type SearchData = {
	/** 命中的**总数**（不受 limit / offset 限制）。 */
	total: number;
	songs: {
		id: string;
		title: string;
		artist: string;
		album: string;
		durationSec: number;
		tags: string[];
	}[];
};

type PlayData = { state: string; currentTrack: { title: string; artist: string } | null };

/** 换队列的响应：播放载荷 + 队列自身的信息（来源、长度、被丢掉的 id）。 */
type QueueData = PlayData & {
	queueSize: number;
	queueSource: 'library' | 'custom';
	queueLabel: string | null;
	/** 库里已经不存在的 id（被丢掉而不是让整批失败，见 queue 路由）。 */
	missing: string[];
};

/** `/api/player/settings` 的响应：改完之后的音量与播放方式。 */
type SettingsData = { volume: number; mode: 'seq' | 'rpt' | 'one'; shuffle: boolean };

type HistoryData = {
	count: number;
	plays: { id: number; trackId: string; title: string; artist: string; startedAt: string }[];
};

/** `/api/library/tags` 的行，只取用得到的两列（`updatedAt` 对模型没有意义）。 */
type TagRow = { tags: string[]; source: string };

type TagListData = { tags: TagRow[] };

/** `/api/library/tags?trackId=` 的单条响应：没有标签时 `tag` 为 null。 */
type SingleTagData = { tag: TagRow | null };

/* ── 两个纯函数：把数据译成模型读得懂的话 ─────────────────────────
 *
 * 它们**导出是给单测用的**（`agent/tools.test.ts`），不是给别的模块调。
 * 之所以值得单独拎出来测：这两处的错都是**静默**的——相对时间算错、标签漏算，
 * 工具照样成功返回、模型照样拿到一段通顺的话，只是那段话是错的。
 */

/** 相对时间的档位。超过一周就不再给相对说法（"23 天前"没有信息量，不如看日期）。 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 把 ISO 时间译成「03-16 22:41，3 小时前」。
 *
 * 为什么必须带相对说法：**提示词里没有「现在几点」**（只有播放状态）。所以模型
 * 拿到一串裸时间戳时，无法回答「我昨晚听了什么」——它连今天是几号都不知道。
 * 相对时间在这里算，等于把「现在」这个事实随每次工具结果捎进去。
 */
export function formatPlayTime(iso: string, now: Date = new Date()): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso; // 库里存了脏值就原样给，不要编一个时间
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;

	const diff = now.getTime() - at.getTime();
	let rel = '';
	// 未来时间（时钟漂移 / 手工改过库）不给相对说法。**这个否定必须先判**：放任它往下走，
	// `diff < MINUTE` 是成立的（负数当然小于 60000），于是一条两小时后才发生的播放
	// 会被写成「刚刚」——看起来像刚放完，而库里的时间戳明明在将来。
	if (diff >= 0) {
		if (diff < MINUTE) rel = '刚刚';
		else if (diff < HOUR) rel = `${Math.floor(diff / MINUTE)} 分钟前`;
		else if (diff < DAY) rel = `${Math.floor(diff / HOUR)} 小时前`;
		else if (diff < 2 * DAY) rel = '昨天';
		else if (diff < 7 * DAY) rel = `${Math.floor(diff / DAY)} 天前`;
	}

	return rel ? `${stamp}，${rel}` : stamp;
}

/**
 * 把标签行汇总成「库里存在哪些标签」。按出现次数降序，同次数按字母序
 * （**排序稳定**才能写断言，也才能让同样的库每次给出同样的提示词）。
 *
 * `user: true` 表示至少有一首歌的标签是用户自己定的——模型据此知道这类标签
 * 不该被它随手改掉（见 `server/library/tags.ts` 的 ai/user 优先级）。
 */
export function summarizeTags(rows: TagRow[]): { tag: string; count: number; user: boolean }[] {
	const byTag = new Map<string, { tag: string; count: number; user: boolean }>();
	for (const row of rows) {
		for (const tag of row.tags ?? []) {
			const hit = byTag.get(tag) ?? { tag, count: 0, user: false };
			hit.count += 1;
			hit.user ||= row.source === 'user';
			byTag.set(tag, hit);
		}
	}
	return [...byTag.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * 构造本次请求的工具集。
 *
 * 每个 `execute` **不抛异常**：失败也走返回值（`ok:false` + 原因文字）。理由是这个
 * 失败要同时喂给两个消费者——模型（据此调整话术）和用户（前端展示的 trace 卡片）。
 * 抛出去会让模型那一侧只看到一句「工具异常」，而前端什么也看不到。
 */
export function createTools(ctx: ToolRunContext) {
	/** 计时 + 把异常收敛成失败结果。 */
	const settled = async (
		act: () => Promise<{ ok: boolean; text: string }>,
	): Promise<ToolOutcome> => {
		const started = Date.now();
		try {
			return { ...(await act()), ms: Date.now() - started };
		} catch (err) {
			return {
				ok: false,
				text: `工具执行异常：${err instanceof Error ? err.message : String(err)}`,
				ms: Date.now() - started,
			};
		}
	};

	return {
		search_library: tool({
			description:
				'在本地曲库里按关键词检索曲目，返回曲名、歌手、时长、风格标签和 trackId。' +
				'关键词会匹配曲名 / 歌手 / 专辑，也会匹配**风格标签**——所以「来点舒缓的」' +
				'「有没有摇滚」这类请求也用本工具（标签是 pop / folk / ballad / dance 这样的英文词）。' +
				'查询词留空则返回整库（用于「有哪些歌」这类问题）。' +
				'一次最多 20 条：命中比这更多时返回值会告诉你还能用 offset 接着看。' +
				'想播放任何歌曲前，必须先用本工具拿到 trackId。',
			inputSchema: z.object({
				query: z.string().describe('检索关键词，如歌手名、曲名片段或风格标签。留空表示列出整库。'),
				limit: z.number().int().min(1).max(20).optional().describe('最多返回几条，1-20，默认 10。'),
				offset: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe('跳过前几条（翻页用），默认 0。命中数超过 limit 时，返回值会给出下一页的 offset。'),
			}),
			execute: ({ query, limit, offset }, { abortSignal }) =>
				settled(async () => {
					const q = query.trim();
					const n = limit ?? 10;
					const from = offset ?? 0;
					const r = await callBff<SearchData>(
						ctx,
						`/api/library/search?q=${encodeURIComponent(q)}&limit=${n}&offset=${from}`,
						undefined,
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `检索失败：${r.message}` };

					const total = r.data?.total ?? 0;
					const songs = r.data?.songs ?? [];
					if (total === 0) {
						return { ok: true, text: q ? `曲库里没有匹配「${q}」的曲目。` : '曲库是空的。' };
					}
					// 翻过头了：总数不为 0 但这一页是空的。**必须单独说一句**，
					// 否则模型会拿"命中 N 首"当结论、以为后面就是没有。
					if (songs.length === 0) {
						return {
							ok: true,
							text: `共命中 ${total} 首，但 offset=${from} 已经翻过头了（只有 ${total} 首）。`,
						};
					}
					// 编号是**在整批里的位置**（含 offset），不是本页内的 1..N ——
					// 否则翻到第二页时「第 1 首」会指另一首歌，模型转述给用户就是错的。
					const lines = songs.map((s, i) => {
						const tagText = s.tags?.length ? `，标签：${s.tags.join('/')}` : '';
						return `${from + i + 1}. ${s.title} — ${s.artist}（${mmss(s.durationSec)}，id=${s.id}${tagText}）`;
					});
					const rest = total - from - songs.length;
					const tail = rest > 0 ? `；还有 ${rest} 首，用 offset=${from + songs.length} 接着看` : '';
					return {
						ok: true,
						text: `命中 ${total} 首，本页第 ${from + 1}–${from + songs.length} 首：\n${lines.join('\n')}${tail}`,
					};
				}),
			// 只把 text 交给模型；不写这个，默认会把整个 {ok,text,ms} JSON 发过去。
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		play_track: tool({
			description:
				'立即播放指定曲目，参数是该曲目的 trackId。调用后队列不动，只是当前曲目切到这一首。',
			inputSchema: z.object({
				trackId: z
					.string()
					.min(1)
					.describe(
						'曲目 id，就是曲库里的文件名（如「奢香夫人 - 凤凰传奇.mp3」）。必须来自 search_library 的返回值，不要自己编。',
					),
			}),
			execute: ({ trackId }, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<PlayData>(
						ctx,
						'/api/player/play',
						{ method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ trackId }) },
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `播放失败：${r.message}` };
					const t = r.data?.currentTrack;
					return { ok: true, text: t ? `已开始播放：${t.title} — ${t.artist}` : '已切换曲目。' };
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		/**
		 * **按条件组队列** —— 本项目从「播放控制」迈向「按你的意思放」的那一步。
		 *
		 * 从前队列恒等于整个曲库（`ensureQueue(getSongs())`），于是「来点安静的」
		 * 只能搜一首播一首，`next_track` 转眼又跑回整库顺序。给模型一个能换队列
		 * 的工具之后，「连续听某一批」才成为一件它能做的事。
		 *
		 * 它一次做两件事（搜 → 组 → 开播），而不是像「放一首歌」那样拆成两步
		 * 工具调用：用户说「来点安静的」要的是**听到**，不是一份待播清单；拆开
		 * 只会多一次往返、多一次猜错的机会。而「先搜再播」的两步仍保留给
		 * `play_track` —— 那里模型需要看到候选曲名并选一个，这里不需要选。
		 */
		build_queue: tool({
			description:
				'换掉整个播放队列，并立刻开始放这一批的第一首。用于用户要**连续听某一批**的要求：' +
				'「来点安静的」「放点摇滚的」「只想听凤凰传奇」，也用于「换个风格」这种整体换口味。' +
				'query 的匹配规则与 search_library 相同（曲名 / 歌手 / 专辑 / 风格标签）。' +
				'query 留空 = 恢复成整个曲库（用户说「别只放这几首了」「放回全部」时用它）。' +
				'只放**某一首具体的歌**请用 play_track，不要用本工具。',
			inputSchema: z.object({
				query: z
					.string()
					.optional()
					.describe(
						'挑选条件，如风格标签（quiet / rock）、歌手名或关键词。省略或留空表示恢复整个曲库。',
					),
				limit: z.number().int().min(1).max(50).optional().describe('这批最多几首，1-50，默认 20。'),
				label: z
					.string()
					.optional()
					.describe('这批队列的名字，会显示给用户，如「安静的歌」「凤凰传奇」。省略则用 query 原文。'),
			}),
			execute: ({ query, limit, label }, { abortSignal }) =>
				settled(async () => {
					const q = (query ?? '').trim();
					const n = limit ?? 20;

					// ── 恢复整库：空条件就是「没有条件」这一批（见 queue 路由的文件头）──
					if (!q) {
						const r = await callBff<QueueData>(
							ctx,
							'/api/player/queue',
							{ method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ trackIds: [] }) },
							abortSignal,
						);
						if (!r.ok) return { ok: false, text: `恢复整个曲库失败：${r.message}` };
						return {
							ok: true,
							text: `队列已恢复为整个曲库，共 ${r.data?.queueSize ?? 0} 首，从第一首开始放。`,
						};
					}

					// ── 先搜 ──
					const found = await callBff<SearchData>(
						ctx,
						`/api/library/search?q=${encodeURIComponent(q)}&limit=${n}`,
						undefined,
						abortSignal,
					);
					if (!found.ok) return { ok: false, text: `按「${q}」挑歌失败：${found.message}` };
					const songs = found.data?.songs ?? [];
					if (songs.length === 0) {
						// 队列**没有动**，这一点必须说清楚：否则模型可能以为换成了空队列。
						return {
							ok: false,
							text: `曲库里没有匹配「${q}」的曲目，队列没有改动。可以换个说法再试，或先用 list_tags 看看库里有哪些用词。`,
						};
					}

					// ── 再组队列 ──
					const r = await callBff<QueueData>(
						ctx,
						'/api/player/queue',
						{
							method: 'POST',
							headers: JSON_HEADERS,
							body: JSON.stringify({ trackIds: songs.map((s) => s.id), label: label ?? q }),
						},
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `换成这一批队列失败：${r.message}` };

					const total = found.data?.total ?? songs.length;
					const missing = r.data?.missing?.length ?? 0;
					const more = total > songs.length ? `，命中 ${total} 首，本批取了前 ${songs.length} 首` : '';
					const dropped = missing ? `；其中 ${missing} 首已不在曲库里，被跳过` : '';
					// 报一下开头几首：模型这一轮就能回答「接下来放什么」，
					// 不必让用户再问一次（下一轮的系统提示词里会有队列窗口）。
					const head = songs
						.slice(0, 3)
						.map((s, i) => `${i + 1}. ${s.title} — ${s.artist}`)
						.join('\n');
					return {
						ok: true,
						text:
							`队列已换成「${label ?? q}」，共 ${r.data?.queueSize ?? songs.length} 首${more}${dropped}，` +
							`现在开始放第 1 首。开头几首：\n${head}`,
					};
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		next_track: tool({
			description: '跳到队列中的下一首。已经在队尾时返回提示，此时播放停止。',
			inputSchema: z.object({}),
			execute: (_args, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<PlayData>(
						ctx,
						'/api/player/next',
						{ method: 'POST' },
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `切歌失败：${r.message}` };
					const t = r.data?.currentTrack;
					if (!t) return { ok: true, text: '已经是队列最后一首，播放已停止。' };
					return { ok: true, text: `已跳到下一首：${t.title} — ${t.artist}` };
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		pause_playback: tool({
			description: '暂停当前播放。没有在播放时返回提示，不算失败。',
			inputSchema: z.object({}),
			execute: (_args, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<unknown>(
						ctx,
						'/api/player/pause',
						{ method: 'POST' },
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `暂停失败：${r.message}` };
					return { ok: true, text: '已暂停。' };
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		resume_playback: tool({
			description: '从暂停状态继续播放。当前没有暂停时返回提示。',
			inputSchema: z.object({}),
			execute: (_args, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<unknown>(
						ctx,
						'/api/player/resume',
						{ method: 'POST' },
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `继续播放失败：${r.message}` };
					return { ok: true, text: '已继续播放。' };
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		/**
		 * 音量。**它的存在依赖 ⑦ 里那句「音量：80%」**——「大声点」不是绝对值，
		 * 提示词里没有当前音量时，模型只能瞎给一个数（从 80 调到 50 还是调到 99？），
		 * 猜错了用户只会觉得它听不懂人话。所以这个工具和 `prompt.ts` 的
		 * `stateLines` 是**一对**，改一个就要看另一个。
		 *
		 * 对外用百分数（0-100）：用户说「音量 30」，模型答「设成 30%」，
		 * 中间不该出现 0.3 这种只在代码里有意义的形态。换算在这一处完成，
		 * 路由与状态层一律只认 0–1（与 `HTMLAudioElement.volume` 一致）。
		 */
		set_volume: tool({
			description:
				'调整播放音量。用户说「大声点」「小声点」「太吵了」「静音」时用它。' +
				'**先看系统提示词里的当前音量，在它基础上调整**（比如现在 80%，「小声点」就设 40-50），' +
				'不要凭空给一个数。要完全静音就设 0。' +
				'（提示词里那个当前值是**快照**，可能与实际差一点：音量存在浏览器里，' +
				'上报有延迟。本工具返回的才是**回读的实际值**，答话时以它为准。）',
			inputSchema: z.object({
				level: z.number().int().min(0).max(100).describe('音量百分比，0-100。0 表示静音。'),
			}),
			execute: ({ level }, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<SettingsData>(
						ctx,
						'/api/player/settings',
						{
							method: 'POST',
							headers: JSON_HEADERS,
							body: JSON.stringify({ volume: level / 100 }),
						},
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `调整音量失败：${r.message}` };
					// 回读服务端的实际值（它可能夹紧过）—— 报「设成 30%」而实际是 100%
					// 是那种用户当场就能发现、而代码永远不会红的错。
					const now = Math.round((r.data?.volume ?? level / 100) * 100);
					return { ok: true, text: now === 0 ? '已静音（音量 0%）。' : `音量已设为 ${now}%。` };
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		/**
		 * 播放方式。循环方式与随机开关放在**同一个工具**里，因为它们在 UI 上就是
		 * 紧挨着的一组、在用户嘴里也常常一句话说完（「随机循环放」）——拆成两个
		 * 工具只会让模型在「用户到底说的是哪一个」上多一次判断。
		 *
		 * 两个参数都可选，但至少给一个：只给 `shuffle` 时循环方式保持不变
		 * （路由按「只改给了的字段」实现，见 `app/api/player/settings/route.ts`）。
		 */
		set_playback_mode: tool({
			description:
				'设置播放方式：循环方式 + 随机开关。用户说「单曲循环」「这首歌循环放」→ mode=one；' +
				'「列表循环」「一直循环」→ mode=rpt；「顺序播放」「放完就停」→ mode=seq；' +
				'「随机播放」「打乱放」→ shuffle=true；「别随机了」「按顺序来」→ shuffle=false。' +
				'只说了其中一件事时，另一件不要给（保持现状）。',
			inputSchema: z.object({
				mode: z
					.enum(['seq', 'rpt', 'one'])
					.optional()
					.describe('循环方式：seq=顺序播放，rpt=列表循环，one=单曲循环。'),
				shuffle: z.boolean().optional().describe('随机开关：true=随机播放，false=不随机。'),
			}),
			execute: ({ mode, shuffle }, { abortSignal }) =>
				settled(async () => {
					if (mode === undefined && shuffle === undefined) {
						return {
							ok: false,
							text: '没有说明要改成什么播放方式。请给出循环方式（单曲 / 列表 / 顺序）或是否随机。',
						};
					}
					const r = await callBff<SettingsData>(
						ctx,
						'/api/player/settings',
						{
							method: 'POST',
							headers: JSON_HEADERS,
							// `undefined` 的键会被 JSON.stringify 丢掉 —— 正是我们要的
							// 「只改给了的那个」，不必手动拼 body。
							body: JSON.stringify({ mode, shuffle }),
						},
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `设置播放方式失败：${r.message}` };

					const parts: string[] = [];
					// 只复述**这次改动的**那一部分。写成 `if (r.data?.mode)` 就会在
					// 「只改随机」时把没动过的循环方式也报一遍，读起来像它被改了。
					if (mode !== undefined) parts.push(PLAYBACK_MODE_LABEL[r.data?.mode ?? mode]);
					if (shuffle !== undefined) parts.push(shuffle ? '随机播放' : '不随机');
					return { ok: true, text: `播放方式已设为：${parts.join(' + ')}。` };
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		/**
		 * ⑥ 记忆的**写入口**。它和上面几个工具形态相同（都是打自家 BFF），
		 * 但它改变的不是播放状态，而是**服务端对这个用户的认知**——
		 * 所以它写下去的东西会在下一轮、以及以后每一次对话里出现在系统提示词里。
		 *
		 * `key` 在本地先过一遍 `normalizePreferenceKey`：这样模型拿回的是规范化后的
		 * key，下次用同一个 key 才不会写成第二条（归一化规则与存储层共用，见 contract）。
		 */
		remember_preference: tool({
			description:
				'记住一条关于用户的持久偏好，跨对话长期生效，例如「不喜欢摇滚」「晚上只听轻音乐」。' +
				'只在用户表达了**稳定的喜好或长期约束**时调用；一次性的要求（「放首歌」「大声点」「换一首」）不要记。' +
				'当前已记住的偏好会列在系统提示词的【已知偏好】里，先看那里，不要重复记同一个意思。' +
				'同一个 key 再记会覆盖旧值——用户改主意时用它覆盖，而不是新增。',
			inputSchema: z.object({
				key: z
					.string()
					.describe(
						'这条偏好的标识，英文小写加下划线，如 disliked_genre、preferred_artist、no_music_at_night。同一个 key = 同一条偏好，会覆盖。',
					),
				value: z.string().describe('偏好内容，把用户的意思浓缩成一句，如「摇滚」或「睡前放轻音乐」。'),
			}),
			execute: ({ key, value }, { abortSignal }) =>
				settled(async () => {
					const normalized = normalizePreferenceKey(key);
					if (!normalized) {
						return {
							ok: false,
							text: 'key 不合法：只能用英文字母、数字、下划线（如 disliked_genre）。换一个 key 再试。',
						};
					}
					const r = await callBff<{ preference: Preference }>(
						ctx,
						'/api/preferences',
						{
							method: 'POST',
							headers: JSON_HEADERS,
							body: JSON.stringify({ key: normalized, value }),
						},
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `记住失败：${r.message}` };
					return { ok: true, text: `已记住：${value}（key=${normalized}）` };
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		forget_preference: tool({
			description:
				'忘掉一条已记住的偏好。用户说「不用记了」「忘掉刚才那句」「这个不算」时调用。' +
				'key 用【已知偏好】里列出的那个。',
			inputSchema: z.object({
				key: z.string().describe('要忘掉的那条偏好的 key（见系统提示词的【已知偏好】）。'),
			}),
			execute: ({ key }, { abortSignal }) =>
				settled(async () => {
					const normalized = normalizePreferenceKey(key);
					if (!normalized) {
						return { ok: false, text: 'key 不合法：只能用英文字母、数字、下划线。' };
					}
					const r = await callBff<{ removed: boolean }>(
						ctx,
						`/api/preferences?key=${encodeURIComponent(normalized)}`,
						{ method: 'DELETE' },
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `忘掉失败：${r.message}` };
					return {
						ok: true,
						text: r.data?.removed ? `已忘掉「${normalized}」。` : `本来就没记过「${normalized}」。`,
					};
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		/**
		 * 曲目风格的**用户重设入口**。它和 `remember_preference` 是同一类东西 ——
		 * 都改变「服务端对这个世界的认知」，而不是当下的播放状态。
		 *
		 * 优先级由服务端保证而不是这里：路由写进去的 `source` 恒为 `'user'`，
		 * 而 AI 批量打标遇到用户设过的行会跳过（见 `server/library/tags.ts`）。
		 * 所以工具这边不需要判断「该不该覆盖」——**入口本身就决定了优先级**。
		 *
		 * ── 为什么是 add / remove，而不是「新标签整体替换」（2026-09-17 改）──
		 * 原实现把 `tags` 当**完整新集合**：用户说「这首其实是民谣」，模型只写
		 * 「民谣」，原有的 `中国风,广场舞` 就没了——**静默的数据丢失**，工具回
		 * 「已设为民谣」、一切正常，只有回头看标签列表才发现少了两条。
		 * 措辞上提醒模型「要把想保留的也写进去」治不住它：模型没法可靠地穷举
		 * 「原有的全部」，而漏一个也不报错。
		 * 改成增删之后，**没写到的部分在语义上就等于不变**，漏写不可能造成丢失。
		 * 代价是「整批换掉」表达起来啰嗦一点（把旧的列进 remove），但那本来就
		 * 不是用户说话的方式。**替换语义仍在 `/api/library/tags` 上**——路由是
		 * 「重设」，工具是「改」，两者不冲突：工具自己读、自己算、再调那个重设。
		 */
		set_track_tags: tool({
			description:
				'增删某首歌的风格标签：**只动你写出来的那些，没写到的标签保持不变**。' +
				'用户对曲目风格的判断优先于系统自动打的标签，且不会被之后的自动打标覆盖。' +
				'用户说「这首其实是民谣」「也适合跳舞」→ 用 add；说「别把它当摇滚」「不算民谣」→ 用 remove。' +
				'两件事同时发生时两个参数都给。**不要**笼统地说"它的标签是 X"然后就只填 X。' +
				'需要先用 search_library 拿到 trackId，并从它的返回值里看清这首歌当前有哪些标签。',
			inputSchema: z.object({
				trackId: z
					.string()
					.min(1)
					.describe('曲目 id，来自 search_library 的返回值（形如「奢香夫人 - 凤凰传奇.mp3」）。'),
				add: z
					.string()
					.optional()
					.describe('要加上的标签，逗号分隔，如「民谣,抒情」。原有标签不受影响。'),
				remove: z
					.string()
					.optional()
					.describe('要删掉的标签，逗号分隔。只写用户明确否定掉的那个词，不要顺手清空。'),
			}),
			execute: ({ trackId, add, remove }, { abortSignal }) =>
				settled(async () => {
					const toAdd = normalizeTags(add ?? '');
					const toRemove = normalizeTags(remove ?? '');
					// 两个都没给：**不能当成"清空"**。清空是最危险的动作，必须有明确的
					// 输入才执行；这里退化成一句可照做的提示（模型下一轮就会补上参数）。
					if (toAdd.length === 0 && toRemove.length === 0) {
						return {
							ok: false,
							text: '没有说明要加什么或去掉什么标签。请用 add 给出要加上的标签，或 remove 给出要删掉的。',
						};
					}

					// 读当前值再算最终值 —— 增量语义必须建立在这个读之上，否则就退回成替换。
					const current = await callBff<SingleTagData>(
						ctx,
						`/api/library/tags?trackId=${encodeURIComponent(trackId)}`,
						undefined,
						abortSignal,
					);
					if (!current.ok) return { ok: false, text: `读取原有标签失败：${current.message}` };
					const before = current.data?.tag?.tags ?? [];

					const final = [...new Set([...before, ...toAdd])].filter((t) => !toRemove.includes(t)).sort();
					const added = toAdd.filter((t) => !before.includes(t));
					const removed = before.filter((t) => toRemove.includes(t));

					if (added.length === 0 && removed.length === 0) {
						return {
							ok: true,
							text: `标签没有变化：这首歌现在仍是「${before.join('、') || '没有标签'}」。`,
						};
					}

					// 最终集合为空 → 用 DELETE 把这一行删掉（POST 明确拒绝空标签）。
					// 两条路都写成功，才算真的改完。
					const wrote = final.length
						? await callBff<{ tag: TagRow }>(
								ctx,
								'/api/library/tags',
								{
									method: 'POST',
									headers: JSON_HEADERS,
									body: JSON.stringify({ trackId, tags: final }),
								},
								abortSignal,
							)
						: await callBff<{ removed: boolean }>(
								ctx,
								`/api/library/tags?trackId=${encodeURIComponent(trackId)}`,
								{ method: 'DELETE' },
								abortSignal,
							);
					if (!wrote.ok) return { ok: false, text: `更新标签失败：${wrote.message}` };

					// 复述**最终全量**而不是「成功了」：模型拿这句去回答用户，用户照着
					// 这句核对；只回「已更新」时，改错了要等下次看标签列表才发现。
					// 顺带说一句这行现在归用户所有 —— 它意味着以后自动打标不会再动它。
					const now = final.length ? `现在是「${final.join('、')}」` : '现在没有任何标签';
					return {
						ok: true,
						text:
							`已更新标签，${now}。` +
							`（加上：${added.join('、') || '无'}；去掉：${removed.join('、') || '无'}）` +
							`这首歌的标签从此以你的设定为准，自动打标不会再改动它。`,
					};
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		/**
		 * 播放历史。它读的 `plays` 表与曲库**不是一回事**：曲名 / 歌手在写入时冗余存了
		 * 一份，所以歌被移走、改名之后历史依然可读（见 `server/records/play-log.ts`）。
		 * 这也让「我上周听的那首叫什么」有了答案——曲库里已经找不到它了。
		 */
		recent_plays: tool({
			description:
				'查看最近播放过的曲目（新的在前）。用于「我刚听了什么」「最近都听了哪些歌」' +
				'「昨天放的是什么」这类回顾。历史记的是播放当时的曲名，那首歌后来被移出曲库也仍在。' +
				'要找歌来播请用 search_library，本工具只做回顾。',
			inputSchema: z.object({
				limit: z.number().int().min(1).max(50).optional().describe('最多返回几条，1-50，默认 10。'),
			}),
			execute: ({ limit }, { abortSignal }) =>
				settled(async () => {
					const n = limit ?? 10;
					const r = await callBff<HistoryData>(
						ctx,
						`/api/history?limit=${n}`,
						undefined,
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `读取播放历史失败：${r.message}` };
					const plays = r.data?.plays ?? [];
					if (plays.length === 0) return { ok: true, text: '还没有播放记录。' };
					const lines = plays.map(
						(p, i) => `${i + 1}. ${p.title} — ${p.artist}（${formatPlayTime(p.startedAt)}）`,
					);
					return { ok: true, text: `最近 ${plays.length} 次播放，新的在前：\n${lines.join('\n')}` };
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		/**
		 * 按**位置**跳转。它和 `play_track` 的区别不在实现，在**用户的说法**：
		 * 说曲名 → 先搜再播（play_track）；说第几首 → 直接跳（本工具）。
		 * 所以 `position` 是 1 基、与系统提示词里队列列表的编号一致，**差一在这一行吸收**。
		 */
		jump_in_queue: tool({
			description:
				'跳到当前播放队列中的第 position 首并开始播放。用于用户**按位置**说话的场景：' +
				'「跳到第 5 首」「回到第一首」「跳到队列最后一首」。' +
				'position 从 1 开始，对应系统提示词【当前播放状态】里队列列表的编号。' +
				'如果用户说的是曲名，改用 search_library + play_track。',
			inputSchema: z.object({
				position: z.number().int().min(1).describe('队列中的位置，从 1 开始（1 = 第一首）。'),
			}),
			execute: ({ position }, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<PlayData>(
						ctx,
						'/api/player/jump',
						{
							method: 'POST',
							headers: JSON_HEADERS,
							// 对外 1 基、对内 0 基（`jumpToIndex` 收的是下标）。
							body: JSON.stringify({ index: position - 1 }),
						},
						abortSignal,
					);
					if (!r.ok) {
						return {
							ok: false,
							text: `跳到第 ${position} 首失败：${r.message}。当前队列的长度见系统提示词的队列列表。`,
						};
					}
					const t = r.data?.currentTrack;
					return {
						ok: true,
						text: t ? `已跳到第 ${position} 首：${t.title} — ${t.artist}` : `已跳到第 ${position} 首。`,
					};
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),

		/**
		 * 标签词表。**不是用来找歌的**（那是 `search_library`）——它回答的是
		 * 「这个库现在用哪些词在描述风格」，用途有二：
		 *  1. 用户问「都有哪些风格」时直接答；
		 *  2. **改标签之前先看已有用词**，避免 pop / 流行 / 华语流行 各记一套：
		 *     同义标签会让「来点流行的」只命中其中一部分，而库里看不出它们是同一个意思。
		 */
		list_tags: tool({
			description:
				'列出曲库里已存在的风格标签、每个标签有几首歌，并告诉你其中哪些是用户自己定的。' +
				'用于「都有哪些风格的歌」「你能按什么标签筛」这类问题，也用于**给某首歌改标签之前' +
				'先看库里已有的用词**，尽量复用（避免 pop / 流行 / 华语流行 各记一套）。' +
				'要找歌来播请用 search_library。',
			inputSchema: z.object({}),
			execute: (_args, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<TagListData>(ctx, '/api/library/tags', undefined, abortSignal);
					if (!r.ok) return { ok: false, text: `读取标签失败：${r.message}` };
					const rows = r.data?.tags ?? [];
					const summary = summarizeTags(rows);
					if (summary.length === 0) return { ok: true, text: '曲库里还没有任何风格标签。' };
					// 「哪些是用户定的」**单列一行**，不逐项塞进括号里。
					// 括号里是**数量**（每项都有、彼此可比较），这一行是**来源**
					// （回答"哪些是我自己定的"时该整句念出来）——两种信息性质不同。
					// 混在一起时读者要扫完每一项的后缀才能拼出答案，也容易把某一项的
					// 后缀读成整张列表的性质。
					const body = summary.map((t) => `${t.tag}（${t.count} 首）`).join('、');
					const mine = summary.filter((t) => t.user).map((t) => t.tag).sort();
					const tail = mine.length ? `\n其中用户自己定过的：${mine.join('、')}` : '';
					return {
						ok: true,
						text: `共 ${summary.length} 个标签（${rows.length} 首歌已有标签）：\n${body}${tail}`,
					};
				}),
			toModelOutput: ({ output }) => ({ type: 'text', value: output.text }) as const,
		}),
	};
}
