/**
 * contract/chat-chunks 的单元测试（node:test + tsx，无需额外测试框架）。
 *
 * 为什么给这个模块写测试：它是「用户/评估看到的回答到底是什么」的唯一真相，
 * 被前端气泡、线上采集、离线评估三处共用。分块边界的语义很微妙
 * （reasoning 要丢、过渡语要丢、但最终答案不能丢），错了不会报错，
 * 只会让回答变脏、让 accuracy 慢慢失真——典型的静默故障。
 *
 * 用例按 **AI SDK 原生 UIMessageChunk** 构造（翻译层已删除），
 * 见 contract/chat-chunks.ts 文件头的词汇表。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	assembleReply,
	emptyReply,
	isVisibleTextDelta,
	reduceReply,
	visibleReply,
} from './chat-chunks';

const textStart = (id: string) => ({ type: 'text-start', id });
const textDelta = (id: string, delta: string) => ({ type: 'text-delta', id, delta });
const textEnd = (id: string) => ({ type: 'text-end', id });
const reasoning = (delta: string) => ({ type: 'reasoning-delta', id: 'r', delta });
const toolInput = (name: string) => ({
	type: 'tool-input-available',
	toolCallId: 'c1',
	toolName: name,
	input: {},
});

test('delta 判定：reasoning 不可见，text 可见', () => {
	assert.equal(isVisibleTextDelta(reasoning('a')), false);
	assert.equal(isVisibleTextDelta(textDelta('t', 'a')), true);
	assert.equal(isVisibleTextDelta({ type: 'text-delta' }), false, 'delta 非字符串不算');
	assert.equal(isVisibleTextDelta({ type: 'tool-output-available' }), false);
});

test('思考过程不进回复', () => {
	const out = assembleReply([
		{ type: 'start' },
		{ type: 'start-step' },
		reasoning('让我想想'),
		reasoning('用户在问推荐'),
		textStart('t1'),
		textDelta('t1', '推荐《荷塘月色》'),
		textEnd('t1'),
		{ type: 'finish' },
	]);
	assert.equal(out, '推荐《荷塘月色》');
});

test('只保留最后一个文本块：工具调用前的过渡语要丢掉', () => {
	// 真实观测到的形态：模型先说「我去搜一下」，调完工具再给最终答复。
	const out = assembleReply([
		{ type: 'start' },
		{ type: 'start-step' },
		textStart('t1'),
		textDelta('t1', '我去搜一下'),
		textEnd('t1'),
		toolInput('search_songs'),
		{ type: 'finish-step' },
		{ type: 'start-step' },
		textStart('t2'),
		textDelta('t2', '搜到 6 首，已放进歌单'),
		textEnd('t2'),
		{ type: 'finish' },
	]);
	assert.equal(out, '搜到 6 首，已放进歌单');
});

test('text-start / text-end 是显式块边界，工具 part 也能切块', () => {
	// 主判据是 text-start/text-end；工具 part 是兜底（模型不发 text-end 就切走时
	// 不能让两段文本粘在一起）。
	const st = [textDelta('t1', '前半句'), toolInput('play_track'), textDelta('t2', '后半句')].reduce(
		reduceReply,
		emptyReply(),
	);
	assert.equal(visibleReply(st), '后半句');
	assert.deepEqual(st.blocks, ['前半句']);
});

test('同一个文本 part 内的多次 delta 会拼接，不会被切成多块', () => {
	const out = assembleReply([
		textStart('t1'),
		textDelta('t1', '正在'),
		textDelta('t1', '播放'),
		textDelta('t1', '《荷塘月色》'),
		textEnd('t1'),
	]);
	assert.equal(out, '正在播放《荷塘月色》');
});

test('当前块还没吐字时回退到上一块，避免中途闪空', () => {
	let st = emptyReply();
	st = reduceReply(st, textDelta('t1', '第一块'));
	assert.equal(visibleReply(st), '第一块');
	// 新块开始、尚未产生可见文本（可能正在 reasoning 或调工具）
	st = reduceReply(st, textStart('t2'));
	assert.equal(visibleReply(st), '第一块', '不应闪成空白');
	// 新块吐字后才切换
	st = reduceReply(st, textDelta('t2', '第二块'));
	assert.equal(visibleReply(st), '第二块');
});

test('空流与纯思考流返回空串，不抛错', () => {
	assert.equal(assembleReply([]), '');
	assert.equal(assembleReply([reasoning('只想不说')]), '');
});

test('reduceReply 是不可变的（React 与服务端都要能安全复用）', () => {
	const before = emptyReply();
	const after = reduceReply(before, textDelta('t1', 'x'));
	assert.notEqual(before, after);
	assert.equal(before.current, '');
	assert.equal(before.blocks.length, 0);
});
