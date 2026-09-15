/**
 * /api/player/events — SSE 推送端点。
 *
 * 替代 PlayerControls 的 3s 轮询：前端建一次长连接，服务端在 player-state
 * 变更时主动推送快照，延迟从 ≤3s 降到毫秒级。
 *
 * 协议层面就是 HTTP：响应头设 `Content-Type: text/event-stream` 且不写
 * Content-Length，连接保持打开，每次状态变更往 body 写 `data: {...}\n\n`。
 * 浏览器 EventSource API 自动重连，无需手写断线逻辑。
 *
 * 生命周期：
 *  1. 客户端 GET /api/player/events → 建立连接
 *  2. 服务端立即推一次当前快照（让前端马上拿到状态，不等第一次变更）
 *  3. subscribeToPlayerState 注册监听器
 *  4. player-state 任一 mutation → emitChange → 监听器写 SSE 帧
 *  5. 客户端断开（关 tab / refresh）→ request.signal abort → 取消订阅 + 关流
 */
import { subscribeToPlayerState, getSnapshot, initQueueFromLibrary } from '@/server/player/state';
import type { PlayerSnapshot } from '@/contract/player';

export const dynamic = 'force-dynamic'; // 禁止静态优化，SSE 必须动态运行

export async function GET(request: Request) {
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			let closed = false;

			const send = (snapshot: PlayerSnapshot) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
				} catch {
					// controller 可能已关（客户端断开），忽略
				}
			};

			// 0. 首次连接时从真实音乐库加载队列（扫描 MUSIC_DIR）
			// initQueueFromLibrary 内部有 queueInitialized 标记，不会重复扫描
			await initQueueFromLibrary();

			// 1. 立即推当前快照（队列已加载完，推给前端的是真实歌曲）
			send(getSnapshot());

			// 2. 订阅后续变更
			const unsubscribe = subscribeToPlayerState(send);

			// 3. 客户端断开时清理
			const cleanup = () => {
				if (closed) return;
				closed = true;
				unsubscribe();
				try { controller.close(); } catch { /* already closed */ }
			};
			request.signal.addEventListener('abort', cleanup);
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			'Connection': 'keep-alive',
			// 禁止代理缓冲（nginx 等可能缓冲 SSE 导致延迟）
			'X-Accel-Buffering': 'no',
		},
	});
}
