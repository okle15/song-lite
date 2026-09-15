/**
 * `server/player/media.ts` 单测 —— Range 三态响应 + Content-Type 查表。
 *
 * 为什么值得测：这段逻辑的失败方式都是**静默**的。416 少一个 `Content-Range`
 * 浏览器不会报错，只是拖到结尾就卡住；206 少一个 `Content-Range` 会让
 * `<audio>` 认为整段都对却又只收到一段，表现为「进度条乱跳」；
 * 200 少一个 `Cache-Control` 会让改文件后前端长时间拿到旧内容。
 * 这些在人工点测里极难复现，但用真实 `Request`/`Response` 几行就能钉死。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { contentTypeFor, mediaResponse } from './media';

let dir: string;
let file: string;
/** 32 字节的确定性内容：第 n 个字节 = n。 */
const CONTENT = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

before(() => {
	dir = mkdtempSync(join(tmpdir(), 'media-test-'));
	file = join(dir, 'sample.mp3');
	writeFileSync(file, CONTENT);
});

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

test('无 Range → 200 整文件，带 Content-Length / Accept-Ranges / Cache-Control', async () => {
	const res = mediaResponse(file, CONTENT.length, 'audio/mpeg', null);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('content-length'), '32');
	assert.equal(res.headers.get('accept-ranges'), 'bytes');
	assert.equal(res.headers.get('cache-control'), 'no-cache');
	const body = Buffer.from(await res.arrayBuffer());
	assert.deepEqual(body, CONTENT);
});

test('Range 区间合法 → 206，字节切片与 Content-Range 都正确', async () => {
	const res = mediaResponse(file, CONTENT.length, 'audio/mpeg', 'bytes=8-15');
	assert.equal(res.status, 206);
	assert.equal(res.headers.get('content-range'), `bytes 8-15/${CONTENT.length}`);
	assert.equal(res.headers.get('content-length'), '8');
	assert.equal(res.headers.get('cache-control'), 'no-cache');
	const body = Buffer.from(await res.arrayBuffer());
	assert.deepEqual(body, CONTENT.subarray(8, 16));
});

test('Range 开区间（bytes=N-）→ 206，末尾默认最后字节', async () => {
	const res = mediaResponse(file, CONTENT.length, 'audio/mpeg', 'bytes=30-');
	assert.equal(res.status, 206);
	assert.equal(res.headers.get('content-range'), `bytes 30-31/${CONTENT.length}`);
	assert.equal(res.headers.get('content-length'), '2');
});

test('Range 起点越界 → 416 + Content-Range: bytes */size，body 为空', async () => {
	const res = mediaResponse(file, CONTENT.length, 'audio/mpeg', 'bytes=999-');
	assert.equal(res.status, 416);
	assert.equal(res.headers.get('content-range'), `bytes */${CONTENT.length}`);
	const body = Buffer.from(await res.arrayBuffer());
	assert.equal(body.length, 0);
});

test('Range 起点大于终点 → 416', async () => {
	const res = mediaResponse(file, CONTENT.length, 'audio/mpeg', 'bytes=20-10');
	assert.equal(res.status, 416);
});

test('Range 头形态不合法 → 忽略并回落 200 整文件', async () => {
	for (const bad of ['bytes=abc', 'items=0-1', 'bytes=', '0-1']) {
		const res = mediaResponse(file, CONTENT.length, 'audio/mpeg', bad);
		assert.equal(res.status, 200, `range=${bad} 应回落 200`);
		const body = Buffer.from(await res.arrayBuffer());
		assert.deepEqual(body, CONTENT, `range=${bad} 应返回整文件`);
	}
});

test('contentTypeFor：按扩展名查表，未命中回落 fallback', () => {
	const table = { '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };
	assert.equal(contentTypeFor('/a/b/song.MP3', table, 'application/octet-stream'), 'audio/mpeg');
	assert.equal(contentTypeFor('movie.mp4', table, 'application/octet-stream'), 'video/mp4');
	assert.equal(contentTypeFor('noext', table, 'application/octet-stream'), 'application/octet-stream');
	assert.equal(contentTypeFor('/a/b/song.wav', table, 'application/octet-stream'), 'application/octet-stream');
});
