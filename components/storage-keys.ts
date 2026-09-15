/**
 * storage-keys — song-lite 浏览器存储键的单一出处。
 *
 * 为什么要有命名空间：song 与 song-lite 都跑过 http://127.0.0.1:3100。
 * 浏览器存储按 **origin**（协议 + 主机 + 端口）隔离，**不区分是哪个项目**——
 * 只要键名相同，两个项目读写的就是同一份数据。实测到的后果：
 *   song 的布局里有 lite 不认识的 `overview` 卡 → lite 读到后结构校验失败、
 *   整体回退默认（看起来「我调好的布局丢了」）；而 LayoutProvider 在 ready
 *   翻真的那一刻就 saveLayout，等于**打开 lite 就把 song 的布局覆盖掉**。
 * 反向则静默通过，但 song 的 `overview` 会从界面消失。
 *
 * 规则：任何持久化键都必须从 LS_KEYS 取，不要写字面量。
 * 单测（storage-keys.test.ts）会断言每个键都带命名空间。
 */
export const LS_NAMESPACE = ':lite';

/** 给存储键加项目命名空间，避免与 song 互相覆盖。 */
export function lsKey(name: string): string {
	return `${name}${LS_NAMESPACE}`;
}

export const LS_KEYS = {
	/** 主区布局（列 / Pane / 卡片）。 */
	layout: lsKey('music-panel-layout'),
	/** 主题（预设或自定义配色）。 */
	theme: lsKey('song-theme-v1'),
	/** 音量 0–1。 */
	volume: lsKey('music-volume'),
	/** 收藏曲目 id 列表。 */
	favorites: lsKey('music-favorites'),
	/** 循环模式 seq / rpt / one。 */
	mode: lsKey('music-playback-mode'),
	/** 随机播放开关。 */
	shuffle: lsKey('music-playback-shuffle'),
	/** 断点续播进度前缀：本值 + trackId 拼成完整键。 */
	resumePrefix: `${lsKey('music-resume')}:`,
} as const;
