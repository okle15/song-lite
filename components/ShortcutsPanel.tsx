/**
 * ShortcutsPanel — 顶栏「键盘」按钮 + 快捷键说明弹层。
 *
 * 为什么要单独做这个入口：GlobalHotkeys 提供了多组快捷键，但没有任何提示的话
 * 用户根本不会去按，功能等于不存在。这是快捷键能力的必要组成部分，不是锦上添花。
 *
 * 清单本身（SHORTCUTS）在 components/keyboard.ts，与 GlobalHotkeys 的行为实现
 * 放在一起维护，本组件只负责渲染 + 开关状态。
 */
'use client';
import { useEffect, useState } from 'react';
import { SHORTCUTS, hasModifier, isTypingTarget } from '@/components/keyboard';
import { useEscapeToClose } from './use-escape-to-close';
import { CloseIcon, KeyboardIcon } from './icons';

export function ShortcutsPanel() {
	const [open, setOpen] = useState(false);

	// 仅在打开时挂载 Esc 监听（与 page.tsx 的 Esc 处理互不干扰：
	// 两边都会响应，本面板关闭后 Esc 仍可关闭聊天/队列）
	useEscapeToClose(() => setOpen(false), open);

	// ? 键唤起 / 关闭帮助（与 GlobalHotkeys 同样的让位规则：打字时不触发）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== '?') return;
			if (hasModifier(e) || isTypingTarget(e.target)) return;
			e.preventDefault();
			setOpen((v) => !v);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-label="快捷键说明"
				aria-expanded={open}
				title="快捷键（按 ? 打开）"
				className="lift flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
			>
				<KeyboardIcon size={15} />
				<span className="hidden lg:inline">快捷键</span>
			</button>

			{open && (
				<div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
					<div
						className="absolute inset-0 bg-black/40"
						onClick={() => setOpen(false)}
						aria-hidden="true"
					/>
					<div
						role="dialog"
						aria-modal="true"
						aria-label="快捷键说明"
						className="card animate-fade-up relative w-full max-w-sm p-5"
					>
						<div className="mb-3 flex items-center justify-between">
							<h2 className="text-sm font-semibold">键盘快捷键</h2>
							<button
								type="button"
								onClick={() => setOpen(false)}
								aria-label="关闭"
								className="rounded-lg p-1 text-muted transition hover:bg-surface-2 hover:text-foreground"
							>
								<CloseIcon size={16} />
							</button>
						</div>

						<ul className="flex flex-col gap-1.5">
							{SHORTCUTS.map((s) => (
								<li key={s.desc} className="flex items-center justify-between gap-3 text-xs">
									<span className="text-muted">{s.desc}</span>
									<span className="flex shrink-0 items-center gap-1">
										{s.keys.map((k) => (
											<kbd
												key={k}
												className="min-w-6 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-center font-sans text-[11px] text-foreground shadow-sm"
											>
												{k}
											</kbd>
										))}
									</span>
								</li>
							))}
						</ul>

						<p className="mt-3 border-t border-border pt-2.5 text-[10px] text-muted/70">
							在输入框内打字时，单键快捷键不会触发，避免误操作。
						</p>
					</div>
				</div>
			)}
		</>
	);
}
