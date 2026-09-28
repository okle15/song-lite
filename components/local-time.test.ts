/**
 * `components/local-time.ts` 单测 —— 钉住「昨天」的判据。
 *
 * 这个文件的全部理由是**跨天不等于相差 24 小时**：23:30 与次日 00:10 只差 40 分钟，
 * 却是两个不同的日子。拿小时差当判据的话，凌晨那几个小时里「昨天听的歌」会被
 * 显示成「今天」——**不报错**，只是让人以为自己刚才听过。
 *
 * 所有用例都用**本地时区**构造再转 ISO（服务端就是这么存的），所以断言与跑测试的
 * 机器在哪个时区无关。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPlayedAt, formatScheduledAt } from './local-time';

/** 本地时间 → ISO 串（服务端存进 `plays.started_at` 的就是这个形状）。 */
function iso(y: number, m: number, d: number, h = 0, mi = 0): string {
	return new Date(y, m - 1, d, h, mi).toISOString();
}

test('今天：只给时分（不写"今天"，那是默认语境）', () => {
	const now = new Date(2026, 8, 28, 20, 0);
	assert.equal(formatPlayedAt(iso(2026, 9, 28, 15, 4), now), '15:04');
	// 同一天里"刚刚"也是同一天 —— 不额外造一个「刚刚」档：
	// 档位越多，「离现在多远」这件事就越难一眼读出来。
	assert.equal(formatPlayedAt(iso(2026, 9, 28, 19, 59), now), '19:59');
});

test('昨天按日历日判，不按「相差 24 小时」判', () => {
	// ① 只差 40 分钟，但跨天了 → 必须说「昨天」
	const nowEarly = new Date(2026, 8, 28, 0, 10);
	assert.equal(formatPlayedAt(iso(2026, 9, 27, 23, 30), nowEarly), '昨天 23:30');

	// ② 差了 11 小时、仍在同一天 → 必须**不带**「昨天」
	const nowNoon = new Date(2026, 8, 28, 12, 0);
	assert.equal(formatPlayedAt(iso(2026, 9, 28, 1, 0), nowNoon), '01:00');

	// ③ 差不满 24 小时（23 小时）但确实是前一天 → 仍然说「昨天」
	const nowNight = new Date(2026, 8, 28, 8, 0);
	assert.equal(formatPlayedAt(iso(2026, 9, 27, 9, 0), nowNight), '昨天 09:00');
});

test('今年更早：MM-DD HH:mm；往年：带上年份', () => {
	const now = new Date(2026, 8, 28, 20, 0);
	assert.equal(formatPlayedAt(iso(2026, 9, 22, 8, 15), now), '09-22 08:15');
	assert.equal(formatPlayedAt(iso(2026, 1, 3, 7, 5), now), '01-03 07:05');
	assert.equal(formatPlayedAt(iso(2025, 12, 31, 23, 11), now), '2025-12-31 23:11');
});

test('未来的时间戳按绝对时间显示（不能显示成"明天"）', () => {
	// 时钟不同步或手工改库都可能产生未来时间。显示成相对说法会让人以为
	// 自己在看一份预测 —— 而"预测"这件事这个项目没有做。
	const now = new Date(2026, 8, 28, 20, 0);
	assert.equal(formatPlayedAt(iso(2026, 9, 29, 9, 0), now), '09-29 09:00');
});

test('脏值原样返回：不编一个时间出来', () => {
	assert.equal(formatPlayedAt('not-a-date'), 'not-a-date');
	assert.equal(formatPlayedAt(''), '');
	assert.equal(formatScheduledAt('not-a-date'), 'not-a-date');
});

test('排期时间：把星期几露出来（用户要拿它跟自己的日历对）', () => {
	// 2026-09-24 是周四（与 `agent/tools.test.ts` 里那条 formatAbsolute 用例同一天）
	const out = formatScheduledAt(iso(2026, 9, 24, 7, 0));
	assert.match(out, /^09-24 /, '月日');
	assert.match(out, /周四/, '星期几必须在 —— 相对说法（"下周一"）在这里是有害的');
	assert.match(out, /07:00$/, '时刻');
});
