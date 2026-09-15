/**
 * AI SDK 原生 UI 消息流（UIMessageChunk）的共享装配语义（纯函数、无依赖）。
 *
 * 协议来源：本文件**不**定义自有 chunk 词汇表，直接消费 AI SDK 的
 * `UIMessageChunk`（`ai` 包导出，线格式见 `JsonToSseTransformStream`：
 * `data: <json>\n\n` 每帧 + `data: [DONE]\n\n` 收尾）。
 *
 * 一个 assistant 回复在流里不是一个连续字符串，而是**分段**的：
 * 文本被包成带 `id` 的 part（`text-start` … `text-delta`* … `text-end`）。
 * 一次 turn 里模型常连调多次工具，于是会出现多个文本 part——
 * 例如「我先搜一下」→ 调工具 →「正在放：荷塘月色」。
 * 只有**最后一个产生了可见文本的 part** 才是真正给用户的回答。
 *
 * 这一点比旧协议更硬：AI SDK 本来就给每段文本发 `text-start`/`text-end`，
 * 块边界是**显式**的，不用再从「新一轮 LLM / 工具调用」去推断。
 * （`start-step` / `finish-step` / 工具 part 仍一并当边界，是兜底——
 * 模型不发 `text-end` 就切走时不能让两段文本粘在一起。）
 *
 * 消费者是 `components/use-chat-stream.ts`（前端气泡）。放在 `contract/`
 * 而不是组件内部，是因为这段装配语义必须与 BFF 产出的 chunk 严格对齐——
 * 它属于 **wire 契约**，不是 UI 细节（历史上曾由前端 / 采集 / 评估三处
 * 各写一份，然后漂移了）。所以这里只放纯函数、不 import `ai`。
 *
 * 相关词汇表（节选，权威定义见 `ai` 的 `UIMessageChunk`）：
 *   start / start-step / finish-step / finish / abort / error
 *   text-start { id } / text-delta { id, delta } / text-end { id }
 *   reasoning-start / reasoning-delta { delta } / reasoning-end
 *   tool-input-start / tool-input-delta / tool-input-available
 *   tool-output-available { toolCallId, output } / tool-output-error { toolCallId, errorText }
 *   message-metadata { messageMetadata }
 */

/** 一次 LLM 往返的 token 计量。 */
export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

/** 结构化的 UIMessageChunk 视图（不 import `ai`，保证纯函数、可被客户端安全引用）。 */
export type UIChunk = {
	type?: string;
	/** 文本/推理 part 的 id；同一 part 的 start/delta/end 共享。 */
	id?: string;
	/** `text-delta` / `reasoning-delta` 的增量文本。 */
	delta?: string;
	toolCallId?: string;
	toolName?: string;
	input?: unknown;
	output?: unknown;
	/** `error` / `tool-output-error` / `tool-input-error` 的原因。 */
	errorText?: string;
	/** `message-metadata` 的载荷（本项目用它带 token usage）。 */
	messageMetadata?: unknown;
	[key: string]: unknown;
};

/** 可见文本 part 的 part 类型。 */
export const TEXT_PART_DELTA = 'text-delta';
/** 思考 part 的 part 类型——明确不可见，其余一律视为面向用户的文本。 */
export const REASONING_PART_DELTA = 'reasoning-delta';

/** chunk 是否是一段应当呈现给用户的文本增量。 */
export function isVisibleTextDelta(chunk: UIChunk): boolean {
	return chunk.type === TEXT_PART_DELTA && typeof chunk.delta === 'string';
}

/** chunk 是否是模型的思考增量（不展示，但保留作失败归因证据）。 */
export function isReasoningDelta(chunk: UIChunk): boolean {
	return chunk.type === REASONING_PART_DELTA && typeof chunk.delta === 'string';
}

/**
 * 文本块边界。
 *
 * 主判据是 `text-start`/`text-end`（AI SDK 的显式边界）；其余是兜底：
 * 步骤切换、工具调用、流结束都可能让模型不发 `text-end` 就切走。
 */
const BLOCK_BOUNDARY_TYPES = new Set([
	'text-start',
	'text-end',
	'start-step',
	'finish-step',
	'finish',
	'error',
	'abort',
	'tool-input-start',
	'tool-input-available',
]);

export function isBlockBoundary(chunk: UIChunk): boolean {
	return typeof chunk.type === 'string' && BLOCK_BOUNDARY_TYPES.has(chunk.type);
}

/** 回复装配器的状态：已封闭的文本块 + 当前正在流的块。 */
export type ReplyAssembler = {
	/** 已封闭的可见文本块，按时间顺序。 */
	readonly blocks: readonly string[];
	/** 当前块（尚未封闭）。 */
	readonly current: string;
};

export const emptyReply = (): ReplyAssembler => ({ blocks: [], current: '' });

/** 封闭当前块：非空则入栈。 */
function closeBlock(state: ReplyAssembler): ReplyAssembler {
	const text = state.current.trim();
	return text ? { blocks: [...state.blocks, text], current: '' } : { blocks: state.blocks, current: '' };
}

/** 把一个 chunk 折进装配器状态（不可变，方便 React 与服务端复用）。 */
export function reduceReply(state: ReplyAssembler, chunk: UIChunk): ReplyAssembler {
	if (isBlockBoundary(chunk)) return closeBlock(state);
	if (isVisibleTextDelta(chunk)) {
		return { blocks: state.blocks, current: state.current + String(chunk.delta) };
	}
	return state;
}

/**
 * 当前应呈现给用户的回复文本。
 * 正在流的块优先；若当前块还没有可见文本（例如模型还在思考或刚调完工具），
 * 回退到上一个已封闭的块——这样中途不会闪成空白。
 */
export function visibleReply(state: ReplyAssembler): string {
	return state.current.trim() || state.blocks[state.blocks.length - 1] || '';
}

/** 一次性把整段 chunk 列表折成最终回复（离线/测试用）。 */
export function assembleReply(chunks: readonly UIChunk[]): string {
	return visibleReply(chunks.reduce(reduceReply, emptyReply()));
}

/**
 * 从原生 `message-metadata` part 里取归一化 token 计量。
 *
 * BFF 在 `finish` 时把上游返回的 usage 归一化成本项目的 `TokenUsage.total`，
 * 挂到 `message-metadata` 上。
 *
 * ⚠️ 零 token 意味着请求被上游掐断、模型根本没跑完，**不是**「答错了」。
 */
export function extractUsage(chunk: UIChunk): TokenUsage | undefined {
	const u = chunk.messageMetadata as
		| { usage?: { input?: number; output?: number; totalTokens?: number } }
		| undefined;
	if (!u?.usage) return undefined;
	const input = u.usage.input ?? 0;
	const output = u.usage.output ?? 0;
	const total = u.usage.totalTokens ?? input + output;
	if (total <= 0) return undefined;
	return { input, output, total };
}
