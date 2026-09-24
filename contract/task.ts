/**
 * 任务（⑩ 触发器）的**共享事实**：形态 + 把重复方式译成人话的那一个函数。
 *
 * 为什么在 `contract/` 而不是 `server/agent/tasks.ts`：
 * 「一件任务长什么样」有**三个消费方** —— 服务端（读写库）、模型（工具的返回值）、
 * 浏览器（任务卡片）。后两个都不许 import `server/`（依赖方向见 AGENTS.md），
 * 于是共享的那部分只能待在 contract。理由与 `contract/player.ts`（播放状态的形状）
 * 完全一样：**它是事实，不是某一层的实现细节。**
 *
 * ⚠️ `agent/tools.ts` 里仍有它自己的一份 `TaskRow` —— 那是**刻意的**，不要合并过来：
 * 工具是 HTTP 客户端，它该认的是**响应体**（什么字段、什么类型），那是 BFF 的契约，
 * 不是共享事实。**但 `repeatLabel` 必须同源**：模型念回去的「每周一重复」和用户
 * 在卡片上看到的「每周一」，要是同一句话——两处各写一份，漂移的那个不会报错，
 * 只会让用户觉得"它记错了"。
 */

/** 一件任务的状态。`running` = 已被某次 tick 认领、还没收尾。 */
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * 重复方式三档。
 *
 * `weekly` **可以指定"哪几天"**（`repeatDays`）；只做一天时它由 `dueAt` 的星期
 * 决定，所以调用方不必再传一遍（见 `createTask`）。参数错（不认识的值）在写入侧
 * 一律拒绝，不许回落 —— 把一个错参数悄悄变成另一个合理的值，就是「用户要每周、
 * 系统给了一次，而工具照样念『已排期』」。
 */
export type TaskRepeat = 'none' | 'daily' | 'weekly';

/** 一件任务。字段名与建表一一对应（`server/db.ts` 里的 `tasks`）。 */
export type Task = {
	id: string;
	/** 模型自己写下的那句话：用户想让它做到什么。 */
	goal: string;
	/** 该做的时间（ISO）。 */
	dueAt: string;
	repeat: TaskRepeat;
	/**
	 * `weekly` 的"哪几天"（0=周日…6=周六，去重升序）。
	 * `none` / `daily` 恒为空数组；`weekly` **恒非空** —— 调用方没说哪天时，
	 * 建表那一刻就按 `dueAt` 的星期补上一个（"每周一"不必再传一遍 `1`）。
	 * 于是读这一行的人不必猜"空代表哪天"。
	 */
	repeatDays: number[];
	status: TaskStatus;
	/** 认领过几次。**它同时是"卡住过几次"的痕迹**（每次租约回收都会 +1）。 */
	attempts: number;
	lastError: string | null;
	/** 上次执行的一句话结论（给用户看的那句）。 */
	result: string | null;
	createdAt: string;
	lastRunAt: string | null;
};

/** 人话里的星期。索引与 `Date.getDay()` 同序（0=周日）。 */
const DAY_CHARS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 把 `repeat` / `repeatDays` 译成一句人话的**标签**：
 * `每天` / `每周一三五` / `''`（只做一次）。
 *
 * 它存在的理由是**把服务端理解成的东西念回去**：模型自己推的 `dueAt` 与它嘴上说的
 * 「每周一」是不是同一件事，只有在返回值里看见才算核对过一遍。少念一档
 * （比如 daily 与 weekly 都不说）时，模型会以为"排上了"就是"按我要的频率排上了"，
 * 而那两种频率差了七倍。
 *
 * 只给标签、不给整句，是因为它有两个读法：排期成功后念回「，每周一重复」，
 * 列清单 / 卡片上贴在时间后面「（每周一）」—— 一句话写死在一处，另一处就只能再写一遍。
 */
export function repeatLabel(repeat: TaskRepeat, days: number[] | undefined): string {
	if (repeat === 'daily') return '每天';
	if (repeat !== 'weekly') return '';
	const list = days ?? [];
	// 认不出的下标给 `?`，而不是悄悄跳过：跳过的结果是「每周一三五」显示成「每周一五」，
	// 少一天却看不出少 —— 与 `sanitizeLayout` 丢未知卡片时留下痕迹同一个道理。
	return list.length > 0 ? `每周${list.map((d) => DAY_CHARS[d] ?? '?').join('')}` : '每周';
}
