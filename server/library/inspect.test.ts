/**
 * `server/library/inspect.ts` 单测 —— 曲库体检（清单里 `organize` 的落地形态）。
 *
 * 钉的是三条**坏掉时不报错**的规则：
 *
 *  1. **`untaggedIds` 要给 id，不能只给一个数字。** 只说「有 2 首没打标」等于
 *     让人自己去猜是哪两首 —— 与 `list_hidden` 必须带 id 同一条判据。
 *     它是 `npm run tag:library` 的输入，看不见就无从下手。
 *  2. **`hidden` 单列在 `total` 之外。** 混进 total 的话，「库里 6 首、3 首没标签」
 *     会与「我屏蔽了 2 首」互相矛盾，而两句话都对 —— 那是最难查的一类错。
 *  3. **未知歌手 / 专辑单独数。** `Unknown Artist` 是扫描器填不出来的占位值，
 *     它看起来像一个真实的歌手名（还会自己变成一组），只有单独数出来才看得见。
 *
 * ⚠️ 这里测的是**只读体检**。清单里的 `organize` 之所以没做成「把文件挪进子目录」：
 * `Song.id` 是相对路径，改名 / 移动 = 新 id = `plays` 与 `track_tags` 全失联
 * （改「唯一标识」= 数据迁移），而本机无回收站。理由在 `inspect.ts` 文件头。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport } from './inspect';
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
	song('c.mp3', 'Unknown Artist', 'Unknown Album'),
];

const TAGS = new Map<string, string[]>([['a.mp3', ['中国风']]]);

test('没打标的曲目**给 id**，不是只给一个数字', () => {
	const r = buildReport(SONGS, TAGS, 0);
	assert.equal(r.withoutTags, 2);
	assert.deepEqual(
		r.untaggedIds,
		['b.mp3', 'c.mp3'],
		'体检要能直接喂给打标脚本 —— 只报数字等于让人去猜是哪几首',
	);
	assert.equal(r.withTags, 1);
});

test('withTags + withoutTags = total（两个数必须自洽）', () => {
	const r = buildReport(SONGS, TAGS, 0);
	assert.equal(r.withTags + r.withoutTags, r.total);
	assert.equal(r.total, 3);
});

test('被屏蔽的**单列在 total 之外**，不混进曲目数', () => {
	const r = buildReport(SONGS, TAGS, 2);
	assert.equal(r.total, 3, '可见曲库 3 首');
	assert.equal(r.hidden, 2, '另有 2 首被屏蔽 —— 它们不在 total 里');
});

test('未知歌手 / 专辑单独数出来（它们看着像真名字，还会自己变成一组）', () => {
	const r = buildReport(SONGS, TAGS, 0);
	assert.equal(r.unknownArtist, 1);
	assert.equal(r.unknownAlbum, 1);
	assert.equal(r.artistCount, 2, 'Unknown Artist 也算一个"歌手"，所以单独报');
	assert.equal(r.albumCount, 3);
});

test('空曲库：全 0，untaggedIds 是空数组（不是 null）', () => {
	const r = buildReport([], new Map(), 0);
	assert.equal(r.total, 0);
	assert.deepEqual(r.untaggedIds, []);
	assert.equal(r.artistCount, 0);
});
