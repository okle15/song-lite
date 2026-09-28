/**
 * TasksCard — ⑩ 触发器终于有了界面（第 5 张卡）。
 *
 * 在这之前，「排过的事」只能靠对话问出来（`list_scheduled_tasks`），想撤回还得
 * 再说一句。这张卡把三件事变成**看得见、点得到**：排在什么时候 / 按什么频率重复 /
 * 撤回；另外把最近做过的摆出来（成没成、为什么没成）。
 *
 * 为什么这张卡不是「有对话就够了」：
 * ⑩ 是唯一一个**在用户离开之后才发生**的部件 —— 事有没有做、做对没做对，都不在
 * 这一轮对话里。没有界面时，它唯一的失败发现路径是「用户某天偶然想起来去问一句」。
 * `attempts`（重试过几次 = 卡住过几次的痕迹）与 `lastError` 正是为这件事记的
 * （见 `server/agent/tasks.ts`），摆到这里才算把这些列真的用完。
 *
 * ⚠️ **触发不在这里**：本卡只读写清单（`GET` / `PATCH /api/tasks`）。执行在
 * `POST /api/tasks/tick`，设计上留给部署环境的 cron —— 「没人打点就一定不执行」
 * 是 ⑩ 的已知边界，不是这张卡的缺陷。
 */
'use client';
import { useCallback, useEffect, useState } from 'react';
import { repeatLabel, type Task, type TaskStatus } from '@/contract/task';
import { formatScheduledAt } from './local-time';

const STATUS_LABEL: Record<TaskStatus, string> = {
	pending: '待执行',
	running: '执行中',
	done: '已完成',
	failed: '失败',
	cancelled: '已撤回',
};

/** 状态配色。`failed` 用红色是唯一让它「看得见」的办法 —— 它和 muted 混在一起时没人会注意。 */
function statusClass(status: TaskStatus): string {
	if (status === 'failed') return 'text-red-400';
	if (status === 'running') return 'text-brand';
	if (status === 'done') return 'text-emerald-400';
	return 'text-muted';
}

/*
 * 时间给人看的样子（`09-24 周四 07:00`）现在住在 `./local-time.ts` —— 「播放历史」卡
 * 也要把 ISO 串摆到界面上，两处各写一份就是同一份规则两处实现。
 * 两处的**需求不同**（排期要一个不会动的锚，历史要相对距离），所以那边是两个导出。
 */

type TaskList = { open: Task[]; closed: Task[] };

export function TasksCard({ refreshKey }: { refreshKey?: number }) {
	const [list, setList] = useState<TaskList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	/**
	 * 「你刚才那一下没成」的一句话。与 `error` 是**两种处境**，所以两个状态：
	 * `error` = 整张卡读不到清单（这张卡现在没用），`notice` = 清单是真的、只有那一次动作失败。
	 * 合成一个的话，撤回失败会把整张可用的清单换成一个报错页。
	 */
	const [notice, setNotice] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch('/api/tasks');
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { data?: TaskList };
			setList({ open: body.data?.open ?? [], closed: body.data?.closed ?? [] });
			setError(null);
		} catch {
			// 读不到就明说。**不静默留空**：空清单看起来和「一件都没排」一模一样，
			// 而这两件事对用户的意义完全相反（一个是"我做过了"，一个是"看不到"）。
			setError('读不到任务清单');
		}
	}, []);

	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		void load();
	}, [load, refreshKey]);
	/* eslint-enable react-hooks/set-state-in-effect */

	const cancel = async (id: string) => {
		setBusyId(id);
		setNotice(null);
		try {
			const res = await fetch('/api/tasks', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id }),
			});
			// ⚠️ **必须看 `ok`**。不看的话，400（id 不对 / 参数错）与 500 会和网络失败
			// 一样被咽掉，而用户看到的是「点了撤回，列表没变」——他分不清是没撤掉、
			// 是撤掉了没刷新、还是这个按钮坏了。**静默失败的控制件与坏掉的控制件长得一样。**
			if (!res.ok) setNotice(`撤回没成功（服务端回了 ${res.status}）—— 这件任务还在。`);
		} catch {
			setNotice('撤回没成功（网络没通）—— 这件任务还在。');
		} finally {
			await load();
			setBusyId(null);
		}
	};

	if (error) {
		return (
			<div className="flex h-full min-h-0 items-center justify-center px-3 text-center">
				<p className="text-xs text-red-400">{error}</p>
			</div>
		);
	}

	if (!list) {
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
			{list.open.length === 0 ? (
				<div className="px-2 py-6 text-center text-xs text-muted">
					<p>还没有排期的事</p>
					<p className="mt-1 text-[10px] leading-relaxed text-muted/70">
						跟助手说「明天早上七点放首歌」试试
					</p>
				</div>
			) : (
				<ul className="space-y-1">
					{list.open.map((t) => (
						<li key={t.id} className="group rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2">
							<div className="flex items-start gap-2">
								<div className="min-w-0 flex-1">
									<p className="truncate text-xs font-medium" title={t.goal}>
										{t.goal}
									</p>
									<p className="mt-0.5 text-[10px] text-muted">
										<span className="tabular-nums">{formatScheduledAt(t.dueAt)}</span>
										{repeatLabel(t.repeat, t.repeatDays) && (
											<span className="ml-1.5 text-brand/80">
												{repeatLabel(t.repeat, t.repeatDays)}
											</span>
										)}
										{/* 重试过 = 卡住过。摆出来而不是等用户自己发现。 */}
										{t.attempts > 0 && (
											<span className="ml-1.5 text-amber-400/90">已试 {t.attempts} 次</span>
										)}
									</p>
								</div>
								<button
									type="button"
									onClick={() => void cancel(t.id)}
									disabled={busyId === t.id}
									title="撤回这件任务（不可逆）"
									className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted transition hover:bg-surface-3 hover:text-foreground disabled:opacity-40"
								>
									{busyId === t.id ? '…' : '撤回'}
								</button>
							</div>
						</li>
					))}
				</ul>
			)}

			{list.closed.length > 0 && (
				<div className="mt-3 border-t border-border pt-2">
					<p className="px-2 pb-1 text-[10px] font-semibold text-muted/70">最近</p>
					<ul className="space-y-1">
						{list.closed.map((t) => (
							<li key={t.id} className="px-2 py-1">
								<div className="flex items-baseline gap-2">
									<p className="min-w-0 flex-1 truncate text-[11px] text-muted" title={t.goal}>
										{t.goal}
									</p>
									<span className={`shrink-0 text-[10px] ${statusClass(t.status)}`}>
										{STATUS_LABEL[t.status]}
									</span>
								</div>
								{/* 结论优先、错误兜底：做成了说"放了哪首"，没做成说为什么。 */}
								{(t.result || t.lastError) && (
									<p
										className={`mt-0.5 truncate pl-0 text-[10px] ${
											t.result ? 'text-muted/70' : 'text-red-400/80'
										}`}
										title={t.result ?? t.lastError ?? ''}
									>
										{t.result ?? t.lastError}
									</p>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
