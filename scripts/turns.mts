/**
 * 看最近几轮对话的观测（⑨）—— `npm run turns [N]`。
 *
 * ── 为什么是脚本，不是 API + 页面 ──────────────────────────────────
 * 与 `auto-tag.mts` 同一个判断：这是**给开发者自己看**的东西，不是给用户的功能。
 * 加一条 API 要顺带更新 README 的接口清单、加一条冒烟用例、加一个前端入口——
 * 而它真正被用到的场合是「刚才那轮怎么这么慢」。脚本直接读库（`server/` 是允许的，
 * 见 auto-tag.mts 的文件头），够用且不留架子。
 *
 * ── 输出里每一列都在回答一个具体问题 ──────────────────────────────
 *   步数 / 工具   这轮它走了几步、用了什么（多了说明提示词的"工作方式"该收一收）
 *   **版本**      那一轮用的是哪份系统提示词（`agent/prompt.ts` 的指纹 + 关掉的补丁）。
 *                 它是**唯一能按提示词分组**的一列：`PROMPT_DISABLE=work_style` 起一个
 *                 实例、再不带它起一个，两版的数字不会混在一起。出现多个版本时
 *                 下面会给**分组小计**（轮数 / 平均步数 / 平均耗时 / 失败工具数）。
 *   耗时          慢不慢（`ms` 是请求进来 → 流结束的墙钟）
 *   **首字**      用户等了多久才看到第一个字（`first_token_ms`；`—` = 一个字都没吐）。
 *                 它和总耗时是**两个病**：总耗时高可能是工具慢，首字高是"开口晚"。
 *                 只看总耗时会把这两种情况混成一件事，而它们的修法完全不同。
 *   **模型 / 钱**  那一轮用的哪个模型、花了多少（`cost_micro`，微美元整数）。
 *                 **两者必须同行**：价格随模型走，混着两种价目画出来的曲线看不出异常。
 *                 `—` = **不知道**花了多少（不是 0；0 是"免费"，两者不能混）。
 *                 ⚠️ 钱的多少是**写入时**按服务端那一侧的 `LLM_PRICES` 算好存下的，
 *                 跑这个脚本的进程配没配**不影响**已存的数字 —— 判"为什么是「—」"
 *                 要看**行**，不能看本地环境变量。
 *   tokens        贵不贵（钱 = token 数 × 单价，两列一起看才谈得上"贵"）
 *   触顶 / 预算   这一轮被**哪一种上限**停住的。两种都是「最后一步还在要工具、话没说完」，
 *                 所以数据上长得几乎一样，但下一步动作**完全不同** —— 一个该调大 `MAX_STEPS`、
 *                 一个该调大 `AGENT_MAX_COST_MICRO`。合成一个记号就等于把诊断引向错的方向，
 *                 所以这里是两个标记、合计里也分开数（`budget_hit` 是 2026-09-24 加的列）。
 *                 `预算` 撞不上时它显示不出来 —— 没配闸门就是永不触发，那不是"没问题"。
 *   中断 / 错误   用户点了停止 / 网关报错（后者以前只能翻服务端日志）
 *   **归因**      把上面那些候选答案**排成一句能据以行动的话**（`server/agent/diagnose.ts`）。
 *                 逐轮打印，表尾再给一次**分布**。它回答的是「这一轮为什么是这样、
 *                 下一步动哪儿」，而不是「这一轮有哪些数字不好看」——
 *                 环境类（网关/服务）与行为类（它自己就能修）分开说，
 *                 因为前者改提示词没用，后者去重启服务也没用。
 *
 * 用法：
 *   npm run turns            最近 10 轮
 *   npm run turns -- 30      最近 30 轮
 *   npm run turns -- 30 full 附带每轮的完整工具明细
 */
import { diagnoseTurn, summarizeDiagnoses } from '../server/agent/diagnose';
import { formatMoney, readPriceTable, unusedPriceEntries } from '../server/agent/pricing';
import { recentSpans, recentTurns, type SpanRecord, type TurnRecord } from '../server/agent/turn-log';

const limit = Number(process.argv[2]) || 10;
const full = process.argv[3] === 'full';

const rows = recentTurns(limit);
if (rows.length === 0) {
	console.log('还没有观测数据（agent_turns 是空的）。先跟 agent 说一句话，再跑一次。');
	process.exit(0);
}

/** `2026-09-17T09:52:03.123Z` → `09-17 17:52`（本地时区）。 */
function shortTime(iso: string): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso.slice(0, 11);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 工具序列压成 `search_library→build_queue`；重复调用保留（重复本身是信号）。 */
function toolChain(names: string[]): string {
	if (names.length === 0) return '（没调工具）';
	return names.join('→');
}

/**
 * 版本那一格：指纹，关了补丁就缀在后面（`v:a1b2c3d4-work_style`）。
 *
 * 老行显示 `v:—`，**不能显示成默认版本**：「不知道那一轮用的哪版」与「那一轮就是
 * 默认那版」是两件事，混在一起的后果是——按版本分组时，加列之前的行会悄悄算进
 * 默认组，让那组的平均数被一段性质不同的历史拖歪，而报告上看不出任何异常。
 */
function versionCell(row: TurnRecord): string {
	if (row.promptVersion === null) return 'v:—';
	return row.promptDisabled ? `v:${row.promptVersion}-${row.promptDisabled}` : `v:${row.promptVersion}`;
}

/**
 * 首字那一格：毫秒，没吐字就是 `—`。
 *
 * **不能显示成 0**：0 会读成"第一个字立刻就到了"，而真相是"这一轮它一个字都没说"
 * （被中断 / 只调了工具 / 空回复）。这也是这一列本身存 NULL 而不是 0 的理由。
 */
function firstTokenCell(row: TurnRecord): string {
	return row.firstTokenMs === null ? '—' : `${row.firstTokenMs}ms`;
}

/**
 * 钱那一格。`formatMoney` 自带**自适应小数位**——单轮成本常在 0.0001 美元这一档，
 * 固定两位会把每一轮都显示成 `$0.00`，于是"成本列已加"其实什么都看不到。
 */
function moneyCell(row: TurnRecord): string {
	return formatMoney(row.costMicro);
}

/** 当前进程读到的价目表是不是空的（空 = 没配 `LLM_PRICES`）。 */
const priceTableEmpty = Object.keys(readPriceTable()).length === 0;

// 逐 span 数据**只取一次**：归因要用它（"慢在工具还是慢在别处"），`full` 模式也要用。
// 两处各取一次的话，同一条轮次在两处可能给出不同结论 —— 而那种不一致没人会发现。
const spansOf = new Map<string, SpanRecord[]>(rows.map((r) => [r.id, recentSpans(r.id)]));
// 诊断也只做一次：逐轮打印与表尾的分布共用同一份结果（见 `summarizeDiagnoses` 的注释）。
const diagnoses = rows.map((r) => diagnoseTurn(r, spansOf.get(r.id) ?? []));

console.log(
	`\n最近 ${rows.length} 轮  （id 前 8 位 · 时间 · 版本 · 用户那句 · 步数 · 工具链 · 耗时 · 首字 · tokens · 模型 · 钱）\n`,
);

for (const [i, row] of rows.entries()) {
	const flags = [
		row.truncated ? '触顶' : '',
		// 「预算」单独一个标记，不并进「触顶」：两者症状一样、修法相反
		// （见文件头那一行，以及 `turn-log.ts` 的 `TurnRecord.budgetHit`）。
		row.budgetHit ? '预算' : '',
		row.aborted ? '中断' : '',
		row.error ? '错误' : '',
	].filter(Boolean);
	const failCount = row.tools.filter((t) => t.ok === false).length;

	const head =
		`${row.id.slice(0, 8)}  ${shortTime(row.createdAt)}  ` +
		`${versionCell(row).padEnd(16)}  ` +
		`${row.userText.slice(0, 20).padEnd(20)}  ` +
		`${String(row.steps).padStart(2)}步  ${toolChain(row.tools.map((t) => t.name))}`;
	const tail =
		`  ${row.ms}ms  首字${firstTokenCell(row).padStart(6)}  ` +
		`in${row.inputTokens}/out${row.outputTokens}  ` +
		`${(row.model ?? '—').padEnd(20)}${moneyCell(row)}  ` +
		`${row.finishReason ?? '-'}${flags.length ? `  ⚠ ${flags.join(' ')}` : ''}${
			failCount ? `  ✗ 失败工具 ${failCount}` : ''
		}`;
	console.log(head + tail);

	if (row.error) console.log(`    错误：${row.error.slice(0, 160)}`);
	// 归因：**环境类带 `⚠ 环境` 前缀**（与 `npm run cases` 同一个记号）。
	// 它的作用是让人一眼分清"该去查服务"与"该去改提示词"—— 这两件事的下一步完全不同。
	for (const f of diagnoses[i]) {
		console.log(`    ↳ ${f.blame === 'env' ? '⚠ 环境 ' : ''}${f.text}`);
	}
	if (full) {
		for (const t of row.tools) {
			const ms = t.ms === null ? '?' : `${t.ms}ms`;
			const ok = t.ok === null ? '?' : t.ok ? 'ok' : 'FAIL';
			console.log(`    · ${t.name.padEnd(20)} ${ms.padStart(7)}  ${ok}`);
		}
		// 逐 span（`agent_spans`）——`row.tools` 是把整轮**压平**的，于是看不出
		// "哪几步用了工具、哪几步一个都没用"。`finish_reason` 还只能按步给：
		// 「最后那步是 tool-calls 却停了」这类情况（撞上 MAX_STEPS 的样子）
		// 只在步的层面看得见。
		const spans = spansOf.get(row.id) ?? [];
		if (spans.length > 0) {
			const cells = spans.map((s) => {
				const names = s.tools.length ? s.tools.map((t) => t.name).join('+') : '（无工具）';
				const fr = s.finishReason ? `[${s.finishReason}]` : '';
				// `toolMs` 是**下界**（取不到 ms 的按 0 计），所以标成 `≥`
				return `${s.idx + 1}.${names} ≥${s.toolMs}ms${fr}`;
			});
			console.log(`    ${spans.length} 步：${cells.join('  ')}`);
		}
	}
}

const truncated = rows.filter((r) => r.truncated).length;
// 与「触顶」分开数：合计里只有一个数的话，看到「触顶 3」的人会去调 MAX_STEPS，
// 而其中可能有两条其实是钱用完了 —— 调步数上限对它们毫无作用。
const budget = rows.filter((r) => r.budgetHit).length;
const aborted = rows.filter((r) => r.aborted).length;
const errored = rows.filter((r) => r.error).length;
const failed = rows.filter((r) => r.tools.some((t) => t.ok === false)).length;
const slow = rows.reduce((a, r) => (r.ms > a.ms ? r : a), rows[0]);

const priced = rows.filter((r) => r.costMicro !== null);
const totalMicro = priced.reduce((a, r) => a + (r.costMicro ?? 0), 0);
// 首字延迟的分布长尾很重（一次网关排队能把平均数拉到没有意义），所以给中位数。
const firsts = rows
	.map((r) => r.firstTokenMs)
	.filter((v): v is number => v !== null)
	.sort((a, b) => a - b);
const medianFirst = firsts.length ? firsts[Math.floor(firsts.length / 2)] : null;

console.log(
	`\n合计 ${rows.length} 轮：触顶 ${truncated} · 预算 ${budget} · 中断 ${aborted} · 有错 ${errored} · 内有失败工具 ${failed}`,
);
if (budget > 0) {
	// 撞了就明说下一步做什么 —— 与归因那段同一个判据（那两条诊断是按 `budgetHit` 给的）。
	console.log(
		`  ↳ 有 ${budget} 轮是被**成本闸门**停住的：调大 AGENT_MAX_COST_MICRO，` +
			'或让提示词把那几步收掉（改 MAX_STEPS 对它们没用）。',
	);
}
console.log(
	`最慢的一轮：${slow.ms}ms（${shortTime(slow.createdAt)}「${slow.userText.slice(0, 20)}」）` +
		(medianFirst === null ? '' : `　·　首字中位 ${medianFirst}ms（${firsts.length}/${rows.length} 轮有值）`),
);
console.log(
	`这 ${rows.length} 轮花了 ${formatMoney(priced.length ? totalMicro : null)}` +
		`（${priced.length}/${rows.length} 轮可计价）`,
);

// ── 归因分布 ────────────────────────────────────────────────────────
// `无异常` 也占一格：只列异常的话，「异常 3」看不出它是 3/10 还是 3/100。
// 这一行与上面逐轮的 `↳` 是**同一份诊断结果**（只算了一次），所以不可能互相矛盾。
console.log('\n归因分布：');
for (const t of summarizeDiagnoses(diagnoses)) {
	console.log(`  ${t.blame === 'env' ? '⚠ 环境 ' : '       '}${t.label.padEnd(20)}${String(t.count).padStart(3)} 轮`);
}
// ⚠️ 判"钱为什么是「—」"**必须看行、不能看本进程的环境变量**：
// `cost_micro` 是**写入时**按当时那一侧进程的价目表算好存下的，这个脚本只是读。
// 本进程没配 `LLM_PRICES` 完全不影响它显示已存的钱 —— 反过来也一样（实测踩过：
// 本进程没配、行里明明有钱，却打了一句"上面的钱全是「—」"）。
const missing = rows.length - priced.length;
if (missing > 0) {
	console.log(
		`⚠ 有 ${missing}/${rows.length} 轮没记到钱（显示成「—」= **不知道**花了多少，不是 0）：\n` +
			'  那一轮写入时，**服务端那一侧**的进程没配 `LLM_PRICES`；也可能是加列之前的老行。\n' +
			'  要开始记账：在服务端的 .env.local 里配 LLM_PRICES="模型名=输入价,输出价;*=兜底输入,兜底输出"（美元 / 每百万 token）',
	);
}
// 本进程的价目表只有一个用途：反查"配了但没用上"的条目 —— 而那是**服务端**在写入时
// 取的同一份环境变量，所以要看的地方就是这里，与上面的"为什么是「—」"不是一回事。
if (!priceTableEmpty) {
	// 拼错模型名时唯一的可见痕迹：`priceOf` 找不到就回落到兜底价，**不报错**，
	// 于是所有历史数字都偏着，而没人会去质疑一个看起来正常的钱数。
	// 取**最近一条有模型的**行，不是 `rows[0]`：最新那条可能是 `model` 为空的行
	// （加列之前的老行、或手工造的数据），拿它去查价目表只会得到一句空话。
	const model = rows.find((r) => r.model)?.model;
	const unused = model ? unusedPriceEntries(readPriceTable(), model) : [];
	if (unused.length) {
		console.log(`⚠ 价目表里这几条没被用上（模型名对不上？本行用的是 ${model}）：${unused.join('、')}`);
	}
}

// ── 按提示词版本分组 ────────────────────────────────────────────────
// 只在**出现多个版本**时打印。这正是「带 / 不带某条 prompt 补丁各跑一遍」的形状：
// 起两个实例（一个带 `PROMPT_DISABLE=work_style`、一个不带），同样那几句话各跑一遍，
// 再看这里的数字。没有分组小计的话，两版的轮次全混在上面那个"合计"里 ——
// 而"唯一值得看的那个差别"恰恰会被平均掉。
const byVersion = new Map<string, TurnRecord[]>();
for (const row of rows) {
	const key = row.promptVersion ?? '—（加列前的老行）';
	const list = byVersion.get(key);
	if (list) list.push(row);
	else byVersion.set(key, [row]);
}
if (byVersion.size > 1) {
	console.log('\n按提示词版本分组：');
	for (const [key, list] of byVersion) {
		const off = list[0].promptDisabled;
		const avgSteps = (list.reduce((a, r) => a + r.steps, 0) / list.length).toFixed(1);
		const avgMs = Math.round(list.reduce((a, r) => a + r.ms, 0) / list.length);
		const bad = list.filter(
			(r) =>
				r.truncated ||
				// 撞预算也是「异常」：它不是模型答错，但这一轮的结论不能用
				r.budgetHit ||
				r.aborted ||
				r.error ||
				r.tools.some((t) => t.ok === false),
		).length;
		// 每轮平均花了多少 —— 补丁组的差通常也体现在"多走一步"上，而步数与钱是同一件事的两面
		const pricedList = list.filter((r) => r.costMicro !== null);
		const avgMicro = pricedList.length
			? Math.round(pricedList.reduce((a, r) => a + (r.costMicro ?? 0), 0) / pricedList.length)
			: null;
		console.log(
			`  ${key.padEnd(16)}${(off ? `关掉 ${off}` : '全部启用').padEnd(20)}` +
				`${String(list.length).padStart(3)} 轮 · 平均 ${avgSteps} 步 · 平均 ${avgMs}ms · ` +
				`平均 ${formatMoney(avgMicro)} · 异常 ${bad}`,
		);
	}
}

console.log('\n加 full 看每轮的工具明细：npm run turns -- 10 full\n');
