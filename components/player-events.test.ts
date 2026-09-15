/**
 * `components/player-events.ts` 单测 —— 只覆盖纯函数 `fmtTime`。
 *
 * 为什么值得测：`fmtTime` 是「秒 → m:ss」的**唯一**格式化入口，被播放条、正在播放、
 * 歌词面板、全屏歌词、曲库列表 5 处消费。它有两类历史坑：
 *  1. 单位混用——曾有调用方传**毫秒**进来，
 *     这类错误不会报错，只会把 3.5 秒显示成「0:03」（看似正常）或把 200 秒显示成「3:20」的 60 倍偏差。
 *  2. 脏数据——APlayer 切歌瞬间会推 `NaN` / 负值，直接 `Math.floor` 会渲染成 `NaN:NaN`。
 * 因此这里把边界与脏数据一起钉住。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAYER_EVENTS, fmtTime } from './player-events';

test('fmtTime：常规秒值', () => {
	assert.equal(fmtTime(0), '0:00');
	assert.equal(fmtTime(5), '0:05');
	assert.equal(fmtTime(59), '0:59');
	assert.equal(fmtTime(60), '1:00');
	assert.equal(fmtTime(61), '1:01');
	assert.equal(fmtTime(185), '3:05');
	assert.equal(fmtTime(3599), '59:59');
	assert.equal(fmtTime(3600), '60:00');
});

test('fmtTime：小数秒向下取整（取整数秒，不进位）', () => {
	assert.equal(fmtTime(59.9), '0:59');
	assert.equal(fmtTime(60.99), '1:00');
	assert.equal(fmtTime(0.999), '0:00');
});

test('fmtTime：脏数据兜底为 0:00（不渲染 NaN / 负数）', () => {
	assert.equal(fmtTime(Number.NaN), '0:00');
	assert.equal(fmtTime(Number.POSITIVE_INFINITY), '0:00');
	assert.equal(fmtTime(Number.NEGATIVE_INFINITY), '0:00');
	assert.equal(fmtTime(-1), '0:00');
	assert.equal(fmtTime(-0.5), '0:00');
});

test('fmtTime：秒数总是补零到两位', () => {
	for (let s = 0; s < 120; s++) {
		assert.match(fmtTime(s), /^\d+:[0-5]\d$/, `fmtTime(${s}) 应为 m:ss`);
	}
});

test('PLAYER_EVENTS：事件名唯一且都是 player-/lyrics- 前缀（防复制粘贴重复）', () => {
	const values = Object.values(PLAYER_EVENTS);
	assert.equal(new Set(values).size, values.length, 'PLAYER_EVENTS 存在重复事件名');
	for (const v of values) {
		assert.match(v, /^(player|lyrics)-[a-z-]+$/, `事件名 ${v} 不符合命名约定`);
	}
});
