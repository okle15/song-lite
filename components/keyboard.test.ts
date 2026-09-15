/**
 * `components/keyboard.ts` 单测 —— 只覆盖展示清单 `SHORTCUTS` 的结构不变量。
 *
 * 为什么值得测：这张表被 ShortcutsPanel 用 `key={s.desc}` 渲染，
 * 而它过去与 GlobalHotkeys 的注释各存一份、已经漂移过（注释漏了 F 与 `?`）。
 * 现在收敛成单一来源后，剩下的风险是「有人顺手删掉一行」——那不会报错，
 * 只会让用户看不到某个已实现的快捷键（功能等于不存在）。
 * 这里用**期望键集**把展示契约钉住：删行会红，加行也要显式更新期望。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHORTCUTS, hasModifier, isTypingTarget } from './keyboard';

test('SHORTCUTS：desc 唯一（ShortcutsPanel 用它当 React key）', () => {
	const descs = SHORTCUTS.map((s) => s.desc);
	assert.equal(new Set(descs).size, descs.length, 'desc 重复会导致 React key 冲突');
});

test('SHORTCUTS：每行至少一个非空键帽文本', () => {
	for (const s of SHORTCUTS) {
		assert.ok(s.keys.length > 0, `「${s.desc}」没有键帽`);
		for (const k of s.keys) {
			assert.equal(typeof k, 'string');
			assert.ok(k.trim().length > 0, `「${s.desc}」存在空键帽`);
		}
	}
});

test('SHORTCUTS：覆盖全部已实现的快捷键（漏行 = 用户以为没这个功能）', () => {
	const shown = new Set(SHORTCUTS.flatMap((s) => s.keys));
	const expected = ['空格', '←', '→', '↑', '↓', 'M', 'N', 'P', 'L', 'F', 'K', 'Esc'];
	const missing = expected.filter((k) => !shown.has(k));
	assert.deepEqual(missing, [], `展示清单缺少键帽：${missing.join(' / ')}`);
});

test('isTypingTarget：可输入元素返回 true，其余 false', () => {
	// node 环境没有 DOM：`isTypingTarget` 内部用 `instanceof HTMLElement`，
	// 因此先补一个最小 HTMLElement 桩，再让假元素的原型指向它。
	const g = globalThis as unknown as { HTMLElement?: unknown };
	const StubProto = class HTMLElementStub {};
	if (!('HTMLElement' in g)) g.HTMLElement = StubProto;

	const el = (tagName: string, isContentEditable = false): EventTarget => {
		const o = { tagName, isContentEditable };
		Object.setPrototypeOf(o, StubProto.prototype);
		return o as unknown as EventTarget;
	};

	assert.equal(isTypingTarget(el('INPUT')), true);
	assert.equal(isTypingTarget(el('TEXTAREA')), true);
	assert.equal(isTypingTarget(el('SELECT')), true);
	assert.equal(isTypingTarget(el('DIV', true)), true);
	assert.equal(isTypingTarget(el('DIV')), false);
	assert.equal(isTypingTarget(null), false);
});

test('hasModifier：识别 Meta / Ctrl / Alt', () => {
	const ev = (o: Partial<KeyboardEvent>) => o as KeyboardEvent;
	assert.equal(hasModifier(ev({ metaKey: true })), true);
	assert.equal(hasModifier(ev({ ctrlKey: true })), true);
	assert.equal(hasModifier(ev({ altKey: true })), true);
	assert.equal(hasModifier(ev({})), false);
});
