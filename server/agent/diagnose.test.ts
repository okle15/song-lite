/**
 * `server/agent/diagnose.ts` 单测 —— ⑨ 归因层。
 *
 * 为什么值得单独测：归因的错**全是"听起来很合理但不该这么说"**。
 *   - 网关超时那一轮的工具链本来就是残缺的，"它没调某工具"不是证据 →
 *     归因必须说「这一轮不作数」，而不是「它不会用工具」；
 *   - 触顶的那一轮本来就"没来得及说话"，此时再报一条"它没回话"是**重复归因**
 *     （两条都在描述同一个现象，而修法只有一条）→ 这条由用例钉住；
 *   - 用户自己点了停止的那一轮，报成"它失败了"会让成功率永远是坏的。
 * 这三条都不会让脚本崩，只会让读报告的人得出一个错的行动。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolFailureKind } from '../../contract/tool';
import { diagnoseTurn, summarizeDiagnoses } from './diagnose';
import type { SpanRecord, ToolTrace, TurnRecord } from './turn-log';

/** 一轮的默认形状：**健康**那种（没有任何归因该命中）。 */
function turn(over: Partial<TurnRecord> = {}): TurnRecord {
	return {
		id: 't1',
		createdAt: '2026-09-23T09:00:00.000Z',
		userText: '放点凤凰传奇的歌',
		steps: 2,
		toolCalls: 2,
		tools: [
			{ name: 'search_library', ms: 40, ok: true },
			{ name: 'build_queue', ms: 300, ok: true },
		],
		truncated: false,
		budgetHit: false,
		aborted: false,
		finishReason: 'stop',
		ms: 9_000,
		firstTokenMs: 2_500,
		inputTokens: 900,
		outputTokens: 40,
		model: 'test-model',
		costMicro: 1234,
		error: null,
		promptVersion: 'a1b2c3d4',
		promptDisabled: '',
		...over,
	};
}

/** 失败的调用（`kind` 省略 = 老行 / 工具没给分类）。 */
const fail = (name: string, ms: number | null = 30, kind?: ToolFailureKind): ToolTrace => ({
	name,
	ms,
	ok: false,
	...(kind ? { kind } : {}),
});

const span = (idx: number, toolMs: number, names: string[] = []): SpanRecord => ({
	idx,
	tools: names.map((name) => ({ name, ms: Math.round(toolMs / Math.max(names.length, 1)), ok: true })),
	toolMs,
	finishReason: 'tool-calls',
});

const codes = (row: TurnRecord, spans: SpanRecord[] = []) => diagnoseTurn(row, spans).map((f) => f.code);

test('健康的一轮给空数组 —— "没有信号"与"修好了什么"必须分得开', () => {
	assert.deepEqual(diagnoseTurn(turn()), []);
});

test('网关报错：算环境类，并明说这一轮不作数', () => {
	const f = diagnoseTurn(turn({ error: '网关 502', firstTokenMs: null }))[0];
	assert.equal(f.code, 'gateway_error');
	assert.equal(f.blame, 'env', '网关的事改提示词没用');
	assert.match(f.text, /别拿它判断提示词好坏/, '报告要拦住"拿这一轮去改 prompt"这个动作');
});

test('用户点了停止：算在用户头上，不算缺陷，但要从成功率里摘出去', () => {
	const f = diagnoseTurn(turn({ aborted: true, firstTokenMs: null }))[0];
	assert.equal(f.code, 'aborted');
	assert.equal(f.blame, 'user');
	assert.match(f.text, /不该计入成功率/);
});

test('撞上步数上限：算行为类，且说清是"一直在试"而不是"试不动"', () => {
	const f = diagnoseTurn(turn({ truncated: true, steps: 5, firstTokenMs: null }))[0];
	assert.equal(f.code, 'truncated');
	assert.equal(f.blame, 'behaviour');
	assert.match(f.text, /5 步/);
});

test('工具失败按「谁来修」分成两堆：transport 算环境，bad_request 算它自己', () => {
	const env = diagnoseTurn(turn({ tools: [fail('search_library', 3_000, 'transport')] }));
	assert.deepEqual(env.map((f) => f.code), ['tool_env']);
	assert.match(env[0].text, /search_library\[transport\] 3000ms/);
	assert.match(env[0].text, /先查服务有没有跑/);

	const mine = diagnoseTurn(turn({ tools: [fail('build_queue', 12, 'bad_request')] }));
	assert.deepEqual(mine.map((f) => f.code), ['tool_behaviour']);
	assert.match(mine[0].text, /同参数重试没有意义/);
});

test('两种失败同时出现时两条都要报（修法不同，合成一句等于扔掉线索）', () => {
	const fs = diagnoseTurn(
		turn({ tools: [fail('a', 5, 'unavailable'), fail('b', 5, 'not_found'), fail('c', 5, 'forbidden')] }),
	);
	assert.deepEqual(fs.map((f) => f.code).sort(), ['tool_behaviour', 'tool_env']);
	// forbidden 是"谁都不行，得人去配"→ 环境那一堆（改提示词与重试都没用）
	assert.match(fs.find((f) => f.code === 'tool_env')?.text ?? '', /a\[unavailable\]/);
	assert.match(fs.find((f) => f.code === 'tool_env')?.text ?? '', /c\[forbidden\]/);
	assert.match(fs.find((f) => f.code === 'tool_behaviour')?.text ?? '', /b\[not_found\]/);
});

test('没有 kind 的老行也要能归因，且如实显示成 `?`（不猜一个原因）', () => {
	const fs = diagnoseTurn(turn({ tools: [fail('search_library')] }));
	assert.deepEqual(fs.map((f) => f.code), ['tool_behaviour'], '不知道是谁的错时归到"它自己那堆"最省事也最安全');
	assert.match(fs[0].text, /search_library\[\?\]/);
});

test('调了工具却一个字都没回：报出来', () => {
	assert.deepEqual(codes(turn({ firstTokenMs: null, steps: 3 })), ['silent']);
});

test('但被截断 / 中断 / 报错的那一轮**不再重复**报"没回话"', () => {
	// 这是本文件最该钉的一条：那几种情况下"没说话"是**同一个现象的另一面**，
	// 两条归因一起打出来，读的人会以为有两个独立缺陷。
	for (const over of [
		{ truncated: true, firstTokenMs: null },
		{ aborted: true, firstTokenMs: null },
		{ error: '网关 502', firstTokenMs: null },
	]) {
		assert.ok(!codes(turn(over)).includes('silent'), `${JSON.stringify(over)} 下不该再报 silent`);
	}
});

test('慢：工具占大头时，指名是哪一步', () => {
	const f = diagnoseTurn(turn({ ms: 30_000 }), [
		span(0, 200, ['search_library']),
		span(1, 25_000, ['build_queue']),
	]);
	assert.equal(f[0].code, 'slow');
	assert.equal(f[0].blame, 'info', '"慢"不是失败，别把它和报错并列');
	assert.match(f[0].text, /第 2 步/);
	assert.match(f[0].text, /build_queue/);
});

test('慢：工具没占大头时，明说"不在工具上"（否则会去白白优化工具）', () => {
	const f = diagnoseTurn(turn({ ms: 30_000 }), [span(0, 100, ['search_library'])]);
	assert.match(f[0].text, /时间不在工具上/);
});

test('慢：没有逐 span 数据时如实说看不出，**不拿 0 当"工具不慢"**', () => {
	const f = diagnoseTurn(turn({ ms: 30_000 }), []);
	assert.match(f[0].text, /没有逐 span 数据/);
});

test('首字晚与总耗时高是两条不同的归因', () => {
	// 一轮 9 秒、首字 7 秒：总耗时不算慢，但用户盯着空屏等了 7 秒
	const f = diagnoseTurn(turn({ ms: 9_000, firstTokenMs: 7_000 }));
	assert.deepEqual(f.map((x) => x.code), ['slow_start']);
	assert.match(f[0].text, /7000ms/);
});

test('步数偏多（没触顶）也给一句：提示词那段可能还有能收的', () => {
	const f = diagnoseTurn(turn({ steps: 4 }));
	assert.deepEqual(f.map((x) => x.code), ['many_steps']);
	assert.match(f[0].text, /走了 4 步/);
});

test('优先级：最能解释"为什么没做成"的排在最前', () => {
	const fs = diagnoseTurn(
		turn({
			error: '网关 502',
			aborted: true,
			truncated: true,
			steps: 5,
			ms: 30_000,
			tools: [fail('x', 5, 'transport')],
		}),
	);
	assert.deepEqual(fs.map((f) => f.code), [
		'gateway_error',
		'aborted',
		'truncated',
		'tool_env',
		'slow',
	]);
	// 触顶已经把"步数多"解释掉了 —— 再补一条 `many_steps` 是**重复归因同一个现象**
	assert.ok(!fs.some((f) => f.code === 'many_steps'), '触顶时不该再报"步数偏多"');
});

/* ── 分布 ─────────────────────────────────────────────────────────── */

test('summarizeDiagnoses：健康的轮次也占一格（否则 3 条异常看不出是 3/10 还是 3/100）', () => {
	const rows = [turn(), turn(), turn({ truncated: true, steps: 5, firstTokenMs: null })];
	const tally = summarizeDiagnoses(rows.map((r) => diagnoseTurn(r)));
	const ok = tally.find((t) => t.code === 'ok');
	assert.equal(ok?.count, 2);
	assert.equal(ok?.label, '无异常');
	assert.equal(tally.find((t) => t.code === 'truncated')?.count, 1);
});

test('summarizeDiagnoses：次数降序、同次数按 code 升序（两次跑必须给出同一个顺序）', () => {
	const one = turn({ error: '网关 502' });
	const two = turn({ aborted: true, firstTokenMs: null });
	const tally = summarizeDiagnoses([diagnoseTurn(one), diagnoseTurn(two)]);
	assert.deepEqual(tally.map((t) => t.code), ['aborted', 'gateway_error'], '都是 1 次 → 按 code 升序');
	assert.deepEqual(summarizeDiagnoses([diagnoseTurn(one), diagnoseTurn(two)]), tally);
});

test('summarizeDiagnoses：空输入给空数组（不是 undefined，调用方不该判空）', () => {
	assert.deepEqual(summarizeDiagnoses([]), []);
});

/* ── 成本闸门（budget）───────────────────────────────────────────── */

test('撞成本上限：报 budget 而不是 truncated（症状一样、动作不同）', () => {
	const out = diagnoseTurn(turn({ budgetHit: true, steps: 5, firstTokenMs: null }));
	const codes = out.map((f) => f.code);
	assert.ok(codes.includes('budget'), '得报出来，否则用户不知道为什么话说一半');
	assert.ok(!codes.includes('truncated'), '两个上限不能混成一个标记 —— 改的方向不一样');
	assert.equal(
		out.find((f) => f.code === 'budget')?.blame,
		'env',
		'动作指向配置（调预算），不是改提示词 —— 所以归在 env，报告里带「⚠ 环境」前缀',
	);
});

test('撞成本上限时不再重复报 silent / many_steps（一个现象只归因一次）', () => {
	// 这一轮的形状与"撞步数上限"那一轮**完全一样**：步数多、一个字都没回。
	// 触顶已经把"为什么没说话""为什么停在这"解释掉了，再报一遍就是重复归因 ——
	// 两条都在描述同一个现象，而修法只有一条。
	const codes = diagnoseTurn(turn({ budgetHit: true, steps: 5, firstTokenMs: null })).map((f) => f.code);
	assert.ok(!codes.includes('silent'));
	assert.ok(!codes.includes('many_steps'));
});

test('没撞预算时一律不报 budget（老行与没配闸门都是 false）', () => {
	assert.ok(!diagnoseTurn(turn()).some((f) => f.code === 'budget'));
	assert.ok(
		!diagnoseTurn(turn({ truncated: true, steps: 5, firstTokenMs: null })).some((f) => f.code === 'budget'),
		'撞步数上限 ≠ 撞预算',
	);
});

test('summarizeDiagnoses：budget 有中文短语（表尾分布要能读）', () => {
	const tally = summarizeDiagnoses([
		diagnoseTurn(turn({ budgetHit: true, steps: 5, firstTokenMs: null })),
	]);
	const b = tally.find((t) => t.code === 'budget');
	assert.equal(b?.count, 1);
	assert.equal(b?.label, '撞成本上限');
});
