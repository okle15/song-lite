/**
 * 「记忆」卡的纯规则。
 *
 * ⚠️ 这里**只剩这张卡自己的那两句文案**。两条原本住在这里、现在被提上去的规则 ——
 * 提走的原因是它们已经不只服务这一张卡（各写一份必然漂移出两种口径）：
 *
 *  - **四态的顺序**（`error` 先于 `empty`）→ `./list-phase.ts`（「播放历史」卡是第二个消费者）
 *  - **「网络没通」与「服务端拒绝」分开说** → `./failure-note.ts`
 *
 * 本文件保留下来，是因为 `MemoryCard.tsx` 与它的单测认这个名字，而且这两条规则
 * 对**记忆**这件事的分量值得留在离卡片最近的地方 —— 见 `memoryView` 的注释。
 *
 * ── 这张卡为什么非要不可 ──────────────────────────────────────────
 * ⑥ 记忆是 `LEARNING.md` 说的「唯一不会被模型换代抹平的东西」。它的写入由模型判断
 * （铁律 6），注入到**以后每一次对话**。而 `prompt.ts` 里那条铁律的原文自己写着：
 *
 *     **记错比不记更糟**：它会长期影响以后每一次对话，而用户不知道你记了什么。
 *
 * 「用户不知道」被写成了风险，可产品上一直没有出口 —— `GET /api/preferences`
 * 这条路 2026-09-2x 就在，`app/api/preferences/route.ts` 的文件头甚至提前写下了
 * 「将来前端加一个「管理我的偏好」面板，走的是同一条路径、同一套校验、同一个信封」，
 * 而那个面板直到今天才做。所以这张卡不是新功能，是**把已经存在的能力接上出口**
 * （与阶段 3c 那次「路由本来就存在、缺的只是工具」同一个形状）。
 */
import type { Preference } from '@/contract/preference';
import { failureNote } from './failure-note';
import { listPhase, type ListPhase } from './list-phase';

/** 四态 + 数据同源（规则在 `./list-phase.ts`，这里只是给它安上这张卡的条目类型）。 */
export type MemoryView = ListPhase<Preference>;

export function memoryView(input: {
	/** 第一次请求是否已经出结果（成功或失败都算）。 */
	loaded: boolean;
	/** 读取失败时的一句人话；成功时为 `null`。 */
	error: string | null;
	items: Preference[];
}): MemoryView {
	// 这条顺序对「记忆」卡格外要紧，所以在这里写清它的分量（规则本身在 list-phase）：
	// 读失败时列表是空的，反过来写（先看有没有条目）会把它判成 empty —— 用户于是
	// 得出「我从来没设过偏好」这个关于**自己**的结论，而真实情况是 agent 正拿着一份
	// 他看不见的东西影响每一轮对话。**那正是这张卡要消灭的处境本身**，
	// 不分开就等于卡片自己犯了它要修的错。
	return listPhase(input);
}

/**
 * 删除没成功时那句提示。`status` 传 `null` 表示请求根本没发出去（网络层失败）。
 *
 * 为什么不合成一句「删除失败」：这两件事对用户的**下一步**不同。服务端回了 4xx/5xx
 * 说明请求到了、是我们发的东西不被接受（再点一次同样结果），网络没通则值得重试。
 * 文案的两种形态由 `./failure-note.ts` 提供，这里只负责补上「这条还在」——
 * 少了它用户会以为已经删掉了。
 */
export function forgetFailed(status: number | null): string {
	return failureNote('删除', status, '—— 这条还在。');
}
