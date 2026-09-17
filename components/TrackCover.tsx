/**
 * TrackCover — 统一封面渲染：真实封面优先，缺失时回落到「首字 + 渐变」。
 *
 * 为什么单独一个组件：三处封面（曲库卡片 / 正在播放 / 播放条）要处理的是**同一件事**
 * ——「这个 id 有没有封面」。各写一遍的结果就是三份略有差别的回落逻辑。
 *
 * 数据来源：`GET /api/library/cover?trackId=`（服务端从 ID3 的 APIC 帧按需读，
 * 见 `app/api/library/cover/route.ts`）。`hasCover` 由调用方传入——曲库来自
 * `/api/library/search`（`SongSummary` 就是 `Song`），正在播放来自播放器快照
 * （`contract/player.ts` 的 `currentTrack`）。所以这里**不做探测请求**：
 * 没有封面的曲目一次网络往返都不会发生。
 *
 * 既然 `hasCover` 已经在手上，为什么还留 `onError`：它是**扫描那一刻**的事实，
 * 盘上文件事后被换掉（封面没了 / 文件没了）时就会过期。图片失败时回落到渐变，
 * 比在界面上留一个碎图标体面。
 *
 * 两条约束（都是踩出来的）：
 *  - **`className` 里不要传 `absolute` / `inset-*`**：本组件的根节点自己带 `relative`
 *    （内部图片要绝对定位填满它），两个 position 工具类同时存在时谁生效由生成的
 *    CSS 顺序决定、不由 class 书写顺序决定，可能出现「封面塌成零高」。要在父容器里
 *    铺满就用 `h-full w-full`。
 *  - 本文件刻意不叫 `Cover.tsx` —— 同目录已有纯函数模块 `cover.ts`（渐变池 + 端点
 *    URL），在大小写不敏感的文件系统上两者会被解析成同一个模块，报出「`./Cover`
 *    找不到导出成员」这种与命名无关的错。
 */
'use client';
import { useState } from 'react';
import { coverUrl, gradientFor } from './cover';

type TrackCoverProps = {
	id: string;
	/** 回落时取首字用。 */
	title: string;
	/** 该曲目有没有内嵌封面（扫描产物，见 `server/library/scanner.ts`）。 */
	hasCover: boolean;
	/** 尺寸 / 圆角 / 阴影 / 过渡。渐变底与 `overflow-hidden` 由组件自理。 */
	className?: string;
	/** 回落首字的字号与字重（默认对得上曲库卡片那种中等封面）。 */
	charClassName?: string;
};

export function TrackCover({
	id,
	title,
	hasCover,
	className = '',
	charClassName = 'text-4xl font-display text-white/90',
}: TrackCoverProps) {
	// 记「哪一首的封面加载失败」，而不是一个布尔：换歌时本组件不会重新挂载，
	// 布尔会把上一首的失败状态带过来，让新歌也无缘无故走渐变。
	const [failedId, setFailedId] = useState<string | null>(null);
	const showImage = hasCover && failedId !== id;
	const char = title.trim().slice(0, 1) || '♪';

	return (
		<div className={`relative overflow-hidden bg-gradient-to-br ${gradientFor(id)} ${className}`}>
			{showImage ? (
				// 封面是自家 BFF 从 ID3 的 APIC 帧按需读出的原始字节，套 next/image
				// 只会多一跳服务端重编码 —— 本地个人曲库这点带宽不值得多一层概念。
				// eslint-disable-next-line @next/next/no-img-element
				<img
					src={coverUrl(id)}
					alt=""
					aria-hidden
					loading="lazy"
					decoding="async"
					onError={() => setFailedId(id)}
					className="absolute inset-0 h-full w-full object-cover"
				/>
			) : (
				<span
					aria-hidden
					className={`absolute inset-0 flex items-center justify-center ${charClassName}`}
				>
					{char}
				</span>
			)}
		</div>
	);
}
