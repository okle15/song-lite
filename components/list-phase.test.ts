/**
 * `components/list-phase.ts` 单测 —— 钉住**四态的顺序**与**「不重排」**。
 *
 * 两条都不报错：写反了界面照常渲染、控制台一条报错都没有，只是用户会照着
 * 一幅看着正常其实骗人的画面做决定（见那个文件的文件头）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listPhase } from './list-phase';

/** 任意类型的清单 —— 这两条规则与条目是什么无关，正是它被提上来的理由。 */
type Row = { id: number };
const two: Row[] = [{ id: 2 }, { id: 1 }];

test('读不到 ≠ 一条都没有：两条一起喂时，error 必须赢', () => {
	// 这条是这个文件的全部理由。读失败时清单是空的，所以「先看有没有条目」那种
	// 写法会把它判成 empty —— 用户于是把「我看不到」读成「这里什么都没有」，
	// 而那是一个关于**他自己**的错话。
	assert.deepEqual(listPhase<string>({ loaded: true, error: '读不到', items: [] }), {
		kind: 'error',
	});
	// 即使服务端回了空清单、同时又报了错，仍以 error 为准：
	// 「这一份空清单可信吗」的答案是「不可信」，那就不能拿它下结论。
	assert.deepEqual(listPhase<string>({ loaded: true, error: '读不到', items: ['x'] }), {
		kind: 'error',
	});
	// 还没读完也一样：空白区域不能先冒充「空清单」再变成有内容（那是一次可见的跳变）
	assert.deepEqual(listPhase<string>({ loaded: false, error: null, items: [] }), {
		kind: 'loading',
	});
});

test('list 原样带出 items：不重排、不拷贝', () => {
	// 顺序由服务端定。展示层再排一次 = 两处会漂移的实现，
	// 而漂移的表现是「卡片上的顺序和模型看到的不是一回事」。
	const view = listPhase({ loaded: true, error: null, items: two });
	assert.deepEqual(view, { kind: 'list', items: two });
	assert.equal(view.kind === 'list' && view.items, two, '应当是同一个数组，不做拷贝也不排序');
});

test('确实一条都没有，才是 empty', () => {
	assert.deepEqual(listPhase<string>({ loaded: true, error: null, items: [] }), { kind: 'empty' });
});

test('四态互不重叠', () => {
	const kinds = [
		listPhase<string>({ loaded: false, error: null, items: [] }).kind,
		listPhase<string>({ loaded: true, error: 'x', items: [] }).kind,
		listPhase<string>({ loaded: true, error: null, items: [] }).kind,
		listPhase<string>({ loaded: true, error: null, items: ['x'] }).kind,
	];
	assert.deepEqual([...new Set(kinds)].sort(), ['empty', 'error', 'list', 'loading']);
});
