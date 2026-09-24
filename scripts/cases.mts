/**
 * 失败案例集 —— `npm run cases`。
 *
 * ── 它回答的是什么问题 ────────────────────────────────────────────────
 * **不是**「它答得对不对」（那需要一个 judge），而是**「某条 prompt 补丁还需不需要」**：
 *
 *   BASE=http://127.0.0.1:3200 npm run cases     # 带 work_style 的实例
 *   BASE=http://127.0.0.1:3201 npm run cases     # PROMPT_DISABLE=work_style 的实例
 *
 * 把两次的数字放在一起看：**不带也全过 ⇒ 那条补丁可以删了**。
 *
 * 这就是 `agent/prompt.ts` 的 `PATCHES` 存在的理由 —— 把「凭感觉删一条规则」
 * 换成「跑两遍看数字」。`LEARNING.md` §3.2 否掉的正是另一种形态（一批固定问题 +
 * 期望答案 → 一个准确率）：准确率不改变任何行动，而「这条可以删了」会。
 *
 * ── 「把两次放在一起看」原本要靠人眼，现在交给 `cases:diff` ─────────────
 * 本文件**只跑一版**（它只认识一个 `BASE`）。要下结论需要两份报告，于是本文件负责
 * 把这一版落成 JSON（`CASES_REPORT=<path>`），`scripts/cases-diff.mts` 负责对比两份
 * JSON 并给出「可以删 / 保留 / 测不出」—— 下面那句「单版只能给一半」说的是这件事。
 *
 *   APP_DB_PATH="C:/tmp/a.db" npm start -- -p 3200
 *   BASE=http://127.0.0.1:3200 CASES_REPORT=full.json   CASES_LABEL=full \
 *     npm run cases
 *   APP_DB_PATH="C:/tmp/b.db" PROMPT_DISABLE=work_style npm start -- -p 3201
 *   BASE=http://127.0.0.1:3201 CASES_REPORT=no-ws.json CASES_LABEL=no-work_style \
 *     npm run cases
 *   npm run cases:diff -- full.json no-ws.json
 *
 * `CASES_LABEL` 只是给人看的标签（默认由响应头的 `x-prompt-disabled` 推出来）；
 * **对比的方向不看它，看 `disabled`** —— 手写的标签可能写反，响应头不会。
 *
 * ── 为什么是脚本，不是 API + 页面 ──────────────────────────────────────
 * 与 `turns.mts` / `auto-tag.mts` 同一个判断：这是**给开发者自己看的**东西。
 * 加一条 API 要顺带更新 README 的接口清单、加一条冒烟用例，而它真正被用到的场合是
 * 「这条补丁现在还需不需要」——一个季度可能问一次。脚本够用且不留架子。
 *
 * ── 为什么打自家的 `/api/agent`，而不是进程内直调 `runAgent` ────────────
 * ① 走的就是用户那条路：⑧ 传输、⑦ 快照装配、⑥ 偏好注入、⑨ 落库全都在链路上，
 *    进度不可能因为"少走了一层"而与真实使用不同；
 * ② 报告标题用**响应头**里的 `x-prompt-version`（路由落的），而不是自己
 *    `import agent/prompt.ts` 算一遍 —— 后者算的是**源码**的指纹，而服务可能正跑着
 *    上一次构建的产物（改完 `agent/**` 忘了 `npm run build` 是 AGENTS.md 明写的高频坑），
 *    报告会因此指着一个不存在的版本，而"跑的是哪一版"是这组对比的全部意义。
 *
 * ── ⚠️ 它会往目标实例的 `messages` / `agent_turns` 写**真实数据** ──────────
 * 所以 `BASE` **没有默认值**（3100 上通常放着用户自己那份真库，跑一次就灌进一堆
 * 合成对话，`npm run turns` 从此不好看了）。用临时库起一个实例：
 *
 *   APP_DB_PATH="C:/tmp/song-lite-cases.db" npm start -- -p 3200
 *   BASE=http://127.0.0.1:3200 npm run cases
 *
 * （Windows 上 `APP_DB_PATH` 别写成 `/c/...`：`path.resolve` 会把 `/c/` 当相对当前
 * 盘符，临时库落到 `C:\c\...`，然后你会"查不到那个文件"，见 AGENTS.md。）
 *
 * 环境变量：`BASE`（必填）· `CASES_REPEAT=N`（每条跑 N 遍，全过才算过 —— 模型是随机的，
 * 一次跑一遍不足以下结论）· `CASE_TIMEOUT_MS`（单条超时，默认 120s）·
 * `CASES_REPORT=<path>`（把这次跑落成 JSON，给 `cases:diff` 读）·
 * `CASES_LABEL=<text>`（这一版的自称，只为在对比表里认得出来）。
 *
 * ── 判据只落在「可观察的事实」上 ─────────────────────────────────────
 * 调了哪个工具、工具成没成功、回答里有没有某个字符串、走了几步。**不判"答得好不好"**：
 * 那需要一个 judge，而"判据可复现"正是这套东西比准确率强的地方 —— 它要回答的不是
 * 「它多聪明」，是「这条补丁还在不在起作用」。
 * 判据词汇表见 `cases/failure-cases.json` 的 `_about`。
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL；2 = 用法/环境不对（没给 BASE、目标打不通、报告写不出）。
 */
import { readFileSync } from 'node:fs';

import {
	REPORT_KIND,
	REPORT_SCHEMA,
	type CaseResult,
	type CasesReport,
	writeReport,
} from '../cases/report';

/* ── 案例集的形状（与 cases/failure-cases.json 对齐）──────────────────── */

type Expect = {
	/** 必须调到的工具（全部）。 */
	tools?: string[];
	/** 至少调到其中一个。用于「两条路都算对」的基线，见 JSON 的 missing-track。 */
	toolsAny?: string[];
	/** 这些工具**必须成功**（`ok !== false`）。只写 `tools` 会让"调了但报错了"也算过。 */
	toolsOk?: string[];
	/** 不许出现的工具（一次都不许）。 */
	toolsNot?: string[];
	/** 回答（全部 text-delta 拼起来）里必须出现的字符串。 */
	text?: string[];
	/** 回答里不许出现的字符串 —— 判"它是不是在编"的主要手段。 */
	textNot?: string[];
	/** 步数上限。撞上 `MAX_STEPS`（5）意味着它开始瞎试了。 */
	maxSteps?: number;
};

type FailureCase = {
	id: string;
	/** 守哪些补丁（`agent/prompt.ts` 的 `PATCH_IDS`）。空数组 = **基线**。 */
	guards: string[];
	/** 这条为什么存在、判据为什么落在这个工具上（给人看的，脚本不读）。 */
	why: string;
	input: string;
	expect: Expect;
};

/* ── 用法与前置检查 ──────────────────────────────────────────────────── */

const BASE = (process.env.BASE ?? '').replace(/\/+$/, '');
if (!BASE) {
	console.error(
		[
			'未指定 BASE。',
			'',
			'本脚本会往**目标实例**的 messages / agent_turns 写真实数据，所以没有默认值',
			'（3100 上通常放着你自己那份真库）。先起一个临时实例，再指向它跑：',
			'',
			'  APP_DB_PATH="C:/tmp/song-lite-cases.db" npm start -- -p 3200',
			'  BASE=http://127.0.0.1:3200 npm run cases',
			'',
			'（⚠️ Windows 上 APP_DB_PATH 别写成 /c/...：会落到 C:\\c\\...，见 AGENTS.md）',
		].join('\n'),
	);
	process.exit(2);
}

let parsed: { cases?: FailureCase[] };
try {
	parsed = JSON.parse(
		readFileSync(new URL('../cases/failure-cases.json', import.meta.url), 'utf8'),
	) as { cases?: FailureCase[] };
} catch (err) {
	console.error(`读不到案例集：${err instanceof Error ? err.message : String(err)}`);
	process.exit(2);
}
const cases = parsed.cases ?? [];
if (cases.length === 0) {
	console.error('案例集是空的（cases/failure-cases.json 的 cases 数组没有元素）。');
	process.exit(2);
}

const CASE_TIMEOUT_MS = Number(process.env.CASE_TIMEOUT_MS) || 120_000;

/**
 * 每条 case 跑几遍（`CASES_REPEAT=3`）。**全过才算过**。
 *
 * 默认 1 是为了跑得快，但**一次跑一遍不足以下结论**：模型是随机的，而"删一条补丁"
 * 是个不可逆的决定。跑 3 遍、报告里显示 `k/N`，看到的就是"它稳定地做不到"还是
 * "它这次恰好做到了"。
 */
const REPEAT = Math.max(1, Number(process.env.CASES_REPEAT) || 1);

/**
 * 把这次跑落成 JSON 的落点（`CASES_REPORT`）。空 = 不落盘（默认行为不变）。
 *
 * 为什么是「脚本自己写文件」而不是「脚本输出、由人贴进报告」：这份 JSON 的消费者是
 * 另一个进程（`cases:diff`），中间任何一次手工搬运都会把"跑的是哪一版"这件事弄丢
 * —— 而那正是这组对比的全部意义。
 */
const REPORT_PATH = (process.env.CASES_REPORT ?? '').trim();

/** 这一版的自称（`CASES_LABEL`）。空 = 由响应头 `x-prompt-disabled` 推出来。 */
const LABEL = (process.env.CASES_LABEL ?? '').trim();

/** 这次跑的起点。写进报告，用来判断"这两份是不是一轮里的"（同一天的两个文件才像一对）。 */
const STARTED_AT = new Date().toISOString();

/**
 * 每个 case 的设备侧快照 —— **脚本就是那台"浏览器"**。
 *
 * ⑦ 的字段按「真相在哪」分流（`server/player/prompt-snapshot.ts`）：曲目 / 队列
 * 由服务端现取，音量 / 播放方式 / 随机 / 进度只认随消息寄来的这份。所以这里给什么，
 * 模型看到的基准值就是什么 —— 固定 `volume: 0.8` 之后，「小声一点」那条案例的
 * 参照点就不受上一条 case 改过什么影响（**跨 case 的状态污染会变成假结论**）。
 */
const DEVICE = { positionSec: 0, volume: 0.8, mode: 'seq', shuffle: false } as const;

/** 探目标前先确认它在听 —— 打不通时报「连不上」，比一串连接错误好读。 */
async function preflight(): Promise<string | null> {
	try {
		const res = await fetch(`${BASE}/api/player/settings`, {
			signal: AbortSignal.timeout(10_000),
		});
		const body = (await res.json().catch(() => null)) as { code?: number } | null;
		if (res.status !== 200 || body?.code !== 0) {
			return `HTTP ${res.status} · code=${body?.code ?? '?'}（不像是这个项目的实例）`;
		}
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/**
 * 把队列恢复成整个曲库。
 *
 * **每条 case 之前跑一遍**，理由不是洁癖：`batch-by-mood` 会把队列换成一批安静的歌，
 * 而 `queue-position`（「跳到第 3 首」）判的就是队列里的位置 —— 上一条留下的自定义队列
 * 会让下一条跑在另一个场景里。那种失败**不是被测对象变了，是场景变了**，
 * 而报告上看不出区别。所以每条 case 自带它的前置状态（与 `api-smoke.mjs` 的
 * 「还原现场」同一个纪律）。
 */
async function resetScene(): Promise<string | null> {
	try {
		const res = await fetch(`${BASE}/api/player/queue`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ trackIds: [] }),
			signal: AbortSignal.timeout(10_000),
		});
		const body = (await res.json().catch(() => null)) as { code?: number; message?: string } | null;
		if (res.status !== 200 || body?.code !== 0) {
			return body?.message ?? `HTTP ${res.status}`;
		}
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/* ── 跑一条 case 并读它的 UI 消息流 ──────────────────────────────────── */

type ToolCall = { name: string; ok: boolean | null; text: string };

type Run = {
	httpStatus: number;
	version: string | null;
	disabled: string | null;
	steps: number;
	tools: ToolCall[];
	text: string;
	finishReason: string | null;
	error: string | null;
	timedOut: boolean;
	ms: number;
};

/**
 * 从一段 SSE 块里取出 `data:` 行。
 *
 * 帧格式是 AI SDK 定的（`ui-message-stream-headers.ts`）：`Content-Type: text/event-stream`
 * + 每帧 `data: <json>\n\n`，收尾 `data: [DONE]`。**一行 JSON 一行帧**，所以
 * JSON.stringify 转义过的换行不会把帧劈成两半 —— 按行取是安全的。
 */
function dataLines(block: string): string[] {
	const out: string[] = [];
	for (const line of block.split('\n')) {
		if (line.startsWith('data:')) out.push(line.slice(5).trim());
	}
	return out;
}

async function runCase(c: FailureCase): Promise<Run> {
	const started = Date.now();
	const run: Run = {
		httpStatus: 0,
		version: null,
		disabled: null,
		steps: 0,
		tools: [],
		text: '',
		finishReason: null,
		error: null,
		timedOut: false,
		ms: 0,
	};

	const controller = new AbortController();
	const timer = setTimeout(() => {
		run.timedOut = true;
		controller.abort();
	}, CASE_TIMEOUT_MS);

	/** toolCallId → 工具名（`tool-output-available` 帧里只有 id，没有名字）。 */
	const nameById = new Map<string, string>();

	try {
		// ⚠️ `messages` 里**只有这一句**：这是"第一次说这句话"，
		// 带上别的 case 的历史就不再是可复现的实验了。
		const res = await fetch(`${BASE}/api/agent`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messages: [{ id: `case-${c.id}`, role: 'user', parts: [{ type: 'text', text: c.input }] }],
				snapshot: DEVICE,
			}),
			signal: controller.signal,
		});
		run.httpStatus = res.status;
		run.version = res.headers.get('x-prompt-version');
		run.disabled = res.headers.get('x-prompt-disabled');

		if (!res.ok) {
			// 非 2xx 是普通 JSON 信封（`fail()` 返回的），不是流 —— 例如没配 key 的 503。
			const body = (await res.json().catch(() => null)) as { message?: string } | null;
			run.error = body?.message ?? `HTTP ${res.status}`;
			return run;
		}
		if (!res.body) {
			run.error = '响应没有 body';
			return run;
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';

		/** 处理一帧。**单独拆成函数是为了让它只在一处** —— 帧类型多了以后最怕漏一种。 */
		const handle = (raw: string) => {
			if (!raw || raw === '[DONE]') return;
			let chunk: Record<string, unknown>;
			try {
				chunk = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				run.error = `流里出现读不懂的帧：${raw.slice(0, 80)}`;
				return;
			}
			const type = String(chunk.type ?? '');
			switch (type) {
				case 'start-step':
					run.steps += 1;
					break;
				case 'text-delta':
					run.text += String(chunk.delta ?? '');
					break;
				case 'tool-input-available': {
					const name = String(chunk.toolName ?? '?');
					nameById.set(String(chunk.toolCallId ?? ''), name);
					// 先按「未知成败」记下这次调用：**调用发生了**这件事本身
					// 就是判据的一半（`tools` / `toolsNot` 看的就是它）。
					run.tools.push({ name, ok: null, text: '' });
					break;
				}
				case 'tool-output-available': {
					const call = lastCall(run.tools, nameById.get(String(chunk.toolCallId ?? '')));
					const out = chunk.output as { ok?: boolean; text?: string } | undefined;
					if (call) {
						call.ok = typeof out?.ok === 'boolean' ? out.ok : true;
						call.text = out?.text ?? '';
					}
					break;
				}
				case 'tool-output-error': {
					const call = lastCall(run.tools, nameById.get(String(chunk.toolCallId ?? '')));
					if (call) {
						call.ok = false;
						call.text = String(chunk.errorText ?? '');
					}
					break;
				}
				case 'error':
					run.error = String(chunk.errorText ?? '未知错误');
					break;
				case 'finish':
					run.finishReason = chunk.finishReason ? String(chunk.finishReason) : null;
					break;
				default:
					// start / text-start / text-end / finish-step / abort / data-* 都不参与判据。
					break;
			}
		};

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let cut = buf.indexOf('\n\n');
			while (cut >= 0) {
				const block = buf.slice(0, cut);
				buf = buf.slice(cut + 2);
				for (const line of dataLines(block)) handle(line);
				cut = buf.indexOf('\n\n');
			}
		}
		// 收尾：流没以 `\n\n` 结束时最后一帧还在 buf 里（正常会被 [DONE] 前面的帧用掉）。
		for (const line of dataLines(buf)) handle(line);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		run.error = run.timedOut ? `超过 ${Math.round(CASE_TIMEOUT_MS / 1000)}s 未结束` : msg;
	} finally {
		clearTimeout(timer);
		run.ms = Date.now() - started;
	}

	return run;
}

/** 从后往前找某个工具的调用记录（同一工具可能被调多次，配对的是最近那次）。 */
function lastCall(tools: ToolCall[], name: string | undefined): ToolCall | undefined {
	if (!name) return undefined;
	for (let i = tools.length - 1; i >= 0; i--) {
		if (tools[i].name === name && tools[i].ok === null) return tools[i];
	}
	return undefined;
}

/* ── 判定 ────────────────────────────────────────────────────────────── */

/**
 * 一条失败判据。`infra` = **这条失败不能归因给补丁**。
 *
 * 分开的理由是这套东西的**全部意义就在于归因**：一次 120s 网关超时与一次
 * 「它用了错的工具」在报告里都只是"红了一条"，但前者说明不了任何关于补丁的事。
 * 混在一起的下场是——**把基础设施抖动记成"补丁还在起作用"**，而那条补丁就
 * 永远删不掉了（没人敢删一条"有失败案例守着"的东西）。
 * （2026-09-23 实测踩到：`batch-by-mood` 在关掉补丁那一版里有一遍卡在 120s 超时。）
 */
type Problem = { text: string; infra?: boolean };

type Verdict = { pass: boolean; problems: Problem[] };

/**
 * 一条 case 的判定。**问题全部收集**（不是遇到第一个就返回）：失败时能看到
 * 「它调了错的工具、而且回答里还编了曲名」，这两件事的修法不一样。
 */
function judge(c: FailureCase, run: Run): Verdict {
	const e = c.expect;
	const problems: Problem[] = [];

	// ── 流没正常结束（超时 / 流内报错）→ **整遍只报环境类问题，后面的行为判据一律不评** ──
	// 这一步的顺序是承重的：卡在 120s 超时的那些轮里，工具链本来就是**残缺**的，
	// 于是「没有调 build_queue」必然成立 —— 它不是"它选错了工具"，是"它还没来得及选"。
	// 照评下去，一条基础设施抖动会被写成"判据失败"，而这套东西的全部意义就是归因。
	if (run.timedOut || run.error) {
		if (run.timedOut) problems.push({ text: `本轮没有正常结束（超过 ${Math.round(CASE_TIMEOUT_MS / 1000)}s）`, infra: true });
		if (run.error) problems.push({ text: run.error, infra: true });
		return { pass: false, problems };
	}

	const names = run.tools.map((t) => t.name);

	// ── 环境类：工具自己执行失败（夹具不成立，或路由坏了）——与"选对了工具没有"无关 ──
	for (const t of e.toolsOk ?? []) {
		const call = run.tools.find((x) => x.name === t);
		if (call && call.ok === false) {
			problems.push({ text: `${t} 执行失败：${call.text.slice(0, 60)}`, infra: true });
		}
	}

	// ── 行为类：它选了哪个工具、走了几步、说了什么。**这些才是补丁的证据** ──
	for (const t of e.tools ?? []) {
		if (!names.includes(t)) problems.push({ text: `没有调 ${t}` });
	}
	if (e.toolsAny && e.toolsAny.length > 0 && !e.toolsAny.some((t) => names.includes(t))) {
		problems.push({ text: `这几个里一个都没调：${e.toolsAny.join(' / ')}` });
	}
	for (const t of e.toolsNot ?? []) {
		const at = names.indexOf(t);
		if (at >= 0) problems.push({ text: `不该调 ${t}（第 ${at + 1} 步调用了）` });
	}
	for (const s of e.text ?? []) {
		if (!run.text.includes(s)) problems.push({ text: `回答里没有「${s}」` });
	}
	for (const s of e.textNot ?? []) {
		if (run.text.includes(s)) problems.push({ text: `回答里出现了「${s}」（像是没查就说了）` });
	}
	if (e.maxSteps !== undefined && run.steps > e.maxSteps) {
		problems.push({ text: `走了 ${run.steps} 步（上限 ${e.maxSteps}）` });
	}

	return { pass: problems.length === 0, problems };
}

/** 工具链。失败的调用缀一个 `!`（`search_library!`）—— 一眼看出调了但没成。 */
function chain(tools: ToolCall[]): string {
	if (tools.length === 0) return '（没调工具）';
	return tools.map((t) => (t.ok === false ? `${t.name}!` : t.name)).join('→');
}

/* ── 主流程 ──────────────────────────────────────────────────────────── */

const bad = await preflight();
if (bad) {
	console.error(`连不上 ${BASE}：${bad}\n先起实例（见本文件头部）；临时库用 APP_DB_PATH 指过去。`);
	process.exit(2);
}

type Attempt = { run: Run; verdict: Verdict };
type Row = { c: FailureCase; attempts: Attempt[]; verdict: Verdict };

/** 报告里代表这条 case 的那一遍：优先展示**失败**的那一遍（它才是有信息量的）。 */
function shownRun(row: Row): Run {
	return (row.attempts.find((a) => !a.verdict.pass) ?? row.attempts[0]).run;
}

const avg = (nums: number[]): number => Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);

/** 一条 case 落进报告的样子。展示字段与判定字段**分开写**，理由见 `cases-report.mts` 头注。 */
function toCaseResult(row: Row): CaseResult {
	return {
		id: row.c.id,
		guards: row.c.guards,
		input: row.c.input,
		pass: row.verdict.pass,
		// 从每一遍的 verdict 数出来，而不是把循环里的局部变量往上带 —— 少一个要同步的地方。
		passed: row.attempts.filter((a) => a.verdict.pass).length,
		repeat: REPEAT,
		// 已经是「第 N 遍：…」的形态（主循环里拼的），这里不再重排。
		problems: row.verdict.problems.map((p) => ({ text: p.text, infra: p.infra === true })),
		steps: row.attempts.map((a) => a.run.steps),
		ms: row.attempts.map((a) => a.run.ms),
		chains: row.attempts.map((a) => chain(a.run.tools)),
	};
}

/** `x-prompt-disabled` 是逗号拼的（`route.ts` 的 `disabled.join(',')`）：空串 = 全部启用。 */
function splitDisabled(header: string | null): string[] | null {
	// ⚠️ **没回这个头 ≠ 回了空串**：前者是"不知道"，后者是"全部启用"。合成一个空数组，
	// 读侧就会把"判不出方向"读成"这一版带全部补丁"—— 一个缺字段的报告会因此
	// 变成「补丁还在起作用，保留」。返回 null 让那个区别一路传到读侧。
	if (header === null) return null;
	return header.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 这一版的自称：没给 `CASES_LABEL` 时从响应头推一个（**只为在对比表里认得出来**）。
 *
 * 注意它接受的是**整份取值列表**而不是一个值：一次跑里出现两个取值时（中途换过配置）
 * 贴哪个都不对，那就退成一句"说不清"—— 标签是给人看的，但它不能说谎。
 */
function defaultLabel(headers: (string | null)[]): string {
	if (headers.length === 0) return '（无 disabled 头）';
	if (headers.length > 1) return '（中途换过配置）';
	const d = splitDisabled(headers[0]);
	if (d === null) return '（无 disabled 头）';
	return d.length ? `off:${d.join('+')}` : 'full';
}

console.log(`\n失败案例集  BASE=${BASE}  ·  共 ${cases.length} 条 · 每条 ${REPEAT} 遍`);
console.log('─'.repeat(96));

const rows: Row[] = [];
for (const c of cases) {
	const attempts: Attempt[] = [];
	const problems: Problem[] = [];
	let passed = 0;

	for (let i = 0; i < REPEAT; i++) {
		// 前置：队列回到整库（理由见 resetScene）。这一步失败**不静默**：
		// 它会让后面的失败无法归因 —— 那正是这套东西最怕的错。
		const resetErr = await resetScene();
		const run = await runCase(c);
		const v = judge(c, run);
		if (resetErr) v.problems.unshift({ text: `队列复位失败：${resetErr}`, infra: true });
		// 每一遍的失败都带上遍号：只显示"有 3 个问题"看不出它们是同一遍里的还是分批出现的。
		if (v.pass) passed += 1;
		else {
			for (const p of v.problems) {
				problems.push({ ...p, text: REPEAT > 1 ? `第 ${i + 1} 遍：${p.text}` : p.text });
			}
		}
		attempts.push({ run, verdict: v });
	}

	const verdict: Verdict = { pass: passed === REPEAT, problems };
	const row: Row = { c, attempts, verdict };
	rows.push(row);

	const run = shownRun(row);
	const rate = REPEAT > 1 ? ` ${passed}/${REPEAT}` : '';
	console.log(
		`${c.id.padEnd(16)}  ${(verdict.pass ? 'PASS' : 'FAIL').padEnd(5)}${rate.padEnd(5)}  ` +
			`${String(run.steps).padStart(2)}步  ${chain(run.tools).slice(0, 32).padEnd(32)}  ${run.ms}ms`,
	);
	console.log(`  └ ${c.input}`);
	if (!verdict.pass) {
		// `⚠ 环境` 前缀不是装饰：它一眼告诉读者**这条失败与补丁无关**（超时 / 工具报错）。
		for (const p of verdict.problems) console.log(`    ✗ ${p.infra ? '⚠ 环境 ' : ''}${p.text}`);
	}
}

/* ── 版本一致性 ──────────────────────────────────────────────────────── */

const allRuns = rows.flatMap((r) => r.attempts.map((a) => a.run));
const versions = [...new Set(allRuns.map((r) => r.version))];
const disabledSet = [...new Set(allRuns.map((r) => r.disabled))];
console.log('─'.repeat(96));

if (versions.length === 1 && versions[0]) {
	const off = disabledSet[0] ?? '';
	console.log(`提示词版本  v:${versions[0]}${off ? `（关掉 ${off}）` : '（全部启用）'}`);
} else if (versions.length === 1) {
	// 服务没回这个头 —— 大概率是**没重建的旧构建**（改完 agent/** 忘了 npm run build）。
	// 那这次跑的数字**不能**跟另一版比：报告上写着的是"我改的这版"，跑的是上一版。
	console.log(
		'提示词版本  ⚠ 响应里没有 x-prompt-version —— 服务多半是**旧构建**（改完 agent/** 忘了 npm run build）。',
	);
} else {
	console.log(`提示词版本  ⚠ 同一次跑里出现了多个版本：${versions.map((v) => v ?? '（无）').join(' / ')}`);
	console.log('  这不该发生：说明中途进程被换过（或重启过），整组数字不可比。');
}

/* ── 分组小计 ────────────────────────────────────────────────────────── */

const groups = new Map<string, Row[]>();
for (const r of rows) {
	const key = r.c.guards.length ? `补丁[${r.c.guards.join(',')}]` : '基线（guards 为空）';
	const list = groups.get(key);
	if (list) list.push(r);
	else groups.set(key, [r]);
}

console.log('');
for (const [key, list] of groups) {
	const ok = list.filter((r) => r.verdict.pass).length;
	const runs = list.flatMap((r) => r.attempts.map((a) => a.run));
	const avgSteps = (runs.reduce((a, r) => a + r.steps, 0) / runs.length).toFixed(1);
	console.log(
		`${key.padEnd(24)} ${ok}/${list.length} 通过 · 平均 ${avgSteps} 步 · 平均 ${avg(runs.map((r) => r.ms))}ms`,
	);
}

/* ── 结论 ────────────────────────────────────────────────────────────── */

const baseline = groups.get('基线（guards 为空）') ?? [];
const baselineBad = baseline.filter((r) => !r.verdict.pass);
const patchGroups = [...groups.entries()].filter(([k]) => k !== '基线（guards 为空）');

/**
 * 这条 case 的失败**能不能算在补丁头上**。
 *
 * 只差在环境类问题上（超时 / 工具报错 / 队列复位失败）的一遍**不算** —— 见 `Problem`。
 * 少了这个区分，一次网关抖动会被记成「补丁还在起作用」，而那条补丁从此永远删不掉：
 * 没人敢删一条"有失败案例守着"的东西。
 */
function attributable(row: Row): boolean {
	return row.attempts.some((a) => a.verdict.problems.some((p) => !p.infra));
}

console.log('');
if (baselineBad.length > 0) {
	console.log('⚠️ 基线红了 —— 这次跑的**环境**有问题，不是补丁的问题。');
	console.log(`   红的是：${baselineBad.map((r) => r.c.id).join('、')}`);
	console.log('   基线守的是 CORE 里的铁律（曲名只能来自工具返回值、找不到要说实话），');
	console.log('   它必须在任何版本下都过。先查这三样：模型网关通不通 · 曲库是不是空的 ·');
	console.log('   服务是不是旧构建。**在此之前，下面补丁组的失败不能归因给补丁。**');
} else {
	console.log(`基线 ${baseline.length}/${baseline.length} 通过 —— 环境是好的，补丁组的数字可以信。`);
}

if (patchGroups.length > 0) {
	console.log('');
	console.log('结论（单版只能给一半）：');
	for (const [key, list] of patchGroups) {
		const ok = list.filter((r) => r.verdict.pass).length;
		const bad = list.filter((r) => !r.verdict.pass);
		const real = bad.filter(attributable);
		const infraOnly = bad.filter((r) => !attributable(r));
		console.log(
			`  ${key}：${ok}/${list.length}` +
				(real.length
					? `  → 判据失败：${real.map((r) => r.c.id).join('、')}`
					: bad.length
						? '  → 没有判据失败'
						: '  → 这版下全过'),
		);
		if (infraOnly.length > 0) {
			console.log(
				`     ⚠ 另有 ${infraOnly.length} 条**只**差在环境类问题上（超时 / 工具报错）：` +
					`${infraOnly.map((r) => r.c.id).join('、')} —— 与补丁无关，别当成证据。`,
			);
		}
		if (bad.length > 0 && real.length === 0) {
			console.log('     ⇒ 这一轮**没测出这条补丁在做事**。它既不能证明补丁没用（是环境抖动），');
			console.log('       也不能证明补丁有用 —— 重跑一次（或调大 CASES_REPEAT）再下结论。');
		}
	}
	console.log('  要判断"还需不需要"，对**不带它**的实例再跑一遍（PROMPT_DISABLE=<id>），然后比这一行：');
	console.log('      不带补丁也全过 ⇒ 它已经没在做事，删掉它');
	console.log('      不带补丁有失败 ⇒ 它还在起作用，保留（失败的这几条就是它的边界）');
}

const failed = rows.filter((r) => !r.verdict.pass).length;
console.log(`\n合计：通过 ${rows.length - failed} · 失败 ${failed}`);
console.log('（每条判据的「为什么落在这个工具上」写在 cases/failure-cases.json 的 why 里）\n');

/* ── 落盘（`CASES_REPORT`）────────────────────────────────────────────── */

if (REPORT_PATH) {
	const report: CasesReport = {
		kind: REPORT_KIND,
		schema: REPORT_SCHEMA,
		label: LABEL || defaultLabel(disabledSet),
		base: BASE,
		// 上面那两行控制台输出已经判过一致性；报告里**照样记原值**，让读侧自己判 ——
		// 「这一版能不能比」这件事必须在读侧也有据可依，不能只活在终端里。
		versions,
		disabled: disabledSet.map((d) => splitDisabled(d)),
		repeat: REPEAT,
		startedAt: STARTED_AT,
		finishedAt: new Date().toISOString(),
		cases: rows.map(toCaseResult),
	};
	try {
		writeReport(REPORT_PATH, report);
		console.log(`报告已落盘：${REPORT_PATH}  （标签 ${report.label} · v:${versions[0] ?? '（无）'}）`);
		console.log('两份到手后：npm run cases:diff -- <这份> <另一份>\n');
	} catch (err) {
		// **不静默、且非零退出**：写不出去时那个路径上多半还留着**上一次**的报告，
		// 下游 cases:diff 会拿它当这次的结果，给出一句关于旧数据的结论。
		// 那比"没有报告"糟得多 —— 没有报告你会去重跑，有旧报告你会直接信。
		console.error(
			`\n⚠️ 报告写不出去：${err instanceof Error ? err.message : String(err)}` +
				`\n   ${REPORT_PATH} 上若还留着上一次的报告，cases:diff 会把它当成这次的结果。\n`,
		);
		process.exit(2);
	}
}

process.exit(failed > 0 ? 1 : 0);
