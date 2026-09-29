/**
 * QueueList — 播放队列（「接下来播放」）。
 *
 * 读取共享快照里的 queue / queueIndex / state，高亮当前曲目，
 * 点击任意项通过 `/api/player/jump` 跳转播放（与 APlayer listswitch 同一后端）。
 * 当前且正在播放的曲目显示一个小型均衡器动画，强化「正在播放」的感知。
 *
 * ── 2026-09-28：从「只能看」变成「能改」───────────────────────────────
 *
 *  1. **每行一个 ×** → `POST /api/player/queue/remove`。从前队列卡是纯读的：
 *     agent 能换一批（`build_queue`）、能跳（`next_track`），而用户看到队列里有一首
 *     不想听的，唯一能做的事是点它把它**播出来** —— 这是这张卡最刺眼的一处缺口。
 *     语义（删当前项 = 跳到下一首、删到空 = 停止）在 `server/player/state.ts` 的
 *     `removeFromQueue` 上，这里只管界面。
 *  2. **底部「恢复整个曲库」** → `POST /api/player/queue`（`{ trackIds: [] }`）。
 *     它是 agent「来点安静的」那个动作的**退路**。没有它，被换过队列的用户只剩一个
 *     选择：自己再挑一遍。**按钮上写着「从第一首开始播」** —— 那条路由的契约就是
 *     「换一批并开播第一首」，把副作用写在按钮上比事后解释便宜。
 *
 * 两处细节都是踩过才知道的：
 *  - × 是**跳转按钮的兄弟节点**，不是它的子节点（`<button>` 里放 `<button>` 是非法
 *    HTML，里层会被浏览器挤出去，点不到还不报错）；
 *  - 底部那条在**滚动区之外**（`shrink-0`）——「卡片里的主按钮必须固定在滚动区之外」，
 *    队列长到几十首时，按钮不能跟着一起被滚走。
 *
 * ⚠️ 本组件在 `home-client.tsx` 里挂了**两处**（右列卡片 + 底部抽屉），
 * 所以端到端探针的选择器必须限定作用域（`[data-pane-id]` / 抽屉的 `aria-label`）。
 */
'use client';
import { useState } from 'react';
import { usePlayerSnapshot } from './PlayerProvider';
import { CloseIcon, QueueIcon } from './icons';
import { queueFootNote, removalNote, restoreNote } from './queue-view';

export function QueueList() {
	const snap = usePlayerSnapshot();
	const { queue, queueIndex, state, queueSource, queueLabel } = snap;
	const currentPlaying = state === 'playing';

	/** 正在被去掉的那一首。在途时禁用所有 × —— 连点第二次会撞上 404，而那不是失败。 */
	const [removingId, setRemovingId] = useState<string | null>(null);
	const [restoring, setRestoring] = useState(false);
	/**
	 * 上一次动作留下的提示，**连同它被写下时队列的版本**。
	 *
	 * 那些句子讲的都是「你看到的这一份旧了」（如 404「它已经不在队列里了」）——
	 * 队列一换新版本，留着它就是在说一件已经过去的事。所以提示自己带着版本号，
	 * 渲染时对不上就不显示。
	 *
	 * 为什么不用 `useEffect` 去清：那会在每次队列变化后再多渲染一轮，而且
	 * 「effect 里同步 setState」正是 `react-hooks/set-state-in-effect` 拦的写法
	 * （2026-09-28 eslint 当场拦下）。这里是**可以在渲染时算出来的东西**，
	 * 就不该绕道 effect。
	 */
	const [notice, setNotice] = useState<{ text: string; version: string } | null>(null);
	const queueVersion = `${snap.queueSize}|${snap.queueIndex}|${snap.currentTrack?.id ?? ''}`;
	const noticeText = notice && notice.version === queueVersion ? notice.text : null;
	const busy = removingId !== null || restoring;

	const jump = (index: number) => {
		void fetch('/api/player/jump', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index }),
		}).catch(() => {});
	};

	const remove = async (trackId: string) => {
		if (busy) return;
		const version = queueVersion; // 提示属于「我点这一下时的那份列表」
		setRemovingId(trackId);
		try {
			const res = await fetch('/api/player/queue/remove', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ trackId }),
			});
			if (!res.ok) setNotice({ text: removalNote(res.status), version });
		} catch {
			setNotice({ text: removalNote(null), version });
		} finally {
			setRemovingId(null);
		}
	};

	const restore = async () => {
		if (busy) return;
		const version = queueVersion;
		setRestoring(true);
		try {
			const res = await fetch('/api/player/queue', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ trackIds: [] }),
			});
			if (!res.ok) setNotice({ text: restoreNote(res.status), version });
		} catch {
			setNotice({ text: restoreNote(null), version });
		} finally {
			setRestoring(false);
		}
	};

	const foot = queueFootNote(queueSource, queueLabel);

	return (
		<div className="flex h-full min-h-0 flex-col">
			{noticeText && (
				<p className="shrink-0 border-b border-border bg-red-400/10 px-3 py-1.5 text-[10px] leading-snug text-red-400">
					{noticeText}
				</p>
			)}

			<div className="scroll-area min-h-0 flex-1 overflow-y-auto px-2 py-2">
				{queue.length === 0 ? (
					<div className="px-2 py-8 text-center text-xs text-muted">队列为空</div>
				) : (
					<ul className="space-y-0.5">
						{queue.map((item, i) => {
							const active = i === queueIndex;
							return (
								<li
									key={`${item.id}-${i}`}
									className={`flex items-center gap-0.5 rounded-lg pr-1 transition-colors ${
										active ? 'bg-brand-soft' : 'hover:bg-surface-2'
									}`}
								>
									<button
										type="button"
										onClick={() => jump(i)}
										aria-label={`跳到第 ${i + 1} 首：${item.title} - ${item.artist}`}
										className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left"
									>
										{active ? (
											<span className="flex h-4 w-4 shrink-0 items-end justify-center gap-[2px]" aria-hidden>
												<span className="w-[2px] bg-brand rounded-sm animate-[eq_0.9s_ease-in-out_infinite]" style={{ height: '40%' }} />
												<span className="w-[2px] bg-brand rounded-sm animate-[eq_0.9s_ease-in-out_infinite_0.2s]" style={{ height: '90%' }} />
												<span className="w-[2px] bg-brand rounded-sm animate-[eq_0.9s_ease-in-out_infinite_0.4s]" style={{ height: '60%' }} />
											</span>
										) : (
											<span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-muted">
												{i + 1}
											</span>
										)}
										<span className="min-w-0 flex-1">
											<span className="block truncate text-xs font-medium">{item.title}</span>
											<span className="block truncate text-[10px] text-muted">{item.artist}</span>
										</span>
										{active && currentPlaying && (
											<span className="shrink-0 text-[10px] text-brand">播放中</span>
										)}
									</button>

									{/* 去掉这一首。**常显、不靠 hover**（触摸屏没有 hover），且是跳转
									    按钮的兄弟节点（见文件头）。tooltip 单独写，因为它在「正在播的
									    那一行」上的行为和别行不一样（会跳到下一首）。 */}
									<button
										type="button"
										onClick={() => void remove(item.id)}
										disabled={busy}
										aria-label={`从队列去掉 ${item.title} - ${item.artist}`}
										title={
											active
												? '从队列里去掉 · 这是正在播的一首，去掉后会跳到下一首'
												: '从队列里去掉'
										}
										className="shrink-0 rounded-md p-1.5 text-muted/50 transition hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
									>
										<CloseIcon size={13} />
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>

			{/* 底部：解释「为什么这一批不是整个曲库」+ 退回去。在滚动区之外（`shrink-0`）。 */}
			{foot && (
				<div className="shrink-0 space-y-1.5 border-t border-border px-2 py-2">
					<p className="text-[10px] leading-snug text-muted">{foot}</p>
					<button
						type="button"
						onClick={() => void restore()}
						disabled={busy}
						aria-label="恢复整个曲库（会从第一首开始播）"
						className="lift flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-[11px] text-muted transition hover:bg-surface-2 hover:text-foreground disabled:opacity-40"
					>
						<QueueIcon size={13} />
						恢复整个曲库（从第一首开始播）
					</button>
				</div>
			)}
		</div>
	);
}
