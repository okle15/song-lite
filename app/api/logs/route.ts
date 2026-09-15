/**
 * /api/logs — interaction log reader（SQLite 后端）。
 *
 * 支持 query 参数过滤（底层走 SQLite 索引）：
 *  - limit:   最多返回多少条（默认 50，上限 500）
 *  - intent:  按 intent 精确匹配，如 'search' / 'play' / 'pause'
 *  - since:   ISO 时间字符串，timestamp >= since
 *  - until:   ISO 时间字符串，timestamp <= until
 *  - errorTag: 按 error_tag 精确匹配
 *  - routedTo: 'local' | 'agent'
 *
 * 无任何过滤参数时，等价于"取最近 N 条"。响应用统一 `ApiResponse` 信封。
 * 只读路由 — 写入发生在 chat / player / library 路由里。无鉴权（本地单用户）。
 */
import { queryInteractionLogs } from '@/server/records/interaction-log';
import { ok } from '@/server/http';

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	const limitParam = searchParams.get('limit');
	const limit = limitParam
		? Math.min(Math.max(Number.parseInt(limitParam, 10) || 50, 1), 500)
		: 50;

	const intent = searchParams.get('intent') ?? undefined;
	const since = searchParams.get('since') ?? undefined;
	const until = searchParams.get('until') ?? undefined;
	const errorTag = searchParams.get('errorTag') ?? undefined;
	const routedToParam = searchParams.get('routedTo');
	const routedTo =
		routedToParam === 'local' || routedToParam === 'agent' ? routedToParam : undefined;

	// queryInteractionLogs 无过滤参数时等价于 readInteractionLogs
	const logs = await queryInteractionLogs({
		limit,
		intent,
		since,
		until,
		errorTag,
		routedTo,
	});

	return ok({ logs, count: logs.length });
}
