/**
 * `agent/prompt.ts` 单测 —— 只覆盖 `buildSystemPrompt` 里那段**动态**的部分。
 *
 * 为什么值得测：静态正文（铁律、工作方式）改一次就是一次人工 review，写测试只会
 * 变成"改 prompt 就得改测试"的噪音。真正会悄悄错的是把快照翻译成人话的那几行：
 *  - 状态三元判断写反 → 已暂停被说成"播放中"，模型据此答错，但代码不报错；
 *  - 前端没上报时留给模型的是一句 `undefined` / `null` ——模板字面量漏字段的典型
 *    产物，模型会照着这个字面量理解处境。
 * 所以这里只钉"翻译"这一层。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlayerSnapshot } from '../contract/player';
import { buildSystemPrompt } from './prompt';

const snap = (over: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
	state: 'playing',
	currentTrack: { id: 'track-1', title: '荷塘月色', artist: '凤凰传奇', album: '最炫民族风' },
	positionSec: 42,
	queueSize: 6,
	queueIndex: 2,
	queue: [{ id: 'track-1', title: '荷塘月色', artist: '凤凰传奇' }],
	...over,
});

test('buildSystemPrompt：播放中', () => {
	const p = buildSystemPrompt(snap());
	assert.match(p, /状态：播放中/);
	assert.match(p, /当前曲目：荷塘月色 — 凤凰传奇/);
	assert.match(p, /队列：共 6 首，当前第 3 首/); // queueIndex 是 0 基，展示要 +1
});

test('buildSystemPrompt：已暂停 / 未播放', () => {
	assert.match(buildSystemPrompt(snap({ state: 'paused' })), /状态：已暂停/);
	assert.match(buildSystemPrompt(snap({ state: 'stopped' })), /状态：未播放/);
});

test('buildSystemPrompt：无曲目、空队列', () => {
	const p = buildSystemPrompt(snap({ currentTrack: null, queueSize: 0, queueIndex: 0 }));
	assert.match(p, /当前曲目：（无）/);
	assert.match(p, /队列：（空）/);
});

test('buildSystemPrompt：前端未上报时的兜底', () => {
	const p = buildSystemPrompt(null);
	assert.match(p, /前端未上报/);
	assert.doesNotMatch(p, /undefined|null/); // 模板漏字段的字面量不能漏给模型
});

test('buildSystemPrompt：快照齐备时不得出现 undefined / null 字面量', () => {
	for (const s of [snap(), snap({ state: 'paused' }), snap({ currentTrack: null })]) {
		assert.doesNotMatch(buildSystemPrompt(s), /undefined|null/);
	}
});
