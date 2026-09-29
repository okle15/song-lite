/**
 * `server/library/visible.ts` 单测 —— 屏蔽的**过滤谓词只有一处**。
 *
 * 为什么值得测（这个模块的失效方式很不寻常）：
 *   - 它**不会因为漏过滤而报错**。曲库有六七个出口，只要在某一个出口忘了过这一道，
 *     被屏蔽的歌就从那条路回来了 —— 而队列本来就长成「一批歌」，多一首**看不出来**，
 *     界面照常工作，日志一行没有。用户只会觉得「我不是屏蔽了吗」。
 *   - 反过来，它也不会因为**多过滤**而报错：若有人顺手把 `findSongById` 也过滤了，
 *     正在播的那首歌的音频流会 404 —— 那种错至少看得见，而上面那种看不见。
 *
 * 所以这里钉的是形状：**拆出来的两半必须合起来等于原来那一批**，
 * 以及「✅ 有解封出口」这类结构性事实（后者在 `architecture.test.ts`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Song } from './';
import { mergePreservingHidden, splitHidden } from './visible';

const song = (id: string): Song => ({
	id,
	title: id,
	artist: 'a',
	album: 'b',
	durationSec: 1,
	filePath: `/${id}`,
	hasLyrics: false,
	hasCover: false,
	videoPath: null,
});

const A = song('A.mp3');
const B = song('B.mp3');
const C = song('C.mp3');

test('没有屏蔽项时：全部可见、hidden 为空', () => {
	const r = splitHidden([A, B, C], new Set());
	assert.deepEqual(r.visible.map((s) => s.id), ['A.mp3', 'B.mp3', 'C.mp3']);
	assert.deepEqual(r.hidden, []);
});

test('屏蔽命中 id：歌进 hidden 那一半，可见侧少一首', () => {
	const r = splitHidden([A, B, C], new Set(['B.mp3']));
	assert.deepEqual(r.visible.map((s) => s.id), ['A.mp3', 'C.mp3']);
	assert.deepEqual(r.hidden.map((s) => s.id), ['B.mp3']);
});

test('两半合起来 = 原来那一批，且顺序不变（漏一首 / 多一首都抓得住）', () => {
	const all = [A, B, C];
	const r = splitHidden(all, new Set(['A.mp3', 'C.mp3']));
	assert.deepEqual([...r.visible, ...r.hidden].map((s) => s.id).sort(), ['A.mp3', 'B.mp3', 'C.mp3']);
	assert.equal(r.visible.length + r.hidden.length, all.length);
});

test('空输入：两半都是空（不是 undefined）', () => {
	const r = splitHidden([], new Set(['A.mp3']));
	assert.deepEqual(r.visible, []);
	assert.deepEqual(r.hidden, []);
});

test('屏蔽集合里有多余的 id（歌已经不在曲库）不影响可见性', () => {
	const r = splitHidden([A], new Set(['A.mp3', 'gone.mp3']));
	assert.deepEqual(r.visible, []);
	assert.deepEqual(r.hidden.map((s) => s.id), ['A.mp3']);
});

test('mergePreservingHidden = 整批替换的唯一合并入口（红线②）：结果与 splitHidden().visible 同形', () => {
	const next = [A, B, C];
	const hidden = new Set(['B.mp3']);
	assert.deepEqual(mergePreservingHidden(next, hidden), splitHidden(next, hidden).visible);
	assert.deepEqual(mergePreservingHidden(next, hidden).map((s) => s.id), ['A.mp3', 'C.mp3']);
});
