/**
 * server/radio/memory 里标签规范化的单元测试。
 *
 * 为什么测这个：`normalizeTag` 是「这首歌到底是什么风格」的入口之一，
 * 被搜索匹配、电台编排、点播、Agent 环境信息共用。模型会把多个标签塞进
 * 一个字符串（实测 `"pop folk"` / `"happy upbeat"`），不拆的话它既不等于
 * `pop` 也不等于 `folk` —— 不报错，只是这首歌从此搜不到，典型静默故障。
 *
 * 只测纯函数：`fusedTags` 依赖 radio.db 单例，留给端到端。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTag } from './memory';

test('单标签原样返回并小写', () => {
	assert.deepEqual(normalizeTag('Pop'), ['pop']);
});

test('空格分隔的整串要拆开（模型实测会输出 "pop folk"）', () => {
	assert.deepEqual(normalizeTag('pop folk'), ['pop', 'folk']);
	assert.deepEqual(normalizeTag('happy upbeat'), ['happy', 'upbeat']);
});

test('中英文分隔符都能拆', () => {
	assert.deepEqual(normalizeTag('pop,folk'), ['pop', 'folk']);
	assert.deepEqual(normalizeTag('pop、folk'), ['pop', 'folk']);
	assert.deepEqual(normalizeTag('pop;folk'), ['pop', 'folk']);
	assert.deepEqual(normalizeTag('pop/folk'), ['pop', 'folk']);
});

test('多余空白与空片段要清掉', () => {
	assert.deepEqual(normalizeTag('  pop   folk  '), ['pop', 'folk']);
	assert.deepEqual(normalizeTag(''), []);
	assert.deepEqual(normalizeTag('   '), []);
});

test('大小写与重复由调用方 dedupe，这里保持原序不去重', () => {
	// 不去重是有意的：fusedTags 用 Set 去重，这里保持单一职责
	assert.deepEqual(normalizeTag('pop Pop'), ['pop', 'pop']);
});
