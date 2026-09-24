/**
 * ⑨ 观测的最后一层：**归因** —— 「这一轮为什么是这样」。
 *
 * ── 为什么需要它（BLUEPRINT §8 阶段 4 剩下的那一层）────────────────
 * `agent_turns` 已经把**候选答案**全摆出来了：触顶、工具失败、中断、慢、首字晚。
 * 但"候选"不是"归因"—— 看一行的 `truncated=1`、`ms=14630`、两个工具 FAIL，
 * 仍然答不出**下一步该改什么**。归因要做的就是把它们排成一句能据以行动的话。
 *
 * ── 「谁来修」是唯一的分类轴 ──────────────────────────────────────
 * 与 `contract/tool.ts` 的 B1（`ToolFailureKind`）共用同一个判据，因为那是唯一
 * 能改变行动的判据：
 *   - `env`       环境的事（网关报错 / 服务没跑 / 超时）—— 改提示词、改工具都没用；
 *   - `behaviour` 模型的选择或那句话本身 —— 可以靠提示词/案例改；
 *   - `user`      用户自己停的 —— **不是缺陷**，但必须从成功率里摘出去；
 *   - `info`      只是"值得看一眼"（慢、步数多），没失败。
 *
 * ⚠️ 与 `scripts/cases.mts` 的「判据类 / 环境类」是**同一套区分，不同的问题**，
 * 别把两边合成一处：那边问的是「这条失败与**这条补丁**有没有关系」，所以只需要
 * 两桶；这里问的是「这一轮为什么没做成、下一步动哪儿」，所以还要把
 * `bad_request`（模型换个参数就行）从 `transport`（服务没跑）里分出来。
 * 共同的一条纪律是照抄的：**说不清原因的那一类，不许算成"补丁在起作用"。**
 *
 * ── 阈值是拍的，但拍在实测分布之外 ────────────────────────────────
 * 下面四个常量都来自本机实测（正常轮 7–14 秒、首字 2.5–3.0 秒），取在两倍开外。
 * 它们只影响 `info` 类结论（"值得看一眼"），**没有一条判据依赖它们** ——
 * 所以调大调小只是让它少说/多说，不会让报告把环境问题说成模型问题。
 */
import type { SpanRecord, ToolTrace, TurnRecord } from './turn-log';

/** 这条归因该记在谁头上。见文件头：这是唯一的分类轴。 */
export type Blame = 'env' | 'behaviour' | 'user' | 'info';

export type FindingCode =
	| 'gateway_error'
	| 'aborted'
	| 'truncated'
	| 'budget'
	| 'tool_env'
	| 'tool_behaviour'
	| 'silent'
	| 'slow'
	| 'slow_start'
	| 'many_steps';

export type Finding = {
	code: FindingCode;
	blame: Blame;
	/** 一句能据以行动的话（报告里直接打印，所以不写"可能/也许"）。 */
	text: string;
};

/** 首字超过它就不是"它在想"，而是"它开口晚"（实测正常 2.5–3.0 秒）。 */
const SLOW_FIRST_MS = 6_000;
/** 一轮到这就算慢（实测正常 7–14 秒，14.6 秒那次已经贴着 MAX_STEPS）。 */
const SLOW_TURN_MS = 20_000;
/** 工具耗时占总耗时这么多，才算"慢在工具"（否则说明时间不在工具上）。 */
const TOOL_DOMINANT = 0.6;
/** 走到这么多步就该看一眼提示词的"工作方式"（`MAX_STEPS` 是 5，撞上另有告警）。 */
const MANY_STEPS = 4;

/**
 * `search_library[transport] 3000ms`、`build_queue 12ms`。
 *
 * `[kind]` **只在失败的那次调用上出现** —— 它是"谁来修"的标记，挂在成功的调用后面
 * 会读成"未知错误"（实测：慢那一轮里 `search_library[?]` 看着像它出问题了）。
 * 失败却没有 kind（加这一项之前的老行）时给 `?`：如实显示"没有分类信息"，不猜一个。
 */
function describeTools(list: ToolTrace[]): string {
	return list
		.map((t) => {
			const kind = t.ok === false ? `[${t.kind ?? '?'}]` : '';
			const ms = t.ms === null ? '' : ` ${t.ms}ms`;
			return `${t.name}${kind}${ms}`;
		})
		.join('、');
}

/** `transport` / `unavailable` / `forbidden` 这三类改提示词没用，得去动环境。 */
function isEnvKind(kind: ToolTrace['kind']): boolean {
	return kind === 'transport' || kind === 'unavailable' || kind === 'forbidden';
}

/**
 * 给**一轮**做归因。返回空数组 = 没有值得说的信号（正常的一轮）。
 *
 * 顺序即优先级（最能解释"为什么没做成"的在前）：报错 → 中断 → 触顶 → 工具失败
 * → 一个字没吐 → 慢 → 首字晚 → 步数多。**全部收集**，不是遇到第一个就返回 ——
 * 「触顶了，而且工具还失败过」这两件事的修法不一样，合成一句等于扔掉一条线索。
 *
 * `spans` 只用于把"慢"拆成"慢在工具"与"慢在别处"。**不传也能用**，只是那一条
 * 会退化成"看不出慢在哪一步"（如实说，而不是拿 0 当"工具不慢"）。
 */
export function diagnoseTurn(row: TurnRecord, spans: SpanRecord[] = []): Finding[] {
	const out: Finding[] = [];

	// ── 整轮没有正常收尾：先把这条放最前 ──
	// 理由与 `cases.mts` 里那条"流没正常结束 → 行为判据一律不评"完全一样：
	// 网关报错的那一轮里，工具链本来就是残缺的，"少调了某个工具"根本不算证据。
	if (row.error) {
		out.push({
			code: 'gateway_error',
			blame: 'env',
			text: `这一轮没有正常收尾：${row.error} —— 这一轮的工具链与步数都是残缺的，别拿它判断提示词好坏`,
		});
	}
	if (row.aborted) {
		out.push({
			code: 'aborted',
			blame: 'user',
			text: '用户中途点了停止 —— 不是缺陷，但这一轮不该计入成功率',
		});
	}

	// 被某种上限截断（步数 / 预算）。这两件事在「它为什么没把话说完」上是**等价**的，
	// 所以下面的 `silent` 与 `many_steps` 都不该再报一遍 —— 归因的纪律②：
	// **不许重复归因同一个现象**（触顶已经解释了"为什么没说话"）。
	const bounded = row.truncated || row.budgetHit;

	// ── 撞上步数上限 ──
	if (row.truncated) {
		out.push({
			code: 'truncated',
			blame: 'behaviour',
			text:
				`撞上步数上限（走了 ${row.steps} 步，最后一次仍在要工具）：多半是那句要求没写清，` +
				'或在这份曲库里满足不了 —— 它是"一直在试"，不是"试不动"',
		});
	}

	// ── 撞上成本上限 ──
	// 与 `truncated` **并列但分开报**：症状一样，动作完全不同 —— 一个该调大
	// `MAX_STEPS`，一个该调大预算。合成一条，给出的方向必然有一半是错的。
	// 记在 `env` 上（报告里带「⚠ 环境」前缀）是有意的：**先去查配置，别先怀疑提示词**。
	if (row.budgetHit) {
		out.push({
			code: 'budget',
			blame: 'env',
			text:
				`走到第 ${row.steps} 步时花到了成本上限，本轮被停住 —— 不是它不会说，是预算用完了；` +
				'该调大 AGENT_MAX_COST_MICRO（若确实配得太小），或让提示词少绕几步',
		});
	}

	// ── 工具失败：按 B1 的 kind 分成"该动环境"与"它自己就能修"两堆 ──
	const failed = row.tools.filter((t) => t.ok === false);
	if (failed.length > 0) {
		const environmental = failed.filter((t) => isEnvKind(t.kind));
		const onModel = failed.filter((t) => !isEnvKind(t.kind));
		if (environmental.length > 0) {
			out.push({
				code: 'tool_env',
				blame: 'env',
				text: `${describeTools(environmental)} 失败了，而且是环境类的 —— 与"它选错了工具"无关，先查服务有没有跑`,
			});
		}
		if (onModel.length > 0) {
			out.push({
				code: 'tool_behaviour',
				blame: 'behaviour',
				text: `${describeTools(onModel)} 失败了，而这类是它自己就能修的（换个参数/换个说法）—— 同参数重试没有意义`,
			});
		}
	}

	// ── 调了工具却一个字都没回 ──
	// 与 ⑩ 的 `finishOutcome` 同一族：**"没抛异常"不等于"做成了"**。
	// 这里排除掉已经被上面解释过的那几种（中断/报错/触顶），剩下的才是"网关给了空回复"。
	if (
		row.firstTokenMs === null &&
		row.steps > 0 &&
		!row.aborted &&
		!row.error &&
		!bounded
	) {
		out.push({
			code: 'silent',
			blame: 'behaviour',
			text: `调了 ${row.steps} 步工具，却一个字都没回给用户 —— 用户看到的是一个空壳回答`,
		});
	}

	// ── 慢：先看时间花在不在工具上 ──
	if (row.ms >= SLOW_TURN_MS) {
		const toolMs = spans.reduce((a, s) => a + s.toolMs, 0);
		if (spans.length === 0) {
			out.push({
				code: 'slow',
				blame: 'info',
				text: `这一轮 ${row.ms}ms 偏慢，但没有逐 span 数据（加 "agent_spans" 之前的行），看不出慢在哪一步`,
			});
		} else if (toolMs >= row.ms * TOOL_DOMINANT) {
			const worst = spans.reduce((a, s) => (s.toolMs > a.toolMs ? s : a), spans[0]);
			out.push({
				code: 'slow',
				blame: 'info',
				text:
					`这一轮 ${row.ms}ms 偏慢，且时间在工具上（≥${toolMs}ms，下界）：` +
					`最慢的是第 ${worst.idx + 1} 步 ${describeTools(worst.tools) || '（无工具）'}`,
			});
		} else {
			out.push({
				code: 'slow',
				blame: 'info',
				text:
					`这一轮 ${row.ms}ms 偏慢，但工具只占 ≥${toolMs}ms —— 时间不在工具上，` +
					'收提示词/换工具都治不了它（更可能是生成或排队）',
			});
		}
	}

	// ── 开口晚 ──
	// 与"总耗时高"是两件事：总耗时高可能是工具慢，首字高是"憋着不说"。
	// 只看总耗时会把这两种混成一件，而修法完全不同。
	if (row.firstTokenMs !== null && row.firstTokenMs >= SLOW_FIRST_MS) {
		out.push({
			code: 'slow_start',
			blame: 'info',
			text: `用户等了 ${row.firstTokenMs}ms 才看到第一个字（正常 2.5–3.0 秒）—— 与总耗时高是两回事`,
		});
	}

	// ── 步数偏多（但没触顶）──
	if (!bounded && row.steps >= MANY_STEPS) {
		out.push({
			code: 'many_steps',
			blame: 'info',
			text: `走了 ${row.steps} 步（上限 5）—— 没触顶，但提示词的"工作方式"那段可能还有能收的`,
		});
	}

	return out;
}

/** 每个 code 的中文短语（报告里分组用）。 */
export const FINDING_LABELS: Record<FindingCode, string> = {
	gateway_error: '网关/服务端报错',
	aborted: '用户中断',
	truncated: '撞步数上限',
	budget: '撞成本上限',
	tool_env: '工具失败（环境类）',
	tool_behaviour: '工具失败（它自己能修）',
	silent: '调了工具却没回话',
	slow: '偏慢',
	slow_start: '开口晚',
	many_steps: '步数偏多',
};

export type DiagnosisCount = {
	/** `ok` = 这一轮一条归因都没有（健康），它不是 `FindingCode`，所以单独标出来。 */
	code: FindingCode | 'ok';
	blame: Blame;
	label: string;
	count: number;
};

/**
 * 一批轮次的归因分布。参数是**已经诊断好的结果**（`Finding[][]`）而不是原始行 ——
 * 这样调用方诊断一次、既用于逐轮打印又用于分布统计，两处的结论**不可能不一致**。
 *
 * 为什么"健康"也占一格：只列异常的话，「异常 3 条」看不出它是 3/10 还是 3/100。
 * 排序是确定的（次数降序、同次数按 code 升序）—— 同 `listTasks` 要求排序稳定
 * 是同一条纪律：报告两次跑出两种顺序，读的人会以为数据变了。
 */
export function summarizeDiagnoses(findingsPerTurn: Finding[][]): DiagnosisCount[] {
	const byCode = new Map<string, DiagnosisCount>();
	for (const findings of findingsPerTurn) {
		if (findings.length === 0) {
			const hit = byCode.get('ok');
			if (hit) hit.count += 1;
			else byCode.set('ok', { code: 'ok', blame: 'info', label: '无异常', count: 1 });
			continue;
		}
		for (const f of findings) {
			const hit = byCode.get(f.code);
			if (hit) hit.count += 1;
			else byCode.set(f.code, { code: f.code, blame: f.blame, label: FINDING_LABELS[f.code], count: 1 });
		}
	}
	return [...byCode.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}
