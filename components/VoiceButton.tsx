/**
 * VoiceButton —— 语音输入的**唯一入口**（对话输入框旁边那颗麦克风）。
 *
 * ── 它为什么在 `components/` 而不是 `icons/` 那类纯展示里 ───────────────
 * 它握着 `MediaRecorder` 与 `getUserMedia` 两个**有状态、会失败**的浏览器 API，
 * 而状态机与格式挑选（能脱开浏览器算清的部分）已经挪进 `./voice-capture.ts` 由单测钉住。
 * 这个文件只做那两件必须真跑才能验的事：开麦克风、发一次请求。
 *
 * ── 三条产品边界 ────────────────────────────────────────────────────
 * 1. **不支持的设备上不显示按钮**（`canRecord` 为假就不渲染），而不是显示了再报错。
 *    缺少 `MediaRecorder` 的浏览器不是"偶尔失败"，是**没有这个功能**。
 * 2. **转写结果进输入框，不自动发送**。识别会错字，而「替用户按下发送」不可逆
 *    （那条消息会进 `messages`、会触发工具）。见路由头部的同一条说明。
 * 3. **失败要说清是哪一档**（麦克风被拒 / 没配转写 / 网关坏了）。所以这里把服务端
 *    回的 `message` 原样显示 —— 它会说「在 .env.local 里填 VOICE_MODEL」这种**能照着做**的话。
 *
 * ── 为什么 `supported` 要放在 `useEffect` 里 ──────────────────────────
 * 服务端渲染时没有 `navigator` / `MediaRecorder`，若在渲染期就判断，首帧与
 * 水合后的帧不一致 → React 报 hydration mismatch。先渲染"不支持"，挂载后再改。
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { MicIcon } from './icons';
import {
	canRecord,
	VOICE_INITIAL,
	pickRecorderMime,
	voiceReducer,
	voiceExtFor,
	type VoiceState,
} from './voice-capture';

type Props = {
	/** 转写成功后把这段文字交给调用方（由它决定接到输入框哪个位置）。 */
	onText: (text: string) => void;
	/** 对话正在忙（等首字 / 吐字中）时不许录音 —— 与发送键同一个条件。 */
	disabled?: boolean;
};

/** 把 `getUserMedia` 的失败翻译成一句能照着做的话。 */
function micErrorNote(err: unknown): string {
	const name = (err as { name?: string })?.name;
	if (name === 'NotAllowedError' || name === 'SecurityError') {
		return '麦克风权限被拒绝 —— 地址栏左侧那把锁里可以重新允许';
	}
	if (name === 'NotFoundError' || name === 'OverconstrainedError') {
		return '这台设备上没有可用的麦克风';
	}
	return `打不开麦克风：${(err as Error)?.message ?? err}`;
}

export function VoiceButton({ onText, disabled = false }: Props) {
	const [supported, setSupported] = useState(false);
	const [state, setState] = useState<VoiceState>(VOICE_INITIAL);

	// 录音相关的句柄：不放 state（它们变化不该触发重渲染，且读的总是最新值）。
	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	/** `getUserMedia` 是异步的；在它返回前相位还是 `idle`，双击会开出两个录音器。
	 *  这个 ref 就是补那个窗口的（reducer 只挡得住已进入 `recording` 之后的重复点击）。 */
	const startingRef = useRef(false);

	useEffect(() => {
		if (typeof navigator === 'undefined') return;
		setSupported(
			canRecord({
				mediaDevices: navigator.mediaDevices as { getUserMedia?: unknown } | undefined,
				MediaRecorder: typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
			}),
		);
	}, []);

	// 卸载时收掉麦克风（否则标签页上会一直留着录音指示灯）。
	useEffect(() => {
		return () => {
			const rec = recorderRef.current;
			if (rec?.state === 'recording') rec.stop();
			streamRef.current?.getTracks().forEach((t) => t.stop());
		};
	}, []);

	/** 录音结束：拼字节 → POST → 把文字交给调用方。 */
	const finish = async (mime: string) => {
		streamRef.current?.getTracks().forEach((t) => t.stop());
		streamRef.current = null;
		recorderRef.current = null;

		const blob = new Blob(chunksRef.current, { type: mime });
		chunksRef.current = [];
		setState((s) => voiceReducer(s, { type: 'stop' }));

		if (blob.size === 0) {
			setState((s) => voiceReducer(s, { type: 'fail', message: '没录到声音' }));
			return;
		}

		const form = new FormData();
		form.append('file', blob, `voice.${voiceExtFor(mime)}`);
		try {
			const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
			const json = (await res.json().catch(() => null)) as
				| { code?: number; message?: string; data?: { text?: string } }
				| null;
			if (!res.ok || !json || json.code !== 0) {
				// 服务端的 message 是**能照着做**的那句话（没配 / 上游坏了），原样显示。
				throw new Error(json?.message ?? `HTTP ${res.status}`);
			}
			setState((s) => voiceReducer(s, { type: 'done' }));
			const text = json.data?.text ?? '';
			if (text.trim()) onText(text);
		} catch (err) {
			setState((s) =>
				voiceReducer(s, { type: 'fail', message: (err as Error).message || '语音转写失败' }),
			);
		}
	};

	const start = async () => {
		if (startingRef.current || state.phase !== 'idle') return;
		startingRef.current = true;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
			if (!mime) {
				stream.getTracks().forEach((t) => t.stop());
				setState((s) =>
					voiceReducer(s, { type: 'fail', message: '这台设备没有可用的录音格式' }),
				);
				return;
			}
			const rec = new MediaRecorder(stream, { mimeType: mime });
			chunksRef.current = [];
			rec.ondataavailable = (e) => {
				if (e.data.size > 0) chunksRef.current.push(e.data);
			};
			rec.onstop = () => void finish(mime);
			rec.start();
			recorderRef.current = rec;
			streamRef.current = stream;
			setState((s) => voiceReducer(s, { type: 'start' }));
		} catch (err) {
			setState((s) => voiceReducer(s, { type: 'fail', message: micErrorNote(err) }));
		} finally {
			startingRef.current = false;
		}
	};

	const stop = () => {
		if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
	};

	if (!supported) return null;

	const recording = state.phase === 'recording';
	const transcribing = state.phase === 'transcribing';

	return (
		<div className="flex shrink-0 flex-col items-end gap-1">
			<button
				type="button"
				onClick={recording ? stop : start}
				disabled={disabled || transcribing}
				aria-label={recording ? '停止录音' : transcribing ? '正在转写' : '语音输入'}
				aria-pressed={recording}
				title={recording ? '停止录音' : '语音输入'}
				className={
					'flex h-9 w-9 items-center justify-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-40 ' +
					(recording
						? 'animate-pulse bg-red-500/15 text-red-400 hover:bg-red-500/25'
						: 'bg-surface-2 text-muted hover:text-foreground')
				}
			>
				<MicIcon />
			</button>
			{state.error && (
				<p className="max-w-[13rem] text-right text-[10px] leading-snug text-red-400">
					{state.error}
				</p>
			)}
		</div>
	);
}
