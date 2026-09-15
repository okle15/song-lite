'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

export type Tone = 'dark' | 'light';

export interface ThemePreset {
  id: string;
  name: string;
  tone: Tone;
  /** 渐变起始色（顶部） */
  bg: string;
  /** 渐变结束色（底部） */
  bg2: string;
  /** 左上辉光 */
  glow1: string;
  /** 右上辉光 */
  glow2: string;
}

/** 背景主题预设 —— 默认「夜紫」即 meowra 同款。 */
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'night-plum', name: '夜紫', tone: 'dark', bg: '#2a2140', bg2: '#140f24', glow1: '#ff7ab6', glow2: '#6a5acd' },
  { id: 'deep-space', name: '深空蓝', tone: 'dark', bg: '#16223f', bg2: '#0c1326', glow1: '#6ab8ff', glow2: '#5a6bb8' },
  { id: 'ink-green', name: '墨绿夜', tone: 'dark', bg: '#143a30', bg2: '#0a1f1a', glow1: '#6ed6c2', glow2: '#3a8f7a' },
  { id: 'sakura', name: '樱粉', tone: 'dark', bg: '#3a2140', bg2: '#1f1024', glow1: '#ff9ecb', glow2: '#c06ab0' },
  { id: 'warm-night', name: '暖夜橙', tone: 'dark', bg: '#3a2418', bg2: '#1c1008', glow1: '#ffb07a', glow2: '#c06a4a' },
  { id: 'pure-black', name: '纯黑', tone: 'dark', bg: '#1a1a1f', bg2: '#0a0a0c', glow1: '#ff7ab6', glow2: '#4a406e' },
  { id: 'morning-mist', name: '晨雾', tone: 'light', bg: '#efe7f5', bg2: '#e1d4ee', glow1: '#ff9ecb', glow2: '#b9a6e6' },
  { id: 'mint', name: '薄荷', tone: 'light', bg: '#eaf3ef', bg2: '#d7e9e0', glow1: '#6ed6c2', glow2: '#8d6dd8' },
];

const STORAGE_KEY = 'song-theme-v1';

export type ThemeState =
  | { kind: 'preset'; id: string }
  | { kind: 'custom'; bg: string; bg2: string; tone: Tone };

function applyTheme(state: ThemeState) {
  const root = document.documentElement;
  const preset =
    state.kind === 'preset'
      ? THEME_PRESETS.find((p) => p.id === state.id) ?? THEME_PRESETS[0]
      : null;
  const bg = state.kind === 'preset' ? preset!.bg : state.bg;
  const bg2 = state.kind === 'preset' ? preset!.bg2 : state.bg2;
  const glow1 = state.kind === 'preset' ? preset!.glow1 : '#ff7ab6';
  const glow2 = state.kind === 'preset' ? preset!.glow2 : '#6a5acd';
  const tone = state.kind === 'preset' ? preset!.tone : state.tone;
  root.style.setProperty('--bg', bg);
  root.style.setProperty('--bg-2', bg2);
  root.style.setProperty('--bg-glow-1', glow1);
  root.style.setProperty('--bg-glow-2', glow2);
  root.setAttribute('data-tone', tone);
}

/** 由颜色亮度推断明暗色调（自定义取色时用）。 */
function inferTone(hex: string): Tone {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'dark';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? 'light' : 'dark';
}

function loadState(): ThemeState {
  if (typeof window === 'undefined') return { kind: 'preset', id: 'night-plum' };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { kind: 'preset', id: 'night-plum' };
    const parsed = JSON.parse(raw) as ThemeState;
    if (parsed.kind === 'preset') {
      if (THEME_PRESETS.some((p) => p.id === parsed.id)) return parsed;
    } else if (parsed.kind === 'custom' && parsed.bg && parsed.bg2) {
      return parsed;
    }
  } catch {
    /* 损坏数据回退默认 */
  }
  return { kind: 'preset', id: 'night-plum' };
}

interface ThemeContextValue {
  presets: ThemePreset[];
  current: ThemeState;
  setPreset: (id: string) => void;
  setCustom: (bg: string, bg2: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ThemeState>({ kind: 'preset', id: 'night-plum' });

	// 挂载后从 localStorage 还原，并应用到 :root
	useEffect(() => {
		const saved = loadState();
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setCurrent(saved);
		applyTheme(saved);
	}, []);

  const setPreset = useCallback((id: string) => {
    const next: ThemeState = { kind: 'preset', id };
    setCurrent(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 忽略写入失败 */
    }
  }, []);

  const setCustom = useCallback((bg: string, bg2: string) => {
    const next: ThemeState = { kind: 'custom', bg, bg2, tone: inferTone(bg) };
    setCurrent(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 忽略写入失败 */
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ presets: THEME_PRESETS, current, setPreset, setCustom }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
