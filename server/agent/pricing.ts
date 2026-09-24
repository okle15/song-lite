/**
 * 成本计价 —— **服务端这一侧**。
 *
 * 纯函数（解析价目 / 查价 / 算钱 / 写成人话）都搬去了 `contract/pricing.ts`，
 * 因为出现了第二个消费者：**成本闸门**（`agent/run.ts` 在循环里逐步算钱，
 * 决定这一轮该不该停），而 `agent/` 不许 import `server/`。
 * 搬走的理由与准入条件写在那个文件的头注里。
 *
 * 留在这里的两件是**服务端特有**的：
 *   - `costMicroFor`：从当前进程的价目表里给某个模型求价（要读 env）；
 *   - `unusedPriceEntries`：拼错模型名时唯一的可见痕迹。
 *
 * 下面那串 re-export 只为不打断既有调用方（`turn-log.ts`、`scripts/turns.mts`
 * 都从本模块取），不是"这里还有一份实现"。
 */
import {
	costMicro,
	formatMoney,
	parsePriceTable,
	priceOf,
	readPriceTable,
	type PriceTable,
} from '../../contract/pricing';

export { costMicro, formatMoney, parsePriceTable, priceOf, readPriceTable };
export type { Price, PriceTable } from '../../contract/pricing';

/**
 * 给本轮求价的便捷组合：从当前进程的价目表里找这个模型那一档。
 *
 * 参数收 `model: string` 而不是 `AgentConfig` —— 依赖方向是
 * `app → server → contract`，`server/` 不许 import `agent/`（见 AGENTS.md）。
 * 收一个字符串就够，没必要为一行便利把分层捅穿。
 *
 * 单独成函数是因为它有**三个调用点**（对话路由、定时任务执行器、成本闸门），
 * 各写一遍就是三处会漂移的实现。
 */
export function costMicroFor(
	model: string,
	tokens: { inputTokens: number; outputTokens: number },
): number | null {
	return costMicro(tokens, priceOf(readPriceTable(), model));
}

/**
 * 列出配了价、但这个模型没用上的条目 —— 拼错模型名时唯一的可见痕迹。
 *
 * 为什么需要：`priceOf` 找不到就回落到 `*`（或 null），于是**拼错模型名不会报错**，
 * 只会一直用一个"看起来合理"的兜底价，而所有历史数字都偏着。
 */
export function unusedPriceEntries(table: PriceTable, model: string): string[] {
	const keys = Object.keys(table).filter((k) => k !== '*' && k !== model);
	return keys;
}
