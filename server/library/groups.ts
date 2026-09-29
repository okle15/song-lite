/**
 * 曲库分组 —— 按**歌手 / 专辑 / 风格**分桶（维度定义在 `contract/library-groups.ts`）。
 *
 * ── 为什么这一层存在（而不是前端拿列表自己分）───────────────────────
 * 前端只有一页（limit 12/50），拿它分桶得到的是「**这一页**里有哪几个歌手」，
 * 说出来却是「按歌手（N 组）」。这条谎话项目里已经踩过一次（曲库网格曾把
 * `songs.length` 说成「全部多少首」）。**分桶的真相在整库上，整库只在服务端。**
 *
 * ── 分桶从 `getSongs()` 取，不从 `getAllSongs()` ──────────────────────
 * 分组是「**列出来给人看**」的那一族，所以走可见曲库 —— 与检索、整库队列同侧。
 * 它**不是第二个过滤点**：过滤仍然只发生在 `getSongs()` 内部（`./visible.ts`），
 * 这里只是消费过滤之后的结果，一行过滤代码都没有写。
 *
 * ── `tag` 维度下 count 之和会大于 total ────────────────────────────────
 * 一首「民谣 / 中国风」的歌进两个组。这是**对**的：把「有多少首歌」说成
 * 「有多少个标签归属」才是撒谎。所以 `total` 恒定是曲目数，前端不许拿各组
 * count 相加去"校验"它。
 *
 * ── 没有标签的歌去哪了 ────────────────────────────────────────────────
 * `tag` 维度下它们进 key 为 `''` 的那一组，显示成「未打标」。刻意**不藏起来**：
 * 「我的库里还有 3 首没打标」是 `inspect` 体检要报的数，而它是 `npm run tag:library`
 * 的真实输入 —— 藏起来等于让打标脚本无从下手（与 `list_hidden` 必须留着是同一条：
 * **看不见的东西没法被处理**）。
 */
import {
	type GroupBy,
	type GroupTrackSummary,
	type LibraryGroup,
	type LibraryGroupTracksResult,
	type LibraryGroupsResult,
} from '../../contract/library-groups';
import { getSongs, type Song } from './';
import { listTrackTags } from './tags';

/** 未打标那一组的显示名（它的 `key` 是空串）。 */
export const UNTAGGED_LABEL = '未打标';

/** 曲库上限（与检索路由的 limit 上限同源，别让两条路给出不同的"最多多少"）。 */
export const GROUP_LIMIT_MAX = 50;

/**
 * 一首歌在这个维度下属于哪几个桶。
 *
 * 返回**数组**而不是单个值：`tag` 维度下本来就是多值。写成单值会让
 * 「一首歌有两个标签」这件事在分桶时静默丢掉一个 —— 而丢了之后
 * 各组 count 之和恰好等于 total，看起来**更整齐**，于是没人会发现。
 */
function keysOf(song: Song, tags: readonly string[], by: GroupBy): string[] {
	if (by === 'artist') return [song.artist];
	if (by === 'album') return [song.album];
	return tags.length > 0 ? [...tags] : [''];
}

/** 标签一次全量读进 Map（与 `search.ts` 同一条理由：N 次往返不如一次 SELECT）。 */
function tagMap(): Map<string, string[]> {
	return new Map(listTrackTags().map((t) => [t.trackId, t.tags]));
}

/**
 * 分桶本身 —— **纯函数**（输入曲目与标签，输出分组）。
 *
 * 提出来的理由与 `visible.ts` 的 `splitHidden()` 一样：过滤 / 分桶这类规则
 * 值得单独测，而测它需要喂一份自己造的曲库（`scanLibrary()` 要真读音频文件，
 * 单测里造不出来）。异步取数的那一层只是两行 `await`。
 *
 * 排序：**首数降序 → 名字**（首数相同的时候顺序必须稳定，否则界面每刷新一次
 * 组的顺序就变一次，而那种抖动会被读成"数据变了"）。
 */
export function bucketSongs(
	songs: readonly Song[],
	tagsById: ReadonlyMap<string, string[]>,
	by: GroupBy,
): LibraryGroup[] {
	const counts = new Map<string, number>();
	for (const song of songs) {
		for (const key of keysOf(song, tagsById.get(song.id) ?? [], by)) {
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return [...counts]
		.map(([key, count]) => ({ key, label: key || UNTAGGED_LABEL, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * 按维度分桶，返回各组与每组几首。
 *
 * 输入是可见曲库，所以被屏蔽的歌不进任何一组 —— 与它在检索里的处境一致。
 */
export async function getLibraryGroups(by: GroupBy): Promise<LibraryGroupsResult> {
	const songs = await getSongs();
	return { by, total: songs.length, groups: bucketSongs(songs, tagMap(), by) };
}

/** 某个组里的成员 —— 纯函数（`bucketSongs` 的同一层）。 */
export function membersOf(
	songs: readonly Song[],
	tagsById: ReadonlyMap<string, string[]>,
	by: GroupBy,
	key: string,
): Song[] {
	return songs.filter((song) => keysOf(song, tagsById.get(song.id) ?? [], by).includes(key));
}

/**
 * 某一个组里的曲目（带 limit / offset）。
 *
 * 成员资格由**服务端算**，不由"拿组名去搜"代替：搜索是子串匹配，歌手名
 * 「凤凰传奇」可能同时出现在别人的专辑字段里，于是点一个组会看到组外的歌
 * —— 用户只会觉得"这个分组不准"，而真正的毛病在于**成员不是算出来的**。
 *
 * 找不到这个组（库里没人叫这个名字）→ `total: 0` 而不是 404：
 * 分组视图是浏览，浏览到一个空组是正常结果（比如刚把所有某个歌手的歌都屏蔽了），
 * 报错会让人以为界面坏了。
 */
export async function getGroupTracks(
	by: GroupBy,
	key: string,
	limit: number,
	offset = 0,
): Promise<LibraryGroupTracksResult> {
	const songs = await getSongs();
	const tagsById = tagMap();

	const members = membersOf(songs, tagsById, by, key);
	const page = members.slice(offset, offset + limit);

	const songsOut: GroupTrackSummary[] = page.map((song) => ({
		...song,
		tags: tagsById.get(song.id) ?? [],
		// 契约面给布尔、不给路径（与 `hasCover` 同一条：界面上"有没有"就够了，
		// URL 由前端按 id 拼，见 `components/cover.ts`）。
		hasVideo: song.videoPath !== null,
	}));

	return { by, key, offset, count: page.length, total: members.length, songs: songsOut };
}
