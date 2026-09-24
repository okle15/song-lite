/**
 * MemoryCard — ⑥ 记忆终于有了「看得见」的那一面（第 6 张卡）。
 *
 * ── 它补的是什么 ──────────────────────────────────────────────────
 * 在这之前，偏好只有「写」（`remember_preference` 工具）与「用」（每轮注入系统
 * 提示词），**没有「看」**。而 `prompt.ts` 铁律 6 的原文自己写着这条风险：
 *
 *     **记错比不记更糟**：它会长期影响以后每一次对话，而用户不知道你记了什么。
 *
 * 「用户不知道」一直被写成一个风险，却没有出口。`GET /api/preferences` 这条路
 * 早就在，`app/api/preferences/route.ts` 的文件头甚至提前写下了「将来前端加一个
 * 「管理我的偏好」面板，走的是同一条路径、同一套校验、同一个信封」—— 那个面板
 * 到今天才做。所以这张卡**不是新功能**，是把已有的能力接上出口
 * （阶段 3c「路由本来就存在、缺的只是工具」的同一个形状）。
 *
 * ── 为什么它值得占一张卡 ──────────────────────────────────────────
 * ⑥ 是 `LEARNING.md` 说的「**唯一不会被模型换代抹平的东西**」——模型换了，
 * 你攒下的口味还在。所以「它记住了什么」是用户唯一真正拥有的长期资产，
 * 而在此之前，它的存在只能靠用户回忆自己说过哪些话。更糟的是：**记错的代价是
 * 每一次对话都被污染**，而发现它的唯一路径是「某天偶然听出不对」。
 *
 * ── 边界（别越界）──────────────────────────────────────────────────
 * 本卡只做两件事：**看得见**（列出）与**撤得回**（逐条删）。
 * **没有「手动新增」的表单** —— 偏好是 agent 对用户的理解，不是用户自己填的配置项。
 * README 里那张被有意删掉的「偏好设置」面板不在本项目范围内；这里补的是
 * 「AI 的长期记忆要可审计、可撤回」，两件事的判据不同（见 `LEARNING.md` §2 的
 * 「人在哪里介入」）。
 *
 * ⚠️ **删除不再走一遍确认**：`forget_preference` 工具那头有 `toolApproval`
 * （判据是「删的是用户的东西」，见 `agent/run.ts`），而**卡上这个按钮是用户亲手点的**
 * —— 那一下本身就是确认动作。再弹一层确认等于把同一个决定问两遍，只会让人点得变钝。
 * 但「删没删掉」必须看得见：失败走 `forgetFailed()` 的那两句提示，绝不静默。
 */
'use client';
import { useCallback, useEffect, useState } from 'react';
import type { Preference } from '@/contract/preference';
import { forgetFailed, memoryView } from './memory-view';

export function MemoryCard({ refreshKey }: { refreshKey?: number }) {
	const [items, setItems] = useState<Preference[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyKey, setBusyKey] = useState<string | null>(null);
	/** 「你刚才那一下没成」。与 `error` 是两种处境：那一个是整张卡读不到，这一个只是某一次动作失败。 */
	const [notice, setNotice] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			// 不带 limit：走服务端的默认值（`MAX_INJECTED_PREFERENCES`）——
			// 与「注入系统提示词」用的是同一个函数、同一个默认值，所以
			// **这张卡上列出来的，就是它现在真的知道的全部**。
			// 传一个更大的 limit 会列出一些永远不进对话的行，那是在制造管理负担。
			const res = await fetch('/api/preferences');
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { data?: { preferences?: Preference[] } };
			setItems(body.data?.preferences ?? []);
			setError(null);
		} catch {
			// 读不到就明说。**不静默留空**：空列表看起来和「它还没记住任何事」
			// 一模一样，而这两件事对用户的意义相反（一个是"我很干净"，
			// 一个是"我在看一份不可信的东西"）。这条判据在 `memory-view.ts` 里。
			setError('读不到记忆');
		} finally {
			setLoaded(true);
		}
	}, []);

	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		void load();
	}, [load, refreshKey]);
	/* eslint-enable react-hooks/set-state-in-effect */

	const forget = async (key: string) => {
		setBusyKey(key);
		setNotice(null);
		try {
			const res = await fetch(`/api/preferences?key=${encodeURIComponent(key)}`, {
				method: 'DELETE',
			});
			// ⚠️ **必须看 `ok`**：不看的话 4xx/5xx 会和网络失败一样被咽掉，
			// 用户看到的是「点了忘掉，列表没变」—— 分不清是没删掉、还是删掉了没刷新。
			if (!res.ok) setNotice(forgetFailed(res.status));
		} catch {
			setNotice(forgetFailed(null));
		} finally {
			await load();
			setBusyKey(null);
		}
	};

	const view = memoryView({ loaded, error, items });

	if (view.kind === 'error') {
		return (
			<div className="flex h-full min-h-0 items-center justify-center px-3 text-center">
				<div>
					<p className="text-xs text-red-400">读不到记忆</p>
					{/* 与「还没记住任何事」分开说：这件事的下一步是重试，不是接受。 */}
					<p className="mt-1 text-[10px] leading-relaxed text-muted/70">
						它记住的东西可能还在，只是这一下没读到
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
					<p>还没记住任何事</p>
					<p className="mt-1 text-[10px] leading-relaxed text-muted/70">
						跟助手说「我不喜欢摇滚」试试
					</p>
				</div>
			) : (
				<>
					<ul className="space-y-1">
						{view.items.map((p) => (
							<li
								key={p.key}
								className="group rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2"
							>
								<div className="flex items-start gap-2">
									<div className="min-w-0 flex-1">
										{/* 主行是 `value` —— 契约里写明了它才是「给人看的原话浓缩」。 */}
										<p className="truncate text-xs" title={p.value}>
											{p.value}
										</p>
										{/* `key` 作副行：它决定「什么算同一条」（同 key 再记 = 覆盖），
										    所以它管的是**这一条会不会重复长出来**，值得摆出来但不必抢眼。 */}
										<p className="mt-0.5 truncate text-[10px] text-muted/70" title={p.key}>
											{p.key}
										</p>
									</div>
									<button
										type="button"
										onClick={() => void forget(p.key)}
										disabled={busyKey === p.key}
										title="忘掉这一条（不可逆）"
										className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted transition hover:bg-surface-3 hover:text-foreground disabled:opacity-40"
									>
										{busyKey === p.key ? '…' : '忘掉'}
									</button>
								</div>
							</li>
						))}
					</ul>
					<p className="mt-2 px-2 text-[10px] leading-relaxed text-muted/60">
						最近更新的排前面 —— 带进每一次对话的就是这一批。
					</p>
				</>
			)}
		</div>
	);
}
