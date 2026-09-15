/**
 * tagger 标签清洗单测。
 *
 * 只测 `cleanTags` 这一个纯函数——打标链路唯一能兜住脏数据的地方，
 * 而且三种脏数据（整串、词表外、超量）全都有真实样本，不是凭空想的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_GENRES, ALLOWED_MOODS, cleanTags } from './tagger';

test('拦住词表外的标签（实测 majestic/passionate/nostalgic 越界）', () => {
	const raw = ['upbeat', 'energetic', 'majestic', 'passionate', 'nostalgic'];
	assert.deepEqual(cleanTags(raw, ALLOWED_MOODS), ['upbeat', 'energetic']);
});

test('拆分整串标签：["pop folk"] → ["pop","folk"]', () => {
	assert.deepEqual(cleanTags(['pop folk'], ALLOWED_GENRES), ['pop', 'folk']);
});

test('中文/全角分隔符也能拆开', () => {
	assert.deepEqual(cleanTags(['pop，folk'], ALLOWED_GENRES), ['pop', 'folk']);
});

test('截断到 2 个，且保留靠前的', () => {
	assert.deepEqual(cleanTags(['pop', 'folk', 'rock', 'jazz'], ALLOWED_GENRES), ['pop', 'folk']);
});

test('去重：重复标签只留一个', () => {
	assert.deepEqual(cleanTags(['pop', 'pop', 'folk'], ALLOWED_GENRES), ['pop', 'folk']);
});

test('非数组 / 非字符串输入返回空数组，不抛异常', () => {
	assert.deepEqual(cleanTags(null, ALLOWED_GENRES), []);
	assert.deepEqual(cleanTags('pop', ALLOWED_GENRES), []);
	assert.deepEqual(cleanTags([123, null], ALLOWED_GENRES), []);
});

test('大小写不敏感（normalizeTag 已小写化）', () => {
	assert.deepEqual(cleanTags(['POP', 'Folk'], ALLOWED_GENRES), ['pop', 'folk']);
});

test('词表与词典值域对齐：lexicon 映射出的每个标签都在白名单内', async () => {
	const { GENRE_LEXICON, MOOD_LEXICON } = await import('./lexicon');
	const moodTargets = [...new Set(Object.values(MOOD_LEXICON).flat())];
	const genreTargets = [...new Set(Object.values(GENRE_LEXICON).flat())];
	for (const t of moodTargets) {
		assert.ok(ALLOWED_MOODS.includes(t as never), `mood "${t}" 不在白名单内，中文搜索会失效`);
	}
	for (const t of genreTargets) {
		assert.ok(ALLOWED_GENRES.includes(t as never), `genre "${t}" 不在白名单内，中文搜索会失效`);
	}
});
