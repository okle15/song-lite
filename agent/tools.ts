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
import { normalizePreferenceKey, type Preference } from '../contract/preference';
import type { ToolOutcome } from '../contract/tool';

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
	total: number;
	songs: { id: string; title: string; artist: string; album: string; durationSec: number }[];
};

type PlayData = { state: string; currentTrack: { title: string; artist: string } | null };

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
				'在本地曲库里按关键词检索曲目，返回曲名、歌手、时长和 trackId。' +
				'关键词会匹配曲名 / 歌手 / 专辑。查询词留空则返回整库（用于「有哪些歌」这类问题）。' +
				'想播放任何歌曲前，必须先用本工具拿到 trackId。',
			inputSchema: z.object({
				query: z.string().describe('检索关键词，如歌手名或曲名片段。留空表示列出整库。'),
				limit: z.number().int().min(1).max(20).optional().describe('最多返回几条，1-20，默认 10。'),
			}),
			execute: ({ query, limit }, { abortSignal }) =>
				settled(async () => {
					const q = query.trim();
					const n = limit ?? 10;
					const r = await callBff<SearchData>(
						ctx,
						`/api/library/search?q=${encodeURIComponent(q)}&limit=${n}`,
						undefined,
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `检索失败：${r.message}` };

					const total = r.data?.total ?? 0;
					const songs = r.data?.songs ?? [];
					if (total === 0) {
						return { ok: true, text: q ? `曲库里没有匹配「${q}」的曲目。` : '曲库是空的。' };
					}
					const lines = songs.map(
						(s, i) => `${i + 1}. ${s.title} — ${s.artist}（${mmss(s.durationSec)}，id=${s.id}）`,
					);
					return {
						ok: true,
						text: `命中 ${total} 首，列出前 ${songs.length} 首：\n${lines.join('\n')}`,
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
					.describe('曲目 id，形如 track-3。必须来自 search_library 的返回值，不要自己编。'),
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
	};
}
