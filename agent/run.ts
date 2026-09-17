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
 *
 * ── 会话历史（2026-09-16 接上，BLUEPRINT 阶段 3）──────────────────────
 * `messages` 不再只有本轮那一句，而是**整段历史**。把 `UIMessage[]` 变成模型
 * 认得的 `ModelMessage[]` 也是 SDK 的活（`convertToModelMessages`），本项目
 * 只写两行调用——难点不在代码，在理解下面两个动作**为什么必须分开**。
 */
import {
	convertToModelMessages,
	isStepCount,
	pruneMessages,
	streamText,
	type UIMessage,
} from 'ai';
import type { Preference } from '../contract/preference';
import type { PlayerSnapshot } from '../contract/player';
import { buildSystemPrompt } from './prompt';
import { type AgentConfig, getModel } from './provider';
import { createTools } from './tools';

/**
 * 最多几轮「模型 → 工具 → 模型」。
 *
 * 模型偶尔会陷入「搜一次没满意、再搜一次」的循环。有上限时它会带着已有的信息
 * 收口，而不是把 token 烧光。
 *
 * **导出是给 ⑨ 观测用的**：撞到上限时它想调的工具就没机会执行，而这件事
 * 在输出里毫无痕迹（模型只是"话没说完"）——观测要能把这一轮标出来
 * （`summarizeSteps` 的 `truncated`），判据必须是同一个数，不能另抄一份。
 */
export const MAX_STEPS = 5;

export type RunAgentOptions = {
	/**
	 * 整段会话历史（含本轮用户消息），顺序为「早的在前」。
	 * 形态是 SDK 的 `UIMessage`（parts 数组）——因为浏览器与存储层用的都是它，
	 * 只有**送给模型之前**才转成 `ModelMessage`。
	 */
	uiMessages: UIMessage[];
	/** 前端随消息带上来的播放状态，拼进系统提示词。 */
	snapshot?: PlayerSnapshot | null;
	/**
	 * ⑥ 已知偏好（跨对话保留）。**由路由从存储层读好传进来**——agent 不 import
	 * `server/`（依赖方向，见 AGENTS.md），所以它只「收到事实」，不负责取事实。
	 * 写入走另一条路：`remember_preference` 工具 → BFF `/api/preferences`。
	 */
	preferences?: Preference[] | null;
	/** 自家 BFF 的 origin（工具靠它回调 API）。 */
	baseUrl: string;
	/** 客户端断开时中断本轮（关页面 / 点停止）。 */
	signal?: AbortSignal;
};

/**
 * 跑完一整轮对话。返回 `{ result, tools }`——**流还没被消费**，怎么送出去由路由决定。
 *
 * `async` 的唯一原因是 `convertToModelMessages` 返回 Promise（它要 await 工具的
 * output schema）。**忘了 `await` 不会报类型错**（Promise 也是对象），错误会推迟到
 * 模型调用处、指向一个看不出因果的位置——这是本文件最容易踩的一脚。
 *
 * 不在这里 try/catch：错误的落点是路由的 `onError`（→ 客户端一条 `error` part），
 * 前端因此总能拿到一条可读的话，而不是一个悬空的「正在思考…」。
 */
export async function runAgent(config: AgentConfig, opts: RunAgentOptions) {
	const tools = createTools({ baseUrl: opts.baseUrl });

	// ① 转换：`UIMessage[]`（parts 数组，浏览器与库里的形态）→ `ModelMessage[]`
	//    （模型认得的形态）。传 `tools` 是为了让 SDK 按工具自己的 output schema
	//    还原历史里的工具结果——不传会退化成按默认形状猜。
	//
	//    `ignoreIncompleteToolCalls` 专治一种必然发生的脏数据：用户点了「停止」，
	//    那一轮的工具调用只有 input、没有 output。原样发上去，**下一轮的第一个
	//    请求就会抛 `MissingToolResultsError`**——而且是在用户已经忘了那次中断之后。
	const history = await convertToModelMessages(opts.uiMessages, {
		tools,
		ignoreIncompleteToolCalls: true,
	});

	// ② 裁剪：只影响**发出去的**，不动库里存的（存储层存全量，见 message-log.ts）。
	//
	//    为什么必须裁：一轮工具调用比一句话啰嗦得多——搜一次曲库把 10 首歌写进
	//    历史就是几百 token，留 5 轮，上下文一半是「上轮搜了啥」。而它对下一轮
	//    通常没用：用户说「换一首」时，模型需要的是「现在在放什么」（在系统提示词
	//    的实时状态块里），不是「上轮搜到了哪些歌」。
	//
	//    `before-last-message` = 只保留最后一条消息之后的工具轨迹，也就是「本轮
	//    自己的、还热着的」。历史轮的全部扔掉。这一条对应 BLUEPRINT 里「用户选的
	//    是轨迹全扔」，改它就是改产品行为。
	const messages = pruneMessages({
		messages: history,
		reasoning: 'none',
		toolCalls: 'before-last-message',
		emptyMessages: 'remove',
	});

	const result = streamText({
		model: getModel(config),
		// ai@7 起 `system` 更名为 `instructions`（旧名仍可作废弃别名）。
		// ⑦ 的实时状态与 ⑥ 的已知偏好都拼在这里，**不进 messages**：它们是
		// 「约束与事实」而不是对话，进历史会随历史一起落库、一起长大（见 prompt.ts）。
		instructions: buildSystemPrompt(opts.snapshot, opts.preferences),
		messages,
		tools,
		stopWhen: isStepCount(MAX_STEPS),
		abortSignal: opts.signal,
	});
	// `tools` 一并交出：`toUIMessageStream` 要靠它判断「这个工具 part 是静态工具还是
	// 动态工具（MCP 那类）」。不传会退化成读 part 自带的 `dynamic` 字段——当前全是静态
	// 工具，两者结果一致，但传了才不会在将来接动态工具时静默走错分支。
	return { result, tools };
}
