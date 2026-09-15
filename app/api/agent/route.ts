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

	// `useChat` 会把整段会话历史发上来。但**本项目还没有服务端会话历史**
	// （BLUEPRINT 阶段 3），所以这里刻意只取最后一条——「LLM 无状态」因此保持
	// 可见：连着说两句「我想听 X」→「换一首」，第二句是独立的。
	// 阶段 3 要做的正是：把这段历史从浏览器搬到服务端，并在这里读回来。
	const message = lastUserText(Array.isArray(body.messages) ? body.messages : []);
	if (!message) return fail('message is required', 400);

	// 工具要回调自家 API。origin 从**本次请求**推出来，而不是硬编码端口——
	// 否则换个端口跑（3000 / 3100 / 部署后域名）工具就会打空。
	const { result, tools } = runAgent(config, {
		message,
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
		// 推理过程不进气泡（实测一轮里 reasoning 的字符量能占三分之二）。
		sendReasoning: false,
		// 网关的错误体里通常有可读的原因（401 / 模型名写错都靠它定位），
		// 原样带给前端比一句「执行失败」有用得多。
		onError: (error) => (error instanceof Error ? error.message : String(error)),
	});

	return createUIMessageStreamResponse({ stream });
}
