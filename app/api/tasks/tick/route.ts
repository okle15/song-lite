/**
 * /api/tasks/tick —— ⑩ 触发器的**执行**面：把到期的任务跑掉。
 *
 * ── 为什么是 tick，不是常驻定时器 ──────────────────────────────────
 * 本文件刻意**不提供 setInterval**（理由在 `server/agent/tasks.ts` 的文件头：
 * dev 热重载会越起越多、多实例各起一个、无状态部署里本来就指望不上）。
 * 最小正确形态是「谁来打点都行 + 原子认领」：
 *
 *   cron: * /1 * * * *  curl -fsS -X POST http://127.0.0.1:3100/api/tasks/tick
 *   npm run tasks:tick          # 本机手动打一次
 *
 * **正确性由 `claimDueTask` 的原子认领保证，而不是由"只有一个人在打点"保证** ——
 * 后者是个会被打破的假设，前者不会。
 *
 * ── 一次请求只跑一条 ───────────────────────────────────────────
 * 一轮真实对话 7–14 秒（含工具），所以一分钟一条已经远快于实际需要；而在一个
 * HTTP 请求里连着跑 N 条会撞上平台超时，那时**前面几条的副作用已经发生了**，
 * 后面的没有 —— 一次请求的成败变成一句说不清的话。只跑一条时，"这次跑了什么"
 * 永远是一个确定的答案。
 *
 * ⚠️ 所以这里是**一条直路，不是一个"跑 N 条"的循环**。曾经写过一个
 * `for (i < MAX_TASKS_PER_TICK)` + 循环体里 `return` 的形状：那个常量看着像个
 * 可调旋钮，其实无论改成几都只会跑一条 —— 一个骗人的旋钮比没有旋钮更坏。
 * 真要一次跑多条，先把上面这段读一遍（超时之后"前面几条已发生"只能靠
 * `attempts` 事后认出来）。
 *
 * ── 这一轮也要进 ⑨ ────────────────────────────────────────────
 * 它和用户发起的一轮**在观测里长得一样**（同一张 `agent_turns`、同一个 id 规则）。
 * 理由：⑨ 要回答的是「它哪次答错、慢在哪、花了多少」，而"半夜自己跑的那次"
 * 恰恰是最没人盯着的那些轮次 —— 把它排除在外，观测就漏掉了最需要看的一类。
 */
import type { UIMessage } from 'ai';
import { disabledPatches, promptVersion } from '@/agent/prompt';
import { readAgentConfig } from '@/agent/provider';
import { MAX_STEPS, runAgent } from '@/agent/run';
import { appendMessages } from '@/server/agent/message-log';
import { listPreferences } from '@/server/agent/preference-log';
import { costMicroFor } from '@/server/agent/pricing';
import { claimDueTask, finishOutcome, finishTask, type Task } from '@/server/agent/tasks';
import {
	recordSpans,
	recordTurn,
	summarizeSpans,
	summarizeSteps,
	type StepLike,
} from '@/server/agent/turn-log';
import { fail, ok } from '@/server/http';
import { promptSnapshot } from '@/server/player/prompt-snapshot';

export const dynamic = 'force-dynamic';

/**
 * 唤醒时模型看到的那句话。
 *
 * ⚠️ 它**不进系统提示词**，而是当成本轮的"用户消息"。这个位置的选择是有判据的：
 * 系统提示词是**每一轮都带着**的东西，把"这是定时任务"写进去，等于给所有普通
 * 对话都加一段与它无关的说明 —— 那就是在造新的一条补丁（LEARNING.md §1.2）。
 * 而它的真实身份就是"这一轮的输入"，所以它出现在 messages 里，还会被落库：
 * 用户翻历史时能看到「它半夜是被哪句话唤醒的」。
 */
function triggerText(task: Task, now: Date): string {
	return `【定时任务】你在 ${task.dueAt} 记下了这件事：${task.goal}
（现在是 ${now.toISOString()}。这条不是你面前的用户发的，是计划到点触发的。）
把它做完，然后用一句话说结果。`;
}

export async function POST(request: Request) {
	// 网关没配就**先挡在认领之前**：先认领再失败，那件任务会白费一次
	// `attempts`，而 attempts 是"卡住过几次"的痕迹，不该被配置问题污染。
	const config = readAgentConfig();
	if (!config) return fail('未配置模型网关：请在 .env.local 里设置 LLM_API_KEY。', 503);

	const task = claimDueTask();
	// 没有到期任务就是正常结果（cron 每分钟都在打点），不是错误。
	if (!task) return ok({ ran: false, reason: '没有到期的任务' });

	const startedAt = Date.now();
	const now = new Date(startedAt);
	const turnId = crypto.randomUUID();
	// 消息 id 带上 attempts：同一件任务的不同次执行是**不同的两轮对话**，
	// 共用一个 id 会让第二次覆盖第一次（`messages` 是按 id 幂等覆盖的），
	// 于是"上一次它说了什么"在历史里永远看不到。
	const userMessage: UIMessage = {
		id: `${task.id}:${task.attempts}`,
		role: 'user',
		parts: [{ type: 'text', text: triggerText(task, now) }],
	};

	let text = '';
	let error: string | null = null;
	let firstTextMs: number | null = null;
	let steps: StepLike[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	/**
	 * 这一轮的统计。**在 `finally` 里算一次，收尾与落库共用同一份** ——
	 * 两处各算一遍的话，"收尾判成失败"与"观测记成没触顶"会各说一套，
	 * 而它们说的本来是同一件事（`truncated`）。
	 */
	let summary: ReturnType<typeof summarizeSteps> | null = null;

	try {
		const { result } = await runAgent(config, {
			// 历史只有这一条：定时任务是**从零开始的一轮**，不是接着上一段对话说的。
			// （把用户的历史也塞进来会让"上次说到哪"影响这次要做的事，而任务是自足的。）
			uiMessages: [userMessage],
			// ⑦ 照常现取：服务端权威那几项（曲目 / 队列 / 状态）本来就取自服务端，
			// 所以这里**不需要浏览器上报**，传 null 即可（设备侧四项会取服务端镜像）。
			snapshot: promptSnapshot(null),
			preferences: listPreferences(),
			baseUrl: new URL(request.url).origin,
			onFirstText: () => {
				if (firstTextMs === null) firstTextMs = Date.now() - startedAt;
			},
		});
		text = await result.text;
		try {
			const usage = await result.usage;
			inputTokens = usage.inputTokens ?? 0;
			outputTokens = usage.outputTokens ?? 0;
		} catch {
			// 拿不到就按 0 记（同 `app/api/agent/route.ts` 的取舍）
		}
		try {
			steps = (await result.steps) as unknown as StepLike[];
		} catch {
			// 同上
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		// ⚠️ **必须在 finally 里收尾**（见 `tasks.ts` 的文件头）：漏了它，这件
		// 任务会卡在 `running` 直到租约超时（10 分钟），而用户看到的就是「没反应」。
		// 收尾自己失败也不能把这一轮的观测一起带走，所以单独 catch。
		try {
			summary = summarizeSteps(steps, { maxSteps: MAX_STEPS, aborted: false, error });
			// 判据在 `tasks.ts` 的 `finishOutcome`（有单测）：**没抛异常不等于做成了**。
			// 实测撞到的形状是「连调 5 步工具 → 撞上 MAX_STEPS → 结论是两个换行」，
			// 而 `ok: !error` 会把那一轮记成 `done`，于是用户问「做了吗」时模型
			// 会照着一个空结论回答"做了"。
			finishTask(task.id, finishOutcome({ text, error, truncated: summary.truncated }));
		} catch (finishErr) {
			console.error('[tasks/tick] failed to finish task:', finishErr);
		}
	}

	const ms = Date.now() - startedAt;
	const disabled = disabledPatches();
	// `?? …` 是给类型看的兜底：`finally` 一定跑过、`summarizeSteps` 不抛，
	// 所以正常情况下走不到后半句。
	const s = summary ?? summarizeSteps([], { maxSteps: MAX_STEPS });
	recordTurn({
		id: turnId,
		userText: `【定时】${task.goal}`,
		...s,
		finishReason: error ? 'error' : 'stop',
		ms,
		firstTokenMs: firstTextMs,
		inputTokens,
		outputTokens,
		model: config.model,
		costMicro: costMicroFor(config.model, { inputTokens, outputTokens }),
		promptVersion: promptVersion(disabled),
		promptDisabled: disabled.join(','),
	});
	recordSpans(turnId, summarizeSpans(steps));

	// 落进 ⑤ 会话历史：用户下次打开对话能看见"它半夜自己做了什么"。
	// **去掉两端空白后再判**：`if (text)` 会把 `"\n\n"` 当成有话，于是界面上留下
	// 一个点不动、看不见的空气泡 —— 而它比"没这条"更难读（用户会以为消息加载失败了）。
	const spoke = text.trim();
	if (spoke) {
		appendMessages([
			userMessage,
			{ id: turnId, role: 'assistant', parts: [{ type: 'text', text: spoke }] },
		]);
	}
	// 返回体里也给去空白后的那份：调用方（`scripts/tasks-tick.mts`）拿它当"它说了什么"，
	// 回两个换行与回空串对读的人是同一件事。
	return ok({ ran: true, taskId: task.id, goal: task.goal, text: spoke, error, ms });
}
