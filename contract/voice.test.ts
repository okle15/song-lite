/**
 * `contract/voice.ts` 的不变式：**候选表与后缀表必须对得上**。
 *
 * 这两张表是「同一个集合的两种说法」：候选表说「能录哪几种容器」，
 * 后缀表说「每种容器对应的文件名后缀」。前端拿候选表挑格式、再拿后缀表起文件名 ——
 * 少一行不会报错，只是**上传的文件名会少个后缀**（网关按名字判格式时就炸在更远的地方）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VOICE_FILE_EXT, VOICE_MAX_BYTES, VOICE_MIME_CANDIDATES } from './voice';

test('候选表里每个 mime 都要有后缀映射', () => {
	for (const mime of VOICE_MIME_CANDIDATES) {
		assert.ok(VOICE_FILE_EXT[mime], `候选 ${mime} 没有后缀映射`);
	}
});

test('后缀表不许有多余的键（多出来的键说明候选表删过东西没删干净）', () => {
	const candidates = new Set<string>(VOICE_MIME_CANDIDATES);
	for (const mime of Object.keys(VOICE_FILE_EXT)) {
		assert.ok(candidates.has(mime), `后缀表里的 ${mime} 已不在候选表里`);
	}
});

test('候选表按优先级排列，opus/webm 在最前（覆盖 Chrome/Edge/Firefox）', () => {
	assert.equal(VOICE_MIME_CANDIDATES[0], 'audio/webm;codecs=opus');
	assert.ok(VOICE_MIME_CANDIDATES.includes('audio/mp4'), 'Safari 只出 mp4，必须在表里');
});

test('上限是个正数且不至于小到手机录 10 秒就超', () => {
	assert.ok(VOICE_MAX_BYTES >= 1024 * 1024, '小于 1MB 会把正常的短录音也挡掉');
});
