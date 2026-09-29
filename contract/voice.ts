/**
 * voice —— 语音输入的**共享契约**（结果形状 / 上传上限 / 录音容器候选）。零业务依赖。
 *
 * ── 为什么走服务端转写，而不是浏览器的 `SpeechRecognition` ──────────────
 * 后者在 Chrome / Edge 之外基本没有（Firefox 至今不认），且把音频送去**第三方**
 * （识别由浏览器厂商的云做）。本仓已经有一条现成的路：`VOICE_*` 环境变量本来就是
 * 为**语音转写**预留的（`agent/provider.ts` 里那条「`VOICE_MODEL=whisper-1`
 * 是转写模型，不能当对话模型」的教训就是它的来历）。于是语音输入 = **一次
 * 普通的 BFF 调用**：浏览器录一段音频 POST 上来，服务端转发给同一个网关。
 * 没有第二个入口、没有第二套凭证、失败语义和别的路由一样是「说清楚」。
 *
 * ── `VOICE_MODEL` **不许**回落到 `AGENT_MODEL`（对称于 provider.ts）──────────
 * provider.ts 那条双向的规则在这里反过来用一次：**对话网关的 `key` / `base`
 * 可以回落到 `VOICE_*`（同一个网关、同一套凭证），但 `VOICE_MODEL` 绝不承认
 * `AGENT_MODEL`**。理由完全一样——不同能力类的模型不能互相兜底，网关不会报
 * 「模型不匹配」，只会回一句 `No available channel for model …`，看起来像网关
 * 坏了，其实是回落链捡错了模型。**这两处必须一起读**，只改一处会漂移。
 *
 * ── 上限是**契约**，不是路由自己拍的 ─────────────────────────────────
 * 「多大的音频不收了」这件事前后端要给出**同一个答案**：前端超了就根本别传
 * （省一次白跑的请求），路由超了要回一句人能看懂的话。两边各写一个数字 = 迟早
 * 不一致，所以它只在这里出现一次。
 */

/**
 * 一次上传的音频上限（字节）。
 *
 * 8 MiB 是个**取舍值**：手机麦克风录 30 秒左右通常 1 MiB 上下，8 MiB 足够容纳
 * 一两分钟的「说完才停」。定得再大只是让失败来得更晚——超限时该做的是让用户
 * **分几次说**，不是把上限往上抬。
 */
export const VOICE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 录音容器的候选表（**按优先级**）。前端逐个问 `MediaRecorder.isTypeSupported`,
 * 取第一个支持的。顺序有讲究：
 *   1. `audio/webm;codecs=opus` —— Chrome / Edge / Firefox 都支持，转写网关最爱；
 *   2. `audio/ogg;codecs=opus`  —— Firefox 的另一种写法；
 *   3. `audio/mp4`              —— Safari（它的 `MediaRecorder` 只出 mp4）。
 * 一个都不支持时**不是**「录了再传」，而是「这台设备不提供录音」——
 * 编一个格式反而会在服务端失败得更晚、更难懂。
 */
export const VOICE_MIME_CANDIDATES = [
	'audio/webm;codecs=opus',
	'audio/webm',
	'audio/ogg;codecs=opus',
	'audio/mp4',
] as const;

/** `POST /api/voice/transcribe` 的成功响应形状。 */
export type TranscribeResult = {
	/** 转写出来的文字。可能是空串（录到了静音），那时前端**不改输入框**。 */
	text: string;
};

/**
 * 前端录音时用的文件后缀。
 *
 * 由 `pickRecorderMime()` 选出的 mime 映射而来——网关按文件名判格式的多，
 * 所以 `Blob` 上传时要给个带后缀的名字。**只在这一处映射**：前端与路由读到
 * 的必须是同一张表。
 */
export const VOICE_FILE_EXT: Record<string, string> = {
	'audio/webm;codecs=opus': 'webm',
	'audio/webm': 'webm',
	'audio/ogg;codecs=opus': 'ogg',
	'audio/mp4': 'mp4',
};
