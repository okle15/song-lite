/**
 * HistoryCard — `/api/history` 终于有了前端的那个出口（第 7 张卡）。
 *
 * ── 它补的是什么 ──────────────────────────────────────────────────
 * `GET /api/history` 与它的唯一读侧函数 `server/records/play-log.ts#recentPlays`
 * 早就在，`recent_plays` 工具一直在用它回答「我最近听了什么」——**唯一没有的是出口**：
 * 用户看不见模型看到的那份清单，也没法自己重播。所以这张卡不是新功能，是把已有的
 * 能力接上界面（与「记忆」卡、「定时任务」卡同一个形状，这是第三张「清单」卡）。
 *
 * ── 为什么它是一张卡，而不是塞进曲库抽屉 ────────────────────────────
 * 抽屉是**一个弹层**：塞进它等于这块内容不参与合并 / 拆分 / 隐藏 / 持久化，
 * 可用面积也可能被盖住 —— BLUEPRINT §7 错题本记过这个形状（「浮层游离在布局之外」，
 * 当时把对话从右下角浮窗改成布局系统里的一张普通卡才修好）。所以新东西一律
 * **与其它卡同权**；代价是「加一张卡要改四处」，清单在 `AGENTS.md`。
 *
 * ── 为什么每一行都能点（以及点不动时怎么办）─────────────────────────
 * 历史**冗余存了一份曲名 / 歌手**（见 `server/records/play-log.ts`：曲目被移出曲库、
 * 甚至改名之后，这些行还要读得通）。代价是：**一行读得通，不等于那首歌还在**。
 * 点下去才会撞上 404 —— 属于「看着正常、其实已经做不到」的处境，所以 404 有
 * 专门的一句话（「已经不在曲库里了」），而不是笼统的"重播失败"。
 *
 * ── 刷新时机（别把它当通知用）──────────────────────────────────────
 * 两处：**切到这张卡时**（卡片切标签页会重新挂载 → 现取）与 `refreshKey` 变化时
 * （= 刚才发生了一次切歌）。⚠️ **同一首歌重播**不改变这两个信号，所以卡片上会
 * 少一条最新记录，直到下次切歌 —— 它显示的是「你打开它那一刻」的真值，
 * 不是推送。数据是 GET 现取的，刷新即准。
 *
 * ── 顺序 ──────────────────────────────────────────────────────────
 * 照抄服务端（`plays.id` 倒序，新的在前）：**前端不重排**。重排一次就会与模型
 * 看到的 `recent_plays` 顺序不一致，而"哪几条进上下文"正是按这个顺序选的。
 */
'use client';
import { useCallback, useEffect, useState } from 'react';
import { failureNote } from './failure-note';
import { listPhase } from './list-phase';
import { formatPlayedAt } from './local-time';

/**
 * 一行播放历史。
 *
 * 本地定义而不从 `server/records/play-log.ts` 取类型：`components/` 不许 import
 * `server/`（BLUEPRINT §5 的依赖方向），只 `import type` 也不行 —— 那会让人以为
 * 这条边可以走。与 `LibraryGrid.tsx` 里那个本地 `Song` 同一个取舍。
 */
type Play = {
	id: number;
	trackId: string;
	title: string;
	artist: string;
	startedAt: string;
};

export function HistoryCard({ refreshKey }: { refreshKey?: string }) {
	const [plays, setPlays] = useState<Play[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<number | null>(null);
	/** 「你刚才那一下没成」。与 `error` 是两种处境：那一个是整张卡读不到，这一个只是某一次动作失败。 */
	const [notice, setNotice] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			// `limit` 明写 20：这张卡问的是「最近听过什么」，服务端的默认值就是 20，
			// 写出来是为了让读代码的人不必去翻默认值是多少。
			const res = await fetch('/api/history?limit=20');
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { data?: { plays?: Play[] } };
			setPlays(body.data?.plays ?? []);
			setError(null);
		} catch {
			// 读不到就明说，**不静默留空**：空清单看起来和「一次都没放过」一模一样，
			// 而这两件事对用户的意义相反（见 `list-phase.ts` 的头两条规则）。
			setError('读不到播放记录');
		} finally {
			setLoaded(true);
		}
	}, []);

	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		void load();
	}, [load, refreshKey]);
	/* eslint-enable react-hooks/set-state-in-effect */

	const replay = async (p: Play) => {
		setBusyId(p.id);
		setNotice(null);
		try {
			const res = await fetch('/api/player/play', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ trackId: p.trackId }),
			});
			// ⚠️ **必须看 `ok`**：不看的话，404 与网络失败会和成功一样被咽掉，
			// 用户看到的是「点了没反应」—— 分不清是没播、是播了没刷新、还是这行坏了。
			if (res.status === 404) {
				setNotice('这首歌已经不在曲库里了 —— 记录里留着的是当时那一份。');
			} else if (!res.ok) {
				setNotice(failureNote('重播', res.status));
			}
		} catch {
			setNotice(failureNote('重播', null));
		} finally {
			// 成功时也重取：这一下本来就会让历史多一行，看得见才算闭环。
			await load();
			setBusyId(null);
		}
	};

	const view = listPhase({ loaded, error, items: plays });

	if (view.kind === 'error') {
		return (
			<div className="flex h-full min-h-0 items-center justify-center px-3 text-center">
				<div>
					<p className="text-xs text-red-400">读不到播放记录</p>
					{/* 与「一次都没放过」分开说：这件事的下一步是重试，不是接受。 */}
					<p className="mt-1 text-[10px] leading-relaxed text-muted/70">
						记录可能还在，只是这一下没读到
					</p>
				</div>
			</div>
		);
	}

	if (view.kind === 'loading') {
		return (
			<div className="flex h-full min-h-0 items-center justify-center">
				<p className="text-xs text-muted">正在读取…</p>
			</div>
		);
	}

	return (
		<div className="scroll-area h-full min-h-0 overflow-y-auto px-2 py-2">
			{notice && (
				<p className="mb-1 rounded-lg border border-red-400/30 bg-red-400/10 px-2 py-1 text-[10px] leading-snug text-red-400">
					{notice}
				</p>
			)}
			{view.kind === 'empty' ? (
				<div className="px-2 py-6 text-center text-xs text-muted">
					<p>还没有播放记录</p>
					<p className="mt-1 text-[10px] leading-relaxed text-muted/70">
						每开始播一首就记一行 —— 去曲库挑一首试试
					</p>
				</div>
			) : (
				<>
					<ul className="space-y-0.5">
						{view.items.map((p) => (
							<li key={p.id}>
								<button
									type="button"
									onClick={() => void replay(p)}
									disabled={busyId === p.id}
									aria-label={`重播 ${p.title} - ${p.artist}`}
									title="重播这一首"
									className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2 disabled:opacity-50"
								>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-xs font-medium">{p.title}</span>
										<span className="block truncate text-[10px] text-muted">{p.artist}</span>
									</span>
									<span className="shrink-0 text-[10px] tabular-nums text-muted/70">
										{busyId === p.id ? '…' : formatPlayedAt(p.startedAt)}
									</span>
								</button>
							</li>
						))}
					</ul>
					<p className="mt-2 px-2 text-[10px] leading-relaxed text-muted/60">
						每开始播一首记一行（暂停不算）—— 助手答「我最近听了什么」看的就是这一份。
					</p>
				</>
			)}
		</div>
	);
}
