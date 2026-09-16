/**
 * ⑥ 记忆的共享契约 —— 一条偏好。
 *
 * **为什么要放进 `contract/`**：`server/`（存与读）和 `agent/`（拼进系统提示词）
 * 都要用它，而 `agent/` 不许 import `server/`（AGENTS.md 的依赖方向）。
 * 放这里两边引用同一个定义，不会各自演化成两种形状——这条规则在旧项目里
 * 已经付过一次代价（同一份协议分化出三份实现）。
 *
 * **刻意只有两个字段**：
 *  - `key` 是机器用的标识（`disliked_genre`），它决定「什么算同一条偏好」。
 *    同 key 再记 = 覆盖，所以偏好表不会越记越乱——这是它必须存在的原因，
 *    若只有 `value`，用户说五遍「不喜欢摇滚」就会长出五条。
 *  - `value` 是给人看的原话浓缩（`摇滚`），模型读它，也只用它。
 *
 * **不设 `source` / `confidence` / `expiresAt`**：它们都是「以后可能需要」的字段。
 * 在没有真实需求支撑时加上去，会让读代码的人以为系统在做它其实没做的判断
 * （比如看到 `expires_at` 就以为有过期机制，而实际上没有任何代码去检查它）。
 */
export type Preference = {
	/** 稳定标识，小写 snake_case。**同 key 再写入即覆盖**。 */
	key: string;
	/** 用户原话的浓缩，如「摇滚」。 */
	value: string;
};

/** 注入系统提示词的偏好条数上限（防某次异常写入把提示词淹掉）。 */
export const MAX_INJECTED_PREFERENCES = 30;

/**
 * `key` 的归一化规则 —— **写在这里是因为它是「什么算同一条偏好」的定义**，
 * 工具侧与存储侧必须用同一套，否则 `Disliked_Genre` 与 `disliked_genre`
 * 会变成两条不同的偏好，用户说两遍就记两遍。
 *
 * 规则：小写 → 空白与连字符变 `_` → 只留 `[a-z0-9_]` → 合并连续 `_` → 去首尾 `_`。
 * 归一化后为空（比如 key 整串是中文）返回 null，由调用方报错让模型换一个。
 */
export function normalizePreferenceKey(raw: string): string | null {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_')
		.replace(/[^a-z0-9_]/g, '')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '');
	if (normalized.length === 0 || normalized.length > 40) return null;
	return normalized;
}
