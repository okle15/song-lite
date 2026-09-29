/**
 * `server/library/flags.ts` 单测 —— 收藏 / 屏蔽的读写语义。
 *
 * 三条值得钉住的规则，坏掉时都**不报错**：
 *  1. **同 id 只一行**。收藏是「当下的判断」不是流水：重复收藏不该长出第二行，
 *     否则「我收藏了几首」会随点击次数变化。（`setFlag` 的返回值据此给出
 *     「这次真的改了没有」—— 界面与工具都靠它决定说不说「本来就是这个状态」。）
 *  2. **两类标记互不干扰**。同一首歌可以同时收藏与屏蔽（先喜欢、后听腻），
 *     所以是两张表而不是一列二值枚举。
 *  3. **读失败 fail-open**（`listFlagIds` 返回空而不是抛）。这条是**承重**的：
 *     它的读取者是 `getSongs()`（可见曲库的唯一产出点）。改成抛的后果是整库读不出来
 *     （列表 500、`search_library` 全失败），而 fail-open 的后果只是"被屏蔽的那几首又
 *     出现了" —— 旧总比坏强。下面有一个用例**真的把表删掉**来验它。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { closeDb, getDb } from '../db';
import { flagTableName, isFlagged, listFlagIds, setFlag } from './flags';

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), 'library-flags-test-'));
	process.env.APP_DB_PATH = join(dir, 'app.db');
	closeDb();
});

after(() => {
	closeDb();
	delete process.env.APP_DB_PATH;
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	// 两张表一起清：用例之间不互相污染（顺序无关才能定位失败）。
	getDb().exec('DELETE FROM favorites; DELETE FROM hidden;');
});

test('打上标记后可读回，重复打上返回 false（这次没真的改）', () => {
	assert.equal(setFlag('favorite', 'a.mp3', true), true, '第一次收藏应该真的改了');
	assert.equal(isFlagged('favorite', 'a.mp3'), true);
	assert.equal(setFlag('favorite', 'a.mp3', true), false, '重复收藏不该算一次改动');
	assert.deepEqual(listFlagIds('favorite'), ['a.mp3'], '也不该长出第二行');
});

test('摘掉标记：真的摘掉；摘一个本来就没有的返回 false', () => {
	setFlag('favorite', 'a.mp3', true);
	assert.equal(setFlag('favorite', 'a.mp3', false), true);
	assert.equal(isFlagged('favorite', 'a.mp3'), false);
	assert.equal(setFlag('favorite', 'a.mp3', false), false, '本来就没收藏，不算改动');
	assert.deepEqual(listFlagIds('favorite'), []);
});

test('listFlagIds 按 id 排序（顺序稳定 → 响应可预测、可断言）', () => {
	setFlag('favorite', 'c.mp3', true);
	setFlag('favorite', 'a.mp3', true);
	setFlag('favorite', 'b.mp3', true);
	assert.deepEqual(listFlagIds('favorite'), ['a.mp3', 'b.mp3', 'c.mp3']);
});

test('收藏与屏蔽互不干扰：同一首歌可以同时是两个（两张表，不是一列二值）', () => {
	setFlag('favorite', 'a.mp3', true);
	setFlag('hidden', 'a.mp3', true);
	assert.deepEqual(listFlagIds('favorite'), ['a.mp3']);
	assert.deepEqual(listFlagIds('hidden'), ['a.mp3']);

	// 摘掉一个不该动另一个 —— 合成一张表时这里必然出错。
	setFlag('hidden', 'a.mp3', false);
	assert.deepEqual(listFlagIds('favorite'), ['a.mp3'], '取消屏蔽不该把收藏也带走');
	assert.deepEqual(listFlagIds('hidden'), []);
});

test('读失败 fail-open：表不存在时返回空而不是抛（否则整库读不出来）', () => {
	const table = flagTableName('hidden');
	const row = getDb()
		.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`)
		.get(table) as unknown as { sql: string } | undefined;
	assert.ok(row?.sql, `建表语句应该查得到（表名来自固定映射：${table}）`);

	setFlag('hidden', 'a.mp3', true);
	getDb().exec(`DROP TABLE ${table}`);
	try {
		// ⚠️ 这里断言的是「不抛」：`getSongs()` 会经 `hiddenIds()` 走到它，
		// 抛出去的后果是整个曲库 500，而不是少屏蔽几首。
		assert.deepEqual(listFlagIds('hidden'), [], '表没了应该按「没有屏蔽」处理');
	} finally {
		getDb().exec(row.sql);
	}
});
