/**
 * /api/agent —— 对话端点。
 *
 * 这是 BLUEPRINT §2 的 ⑧ **传输**（冻结区）。协议完全交给 AI SDK：本文件只剩
 * 「把请求翻译成一次 runAgent，再把流原样送出去」，没有一行帧编解码、没有手写的
 * `ReadableStream`、没有 `[DONE]` 哨兵。
 *
 * 与 `/api/player/events` 的关系（这是理解整个交互的关键）：
 *  - 本路由是**请求-响应**的：用户说一句，agent 回一段文字 + 若干工具轨迹，然后关流。
 *    这里的「流式」指的是**首字延迟**——不等整段生成完再返回。
 *  - `/api/player/events` 是**长连接广播**：播放状态一变就推给所有浏览器。
 * 两者**没有直接耦合**。agent 想让「前端动起来」，只需要通过工具去调
 * `/api/player/*` 改状态——状态一变，广播自然把新快照推给浏览器。
 * 换句话说：**agent 不通知前端，前端自己会跟上**。
 *
 * 为什么「没配 key」不用流返回：那是能预期到的首次运行状态，用普通 JSON 信封 +
 * 503 返回，前端直接显示 message，不必先解 SSE。
 */
import { createUIMessageStreamResponse, isTextUIPart, toUIMessageStream, type UIMessage } from 'ai';
import { readAgentConfig } from '@/agent/provider';
import { MAX_STEPS, runAgent } from '@/agent/run';
import type { PlayerSnapshot } from '@/contract/player';
import { appendMessages } from '@/server/agent/message-log';
import { listPreferences } from '@/server/agent/preference-log';
import { recordTurn, summarizeSteps, type StepLike } from '@/server/agent/turn-log';
import { fail } from '@/server/http';
import { promptSnapshot } from '@/server/player/prompt-snapshot';

export const dynamic = 'force-dynamic'; // SSE 必须动态运行，禁止静态优化

/**
 * 请求体。
 *
 * `snapshot` 是 `Partial`，因为服务端**只从它取设备侧的四项**（音量 / 播放方式 /
 * 随机 / 进度）——曲目与队列这些服务端自己就知道，不该由浏览器当信使送回来
 * （见下面 `promptSnapshot`）。浏览器目前仍寄完整的一份，那些多出来的字段是
 * **冗余，不是依赖**：哪天前端只寄这四项，这条链路照样成立。
 */
type Body = { messages?: UIMessage[]; snapshot?: Partial<PlayerSnapshot> | null };

/** 取最后一条用户消息的纯文本（UI 消息是 parts 数组，文字只是其中一种 part）。 */
function lastUserText(messages: UIMessage[]): string {
	const last = messages.filter((m) => m.role === 'user').at(-1);
	return (last?.parts ?? [])
		.filter(isTextUIPart)
		.map((p) => p.text)
		.join('')
		.trim();
}

export async function POST(request: Request) {
	// ⑨ 观测的一头一尾：`startedAt` 是路由进来的墙钟，收尾在下面的 `onEnd`。
	const startedAt = Date.now();
	const config = readAgentConfig();
	if (!config) {
		return fail(
			'未配置模型网关：请在 .env.local 里设置 LLM_API_KEY（可选 LLM_API_BASE / AGENT_MODEL）。',
			503,
		);
	}

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	// `useChat` 会把整段会话历史发上来（含本轮这句话）。**本项目现在把它当回事**：
	// 全量交给 runAgent，服务端因此有了上下文——连着说「我想听 X」→「换一首」，
	// 第二句能理解「换」的是当前这首。这就是 BLUEPRINT 阶段 3 的落点。
	const uiMessages = Array.isArray(body.messages) ? body.messages : [];
	const message = lastUserText(uiMessages);
	if (!message) return fail('message is required', 400);

	// 工具要回调自家 API。origin 从**本次请求**推出来，而不是硬编码端口——
	// 否则换个端口跑（3000 / 3100 / 部署后域名）工具就会打空。
	// ⑨ 观测：这一轮的 id **就是**下面那条 assistant 消息的 id（同一个值交给
	// `generateMessageId`）。于是「说了什么」（messages 表）与「花了多少、调了什么」
	// （agent_turns 表）天然可 join，不需要再发明一个关联字段。
	const turnId = crypto.randomUUID();
	/** 本轮的错误原文。`onError` 与 `onEnd` 是两个回调，靠这个变量把前者捎给后者。 */
	let turnError: string | null = null;

	const { result, tools } = await runAgent(config, {
		uiMessages,
		// ⑦ 的播放状态：**服务端权威的那几项在这里现取**（播放状态 / 曲目 / 队列），
		// 只有设备侧的四项（音量 / 播放方式 / 随机 / 进度）才用浏览器随消息寄来的
		// 那份。规则、理由与可测的那一半都在 `server/player/prompt-snapshot.ts`。
		snapshot: promptSnapshot(body.snapshot),
		// ⑥ 记忆的**读侧**：每轮现读一遍偏好，注入系统提示词。
		// 写侧不在这里——那是 `remember_preference` 工具 → `/api/preferences`，
		// 因为「记不记、记什么」必须由模型自己判断（见 prompt.ts 的铁律 6）。
		// 读与写因此是两条独立的路，各走各的通道，在下一轮才汇合：
		// 这一轮写进去的偏好，下一轮才会出现在下面这次读取里。
		preferences: listPreferences(),
		baseUrl: new URL(request.url).origin,
		signal: request.signal,
	});

	// ai@7 把这几个方法从 `streamText` 结果上挪成了独立函数（旧方法已标 @deprecated，
	// 声明「将在下个大版本移除」）。一步变两步，换来的是**传输边界在路由里显式可见**：
	// 哪一步在转帧（`toUIMessageStream`）、哪一步在包 HTTP 响应（`createUIMessageStreamResponse`），
	// 读这两行就知道；旧写法把两件事藏在 method 链里。
	const stream = toUIMessageStream({
		stream: result.stream,
		// 判断工具 part 是静态还是动态要用到它（见 run.ts 的返回说明）。
		tools,
		// ⚠️ 传了 `originalMessages` 就等于**开启 SDK 的持久化模式**（官方注释原文：
		// "If they are provided, persistence mode is assumed"）。此时 `onEnd` 收到的是
		// **含本轮 assistant 回复在内的完整消息列表**——所以落库不需要「延迟一轮」，
		// 不存在「要等下一次请求才把这次的回复存进去」的时序问题。
		originalMessages: uiMessages,
		// ⚠️ **不传 `generateMessageId`，响应消息就没有 id。** SDK 的实现是
		// `responseMessageId = generateMessageId != null ? getResponseUIMessageId(...) : undefined`，
		// 少了它这条回复的 id 是空字符串——而 id 是我们的主键，后果不是「id 难看」，
		// 是**每轮 assistant 回复互相覆盖，库里只留得下最后一条**（历史里的回答全没了，
		// 且不报任何错）。实测踩过（2026-09-16）。
		// 传了之后这个 id 会经流的 `start` 帧发给浏览器，前端 `useChat` 用同一个 id ——
		// 于是「服务端落库的主键」与「前端下一轮回传的 id」是同一个值，幂等才真正成立。
		// 附带好处：SDK 会把「最后一条是 assistant」的情形判为续写（重新生成），
		// 复用同 id 覆盖而不是新增一条。
		generateMessageId: () => turnId,
		// ⚠️ 这里**必须 await**（`onEnd` 的返回值 SDK 是会等的）：观测那一行要么在
		// 本轮结束时就落好，要么干脆没落——挂成后台 promise 会让「刚问完就去查观测」
		// 时有时无，而**验证脚本会因此间歇性失败**（本轮踩过这个形状的坑：
		// 收尾动作必须可断言）。写失败在 `recordTurn` 内部只 log，不会把对话炸掉。
		onEnd: async ({ messages, isAborted, finishReason }) => {
			appendMessages(messages);

			// 中断时 `steps` / `usage` 可能拿不到（诚实记「已知多少算多少」，
			// 而不是丢掉这一轮——被中断的轮次恰恰是最需要看的一类）。
			let steps: StepLike[] = [];
			let inputTokens = 0;
			let outputTokens = 0;
			try {
				steps = (await result.steps) as unknown as StepLike[];
			} catch {
				// 忽略：下面按 0 步记，`aborted` 已经把这件事标出来了
			}
			try {
				const usage = await result.usage;
				inputTokens = usage.inputTokens ?? 0;
				outputTokens = usage.outputTokens ?? 0;
			} catch {
				// 同上
			}

			recordTurn({
				id: turnId,
				userText: message,
				...summarizeSteps(steps, {
					maxSteps: MAX_STEPS,
					aborted: isAborted,
					error: turnError,
				}),
				finishReason: finishReason ?? null,
				ms: Date.now() - startedAt,
				inputTokens,
				outputTokens,
			});
		},
		// 推理过程不进气泡（实测一轮里 reasoning 的字符量能占三分之二）。
		sendReasoning: false,
		// 网关的错误体里通常有可读的原因（401 / 模型名写错都靠它定位），
		// 原样带给前端比一句「执行失败」有用得多——同时留一份给 ⑨ 观测，
		// 否则「哪次答错是因为网关」只能靠翻服务端日志。
		onError: (error) => {
			turnError = error instanceof Error ? error.message : String(error);
			return turnError;
		},
	});

	return createUIMessageStreamResponse({ stream });
}
