/**
 * 曲目标记的读写点：**收藏**与**屏蔽**（表结构在 `server/db.ts`）。
 *
 * 与 `server/library/tags.ts` 同族（一行 = 一首歌，`track_id` 唯一），
 * 三处语义直接沿用，不另立规矩：
 *
 * 1. **`track_id` 唯一 = 一首歌一个判断。** 「我收藏了这首」不是一条流水，
 *    是一个**当下的判断**——同 id 再写就是覆盖（幂等：重复收藏不会长出第二行）。
 * 2. **写失败要抛**（与 `preferences` / `track_tags` 一侧，与 `plays` 相反）：
 *    agent 一旦说了「好，帮你收起来了」，就必须真收起来。静默失败会让用户
 *    下次发现它没记住，却找不到任何线索。
 * 3. **读失败只 log，并且按「没有标记」处理**（与写侧不对称，是有意的）。
 *    这里要专门说清**为什么 fail-open 是对的**：
 *    `hidden` 的读取者是 `getSongs()`——「可见曲库」的唯一产出点。
 *    若读失败就抛，后果是**整个曲库读不出来**（列表页 500、`search_library`
 *    全失败）；而 fail-open 的后果只是**被屏蔽的那几首又出现了**。
 *    前者把一件事搞坏，后者把一件事搞旧 —— 旧总比坏强。
 *    （`tags.ts` 对读侧是同一条取舍，那边的措辞是「标签是增强，读不到等于
 *    暂时没有标签」。）
 *
 * ── 为什么要有 `setFlag` 的返回值 ────────────────────────────────────
 * 它回的是「这次真的改了没有」。界面据此决定要不要重绘、工具据此决定要不要
 * 说「本来就是这个状态」——两者都不该靠「我发了请求」来推断结果。
 */
import { getDb } from '../db';
import type { FlagKind } from '../../contract/library-flags';

/** 标记 → 表名。**这张表就是「新增一种标记要改哪几处」的清单。** */
const TABLES = {
	favorite: 'favorites',
	hidden: 'hidden',
} as const satisfies Record<FlagKind, string>;

/** 表名只来自上面那张固定映射，不来自调用方 —— 不拼用户输入进 SQL。 */
type FlagTable = (typeof TABLES)[FlagKind];

/** `at` 可注入，单测靠它钉时间（与 `tags.ts` / `preference-log.ts` 一致）。 */
export type FlagOptions = { at?: Date };

/**
 * 某一类标记的全部 trackId，按 id 排序（**顺序稳定才能写断言**，也让
 * 同样的库每次给出同样的响应）。
 *
 * 读失败 → log + 返回空数组（理由见文件头第 3 条：fail-open）。
 */
export function listFlagIds(kind: FlagKind): string[] {
	try {
		const rows = getDb()
			.prepare(`SELECT track_id FROM ${TABLES[kind]} ORDER BY track_id`)
			.all() as unknown as { track_id: string }[];
		return rows.map((r) => r.track_id);
	} catch (err) {
		console.error(`[library-flags] failed to list ${kind}:`, err);
		return [];
	}
}

/** 屏蔽集合。`visible.ts` 只认这个形状 —— 它不该知道「标记」有几种。 */
export function hiddenIds(): Set<string> {
	return new Set(listFlagIds('hidden'));
}

/** 这首歌有没有这个标记。 */
export function isFlagged(kind: FlagKind, trackId: string): boolean {
	const row = getDb()
		.prepare(`SELECT 1 AS one FROM ${TABLES[kind]} WHERE track_id = ?`)
		.get(trackId) as unknown as { one: number } | undefined;
	return row !== undefined;
}

/**
 * 写一个标记（`on: true` = 打上，`false` = 摘掉）。返回**这次真的改了没有**。
 *
 * `on: true` 用 `ON CONFLICT DO NOTHING` 而不是 `DO UPDATE`：重复收藏不该刷新
 * 时间戳（时间戳的意义是「这条标记是什么时候立下的」，不是「最后一次有人点它」）。
 * 代价是 `changes` 为 0 时分不清「本来就有」与「刚刚写过」——所以返回值的判据
 * 取「**调用前存在吗**」，而不是 `changes`（SQLite 的 `DO NOTHING` 在冲突时
 * `changes` 也是 0）。
 */
export function setFlag(kind: FlagKind, trackId: string, on: boolean, opts: FlagOptions = {}): boolean {
	const db = getDb();
	const existed = isFlagged(kind, trackId);
	if (on === existed) return false;
	if (on) {
		const at = (opts.at ?? new Date()).toISOString();
		db.prepare(`INSERT INTO ${TABLES[kind]} (track_id, created_at) VALUES (?, ?) ON CONFLICT(track_id) DO NOTHING`).run(
			trackId,
			at,
		);
	} else {
		db.prepare(`DELETE FROM ${TABLES[kind]} WHERE track_id = ?`).run(trackId);
	}
	return true;
}

/** 表名（守门用例要用，避免它自己再抄一份）。 */
export function flagTableName(kind: FlagKind): FlagTable {
	return TABLES[kind];
}
