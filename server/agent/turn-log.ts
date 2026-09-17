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
 * ── 最小版：只记答得了问题的那几个数 ────────────────────────────────
 * 不做的事，以及各自的理由（写下来是因为"没做"和"忘了做"看起来一样）：
 *   - **没有首字延迟（TTFB）**：要 hook 每个 chunk，那就得动 ② `run.ts` 与
 *     ⑧ 传输——为了一个观察指标去改冻结区，正是 BLUEPRINT §2 让先停一下的情形。
 *     真需要时应该在 SDK 的 `onChunk` 上做，而不是在业务层糊一层。
 *   - **没有逐 span 的 trace**：那一档要的是「一次请求内部的耗时分布」，
 *     与「一轮对话的外部画像」是两件事，等真有"慢在哪一步"的问题再说。
 *   - **没有读的界面**：读取走 `scripts/turns.mts`（`npm run turns`）。
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
	tools: { name: string; ms: number | null; ok: boolean | null }[];
	/** 撞到 `MAX_STEPS` 被掐掉：模型还想调工具，但循环到上限了。 */
	truncated: boolean;
	aborted: boolean;
	/**
	 * SDK 自己的收尾原因（`stop` / `tool-calls` / `length` / `error`…）。
	 * 与 `truncated` **不是一回事**：前者是原始事实，后者是「按当时的 MAX_STEPS
	 * 判定它被掐了」。分开存的意义在于——将来调大上限，历史行的判定不会被重算改写。
	 */
	finishReason: string | null;
	/** 请求进 → 流结束的墙钟耗时（含工具执行与模型生成）。 */
	ms: number;
	inputTokens: number;
	outputTokens: number;
	error: string | null;
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
function pickOutcome(output: unknown): { ms: number | null; ok: boolean | null } {
	if (typeof output !== 'object' || output === null) return { ms: null, ok: null };
	const o = output as { ms?: unknown; ok?: unknown };
	return {
		ms: typeof o.ms === 'number' && Number.isFinite(o.ms) ? o.ms : null,
		ok: typeof o.ok === 'boolean' ? o.ok : null,
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
 */
export function summarizeSteps(
	steps: StepLike[],
	opts: { maxSteps: number; aborted?: boolean; error?: string | null } = { maxSteps: 0 },
): Pick<TurnRecord, 'steps' | 'toolCalls' | 'tools' | 'truncated' | 'aborted' | 'error'> {
	const tools: TurnRecord['tools'] = [];
	for (const step of steps) {
		const byId = new Map(step.toolResults.map((r) => [r.toolCallId, r]));
		for (const call of step.toolCalls) {
			const hit = byId.get(call.toolCallId);
			const { ms, ok } = pickOutcome(hit?.output);
			tools.push({ name: call.toolName, ms, ok });
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
		aborted: opts.aborted === true,
		error: opts.error ?? null,
	};
}

/** 落一行观测。**失败只 log**（见文件头的失败语义）。 */
export function recordTurn(record: Omit<TurnRecord, 'createdAt'> & { createdAt?: string }): void {
	try {
		getDb()
			.prepare(
				`INSERT INTO agent_turns
					(id, created_at, user_text, steps, tool_calls, tools, truncated, aborted,
					 finish_reason, ms, input_tokens, output_tokens, error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					user_text = excluded.user_text, steps = excluded.steps,
					tool_calls = excluded.tool_calls, tools = excluded.tools,
					truncated = excluded.truncated, aborted = excluded.aborted,
					finish_reason = excluded.finish_reason, ms = excluded.ms,
					input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
					error = excluded.error`,
			)
			.run(
				record.id,
				record.createdAt ?? new Date().toISOString(),
				record.userText.slice(0, USER_TEXT_MAX),
				record.steps,
				record.toolCalls,
				JSON.stringify(record.tools),
				record.truncated ? 1 : 0,
				record.aborted ? 1 : 0,
				record.finishReason,
				record.ms,
				record.inputTokens,
				record.outputTokens,
				record.error,
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
	aborted: number;
	finish_reason: string | null;
	ms: number;
	input_tokens: number;
	output_tokens: number;
	error: string | null;
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
				aborted: row.aborted === 1,
				finishReason: row.finish_reason,
				ms: row.ms,
				inputTokens: row.input_tokens,
				outputTokens: row.output_tokens,
				error: row.error,
			});
		}
		return out;
	} catch (err) {
		console.error('[turn-log] failed to read turns:', err);
		return [];
	}
}
