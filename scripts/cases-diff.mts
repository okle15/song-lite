/**
 * 案例集报告对比 —— `npm run cases:diff -- <A.json> <B.json>`。
 *
 * ── 它回答的就是 `cases.mts` 一直说"只能给一半"的那一半 ────────────────────
 * `cases.mts` 一次只跑一版（它只认识一个 `BASE`），所以报告末尾写着「单版只能给一半」：
 *
 *   不带补丁也全过 ⇒ 这条补丁已经没在做事，删掉它
 *   不带补丁有失败 ⇒ 它还在起作用，保留（失败的那几条就是它的边界）
 *
 * 这个判断**两个数缺一不可**，所以它需要一个能同时看到两份报告的地方。放在这里，
 * 而不是让人拿两张终端截图对着看 —— 对着看时最容易错的一步是**把环境抖动读成
 * 补丁的证据**（一次 120s 超时与一次"它选错了工具"在屏幕上都是"红了一条"）。
 *
 * ── 本文件只做两件事：读、排版 ─────────────────────────────────────────
 * 「该不该删」的判定全在 `cases/report.ts` 的 `patchVerdict()`：它是唯一会说出
 * "这条补丁可以删"的地方，而那个决定不可逆（补丁的存在理由就是那几条失败案例，
 * 删了之后没人会再验）。写成纯函数是为了它能被单测断言 —— 编排在脚本里，判定在模块里。
 *
 * 退出码：0 = 每条补丁都有明确结论；1 = 有补丁**测不出**（含方向不明 / 无证据）；
 * 2 = 用法不对或报告读不了。
 */
import {
	DEFINITE_KINDS,
	patchIdsOf,
	patchVerdict,
	readReport,
	realFailures,
	versionOf,
	type CaseResult,
	type CasesReport,
	type PatchVerdict,
} from '../cases/report';

const argv = process.argv.slice(2);
if (argv.length !== 2) {
	console.error(
		[
			'用法：npm run cases:diff -- <A.json> <B.json>',
			'',
			'两份报告由 cases.mts 落下（同一个脚本跑两个实例）：',
			'',
			'  APP_DB_PATH="C:/tmp/a.db" npm start -- -p 3200',
			'  BASE=http://127.0.0.1:3200 CASES_REPORT=full.json   CASES_LABEL=full        npm run cases',
			'',
			'  APP_DB_PATH="C:/tmp/b.db" PROMPT_DISABLE=work_style npm start -- -p 3201',
			'  BASE=http://127.0.0.1:3201 CASES_REPORT=no-ws.json  CASES_LABEL=no-work_style npm run cases',
			'',
			'  npm run cases:diff -- full.json no-ws.json',
		].join('\n'),
	);
	process.exit(2);
}

const [fileA, fileB] = argv;
let A: CasesReport;
let B: CasesReport;
try {
	A = readReport(fileA);
	B = readReport(fileB);
} catch (err) {
	console.error(`读报告失败：${err instanceof Error ? err.message : String(err)}`);
	process.exit(2);
}

/* ── 表头 ────────────────────────────────────────────────────────────── */

const WIDTH = 96;
const rule = (ch = '─') => ch.repeat(WIDTH);

function describe(tag: 'A' | 'B', r: CasesReport): string {
	const off = r.disabled.length
		? r.disabled.map((d) => (d === null ? '（无这个头）' : d.length ? `关掉 ${d.join('+')}` : '全部启用')).join(' / ')
		: '（无这个头）';
	// 多个取值 = 说不清，标个 ⚠（`comparability` 会拦，这里只是让人一眼看见）。
	const dupe = r.disabled.length > 1 ? '⚠' : ' ';
	const passed = r.cases.filter((c) => c.pass).length;
	return (
		`  ${tag} ${r.label.padEnd(18)} v:${(versionOf(r) ?? '（无头）').padEnd(10)} ${dupe}${off.padEnd(24)}` +
		` ${r.base.padEnd(22)} 每条 ${r.repeat} 遍 · ${passed}/${r.cases.length} 过`
	);
}

console.log(`\n案例集报告对比  （A = ${fileA} · B = ${fileB}）`);
console.log(rule('═'));
console.log(describe('A', A));
console.log(describe('B', B));

/* ── 逐条对比 ────────────────────────────────────────────────────────── */

/** 按 A 的顺序排，B 独有的接在后面（案例集改过之后两份的条数会不一样）。 */
const order: string[] = [];
for (const c of A.cases) order.push(c.id);
for (const c of B.cases) if (!order.includes(c.id)) order.push(c.id);

const byId = (r: CasesReport) => new Map(r.cases.map((c) => [c.id, c]));
const mapA = byId(A);
const mapB = byId(B);

const idW = Math.max(8, ...order.map((id) => id.length));
/** `k/N` 只在真跑了多遍时给：单遍时 `1/1` 是噪音。 */
const cell = (c: CaseResult | undefined): string => {
	if (!c) return '（缺）';
	if (!c.pass) return c.repeat > 1 ? `FAIL ${c.passed}/${c.repeat}` : 'FAIL';
	return c.repeat > 1 ? `PASS ${c.passed}/${c.repeat}` : 'PASS';
};

console.log('');
console.log(rule());
console.log(`  ${'case'.padEnd(idW)}  ${'A'.padEnd(9)}  ${'B'.padEnd(9)}`);
console.log(rule());

const differing: string[] = [];
for (const id of order) {
	const a = mapA.get(id);
	const b = mapB.get(id);
	// 单边缺失也算"不同"：案例集改过之后，"B 里没这条"本身是要看见的事实。
	const same = a !== undefined && b !== undefined && a.pass === b.pass;
	console.log(`  ${id.padEnd(idW)}  ${cell(a).padEnd(9)}  ${cell(b).padEnd(9)}  ${same ? '' : '←'}`);
	if (!same) differing.push(id);
}

// 只在两边结果不同时展开细节 —— 两边都红的 case，细节已经写在自己的那份报告里了。
for (const id of differing) {
	const a = mapA.get(id);
	const b = mapB.get(id);
	console.log('');
	console.log(`  ── ${id}：${a?.input ?? b?.input ?? ''}`);
	for (const [tag, c] of [
		['A', a],
		['B', b],
	] as const) {
		if (!c) {
			console.log(`     ${tag}：这份报告里没有这条 case。`);
			continue;
		}
		if (c.pass) {
			console.log(`     ${tag}：通过（${c.passed}/${c.repeat}）`);
			continue;
		}
		for (const p of c.problems) console.log(`     ${tag}：${p.infra ? '⚠ 环境 ' : '✗ '}${p.text}`);
	}
}

/* ── 补丁判定 ────────────────────────────────────────────────────────── */

const patchIds = patchIdsOf(A, B);
const verdicts: PatchVerdict[] = patchIds.map((p) => patchVerdict(A, B, p));

console.log('');
console.log(rule('═'));

/** 一句话结论。**每个 kind 都要说"所以下一步做什么"** —— 只报状态不指方向等于没判。 */
function explain(v: PatchVerdict): string[] {
	const out: string[] = [];
	const ids = (list: CaseResult[]) => list.map((c) => c.id).join('、');
	const reasons = (list: CaseResult[]) => {
		for (const c of list) for (const t of realFailures(c)) out.push(`        ✗ ${c.id}：${t}`);
	};

	switch (v.kind) {
		case 'not-comparable':
		case 'no-direction':
			out.push(`    ⚠ ${v.warnings[0] ?? '这份报告说不清自己是什么版本。'}`);
			out.push('    ⇒ **测不出** —— 别据此下结论（尤其别据此删东西）。');
			break;
		case 'no-evidence':
			out.push(`    ✗ 无证据：两份报告里都没有守着 ${v.patch} 的 case（guards 里含它的那些）。`);
			out.push(`    ⇒ **测不出** —— 想验它就得先在 cases/failure-cases.json 里给它加一条守卫。`);
			break;
		case 'with-failing':
			out.push(`    ⚠ **带着它**也没过：${ids(v.withReal)}`);
			reasons(v.withReal);
			out.push(`    ⇒ **测不出**：这条 case 现在守不住 ${v.patch}（判据过期？场景变了？）——`);
			out.push('       先查它为什么红，**别**拿"关掉之后也红"当补丁有用的证据。');
			break;
		case 'working':
			out.push(`    ⇒ **还在起作用**：关掉 ${v.patch} 之后这些 case 开始失败 —— ${ids(v.withoutReal)}。`);
			reasons(v.withoutReal);
			out.push('       保留它（这几条就是它的边界）。');
			break;
		case 'inconclusive':
			out.push(`    ⇒ **测不出**：关掉之后的失败**全部**是环境类（超时 / 工具报错）：${ids(v.withoutBad)}。`);
			out.push('       与补丁无关。这一轮没测出它在不在做事 —— 重跑一次，或调大 CASES_REPEAT。');
			break;
		case 'removable':
			out.push(`    ⇒ **已经没在做事**：关掉 ${v.patch} 之后这 ${v.shared.length} 条**全过**。`);
			out.push(`       把它从 \`agent/prompt.ts\` 的 PATCHES 里删掉（连同 cases/failure-cases.json 里它的 guards）。`);
			break;
	}
	return out;
}

if (patchIds.length === 0) {
	console.log('两份报告里都没有 `guards`（全是基线案例）—— 这套案例集现在只验环境，判不出任何补丁。');
} else {
	console.log('补丁判定');
	const repOf = (tag: 'A' | 'B') => (tag === 'A' ? A : B);
	for (const v of verdicts) {
		// `k/N` 用**各自那份**报告的 REPEAT：两次的 `CASES_REPEAT` 可能不一样，
		// 拿一份的遍数去标另一份的分母，两个数就不可比了。
		const rate = (r: CasesReport, bad: number) =>
			`${r.repeat > 1 ? `每条 ${r.repeat} 遍 · ` : ''}${v.shared.length - bad}/${v.shared.length}`;
		console.log('');
		console.log(`  ● ${v.patch}`);
		// 计数行只在方向判得出来时给 —— 方向不明时"哪份是带补丁的"根本不存在。
		if (v.kind !== 'no-direction' && v.kind !== 'not-comparable') {
			console.log(`    带着它（${v.withTag} ${v.withLabel}）：${rate(repOf(v.withTag), v.withBad.length)} 过`);
			console.log(`    关掉它（${v.withoutTag} ${v.withoutLabel}）：${rate(repOf(v.withoutTag), v.withoutBad.length)} 过`);
		}
		for (const line of explain(v)) console.log(line);

		// 提醒排在结论之后：它们不改变"该不该删"，但会改变这句话有多可信。
		for (const w of v.warnings.slice(v.kind === 'no-direction' || v.kind === 'not-comparable' ? 1 : 0)) {
			console.log(`    ⚠ ${w}`);
		}
		if (v.sideEffects.length > 0) {
			console.log(
				`    ⚠ 另注：不归它管的 ${v.sideEffects.length} 条在关掉它之后红了（${v.sideEffects.map((c) => c.id).join('、')}）` +
					' —— 可能是它的副作用，也可能是环境，值得看一眼。',
			);
		}
	}
}

/* ── 收尾 ────────────────────────────────────────────────────────────── */

const unproven = verdicts.filter((v) => !DEFINITE_KINDS.includes(v.kind));

console.log('');
console.log(rule('═'));
if (patchIds.length === 0) {
	console.log('（这套案例集里没有补丁守卫，没有补丁层面的结论可给。）\n');
} else if (unproven.length === 0) {
	console.log(`结论：${patchIds.length} 条补丁都给出了明确结论 —— 该保留的保留，该删的删。\n`);
} else {
	console.log(`⚠️ 有 ${unproven.length}/${patchIds.length} 条补丁**没测出结论**：${unproven.map((v) => v.patch).join('、')}。`);
	console.log('   别把"没测出"读成"可以删" —— 前者是证据不够，后者是证据指向删除。\n');
}

process.exit(unproven.length === 0 ? 0 : 1);
