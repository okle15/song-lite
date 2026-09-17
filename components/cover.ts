/**
 * cover — 无封面资源时的「素材感知」封面：按 id 稳定映射到一组渐变。
 *
 * 为什么共享：曲库卡片、正在播放、全屏歌词都该用同一套颜色——同一首歌的颜色恒定，
 * 否则不同页面各算各的会显得像 bug。把 hash 算法与渐变池抽到一处，避免三处漂移。
 *
 * 注意：返回的只是 `from-x to-y` 两个 Tailwind 类，调用方自己拼 `bg-gradient-to-br`。
 */
export const COVER_GRADIENTS = [
	'from-rose-400 to-purple-500',
	'from-sky-400 to-indigo-500',
	'from-amber-400 to-orange-500',
	'from-emerald-400 to-teal-500',
	'from-fuchsia-400 to-pink-500',
	'from-violet-400 to-blue-500',
];

/** 按 id 稳定映射到一组渐变（同 id 始终返回同色）。返回形如 'from-rose-400 to-purple-500'。 */
export function gradientFor(id: string): string {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
	return COVER_GRADIENTS[h % COVER_GRADIENTS.length];
}

/**
 * 内嵌封面端点 URL，给 `<img src>` 直接用（见 `app/api/library/cover/route.ts`）。
 *
 * 必须整串编码：`Song.id` 就是曲库内相对路径，会带斜杠与中文
 * （如 `专辑/全是爱 - 凤凰传奇.mp3`）——不编码的话斜杠会被当成 URL 路径分隔符，
 * 中文也可能被中间层按各自的方式处理。无封面时服务端 404，那是正常分支不是错误。
 */
export function coverUrl(id: string): string {
	return `/api/library/cover?trackId=${encodeURIComponent(id)}`;
}
