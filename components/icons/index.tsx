'use client';
/**
 * 音乐软件按键图标集 —— 一套 currentColor 主题的 24×24 网格图标。
 *
 * 设计原则：
 *  - 24×24 统一网格、2.2–2.4px 圆头线角，填充仅在收藏点亮态与「队列」音符头出现。
 *  - 颜色一律 currentColor，交给父元素的 text-* class 控制。
 *  - size 默认 16，与 PlayerBar / NowPlaying / FullscreenLyrics 现有尺寸一致。
 */
import * as React from 'react';

export type IconProps = Omit<React.SVGProps<SVGSVGElement>, 'children'> & {
  size?: number;
};

const commonStroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function PrevIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M6 5.4v13.2" />
      <path d="M19 6.6 9.8 12l9.2 5.4V6.6Z" />
    </svg>
  );
}

export function PlayIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M9 5.6 18.4 12 9 18.4V5.6Z" />
    </svg>
  );
}

export function PauseIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M8.8 5.8v12.4M15.2 5.8v12.4" />
    </svg>
  );
}

export function NextIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M17 5.4v13.2" />
      <path d="M5 6.6l9.2 5.4L5 17.4V6.6Z" />
    </svg>
  );
}

export function SeqIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M4.6 6.6h8.6M4.6 12h8.6M4.6 17.4h5.4" />
      <path d="m16.6 14.6 3.4-2.6-3.4-2.6" />
    </svg>
  );
}

export function ListLoopIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="m17 2.6 3.8 3.8-3.8 3.8" />
      <path d="M3.4 11v-.8a3.8 3.8 0 0 1 3.8-3.8H20.6" />
      <path d="m7 21.4-3.8-3.8L7 13.8" />
      <path d="M20.6 13v.8a3.8 3.8 0 0 1-3.8 3.8H3.4" />
    </svg>
  );
}

export function OneLoopIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="m17 2.6 3.8 3.8-3.8 3.8" />
      <path d="M3.4 11v-.8a3.8 3.8 0 0 1 3.8-3.8H20.6" />
      <path d="m7 21.4-3.8-3.8L7 13.8" />
      <path d="M20.6 13v.8a3.8 3.8 0 0 1-3.8 3.8H3.4" />
      <path
        d="M12 9.4v5.6"
        strokeWidth={3}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ShuffleIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M16.4 3.4h4.2v4.2" />
      <path d="M3.4 20.6 20.6 3.4" />
      <path d="M20.6 16.4v4.2h-4.2" />
      <path d="m14.6 14.6 6 6" />
      <path d="m3.4 3.4 5 5" />
    </svg>
  );
}

/** 收藏常态：线描空心。 */
export function FavIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M12 21.35C7.08 17.11 2 13.16 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 4.66-4.08 8.61-8.55 12.85L12 21.35Z" />
    </svg>
  );
}

/** 收藏点亮：实心。 */
export function FavOnIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" {...rest}>
      <path d="M12 21.35C7.08 17.11 2 13.16 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 4.66-4.08 8.61-8.55 12.85L12 21.35Z" />
    </svg>
  );
}

/** 播放队列：三行列表 + 实心八分音符。 */
export function QueueIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M3.75 6.75h10.5M3.75 12h10.5M3.75 17.25h6.25" />
      <circle cx="17.4" cy="14" r="2.1" fill="currentColor" stroke="none" />
      <path d="M17.4 11.9V6.5" />
      <path d="M17.4 6.5c1.4.2 2.1 1 2.1 2.1" />
    </svg>
  );
}

/** 音量：喇叭 + 双声波。 */
export function VolumeIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M11.2 5.2 6.4 9.2H3.6v5.6h2.8l4.8 4V5.2Z" />
      <path d="M15 9.4a4.4 4.4 0 0 1 0 5.2" />
      <path d="M17.9 6.6a8.6 8.6 0 0 1 0 10.8" />
    </svg>
  );
}

/** 静音：喇叭 + 叉。 */
export function MuteIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M11.2 5.2 6.4 9.2H3.6v5.6h2.8l4.8 4V5.2Z" />
      <path d="m16.4 9.6 5.2 5.2M21.6 9.6l-5.2 5.2" />
    </svg>
  );
}

/** 进入全屏：四角向外括号。 */
export function FullscreenIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M8.6 4.6H5.2v3.4M15.4 4.6h3.4v3.4M8.6 19.4H5.2v-3.4M15.4 19.4h3.4v-3.4" />
    </svg>
  );
}

/** 曲库：唱片（外圆 + 中心孔 + 两道纹路）。 */
export function LibraryIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <circle cx="12" cy="12" r="6.4" />
      <circle cx="12" cy="12" r="1.7" />
      <path d="M12 5.6v3M12 15.4v3" />
    </svg>
  );
}

/** 搜索。 */
export function SearchIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <circle cx="10.8" cy="10.8" r="6.4" />
      <path d="m15.6 15.6 4.8 4.8" />
    </svg>
  );
}

/** 背景主题（调色板：外环 + 四个品牌色点缀）。 */
export function ThemeIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...rest}>
      <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth={2.2} />
      <circle cx="12" cy="3.6" r="1.8" fill="#FF7AB6" />
      <circle cx="20.4" cy="12" r="1.8" fill="#6FE9F2" />
      <circle cx="12" cy="20.4" r="1.8" fill="#9D7BEA" />
      <circle cx="3.6" cy="12" r="1.8" fill="#FFD166" />
    </svg>
  );
}

/** 快捷键（键盘 + 七个圆点键）。 */
export function KeyboardIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M3.4 6.8a2 2 0 0 1 2-2h13.2a2 2 0 0 1 2 2v10.4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2Z" />
      <circle cx="6.4" cy="10.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.6" cy="10.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="17.2" cy="10.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8.2" cy="14.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="11.8" cy="14.4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15.4" cy="14.4" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 关闭 X。 */
export function CloseIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="m6.6 6.6 10.8 10.8M17.4 6.6 6.6 17.4" />
    </svg>
  );
}

/** 勾选 ✓（卡片启用 / 多选确认）。 */
/** 音乐助手对话入口（气泡）。 */
export function ChatIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function CheckIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

/** 拖拽把手 6 点。 */
export function GripIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      <circle cx="9" cy="5" r="1.6" />
      <circle cx="15" cy="5" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="19" r="1.6" />
      <circle cx="15" cy="19" r="1.6" />
    </svg>
  );
}

/** 更多 ⋯（horizontal 3 点，菜单/操作触发）。 */
export function MoreIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

/** 卡片布局（2×2 宫格，管理面板布局的入口）。 */
export function GridIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...commonStroke} {...rest}>
      <rect x="3.5" y="3.5" width="7.6" height="7.6" rx="1.8" />
      <rect x="12.9" y="3.5" width="7.6" height="7.6" rx="1.8" />
      <rect x="3.5" y="12.9" width="7.6" height="7.6" rx="1.8" />
      <rect x="12.9" y="12.9" width="7.6" height="7.6" rx="1.8" />
    </svg>
  );
}
