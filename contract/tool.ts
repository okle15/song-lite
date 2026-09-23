/**
 * 工具结果的 wire 形状 —— 服务端 `agent/tools.ts` 产出、浏览器 `ChatCard` 消费。
 *
 * 为什么单独成文件（而不是定义在 `agent/tools.ts` 里）：这个形状有**两个**消费者，
 * 一个在服务端、一个在浏览器。定义在生产方的话，浏览器侧就得 `import type` 一条
 * 指向 `agent/` 的边——依赖方向反了。放到零依赖的 `contract/` 后，两边都只依赖
 * 契约（与 `contract/player.ts` 同一个理由）。
 *
 * 注意它和「模型看到的东西」不是一份：模型只看到 `text`（`tools.ts` 的
 * `toModelOutput` 裁过），`ok` 和 `ms` 是**只给界面看**的。
 * `kind` 是唯一**两边都看**的新字段，见下。
 */

/**
 * 失败是哪一种。**判据是"谁来修"**，不是"HTTP 几几几" —— 这才是模型拿着它
 * 能起作用的原因（LEARNING.md §3.3 的 B1）。
 *
 * | kind | 含义 | 谁来修 |
 * |:--|:--|:--|
 * | `bad_request` | 参数不对（400 / 422） | **模型自己能修**：换个参数再试 |
 * | `not_found` | 目标不存在（404） | 模型：**别重试了**，如实说没有 |
 * | `forbidden` | 没权限（401 / 403） | 谁都不行，得人去配 |
 * | `unavailable` | 服务端的问题（5xx） | 稍后重试可能就好了 |
 * | `transport` | 没拿到合法信封（连不上 / 超时 / 回的不是 JSON） | **通常是服务没跑**，模型重试无用 |
 * | `unknown` | 其他非 2xx | 不确定，别猜 |
 *
 * ⚠️ 为什么不是三档（成功 / 业务失败 / 崩了）：现在 `tools.ts` 里那个把三种失败
 * 压平的 `{ok:false, text}` **本身就是在替模型判断**——它只能从一句中文里猜
 * 「这事还值不值得换个说法再试」。而"要不要换做法"恰恰是模型比这段代码强的
 * 地方（代码里的判断会过时，模型的不会）。所以 B1 改的是**接口**，不是提示词：
 * 不在铁律里写「超时可以重试、不存在别试了」，只把分类如实交出去。
 */
/**
 * 全部 kind 的**运行时名单**。类型从它派生，于是"加一种失败"只有一处要改。
 *
 * 它有两个用途：`tools.ts` 拼 `[kind] 前缀`（模型看的），`turn-log.ts` 把工具结果
 * 落进观测时判一下读回来的值（**观测从 JSON 里读，不信类型断言**）。
 */
export const TOOL_FAILURE_KINDS = [
	'bad_request',
	'not_found',
	'forbidden',
	'unavailable',
	'transport',
	'unknown',
] as const;

export type ToolFailureKind = (typeof TOOL_FAILURE_KINDS)[number];

/** 读回来的值是不是一个 kind。老行没有这个字段，脏值也要能挡住。 */
export function isToolFailureKind(value: unknown): value is ToolFailureKind {
	return typeof value === 'string' && (TOOL_FAILURE_KINDS as readonly string[]).includes(value);
}

export type ToolOutcome = {
	/** 业务成败。`false` = 工具跑了但结果是否定的（如曲目不存在），不是崩了。 */
	ok: boolean;
	/** 工具回给模型的文字。 */
	text: string;
	/** 本次工具耗时（毫秒）。 */
	ms: number;
	/**
	 * 失败的种类（成功时为 `null` / 省略）。
	 *
	 * 形状上**不加限定为必填**：`ok: true` 时它没有意义，硬塞一个 `null` 只会让
	 * 每一处成功返回都要多写一个字段。而失败侧漏带它也不会静默——`toModelOutput`
	 * 只在有 kind 时才加前缀，所以漏带的表现是「模型少了一条信息」，
	 * 不是「模型拿到一条错的信息」。
	 */
	kind?: ToolFailureKind | null;
};
