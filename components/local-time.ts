/**
 * 「把 ISO 串给人看」的唯一出处。
 *
 * 为什么要有这个模块：`TasksCard`（排期，看的是**将来**）与 `HistoryCard`
 * （播放历史，看的是**过去**）都要把服务端给的 ISO 串摆到界面上。各写一份的话，
 * 改一次格式要同步两处 —— 「同一份规则两处实现」正是 BLUEPRINT §7 错题本里
 * `normalizeTags` / `normalizePreferenceKey` 那两条记的腐化方式。
 *
 * **但刻意不合并成一个带 flag 的函数**：两者的需求真的不同。
 *  - 排期要一个**不会动的锚**（"09-24 周四 07:00"）—— 用户要拿它跟自己的日历对，
 *    所以「星期几」必须露出来，相对说法（"下周"）在这里是有害的；
 *  - 历史要的是**相对距离**（"昨天 21:04"）—— 「我最近听了什么」是个接近感的问题，
 *    每周一都排满「周四 07:00」反而看不出远近。
 * 所以是两个导出，各自承担一种需求，而不是一个函数加一堆开关。
 *
 * 两条共同的纪律：
 *  1. **一律按浏览器本地时区渲染**（`Date` 的 getter 就是本地时区）。服务端存的是
 *     ISO（带 Z），到人眼前这一步才换算，中间不掺任何手写的时区偏移。
 *  2. **脏值原样返回**，不编一个时间出来 —— 编出来的时间和真的长得一模一样。
 */

/** 解析失败返回 null（而不是抛）：调用方要的是「还能不能显示」，不是异常处理。 */
function parseIso(iso: string): Date | null {
	const at = new Date(iso);
	return Number.isNaN(at.getTime()) ? null : at;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:mm`。手写而不用 `Intl`：数字部分不该随运行环境的 locale 变。 */
function clock(at: Date): string {
	return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** `MM-DD`。 */
function dayMonth(at: Date): string {
	return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** `YYYY-MM-DD`。 */
function fullDay(at: Date): string {
	return `${at.getFullYear()}-${dayMonth(at)}`;
}

/**
 * 本地日历日的整数序号（跨年也单调）。
 *
 * ⚠️ 「昨天」必须按**日历日**判，不能按「相差不到 24 小时」判：
 * 23:30 与次日 00:10 只差 40 分钟，却是两个不同的日子；反过来，今天 08:00 与
 * 昨天 09:00 差 23 小时，也是两天。用小时差当判据的话，凌晨那几个小时里
 * 「昨天听的歌」会被显示成「今天」——而这条**不会报错**，只是让人以为
 * 自己刚才听过。
 */
function dayIndex(at: Date): number {
	return Math.floor(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / 86_400_000);
}

/**
 * 排期时间给人看的样子：`09-24 周四 07:00`。
 *
 * 用的是**同一个时区**（本地）作为判据 —— 与 `server/agent/tasks.ts` 判
 * 「下一次落在周几」用的是同一套 `getDay()`，否则会出现「模型按周四排的、
 * 界面按周三显示」这种谁都没错的错。
 */
export function formatScheduledAt(iso: string): string {
	const at = parseIso(iso);
	if (!at) return iso; // 脏值原样显示，不编一个时间出来
	const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
	return `${dayMonth(at)} ${WEEKDAYS[at.getDay()]} ${clock(at)}`;
}

/**
 * 播放时间给人看的样子，按**离现在多远**换档：
 *
 * | 离现在 | 显示 |
 * |:---|:---|
 * | 今天 | `15:04` |
 * | 昨天 | `昨天 21:30` |
 * | 今年更早 | `09-22 08:15` |
 * | 往年 | `2025-12-31 23:11` |
 *
 * 未来的时间戳（时钟不同步、手工改库）落进后两档按绝对时间显示：显示成
 * 「明天」会让人以为自己在看一份预测。
 *
 * `now` 可注入，单测靠它钉住「今天 / 昨天」的边界（同样理由见 `setTrackTags`
 * 的 `at` 参数）。
 */
export function formatPlayedAt(iso: string, now: Date = new Date()): string {
	const at = parseIso(iso);
	if (!at) return iso;
	const diff = dayIndex(now) - dayIndex(at);
	if (diff === 0) return clock(at);
	if (diff === 1) return `昨天 ${clock(at)}`;
	if (at.getFullYear() === now.getFullYear()) return `${dayMonth(at)} ${clock(at)}`;
	return `${fullDay(at)} ${clock(at)}`;
}
