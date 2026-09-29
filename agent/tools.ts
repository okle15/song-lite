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
import { FLAG_LABEL, type FlagKind } from '../contract/library-flags';
import { GROUP_BY, GROUP_BY_LABEL } from '../contract/library-groups';
import { PLAYBACK_MODE_LABEL } from '../contract/player';
import { normalizePreferenceKey, type Preference } from '../contract/preference';
import { repeatLabel } from '../contract/task';
import type { ToolFailureKind, ToolOutcome } from '../contract/tool';
import { normalizeTags } from '../contract/track-tags';

export type ToolRunContext = {
	/** 自家 BFF 的 origin，由路由从 `request.url` 取——不硬编码端口。 */
	baseUrl: string;
};

/* ── 信封与格式小工具 ─────────────────────────────────────────── */

type Envelope<T> = { code: number; data?: T; message?: string };

/** 一次 BFF 调用的结果。**失败那一支一定带 `kind`**（判据见 `contract/tool.ts`）。 */
type BffResult<T> =
	| { ok: true; data?: T; message: string }
	| { ok: false; message: string; kind: ToolFailureKind };

/**
 * 把一次失败的 HTTP 响应归类。
 *
 * 判据只用 **HTTP status**，不去读 message 的措辞 —— 按文案猜（"含'不存在'就是 404"）
 * 会在 BFF 改一次文案之后静默失效，而 status 不会。这条纪律与 `turn-log.ts` 里
 * 「按 toolCallId 配对而不是按下标」同源：**别用一个会变的信号去替代那个稳定的信号**。
 */
function classifyStatus(status: number): ToolFailureKind {
	if (status === 404) return 'not_found';
	if (status === 400 || status === 422) return 'bad_request';
	if (status === 401 || status === 403) return 'forbidden';
	if (status >= 500) return 'unavailable';
	return 'unknown';
}

/**
 * 调自家 BFF。**成功判据是 `code === 0`，不是 `res.ok`**——
 * 本项目信封的约定是成功 `code: 0`、失败时 `code` 才等于 HTTP status。
 * 按「200 即成功」写会漏掉「HTTP 200 但 code 非 0」的情形。
 *
 * 失败时除了 `message` 还给出 `kind`（B1）：三个压平了很久的失败类别终于分开，
 * 而**怎么应对仍然由模型决定**（这里一个字都不建议）。
 */
async function callBff<T>(
	ctx: ToolRunContext,
	path: string,
	init?: RequestInit,
	signal?: AbortSignal,
): Promise<BffResult<T>> {
	try {
		const res = await fetch(new URL(path, ctx.baseUrl), { ...init, signal });
		const body = (await res.json().catch(() => null)) as Envelope<T> | null;
		// ⚠️ 「拿到了响应、但回的不是我们的信封」与「压根没拿到响应」是**两种病**
		// （打到了别的服务 / 服务没起来）。原来它们与"业务失败"一起被压成同一句
		// 「请求失败」，于是模型对三种完全不同的处境给同一个反应。
		if (!body) {
			return {
				ok: false,
				kind: 'transport',
				message: `HTTP ${res.status} 且响应不是 JSON（打到的可能不是本项目）`,
			};
		}
		if (!res.ok || body.code !== 0) {
			return {
				ok: false,
				kind: classifyStatus(res.status),
				message: body.message ?? `HTTP ${res.status}`,
			};
		}
		return { ok: true, data: body.data, message: body.message ?? 'ok' };
	} catch (err) {
		return {
			ok: false,
			kind: 'transport',
			message: `请求失败：${err instanceof Error ? err.message : String(err)}`,
		};
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
	/** 命中的**总数**（不受 limit / offset 限制）。**不含被屏蔽的**。 */
	total: number;
	/** 同一个词还能命中、但已被屏蔽的条数。**必须转告模型**（见 `search_library`）。 */
	hiddenMatches?: number;
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

/**
 * 去掉一首的响应。与 `QueueData` 差一个 `missing`，**不复用**：那个字段是
 * **换一批**才有的概念（整批里有几首已经不在曲库里了），"去掉一首"不存在这个量 ——
 * 复用时它只会是 `undefined`，而读的人得靠记忆去判断"这里它到底有没有意义"。
 */
type QueueRemoveData = {
	currentTrack: { title: string; artist: string } | null;
	queueSize: number;
	/** 0 基；`-1` = 队列在但没在放（与提示词的展示约定一致）。 */
	queueIndex: number;
	queueSource: 'library' | 'custom';
	queueLabel: string | null;
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

/**
 * `/api/library/{favorites,hidden}` 的响应行。
 *
 * ⚠️ 与上面几个类型同一个纪律：**在 agent 侧重新声明**，不 import
 * `server/` 或 `contract/` 的实现。工具是 HTTP 客户端，它该认的是**响应体**。
 * （这里只取了用得上的四个字段 —— 将来 BFF 多给一个字段不该逼这里改。）
 */
type FlagRow = {
	trackId: string;
	title: string;
	artist: string;
	/** 文件已不在曲库里（改名 / 移走）。**照旧要念给用户听**，见下方 `flagListText`。 */
	missing?: boolean;
};

type FlagData = { rows?: FlagRow[]; changed?: boolean };

/* ── 歌单用的两个形状（同上：只取用得上的字段）────────────────────── */
type PlaylistSummaryData = { id: string; name: string; count: number };
type PlaylistOneData = { playlist?: PlaylistSummaryData };
type PlaylistListData = { playlists?: PlaylistSummaryData[] };

/* ── 曲库运维 + 分组用的形状（同上：只取用得上的字段）────────────────
 *
 * `inspect` 一条路由两种粒度，所以这里是**联合类型**而不是交叉类型：
 * 两个形状里 `hidden` 一个是数字（"屏蔽了几首"）、一个是布尔（"这首被屏蔽了吗"），
 * 交叉会被 TypeScript 化简成 `never`。判据靠 `'song' in d` —— 单曲那一半
 * 才有 `song`，整库那一半才有 `total`。
 */
type InspectData = LibraryReportData | TrackReportData;

/* ── 曲库运维 + 分组用的三个形状（同上：只取用得上的字段）──────────── */
type RescanData = {
	/** null = 这次之前没扫过（**不知道**，不是 0）。 */
	previousTotal: number | null;
	total: number;
	ms: number;
};
type GroupsData = { by: string; total: number; groups?: { key: string; label: string; count: number }[] };
type LibraryReportData = {
	total: number;
	hidden: number;
	artistCount: number;
	albumCount: number;
	withoutTags: number;
	unknownArtist: number;
	untaggedIds?: string[];
};
type TrackReportData = {
	song?: { title: string; artist: string; album: string };
	tags?: string[];
	tagSource?: 'ai' | 'user' | null;
	favorite?: boolean;
	hidden?: boolean;
	/** null = 读不出来（不是 0 次）。 */
	playCount?: number | null;
	lastPlayedAt?: string | null;
};

/* ── ⑩ 触发器用的三个形状 ────────────────────────────────────────
 *
 * ⚠️ 这些类型**在 agent 侧重新声明**，不 import `server/agent/tasks.ts`：
 * 依赖方向是 `app → server → contract`，`agent/` 对 `server/` 只允许 `import type`…
 * 而这里连 type 都不用 —— 工具是 HTTP 客户端，它该认的是**响应体**（什么字段、
 * 什么类型），不是服务端的内部类型。BFF 改了签名，这里只会以一个 400 暴露，
 * 而不是编译期耦合（这正是 `agent/tools.ts` 头注里选 HTTP 而不是进程内直调的理由）。
 */
type TaskRow = {
	id: string;
	goal: string;
	dueAt: string;
	repeat: 'none' | 'daily' | 'weekly';
	/** `weekly` 的"哪几天"（0=周日…6=周六）。服务端**恒给出非空**（见 tasks.ts 的 `createTask`）。 */
	repeatDays?: number[];
	status: string;
	attempts: number;
	result: string | null;
	lastError: string | null;
};

type TaskListData = { open: TaskRow[]; closed: TaskRow[] };
type TaskCreateData = { task: TaskRow };
type TaskCancelData = { id: string; cancelled: boolean };

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
 * 把一份标记清单念给模型听（`list_favorites` / `list_hidden` 共用）。
 *
 * 导出是给单测用的（与 `formatPlayTime` / `summarizeTags` 同一理由）：
 * 这里的错都是**静默**的 —— 少念一个 id，模型下一轮就拿不到它去操作，
 * 而对话照样通顺。
 *
 * 两条不能省的写法：
 *  1. **id 必须念出来**。`trackId` 是模型唯一能用来调
 *     `set_favorite` / `set_hidden` 的东西（曲名不是标识，会撞）。
 *     漏了它，清单就只是"给人看的"，模型看得见却动不了 —— 而那正是
 *     「解封出口不许减」这条红线的落点。
 *  2. **失效项要标出来**（`missing`）。收藏过一首后来改名的歌会变成一行失效
 *     标记；不标的话，模型会照着那个已经不存在的 id 去操作，然后 404。
 */
export function flagListText(rows: readonly FlagRow[], kind: FlagKind): string {
	if (rows.length === 0) {
		return kind === 'favorite' ? '还没有收藏任何曲目。' : '还没有屏蔽任何曲目。';
	}
	const head = kind === 'favorite' ? `已收藏 ${rows.length} 首` : `已屏蔽 ${rows.length} 首`;
	const lines = rows.map(
		(r, i) =>
			`${i + 1}. ${r.title}${r.artist ? ` — ${r.artist}` : ''}` +
			`${r.missing ? '（**文件已不在曲库里**，可能需要清理）' : ''}（id=${r.trackId}）`,
	);
	return `${head}：\n${lines.join('\n')}`;
}

/**
 * 把歌单清单念给模型听。**id 必须念出来** —— 它是模型下一步「往里加歌 /
 * 放这份歌单」唯一能用的东西（名字会撞，两份「跑步」完全合法）。
 *
 * `count` 也要带上：「哪份是空的」决定了模型该说「放这份」还是「先往里加点东西」。
 */
export function playlistListText(rows: readonly PlaylistSummaryData[]): string {
	if (rows.length === 0) return '还没有建过歌单。';
	const lines = rows.map(
		(p, i) => `${i + 1}. ${p.name}（${p.count} 首，id=${p.id}）`,
	);
	return `共 ${rows.length} 份歌单：\n${lines.join('\n')}`;
}

/**
 * `repeatLabel`（`每天` / `每周一三五`）移到 `contract/task.ts` 了 —— 它如今有两个
 * 读法：模型在返回值里念回去的、卡片上显示给用户看的，**必须同源**。
 * 这里只留 `WEEKDAYS`：它是 `formatAbsolute` 的（绝对时间锚，与任务无关）。
 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 把 ISO 时间译成「09-24 07:00，周四」。**只给绝对时间，不给相对说法**（与
 * `formatPlayTime` 相反）—— 排期是**将来**的事，而「明天」这种说法会随读它的
 * 那一刻改变；这里唯一的用途是让模型**核对自己算的时间对不对**，那需要一个
 * 不会动的锚。库里存的是脏值时原样返回，不编一个时间出来。
 */
export function formatAbsolute(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
		`${pad(at.getHours())}:${pad(at.getMinutes())}，${WEEKDAYS[at.getDay()]}`
	);
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
 * 「这次真的改了没有」→ 一句可以说的话。
 *
 * `changed: false` 表示**本来就是这个状态**（用户连点两次、两个入口各点一次）。
 * 那**不是失败**，但也不能说成「已收藏」—— 那是在报告一件没有发生的事，
 * 而用户下一步就会去核对（"我什么时候收藏的？"）。与之对称的另一半在
 * `set_track_tags` 里：「标签没有变化」要单独说，而不是回一句「已更新」。
 */
function changedText(
	data: FlagData | undefined,
	on: boolean,
	done: string,
	undone: string,
): string {
	const target = on ? done : undone;
	return data?.changed === false ? `本来就是这个状态（${target}），没有改动` : target;
}

/**
 * 模型看到的东西：`text`，失败时**多一个 kind 前缀**。
 *
 * 为什么用 `[kind]` 这个形状：它是一条**结构化的单点标签**（闭集里的一个词），
 * 位置固定、一眼能与正文分开。做成 JSON 对象（`{ok, kind, message}`）语义更干净，
 * 但会让成功与失败两种返回**形状不同**，而模型对"同一个工具有两种形状"的处理，
 * 不如对"一段话前面多个标签"稳。
 *
 * ⚠️ 这里**不许加解释性文字**（「建议换个说法」「可以重试」）——那是话术，
 * 正是 B1 要避免的东西（LEARNING.md §3.3：加 kind 之后只把真相交给模型）。
 *
 * ⚠️⚠️ 参数类型写成 `unknown` 而不是 `ToolOutcome`，这是**必须的**，不是省事：
 * `toModelOutput` 写成 `toModelOutput: toModel`（一个已声明、带类型的函数）会打断
 * `tool({...})` 对 `TOOLS` 的推导，TS 于是报在 `inputSchema` 上，看起来像 zod 版本
 * 问题（本文件头注第 2 条踩过同一个坑）。所以调用处保持**内联、不写注解**的箭头函数，
 * 由上下文反推出 `output` 的类型；真正的逻辑挪到这里，用 `unknown` 自己收窄。
 */
function modelText(output: unknown): { type: 'text'; value: string } {
	const o = (typeof output === 'object' && output !== null ? output : {}) as {
		ok?: unknown;
		text?: unknown;
		kind?: unknown;
	};
	const text = typeof o.text === 'string' ? o.text : '';
	const kind = typeof o.kind === 'string' ? o.kind : null;
	if (o.ok === true || !kind) return { type: 'text', value: text };
	return { type: 'text', value: `[${kind}] ${text}` };
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
		act: () => Promise<{ ok: boolean; text: string; kind?: ToolFailureKind | null }>,
	): Promise<ToolOutcome> => {
		const started = Date.now();
		try {
			return { ...(await act()), ms: Date.now() - started };
		} catch (err) {
			// 走到这里说明**工具自己的代码**炸了（不是 BFF 返回失败）——
			// 归 `unknown`（不确定，别猜）。原来它与"曲目不存在"长得一模一样，
			// 于是模型会对一个代码缺陷说「这首曲子找不到，要不要换一首」。
			return {
				ok: false,
				kind: 'unknown',
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
					if (!r.ok) return { ok: false, text: `检索失败：${r.message}`, kind: r.kind };

					const total = r.data?.total ?? 0;
					const songs = r.data?.songs ?? [];
					// 「0 命中」有**两种**，说成一种就是在编假话：库里真没有，以及
					// 都被用户自己屏蔽了。后者要说出来，否则用户问「那首 XX 呢」会得到
					// 一句「曲库里没有」——而它明明在，只是他当年亲手屏蔽的。
					const blocked = r.data?.hiddenMatches ?? 0;
					const blockedTail = blocked
						? `（另有 ${blocked} 首也被这个词命中、但已**屏蔽**，可用 list_hidden 查看或 set_hidden 解除）`
						: '';
					if (total === 0) {
						return {
							ok: true,
							text: q
								? `曲库里没有匹配「${q}」的曲目。${blockedTail}`
								: `曲库是空的。${blockedTail}`,
						};
					}
					// 翻过头了：总数不为 0 但这一页是空的。**必须单独说一句**，
					// 否则模型会拿"命中 N 首"当结论、以为后面就是没有。
					if (songs.length === 0) {
						return {
							ok: true,
							text: `共命中 ${total} 首，但 offset=${from} 已经翻过头了（只有 ${total} 首）。${blockedTail}`,
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
						text: `命中 ${total} 首，本页第 ${from + 1}–${from + songs.length} 首：\n${lines.join('\n')}${tail}${blockedTail}`,
					};
				}),
			// 只把 text 交给模型；不写这个，默认会把整个 {ok,text,ms} JSON 发过去。
			toModelOutput: ({ output }) => modelText(output),
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
					if (!r.ok) return { ok: false, text: `播放失败：${r.message}`, kind: r.kind };
					const t = r.data?.currentTrack;
					return { ok: true, text: t ? `已开始播放：${t.title} — ${t.artist}` : '已切换曲目。' };
				}),
			toModelOutput: ({ output }) => modelText(output),
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
				'`playlistId` = **放一整个歌单**（id 来自 list_playlists）。' +
				'只放**某一首具体的歌**请用 play_track，不要用本工具。',
			inputSchema: z.object({
				query: z
					.string()
					.optional()
					.describe(
						'挑选条件，如风格标签（quiet / rock）、歌手名或关键词。省略或留空表示恢复整个曲库。',
					),
				playlistId: z
					.string()
					.optional()
					.describe('放这一整份歌单（id 来自 list_playlists）。给了它就不要再给 query。'),
				limit: z.number().int().min(1).max(50).optional().describe('这批最多几首，1-50，默认 20。'),
				label: z
					.string()
					.optional()
					.describe('这批队列的名字，会显示给用户，如「安静的歌」「凤凰传奇」。省略则用 query 原文。'),
			}),
			execute: ({ query, playlistId, limit, label }, { abortSignal }) =>
				settled(async () => {
					const q = (query ?? '').trim();
					const n = limit ?? 20;

					// ── 放一整份歌单 ──
					// 为什么不新开一个 `play_playlist` 工具：「换一批队列并开播」已经是本工具的
					// 职责，歌单只是**这一批从哪来**的一种。多一个工具就多一处要同步的文案。
					if (playlistId?.trim()) {
						const found = await callBff<{ playlist?: { name: string; tracks: { trackId: string; missing?: boolean }[] } }>(
							ctx,
							`/api/playlists/items?id=${encodeURIComponent(playlistId.trim())}`,
							undefined,
							abortSignal,
						);
						if (!found.ok) return { ok: false, text: `读取歌单失败：${found.message}`, kind: found.kind };
						const p = found.data?.playlist;
						if (!p) return { ok: false, text: '没有这份歌单（id 可能旧了，用 list_playlists 重查）', kind: 'not_found' };
						// 空歌单**不能**退化成「恢复整库」——那是把一件事悄悄换成另一件。
						if (p.tracks.length === 0) {
							return { ok: false, text: `歌单「${p.name}」是空的，队列没有改动。先往里加几首再放。` };
						}
						const gone = p.tracks.filter((t) => t.missing).length;
						const r = await callBff<QueueData>(
							ctx,
							'/api/player/queue',
							{
								method: 'POST',
								headers: JSON_HEADERS,
								body: JSON.stringify({
									trackIds: p.tracks.map((t) => t.trackId),
									label: label ?? `歌单「${p.name}」`,
								}),
							},
							abortSignal,
						);
						if (!r.ok) return { ok: false, text: `放歌单失败：${r.message}`, kind: r.kind };
						const tail = gone > 0 ? `（其中 ${gone} 首已经不在曲库里，会被跳过）` : '';
						return {
							ok: true,
							text: `队列已换成歌单「${p.name}」，共 ${r.data?.queueSize ?? p.tracks.length} 首，从第一首开始放。${tail}`,
						};
					}

					// ── 恢复整库：空条件就是「没有条件」这一批（见 queue 路由的文件头）──
					if (!q) {
						const r = await callBff<QueueData>(
							ctx,
							'/api/player/queue',
							{ method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ trackIds: [] }) },
							abortSignal,
						);
						if (!r.ok) return { ok: false, text: `恢复整个曲库失败：${r.message}`, kind: r.kind };
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
					if (!found.ok) return { ok: false, text: `按「${q}」挑歌失败：${found.message}`, kind: found.kind };
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
					if (!r.ok) return { ok: false, text: `换成这一批队列失败：${r.message}`, kind: r.kind };

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
			toModelOutput: ({ output }) => modelText(output),
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
					if (!r.ok) return { ok: false, text: `切歌失败：${r.message}`, kind: r.kind };
					const t = r.data?.currentTrack;
					if (!t) return { ok: true, text: '已经是队列最后一首，播放已停止。' };
					return { ok: true, text: `已跳到下一首：${t.title} — ${t.artist}` };
				}),
			toModelOutput: ({ output }) => modelText(output),
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
					if (!r.ok) return { ok: false, text: `暂停失败：${r.message}`, kind: r.kind };
					return { ok: true, text: '已暂停。' };
				}),
			toModelOutput: ({ output }) => modelText(output),
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
					if (!r.ok) return { ok: false, text: `继续播放失败：${r.message}`, kind: r.kind };
					return { ok: true, text: '已继续播放。' };
				}),
			toModelOutput: ({ output }) => modelText(output),
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
					if (!r.ok) return { ok: false, text: `调整音量失败：${r.message}`, kind: r.kind };
					// 回读服务端的实际值（它可能夹紧过）—— 报「设成 30%」而实际是 100%
					// 是那种用户当场就能发现、而代码永远不会红的错。
					const now = Math.round((r.data?.volume ?? level / 100) * 100);
					return { ok: true, text: now === 0 ? '已静音（音量 0%）。' : `音量已设为 ${now}%。` };
				}),
			toModelOutput: ({ output }) => modelText(output),
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
					if (!r.ok) return { ok: false, text: `设置播放方式失败：${r.message}`, kind: r.kind };

					const parts: string[] = [];
					// 只复述**这次改动的**那一部分。写成 `if (r.data?.mode)` 就会在
					// 「只改随机」时把没动过的循环方式也报一遍，读起来像它被改了。
					if (mode !== undefined) parts.push(PLAYBACK_MODE_LABEL[r.data?.mode ?? mode]);
					if (shuffle !== undefined) parts.push(shuffle ? '随机播放' : '不随机');
					return { ok: true, text: `播放方式已设为：${parts.join(' + ')}。` };
				}),
			toModelOutput: ({ output }) => modelText(output),
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
					if (!r.ok) return { ok: false, text: `记住失败：${r.message}`, kind: r.kind };
					return { ok: true, text: `已记住：${value}（key=${normalized}）` };
				}),
			toModelOutput: ({ output }) => modelText(output),
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
						return { ok: false, kind: 'bad_request', text: 'key 不合法：只能用英文字母、数字、下划线。' };
					}
					const r = await callBff<{ removed: boolean }>(
						ctx,
						`/api/preferences?key=${encodeURIComponent(normalized)}`,
						{ method: 'DELETE' },
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `忘掉失败：${r.message}`, kind: r.kind };
					return {
						ok: true,
						text: r.data?.removed ? `已忘掉「${normalized}」。` : `本来就没记过「${normalized}」。`,
					};
				}),
			toModelOutput: ({ output }) => modelText(output),
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
					if (!current.ok) return { ok: false, text: `读取原有标签失败：${current.message}`, kind: current.kind };
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
					if (!wrote.ok) return { ok: false, text: `更新标签失败：${wrote.message}`, kind: wrote.kind };

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
			toModelOutput: ({ output }) => modelText(output),
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
					if (!r.ok) return { ok: false, text: `读取播放历史失败：${r.message}`, kind: r.kind };
					const plays = r.data?.plays ?? [];
					if (plays.length === 0) return { ok: true, text: '还没有播放记录。' };
					const lines = plays.map(
						(p, i) => `${i + 1}. ${p.title} — ${p.artist}（${formatPlayTime(p.startedAt)}）`,
					);
					return { ok: true, text: `最近 ${plays.length} 次播放，新的在前：\n${lines.join('\n')}` };
				}),
			toModelOutput: ({ output }) => modelText(output),
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
				'position 从 1 开始，对应系统提示词【当前状态】里队列列表的编号。' +
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
							kind: r.kind,
							text: `跳到第 ${position} 首失败：${r.message}。当前队列的长度见系统提示词的队列列表。`,
						};
					}
					const t = r.data?.currentTrack;
					return {
						ok: true,
						text: t ? `已跳到第 ${position} 首：${t.title} — ${t.artist}` : `已跳到第 ${position} 首。`,
					};
				}),
			toModelOutput: ({ output }) => modelText(output),
		}),

		/**
		 * 从队列里**去掉一首**，其余不变。
		 *
		 * 为什么这个工具必须存在（而不是让模型拿 `build_queue` 凑）：`build_queue` 的契约是
		 * **换掉整队**（它要的是"条件"，不是"这一首不要"），而模型在提示词里只看得到队列的
		 * **窗口**（`QUEUE_WINDOW = 4`，见 `agent/prompt.ts`）。于是被要求"把这首去掉"时它
		 * 只有两条路，而**两条都不报错**：
		 *  1. 用 `build_queue` 换个条件 → 把用户原来那一整批**悄悄换掉**（他要的是"去掉一首"，
		 *     看到的却是整个队列变了）；
		 *  2. 试着把剩下的 id 整份发回去重设 → 它手上根本没有整份列表，发出去的必然是残缺的。
		 * 这与「`set_track_tags` 选 add/remove 而不是整体替换」「`update_playlist` 被标成
		 * 整表替换危险点」是**同一条判据**：**内容编辑要有"就地编辑"的形状**。
		 *
		 * **按 `trackId`、不按位置**（与 `jump_in_queue` 的取舍相反，理由也正相反）：
		 * 位置是"**某一轮提示词里那一份队列**"里的编号，而队列会被别处改（点播追加 /
		 * `ensureQueue` / 本轮更早的工具调用），提示词那份随即过期 —— 按下标删最坏是
		 * **删掉另一首歌而且不报错**（用户只发现歌少了，说不出为什么）；按 id 删最坏是
		 * 删不到 → 404 → 模型看得见。**位置可以用来"跳"，跳错一首可原谅；用来"删"不可原谅。**
		 * id 从 `search_library` 拿（它的输出里带 `id=`）。
		 *
		 * **404 不算失败**（走 `ok: true`）：路由的 404 语义是"你看到的列表已经旧了"，
		 * 而不是"这次操作出错了" —— 队列一个字节都没动，与 `cancel_scheduled_task` 把
		 * "来晚了一步"报成 `cancelled:false` 是同一个处置。判据取 `kind === 'not_found'`
		 * （`classifyStatus` 只看 status），**不读文案** —— 按文案猜会在 BFF 改一次措辞之后
		 * 静默失效（同 `turn-log.ts` 按 toolCallId 配对的理由）。
		 */
		remove_from_queue: tool({
			description:
				'把一首歌从当前播放队列里去掉，队列里其余的**保持不变**。用于「这首别放了」' +
				'「把刚才那首从队列里去掉」「不想听这首了」这类只针对**一首**的要求。' +
				'trackId 必须来自 search_library（队列列表里只有曲名，没有 id），先搜一下拿到它再调。' +
				'如果去掉的正好是**正在放的那一首**，播放会接着往下走而**不是停下来** —— 返回值会告诉你现在放的是哪首。' +
				'要**换一批**（换风格、换口味）请用 build_queue，它会把整个队列换掉。',
			inputSchema: z.object({
				trackId: z.string().min(1).describe('要去掉的曲目 id，来自 search_library 返回值里的 id=…。'),
			}),
			execute: ({ trackId }, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<QueueRemoveData>(
						ctx,
						'/api/player/queue/remove',
						{
							method: 'POST',
							headers: JSON_HEADERS,
							body: JSON.stringify({ trackId }),
						},
						abortSignal,
					);
					if (!r.ok) {
						// 「队列里没有这一首」= 用户看到的那份列表旧了，不是操作失败：队列**一个字节
						// 都没动**。报 `ok:true` 是照 `cancel_scheduled_task` 的处置 —— 报成失败
						// 会推着模型去编一个补救动作，而这里什么都不用做。
						if (r.kind === 'not_found') {
							return {
								ok: true,
								text:
									`队列里没有这一首（${r.message}）。队列没有改动 —— 你看到的列表可能已经旧了，` +
									'先看【当前状态】里的队列，或重新 search_library 确认 id。',
							};
						}
						return { ok: false, text: `从队列里去掉失败：${r.message}`, kind: r.kind };
					}
					const size = r.data?.queueSize ?? 0;
					const cur = r.data?.currentTrack;
					const idx = r.data?.queueIndex ?? -1;
					// 去掉正在放的那首时播放**不会停**，而是从同一位置接着往下走 —— 这句要说，
					// 否则用户以为音乐断了（它只是换了一首，而且是他自己要求的）。
					const now = cur
						? `，当前正放第 ${idx + 1} 首：${cur.title} — ${cur.artist}`
						: size === 0
							? '，队列空了，播放已停止'
							: '';
					// 从**整库**队列里去掉一首，服务端会把这批就地提升为固定的一批
					// （内容编辑 = 身份编辑，见 `server/player/state.ts` 的 `removeFromQueue`）。
					// 这是用户能感知的产品事实（它从此不再跟着曲库变），瞒着的话他下次发现
					// "新加的歌不进队列了"会毫无线索。
					//
					// ⚠️ 说成**状态**、不说成一次转变：`removeFromQueue` 对 `library` 是无条件提升的，
					// 所以去掉之后来源**总是** `custom` —— 响应里分不出"本来就是这个身份"与
					// "刚刚被提升"。要分就得加一个只被这一处读的响应字段，不划算；
					// 而"这一批是固定的一批"在两种情形下**都成立**，说状态就没有假话。
					const fixed =
						r.data?.queueSource === 'custom'
							? `\n（这一批是固定的一批，不再跟着曲库变${r.data.queueLabel ? `；当初是按「${r.data.queueLabel}」挑的` : ''}）`
							: '';
					return {
						ok: true,
						text: `已从队列里去掉一首（id=${trackId}）。队列现在 ${size} 首${now}。${fixed}`,
					};
				}),
			toModelOutput: ({ output }) => modelText(output),
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
					if (!r.ok) return { ok: false, text: `读取标签失败：${r.message}`, kind: r.kind };
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
			toModelOutput: ({ output }) => modelText(output),
		}),

		/* ── 收藏与屏蔽（2026-09-28）────────────────────────────────────
		 *
		 * 四个工具的形状完全对称：**收藏 / 看收藏 / 屏蔽 / 看屏蔽**。
		 *
		 * 在这之前，「收藏」只活在前端 localStorage 里 —— 服务端与 agent
		 * 完全看不见它（既答不了「我收藏了哪些」，也没法说「帮你收起来了」）。
		 * 判据是项目里那条分流规则：**收藏与屏蔽是「人的偏好」，不是「设备的事实」**
		 * （音量 / 播放方式才是设备的事实）。人的偏好不进服务端，agent 就永远是瞎的。
		 *
		 * ⚠️ **屏蔽为什么必须有 `list_hidden` 这个配对工具**（红线③「解封出口不许减」）：
		 * `search_library` 会过滤掉被屏蔽的歌，于是它**再也不是「拿到 trackId 的那条路」**
		 * —— 那正是 `set_hidden` 唯一需要的东西。没有 `list_hidden`，模型会把歌屏蔽掉
		 * 然后**永远没法解除**：它嘴上说着「要解除的话告诉我」，手上却没有任何办法
		 * 拿到那首歌的 id。这就是「读过滤与写保护必须成对」在工具层的正面形态：
		 * **过滤掉一个读出口，就必须补上另一个读出口。**
		 *
		 * ⚠️ **屏蔽刻意不加确认闸门**（与 `set_track_tags` 的 remove 不同）：
		 * §2.8 的三条判据里它只满足两条 —— 一旦执行确实「看不出往回走」，
		 * 但它**完全可逆**（`set_hidden:false`），而且**用户看得见**
		 * （那首歌从曲库列表里消失了）。第三条判据「撤掉之后用户不知道曾有这么
		 * 一件事」不成立，所以不该拦。加闸门的代价是真实的：被拦烦了的用户
		 * 见框就点，闸门本身会失效。
		 */
		set_favorite: tool({
			description:
				'收藏 / 取消收藏一首歌。用户说「这首不错，收藏一下」「帮我存起来」「这首我挺喜欢」→ favorite=true；' +
				'「取消收藏」「不喜欢了」→ favorite=false。收藏是**用户的长期偏好**，会一直保留。' +
				'需要先用 search_library 拿到 trackId；如果是**当前正在放的那首**，也可以直接说它的名字。',
			inputSchema: z.object({
				trackId: z.string().min(1).describe('曲目 id，来自 search_library 返回值里的 id=…。'),
				favorite: z.boolean().describe('true = 收藏，false = 取消收藏。'),
			}),
			execute: ({ trackId, favorite }, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<FlagData>(
						ctx,
						'/api/library/favorites',
						{
							method: 'POST',
							headers: JSON_HEADERS,
							body: JSON.stringify({ trackId, favorite }),
						},
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `${FLAG_LABEL.favorite.verb}失败：${r.message}`, kind: r.kind };
					// `changed: false` = 本来就是这个状态（用户连点、或两个入口各点一次）。
					// **不是失败**，但也不能说成「已收藏」——那样是在报告一件没发生的事。
					const state = changedText(r.data, favorite, FLAG_LABEL.favorite.done, FLAG_LABEL.favorite.undone);
					return { ok: true, text: `${state}。当前共收藏 ${r.data?.rows?.length ?? 0} 首。` };
				}),
			toModelOutput: ({ output }) => modelText(output),
		}),

		list_favorites: tool({
			description:
				'列出用户收藏过的所有曲目（含 id，可用于播放或取消收藏）。' +
				'用于「我收藏了哪些歌」「放一首我收藏的」这类请求。要**找歌**请用 search_library。',
			inputSchema: z.object({}),
			execute: (_args, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<FlagData>(ctx, '/api/library/favorites', undefined, abortSignal);
					if (!r.ok) return { ok: false, text: `读取收藏失败：${r.message}`, kind: r.kind };
					return { ok: true, text: flagListText(r.data?.rows ?? [], 'favorite') };
				}),
			toModelOutput: ({ output }) => modelText(output),
		}),

		set_hidden: tool({
			description:
				'屏蔽 / 解除屏蔽一首歌。屏蔽 = 「以后别再自动给我放这首」：它会从曲库列表、检索结果和' +
				'「整个曲库」队列里消失（文件本身还在，随时可以解除）。' +
				'用户说「这首以后别放了」「再也不想听到这首」→ hidden=true；' +
				'「把那首放回来」「解除屏蔽」→ hidden=false。' +
				'**解除屏蔽前必须先用 list_hidden 拿到 id** —— search_library 已经搜不到被屏蔽的歌了。' +
				'要**从当前队列里**去掉一首（只是这一批里不想听，不是永远不想听）请用 remove_from_queue。',
			inputSchema: z.object({
				trackId: z.string().min(1).describe('曲目 id。屏蔽时来自 search_library；解除时来自 list_hidden。'),
				hidden: z.boolean().describe('true = 屏蔽，false = 解除屏蔽。'),
			}),
			execute: ({ trackId, hidden }, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<FlagData>(
						ctx,
						'/api/library/hidden',
						{
							method: 'POST',
							headers: JSON_HEADERS,
							body: JSON.stringify({ trackId, hidden }),
						},
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `${FLAG_LABEL.hidden.verb}失败：${r.message}`, kind: r.kind };
					const state = changedText(r.data, hidden, FLAG_LABEL.hidden.done, FLAG_LABEL.hidden.undone);
					// 屏蔽生效的**时机**必须说清：用户以为"这首立刻从队列里没了"，
					// 而实际上队列要到下一次点播才按新的可见曲库重排（见 hidden 路由文件头）。
					// 不说的话，他会说「我不是让你别放这首了吗」——而它其实已经在队列里了。
					const when = hidden
						? '（当前队列不受影响；下一次点播时整库队列会按新的可见曲库重排，它就不在里面了）'
						: '';
					return {
						ok: true,
						text: `${state}。当前共屏蔽 ${r.data?.rows?.length ?? 0} 首${when}`,
					};
				}),
			toModelOutput: ({ output }) => modelText(output),
		}),

		list_hidden: tool({
			description:
				'列出被屏蔽的曲目（含 id）。**这是解除屏蔽的唯一入口** —— 被屏蔽的歌在 search_library 里搜不到，' +
				'所以「把那首放回来」必须先调本工具拿 id，再调 set_hidden 传 hidden=false。' +
				'用户问「我屏蔽过哪些」也用它。',
			inputSchema: z.object({}),
			execute: (_args, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<FlagData>(ctx, '/api/library/hidden', undefined, abortSignal);
					if (!r.ok) return { ok: false, text: `读取屏蔽清单失败：${r.message}`, kind: r.kind };
					return { ok: true, text: flagListText(r.data?.rows ?? [], 'hidden') };
				}),
			toModelOutput: ({ output }) => modelText(output),
		}),

		/* ── 歌单（2026-09-28 加）────────────────────────────────────────
	 *
	 * 四个工具的形状是「建 / 看 / 加 / 减」。**刻意没有「改整份」的那个**：
	 * 模型只看得到清单的一页，给它一个"写回这一批"的入口，它会把自己看得见的
	 * 那部分当成全部 —— 用户的歌单被悄悄换走，而两次都不报错（§2.4）。
	 * 所以加是追加、减是**按 id 删那一项**（不收下标：下标是某一份视图里的位置，
	 * 视图一变就指到另一首歌）。
	 *
	 * 「放这份歌单」不在这里 —— 它走 `build_queue` 的 `playlistId`：
	 * 换一批队列本来就是它的职责，没必要为「从哪来」再发明一个工具。
	 */
	create_playlist: tool({
		description:
			'新建一个歌单。用户说「建一个跑步歌单」「存一份睡前听的」「把这批收起来」→ 用本工具。' +
			'`trackIds` 可选：**给了就是一次导入一批**（来源可以是 search_library 的结果、' +
			'list_favorites 的收藏、或当前队列）。先建空歌单、之后再往里加也可以。',
		inputSchema: z.object({
			name: z.string().min(1).describe('歌单名，如「跑步」「睡前」。'),
			trackIds: z
				.array(z.string().min(1))
				.optional()
				.describe('可选：一次导入的曲目 id 列表。省略则建一个空歌单。'),
		}),
		execute: ({ name, trackIds }, { abortSignal }) =>
			settled(async () => {
				const r = await callBff<PlaylistOneData>(
					ctx,
					'/api/playlists',
					{
						method: 'POST',
						headers: JSON_HEADERS,
						body: JSON.stringify(trackIds?.length ? { name, trackIds } : { name }),
					},
					abortSignal,
				);
				if (!r.ok) return { ok: false, text: `建歌单失败：${r.message}`, kind: r.kind };
				const p = r.data?.playlist;
				if (!p) return { ok: false, text: '服务端没有回歌单（歌单可能没建成）', kind: 'unknown' };
				// id 必须念出来：它是模型下一步往里加歌 / 删歌唯一能用的东西。
				const withItems = p.count > 0 ? `，已导入 ${p.count} 首` : '（空的）';
				return { ok: true, text: `已建歌单「${p.name}」${withItems}（id=${p.id}）` };
			}),
		toModelOutput: ({ output }) => modelText(output),
	}),

	list_playlists: tool({
		description:
			'列出用户建过的全部歌单（含 id 与每份有几首）。' +
			'用于「我有哪些歌单」「放我的跑步歌单」（拿到 id 后交给 build_queue 的 playlistId）。' +
			'要**看某一份里有什么歌**请用 list_playlist_tracks。',
		inputSchema: z.object({}),
		execute: (_args, { abortSignal }) =>
			settled(async () => {
				const r = await callBff<PlaylistListData>(ctx, '/api/playlists', undefined, abortSignal);
				if (!r.ok) return { ok: false, text: `读取歌单失败：${r.message}`, kind: r.kind };
				return { ok: true, text: playlistListText(r.data?.playlists ?? []) };
			}),
		toModelOutput: ({ output }) => modelText(output),
	}),

	add_to_playlist: tool({
		description:
			'往歌单里**加**歌（追加，不会动里面已有的那些）。' +
			'用户说「把这首加到跑步歌单」「这几首都收进去」→ 用本工具。' +
			'已经在这份里的会跳过（那不是失败）。要从歌单里**去掉**一首请用 remove_from_playlist。',
		inputSchema: z.object({
			playlistId: z.string().min(1).describe('歌单 id，来自 list_playlists（不是歌单名）。'),
			trackIds: z.array(z.string().min(1)).min(1).describe('要加入的曲目 id 列表，可多首。'),
		}),
		execute: ({ playlistId, trackIds }, { abortSignal }) =>
			settled(async () => {
				const r = await callBff<PlaylistOneData & { added: number; skipped: number }>(
					ctx,
					'/api/playlists/items',
					{
						method: 'POST',
						headers: JSON_HEADERS,
						body: JSON.stringify({ id: playlistId, trackIds }),
					},
					abortSignal,
				);
				if (!r.ok) return { ok: false, text: `加入歌单失败：${r.message}`, kind: r.kind };
				const p = r.data?.playlist;
				if (!p) return { ok: false, text: '服务端没有回歌单', kind: 'unknown' };
				const added = r.data?.added ?? 0;
				const skipped = r.data?.skipped ?? 0;
				const tail = skipped > 0 ? `；有 ${skipped} 首本来就在里面，没有重复加` : '';
				return {
					ok: true,
					text:
						added === 0
							? `这几首本来就在「${p.name}」里，没有改动（现在共 ${p.count} 首）${tail}`
							: `已往「${p.name}」加了 ${added} 首，现在共 ${p.count} 首${tail}`,
				};
			}),
		toModelOutput: ({ output }) => modelText(output),
	}),

	remove_from_playlist: tool({
		description:
			'从歌单里**去掉一首**。用户说「把这首从跑步歌单里删了」「那首别放在里面」→ 用本工具。' +
			'⚠️ 传 **trackId**（曲目 id），不是第几首 —— 位置会随排序变化，按位置删会删错歌。' +
			'不知道 id 就先用 list_playlists 找到歌单，再看清单里的 id。',
		inputSchema: z.object({
			playlistId: z.string().min(1).describe('歌单 id，来自 list_playlists。'),
			trackId: z.string().min(1).describe('要去掉的那首的曲目 id。**不是位置**。'),
		}),
		execute: ({ playlistId, trackId }, { abortSignal }) =>
			settled(async () => {
				const r = await callBff<PlaylistOneData & { removed: boolean }>(
					ctx,
					`/api/playlists/items?id=${encodeURIComponent(playlistId)}&trackId=${encodeURIComponent(trackId)}`,
					{ method: 'DELETE' },
					abortSignal,
				);
				if (!r.ok) return { ok: false, text: `从歌单里去掉失败：${r.message}`, kind: r.kind };
				const p = r.data?.playlist;
				if (r.data?.removed === false) {
					// 不是失败，但也不能说成「已删除」—— 那是在报告一件没发生的事。
					return {
						ok: true,
						text: `「${p?.name ?? '这份歌单'}」里本来就没有这首，没有改动（现在共 ${p?.count ?? 0} 首）。`,
					};
				}
				return { ok: true, text: `已从「${p?.name ?? '歌单'}」去掉这一首，现在共 ${p?.count ?? 0} 首。` };
			}),
		toModelOutput: ({ output }) => modelText(output),
	}),

	/* ── 曲库运维 + 分组视图（2026-09-28 加）────────────────────────────
	 *
	 * 三件，每一件对应一个此前**答不上来**的问题：
	 *
	 *   ① `rescan_library` —— 「我往目录里加了新歌」。扫描结果在进程内存活期内
	 *      memo 一次，所以新文件在重启之前**不可见**，而没有任何地方告诉用户。
	 *   ② `list_library_groups` —— 「我库里都有谁 / 哪些专辑 / 哪些风格」。
	 *      与 `list_tags` 同形态（词表类工具），没有它模型只能猜名字。
	 *      分桶**在服务端**：前端只有一页，拿一页分桶会把「本页」说成「全部」。
	 *   ③ `inspect_library` —— 「这首什么状况 / 我的库缺什么」。
	 *      单曲那一半把「标签 + 收藏 + 屏蔽 + 播过几次」合成一次调用；
	 *      整库那一半给出 `untaggedIds`（**打标脚本的真实输入**）。
	 *
	 * ⚠️ 清单里的 `organize` 落地成了**只读体检**，不是「把文件挪进子目录」：
	 * `Song.id` 是相对路径，改名 / 移动 = 新 id = `plays` 与 `track_tags` 全失联
	 * （改「唯一标识」= 数据迁移），而本机无回收站、删了就真没了。
	 * 它说清「库里缺什么」，动哪一处由人决定。
	 */
	rescan_library: tool({
		description:
			'**重新扫描曲库**。用户往音乐目录里加了（或删了、改名了）音频文件之后，' +
			'说「我加了新歌」「扫一下曲库」「怎么没看到我新下的那首」→ 用本工具。' +
			'不调它的话，新文件要等服务端重启才可见。',
		inputSchema: z.object({}),
		execute: (_args, { abortSignal }) =>
			settled(async () => {
				const r = await callBff<RescanData>(
					ctx,
					'/api/library/rescan',
					{ method: 'POST' },
					abortSignal,
				);
				if (!r.ok) return { ok: false, text: `重扫曲库失败：${r.message}`, kind: r.kind };
				const d = r.data;
				if (!d) return { ok: false, text: '服务端没有回扫描结果', kind: 'unknown' };
				// ⚠️ `previousTotal` 为 null = 这次之前没扫过（**不知道**，不是 0）。
				// 这时只说现在有几首 —— 说「新增了 N 首」是在编一个数字。
				const delta =
					d.previousTotal === null
						? ''
						: d.total === d.previousTotal
							? `（和上次一样，还是 ${d.total} 首）`
							: `（上次 ${d.previousTotal} 首 → 现在 ${d.total} 首）`;
				return { ok: true, text: `已重扫曲库，现在共 ${d.total} 首${delta}。` };
			}),
		toModelOutput: ({ output }) => modelText(output),
	}),

	list_library_groups: tool({
		description:
			'按**歌手 / 专辑 / 风格**列出曲库的分组，以及每个组里有几首歌。' +
			'用于「我库里都有谁的歌」「都有哪几张专辑」「能按什么风格挑」这类问题 —— ' +
			'**在按歌手或风格挑歌之前先看一眼这里**，别凭印象猜名字。' +
			'想直接放某个歌手的歌请用 build_queue（它会自己搜）。',
		inputSchema: z.object({
			// ⚠️ **直接拿 `GROUP_BY` 当枚举**，不另抄一份 `['artist','album','tag']`：
			// 抄一份的话两处会漂移（加维度时只改一处 → 工具收不到新维度、或路由
			// 拒掉工具认的值），而那种漂移**不报错**（§2.6「跨层清单必须双向相等」）。
			// 描述里**不写引号括起来的那三个值**：架构守卫靠"一行里同时出现三个
			// 带引号的维度名"来抓"抄了一份清单"，写进来会把自己送进去。
			by: z.enum(GROUP_BY).describe('分组维度：artist 歌手 / album 专辑 / tag 风格标签。'),
		}),
		execute: ({ by }, { abortSignal }) =>
			settled(async () => {
				const r = await callBff<GroupsData>(
					ctx,
					`/api/library/groups?by=${encodeURIComponent(by)}`,
					undefined,
					abortSignal,
				);
				if (!r.ok) return { ok: false, text: `读取分组失败：${r.message}`, kind: r.kind };
				const groups = r.data?.groups ?? [];
				if (groups.length === 0) {
					return { ok: true, text: `曲库里还没有可分组的曲目（共 ${r.data?.total ?? 0} 首）。` };
				}
				const body = groups.map((g) => `${g.label}（${g.count} 首）`).join('、');
				// ⚠️ tag 维度下各组之和会**大于** total（一首多标签进多组）。
				// 这句话必须说，否则模型会拿各组相加去"校验" total，然后报一个不存在的矛盾。
				const note =
					by === 'tag' && groups.length > 1
						? '\n（一首歌可以有多个标签，所以上面的首数相加会多于总曲目数）'
						: '';
				return {
					ok: true,
					text: `按${GROUP_BY_LABEL[by]}分 ${groups.length} 组（共 ${r.data?.total ?? 0} 首）：\n${body}${note}`,
				};
			}),
		toModelOutput: ({ output }) => modelText(output),
	}),

	inspect_library: tool({
		description:
			'**曲库体检**：给了 trackId 就报这一首的状况（有什么标签、标签是谁定的、' +
			'是不是收藏 / 屏蔽了、播过几次），不给就报整个库的状况（几首、几首还没打标、' +
			'有几个歌手、有几首读不出歌手）。' +
			'用于「这首我听过吗」「这首是什么风格来着」「我的库里还有哪几首没打标」。' +
			'⚠️ 只报**事实**，不整理也不修改任何文件。',
		inputSchema: z.object({
			trackId: z
				.string()
				.min(1)
				.optional()
				.describe('可选：曲目 id（来自 search_library）。省略 = 报整个曲库的状况。'),
		}),
		execute: ({ trackId }, { abortSignal }) =>
			settled(async () => {
				const path = trackId
					? `/api/library/inspect?trackId=${encodeURIComponent(trackId)}`
					: '/api/library/inspect';
				const r = await callBff<InspectData>(ctx, path, undefined, abortSignal);
				if (!r.ok) return { ok: false, text: `读取曲库信息失败：${r.message}`, kind: r.kind };
				const d = r.data;
				if (!d) return { ok: false, text: '服务端没有回曲库信息', kind: 'unknown' };

				if ('song' in d && d.song) {
					const s = d.song;
					const tags = d.tags?.length ? d.tags.join('、') : '（还没打标签）';
					const source = d.tagSource === 'user' ? '这组标签是用户自己定的' : d.tagSource === 'ai' ? '这组标签是 AI 打的' : '';
					const flags = [d.favorite ? '已收藏' : '', d.hidden ? '已屏蔽' : ''].filter(Boolean);
					// ⚠️ `playCount` 为 null = 读不出来，**不是** 0 次。说成"没听过"是在编。
					const plays =
						d.playCount === null
							? '播放次数读不出来'
							: d.playCount === 0
								? '还没播过'
								: `播过 ${d.playCount} 次${d.lastPlayedAt ? `，最近一次 ${d.lastPlayedAt.slice(0, 10)}` : ''}`;
					return {
						ok: true,
						text:
							`《${s.title}》— ${s.artist}（专辑：${s.album}）\n` +
							`标签：${tags}${source ? `（${source}）` : ''}\n` +
							`${plays}${flags.length ? `\n${flags.join(' · ')}` : ''}`,
					};
				}

				if (!('total' in d)) return { ok: false, text: '服务端回了不认识的体检结果', kind: 'unknown' };
				const untagged =
					d.withoutTags === 0
						? '全部都有标签'
						: `还有 ${d.withoutTags} 首没打标：${(d.untaggedIds ?? []).join(' / ')}`;
				return {
					ok: true,
					text:
						`曲库共 ${d.total} 首${d.hidden ? `（另有 ${d.hidden} 首被屏蔽）` : ''}，` +
						`${d.artistCount} 位歌手 / ${d.albumCount} 张专辑。\n${untagged}` +
						(d.unknownArtist ? `\n有 ${d.unknownArtist} 首读不出歌手信息。` : ''),
				};
			}),
		toModelOutput: ({ output }) => modelText(output),
	}),

	/* ── ⑩ 触发器（2026-09-23 加）──────────────────────────────────
		 *
		 * 三个工具的形状完全对称：**排 / 看 / 撤**。加它们不是"多了三个功能"，
		 * 而是补齐了 BLUEPRINT §2 里唯一空着的那个部件 —— 在这之前 agent
		 * 只可能被"用户这一秒说了句话"唤醒。
		 *
		 * ⚠️ 一件要在文档里说清、否则会被误读的事：**它不是"定时器功能"**。
		 * `LEARNING.md §3.1` 的判断是"接定时器只是加一层，真正要设计的是**任务**
		 * 这个概念"（跨轮的目标：这次推到哪儿了、下次该不该继续）。所以这里能看到
		 * 的是任务的三件事，看不到任何 cron 表达式 —— 定时器属于**部署环境**
		 * （见 `server/agent/tasks.ts` 的文件头：为什么刻意不做常驻定时器）。
		 */
		schedule_task: tool({
			description:
				'把一件事**排在将来某个时间**做，到点后你会被自动唤醒去做它（不需要用户在那一刻说话）。' +
				'用于「明天早上七点叫我起床时放首歌」「十分钟后暂停」「每天早上放点新闻」「每周一早上放首歌」这类**明确说了时间**的要求。' +
				'dueAt 必须是 ISO 8601 时间（如 2026-09-24T07:00:00+08:00）——' +
				'请按系统提示词【现在】那一行自己算出绝对时间，不要传「明天早上」这种说法。' +
				'user 只说了「过一会儿」而没有具体时间时，先问清具体时刻再排。' +
				'用户要的是**现在**就做，就不要用本工具，直接做。',
			inputSchema: z.object({
				goal: z
					.string()
					.min(1)
					.describe(
						'到点后要做什么，写清是哪件事、对谁做。写成你能独立看懂的一句（到点时你只看到这句话）。',
					),
				dueAt: z
					.string()
					.min(1)
					.describe('什么时候做，ISO 8601 格式，如 2026-09-24T07:00:00+08:00。'),
				repeat: z
					.enum(['none', 'daily', 'weekly'])
					.optional()
					.describe(
						'重复方式。默认 none（只做一次）；「每天」用 daily；「每周几」用 weekly。' +
							'weekly 且不传 repeatDays 就是"每周同一天"——那一天由 dueAt 落在星期几决定。',
					),
				repeatDays: z
					.array(z.number().int().min(0).max(6))
					.optional()
					.describe(
						'只在 repeat=weekly 且要指定**多天**时传（「每周一三五」→ [1,3,5]）。' +
							'0=周日，1=周一…6=周六；只重复一天时不必传（dueAt 已经说了是哪天）。',
					),
			}),
			execute: ({ goal, dueAt, repeat, repeatDays }, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<TaskCreateData>(
						ctx,
						'/api/tasks',
						{
							method: 'POST',
							headers: JSON_HEADERS,
							body: JSON.stringify({ goal, dueAt, repeat: repeat ?? 'none', repeatDays }),
						},
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `排期失败：${r.message}`, kind: r.kind };
					const t = r.data?.task;
					if (!t) return { ok: false, text: '排期失败：服务端没有返回任务。', kind: 'unknown' };
					// 把算出来的时间与"做一次 / 每天 / 每周几"**念回去**：`dueAt` 是模型自己
					// 推的，念回去它才能发现自己算错了时区或频率（而它算错时没人会报错）。
					const when = formatAbsolute(t.dueAt);
					const every = repeatLabel(t.repeat, t.repeatDays);
					return {
						ok: true,
						text:
							`已排期（id=${t.id}）：${when}${every ? `，${every}重复` : ''}\n` +
							`要做的事：${t.goal}`,
					};
				}),
			toModelOutput: ({ output }) => modelText(output),
		}),

		list_scheduled_tasks: tool({
			description:
				'查看已排期的任务：还没做的（含到点但还没跑到的）在前，另附最近做完的几条。' +
				'用于「我让你做过什么」「明天早上那件事排上了吗」这类问题，' +
				'也用于**改主意之前先确认要撤销的是哪一条**（拿它的 id）。' +
				'要撤销请用 cancel_scheduled_task。',
			inputSchema: z.object({}),
			execute: (_args, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<TaskListData>(ctx, '/api/tasks', undefined, abortSignal);
					if (!r.ok) return { ok: false, text: `读取任务失败：${r.message}`, kind: r.kind };
					const open = r.data?.open ?? [];
					const closed = r.data?.closed ?? [];
					if (open.length === 0 && closed.length === 0) {
						return { ok: true, text: '还没有排过任何任务。' };
					}
					const rows: string[] = [];
					if (open.length > 0) {
						rows.push('待执行（按该做的时间）：');
						for (const t of open) {
							const when = formatAbsolute(t.dueAt);
							const state = t.status === 'running' ? '（正在做）' : '';
							// 频率要标出来：清单里"每周一放歌"与"就这一次"长得一样时，
							// 用户说「把每周那件撤了」模型就只能猜 —— 而猜错撤掉的是另一件。
							const every = repeatLabel(t.repeat, t.repeatDays);
							rows.push(`· ${when}${state}${every ? `（${every}）` : ''}｜${t.goal}｜id=${t.id}`);
						}
					}
					if (closed.length > 0) {
						rows.push('最近做过的：');
						for (const t of closed) {
							const done = t.status === 'done' ? '已完成' : t.status === 'cancelled' ? '已取消' : '失败';
							rows.push(`· ${done}｜${t.goal}｜${(t.result ?? t.lastError ?? '').slice(0, 60)}`);
						}
					}
					return { ok: true, text: rows.join('\n') };
				}),
			toModelOutput: ({ output }) => modelText(output),
		}),

		cancel_scheduled_task: tool({
			description:
				'撤销一件**还没做完**的排期任务。用于「别放了我睡了」「把早上那件事取消」。' +
				'id 必须来自 list_scheduled_tasks 的返回值，不要自己编。' +
				'已经做完的任务撤不掉（返回值会告诉你 cancelled=false）——那是来晚了一步，不是出错。',
			inputSchema: z.object({
				id: z.string().min(1).describe('要撤销的任务 id，来自 list_scheduled_tasks。'),
			}),
			execute: ({ id }, { abortSignal }) =>
				settled(async () => {
					const r = await callBff<TaskCancelData>(
						ctx,
						'/api/tasks',
						{ method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ id }) },
						abortSignal,
					);
					if (!r.ok) return { ok: false, text: `撤销失败：${r.message}`, kind: r.kind };
					if (!r.data?.cancelled) {
						return {
							ok: true,
							text: '这件事不在「还没做」的状态里（可能已经做过了，或 id 不对）——没有改动任何东西。',
						};
					}
					return { ok: true, text: `已撤销排期 ${id}。` };
				}),
			toModelOutput: ({ output }) => modelText(output),
		}),
	};
}
