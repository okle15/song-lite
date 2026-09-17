import test from 'node:test';
import assert from 'node:assert/strict';
import { COVER_GRADIENTS, coverUrl, gradientFor } from './cover';

test('coverUrl 把 id 整串编码进查询串（id 是相对路径，含斜杠与中文）', () => {
	const url = coverUrl('专辑/全是爱 - 凤凰传奇.mp3');
	assert.ok(url.startsWith('/api/library/cover?trackId='));

	const raw = url.slice('/api/library/cover?trackId='.length);
	assert.ok(!raw.includes('/'), '斜杠必须被编码，否则会被当成 URL 路径分隔符');
	assert.ok(!raw.includes(' '), '空格必须被编码');
	assert.equal(decodeURIComponent(raw), '专辑/全是爱 - 凤凰传奇.mp3', '编码必须可逆');
});

test('gradientFor 对同一 id 恒定（三处封面不能各算各的颜色）', () => {
	assert.equal(gradientFor('全是爱 - 凤凰传奇.mp3'), gradientFor('全是爱 - 凤凰传奇.mp3'));
	assert.ok(COVER_GRADIENTS.includes(gradientFor('全是爱 - 凤凰传奇.mp3')));
});
