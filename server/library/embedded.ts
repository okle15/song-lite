/**
 * 内嵌资源读取 —— ID3 里的歌词（USLT）与封面（APIC）。
 *
 * 为什么单独成文件：`/api/library/lyrics` 与 `/api/library/cover` 都要做同一件事
 * ——「打开音频文件，取出内嵌的那份二进制/文本」。各写一份的话，`parseFile` 的
 * 调用方式、失败兜底、缓存策略会各自演化（本项目已经吃过一次「同一份协议两处解析」
 * 的亏）。这里只做一件事：**给一个绝对路径，还你内嵌资源**，要不要 404、
 * 要不要回退 .lrc 由调用方决定。
 *
 * 为什么不把歌词/封面读进 `Song`（扫描时反正已经 `parseFile` 过了，取它是零 I/O）：
 * 那会让 `Song` 带着十几 KB 歌词和几百 KB 图片字节常驻内存，**并且使搜索结果
 * 这类「返回一堆 Song」的响应无谓膨胀**。所以 `Song` 只留 `hasLyrics` / `hasCover`
 * 两个布尔（扫描时顺手判断，零成本），字节到真要用时才读。
 *
 * 缓存：按**绝对路径**记一次解析结果。封面/歌词在音频文件被重新编辑前不会变；
 * 缓存的是解析后的值而不是文件句柄，所以文件被替换后最多脏一次（重启即清）。
 * 曲库是个人自用规模，不做淘汰策略。
 */
import { parseFile } from 'music-metadata';

export type EmbeddedCover = { data: Uint8Array; type: string };

export type Embedded = {
	/** ID3v2 USLT 帧里的第一段非空歌词，没有则 null。 */
	lyrics: string | null;
	/** ID3v2 APIC 帧里的第一张图，没有则 null。 */
	cover: EmbeddedCover | null;
};

const EMPTY: Embedded = { lyrics: null, cover: null };

const cache = new Map<string, Embedded>();

/** 取 `common.lyrics` 里第一段非空文本。 */
function firstLyricsText(lyrics: { text?: string }[] | undefined): string | null {
	for (const one of lyrics ?? []) {
		const text = one.text?.trim();
		if (text) return text;
	}
	return null;
}

/**
 * 读音频文件的内嵌资源。解析失败（损坏文件 / 不认识的格式）按「什么都没有」处理
 * —— 调用方各自决定这是 404 还是回退其他数据源，这里不替它们做判断。
 */
export async function readEmbedded(absPath: string): Promise<Embedded> {
	const hit = cache.get(absPath);
	if (hit) return hit;

	let value = EMPTY;
	try {
		const metadata = await parseFile(absPath);
		const pic = metadata.common.picture?.[0];
		value = {
			lyrics: firstLyricsText(metadata.common.lyrics),
			cover: pic?.data?.length ? { data: pic.data, type: pic.format || 'image/jpeg' } : null,
		};
	} catch {
		// 按「没有内嵌资源」处理；不缓存失败结果，下次请求可以重试。
		return EMPTY;
	}

	cache.set(absPath, value);
	return value;
}
