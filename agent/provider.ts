/**
 * ① 模型接入 —— 把网关拼成 SDK 认得的 provider。
 *
 * 这是 BLUEPRINT §2 里划进**冻结区**的部件之一：装一次，之后永久不动。
 * 加功能不需要改这里；唯一该改它的正当理由是「换模型来源」。
 *
 * 为什么值得单独成文件：这份配置在原项目里散落在两处，且两处对「base 回落到哪个
 * 变量」的答案不同（一处回落 `VOICE_API_BASE`，另一处不回落），症状是「同一个
 * token 在 A 功能好用、在 B 功能 401」。收口到一处后回落链只有一条，肉眼可查。
 *
 * 只读 `process.env`，不写任何文件、不打印值。
 *
 * 版本配套（照抄原项目踩平的结论，别自己试）：
 *   ai@7  ↔  @ai-sdk/openai-compatible@3.x  ↔  @ai-sdk/provider@4（spec v4）
 * 三者必须同一代。跨代时 `chatModel()` 的返回值塞不进 `streamText`，
 * 而报错信息是类型层面的、指向很不直观。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

const DEFAULT_BASE = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_MODEL = 'agnes-2.5-flash';

export type AgentConfig = {
	/** 网关根地址，已去掉尾部斜杠。 */
	base: string;
	/** 凭证。 */
	key: string;
	/** 模型名。 */
	model: string;
};

/** 按顺序取第一个非空环境变量。 */
function pick(...names: string[]): string | null {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return null;
}

/**
 * 读取网关配置。
 *
 * **没有凭证时返回 `null` 而不是抛异常**——「还没配 key」是首次运行最常见的
 * 状态，应该被翻译成一句人能看懂的提示（「去 .env.local 填 LLM_API_KEY」），
 * 而不是一个 500 堆栈。
 *
 * 回落的边界值得留意：`key` 与 `base` 允许回落到 `VOICE_*`（同一个网关、同一套
 * 凭证，回落是安全的），但 **`model` 绝不回落 `VOICE_MODEL`**。踩过的坑：
 * `VOICE_MODEL=whisper-1` 是**语音转写**模型，把它当对话模型用，网关不会报
 * 「模型不匹配」，只会回一句 `No available channel for model whisper-1`——
 * 看起来像网关配置坏了，其实是回落链捡错了模型。不同能力类的变量不能互相兜底。
 */
export function readAgentConfig(): AgentConfig | null {
	const key = pick('LLM_API_KEY', 'ANTHROPIC_AUTH_TOKEN');
	if (!key) return null;
	const rawBase = pick('LLM_API_BASE', 'VOICE_API_BASE') ?? DEFAULT_BASE;
	return {
		base: rawBase.replace(/\/+$/, ''),
		key,
		model: pick('AGENT_MODEL') ?? DEFAULT_MODEL,
	};
}

/** 构造模型句柄。调用方先用 `readAgentConfig()` 把关，这里不做缺失兜底。 */
export function getModel(config: AgentConfig): LanguageModel {
	return createOpenAICompatible({
		name: 'agnes',
		baseURL: config.base,
		apiKey: config.key,
	}).chatModel(config.model);
}

/**
 * 本轮的成本上限（**微美元**）。变量 `AGENT_MAX_COST_MICRO`，**默认 0 = 不限**。
 *
 * 为什么默认不限，而不是给一个"合理的小数目"：一个默认打开的闸门会在用户不知情的
 * 情况下改变行为（该说的话说到一半停了），而它的症状与"模型话说一半"**无法区分** ——
 * 这种"悄悄替用户做决定"正是本项目反复防的东西。**要拦，得用户自己说要拦。**
 *
 * 读不到、非数字、负数、0 一律当成「不限」：env 写错时的安全方向是**放行**，
 * 而不是把服务变成"什么都干不了"（同 `overBudget` 里"没有价目就放行"那条）。
 *
 * 放在这个文件（provider）是因为它是**读环境变量的唯一处**——`agent/` 与 `app/`
 * 两侧都从这里取，不会各写一份解析。
 */
export function readCostLimitMicro(): number {
	const raw = Number(process.env.AGENT_MAX_COST_MICRO);
	return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}
