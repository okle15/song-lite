/**
 * ⑩ 触发器 —— 「跨轮的目标」的持久化读写点（BLUEPRINT §2 的活跃区里最后一件空着的）。
 *
 * ── 为什么 ⑩ 值得做，以及它到底难在哪 ────────────────────────────────
 * 前面九件全是「用户说一句 → agent 做一件事」。⑩ 要的是「**没有人说话**的时候，
 * agent 也能做一件事」。`LEARNING.md §3.1` 已经把它的形状写清楚了：
 * 定时器是**加一层**就有的（`runAgent` 早就与 HTTP 解耦），真正要设计的是
 * **任务**这个概念 —— 跨轮，且跨轮意味着它必须落库：
 *
 *   - 「推到哪儿了」= 跨轮的状态 → 只有库能记住它；
 *   - 「下次该不该继续」= 一个判断 → 只有拿到上次的结果才谈得上判断。
 *
 * ── 定时器不在这里，这是有意的 ────────────────────────────────────
 * 本模块**没有 setInterval**，也刻意不提供。理由不是偷懒：
 *   1. `next dev` 热重载会重新求值模块 —— 定时器会越起越多；
 *   2. 多实例部署时每个进程各起一个 → 同一件事做 N 遍；
 *   3. 无状态部署里进程随时被回收，定时器本身就不该指望。
 * 所以 ⑩ 的最小正确形态是 **tick（外部打点）+ 原子认领**：谁打点都行
 * （cron / `npm run tasks:tick` / 一个按钮），**正确性由认领保证，而不是由
 * "只有一个人在打点"这个假设保证**。假设会破，认领不会。
 *
 * ── 三处不写对就不报错的地方（本文件的全部价值所在）──────────────────
 *
 * 1. **认领必须是原子的**（`claimDueTask`）。写成「查出来 → 改状态」两步，
 *    两个 tick 恰好同时进来就会各查到同一条、各改一次、各跑一遍 ——
 *    对用户的观感是「它怎么把同一句话说两遍」，而**没有任何日志会显示异常**。
 *    所以真正的闸门是 `UPDATE ... WHERE id=? AND status='pending'` 之后
 *    看 `changes` 是不是 1（先查只是为了知道该改谁）。
 *
 * 2. **认领之后跑挂了，任务会永远卡住**（`RECLAIM_AFTER_MS`）。进程被 kill、
 *    网关把请求挂死、机器断电 —— 那条行留在 `running`，而 `claimDueTask` 只认
 *    `pending`，于是这件任务**再也不会被执行**，也不会有任何提示。
 *    所以认领前先做一次「租约过期回收」：`running` 且 `last_run_at` 太旧的，
 *    放回 `pending`。这是 ⑩ 里唯一一处"必须主动认错"的地方。
 *
 * 3. **重复任务的补跑不能堆积**。放了两天没跑，直接 `due_at += 1 天` 会让它
 *    连续触发两次 —— 而"补跑"从来不是用户想要的（他要的是"每天这时候"),
 *    堆积的补跑是灾难（连着放两遍歌）。所以推进 due_at 时要**推到未来为止**。
 *    ⚠️ `weekly`（2026-09-23 加，BLUEPRINT §9 的"只在某几天"）比 daily 多一层：
 *    推完还要**星期也对**才算落点。两个条件写在同一个循环里（`nextRepeatDue`），
 *    分开写早晚会漂成两种"下一次"。
 *
 * ── 一个刻意留下的取舍：重复任务失败一次就停 ───────────────────────
 * `finishTask` 里，`repeat !== 'none'` 的**只在成功时**回到 `pending`；失败则落
 * `failed` 并结束系列。也就是说「每天早上放首歌」某天没做成，**明天不会再试**。
 *
 * 两种做法都有代价，这里选的是"停下来让人看见"：
 *   - 若失败也重排：一件**永久坏掉**的任务（那首歌被移出曲库了）会每天烧一整轮
 *     对话的钱，一直到用户偶然想起来才停 —— 而它每天都在 `pending`/`failed` 之间循环，
 *     没有一个时刻是"需要人管"的样子。
 *   - 停下来的代价：一次网络抖动就让"每天的承诺"断了。
 * 选后者的理由是本项目一贯的那条：**不确定就让它大声**。停掉之后它落在 `closed`
 * 里、带 `last_error`，模型答得出「那天早上没做成」；而继续重试的那条路径
 * **恰恰是最难被发现的一种花钱方式**。
 * ⚠️ 这是个可以被推翻的取舍，不是"本来就该这样"：想让系列继续，改成
 * `input.ok || task.repeat === 'daily'` 即可 —— 但在那之前先想清楚上面第一个代价。
 *
 * ── 失败语义：抛，不是 log ─────────────────────────────────────────
 * 沿用 §7 那条纪律「每加一张表先问：它失败时，谁需要知道」。
 * ⑩ 与 ⑥ `preferences` 同类，**不是**与 `agent_turns` 同类：用户说「明天早上
 * 提醒我放歌」，任务没排上他会一直干等 —— 这不是"少一行统计"，是**对用户的承诺
 * 没兑现**。所以写失败必须抛到路由 → 工具返回失败 → 模型如实告诉他。
 */
import type { Task, TaskRepeat, TaskStatus } from '../../contract/task';
import { getDb } from '../db';

/**
 * 形态与「重复方式怎么念」都在 `contract/task.ts` —— 它有**三个消费方**
 * （服务端 / 模型 / 浏览器卡片），后两个不许 import `server/`。
 * 这里 re-export 只为不打断既有调用方（单测、路由都从本模块取类型）。
 */
export type { Task, TaskRepeat, TaskStatus };

/** 目标那句话的长度上限。任务不是文档，超过就该拆成两件。 */
const GOAL_MAX = 300;
/** 结论入库前截断（`messages` 里有全文）。 */
const RESULT_MAX = 500;

/**
 * 租约时长：`running` 超过它就视为「认领的人已经死了」，放回 `pending`。
 *
 * 取 10 分钟而不是 1 分钟：一轮真实对话 7–14 秒（实测），而网关卡死时
 * 可能挂到几十秒；太短会把**正在跑**的任务抢回来，于是同一件事并行跑两遍 ——
 * 那正是认领要防的事，用租约把它从常规路径上引回来。
 */
const RECLAIM_AFTER_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** 列表里最多回几件"没做的"与几件"做过的"。 */
const OPEN_LIMIT = 20;
const CLOSED_LIMIT = 5;

/** SQL 行的原始形状（`node:sqlite` 返回的键名就是列名）。 */
type RawTaskRow = {
	id: string;
	goal: string;
	due_at: string;
	repeat: string;
	/** JSON 数字数组；NULL = 后加这一列之前的老行，或 none / daily。 */
	repeat_days: string | null;
	status: string;
	attempts: number;
	last_error: string | null;
	result: string | null;
	created_at: string;
	last_run_at: string | null;
};

const STATUSES = new Set<TaskStatus>(['pending', 'running', 'done', 'failed', 'cancelled']);

function toTask(row: RawTaskRow): Task {
	return {
		id: row.id,
		goal: row.goal,
		dueAt: row.due_at,
		repeat: row.repeat === 'daily' ? 'daily' : row.repeat === 'weekly' ? 'weekly' : 'none',
		repeatDays: parseRepeatDays(row.repeat_days),
		status: STATUSES.has(row.status as TaskStatus) ? (row.status as TaskStatus) : 'pending',
		attempts: row.attempts,
		lastError: row.last_error,
		result: row.result,
		createdAt: row.created_at,
		lastRunAt: row.last_run_at,
	};
}

/* ── 重复规则：「哪几天」的解析与规范化（导出是给单测 + 路由用）───── */

/** 0=周日…6=周六，与 `Date.getDay()` 一致（`agent/tools.ts` 的 `WEEKDAYS` 同序）。 */
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * `repeat_days` 列（JSON 数组）→ 数字数组。**坏值一律读成"没有指定"**，不抛。
 *
 * 读取侧为什么不抛、也不"救回能认的那几个"：这一列只可能是我们自己写进去的，
 * 出现坏值说明库被人手工改过、或来自更早的版本 —— 而"读一份任务清单"不该因为一行
 * 脏数据整个失败（同 `turn-log.ts` 的 `recentTurns` 跳过坏行）。退化成"没有指定"
 * 之后，`weekly` 会按 `dueAt` 的星期走（见 `nextRepeatDue`），**方向是安全的：
 * 宁可少跑一天，不会多跑一天**。挑几个认得的留下来反而会让"这行说的是哪几天"
 * 变成一个静默的近似值。
 */
export function parseRepeatDays(raw: unknown): number[] {
	if (typeof raw !== 'string' || raw.trim() === '') return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	// 复用写入侧那份校验（去重 + 升序），于是 `Task.repeatDays` 的"升序"不变量
	// 对**任何**一行都成立 —— 读的人不必先想"这行是正常的吗"。
	return normalizeRepeatDays(parsed) ?? [];
}

/**
 * 校验并规范化调用方给的"哪几天"：去重 + 升序。返回 `null` = **形状不对**
 * （不是数组 / 有非整数 / 越界），由调用方决定怎么报错。
 *
 * **升序是承重的**：它进提示词与工具返回值（「每周一三五」），也进落点判断。
 * 不排序的话 `[5,1]` 与 `[1,5]` 是同一个意思却长得不一样 —— 而"星期落在集合里"
 * 这个判断两侧写法不同不会报错，只会让"我明明设了周五"读起来像假的。
 *
 * 写入侧为什么是 `null` 而不是"滤掉坏的那几个"：滤掉之后模型拿到的是一句
 * 「已排期，每周一重复」——它以为自己传的 `[1, 'x', 3]` 被接受了。参数错要让它
 * 看得见（路由 → 400 → B1 的 `bad_request`），它才会换个说法重来。
 *
 * 用一个返回值而不是抛，是因为它有两个调用方：路由拿它判 400，`createTask` 拿它
 * 判该不该入库 —— 两边都自己写一遍就是两处会漂移的校验。
 */
export function normalizeRepeatDays(input: unknown): number[] | null {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) return null;
	const out = new Set<number>();
	for (const d of input) {
		if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) return null;
		out.add(d);
	}
	return [...out].sort((a, b) => a - b);
}

/**
 * 调用方给的 `repeat` → 三档之一。**不认识的值返回 `null`，不静默回落到 `none`**。
 *
 * 静默回落看起来"宽容"，实际是把一个错误变成了一个错误的承诺：模型传
 * `repeat: 'weekly'` 而这里当月一次的 `none` 处理，用户要的是"每周一放歌"，
 * 得到的却是"就这一次"——而且**排期工具的返回值会念回"已排期"**，没人看得出差别。
 * 拿不准就让调用方报错（路由 → 400 → B1 的 `bad_request` → 模型换个说法重试）。
 */
export function parseRepeat(input: unknown): TaskRepeat | null {
	if (input === undefined || input === null || input === '') return 'none';
	return input === 'none' || input === 'daily' || input === 'weekly' ? input : null;
}

/* ── 时间：三个纯函数（导出是给单测用）───────────────────────────── */

/** `dueAt` 解析失败时抛 —— 静默回落到"现在"会让任务立刻执行，那是灾难性的默认值。 */
export function parseDueAt(dueAt: string): number {
	const t = new Date(dueAt).getTime();
	if (!Number.isFinite(t)) throw new Error(`dueAt 不是合法时间：${dueAt}`);
	return t;
}

/**
 * 重复任务的**下一次** `due_at`：从原定时间往后推整天，推到
 * 「**落在未来** 且 **星期也对**」为止。
 *
 * 两个条件必须写在同一个循环里。写成"先推星期、再推未来"两段的话，
 * 第二段会把第一段推出来的落点跨过去（推到明天就不是周一了）——而且它**不报错**，
 * 只是"每周一"从第二周起变成了"每周二"。
 *
 * `daily` = 七天全允许，于是退化成原来那个"推到未来为止"的循环（同一份实现，
 * 不是两份）。**`weekly` 而没指定星期** = 每周同一天，由 `dueAt` 自己的星期决定 ——
 * 这是「每周一早上七点」最常见的形态，不该逼调用方再传一次星期几。
 *
 * ⚠️ **星期几按服务端本地时区算**（`getDay()` 就是本地时区）。这不是随便选的：
 * `dueAt` 是模型照着提示词里【现在：…，周四】那一行算出来的 ISO，用的是**同一个**
 * 时区。换个时区来判星期，就会出现"模型按周四排的，系统按周三算"这种谁都没错的错。
 */
export function nextRepeatDue(
	repeat: TaskRepeat,
	dueAt: string,
	days: readonly number[],
	now: Date,
): string {
	const allowed: readonly number[] =
		repeat === 'daily'
			? ALL_DAYS
			: days.length > 0
				? days
				: [new Date(parseDueAt(dueAt)).getDay()];

	let t = parseDueAt(dueAt);
	const limit = now.getTime();
	// 上界只是防御（坏数据 + 死循环），正常情况下几步就出循环
	for (let i = 0; i < 400 && (t <= limit || !allowed.includes(new Date(t).getDay())); i++) {
		t += DAY_MS;
	}
	return new Date(t).toISOString();
}

/**
 * `daily` 的那一格 —— 保留这个入口，因为**"每天"是用户嘴里的话**，
 * 判据里出现它比出现 `nextRepeatDue('daily', …)` 更像那件事本身（旧调用点不动）。
 */
export function nextDailyDue(dueAt: string, now: Date): string {
	return nextRepeatDue('daily', dueAt, [], now);
}

/** 这件任务现在该不该做。**判据只有时间**——"该不该做"是模型的活，不是这里的。 */
export function isDue(task: Task, now: Date): boolean {
	return task.status === 'pending' && parseDueAt(task.dueAt) <= now.getTime();
}

/* ── 写 ─────────────────────────────────────────────────────────── */

export type CreateTaskInput = {
	goal: string;
	dueAt: string;
	/** 缺省 = `none`。**传了不认识的值会抛**（不静默回落，见 `parseRepeat`）。 */
	repeat?: unknown;
	/** 只有 `weekly` 用得上；其余档位一律丢掉（理由见下面 `createTask`）。 */
	repeatDays?: unknown;
};

/**
 * 排期参数哪里不对（一句人话），全对就返回 `null`。
 *
 * 这是**校验规则的唯一出处**：路由拿它决定 400，`createTask` 拿它决定抛什么。
 * 两边各写一遍的代价不是重复，是**同一个输入在一处被接受、在另一处被拒** ——
 * 而模型从 HTTP 状态码里读到的"要不要换个说法重试"（B1 的 `bad_request` 与
 * `unavailable`）恰恰就来自这里。参数错报成 500，它会以为是服务端坏了、原样重试。
 */
export function validateCreate(input: CreateTaskInput): string | null {
	const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
	if (!goal) return 'goal 不能为空';
	if (goal.length > GOAL_MAX) return `goal 过长（上限 ${GOAL_MAX} 字）`;

	try {
		parseDueAt(String(input.dueAt));
	} catch {
		return `dueAt 不是合法时间：${String(input.dueAt)}`;
	}

	if (parseRepeat(input.repeat) === null) {
		return `repeat 只能是 none / daily / weekly，收到 ${JSON.stringify(input.repeat)}`;
	}
	if (normalizeRepeatDays(input.repeatDays) === null) {
		return 'repeatDays 必须是 0–6 的整数数组（0=周日）';
	}
	return null;
}

/**
 * 排一件任务。**失败抛**（见文件头的失败语义）。
 *
 * 校验放在这里而不是路由：`goal` 为空、`dueAt` 不是时间的任务一旦入库，
 * 就成了一条**永远触发不了或触发就崩**的脏数据，而它躺在表里没有任何提示。
 * 路由那边只是**先问一句**（`validateCreate` 返回非 null 就 400），
 * 规则本身只有上面那一份。
 */
export function createTask(input: CreateTaskInput, now: Date = new Date()): Task {
	const bad = validateCreate(input);
	if (bad) throw new Error(bad);

	const goal = input.goal.trim();
	const dueAt = new Date(parseDueAt(String(input.dueAt))).toISOString();
	// `validateCreate` 刚判过，这两个不可能为 null。**用抛而不是回落**：
	// `?? 'none'` 会在有人改坏上面那条校验时，把"参数错了"静默变成"一次性的任务"——
	// 那正是 `parseRepeat` 的注释里说的那种错（用户要"每周一"，得到"就这一次"）。
	const repeat = parseRepeat(input.repeat);
	const days = normalizeRepeatDays(input.repeatDays);
	if (repeat === null || days === null) throw new Error('排期参数校验与解析不一致（内部错误）');
	// 非 weekly 的档位丢掉 days（留着会让行里长出"一次性的任务却带着星期"这种
	// 自相矛盾的状态）；weekly 没说哪一天 = 每周同一天，就在**建表这一刻**按
	// `dueAt` 的星期补上 —— 让这一行自己说清"到底是哪几天"。
	const repeatDays =
		repeat === 'weekly' ? (days.length > 0 ? days : [new Date(dueAt).getDay()]) : [];

	// ⚠️ **第一个落点也要「推到未来为止」**（2026-09-23 实测补上）。`finishTask` 早就是
	// 这么推的，只有**建表那一刻**没有 —— 于是留了一个洞：模型把「每周一早上七点」算成
	// 过去的某个周一（实测两遍都算错了月份/年份，而 `getDay()` 恰好是对的，所以上面那些
	// 校验一条都拦不住），任务依然落库成功、状态 `pending`、`due_at` 在过去 →
	// **下一次 tick 立刻执行**：用户听到一首自己没要的歌，而全程零报错。
	// 规则要有单一出处，所以直接复用 `nextRepeatDue`，而不是在这里再写一个「推到未来」。
	// 一次性的任务（`none`）**刻意不推**：「已经晚了就现在做」正是用户要的。
	const firstDueAt =
		repeat !== 'none' && parseDueAt(dueAt) <= now.getTime()
			? nextRepeatDue(repeat, dueAt, repeatDays, now)
			: dueAt;

	const task: Task = {
		id: crypto.randomUUID(),
		goal,
		dueAt: firstDueAt,
		repeat,
		repeatDays,
		status: 'pending',
		attempts: 0,
		lastError: null,
		result: null,
		createdAt: now.toISOString(),
		lastRunAt: null,
	};

	getDb()
		.prepare(
			`INSERT INTO tasks (id, goal, due_at, repeat, repeat_days, status, attempts,
				last_error, result, created_at, last_run_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			task.id,
			task.goal,
			task.dueAt,
			task.repeat,
			task.repeatDays.length > 0 ? JSON.stringify(task.repeatDays) : null,
			task.status,
			task.attempts,
			task.lastError,
			task.result,
			task.createdAt,
			task.lastRunAt,
		);
	return task;
}

/** 取一件。不存在返回 null（不抛——"查不到"是正常结果，不是异常）。 */
export function getTask(id: string): Task | null {
	const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as
		| RawTaskRow
		| undefined;
	return row ? toTask(row) : null;
}

/**
 * 把租约过期的 `running` 放回 `pending`。返回放回了哪几件（给调用方打日志）。
 *
 * 有返回值的理由：**这是一次"修好了什么"的动作**，而它平时的输出是零。
 * 没有返回值的话，「回收了一件事」与「什么都没发生」在日志里长得一样
 * （同 `api-smoke` 里那条"还原现场也是一条用例"的教训）。
 */
export function reclaimStaleRuns(now: Date = new Date()): string[] {
	const cutoff = new Date(now.getTime() - RECLAIM_AFTER_MS).toISOString();
	const db = getDb();
	const rows = db
		.prepare(`SELECT id FROM tasks WHERE status = 'running' AND (last_run_at IS NULL OR last_run_at < ?)`)
		.all(cutoff) as unknown as { id: string }[];
	if (rows.length === 0) return [];
	const stmt = db.prepare(
		`UPDATE tasks SET status = 'pending', last_error = ? WHERE id = ? AND status = 'running'`,
	);
	const ids: string[] = [];
	for (const row of rows) {
		const res = stmt.run('上一次执行没有收尾（进程被杀或网关挂死），已放回待执行', row.id);
		if (res.changes === 1) ids.push(row.id);
	}
	return ids;
}

/**
 * 认领一件到期的任务。**这是整个 ⑩ 的关键函数**，没有之一。
 *
 * 返回 null 表示"这一刻没有到期任务"或"被别人抢先认领了"——两种情形对调用方
 * 是同一件事（这一轮没我干的活），所以不区分。
 *
 * 为什么不能只写一个 `UPDATE`：`UPDATE` 能一次改一批，但改完不知道改的是谁。
 * 所以顺序是「先查 id → 再带条件改」，而**原子性由 UPDATE 的 WHERE 保证**：
 * 两个人同时查到同一个 id，只有一个人的 `changes` 会是 1。
 */
export function claimDueTask(now: Date = new Date()): Task | null {
	reclaimStaleRuns(now);

	const db = getDb();
	const nowIso = now.toISOString();
	const picked = db
		.prepare(
			`SELECT id FROM tasks WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 1`,
		)
		.get(nowIso) as unknown as { id: string } | undefined;
	if (!picked) return null;

	const res = db
		.prepare(
			`UPDATE tasks SET status = 'running', attempts = attempts + 1, last_run_at = ?
			 WHERE id = ? AND status = 'pending'`,
		)
		.run(nowIso, picked.id);
	if (res.changes !== 1) return null; // 有人抢先了
	return getTask(picked.id);
}

export type FinishInput = { ok: boolean; result?: string | null; error?: string | null };

/**
 * 一轮执行算不算完成 —— **收尾判据**（纯函数，导出给单测）。
 *
 * ── 为什么「没抛异常」不够 ──────────────────────────────────────────
 * `finishTask` 原来只收 `{ ok: !error }`，即"有没有抛异常"。而**没抛异常不等于做成了**。
 * 2026-09-23 端到端实测撞到的样子：模型连调 5 步工具、撞上 `MAX_STEPS` 被掐，
 * 一个字的结论都没留下 —— 而 `text` 是 `"\n\n"`，`if (text)` 判定为真，于是任务记成
 * `done`、`result` 存了两个换行。
 *
 * 对用户的后果是**一句话没有任何东西支撑**：他问「我那件事做了吗」，模型照着
 * `result` 回答「做了」——而库里那两行换行就是它的全部依据。更坏的是这件事
 * **不可能被发现**：状态是 `done`、没有 `last_error`、也没有异常。
 *
 * ── 判据为什么是「有没有留下一句话」 ────────────────────────────────
 * 不用"有没有副作用"：工具副作用在这里看不见（它们全是打 BFF 的 HTTP 调用），
 * 要看得见就得把每个工具的语义搬进收尾逻辑，那是把 ③ 抄一遍。
 * 而"留下一句能读的结论"是这个任务的**契约**：唤醒语里明写了
 * 「把它做完，然后用一句话说结果」。所以它没留下话，就不是"做完了"。
 *
 * 两条失败原因分开写：**被截断**是最常见也最可诊断的一种（它一直在调工具、
 * 没来得及收尾——通常意味着那句话本身没写清楚，或曲库里满足不了），
 * 与"一个字都没回"（网关给了空回复）该分开看。
 */
export function finishOutcome(input: {
	text: string;
	error: string | null;
	truncated: boolean;
}): FinishInput {
	// 抛了异常：原因就是它，如实记。（这条先判——`text` 可能是半截的。）
	if (input.error) return { ok: false, result: null, error: input.error };

	const text = input.text.trim();
	if (text) return { ok: true, result: text, error: null };

	return {
		ok: false,
		result: null,
		error: input.truncated
			? '到点没做成：一直在调工具，撞上 MAX_STEPS 被截断，没留下结论'
			: '到点没做成：这一轮一个字都没回',
	};
}

/**
 * 收尾一件任务：记结论 + 决定它还有没有下一次。
 *
 * `repeat !== 'none'` 时**回到 pending 并推进 due_at**（推到未来为止，见
 * `nextRepeatDue`）——注意是回到 `pending` 而不是新建一行：同一件"每天/每周的事"
 * 在库里始终是同一行，`attempts` 才是它跑过几次的完整痕迹。
 *
 * ⚠️ 一定要在 `finally` 里调它。中间任何一步抛出去而没走到这里，那件任务会
 * 卡在 `running`，要等租约超时（10 分钟）才被回收 —— 而"卡 10 分钟"对用户
 * 就是「它没反应」。
 */
export function finishTask(id: string, input: FinishInput, now: Date = new Date()): Task | null {
	const db = getDb();
	const task = getTask(id);
	if (!task) return null;

	const nowIso = now.toISOString();
	const result = input.result?.slice(0, RESULT_MAX) ?? null;
	const error = input.error?.slice(0, RESULT_MAX) ?? null;

	if (input.ok && task.repeat !== 'none') {
		db.prepare(
			`UPDATE tasks SET status = 'pending', due_at = ?, result = ?, last_error = NULL,
				last_run_at = ?
			 WHERE id = ?`,
		).run(nextRepeatDue(task.repeat, task.dueAt, task.repeatDays, now), result, nowIso, id);
	} else {
		db.prepare(
			`UPDATE tasks SET status = ?, result = ?, last_error = ? WHERE id = ?`,
		).run(input.ok ? 'done' : 'failed', result, error, id);
	}
	return getTask(id);
}

/** 取消一件还没做完的任务。返回是否真的改到了（已经做完的取消不了，也不是错误）。 */
export function cancelTask(id: string): boolean {
	const res = getDb()
		.prepare(`UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'running')`)
		.run(id);
	return res.changes === 1;
}

/* ── 读 ─────────────────────────────────────────────────────────── */

/**
 * 给模型看的任务清单：**没做的在前（按该做的时间升序），做过的取最近几条**。
 *
 * 为什么不给全量：这和 ⑥ 偏好为什么全量注入是同一道算术的反面 —— 偏好是
 * 「少量、长期」，而任务是「做完就走」。让已完成的 200 条挤进来，模型每次
 * 都要在噪声里找"还没做的那两件"，而它每次只能看那么多。
 *
 * 为什么还要带几条做完的：模型需要回答「你昨天那件事做了吗」。
 * 只报未完成的话，它会答"没有这件事"——而那是**答错**，不是"没信息"。
 */
export function listTasks(): { open: Task[]; closed: Task[] } {
	const db = getDb();
	// ⚠️ 两个 `ORDER BY` 后面的 `rowid` 不是装饰：时间列**会撞车**（同一轮 tick
	// 里排的两件 `due_at` 可能一样；一次性任务收尾时不改 `last_run_at`，于是同批
	// 完成的那几件时间完全相同），而撞车之后 SQLite 给的顺序是**不保证**的 ——
	// 表现是"同一个库，两次请求给出两份不同顺序的清单"，比对历史时看起来像随机。
	// 与 `summarizeTags` 要求排序稳定是同一条纪律。`rowid` 反映入库先后，
	// 拿它兜底既确定、又与"后来的更该被看到"一致。
	const open = db
		.prepare(
			`SELECT * FROM tasks WHERE status IN ('pending', 'running')
			 ORDER BY due_at ASC, rowid ASC LIMIT ?`,
		)
		.all(OPEN_LIMIT) as unknown as RawTaskRow[];
	const closed = db
		.prepare(
			`SELECT * FROM tasks WHERE status IN ('done', 'failed', 'cancelled')
			 ORDER BY COALESCE(last_run_at, created_at) DESC, rowid DESC LIMIT ?`,
		)
		.all(CLOSED_LIMIT) as unknown as RawTaskRow[];
	return { open: open.map(toTask), closed: closed.map(toTask) };
}
