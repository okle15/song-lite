/**
 * `contract/preference.ts` 单测 —— key 的归一化规则。
 *
 * 为什么这个纯函数值得单独钉住：它定义了「**什么算同一条偏好**」。
 * 归一化漏一种写法，同一条偏好就会变成两条——用户说两遍「不喜欢摇滚」，
 * 提示词里就出现两行，而用户以为自己说的是同一件事、系统却当成两件。
 * 这种错不会报错，只会在用久之后表现为「它怎么记重了」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_INJECTED_PREFERENCES, normalizePreferenceKey } from './preference';

test('大小写与分隔符归一：同一条偏好只该有一个 key', () => {
	// 这五种写法都指同一件事，必须落到同一个 key，否则记出五条。
	for (const raw of [
		'disliked_genre',
		'Disliked_Genre',
		'DISLIKED-GENRE',
		'disliked genre',
		'  disliked   genre  ',
	]) {
		assert.equal(normalizePreferenceKey(raw), 'disliked_genre', `「${raw}」未归一到同一个 key`);
	}
});

test('去掉非法字符，只留字母数字下划线', () => {
	assert.equal(normalizePreferenceKey('preferred_artist!'), 'preferred_artist');
	assert.equal(normalizePreferenceKey('no.music.at.night'), 'nomusicatnight');
	assert.equal(normalizePreferenceKey('a@#$%b'), 'ab');
});

test('连续下划线合并、首尾下划线去掉（否则 `a__b` 与 `a_b` 会变成两条）', () => {
	assert.equal(normalizePreferenceKey('a__b'), 'a_b');
	assert.equal(normalizePreferenceKey('_leading'), 'leading');
	assert.equal(normalizePreferenceKey('trailing_'), 'trailing');
	assert.equal(normalizePreferenceKey('___'), null);
});

test('纯中文 / 空串 / 全非法字符一律返回 null，由调用方要求换一个', () => {
	// 中文 key 不是「非法输入」而是「模型该换一种写法」——返回 null 让工具能据此
	// 回一句可操作的话，而不是静默归一成一个空 key 写进库里。
	for (const raw of ['不喜欢摇滚', '', '   ', '---', '！！！']) {
		assert.equal(normalizePreferenceKey(raw), null, `「${raw}」应判定为不可用`);
	}
});

test('长度上限 40：超长 key 返回 null（防模型把一整句话当 key）', () => {
	assert.equal(normalizePreferenceKey('a'.repeat(40)), 'a'.repeat(40));
	assert.equal(normalizePreferenceKey('a'.repeat(41)), null);
});

test('注入上限是常量而非散落的字面量', () => {
	assert.equal(MAX_INJECTED_PREFERENCES, 30);
});
