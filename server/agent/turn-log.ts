/**
 * ⑨ 观测 —— 「一轮对话发生了什么」的持久化读写点（BLUEPRINT §2 的活跃区）。
 *
 * 与 `message-log.ts` / `preference-log.ts` 同一个形状：表结构在 `server/db.ts`，
 * 本文件只有「写一对读」+ 一个纯函数（把 SDK 的 steps 译成可入库的统计）。
 *
 * ── 一行 = 一轮，不是一条消息 ──────────────────────────────────────
 * ⑤ 的 `messages` 已经存了「说了什么」，本表存的是它答不了的那一半：
 * **几轮工具、哪个工具慢、有没有被截断、花了多少 token**。两者用同一个主键
 * （那一轮 assistant 消息的 id），所以「哪次答错了」可以直接把两行并起来看。
 *
 * ── 2026-09-23：补上了当初刻意留空的两块 ────────────────────────────
 * 原版这里写着「没有首字延迟 / 没有逐 span」以及各自的理由。现在它们都做了，
 * 但**做法与原计划不同**，这一点比"做了"更重要：
 *   - **首字延迟（TTFB）**：原版说"要 hook 每个 chunk，那就得动 ② ⑧"，并留下
 *     判据 —— 「真需要时应该在 SDK 的 `onChunk` 上做，而不是在业务层糊一层」。
 *     **照做了**：`onChunk` 是 SDK 的观察钩子，`run.ts` 只把它透传成一个可选的
 *     `onFirstText` 回调（加的是**观察**，不是循环形状）。所以 ② 那条"装一次
 *     永久不动"没有被破 —— 它防的是循环形状漂移，不是禁止任何触碰。
 *   - **逐 span**：不再是"另造一套 trace"，而是**从已有数据下钻**：`run.ts` 的
 *     `steps` 本来就分步，`summarizeSpans` 只是不再把它们压平成一列工具清单。
 *     落 `agent_spans` 表（一行 = 一步）。
 *     ⚠️ **不存"模型耗时"**：那是残差（轮耗时 − 工具耗时），里面还混着网络与排队。
 *     把推算叫成实测，正是本项目最防的那种错（同 `truncated` 与 `finish_reason`
 *     分两列的理由：一个是判定，一个是原始事实）。
 *   - **仍然没有读的界面**：读取走 `scripts/turns.mts`（`npm run turns`）。
 *     够用，且不必先长出一个 API + 一个页面。
 *
 * ── 失败语义：只 log，不抛 ─────────────────────────────────────────
 * 沿用 §7 那条纪律——「每加一张表先问：它失败时，谁需要知道」。
 * 观测是**流水**：磁盘满时少一行统计，用户什么都不受影响（没有哪句话会因此失真）。
 * 所以这里和 `plays` / `messages` 同类，而不是和 `preferences` 同类。
 *
 * ⚠️ 一个已知缺口（不是 bug，是边界）：**用户中途点了「停止」的轮次，步数与 token
 * 可能取不到**（`result.steps` 在中断时可能拒绝）。此时按「已知多少记多少」入库，
 * 并把 `aborted` 标成 1——**不要让它变成一行空白或干脆不落行**，否则"中断过的轮次"
 * 会从观测里消失，而那正是最需要看的一类。
 */
import { isToolFailureKind, type ToolFailureKind } from '../../contract/tool';
import { getDb } from '../db';

/**
 * 工具调用**在若干步里的样子**——结构化的最小面，而不是 SDK 的具体类型。
 *
 * 为什么不用 SDK 类型：这个纯函数是「把 steps 翻译成数字」的**唯一**实现，
 * 它只需要三个字段。写成结构声明后，单测可以不构造 SDK 对象就把每个分支跑遍
 * （包括取不到 `output` 的异常形状）——用 SDK 类型就只能靠"造一个差不多像的对象"。
 */
export type StepLike = {
	toolCalls: { toolCallId: string; toolName: string }[];
	toolResults: { toolCallId: string; toolName: string; output?: unknown }[];
	finishReason: string;
};

/**
 * 一次工具调用在观测里的形状。**`agent_turns.tools` 与 `agent_spans.tools` 共用它**
 * （同一个概念只能有一处定义，否则两处会各自长出字段）。
 *
 * `ms` 取不到时是 null：说明这个工具没走正常路径（**0 会伪装成"很快"**）。
 *
 * `kind` 是 B1 给模型的失败分类。**没有分类信息时这个字段整个省略**（不是 `null`）：
 * 一次成功的调用没必要背上一个空字段，而读的人只在 `ok === false` 那一格上用它 ——
 * 那里"字段不存在"读作「没有分类信息」（加这一项之前的老行，或工具没给），
 * 与 `ok === true` 的条目不会混（它们根本不该出现 kind）。
 *
 * ⚠️ 为什么值得把它存下来：它是「**谁来修**」这个判断的唯一载体
 * （`bad_request` = 模型换个参数就行 / `transport` = 服务没跑，重试无用）。
 * B1 已经把它交给模型了，观测层再丢掉的话，事后看一轮失败的记录只能得到
 * "有个工具失败了"——而"该改提示词"与"该去把服务起起来"是两件完全不同的事。
 * 加这一项是**向后兼容**的：老行的 JSON 里没有它。
 */
export type ToolTrace = {
	name: string;
	ms: number | null;
	ok: boolean | null;
	kind?: ToolFailureKind;
};

/** 一轮对话的画像。字段顺序与建表一致，方便对照。 */
export type TurnRecord = {
	/** 那一轮 assistant 消息的 id（与 `messages` 表同一个主键）。 */
	id: string;
	createdAt: string;
	/** 本轮用户那句话（已截断）。 */
	userText: string;
	steps: number;
	toolCalls: number;
	/** 按调用顺序的工具明细。**这是工具信息的唯一真相**，不再另设冗余列。 */
	tools: ToolTrace[];
	/** 撞到 `MAX_STEPS` 被掐掉：模型还想调工具，但循环到上限了。 */
	truncated: boolean;
	/**
	 * 这一轮**因成本上限被停住**（`agent/run.ts` 的 `overBudget`）。
	 *
	 * 与 `truncated` 分开是刻意的：**症状一样、动作不同** —— 一个该调大
	 * `MAX_STEPS`，一个该调大预算。合成一个标记，诊断就必然朝错的方向改。
	 *
	 * 它是路由的 `onBudgetHit` 回调**记**下来的，不是事后从 `steps` 反推的：
	 * 反推是猜（那两种触顶在数据上长得一样），回调是记。
	 */
	budgetHit: boolean;
	aborted: boolean;
	/**
	 * SDK 自己的收尾原因（`stop` / `tool-calls` / `length` / `error`…）。
	 * 与 `truncated` **不是一回事**：前者是原始事实，后者是「按当时的 MAX_STEPS
	 * 判定它被掐了」。分开存的意义在于——将来调大上限，历史行的判定不会被重算改写。
	 */
	finishReason: string | null;
	/** 请求进 → 流结束的墙钟耗时（含工具执行与模型生成）。 */
	ms: number;
	/**
	 * 从请求进到**模型吐出第一个字**的毫秒数 —— 用户感知的「它多久开始说话」。
	 *
	 * NULL = 这一轮**一个字都没吐出来**（被掐掉 / 中断 / 全程只在调工具），
	 * 不是 0ms。`ms` 答的是"总共多久"，它答的是"多久开始有反应"——
	 * 一轮 14 秒里，是"3 秒就开始说了"还是"憋了 12 秒才开口"，改法完全不同。
	 */
	firstTokenMs: number | null;
	inputTokens: number;
	outputTokens: number;
	/** 那一轮用的是哪个模型。**NULL = 加这一列之前的老行。** */
	model: string | null;
	/**
	 * 这一轮的钱（**微美元整数**）。NULL = 没配价目表或模型不在表里 ——
	 * 是「不知道」，不是「免费」（见 `pricing.ts`）。
	 */
	costMicro: number | null;
	error: string | null;
	/**
	 * 那一轮用的系统提示词指纹（`agent/prompt.ts` 的 `promptVersion()`，8 位）。
	 * **NULL = 加这一列之前的历史行**，无从得知——不是"空版本"。
	 */
	promptVersion: string | null;
	/**
	 * 那一轮**关掉了哪些补丁段落**（逗号分隔；空串 = 一条没关）。
	 * NULL 同上是老行。
	 *
	 * 它与 `promptVersion` 不是冗余，和 `truncated` / `finish_reason` 是同一种关系：
	 * 指纹**唯一但不可读**（改任何一处 prompt 文字它就变，可你不知道变在哪），
	 * 这一列**可读但不唯一**（只改 `CORE` 的文字时它纹丝不动）。
	 * 分组要用前者，读懂那一组是什么要用后者。
	 */
	promptDisabled: string | null;
};

/** 观测用的读取上限（只限制读多少，不删行，与 messages 表同一取舍）。 */
const READ_LIMIT = 100;
/** 用户那句话入库前截断的长度。观测不需要全文，`messages` 表里有。 */
const USER_TEXT_MAX = 200;

/**
 * 从工具返回值里取出 `ms` / `ok`。
 *
 * 工具的输出形状是 `ToolOutcome`（见 `contract/tool.ts`），但这里**故意按运行时
 * 判断**而不是断言类型：`toolResults` 的 `output` 在动态工具/异常路径下可能是任何东西，
 * 直接 `output.ms` 会在某一条脏数据上把整轮观测炸掉（而观测绝不该影响对话）。
 * 取不到就写 null——**null 是有信息量的**（说明这个工具没走正常路径），
 * 而 0 会伪装成"很快"。
 */
function pickOutcome(output: unknown): { ms: number | null; ok: boolean | null; kind: ToolFailureKind | null } {
	if (typeof output !== 'object' || output === null) return { ms: null, ok: null, kind: null };
	const o = output as { ms?: unknown; ok?: unknown; kind?: unknown };
	return {
		ms: typeof o.ms === 'number' && Number.isFinite(o.ms) ? o.ms : null,
		ok: typeof o.ok === 'boolean' ? o.ok : null,
		// 同样按运行时判断：`kind` 是 `contract/tool.ts` 里的联合类型，
		// 而从工具结果里读回来的东西没有类型保证（动态工具、异常路径）。
		kind: isToolFailureKind(o.kind) ? o.kind : null,
	};
}

/**
 * 把若干步翻译成一轮的统计。**纯函数**（导出的原因就是给单测用）。
 *
 * 工具按 `toolCallId` 与结果配对，而不是按下标——SDK 并行执行多个工具时，
 * 结果的顺序不保证等于调用的顺序。按下标配对时**不会报错**，只会把耗时挂到
 * 另一个工具上（"哪个工具慢"从此答错）。
 *
 * `truncated` 的判据是两条都要满足：
 *   - 步数已经贴到上限（`steps >= maxSteps`）；
 *   - 最后一步的 `finishReason` 仍是 `'tool-calls'`（= 它还想继续调，是被我们掐的）。
 * 只看后者会把中间步当成截断，只看前者会把"刚好在上限那一步收尾"误判成截断。
 *
 * `budgetHit` 则**不由这里推导**，只透传调用方（路由的回调）给的那个布尔 ——
 * 原因见 `TurnRecord.budgetHit`。
 */
export function summarizeSteps(
	steps: StepLike[],
	opts: {
		maxSteps: number;
		aborted?: boolean;
		error?: string | null;
		budgetHit?: boolean;
	} = { maxSteps: 0 },
): Pick<
	TurnRecord,
	'steps' | 'toolCalls' | 'tools' | 'truncated' | 'budgetHit' | 'aborted' | 'error'
> {
	const tools: TurnRecord['tools'] = [];
	for (const step of steps) {
		const byId = new Map(step.toolResults.map((r) => [r.toolCallId, r]));
		for (const call of step.toolCalls) {
			const { ms, ok, kind } = pickOutcome(byId.get(call.toolCallId)?.output);
			tools.push({ name: call.toolName, ms, ok, ...(kind ? { kind } : {}) });
		}
	}

	const last = steps.at(-1);
	const truncated =
		steps.length >= opts.maxSteps && opts.maxSteps > 0 && last?.finishReason === 'tool-calls';

	return {
		steps: steps.length,
		toolCalls: tools.length,
		tools,
		truncated,
		budgetHit: opts.budgetHit === true,
		aborted: opts.aborted === true,
		error: opts.error ?? null,
	};
}

/* ── 逐 span：一轮里的一步 ──────────────────────────────────────── */

/**
 * 一步的画像。落 `agent_spans` 表（`turn_id` + `idx` 为主键，与 `agent_turns` 父子）。
 *
 * 为什么值得单独一张表：`agent_turns.tools` 已经能回答「哪个工具慢」，但答不了
 * **「这一步里是模型慢还是工具慢」** —— 而这两件事的修法完全不同（收提示词
 * 减少步数 vs 优化/缓存那个工具），却都表现为"这一轮很慢"。
 */
export type SpanRecord = {
	/** 步序，从 0 开始。 */
	idx: number;
	tools: ToolTrace[];
	/**
	 * 这一步里各工具耗时之和。⚠️ 它是**下界**：`ms` 取不到的按 0 计入
	 * （那种情况说明这个工具没走正常路径，见 `pickOutcome`）。
	 * 用下界而不是"跳过这一步"：宁可把残差算大一点、读成"这里还有时间没解释"，
	 * 也不要让它看起来像"这一步很干净"。
	 */
	toolMs: number;
	finishReason: string | null;
};

/**
 * 把若干步压成 span 列表。纯函数（导出给单测）。
 *
 * 与 `summarizeSteps` 的分工：那个压成**一轮**（给 `agent_turns` 用），这个保留
 * **步的边界**（给 `agent_spans` 用）。两者共用 `pickOutcome`，所以"哪个工具慢"
 * 这个判断在两处不会各算一遍 —— 各算一遍就是两处会漂移的实现。
 */
export function summarizeSpans(steps: StepLike[]): SpanRecord[] {
	return steps.map((step, idx) => {
		const byId = new Map(step.toolResults.map((r) => [r.toolCallId, r]));
		const tools: SpanRecord['tools'] = [];
		let toolMs = 0;
		for (const call of step.toolCalls) {
			const { ms, ok, kind } = pickOutcome(byId.get(call.toolCallId)?.output);
			tools.push({ name: call.toolName, ms, ok, ...(kind ? { kind } : {}) });
			if (ms !== null) toolMs += ms;
		}
		return { idx, tools, toolMs, finishReason: step.finishReason ?? null };
	});
}

/**
 * 落一组 span（一行一步）。**幂等**（`turn_id` + `idx` 主键 + ON CONFLICT 覆盖），
 * 与 `messages` 表同一个理由：同一轮重放不会长出重复行。
 *
 * 失败只 log：与 `recordTurn` 同属**流水**（见文件头的失败语义）。
 */
export function recordSpans(turnId: string, spans: SpanRecord[]): void {
	if (spans.length === 0) return;
	try {
		const db = getDb();
		const stmt = db.prepare(
			`INSERT INTO agent_spans (turn_id, idx, tools, tool_ms, finish_reason)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(turn_id, idx) DO UPDATE SET
				tools = excluded.tools, tool_ms = excluded.tool_ms,
				finish_reason = excluded.finish_reason`,
		);
		db.exec('BEGIN');
		try {
			for (const s of spans) {
				stmt.run(turnId, s.idx, JSON.stringify(s.tools), s.toolMs, s.finishReason);
			}
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
	} catch (err) {
		console.error('[turn-log] failed to record spans:', err);
	}
}

/** 读回某一轮的 span（步序升序）。坏行跳过，不让一条脏数据拖垮报告。 */
export function recentSpans(turnId: string): SpanRecord[] {
	try {
		const rows = getDb()
			.prepare('SELECT idx, tools, tool_ms, finish_reason FROM agent_spans WHERE turn_id = ? ORDER BY idx')
			.all(turnId) as unknown as {
			idx: number;
			tools: string;
			tool_ms: number;
			finish_reason: string | null;
		}[];
		const out: SpanRecord[] = [];
		for (const row of rows) {
			try {
				const parsed = JSON.parse(row.tools) as unknown;
				if (!Array.isArray(parsed)) continue;
				out.push({
					idx: row.idx,
					tools: parsed as SpanRecord['tools'],
					toolMs: row.tool_ms,
					finishReason: row.finish_reason,
				});
			} catch {
				continue;
			}
		}
		return out;
	} catch (err) {
		console.error('[turn-log] failed to read spans:', err);
		return [];
	}
}

/**
 * 落一行观测。**失败只 log**（见文件头的失败语义）。
 *
 * `promptVersion` / `promptDisabled` 在**写入侧是必填**的（读取侧才可空）：
 * 做成可选再加个 `null` 默认值的话，「忘了传」会静默写成一个看起来像老行的
 * NULL——而那一列正是分组对比的键。**分错组的数字比没有数字更坏**，
 * 所以让它在这里编译期就红。
 */
export function recordTurn(
	record: Omit<TurnRecord, 'createdAt' | 'promptVersion' | 'promptDisabled' | 'model'> & {
		createdAt?: string;
		promptVersion: string;
		promptDisabled: string;
		/** 与上面两个同理：**写入侧必填**，否则"忘了传"会写成一行看起来像老库的行。 */
		model: string;
	},
): void {
	try {
		getDb()
			.prepare(
				`INSERT INTO agent_turns
					(id, created_at, user_text, steps, tool_calls, tools, truncated, budget_hit, aborted,
					 finish_reason, ms, first_token_ms, input_tokens, output_tokens, error,
					 model, cost_micro, prompt_version, prompt_disabled)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					user_text = excluded.user_text, steps = excluded.steps,
					tool_calls = excluded.tool_calls, tools = excluded.tools,
					truncated = excluded.truncated, budget_hit = excluded.budget_hit,
					aborted = excluded.aborted,
					finish_reason = excluded.finish_reason, ms = excluded.ms,
					first_token_ms = excluded.first_token_ms,
					input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
					error = excluded.error,
					model = excluded.model, cost_micro = excluded.cost_micro,
					prompt_version = excluded.prompt_version,
					prompt_disabled = excluded.prompt_disabled`,
			)
			.run(
				record.id,
				record.createdAt ?? new Date().toISOString(),
				record.userText.slice(0, USER_TEXT_MAX),
				record.steps,
				record.toolCalls,
				JSON.stringify(record.tools),
				record.truncated ? 1 : 0,
				record.budgetHit ? 1 : 0,
				record.aborted ? 1 : 0,
				record.finishReason,
				record.ms,
				record.firstTokenMs,
				record.inputTokens,
				record.outputTokens,
				record.error,
				record.model,
				record.costMicro,
				record.promptVersion,
				record.promptDisabled,
			);
	} catch (err) {
		console.error('[turn-log] failed to record turn:', err);
	}
}

/** SQL 行的原始形状（`node:sqlite` 返回的对象键名就是列名）。 */
type RawTurnRow = {
	id: string;
	created_at: string;
	user_text: string;
	steps: number;
	tool_calls: number;
	tools: string;
	truncated: number;
	/** 同样是老库升级补的列 → 可空。NULL 读成 false（那时闸门还不存在，确实没撞过）。 */
	budget_hit: number | null;
	aborted: number;
	finish_reason: string | null;
	ms: number;
	first_token_ms: number | null;
	input_tokens: number;
	output_tokens: number;
	error: string | null;
	model: string | null;
	cost_micro: number | null;
	/** 老库升级补的列，所以是**可空**的（NULL = 加列之前那一行）。 */
	prompt_version: string | null;
	prompt_disabled: string | null;
};

/**
 * 读回最近 N 轮，**最近的在前**（看观测时想先看刚发生的那一轮）。
 * 坏行（`tools` 不是合法 JSON）跳过，不让一条脏数据拖垮整个报告。
 */
export function recentTurns(limit = READ_LIMIT): TurnRecord[] {
	const parsed = Math.trunc(limit);
	const n = Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : READ_LIMIT, 1), READ_LIMIT);
	try {
		const rows = getDb()
			.prepare('SELECT * FROM agent_turns ORDER BY rowid DESC LIMIT ?')
			.all(n) as unknown as RawTurnRow[];
		const out: TurnRecord[] = [];
		for (const row of rows) {
			let tools: TurnRecord['tools'];
			try {
				const value = JSON.parse(row.tools) as unknown;
				if (!Array.isArray(value)) continue;
				tools = value as TurnRecord['tools'];
			} catch {
				continue;
			}
			out.push({
				id: row.id,
				createdAt: row.created_at,
				userText: row.user_text,
				steps: row.steps,
				toolCalls: row.tool_calls,
				tools,
				truncated: row.truncated === 1,
				budgetHit: row.budget_hit === 1,
				aborted: row.aborted === 1,
				finishReason: row.finish_reason,
				ms: row.ms,
				firstTokenMs: row.first_token_ms,
				inputTokens: row.input_tokens,
				outputTokens: row.output_tokens,
				model: row.model,
				costMicro: row.cost_micro,
				error: row.error,
				promptVersion: row.prompt_version,
				promptDisabled: row.prompt_disabled,
			});
		}
		return out;
	} catch (err) {
		console.error('[turn-log] failed to read turns:', err);
		return [];
	}
}
