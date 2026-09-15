/**
 * /api/voice — Whisper transcription BFF route (Phase 6).
 *
 * Decision J1/J2: dual Web Speech API + Whisper support. This route is the
 * Whisper half: the frontend (MediaRecorder → webm/opus blob) POSTs the audio
 * as `multipart/form-data` here, this route forwards it to an OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint and returns `{ text }` in an
 * `ApiResponse` envelope.
 *
 * Configuration (env):
 * - `VOICE_API_BASE` — base URL of the transcription provider. Defaults to the
 *   Agnes gateway (`https://apihub.agnes-ai.com/v1`) so it reuses the same
 *   token as the chat model. The OpenAI path `/audio/transcriptions` is
 *   appended, so the final URL is `<VOICE_API_BASE>/audio/transcriptions`.
 * - `VOICE_MODEL` — model id sent in the `model` form field. Defaults to
 *   `whisper-1`. (The Agnes gateway currently returns 503
 *   `model_not_found: No available channel for model whisper-1`, so callers
 *   should expect a 502 here until a real whisper channel is configured, and
 *   fall back to the Web Speech API half on the frontend.)
 * - `ANTHROPIC_AUTH_TOKEN` — reused as the bearer token
 *   (`Authorization: Bearer <token>`).
 *
 * Error mapping:
 * - No audio / unparseable form → 400 `bad_request`.
 * - Upstream returns non-2xx (e.g. Agnes 503 model_not_found) → 502
 *   `bad_gateway` with the upstream message surfaced so the frontend can show
 *   a useful hint and fall back to Web Speech API.
 * - Network failure reaching upstream → 502 `bad_gateway`.
 *
 * 信封统一（2026-09-10）：原先本文件自带一个 `jsonError()` 并手写成功分支，
 * 是全仓最后两处绕过 `server/http.ts` 的地方之一（另一处是 `api/chat`），
 * 已改为 `ok()` / `fail()`，不变式恢复为「信封 code === HTTP status」。
 */
import { ok, fail } from '@/server/http';

const DEFAULT_VOICE_API_BASE = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_VOICE_MODEL = 'whisper-1';

function voiceConfig() {
	return {
		apiBase: process.env.VOICE_API_BASE ?? DEFAULT_VOICE_API_BASE,
		model: process.env.VOICE_MODEL ?? DEFAULT_VOICE_MODEL,
		token: process.env.ANTHROPIC_AUTH_TOKEN,
	};
}

export async function POST(request: Request) {
	const { apiBase, model, token } = voiceConfig();

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return fail('Request body must be multipart/form-data', 400);
	}

	const file = form.get('audio');
	if (!(file instanceof Blob) || file.size === 0) {
		return fail(
			'Missing "audio" file in multipart form (expected a recorded audio blob)',
			400,
		);
	}

	if (!token) {
		return fail(
			'VOICE transcription is not configured: ANTHROPIC_AUTH_TOKEN is not set',
			500,
		);
	}

	// Re-pack as multipart for the upstream OpenAI-compatible endpoint.
	const upstreamForm = new FormData();
	// OpenAI's API expects a filename on the file field; MediaRecorder blobs
	// arrive unnamed, so we synthesize one with a webm extension (the container
	// MediaRecorder produces on Chromium). The upstream sniffs the actual codec
	// from the container header, so .webm is a safe default.
	const filename = (file as File).name || `recording.webm`;
	upstreamForm.append('file', file, filename);
	upstreamForm.append('model', model);
	// Hint the source language so the model doesn't auto-detect; the UI is
	// Chinese-first and we send lang=zh-CN from the Web Speech half too.
	const lang = (form.get('language') as string | null) ?? 'zh-CN';
	upstreamForm.append('language', lang);
	upstreamForm.append('response_format', 'json');

	const upstreamUrl = `${apiBase.replace(/\/$/, '')}/audio/transcriptions`;
	let upstreamRes: Response;
	try {
		upstreamRes = await fetch(upstreamUrl, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: upstreamForm,
		});
	} catch (err) {
		return fail(
			`Voice upstream unreachable: ${err instanceof Error ? err.message : String(err)}`,
			502,
		);
	}

	if (!upstreamRes.ok) {
		// Surface the upstream error so the frontend can show a useful hint.
		// Agnes gateway returns 503 + `{"error":{"message":"...model whisper-1..."}}`
		// when the model isn't available — we map any non-2xx to 502 so the
		// frontend treats it as "Whisper unavailable, fall back to Web Speech".
		let detail = `${upstreamRes.status} ${upstreamRes.statusText}`;
		try {
			const body = await upstreamRes.json();
			const msg = (body as { error?: { message?: string }; message?: string })?.error?.message
				?? (body as { message?: string })?.message;
			if (msg) detail = `${detail} — ${msg}`;
		} catch {
			/* upstream returned non-JSON, keep status text */
		}
		return fail(
			`Voice transcription upstream rejected the request (${detail}). If the model is unavailable, switch to Web Speech API mode.`,
			502,
		);
	}

	let payload: { text?: string } = {};
	try {
		payload = (await upstreamRes.json()) as { text?: string };
	} catch {
		return fail('Voice upstream returned a non-JSON response', 502);
	}

	const text = payload.text?.trim();
	if (!text) {
		return fail('Voice transcription returned empty text — try speaking again', 422);
	}

	return ok({ text });
}
