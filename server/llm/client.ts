/**
 * llm/client — BFF 侧 LLM 直调的**唯一**单点（2026-09-05 评审报告 P1-3 收编）。
 *
 * 边界约定：对话链路一律走 对话 Agent（/api/chat → 3583），本模块只服务
 * **基础设施型**调用（曲库打标这类后台批处理/队列任务）——它们不是对话回合，
 * 塞进会话制的 agent 反而错配。除此之外**禁止**在 BFF 里新增直连模型的代码。
 *
 * env（统一收口，tagger 原先散落的读取已并入）：
 *   LLM_API_BASE   网关地址，默认回落 VOICE_API_BASE / 官方网关
 *   LLM_API_TOKEN  凭证，默认回落 ANTHROPIC_AUTH_TOKEN
 *   TAG_MODEL      打标模型，默认 agnes-2.5-flash（与 agent 同网关同模型）
 */

const DEFAULT_BASE = 'https://apihub.agnes-ai.com/v1';
function apiBase(): string {
	return process.env.LLM_API_BASE ?? process.env.VOICE_API_BASE ?? DEFAULT_BASE;
}

function token(): string {
	return process.env.LLM_API_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN ?? '';
}

export type ChatJsonOptions = {
	/** 模型 id，默认 TAG_MODEL / agnes-2.5-flash。 */
	model?: string;
	temperature?: number;
	maxTokens?: number;
	/** 覆盖网关（一般不用，测试注入用）。 */
	baseUrl?: string;
	/** 覆盖凭证（一般不用，测试注入用）。 */
	authToken?: string;
	signal?: AbortSignal;
};

/**
 * 发一条 user prompt，要求模型只回一个 JSON 对象，返回解析结果。
 *
 * JSON 抽取沿用 tagger 的实战策略：拼接 content 与 reasoning_content 后取
 * **最后一个**能解析且形似答案的 `{...}` 块——模型偶尔先解释再给结论，
 * 甚至中途自我纠正，取最像最终答案的那段最稳。
 * 失败抛 Error（调用方决定重试/记录），不吞错。
 */
export async function chatJson<T>(prompt: string, opts: ChatJsonOptions = {}): Promise<T> {
	const model = opts.model ?? process.env.TAG_MODEL ?? 'agnes-2.5-flash';
	const res = await fetch(`${opts.baseUrl ?? apiBase()}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${opts.authToken ?? token()}`,
		},
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: prompt }],
			temperature: opts.temperature ?? 0.2,
			max_tokens: opts.maxTokens ?? 800,
		}),
		signal: opts.signal,
	});
	if (!res.ok) {
		throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 120)}`);
	}
	const json = (await res.json()) as {
		choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
	};
	const choice = json.choices?.[0]?.message;
	const text = `${choice?.content ?? ''}\n${choice?.reasoning_content ?? ''}`;
	const matches = text.match(/\{[^{}]*\}/g) ?? [];
	for (const candidate of matches.reverse()) {
		try {
			return JSON.parse(candidate) as T;
		} catch {
			/* 试下一个候选 */
		}
	}
	throw new Error(`no JSON in reply: ${(choice?.content ?? '').slice(0, 80)}`);
}
