/**
 * `components/tag-editor.ts` 单测 —— 钉住两件「不报错、只是让人以为控件坏了」的事。
 *
 * 1. 把输入框删空是**明确的意图**（清空），不是「没填」。当成没填的话，那一下
 *    会变成零反应 —— 而 `POST` 那条路本来就拒空，两条凑在一起正好把用户的动作
 *    吃掉了。
 * 2. 「改了没改」的判据必须与存储层同源（`normalizeTags`）。自己拆一份词的话，
 *    界面上说「没变化」而库里多长出一条，两边都觉得自己是对的。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planTagSave, tagButtonDisabled, tagButtonLabel } from './tag-editor';

test('输入框清空 = 清空意图（不是"没填"）', () => {
	// 这条是这个文件的理由：POST 明确拒绝空标签，若把这一段判成 noop，
	// 用户点「保存」后界面一动不动 —— 没有报错、也没有任何地方告诉他为什么。
	assert.deepEqual(planTagSave('', ['rock']), { kind: 'clear' });
	assert.deepEqual(planTagSave('   ', ['rock', 'pop']), { kind: 'clear' });
	// 只敲了分隔符也是空
	assert.deepEqual(planTagSave(' ,,,；、', ['rock']), { kind: 'clear' });
	// 本来就一个标签都没有：才是真的无事可做
	assert.deepEqual(planTagSave('', []), { kind: 'noop', reason: 'nothing-to-clear' });
});

test('没变化 → noop（顺序/大小写/分隔符不同都不算改动）', () => {
	assert.deepEqual(planTagSave('rock,pop', ['pop', 'rock']), { kind: 'noop', reason: 'same' });
	assert.deepEqual(planTagSave('ROCK，Pop', ['pop', 'rock']), { kind: 'noop', reason: 'same' });
	// `pop folk` 整串（模型常这么返回）与 `pop`+`folk` 是同一条 —— 这条钉的是
	// **不在这里自己拆词**：拆错了会以为改了，实际写下去的还是原来那组。
	assert.deepEqual(planTagSave('pop folk', ['folk', 'pop']), { kind: 'noop', reason: 'same' });
});

test('真改了 → save，且写下去的是归一化后的形态', () => {
	assert.deepEqual(planTagSave('民谣, 摇滚', ['pop']), { kind: 'save', tags: ['摇滚', '民谣'] });
	// 删掉一个也算改（用 save 整体重设，不是"只提交新增的"）
	assert.deepEqual(planTagSave('pop', ['pop', 'rock']), { kind: 'save', tags: ['pop'] });
	// 重复与空白被吃掉
	assert.deepEqual(planTagSave('Pop, pop ,,rock', []), { kind: 'save', tags: ['pop', 'rock'] });
});

test('按钮文案跟着即将发生的事变，无事可做时禁用', () => {
	assert.equal(tagButtonLabel({ kind: 'save', tags: ['pop'] }), '保存');
	assert.equal(tagButtonLabel({ kind: 'clear' }), '清空标签');
	assert.notEqual(tagButtonLabel({ kind: 'clear' }), tagButtonLabel({ kind: 'save', tags: [] }));
	assert.equal(tagButtonDisabled({ kind: 'noop', reason: 'same' }), true);
	assert.equal(tagButtonDisabled({ kind: 'noop', reason: 'nothing-to-clear' }), true);
	assert.equal(tagButtonDisabled({ kind: 'save', tags: ['pop'] }), false);
	assert.equal(tagButtonDisabled({ kind: 'clear' }), false);
});
