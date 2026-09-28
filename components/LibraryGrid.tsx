/**
 * LibraryGrid — 曲库网格视图（顶栏入口 + 大抽屉）。
 *
 * 数据源 `GET /api/library/search?q=&limit=&offset=`，服务端搜索 + 250ms debounce
 * （曲库变大后也成立，不做前端全量过滤）。点击卡片 `POST /api/player/play { trackId }`，
 * 服务端会 `ensureQueue` 后切换曲目，SSE 推送回来驱动播放器，前端无需手动维护队列。
 *
 * ── 2026-09-28：补上三处「能力已经在服务端、只是没有出口」 ──────────────
 * 1. **翻页与真实总数**。这条路由的 `limit` **默认 10**，而本组件早先既没传 limit、
 *    也没看返回值里的 `total`，于是把「本页 10 条」写成了「10 首」—— 曲库长过 10 首
 *    之后这是一句**不报错的假话**（BLUEPRINT §3 把「静默截断」点名为曲库长大后的
 *    默认故障）。现在：明写 `limit`、显示服务端给的 `total`、还有更多时给
 *    「加载更多」，并且**服务端说还有却没多给**时明说（那是分页死循环的源头）。
 * 2. **标签可见**。`/api/library/search` 的返回值里**一直带着**每首的 `tags`
 *    （`searchLibrary` 把「库的判断」与「扫描产物」在这一层合流），而前端的本地
 *    `Song` 类型把它丢掉了 —— 于是「库知道每首歌是什么风格」在界面上完全看不见。
 * 3. **标签可改**。`POST /api/library/tags` 的设计初衷写在它自己的文件头里
 *    （「将来前端加「改标签」的入口，走的是同一条路径、同一套校验、同一个信封」），
 *    而那条路此前只有 agent 在走。界面走**同一条 HTTP 路径**，于是写入即
 *    `source='user'`、无条件压过 AI 打标（判定在 `server/library/tags.ts`）——
 *    「谁写的」这件事光看结果看不出来，所以编辑条上把它写出来。
 *
 * 设计要点：
 *  - 封面走 `<TrackCover>`：有内嵌封面就显示真图（`/api/library/cover`），没有才回落到
 *    「标题首字 + 渐变」。`hasCover` 由本接口的响应直接给出，所以无封面的曲目
 *    不会先发一次注定 404 的探测请求。
 *  - hover 才浮出播放按钮（FAB），静态时不遮挡封面。
 *  - 当前播放的卡片常驻高亮 + 音波，让用户知道"正在播这首"。
 *  - ⚠️ 标签行是**播放按钮的兄弟节点**，不是嵌在它里面：`<button>` 里不能放
 *    `<button>` / `<input>`（嵌套的可交互元素是无效 HTML，点击该算谁的说不清）。
 *    这也是为什么编辑条不在卡片里，而是抽屉底部的一整条 —— 单元格只有 ~150px 宽，
 *    输入框 + 两个按钮挤进去后没有一处读得清。
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { usePlayerSnapshot } from './PlayerProvider';
import { failureNote } from './failure-note';
import { listPhase } from './list-phase';
import { planTagSave, tagButtonDisabled, tagButtonLabel } from './tag-editor';
import { fmtTime } from './player-events';
import { useEscapeToClose } from './use-escape-to-close';
import { TrackCover } from './TrackCover';
import { CloseIcon, LibraryIcon, PlayIcon, SearchIcon } from './icons';

type Song = {
	id: string;
	title: string;
	artist: string;
	album?: string;
	durationSec?: number;
	/** 有没有内嵌封面（服务端扫描产物，见 `server/library/scanner.ts`）。 */
	hasCover: boolean;
	/** 风格标签（库里的判断；空数组 = 还没有人标过）。 */
	tags: string[];
};

/** 一次取多少。服务端上限 50 —— 12 在 4 列下正好 3 行，不把首屏撑得太长。 */
const PAGE = 12;
const DEBOUNCE_MS = 250;

type SearchBody = { data?: { songs?: Song[]; total?: number } };

/** 正在编辑的那一条。**存 id 而不是整首**：列表刷新后对象会换，id 不会。 */
type Editing = {
	songId: string;
	title: string;
	text: string;
	/** 服务端记着的「这组标签是谁写的」。没有标签时为 `null`。 */
	source: 'ai' | 'user' | null;
	sourceState: 'loading' | 'ok' | 'error';
};

/** 播放中的均衡器动画（复用 globals.css 的 eq keyframes）。 */
function EqBars() {
	return (
		<span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
			{[0, 1, 2].map((i) => (
				<span
					key={i}
					className="w-[2px] rounded-full bg-brand"
					style={{
						height: '100%',
						animation: 'eq 0.9s ease-in-out infinite',
						animationDelay: `${i * 0.15}s`,
					}}
				/>
			))}
		</span>
	);
}

export function LibraryGrid() {
	const snap = usePlayerSnapshot();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [songs, setSongs] = useState<Song[]>([]);
	/** 命中的**总条数**（服务端给，不受 limit / offset 限制）。0 也要显示对。 */
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	/** 「你刚才那一下没成」。与 `error` 是两种处境：那一个是整页读不到，这一个只是某一次动作失败。 */
	const [notice, setNotice] = useState<string | null>(null);
	const [editing, setEditing] = useState<Editing | null>(null);
	const [saving, setSaving] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// Esc 关闭（与聊天/队列/快捷键面板的 Esc 处理并存：同时打开时会被一起关掉）
	useEscapeToClose(() => setOpen(false), open);

	// 打开后自动聚焦搜索框（曲库第一动作就是找歌）
	useEffect(() => {
		if (!open) return;
		const t = setTimeout(() => inputRef.current?.focus(), 80);
		return () => clearTimeout(t);
	}, [open]);

	// 搜索：仅打开时请求，250ms debounce
	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		if (!open) return;
		// 换词就把编辑态收掉：正在改的那首可能已经不在这一页里了，
		// 留着一个指向不存在卡片的编辑条 = 用户改的是哪一首都说不清。
		setEditing(null);
		setNotice(null);
		setLoading(true);
		let cancelled = false;
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const res = await fetch(
						`/api/library/search?q=${encodeURIComponent(query)}&limit=${PAGE}`,
					);
					if (!res.ok) throw new Error(String(res.status));
					const json = (await res.json()) as SearchBody;
					if (cancelled) return;
					setSongs(json.data?.songs ?? []);
					setTotal(json.data?.total ?? 0);
					setError(null);
				} catch {
					// 读不到**不等于**曲库空了：两件事都渲染成一块空白，但下一步相反
					// （一件是「去别处找」，一件是「再试一次」）。与 `list-phase.ts` 同一条规则。
					if (!cancelled) setError('读不到曲库');
				} finally {
					if (!cancelled) {
						setLoaded(true);
						setLoading(false);
					}
				}
			})();
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query, open]);
	/* eslint-enable react-hooks/set-state-in-effect */

	/**
	 * 四态。**顺序与 `list-phase.ts` 同源**：`error` 先于 `empty`。
	 *
	 * 两处「本地判据」的理由：
	 *  - `loaded: !(loading && songs.length === 0)` —— 首屏那次还没回来时是骨架屏；
	 *    已经有内容时一次在飞的请求不该把网格换回骨架（那是一次可见的闪）。
	 *  - `error: songs.length === 0 ? error : null` —— **已经有内容时，一次失败不接管整页**：
	 *    它只配得到一条提示（`notice`），而这正是 TasksCard 那条「error 与 notice 是两种处境」
	 *    的判据。把已经有 12 张卡的网格换成一个报错页，用户会以为曲库没了。
	 */
	const phase = listPhase({
		loaded: !(loading && songs.length === 0),
		error: songs.length === 0 ? error : null,
		items: songs,
	});

	const playSong = (id: string) => {
		void fetch('/api/player/play', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ trackId: id }),
		}).catch(() => {});
	};

	const loadMore = async () => {
		if (loadingMore) return;
		setLoadingMore(true);
		setNotice(null);
		try {
			const res = await fetch(
				`/api/library/search?q=${encodeURIComponent(query)}&limit=${PAGE}&offset=${songs.length}`,
			);
			if (!res.ok) {
				setNotice(failureNote('加载更多', res.status));
				return;
			}
			const json = (await res.json()) as SearchBody;
			const more = json.data?.songs ?? [];
			setSongs((prev) => [...prev, ...more]);
			setTotal(json.data?.total ?? total);
			// 服务端说还有、却一首都没多给：这就是「翻页死循环」的入口
			// （点一次不增长、按钮也不报错）。说清，而不是让它一直转。
			if (more.length === 0) {
				setNotice('服务端没有再返回更多曲目 —— 曲库可能刚变过，重开一次曲库试试。');
			}
		} catch {
			setNotice(failureNote('加载更多', null));
		} finally {
			setLoadingMore(false);
		}
	};

	const openEditor = (song: Song) => {
		setNotice(null);
		setEditing({
			songId: song.id,
			title: song.title,
			text: song.tags.join(', '),
			source: null,
			sourceState: 'loading',
		});
		// 单独取一次这一首：`source`（ai / user）只有 `/api/library/tags` 给得出，
		// 而「这组标签是谁写的」正是编辑时最该摆出来的事实。
		void (async () => {
			try {
				const res = await fetch(`/api/library/tags?trackId=${encodeURIComponent(song.id)}`);
				if (!res.ok) throw new Error(String(res.status));
				const json = (await res.json()) as { data?: { tag?: { source: 'ai' | 'user' } | null } };
				const tag = json.data?.tag ?? null;
				// 竞态守卫：连点两首时，前一首的响应**后到**不能盖掉这一首的来源
				// （纯序号竞态那一族，见 `panel-layout` 之外的记忆条目）。
				setEditing((cur) =>
					cur && cur.songId === song.id
						? { ...cur, source: tag?.source ?? null, sourceState: 'ok' }
						: cur,
				);
			} catch {
				setEditing((cur) =>
					cur && cur.songId === song.id ? { ...cur, sourceState: 'error' } : cur,
				);
			}
		})();
	};

	/** 编辑条上那句话：**谁写的**。缺了它，「AI 打底 / 用户覆盖」这件事在界面上无处可见。 */
	const sourceHint = (e: Editing): string => {
		if (e.sourceState === 'loading') return '正在读当前标签…';
		if (e.sourceState === 'error') return '读不到当前来源（仍可保存）';
		if (!e.source) return '现在还没有标签';
		return e.source === 'user'
			? '现在这组是你定过的（AI 打标不会再覆盖它）'
			: '现在这组是 AI 打的（你改了就以你为准）';
	};

	const editingSong = editing ? songs.find((s) => s.id === editing.songId) : undefined;
	const plan = editing ? planTagSave(editing.text, editingSong?.tags ?? []) : null;

	const saveTags = async () => {
		if (!editing || !plan || plan.kind === 'noop') return;
		const songId = editing.songId;
		const action = plan.kind === 'clear' ? '清空标签' : '保存标签';
		setSaving(true);
		setNotice(null);
		try {
			const res =
				plan.kind === 'clear'
					? await fetch(`/api/library/tags?trackId=${encodeURIComponent(songId)}`, {
							method: 'DELETE',
						})
					: await fetch('/api/library/tags', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ trackId: songId, tags: plan.tags }),
						});
			// ⚠️ **必须看 `ok`**：不看的话 4xx/5xx 会和网络失败一样被咽掉，
			// 用户看到的是「点了保存，标签没变」—— 分不清是没保存、还是保存了没刷新。
			if (!res.ok) {
				setNotice(failureNote(action, res.status));
				return;
			}
			const json = (await res.json()) as { data?: { tag?: { tags?: string[] } } };
			// 本地用**服务端回的那份**更新：归一化（拆词 / 排序 / 小写）在它那边，
			// 拿我们发出去的原样显示就会与存储不一致 —— 而那种不一致不会报错。
			const next = plan.kind === 'clear' ? [] : (json.data?.tag?.tags ?? plan.tags);
			setSongs((prev) => prev.map((s) => (s.id === songId ? { ...s, tags: next } : s)));
			setEditing(null);
		} catch {
			setNotice(failureNote(action, null));
		} finally {
			setSaving(false);
		}
	};

	const restCount = Math.max(0, total - songs.length);

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-label="曲库"
				aria-expanded={open}
				title="浏览全部曲目"
				className="lift flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
			>
				<LibraryIcon size={15} />
				<span className="hidden lg:inline">曲库</span>
			</button>

			{open && (
				<div className="fixed inset-0 z-[55] flex justify-center p-0 sm:items-center sm:p-6">
					<div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-hidden="true" />

					<div
						role="dialog"
						aria-modal="true"
						aria-label="曲库"
						className="card animate-fade-up relative flex h-full w-full max-w-3xl flex-col overflow-hidden sm:h-[80vh]"
					>
						{/* 头部：搜索 + 计数 + 关闭。三段式的第一段（`shrink-0`）——
						    滚动区里内容再长，搜索框也不会被挤出去。 */}
						<div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
							<div className="relative flex-1">
								<span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
									<SearchIcon size={15} />
								</span>
								<input
									ref={inputRef}
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder="搜索歌名、歌手、专辑…"
									aria-label="搜索曲库"
									className="w-full rounded-full border border-border bg-surface-2 py-1.5 pl-9 pr-3 text-sm text-foreground outline-none transition placeholder:text-muted/70 focus:border-brand/50"
								/>
							</div>
							{/* 计数取服务端的 `total`。**这不是装饰**：早先这里写的是
							    `{songs.length} 首`，而请求默认只取 10 条 —— 曲库长过 10 首之后，
							    那句话会把「本页」说成「全部」。 */}
							<span className="hidden shrink-0 text-xs tabular-nums text-muted sm:block">
								{loaded && total > 0
									? restCount > 0
										? `已显示 ${songs.length} / 共 ${total} 首`
										: `共 ${total} 首`
									: ''}
							</span>
							<button
								type="button"
								onClick={() => setOpen(false)}
								aria-label="关闭曲库"
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

						{/* 网格 */}
						<div className="scroll-area min-h-0 flex-1 overflow-y-auto p-4">
							{phase.kind === 'error' ? (
								<div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
									<span className="text-3xl opacity-60">⚠️</span>
									<p className="text-sm">读不到曲库</p>
									<p className="text-[10px] text-muted/70">曲库没有空，只是这一下没读到</p>
								</div>
							) : phase.kind === 'loading' ? (
								<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
									{[0, 1, 2, 3, 4, 5].map((i) => (
										<div key={i} className="animate-pulse">
											<div className="aspect-square rounded-xl bg-surface-2" />
											<div className="mt-2 h-3 w-3/4 rounded bg-surface-2" />
											<div className="mt-1 h-2.5 w-1/2 rounded bg-surface-2" />
										</div>
									))}
								</div>
							) : phase.kind === 'empty' ? (
								<div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
									<span className="text-3xl opacity-60">🔍</span>
									<p className="text-sm">{query ? `没有找到「${query}」` : '曲库空空的'}</p>
								</div>
							) : (
								<>
									<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
										{phase.items.map((song) => {
											const isCurrent = snap.currentTrack?.id === song.id;
											return (
												<div key={song.id} className="group min-w-0 text-left">
													<button
														type="button"
														onClick={() => playSong(song.id)}
														aria-label={`播放 ${song.title} - ${song.artist}`}
														aria-current={isCurrent ? 'true' : undefined}
														className={`block w-full text-left transition ${
															isCurrent ? '' : 'hover:-translate-y-0.5'
														}`}
													>
														<div className="relative aspect-square overflow-hidden rounded-xl shadow-sm">
															{/* 封面：有内嵌封面读真图，否则回落到首字渐变 */}
															<TrackCover
																id={song.id}
																title={song.title}
																hasCover={song.hasCover}
																className="h-full w-full"
															/>
															{/* hover 悬浮播放 FAB */}
															<span
																className={`absolute inset-0 flex items-center justify-center bg-black/35 transition-opacity ${
																	isCurrent ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'
																}`}
															>
																<span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/95 text-brand shadow-lg transition group-hover:scale-105">
																	<PlayIcon size={20} className="opacity-90" />
																</span>
															</span>
															{/* 当前播放：常驻标记 */}
															{isCurrent && (
																<span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/50 px-2 py-1 backdrop-blur-sm">
																	<EqBars />
																</span>
															)}
														</div>
														<div className="mt-2 min-w-0">
															<div
																className={`truncate text-sm font-medium ${
																	isCurrent ? 'text-brand' : 'text-foreground'
																}`}
															>
																{song.title}
															</div>
															<div className="truncate text-xs text-muted">
																{song.artist}
																{song.durationSec ? ` · ${fmtTime(song.durationSec)}` : ''}
															</div>
														</div>
													</button>

													{/* 标签行 = 改标签的入口。**在播放按钮之外**：
													    输入框不能嵌在 button 里。始终可见（不做 hover 才出现）——
													    触摸屏上根本没有 hover，那等于这个入口不存在。 */}
													<button
														type="button"
														onClick={() => openEditor(song)}
														aria-label={`编辑 ${song.title} 的标签`}
														title="看 / 改这首歌的风格标签（改过就归你，AI 打标不再覆盖）"
														className={`mt-1 flex w-full flex-wrap items-center gap-1 rounded-md px-0.5 py-0.5 text-left transition hover:bg-surface-2 ${
															editing?.songId === song.id ? 'ring-1 ring-brand/60' : ''
														}`}
													>
														{song.tags.length === 0 ? (
															<span className="text-[10px] text-muted/60">＋ 标签</span>
														) : (
															song.tags.map((tag) => (
																<span
																	key={tag}
																	className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted"
																>
																	{tag}
																</span>
															))
														)}
													</button>
												</div>
											);
										})}
									</div>

									{restCount > 0 && (
										<div className="mt-4 text-center">
											<button
												type="button"
												onClick={() => void loadMore()}
												disabled={loadingMore}
												className="rounded-full border border-border px-4 py-1.5 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
											>
												{loadingMore ? '正在加载…' : `加载更多（还有 ${restCount} 首）`}
											</button>
										</div>
									)}
								</>
							)}
						</div>

						{/* 编辑条：抽屉底部一整条（三段式的第三段）。窄单元格里塞不下
						    「输入框 + 两个按钮」，而挤进去的结果是没有一处读得清。 */}
						{editing && (
							<form
								onSubmit={(e) => {
									e.preventDefault();
									void saveTags();
								}}
								className="shrink-0 border-t border-border px-4 py-2.5"
							>
								<div className="flex min-w-0 items-center gap-2">
									<span className="shrink-0 text-[10px] text-muted">
										改「{editing.title}」
									</span>
									<input
										value={editing.text}
										onChange={(e) =>
											setEditing((cur) => (cur ? { ...cur, text: e.target.value } : cur))
										}
										placeholder="民谣, 摇滚"
										aria-label={`${editing.title} 的标签`}
										className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs text-foreground outline-none transition placeholder:text-muted/60 focus:border-brand/50"
									/>
									<button
										type="submit"
										disabled={!plan || saving || tagButtonDisabled(plan)}
										className="shrink-0 rounded-lg bg-brand px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-brand-strong disabled:opacity-40"
									>
										{saving ? '…' : plan ? tagButtonLabel(plan) : '保存'}
									</button>
									<button
										type="button"
										onClick={() => setEditing(null)}
										className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted transition hover:bg-surface-2 hover:text-foreground"
									>
										取消
									</button>
								</div>
								<p className="mt-1 truncate text-[10px] text-muted/70">{sourceHint(editing)}</p>
							</form>
						)}
					</div>
				</div>
			)}
		</>
	);
}
