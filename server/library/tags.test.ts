/**
 * `server/library/tags.ts` 单测 —— 曲目标签的读写与「谁能覆盖谁」。
 *
 * 为什么值得测：两条规则坏掉时都**不报错** ——
 *   - 「同 id 覆盖」坏了 → 用户改主意后旧标签还在，检索同时命中两个互相矛盾的风格；
 *   - 「AI 不覆盖用户」坏了 → 每重跑一次打标脚本就悄悄抹掉用户的主观偏好，
 *     而那正是优先级最高的那层（用户只会觉得「我设的标签过几天自己变了」）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { closeDb, getDb } from '../db';
import { getTrackTags, listTrackTags, removeTrackTags, setTrackTags } from './tags';

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), 'track-tags-test-'));
	process.env.APP_DB_PATH = join(dir, 'app.db');
	closeDb();
});

after(() => {
	closeDb();
	delete process.env.APP_DB_PATH;
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	getDb().exec('DELETE FROM track_tags');
});

test('写入后可读回，标签已归一化', () => {
	setTrackTags('a.mp3', ['Pop', 'folk'], 'ai');
	const row = getTrackTags('a.mp3');
	assert.deepEqual(row?.tags, ['folk', 'pop']);
	assert.equal(row?.source, 'ai');
});

test('同 id 再写是覆盖而非新增（一首歌只该有一个风格判断）', () => {
	setTrackTags('a.mp3', ['rock'], 'ai');
	setTrackTags('a.mp3', ['folk'], 'ai');
	assert.equal(listTrackTags().length, 1, '同 id 不应长出第二行');
	assert.deepEqual(getTrackTags('a.mp3')?.tags, ['folk']);
});

test('AI 不覆盖用户已设的标签（重跑打标脚本不该抹掉主观偏好）', () => {
	setTrackTags('a.mp3', ['folk'], 'user');
	const result = setTrackTags('a.mp3', ['rock'], 'ai');

	assert.equal(result.applied, false, 'AI 的写入不该生效');
	assert.deepEqual(result.current.tags, ['folk'], '返回的应是用户那行');
	assert.deepEqual(getTrackTags('a.mp3')?.tags, ['folk'], '库里也必须保持用户的值');
	assert.equal(getTrackTags('a.mp3')?.source, 'user');
});

test('用户重设可以覆盖 AI 的标签（「最优先」的入口）', () => {
	setTrackTags('a.mp3', ['rock'], 'ai');
	const result = setTrackTags('a.mp3', ['民谣'], 'user');

	assert.equal(result.applied, true);
	assert.equal(getTrackTags('a.mp3')?.source, 'user');
	assert.deepEqual(getTrackTags('a.mp3')?.tags, ['民谣']);
});

test('用户再改一次仍是覆盖（改主意立即生效，不留历史版本）', () => {
	setTrackTags('a.mp3', ['民谣'], 'user');
	setTrackTags('a.mp3', ['摇滚'], 'user');
	assert.equal(listTrackTags().length, 1);
	assert.deepEqual(getTrackTags('a.mp3')?.tags, ['摇滚']);
});

test('没有标签的歌返回 null（而不是抛）', () => {
	assert.equal(getTrackTags('nope.mp3'), null);
});

test('remove 返回是否真的删掉了，删后回到 null', () => {
	setTrackTags('a.mp3', ['folk'], 'user');
	assert.equal(removeTrackTags('a.mp3'), true);
	assert.equal(getTrackTags('a.mp3'), null);
	assert.equal(removeTrackTags('a.mp3'), false);
});

test('list 按 track_id 排序（顺序稳定，回放时不会看起来像随机）', () => {
	setTrackTags('c.mp3', ['pop'], 'ai');
	setTrackTags('a.mp3', ['pop'], 'ai');
	setTrackTags('b.mp3', ['pop'], 'ai');
	assert.deepEqual(
		listTrackTags().map((t) => t.trackId),
		['a.mp3', 'b.mp3', 'c.mp3'],
	);
});

test('读回来的形状不含内部字段名（track_id → trackId）', () => {
	setTrackTags('a.mp3', ['pop'], 'ai');
	assert.deepEqual(Object.keys(listTrackTags()[0]).sort(), [
		'source',
		'tags',
		'trackId',
		'updatedAt',
	]);
});

test('updatedAt 可注入（单测钉时间，与 preference-log 一致）', () => {
	const at = new Date('2026-09-17T00:00:00.000Z');
	setTrackTags('a.mp3', ['pop'], 'ai', at);
	assert.equal(getTrackTags('a.mp3')?.updatedAt, at.toISOString());
});

test('空表返回空数组', () => {
	assert.deepEqual(listTrackTags(), []);
});
