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
	jumpToIndex,
	playTrack,
	removeFromQueue,
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
	videoPath: null,
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

/* ── 去掉一首（队列卡上的 ×，2026-09-28）──────────────────────────────── */

test('removeFromQueue：去掉的不是正在播的那首 —— 播放不受影响，但**当前位置必须平移**', () => {
	setQueueAndPlay([A, B, C]);
	jumpToIndex(2); // 正在播的是 C（第 3 项）
	getPlayerState().positionSec = 42; // 已经播了 42 秒

	const r = removeFromQueue(A.id); // 去掉排在最前面的那首

	assert.ok(r);
	const snap = getSnapshot();
	assert.deepEqual(snap.queue.map((s) => s.id), ['曲2.mp3', '曲3.mp3']);
	assert.equal(snap.currentTrack?.id, '曲3.mp3', '去掉别的项不该换掉正在播的那首');
	assert.equal(snap.positionSec, 42, '去掉别的项不该让进度回到 0');
	assert.equal(snap.state, 'playing');
	assert.equal(r.started, null, '没有「开始播一首新歌」，不该往 plays 记一行');
	// ⚠️ 这一条是这条函数里最容易写漏、且**漏了不报错**的地方：剩下的 C 现在排第 2 位，
	// 位置索引若不平移就指到 B 上去 —— 界面上的均衡器跑到别人的行上、
	// next_track 从错的位置往下走。
	assert.equal(snap.queueIndex, 1);
});

test('removeFromQueue：去掉正在播的那首 → 跳到原位置上的下一首，并回报 started', () => {
	setQueueAndPlay([A, B, C]); // 当前是 A（index 0）
	getPlayerState().positionSec = 30;

	const r = removeFromQueue(A.id);

	assert.ok(r);
	const snap = getSnapshot();
	assert.deepEqual(snap.queue.map((s) => s.id), ['曲2.mp3', '曲3.mp3']);
	assert.equal(snap.currentTrack?.id, '曲2.mp3', '应该是原位置的下一首（B），不是队首重来');
	assert.equal(snap.queueIndex, 0);
	assert.equal(snap.positionSec, 0, '换了一首歌，进度要归零');
	assert.equal(snap.state, 'playing');
	assert.equal(r.started?.id, '曲2.mp3', '真的开始播了 B —— 调用方要据此记一行播放历史');
});

test('removeFromQueue：去掉正在播、且它是队尾那首 → 停（与「播完了」同形）', () => {
	setQueueAndPlay([A, B, C]);
	jumpToIndex(2); // C 在播，且它是最后一首

	const r = removeFromQueue(C.id);

	assert.ok(r);
	const snap = getSnapshot();
	assert.deepEqual(snap.queue.map((s) => s.id), ['曲1.mp3', '曲2.mp3']);
	assert.equal(snap.state, 'stopped');
	assert.equal(snap.currentTrack, null);
	assert.equal(snap.queueIndex, -1);
	assert.equal(snap.positionSec, 0);
	assert.equal(r.started, null);
});

test('removeFromQueue：去掉到空 —— 空队列是合法终态', () => {
	setQueueAndPlay([A]);

	const r = removeFromQueue(A.id);

	assert.ok(r);
	const snap = getSnapshot();
	assert.equal(snap.queueSize, 0);
	assert.equal(snap.state, 'stopped');
	assert.equal(snap.queueIndex, -1);
	assert.equal(r.started, null);
});

test('removeFromQueue：不在队列里 → undefined，且**一个字段都不动**', () => {
	setQueueAndPlay([A, B], { label: '安静的歌' });
	const before = getSnapshot();

	const r = removeFromQueue('曲99.mp3');

	assert.equal(r, undefined);
	assert.deepEqual(getSnapshot(), before, '没找到就不该有任何副作用');
});

test('removeFromQueue：从整库队列去掉一首 → 身份变 custom，**下一次点播不会把它找回来**', () => {
	ensureQueue([A, B, C]); // 整库队列（默认形态，queueSource === 'library'）
	jumpToIndex(1); // B 在播

	const r = removeFromQueue(B.id);

	assert.ok(r);
	assert.equal(getSnapshot().queueSource, 'custom', '它已经不是「整个曲库」了，身份必须跟着改');

	// 点播路径每次都会调它（`app/api/player/play/route.ts`）。若身份还留在 'library'，
	// 这里会把刚去掉的 B 原样找回来 —— 而界面已经告诉用户「去掉了」。两次都不报错，
	// 用户只会觉得「删了又回来了」。这条断言就是那个「不撒谎」的证据。
	ensureQueue([A, B, C]);
	assert.deepEqual(getSnapshot().queue.map((s) => s.id), ['曲1.mp3', '曲3.mp3']);
});

test('removeFromQueue：自定义队列去掉一首 —— 身份与名字都不变（它本来就是这一批）', () => {
	setQueueAndPlay([A, B, C], { label: '安静的歌' });

	const r = removeFromQueue(B.id);

	assert.ok(r);
	const snap = getSnapshot();
	assert.equal(snap.queueSource, 'custom');
	assert.equal(snap.queueLabel, '安静的歌', '去掉一首不等于换一批，名字不该丢');
	assert.deepEqual(snap.queue.map((s) => s.id), ['曲1.mp3', '曲3.mp3']);
});
