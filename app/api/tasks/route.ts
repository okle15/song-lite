/**
 * /api/tasks —— ⑩ 触发器的 HTTP 面（排任务 / 看任务 / 取消任务）。
 *
 * 为什么任务要有自己的路由，而不是让工具直接改库：与 `/api/preferences` 同一个
 * 理由 —— agent 的工具一律用 HTTP 打自家 BFF（见 `agent/tools.ts` 的文件头），
 * 于是「agent 能排任务」与「将来前端能排任务」走的是同一条路径、同一套校验、
 * 同一个信封，不存在第二套入口各自漂移。
 *
 * ⚠️ **执行不在这里**，在 `/api/tasks/tick`。分开的理由是这两件事的失败语义
 * 完全不同（见下），混在一个路由里早晚会把它们揉成一种：
 *   - 本路由是**承诺**：用户说「明天早上提醒我」，排不上必须当场告诉他（400/500）；
 *   - tick 是**执行**：它可能因为网关抖动而失败，而任务应当**留着下次再试**。
 *
 * 校验分工沿用 `/api/preferences` 那条线：**规则的唯一出处是
 * `server/agent/tasks.ts` 的 `validateCreate`**（它返回一句人话或 null），
 * 路由只是**先问一句**好把参数错回成 400 而不是 500 —— 这个区别模型读得到：
 * 400（B1 的 `bad_request`）意思是"换个说法再来"，500 意思是"服务端坏了，原样重试"。
 * 两边各写一份校验的下场是同一个输入在一处被接受、在另一处被拒。
 */
import { cancelTask, createTask, listTasks, validateCreate } from '@/server/agent/tasks';
import { fail, ok } from '@/server/http';

export const dynamic = 'force-dynamic';

/** GET /api/tasks —— 没做的在前（按该做的时间），另附最近做过的几条。 */
export async function GET() {
	return ok(listTasks());
}

type PostBody = { goal?: unknown; dueAt?: unknown; repeat?: unknown; repeatDays?: unknown };

/**
 * POST /api/tasks —— 排一件任务。body `{ goal, dueAt, repeat?, repeatDays? }`。
 *
 * `dueAt` 用 ISO 8601 字符串（带时区或 `Z`）。**不接受自然语言**：「明天早上七点」
 * 的解析要是放在这里，就会有两份"现在几点"的算法（路由一份、模型一份），
 * 而它们对时区 / 夏令时的答案不会一致。模型那边看得到【现在几点】，
 * 让它自己算出 ISO —— 那是它的活。
 *
 * `repeat` 的 `weekly` **可以不带 `repeatDays`**，那就是"每周同一天"（由 `dueAt`
 * 落在星期几决定）；`repeatDays` 只在要指定多天（「每周一三五」）时才传，
 * 用 0=周日…6=周六。
 */
export async function POST(request: Request) {
	let body: PostBody;
	try {
		body = (await request.json()) as PostBody;
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const input = {
		goal: typeof body.goal === 'string' ? body.goal : '',
		dueAt: typeof body.dueAt === 'string' ? body.dueAt : '',
		repeat: body.repeat,
		repeatDays: body.repeatDays,
	};

	// 参数错 → 400（不是 500）：`fail` 会把 `code` 写成同一个 400。
	// 消息直接用 `validateCreate` 给的那句，于是"哪儿错了"只有一处措辞。
	const bad = validateCreate(input);
	if (bad) return fail(bad, 400);

	try {
		const task = createTask(input);
		return ok({ task }, 'scheduled');
	} catch (err) {
		// 走到这里说明是存储层的问题（磁盘满 / 权限）。**不吞**：排任务是承诺，
		// 失败必须让模型知道，否则它会说「记下了」而其实没排上（见 tasks.ts 文件头）。
		console.error('[tasks] failed to create:', err);
		return fail('任务排期写入失败', 500);
	}
}

type PatchBody = { id?: unknown };

/** PATCH /api/tasks —— 取消一件还没做完的任务。body `{ id }`。 */
export async function PATCH(request: Request) {
	let body: PatchBody;
	try {
		body = (await request.json()) as PatchBody;
	} catch {
		return fail('Invalid JSON body', 400);
	}
	const id = typeof body.id === 'string' ? body.id.trim() : '';
	if (!id) return fail('id is required', 400);

	try {
		// 取消一件已经做完的任务不算失败（`cancelled:false`）——那是"来晚了一步"，
		// 不是错误。返回布尔值而不是抛，让模型能如实说「那件已经做过了」。
		return ok({ id, cancelled: cancelTask(id) });
	} catch (err) {
		console.error('[tasks] failed to cancel:', err);
		return fail('任务取消失败', 500);
	}
}
