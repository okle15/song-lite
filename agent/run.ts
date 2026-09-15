/**
 * ② 运行一次对话 —— 「用户说一句话」到「模型说完了」的全过程。
 *
 * 这是 BLUEPRINT §2 里划进**冻结区**的部件之一。注意本文件有多短：循环的**形状**
 * （有工具、有边界、会反复问）全部浮在下面这几个参数上，而不是埋在两百行流解析里。
 *
 * 被 SDK 接手的那些活（一行都不用写）：
 *   - 读模型的 SSE 流、按 index 拼接 `tool_calls` 的 JSON 碎片
 *   - `arguments` 分片到达、多字节字符被网络分片切半
 *   - 「模型要工具 → 执行 → 回填 → 再问一次」的循环本身
 *   - 终止条件、usage 提取、收尾哨兵
 *
 * 留在这里的三件事，恰好是「agent 是什么」的全部：
 *   `instructions`（它是谁）、`messages`（它看见了什么）、`tools`（它能做什么）。
 */
import { isStepCount, streamText } from 'ai';
import type { PlayerSnapshot } from '../contract/player';
import { buildSystemPrompt } from './prompt';
import { type AgentConfig, getModel } from './provider';
import { createTools } from './tools';

/**
 * 最多几轮「模型 → 工具 → 模型」。
 *
 * 模型偶尔会陷入「搜一次没满意、再搜一次」的循环。有上限时它会带着已有的信息
 * 收口，而不是把 token 烧光。
 */
const MAX_STEPS = 5;

export type RunAgentOptions = {
	message: string;
	/** 前端随消息带上来的播放状态，拼进系统提示词。 */
	snapshot?: PlayerSnapshot | null;
	/** 自家 BFF 的 origin（工具靠它回调 API）。 */
	baseUrl: string;
	/** 客户端断开时中断本轮（关页面 / 点停止）。 */
	signal?: AbortSignal;
};

/**
 * 跑完一整轮对话。返回 `{ result, tools }`——**流还没被消费**，怎么送出去由路由决定。
 *
 * 不在这里 try/catch：错误的落点是路由的 `onError`（→ 客户端一条 `error` part），
 * 前端因此总能拿到一条可读的话，而不是一个悬空的「正在思考…」。
 */
export function runAgent(config: AgentConfig, opts: RunAgentOptions) {
	const tools = createTools({ baseUrl: opts.baseUrl });
	const result = streamText({
		model: getModel(config),
		// ai@7 起 `system` 更名为 `instructions`（旧名仍可作废弃别名）。
		instructions: buildSystemPrompt(opts.snapshot),
		// 本项目还没有会话历史（BLUEPRINT 阶段 3）：每次只有本轮这一条用户消息。
		// 所以现在连着说两句「我想听 X」→「换一首」，第二句是独立的，模型不知道
		// 上一句说过什么——这不是 bug，是「LLM 无状态」的直接结果。
		messages: [{ role: 'user', content: opts.message }],
		tools,
		stopWhen: isStepCount(MAX_STEPS),
		abortSignal: opts.signal,
	});
	// `tools` 一并交出：`toUIMessageStream` 要靠它判断「这个工具 part 是静态工具还是
	// 动态工具（MCP 那类）」。不传会退化成读 part 自带的 `dynamic` 字段——当前全是静态
	// 工具，两者结果一致，但传了才不会在将来接动态工具时静默走错分支。
	return { result, tools };
}
