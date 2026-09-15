/**
 * PreferencePanel — 偏好查看/编辑面板。
 *
 * 从 GET /api/preferences 读取 BFF 副本，允许用户：
 * - 查看当前偏好（喜欢的风格/心情、不喜欢的、备注）
 * - 添加/移除单个标签
 * - 编辑备注文本
 * - 一键清除全部偏好
 *
 * 通过 PUT /api/preferences 全量覆盖到 BFF 副本。
 * 注意：BFF 副本是前端可读的镜像，也是 agent 每轮读取的权威源
 * （data/preferences.json，见 server/user/preferences-store.ts 头注）。
 * 前端编辑后如需立即影响 agent 行为，
 * 可在聊天里重述偏好（agent 会调 update_preferences 同步两边）。
 */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEscapeToClose } from './use-escape-to-close';
import { CloseIcon, SettingsIcon } from './icons';

type Preferences = {
	favoriteGenres: string[];
	favoriteMoods: string[];
	dislikedGenres: string[];
	notes: string;
};

const EMPTY: Preferences = {
	favoriteGenres: [],
	favoriteMoods: [],
	dislikedGenres: [],
	notes: '',
};

export function PreferencePanel() {
	const [prefs, setPrefs] = useState<Preferences>(EMPTY);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [draft, setDraft] = useState<Preferences>(EMPTY);
	const btnRef = useRef<HTMLButtonElement>(null);
	const [newTag, setNewTag] = useState<{ field: keyof Pick<Preferences, 'favoriteGenres' | 'favoriteMoods' | 'dislikedGenres'> | null; value: string }>({
		field: null,
		value: '',
	});

	const refresh = useCallback(async () => {
		try {
			const res = await fetch('/api/preferences');
			if (res.ok) {
				const j = (await res.json()) as { code: number; data?: Preferences };
				if (j.code === 0 && j.data) {
					setPrefs(j.data);
					setDraft(j.data);
				}
			}
		} catch {
			/* ignore */
		}
	}, []);

	/* eslint-disable react-hooks/set-state-in-effect */
	useEffect(() => {
		refresh();
	}, [refresh]);
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

	const save = async () => {
		setBusy(true);
		try {
			const res = await fetch('/api/preferences', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(draft),
			});
			if (res.ok) {
				const j = (await res.json()) as { code: number; data?: Preferences };
				if (j.code === 0 && j.data) {
					setPrefs(j.data);
					setDraft(j.data);
				}
			}
		} catch {
			/* ignore */
		} finally {
			setBusy(false);
		}
	};

	const clearAll = async () => {
		if (!confirm('确定清除所有偏好？此操作不可撤销。')) return;
		setBusy(true);
		try {
			const res = await fetch('/api/preferences', { method: 'DELETE' });
			if (res.ok) {
				const j = (await res.json()) as { code: number; data?: Preferences };
				if (j.code === 0 && j.data) {
					setPrefs(j.data);
					setDraft(j.data);
				}
			}
		} catch {
			/* ignore */
		} finally {
			setBusy(false);
		}
	};

	const addTag = (field: 'favoriteGenres' | 'favoriteMoods' | 'dislikedGenres', value: string) => {
		const v = value.trim();
		if (!v) return;
		if (draft[field].includes(v)) return;
		setDraft({ ...draft, [field]: [...draft[field], v] });
	};

	const removeTag = (field: 'favoriteGenres' | 'favoriteMoods' | 'dislikedGenres', value: string) => {
		setDraft({ ...draft, [field]: draft[field].filter((x) => x !== value) });
	};

	const hasDraftChanges = JSON.stringify(draft) !== JSON.stringify(prefs);
	const hasAnyPref = prefs.favoriteGenres.length > 0 || prefs.favoriteMoods.length > 0 || prefs.dislikedGenres.length > 0 || prefs.notes.length > 0;

	return (
		<div className="relative">
			<button
				ref={btnRef}
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-label="查看或编辑我的偏好"
				aria-expanded={open}
				className="lift flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
				title="查看/编辑我的偏好"
			>
				<SettingsIcon size={15} />
				<span className="hidden lg:inline">偏好</span>
				{hasAnyPref && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
			</button>

			{open && (
				<div className="card scroll-area fixed right-3 top-12 z-[60] w-[min(20rem,calc(100vw-1.5rem))] max-h-[75vh] overflow-y-auto p-3 shadow-xl">
					<div className="mb-3 flex items-center justify-between">
						<h3 className="text-sm font-semibold">我的偏好</h3>
						<button
							type="button"
							onClick={() => setOpen(false)}
							aria-label="关闭偏好面板"
							className="text-xs text-muted transition hover:text-foreground"
						>
							<CloseIcon size={14} />
						</button>
					</div>

					<div className="space-y-3">
						<TagEditor
							label="喜欢的风格"
							field="favoriteGenres"
							tags={draft.favoriteGenres}
							newTag={newTag}
							setNewTag={setNewTag}
							onAdd={addTag}
							onRemove={removeTag}
							color="emerald"
						/>
						<TagEditor
							label="喜欢的心情"
							field="favoriteMoods"
							tags={draft.favoriteMoods}
							newTag={newTag}
							setNewTag={setNewTag}
							onAdd={addTag}
							onRemove={removeTag}
							color="blue"
						/>
						<TagEditor
							label="不喜欢的风格"
							field="dislikedGenres"
							tags={draft.dislikedGenres}
							newTag={newTag}
							setNewTag={setNewTag}
							onAdd={addTag}
							onRemove={removeTag}
							color="rose"
						/>

						<div>
							<label className="mb-1 block text-xs font-medium text-muted">
								备注
							</label>
							<textarea
								value={draft.notes}
								onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
								placeholder="任何想告诉助手的偏好（如：工作时听纯音乐，运动时要快节奏）"
								rows={3}
								className="w-full resize-none rounded border border-border bg-surface px-2 py-1 text-xs text-foreground"
							/>
						</div>

						<div className="flex items-center gap-2 pt-1">
							<button
								type="button"
								onClick={save}
								disabled={busy || !hasDraftChanges}
							className="flex-1 rounded bg-brand px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-brand-strong disabled:opacity-40 active:scale-95"
						>
							{busy ? '保存中…' : '保存'}
						</button>
						<button
							type="button"
							onClick={clearAll}
							disabled={busy || !hasAnyPref}
							className="rounded border border-border px-3 py-1.5 text-xs text-muted transition hover:bg-surface-2 disabled:opacity-40"
						>
							清除
						</button>
						</div>

						{hasDraftChanges && (
							<p className="text-[10px] text-muted">
								提示：保存只更新前端可见的副本。如需立即影响助手行为，可在聊天里告诉它你的偏好。
							</p>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

type TagEditorProps = {
	label: string;
	field: 'favoriteGenres' | 'favoriteMoods' | 'dislikedGenres';
	tags: string[];
	newTag: { field: keyof Pick<Preferences, 'favoriteGenres' | 'favoriteMoods' | 'dislikedGenres'> | null; value: string };
	setNewTag: (v: { field: keyof Pick<Preferences, 'favoriteGenres' | 'favoriteMoods' | 'dislikedGenres'> | null; value: string }) => void;
	onAdd: (field: 'favoriteGenres' | 'favoriteMoods' | 'dislikedGenres', value: string) => void;
	onRemove: (field: 'favoriteGenres' | 'favoriteMoods' | 'dislikedGenres', value: string) => void;
	color: 'emerald' | 'blue' | 'rose';
};

function TagEditor({ label, field, tags, newTag, setNewTag, onAdd, onRemove, color }: TagEditorProps) {
	const colorClasses = {
		emerald: 'bg-brand/15 text-brand',
		blue: 'bg-brand-2/15 text-brand-2',
		rose: 'bg-rose-500/15 text-rose-300',
	}[color];

	return (
		<div>
		<label className="mb-1 block text-xs font-medium text-muted">
			{label}
		</label>
		<div className="flex flex-wrap gap-1">
			{tags.map((tag) => (
				<span
					key={tag}
					className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${colorClasses}`}
				>
					{tag}
					<button
						type="button"
						onClick={() => onRemove(field, tag)}
						className="text-[10px] opacity-60 hover:opacity-100"
						aria-label={`移除 ${tag}`}
					>
						✕
					</button>
				</span>
			))}
			{tags.length === 0 && (
				<span className="text-[10px] text-muted">（暂无）</span>
			)}
		</div>
		<div className="mt-1 flex gap-1">
			<input
				type="text"
				value={newTag.field === field ? newTag.value : ''}
				onChange={(e) => setNewTag({ field, value: e.target.value })}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						if (newTag.field === field) {
							onAdd(field, newTag.value);
							setNewTag({ field: null, value: '' });
						}
					}
				}}
				placeholder="加一个…"
				className="flex-1 rounded border border-border bg-surface px-2 py-0.5 text-xs text-foreground"
			/>
			<button
				type="button"
				onClick={() => {
					if (newTag.field === field) {
						onAdd(field, newTag.value);
						setNewTag({ field: null, value: '' });
					}
				}}
				disabled={newTag.field !== field || !newTag.value.trim()}
				className="rounded border border-border px-2 py-0.5 text-xs text-muted transition hover:bg-surface-2 disabled:opacity-40"
			>
				+
			</button>
		</div>
		</div>
	);
}
