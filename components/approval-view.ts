/**
 * 一个「需要你确认」的框该长成什么样 —— 从 `ChatCard.tsx` 里提出来的**一条纯规则**。
 *
 * ── 它在修一个不报错的 bug ────────────────────────────────────────
 * `messages` 表存的是 parts 全量，所以一个**没被回答**的待确认框会跟着历史一起回来。
 * 而 AI SDK 的 `addToolApprovalResponse` **只更新最后一条消息**里的 part
 * （`AbstractChat` 的实现就是 `messages[messages.length - 1]`）。于是刷新之后有两种处境：
 *
 *   - 那个框还在**最后一条**上 → 按钮可点，点下去真的会续跑（正常）；
 *   - 用户又说了一句话、它退到了中间 → 按钮**照样可点，点下去什么都不发生**。
 *
 * 后者的表现是「点了没反应，控制台一条报错都没有」，与「网络慢」长得一模一样；
 * 而它比前者更常发生 —— 用户看到框愣了一下、先说了句别的，就会出现。
 *
 * ── 所以判据不是「这个 part 是什么状态」 ──────────────────────────
 * 状态的检查（`approval-requested`）只是必要条件；**它在不在最后一条消息上**才是
 * 决定性的那一半。这也解释了为什么这条规则值得从渲染里提出来：它的输入是承重的，
 * 选错就等于在界面上留一个**死控件**（点了没有任何反馈的控制件，用户只会怪自己）。
 *
 * 同族的先例见 `agent/run.ts` 的 `toolCallPruningFor()` —— 那里也是「一个纯函数选一档，
 * 选错的症状在 `tsc` / 单测 / 日志里一个都不留痕」，所以同样导出、同样被单测钉住。
 */
import type { ToolUIPart } from 'ai';

/** 待确认那一步的四种样子。`other` = 与审批无关的普通状态，走常规轨迹卡。 */
export type ApprovalView = 'buttons' | 'stale' | 'denied' | 'other';

/**
 * @param state        tool part 的状态（`ToolUIPart['state']`）
 * @param isLastMessage 这个 part 所在的消息是不是 `messages` 的最后一条
 */
export function approvalView(state: ToolUIPart['state'], isLastMessage: boolean): ApprovalView {
	// 待确认：只有在最后一条上才给按钮。其余的**必须**降级成一句说明 ——
	// 留着按钮就是那个死控件（SDK 不会去看更早的消息）。
	if (state === 'approval-requested') return isLastMessage ? 'buttons' : 'stale';
	// 被拒：终态，与位置无关（它已经不会再有动作，也就无所谓能不能点）。
	if (state === 'output-denied') return 'denied';
	return 'other';
}
