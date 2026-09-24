/**
 * 成本计价 —— 把「用了多少 token」变成「花了多少钱」。
 *
 * ── 为什么从 `server/agent/pricing.ts` 上移到 contract ──────────────
 * 原来它待在 `server/`，文件头写着一条准入条件：
 * 「类型定义在本文件而不是 `contract/`：`contract/` 的准入条件是『有第二个消费者』，
 *  而价目目前只有服务端读。等前端要显示钱的那一天再上移——**"以后可能用得上"不算消费者**。」
 *
 * 现在第二个消费者出现了：**成本闸门**（`agent/run.ts` 的 `stopWhen`）要在循环里
 * 每一步算钱，才能判断"这一轮该不该停"。而 `agent/` 不许 import `server/`
 * （依赖方向见 AGENTS.md）。于是按它自己写下的标准，该上移了 —— 这不是重构爱好，
 * 是那条准入条件在起作用。
 *
 * 本文件只放**纯函数**（外加一个读环境的便利函数）：解析价目、查价、算钱、写成人话。
 * 「本轮一共花了多少」这类**记账**留在 `server/agent/turn-log.ts`，
 * 因为那需要库，而 contract 是零依赖层。
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

/** 每百万 token 的单价（美元）。 */
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
 * 而代价（少一条价目）远小于收益。跳过的条目由 `unusedPriceEntries` 报出来 ——
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
 * 算一笔账的**微美元整数**。没有价目 → `null`。
 *
 * `null` 而不是 `0`：前者是「不知道」，后者是「免费」。`turn-log.ts` 里
 * `ms` 用 `null` 不用 `0` 是同一条判据 —— 0 会伪装成一个真实的值。
 *
 * 参数收 `{ inputTokens, outputTokens }` 且**两者都可选**：成本闸门
 * （`agent/run.ts`）拿到的是 SDK 的 `LanguageModelUsage`（字段更多、且可能缺项），
 * 记账那边拿到的是库里的两个确定数字 —— 两种形状都能喂进来。
 * 缺项按 0 计（不是按"未知"拒算）：token 数缺失时它只是这一项没算上，
 * 而**价目缺失**才是"压根不知道"（那一支返回 `null`）。
 */
export function costMicro(
	tokens: { inputTokens?: number; outputTokens?: number },
	price: Price | null,
): number | null {
	if (!price) return null;
	// 先收窄到 number 再判有限性：`Number.isFinite(undefined)` 是 false，
	// 但它**不会**把 `number | undefined` 缩窄成 number。
	const rawIn = tokens.inputTokens;
	const rawOut = tokens.outputTokens;
	const inTok = typeof rawIn === 'number' && Number.isFinite(rawIn) ? rawIn : 0;
	const outTok = typeof rawOut === 'number' && Number.isFinite(rawOut) ? rawOut : 0;
	return Math.round(inTok * price.inPerM + outTok * price.outPerM);
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
