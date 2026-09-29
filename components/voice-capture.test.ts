/**
 * 语音输入纯逻辑（状态机 / 能力探测 / 格式挑选 / 填字）的单测。
 *
 * 这几条之所以值得钉：它们坏掉时**界面都不报错** ——
 * 状态机漏一个迁移 = 按钮点下去没反应；`canRecord` 太宽 = 显示了麦克风却在
 * 点了之后才说"不支持"；`voiceInsert` 太松 = 录到静音时把用户已打的字清掉。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	canRecord,
	pickRecorderMime,
	voiceExtFor,
	voiceInsert,
	VOICE_INITIAL,
	voiceReducer,
} from './voice-capture';

test('状态机：idle → recording → transcribing → idle', () => {
	let s = VOICE_INITIAL;
	s = voiceReducer(s, { type: 'start' });
	assert.equal(s.phase, 'recording');
	s = voiceReducer(s, { type: 'stop' });
	assert.equal(s.phase, 'transcribing');
	s = voiceReducer(s, { type: 'done' });
	assert.equal(s.phase, 'idle');
	assert.equal(s.error, null);
});

test('状态机：非法迁移被**忽略**而不是抛（onstop 与点击可能同帧到达）', () => {
	// 没在录的时候「停」不该把它推进 transcribing
	assert.equal(voiceReducer(VOICE_INITIAL, { type: 'stop' }).phase, 'idle');
	// 已经在录的时候再「开始」不该重启（否则会开出第二个录音器）
	const rec = voiceReducer(VOICE_INITIAL, { type: 'start' });
	assert.deepEqual(voiceReducer(rec, { type: 'start' }), rec);
	// 转写中不该再回到 recording
	const tr = voiceReducer(rec, { type: 'stop' });
	assert.equal(voiceReducer(tr, { type: 'start' }).phase, 'transcribing');
});

test('状态机：fail 带着那句话回到 idle（错误不进 recording）', () => {
	const s = voiceReducer(voiceReducer(VOICE_INITIAL, { type: 'start' }), {
		type: 'fail',
		message: '麦克风权限被拒绝',
	});
	assert.equal(s.phase, 'idle');
	assert.equal(s.error, '麦克风权限被拒绝');
});

test('状态机：start 会清掉上一次的错误（不然旧错误会一直挂在按钮下面）', () => {
	const withErr = voiceReducer(VOICE_INITIAL, { type: 'fail', message: 'x' });
	assert.equal(voiceReducer(withErr, { type: 'start' }).error, null);
});

test('canRecord：两个 API 都要有', () => {
	/** `MediaRecorder` 是**构造函数**，所以判据是 `typeof === 'function'`（不是「非 null」）。 */
	const MR = function () {} as unknown;
	assert.equal(canRecord({ mediaDevices: { getUserMedia() {} }, MediaRecorder: MR }), true);
	assert.equal(canRecord({ mediaDevices: { getUserMedia() {} } }), false, '没有 MediaRecorder 就没法编码');
	assert.equal(canRecord({ MediaRecorder: MR }), false, '没有 getUserMedia 就没法拿麦克风');
	assert.equal(canRecord({}), false);
	assert.equal(canRecord({ mediaDevices: undefined, MediaRecorder: undefined }), false);
	// 有 `MediaRecorder` 这个**名字**但它不是构造函数（半吊子垫片）→ 也算不支持
	assert.equal(
		canRecord({ mediaDevices: { getUserMedia() {} }, MediaRecorder: {} }),
		false,
		'不是函数 = 不能 new = 不支持',
	);
});

test('pickRecorderMime：取第一个支持的；一个都不支持返回 null（不是硬塞一个）', () => {
	assert.equal(pickRecorderMime(() => true), 'audio/webm;codecs=opus', '优先 opus/webm');
	assert.equal(pickRecorderMime((m) => m === 'audio/mp4'), 'audio/mp4', 'Safari 只认 mp4');
	assert.equal(pickRecorderMime(() => false), null);
});

test('pickRecorderMime：按**候选表的顺序**挑，不是按提问顺序', () => {
	const asked: string[] = [];
	pickRecorderMime((m) => {
		asked.push(m);
		return m === 'audio/mp4';
	});
	assert.equal(asked[0], 'audio/webm;codecs=opus', '第一个问的必须是优先级最高的那个');
});

test('voiceExtFor：mime → 后缀，未知回落 webm', () => {
	assert.equal(voiceExtFor('audio/mp4'), 'mp4');
	assert.equal(voiceExtFor('audio/ogg;codecs=opus'), 'ogg');
	assert.equal(voiceExtFor('audio/webm;codecs=opus'), 'webm');
	assert.equal(voiceExtFor('audio/x-unknown'), 'webm');
});

test('voiceInsert：空 / 全空白 → null（录到静音时**不许**动输入框）', () => {
	assert.equal(voiceInsert('', ''), null);
	assert.equal(voiceInsert('', '   \n '), null);
	assert.equal(voiceInsert('已经打了半句', '\t'), null, '保持用户已有的内容不动');
});

test('voiceInsert：接在已有内容**后面**，不覆盖、不自己加空格', () => {
	assert.equal(voiceInsert('', '放一首传奇'), '放一首传奇');
	assert.equal(voiceInsert('先放', '传奇'), '先放传奇');
	assert.equal(voiceInsert('先放 ', '传奇'), '先放 传奇', '空格由已打的那句决定，这里不加');
	assert.equal(voiceInsert('', '  传奇  '), '传奇', '只 trim，不改变中间');
});
