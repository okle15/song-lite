/**
 * `server/agent/message-log.ts` 单测 —— 对话历史的读写与幂等。
 *
 * 为什么值得测：这段逻辑的失败方式全是**静默**的，而且都要等到「刷新页面」才暴露。
 *
 *   - 顺序错了 → 回放出来的对话前后颠倒，但在库里看不出问题（SQL 没报错）；
 *   - 幂等坏了 → 同一轮重复上报长出重复行，用几次之后同一条消息在气泡里出现两遍；
 *   - 坏行没跳过 → 一条脏 JSON 让整段历史读不出来，用户以为对话被清了。
 *
 * 三条都在人工点测里极难复现（要精确控制落库时机），但用真实的临时 SQLite 几行就能钉死。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { UIMessage } from 'ai';
import { closeDb, getDb } from '../db';
import { appendMessages, recentMessages } from './message-log';

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), 'message-log-test-'));
	// 指到临时库，绝不碰真实历史。`getDb()` 每次现读该变量，所以在这里设就够。
	process.env.APP_DB_PATH = join(dir, 'app.db');
	closeDb();
});

after(() => {
	closeDb();
	delete process.env.APP_DB_PATH;
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	getDb().exec('DELETE FROM messages');
});

/** 造一条纯文本消息。 */
function msg(id: string, role: 'user' | 'assistant', text: string): UIMessage {
	return { id, role, parts: [{ type: 'text', text }] };
}

/** 取回消息里的纯文本（只用于断言，不参与实现）。 */
function textOf(m: UIMessage): string {
	return m.parts
		.filter((p) => p.type === 'text')
		.map((p) => (p as { text: string }).text)
		.join('');
}

test('按会话顺序读回：早的在前（不是倒序，也不是按 id 排）', () => {
	appendMessages([msg('u1', 'user', '一'), msg('a1', 'assistant', '回一')]);
	appendMessages([msg('u2', 'user', '二'), msg('a2', 'assistant', '回二')]);

	assert.deepEqual(
		recentMessages().map((m) => m.id),
		['u1', 'a1', 'u2', 'a2'],
	);
});

test('顺序锚在「首次插入」，与 id 字面量无关', () => {
	// 故意让后写的 id 更小：若实现里按 id 排序，这里就会红。
	appendMessages([msg('zzz', 'user', '先')]);
	appendMessages([msg('aaa', 'user', '后')]);

	assert.deepEqual(
		recentMessages().map((m) => m.id),
		['zzz', 'aaa'],
	);
});

test('幂等：同 id 重复落库不产生重复行，且内容被覆盖为最新', () => {
	appendMessages([msg('u1', 'user', '第一版')]);
	appendMessages([msg('u1', 'user', '第二版')]);

	const out = recentMessages();
	assert.equal(out.length, 1, '重复上报不应长出第二行');
	assert.equal(textOf(out[0]), '第二版');
});

test('整段历史反复 upsert：顺序不回退也不前进', () => {
	const all = [msg('u1', 'user', '一'), msg('a1', 'assistant', '回一'), msg('u2', 'user', '二')];
	// 模拟真实调用：每轮 onEnd 都把「完整历史」原样交下来。
	appendMessages(all);
	appendMessages(all);
	appendMessages(all);

	assert.deepEqual(
		recentMessages().map((m) => m.id),
		['u1', 'a1', 'u2'],
	);
});

test('工具轨迹一并存下并原样读回（存储层存全量，裁剪只发生在发送层）', () => {
	const withTool: UIMessage = {
		id: 'a9',
		role: 'assistant',
		parts: [
			{ type: 'text', text: '帮你放上了。' },
			{
				type: 'tool-play_track',
				toolCallId: 'call-1',
				state: 'output-available',
				input: { trackId: 'track-3' },
				output: { ok: true, text: '已开始播放：传奇 — 王菲', ms: 12 },
			},
		],
	};
	appendMessages([withTool]);

	const [back] = recentMessages();
	assert.deepEqual(back.parts, withTool.parts);
});

test('坏行跳过，不拖垮整段回放', () => {
	const db = getDb();
	const dirty = [
		['bad-json', 'user', '{不是 JSON'],
		['bad-role', 'robot', '[]'],
		['bad-shape', 'user', '{"a":1}'],
	];
	for (const [id, role, parts] of dirty) {
		db.prepare(
			'INSERT INTO messages (id, role, parts, created_at) VALUES (?, ?, ?, ?)',
		).run(id, role, parts, '2026-01-01T00:00:00.000Z');
	}
	appendMessages([msg('good', 'user', '正常的一条')]);

	assert.deepEqual(
		recentMessages().map((m) => m.id),
		['good'],
	);
});

test('limit 取最近 N 条且仍为正序', () => {
	for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) {
		appendMessages([msg(id, 'user', id)]);
	}
	assert.deepEqual(
		recentMessages(2).map((m) => m.id),
		['m4', 'm5'],
	);
});

test('limit 非法或越界一律回落，不抛也不返回空', () => {
	appendMessages([msg('m1', 'user', '一')]);
	for (const bad of [0, -3, Number.NaN, 10_000]) {
		assert.equal(recentMessages(bad).length, 1, `limit=${bad} 应回落而不是截断成空`);
	}
});

test('空数组是 no-op（不建连接、不报错）', () => {
	appendMessages([]);
	assert.equal(recentMessages().length, 0);
});
