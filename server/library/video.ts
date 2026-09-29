/**
 * 伴生视频的**配对规则**（纯函数，无 I/O）。
 *
 * ── 什么是「伴生视频」────────────────────────────────────────────────
 * 曲库里的 `X.mp4` 与 `X.mp3` **同名同目录**时，它就是这首歌的伴生视频。
 * 它**不成为一条独立曲目**（否则同一首歌在队列里出现两次、`plays` 记两条），
 * 也**不改变 `Song.id`**（id 仍是音频的相对路径）—— 这两条正是「伴生」的定义，
 * 也是「理解只增不减」的边界：视频是歌曲的一个**表面**，不是第二个实体。
 *
 * ── 为什么扩展名表是**有序**的 ────────────────────────────────────────
 * 同一个基名可能同时有 `X.mp4` 和 `X.mkv`。任选一个是**不确定**的：`readdir` 的
 * 顺序在不同文件系统上不一样，于是"今天放的是 mp4、明天放的是 mkv"——而那种
 * 抖动会被读成「数据坏了」。所以按 `VIDEO_EXTENSIONS` 的**优先级**取，与候选
 * 给出的顺序无关（实测过的同族坑：位置型 id 依赖 `readdir` 顺序）。
 *
 * ── 为什么只按「同名」配，不做模糊匹配 ────────────────────────────────
 * 「`荷塘月色.mp3` 配 `荷塘月色-现场版.mp4`」这类猜测一旦猜错，用户看到的是
 * **另一首歌的画面**，而且不会报错。宁可配不上（`videoPath: null`），
 * 那种情况用户一眼就知道该改名 —— 判据同一处。
 */
import { extname } from 'node:path';

/** 视频扩展名，**有序**（优先级从高到低）。改这里的顺序 = 改「同名多个取哪个」。 */
export const VIDEO_EXTENSIONS: readonly string[] = ['.mp4', '.m4v', '.webm', '.mkv', '.mov'];

/**
 * 伴生视频的 content-type 表 —— `VIDEO_EXTENSIONS` 的**另一半**。
 *
 * 为什么和扩展名表住同一个文件：它们是同一份清单的两个面（「哪些文件会被配进来」
 * 与「配进来的文件用什么 MIME 送出去」）。分开住就会漂移，而漂移**不报错** ——
 * 少了哪一行，那个格式就安静地回落成 `application/octet-stream`，然后浏览器的
 * `<video>` 静默不播。`video.test.ts` 里有一条**双向集合相等**断言钉着这两份。
 *
 * 为什么不放 `server/player/media.ts`：那里的 `contentTypeFor()` 是通用管线，
 * 刻意不认识「视频」这个概念（它连表都是调用方传进去的）；把这张表挪过去，
 * 「扩展名 ↔ MIME」这条断言就要跨两个文件读，反而更松。
 */
export const VIDEO_CONTENT_TYPES: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/x-m4v',
	'.webm': 'video/webm',
	'.mkv': 'video/x-matroska',
	'.mov': 'video/quicktime',
};

/** 这个扩展名（含点，大小写不敏感）是不是视频。 */
export function isVideoExt(ext: string): boolean {
	return VIDEO_EXTENSIONS.includes(ext.toLowerCase());
}

/** 取「目录 + 基名（去扩展名）」当配对键。大小写不敏感：本机文件系统不区分大小写。 */
function pairKey(relPath: string): string {
	const i = relPath.lastIndexOf('.');
	const noExt = i < 0 ? relPath : relPath.slice(0, i);
	return noExt.toLowerCase();
}

/** 扩展名在优先级表里的位次；表外的排到最后（仍可确定，不会随机）。 */
function rank(relPath: string): number {
	const idx = VIDEO_EXTENSIONS.indexOf(extname(relPath).toLowerCase());
	return idx < 0 ? VIDEO_EXTENSIONS.length : idx;
}

/**
 * 从「同一个基名的若干视频文件」里挑一个。
 *
 * 排序是**全序**（位次 → 字典序），所以同样的输入永远得到同一个答案 ——
 * 这是让界面不抖的前提，也是这个函数存在的全部理由。
 */
export function pickVideoPath(candidates: readonly string[]): string | null {
	if (candidates.length === 0) return null;
	return [...candidates].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

/**
 * 把一次扫描拿到的**全部**相对路径配成 `音频相对路径 → 视频相对路径`。
 *
 * 入参是「这一层目录下的相对路径」—— 向上翻一层（带子目录）也成立，
 * 因为配对键里含目录，不同目录的同名文件不会互相串（实测过的那种串法：
 * 只按 basename 配，会把 `A/开场.mp3` 配上 `B/开场.mp4`）。
 *
 * 一个视频只会被配走一次（它属于它同名的那个音频）；没有同名音频的视频
 * **不会出现在结果里**，也不会变成一个曲目 —— 它就静静地躺在盘上。
 */
export function pairVideos(relPaths: readonly string[]): Map<string, string> {
	/** 基名键 → 候选视频（保持**原始相对路径**，因为结果要拿它去解析文件）。 */
	const byKey = new Map<string, string[]>();
	for (const rel of relPaths) {
		if (!isVideoExt(extname(rel))) continue;
		const key = pairKey(rel);
		const list = byKey.get(key);
		if (list) list.push(rel);
		else byKey.set(key, [rel]);
	}

	const pairs = new Map<string, string>();
	for (const rel of relPaths) {
		if (isVideoExt(extname(rel))) continue;
		const video = pickVideoPath(byKey.get(pairKey(rel)) ?? []);
		if (video) pairs.set(rel, video);
	}
	return pairs;
}
