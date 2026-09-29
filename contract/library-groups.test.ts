/**
 * `contract/library-groups.ts` 单测 —— 分组维度的**运行时校验**。
 *
 * 为什么这条值得测：`by` 从 URL 里来，**不信类型断言**（与 `contract/tool.ts`
 * 的 `isToolFailureKind` 同族）。它错的时候不报错 —— 路由会拿一个字符串去查
 * 一个不存在的字段，于是"按歌手分组"返回一堆空组，而界面上写着「按歌手」。
 *
 * 顺带钉住 `GROUP_BY_LABEL` 覆盖全部维度：加维度时忘了一处，界面上那个 chip
 * 就是空白的（不报错，只是没字）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GROUP_BY, GROUP_BY_LABEL, isGroupBy } from './library-groups';

test('三个维度都认', () => {
	assert.equal(isGroupBy('artist'), true);
	assert.equal(isGroupBy('album'), true);
	assert.equal(isGroupBy('tag'), true);
});

test('不是维度的一律不认（不信类型断言）', () => {
	for (const bad of ['', 'Artist', 'ARTIST', 'genre', 'artist ', '0', 'null', 'undefined']) {
		assert.equal(isGroupBy(bad), false, `${JSON.stringify(bad)} 不该被当成维度`);
	}
	assert.equal(isGroupBy(undefined), false);
	assert.equal(isGroupBy(null), false);
	assert.equal(isGroupBy(0), false);
	assert.equal(isGroupBy(['artist']), false);
});

test('每个维度都有说人话的名字（加维度时漏一处 = 界面上一个空白 chip）', () => {
	for (const by of GROUP_BY) {
		assert.ok(GROUP_BY_LABEL[by]?.length > 0, `${by} 缺显示名`);
	}
});
