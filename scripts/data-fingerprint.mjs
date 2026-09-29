/**
 * 生产数据根的指纹 —— 「单测有没有偷偷写进真库」这条守卫的**唯一**规则出处。
 *
 * ── 为什么必须单独一个文件，而不是开始、收尾各写一遍 ──────────────────
 * 「核对数据没被动过」这类工作最经典的翻车**不是粗心，是规则写了两遍**。
 * 2026-09-24 实测过一次：快照那侧 walk 了 `data/music/`，核对那侧在 walk 里
 * 把它剔掉了 → 打出「13 个文件 → 1 个 ❌ 有变化」。**假警报比漏报贵**：
 * 漏报只是没抓到；假警报会让人去改没坏的东西，甚至回滚一次本来正确的操作。
 *
 * 所以这里只暴露 `fingerprint(root)`：开始侧、收尾侧调的是同一个函数，
 * 「两侧不一致」这个可能性从根上消失。
 *
 * ── 算法（写死在这里，调用方不许另立一套）──────────────────────────
 *   递归列出 root 下**全部文件**（不含目录本身），按相对路径**排序**
 *   → 每个文件取 `sha256(内容)` 的前 16 位十六进制
 *   → 再用「相对路径 + 字节数 + 该哈希」拼总摘要。
 *
 * ⚠️ **排序是承重的**：目录读取顺序由文件系统决定、不保证稳定，
 * 不排序会让同一份数据算出两个摘要，又造出一次假警报。
 * ⚠️ 比对时**只比哈希、不比 mtime**：mtime 会因为一次无内容的 touch 而变，
 * 那属于「变了但没差」；反过来「同大小同时间的不同内容」只有内容哈希抓得住。
 *
 * ── 为什么连 `data/music/` 那 34MB 音频一起算，不图省事只算 `app.db` ──
 * 「哪些子目录不会被写」是一个**假设**，而这份文件存在的意义就是不再靠假设。
 * 代价可控：34MB 的 sha256 实测一次约 0.1 秒，且 OS 页缓存会吸收重复读。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * 不参与指纹的目录段。
 * 写法：精确段名（`node_modules`）；以 `*` 结尾 = **段名前缀**（`.next*` 命中
 * `.next` / `.next_old_123`）。
 * ⚠️ 这是**规则的一部分**，只在本文件出现 —— 调用方不许传自己的排除项
 * （正是"我在两侧各写了一遍"才会造出不对称）。
 */
export const FINGERPRINT_EXCLUDES = ['node_modules', '.git', '.next*', '.turbo', 'dist', 'build'];

/** 段名命中任一条即排除。 */
function excluded(rel, excludes) {
	const segs = rel.split('/');
	return segs.some((seg) =>
		excludes.some((rule) => (rule.endsWith('*') ? seg.startsWith(rule.slice(0, -1)) : seg === rule)),
	);
}

/**
 * 列出 root 下全部文件（相对路径、`/` 分隔、已排序）。root 不存在 = 空数组
 * —— 空也要求指纹，而不是抛错：干净仓库跑测试时 `data/` 可能真不存在。
 */
export function listFiles(root, excludes = FINGERPRINT_EXCLUDES) {
	if (!existsSync(root)) return [];
	const out = [];
	const rec = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			const rel = relative(root, abs).split(sep).join('/');
			if (excluded(rel, excludes)) continue;
			if (entry.isDirectory()) rec(abs);
			else if (entry.isFile()) out.push(rel);
		}
	};
	rec(root);
	return out.sort();
}

/**
 * 求指纹。返回 `{ count, digest, rows }`：
 *  - `count` —— 参与的文件数。**报数时必须连口径一起写**：这是「递归、含子目录、
 *    不含目录本身、含 SQLite 边车」的数，否则过一天就会自相矛盾。
 *  - `digest` —— 总摘要前 16 位，用于快速判「有没有变」。
 *  - `rows`   —— 逐文件 `{ rel, size, hash }`，有差异时用来**点名**是哪个文件。
 */
export function fingerprint(root) {
	const rows = listFiles(root).map((rel) => {
		const buf = readFileSync(join(root, rel));
		return {
			rel,
			size: buf.length,
			hash: createHash('sha256').update(buf).digest('hex').slice(0, 16),
		};
	});
	const total = createHash('sha256');
	for (const r of rows) total.update(`${r.rel}\0${r.size}\0${r.hash}\n`);
	return { count: rows.length, digest: total.digest('hex').slice(0, 16), rows };
}

/**
 * 逐文件比对两次指纹，返回 `+ 新增` / `- 删除` / `~ 改动` 文本行（相同则空数组）。
 * 光有一个总摘要变了、说不出**是什么**变了，收尾时无法归因。
 */
export function diffRows(before, after) {
	const b = new Map(before.map((r) => [r.rel, r]));
	const a = new Map(after.map((r) => [r.rel, r]));
	const lines = [];
	for (const [rel, r] of a) {
		const old = b.get(rel);
		if (!old) lines.push(`+ 新增  ${rel}  (${r.size} B)`);
		else if (old.hash !== r.hash) lines.push(`~ 改动  ${rel}  (${old.size} B → ${r.size} B)`);
	}
	for (const rel of b.keys()) if (!a.has(rel)) lines.push(`- 删除  ${rel}`);
	return lines;
}
