/**
 * `cases/report.ts` 单测 —— 「这条补丁还需不需要」的判定规则。
 *
 * 为什么这个纯模块值得单独钉住：**它是唯一会说出"可以删"的地方**，而那个决定不可逆
 * （补丁的存在理由就是那几条失败案例，删了之后没人会再验）。所以这些用例里最要紧的
 * 不是"能判出 working"，而是**每一条"拒绝下结论"的分支**都真的会拒绝：
 * 环境抖动、方向不明、变量不止一个、带着它自己也红 —— 这些情形下说错一句
 * 「可以删」，就会让一条还在做事的补丁永久消失。
 *
 * 同族纪律（见 `cases.mts` 的 `Problem` 注释）：一次 120s 超时与一次"它选错了工具"
 * 在屏幕上都是"红了一条"，但前者说明不了任何关于补丁的事。`infra` 就是为了把这两件事
 * 分开 —— 下面的用例专门盯这条界线。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	REPORT_KIND,
	REPORT_SCHEMA,
	casesGuarding,
	comparability,
	isDisabled,
	patchIdsOf,
	patchVerdict,
	parseReport,
	readReport,
	realFailures,
	writeReport,
	type CaseProblem,
	type CaseResult,
	type CasesReport,
} from './report';

/* ── 夹具 ────────────────────────────────────────────────────────────── */

function caseOf(over: Partial<CaseResult> & { id: string }): CaseResult {
	return {
		guards: [],
		input: `（${over.id} 的输入）`,
		pass: true,
		passed: 1,
		repeat: 1,
		problems: [],
		steps: [2],
		ms: [1200],
		chains: ['search_songs'],
		...over,
	};
}

/** 一条**判据失败**（能归因给补丁）。 */
function failed(id: string, guards: string[], text = '没有调 build_queue'): CaseResult {
	return caseOf({ id, guards, pass: false, passed: 0, problems: [{ text, infra: false }] });
}

/** 一条**只有环境类问题**的失败 —— 不能归因给补丁。 */
function infraFailed(id: string, guards: string[]): CaseResult {
	return caseOf({
		id,
		guards,
		pass: false,
		passed: 0,
		problems: [{ text: '本轮没有正常结束（超过 120s）', infra: true }],
	});
}

function report(over: Partial<CasesReport> = {}): CasesReport {
	return {
		kind: REPORT_KIND,
		schema: REPORT_SCHEMA,
		label: 'full',
		base: 'http://127.0.0.1:3200',
		versions: ['v1'],
		disabled: [[]],
		repeat: 1,
		startedAt: '2026-09-23T00:00:00.000Z',
		finishedAt: '2026-09-23T00:01:00.000Z',
		cases: [],
		...over,
	};
}

/** 「带着补丁」的那一份。 */
const withPatch = (cases: CaseResult[]) => report({ label: 'full', cases });
/** 「关掉 work_style」的那一份。 */
const withoutPatch = (cases: CaseResult[]) =>
	report({ label: 'no-work_style', base: 'http://127.0.0.1:3201', disabled: [['work_style']], cases });

const P = 'work_style';

/* ── parseReport：判定字段一律抛 ─────────────────────────────────────── */

test('parseReport：kind / schema 不对就抛（拿别的 JSON 进来要说"这不是报告"）', () => {
	assert.throws(() => parseReport(null), /不是一个 JSON 对象/);
	assert.throws(() => parseReport({ kind: '别的', schema: 1, cases: [] }), /这是别的文件/);
	assert.throws(() => parseReport({ kind: REPORT_KIND, schema: 999, cases: [] }), /只认 1/);
});

test('parseReport：`problems[].infra` 缺字段必须抛，**不许默认 false**', () => {
	// 默认 false 的含义是"这条失败可以归因给补丁" —— 而它恰好会给出
	// 「补丁还在起作用，保留」。一个缺字段的旧报告会因此变成一条虚假的"保留"证据。
	const bad = report({ cases: [caseOf({ id: 'a' })] }) as unknown as Record<string, unknown>;
	(bad.cases as Array<Record<string, unknown>>)[0].problems = [{ text: '没有调 build_queue' }];
	assert.throws(() => parseReport(bad), /infra 不是布尔/);
});

test('parseReport：判定字段坏了抛，展示字段坏了只是降级（两档严格度是有意的）', () => {
	const raw = report({ cases: [caseOf({ id: 'a' })] }) as unknown as Record<string, unknown>;
	const first = (raw.cases as Array<Record<string, unknown>>)[0];

	// 展示字段：整段删掉也不拦，只影响报告里的一行字。
	first.steps = '不是数组';
	first.chains = null;
	const ok = parseReport(raw);
	assert.deepEqual(ok.cases[0].steps, []);
	assert.deepEqual(ok.cases[0].chains, []);

	// 判定字段：错一格就必须拦 —— 它会让结论翻面。
	first.pass = 'yes';
	assert.throws(() => parseReport(raw), /pass 不是布尔/);
});

test('parseReport → writeReport → readReport 原样往返', () => {
	const dir = mkdtempSync(join(tmpdir(), 'cases-report-'));
	try {
		const file = join(dir, 'r.json');
		const original = report({ cases: [failed('queue-position', [P])] });
		writeReport(file, original);
		assert.deepEqual(readReport(file), original);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('readReport：读不到 / 不是 JSON 都给一句能读的原因（不留半份）', () => {
	assert.throws(() => readReport(join(tmpdir(), '这一定不存在-cases-report.json')), /读不到/);
});

/* ── comparability：三种"不可比"要分得开 ─────────────────────────────── */

test('comparability：正常报告返回 null', () => {
	assert.equal(comparability(report()), null);
});

test('comparability：同一次跑里多个版本 / 多套 disabled 都要拦（中途换过进程或配置）', () => {
	assert.match(String(comparability(report({ versions: ['v1', 'v2'] }))), /多个提示词版本/);
	assert.match(String(comparability(report({ disabled: [[], [P]] }))), /多套「关掉的补丁」/);
});

test('comparability：没有 x-prompt-version 要说到"旧构建"（改完 agent 忘了 build 的坑）', () => {
	const why = comparability(report({ versions: [null] }));
	assert.match(String(why), /旧构建/);
});

test('comparability：**没回 disabled 头 ≠ 回了空串**（一个说不知道，一个说全启用）', () => {
	assert.equal(comparability(report({ disabled: [[]] })), null, '回了空串 = 全部启用，可比');
	assert.match(String(comparability(report({ disabled: [null] }))), /x-prompt-disabled/, '没回这个头 = 判不出方向');
});

/* ── 读侧小工具 ──────────────────────────────────────────────────────── */

test('isDisabled / casesGuarding：只认受它管的那些 case', () => {
	const r = withoutPatch([caseOf({ id: 'base' }), failed('guarded', [P])]);
	assert.equal(isDisabled(r, P), true);
	assert.equal(isDisabled(report(), P), false);
	assert.deepEqual(casesGuarding(r, P).map((c) => c.id), ['guarded']);
});

test('realFailures：环境类的失败**不计票**（这条界线是整条判定链的承重墙）', () => {
	assert.deepEqual(realFailures(caseOf({ id: 'ok' })), []);
	assert.deepEqual(realFailures(failed('a', [P])), ['没有调 build_queue']);
	assert.deepEqual(realFailures(infraFailed('b', [P])), []);
});

/* ── patchVerdict：方向 ──────────────────────────────────────────────── */

test('patchVerdict：方向自己判 —— 补丁关在 A 上时，带补丁的那份是 B', () => {
	const a = withoutPatch([failed('guarded', [P])]);
	const b = withPatch([caseOf({ id: 'guarded', guards: [P] })]);
	const v = patchVerdict(a, b, P);
	assert.equal(v.withTag, 'B');
	assert.equal(v.withoutTag, 'A');
	assert.equal(v.kind, 'working');
});

test('patchVerdict：两次都带着 / 都关着 → no-direction（同版本重跑判不出补丁）', () => {
	const both = withPatch([failed('guarded', [P])]);
	const v = patchVerdict(both, both, P);
	assert.equal(v.kind, 'no-direction');
	assert.match(v.warnings[0], /都带着/);
	assert.match(v.warnings[0], /CASES_REPEAT|PROMPT_DISABLE/);
});

/* ── patchVerdict：四种"没测出" ──────────────────────────────────────── */

test('patchVerdict：没有守着它的 case → no-evidence', () => {
	const v = patchVerdict(withPatch([caseOf({ id: 'base' })]), withoutPatch([caseOf({ id: 'base' })]), P);
	assert.equal(v.kind, 'no-evidence');
});

test('patchVerdict：**带着它**那一版自己也红 → with-failing（不许当成"补丁有用"）', () => {
	const v = patchVerdict(withPatch([failed('guarded', [P])]), withoutPatch([failed('guarded', [P])]), P);
	assert.equal(v.kind, 'with-failing');
	assert.deepEqual(v.withReal.map((c) => c.id), ['guarded']);
});

test('patchVerdict：关掉之后只红在环境上 → inconclusive（与补丁无关）', () => {
	const v = patchVerdict(withPatch([caseOf({ id: 'guarded', guards: [P] })]), withoutPatch([infraFailed('guarded', [P])]), P);
	assert.equal(v.kind, 'inconclusive');
	assert.deepEqual(v.withoutBad.map((c) => c.id), ['guarded']);
	assert.deepEqual(v.withoutReal, []);
});

test('patchVerdict：其中一份说不清版本 → not-comparable（任何方向都可能是错的）', () => {
	const a = withPatch([caseOf({ id: 'guarded', guards: [P] })]);
	const b = withoutPatch([infraFailed('guarded', [P])]);
	b.versions = [null]; // 没回版本头 = 旧构建
	const v = patchVerdict(a, b, P);
	assert.equal(v.kind, 'not-comparable');
	assert.match(v.warnings[0], /旧构建/);
});

/* ── patchVerdict：两种"有结论" ──────────────────────────────────────── */

test('patchVerdict：关掉之后出现判据失败 → working（保留）', () => {
	const v = patchVerdict(
		withPatch([caseOf({ id: 'guarded', guards: [P] })]),
		withoutPatch([failed('guarded', [P], '没有调 batch_by_mood')]),
		P,
	);
	assert.equal(v.kind, 'working');
	assert.deepEqual(v.withoutReal.map((c) => c.id), ['guarded']);
	assert.deepEqual(realFailures(v.withoutReal[0]), ['没有调 batch_by_mood']);
});

test('patchVerdict：关掉之后全过 → removable（这是唯一敢说"可以删"的分支）', () => {
	const v = patchVerdict(
		withPatch([caseOf({ id: 'guarded', guards: [P] }), failed('other', [])]),
		withoutPatch([caseOf({ id: 'guarded', guards: [P] }), failed('other', [])]),
		P,
	);
	assert.equal(v.kind, 'removable');
	assert.equal(v.shared.length, 1, '基线那条不归它管，不该算进来');
});

/* ── patchVerdict：提醒（不改变结论，但改变这句话有多可信）────────────── */

test('patchVerdict：**"带补丁"那一版还关着别的补丁**要提醒（变量不止一个）', () => {
	const a = report({
		label: 'full',
		disabled: [['other_patch']],
		cases: [caseOf({ id: 'guarded', guards: [P] })],
	});
	const b = withoutPatch([failed('guarded', [P])]);
	const v = patchVerdict(a, b, P);
	assert.equal(v.kind, 'working', '带着它是绿的、关掉才红 —— 结论仍成立，只是可信度要打折');
	assert.ok(
		v.warnings.some((w) => w.includes('other_patch') && w.includes('污染')),
		`另一版还关着别的补丁时该提醒，实际：${JSON.stringify(v.warnings)}`,
	);
});

test('patchVerdict：两次的案例集不一样时只说共有的那几条能比', () => {
	const a = withPatch([caseOf({ id: 'guarded', guards: [P] }), caseOf({ id: 'only-in-a', guards: [P] })]);
	const b = withoutPatch([failed('guarded', [P]), caseOf({ id: 'only-in-b', guards: [P] })]);
	const v = patchVerdict(a, b, P);
	assert.equal(v.shared.length, 1);
	assert.ok(v.warnings.some((w) => /案例集不一样/.test(w) && w.includes('only-in-a') && w.includes('only-in-b')));
});

test('patchVerdict：不归它管的 case 只在"关掉它"那一版红了 → 记成 sideEffects', () => {
	const a = withPatch([caseOf({ id: 'guarded', guards: [P] }), caseOf({ id: 'bystander' })]);
	const b = withoutPatch([caseOf({ id: 'guarded', guards: [P] }), failed('bystander', [])]);
	const v = patchVerdict(a, b, P);
	assert.equal(v.kind, 'removable');
	assert.deepEqual(v.sideEffects.map((c) => c.id), ['bystander'], '副作用要看得见，但不当成补丁的证据');
});

/* ── 杂项 ────────────────────────────────────────────────────────────── */

test('patchIdsOf：按首次出现顺序去重', () => {
	const a = withPatch([failed('x', ['p2', 'p1']), failed('y', ['p1', 'p3'])]);
	const b = withoutPatch([]);
	assert.deepEqual(patchIdsOf(a, b), ['p2', 'p1', 'p3']);
});

test('CaseProblem 的线是"能不能归因"，不是"严不严重"', () => {
	// 一条判据失败是"轻"的（少说了一句话），但**能**归因给补丁；
	// 一次超时是"重"的（整轮没结束），但**不能**。按严重程度分就分错了。
	const lightButAttributable: CaseProblem = { text: '回答里没有「第 3 首」', infra: false };
	const heavyButNotAttributable: CaseProblem = { text: '超过 120s 未结束', infra: true };
	assert.deepEqual(realFailures(caseOf({ id: 'a', pass: false, problems: [lightButAttributable] })), [
		'回答里没有「第 3 首」',
	]);
	assert.deepEqual(realFailures(caseOf({ id: 'b', pass: false, problems: [heavyButNotAttributable] })), []);
});
