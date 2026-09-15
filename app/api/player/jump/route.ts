/**
 * Player jump route — 队列面板点击跳转到指定索引。
 *
 * 接收 `{ index }`，调用 player-state.jumpToIndex 切到队列中该位置的曲目。
 * 返回 400 如果 index 缺失/非数字，404 如果索引越界。
 */
import { jumpToIndex } from '@/server/player/state';
import { playerLogResult, playerPayload } from '@/server/player/payload';
import { recordLocalInteraction } from '@/server/records/interaction-log';
import { ok, fail } from '@/server/http';

export async function POST(request: Request) {
	const startedAt = Date.now();
	let body: { index?: unknown };
	try {
		body = await request.json();
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const index = typeof body.index === 'number' ? body.index : Number.parseInt(String(body.index ?? ''), 10);
	if (!Number.isInteger(index)) {
		return fail('index must be an integer', 400);
	}

	const updated = jumpToIndex(index);
	if (!updated) {
		return fail(`queue index out of range: ${index}`, 404);
	}

	void recordLocalInteraction({
		userInput: `jump ${index}`,
		intent: 'play',
		result: playerLogResult(updated, { jumpedFromIndex: index }),
		latency: Date.now() - startedAt,
	});

	return ok(playerPayload(updated, { withQueue: true }));
}
