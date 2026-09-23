/**
 * 打一次 tick —— `npm run tasks:tick`。
 *
 * ── 为什么是「打一次」而不是「常驻定时器」 ──────────────────────────────
 * ⑩ 的最小正确形态是 **tick（外部打点）+ 原子认领**，理由写在
 * `server/agent/tasks.ts` 的文件头（dev 热重载会越起越多、多实例各起一个、
 * 无状态部署里进程随时被回收）。结论是：**定时器的位置属于部署环境**，
 * 不在应用代码里。所以这个脚本干的事只有一件 —— 打一次，然后退出。
 *
 * 生产上换成 cron 一行就够（`curl -fsS -X POST .../api/tasks/tick`），
 * 本脚本的用途是**本机手动试**：排一条一分钟后的任务，看它到点会不会自己动。
 *
 * ── 为什么默认 3100 而不是 3000 ───────────────────────────────────
 * 与 `api-smoke.mjs` 同一个约定：3100 是**生产构建**的那一份（`npm start`），
 * 而本项目的前端回归一律走生产模式（dev 的 Turbopack 会干扰 SSE，见 README）。
 * 要打别的实例就把 `BASE` 指过去。
 *
 * ⚠️ **它会真的执行到期任务**（写 `tasks` / `agent_turns` / `messages`，还可能有
 * 播放副作用）。所以别对着一个你不打算让它动的实例跑。
 */
const BASE = (process.env.BASE ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');

/** 单次 tick 会跑一轮完整对话（实测 7–14 秒），给足时间。 */
const TIMEOUT_MS = Number(process.env.TICK_TIMEOUT_MS ?? 120_000);

const url = `${BASE}/api/tasks/tick`;
process.stdout.write(`POST ${url}\n`);

let res: Response;
try {
	res = await fetch(url, {
		method: 'POST',
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
} catch (err) {
	// 「连不上」是最常见的失败（忘了起服务 / 端口不对），所以把原始原因带出来，
	// 而不是把它包成一句「请求失败」——那正是 B1 要消灭的写法。
	console.error(`连不上 ${BASE}：${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}

const text = await res.text();
let body: { code?: number; data?: Record<string, unknown>; message?: string };
try {
	body = JSON.parse(text) as typeof body;
} catch {
	console.error(`HTTP ${res.status}，响应不是 JSON：${text.slice(0, 200)}`);
	process.exit(1);
}

if (body.code !== 0) {
	// 该报的错要报出来（比如网关没配 key 时是 503）——**不能当成"这次没活干"**：
	// 那会让"配置坏了"看起来像"一切正常，只是没有到期任务"。
	console.error(`HTTP ${res.status} / code ${body.code}：${body.message ?? '(无 message)'}`);
	process.exit(1);
}

const d = body.data ?? {};
if (d.ran) {
	process.stdout.write(`跑了 1 条：${String(d.goal ?? '')}\n`);
	process.stdout.write(`它说：${String(d.text ?? '(空回复)')}\n`);
	process.stdout.write(`耗时 ${String(d.ms ?? '?')}ms，任务 ${String(d.taskId ?? '?')}\n`);
	if (d.error) process.stdout.write(`⚠ 这一轮出错：${String(d.error)}\n`);
} else {
	// `ran: false` 是**正常结果**（cron 每分钟都在打点，绝大多数次都是这个），
	// 所以退出码仍是 0 —— 把它当失败会让 cron 一直发告警。
	// 注意它**不区分**「没有到期任务」与「刚被别人抢走」：对调用方这两件事都是
	// "这一轮没我干的活"，而认领的原子性由 `claimDueTask` 保证（`server/agent/tasks.ts`）。
	process.stdout.write(`没跑：${String(d.reason ?? '(未说明)')}\n`);
}
