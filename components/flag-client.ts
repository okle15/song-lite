/**
 * flag-client — **收藏 / 屏蔽 在前端的唯一写入口**。
 *
 * ── 为什么要有这个文件（而不是在各组件里各写一次 fetch）──────────────
 * 收藏与屏蔽各有**三个**前端入口（播放条 ❤、全屏歌词 ❤、曲库抽屉的卡片按钮与
 * 「收藏 / 已屏蔽」两个视图）。每个入口都自己拼一次 `fetch` 的后果不是重复代码，
 * 而是**失败处理会各写一份**：有的看 `res.ok`、有的只 `catch`，于是「点了没反应」
 * 在三个地方有三种表现，而哪一个都不报错。这里把它们收成两个函数。
 *
 * ── 为什么写入之后**不回本地状态** ────────────────────────────────────
 * 收藏与屏蔽是**人的偏好**，真相在服务端（`favorites` / `hidden` 表），
 * 按下述判据（见 `contract/library-flags.ts` 文件头）：
 *
 *     音量 / 播放方式 = 设备的事实 → 本机是真相，服务端只配镜像；
 *     收藏 / 屏蔽     = 人的偏好   → 服务端是真相，本机一份都不留。
 *
 * 所以这两个函数**只发请求、不返回「新的收藏集合」给调用方拿着**：界面该显示什么
 * 一律从快照（`PlayerSnapshot.favoriteIds` / `hiddenIds`）算 —— 快照由写路由触发的
 * SSE 推下来（见 `server/player/state.ts` 的 `publishSnapshot`）。于是 agent 收藏
 * 一首歌之后，三个入口**同时**变，不需要「刷新一下就准了」这种解释。
 * 反过来：谁都不许在本机留一份「我以为我收藏了什么」，那是最容易静默漂移的东西。
 *
 * ── 失败怎么办（有意不留 notice 的地方）────────────────────────────
 * 两个函数都**抛错**，由调用方决定说不说一句。曲库抽屉有 `notice` 条，就说；
 * 播放条那颗 ❤ 没有地方放字，就不说 —— **它不变色本身就是那句话**，而再点一次
 * 就是重试。⚠️ 不能因此改成"先变色、失败再变回去"：那是在报告一件没发生的事，
 * 与 `set_track_tags` 里「标签没有变化要单独说」是同一条判据。
 */
import { FLAG_LABEL, type FlagKind, type FlagRow } from '@/contract/library-flags';
import { LS_KEYS } from './storage-keys';

/** 两类标记各自的路由。**加第三种标记时改这一处**（与服务端 `TABLES` 对表）。 */
const PATH: Record<FlagKind, string> = {
	favorite: '/api/library/favorites',
	hidden: '/api/library/hidden',
};

/**
 * 一次写入的结果。`changed` 是服务端说的「这次真的改了没有」——
 * **不是失败**（本来就是这个状态时为 false，用户连点两次就会遇到）。
 */
export type FlagWrite = { rows: FlagRow[]; changed: boolean };

/**
 * 失败时抛的这个错。**带上 status 是必须的**：`failureNote` 靠它区分
 * 「网络没通（值得重试）」与「服务端拒绝了（再点一次还是一样）」——
 * 症状一样、修法相反（见 `./failure-note.ts`）。只抛一句 `HTTP 500`
 * 就把这两种处境合成了一句。
 */
export class FlagError extends Error {
	constructor(
		message: string,
		readonly status: number | null,
	) {
		super(message);
		this.name = 'FlagError';
	}
}

/** 读一份清单（含曲名；文件已不在曲库的那几首也会列出来，带 `missing`）。 */
export async function fetchFlagRows(kind: FlagKind): Promise<FlagRow[]> {
	let res: Response;
	try {
		res = await fetch(PATH[kind]);
	} catch (err) {
		throw new FlagError(String(err), null);
	}
	if (!res.ok) throw new FlagError(`HTTP ${res.status}`, res.status);
	const json = (await res.json()) as { data?: { rows?: FlagRow[] } };
	return json.data?.rows ?? [];
}

/** 打上 / 摘掉一个标记。返回服务端回的**整份清单**（不是只回改的那一条）。 */
export async function postFlag(kind: FlagKind, trackId: string, on: boolean): Promise<FlagWrite> {
	let res: Response;
	try {
		res = await fetch(PATH[kind], {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(kind === 'favorite' ? { trackId, favorite: on } : { trackId, hidden: on }),
		});
	} catch (err) {
		throw new FlagError(String(err), null);
	}
	if (!res.ok) throw new FlagError(`HTTP ${res.status}`, res.status);
	const json = (await res.json()) as { data?: { rows?: FlagRow[]; changed?: boolean } };
	return { rows: json.data?.rows ?? [], changed: json.data?.changed === true };
}

/**
 * 一次性的**收藏迁移**：把旧版本存在 `localStorage` 里的那份并进服务端。
 *
 * 为什么是"并"而不是"覆盖"：两边都可能是用户的东西（本机那份是他手动点的，
 * 服务端那份可能是 agent 存进去的），取并集才不丢。`setFlag(id, true)` 幂等，
 * 所以并集就是"逐个打上"，不必再算差集。
 *
 * ⚠️ **只有全部成功才清掉本机的键**：清早了，一次网络失败就把用户攒的收藏
 * 永久丢了 —— 而这次失败在界面上不会出现（迁移是后台跑的）。留着键 = 下次
 * 打开自动重试，这个迁移因此是幂等的。
 *
 * @returns 迁了几首（0 = 没有旧数据、或全部失败）
 */
export async function migrateFavoritesFromStorage(): Promise<number> {
	if (typeof window === 'undefined') return 0;
	const raw = window.localStorage.getItem(LS_KEYS.favorites);
	if (!raw) return 0;
	let ids: string[] = [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
	} catch {
		// 脏值：清掉，否则每次打开都要解析一次坏 JSON。收藏本身没法救回来，
		// 但至少不会一直报错。
		window.localStorage.removeItem(LS_KEYS.favorites);
		return 0;
	}
	if (ids.length === 0) {
		window.localStorage.removeItem(LS_KEYS.favorites);
		return 0;
	}

	let done = 0;
	try {
		for (const id of ids) {
			await postFlag('favorite', id, true);
			done += 1;
		}
	} catch (err) {
		console.warn(`[flag-client] ${FLAG_LABEL.favorite.name}迁移中断（本机那份留着，下次再试）：`, err);
		return done;
	}
	window.localStorage.removeItem(LS_KEYS.favorites);
	return done;
}
