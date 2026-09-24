/**
 * `agent/run.ts` 的三个纯函数单测 —— 它们都是「只观察 / 只判定，不参与循环」的
 * 东西：`firstTextChunk`（⑨ 的首字延迟取数点）、`overBudget`（成本闸门）、
 * `toolCallPruningFor`（审批续跑那一轮该用哪一档裁剪）。
 *
 * ── firstTextChunk：为什么单独测这个看起来"只有三行"的函数 ──────────
 *
 *   - 它的两条否定分支**都会静默算错**：把工具调用的 chunk 当"第一个字"，
 *     延迟会算成一个**偏小**的值，而它看起来只是"这次挺快"；
 *     空 delta 同理 —— 它不是用户看得见的字。
 *   - 「只回调一次」是它对调用方的契约。破了之后调用方那一侧的表现是
 *     `first_token_ms` 变成**最后一个** chunk 的时刻，而列里仍然是一个正常数字。
 *   - 它是⑨ 里唯一挂进 `② 冻结区` 的东西（`onChunk` 钩子）。把判据钉在单测里，
 *     等于把"这一处只观察、不参与循环"这句话变成可执行的东西 —— 它不需要起模型、
 *     不需要 SDK 对象，喂一个 `{ chunk: {...} }` 就能跑遍。
 *
 * ── overBudget：为什么它的测试几乎全在否定分支上 ────────────────
 * 它只有两种坏掉的形态，而**两种都不报错**：
 *   - 该停不停（累加写错、只看最后一步）→ 上限"配了但从不生效"，钱照烧；
 *   - 该放不放（把"算不出钱"当成"超了"）→ 用户什么都做不了，而且看起来像服务坏了。
 * 这两条各自都能靠单测钉死，成本极低（纯函数、不碰模型、不碰库）。
 *
 * ── toolCallPruningFor：为什么它必须是导出、且必须配一条"形状"用例 ──
 * 选错一档的后果是服务端抛 `ToolCallNotFoundForApprovalError`，而它在 `tsc`、
 * 单测、服务端日志里**一个都不留痕**（错误以 `error` 帧回给浏览器）。所以：
 *   ① 把"选哪一档"提成纯函数，让单测能直接断言它；
 *   ② **还要断言"旧那一档真的会剪坏"** —— 否则这条用例可能是"因为错误的原因而绿"
 *      （比如哪天 SDK 改了裁剪实现，用例照样绿，而 bug 已经回来）。
 *   ②的输入不手工摆：先过一遍真实的 `convertToModelMessages`，让 SDK 自己产出
 *      `tool-call` / `tool-approval-request` / `tool-approval-response` 的布局。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertToModelMessages, pruneMessages, type UIMessage } from 'ai';
import { firstTextChunk, overBudget, toolCallPruningFor } from './run';

/** 只关心 `chunk.type` 与 `chunk.text`，所以事件按**结构**造，不引 SDK 的联合类型。 */
const ev = (type: string, text?: string) => ({ chunk: { type, text } });

test('没传回调时不注册钩子（返回 undefined，SDK 那边等于"不管"）', () => {
	assert.equal(firstTextChunk(undefined), undefined);
});

test('第一个带文字的 text-delta 触发一次', () => {
	let fired = 0;
	const on = firstTextChunk(() => fired++)!;
	on(ev('text-delta', '好'));
	assert.equal(fired, 1);
});

test('连续多个 text-delta 仍然只触发一次（否则记的是"最后一个字"的时刻）', () => {
	let fired = 0;
	const on = firstTextChunk(() => fired++)!;
	on(ev('text-delta', '好'));
	on(ev('text-delta', '的'));
	on(ev('text-delta', '，马上放'));
	assert.equal(fired, 1);
});

test('工具调用之类的 chunk 不算"第一个字"（算了延迟会偏小，看着只是"这次挺快"）', () => {
	let fired = 0;
	const on = firstTextChunk(() => fired++)!;
	on(ev('tool-call'));
	on(ev('tool-result'));
	on(ev('reasoning', '让我想想'));
	on(ev('finish'));
	assert.equal(fired, 0, '一个都还没吐出来');

	// 真吐字时才算 —— 延迟量的是"用户等了多久才看到反应"，不是"模型什么时候开始动"
	on(ev('text-delta', '好'));
	assert.equal(fired, 1);
});

test('空的 text-delta 不算（空串不是用户看得见的字），且不消耗掉"只回调一次"', () => {
	let fired = 0;
	const on = firstTextChunk(() => fired++)!;
	on(ev('text-delta', '')); // 有的实现会先发一个空 delta 起头
	assert.equal(fired, 0);

	on(ev('text-delta', '好'));
	assert.equal(fired, 1, '空 delta 不该把这次机会用掉');
});

test('全程没吐字 → 一次都不回调（调用方据此记 null，而不是 0）', () => {
	let fired = 0;
	const on = firstTextChunk(() => fired++)!;
	on(ev('text-delta', ''));
	on(ev('text-delta'));
	on(ev('tool-call'));
	on(ev('finish'));
	assert.equal(fired, 0);
});

/* ── overBudget（成本闸门）──────────────────────────────────────── */

/** 一步的最小用量形状（与 `BudgetStep` 一致）。 */
const step = (inputTokens: number, outputTokens: number) => ({
	usage: { inputTokens, outputTokens },
});

/** 1 微美元 / 输入 token、2 / 输出 token —— 两档不同，才能看出有没有弄反。 */
const PRICE = { inPerM: 1, outPerM: 2 };

test('overBudget：没配价目 → 一律放行（不拿"不知道"当理由拒绝服务）', () => {
	const over = overBudget({ limitMicro: 1, price: null });
	assert.equal(over({ steps: [step(1_000_000, 1_000_000)] }), false);
});

test('overBudget：上限 <= 0 → 放行（0 是"不限"，不是"一分钱都不许花"）', () => {
	for (const limitMicro of [0, -1]) {
		const over = overBudget({ limitMicro, price: PRICE });
		assert.equal(over({ steps: [step(1_000_000, 1_000_000)] }), false, `limitMicro=${limitMicro}`);
	}
});

test('overBudget：不传 budget → 放行（与加这个闸门之前的行为一致）', () => {
	assert.equal(overBudget(undefined)({ steps: [step(1_000_000, 0)] }), false);
	assert.equal(overBudget(null)({ steps: [step(1_000_000, 0)] }), false);
});

test('overBudget：**逐步累加**，不是只看最后一步（否则多步的一轮永远撞不上上限）', () => {
	// 每步 100 输入 × 1 = 100 微美元。上限 300。
	const over = overBudget({ limitMicro: 300, price: PRICE });
	assert.equal(over({ steps: [step(100, 0)] }), false, '一步 100，没超');
	assert.equal(over({ steps: [step(100, 0), step(100, 0)] }), false, '两步 200，没超');
	assert.equal(
		over({ steps: [step(100, 0), step(100, 0), step(100, 0)] }),
		false,
		'三步 300，正好到上限 —— 不算超',
	);
	assert.equal(
		over({ steps: [step(100, 0), step(100, 0), step(100, 0), step(100, 0)] }),
		true,
		'四步 400，超了',
	);
});

test('overBudget：正好等于上限不算超，多一个 token 就算（limit 是"允许花到这个数"）', () => {
	const over = overBudget({ limitMicro: 100, price: PRICE });
	assert.equal(over({ steps: [step(100, 0)] }), false);
	assert.equal(over({ steps: [step(101, 0)] }), true);
});

test('overBudget：两档价不能弄反（输出往往比输入贵一个量级）', () => {
	// 上限 150；输入 1 微/个、输出 100 微/个。**同样 100 个 token，两档差 100 倍。**
	const over = overBudget({ limitMicro: 150, price: { inPerM: 1, outPerM: 100 } });
	assert.equal(
		over({ steps: [{ usage: { inputTokens: 100, outputTokens: 0 } }] }),
		false,
		'100 输入 = 100，没超',
	);
	assert.equal(
		over({ steps: [{ usage: { inputTokens: 0, outputTokens: 2 } }] }),
		true,
		'2 输出 = 200，超了 —— 两档若写反，上面那条会红',
	);
});

test('overBudget：用量缺项 / 空步数都不崩，缺的按 0 计', () => {
	const over = overBudget({ limitMicro: 100, price: PRICE });
	assert.equal(over({ steps: [] }), false);
	assert.equal(over({ steps: [{}] }), false, 'usage 整个缺席');
	assert.equal(over({ steps: [{ usage: null }] }), false);
	assert.equal(over({ steps: [{ usage: {} }] }), false, '两项都缺');
	assert.equal(over({ steps: [{}] }), false, '前面的步缺 usage 不该影响后面的累加');
});

/* ── toolCallPruningFor（审批续跑那一轮不许裁工具轨迹）────────────── */

/**
 * 造一条 UI 消息。`parts` 按**结构**给、整体断言成 `UIMessage`：这几个 part 在
 * SDK 的联合类型里各自要带一堆字段，而本文件只关心「是不是 tool part、state 是
 * 什么」。**真实形状由下面那条端到端用例钉住**，所以这里的断言不承重。
 */
const ui = (id: string, role: 'user' | 'assistant', parts: unknown[]): UIMessage =>
	({ id, role, parts }) as unknown as UIMessage;

/** 一个工具 part 的最小形状：`state` 是唯一的自变量。 */
const toolPart = (state: string) => ({ type: 'tool-forget_preference', toolCallId: 'call_1', state });

test('toolCallPruningFor：只有"审批已答复"那一轮返回 none，其余一律照常裁', () => {
	assert.equal(
		toolCallPruningFor([ui('a1', 'assistant', [{ type: 'step-start' }, toolPart('approval-responded')])]),
		'none',
		'用户刚点了「执行」或「算了」—— 这一轮是续跑',
	);

	// 下面每一条都**不是**续跑。若在这里误判成 'none'，历史轮的工具轨迹就全留下来了 ——
	// 那不是"修好了"，是把产品行为（BLUEPRINT：轨迹全扔）改错，而且不报错。
	assert.equal(
		toolCallPruningFor([ui('a1', 'assistant', [toolPart('approval-requested')])]),
		'before-last-message',
		'刚弹出审批框那一轮：工具还没跑过，没有"续跑"这回事',
	);
	for (const state of ['input-streaming', 'input-available', 'output-available', 'output-error']) {
		assert.equal(
			toolCallPruningFor([ui('a1', 'assistant', [toolPart(state)])]),
			'before-last-message',
			`state=${state}`,
		);
	}
	assert.equal(
		toolCallPruningFor([ui('u1', 'user', [{ type: 'text', text: '放首歌' }])]),
		'before-last-message',
		'一条工具 part 都没有',
	);
	assert.equal(toolCallPruningFor([]), 'before-last-message', '空历史（第一轮）');
});

test('⚠️ 形状：`before-last-message` 真会把 tool-call 剪掉而审批请求留着（配对断裂）', async () => {
	// 输入不手工摆：先过一遍真实的 `convertToModelMessages`，再喂给 `pruneMessages`。
	// 手摆 ModelMessage[] 也能让断言变红，但那证明的是"我摆错了"，不是"产品会错"。
	// 数据形态照抄 09-24 端到端抓到的真实请求体。
	const uiMessages: UIMessage[] = [
		ui('u1', 'user', [{ type: 'text', text: '以后别再给我推摇滚了' }]),
		ui('a1', 'assistant', [
			{ type: 'step-start' },
			{ type: 'text', text: '\n\n', state: 'done' },
			{
				type: 'tool-forget_preference',
				toolCallId: 'call_1',
				state: 'approval-responded',
				input: { key: 'disliked_genre' },
				approval: { id: 'aitxt-1', approved: true },
			},
		]),
	];
	const history = await convertToModelMessages(uiMessages, { tools: {}, ignoreIncompleteToolCalls: true });

	/**
	 * 量出「有几个审批请求找不到配对的 tool-call」——这正是服务端
	 * `collectToolApprovals` 的判据（找不到就抛 `ToolCallNotFoundForApprovalError`）。
	 */
	const orphanApprovals = (mode: 'none' | 'before-last-message') => {
		const out = pruneMessages({ messages: history, reasoning: 'none', toolCalls: mode, emptyMessages: 'remove' });
		const callIds = new Set<string>();
		const approvalCallIds: string[] = [];
		for (const message of out) {
			if (typeof message.content === 'string') continue;
			for (const part of message.content) {
				if (part.type === 'tool-call') callIds.add(part.toolCallId);
				if (part.type === 'tool-approval-request') approvalCallIds.push(part.toolCallId);
			}
		}
		return approvalCallIds.filter((id) => !callIds.has(id));
	};

	// ① **先证明旧那一档真的会红**。少了这一半，下面那条即使绿也说明不了什么。
	assert.equal(
		orphanApprovals('before-last-message').length,
		1,
		'旧那一档：审批请求成了孤儿 —— 这就是线上那句 "Tool call … not found for approval request …"',
	);

	// ② 这一轮的档位必须恰好是 `none`，且接了它之后配对完整 —— 把两半接起来才叫回归。
	assert.equal(toolCallPruningFor(uiMessages), 'none');
	assert.equal(orphanApprovals(toolCallPruningFor(uiMessages)).length, 0, '本轮档位下配对必须完整');
});
