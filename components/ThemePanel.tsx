'use client';

import { useEffect, useRef, useState } from 'react';
import { useTheme, type ThemeState } from './ThemeProvider';
import { useEscapeToClose } from './use-escape-to-close';
import { CloseIcon, ThemeIcon } from './icons';

function currentPresetId(current: ThemeState): string | null {
  return current.kind === 'preset' ? current.id : null;
}

export function ThemePanel() {
  const { presets, current, setPreset, setCustom } = useTheme();
  const [open, setOpen] = useState(false);
  const [c1, setC1] = useState('#2a2140');
  const [c2, setC2] = useState('#140f24');
  const wrapRef = useRef<HTMLDivElement>(null);
  const activeId = currentPresetId(current);

  // Esc 关闭
  useEscapeToClose(() => setOpen(false), open);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="背景主题"
        aria-expanded={open}
        title="切换背景主题"
        className="lift flex h-9 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
      >
        <ThemeIcon size={15} />
        <span className="hidden lg:inline">背景</span>
      </button>

      {open && (
        <div className="card scroll-area animate-fade-up absolute right-0 top-12 z-[60] max-h-[70vh] w-72 overflow-y-auto p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">背景主题</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
aria-label="关闭"
							className="text-xs text-muted hover:text-foreground"
						>
							<CloseIcon size={14} />
						</button>
          </div>

          <p className="mb-2 text-[10px] text-muted">挑一个氛围，或自定义渐变。</p>

          <div className="grid grid-cols-4 gap-2">
            {presets.map((p) => {
              const active = p.id === activeId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPreset(p.id)}
                  title={p.name}
                  aria-label={p.name}
                  aria-pressed={active}
                  className={`lift flex flex-col items-center gap-1 rounded-xl p-1.5 ${
                    active ? 'ring-2 ring-brand' : 'ring-1 ring-border'
                  }`}
                >
                  <span
                    className="h-9 w-full rounded-lg"
                    style={{
                      background: `linear-gradient(150deg, ${p.bg}, ${p.bg2})`,
                      boxShadow: `inset 0 0 12px ${p.glow1}55`,
                    }}
                  />
                  <span className="text-[10px] text-muted">{p.name}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 border-t border-border pt-3">
            <div className="mb-2 text-[10px] font-medium text-muted">自定义渐变</div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[10px] text-muted">
                起始
                <input
                  type="color"
                  value={c1}
                  onChange={(e) => setC1(e.target.value)}
                  aria-label="起始颜色"
                  className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent"
                />
              </label>
              <label className="flex items-center gap-1 text-[10px] text-muted">
                结束
                <input
                  type="color"
                  value={c2}
                  onChange={(e) => setC2(e.target.value)}
                  aria-label="结束颜色"
                  className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent"
                />
              </label>
              <button
                type="button"
                onClick={() => setCustom(c1, c2)}
                className="ml-auto rounded-lg bg-brand px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-brand-strong active:scale-95"
              >
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
