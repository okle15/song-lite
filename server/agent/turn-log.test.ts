/**
 * `server/agent/turn-log.ts` 单测 —— ⑨ 观测的读写与那一个纯函数。
 *
 * 为什么值得测：观测自己不会报警。它记错了没有任何人会当场发现，
 * 只会让**下一次归因**建立在一个错的数上（"这个工具很快" / "它没用工具"），
 * 而那正是 ⑨ 存在的全部意义。四处具体的静默错法：
 *
 *   - **工具与耗时按配错** → 「哪个工具慢」从此答错，而表里每一行看着都正常；
 *   - **触顶判定过宽或过窄** → 前者把正常的收尾判成被掐（从此天天"触顶"），
 *     后者让真实的截断隐形（这正是 B2 那个缺口）；
 *   - **中断的轮次没落行** → "被中止的对话"从观测里消失，而它最值得看；
 *   - **老库没补上后加的列** → 写入走流水语义（只 log 不抛），于是观测**一行都
 *     进不来**，而表还在、没有任何提示（2026-09-23 加版本列时新增的守门用例）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, test } from 'node:test';
import { closeDb, getDb } from '../db';
import {
	recentSpans,
	recentTurns,
	recordSpans,
	recordTurn,
	summarizeSpans,
	summarizeSteps,
	type StepLike,
} from './turn-log';

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
	getDb().exec('DELETE FROM agent_spans');
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

/**
 * 一条最小可用的记录。**默认带上提示词版本与模型名** —— 它们是 `recordTurn`
 * 的必填项（理由见那边：可选 + 默认 null 会让「忘了传」静默写成一个像老行的值）。
 */
function turn(id: string, over: Record<string, unknown> = {}) {
	return {
		id,
		userText: '放点安静的',
		steps: 2,
		toolCalls: 1,
		tools: [{ name: 'build_queue', ms: 30, ok: true }],
		truncated: false,
		budgetHit: false,
		aborted: false,
		finishReason: 'stop',
		ms: 1200,
		firstTokenMs: 300,
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
	recordTurn(
		turn('turn-a', {
			createdAt: '2026-09-17T09:00:00.000Z',
			userText: '换一首安静的',
			tools: [
				{ name: 'search_library', ms: 12, ok: true },
				{ name: 'build_queue', ms: 340, ok: false },
			],
			ms: 1500,
		}),
	);

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
	recordTurn(turn('turn-b', { userText: '一', steps: 1, toolCalls: 0, tools: [], ms: 1 }));
	recordTurn(
		turn('turn-b', {
			userText: '二',
			steps: 3,
			tools: [{ name: 'next_track', ms: 3, ok: true }],
			truncated: true,
			finishReason: 'tool-calls',
			ms: 9,
		}),
	);

	const rows = recentTurns(10);
	assert.equal(rows.length, 1, '同 id 只应有一行');
	assert.equal(rows[0].userText, '二');
	assert.equal(rows[0].truncated, true, '覆盖要带上后来的判定');
});

test('userText 超长入库前截断（观测不需要全文，全文在 messages 表）', () => {
	recordTurn(turn('turn-c', { userText: '啊'.repeat(500), steps: 0, toolCalls: 0, tools: [] }));
	assert.equal(recentTurns(1)[0].userText.length, 200);
});

test('最近的在前（看观测时想先看刚发生的那一轮）', () => {
	recordTurn(turn('turn-1', { userText: '早' }));
	recordTurn(turn('turn-2', { userText: '晚' }));
	assert.deepEqual(recentTurns(2).map((r) => r.id), ['turn-2', 'turn-1']);
});

test('提示词版本两列写入 → 读回（「带 / 不带补丁」的分组对比全靠它们）', () => {
	recordTurn(turn('turn-v', { promptVersion: 'a1b2c3d4', promptDisabled: 'work_style' }));

	const [row] = recentTurns(1);
	assert.equal(row.promptVersion, 'a1b2c3d4');
	assert.equal(row.promptDisabled, 'work_style');
});

test('没关补丁时是**空串**而不是 null —— 两者含义不同', () => {
	recordTurn(turn('turn-off', { promptVersion: 'a1b2c3d4', promptDisabled: '' }));

	const [row] = recentTurns(1);
	assert.equal(row.promptDisabled, '');
	assert.notEqual(
		row.promptDisabled,
		null,
		'空串 =「这一轮全部启用」，null =「不知道（加列之前的老行）」；混起来会让老行被算进默认组',
	);
});

/**
 * 老库升级的守门用例（2026-09-23 加版本列时写的）。
 *
 * ⚠️ 它防的是一种**不会报错、只是功能死掉**的故障：`CREATE TABLE IF NOT EXISTS`
 * 对已存在的表是空操作，所以只在 CREATE 里加列，老库永远拿不到它 —— 而写入侧是
 * 流水语义（`recordTurn` catch 住只 log），于是观测**一行都进不来**，
 * 表还在、代码也没错。
 *
 * 断言刻意落在**「写入能成功且读得回」**上，而不是「`PRAGMA` 里有那一列」：
 * 列在但 INSERT 的列数与它不匹配，照样写不进去 —— 后者是更弱、更容易绿的断言。
 */
test('老库升级：按旧形状建的表，migrate 之后版本列必须补上且写入真的成功', () => {
	const oldDir = mkdtempSync(join(tmpdir(), 'turn-log-legacy-'));
	const oldFile = join(oldDir, 'app.db');
	const restore = process.env.APP_DB_PATH;

	try {
		// 1) 造一个「加这列之前」的库：裸 SQL 按旧形状建表，**不经过 server/db.ts**。
		closeDb();
		const raw = new DatabaseSync(oldFile);
		raw.exec(`
			CREATE TABLE agent_turns (
				id            TEXT PRIMARY KEY,
				created_at    TEXT NOT NULL,
				user_text     TEXT NOT NULL,
				steps         INTEGER NOT NULL,
				tool_calls    INTEGER NOT NULL,
				tools         TEXT NOT NULL,
				truncated     INTEGER NOT NULL,
				aborted       INTEGER NOT NULL,
				finish_reason TEXT,
				ms            INTEGER NOT NULL,
				input_tokens  INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				error         TEXT
			);
		`);
		// 顺带塞一行"老数据"：它必须活着，且版本列读出来是 null（不是 ""）。
		raw.exec(`
			INSERT INTO agent_turns
				(id, created_at, user_text, steps, tool_calls, tools, truncated, aborted,
				 finish_reason, ms, input_tokens, output_tokens, error)
			VALUES ('legacy', '2026-09-22T00:00:00.000Z', '加列之前的一句', 1, 0, '[]', 0, 0, 'stop', 5, 1, 1, NULL);
		`);
		raw.close();

		// 2) 让生产那条路（getDb → migrate）去处理它。
		process.env.APP_DB_PATH = oldFile;
		closeDb();

		recordTurn(
			turn('after-migrate', {
				promptVersion: 'beef1234',
				promptDisabled: 'work_style',
				// 后加的列一起带上：**漏登记 `ADDED_COLUMNS` 时这一行根本写不进去**
				// （ALTER 没跑 → 列不存在 → INSERT 抛 → 被 recordTurn 吞成一行 log），
				// 于是下面的 `fresh` 断言会红。这是那条纪律的守门点。
				budgetHit: true,
			}),
		);

		const rows = recentTurns(10);
		const fresh = rows.find((r) => r.id === 'after-migrate');
		assert.ok(fresh, ' migrate 之后写入必须成功——为 null 说明 INSERT 被 recordTurn 吞了，观测会静默停摆');
		assert.equal(fresh.promptVersion, 'beef1234');
		assert.equal(fresh.budgetHit, true, 'budget_hit 也必须跟着 ALTER 补上');

		const legacy = rows.find((r) => r.id === 'legacy');
		assert.ok(legacy, '老数据不能被迁移弄丢');
		assert.equal(legacy.promptVersion, null, '老行的版本只能是 null —— "无从得知"');
		assert.equal(legacy.model, null, '同理：老行用的哪个模型也无从得知');
		assert.equal(legacy.costMicro, null, '成本 null = 不知道，不是 $0');
		assert.equal(legacy.firstTokenMs, null);
		assert.equal(legacy.budgetHit, false, '老行 = 那时还没有闸门，确实没撞过（NULL 读成 false 是对的）');
		assert.equal(legacy.userText, '加列之前的一句');
	} finally {
		closeDb();
		if (restore === undefined) delete process.env.APP_DB_PATH;
		else process.env.APP_DB_PATH = restore;
		rmSync(oldDir, { recursive: true, force: true });
	}
});

/* ── 成本与首字延迟（2026-09-23 加）────────────────────────────────── */

test('模型名、成本、首字延迟写入 → 读回（成本没有 model 就没法解释）', () => {
	recordTurn(turn('turn-cost', { model: 'agnes-2.5-flash', costMicro: 4567, firstTokenMs: 812 }));

	const [row] = recentTurns(1);
	assert.equal(row.model, 'agnes-2.5-flash');
	assert.equal(row.costMicro, 4567);
	assert.equal(row.firstTokenMs, 812);
});

/**
 * `0` 与 `null` 在这里必须是两件事 —— 与 `ms` 用 null 不用 0 是同一条判据。
 * 混起来的后果是**汇总不可信而看不出来**：没配价目表的轮次被算成免费，
 * 「这个月花了多少」于是永远偏小。
 */
test('成本 0（免费）与 null（不知道）不是一回事', () => {
	recordTurn(turn('turn-free', { costMicro: 0 }));
	recordTurn(turn('turn-unknown', { costMicro: null }));

	const rows = recentTurns(2);
	assert.equal(rows.find((r) => r.id === 'turn-free')?.costMicro, 0);
	assert.equal(rows.find((r) => r.id === 'turn-unknown')?.costMicro, null);
});

test('首字延迟 null = 这一轮一个字都没吐（不是 0ms）', () => {
	recordTurn(turn('turn-no-text', { firstTokenMs: null }));

	assert.equal(recentTurns(1)[0].firstTokenMs, null);
});

/* ── 逐 span（2026-09-23 加）─────────────────────────────────────── */

test('summarizeSpans 保留步的边界（这正是它相对 summarizeSteps 的增量）', () => {
	const spans = summarizeSpans([
		step('tool-calls', [['search_library', 12, true]]),
		step('tool-calls', [
			['build_queue', 340, true],
			['next_track', 8, true],
		]),
		step('stop', []),
	]);

	assert.deepEqual(
		spans.map((s) => s.idx),
		[0, 1, 2],
	);
	assert.deepEqual(
		spans.map((s) => s.tools.map((t) => t.name)),
		[['search_library'], ['build_queue', 'next_track'], []],
	);
	assert.deepEqual(
		spans.map((s) => s.toolMs),
		[12, 348, 0],
		'工具耗时按步求和',
	);
	assert.equal(spans[2].finishReason, 'stop', '收尾原因落在最后一步上');
});

/**
 * `toolMs` 是**下界**：取不到 `ms` 的工具按 0 计入。这条断言把这个方向钉住 ——
 * 于是「轮耗时 − Σ工具耗时」这个残差只会偏大（读成"还有时间没被解释"），
 * 不会偏小（读成"这一步很干净"）。后者会让人得出**相反的结论**。
 */
test('取不到 ms 的工具按 0 求和 → toolMs 是下界，宁可把残差算大', () => {
	const spans = summarizeSpans([
		{
			toolCalls: [{ toolCallId: 'x', toolName: 'play_track' }],
			toolResults: [{ toolCallId: 'x', toolName: 'play_track' }], // 没有 output
			finishReason: 'tool-calls',
		},
	]);

	assert.equal(spans[0].tools[0].ms, null, '取不到就是 null，不是 0');
	assert.equal(spans[0].toolMs, 0, '求和时按 0 —— 残差只会偏大');
});

test('span 落库 → 读回：一行一步，按步序', () => {
	recordSpans(
		'turn-s',
		summarizeSpans([step('tool-calls', [['search_library', 10, true]]), step('stop', [['play_track', 50, true]])]),
	);

	const rows = recentSpans('turn-s');
	assert.equal(rows.length, 2);
	assert.deepEqual(
		rows.map((r) => r.idx),
		[0, 1],
	);
	assert.deepEqual(rows[1].tools, [{ name: 'play_track', ms: 50, ok: true }]);
	assert.equal(rows[1].toolMs, 50);
});

test('同一步重放是覆盖而非新增（幂等，同 messages 表的取舍）', () => {
	recordSpans('turn-s2', summarizeSpans([step('tool-calls', [['search_library', 10, true]])]));
	recordSpans('turn-s2', summarizeSpans([step('stop', [['build_queue', 99, true]])]));

	const rows = recentSpans('turn-s2');
	assert.equal(rows.length, 1, '同 (turn_id, idx) 只应有一行');
	assert.equal(rows[0].tools[0].name, 'build_queue', '覆盖要带上后来的内容');
});

test('没有 span 的轮次读回空数组（而不是抛）', () => {
	assert.deepEqual(recentSpans('never-recorded'), []);
});

/* ── B1 的 kind 要活着进观测 ──────────────────────────────────────── */

/**
 * 这几条钉的是**「谁来修」这个判断别在观测层丢掉**：B1 把 `kind` 交给模型了
 * （`[transport] …` 前缀），可观测侧原来只存 `{name, ms, ok}` —— 事后翻记录
 * 只能得到"有个工具失败了"，而"该改提示词"与"该去把服务起起来"是两件事。
 */
test('summarizeSteps：工具输出里的 kind 落进 tools；没有 kind 时不写这个字段', () => {
	const summary = summarizeSteps(
		[
			{
				toolCalls: [
					{ toolCallId: 'a', toolName: 'search_library' },
					{ toolCallId: 'b', toolName: 'play_track' },
				],
				toolResults: [
					{
						toolCallId: 'a',
						toolName: 'search_library',
						output: { ok: false, text: '连不上', ms: 12, kind: 'transport' },
					},
					// 成功的那条：**整个字段省略**（省得每一行都背一个空值）
					{ toolCallId: 'b', toolName: 'play_track', output: { ok: true, text: '放了', ms: 30 } },
				],
				finishReason: 'stop',
			},
		],
		{ maxSteps: 5 },
	);

	assert.deepEqual(summary.tools, [
		{ name: 'search_library', ms: 12, ok: false, kind: 'transport' },
		{ name: 'play_track', ms: 30, ok: true },
	]);
});

test('summarizeSpans：逐 span 里也带 kind（不然下钻到"哪一步"就断了）', () => {
	const spans = summarizeSpans([
		{
			toolCalls: [{ toolCallId: 'a', toolName: 'build_queue' }],
			toolResults: [
				{
					toolCallId: 'a',
					toolName: 'build_queue',
					output: { ok: false, text: '坏了', ms: 5, kind: 'unavailable' },
				},
			],
			finishReason: 'stop',
		},
	]);
	assert.deepEqual(spans[0].tools, [{ name: 'build_queue', ms: 5, ok: false, kind: 'unavailable' }]);
});

test('认不出的 kind 一律丢掉 —— 观测从 JSON 里读，不信类型断言', () => {
	// 手工改过库、或将来删掉某种 kind 时，脏值不能变成一条假的归因依据
	const summary = summarizeSteps(
		[
			{
				toolCalls: [{ toolCallId: 'a', toolName: 'x' }],
				toolResults: [
					{ toolCallId: 'a', toolName: 'x', output: { ok: false, text: '', ms: 1, kind: 'whatever' } },
				],
				finishReason: 'stop',
			},
		],
		{ maxSteps: 5 },
	);
	assert.deepEqual(summary.tools, [{ name: 'x', ms: 1, ok: false }]);
});

test('落库再读回，kind 不丢（写入是 JSON，读取只在 ok===false 那一格上用它）', () => {
	recordTurn(
		turn('kind-roundtrip', {
			tools: [{ name: 'search_library', ms: 12, ok: false, kind: 'transport' }],
		}),
	);
	assert.deepEqual(recentTurns(1)[0].tools, [
		{ name: 'search_library', ms: 12, ok: false, kind: 'transport' },
	]);

	recordTurn(turn('kind-absent'));
	assert.equal(
		recentTurns(1)[0].tools[0].kind,
		undefined,
		'成功 / 老行读出来都是 undefined —— 那是一回事',
	);
});

test('summarizeSteps：budgetHit 只透传调用方给的布尔，不从 steps 反推', () => {
	// 五步、最后一步仍在要工具 —— 形状与"撞步数上限"一模一样，
	// 而这正是**不能靠反推**的原因：光看 steps 分不出是哪一种上限。
	const steps: StepLike[] = Array.from({ length: 5 }, () => step('tool-calls', [['x', 1, true]]));
	assert.equal(summarizeSteps(steps, { maxSteps: 5 }).budgetHit, false);
	assert.equal(summarizeSteps(steps, { maxSteps: 5, budgetHit: true }).budgetHit, true);
});

test('budgetHit：落库 → 读回不丢；不带时默认 false', () => {
	recordTurn(turn('budget-yes', { budgetHit: true }));
	assert.equal(recentTurns(1)[0].budgetHit, true);

	recordTurn(turn('budget-default'));
	assert.equal(recentTurns(1)[0].budgetHit, false, '夹具默认没撞预算');
});

test('budgetHit 与 truncated 是两列、互不覆盖（合成一列就分不出该改哪个上限）', () => {
	recordTurn(turn('both-hits', { truncated: true, budgetHit: true }));
	const row = recentTurns(1)[0];
	assert.equal(row.truncated, true);
	assert.equal(row.budgetHit, true);

	recordTurn(turn('only-budget', { truncated: false, budgetHit: true }));
	const other = recentTurns(1)[0];
	assert.equal(other.truncated, false);
	assert.equal(other.budgetHit, true, '只撞预算的那一轮，truncated 必须是 false');
});
