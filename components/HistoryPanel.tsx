/**
 * HistoryPanel — 播放历史面板。
 *
 * 从 /api/logs?intent=play 读取播放日志，解析 userInput 中的 trackId 和 result 中的
 * currentTrackTitle 显示。点击历史项重新播放（POST /api/player/play，由 SSE 推给 APlayer）。
 *
 * 下拉框用 fixed 定位贴右边，避免 header flex 容器内 right-0 定位偏移。
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { useEscapeToClose } from './use-escape-to-close';
import { HistoryIcon } from './icons';

type LogEntry = {
	id: string;
	timestamp: string;
	userInput: string;
	result: { state?: string; currentTrackTitle?: string } | null;
};

type HistoryItem = {
	trackId: string;
	title: string;
	timestamp: string;
};

function parseHistoryItem(log: LogEntry): HistoryItem | null {
	// userInput 格式："play <trackId>"
	const match = log.userInput.match(/^play\s+(.+)$/);
	if (!match) return null;
	const trackId = match[1].trim();
	const title = log.result?.currentTrackTitle ?? trackId;
	return { trackId, title, timestamp: log.timestamp };
}

/** ISO 时间戳 → 相对时间（「刚刚 / N 分钟前 / N 小时前 / M/D HH:mm」）。
 *  注意与 player-events.fmtTime 区分：那个是播放进度的 m:ss，单位与用途都不同。 */
function fmtRelativeTime(iso: string): string {
	try {
		const d = new Date(iso);
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		if (diff < 60_000) return '刚刚';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
		const m = d.getMonth() + 1;
		const day = d.getDate();
		const h = d.getHours().toString().padStart(2, '0');
		const min = d.getMinutes().toString().padStart(2, '0');
		return `${m}/${day} ${h}:${min}`;
	} catch {
		return iso;
	}
}

export function HistoryPanel() {
	const [items, setItems] = useState<HistoryItem[]>([]);
	const [open, setOpen] = useState(false);
	const btnRef = useRef<HTMLButtonElement>(null);

	const refresh = async () => {
		try {
			const res = await fetch('/api/logs?intent=play&limit=50');
			if (res.ok) {
				const j = (await res.json()) as { code: number; data?: { logs: LogEntry[]; count: number } };
				if (j.code === 0 && j.data) {
					const parsed = j.data.logs
						.map(parseHistoryItem)
						.filter((x): x is HistoryItem => x !== null);
					// 去重：同一 trackId 只保留最近一次
					const seen = new Set<string>();
					const deduped = parsed.filter((item) => {
						if (seen.has(item.trackId)) return false;
						seen.add(item.trackId);
						return true;
					});
					setItems(deduped);
				}
			}
		} catch {
			/* 忽略 */
		}
	};

	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		if (open) refresh();
	}, [open]);
	/* eslint-enable react-hooks/set-state-in-effect */

	// Esc 关闭
	useEscapeToClose(() => setOpen(false), open);

	// 点击外部关闭
	useEffect(() => {
		if (!open) return;
		const onClick = (e: PointerEvent) => {
			if (btnRef.current && !btnRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener('pointerdown', onClick);
		return () => document.removeEventListener('pointerdown', onClick);
	}, [open]);


	const replay = async (trackId: string) => {
		try {
			await fetch('/api/player/play', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ trackId }),
			});
		} catch {
			/* 忽略 */
		}
		setOpen(false);
	};

	return (
		<div className="relative">
			<button
				ref={btnRef}
				type="button"
				onClick={() => setOpen(!open)}
				aria-label="播放历史"
				aria-expanded={open}
				className="lift flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
				title="播放历史"
			>
				<HistoryIcon size={16} />
				<span className="hidden lg:inline">历史</span>
			</button>
			{open && (
				<div className="card scroll-area fixed right-3 top-12 z-[60] max-h-[70vh] w-[min(16rem,calc(100vw-1.5rem))] overflow-y-auto p-2 shadow-xl">
					<div className="mb-1 flex items-center justify-between">
						<span className="text-[10px] font-medium text-muted">播放历史</span>
						<button onClick={refresh} className="text-[10px] text-muted transition hover:text-foreground">
							刷新
						</button>
					</div>
					{items.length === 0 ? (
						<div className="py-4 text-center text-xs text-muted">暂无播放记录</div>
					) : (
						<ul className="space-y-0.5">
							{items.map((item, i) => (
								<li
									key={`${item.trackId}-${i}`}
									onClick={() => replay(item.trackId)}
									className="cursor-pointer rounded-lg px-2 py-1.5 text-xs text-foreground hover:bg-surface-2"
								>
									<div className="truncate font-medium">{item.title}</div>
									<div className="text-[10px] text-muted">{fmtRelativeTime(item.timestamp)}</div>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
