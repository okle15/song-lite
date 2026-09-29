/**
 * LibraryGroups — 曲库**分组浏览**（按歌手 / 专辑 / 风格）。
 *
 * ── 分桶为什么在服务端（本组件一行分桶代码都不写）────────────────────
 * 浏览器手里只有**一页**曲目（limit 12/50）。拿这一页分桶，得到的是
 * 「这一页里出现了哪几个歌手」，而界面上写的是「按歌手（N 组）」——
 * **把「本页」说成「全部」**。这条谎话项目里已经踩过一次（曲库网格曾把
 * `songs.length` 说成「全部多少首」）。所以本组件只做两件事：
 * 问服务端要分组，把拿到的东西画出来。判据写在 `contract/library-groups.ts`。
 *
 * ── 组内成员为什么也要服务端给 ────────────────────────────────────────
 * 点开一个组时**不用「拿组名去搜」代替**：搜索是子串匹配，歌手名可能同时
 * 出现在别人的专辑字段里，于是点一个组会看到组外的歌。成员资格是服务端算的。
 *
 * ── 这个视图里**没有搜索框** ──────────────────────────────────────────
 * 搜索结果的形状是平铺的一页，分组的形状是整库的全部分桶；两者同时生效时
 * 「共 3 组」其实是「这一页里出现了 3 组」。所以分组态下搜索框被禁用
 * （禁用逻辑在 `LibraryGrid`，它持有 `groupBy` 这个状态）。
 */
'use client';
import { useEffect, useState } from 'react';
import {
	GROUP_BY_LABEL,
	type GroupBy,
	type GroupTrackSummary,
	type LibraryGroup,
} from '@/contract/library-groups';
import { listPhase } from './list-phase';
import { PlayIcon } from './icons';

/** 一个组里最多取多少（服务端上限 50）。组通常很小，一次取完。 */
const GROUP_TRACKS_LIMIT = 50;

type GroupsBody = { data?: { by?: string; total?: number; groups?: LibraryGroup[] } };
type TracksBody = {
	data?: { by?: string; key?: string; total?: number; count?: number; songs?: GroupTrackSummary[] };
};

async function readEnvelope<T>(url: string): Promise<T> {
	const res = await fetch(url);
	const json = (await res.json()) as { code?: number; data?: T; message?: string };
	// ⚠️ **必须看 `code`**：只看 HTTP 状态时 4xx/5xx 会和网络失败一样被咽掉，
	// 用户看到的是「点了一个组，什么都没出来」—— 分不清是没读到、还是真的空。
	if (!res.ok || json.code !== 0 || !json.data) {
		throw new Error(json.message ?? `读取失败（HTTP ${res.status}）`);
	}
	return json.data;
}

export function LibraryGroups({
	by,
	currentId,
	onPlay,
}: {
	by: GroupBy;
	/** 正在播的那首（高亮用）。 */
	currentId?: string;
	onPlay: (trackId: string) => void;
}) {
	const [groups, setGroups] = useState<LibraryGroup[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	/** 当前展开的那个组的 key。`null` = 停在分组清单那一层。 */
	const [openKey, setOpenKey] = useState<string | null>(null);
	const [tracks, setTracks] = useState<GroupTrackSummary[]>([]);
	const [tracksLoading, setTracksLoading] = useState(false);
	const [tracksError, setTracksError] = useState<string | null>(null);

	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError(null);
		void (async () => {
			try {
				const data = await readEnvelope<GroupsBody['data']>(
					`/api/library/groups?by=${encodeURIComponent(by)}`,
				);
				if (!alive) return;
				setGroups(data?.groups ?? []);
				setTotal(data?.total ?? 0);
			} catch (err) {
				if (!alive) return;
				setError(err instanceof Error ? err.message : '读取分组失败');
				setGroups([]);
			} finally {
				if (alive) setLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [by]);

	useEffect(() => {
		if (openKey === null) return;
		let alive = true;
		setTracksLoading(true);
		setTracksError(null);
		void (async () => {
			try {
				// `key` 可能是**空串**（tag 维度下的「未打标」那一组），
				// 所以走 URLSearchParams 而不是手拼 —— 服务端用 has('key') 判。
				const params = new URLSearchParams({ by, key: openKey, limit: String(GROUP_TRACKS_LIMIT) });
				const data = await readEnvelope<TracksBody['data']>(`/api/library/groups?${params}`);
				if (!alive) return;
				setTracks(data?.songs ?? []);
			} catch (err) {
				if (!alive) return;
				setTracksError(err instanceof Error ? err.message : '读取这个组失败');
				setTracks([]);
			} finally {
				if (alive) setTracksLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [by, openKey]);
	/* eslint-enable react-hooks/set-state-in-effect */

	const phase = listPhase({ loaded: !loading, error, items: groups });

	if (openKey !== null) {
		const label = groups.find((g) => g.key === openKey)?.label ?? openKey;
		return (
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => setOpenKey(null)}
						className="shrink-0 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted transition hover:bg-surface-2 hover:text-foreground"
					>
						← 全部{GROUP_BY_LABEL[by]}
					</button>
					<span className="min-w-0 truncate text-sm text-foreground">{label}</span>
					<span className="shrink-0 text-[11px] tabular-nums text-muted">
						{tracksLoading ? '读取中…' : `${tracks.length} 首`}
					</span>
				</div>
				{tracksError ? (
					<p className="rounded-lg border border-border px-3 py-2 text-[11px] text-red-400">
						{tracksError}
					</p>
				) : tracksLoading ? (
					<div className="space-y-2">
						{[0, 1, 2].map((i) => (
							<div key={i} className="h-11 animate-pulse rounded-lg bg-surface-2" />
						))}
					</div>
				) : tracks.length === 0 ? (
					<p className="py-6 text-center text-xs text-muted">这个组里现在一首歌都没有</p>
				) : (
					<ul className="space-y-1.5">
						{tracks.map((song) => (
							<li
								key={song.id}
								className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5"
							>
								<button
									type="button"
									onClick={() => onPlay(song.id)}
									aria-label={`播放 ${song.title}`}
									className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-foreground/75 transition hover:bg-surface-2 hover:text-foreground"
								>
									<PlayIcon size={14} />
								</button>
								<div className="min-w-0 flex-1">
									<div
										className={`truncate text-sm ${
											song.id === currentId ? 'text-brand' : 'text-foreground'
										}`}
									>
										{song.title}
									</div>
									<div className="truncate text-[10px] text-muted">
										{by === 'artist'
											? song.album
											: `${song.artist}${song.album ? ` · ${song.album}` : ''}`}
									</div>
								</div>
								{song.tags.length > 0 && (
									<span className="hidden shrink-0 truncate text-[10px] text-muted sm:block">
										{song.tags.join('、')}
									</span>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		);
	}

	if (phase.kind === 'error') {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
				<span className="text-3xl opacity-60">⚠️</span>
				<p className="text-sm">{error}</p>
				<p className="px-6 text-center text-[10px] text-muted/70">
					曲库没有空，只是这一下没读到 —— 重开一次曲库试试
				</p>
			</div>
		);
	}
	if (phase.kind === 'loading') {
		return (
			<div className="space-y-2">
				{[0, 1, 2, 3].map((i) => (
					<div key={i} className="h-11 animate-pulse rounded-lg bg-surface-2" />
				))}
			</div>
		);
	}
	if (phase.kind === 'empty') {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
				<span className="text-3xl opacity-60">🗂</span>
				<p className="text-sm">曲库空空的，没有可分组的曲目</p>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<p className="text-[11px] text-muted">
				共 {total} 首，按{GROUP_BY_LABEL[by]}分成 {groups.length} 组
				{by === 'tag' ? '（一首歌可以有多个标签，各组之和会多于总曲目数）' : ''}
			</p>
			<ul className="space-y-1.5">
				{/* 顺序**照抄服务端**（首数降序 → 名字）：前端重排一次，
				    用户看到的顺序就与服务端算出来的不是一回事了。 */}
				{phase.items.map((group) => (
					<li key={group.key}>
						<button
							type="button"
							onClick={() => setOpenKey(group.key)}
							className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left transition hover:bg-surface-2"
						>
							<span className="min-w-0 flex-1 truncate text-sm text-foreground">{group.label}</span>
							<span className="shrink-0 text-[11px] tabular-nums text-muted">{group.count} 首</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
