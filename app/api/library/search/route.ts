/**
 * Library search route —— 薄适配层。
 *
 * 打分规则（原文子串 / 词典归一化标签 / 长期记忆微调）与空结果话术已迁到
 * `server/library/search.ts`（2026-09-10）：那是纯域逻辑，路由只负责
 * 「解析参数 → 调域逻辑 → 记录旁路日志 → 封装信封」。
 *
 * `GET /api/library/search?q=<query>&limit=<1..50>`，limit 默认 10、上限 50。
 */
import { searchLibrary } from '@/server/library/search';
import { recordLocalInteraction } from '@/server/records/interaction-log';
import { ok } from '@/server/http';

export async function GET(request: Request) {
	const startedAt = Date.now();
	const { searchParams } = new URL(request.url);
	const q = (searchParams.get('q') ?? '').trim().toLowerCase();
	const limitParam = searchParams.get('limit');
	const limit = limitParam ? Math.min(Math.max(Number.parseInt(limitParam, 10) || 10, 1), 50) : 10;

	const data = await searchLibrary(q, limit);

	void recordLocalInteraction({
		userInput: q,
		inputType: 'text',
		intent: 'search',
		result: { total: data.total, count: data.count },
		latency: Date.now() - startedAt,
	});

	return ok(data);
}
