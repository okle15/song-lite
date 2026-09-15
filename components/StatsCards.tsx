/**
 * StatsCards — Hero 下方的真实数据三卡 + 7 日活跃趋势。
 *
 * 数据源 GET /api/logs（interaction_logs 表），全部为真实统计，无 mock：
 *  - 播放次数：intent ∈ {play, resume, next} 的条数
 *  - 本地处理：routedTo === 'local' 的占比（环形进度）
 *  - 平均响应：latency 均值（含云端调用，故标签注明「混合」）
 *  - 7 日趋势：按天聚合最近 7 天的交互量
 *
 * 空态与加载态都要体面：无数据时不渲染（避免 Hero 被 0 值卡片撑高），
 * 加载中显示骨架条，失败则静默不显示——统计卡不该抢戏或报错。
 */
'use client';
import { useEffect, useState } from 'react';

type LogItem = {
	intent?: string;
	routedTo?: string;
	latency?: number;
	timestamp?: string;
};

type Stats = {
	total: number;
	plays: number;
	localPct: number;
	avgLatencySec: number;
	days: { label: string; count: number }[];
};

/** 计入「播放」的意图：直接播放、恢复播放、切下一首。 */
const PLAY_INTENTS = new Set(['play', 'resume', 'next']);

function computeStats(logs: LogItem[]): Stats {
	const total = logs.length;
	let plays = 0;
	let local = 0;
	let latencySum = 0;
	let latencyCount = 0;

	// 最近 7 天（含今天）按天聚合，倒序回填保证今天在最右
	const days: { label: string; count: number }[] = [];
	const dayIndex = new Map<string, number>();
	const now = new Date();
	for (let i = 6; i >= 0; i--) {
		const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
		const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
		dayIndex.set(key, days.length);
		days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, count: 0 });
	}

	for (const log of logs) {
		if (log.intent && PLAY_INTENTS.has(log.intent)) plays += 1;
		if (log.routedTo === 'local') local += 1;
		if (typeof log.latency === 'number') {
			latencySum += log.latency;
			latencyCount += 1;
		}
		if (log.timestamp) {
			const d = new Date(log.timestamp);
			const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
			const idx = dayIndex.get(key);
			if (idx !== undefined) days[idx].count += 1;
		}
	}

	return {
		total,
		plays,
		localPct: total > 0 ? Math.round((local / total) * 100) : 0,
		avgLatencySec: latencyCount > 0 ? latencySum / latencyCount / 1000 : 0,
		days,
	};
}

/** 环形进度：本地处理占比。r=15.9 使周长恰好 100，百分比可直接当 dasharray 用。 */
function LocalRing({ pct }: { pct: number }) {
	return (
		<svg viewBox="0 0 40 40" className="h-8 w-8 shrink-0 sm:h-10 sm:w-10" aria-hidden="true">
			<circle cx="20" cy="20" r="15.9" fill="none" stroke="var(--border)" strokeWidth="4" />
			<circle
				cx="20"
				cy="20"
				r="15.9"
				fill="none"
				stroke="url(#statsRingGrad)"
				strokeWidth="4"
				strokeLinecap="round"
				strokeDasharray={`${pct} ${100 - pct}`}
				transform="rotate(-90 20 20)"
			/>
			<defs>
				<linearGradient id="statsRingGrad" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0%" stopColor="var(--brand)" />
					<stop offset="100%" stopColor="var(--brand-2)" />
				</linearGradient>
			</defs>
		</svg>
	);
}

function Card({
	label,
	value,
	unit,
	hint,
}: {
	label: string;
	value: string | number;
	unit?: string;
	hint?: string;
}) {
	return (
		<div className="rounded-xl border border-border bg-surface-2/60 px-2.5 py-2 sm:px-3 sm:py-2.5">
			<div className="truncate text-[11px] text-muted">{label}</div>
			<div className="mt-0.5 flex items-baseline gap-1 whitespace-nowrap">
				<span className="font-display text-xl font-bold tabular-nums text-foreground">{value}</span>
				{unit && <span className="text-[11px] text-muted">{unit}</span>}
			</div>
			{hint && <div className="mt-0.5 truncate text-[10px] text-muted/70">{hint}</div>}
		</div>
	);
}

export function StatsCards() {
	const [stats, setStats] = useState<Stats | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		fetch('/api/logs')
			.then((res) => (res.ok ? res.json() : null))
			.then((json) => {
				if (cancelled) return;
				const logs: LogItem[] = json?.data?.logs ?? [];
				setStats(computeStats(logs));
				setLoading(false);
			})
			.catch(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	if (loading) {
		return (
			<div className="grid grid-cols-3 gap-2">
				{[0, 1, 2].map((i) => (
					<div key={i} className="h-[62px] animate-pulse rounded-xl border border-border bg-surface-2/40" />
				))}
			</div>
		);
	}

	// 无数据 / 请求失败：不渲染，避免用 0 值卡片污染 Hero
	if (!stats || stats.total === 0) return null;

	const maxDay = Math.max(1, ...stats.days.map((d) => d.count));

	return (
		<div className="flex flex-col gap-2.5">
			<div className="grid grid-cols-3 gap-1.5 sm:gap-2">
				<Card label="播放次数" value={stats.plays} unit="次" hint={`共 ${stats.total} 次交互`} />
				<div className="flex items-center gap-1.5 rounded-xl border border-border bg-surface-2/60 px-2.5 py-2 sm:gap-2 sm:px-3 sm:py-2.5">
					<LocalRing pct={stats.localPct} />
					<div className="min-w-0">
						<div className="truncate text-[11px] text-muted">本地处理</div>
						<div className="whitespace-nowrap font-display text-xl font-bold tabular-nums text-foreground">
							{stats.localPct}
							<span className="text-[11px] font-normal text-muted">%</span>
						</div>
					</div>
				</div>
				<Card
					label="平均响应"
					value={stats.avgLatencySec.toFixed(1)}
					unit="s"
					hint="本地 · 云端混合"
				/>
			</div>

			{/* 7 日活跃趋势（迷你柱状，纯展示，柱高按最大值归一化；轨道底色让 0 值天也读得出） */}
			<div className="flex items-end gap-1.5" aria-hidden="true">
				{stats.days.map((d, i) => (
					<div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1">
						<div className="flex h-8 w-full items-end rounded-sm bg-border/60">
							<div
								className="w-full rounded-t bg-gradient-to-t from-brand/40 to-brand transition-[height] duration-500"
								style={{ height: `${Math.max(6, (d.count / maxDay) * 100)}%` }}
								title={`${d.label}：${d.count} 次`}
							/>
						</div>
						<span className="text-[9px] tabular-nums text-muted/70">{d.label}</span>
					</div>
				))}
			</div>
		</div>
	);
}
