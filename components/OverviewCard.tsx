/**
 * OverviewCard — 「概览」卡片内容（原 HomeCarousel 的第一页）。
 *
 * 只负责内容，不带标题栏 / 外壳：外壳与合并能力由 PaneShell 统一提供，
 * 这样概览既能单独成卡，也能和 AI 对话合并成标签页。
 */
'use client';
import { useEffect, useState } from 'react';
import { StatsCards } from './StatsCards';

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function formatClock(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const date = `${d.getMonth() + 1}月${d.getDate()}日`;
	return `现在是 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} · ${WEEK[d.getDay()]} ${date}`;
}

export function OverviewCard() {
	// 首帧不渲染时钟（服务端与客户端秒数必然不同），挂载后再走 interval
	const [now, setNow] = useState('');
	useEffect(() => {
		const tick = () => setNow(formatClock(new Date()));
		tick();
		const t = setInterval(tick, 1000);
		return () => clearInterval(t);
	}, []);

	return (
		<div className="scroll-area flex min-h-0 flex-1 flex-col justify-center gap-3 overflow-y-auto p-5 sm:p-6">
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-muted">
					<span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400" />
					云端同步正常
				</span>
				{now && <span className="text-muted">{now}</span>}
			</div>

			<h2 className="font-display text-2xl leading-snug text-foreground sm:text-3xl">
				只属于你的<span className="text-brand-gradient">音乐空间</span>
			</h2>
			<p className="max-w-xl text-sm leading-relaxed text-muted">
				这里是只给你留灯的音乐角落，把心情、夜晚与收藏慢慢收进来，让每一次播放都像一场小小的仪式。
			</p>

			{/* 真实统计卡（数据来自 /api/logs），无数据时组件自行不渲染 */}
			<StatsCards />
		</div>
	);
}
