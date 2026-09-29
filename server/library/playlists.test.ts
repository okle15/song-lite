/**
 * `server/library/playlists.ts` 单测 —— 歌单的读写与「只动那一项」。
 *
 * 最值得钉住的是**写侧的形状**，因为它坏掉时**不报错**：
 *   - 追加若不幂等 → 用户点两次收藏就出现两首一样的，清单"变长"看起来像正常行为；
 *   - 删若按下标 → 排序 / 过滤一变就删掉另一首歌，而界面上只是"少了一首"，
 *     没人会去核对少的是不是那一首；
 *   - 删整份若不清曲目 → 留下孤儿行，它们永远占着计数、却不属于任何歌单。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { closeDb, getDb } from '../db';
import {
	addPlaylistTracks,
	createPlaylist,
	deletePlaylist,
	getPlaylist,
	getPlaylistDetail,
	listPlaylists,
	removePlaylistTrack,
} from './playlists';

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), 'playlists-test-'));
	process.env.APP_DB_PATH = join(dir, 'app.db');
	closeDb();
});

after(() => {
	closeDb();
	delete process.env.APP_DB_PATH;
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	getDb().exec('DELETE FROM playlist_items; DELETE FROM playlists;');
});

test('新建：空的 / 带一批（= 导入）两种都能建，计数对得上', () => {
	const empty = createPlaylist('空歌单');
	assert.equal(empty.count, 0);

	const imported = createPlaylist('跑步', ['a.mp3', 'b.mp3']);
	assert.equal(imported.count, 2, '导入的曲目数要立刻体现在 count 上');
	assert.equal(getPlaylist(imported.id)?.count, 2);
});

test('id 是不透明生成串，名字可以重复（名字不是标识）', () => {
	const a = createPlaylist('跑步');
	const b = createPlaylist('跑步');
	assert.notEqual(a.id, b.id, '同名两份必须是两个不同的 id');
	assert.notEqual(a.id, '跑步', 'id 不能就是名字 —— 改名会变成一次数据迁移');
	assert.equal(listPlaylists().length, 2);
});

test('追加是幂等的：同一首加两次只算一次（skipped 计数，不是失败）', () => {
	const p = createPlaylist('睡前', ['a.mp3']);
	const first = addPlaylistTracks(p.id, ['b.mp3']);
	assert.deepEqual(first, { added: 1, skipped: 0 });

	const again = addPlaylistTracks(p.id, ['b.mp3']);
	assert.deepEqual(again, { added: 0, skipped: 1 }, '重复添加是常态，不该报成失败');
	assert.equal(getPlaylist(p.id)?.count, 2, '也不该长出第二行');
});

test('同一批里重复出现的 id 只算一次（计数不会虚高）', () => {
	const p = createPlaylist('x');
	assert.deepEqual(addPlaylistTracks(p.id, ['a.mp3', 'a.mp3', 'b.mp3']), { added: 2, skipped: 1 });
	assert.equal(getPlaylist(p.id)?.count, 2);
});

test('顺序 = 加入顺序，后来加的排在后面', async () => {
	const p = createPlaylist('x', ['a.mp3']);
	addPlaylistTracks(p.id, ['b.mp3']);
	const detail = await getPlaylistDetail(p.id);
	assert.deepEqual(
		detail?.tracks.map((t) => t.trackId),
		['a.mp3', 'b.mp3'],
	);
});

test('删一首：只动那一项，其余的顺序也不动', async () => {
	const p = createPlaylist('x', ['a.mp3', 'b.mp3', 'c.mp3']);
	// ⚠️ 传的是 **id**，不是"第几首"。按位置删的那一刻就是删错歌的那一刻。
	assert.equal(removePlaylistTrack(p.id, 'b.mp3'), true);
	const detail = await getPlaylistDetail(p.id);
	assert.deepEqual(
		detail?.tracks.map((t) => t.trackId),
		['a.mp3', 'c.mp3'],
	);
});

test('删一首本来就不在里面的：返回 false，**不是失败**', () => {
	const p = createPlaylist('x', ['a.mp3']);
	assert.equal(removePlaylistTrack(p.id, 'gone.mp3'), false);
	assert.equal(getPlaylist(p.id)?.count, 1);
});

test('删整份歌单：曲目一起清掉（不留孤儿行）', async () => {
	const p = createPlaylist('x', ['a.mp3', 'b.mp3']);
	assert.equal(deletePlaylist(p.id), true);
	assert.equal(getPlaylist(p.id), null);
	assert.equal(listPlaylists().length, 0);

	// 孤儿行看不见、但永远占着计数：直接查表确认它们也没了。
	const left = getDb()
		.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?')
		.get(p.id) as unknown as { n: number };
	assert.equal(left.n, 0, '歌单删了，它的曲目必须是 0 行');
});

test('删一份不存在的歌单返回 false', () => {
	assert.equal(deletePlaylist('nope'), false);
});

test('详情带曲名；库里没有的那首标 missing —— **照旧列出**，不静默丢掉', async () => {
	const p = createPlaylist('x', ['a.mp3', '已删掉的歌.mp3']);
	const detail = await getPlaylistDetail(p.id);
	assert.equal(detail?.tracks.length, 2, '失效的那首也要在清单里');
	const gone = detail?.tracks.find((t) => t.trackId === '已删掉的歌.mp3');
	assert.equal(gone?.missing, true);
	assert.equal(gone?.title, '已删掉的歌.mp3', '查不到曲名时回落到 id，不留空白');
});

test('往不存在的歌单里加会抛（写失败要抛，不能静默吞掉）', () => {
	assert.throws(() => addPlaylistTracks('nope', ['a.mp3']), /歌单不存在/);
});

test('计数来自 SQL，不是"我这次取了几条"', async () => {
	const p = createPlaylist('x', ['a.mp3', 'b.mp3', 'c.mp3']);
	// 详情页取的是全部曲目，但这与列表接口里那个 count 必须是同一个数。
	assert.equal(getPlaylist(p.id)?.count, 3);
	assert.equal((await getPlaylistDetail(p.id))?.tracks.length, 3);
	assert.equal(listPlaylists()[0].count, 3);
});
