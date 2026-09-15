/**
 * radio/station — 私人电台的长驻运行核心。
 *
 * 三块壁垒之三：**长驻运行**。电台是服务端常驻模块（Next.js server 内的
 * 单例，globalThis 防护 dev 模式 HMR 重复启动），每 15 秒 tick 一次：
 *
 *   ┌──────────────── tick ────────────────┐
 *   │ 1. 时段变了？ → 收播旧栏目，编排新栏目 │
 *   │ 2. 队列快见底？ → 追加下一组曲目       │
 *   │ 3. 播放器空转？ → 推进到下一位        │
 *   │ 4. 用户手动暂停？ → 让位，不抢麦       │
 *   └─────────────────────────────────────┘
 *
 * 台里不自己发声：电台只负责编排 + 记忆 + 指令。真正出声的是任何接上来的
 * 播放器客户端（现在 = 浏览器 APlayer；以后 = 任何消费 BFF API 的传统
 * 前端 / 硬件），通过 player-state 的 SSE 快照被驱动 —— 这就是「嵌入
 * 传统前后端」：电台之于播放器，就像电台塔之于收音机。
 *
 * 记忆回流（壁垒之一）：电台订阅 player-state 快照，上一首电台曲目被切走时
 * 按完成度记账 —— 播满 60% 记 play，否则记 skip。长期记忆反哺选曲打分。
 */
import { findSongById, getSongs, type Song } from '@/server/library';
import {
	ensureQueue,
	getSnapshot,
	playTrackById,
	subscribeToPlayerState,
} from '@/server/player/state';
import type { PlayerSnapshot } from '../../contract/player';
import { endProgram, insertProgram, recordPlay, recordSkip } from './memory';
import { daypartForHour, djOutro, planProgram, type ProgramPlan } from './director';
import { memorySummary, recentPrograms, type ProgramRow } from './memory';

/** 单次追加进队列的曲目数（编排档大小） */
const BLOCK_SIZE = 5;
/** 调度心跳间隔 */
const TICK_MS = 15_000;
/** 播放不足总时长 60% 就被切走 → 记跳过（负反馈） */
const SKIP_RATIO = 0.6;
/** 列填充高度下限（防止把台「调没了」） */
const FILL_MIN = 0.15;

export type RadioStatus = {
	on: boolean;
	program: { id: string; name: string; daypartId: string; startedAt: string } | null;
	djLines: { at: string; text: string }[];
	playlist: { id: string; title: string; artist: string; reasons: string[] }[];
	sessionStats: { plays: number; skips: number };
};

type StationState = {
	on: boolean;
	timer: ReturnType<typeof setInterval> | null;
	program: { id: string; name: string; daypartId: string; startedAt: string } | null;
	plan: ProgramPlan | null;
	djLines: { at: string; text: string }[];
	sessionStats: { plays: number; skips: number };
	/** 电台刚喂给播放器、还没在快照里确认开播的曲目 id */
	radioFeeding: string | null;
	/** 换档待执行：等当前这首自然播完后，再切进新栏目（换档不掐歌） */
	switchOnEnd: boolean;
	/** 电台当前（最近）推进的曲目及开始时间 —— 完成度记账用 */
	currentRadioTrack: { id: string; startedAt: number; durationSec: number } | null;
	unsubscribe: (() => void) | null;
};

// dev 模式 HMR 会重新执行模块：用 globalThis 挂单例，台不重开、记忆不丢。
const g = globalThis as unknown as { __radioStation?: StationState };

function station(): StationState {
	if (!g.__radioStation) {
		g.__radioStation = {
			on: false,
			timer: null,
			program: null,
			plan: null,
			djLines: [],
			sessionStats: { plays: 0, skips: 0 },
			radioFeeding: null,
			switchOnEnd: false,
			currentRadioTrack: null,
			unsubscribe: null,
		};
	}
	return g.__radioStation;
}

function say(text: string): void {
	const s = station();
	s.djLines.unshift({ at: new Date().toISOString(), text });
	if (s.djLines.length > 20) s.djLines.length = 20;
	// 便于服务端日志排查（长驻进程的主要可观测面）
	console.log(`[radio] ${text}`);
}

/** 把排片写进播放器队列：replace=整列接管；append=追加到队尾（去重保序）。 */
async function setQueueSequence(ids: string[], mode: 'replace' | 'append'): Promise<void> {
	const songs = await getSongs();
	const byId = new Map(songs.map((s) => [s.id, s]));
	let sequence: Song[] = [];
	if (mode === 'replace') {
		sequence = ids.map((id) => byId.get(id)).filter((s): s is Song => Boolean(s));
	} else {
		const snap = getSnapshot();
		const existing: Song[] = [];
		for (const q of snap.queue) {
			const s = byId.get(q.id);
			if (s) existing.push(s);
		}
		const present = new Set(existing.map((s) => s.id));
		const extra = ids
			.filter((id) => !present.has(id))
			.map((id) => byId.get(id))
			.filter((s): s is Song => Boolean(s));
		sequence = [...existing, ...extra];
	}
	if (sequence.length > 0) ensureQueue(sequence);
}

/**
 * 电台推进：从即将开播的角度确保「队列里有货、该出声就出声」。
 * 用户手动暂停时绝不抢麦。
 */
async function advanceRadio(firstId: string | undefined, force: boolean): Promise<void> {
	if (!firstId) return;
	const snap = getSnapshot();
	if (!force && snap.state === 'paused') return; // 用户暂停 → 让位
	const song = await findSongById(firstId);
	if (!song) return; // 曲库变动导致找不到，tick 下一轮会重排
	const st = station();
	st.radioFeeding = firstId;
	playTrackById(firstId);
}

/** 换栏目：收播旧栏目（归档记忆）→ 按当前时段重新编排 → 口播 → 接管队列。 */
async function rotateProgram(reason: 'open' | 'daypart'): Promise<void> {
	const s = station();
	if (s.program) endProgram(s.program.id);
	const hour = new Date().getHours();
	const songs = await getSongs();
	if (songs.length === 0) {
		say('曲库是空的，没法开播。先把歌放进 MUSIC_DIR 再开台。');
		return;
	}
	const plan = await planProgram({ songs, hour, blockSize: Math.min(BLOCK_SIZE, songs.length) });
	const programId = insertProgram({
		name: plan.name,
		daypartId: plan.daypartId,
		hour: plan.hour,
		trackIds: plan.trackIds,
		djLine: plan.intro,
	});
	const oldName = s.program?.name;
	s.program = {
		id: programId,
		name: plan.name,
		daypartId: plan.daypartId,
		startedAt: new Date().toISOString(),
	};
	s.plan = plan;
	if (reason === 'daypart' && oldName) say(djOutro(oldName, plan.name));
	say(plan.intro);

	if (reason === 'daypart') {
		// 换档不掐歌：正在播的这首让它播完，自然结束的瞬间再切进新栏目
		//（见快照监听里的 switchOnEnd）。电台开着也不该把人正在听的歌拦腰换掉。
		s.switchOnEnd = true;
		return;
	}

	// 开台：整列接管队列，从排片第一首开播（用户暂停中则只排不播，恢复后自然接上）
	await setQueueSequence(plan.trackIds, 'replace');
	await advanceRadio(plan.trackIds[0], reason === 'open');
}

/**
 * player-state 快照订阅 —— 电台的「耳朵」与记账本。
 * 上一首电台曲目被切走时按完成度记 play / skip；新曲是电台排片内的则收编跟踪。
 */
function watchPlayer(): void {
	const s = station();
	if (s.unsubscribe) return;
	let lastTrackId: string | null = getSnapshot().currentTrack?.id ?? null;
	s.unsubscribe = subscribeToPlayerState((snap: PlayerSnapshot) => {
		const st = station();
		const cur = snap.currentTrack?.id ?? null;
		if (cur === lastTrackId) return;
		const prevId = lastTrackId;
		lastTrackId = cur;

		// 1. 上一首电台曲目的完成度记账（自然播完 / 用户跳过统一走这里）
		const prev = st.currentRadioTrack;
		if (prev && prev.id === prevId && cur !== prevId) {
			const playedSec = (Date.now() - prev.startedAt) / 1000;
			if (prev.durationSec > 0 && playedSec < prev.durationSec * SKIP_RATIO) {
				recordSkip(prevId);
				st.sessionStats.skips += 1;
			} else {
				recordPlay(prevId, Math.min(playedSec, prev.durationSec));
				st.sessionStats.plays += 1;
			}
			if (st.currentRadioTrack?.id === prevId) st.currentRadioTrack = null;

			// 换档不掐歌：上一首正好自然播完 → 此刻才是切新栏目的时机
			if (st.switchOnEnd) {
				st.switchOnEnd = false;
				const plan = st.plan;
				if (plan) {
					void setQueueSequence(plan.trackIds, 'replace').then(() =>
						advanceRadio(plan.trackIds[0], false),
					);
				}
			}
		}

		// 2. 新曲入账：电台喂的 → 立即跟踪；排片内自然接续的 → 收编跟踪
		if (cur) {
			if (st.radioFeeding === cur) {
				st.radioFeeding = null;
				st.currentRadioTrack = {
					id: cur,
					startedAt: Date.now(),
					durationSec: st.plan?.durations.get(cur) ?? 240,
				};
			} else if (
				!st.currentRadioTrack &&
				st.plan?.trackIds.includes(cur)
			) {
				st.currentRadioTrack = {
					id: cur,
					startedAt: Date.now(),
					durationSec: st.plan.durations.get(cur) ?? 240,
				};
			}
		}
	});
}

/** 调度心跳。所有异常自吞 —— 电台不能因为一次抖动死掉。 */
async function tick(): Promise<void> {
	const s = station();
	if (!s.on) return;
	try {
		const hour = new Date().getHours();
		const daypart = daypartForHour(hour);
		const snap = getSnapshot();

		// 1. 时段轮换
		if (s.program && s.program.daypartId !== daypart.id) {
			await rotateProgram('daypart');
			return;
		}
		// 2. 开台后还没编出栏目（曲库首次就绪前）→ 先编
		if (!s.program) {
			await rotateProgram('open');
			return;
		}

		if (snap.state === 'paused') return; // 用户暂停中，让位

		// 3. 队列快见底（当前之后剩 ≤1 首）→ 追加下一组同栏目曲目
		const remaining = snap.queue.length - 1 - snap.queueIndex;
		if (remaining <= 1) {
			const songs = await getSongs();
			if (songs.length === 0) return;
			const plan = await planProgram({
				songs,
				hour,
				blockSize: Math.min(BLOCK_SIZE, Math.max(songs.length, 1)),
			});
			s.plan = plan; // 补档沿用当前栏目，打分依据更新为最新一轮
			await setQueueSequence(plan.trackIds, 'append');
			if (snap.state === 'stopped') {
				await advanceRadio(plan.trackIds[0], false);
			}
			return;
		}

		// 4. 播放器空转（用户没暂停但停了）→ 推进到排片下一位
		if (snap.state === 'stopped') {
			const nextId = snap.queue[snap.queueIndex + 1]?.id ?? s.plan?.trackIds[0];
			await advanceRadio(nextId, false);
		}
	} catch (err) {
		console.error('[radio] tick failed:', err);
	}
}

// ────────────────────────── 对外控制面 ──────────────────────────

export async function startStation(): Promise<RadioStatus> {
	const s = station();
	if (s.on) return baseStatus();
	s.on = true;
	s.sessionStats = { plays: 0, skips: 0 };
	watchPlayer();
	say('电台开机，正在翻你的曲库和听歌记忆……');
	await rotateProgram('open');
	if (!s.timer) {
		s.timer = setInterval(() => {
			void tick();
		}, TICK_MS);
		// 不阻止 Node 进程自然退出
		const t = s.timer as unknown as { unref?: () => void };
		t.unref?.();
	}
	return baseStatus();
}

export function stopStation(): RadioStatus {
	const s = station();
	if (s.timer) {
		clearInterval(s.timer);
		s.timer = null;
	}
	if (s.program) endProgram(s.program.id);
	say('电台收播。记忆已归档，下次开机接着讲。');
	s.on = false;
	s.program = null;
	s.plan = null;
	s.currentRadioTrack = null;
	s.switchOnEnd = false;
	return baseStatus();
}

function baseStatus(): RadioStatus {
	const s = station();
	const plan = s.plan;
	return {
		on: s.on,
		program: s.program ? { ...s.program } : null,
		djLines: s.djLines.slice(0, 10),
		playlist:
			plan?.trackIds.map((id) => ({
				id,
				title: id,
				artist: '',
				reasons: plan.reasons.get(id) ?? [],
			})) ?? [],
		sessionStats: { ...s.sessionStats },
	};
}

/** /api/radio/now：状态 + 曲目元数据 + 记忆概况 + 最近节目。 */
export async function getStatusDetailed(): Promise<
	RadioStatus & {
		memory: ReturnType<typeof memorySummary>;
		recentPrograms: ProgramRow[];
		fillFloor: number;
	}
> {
	const base = baseStatus();
	const songs = await getSongs();
	const byId = new Map(songs.map((s) => [s.id, s]));
	const playlist = base.playlist.map((p) => ({
		id: p.id,
		title: byId.get(p.id)?.title ?? p.id,
		artist: byId.get(p.id)?.artist ?? '',
		reasons: p.reasons,
	}));
	return {
		...base,
		playlist,
		memory: memorySummary(),
		recentPrograms: recentPrograms(5),
		fillFloor: FILL_MIN,
	};
}
