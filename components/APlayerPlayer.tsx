/**
 * APlayerPlayer — 播放引擎（APlayer normal 模式，UI 视觉隐藏）。
 *
 * APlayer 的预打包 webpack UMD 产物与 Turbopack 不兼容（构造时 art-template
 * 模板渲染异常导致 classList TypeError），因此改为从 CDN 动态加载 APlayer
 * JS + CSS，规避打包问题。
 *
 * 视觉层说明：播放 UI 已由自绘组件接管（PlayerBar 底部播放条 + NowPlaying
 * 英雄卡 + QueueList 队列），APlayer 容器用 sr-only 隐藏（保留 audio 引擎与
 * 事件系统），避免两套播放器 UI 并存。
 *
 * 数据流（agent 侧 BFF API 零改动）：
 *  - 共享 SSE（见 PlayerProvider）推送 PlayerSnapshot → 同步到 APlayer 播放状态
 *  - APlayer 用户操作（play/pause/listswitch）→ POST BFF API → player-state
 *    变更 → SSE 推回。用 isSyncingRef 防止 SSE 回推时再次触发 BFF 调用形成循环。
 *
 * 歌词不在 APlayer 内显示（lrcType:0），由独立的 LyricsPanel 组件负责大面板
 * 展示 + 点击跳转。两者通过 window 自定义事件通信，事件名统一走 player-events
 * 的 PLAYER_EVENTS 常量（不要再写字面量，两边拼错是静默故障）：
 *  - APlayer timeupdate → dispatch PLAYER_EVENTS.time（LyricsPanel/PlayerBar 监听）
 *  - 任意组件 seek/volume 请求 → PLAYER_EVENTS.seek / PLAYER_EVENTS.volume（本组件监听）
 *  - 自动连播：'ended' 时按播放模式（localStorage，见 player-events.ts）决定
 *    单曲循环（本地 seek+play）/ 顺序 / 列表循环 / 随机（jump/next BFF）。
 *
 * 断点续传：timeupdate 存 localStorage，loadeddata 恢复。音量偏好同样持久化。
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import type { PlayerSnapshot, QueueItem } from '@/contract/player';
import { usePlayerSnapshot } from './PlayerProvider';
import { loadMode, loadShuffle, loadVolume, PLAYER_EVENTS } from './player-events';

const AP_CDN_JS = 'https://unpkg.com/aplayer@1.10.1/dist/APlayer.min.js';
const AP_CDN_CSS = 'https://unpkg.com/aplayer@1.10.1/dist/APlayer.min.css';

/** APlayer 实例的最小运行时类型（CDN 加载后挂在 window.APlayer）。 */
type APlayerInstance = {
	audio: HTMLAudioElement;
	list: {
		audios: unknown[];
		index: number;
		add(audios: unknown | unknown[]): void;
		remove(index: number): void;
		switch(index: number): void;
	};
	on(event: string, handler: (data?: unknown) => void): void;
	play(): Promise<void>;
	pause(): void;
	seek(time: number): void;
	destroy(): void;
};
type APlayerConstructor = new (options: Record<string, unknown>) => APlayerInstance;

const RESUME_KEY_PREFIX = 'music-resume:';
const RESUME_THROTTLE_MS = 2000;

/** 切歌后抑制旧曲目残留进度的时间窗口（毫秒）。 */
const SUPPRESS_STALE_MS = 3000;

/**
 * 初始化失败后的自动重试上限。
 *
 * 达到上限就不再自动重试（改为弹可见提示 + 手动重试按钮）。原因：初始化失败
 * 通常是**确定性**的（构造参数/环境问题），而 effect 依赖 `[snap, retryNonce]`，
 * 快照每次变化都会重跑——不设上限就会在每次切歌时反复 `new APlayer` 再崩一次。
 */
const MAX_INIT_ATTEMPTS = 3;

function loadResumePosition(trackId: string): number {
	if (typeof window === 'undefined') return 0;
	const raw = window.localStorage.getItem(`${RESUME_KEY_PREFIX}${trackId}`);
	const n = raw ? Number(raw) : NaN;
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function saveResumePosition(trackId: string, sec: number): void {
	if (typeof window === 'undefined') return;
	window.localStorage.setItem(`${RESUME_KEY_PREFIX}${trackId}`, String(sec));
}

function clearResumePosition(trackId: string): void {
	if (typeof window === 'undefined') return;
	window.localStorage.removeItem(`${RESUME_KEY_PREFIX}${trackId}`);
}

/** QueueItem → APlayer audio 配置。lrcType:0，不启用 APlayer 内置歌词。 */
function toAudio(item: QueueItem) {
	const origin = typeof window !== 'undefined' ? window.location.origin : '';
	return {
		name: item.title,
		artist: item.artist,
		url: `${origin}/api/library/stream?trackId=${encodeURIComponent(item.id)}`,
		theme: '#10b981',
	};
}

/**
 * 自动连播：'ended' 时按播放模式 + 随机 toggle 决定行为。
 *  - shuffleOn（独立 toggle）：随机跳转（排除当前曲目）
 *  - mode === 'one'：单曲循环，本地 seek+play，无需后端往返
 *  - mode === 'rpt' 且在末尾：回卷到队首
 *  - 否则：顺序前进（后端 nextTrack 自会置 stopped）
 */
function handleEnded(ap: APlayerInstance, s: PlayerSnapshot): void {
	const mode = loadMode();
	const shuffleOn = loadShuffle();
	const q = s.queue;
	if (q.length === 0) return;
	if (mode === 'one') {
		try {
			ap.seek(0);
			void ap.play();
		} catch { /* 忽略 */ }
		return;
	}
	if (shuffleOn && q.length > 1) {
		let idx = s.queueIndex;
		while (idx === s.queueIndex) {
			idx = Math.floor(Math.random() * q.length);
		}
		postPlayer('/api/player/jump', { index: idx });
		return;
	}
	const atEnd = s.queueIndex >= q.length - 1;
	if (!atEnd) {
		postPlayer('/api/player/next');
	} else if (mode === 'rpt') {
		postPlayer('/api/player/jump', { index: 0 });
	}
}

/** 在 queue 里找 trackId 对应的索引。 */
function findIndexOfTrack(queue: QueueItem[], trackId: string | undefined): number {
	if (!trackId) return -1;
	return queue.findIndex((q) => q.id === trackId);
}

/**
 * APlayer 事件 → BFF 写操作的唯一出口。
 * 带 body 才发 `Content-Type`（`next` / `pause` / `resume` 原本就不带 body，
 * 空 body + JSON 头在部分 handler 里会被当成坏请求）。
 */
function postPlayer(path: string, body?: Record<string, unknown>): void {
	void fetch(
		path,
		body
			? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
			: { method: 'POST' },
	);
}

/** 在 CDN 动态加载 APlayer JS + CSS，返回全局构造器。
 *  模块级单例 Promise：并发调用与重复挂载共用同一次加载；
 *  已就绪直接复用，失败会 reject（让调用方重置初始化标记并可重试）。 */
let aPlayerCdnPromise: Promise<APlayerConstructor> | null = null;

function loadAPlayerFromCDN(): Promise<APlayerConstructor> {
	if (aPlayerCdnPromise) return aPlayerCdnPromise;
	aPlayerCdnPromise = new Promise<APlayerConstructor>((resolve, reject) => {
		if (typeof window === 'undefined') {
			reject(new Error('window unavailable'));
			return;
		}
		const w = window as unknown as { APlayer?: APlayerConstructor };
		if (w.APlayer) {
			resolve(w.APlayer);
			return;
		}

		// CSS
		if (!document.querySelector(`link[href="${AP_CDN_CSS}"]`)) {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = AP_CDN_CSS;
			document.head.appendChild(link);
		}

		// JS。注意：script 标签可能来自上一次失败的尝试而处于任意状态，
		// 必须同时监听 load / error，否则加载失败会永久 pending（表现为
		// 「永远无法放歌」且 initStartedRef 卡死不再重试）。
		const existing = document.querySelector(`script[src="${AP_CDN_JS}"]`);
		if (existing) {
			const w2 = window as unknown as { APlayer?: APlayerConstructor };
			if (w2.APlayer) {
				resolve(w2.APlayer);
				return;
			}
			const onErr = () => {
				cleanup();
				existing.remove(); // 移除失败脚本，下次重试能重新注入
				reject(new Error('APlayer script load error'));
			};
			const onOk = () => {
				cleanup();
				if (w.APlayer) resolve(w.APlayer);
				else reject(new Error('APlayer loaded but not found on window'));
			};
			const cleanup = () => {
				existing.removeEventListener('load', onOk);
				existing.removeEventListener('error', onErr);
			};
			existing.addEventListener('load', onOk);
			existing.addEventListener('error', onErr);
			return;
		}

		const script = document.createElement('script');
		script.src = AP_CDN_JS;
		script.async = true;
		script.onload = () => {
			if (w.APlayer) resolve(w.APlayer);
			else reject(new Error('APlayer loaded but not found on window'));
		};
		script.onerror = () => reject(new Error('APlayer script load error'));
		document.head.appendChild(script);
	});
	// 失败后清掉单例，允许下一次快照驱动重试
	aPlayerCdnPromise.catch(() => {
		aPlayerCdnPromise = null;
	});
	return aPlayerCdnPromise;
}

export function APlayerPlayer() {
	const snap = usePlayerSnapshot();
	const containerRef = useRef<HTMLDivElement>(null);
	const apRef = useRef<APlayerInstance | null>(null);
	const snapRef = useRef<PlayerSnapshot>(snap);
	const isSyncingRef = useRef(false);
	const pendingResumeRef = useRef(0);
	const lastSaveAtRef = useRef(0);
	/**
	 * 切歌后抑制「上一首的残留进度」的时间戳（0 = 不抑制）。
	 *
	 * 现象：调用 ap.list.switch() 后，APlayer 仍会用**旧音频**再触发几次 timeupdate，
	 * 把上一首的 currentTime（例如 168s）广播出去。此时 SSE 新快照已把 UI 重置为 0，
	 * 于是进度条被旧值覆盖，表现为「切歌后进度条瞬间跳到上一首的位置」。
	 * 对策：切歌后开启一个短窗口，只放行「新音频从头开始」的信号（t <= 1s），
	 * 窗口超时自动解除——避免断点续传（t 恒 > 1）被永久卡住。
	 */
	const suppressStaleUntilRef = useRef(0);
	const initializedRef = useRef(false);
	const initStartedRef = useRef(false);
	/** 已尝试初始化的次数（成功或手动重试时归零）。 */
	const initAttemptsRef = useRef(0);
	/**
	 * 是否已放弃自动重试。与 `loadError` 的区别：这个是 ref，effect 里读到的是
	 * 最新值；`loadError` 是 state，在 effect 闭包里会是旧值。
	 */
	const initFailedRef = useRef(false);
	const seekHandlerRef = useRef<((e: Event) => void) | null>(null);
	const volHandlerRef = useRef<((e: Event) => void) | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	// 「重试」按钮的触发器：CDN 失败后快照可能长期不变，需要一个额外的
	// 依赖值让初始化 effect 重新执行。
	const [retryNonce, setRetryNonce] = useState(0);

	// 内部函数声明在使用它们的 effect 之前，避免「声明前访问」的 lint 报错。
	// 二者都只闭合组件级 ref 与模块级纯函数，不依赖 props/state。

	/** SSE 快照 → APlayer UI（切歌 / 播放暂停 / 队列变化）。 */
	function syncFromSnapshot(snap: PlayerSnapshot) {
		const ap = apRef.current;
		if (!ap) return;
		isSyncingRef.current = true;
		try {
			// 队列变化时重建 list（APlayer remove 只接受 index，需循环删除）
			const oldQueue = snapRef.current.queue;
			const queueChanged =
				oldQueue.length !== snap.queue.length ||
				snap.queue.some((q, i) => q.id !== oldQueue[i]?.id);
			if (queueChanged) {
				while (ap.list.audios.length > 0) {
					ap.list.remove(0);
				}
				if (snap.queue.length > 0) {
					ap.list.add(snap.queue.map((item) => toAudio(item)));
				}
			}

			// 切到 currentTrack 对应的 index
			const targetIdx = findIndexOfTrack(snap.queue, snap.currentTrack?.id);
			if (targetIdx >= 0 && targetIdx !== ap.list.index) {
				ap.list.switch(targetIdx);
				// targetIdx >= 0 已蕴含 currentTrack 存在，但不写非空断言——
				// 断言一旦被后续改动打破就是运行时崩溃，这里退化成「不续传」更安全。
				pendingResumeRef.current = snap.currentTrack ? loadResumePosition(snap.currentTrack.id) : 0;
				// 开启抑制窗口并先把进度归零，UI 立刻反映「新歌从头开始」
				suppressStaleUntilRef.current = Date.now() + SUPPRESS_STALE_MS;
				window.dispatchEvent(new CustomEvent(PLAYER_EVENTS.time, { detail: 0 }));
			}

			// 播放/暂停状态同步（去重：audio 实际状态已匹配时跳过，减少 AbortError）
			const audioPaused = ap.audio.paused;
			if (snap.state === 'playing') {
				if (audioPaused) void ap.play();
			} else if (snap.state === 'paused') {
				if (!audioPaused) ap.pause();
			} else if (snap.state === 'stopped') {
				if (!audioPaused) ap.pause();
				try { ap.seek(0); } catch { /* 忽略 */ }
			}
		} finally {
			setTimeout(() => { isSyncingRef.current = false; }, 0);
		}
	}

	/**
	 * 初始化失败后的统一收尾：复位闸门允许再试，达到上限就改弹可见提示。
	 *
	 * 复位 `initStartedRef` 是关键——不复位的话后续所有快照都会被守卫挡在
	 * 门外，而 `loadError` 又没被设置（错误横幅不渲染），于是变成「没声音、
	 * 没提示、点刷新也救不回来」的永久卡死。
	 */
	function handleInitFailure(message: string): void {
		initStartedRef.current = false;
		initAttemptsRef.current += 1;
		if (initAttemptsRef.current >= MAX_INIT_ATTEMPTS) {
			initFailedRef.current = true;
			setLoadError(message);
		}
	}

	/**
	 * 首次初始化 APlayer：normal 模式嵌入 footer，lrcType:0 不用 APlayer 歌词。
	 * @returns 是否初始化成功——失败时调用方负责复位重试闸门。
	 */
	function initAPlayer(APlayerCtor: APlayerConstructor, snap: PlayerSnapshot): boolean {
		if (!containerRef.current || apRef.current) return false;
		let ap: APlayerInstance;
		try {
			ap = new APlayerCtor({
				container: containerRef.current,
				fixed: false,
				autoplay: false,
				lrcType: 0,
				listFolded: false,
				listMaxHeight: 256,
				volume: loadVolume(), // 恢复本地音量偏好
				audio: snap.queue.map((item) => toAudio(item)),
			});
		} catch (err) {
			console.error('[APlayer] init failed:', err);
			if (containerRef.current) containerRef.current.innerHTML = '';
			return false;
		}
		apRef.current = ap;
		initializedRef.current = true;
		initAttemptsRef.current = 0;
		setLoadError(null); // 初始化成功，清除可能的历史错误

		// 静默 audio.play() 的 AbortError：SSE 快速推送时 play() 的 Promise 可能
		// 被后续 pause() 中断，浏览器抛 AbortError，APlayer 内部 catch 后 console.warn。
		// 包装 play() 返回已处理 rejection 的 Promise，使 APlayer 的 warn 不触发。
		const audioEl = ap.audio;
		const origPlay = audioEl.play.bind(audioEl);
		audioEl.play = () => {
			const p = origPlay();
			if (p && typeof p.then === 'function') {
				return p.then(undefined, () => {});
			}
			return p;
		};

		// 用户操作 → BFF。isSyncingRef 防止 SSE 回推时重复触发。
		ap.on('play', () => {
			if (isSyncingRef.current) return;
			const s = snapRef.current;
			if (s.state === 'stopped' || !s.currentTrack) {
				const idx = ap.list.index >= 0 ? ap.list.index : 0;
				postPlayer('/api/player/jump', { index: idx });
			} else {
				postPlayer('/api/player/resume');
			}
		});
		ap.on('pause', () => {
			if (isSyncingRef.current) return;
			postPlayer('/api/player/pause');
		});
		ap.on('listswitch', (data) => {
			if (isSyncingRef.current) return;
			const idx = (data as { index?: number })?.index;
			if (typeof idx === 'number') {
				postPlayer('/api/player/jump', { index: idx });
			}
		});

		// 断点续传：loadeddata 时恢复，timeupdate 时节流保存 + 推时间给 LyricsPanel，ended 时清除。
		ap.on('loadeddata', () => {
			// 广播时长，供「正在播放」进度条使用
			try {
				window.dispatchEvent(new CustomEvent(PLAYER_EVENTS.duration, { detail: ap.audio.duration || 0 }));
			} catch { /* 忽略 */ }
			const resume = pendingResumeRef.current;
			pendingResumeRef.current = 0;
			if (resume > 0) {
				try {
					ap.seek(resume);
					// 新音频已就绪且已定位到续传点：提前解除抑制并广播真实位置，
					// 否则续传位置（>1s）会被抑制窗口挡满 3 秒才显示
					suppressStaleUntilRef.current = 0;
					window.dispatchEvent(new CustomEvent(PLAYER_EVENTS.time, { detail: resume }));
				} catch { /* 忽略 */ }
			}
		});
		ap.on('timeupdate', () => {
			const s = snapRef.current;
			if (!s.currentTrack) return;
			try {
				const t = ap.audio.currentTime;
				// 抑制窗口内：只放行新音频从头开始的信号（t<=1s），挡掉上一首的残留位置
				if (suppressStaleUntilRef.current > Date.now() && t > 1) return;
				suppressStaleUntilRef.current = 0;
				window.dispatchEvent(new CustomEvent(PLAYER_EVENTS.time, { detail: t }));
				const now = Date.now();
				if (now - lastSaveAtRef.current > RESUME_THROTTLE_MS) {
					saveResumePosition(s.currentTrack.id, t);
					lastSaveAtRef.current = now;
				}
			} catch {
				/* 忽略 */
			}
		});
		ap.on('ended', () => {
			const s = snapRef.current;
			if (s.currentTrack) clearResumePosition(s.currentTrack.id);
			handleEnded(ap, s);
		});

		// 监听 LyricsPanel 的 seek 请求（点击歌词跳转）
		const onSeek = (e: Event) => {
			const t = (e as CustomEvent<number>).detail;
			if (typeof t === 'number' && t >= 0) {
				try {
					ap.seek(t);
					// 显式 seek 是用户直接意图：解除残留抑制窗口并立即广播新位置，
					// 否则切歌后几秒内按 ←/→ 快进时进度条迟迟不动（像没响应）。
					suppressStaleUntilRef.current = 0;
					window.dispatchEvent(new CustomEvent(PLAYER_EVENTS.time, { detail: t }));
				} catch { /* 忽略 */ }
			}
		};
		window.addEventListener(PLAYER_EVENTS.seek, onSeek);
		seekHandlerRef.current = onSeek;

		// 监听任意组件的音量请求（PlayerBar / NowPlaying 音量条）
		const onVolume = (e: Event) => {
			const v = (e as CustomEvent<number>).detail;
			if (typeof v === 'number' && v >= 0 && v <= 1) {
				try { ap.audio.volume = v; } catch { /* 忽略 */ }
			}
		};
		window.addEventListener(PLAYER_EVENTS.volume, onVolume);
		volHandlerRef.current = onVolume;

		// 初始化后立即同步当前状态
		syncFromSnapshot(snap);
		return true;
	}

	// 始终让 snapRef 指向最新快照（供各事件回调读取，避免闭包陷阱）。
	useEffect(() => {
		snapRef.current = snap;
	}, [snap]);

	// 共享 SSE：首次拿到非空队列时从 CDN 加载并初始化 APlayer，之后每次快照变化同步 UI。
	// 不再各自维护 EventSource，也不再用 force 重渲染（本组件只渲染容器/兜底文案）。
	useEffect(() => {
		if (!apRef.current) {
			if (initFailedRef.current) return; // 已达重试上限：等用户手动点重试
			if (!initializedRef.current && snap.queue.length > 0 && containerRef.current && !initStartedRef.current) {
				initStartedRef.current = true;
				loadAPlayerFromCDN()
					.then((APlayerCtor) => {
						if (!containerRef.current) return;
						// 构造失败（CDN 成功但 new 崩了）也必须走同一套收尾，
						// 否则闸门永久卡在 true。
						if (!initAPlayer(APlayerCtor, snapRef.current)) {
							handleInitFailure('播放器初始化失败，请重试');
						}
					})
					.catch((err) => {
						console.error('[APlayer] CDN load failed:', err);
						handleInitFailure('播放器组件加载失败，请检查网络后重试');
					});
			}
		} else {
			syncFromSnapshot(snap);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [snap, retryNonce]);

	// 卸载时销毁 APlayer + 移除 seek / volume 监听
	useEffect(() => {
		return () => {
			if (seekHandlerRef.current) {
				window.removeEventListener(PLAYER_EVENTS.seek, seekHandlerRef.current);
				seekHandlerRef.current = null;
			}
			if (volHandlerRef.current) {
				window.removeEventListener(PLAYER_EVENTS.volume, volHandlerRef.current);
				volHandlerRef.current = null;
			}
			if (apRef.current) {
				try { apRef.current.destroy(); } catch { /* 忽略 */ }
				apRef.current = null;
			}
			initializedRef.current = false;
			initFailedRef.current = false;
			initAttemptsRef.current = 0;
		};
	}, []);

	// 引擎容器视觉隐藏（sr-only）：播放 UI 由 PlayerBar / NowPlaying / QueueList 承担，
	// 这里只保留 audio 引擎与事件系统。sr-only 而非 display:none，避免 APlayer
	// 初始化读取布局尺寸时的潜在异常。
	// CDN 加载失败时显示可见的错误横幅 + 重试（不能只藏在 sr-only 里，
	// 否则用户只觉得「无法放歌」而不知道原因）。
	if (loadError) {
		return (
			<>
				<div
					role="alert"
					className="fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-500 shadow-lg backdrop-blur-md"
				>
					<span>⚠ {loadError}</span>
					<button
						type="button"
						onClick={() => {
							initStartedRef.current = false;
							initFailedRef.current = false;
							initAttemptsRef.current = 0;
							setLoadError(null);
							setRetryNonce((n) => n + 1);
						}}
						className="rounded-lg border border-red-500/40 px-2.5 py-1 font-medium text-red-500 transition hover:bg-red-500/15 active:scale-95"
					>
						重试
					</button>
				</div>
				<div ref={containerRef} className="sr-only" aria-hidden="true" />
			</>
		);
	}
	return <div ref={containerRef} className="sr-only" aria-hidden="true" />;
}
