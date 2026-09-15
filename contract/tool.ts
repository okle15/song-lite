/**
 * 工具结果的 wire 形状 —— 服务端 `agent/tools.ts` 产出、浏览器 `AgentMount` 消费。
 *
 * 为什么单独成文件（而不是定义在 `agent/tools.ts` 里）：这个形状有**两个**消费者，
 * 一个在服务端、一个在浏览器。定义在生产方的话，浏览器侧就得 `import type` 一条
 * 指向 `agent/` 的边——依赖方向反了。放到零依赖的 `contract/` 后，两边都只依赖
 * 契约（与 `contract/player.ts` 同一个理由）。
 *
 * 注意它和「模型看到的东西」不是一份：模型只看到 `text`（`tools.ts` 的
 * `toModelOutput` 裁过），`ok` 和 `ms` 是**只给界面看**的。
 */
export type ToolOutcome = {
	/** 业务成败。`false` = 工具跑了但结果是否定的（如曲目不存在），不是崩了。 */
	ok: boolean;
	/** 工具回给模型的文字。 */
	text: string;
	/** 本次工具耗时（毫秒）。 */
	ms: number;
};
