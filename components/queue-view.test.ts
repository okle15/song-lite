/**
 * `components/queue-view.ts` 单测 —— 队列卡那几句话。
 *
 * 为什么值得测：这些句子里有两条判定**错了不会报错，只会让人误解**。
 *  - 404（歌已经不在队列里）若说成「去掉没成功」，用户会再点一次，而再点一次还是 404；
 *  - `queueTitle` 若把「整个曲库」省掉，用户看着「6 首」分不清是「曲库只有 6 首」
 *    还是「队列被换过」—— 两种处境下一步完全不同，而数字一模一样。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueFootNote, queueTitle, removalNote, restoreNote } from './queue-view';

test('queueTitle：三种身份都要说出来，不能只剩一个数字', () => {
	assert.equal(queueTitle('library', null, 12), '整个曲库 · 12 首');
	assert.equal(queueTitle('custom', '安静的歌', 6), '安静的歌 · 6 首');
	// 自定义但没有名字（用户自己从整库里删出来的那批）：不能显示成「整个曲库」，
	// 那正是它已经不是的东西。
	assert.equal(queueTitle('custom', null, 11), '你改过的这批 · 11 首');
});

test('queueTitle：整库队列的 label 只可能是 null，给了也不许顶掉「整个曲库」', () => {
	assert.equal(queueTitle('library', '安静的歌', 3), '整个曲库 · 3 首');
});

test('queueFootNote：整库队列没有这一块（没有「为什么不是全部」要解释，也没有退路可退）', () => {
	assert.equal(queueFootNote('library', null), null);
	assert.equal(queueFootNote('library', '不该出现的名字'), null);
});

test('queueFootNote：自定义队列要同时说出**为什么**和**谁弄的**', () => {
	const byAgent = queueFootNote('custom', '安静的歌');
	assert.ok(byAgent);
	assert.match(byAgent, /安静的歌/, 'agent 组的那批要露出名字，否则用户不知道它在说什么');
	assert.match(byAgent, /不跟着曲库变/, '这是它为什么值得解释的全部理由');

	const byUser = queueFootNote('custom', null);
	assert.ok(byUser);
	assert.match(byUser, /你改过/, '没名字的那批是用户自己删出来的，要说「你」，不是「它按什么挑的」');
	assert.match(byUser, /不跟着曲库变/);
	assert.doesNotMatch(byUser, /按「/, '没有名字就不要编一个名字');
});

test('removalNote：404 不是失败 —— 它是「你看到的列表已经旧了」', () => {
	const note = removalNote(404);
	assert.match(note, /已经不在队列里/);
	assert.doesNotMatch(note, /没成功/, '说成失败会推着用户再点一次，而结果仍然是 404');
});

test('removalNote：其余状态码与网络层失败分开说', () => {
	assert.match(removalNote(500), /去掉没成功（服务端回了 500）/);
	assert.match(removalNote(500), /队列没变/, '失败之后队列是什么样要说清');
	assert.match(removalNote(null), /去掉没成功（网络没通）/);
	assert.doesNotMatch(removalNote(null), /服务端/);
});

test('restoreNote：409 是「曲库是空的」，不是一句状态码', () => {
	const note = restoreNote(409);
	assert.match(note, /曲库是空的/);
	assert.doesNotMatch(note, /409/, '让用户去猜 409 是什么意思，等于没解释');
});

test('restoreNote：其余情况仍然走统一的两分法', () => {
	assert.match(restoreNote(null), /恢复整个曲库没成功（网络没通）/);
	assert.match(restoreNote(503), /恢复整个曲库没成功（服务端回了 503）/);
});
