/**
 * `agent/run.ts` 的 `firstTextChunk` 单测 —— ⑨ 的首字延迟取数点。
 *
 * 为什么单独测这个看起来"只有三行"的函数：
 *
 *   - 它的两条否定分支**都会静默算错**：把工具调用的 chunk 当"第一个字"，
 *     延迟会算成一个**偏小**的值，而它看起来只是"这次挺快"；
 *     空 delta 同理 —— 它不是用户看得见的字。
 *   - 「只回调一次」是它对调用方的契约。破了之后调用方那一侧的表现是
 *     `first_token_ms` 变成**最后一个** chunk 的时刻，而列里仍然是一个正常数字。
 *   - 它是⑨ 里唯一挂进 `② 冻结区` 的东西（`onChunk` 钩子）。把判据钉在单测里，
 *     等于把"这一处只观察、不参与循环"这句话变成可执行的东西 —— 它不需要起模型、
 *     不需要 SDK 对象，喂一个 `{ chunk: {...} }` 就能跑遍。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstTextChunk } from './run';

/** 只关心 `chunk.type` 与 `chunk.text`，所以事件按**结构**造，不引 SDK 的联合类型。 */
const ev = (type: string, text?: string) => ({ chunk: { type, text } });

test('没传回调时不注册钩子（返回 undefined，SDK 那边等于"不管"）', () => {
	assert.equal(firstTextChunk(undefined), undefined);
});

test('第一个带文字的 text-delta 触发一次', () => {
	let fired = 0;
	const on = firstTextChunk(() => fired++)!;
	on(ev('text-delta', '好'));
	assert.equal(fired, 1);
});

test('连续多个 text-delta 仍然只触发一次（否则记的是"最后一个字"的时刻）', () => {
	let fired = 0;
	const on = firstTextChunk(() => fired++)!;
	on(ev('text-delta', '好'));
	on(ev('text-delta', '的'));
	on(ev('text-delta', '，马上放'));
	assert.equal(fired, 1);
});

test('工具调用之类的 chunk 不算"第一个字"（算了延迟会偏小，看着只是"这次挺快"）', () => {
	let fired = 0;
	const on = firstTextChunk(() => fired++)!;
	on(ev('tool-call'));
	on(ev('tool-result'));
	on(ev('reasoning', '让我想想'));
	on(ev('finish'));
	assert.equal(fired, 0, '一个都还没吐出来');

	// 真吐字时才算 —— 延迟量的是"用户等了多久才看到反应"，不是"模型什么时候开始动"
	on(ev('text-delta', '好'));
	assert.equal(fired, 1);
});

test('空的 text-delta 不算（空串不是用户看得见的字），且不消耗掉"只回调一次"', () => {
	let fired = 0;
	const on = firstTextChunk(() => fired++)!;
	on(ev('text-delta', '')); // 有的实现会先发一个空 delta 起头
	assert.equal(fired, 0);

	on(ev('text-delta', '好'));
	assert.equal(fired, 1, '空 delta 不该把这次机会用掉');
});

test('全程没吐字 → 一次都不回调（调用方据此记 null，而不是 0）', () => {
	let fired = 0;
	const on = firstTextChunk(() => fired++)!;
	on(ev('text-delta', ''));
	on(ev('text-delta'));
	on(ev('tool-call'));
	on(ev('finish'));
	assert.equal(fired, 0);
});
