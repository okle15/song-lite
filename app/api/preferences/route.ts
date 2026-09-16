/**
 * /api/preferences —— ⑥ 记忆的 HTTP 面（读写用户偏好）。
 *
 * 为什么偏好要有自己的路由，而不是让工具直接改库：
 * agent 的工具一律用 HTTP 打自家 BFF（见 `agent/tools.ts` 的文件头）。好处是
 * **agent 与浏览器共用同一个 API 面**——将来前端加一个「管理我的偏好」面板，
 * 走的是同一条路径、同一套校验、同一个信封，不存在「第二套入口各自漂移」。
 *
 * 校验分工（这是本文件唯一值得看的地方）：
 *  - 形状与合法性（key 能不能用、value 空不空）在这里判，错就 400；
 *  - 「什么算同一条偏好」的归一化规则在 `contract/preference.ts`，
 *    存储层与工具侧共用，不在这里另写一份。
 * 存储层抛出的异常（磁盘满等）一律 500——**不吞掉**：写偏好是 agent 对用户的
 * 承诺，失败必须让它知道，否则它会说「我记住了」而其实没记住。
 */
import type { Preference } from '@/contract/preference';
import { MAX_INJECTED_PREFERENCES, normalizePreferenceKey } from '@/contract/preference';
import { listPreferences, removePreference, setPreference } from '@/server/agent/preference-log';
import { fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET /api/preferences?limit= —— 列出已记住的偏好（最近更新的在前）。 */
export async function GET(request: Request) {
	const raw = new URL(request.url).searchParams.get('limit');
	const limit = raw === null ? MAX_INJECTED_PREFERENCES : Number(raw);
	return ok({ preferences: listPreferences(limit) });
}

type PostBody = { key?: unknown; value?: unknown };

/** POST /api/preferences —— 记住一条偏好。body `{key, value}`，同 key 覆盖。 */
export async function POST(request: Request) {
	let body: PostBody;
	try {
		body = (await request.json()) as PostBody;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const key = normalizePreferenceKey(typeof body.key === 'string' ? body.key : '');
	if (!key) {
		return fail(
			'key 必须是英文小写标识（如 disliked_genre）——请换一个只含字母、数字、下划线的 key。',
			400,
		);
	}
	const value = typeof body.value === 'string' ? body.value.trim() : '';
	if (!value) return fail('value is required', 400);

	try {
		setPreference(key, value);
	} catch (err) {
		console.error('[preferences] failed to write:', err);
		return fail('偏好写入失败', 500);
	}
	const preference: Preference = { key, value };
	return ok({ preference }, 'remembered');
}

/** DELETE /api/preferences?key= —— 忘掉一条。删不存在的 key 不算失败（返回 removed:false）。 */
export async function DELETE(request: Request) {
	const key = normalizePreferenceKey(new URL(request.url).searchParams.get('key') ?? '');
	if (!key) return fail('key 无效', 400);
	try {
		return ok({ key, removed: removePreference(key) });
	} catch (err) {
		console.error('[preferences] failed to delete:', err);
		return fail('偏好删除失败', 500);
	}
}
