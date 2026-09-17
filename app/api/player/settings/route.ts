/**
 * /api/player/settings —— 音量与播放方式的 HTTP 面。
 *
 * 这两个东西从前**纯前端**（`localStorage` + `window` 事件，见
 * `components/player-events.ts`），后果是 agent 既看不见（答不了「现在多大声」
 * 「是不是单曲循环」）、也改不动（说了「小声点」只能回一句做不到）。
 *
 * 这里不搬家、只**镜像**：真相仍在设备侧（音量是这台浏览器的音量、循环方式是
 * 这台设备的播放习惯），服务端这份存在的唯一理由是让它能进 ⑦ 的系统提示词、
 * 并被工具改写。所以：
 *   本机改动 → 前端随口上报一次（`player-events.ts` 的 `reportSettings`）
 *   服务端改动 → 走既有的「改状态 → SSE 广播 → 前端跟上」
 * 两条路都是同一个状态、同一个端点，不存在「谁说了算」的歧义。
 *
 * 参数单位：`volume` 是 **0–1**（与 `HTMLAudioElement.volume`、与快照一致），
 * 越界夹紧而不报错——前端拖到边缘时给的是 0 或 1，不值得为它抛 400。
 * 面向用户的百分数（「小声点」）由工具在那一侧换算，路由这层只认底层单位。
 */
import { getPlayerState, setPlayback, setVolume } from '@/server/player/state';
import { playerPayload } from '@/server/player/payload';
import { ok, fail } from '@/server/http';
import type { PlaybackMode } from '@/contract/player';

export const dynamic = 'force-dynamic';

const MODES: readonly PlaybackMode[] = ['seq', 'rpt', 'one'];

/**
 * GET /api/player/settings —— 读当前的音量与播放方式。
 *
 * 与 POST 对称，用途很具体：**让改动方能把现场还原回去**（`scripts/api-smoke.mjs`
 * 会改一次音量验证写入，跑完必须还原——把用户的音量留在 42% 是那种没人看得出来
 * 的副作用）。前端不需要它，SSE 已经在推同一份数据。
 */
export function GET() {
	return ok(playerPayload(getPlayerState()));
}

type Body = { volume?: unknown; mode?: unknown; shuffle?: unknown };

export async function POST(request: Request) {
	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const hasVolume = body.volume !== undefined;
	const hasMode = body.mode !== undefined;
	const hasShuffle = body.shuffle !== undefined;
	if (!hasVolume && !hasMode && !hasShuffle) {
		return fail('至少要给 volume / mode / shuffle 中的一个', 400);
	}

	let volume: number | undefined;
	if (hasVolume) {
		if (typeof body.volume !== 'number' || !Number.isFinite(body.volume)) {
			return fail('volume 必须是 0–1 的数字', 400);
		}
		volume = Math.min(1, Math.max(0, body.volume));
	}

	let mode: PlaybackMode | undefined;
	if (hasMode) {
		if (typeof body.mode !== 'string' || !MODES.includes(body.mode as PlaybackMode)) {
			return fail(`mode 只能是 ${MODES.join(' / ')}`, 400);
		}
		mode = body.mode as PlaybackMode;
	}

	if (hasShuffle && typeof body.shuffle !== 'boolean') {
		return fail('shuffle 必须是 true / false', 400);
	}

	// 只改给了的字段。**不能写成「先全量设一遍」**：`setVolume(volume ?? 0)` 这种
	// 写法在只改模式时会把音量静默归零 —— 调用方只想改一件事，另一件被顺手动掉。
	let updated = getPlayerState();
	if (volume !== undefined) updated = setVolume(volume);
	if (mode !== undefined || typeof body.shuffle === 'boolean') {
		updated = setPlayback({
			mode,
			shuffle: typeof body.shuffle === 'boolean' ? body.shuffle : undefined,
		});
	}
	return ok(playerPayload(updated), 'settings updated');
}
