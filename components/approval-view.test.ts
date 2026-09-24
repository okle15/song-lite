/**
 * `components/approval-view.ts` 单测 —— 钉住**一个会造出死控件的判据**。
 *
 * 要钉的不是「状态叫什么」，而是那条**位置规则**：`approval-requested` 只有在
 * 最后一条消息上才配拥有按钮。写反了（无条件给按钮）不会报错、单测之外也没人拦得住 ——
 * 症状是「点旧的那个确认框没反应」，而它与「网络慢」长得一模一样
 * （2026-09-24，见那个文件的文件头）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalView } from './approval-view';

test('待确认 + 最后一条：这才是唯一该给按钮的组合', () => {
	assert.equal(approvalView('approval-requested', true), 'buttons');
});

test('待确认 + 不在最后一条：必须降级（给按钮 = 死控件）', () => {
	// 这条是这个文件的全部理由。`addToolApprovalResponse` 只认最后一条消息，
	// 所以这里渲染成按钮的话，用户点下去不会有任何反应、也不会有任何报错。
	assert.equal(approvalView('approval-requested', false), 'stale');
});

test('被拒是终态，与位置无关', () => {
	assert.equal(approvalView('output-denied', true), 'denied');
	assert.equal(approvalView('output-denied', false), 'denied');
});

test('其余状态一律走常规轨迹卡（不受位置影响）', () => {
	// `approval-responded`（答复过、正在续跑）也在这一档：它是**过程**，不是可操作的东西。
	for (const state of [
		'input-streaming',
		'input-available',
		'approval-responded',
		'output-available',
		'output-error',
	] as const) {
		assert.equal(approvalView(state, true), 'other', `${state} 不该被当成待确认`);
		assert.equal(approvalView(state, false), 'other', `${state} 不该被当成待确认`);
	}
});

test('四种样子互不重叠，且只有 buttons 是可操作的', () => {
	const all = [
		approvalView('approval-requested', true),
		approvalView('approval-requested', false),
		approvalView('output-denied', true),
		approvalView('output-available', true),
	];
	assert.deepEqual([...new Set(all)].sort(), ['buttons', 'denied', 'other', 'stale']);
	assert.equal(all.filter((v) => v === 'buttons').length, 1, '只有一个组合能落到可点那一档');
});
