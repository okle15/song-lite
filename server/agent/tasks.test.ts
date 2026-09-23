/**
 * `server/agent/tasks.ts` 单测 —— ⑩ 触发器的三处"不写对也不报错"。
 *
 * 为什么值得单独测（而不是靠"跑起来看看"）：⑩ 的失败**全都不出声**，而且
 * 症状都不像 bug：
 *   1. 认领不原子 → 同一件事跑两遍 → 用户听到两句一样的话，日志里没有异常行；
 *   2. 租约不回收 → 任务永远卡在 running → 表现是「它没反应」，没人会想到库里的状态；
 *   3. daily 补跑堆积 → 停服两天后连着触发 → 表现是「今天这首歌放了两遍」。
 * 这三条在正常使用（服务一直在跑、只跑一次）下**永远看不出来**，所以只能在这里钉。
 *
 * 隔离方式与 `preference-log.test.ts` 一致：`APP_DB_PATH` 指到临时目录，
 * 且换路径前先 `closeDb()`（否则拿到的是上一条连接）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, test } from 'node:test';
import { closeDb, getDb } from '../db';
import {
	cancelTask,
	claimDueTask,
	createTask,
	finishOutcome,
	finishTask,
	getTask,
	isDue,
	listTasks,
	nextDailyDue,
	nextRepeatDue,
	normalizeRepeatDays,
	parseDueAt,
	parseRepeat,
	parseRepeatDays,
	reclaimStaleRuns,
	validateCreate,
} from './tasks';

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), 'tasks-test-'));
	process.env.APP_DB_PATH = join(dir, 'app.db');
	closeDb();
});

after(() => {
	closeDb();
	delete process.env.APP_DB_PATH;
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	getDb().exec('DELETE FROM tasks');
});

/** 一个固定的「现在」。用常量而不是 `new Date()` —— 断言里要出现确定的时间串。 */
const T0 = new Date('2026-09-23T09:00:00+08:00');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (offsetMs: number) => new Date(T0.getTime() + offsetMs).toISOString();

/**
 * 造一个「2026-09-23 之后第一个**本地** <weekday> 的 hh:00」。
 *
 * ⚠️ 为什么 weekly 的断言不写死 `2026-09-28T07:00:00+08:00`：**星期几是时区相关的**
 * （实现用 `getDay()`，按本机时区算），写死的话这套用例换台机器要么假绿要么假红。
 * 先把输入**构造成"某个周一"**、再断言"落点仍然落在周一"，测的才是**不变式**。
 * 2026-09-23 只用来定一个起点，它自己是星期几无关紧要。
 */
function localWeekday(weekday: number, hh: number): Date {
	const d = new Date(2026, 8, 23, hh, 0, 0, 0);
	while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
	return d;
}

/** 表里现存几行。用来断言"失败的任务没留下脏行"。 */
const rowCount = () =>
	(getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get() as unknown as { n: number }).n;

/** 手工把一条摆成"已被认领"（`claimDueTask` 之外没有别的方式造出 running）。 */
function forceRunning(id: string, lastRunAt: string) {
	getDb()
		.prepare(`UPDATE tasks SET status = 'running', attempts = attempts + 1, last_run_at = ? WHERE id = ?`)
		.run(lastRunAt, id);
}

/* ── 时间：三个纯函数 ─────────────────────────────────────────────── */

test('parseDueAt：合法 ISO 给出毫秒；不是时间就抛（不许静默回落成"现在"）', () => {
	assert.equal(parseDueAt('2026-09-24T07:00:00+08:00'), Date.parse('2026-09-24T07:00:00+08:00'));
	assert.equal(parseDueAt('2026-09-23T23:00:00.000Z'), Date.parse('2026-09-23T23:00:00.000Z'));

	// 这条是全部意义所在：回落到 `Date.now()` 会让任务**立刻执行**，
	// 而"立刻执行"看起来只是"排上了"，没有任何东西会提示时间没解析出来。
	assert.throws(() => parseDueAt('明天早上七点'), /不是合法时间/);
	assert.throws(() => parseDueAt(''), /不是合法时间/);
	assert.throws(() => parseDueAt('2026-13-45'), /不是合法时间/);
});

test('nextDailyDue：停服时落下的次数不补 —— 推到落在未来为止', () => {
	// 原定 9/20 早上七点，现在已经是 9/23 早上九点。按「+1 天一次」算，
	// 9/21、9/22 两次都还在过去 → 下一次 tick 会立刻又触发 → 连着跑。
	const next = nextDailyDue('2026-09-20T07:00:00+08:00', T0);
	assert.equal(next, '2026-09-23T23:00:00.000Z', '应推到 9/24 07:00 (+08)');
	assert.ok(Date.parse(next) > T0.getTime(), '结果必须在未来');
	// 且不能推过头：一次补跑都不该留下，但"每天这时候"这个承诺要保住
	assert.ok(Date.parse(next) - T0.getTime() < 24 * 60 * MIN);
});

test('nextDailyDue：只过去一小时时也推到明天同一时刻（保持时分，不是"从现在起一天"）', () => {
	// 「每天八点」要一直在八点，而不是每次执行完顺延一天（会越漂越晚）
	const next = nextDailyDue('2026-09-23T08:00:00+08:00', T0);
	assert.equal(next, '2026-09-24T00:00:00.000Z', '应推到 9/24 08:00 (+08)');
});

test('nextDailyDue：本来就还在未来就不动它', () => {
	const future = '2026-09-25T07:00:00+08:00';
	assert.equal(nextDailyDue(future, T0), new Date(future).toISOString());
});

/* ── 时间：weekly（"只在某几天"）──────────────────────────────────── */

test('nextRepeatDue：weekly 保持星期 —— "每周一"的下一次必须还是周一', () => {
	const mon = localWeekday(1, 7);
	const now = new Date(mon.getTime() + MIN); // 刚跑完一分钟
	const next = nextRepeatDue('weekly', mon.toISOString(), [], now);

	// 这条是全部意义：只按"往后推整天"推到未来就停的话，落点是**周二** ——
	// 而那不报错，只是"每周一"从第二周起变成了"每周二"，用户过两周才发现。
	assert.equal(new Date(next).getDay(), 1, '落点必须还是周一');
	assert.ok(Date.parse(next) > now.getTime(), '落点必须在未来');
	assert.ok(
		Date.parse(next) - mon.getTime() <= 7 * DAY,
		'该是**最早**的那个周一，不能一路推到下下周',
	);
});

test('nextRepeatDue：weekly 给了多天时落在"下一个符合的日子"，不是往后推一周', () => {
	const mon = localWeekday(1, 7);
	const now = new Date(mon.getTime() + MIN);
	const next = nextRepeatDue('weekly', mon.toISOString(), [1, 3, 5], now);

	assert.equal(new Date(next).getDay(), 3, '周一跑完，它设的是周一/三/五 —— 下一次该是周三');
	assert.ok(Date.parse(next) < mon.getTime() + 7 * DAY, '"下一个符合的日子"不是"下一周"');
});

test('nextRepeatDue：weekly 没指定哪天 = 每周同一天，由 dueAt 的星期决定', () => {
	const mon = localWeekday(1, 7);
	const now = new Date(mon.getTime() + MIN);
	assert.equal(
		nextRepeatDue('weekly', mon.toISOString(), [], now),
		nextRepeatDue('weekly', mon.toISOString(), [mon.getDay()], now),
		'「每周一」不该逼调用方再传一遍 1 —— 两种写法必须给出同一个落点',
	);
});

test('nextRepeatDue：dueAt 的星期不在 days 里时重新对齐', () => {
	const mon = localWeekday(1, 7);
	const now = new Date(mon.getTime() + MIN);
	// 说好"每周三"，可模型把 dueAt 算成了周一：本周三就该跑，而不是等到下周一
	const next = nextRepeatDue('weekly', mon.toISOString(), [3], now);
	assert.equal(new Date(next).getDay(), 3);
});

test('nextRepeatDue：停服很久也不堆积 —— 推到未来为止（与 daily 同一条）', () => {
	const mon = localWeekday(1, 7);
	const now = new Date(mon.getTime() + 20 * DAY); // 服务停了三周才起来
	const next = nextRepeatDue('weekly', mon.toISOString(), [1], now);

	assert.ok(Date.parse(next) > now.getTime(), '必须在未来 —— 否则下一次 tick 立刻又触发');
	assert.equal(new Date(next).getDay(), 1, '星期不能因为"补跑"而漂');
});

test('nextRepeatDue：daily 就是"七天全允许" —— 两种说法共用同一份实现', () => {
	const mon = localWeekday(1, 8);
	const now = new Date(mon.getTime() + MIN);
	const all = nextRepeatDue('weekly', mon.toISOString(), [0, 1, 2, 3, 4, 5, 6], now);

	assert.equal(nextRepeatDue('daily', mon.toISOString(), [], now), all, 'daily 不该有第二套推进逻辑');
	assert.equal(nextDailyDue(mon.toISOString(), now), all, '旧的入口要落到同一处');
});

test('isDue：只有"待执行 + 到点"算数；正在跑的和做完的即使到点也不算', () => {
	const base = {
		id: 'x',
		goal: 'g',
		dueAt: iso(-MIN),
		repeat: 'none' as const,
		repeatDays: [],
		attempts: 0,
		lastError: null,
		result: null,
		createdAt: iso(-MIN),
		lastRunAt: null,
	};
	assert.equal(isDue({ ...base, status: 'pending' }, T0), true);
	assert.equal(isDue({ ...base, status: 'pending', dueAt: iso(MIN) }, T0), false);
	// 下面三条是重复执行的来源：状态不对却只看时间，就会把同一件事再做一遍
	assert.equal(isDue({ ...base, status: 'running' }, T0), false);
	assert.equal(isDue({ ...base, status: 'done' }, T0), false);
	assert.equal(isDue({ ...base, status: 'cancelled' }, T0), false);
});

/* ── 写：排任务 ───────────────────────────────────────────────────── */

test('createTask：默认只做一次、待执行、attempts 为 0，时间被规范化成 ISO', () => {
	const t = createTask({ goal: '  明早七点放首轻音乐  ', dueAt: '2026-09-24T07:00:00+08:00' }, T0);
	assert.equal(t.status, 'pending');
	assert.equal(t.repeat, 'none');
	assert.equal(t.attempts, 0);
	assert.equal(t.lastRunAt, null);
	assert.equal(t.result, null);
	assert.equal(t.goal, '明早七点放首轻音乐', '两端的空格该被去掉');
	assert.equal(t.dueAt, '2026-09-23T23:00:00.000Z', 'dueAt 应被规范化（模型可能给 +08:00）');
	assert.ok(t.id.length > 0, 'id 不能是空串（它要回给模型用来撤销）');

	// 落库了才算数 —— 只返回对象不写库，路由会回一个"排上了"而库里什么都没有
	assert.deepEqual(getTask(t.id), t);
});

test('createTask：不认识的 repeat 一律抛 —— 不静默回落成"就这一次"', () => {
	// 回落看着"宽容"，实际是把一个错参数变成一个错的**承诺**：模型传了它以为的
	// "每周"，用户拿到的是"就这一次"，而返回值照样念"已排期"。拿不准就让它响。
	assert.throws(() => createTask({ goal: 'g', dueAt: iso(MIN), repeat: 'monthly' }, T0), /repeat 只能是/);
	assert.throws(() => createTask({ goal: 'g', dueAt: iso(MIN), repeat: 'Daily' }, T0), /repeat 只能是/);
	assert.throws(() => createTask({ goal: 'g', dueAt: iso(MIN), repeat: 7 }, T0), /repeat 只能是/);
	assert.equal(rowCount(), 0, '校验失败不该留下任何行');

	// 而"没传"仍然是"做一次" —— 这是正常输入，不是错误
	assert.equal(createTask({ goal: 'a', dueAt: iso(MIN) }, T0).repeat, 'none');
	assert.equal(createTask({ goal: 'b', dueAt: iso(MIN), repeat: null }, T0).repeat, 'none');
	assert.equal(createTask({ goal: 'c', dueAt: iso(MIN), repeat: 'daily' }, T0).repeat, 'daily');
	assert.equal(createTask({ goal: 'd', dueAt: iso(MIN), repeat: 'weekly' }, T0).repeat, 'weekly');
});

test('createTask：weekly 的 repeatDays 形状不对就抛（0–6 的整数数组），且不留脏行', () => {
	// 抛而不是"滤掉坏的那几个"：滤掉之后模型拿到的是一句「已排期，每周一重复」，
	// 它以为自己传的 `[1, 'x', 3]` 被接受了 —— 参数错要让它看得见。
	assert.throws(() => createTask({ goal: 'g', dueAt: iso(MIN), repeat: 'weekly', repeatDays: '1' }, T0), /repeatDays/);
	assert.throws(() => createTask({ goal: 'g', dueAt: iso(MIN), repeat: 'weekly', repeatDays: [7] }, T0), /repeatDays/);
	assert.throws(() => createTask({ goal: 'g', dueAt: iso(MIN), repeat: 'weekly', repeatDays: [-1] }, T0), /repeatDays/);
	assert.throws(() => createTask({ goal: 'g', dueAt: iso(MIN), repeat: 'weekly', repeatDays: [1.5] }, T0), /repeatDays/);
	assert.throws(() => createTask({ goal: 'g', dueAt: iso(MIN), repeat: 'weekly', repeatDays: ['1'] }, T0), /repeatDays/);
	assert.equal(rowCount(), 0, '校验失败不该留下任何行');
});

test('createTask：weekly 去重升序；没说哪天时按 dueAt 的星期补上', () => {
	const mon = localWeekday(1, 7);

	const many = createTask({ goal: '多天', dueAt: mon.toISOString(), repeat: 'weekly', repeatDays: [5, 1, 5] }, T0);
	assert.deepEqual(many.repeatDays, [1, 5], '升序 + 去重 —— 它会进提示词与工具返回值（「每周一五」）');

	const single = createTask({ goal: '一天', dueAt: mon.toISOString(), repeat: 'weekly' }, T0);
	assert.deepEqual(single.repeatDays, [1], 'weekly 恒非空：读这一行的人不必猜"空代表哪天"');
});

test('createTask：非 weekly 的档位不带星期（免得行里出现"一次性的任务却带着星期"）', () => {
	const daily = createTask({ goal: 'g', dueAt: iso(MIN), repeat: 'daily', repeatDays: [1, 3] }, T0);
	assert.equal(daily.repeat, 'daily');
	assert.deepEqual(daily.repeatDays, [], '多出来的"哪几天"留着只会让人猜它到底哪天做');
	assert.deepEqual(createTask({ goal: 'h', dueAt: iso(MIN) }, T0).repeatDays, []);
});

/**
 * `T0` **之前**最近的那一次「本地 <weekday> hh:00」。
 * 与 `localWeekday` 相对：那个造"未来的某个周一"，这个造"**已经过期**的某个周一"。
 * 从固定的 `T0` 往回走，不依赖真实时钟。
 */
function pastWeekday(weekday: number, hh: number): Date {
	const d = new Date(T0);
	d.setHours(hh, 0, 0, 0);
	let guard = 0;
	while ((d.getDay() !== weekday || d.getTime() >= T0.getTime()) && guard++ < 14) {
		d.setDate(d.getDate() - 1);
	}
	return d;
}

test('createTask：重复任务的**第一个落点**也在未来 —— 模型算成过去的周一时不许立刻开播', () => {
	// 2026-09-23 端到端实测：模型把「每周一早上七点」算成 5/24、7/26 这种**过去的**周一
	// （星期几恰好是对的，所以「形状校验」一条都拦不住）。原样落库的话这行就是
	// `pending` + 过去的 `due_at` → **下一次 tick 立刻执行**：用户听到一首自己没要的
	// 歌，而全程零报错。`finishTask` 早就在推了，只有"建表那一刻"漏了 —— 这条钉住它。
	const pastMon = pastWeekday(1, 7);
	assert.ok(pastMon.getTime() < T0.getTime(), '夹具本身必须是"过去"的周一');

	const t = createTask({ goal: '每周一早上七点放首歌', dueAt: pastMon.toISOString(), repeat: 'weekly' }, T0);
	assert.notEqual(t.dueAt, pastMon.toISOString(), '落在过去的第一个落点必须被推走（不是原样入库）');
	assert.ok(parseDueAt(t.dueAt) > T0.getTime(), '推完必须真的落在未来');
	assert.equal(new Date(t.dueAt).getDay(), 1, '"每周一"推完还得是周一 —— 与 nextRepeatDue 同一条规则');
	assert.deepEqual(t.repeatDays, [1], '推的是落点，不是"哪几天"—— 星期不能跟着漂');
	assert.equal(new Date(t.dueAt).getHours(), 7, '时分要保住（推的是"下一次"，不是"从现在起一天"）');
});

test('createTask：daily 的过期落点同样推到未来；一次性的（none）刻意不推', () => {
	const past = iso(-2 * DAY);

	const d = createTask({ goal: '每天早上放点新闻', dueAt: past, repeat: 'daily' }, T0);
	assert.ok(parseDueAt(d.dueAt) > T0.getTime(), 'daily 的过期落点推到未来为止（与 finishTask 同一条）');

	// `none` 不推：一次性的任务已经没有"下一次"了，推迟等于把它丢掉；
	// 而"已经晚了就现在做"正是用户要的（补跑只对**重复**任务有害）。
	const once = createTask({ goal: '明早七点放首轻音乐', dueAt: past }, T0);
	assert.equal(once.dueAt, past, 'none 保持原样');
});

test('createTask：本来就在未来的落点一个字节都不动', () => {
	const future = iso(DAY);
	assert.equal(createTask({ goal: 'g', dueAt: future, repeat: 'daily' }, T0).dueAt, future);
	assert.equal(createTask({ goal: 'g', dueAt: future, repeat: 'weekly' }, T0).dueAt, future);
	assert.equal(createTask({ goal: 'g', dueAt: future }, T0).dueAt, future);
});

test('parseRepeat：只认三档；空值 = none，别的 = null（由调用方决定怎么报错）', () => {
	assert.equal(parseRepeat(undefined), 'none');
	assert.equal(parseRepeat(null), 'none');
	assert.equal(parseRepeat(''), 'none');
	assert.equal(parseRepeat('none'), 'none');
	assert.equal(parseRepeat('daily'), 'daily');
	assert.equal(parseRepeat('weekly'), 'weekly');
	assert.equal(parseRepeat('hourly'), null);
	assert.equal(parseRepeat(1), null);
});

test('normalizeRepeatDays：去重升序；形状不对给 null（与"没给"分得开）', () => {
	assert.deepEqual(normalizeRepeatDays(undefined), []);
	assert.deepEqual(normalizeRepeatDays([]), []);
	assert.deepEqual(normalizeRepeatDays([5, 1, 5]), [1, 5]);
	assert.deepEqual(normalizeRepeatDays([0, 6]), [0, 6], '周日与周六是合法值（边界）');
	assert.equal(normalizeRepeatDays('1'), null);
	assert.equal(normalizeRepeatDays({ 0: 1 }), null);
	assert.equal(normalizeRepeatDays([7]), null);
	assert.equal(normalizeRepeatDays([1, '2']), null);
});

test('parseRepeatDays：坏值读成"没有指定"，**不抛**（读清单不该因一行脏数据全挂）', () => {
	// 读取侧与写入侧的策略**故意不同**：写要拒绝（让模型看见参数错），
	// 读要退让（一份清单里有一行脏数据，其余几十行照样该看得见）。
	assert.deepEqual(parseRepeatDays(null), []);
	assert.deepEqual(parseRepeatDays(''), []);
	assert.deepEqual(parseRepeatDays('   '), []);
	assert.deepEqual(parseRepeatDays('不是 JSON'), []);
	assert.deepEqual(parseRepeatDays('{"a":1}'), [], 'JSON 但不是数组');
	assert.deepEqual(parseRepeatDays('[1,"3",9]'), [], '混了坏值 → 整行当成"没指定"，不挑几个认得的留下');
	// 退化的方向是安全的：weekly 会按 dueAt 的星期走 —— 宁可少跑一天，不会多跑一天
	assert.deepEqual(parseRepeatDays('[5,1,5]'), [1, 5], '正常值仍然去重升序');
	assert.deepEqual(parseRepeatDays('[3]'), [3]);
});

test('validateCreate：把"哪儿错了"说成人话，全对给 null（路由与存储共用这一份）', () => {
	assert.equal(validateCreate({ goal: 'g', dueAt: iso(MIN) }), null);

	assert.match(String(validateCreate({ goal: '  ', dueAt: iso(MIN) })), /goal 不能为空/);
	assert.match(String(validateCreate({ goal: 'g', dueAt: '明天早上' })), /dueAt 不是合法时间/);
	assert.match(String(validateCreate({ goal: 'g', dueAt: iso(MIN), repeat: 'monthly' })), /repeat 只能是/);
	assert.match(
		String(validateCreate({ goal: 'g', dueAt: iso(MIN), repeat: 'weekly', repeatDays: [9] })),
		/repeatDays/,
	);
});

test('createTask：非法输入一律抛，且**不留脏行**（空 goal / 超长 / 坏时间）', () => {
	assert.throws(() => createTask({ goal: '', dueAt: iso(MIN) }, T0), /goal 不能为空/);
	assert.throws(() => createTask({ goal: '   ', dueAt: iso(MIN) }, T0), /goal 不能为空/);
	assert.throws(() => createTask({ goal: 'x'.repeat(301), dueAt: iso(MIN) }, T0), /goal 过长/);
	assert.throws(() => createTask({ goal: 'x', dueAt: '不是时间' }, T0), /不是合法时间/);

	// 这行断言比上面四条加起来更重要：脏任务一旦入库，它会永远躺在表里
	// 并且**触发不了也删不掉**（用户在界面上看不到它，模型也列不出来）。
	assert.equal(rowCount(), 0, '校验失败不该留下任何行');

	// 边界：正好 300 字是合法的（上限是"超过"才拒）
	assert.equal(createTask({ goal: 'x'.repeat(300), dueAt: iso(MIN) }, T0).goal.length, 300);
});

/* ── 老库升级：后加的列 ───────────────────────────────────────────── */

/**
 * `tasks.repeat_days` 是**后加的列**，所以这条守门用例与
 * `turn-log.test.ts` 里那条同形。
 *
 * 它防的是一种**不报错、只是频率悄悄变小**的故障：`CREATE TABLE IF NOT EXISTS`
 * 对已存在的表是空操作，只在 `CREATE` 里加列的话老库永远拿不到它 —— 而
 * `parseRepeatDays` 把读不到的列当成"没有指定"，于是"每周一三五"退化成
 * "每周同一天"，写入侧一行都不报。断言因此落在**「写进去、再读出来还是那几天」**上，
 * 而不是「PRAGMA 里有这一列」（列在但 INSERT 的列数不匹配，照样写不进去）。
 */
test('老库升级：老形状的 tasks 表，migrate 之后 repeat_days 必须补上且真的能用', () => {
	const oldDir = mkdtempSync(join(tmpdir(), 'tasks-legacy-'));
	const oldFile = join(oldDir, 'app.db');
	const restore = process.env.APP_DB_PATH;

	try {
		// 1) 造一个「加这一列之前」的库：裸 SQL 按旧形状建表，**不经过 server/db.ts**。
		closeDb();
		const raw = new DatabaseSync(oldFile);
		raw.exec(`
			CREATE TABLE tasks (
				id          TEXT PRIMARY KEY,
				goal        TEXT NOT NULL,
				due_at      TEXT NOT NULL,
				repeat      TEXT NOT NULL,
				status      TEXT NOT NULL,
				attempts    INTEGER NOT NULL,
				last_error  TEXT,
				result      TEXT,
				created_at  TEXT NOT NULL,
				last_run_at TEXT
			);
		`);
		// 顺带塞一行"老数据"：加这一列之前排好的"每天"必须活着，且读出来是空。
		raw.exec(`
			INSERT INTO tasks
				(id, goal, due_at, repeat, status, attempts, last_error, result, created_at, last_run_at)
			VALUES
				('legacy', '加列之前排的', '2026-09-20T07:00:00.000Z', 'daily', 'pending', 0, NULL, NULL,
				 '2026-09-19T00:00:00.000Z', NULL);
		`);
		raw.close();

		// 2) 让生产那条路（getDb → migrate）去处理它。
		process.env.APP_DB_PATH = oldFile;
		closeDb();

		const legacy = getTask('legacy');
		assert.ok(legacy, '老数据不能被迁移弄丢');
		assert.equal(legacy.repeat, 'daily');
		assert.deepEqual(legacy.repeatDays, [], '老行没有"哪几天"，读成空 —— 不是崩');

		const mon = localWeekday(1, 7);
		const fresh = createTask(
			{ goal: '每周一放歌', dueAt: mon.toISOString(), repeat: 'weekly', repeatDays: [1, 3] },
			new Date(),
		);
		assert.deepEqual(
			getTask(fresh.id)?.repeatDays,
			[1, 3],
			'repeat_days 没被补上时这里会是 []（INSERT 撞上不存在的列 → 被 catch 吞掉）',
		);
		assert.equal(listTasks().open.length, 2, '两行都在：老的那行 + 新排的这行');
	} finally {
		closeDb();
		if (restore === undefined) delete process.env.APP_DB_PATH;
		else process.env.APP_DB_PATH = restore;
		rmSync(oldDir, { recursive: true, force: true });
	}
});

/* ── 认领：⑩ 的关键函数 ──────────────────────────────────────────── */

test('claimDueTask：没到点不认领；到点了认领并记下 attempts 与 last_run_at', () => {
	createTask({ goal: '还没到点', dueAt: iso(MIN) }, T0);
	assert.equal(claimDueTask(T0), null, '没到点不该被认领');

	const t = createTask({ goal: '到点了', dueAt: iso(-MIN) }, T0);
	const claimed = claimDueTask(T0);
	assert.ok(claimed, '到点的任务该被认领');
	assert.equal(claimed.id, t.id);
	assert.equal(claimed.status, 'running');
	assert.equal(claimed.attempts, 1);
	assert.equal(claimed.lastRunAt, T0.toISOString());
});

test('claimDueTask：同一件不可能被认领两次（认领会把它从 pending 摘走）', () => {
	const t = createTask({ goal: '只该跑一次', dueAt: iso(-MIN) }, T0);
	const first = claimDueTask(T0);
	assert.equal(first?.id, t.id);

	const second = claimDueTask(T0);
	assert.equal(second, null, '第二次该拿不到 —— 这就是"同一件事跑两遍"的闸门');
	assert.equal(getTask(t.id)?.attempts, 1, 'attempts 只能加一次');
});

test('claimDueTask：认领的是**最早**到点的那一件，不是最先入库的', () => {
	// 后入库、但更早到点 —— 顺序若写成"按入库时间"，晚到的急事会被排在后面
	const late = createTask({ goal: '晚一点', dueAt: iso(-MIN) }, T0);
	const early = createTask({ goal: '更早', dueAt: iso(-10 * MIN) }, T0);
	assert.equal(claimDueTask(T0)?.id, early.id);
	assert.equal(claimDueTask(T0)?.id, late.id);
	assert.equal(claimDueTask(T0), null, '两件都认领完了，第三次该什么都没有');
});

test('claimDueTask：已被别人认领（running）的那件不会被再次挑中', () => {
	const t = createTask({ goal: '别人在跑', dueAt: iso(-MIN) }, T0);
	forceRunning(t.id, T0.toISOString());

	assert.equal(claimDueTask(T0), null);
	// 这条断言是"闸门在状态上、不在时间上"的可见证据
	assert.equal(getTask(t.id)?.attempts, 1, 'forceRunning 加的那一次，不该被再 +1');
});

test('reclaimStaleRuns：租约没过期不动它，过期了放回 pending 并留下原因', () => {
	const t = createTask({ goal: '跑挂了', dueAt: iso(-MIN) }, T0);
	claimDueTask(T0);

	// 刚认领：这是"正在跑"的正常样子，抢回来会让同一件事并行跑两遍
	assert.deepEqual(reclaimStaleRuns(new Date(T0.getTime() + 9 * MIN)), []);

	const later = new Date(T0.getTime() + 11 * MIN);
	assert.deepEqual(reclaimStaleRuns(later), [t.id]);

	const back = getTask(t.id);
	assert.equal(back?.status, 'pending', '该被放回待执行 —— 否则这件任务再也不会被执行');
	assert.match(back?.lastError ?? '', /没有收尾/);
	assert.equal(back?.attempts, 1, 'attempts 是"跑过几次"的完整痕迹，回收不该抹掉它');

	// 放回来之后就能被再次认领了，且 attempts 累加（可见的是"它试过两次"）
	assert.equal(claimDueTask(later)?.attempts, 2);
});

test('reclaimStaleRuns：什么都没回收时返回空数组（"修好了什么"与"没出事"必须分得开）', () => {
	// 这个返回值存在的唯一理由就是这条断言：平时它是零，而零要与"出过事"区分开
	assert.deepEqual(reclaimStaleRuns(T0), []);

	createTask({ goal: '还在等', dueAt: iso(MIN) }, T0);
	assert.deepEqual(reclaimStaleRuns(new Date(T0.getTime() + 60 * MIN)), [], 'pending 不在回收范围内');
});

/* ── 收尾 ─────────────────────────────────────────────────────────── */

test('finishTask：成功 → done 并记下结论；失败 → failed 并记下原因', () => {
	const a = createTask({ goal: '放歌', dueAt: iso(-MIN) }, T0);
	claimDueTask(T0);
	const doneA = finishTask(a.id, { ok: true, result: '已开始播放《荷塘月色》' }, T0);
	assert.equal(doneA?.status, 'done');
	assert.equal(doneA?.result, '已开始播放《荷塘月色》');
	assert.equal(doneA?.lastError, null);

	const b = createTask({ goal: '放歌', dueAt: iso(-MIN) }, T0);
	claimDueTask(T0);
	const failedB = finishTask(b.id, { ok: false, error: '网关 502' }, T0);
	assert.equal(failedB?.status, 'failed');
	assert.equal(failedB?.lastError, '网关 502');
});

test('finishTask：daily 成功 → 回到待执行且时间推到未来（不是新建一行）', () => {
	// ⚠️ 不能像以前那样排一个**已经过去**的点：`createTask` 现在保证重复任务的第一个
	// 落点在未来（见上面那条）。所以先排到明天八点，再把"现在"拨到那一刻去认领 ——
	// 与下面几组 weekly 用例同一个形状。
	const due = new Date('2026-09-24T08:00:00+08:00');
	const at = new Date(due.getTime() + MIN);
	const t = createTask({ goal: '每天八点放歌', dueAt: due.toISOString(), repeat: 'daily' }, T0);
	claimDueTask(at);
	const after = finishTask(t.id, { ok: true, result: '放了' }, at);

	assert.equal(after?.id, t.id, '"每天的事"始终是同一行 —— attempts 才是它跑过几次的痕迹');
	assert.equal(after?.status, 'pending');
	assert.equal(after?.dueAt, '2026-09-25T00:00:00.000Z', '该推到明天八点，而不是留在过去');
	assert.equal(after?.lastError, null, '上一次的错误该被清掉，否则它永远挂着一条旧原因');
	assert.equal(after?.attempts, 1);
	assert.equal(listTasks().open.length, 1, '库里仍然只有这一行');
});

test('finishTask：daily 但**这次失败** → failed，不重排（免得失败的事无限重试）', () => {
	// 同上：先排到未来那一点，再把"现在"拨过去认领 —— 否则 `claimDueTask` 什么也认不到，
	// 这条用例会"因为没走到那一步而绿"。
	const due = new Date('2026-09-24T08:00:00+08:00');
	const at = new Date(due.getTime() + MIN);
	const t = createTask({ goal: '每天八点放歌', dueAt: due.toISOString(), repeat: 'daily' }, T0);
	claimDueTask(at);
	const after = finishTask(t.id, { ok: false, error: '曲库是空的' }, at);

	assert.equal(after?.status, 'failed', '失败不该悄悄排到明天 —— 用户会以为它每天都在正常放歌');
	assert.equal(after?.lastError, '曲库是空的');
	assert.equal(after?.dueAt, due.toISOString(), '失败不重排：due_at 原地不动（推进只发生在成功那一支）');
});

test('finishTask：weekly 成功 → 回到待执行，且推到**下一周的同一时刻**', () => {
	const mon = localWeekday(1, 7);
	const at = new Date(mon.getTime() + MIN);
	const t = createTask({ goal: '每周一七点放歌', dueAt: mon.toISOString(), repeat: 'weekly' }, T0);
	claimDueTask(at);
	const after = finishTask(t.id, { ok: true, result: '放了' }, at);

	assert.equal(after?.id, t.id, '同一个"每周一"始终是同一行 —— attempts 才是它跑过几次');
	assert.equal(after?.status, 'pending', '每周的事不能一次就结束');
	assert.equal(new Date(after?.dueAt ?? '').getDay(), 1, '下一次还是周一');
	assert.ok(Date.parse(after?.dueAt ?? '') > mon.getTime() + 6 * DAY, '该是下一周，不是明天');
	assert.deepEqual(after?.repeatDays, [1], '频率要跟着这一行活下去 —— 丢了它，下一次就不知道该推到哪天');
	assert.equal(after?.attempts, 1);
	assert.deepEqual(listTasks().open.map((x) => x.id), [t.id], '库里仍然只有这一行');
});

test('finishTask：weekly 的"多天"在重排后仍然生效', () => {
	const mon = localWeekday(1, 7);
	const at = new Date(mon.getTime() + MIN);
	const t = createTask(
		{ goal: '每周一三五放歌', dueAt: mon.toISOString(), repeat: 'weekly', repeatDays: [1, 3, 5] },
		T0,
	);
	claimDueTask(at);
	const after = finishTask(t.id, { ok: true, result: '放了' }, at);

	assert.equal(new Date(after?.dueAt ?? '').getDay(), 3, '周一的下一站是周三（它设了周一/三/五）');
	assert.deepEqual(after?.repeatDays, [1, 3, 5], '"哪几天"必须原样带过下一次 —— 只留一个就静默变频率');
});

test('finishTask：weekly 这次失败 → 落 failed 结束系列（与 daily 同一条取舍）', () => {
	const mon = localWeekday(1, 7);
	const at = new Date(mon.getTime() + MIN);
	const t = createTask({ goal: '每周一放歌', dueAt: mon.toISOString(), repeat: 'weekly' }, T0);
	claimDueTask(at);
	const after = finishTask(t.id, { ok: false, error: '曲库是空的' }, at);

	assert.equal(after?.status, 'failed', '失败也重排的话，一件永久坏掉的事会每周烧一轮钱，且没人看得出来');
	assert.equal(after?.lastError, '曲库是空的');
});

test('finishTask：结论超长时截断入库（全文在 messages 里，库里只存一句话）', () => {
	const t = createTask({ goal: 'g', dueAt: iso(-MIN) }, T0);
	claimDueTask(T0);
	const after = finishTask(t.id, { ok: true, result: '好'.repeat(900) }, T0);
	assert.equal(after?.result?.length, 500);
});

test('finishTask：id 不存在返回 null（迟到的一次收尾不该把服务弄挂）', () => {
	assert.equal(finishTask('不存在的 id', { ok: true }, T0), null);
});

test('cancelTask：只撤得掉"还没做完"的；撤一件已完成的不算错，只是撤不动', () => {
	const a = createTask({ goal: '不想要了', dueAt: iso(MIN) }, T0);
	assert.equal(cancelTask(a.id), true);
	assert.equal(getTask(a.id)?.status, 'cancelled');
	assert.equal(cancelTask(a.id), false, '第二次是"来晚了一步"，不是错误');

	const b = createTask({ goal: '已经做完了', dueAt: iso(-MIN) }, T0);
	claimDueTask(T0);
	finishTask(b.id, { ok: true, result: '做了' }, T0);
	assert.equal(cancelTask(b.id), false, '做完了就撤不掉 —— 那件事真的发生过');
	assert.equal(getTask(b.id)?.status, 'done');

	assert.equal(cancelTask('不存在的 id'), false);
});

test('cancelTask：正在跑的那件也撤得掉（用户说"别放了我睡了"时它可能已经启动了）', () => {
	const t = createTask({ goal: '响着的闹钟', dueAt: iso(-MIN) }, T0);
	claimDueTask(T0);
	assert.equal(cancelTask(t.id), true);
	assert.equal(getTask(t.id)?.status, 'cancelled');
	// 收尾时会把它从 cancelled 改写吗？——不会：finishTask 只按 ok 写 done/failed，
	// 于是"用户已经撤回"这件事不会被一次迟到的收尾抹掉。这是有意的取舍，钉在这里。
	finishTask(t.id, { ok: true, result: '还是放了' }, T0);
	assert.equal(getTask(t.id)?.status, 'done');
});

/* ── 收尾判据 ─────────────────────────────────────────────────────── */

test('finishOutcome：有结论算成功，并把两端空白去掉', () => {
	const o = finishOutcome({ text: '  已开始播放《荷塘月色》\n', error: null, truncated: false });
	assert.deepEqual(o, { ok: true, result: '已开始播放《荷塘月色》', error: null });
});

test('finishOutcome：**只有空白**不算成功（`if (text)` 会漏掉它）', () => {
	// 2026-09-23 端到端实测就是这个形状：模型撞上 MAX_STEPS，结论是两个换行。
	// 旧写法 `ok: !error` 会把它记成"做完了"，`result` 存 `"\n\n"` ——
	// 于是用户问「那件事做了吗」时，模型照着 `result` 回一句"做了"，
	// 而库里那两行换行就是它的全部依据，**且没有任何地方能看出不对**。
	for (const blank of ['\n\n', '   ', '\t', '\r\n  \n']) {
		const o = finishOutcome({ text: blank, error: null, truncated: false });
		assert.equal(o.ok, false, `空白回复 ${JSON.stringify(blank)} 不该算完成`);
		assert.equal(o.result, null, '不能把空白存成结论');
	}
});

test('finishOutcome：一个字没回时，把"为什么"分开说 —— 被截断与空回复是两种病', () => {
	const cut = finishOutcome({ text: '', error: null, truncated: true });
	assert.equal(cut.ok, false);
	assert.match(cut.error ?? '', /MAX_STEPS/, '撞上限是最常见也最可诊断的一种，要指名');
	assert.match(cut.error ?? '', /一直/, '它一直在调工具 —— 这句话是给下一步排查用的线索');

	const quiet = finishOutcome({ text: '', error: null, truncated: false });
	assert.equal(quiet.ok, false);
	assert.match(quiet.error ?? '', /一个字都没回/);
	assert.ok(!/MAX_STEPS/.test(quiet.error ?? ''), '没被截断时不许冤枉 MAX_STEPS');
});

test('finishOutcome：抛了异常时，原因是异常本身（半截的 text 不算结论）', () => {
	const o = finishOutcome({ text: '已开始播', error: '网关 502', truncated: false });
	assert.equal(o.ok, false);
	assert.equal(o.error, '网关 502');
	assert.equal(o.result, null, '中断那句是半截的，记成结论会让下一次读的人以为它做完了');
});

test('finishOutcome：真跑成了的一条，接上 finishTask 会落成 done 并清掉旧的 last_error', () => {
	const t = createTask({ goal: '放歌', dueAt: iso(-MIN) }, T0);
	claimDueTask(T0);
	// 先造一次失败（留下 last_error），再用成功的一轮收尾
	finishTask(t.id, finishOutcome({ text: '', error: null, truncated: true }), T0);
	assert.equal(getTask(t.id)?.status, 'failed');

	const again = createTask({ goal: '再放一次', dueAt: iso(-MIN) }, T0);
	claimDueTask(T0);
	finishTask(again.id, finishOutcome({ text: '放上了', error: null, truncated: false }), T0);
	assert.equal(getTask(again.id)?.status, 'done');
	assert.equal(getTask(again.id)?.result, '放上了');
	assert.equal(getTask(again.id)?.lastError, null);
});

/* ── 读：给模型看的清单 ───────────────────────────────────────────── */

test('listTasks：没做的按该做的时间升序在前', () => {
	createTask({ goal: '第三', dueAt: iso(3 * MIN) }, T0);
	createTask({ goal: '第一', dueAt: iso(1 * MIN) }, T0);
	createTask({ goal: '第二', dueAt: iso(2 * MIN) }, T0);

	assert.deepEqual(
		listTasks().open.map((t) => t.goal),
		['第一', '第二', '第三'],
	);
});

test('listTasks：跑着的也算"没做完"（正在做时用户问"排上了吗"要答得出来）', () => {
	const t = createTask({ goal: '正在做', dueAt: iso(-MIN) }, T0);
	claimDueTask(T0);
	assert.deepEqual(listTasks().open.map((x) => x.id), [t.id]);
});

test('listTasks：做过的按「最近动过」倒序，且只给最近几条', () => {
	// 每件用**不同的认领时间**，让"最近动过"真的有先后 —— 否则测到的是 tie-break
	for (let i = 0; i < 8; i++) {
		const at = new Date(T0.getTime() + i * MIN);
		const t = createTask({ goal: `第 ${i} 件`, dueAt: iso(-MIN) }, T0);
		claimDueTask(at);
		finishTask(t.id, { ok: true, result: `做了 ${i}` }, at);
	}

	const closed = listTasks().closed;
	assert.equal(closed.length, 5, '已完成的要有上限 —— 200 条历史会把"还没做的那两件"淹掉');
	assert.deepEqual(
		closed.map((t) => t.goal),
		['第 7 件', '第 6 件', '第 5 件', '第 4 件', '第 3 件'],
	);
});

test('listTasks：时间撞车时顺序仍然确定（同一批完成的不是随机排的）', () => {
	// 一次性任务收尾时**不改** `last_run_at`（那是认领时刻），所以同一时刻
	// 认领的那几件时间完全相同。没有 tie-break 时 SQLite 给的顺序不保证 ——
	// 表现是"同一个库，两次请求给出两份不同顺序的清单"，比对时看着像随机。
	// 这条是本用例抓出来的：原来的 `ORDER BY ... DESC` 后面什么都没有。
	for (let i = 0; i < 3; i++) {
		const t = createTask({ goal: `同批 ${i}`, dueAt: iso(-MIN) }, T0);
		claimDueTask(T0);
		finishTask(t.id, { ok: true, result: `做了 ${i}` }, T0);
	}

	const first = listTasks().closed.map((t) => t.goal);
	assert.deepEqual(first, ['同批 2', '同批 1', '同批 0'], '时间相同时后入库的在前');
	assert.deepEqual(listTasks().closed.map((t) => t.goal), first, '两次读取必须一致');
});

test('listTasks：due_at 相同的两件顺序也确定（同一时刻排下的两件事）', () => {
	createTask({ goal: '甲', dueAt: iso(MIN) }, T0);
	createTask({ goal: '乙', dueAt: iso(MIN) }, T0);

	const first = listTasks().open.map((t) => t.goal);
	assert.deepEqual(first, ['甲', '乙'], '时间相同时按入库先后');
	assert.deepEqual(listTasks().open.map((t) => t.goal), first);
});

test('listTasks：做完的也要给几条 —— 只报未完成会让模型把"做过的事"答成"没有这件事"', () => {
	const t = createTask({ goal: '昨天那件事', dueAt: iso(-MIN) }, T0);
	claimDueTask(T0);
	finishTask(t.id, { ok: true, result: '做完了' }, T0);

	const { open, closed } = listTasks();
	assert.equal(open.length, 0);
	assert.equal(closed.length, 1);
	assert.equal(closed[0].goal, '昨天那件事');
});

test('listTasks：空库给两个空数组（不是 null —— 调用方不该判空）', () => {
	assert.deepEqual(listTasks(), { open: [], closed: [] });
});

test('读回来的形状是驼峰，且不带 last_run_at 这类列名（列名是存储细节）', () => {
	const t = createTask({ goal: 'g', dueAt: iso(MIN) }, T0);
	const back = getTask(t.id);
	assert.deepEqual(Object.keys(back ?? {}).sort(), [
		'attempts',
		'createdAt',
		'dueAt',
		'goal',
		'id',
		'lastError',
		'lastRunAt',
		'repeat',
		'repeatDays',
		'result',
		'status',
	]);
});
