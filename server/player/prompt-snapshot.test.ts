/**
 * `server/player/prompt-snapshot.ts` 单测 —— ⑦ 的字段各认哪个来源。
 *
 * 为什么值得测：这条规则的失效方式是**静默**的，而且**真浏览器里撞不出来**。
 *   - 服务端权威的字段若仍从 body 取：用户点「下一首」后问「现在在放什么」，
 *     模型答上一首。可浏览器副本是**刚收到的**，两者恰好一致——只有 SSE 断线、
 *     另一个标签页改的、服务端重启、或请求不由浏览器发起（⑩ 触发器 / curl）时
 *     才会露出错位。要验它就得**造一份故意错了的副本**，这正是单测的活。
 *   - 设备侧的四项若改从服务端取：服务端手上只是镜像，答出来的音量是"上一次
 *     上报的值"，用户拖完音量条立刻说话就答错——而工具会回读，于是输出被兜住、
 *     输入基准没人管。
 *
 * `promptSnapshot` 读模块级状态（与 `state.test.ts` 同一份），所以那个用例前要复位；
 * `mergeSnapshot` 是纯的，不需要。
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { PlayerSnapshot } from '../../contract/player';
import { mergeSnapshot, promptSnapshot } from './prompt-snapshot';
import { DEFAULT_VOLUME, getPlayerState, getSnapshot, setQueueAndPlay } from './state';

const snap = (over: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
	state: 'playing',
	currentTrack: { id: 'B.mp3', title: '自由飞翔', artist: '凤凰传奇', album: 'x', hasCover: true },
	positionSec: 12,
	queueSize: 3,
	queueIndex: 1,
	queue: [
		{ id: 'A.mp3', title: '荷塘月色', artist: '凤凰传奇' },
		{ id: 'B.mp3', title: '自由飞翔', artist: '凤凰传奇' },
		{ id: 'C.mp3', title: '奢香夫人', artist: '凤凰传奇' },
	],
	queueSource: 'library',
	queueLabel: null,
	volume: 0.8,
	mode: 'seq',
	shuffle: false,
	...over,
});

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

test('服务端权威的字段以服务端为准：浏览器那份说反了也不动摇', () => {
	// 浏览器说在放《荷塘月色》，服务端说在放《自由飞翔》——**服务端赢**。
	// 这一条就是「绕一圈」的修复：那一圈只会丢信息，所以权威的一方不该当乘客。
	const device = snap({
		state: 'paused',
		currentTrack: { id: 'A.mp3', title: '荷塘月色', artist: '凤凰传奇', album: 'y', hasCover: true },
		queueIndex: 0,
		queueSize: 1,
		queue: [{ id: 'A.mp3', title: '荷塘月色', artist: '凤凰传奇' }],
		queueSource: 'custom',
		queueLabel: '浏览器以为的一批',
	});
	const merged = mergeSnapshot(snap(), device);
	assert.equal(merged.state, 'playing');
	assert.equal(merged.currentTrack?.id, 'B.mp3');
	assert.equal(merged.queueIndex, 1);
	assert.equal(merged.queueSize, 3);
	assert.equal(merged.queue.length, 3);
	assert.equal(merged.queueSource, 'library');
	assert.equal(merged.queueLabel, null, '队列来源与名字也归服务端：自定义队列是 agent 自己组的');
});

test('服务端重启过（说「没在放」）时，浏览器手里的旧副本改不了这个结论', () => {
	// state 存在模块级变量里（见 state.ts 头注释），进程一重启就没了，而浏览器
	// 还攥着旧快照。此前模型会据此说「正在播放 X」——服务端其实已经停在空白页。
	const merged = mergeSnapshot(snap({ state: 'stopped', currentTrack: null }), snap());
	assert.equal(merged.state, 'stopped');
	assert.equal(merged.currentTrack, null);
});

test('设备侧四项以浏览器为准：服务端那份只是镜像', () => {
	const device = snap({ volume: 0.25, mode: 'one', shuffle: true, positionSec: 77 });
	const merged = mergeSnapshot(snap({ volume: 0.8, mode: 'seq', shuffle: false, positionSec: 0 }), device);
	assert.equal(merged.volume, 0.25);
	assert.equal(merged.mode, 'one');
	assert.equal(merged.shuffle, true);
	assert.equal(merged.positionSec, 77);
});

test('没有浏览器上报时整份取服务端：⑩ 触发器与 curl 走的就是这条路', () => {
	const server = snap();
	for (const device of [undefined, null]) {
		assert.equal(mergeSnapshot(server, device), server, '缺省时应原样返回服务端那份');
	}
});

test('脏输入逐字段退回服务端镜像，不许把 NaN / undefined 送进提示词', () => {
	// 这条路由是公开入口，body 只被 `as` 断言过。宁可给模型一个旧的真值，
	// 也不能给它「音量：NaN%」「播放方式：undefined」——模型会照字面量理解处境。
	const server = snap({ volume: 0.4, mode: 'rpt', shuffle: true, positionSec: 5 });
	const dirty = {
		volume: 'loud',
		mode: 'shuffle',
		shuffle: 'yes',
		positionSec: Number.NaN,
	} as unknown as Partial<PlayerSnapshot>;
	const merged = mergeSnapshot(server, dirty);
	assert.equal(merged.volume, 0.4);
	assert.equal(merged.mode, 'rpt');
	assert.equal(merged.shuffle, true);
	assert.equal(merged.positionSec, 5);
});

test('音量越界夹到 0–1，负数不放过', () => {
	// 服务端 setVolume 会夹紧，但那是**写**路径；这里是读路径上第一次见到这个数，
	// 夹一次的成本是一行，收益是提示词里不会出现「音量：-50%」。
	assert.equal(mergeSnapshot(snap(), snap({ volume: 3 })).volume, 1);
	assert.equal(mergeSnapshot(snap(), snap({ volume: -1 })).volume, 0);
	assert.equal(mergeSnapshot(snap(), snap({ positionSec: -9 })).positionSec, 0);
});

test('promptSnapshot：读的是当下的服务端状态，不是某处缓存', () => {
	// 纯函数的用例全绿也说明不了这一点——「每次都真去取」才是这条修复的意义。
	setQueueAndPlay(
		[
			{
				id: 'B.mp3',
				title: '自由飞翔',
				artist: '凤凰传奇',
				album: 'x',
				durationSec: 200,
				filePath: '/B.mp3',
				hasLyrics: true,
				hasCover: true,
			},
		],
		{ label: '安静的歌' },
	);
	const merged = promptSnapshot(snap({ currentTrack: null, queueSize: 0, queueIndex: -1, queue: [] }));
	assert.equal(merged.currentTrack?.id, 'B.mp3');
	assert.equal(merged.queueSource, 'custom');
	assert.equal(merged.queueLabel, '安静的歌');
	assert.equal(merged.state, 'playing');
	assert.equal(merged.queueSize, getSnapshot().queueSize);
});
