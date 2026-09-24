/**
 * 案例集报告的形状与**判定** —— `scripts/cases.mts`（写）与 `scripts/cases-diff.mts`（读+比）
 * 共用这一份。
 *
 * ── 它为什么在这里（`cases/`）而不是 `scripts/` 或 `contract/` ─────────────────
 * - **不在 `scripts/`**：`tsconfig.json` 只把 `scripts/` 下的 `.mts` 放进类型检查，而
 *   `moduleResolution: bundler` 不认 `./cases-report.mts` 这种带扩展名的相对导入
 *   （`TS5097` / `TS2307`，实测撞过）。于是"共享模块放 scripts 里"要么开
 *   `allowImportingTsExtensions` 动全仓 tsconfig，要么让模块躲过 tsc —— 两条都不划算。
 * - **不在 `contract/`**：`contract/` 的定义是「前后端共享契约，前端能引用的服务端类型
 *   只能来自这里」。这个模块前端一行都不引，塞进去只会让 `contract/` 的边界变模糊。
 * - **在 `cases/`**：这个目录的定义就是「测 agent 的，不是 agent 的一部分」
 *   （AGENTS.md）—— 「这条补丁还需不需要」正是它的题目。`failure-cases.json` 是题目，
 *   这个文件是判卷规则。
 *
 * ── 为什么判定逻辑要抽成纯函数，而不是写在 `cases-diff.mts` 里 ────────────
 * 它是**唯一会说出"这条补丁可以删"的地方**，而那个决定不可逆：补丁的存在理由就是
 * 那几条失败案例（见 `cases.mts` 文件头），删了之后没人会再验。所以每一条"拒绝下结论"
 * 的分支都必须能被断言 —— 写在脚本里就等于没有测试（`scripts/**` 没有单测地位）。
 *
 * ── 「不信类型断言」在这里是硬要求 ──────────────────────────────────────
 * `parseReport` 收的是 `unknown`，逐字段验。JSON 是**别的进程、别的版本**写下的，
 * `as CasesReport` 只让编译器闭嘴，运行时该崩还是崩 —— 而且会崩在
 * `report.cases.map(...)` 那种离现场很远的地方。所以入口就一道，验不过就抛。
 *
 * ── 验的严格度分两档（有意的）──────────────────────────────────────────
 * - **判定字段**（`id` / `guards` / `pass` / `passed` / `repeat` / `problems`）：错一格
 *   就会给出错误结论 → 一律抛，宁可不比。
 * - **展示字段**（`input` / `steps` / `ms` / `chains`）：坏掉只影响一行字
 *   → 缺就用默认值，不让一个坏字段把整次对比拦死。
 * 分界线是「这个字段错了，会不会让我因此删掉一条还在做事的补丁」。
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** 报告格式的标识。读侧先看它 —— 拿一份别的 JSON 进来要说「这不是报告」，不是崩在读字段上。 */
export const REPORT_KIND = 'song-lite/cases-report';

/** 报告格式的版本。**改形状就 +1**：读侧靠它拒绝旧报告，而不是猜字段还在不在。 */
export const REPORT_SCHEMA = 1;

/** 一条失败原因。`infra` = **这条不能归因给补丁**（超时 / 工具报错 / 队列复位失败）。 */
export type CaseProblem = { text: string; infra: boolean };

export type CaseResult = {
	id: string;
	/** 这条守哪些补丁（`agent/prompt.ts` 的 `PATCH_IDS`）。空数组 = **基线**。 */
	guards: string[];
	/** 这条问的是什么（给人看的）。 */
	input: string;
	/** 这条是否整体通过（`repeat` 遍**全过**才算）。 */
	pass: boolean;
	/** 通过的遍数（`passed/repeat`）。 */
	passed: number;
	repeat: number;
	/** 每一遍的失败原因，**已带遍号**（`第 2 遍：没有调 build_queue`）。 */
	problems: CaseProblem[];
	// ── 以下是展示字段（判定不拿它们做依据）──
	steps: number[];
	ms: number[];
	chains: string[];
};

export type CasesReport = {
	kind: string;
	schema: number;
	/**
	 * 这一版的自称（`CASES_LABEL`）。默认由 `disabled` 推出来（`full` / `off:work_style`），
	 * 只为在对比表里一眼认出「哪条是哪条」—— **判定方向不看它，看 `disabled`**：
	 * 手写的标签可能写反，而 `disabled` 是服务响应头原样记下来的。
	 */
	label: string;
	/** 跑的是哪个实例。 */
	base: string;
	/**
	 * 这次跑里**每一条 case** 见到的 `x-prompt-version`，去重后的列表。
	 * - 长度 > 1：中途进程被换过（重启 / 热重载）→ 整组数字不可比；
	 * - 唯一一项是 `null`：服务**没回**这个头 → 多半是**旧构建**（改完 `agent/**` 忘了 `npm run build`）。
	 *
	 * 这两件事必须分得开，所以是列表 + 可空项，而不是一个 `string | null`：
	 * 合成一个值之后，读侧就分不清"没比成"和"比了一个不存在的版本"。
	 */
	versions: (string | null)[];
	/**
	 * 同上，`x-prompt-disabled` 拆逗号后的**各个取值**（去重）。长度 > 1 同样意味着
	 * 中途配置变过。`null`（而不是空数组）= **服务没回这个头**（旧构建）——
	 * 与"回了空串"必须分开：空串是「全部启用」，没回是「不知道」，而默认值
	 * 恰好会把后者读成前者（于是"判不出方向"会被读成"这一版带全部补丁"）。
	 */
	disabled: (string[] | null)[];
	/** 每条 case 跑几遍（`CASES_REPEAT`）。两边不等时不能拿 `k/N` 直接比。 */
	repeat: number;
	startedAt: string;
	finishedAt: string;
	cases: CaseResult[];
};

/* ── 读 ──────────────────────────────────────────────────────────────── */

function bad(msg: string): never {
	throw new Error(msg);
}

/**
 * 把一份 `unknown`（`JSON.parse` 的结果）验成 `CasesReport`。**验不过是抛，不是返回 null**：
 * 调用方拿不到半份报告，就不存在"凑合着用"的可能。
 */
export function parseReport(raw: unknown): CasesReport {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('不是一个 JSON 对象');
	const r = raw as Record<string, unknown>;

	if (r.kind !== REPORT_KIND) {
		bad(`kind 是 ${JSON.stringify(r.kind ?? null)}，不是 ${REPORT_KIND} —— 这是别的文件？`);
	}
	if (r.schema !== REPORT_SCHEMA) {
		bad(
			`报告格式版本是 ${JSON.stringify(r.schema ?? null)}，本工具只认 ${REPORT_SCHEMA}` +
				' —— 请用与它配套的那一版 cases.mts 重新生成。',
		);
	}

	const casesRaw = r.cases;
	if (!Array.isArray(casesRaw)) bad('cases 不是数组');

	const cases = casesRaw.map((c, i): CaseResult => {
		if (!c || typeof c !== 'object') bad(`cases[${i}] 不是对象`);
		const o = c as Record<string, unknown>;

		// ── 判定字段：错一格就会给出错误结论 → 一律抛 ──
		if (typeof o.id !== 'string' || !o.id) bad(`cases[${i}].id 不是非空字符串`);
		if (!Array.isArray(o.guards) || o.guards.some((g) => typeof g !== 'string')) {
			bad(`cases[${i}].guards 不是字符串数组`);
		}
		if (typeof o.pass !== 'boolean') bad(`cases[${i}].pass 不是布尔`);
		if (typeof o.passed !== 'number' || typeof o.repeat !== 'number') {
			bad(`cases[${i}] 的 passed/repeat 不是数字`);
		}
		if (!Array.isArray(o.problems)) bad(`cases[${i}].problems 不是数组`);
		const problems = o.problems.map((p, j): CaseProblem => {
			if (!p || typeof p !== 'object') bad(`cases[${i}].problems[${j}] 不是对象`);
			const q = p as Record<string, unknown>;
			if (typeof q.text !== 'string') bad(`cases[${i}].problems[${j}].text 不是字符串`);
			// ⚠️ **不默认 false**：`infra` 缺了就意味着"这条失败可以归因给补丁"，
			// 而默认值恰好会给出这个结论 —— 一个缺字段的旧报告会因此变成
			// 「补丁还在起作用，保留」。要它显式写着。
			if (typeof q.infra !== 'boolean') bad(`cases[${i}].problems[${j}].infra 不是布尔`);
			return { text: q.text, infra: q.infra };
		});

		// ── 展示字段：坏掉只影响一行字 → 给默认值，不拦死整次对比 ──
		return {
			id: o.id,
			guards: o.guards as string[],
			input: typeof o.input === 'string' ? o.input : '（报告里没记这条的输入）',
			pass: o.pass,
			passed: o.passed,
			repeat: o.repeat,
			problems,
			steps: numArray(o.steps),
			ms: numArray(o.ms),
			chains: strArray(o.chains),
		};
	});

	return {
		kind: REPORT_KIND,
		schema: REPORT_SCHEMA,
		label: typeof r.label === 'string' && r.label ? r.label : '（无标签）',
		base: typeof r.base === 'string' ? r.base : '',
		versions: Array.isArray(r.versions)
			? r.versions.map((v) => (typeof v === 'string' ? v : null))
			: bad('versions 不是数组'),
		disabled: Array.isArray(r.disabled)
			? r.disabled.map((d): string[] | null => {
					if (d === null) return null;
					if (!Array.isArray(d) || d.some((x) => typeof x !== 'string')) {
						bad('disabled 不是「（字符串数组 或 null）」的数组');
					}
					return d as string[];
				})
			: bad('disabled 不是数组'),
		repeat: typeof r.repeat === 'number' ? r.repeat : (cases[0]?.repeat ?? 1),
		startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
		finishedAt: typeof r.finishedAt === 'string' ? r.finishedAt : '',
		cases,
	};
}

function numArray(v: unknown): number[] {
	return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

function strArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 从磁盘读一份报告。**读不了就抛**，不留半份。 */
export function readReport(file: string): CasesReport {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch (err) {
		throw new Error(`读不到 ${file}：${err instanceof Error ? err.message : String(err)}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`${file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
	}
	return parseReport(raw);
}

/* ── 写 ──────────────────────────────────────────────────────────────── */

/**
 * 落盘。**失败要炸**（抛出去，由 `cases.mts` 收成退出码 2）。
 *
 * 不能"写不成就算了"：`CASES_REPORT` 指向的路径写不进去时，文件多半**还在上一次的位置**
 * —— 下游 `cases:diff` 会读到那份旧报告，然后给出一个**关于旧数据的新结论**。
 * 那比"没有报告"糟得多：没有报告你会去重跑，有旧报告你会直接信。
 */
export function writeReport(file: string, report: CasesReport): void {
	writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/* ── 读侧的三个小工具（唯一入口，别在 cases-diff 里另写一份）────────────── */

/**
 * 这份报告能不能拿来跟另一份比。`null` = 能；否则是**说不清**的原因（一句人话）。
 *
 * 三种"不可比"各自对应一个真实事故，所以分开说：
 * ① 一次跑里出现多个版本 → 中途进程被换过，两次的样本不是同一个对象；
 * ② 一次跑里出现多套 disabled → 中途配置变过，方向都判不出来；
 * ③ 没有版本头 / 没有 disabled 头 → 服务是旧构建（改完 `agent/**` 忘了 `npm run build`，
 *    AGENTS.md 明写的高频坑），报告标题指向的版本根本不存在。
 */
export function comparability(r: CasesReport): string | null {
	if (r.versions.length === 0) return '报告里没有版本信息（写侧没记？）';
	if (r.versions.length > 1) {
		return (
			`同一次跑里出现了多个提示词版本：${r.versions.map((v) => v ?? '（无）').join(' / ')}` +
			' —— 中途进程被换过（重启 / 热重载），整组数字不可比。'
		);
	}
	if (r.disabled.length > 1) {
		return (
			'同一次跑里出现过多套「关掉的补丁」：' +
			`${r.disabled.map((d) => (d === null ? '（无这个头）' : d.join(',') || '（全启用）')).join(' / ')}` +
			' —— 中途配置变过，判不出它是"带补丁"还是"不带"。'
		);
	}
	if (r.versions[0] === null) {
		return (
			'响应里没有 x-prompt-version —— 服务多半是**旧构建**' +
			'（改完 agent/** 忘了 npm run build）。这一版跑的是什么，报告上说不了。'
		);
	}
	if (r.disabled[0] === null || r.disabled.length === 0) {
		// 走到这里版本头是有的（上面拦过了），所以这是"两个头只回了一个"的怪情形。
		return '响应里没有 x-prompt-disabled —— 判不出哪些补丁是关着的，方向无从谈起。';
	}
	return null;
}

/** 这次跑里补丁 `id` 是关掉的吗。**只在 `comparability()` 通过时调**（多套取值 / 没有头时语义不明）。 */
export function isDisabled(r: CasesReport, id: string): boolean {
	return (r.disabled[0] ?? []).includes(id);
}

/** 这次跑的版本（`comparability()` 通过时的唯一一项）。 */
export function versionOf(r: CasesReport): string | null {
	return r.versions[0] ?? null;
}

/** 这次跑里，受补丁 `id` 管的 case（`guards` 含它）—— 只有它们才是这个补丁的证据。 */
export function casesGuarding(r: CasesReport, id: string): CaseResult[] {
	return r.cases.filter((c) => c.guards.includes(id));
}

/**
 * 一条 case 失败里**能归因给补丁**的那些理由（非环境类）。
 *
 * 这是整条判定链的承重墙：一次 120s 超时与一次"它选错了工具"在屏幕上都是"红了一条"，
 * 但前者说明不了任何关于补丁的事。混在一起的下场是**把基础设施抖动记成"补丁还在起作用"**,
 * 而那条补丁就永远删不掉了（没人敢删一条"有失败案例守着"的东西）。
 */
export function realFailures(c: CaseResult): string[] {
	if (c.pass) return [];
	return c.problems.filter((p) => !p.infra).map((p) => p.text);
}

/* ── 补丁判定 ────────────────────────────────────────────────────────── */

export type PatchVerdictKind =
	/** 有一份报告说不清自己的版本 / 开关 → 任何方向的结论都可能是错的。 */
	| 'not-comparable'
	/** 两次都带着 / 都关着这条补丁 → 判不出它做没做事。 */
	| 'no-direction'
	/** 两份报告里都没有守着它的 case → 没有证据。 */
	| 'no-evidence'
	/** **带着它**那一版自己也红了 → 这条 case 现在守不住它，先查它为什么红。 */
	| 'with-failing'
	/** 关掉之后出了非环境类的失败 → 它还在做事，**保留**。 */
	| 'working'
	/** 关掉之后的失败**全部**是环境类 → 这一轮测不出。 */
	| 'inconclusive'
	/** 关掉之后**全过** → 它已经没在做事，**可以删**。 */
	| 'removable';

/** 给出明确结论的那两种（其余都是"没测出"，下游据此判断退出码）。 */
export const DEFINITE_KINDS: readonly PatchVerdictKind[] = ['working', 'removable'];

export type PatchVerdict = {
	patch: string;
	kind: PatchVerdictKind;
	/** 「带补丁」那一版是哪一份（`'A'` / `'B'`）。方向由 `disabled` 判出来，不看标签。 */
	withTag: 'A' | 'B';
	withLabel: string;
	withoutTag: 'A' | 'B';
	withoutLabel: string;
	/** 受它管、且两份报告里**都有**的 case（`k/N` 的分母）。 */
	shared: CaseResult[];
	withBad: CaseResult[];
	withoutBad: CaseResult[];
	/** 各自**非环境类**的失败（只有它们计票）。 */
	withReal: CaseResult[];
	withoutReal: CaseResult[];
	/** 不归它管、但只在"关掉它"那一版里红了的 case —— 可能的副作用。 */
	sideEffects: CaseResult[];
	/** 影响可信度、但不能改变"该不该删"的提醒（多变量 / 案例集不同）。 */
	warnings: string[];
};

/**
 * 判一条补丁还需不需要。**方向自己判**（看每份报告的 `disabled`），因为"哪份是带补丁的"
 * 恰恰是最容易搞反的一步 —— 交给调用方就是把一个可测的分支变成一句注释。
 */
export function patchVerdict(a: CasesReport, b: CasesReport, patch: string): PatchVerdict {
	const reason = comparability(a) ?? comparability(b);
	const shell = {
		patch,
		withTag: 'A' as const,
		withLabel: a.label,
		withoutTag: 'B' as const,
		withoutLabel: b.label,
		shared: [] as CaseResult[],
		withBad: [] as CaseResult[],
		withoutBad: [] as CaseResult[],
		withReal: [] as CaseResult[],
		withoutReal: [] as CaseResult[],
		sideEffects: [] as CaseResult[],
		warnings: [] as string[],
	};
	if (reason) return { ...shell, kind: 'not-comparable', warnings: [reason] };

	const aOff = isDisabled(a, patch);
	const bOff = isDisabled(b, patch);
	if (aOff === bOff) {
		return {
			...shell,
			kind: 'no-direction',
			warnings: [
				`两次**都${aOff ? '关着' : '带着'}** ${patch} —— 这是一组同版本重跑，只能看稳定性。` +
					`要判断它做没做事，把其中一次换成 PROMPT_DISABLE=${patch}。`,
			],
		};
	}

	const withR = aOff ? b : a;
	const withoutR = aOff ? a : b;
	const withTag = aOff ? ('B' as const) : ('A' as const);
	const withoutTag = aOff ? ('A' as const) : ('B' as const);

	const warnings: string[] = [];
	// 变量不止一个：这一版还关着别的补丁 → 差就不是 `patch` 造成的了。
	const otherOff = (withR.disabled[0] ?? []).filter((x) => x !== patch);
	if (otherOff.length > 0) {
		warnings.push(
			`「带补丁」那一版（${withR.label}）还关着 ${otherOff.join('、')} —— ` +
				`这次比的不是「有/没有 ${patch}」，多出来的变量会污染结论。`,
		);
	}

	const wAll = casesGuarding(withR, patch);
	const woAll = casesGuarding(withoutR, patch);
	const sharedIds = new Set(wAll.filter((w) => woAll.some((o) => o.id === w.id)).map((c) => c.id));
	if (sharedIds.size !== wAll.length || sharedIds.size !== woAll.length) {
		const miss = [...new Set([...wAll, ...woAll].filter((c) => !sharedIds.has(c.id)).map((c) => c.id))];
		warnings.push(`两次的案例集不一样，只有 ${sharedIds.size} 条共有的能比（还差：${miss.join('、')}）。`);
	}

	// ⚠️ **两侧各自取自己的那一份对象**：`shared` 只从 with 侧取（它当计数用的形态），
	// 但"关掉之后红没红"必须读**关掉那份报告里**的同一条 case。混用会让
	// `withoutBad` 永远是空的 —— 于是每条补丁都被判成 removable（"可以删"）。
	// 这个 bug 单测抓到过一次，改这里时别再"统一成一个 shared"。
	const shared = wAll.filter((c) => sharedIds.has(c.id));
	const withBad = wAll.filter((c) => sharedIds.has(c.id) && !c.pass);
	const withoutBad = woAll.filter((c) => sharedIds.has(c.id) && !c.pass);
	const withReal = withBad.filter((c) => realFailures(c).length > 0);
	const withoutReal = withoutBad.filter((c) => realFailures(c).length > 0);

	// 不归它管、但只在"关掉它"那一版红了的 —— 副作用是可能的解释之一（也可能只是环境）。
	const sideEffects = withoutR.cases.filter(
		(c) =>
			!c.guards.includes(patch) &&
			realFailures(c).length > 0 &&
			withR.cases.find((w) => w.id === c.id)?.pass === true,
	);

	const base = {
		patch,
		withTag,
		withLabel: withR.label,
		withoutTag,
		withoutLabel: withoutR.label,
		shared,
		withBad,
		withoutBad,
		withReal,
		withoutReal,
		sideEffects,
		warnings,
	};

	if (shared.length === 0) return { ...base, kind: 'no-evidence' };
	// 顺序是承重的：**先看"带着它"那一版**。"关掉之后红了"只有在"带着时是绿的"前提下
	// 才是补丁的证据；带着也红，说明这条 case 现在守不住它（可能判据过期、场景变了）。
	if (withReal.length > 0) return { ...base, kind: 'with-failing' };
	if (withoutReal.length > 0) return { ...base, kind: 'working' };
	if (withoutBad.length > 0) return { ...base, kind: 'inconclusive' };
	return { ...base, kind: 'removable' };
}

/** 一条补丁 id 在两份报告里出现过的全部（按首次出现顺序）。 */
export function patchIdsOf(...reports: CasesReport[]): string[] {
	const out: string[] = [];
	for (const r of reports) {
		for (const c of r.cases) for (const g of c.guards) if (!out.includes(g)) out.push(g);
	}
	return out;
}
