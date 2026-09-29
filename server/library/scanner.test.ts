/**
 * `server/library/scanner.ts` 单测 —— 只测 **2026-09-28 补的 `rescanLibrary()`**。
 *
 * 为什么值得测（它坏掉时**不报错**）：
 *
 *  1. **`previousTotal` 为 `null` 的那一格。** 进程起来后一次都没扫过时，
 *     我们不知道"之前有几首"，而且为了得到那个数先扫一遍是白花一倍的时间。
 *     所以 null = **无从得知**，与 `first_token_ms` 的 NULL 同源（不是 0）。
 *     若把它写成 0，工具就会说「新增了 N 首」—— 一句编出来的话。
 *  2. **重扫真的丢掉了缓存。** 忘了 `cachedSongs = null` 的话，返回值看着
 *     一切正常（total 还是老数），而用户刚加进去的那首歌永远不出现 ——
 *     正是这个功能要解决的那个问题，且界面上没有任何提示。
 *
 * 曲库用的是**临时目录里的一份真 mp3**（从 `data/music` 拷一首），
 * 所以断言可以钉在确切数字上，不随用户往曲库里加歌而变。
 *
 * ⚠️ **用例顺序是承重的**：扫描缓存是模块级的，下面第一条必须在**任何一次扫描之前**
 * 跑（它要验的正是"还没扫过"这个状态）。
 */
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { rescanLibrary } from './scanner';

let dir: string;
let musicDir: string;
let savedMusicDir: string | undefined;

/** 找一首真 mp3 拷进临时目录（扫描器要 `parseFile` 真能读出东西才算曲目）。 */
function pickOneAudio(): string {
	const root = resolve('data/music');
	const found: string[] = [];
	const walk = (d: string): void => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else if (p.toLowerCase().endsWith('.mp3')) found.push(p);
		}
	};
	if (existsSync(root)) walk(root);
	return found[0] ?? '';
}

before(() => {
	savedMusicDir = process.env.MUSIC_DIR;
	dir = mkdtempSync(join(tmpdir(), 'scanner-test-'));
	musicDir = join(dir, 'music');
	const src = pickOneAudio();
	if (src) {
		mkdirSync(musicDir);
		copyFileSync(src, join(musicDir, 'one.mp3'));
	}
});

after(() => {
	if (savedMusicDir === undefined) delete process.env.MUSIC_DIR;
	else process.env.MUSIC_DIR = savedMusicDir;
	rmSync(dir, { recursive: true, force: true });
});

// ① 必须第一个跑：它验的是「任何一次扫描之前」的状态。
test('没扫过时 previousTotal 是 null（**无从得知**，不是 0）', async () => {
	delete process.env.MUSIC_DIR;
	const r = await rescanLibrary();
	assert.equal(r.total, 0, '没配 MUSIC_DIR 时曲库为空');
	assert.equal(
		r.previousTotal,
		null,
		'说成 0 会让工具报出「新增了 0 首」这种编出来的话 —— null 是"不知道"',
	);
});

// ② 配好目录：第一次不知道上次有几首，第二次就知道了（缓存真的被丢掉又重建）。
test('重扫两次：第二次的 previousTotal = 第一次的 total', async () => {
	process.env.MUSIC_DIR = musicDir;
	const first = await rescanLibrary();
	assert.equal(first.total, 1, '临时目录里拷了一首真 mp3');
	assert.equal(first.previousTotal, null, '这一轮之前还没扫过');

	const second = await rescanLibrary();
	assert.equal(second.previousTotal, first.total, '第二次该知道上次有几首');
	assert.equal(second.total, first.total);
	assert.ok(second.ms >= 0);
});
