/**
 * `agent/voice.ts` 的单测 —— 重点不是「能不能调通」，是**回落链的方向**。
 *
 * 这条链与 `provider.ts` 的链互为镜像，坏掉时的症状是网关回一句
 * `No available channel for model …`（看着像网关坏了）。所以这里把
 * 「什么能回落、什么绝不能」逐条钉住。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { readVoiceConfig, transcribeAudio, VoiceError } from './voice';

/** 与 voice 相关的环境变量全集（每次测试前后都清干净，避免互相污染）。 */
const VARS = [
	'VOICE_MODEL',
	'VOICE_API_KEY',
	'VOICE_API_BASE',
	'LLM_API_KEY',
	'LLM_API_BASE',
	'AGENT_MODEL',
	'ANTHROPIC_AUTH_TOKEN',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = {};
	for (const k of VARS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of VARS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

test('没配 VOICE_MODEL → null，哪怕对话的 key / base 都在', () => {
	process.env.LLM_API_KEY = 'sk-agent';
	process.env.LLM_API_BASE = 'https://gw.example/v1';
	process.env.AGENT_MODEL = 'agnes-2.5-flash';
	assert.equal(readVoiceConfig(), null, 'VOICE_MODEL 是这条链的必需项，不承认 AGENT_MODEL');
});

test('VOICE_MODEL **绝不**回落到 AGENT_MODEL（镜像于 provider.ts 那条）', () => {
	process.env.AGENT_MODEL = 'agnes-2.5-flash';
	process.env.VOICE_API_KEY = 'sk-voice';
	assert.equal(readVoiceConfig(), null, '对话模型 ≠ 转写模型，捡错了网关只说 No available channel');
});

test('key / base 可以回落到 LLM_*（同一个网关、同一套凭证）', () => {
	process.env.VOICE_MODEL = 'whisper-1';
	process.env.LLM_API_KEY = 'sk-agent';
	process.env.LLM_API_BASE = 'https://gw.example/v1';
	assert.deepEqual(readVoiceConfig(), {
		base: 'https://gw.example/v1',
		key: 'sk-agent',
		model: 'whisper-1',
	});
});

test('VOICE_* 优先于 LLM_*', () => {
	process.env.VOICE_MODEL = 'whisper-1';
	process.env.VOICE_API_KEY = 'sk-voice';
	process.env.VOICE_API_BASE = 'https://voice.example/v1';
	process.env.LLM_API_KEY = 'sk-agent';
	process.env.LLM_API_BASE = 'https://gw.example/v1';
	assert.deepEqual(readVoiceConfig(), {
		base: 'https://voice.example/v1',
		key: 'sk-voice',
		model: 'whisper-1',
	});
});

test('base 的尾部斜杠被去掉（否则会拼出 //audio/transcriptions）', () => {
	process.env.VOICE_MODEL = 'whisper-1';
	process.env.VOICE_API_KEY = 'sk-voice';
	process.env.VOICE_API_BASE = 'https://voice.example/v1///';
	assert.equal(readVoiceConfig()?.base, 'https://voice.example/v1');
});

test('有 VOICE_MODEL 却一点凭证都没有 → null', () => {
	process.env.VOICE_MODEL = 'whisper-1';
	assert.equal(readVoiceConfig(), null);
});

/* ── transcribeAudio：上游的各种「坏」都要变成 VoiceError(502)，不许静默成功 ── */

const CFG = { base: 'https://gw.example/v1', key: 'sk-voice', model: 'whisper-1' };
const AUDIO = { data: new Uint8Array([1, 2, 3]), filename: 'voice.webm', mime: 'audio/webm' };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
	const calls: { url: string; init: RequestInit }[] = [];
	globalThis.fetch = (async (url: unknown, init: unknown) => {
		calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
		return impl(String(url), (init ?? {}) as RequestInit);
	}) as typeof fetch;
	return calls;
}

test('成功：POST 到 /audio/transcriptions，带 Bearer 与 multipart', async () => {
	const calls = stubFetch(() => Response.json({ text: '放一首传奇' }));
	const out = await transcribeAudio(AUDIO, CFG);
	assert.equal(out.text, '放一首传奇');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://gw.example/v1/audio/transcriptions');
	assert.equal(calls[0].init.method, 'POST');
	assert.match(String((calls[0].init.headers as Record<string, string>).Authorization), /^Bearer sk-voice$/);
	assert.ok(calls[0].init.body instanceof FormData, 'multipart 必须是 FormData');
	const form = calls[0].init.body as FormData;
	assert.equal(form.get('model'), 'whisper-1', 'model 必须带上（网关靠它选通道）');
	assert.ok(form.get('file') instanceof Blob, 'file 字段是音频本体');
});

test('上游非 2xx → 502，且把上游正文带出来（那正是最该看见的东西）', async () => {
	stubFetch(() => new Response('No available channel for model whisper-1', { status: 400 }));
	await assert.rejects(
		() => transcribeAudio(AUDIO, CFG),
		(err: unknown) => {
			assert.ok(err instanceof VoiceError);
			assert.equal((err as VoiceError).status, 502);
			assert.match((err as Error).message, /No available channel/);
			return true;
		},
	);
});

test('上游返回的不是 JSON → 502', async () => {
	stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 200 }));
	await assert.rejects(() => transcribeAudio(AUDIO, CFG), (err: unknown) => {
		assert.ok(err instanceof VoiceError);
		assert.equal((err as VoiceError).status, 502);
		return true;
	});
});

test('上游没有 text 字段 → 502（不许「拿不到就返回空串」）', async () => {
	stubFetch(() => Response.json({ result: 'ok' }));
	await assert.rejects(() => transcribeAudio(AUDIO, CFG), (err: unknown) => {
		assert.ok(err instanceof VoiceError);
		assert.match((err as Error).message, /text/);
		return true;
	});
});

test('网络层失败（连接不上）→ 502，不是 500', async () => {
	stubFetch(() => {
		throw new Error('ECONNREFUSED');
	});
	await assert.rejects(() => transcribeAudio(AUDIO, CFG), (err: unknown) => {
		assert.ok(err instanceof VoiceError);
		assert.equal((err as VoiceError).status, 502, '上游不可达是 502（和你无关），不是 500');
		return true;
	});
});
