/**
 * 成本计价 —— 把「用了多少 token」变成「花了多少钱」（⑨ 观测的一列）。
 *
 * `LEARNING.md §2` 把「成本」排在第六位，说它「已有意识，缺'多少钱'这一列」。
 * 缺的确实只是一列，但**不是一列能自己成立的**：
 *
 * ── 为什么成本列必须和 model 列一起加 ──────────────────────────────
 * `agent_turns` 里已经有 `input_tokens` / `output_tokens`，但**光有钱没有价目**
 * 是算不出来的，而价目随模型走。所以这一列一旦单独存在，它就在悄悄做一个假设：
 * 「这些历史行都是同一个模型的价」。换一次模型，那条曲线就把两种价目画在一起了，
 * 而**图上什么异常都看不出来** —— 与 `prompt_version` 之前的处境一模一样
 * （BLUEPRINT §9 说 prompt 版本管理从"可选"变成"前置"，就是这个形状）。
 * 所以同一天加的是**两列**：`model` 与 `cost_micro`。
 *
 * ── 为什么价格从环境变量来，而不是内置一张表 ─────────────────────────
 * 内置价格表看起来更"开箱可用"，但它给的是一串**会过期、且与本网关无关**的数字：
 * 本项目的网关是聚合网关（`LLM_API_BASE` 指向它），单价由**它**决定，不是模型
 * 厂商标价。写死一张厂商标价进来，只会让人拿着一个错的数做决策 —— 而错的钱
 * 比没有钱更坏（同 `turn-log.ts` 的 `ms` 用 null 不用 0）。
 *
 * 所以：**没配就记 NULL**，`npm run turns` 会明说"未配价目表"。NULL 是
 * 「不知道」，0 是「免费」，两者不能混。
 *
 * ── 存储形态：微美元整数 ─────────────────────────────────────────
 * `cost_micro` 存**百万分之一美元**的整数。两个理由：
 *   1. 单轮对话的成本常在 0.0001–0.01 美元这一档，用整数存才看得清；
 *   2. 浮点进 SQLite 会带上 `0.30000000000000004` 那种尾巴，求和之后更难看。
 * 换算恰好很干净：单价是「美元 / 百万 token」时，
 * `microUSD = inputTokens × inPerM + outputTokens × outPerM`（两次乘法，一次取整）。
 */
/**
 * 每百万 token 的单价（美元）。
 *
 * 类型定义在本文件而不是 `contract/`：`contract/` 的准入条件是「有第二个消费者」
 * （见 `contract/tool.ts` 的文件头），而价目目前只有服务端读。等前端要显示钱的
 * 那一天再上移——**"以后可能用得上"不算消费者**。
 */
export type Price = { inPerM: number; outPerM: number };

/** 价目表的字符串键：模型名（精确匹配），或 `*`（兜底）。 */
export type PriceTable = Record<string, Price>;

const PRICES_ENV = 'LLM_PRICES';
/** 兜底键。用 `*` 而不是"最后一条"，因为字典序不该决定谁兜底。 */
const FALLBACK_KEY = '*';

/**
 * 解析 `LLM_PRICES`。形如：
 *
 * ```
 * LLM_PRICES="agnes-2.5-flash=0.1,0.4;*=1,3"
 * ```
 *
 * 分隔符的取舍：条目用 `;`、条目内的两价用 `,`、键值用 `=`。**不能用 `,` 分条目**
 * —— `model=a,b;model2=c,d` 里逗号有两种含义，而解析器一旦猜错，得到的是
 * 一个"看起来很正常"的错误数字（比如把 `0.4` 当成下一个模型的输入价）。
 *
 * 坏条目**跳过**而不是抛：这是一个读环境变量的解析器，抛会让整个服务起不来，
 * 而代价（少一条价目）远小于收益。跳过的条目由 `warnUnknownPrices` 报出来 ——
 * **不静默**是这条纪律的全部要点。
 */
export function parsePriceTable(raw: string | undefined): PriceTable {
	const table: PriceTable = {};
	if (!raw) return table;
	for (const entry of raw.split(';')) {
		const piece = entry.trim();
		if (!piece) continue;
		const eq = piece.indexOf('=');
		if (eq <= 0) continue;
		const name = piece.slice(0, eq).trim();
		const [inRaw, outRaw] = piece
			.slice(eq + 1)
			.split(',')
			.map((s) => s.trim());
		const inPerM = Number(inRaw);
		const outPerM = Number(outRaw);
		// 负价与 NaN 一律拒收：负价会让"花了多少"变成负数，出现在汇总里
		// 就像"这套系统在赚钱"，那种数字没人会去质疑它是不是解析错了。
		if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM)) continue;
		if (inPerM < 0 || outPerM < 0) continue;
		table[name] = { inPerM, outPerM };
	}
	return table;
}

/** 当前进程的价目表（每次调用重新求值，与 `disabledPatches()` 同一个理由）。 */
export function readPriceTable(): PriceTable {
	return parsePriceTable(process.env[PRICES_ENV]);
}

/**
 * 取某个模型的单价：**精确匹配优先，其次 `*` 兜底，都没有则 null**。
 *
 * `*` 兜底而不是"用第一条"：网关常把模型名映射成自己的别名（本项目默认
 * `agnes-2.5-flash` 就不是任何厂商的公开模型名），用户很可能只配得了兜底一档。
 */
export function priceOf(table: PriceTable, model: string): Price | null {
	return table[model] ?? table[FALLBACK_KEY] ?? null;
}

/**
 * 算这一轮的钱（**微美元整数**）。没有价目 → `null`。
 *
 * `null` 而不是 `0`：前者是「不知道」，后者是「免费」。`turn-log.ts` 里
 * `ms` 用 `null` 不用 `0` 是同一条判据 —— 0 会伪装成一个真实的值。
 */
export function costMicro(
	tokens: { inputTokens: number; outputTokens: number },
	price: Price | null,
): number | null {
	if (!price) return null;
	const inTok = Number.isFinite(tokens.inputTokens) ? tokens.inputTokens : 0;
	const outTok = Number.isFinite(tokens.outputTokens) ? tokens.outputTokens : 0;
	return Math.round(inTok * price.inPerM + outTok * price.outPerM);
}

/**
 * 给本轮求价的便捷组合：从当前进程的价目表里找这个模型那一档。
 *
 * 参数收 `model: string` 而不是 `AgentConfig` —— 依赖方向是
 * `app → server → contract`，`server/` 不许 import `agent/`（见 AGENTS.md）。
 * 收一个字符串就够，没必要为一行便利把分层捅穿。
 *
 * 单独成函数是因为它有**两个调用点**（对话路由 + 定时任务执行器），
 * 各写一遍就是两处会漂移的实现。
 */
export function costMicroFor(
	model: string,
	tokens: { inputTokens: number; outputTokens: number },
): number | null {
	return costMicro(tokens, priceOf(readPriceTable(), model));
}

/**
 * 把微美元写成给人看的字符串。**自适应小数位**：
 * 单轮成本常在 0.0001 这一档，固定两位（`$0.00`）会把所有轮次显示成零。
 */
export function formatMoney(micro: number | null): string {
	if (micro === null) return '—';
	const usd = micro / 1_000_000;
	if (usd === 0) return '$0';
	if (usd < 0.01) return `$${usd.toFixed(5)}`;
	if (usd < 1) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}

/**
 * 列出配了价、但这个模型没用上的条目 —— 拼错模型名时唯一的可见痕迹。
 *
 * 为什么需要：`priceOf` 找不到就回落到 `*`（或 null），于是**拼错模型名不会报错**，
 * 只会一直用一个"看起来合理"的兜底价，而所有历史数字都偏着。
 */
export function unusedPriceEntries(table: PriceTable, model: string): string[] {
	const keys = Object.keys(table).filter((k) => k !== FALLBACK_KEY && k !== model);
	return keys;
}
