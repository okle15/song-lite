/**
 * ⑥ 记忆 —— 持久偏好的读写点（BLUEPRINT §2 的活跃区）。
 *
 * 与 `message-log.ts` 形状相同（表结构在 `server/db.ts`，本文件只有一对读写），
 * 但**语义有三处关键差别**，每一处都是刻意的：
 *
 * 1. **写失败要抛，不能静默。**
 *    `message-log` 记的是旁路流水，磁盘满就少一条历史，用户不会因此受损；
 *    而这里的写入是 agent 对用户的**承诺**——它已经说了「好，我记住了」。
 *    若写入静默失败，用户下次会发现它又忘了，却找不到原因。
 *    所以这里让异常冒到路由 → 变成工具失败 → 模型据实告知，失败**可见**。
 *
 * 2. **`key` 决定「什么算同一条偏好」，所以同 key 覆盖而不是追加。**
 *    `messages` 天然按条追加；偏好不行——用户说五遍「不喜欢摇滚」应该是**一条**
 *    偏好，不是五条。key 的唯一性就是这个语义的载体（`ON CONFLICT DO UPDATE`）。
 *    归一化规则在 `contract/preference.ts`，工具侧与存储侧共用同一套。
 *
 * 3. **没有过期，也没有历史版本。** 删除只发生在模型显式调用 `forget_preference`
 *    时。「最近不想听摇滚」这类时效语义由 `value` 的自然语言承载，模型自己理解——
 *    加一个 `expires_at` 字段而不写任何检查它的代码，只会让人误以为系统在做过期判断。
 *
 * 注入上限（`MAX_INJECTED_PREFERENCES`）只管**读多少条进提示词**，不删任何行。
 */
import type { Preference } from '../../contract/preference';
import { MAX_INJECTED_PREFERENCES } from '../../contract/preference';
import { getDb } from '../db';

/** 单次读取的硬上限（防止误传一个很大的 limit 把整表读进内存）。 */
const READ_LIMIT_MAX = 200;

type RawRow = { key: string; value: string };

/**
 * 写入一条偏好（同 key 覆盖）。`key` **必须是已归一化过的**——
 * 归一化由调用方（路由）用 `normalizePreferenceKey` 完成，因为「key 非法」
 * 是要以 400 告诉调用方的，那是 HTTP 层的判断，不该混进存储层。
 *
 * DB 异常直接抛（见文件头第 1 条）。`at` 可注入，单测靠它钉时间。
 */
export function setPreference(key: string, value: string, at: Date = new Date()): void {
	const db = getDb();
	db.prepare(
		`INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
	).run(key, value, at.toISOString());
}

/**
 * 删除一条偏好。返回「是否真的删掉了」——删一条不存在的偏好不算失败
 * （模型可能记错 key），工具据此回一句「本来就没记过」，比一句笼统的失败有用。
 */
export function removePreference(key: string): boolean {
	const result = getDb().prepare('DELETE FROM preferences WHERE key = ?').run(key);
	return Number(result.changes) > 0;
}

/**
 * 读回偏好，**最近更新的在前**。顺序有意如此：注入系统提示词时有条数上限，
 * 该上限应该砍掉「最老的」而不是「最近的」——用户刚说的那句必须在里面。
 *
 * 读失败返回空数组：偏好是增强，读不到就等于「这次没记住你的口味」，
 * 比让整轮对话挂掉好。
 */
export function listPreferences(limit = MAX_INJECTED_PREFERENCES): Preference[] {
	const parsed = Math.trunc(limit);
	const n = Math.min(
		Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_INJECTED_PREFERENCES, 1),
		READ_LIMIT_MAX,
	);
	try {
		// `updated_at` 相同时用 rowid 兜底：同一毫秒写两条时顺序才是确定的。
		return getDb()
			.prepare('SELECT key, value FROM preferences ORDER BY updated_at DESC, rowid DESC LIMIT ?')
			.all(n) as unknown as RawRow[];
	} catch (err) {
		console.error('[preference-log] failed to list preferences:', err);
		return [];
	}
}
