/**
 * /api/chat — BFF chat route（**占位实现，暂无 Agent**）。
 *
 * 本版本只保留前端与 BFF 接口：请求体校验走原来的契约，响应按
 * **AI SDK 原生 UI 消息流**（`UIMessageChunk`）的线格式回一段固定文本，
 * 并以**裸 `data: [DONE]`** 收尾。前端 `components/use-chat-stream.ts`
 * 与 `contract/chat-chunks.ts` 一行都不用改。
 *
 * 线格式（与接入 Agent 后逐字节一致）：
 *   data: <UIMessageChunk json>\n\n   每帧
 *   data: [DONE]\n\n                 收尾哨兵（**不要 JSON 编码**）
 * 响应头带 `x-vercel-ai-ui-message-stream: v1`。
 *
 * 接入 Vercel AI SDK 时，只需把 `buildPlaceholderStream()` 换成
 * `streamText(...).toUIMessageStream()` 接 `JsonToSseTransformStream`——
 * 请求校验、响应头、错误信封都不用动。
 */
import type { ChatRequest } from '@/contract/types';
import { fail } from '@/server/http';

/** AI SDK UI 消息流响应头（取值与 `ai` 导出的 `UI_MESSAGE_STREAM_HEADERS` 一致）。 */
const STREAM_HEADERS: Record<string, string> = {
	'content-type': 'text/event-stream',
	'cache-control': 'no-cache',
	connection: 'keep-alive',
	'x-vercel-ai-ui-message-stream': 'v1',
};

/** 占位回复文案。 */
const PLACEHOLDER_REPLY =
	'当前版本还没有接入 Agent，所以我暂时无法理解你的话。\n' +
	'音乐可以直接用界面操作：左侧搜索曲库、点卡片即可播放，底部播放条切歌。';

/** 组装一帧 SSE 事件。 */
function frame(chunk: Record<string, unknown>): string {
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** 组装一段「只有文本」的最小 UI 消息流。 */
function buildPlaceholderStream(text: string): string {
	const textId = 'text-0';
	return [
		frame({ type: 'start', messageId: `placeholder-${Date.now()}` }),
		frame({ type: 'text-start', id: textId }),
		frame({ type: 'text-delta', id: textId, delta: text }),
		frame({ type: 'text-end', id: textId }),
		frame({ type: 'finish' }),
		'data: [DONE]\n\n',
	].join('');
}

export async function POST(request: Request) {
	let body: ChatRequest;
	try {
		body = (await request.json()) as ChatRequest;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const { message, userId } = body;
	if (!message || !userId) {
		return fail('Missing "message" or "userId"', 400);
	}

	return new Response(buildPlaceholderStream(PLACEHOLDER_REPLY), {
		headers: STREAM_HEADERS,
	});
}
