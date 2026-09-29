/**
 * 语音转写接入 —— **本项目的第二个「模型接入」点**，刻意挨着 `provider.ts`。
 *
 * ── 为什么它也在 `agent/` 而不是 `server/` ────────────────────────────
 * `server/` 至今**一次网络出站都没有**（它的活是曲库 / 播放 / 记忆，全是本地的），
 * 而 `agent/` 就是「和模型网关说话」的那一层（`provider.ts` 的注释写着
 * 「① 模型接入」）。语音转写是**同一种事**：读网关的 `base`/`key`/`model`，
 * 调一个 HTTP 端点。放进 `server/` 会把「模型接入」这件事劈成两半，
 * 两边的回落链各自漂移 —— 而那正是 `provider.ts` 立这个文件时踩过的坑。
 *
 * ── 两条回落链是**镜像**的，必须一起读 ────────────────────────────────
 * ```
 *   读对话配置（provider.ts）：key/base 可回落 VOICE_*；model 绝不回落 VOICE_MODEL
 *   读转写配置（本文件）      ：key/base 可回落 LLM_*  ；model 绝不回落 AGENT_MODEL
 * ```
 * 两句话是同一句：**`key`/`base` 是「哪一个网关」（同一个网关、同一套凭证，回落安全），
 * `model` 是「哪一种能力」（对话模型 ≠ 转写模型），能力不能互相兜底。**
 * 网关对捡错模型不会报「模型不匹配」，只回 `No available channel for model …`——
 * 看着像网关坏了。所以这条规则在**两处各写一遍**是故意的：它们方向相反，
 * 合成一个函数反而会逼人读两遍才看清谁是谁。
 *
 * 只读 `process.env`，不写任何文件、不打印凭证。
 */
import type { TranscribeResult } from '../contract/voice';

const DEFAULT_BASE = 'https://apihub.agnes-ai.com/v1';

export type VoiceConfig = {
	/** 网关根地址，已去掉尾部斜杠。 */
	base: string;
	/** 凭证。 */
	key: string;
	/** 转写模型名（如 `whisper-1`）。 */
	model: string;
};

/**
 * 按顺序取第一个非空环境变量。
 *
 * 与 `provider.ts` 里的同名小助手是同一段代码（6 行）。**没有抽成共享模块是有意的**：
 * `provider.ts` 在冻结区（给它加 `export` 也是一次改动，而它唯一该改的理由是「换模型来源」），
 * 而这个函数是纯机械的 —— 真正要小心的**不是这个函数，是调用它时传的那串变量**，
 * 那串变量在两处本就必须不同（见文件头）。
 */
function pick(...names: string[]): string | null {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return null;
}

/**
 * 读取转写网关配置。**没有 `VOICE_MODEL` 就返回 `null`** —— 它是这条链的必需项
 * （不像 key/base 有可回落项）。`null` 不是异常，是「这个功能还没配」，
 * 由路由翻译成一句人能看懂的话。
 */
export function readVoiceConfig(): VoiceConfig | null {
	const model = pick('VOICE_MODEL');
	if (!model) return null;
	const key = pick('VOICE_API_KEY', 'LLM_API_KEY', 'ANTHROPIC_AUTH_TOKEN');
	if (!key) return null;
	const base = pick('VOICE_API_BASE', 'LLM_API_BASE') ?? DEFAULT_BASE;
	return { base: base.replace(/\/+$/, ''), key, model };
}

/**
 * 转写失败，带一个**给路由用的** HTTP 码。
 *
 * 分档的理由和别处一样（「谁来修」）：`503` = 本机没配（你改 `.env.local`），
 * `502` = 上游网关的问题（和你无关）。前端据此说不同的话。
 */
export class VoiceError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'VoiceError';
	}
}

/**
 * 把一段音频转成文字。
 *
 * 走 OpenAI 兼容的 `POST {base}/audio/transcriptions`（multipart：`file` + `model`），
 * 读回 `{ text }`。**上游返回的不是 JSON、或没有 `text` 字符串，都算上游坏了** ——
 * 不许「拿不到就返回空串」：那会让用户以为是自己没说清楚，而其实是网关的事。
 *
 * 超时由调用方传 `AbortSignal`（路由用 `AbortSignal.timeout`）。
 */
export async function transcribeAudio(
	audio: { data: Uint8Array; filename: string; mime: string },
	config: VoiceConfig,
	signal?: AbortSignal,
): Promise<TranscribeResult> {
	const form = new FormData();
	form.append('model', config.model);
	// Blob 要带 mime + 文件名：网关多半按文件名 / Content-Type 判格式。
	form.append('file', new Blob([audio.data as BlobPart], { type: audio.mime }), audio.filename);

	let res: Response;
	try {
		res = await fetch(`${config.base}/audio/transcriptions`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${config.key}` },
			body: form,
			signal,
		});
	} catch (err) {
		// 网络层失败（DNS / 连接 / 超时）。abort 也落这里 —— 交给路由分辨。
		throw new VoiceError(`转写网关不可达：${(err as Error).message}`, 502);
	}

	if (!res.ok) {
		// 把上游的正文带上一截：网关的报错（`No available channel for model …`）
		// 恰恰是最该让人看见的东西。
		const body = await res.text().catch(() => '');
		throw new VoiceError(
			`转写网关返回 ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`,
			502,
		);
	}

	let json: unknown;
	try {
		json = await res.json();
	} catch {
		throw new VoiceError('转写网关返回的不是 JSON', 502);
	}
	const text = (json as { text?: unknown })?.text;
	if (typeof text !== 'string') {
		throw new VoiceError('转写网关的响应里没有 text 字段', 502);
	}
	return { text };
}
