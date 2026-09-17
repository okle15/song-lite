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
 *   耗时          慢不慢（`ms` 是请求进来 → 流结束的墙钟）
 *   tokens        贵不贵
 *   触顶          被 MAX_STEPS 掐了（**模型"话没说完"最可能的原因**）
 *   中断 / 错误   用户点了停止 / 网关报错（后者以前只能翻服务端日志）
 *
 * 用法：
 *   npm run turns            最近 10 轮
 *   npm run turns -- 30      最近 30 轮
 *   npm run turns -- 30 full 附带每轮的完整工具明细
 */
import { recentTurns } from '../server/agent/turn-log';

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

console.log(`\n最近 ${rows.length} 轮  （id 前 8 位 · 时间 · 用户那句 · 步数 · 工具链 · 耗时 · tokens）\n`);

for (const row of rows) {
	const flags = [
		row.truncated ? '触顶' : '',
		row.aborted ? '中断' : '',
		row.error ? '错误' : '',
	].filter(Boolean);
	const failCount = row.tools.filter((t) => t.ok === false).length;

	const head =
		`${row.id.slice(0, 8)}  ${shortTime(row.createdAt)}  ` +
		`${row.userText.slice(0, 24).padEnd(24)}  ` +
		`${String(row.steps).padStart(2)}步  ${toolChain(row.tools.map((t) => t.name))}`;
	const tail = `  ${row.ms}ms  in${row.inputTokens}/out${row.outputTokens}  ${row.finishReason ?? '-'}${
		flags.length ? `  ⚠ ${flags.join(' ')}` : ''
	}${failCount ? `  ✗ 失败工具 ${failCount}` : ''}`;
	console.log(head + tail);

	if (row.error) console.log(`    错误：${row.error.slice(0, 160)}`);
	if (full) {
		for (const t of row.tools) {
			const ms = t.ms === null ? '?' : `${t.ms}ms`;
			const ok = t.ok === null ? '?' : t.ok ? 'ok' : 'FAIL';
			console.log(`    · ${t.name.padEnd(20)} ${ms.padStart(7)}  ${ok}`);
		}
	}
}

const truncated = rows.filter((r) => r.truncated).length;
const aborted = rows.filter((r) => r.aborted).length;
const errored = rows.filter((r) => r.error).length;
const failed = rows.filter((r) => r.tools.some((t) => t.ok === false)).length;
const slow = rows.reduce((a, r) => (r.ms > a.ms ? r : a), rows[0]);

console.log(
	`\n合计 ${rows.length} 轮：触顶 ${truncated} · 中断 ${aborted} · 有错 ${errored} · 内有失败工具 ${failed}`,
);
console.log(`最慢的一轮：${slow.ms}ms（${shortTime(slow.createdAt)}「${slow.userText.slice(0, 20)}」）`);
console.log('加 full 看每轮的工具明细：npm run turns -- 10 full\n');
