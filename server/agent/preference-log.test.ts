/**
 * `server/agent/preference-log.ts` 单测 —— 偏好的读写。
 *
 * 为什么值得测：它的失败方式同样是**静默**的，而且暴露得比对话历史还慢
 * （要等到下一轮对话、甚至重启服务之后才看出来）。
 *
 *   - 「同 key 覆盖」坏了 → 用户说五遍「不喜欢摇滚」长出五条偏好，
 *     提示词被同一件事占满，而且看起来"它在认真记"；
 *   - 顺序反了 → 注入时有条数上限，被砍掉的会是**用户刚说的那条**；
 *   - 删不掉 → 用户说「不用记了」，它下一轮还在用那条偏好行事。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { closeDb, getDb } from '../db';
import { listPreferences, removePreference, setPreference } from './preference-log';

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), 'preference-log-test-'));
	process.env.APP_DB_PATH = join(dir, 'app.db');
	closeDb();
});

after(() => {
	closeDb();
	delete process.env.APP_DB_PATH;
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	getDb().exec('DELETE FROM preferences');
});

test('同 key 再写是覆盖而非新增（用户说两遍同一件事只该有一条）', () => {
	setPreference('disliked_genre', '摇滚');
	setPreference('disliked_genre', '摇滚和电子');

	const all = listPreferences();
	assert.equal(all.length, 1, '同 key 不应长出第二条');
	assert.equal(all[0].value, '摇滚和电子', '值应被覆盖为最新');
});

test('最近更新的在前（注入有条数上限时，砍掉的必须是旧的）', () => {
	setPreference('a', '一', new Date('2026-01-01T00:00:00.000Z'));
	setPreference('b', '二', new Date('2026-01-02T00:00:00.000Z'));
	setPreference('c', '三', new Date('2026-01-03T00:00:00.000Z'));

	assert.deepEqual(
		listPreferences().map((p) => p.key),
		['c', 'b', 'a'],
	);
});

test('覆盖会把它顶到最前（顺序反映的是「最近提到」而不是「最早记下」）', () => {
	setPreference('a', '一', new Date('2026-01-01T00:00:00.000Z'));
	setPreference('b', '二', new Date('2026-01-02T00:00:00.000Z'));
	// 用户又提起 a —— 它应该重新成为最近的一条，因为「最近说过」才代表当前心意。
	setPreference('a', '一改了', new Date('2026-01-03T00:00:00.000Z'));

	assert.deepEqual(
		listPreferences().map((p) => p.key),
		['a', 'b'],
	);
});

test('同一毫秒写入时顺序仍确定（updated_at 撞车由 rowid 兜底）', () => {
	const at = new Date('2026-02-02T02:02:02.000Z');
	setPreference('first', '一', at);
	setPreference('second', '二', at);

	// 后写的在前；不断言「谁赢」的业务含义，只断言**结果稳定**——
	// 否则 SQLite 的返回顺序在这两种情况下都可能变，回放时看起来像随机。
	const keys = listPreferences().map((p) => p.key);
	assert.deepEqual(keys, ['second', 'first']);
	assert.deepEqual(listPreferences().map((p) => p.key), keys, '两次读取结果必须一致');
});

test('remove 返回是否真的删掉了（删不存在的 key 不算失败）', () => {
	setPreference('disliked_genre', '摇滚');
	assert.equal(removePreference('disliked_genre'), true);
	assert.equal(listPreferences().length, 0);
	// 模型可能记错 key；第二次调用要能分辨「删掉了」与「本来就没什么可删」
	assert.equal(removePreference('disliked_genre'), false);
});

test('limit 夹紧：非法值回落默认，超大值不超过硬上限且不抛', () => {
	setPreference('a', '一');
	setPreference('b', '二');
	setPreference('c', '三');

	assert.equal(listPreferences(2).length, 2, '取最近 2 条');
	assert.equal(listPreferences(0).length, 3, '非法 limit 回落默认（而非截断成空）');
	assert.equal(listPreferences(Number.NaN).length, 3);
	assert.equal(listPreferences(10_000).length, 3, '超过行数时取到全部，不抛');
});

test('空表返回空数组（第一次对话时不该有任何偏好）', () => {
	assert.deepEqual(listPreferences(), []);
});

test('读回来的形状只有 key / value（不多带 updated_at 这类内部字段）', () => {
	setPreference('disliked_genre', '摇滚');
	assert.deepEqual(Object.keys(listPreferences()[0]).sort(), ['key', 'value']);
});
