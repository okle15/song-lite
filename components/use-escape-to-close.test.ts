/**
 * attachEscape 的单测。
 *
 * 覆盖的是「9 处手抄 Escape effect」时真正会犯、且编译期查不出来的错：
 *   1. 弹层没打开时也挂了监听（Esc 会误关不该关的东西）
 *   2. 忘了解绑 / add 与 remove 的 capture 参数不对称（监听悄悄泄漏，不报错）
 *   3. stopPropagation 该开没开（内层菜单的 Esc 会顺带关掉外层抽屉）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachEscape, type EscapeKeyLike } from './use-escape-to-close';

/** 最小事件目标桩，记录 add/remove 的每一次调用。 */
function fakeTarget() {
	const added: { type: string; listener: (e: EscapeKeyLike) => void; capture?: boolean }[] = [];
	const removed: { type: string; listener: (e: EscapeKeyLike) => void; capture?: boolean }[] = [];
	return {
		added,
		removed,
		addEventListener(type: string, listener: (e: EscapeKeyLike) => void, capture?: boolean) {
			added.push({ type, listener, capture });
		},
		removeEventListener(type: string, listener: (e: EscapeKeyLike) => void, capture?: boolean) {
			removed.push({ type, listener, capture });
		},
		/** 模拟一次按键，走最后挂上的那个监听 */
		press(key: string) {
			const last = added[added.length - 1];
			if (!last) throw new Error('没有任何监听被挂上');
			let stopped = false;
			last.listener({ key, stopPropagation: () => { stopped = true; } });
			return stopped;
		},
	};
}

test('挂载后监听 keydown，detach 时解绑同一个 listener', () => {
	const t = fakeTarget();
	let closed = 0;
	const detach = attachEscape(t, () => closed++);

	assert.equal(t.added.length, 1);
	assert.equal(t.added[0]!.type, 'keydown');
	assert.equal(t.removed.length, 0, '未 detach 前不应解绑');

	detach();
	assert.equal(t.removed.length, 1);
	assert.equal(t.removed[0]!.listener, t.added[0]!.listener, '解绑的必须是同一个函数引用');
});

test('只有 Escape 命中，其它键一律忽略', () => {
	const t = fakeTarget();
	let closed = 0;
	attachEscape(t, () => closed++);

	for (const key of ['Enter', 'a', 'ArrowUp', 'escape' /* 大小写敏感 */, '']) {
		t.press(key);
	}
	assert.equal(closed, 0, '只有精确等于 "Escape" 才应命中');
	t.press('Escape');
	assert.equal(closed, 1);
});

test('capture 参数原样传给 add 与 remove（不对称会静默泄漏）', () => {
	for (const capture of [true, false]) {
		const t = fakeTarget();
		const detach = attachEscape(t, () => {}, { capture });
		assert.equal(t.added[0]!.capture, capture);
		detach();
		assert.equal(
			t.removed[0]!.capture,
			t.added[0]!.capture,
			`capture=${capture} 时 add/remove 必须一致，否则该监听永远摘不掉`,
		);
	}
});

test('stopPropagation：默认不阻断，开启后在触发 onClose 前阻断', () => {
	const t1 = fakeTarget();
	attachEscape(t1, () => {});
	assert.equal(t1.press('Escape'), false, '默认不应阻止传播——否则 Esc 只关最内层');

	const t2 = fakeTarget();
	let closed = 0;
	attachEscape(t2, () => closed++, { stopPropagation: true });
	assert.equal(t2.press('Escape'), true, '捕获阶段模式必须阻止外层抽屉一起被关掉');
	assert.equal(closed, 1);
});

test('stopPropagation 只在 Escape 上生效，其它键不阻断', () => {
	const t = fakeTarget();
	attachEscape(t, () => {}, { stopPropagation: true });
	assert.equal(t.press('a'), false, '非 Escape 不应 stopPropagation，否则会吃掉正常按键');
});
