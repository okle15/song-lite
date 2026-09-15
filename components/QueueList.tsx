/**
 * QueueList — 播放队列（「接下来播放」）。
 *
 * 读取共享快照里的 queue / queueIndex / state，高亮当前曲目，
 * 点击任意项通过 /api/player/jump 跳转播放（与 APlayer listswitch 同一后端）。
 * 当前且正在播放的曲目显示一个小型均衡器动画，强化「正在播放」的感知。
 */
'use client';
import { usePlayerSnapshot } from './PlayerProvider';

export function QueueList() {
	const snap = usePlayerSnapshot();
	const { queue, queueIndex, state } = snap;
	const currentPlaying = state === 'playing';

	const jump = (index: number) => {
		void fetch('/api/player/jump', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ index }),
		}).catch(() => {});
	};

	return (
		<div className="scroll-area h-full min-h-0 overflow-y-auto px-2 py-2">
			{queue.length === 0 ? (
				<div className="px-2 py-8 text-center text-xs text-muted">队列为空</div>
			) : (
					<ul className="space-y-0.5">
						{queue.map((item, i) => {
							const active = i === queueIndex;
							return (
								<li key={`${item.id}-${i}`}>
									<button
										type="button"
										onClick={() => jump(i)}
										className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors ${
											active
												? 'bg-brand-soft text-brand'
												: 'hover:bg-surface-2'
										}`}
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
								</li>
							);
						})}
					</ul>
				)}
		</div>
	);
}
