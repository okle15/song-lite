/**
 * `components/storage-keys.ts` 单测。
 *
 * 为什么值得测：键名一旦漏掉命名空间，本项目就会和 song（同源、同端口）
 * 读写同一份数据，而且**不会报错**——症状只是「布局莫名其妙被重置」
 * 「概览卡消失」。这里把「所有键都必须带命名空间」钉死。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LS_KEYS, LS_NAMESPACE, lsKey } from './storage-keys';

test('lsKey：给键名加命名空间', () => {
	assert.equal(LS_NAMESPACE, ':lite');
	assert.equal(lsKey('music-volume'), 'music-volume:lite');
});

test('LS_KEYS：每个键都带命名空间（漏了就会与 song 互相覆盖）', () => {
	for (const [name, key] of Object.entries(LS_KEYS)) {
		assert.ok(key.includes(LS_NAMESPACE), `${name} = ${key} 缺少命名空间`);
	}
});

test('LS_KEYS：键值互不重复', () => {
	const values = Object.values(LS_KEYS);
	assert.equal(new Set(values).size, values.length);
});
