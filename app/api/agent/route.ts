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
import { runAgent } from '@/agent/run';
import type { PlayerSnapshot } from '@/contract/player';
import { appendMessages } from '@/server/agent/message-log';
import { fail } from '@/server/http';

export const dynamic = 'force-dynamic'; // SSE 必须动态运行，禁止静态优化

type Body = { messages?: UIMessage[]; snapshot?: PlayerSnapshot | null };

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
	const { result, tools } = await runAgent(config, {
		uiMessages,
		snapshot: body.snapshot ?? null,
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
		generateMessageId: () => crypto.randomUUID(),
		onEnd: ({ messages }) => appendMessages(messages),
		// 推理过程不进气泡（实测一轮里 reasoning 的字符量能占三分之二）。
		sendReasoning: false,
		// 网关的错误体里通常有可读的原因（401 / 模型名写错都靠它定位），
		// 原样带给前端比一句「执行失败」有用得多。
		onError: (error) => (error instanceof Error ? error.message : String(error)),
	});

	return createUIMessageStreamResponse({ stream });
}
