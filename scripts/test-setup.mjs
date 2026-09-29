/**
 * 单测的全局前置 —— 挂在 `npm test` 的 `--import` 上，**早于任何业务模块求值**。
 *
 * ⚠️ 时机是承重的。放在某个测试文件的 `before()` 里是没用的：那时别的模块
 * （包括 `server/db.ts` 之类在**顶层**读 env 的）可能已经求值过了。
 * `--import` 是进程启动阶段，是唯一确定更早的位置。
 *
 * 它做两件互不替代的事。
 *
 * ── ① 改道：把数据根指到临时目录 ────────────────────────────────
 * 为什么需要：`server/db.ts` 的默认位置是 `<cwd>/data/app.db`。在此之前，
 * 7 个测试文件里只有 5 个在各自 `before()` 里设了 `APP_DB_PATH` —— 也就是说
 * **新加一个测试、忘了设这一句，它就写进了真库，而且不报错**
 * （写入侧走流水语义，只 log）。这层把「记得设」变成「默认就设好了」。
 *
 * 每个进程各建一个临时目录（node 的 test runner 一个文件一个进程），
 * 所以文件之间天然隔离，不会互相抢一个 SQLite 文件。
 *
 * ── ② 守卫：生产 `data/` 有没有被动过 ───────────────────────────
 * 为什么需要：①只认「环境变量」这**一种写法**。一个模块若自己
 * `path.join(process.cwd(), 'data', 'app.db')`（本仓今天只有 `server/db.ts`
 * 一处，而"今天只有一处"不是保证），①完全看不见。
 * 这一层不问写法、只问结果：开始拍一次指纹，进程退出再拍一次，不一致就
 * **非零退出并点名文件**。指纹的规则在 `./data-fingerprint.mjs`，两侧同一份。
 *
 * ── 已知逃逸（诚实交代，别当它密不透风）───────────────────────────
 *  · 测试若**中途 `delete process.env.APP_DB_PATH`**，改道就被撤销了。
 *    本仓那 5 个测试正是在 `after()` 里这么做 —— 那时文件已跑完，之后再无写入，
 *    所以安全；但这是**约定**不是机制。真发生了由 ② 兜住并报红。
 *  · ② 只盯 `data/`。写到仓库别处（例如误建在根目录）它看不见。
 *  · `process.on('exit')` 在**同步**代码里跑，被 SIGKILL 的进程不会触发。
 *  · ② 拦的是「仓库那份 `data/`」。用户显式 `APP_DB_PATH=<别处>` 时，
 *    那处不受保护 —— 那是用户自己点名的位置，符合预期。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINGERPRINT_EXCLUDES, diffRows, fingerprint } from './data-fingerprint.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 「本前置已经跑过一次」的标记：用来区分「用户给的 APP_DB_PATH」与「上层进程给的」。 */
const RAN = 'SONGLITE_TEST_SETUP_RAN';
/** 用户显式指定的库。只在**第一次**进来时抄一次，之后各进程都认它。 */
const USER_DB = 'SONGLITE_TEST_USER_DB';

/** 装上了的断言靠这两个（见 `architecture.test.ts`）。 */
export const SETUP_MARKER = RAN;

// ── ① 改道 ────────────────────────────────────────────────────────
if (!process.env[RAN]) {
	// 第一次进来（父进程）：把"用户显式给的"记下来；没有就留空串（= 我们自己造）。
	process.env[USER_DB] = process.env.APP_DB_PATH ?? '';
	process.env[RAN] = '1';
}
const userDb = process.env[USER_DB];
process.env.APP_DB_PATH = userDb || join(mkdtempSync(join(tmpdir(), 'song-lite-test-')), 'app.db');

// ── ② 守卫 ────────────────────────────────────────────────────────
const DATA_ROOT = join(REPO_ROOT, 'data');
const before = fingerprint(DATA_ROOT);

process.on('exit', () => {
	const after = fingerprint(DATA_ROOT);
	if (before.digest === after.digest) return;
	const lines = diffRows(before.rows, after.rows);
	process.stderr.write(
		`\n[safe-data] 生产数据根被改了 —— ${DATA_ROOT}\n` +
			`  基线 ${before.count} 个文件 (${before.digest}) → 现在 ${after.count} 个 (${after.digest})\n` +
			lines.map((l) => `  ${l}`).join('\n') +
			`\n  这**不是某个测试失败**，是有测试写进了真库。多半是新加的那个用例忘了\n` +
			`  让数据根改道（本前置默认会改，除非它中途把 APP_DB_PATH 删了）。\n` +
			`  本层不豁免任何路径；指纹规则见 scripts/data-fingerprint.mjs。\n` +
			`  排除段（每次都打印，避免"静默跳过"）：${FINGERPRINT_EXCLUDES.join(', ')}\n`,
	);
	process.exitCode = 1;
});
