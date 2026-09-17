/**
 * `server/player/state.ts` 单测 —— 队列来源与「谁可以覆盖队列」。
 *
 * 为什么值得测：这几条规则的失败方式全是**静默**的。
 *   - `ensureQueue` 若不放行自定义队列，用户刚让 agent 组好的「安静的歌」会被下一次
 *     点播换回整库顺序 —— 不报错，只是那一批歌没了；
 *   - `playTrack` 若对「不在队列里的歌」返回失败，arg=「放荷塘月色」这件完全合理的
 *     事会变成一句「播放失败」；
 *   - `setPlayback` 若把没给的字段也写一遍，只改随机会顺手把循环方式重置。
 *
 * 状态是模块级的（还挂在 `globalThis` 上给 dev 热重载用），所以每个用例前手工复位 ——
 * `getPlayerState()` 返回的就是那个活对象本身。
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Song } from '../library';
import {
	DEFAULT_VOLUME,
	ensureQueue,
	getPlayerState,
	getSnapshot,
	playTrack,
	setPlayback,
	setQueueAndPlay,
	setVolume,
} from './state';

const song = (n: number): Song => ({
	id: `曲${n}.mp3`,
	title: `曲${n}`,
	artist: '歌手',
	album: '专辑',
	durationSec: 180,
	filePath: `/曲${n}.mp3`,
	hasLyrics: true,
	hasCover: true,
});

const [A, B, C] = [song(1), song(2), song(3)];

beforeEach(() => {
	const s = getPlayerState();
	s.state = 'stopped';
	s.currentTrack = null;
	s.positionSec = 0;
	s.queue = [];
	s.currentIndex = -1;
	s.queueSource = 'library';
	s.queueLabel = null;
	s.volume = DEFAULT_VOLUME;
	s.mode = 'seq';
	s.shuffle = false;
});

test('ensureQueue：整库队列照旧随曲库同步（默认行为没变）', () => {
	ensureQueue([A, B]);
	assert.deepEqual(getSnapshot().queue.map((s) => s.id), ['曲1.mp3', '曲2.mp3']);
	// 同一批再同步一次不该有任何变化（靠 id 集合判等，避免每次点播都重建队列）
	ensureQueue([A, B]);
	assert.deepEqual(getSnapshot().queue.map((s) => s.id), ['曲1.mp3', '曲2.mp3']);
	ensureQueue([A, B, C]);
	assert.deepEqual(getSnapshot().queue.map((s) => s.id), ['曲1.mp3', '曲2.mp3', '曲3.mp3']);
});

test('setQueueAndPlay：换一批并开播，来源标成 custom 且带上名字', () => {
	const s = setQueueAndPlay([B, C], { label: '安静的歌' });
	assert.ok(s);
	const snap = getSnapshot();
	assert.equal(snap.state, 'playing');
	assert.equal(snap.currentTrack?.id, '曲2.mp3');
	assert.equal(snap.queueIndex, 0);
	assert.equal(snap.queueSource, 'custom');
	assert.equal(snap.queueLabel, '安静的歌');
});

test('ensureQueue：**自定义队列不被覆盖**（这是「按条件组队列」的前提）', () => {
	setQueueAndPlay([B], { label: '就这一首' });
	ensureQueue([A, B, C]); // 点播路径会调它
	const snap = getSnapshot();
	assert.deepEqual(snap.queue.map((s) => s.id), ['曲2.mp3'], '自定义队列被整库覆盖了');
	assert.equal(snap.queueLabel, '就这一首');
});

test('setQueueAndPlay：恢复整库时来源回到 library、名字清空', () => {
	setQueueAndPlay([B], { label: '安静的歌' });
	setQueueAndPlay([A, B, C], { label: null, source: 'library' });
	const snap = getSnapshot();
	assert.equal(snap.queueSource, 'library');
	assert.equal(snap.queueLabel, null);
	// 恢复整库之后就又归 ensureQueue 管了（**要重新取一次快照**：getSnapshot 给的是
	// 一份拷贝，攥着上面那个对象断言的是改动前的样子）。
	ensureQueue([A]);
	assert.deepEqual(getSnapshot().queue.map((s) => s.id), ['曲1.mp3']);
});

test('setQueueAndPlay：空数组返回 undefined —— 空队列不是一种可播放状态', () => {
	assert.equal(setQueueAndPlay([]), undefined);
	assert.equal(getSnapshot().state, 'stopped');
});

test('playTrack：队列里有的歌切过去，队列不动', () => {
	setQueueAndPlay([A, B, C]);
	playTrack(C);
	const snap = getSnapshot();
	assert.equal(snap.currentTrack?.id, '曲3.mp3');
	assert.equal(snap.queueIndex, 2);
	assert.equal(snap.queueSize, 3);
});

test('playTrack：队列里没有的歌**追加到队尾**并播放，而不是失败', () => {
	setQueueAndPlay([A, B], { label: '安静的歌' });
	playTrack(C);
	const snap = getSnapshot();
	assert.deepEqual(snap.queue.map((s) => s.id), ['曲1.mp3', '曲2.mp3', '曲3.mp3']);
	assert.equal(snap.currentTrack?.id, '曲3.mp3');
	assert.equal(snap.queueIndex, 2);
	// 追加不改变这一批的来源：那批歌还在，只是多了一首
	assert.equal(snap.queueSource, 'custom');
	assert.equal(snap.queueLabel, '安静的歌');
});

test('setVolume / setPlayback：只改给了的字段', () => {
	setVolume(0.3);
	setPlayback({ mode: 'one' });
	let snap = getSnapshot();
	assert.equal(snap.volume, 0.3);
	assert.equal(snap.mode, 'one');
	assert.equal(snap.shuffle, false, '只改循环方式不该动随机开关');

	setPlayback({ shuffle: true });
	snap = getSnapshot();
	assert.equal(snap.mode, 'one', '只改随机不该动循环方式');
	assert.equal(snap.shuffle, true);
});
