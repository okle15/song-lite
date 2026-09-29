/**
 * 伴生视频的配对阵单 —— 这支文件守的是「`X.mp4` 配不配得上 `X.mp3`」。
 *
 * 为什么值得一支专门的测试：配对错**永远不报错**。
 *   - 配错了 → 用户看到的是**另一首歌的画面**，而界面一切正常；
 *   - 配不上 → 只是没有画面，看起来像"这首歌本来就没视频"；
 *   - 同一个基名有两个视频时取哪个若不确定 → **今天放 mp4、明天放 mkv**，
 *     那种抖动会被读成「数据坏了」。
 * 三条都只能靠断言拦，人工点测看不出来。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVideoExt, pairVideos, pickVideoPath, VIDEO_CONTENT_TYPES, VIDEO_EXTENSIONS } from './video';

// ── 配对 ──────────────────────────────────────────────────────────

test('pairVideos：同目录同名才配（`X.mp4` 配 `X.mp3`）', () => {
	const pairs = pairVideos([
		'专辑/荷塘月色.mp3',
		'专辑/荷塘月色.mp4',
		'专辑/自由飞翔.mp3',
	]);
	assert.equal(pairs.get('专辑/荷塘月色.mp3'), '专辑/荷塘月色.mp4');
	// 没有同名视频的那首**不进 map**（而不是配到一个空串）——调用方据此得到 null。
	assert.equal(pairs.has('专辑/自由飞翔.mp3'), false);
});

test('pairVideos：目录也是配对键的一半 —— 别把 `B/开场.mp4` 配给 `A/开场.mp3`', () => {
	// 实测过的那种串法：只按 basename 配，两个目录下的同名文件就会串。
	const pairs = pairVideos(['A/开场.mp3', 'B/开场.mp4']);
	assert.equal(pairs.has('A/开场.mp3'), false, '跨目录配上了 —— 用户会看到另一首歌的画面');
	assert.equal(pairs.size, 0);
	// 同目录下就配得上（证明上一条不是因为"配对根本不工作"而绿）
	assert.equal(pairVideos(['B/开场.mp3', 'B/开场.mp4']).get('B/开场.mp3'), 'B/开场.mp4');
});

test('pairVideos：没有同名音频的视频不会自己变成曲目', () => {
	const pairs = pairVideos(['孤零零.mp4', '有歌的.mp4', '有歌的.mp3']);
	assert.deepEqual([...pairs.keys()], ['有歌的.mp3']);
	assert.equal(pairs.has('孤零零.mp4'), false, '视频被当成音频配出去了 —— 它不该出现在任何一侧');
});

test('pairVideos：大小写不敏感（本机文件系统就不区分大小写）', () => {
	const pairs = pairVideos(['Song.MP3', 'song.mp4']);
	assert.equal(pairs.get('Song.MP3'), 'song.mp4');
});

test('pairVideos：音频与视频的扩展名都按大小写不敏感认', () => {
	assert.equal(isVideoExt('.MP4'), true);
	assert.equal(isVideoExt('.mkv'), true);
	assert.equal(isVideoExt('.mp3'), false);
	// 音频那一侧：`.MP3` 不是视频，所以它仍是"要被配对的对象"而不是候选视频
	const pairs = pairVideos(['a.MP3', 'a.MP4']);
	assert.equal(pairs.get('a.MP3'), 'a.MP4');
});

// ── 同名多个取哪个：必须是确定的全序 ──────────────────────────────

test('pickVideoPath：按优先级表取，与候选给出的顺序无关（否则界面会抖）', () => {
	// `.mp4` 在优先级表里排在 `.mkv` 前面 —— 无论两个候选以什么顺序传进来。
	assert.equal(pickVideoPath(['x.mkv', 'x.mp4']), 'x.mp4');
	assert.equal(pickVideoPath(['x.mp4', 'x.mkv']), 'x.mp4');
	// 同一个候选集合、两种排列，必须得到同一个答案。这就是"不抖"的定义。
	const all = ['x.mov', 'x.mkv', 'x.webm', 'x.m4v', 'x.mp4'];
	assert.equal(pickVideoPath(all), pickVideoPath([...all].reverse()));
	// 表外的扩展名排到最后，但仍然确定（不是随机）
	assert.equal(pickVideoPath(['x.avi', 'x.mp4']), 'x.mp4');
	assert.equal(pickVideoPath(['x.avi', 'x.wmv']), 'x.avi', '表外扩展名之间按字典序，仍是全序');
});

test('pickVideoPath：没有候选时返回 null（不是空串）', () => {
	// `null` 是"没有伴生视频"的**唯一**表示；空串会让 `videoPath` 变成 `''`，
	// 而 `''` 在 `song.videoPath !== null` 那一侧会被判成"有视频" → 前端发一次注定 404 的请求。
	assert.equal(pickVideoPath([]), null);
	assert.equal(pickVideoPath(['x.mp4']), 'x.mp4');
});

// ── 两份清单必须同一个集合（这是本文件最承重的一条）──────────────
//
// `VIDEO_EXTENSIONS` 决定"哪些文件会被配进来"，`VIDEO_CONTENT_TYPES` 决定
// "配进来的文件用什么 MIME 送出去"。少一行 MIME **不会报错** —— 那个格式安静地
// 回落成 `application/octet-stream`，然后浏览器的 `<video>` 静默不播。

function missingMime(exts: readonly string[], table: Record<string, string>): string[] {
	return exts.filter((e) => !(e in table));
}

function extraMime(exts: readonly string[], table: Record<string, string>): string[] {
	return Object.keys(table).filter((e) => !exts.includes(e));
}

test('扩展名清单与 MIME 表必须是同一个集合（双向）', () => {
	// 自证：谓词认得出已知违规样本 —— 认不出来时它和"没有违规"长得一模一样。
	assert.deepEqual(
		missingMime(['.mp4', '.avi'], { '.mp4': 'video/mp4' }),
		['.avi'],
		'谓词坏了：少了 MIME 的扩展名认不出来',
	);
	assert.deepEqual(
		extraMime(['.mp4'], { '.mp4': 'video/mp4', '.avi': 'video/x-msvideo' }),
		['.avi'],
		'谓词坏了：表里多出来的条目认不出来',
	);

	// 非空自证：空清单会让上面那两条同时变绿，而"什么都没配"也是一种坏。
	assert.ok(
		VIDEO_EXTENSIONS.length >= 3,
		`扩展名清单只剩 ${VIDEO_EXTENSIONS.length} 项 —— 配对规则被削掉了？`,
	);

	assert.deepEqual(
		missingMime(VIDEO_EXTENSIONS, VIDEO_CONTENT_TYPES),
		[],
		'有扩展名没有对应 MIME：那个格式会安静地回落成 application/octet-stream，`<video>` 静默不播',
	);
	assert.deepEqual(
		extraMime(VIDEO_EXTENSIONS, VIDEO_CONTENT_TYPES),
		[],
		'MIME 表里有扩展名清单外的条目 —— 它永远不会被用到（加 MIME 时忘了加扩展名，或删扩展名时没清表）',
	);
});
