/**
 * `components/memory-view.ts` 单测 —— 钉住**两条「看着正常其实骗人」的规则**。
 *
 * 这个文件的全部理由是第一条用例：「读不到」与「还没记住什么」必须分开。
 * 合成一个的话，界面照常渲染、控制台一条报错都没有，用户却会得出
 * 「我从来没设过偏好」这个关于自己的错误结论 —— 而真实情况是 agent 正拿着
 * 一份他看不见的东西影响每一轮对话（见那个文件的文件头）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetFailed, memoryView } from './memory-view';

const one = [{ key: 'disliked_genre', value: '摇滚' }];

test('读不到 ≠ 没记住：两条一起喂时，error 必须赢', () => {
	// 这条是这个文件的全部理由。读失败时列表是空的，所以「先看有没有条目」
	// 那种写法会把它判成 empty —— 两件事都渲染成一块没有内容的区域，
	// 而它们要用户做的事相反（一件是"接受"，一件是"再试一次"）。
	assert.deepEqual(memoryView({ loaded: true, error: '读不到记忆', items: [] }), {
		kind: 'error',
	});
	// 即使服务端回了空列表、同时又报了错，仍然以 error 为准：
	// 「这一份空列表可信吗」的答案是「不可信」，那就不能拿它下结论。
	assert.deepEqual(memoryView({ loaded: true, error: '读不到记忆', items: one }), {
		kind: 'error',
	});
});

test('还没读完是 loading，不是 empty（空态文案会骗人）', () => {
	assert.deepEqual(memoryView({ loaded: false, error: null, items: [] }), { kind: 'loading' });
});

test('确实一条都没有，才是 empty', () => {
	assert.deepEqual(memoryView({ loaded: true, error: null, items: [] }), { kind: 'empty' });
});

test('有条目 → list，且原样带出（顺序不在这里重排）', () => {
	// 顺序由服务端定（`updated_at DESC`）。展示层再排一次 = 两处会漂移的实现，
	// 而漂移的表现是「卡片上的顺序和模型看到的不一样」。
	const view = memoryView({ loaded: true, error: null, items: one });
	assert.deepEqual(view, { kind: 'list', items: one });
	assert.equal(view.kind === 'list' && view.items[0], one[0], '应当是同一个对象，不做拷贝');
});

test('四态互不重叠', () => {
	const kinds = [
		memoryView({ loaded: false, error: null, items: [] }).kind,
		memoryView({ loaded: true, error: 'x', items: [] }).kind,
		memoryView({ loaded: true, error: null, items: [] }).kind,
		memoryView({ loaded: true, error: null, items: one }).kind,
	];
	assert.deepEqual([...new Set(kinds)].sort(), ['empty', 'error', 'list', 'loading']);
});

test('删除失败的两种原因要分开说（下一步不同）', () => {
	const net = forgetFailed(null);
	const http = forgetFailed(500);
	assert.notEqual(net, http, '「没发出去」与「被服务端拒绝」不能长得一样');
	assert.match(net, /网络/);
	assert.match(http, /500/);
	// 两句都必须说清「这条还在」—— 否则用户会以为已经删掉了。
	assert.match(net, /还在/);
	assert.match(http, /还在/);
});
