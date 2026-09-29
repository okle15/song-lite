/**
 * 语音输入的**纯逻辑**（无 React、无浏览器 API）—— 录音状态机 + 格式挑选。
 *
 * 为什么把这几个函数单独拿出来：录音本身（`MediaRecorder` / `getUserMedia`）必须有
 * 浏览器，但**「什么时候能点、点了之后进入哪个状态」是纯判断**，可以脱开浏览器钉住。
 * 项目里凡是「能不依赖浏览器就算清」的东西都这么分（`panel-layout.ts` / `list-phase.ts`
 * / `queue-view.ts` 同族）。
 */
import { VOICE_FILE_EXT, VOICE_MIME_CANDIDATES } from '@/contract/voice';

/** 界面上的三个相位。**顺序承重**：`recording` 时按钮是「停」，`transcribing` 时按钮禁用。 */
export type VoicePhase = 'idle' | 'recording' | 'transcribing';

export type VoiceState = {
	phase: VoicePhase;
	/** 出错时的一句话（转写失败 / 麦克风被拒）。成功或复位后清空。 */
	error: string | null;
};

export const VOICE_INITIAL: VoiceState = { phase: 'idle', error: null };

export type VoiceEvent =
	/** 用户按了麦克风。 */
	| { type: 'start' }
	/** 录音结束（用户按停，或浏览器自己停了），进入转写。 */
	| { type: 'stop' }
	/** 转写成功。 */
	| { type: 'done' }
	/** 任何一步失败 —— 带着**说给用户的那句话**。 */
	| { type: 'fail'; message: string };

/**
 * 状态机。**忽略非法迁移而不是抛**：`MediaRecorder` 的 `onstop` 与用户点击可能
 * 同帧到达，抛异常会把一次正常的收尾变成崩溃。忽略 = 「这件事已经不需要再做了」。
 */
export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
	switch (event.type) {
		case 'start':
			if (state.phase !== 'idle') return state;
			return { phase: 'recording', error: null };
		case 'stop':
			if (state.phase !== 'recording') return state;
			return { phase: 'transcribing', error: null };
		case 'done':
			return { phase: 'idle', error: null };
		case 'fail':
			return { phase: 'idle', error: event.message };
	}
}

/**
 * 能不能录音。
 *
 * 两个都要有：`getUserMedia`（拿麦克风）与 `MediaRecorder`（把流编成字节）。
 * 缺任一个 ⇒ 这台设备不提供录音 —— 界面**不显示麦克风按钮**，而不是显示了再报错。
 *
 * 参数是**注入**的（不是直接读 `navigator`），所以单测能造出「Safari 有
 * `getUserMedia` 却没有 `MediaRecorder`」这类组合。
 */
export function canRecord(input: {
	mediaDevices?: { getUserMedia?: unknown } | undefined;
	MediaRecorder?: unknown;
}): boolean {
	return typeof input.mediaDevices?.getUserMedia === 'function' && typeof input.MediaRecorder === 'function';
}

/**
 * 从候选表里挑第一个支持的容器格式。**一个都不支持就返回 `null`**（= 不录），
 * 而不是硬塞一个默认值 —— 塞了会在服务端失败得更晚、更难懂。
 */
export function pickRecorderMime(isSupported: (mime: string) => boolean): string | null {
	for (const mime of VOICE_MIME_CANDIDATES) {
		if (isSupported(mime)) return mime;
	}
	return null;
}

/** 录音容器的后缀（给上传的文件起名用）。表在 `contract/voice.ts`，只有一处。 */
export function voiceExtFor(mime: string): string {
	return VOICE_FILE_EXT[mime] ?? 'webm';
}

/**
 * 从转写结果里取出**该填进输入框的内容**。
 *
 * 两条判据：
 * 1. **空串 / 全空白 = 不填**（返回 `null`）—— 录到了静音时，用户看到输入框被清空
 *    比「什么都没发生」更糟。
 * 2. **不覆盖已有内容，也不自己加空格** —— 用户可能已经打了半句话，转写结果接在后面；
 *    中间要不要空格由**调用方**决定（它知道原文末尾有没有空白），这里只负责「该不该填」。
 */
export function voiceInsert(prev: string, text: string): string | null {
	const t = text.trim();
	if (!t) return null;
	return prev + t;
}
