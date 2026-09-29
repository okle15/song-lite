/**
 * /api/voice/transcribe —— **语音输入**：收一段录音，回一句文字。
 *
 * 形状是 multipart（`file` 字段），因为传的是**字节**，不是 JSON。前端用
 * `MediaRecorder` 录一小段 → POST 上来 → 服务端转发给网关的转写端点
 * （`agent/voice.ts`）→ 回来的文字填进输入框，**由用户自己决定发不发**。
 *
 * ⚠️ 它**不直接替用户发消息**。语音识别会错字，而这个项目里「替用户按下发送」
 * 是不可逆的（那条消息进 `messages`、会触发工具）。所以终点是**带内容的输入框**，
 * 不是一次发送。这条边界是产品定义，不是实现细节。
 *
 * 失败分两档（`VoiceError.status`）：**503 = 本机没配 `VOICE_MODEL`**（你改
 * `.env.local`）、**502 = 上游网关的问题**（和你无关）。前端据此说不同的话 ——
 * 把两件事说成一句「转写失败」会让人去改错的地方。
 */
import { readVoiceConfig, transcribeAudio, VoiceError } from '@/agent/voice';
import { VOICE_MAX_BYTES } from '@/contract/voice';
import { ok, fail } from '@/server/http';

export const dynamic = 'force-dynamic';

/** 兜底的文件名后缀（前端没给文件名时用）。别用 `.webm` 写死——格式由 mime 决定。 */
const FALLBACK_MIME = 'audio/webm';

export async function POST(req: Request) {
	let form: FormData;
	try {
		form = await req.formData();
	} catch {
		return fail('请求体不是 multipart/form-data —— `file` 字段里放音频', 400);
	}

	const file = form.get('file');
	if (!(file instanceof Blob)) {
		return fail('缺少 `file` 字段（音频本体）', 400);
	}
	if (file.size === 0) {
		return fail('音频是空的 —— 可能没录到声音', 400);
	}
	if (file.size > VOICE_MAX_BYTES) {
		return fail(
			`音频 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过上限 ${VOICE_MAX_BYTES / 1024 / 1024}MB，分几次说`,
			413,
		);
	}

	const config = readVoiceConfig();
	if (!config) {
		return fail(
			'语音转写没配：在 .env.local 里填 VOICE_MODEL（如 whisper-1）与 VOICE_API_KEY',
			503,
		);
	}

	const mime = file.type || FALLBACK_MIME;
	// 文件名只起「告诉网关这是哪种容器」的作用（见 contract/voice.ts 的 VOICE_FILE_EXT）。
	const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';

	try {
		const data = new Uint8Array(await file.arrayBuffer());
		return ok(await transcribeAudio({ data, filename: `voice.${ext}`, mime }, config, AbortSignal.timeout(30_000)));
	} catch (err) {
		if (err instanceof VoiceError) return fail(err.message, err.status);
		console.error('[voice/transcribe] failed:', err);
		return fail('语音转写失败', 500);
	}
}
