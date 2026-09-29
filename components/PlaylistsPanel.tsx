/**
 * PlaylistsPanel — 歌单面板（顶栏入口 + 大抽屉，两个视图）。
 *
 * ── 两个视图，不是一个 ──────────────────────────────────────────
 * 「歌单列表」与「某一份歌单的曲目」分开取数：列表只带**计数**（`count` 由 SQL 数出来），
 * 点进去才拉曲目。合成一个请求的后果是曲库大起来之后「看看我有哪些歌单」也要拉回
 * 几千首 —— 而那种慢在只有几首歌时完全看不出来。
 *
 * ── 写侧的纪律（这个面板最容易做错的地方）───────────────────────────
 * 1. **没有「改整份」这个动作**。加 = 追加；删 = 按 id 删那一项。
 *    「把这一批写回去」会把本组件看得见的那一页当成全部 —— 用户的歌单被悄悄换走，
 *    而两次都不报错（判据见 `contract/playlist.ts` 文件头）。
 * 2. **删只按 id**。列表渲染出来的是某个顺序，但那个顺序不是身份；
 *    按下标删的那一天就是删错歌的那一天。
 * 3. **删整份歌单要问一句**（`window.confirm`）：它是用户攒的东西、删了没有回收站。
 *    而「从歌单里去掉一首」**不问** —— 那完全可逆，且删错了一眼就能看出来。
 *
 * ── 「导入」在这里的形状 ──────────────────────────────────────────
 * 两种：① 新建时带一批（从曲库里选好再存）；② **把当前队列存成歌单**
 * （队列是"此刻这一批"，队列卡里没有"存下来"的按钮，而那正是用户最想存的东西）。
 * 没有第三种（不从文件导入 m3u —— 那需要一个解析器，而它的输入格式由别人定）。
 */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerSnapshot } from './PlayerProvider';
import { failureNote } from './failure-note';
import { listPhase } from './list-phase';
import {
	PLAYLIST_NAME_MAX,
	type PlaylistDetail,
	type PlaylistSummary,
	type PlaylistTrack,
} from '@/contract/playlist';
import { useEscapeToClose } from './use-escape-to-close';
import { CloseIcon, PlayIcon, PlaylistIcon, TrashIcon } from './icons';

type ListBody = { data?: { playlists?: PlaylistSummary[] } };
type OneBody = {
	data?: { playlist?: PlaylistDetail; added?: number; skipped?: number; removed?: boolean };
};

/** 两个视图。**存 id 不存整份**：清单刷新后对象会换，id 不会。 */
type View = { kind: 'list' } | { kind: 'detail'; id: string };

export function PlaylistsPanel() {
	const snap = usePlayerSnapshot();
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<View>({ kind: 'list' });
	const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
	const [detail, setDetail] = useState<PlaylistDetail | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 「你刚才那一下没成」。与 `error` 是两种处境：那一个是整个视图读不到。 */
	const [notice, setNotice] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEscapeToClose(() => setOpen(false), open);

	// 打开 / 切视图时取数
	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		void (async () => {
			try {
				if (view.kind === 'list') {
					const res = await fetch('/api/playlists');
					if (!res.ok) throw new Error(String(res.status));
					const json = (await res.json()) as ListBody;
					if (cancelled) return;
					setPlaylists(json.data?.playlists ?? []);
				} else {
					const res = await fetch(`/api/playlists/items?id=${encodeURIComponent(view.id)}`);
					if (!res.ok) throw new Error(String(res.status));
					const json = (await res.json()) as OneBody;
					if (cancelled) return;
					setDetail(json.data?.playlist ?? null);
				}
				setError(null);
			} catch {
				// 读不到 ≠ 没有。两件事都渲染成一块空白，但下一步相反。
				if (!cancelled) setError('读不到歌单');
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, view]);
	/* eslint-enable react-hooks/set-state-in-effect */

	// 两个视图的"条目"类型不同（歌单 vs 曲目），但四态的判据是同一条，所以并成一个
	// 联合类型交给 `listPhase` —— 它只关心「有几条」与「有没有读到」。
	const items: (PlaylistSummary | PlaylistTrack)[] =
		view.kind === 'list' ? playlists : (detail?.tracks ?? []);
	const phase = listPhase({
		loaded: !(loading && items.length === 0),
		error,
		items,
	});

	/** 统一的写请求。**必须看 `ok`**：不看的话 4xx/5xx 会和网络失败一样被咽掉。 */
	const write = useCallback(
		async (
			input: string,
			init: RequestInit,
			action: string,
			onOk: (json: OneBody) => void,
		) => {
			setNotice(null);
			setBusy(true);
			try {
				const res = await fetch(input, init);
				if (!res.ok) {
					setNotice(failureNote(action, res.status));
					return;
				}
				const json = (await res.json()) as OneBody;
				onOk(json);
			} catch {
				setNotice(failureNote(action, null));
			} finally {
				setBusy(false);
			}
		},
		[],
	);

	const create = async (trackIds: string[] = []) => {
		const trimmed = name.trim();
		if (!trimmed) return;
		await write(
			'/api/playlists',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(trackIds.length ? { name: trimmed, trackIds } : { name: trimmed }),
			},
			'新建歌单',
			(json) => {
				setName('');
				// 切到列表并刷新：刚建的那份要出现在那儿，否则用户会以为没成
				setView({ kind: 'list' });
				setPlaylists((prev) => (json.data?.playlist ? [...prev, json.data.playlist] : prev));
			},
		);
	};

	/** 把当前队列存成歌单 —— 「导入」的第二种形状（第一种是新建时带一批）。 */
	const saveQueue = async () => {
		const ids = snap.queue.map((q) => q.id);
		if (ids.length === 0) {
			setNotice('当前队列是空的，没有可存的。');
			return;
		}
		const trimmed = name.trim() || `队列 ${new Date().toLocaleDateString('zh-CN')}`;
		await write(
			'/api/playlists',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: trimmed, trackIds: ids }),
			},
			'存成歌单',
			(json) => {
				setName('');
				setView({ kind: 'list' });
				setPlaylists((prev) => (json.data?.playlist ? [...prev, json.data.playlist] : prev));
			},
		);
	};

	const removePlaylist = async (p: PlaylistSummary) => {
		// ⚠️ 删整份要问一句：它是用户攒的东西，删了没有回收站。
		if (!window.confirm(`删掉歌单「${p.name}」？里面的 ${p.count} 首会一起没有，且无法恢复。`)) return;
		setNotice(null);
		setBusy(true);
		try {
			const res = await fetch(`/api/playlists?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' });
			if (!res.ok) {
				setNotice(failureNote('删除歌单', res.status, '—— 它还在。'));
				return;
			}
			setPlaylists((prev) => prev.filter((x) => x.id !== p.id));
			if (view.kind === 'detail' && view.id === p.id) setView({ kind: 'list' });
		} catch {
			setNotice(failureNote('删除歌单', null, '—— 它还在。'));
		} finally {
			setBusy(false);
		}
	};

	const addCurrent = async () => {
		if (view.kind !== 'detail') return;
		const track = snap.currentTrack;
		if (!track) {
			setNotice('现在没有在放歌，没有可加的。');
			return;
		}
		await write(
			'/api/playlists/items',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: view.id, trackIds: [track.id] }),
			},
			'加入歌单',
			(json) => {
				if (json.data?.playlist) setDetail(json.data.playlist);
				// 「本来就在里面」不是失败，但要说出来 —— 否则用户以为加了、其实是重复。
				if (json.data?.added === 0) setNotice('这首本来就在里面，没有重复加。');
			},
		);
	};

	const removeTrack = async (trackId: string) => {
		if (view.kind !== 'detail') return;
		await write(
			`/api/playlists/items?id=${encodeURIComponent(view.id)}&trackId=${encodeURIComponent(trackId)}`,
			{ method: 'DELETE' },
			'从歌单里去掉',
			(json) => {
				// 用**服务端回的整份**更新，而不是本地猜着删 —— 计数与顺序都以它为准。
				if (json.data?.playlist) setDetail(json.data.playlist);
			},
		);
	};

	/** 放这一整份 → 走队列路由（与 `build_queue` 的 playlistId 同一条路）。 */
	const play = async (p: PlaylistDetail) => {
		if (p.tracks.length === 0) {
			setNotice('这份歌单是空的，先往里加几首。');
			return;
		}
		setNotice(null);
		try {
			const res = await fetch('/api/player/queue', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					trackIds: p.tracks.map((t) => t.trackId),
					label: `歌单「${p.name}」`,
				}),
			});
			if (!res.ok) setNotice(failureNote('播放歌单', res.status));
		} catch {
			setNotice(failureNote('播放歌单', null));
		}
	};

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-label="歌单"
				aria-expanded={open}
				title="我的歌单"
				className="lift flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
			>
				<PlaylistIcon size={15} />
				<span className="hidden lg:inline">歌单</span>
			</button>

			{open && (
				<div className="fixed inset-0 z-[55] flex justify-center p-0 sm:items-center sm:p-6">
					<div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden="true" />

					<div
						role="dialog"
						aria-modal="true"
						aria-label="歌单"
						className="card animate-fade-up relative flex h-full w-full max-w-xl flex-col overflow-hidden sm:h-[70vh]"
					>
						{/* 头部（三段式第一段） */}
						<div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
							{view.kind === 'detail' && (
								<button
									type="button"
									onClick={() => setView({ kind: 'list' })}
									aria-label="返回歌单列表"
									className="shrink-0 rounded-lg px-1.5 py-1 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
								>
									←
								</button>
							)}
							<div className="min-w-0 flex-1 truncate text-sm font-semibold">
								{view.kind === 'list' ? '我的歌单' : (detail?.name ?? '歌单')}
							</div>
							<button
								type="button"
								onClick={() => setOpen(false)}
								aria-label="关闭歌单"
								className="shrink-0 rounded-lg p-1 text-muted transition hover:bg-surface-2 hover:text-foreground"
							>
								<CloseIcon size={18} />
							</button>
						</div>

						{notice && (
							<p className="shrink-0 border-b border-border bg-red-400/10 px-4 py-1.5 text-[10px] leading-snug text-red-400">
								{notice}
							</p>
						)}

						{/* 滚动区 */}
						<div className="scroll-area min-h-0 flex-1 overflow-y-auto p-4">
							{phase.kind === 'error' ? (
								<div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
									<span className="text-3xl opacity-60">⚠️</span>
									<p className="text-sm">读不到歌单</p>
									<p className="text-[10px] text-muted/70">歌单没有空，只是这一下没读到</p>
								</div>
							) : phase.kind === 'loading' ? (
								<div className="space-y-2">
									{[0, 1, 2].map((i) => (
										<div key={i} className="h-11 animate-pulse rounded-lg bg-surface-2" />
									))}
								</div>
							) : view.kind === 'list' ? (
								phase.kind === 'empty' ? (
									<div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
										<span className="text-3xl opacity-60">🎵</span>
										<p className="text-sm">还没有歌单</p>
										<p className="px-6 text-center text-[10px] text-muted/70">
											在下面取个名字就能建；也可以把当前队列存成一份
										</p>
									</div>
								) : (
									<ul className="space-y-1.5">
										{playlists.map((p) => (
											<li
												key={p.id}
												className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5"
											>
												<button
													type="button"
													onClick={() => setView({ kind: 'detail', id: p.id })}
													className="min-w-0 flex-1 truncate text-left text-sm transition hover:text-brand"
												>
													{p.name}
													<span className="ml-1.5 text-[10px] text-muted">{p.count} 首</span>
												</button>
												<button
													type="button"
													onClick={() => void removePlaylist(p)}
													aria-label={`删除歌单 ${p.name}`}
													title="删掉整份歌单"
													className="shrink-0 rounded-md p-1 text-muted transition hover:bg-surface-2 hover:text-foreground"
												>
													<TrashIcon size={14} />
												</button>
											</li>
										))}
									</ul>
								)
							) : detail === null ? null : detail.tracks.length === 0 ? (
								<div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
									<span className="text-3xl opacity-60">🎵</span>
									<p className="text-sm">这份歌单是空的</p>
									<p className="px-6 text-center text-[10px] text-muted/70">
										点下面的「＋ 当前播放」加一首，或对助手说「把这首加到这个歌单」
									</p>
								</div>
							) : (
								<ul className="space-y-1.5">
									{detail.tracks.map((t) => (
										<li
											key={t.trackId}
											className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5"
										>
											<button
												type="button"
												onClick={() =>
													void fetch('/api/player/play', {
														method: 'POST',
														headers: { 'Content-Type': 'application/json' },
														body: JSON.stringify({ trackId: t.trackId }),
													}).catch(() => {})
												}
												disabled={t.missing}
												aria-label={t.missing ? `${t.title}（文件已不在曲库）` : `播放 ${t.title}`}
												className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground/75 transition hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
											>
												<PlayIcon size={14} />
											</button>
											<div className="min-w-0 flex-1">
												<div
													className={`truncate text-sm ${
														t.trackId === snap.currentTrack?.id ? 'text-brand' : 'text-foreground'
													}`}
												>
													{t.title}
												</div>
												<div className="truncate text-[10px] text-muted">
													{t.missing ? '文件已不在曲库（可能改过名或被移走）' : t.artist}
												</div>
											</div>
											{/* 去掉一首：按 id，且**不问确认** —— 完全可逆、一眼能看出来 */}
											<button
												type="button"
												onClick={() => void removeTrack(t.trackId)}
												aria-label={`从歌单里去掉 ${t.title}`}
												title="从这份歌单里去掉（歌本身还在曲库里）"
												className="shrink-0 rounded-md p-1 text-muted transition hover:bg-surface-2 hover:text-foreground"
											>
												<CloseIcon size={14} />
											</button>
										</li>
									))}
								</ul>
							)}
						</div>

						{/* 底部操作区（三段式第三段：滚动区再长也挤不出去） */}
						<div className="shrink-0 border-t border-border px-4 py-2.5">
							<div className="flex items-center gap-2">
								<input
									ref={inputRef}
									value={name}
									onChange={(e) => setName(e.target.value)}
									maxLength={PLAYLIST_NAME_MAX}
									placeholder="新歌单的名字"
									aria-label="新歌单的名字"
									className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs text-foreground outline-none transition placeholder:text-muted/60 focus:border-brand/50"
								/>
								<button
									type="button"
									onClick={() => void create()}
									disabled={busy || !name.trim()}
									className="shrink-0 rounded-lg bg-brand px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-brand-strong disabled:opacity-40"
								>
									新建
								</button>
								<button
									type="button"
									onClick={() => void saveQueue()}
									disabled={busy || snap.queue.length === 0}
									title={
										snap.queue.length === 0
											? '当前队列是空的'
											: `把当前这 ${snap.queue.length} 首存成一份歌单`
									}
									className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted transition hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
								>
									存当前队列
								</button>
							</div>
							{view.kind === 'detail' && detail && (
								<div className="mt-2 flex items-center gap-2">
									<button
										type="button"
										onClick={() => void play(detail)}
										disabled={busy || detail.tracks.length === 0}
										className="rounded-lg bg-brand px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-brand-strong disabled:opacity-40"
									>
										放这一整份
									</button>
									<button
										type="button"
										onClick={() => void addCurrent()}
										disabled={busy || !snap.currentTrack}
										title={snap.currentTrack ? `把「${snap.currentTrack.title}」加进来` : '现在没有在放歌'}
										className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted transition hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
									>
										＋ 当前播放
									</button>
								</div>
							)}
						</div>
					</div>
				</div>
			)}
		</>
	);
}
