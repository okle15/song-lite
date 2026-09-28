/**
 * 清单类卡片的**四态** —— 唯一出处。
 *
 * 「记忆」卡（`memory-view.ts`）原先自己写了一份，「播放历史」卡（`HistoryCard.tsx`）
 * 是第二份需求，于是这条规则提上来。**规则一处落笔，其它位置留指针**（铁律 1）——
 * 各写一份的话，两张卡会各自漂移出不同的顺序，而这件事**不报错、只在界面上骗人**。
 *
 * ── 两条承重的规则 ───────────────────────────────────────────────
 *
 * 1. ⚠️ **`error` 必须排在 `empty` 前面。**
 *    反过来写（先看有没有条目）时，「读失败」与「一条都没有」都落进 `empty` ——
 *    两块都渲染成一片没有内容的区域，而它们要用户做的事相反：一件是「接受」，
 *    一件是「再试一次」。
 *    更糟的是那个错误结论的**内容**：对「记忆」卡是「我从来没设过偏好」，
 *    对「历史」卡是「我从来没听过歌」——**都是关于用户自己的错话**，而真相是
 *    agent 正拿着一份他看不见的数据在影响每一轮对话。
 *
 * 2. **`list` 原样带出 `items`：不重排、不拷贝。**
 *    顺序是服务端定的（`plays` 按 id 倒序、`preferences` 按 `updated_at` 倒序），
 *    展示层再排一次就是「两处会漂移的实现」，而漂移的表现是
 *    「卡片上的顺序和模型看到的不是一回事」——同样不报错。
 */

export type ListPhase<T> =
	| { kind: 'loading' }
	| { kind: 'error' }
	| { kind: 'empty' }
	| { kind: 'list'; items: T[] };

export function listPhase<T>(input: {
	/** 第一次请求是否已经出结果（成功或失败都算）。 */
	loaded: boolean;
	/** 读取失败时的一句人话；成功时为 `null`。 */
	error: string | null;
	items: T[];
}): ListPhase<T> {
	// 顺序即判据：先 error，再 loading，再 empty，最后才是 list。
	// 三条断言各钉一段，单测里那条「两条一起喂时 error 必须赢」守的就是第一段。
	if (input.error !== null) return { kind: 'error' };
	if (!input.loaded) return { kind: 'loading' };
	if (input.items.length === 0) return { kind: 'empty' };
	return { kind: 'list', items: input.items };
}
