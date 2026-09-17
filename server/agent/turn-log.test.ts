/**
 * `server/agent/turn-log.ts` 单测 —— ⑨ 观测的读写与那一个纯函数。
 *
 * 为什么值得测：观测自己不会报警。它记错了没有任何人会当场发现，
 * 只会让**下一次归因**建立在一个错的数上（"这个工具很快" / "它没用工具"），
 * 而那正是 ⑨ 存在的全部意义。三处具体的静默错法：
 *
 *   - **工具与耗时按配错** → 「哪个工具慢」从此答错，而表里每一行看着都正常；
 *   - **触顶判定过宽或过窄** → 前者把正常的收尾判成被掐（从此天天"触顶"），
 *     后者让真实的截断隐形（这正是 B2 那个缺口）；
 *   - **中断的轮次没落行** → "被中止的对话"从观测里消失，而它最值得看。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { closeDb, getDb } from '../db';
import { recentTurns, recordTurn, summarizeSteps, type StepLike } from './turn-log';

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), 'turn-log-test-'));
	process.env.APP_DB_PATH = join(dir, 'app.db');
	closeDb();
});

after(() => {
	closeDb();
	delete process.env.APP_DB_PATH;
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	getDb().exec('DELETE FROM agent_turns');
});

/** 造一步：`calls` 是 (工具名, 耗时, 是否成功)，结果**故意打乱顺序**。 */
function step(finishReason: string, calls: [string, number, boolean][]): StepLike {
	return {
		toolCalls: calls.map(([toolName], i) => ({ toolCallId: `c${i}`, toolName })),
		// 结果倒着放：按下标配对就会挂错人，按 id 配对才对
		toolResults: [...calls].reverse().map(([, ms, ok], j) => {
			const idx = calls.length - 1 - j;
			return { toolCallId: `c${idx}`, toolName: calls[idx][0], output: { ok, text: '', ms } };
		}),
		finishReason,
	};
}

test('工具与耗时按 toolCallId 配对，不按下标（结果乱序时也不能挂错人）', () => {
	const summary = summarizeSteps(
		[step('tool-calls', [['search_library', 12, true], ['build_queue', 340, true]])],
		{ maxSteps: 5 },
	);

	assert.deepEqual(
		summary.tools,
		[
			{ name: 'search_library', ms: 12, ok: true },
			{ name: 'build_queue', ms: 340, ok: true },
		],
		'顺序应按调用顺序，耗时/成败应跟着各自的 toolCallId',
	);
	assert.equal(summary.toolCalls, 2);
	assert.equal(summary.steps, 1);
});

test('跨步累加，且保留重复调用（同一工具调两次是真实信号）', () => {
	const summary = summarizeSteps(
		[
			step('tool-calls', [['search_library', 10, true]]),
			step('tool-calls', [['search_library', 11, true]]),
			step('stop', []),
		],
		{ maxSteps: 5 },
	);

	assert.equal(summary.steps, 3);
	assert.equal(summary.toolCalls, 2, '两次调用都要留下');
	assert.deepEqual(summary.tools.map((t) => t.name), ['search_library', 'search_library']);
});

test('取不到 outcome → ms/ok 记为 null，而**不是 0 或 false**', () => {
	const summary = summarizeSteps(
		[
			{
				toolCalls: [{ toolCallId: 'x', toolName: 'play_track' }],
				toolResults: [{ toolCallId: 'x', toolName: 'play_track', output: undefined }],
				finishReason: 'stop',
			},
			{
				toolCalls: [{ toolCallId: 'y', toolName: 'pause_playback' }],
				// 结果里根本没有这个 id（异常路径）：同样算「不知道」
				toolResults: [],
				finishReason: 'stop',
			},
		],
		{ maxSteps: 5 },
	);

	assert.deepEqual(summary.tools, [
		{ name: 'play_track', ms: null, ok: null },
		{ name: 'pause_playback', ms: null, ok: null },
	]);
	// 0 会伪装成「很快」、false 会伪装成「失败」——两者都是编造出来的事实
	assert.notEqual(summary.tools[0].ms, 0);
});

test('触顶：步数贴到上限**且**最后一步还在要工具', () => {
	const calls: StepLike[] = Array.from({ length: 5 }, () => step('tool-calls', [['search_library', 5, true]]));
	const summary = summarizeSteps(calls, { maxSteps: 5 });
	assert.equal(summary.truncated, true, '这两条都满足才是被掐');
});

test('触顶的反面一：步数没到上限，最后一步还在要工具（那是中间步，不是被掐）', () => {
	const summary = summarizeSteps([step('tool-calls', [['search_library', 5, true]])], { maxSteps: 5 });
	assert.equal(summary.truncated, false);
});

test('触顶的反面二：步数贴到上限但已经收尾（刚好在上限那一步说完，不算被掐）', () => {
	const calls: StepLike[] = [
		step('tool-calls', [['search_library', 5, true]]),
		step('tool-calls', [['play_track', 5, true]]),
		step('tool-calls', [['play_track', 5, true]]),
		step('tool-calls', [['play_track', 5, true]]),
		step('stop', []),
	];
	assert.equal(summarizeSteps(calls, { maxSteps: 5 }).truncated, false);
});

test('空 steps（中断 / 取不到）不报错，按 0 步记', () => {
	const summary = summarizeSteps([], { maxSteps: 5, aborted: true, error: 'aborted' });
	assert.deepEqual(
		{ steps: summary.steps, toolCalls: summary.toolCalls, tools: summary.tools, truncated: summary.truncated },
		{ steps: 0, toolCalls: 0, tools: [], truncated: false },
	);
	assert.equal(summary.aborted, true, '中断要留下痕迹，不能只剩一行空白');
	assert.equal(summary.error, 'aborted');
});

test('maxSteps 传 0 / 未传时永不判触顶（避免"忘了传上限"变成"天天触顶"）', () => {
	const calls: StepLike[] = Array.from({ length: 9 }, () => step('tool-calls', [['search_library', 5, true]]));
	assert.equal(summarizeSteps(calls).truncated, false);
	assert.equal(summarizeSteps(calls, { maxSteps: 0 }).truncated, false);
});

test('落库 → 读回：字段一一对应，工具明细是结构化往返', () => {
	recordTurn({
		id: 'turn-a',
		createdAt: '2026-09-17T09:00:00.000Z',
		userText: '换一首安静的',
		steps: 2,
		toolCalls: 2,
		tools: [
			{ name: 'search_library', ms: 12, ok: true },
			{ name: 'build_queue', ms: 340, ok: false },
		],
		truncated: false,
		aborted: false,
		finishReason: 'stop',
		ms: 1500,
		inputTokens: 900,
		outputTokens: 40,
		error: null,
	});

	const [row] = recentTurns(1);
	assert.equal(row.id, 'turn-a');
	assert.equal(row.userText, '换一首安静的');
	assert.equal(row.finishReason, 'stop');
	assert.equal(row.ms, 1500);
	assert.equal(row.inputTokens, 900);
	assert.equal(row.truncated, false);
	assert.deepEqual(row.tools[1], { name: 'build_queue', ms: 340, ok: false }, '工具明细要原样回来');
});

test('同 id 再写是覆盖而非新增（重复上报不该长出一行）', () => {
	recordTurn({ id: 'turn-b', userText: '一', steps: 1, toolCalls: 0, tools: [], truncated: false, aborted: false, finishReason: 'stop', ms: 1, inputTokens: 1, outputTokens: 1, error: null });
	recordTurn({ id: 'turn-b', userText: '二', steps: 3, toolCalls: 1, tools: [{ name: 'next_track', ms: 3, ok: true }], truncated: true, aborted: false, finishReason: 'tool-calls', ms: 9, inputTokens: 5, outputTokens: 2, error: null });

	const rows = recentTurns(10);
	assert.equal(rows.length, 1, '同 id 只应有一行');
	assert.equal(rows[0].userText, '二');
	assert.equal(rows[0].truncated, true, '覆盖要带上后来的判定');
});

test('userText 超长入库前截断（观测不需要全文，全文在 messages 表）', () => {
	recordTurn({ id: 'turn-c', userText: '啊'.repeat(500), steps: 0, toolCalls: 0, tools: [], truncated: false, aborted: false, finishReason: null, ms: 0, inputTokens: 0, outputTokens: 0, error: null });
	assert.equal(recentTurns(1)[0].userText.length, 200);
});

test('最近的在前（看观测时想先看刚发生的那一轮）', () => {
	recordTurn({ id: 'turn-1', userText: '早', steps: 0, toolCalls: 0, tools: [], truncated: false, aborted: false, finishReason: null, ms: 0, inputTokens: 0, outputTokens: 0, error: null });
	recordTurn({ id: 'turn-2', userText: '晚', steps: 0, toolCalls: 0, tools: [], truncated: false, aborted: false, finishReason: null, ms: 0, inputTokens: 0, outputTokens: 0, error: null });
	assert.deepEqual(recentTurns(2).map((r) => r.id), ['turn-2', 'turn-1']);
});
