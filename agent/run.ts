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
	isToolUIPart,
	pruneMessages,
	streamText,
	type UIMessage,
} from 'ai';
import type { Preference } from '../contract/preference';
import type { PlayerSnapshot } from '../contract/player';
import { costMicro, type Price } from '../contract/pricing';
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
	/**
	 * ⑦ 的播放状态，拼进系统提示词。**由路由备好**——agent 不 import `server/`，
	 * 所以它只「收到事实」。服务端权威的几项（状态 / 曲目 / 队列）在路由里现取，
	 * 只有设备侧的四项（音量 / 播放方式 / 随机 / 进度）来自浏览器上报，
	 * 规则与理由见 `server/player/prompt-snapshot.ts`。
	 */
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
	/**
	 * 模型**吐出第一个字**时回调一次（⑨ 观测的首字延迟取数点）。
	 *
	 * 这是本文件唯一一处为**观察**而加的东西，值得说清为什么它不算破规则：
	 * 「② 冻结区」要保护的是**循环的形状**（有几层、怎么终止、怎么回填工具结果），
	 * 而这里一行都没动 —— 挂的是 SDK 现成的 `onChunk` 钩子，同一个 `streamText`
	 * 调用多一个参数。原版 `turn-log.ts` 里留的判据就是这条：
	 * 「真需要时应该在 SDK 的 `onChunk` 上做，而不是在业务层糊一层」。
	 *
	 * 契约是**只回调一次**（实现里带本地标记），调用方不必自己去重。
	 */
	onFirstText?: () => void;
	/**
	 * 本轮的成本上限与价目（见 `RunBudget` / `overBudget`）。
	 * 不传或 `limitMicro <= 0` = 不限，行为与没有这个闸门时完全一样。
	 */
	budget?: RunBudget | null;
	/**
	 * 本轮**因预算被截断**时回调一次（⑨ 观测用）。
	 *
	 * 与 `onFirstText` 同性质：为**观察**挂的钩子，循环的形状一行没动。
	 *
	 * 为什么必须有它：预算触顶的症状与"步数触顶"长得几乎一样（最后一步都是
	 * 想调工具、都没把话说完整），而**下一步动作完全不同** —— 一个该调大预算，
	 * 一个该调大 `MAX_STEPS`。事后从 `steps` 反推是"猜"，这里回调是"记"。
	 */
	onBudgetHit?: () => void;
};

/**
 * 造一个「第一个字」探测器。**只回调一次**，且只在真的吐了字时回调。
 *
 * 单独成函数、且参数按**结构**声明（不引 SDK 的联合类型）的两个理由：
 *  1. 它可以被单测直接喂 `{ chunk: { type: 'text-delta', text: '好' } }` 跑遍，
 *     不必起一个模型或造一个 SDK 对象；
 *  2. 判据里那两条否定（非 text-delta、空字符串）是**会静默算错**的地方 ——
 *     把工具调用的 chunk 当首字，延迟会算成一个偏小的值，而它看起来只是
 *     "这次挺快"。空 delta 同理：它不是用户看得见的字。
 */
export function firstTextChunk(onFirstText?: () => void) {
	if (!onFirstText) return undefined;
	let fired = false;
	return (event: { chunk: { type: string; text?: string } }) => {
		if (fired) return;
		if (event.chunk.type !== 'text-delta') return;
		if (!event.chunk.text) return;
		fired = true;
		onFirstText();
	};
}

/**
 * 判定预算时看得见的**最小**一步。自己声明而不引 `turn-log.ts` 的 `StepLike`：
 * `agent/` 不许 import `server/`（依赖方向见 AGENTS.md），而这里真的只需要"用量"。
 */
type BudgetStep = {
	usage?: { inputTokens?: number; outputTokens?: number } | null;
};

/**
 * 本轮的成本上限（微美元）与算它要用的价目。
 *
 * 为什么价目**跟着 budget 一起传**，而不是让 `run.ts` 自己去读 `process.env`：
 * 与 `snapshot` / `preferences` 同一个模式 —— agent 不 import `server/`
 * （依赖方向），所以它只「收到事实」，不负责取事实。
 */
export type RunBudget = {
	/** 硬上限（微美元）。`<= 0` 表示不限。 */
	limitMicro: number;
	/** 该模型的单价；`null` = 没配价目（那就不拦，见 `overBudget`）。 */
	price: Price | null;
};

/**
 * 造一个「这一轮花超了吗」的判定，交给 `stopWhen`。形状与 SDK 的 `isStepCount`
 * **完全相同**，于是它与步数上限**并列**成两个停止条件，而不是在业务层另糊一层循环。
 *
 * ⚠️ 三条判据，每条都对应一种「不报错但做错」的写法：
 *
 *  1. **没有价目时一律放行**（恒返回 false）。算不出钱就把用户拦下来，是拿
 *     「不知道」当理由拒绝服务。钱算不出来该在观测里显示成「—」（`costMicro`
 *     返回 `null`），而不是变成「这轮不许用」—— 与 `turn-log.ts` 里
 *     `ms` 用 null 不用 0 是同一条判据。
 *  2. **逐步累加，不能只看最后一步。** SDK 的 `step.usage` 是**每一步各自**的用量，
 *     不是累计值；拿最后一步当总数会把 5 步的一轮算成 1 步的钱，于是预算**永远撞不上**
 *     —— 一个"配了却从不生效"的上限，比不配更难发现。
 *  3. 比的是**严格大于**：`limitMicro` 是"允许花到这个数"，正好等于不算超。
 */
export function overBudget(budget: RunBudget | null | undefined) {
	const price = budget?.price ?? null;
	const limit = budget?.limitMicro ?? 0;
	if (!price || !(limit > 0)) return () => false;
	return ({ steps }: { steps: readonly BudgetStep[] }) => {
		let micro = 0;
		for (const step of steps) {
			if (!step.usage) continue;
			micro += costMicro(step.usage, price) ?? 0;
		}
		return micro > limit;
	};
}

/**
 * 这一轮是不是「审批答复」的续跑 —— 用户刚在界面上点了「执行」或「算了」。
 *
 * 判据是 UI 消息里出现了 `state === 'approval-responded'` 的工具 part：那是
 * `addToolApprovalResponse` 写下的形状（`AbstractChat` 里那三行 `updatePart`），
 * 只有"答复完、结果还没拿回来"的那一轮才有它。
 *
 * ── 为什么必须专门认出来（2026-09-24 端到端实测踩到）────────────────────
 * 因为它会让 `pruneMessages` 的 `before-last-message` **剪错一刀**：
 *   `convertToModelMessages` 把审批答复放进**一条新的 `tool` 角色消息**里，于是
 *   "最后一条"变成了它，而**带 `tool-call` 的 assistant 消息退到了"最后一条之前"**
 *   → 它的 `tool-call` 被剪掉，而同一消息里的 `tool-approval-request` 却留着
 *   （`pruneMessages` 对审批 part 单独记账 `keptApprovalIds`，那一条命中了）。
 *   服务端的 `collectToolApprovals` 于是找不到配对的 tool-call，直接抛
 *   `ToolCallNotFoundForApprovalError`。
 *
 * 症状有多隐蔽：用户点「执行」，界面只多出一句英文报错
 * （`Tool call "call_xxx" not found for approval request "aitxt-xxx".`），
 * **工具永远不会跑、那一轮也不会续**；而 `tsc` 全绿、单测全绿、服务端日志干净
 * —— 因为报错是以 `error` 帧回来的，不是异常。
 */
function isApprovalResumption(uiMessages: UIMessage[]): boolean {
	return uiMessages.some((m) =>
		m.parts.some((p) => isToolUIPart(p) && p.state === 'approval-responded'),
	);
}

/**
 * 这一轮该用哪一档工具轨迹裁剪。
 *
 * **导出是给单测的，不是给别的调用方用的** —— 这条规则的输入是承重的：选错一档，
 * 审批续跑就会抛 `ToolCallNotFoundForApprovalError`（见 `isApprovalResumption` 的
 * 长注），而这个错误在 `tsc`、单测、服务端日志里**一个都不留痕**。所以把"选哪一档"
 * 从 `runAgent` 的函数体里提出来，让单测能直接断言它 —— 顺带也就能断言
 * **旧那一档真的会把 tool-call 剪掉**（不然这条回归用例可能"因为错误的原因而绿"）。
 */
export function toolCallPruningFor(uiMessages: UIMessage[]): 'none' | 'before-last-message' {
	return isApprovalResumption(uiMessages) ? 'none' : 'before-last-message';
}

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
	//
	//    ⚠️ **唯一例外：审批续跑那一轮必须原样留着**（`toolCallPruningFor` 会说为什么）。
	const messages = pruneMessages({
		messages: history,
		reasoning: 'none',
		toolCalls: toolCallPruningFor(opts.uiMessages),
		emptyMessages: 'remove',
	});

	// 预算闸门：与 `MAX_STEPS` **并列**的第二个停止条件（形状相同，见 `overBudget`）。
	// 命中时回调一次 —— 本地标记保证"只回调一次"，调用方不必自己去重（同 `firstTextChunk`）。
	const exceedsBudget = overBudget(opts.budget);
	let budgetHit = false;
	const budgetStop = (o: { steps: readonly BudgetStep[] }) => {
		const hit = exceedsBudget(o);
		if (hit && !budgetHit) {
			budgetHit = true;
			opts.onBudgetHit?.();
		}
		return hit;
	};

	const result = streamText({
		model: getModel(config),
		// ai@7 起 `system` 更名为 `instructions`（旧名仍可作废弃别名）。
		// ⑦ 的实时状态与 ⑥ 的已知偏好都拼在这里，**不进 messages**：它们是
		// 「约束与事实」而不是对话，进历史会随历史一起落库、一起长大（见 prompt.ts）。
		instructions: buildSystemPrompt(opts.snapshot, opts.preferences),
		messages,
		tools,
		stopWhen: [isStepCount(MAX_STEPS), budgetStop],
		// ── 确认闸门：不可逆的动作先问一句 ──
		// 判据是**「删掉的是用户的东西」**，而不是"危险"这种说不清的词。这两个工具
		// 一旦执行就没有回头的路，而模型有可能误解了用户的意思：一句「我明天不想
		// 听歌了」被它读成「把那个定时任务撤掉」——**撤掉之后用户根本不知道
		// 曾经有这么一件事**（清单里不再有它，没有任何痕迹）。
		//
		// ⚠️ 为什么这不算"在业务层糊一层"：它是 `streamText` 的**原生选项**，
		// 与 `stopWhen` 同一层 —— 循环的形状一行没动，审批由 SDK 插在
		// 「模型要调工具」与「工具真的跑」之间。
		//
		// ⚠️ **前端必须一起接住**（`useChat` 的 `sendAutomaticallyWhen` +
		// `addToolApprovalResponse`，见 `app/home-client.tsx` 与 `components/ChatCard.tsx`）：
		// 只加服务端这一半，那一轮会停在"等一个永远等不到的回答"上 —— 界面上
		// 看起来只是"它不动了"，没有任何报错。
		toolApproval: {
			cancel_scheduled_task: 'user-approval',
			forget_preference: 'user-approval',
		},
		abortSignal: opts.signal,
		// ⑨ 的首字延迟。**观察钩子，不是循环的一环**：它不改变终止条件、
		// 不参与回填、抛了也只影响一个统计数字（`onFirstText` 由调用方实现，
		// 我们这边不 try/catch —— 观测的失败语义在 `turn-log.ts` 里）。
		onChunk: firstTextChunk(opts.onFirstText),
	});
	// `tools` 一并交出：`toUIMessageStream` 要靠它判断「这个工具 part 是静态工具还是
	// 动态工具（MCP 那类）」。不传会退化成读 part 自带的 `dynamic` 字段——当前全是静态
	// 工具，两者结果一致，但传了才不会在将来接动态工具时静默走错分支。
	return { result, tools };
}
