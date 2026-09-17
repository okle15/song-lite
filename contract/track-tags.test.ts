/**
 * `contract/track-tags.ts` 单测 —— 标签归一化。
 *
 * 为什么值得测：它坏掉时**不报错**，只是库里悄悄多出几条「写法不同、意思相同」
 * 的标签。检索 `pop` 永远查不到那首被存成 `pop folk` 的歌，而且没有任何线索
 * 指向原因 —— 与 `preference.ts` 那条「什么算同一条偏好」是同一类静默故障。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTags, normalizeTag, normalizeTags, parseTags } from './track-tags';

test('整串会被拆开（模型常返回 ["pop folk"] 这种一整串）', () => {
	assert.deepEqual(normalizeTags('pop folk'), ['folk', 'pop']);
	assert.deepEqual(normalizeTags(['pop folk']), ['folk', 'pop']);
});

test('中英文分隔符都认：逗号 / 顿号 / 分号 / 竖线 / 斜杠 / 空白', () => {
	assert.deepEqual(normalizeTags('pop,folk'), ['folk', 'pop']);
	assert.deepEqual(normalizeTags('pop，folk'), ['folk', 'pop']);
	assert.deepEqual(normalizeTags('pop、folk'), ['folk', 'pop']);
	assert.deepEqual(normalizeTags('pop;folk'), ['folk', 'pop']);
	assert.deepEqual(normalizeTags('pop|folk'), ['folk', 'pop']);
	assert.deepEqual(normalizeTags('pop/folk'), ['folk', 'pop']);
});

test('大小写与包裹引号被归一化（Pop / "POP" / 「pop」是同一个标签）', () => {
	assert.deepEqual(normalizeTags(['Pop', '"POP"', '「pop」']), ['pop']);
});

test('空输入与纯分隔符不产出标签', () => {
	for (const input of ['', '   ', ',,,', null, undefined]) {
		assert.deepEqual(normalizeTags(input), [], `输入 ${JSON.stringify(input)} 应为空`);
	}
	assert.equal(normalizeTag('  '), null);
});

test('同一组标签顺序不同 → 存库形态相同（否则会被当成两次不同的写入）', () => {
	assert.equal(formatTags(['pop', 'folk']), formatTags(['folk', 'pop']));
});

test('format → parse 往返稳定', () => {
	const tags = ['folk', 'pop'];
	const stored = formatTags(tags);
	assert.deepEqual(parseTags(stored), tags);
	assert.deepEqual(parseTags(formatTags(parseTags(stored))), tags);
});

test('parse 对脏数据宽容（库里被手工改过 / 有空项时不炸）', () => {
	assert.deepEqual(parseTags(''), []);
	assert.deepEqual(parseTags(null), []);
	assert.deepEqual(parseTags('pop,,FOLK, '), ['folk', 'pop']);
});

test('中文标签也能归一化并排序（曲库以中文歌为主，这条不能只对英文成立）', () => {
	assert.deepEqual(normalizeTags('民谣、流行'), ['民谣', '流行']);
	assert.equal(normalizeTag('  民谣  '), '民谣');
});
