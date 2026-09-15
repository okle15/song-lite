/**
 * RadioButton — 顶栏「电台」开关 + 状态灯。
 *
 * 电台本体是服务端长驻编排器（server/radio/station），前端只是遥控器 +
 * 状态灯：点一下 POST /api/radio/start|stop，开着的时候每 20s 轮询
 * /api/radio/now 拉栏目名和 DJ 口播（title 提示展示最新口播）。
 *
 * 刻意用轮询而不是新开 SSE：player 变化已经有一条 SSE 通道，
 * 电台状态变化频率是分钟级，轮询足够且对「嵌入传统前后端」最友好。
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import { RadioIcon } from './icons';

type NowData = {
	on: boolean;
	program: { name: string } | null;
	djLines: { at: string; text: string }[];
	sessionStats: { plays: number; skips: number };
};

export function RadioButton() {
	const [data, setData] = useState<NowData | null>(null);
	const [busy, setBusy] = useState(false);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const onRef = useRef(false);

	const refresh = async () => {
		try {
			const res = await fetch('/api/radio/now');
			const json = (await res.json()) as { code: number; data?: NowData };
			if (json.code === 0 && json.data) setData(json.data);
		} catch {
			/* 电台接口抖动不影响主界面 */
		}
	};

	// 挂载拉一次初始状态；开台期间轮询（onRef 让定时器读到最新开关态）
	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		refresh();
		if (timerRef.current) clearInterval(timerRef.current);
		timerRef.current = setInterval(() => {
			if (onRef.current) refresh();
		}, 20_000);
		return () => {
			if (timerRef.current) clearInterval(timerRef.current);
		};
	}, []);
	/* eslint-enable react-hooks/set-state-in-effect */

	useEffect(() => {
		onRef.current = data?.on ?? false;
	}, [data]);

	const toggle = async () => {
		setBusy(true);
		try {
			await fetch(onRef.current ? '/api/radio/stop' : '/api/radio/start', { method: 'POST' });
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const on = data?.on ?? false;
	const latestDj = data?.djLines?.[0]?.text;

	return (
		<button
			type="button"
			onClick={toggle}
			disabled={busy}
			aria-label={on ? '收播电台' : '开播电台'}
			aria-pressed={on}
			title={latestDj ? `📻 ${data?.program?.name ?? '电台'}\n${latestDj}` : '开播私人电台（按时段自动编排、长期记住你的口味）'}
			className={`lift flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition ${
				on
					? 'border-brand/50 bg-brand-soft text-brand'
					: 'border-border text-muted hover:bg-surface-2 hover:text-foreground'
			} ${busy ? 'opacity-60' : ''}`}
		>
			<span
				aria-hidden
				className={`h-1.5 w-1.5 rounded-full ${on ? 'animate-pulse bg-brand shadow-[0_0_6px] shadow-brand' : 'bg-muted/50'}`}
			/>
			<span className="hidden lg:inline">{on ? (data?.program?.name ?? '电台播出中') : '电台'}</span>
			<RadioIcon size={14} />
		</button>
	);
}
