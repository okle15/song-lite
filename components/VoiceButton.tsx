/**
 * VoiceButton — Phase 6 (dual Web Speech API + Whisper).
 *
 * Decision J1: support both the browser-native Web Speech API (`webkitSpeechRecognition`,
 * Chromium-only) and a Whisper backend (`/api/voice`) for higher accuracy or
 * non-Chromium browsers. Decision J3: Chromium-only for the Web Speech half;
 * the Whisper half works in any browser that has `MediaRecorder` (all modern
 * evergreen browsers).
 *
 * Decision J2: flow is record → transcribe → send. In Whisper mode the
 * browser records audio with `MediaRecorder` (webm/opus on Chromium), the user
 * clicks stop, the blob is POSTed to `/api/voice` which forwards it to an
 * OpenAI-compatible transcription endpoint, and the returned text is fed into
 * the chat composer via `onTranscript` (same path as the Web Speech half).
 *
 * Mode is persisted to `localStorage` so the user's preference survives reloads.
 *
 * Fallback behavior: if the selected mode is unavailable (no SpeechRecognition,
 * or Whisper returns 502 because `whisper-1` isn't provisioned on the gateway),
 * the button shows a hint and the user can switch to the other mode.
 */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtTime } from './player-events';
import { VoiceIcon } from './icons';

type VoiceButtonProps = {
	onTranscript: (text: string) => void;
};

type VoiceMode = 'web-speech' | 'whisper';

const MODE_KEY = 'music-assistant-voice-mode';

type SpeechRecognitionLike = {
	lang: string;
	interimResults: boolean;
	continuous: boolean;
	onresult: (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
	onerror: (event: unknown) => void;
	onend: () => void;
	start: () => void;
	stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | undefined {
	if (typeof window === 'undefined') return undefined;
	const w = window as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

function hasMediaRecorder(): boolean {
	return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';
}

function pickDefaultMode(): VoiceMode {
	// Prefer Web Speech when available (zero network round-trip, no dependency
	// on a provisioned whisper channel); fall back to Whisper (MediaRecorder)
	// so Firefox/Safari still have a path.
	if (getRecognitionCtor()) return 'web-speech';
	if (hasMediaRecorder()) return 'whisper';
	return 'web-speech';
}

export function VoiceButton({ onTranscript }: VoiceButtonProps) {
	const [mode, setMode] = useState<VoiceMode>('web-speech');
	const [listening, setListening] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [recordingMs, setRecordingMs] = useState(0);
	// `mounted` gates all browser-only feature detection so the server render
	// and the first client render match (both see "unsupported"), avoiding a
	// hydration mismatch. The real capabilities are read after mount.
	const [mounted, setMounted] = useState(false);
	const recogRef = useRef<SpeechRecognitionLike | null>(null);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const streamRef = useRef<MediaStream | null>(null);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// 用 ref 稳定 onTranscript，避免聊天状态变化（status 改变导致 send 身份变化）
	// 时反复重建 Web Speech 识别实例而中断聆听。所有回调统一走 ref。
	const onTranscriptRef = useRef(onTranscript);
	useEffect(() => {
		onTranscriptRef.current = onTranscript;
	}, [onTranscript]);

	// Hydrate mode from localStorage, then pick a working default if the saved
	// mode is unavailable on this browser.
	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		setMounted(true);
		const saved = window.localStorage.getItem(MODE_KEY) as VoiceMode | null;
		if (saved === 'web-speech' && !getRecognitionCtor()) {
			// Saved mode unsupported here; fall through to default pick.
		} else if (saved === 'whisper' && !hasMediaRecorder()) {
			// Saved mode unsupported here; fall through to default pick.
		} else if (saved) {
			setMode(saved);
			return;
		}
		setMode(pickDefaultMode());
	}, []);
	/* eslint-enable react-hooks/set-state-in-effect */

	const switchMode = useCallback((next: VoiceMode) => {
		setMode(next);
		window.localStorage.setItem(MODE_KEY, next);
		setError(null);
	}, []);

	// ── Web Speech half ──────────────────────────────────────────────
	// 仅依赖 mode：onTranscript 已用 ref 稳定，status 变化不会再重建识别实例。
	useEffect(() => {
		if (mode !== 'web-speech') return;
		const Ctor = getRecognitionCtor();
		if (!Ctor) return; // button renders disabled below
		const recog = new Ctor();
		recog.lang = 'zh-CN';
		recog.interimResults = false;
		recog.continuous = false;
		recog.onresult = (event) => {
			const last = event.results[event.results.length - 1];
			const text = last[0].transcript.trim();
			if (text) onTranscriptRef.current(text);
		};
		recog.onerror = () => {
			setListening(false);
			setError('语音识别出错，请重试');
		};
		recog.onend = () => setListening(false);
		recogRef.current = recog;
		return () => {
			try {
				recog.stop();
			} catch {
				/* already stopped */
			}
			recogRef.current = null;
		};
	}, [mode]);

	const stopTimer = useCallback(() => {
		if (timerRef.current) {
			clearInterval(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const stopStream = useCallback(() => {
		if (streamRef.current) {
			for (const track of streamRef.current.getTracks()) track.stop();
			streamRef.current = null;
		}
	}, []);

	// ── Whisper half: upload recorded blob to /api/voice ─────────────
	const transcribeWhisper = useCallback(
		async (blob: Blob) => {
			setError(null);
			const form = new FormData();
			// MediaRecorder on Chromium produces audio/webm; on Safari it may be
			// audio/mp4. Send whatever type the blob reports so the upstream can
			// sniff the container; the filename extension is a hint only.
			const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('mp4') ? 'm4a' : 'webm';
			form.append('audio', blob, `recording.${ext}`);
			form.append('language', 'zh-CN');
			try {
				const res = await fetch('/api/voice', { method: 'POST', body: form });
				const data = (await res.json()) as {
					code: number;
					data?: { text: string };
					message: string;
				};
				if (!res.ok || data.code !== 0) {
					setError(data.message || `HTTP ${res.status}`);
					return;
				}
				const text = data.data?.text.trim();
				if (text) onTranscriptRef.current(text);
			} catch (err) {
				setError(
					`Whisper 请求失败：${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
		[],
	);

	// ── Toggle handler ───────────────────────────────────────────────
	const toggle = useCallback(() => {
		if (mode === 'web-speech') {
			const recog = recogRef.current;
			if (!recog) return;
			if (listening) {
				recog.stop();
				setListening(false);
			} else {
				setError(null);
				try {
					recog.start();
					setListening(true);
				} catch {
					setListening(false);
					setError('无法启动语音识别，请重试');
				}
			}
			return;
		}

		// Whisper mode: start / stop MediaRecorder.
		if (listening) {
			const rec = mediaRecorderRef.current;
			if (rec && rec.state !== 'inactive') {
				rec.stop(); // triggers onstop → upload
			}
			return;
		}

		setError(null);
		setRecordingMs(0);
		navigator.mediaDevices
			.getUserMedia({ audio: true })
			.then((stream) => {
				streamRef.current = stream;
				chunksRef.current = [];
				// Prefer a widely-supported mime type; fall back to default.
				let mimeType: string | undefined;
				if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
					mimeType = 'audio/webm;codecs=opus';
				} else if (MediaRecorder.isTypeSupported('audio/webm')) {
					mimeType = 'audio/webm';
				}
				const rec = mimeType
					? new MediaRecorder(stream, { mimeType })
					: new MediaRecorder(stream);
				rec.ondataavailable = (e) => {
					if (e.data.size > 0) chunksRef.current.push(e.data);
				};
				rec.onstop = () => {
					stopTimer();
					stopStream();
					setListening(false);
					const blob = new Blob(chunksRef.current, {
						type: rec.mimeType || 'audio/webm',
					});
					chunksRef.current = [];
					if (blob.size > 0) void transcribeWhisper(blob);
				};
				rec.start();
				mediaRecorderRef.current = rec;
				setListening(true);
				timerRef.current = setInterval(() => {
					setRecordingMs((ms) => ms + 100);
				}, 100);
			})
			.catch((err: unknown) => {
				setError(
					`无法访问麦克风：${err instanceof Error ? err.message : String(err)}`,
				);
				setListening(false);
				stopStream();
			});
	}, [mode, listening, stopTimer, stopStream, transcribeWhisper]);

	// Cleanup on unmount
	useEffect(
		() => () => {
			stopTimer();
			stopStream();
			if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
				try {
					mediaRecorderRef.current.stop();
				} catch {
					/* ignore */
				}
			}
		},
		[stopTimer, stopStream],
	);

	// ── Availability ─────────────────────────────────────────────────
	// Before mount, report both as unavailable so server + first client render
	// agree (buttons disabled); after mount, read real browser capabilities.
	const webSpeechOk = mounted && getRecognitionCtor() !== undefined;
	const whisperOk = mounted && hasMediaRecorder();
	const modeAvailable = mode === 'web-speech' ? webSpeechOk : whisperOk;

	// ── Render ───────────────────────────────────────────────────────
	const modeLabel = mode === 'web-speech' ? 'Web Speech' : 'Whisper';
	const tooltip = listening
		? '点击停止'
		: mode === 'web-speech'
			? '点击说话（浏览器本地识别）'
			: '点击开始录音，再点一次上传转写';

	return (
		<div className="flex items-center gap-1">
			{/* Mode switch (small segmented control) — 窄屏隐藏，避免顶栏溢出（模式可在宽屏切换） */}
			<div className="hidden overflow-hidden rounded-lg border border-border text-[10px] sm:flex">
				<button
					type="button"
					disabled={!webSpeechOk}
					onClick={() => switchMode('web-speech')}
					title={webSpeechOk ? '用浏览器原生语音识别' : '当前浏览器不支持 Web Speech API'}
					className={`px-1.5 py-1 transition-colors ${
						mode === 'web-speech'
					? 'bg-brand text-white'
					: 'text-muted hover:bg-surface-2'
					} ${!webSpeechOk ? 'cursor-not-allowed opacity-40' : ''}`}
				>
					WS
				</button>
				<button
					type="button"
					disabled={!whisperOk}
					onClick={() => switchMode('whisper')}
					title={whisperOk ? '用 Whisper 后端转写（录音上传）' : '当前浏览器不支持 MediaRecorder'}
					className={`px-1.5 py-1 transition-colors ${
						mode === 'whisper'
					? 'bg-brand text-white'
					: 'text-muted hover:bg-surface-2'
					} ${!whisperOk ? 'cursor-not-allowed opacity-40' : ''}`}
				>
					WH
				</button>
			</div>
			<button
				type="button"
				onClick={toggle}
				disabled={!modeAvailable}
				aria-label={listening ? '停止语音输入' : '开始语音输入'}
				title={
					!modeAvailable
						? mode === 'web-speech'
							? '当前浏览器不支持 Web Speech API，请切换到 Whisper 或使用 Chromium 浏览器'
							: '当前浏览器不支持 MediaRecorder 录音'
						: tooltip
				}
				className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition-colors sm:px-3 ${
					!modeAvailable
						? 'cursor-not-allowed border-border text-muted'
						: listening
							? 'animate-pulse border-red-500/40 bg-red-500/15 text-red-500'
							: 'border-border text-foreground hover:bg-surface-2'
				}`}
			>
				<span aria-hidden={listening} className={listening ? 'inline-block h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px] shadow-red-500/60 animate-pulse' : ''}>
						{listening ? null : <VoiceIcon size={16} />}
					</span>
				{listening ? (
					<span className="hidden sm:inline">
						{mode === 'web-speech' ? '聆听中' : `录音中 ${fmtTime(recordingMs / 1000)}`}
					</span>
				) : (
					<span className="hidden lg:inline">语音</span>
				)}
			</button>
			{error && (
				<span
					className="max-w-[12rem] truncate text-[10px] text-amber-500"
					title={error}
				>
					{error}
				</span>
			)}
			{!error && (
				<span className="hidden text-[10px] text-muted xl:inline">
					{modeLabel}
				</span>
			)}
		</div>
	);
}
