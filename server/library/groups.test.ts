/**
 * `server/library/groups.ts` 单测 —— 曲库分组（按歌手 / 专辑 / 风格）。
 *
 * 钉的是三条**坏掉时不报错**的规则：
 *
 *  1. **多标签的歌要进多个组**。写成「一首只归一个桶」时，各组首数相加恰好
 *     等于总曲目数 —— 看着更整齐，于是没人会发现丢了一半归属。
 *  2. **没标签的歌要进「未打标」那一组**（key 是空串），不能静默丢掉：
 *     它是 `npm run tag:library` 的输入，看不见 = 无从下手。
 *  3. **排序是首数降序 → 名字**。首数相同时顺序不稳，界面就会每刷一次变一次，
 *     而那种抖动会被读成"数据变了"。
 *
 * 另外一条是本批的硬约束：**分桶在服务端**（`contract/library-groups.ts` 文件头），
 * 所以这里测的 `bucketSongs` 就是那个"唯一的分桶实现"—— 前端不许另写一份。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketSongs, membersOf, UNTAGGED_LABEL } from './groups';
import type { Song } from './';

function song(id: string, artist: string, album: string): Song {
	return {
		id,
		title: id,
		artist,
		album,
		durationSec: 100,
		filePath: `/${id}`,
		hasLyrics: false,
		hasCover: false,
		videoPath: null,
	};
}

const SONGS = [
	song('a.mp3', '凤凰传奇', '月亮之上'),
	song('b.mp3', '凤凰传奇', '全是爱'),
	song('c.mp3', '周杰伦', '七里香'),
];

/** `tag` 维度：a 有两个标签，b 有一个，c 一个都没标。 */
const TAGS = new Map<string, string[]>([
	['a.mp3', ['中国风', '民谣']],
	['b.mp3', ['中国风']],
]);

test('按歌手分桶：同歌手归并，顺序是首数降序 → 名字', () => {
	const groups = bucketSongs(SONGS, TAGS, 'artist');
	assert.deepEqual(
		groups.map((g) => [g.label, g.count]),
		[
			['凤凰传奇', 2],
			['周杰伦', 1],
		],
	);
});

test('按专辑分桶：每张专辑一组', () => {
	const groups = bucketSongs(SONGS, TAGS, 'album');
	assert.equal(groups.length, 3);
	// 首数全是 1，所以回落到「按名字」（localeCompare）。
	// ⚠️ 这个顺序是**排序规则的结果**，不是"看着顺眼"排的 —— 换 locale 会变，
	// 但**必须稳定**（同样的库每次给出同样顺序），否则界面每刷一次变一次。
	assert.deepEqual(
		groups.map((g) => g.label),
		['七里香', '全是爱', '月亮之上'],
		'首数相同时按名字排，顺序必须稳定',
	);
});

test('多标签的歌进多个组（各组之和会大于总曲目数，这是对的）', () => {
	const groups = bucketSongs(SONGS, TAGS, 'tag');
	const byLabel = new Map(groups.map((g) => [g.label, g.count]));
	assert.equal(byLabel.get('中国风'), 2, 'a 与 b 都有「中国风」');
	assert.equal(byLabel.get('民谣'), 1);
	// 中国风 2 + 民谣 1 + 未打标 1 = 4，而曲目只有 3 首。
	// 这个"对不上"是**对**的：多标签被数了多次。前端不许拿各组相加去校验 total。
	assert.equal(
		groups.reduce((sum, g) => sum + g.count, 0),
		4,
		'各组之和大于曲目数不是 bug，把它"修正"成相等才是撒谎',
	);
});

test('没标签的歌进「未打标」组（key 是空串，不静默丢掉）', () => {
	const groups = bucketSongs(SONGS, TAGS, 'tag');
	const untagged = groups.find((g) => g.key === '');
	assert.ok(untagged, '必须有一组给没打标的歌');
	assert.equal(untagged?.label, UNTAGGED_LABEL, '显示名要说人话');
	assert.equal(untagged?.count, 1, 'c.mp3 一个标签都没有');
});

test('空串 key 的成员是那几首没标签的歌（打标脚本的输入）', () => {
	const members = membersOf(SONGS, TAGS, 'tag', '');
	assert.deepEqual(
		members.map((s) => s.id),
		['c.mp3'],
	);
});

test('组内成员按 id 精确取，不做子串匹配（歌手名不会串到别的歌）', () => {
	const members = membersOf(SONGS, TAGS, 'artist', '凤凰传奇');
	assert.deepEqual(
		members.map((s) => s.id),
		['a.mp3', 'b.mp3'],
	);
	// 用一个**不存在**的组名取：空数组，而不是全部、也不是报错。
	assert.deepEqual(membersOf(SONGS, TAGS, 'artist', '不存在的歌手'), []);
});

test('空曲库 → 没有分组（不是"一组叫未打标的"）', () => {
	assert.deepEqual(bucketSongs([], new Map(), 'tag'), []);
	assert.deepEqual(bucketSongs([], new Map(), 'artist'), []);
});
