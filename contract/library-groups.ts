/**
 * 曲库分组的**共享契约**（维度名 / 分组行 / 响应形状）。零业务依赖。
 *
 * ── 为什么分桶必须在**服务端**做（§5.3 的硬约束之一）─────────────────
 * 浏览器手里只有**一页**曲目（`limit` 默认 12、上限 50）。拿这一页去分桶，
 * 得到的是「这一页里出现了哪几个歌手」，而界面上写的是「按歌手（N 组）」
 * —— 于是**把「本页」说成「全部」**。项目里这条已经踩过一次：曲库网格曾写
 * `{songs.length} 首` 而不带 `limit`，落到服务端默认 10 上，界面却说「全部」。
 * 判据（与「清单界面的数字必须来自服务端」同一条）：**每个数字都要能回答
 * 「它是哪一问的答案」**。分组的答案是「整库有几组」，而整库只在服务端。
 *
 * ── 为什么分组态必须**禁用搜索** ──────────────────────────────────────
 * 搜索结果的形状是**平铺的一页**（按匹配顺序取前 N 条），分组的形状是
 * **整库的全部分桶**。两者同时生效时，界面上每个数字都在撒谎：「共 3 组」
 * 其实是「这一页里出现了 3 组」。所以分组态下**搜索框不收输入**，
 * 而不是「两边都给、让用户自己想」。
 *
 * ── 一个组里有多少首，与一共有多少首，不是同一个数 ──────────────────
 * `by='tag'` 时一首多标签的歌会进多个组，各组 `count` 之和**大于** `total`。
 * 这不是 bug，也不该在前端"修正"成相等：把「有多少首」说成「有多少个
 * 标签归属」才是撒谎。`total` 恒定是**曲目数**。
 */

/** 分组维度。**取值的全集只在这里一处**（与 `FlagKind` 同一个位置、同一个理由）。 */
export const GROUP_BY = ['artist', 'album', 'tag'] as const;

export type GroupBy = (typeof GROUP_BY)[number];

/**
 * 说给人听的说法（界面 chip / 工具返回值 / 提示词）。
 * 与 `FLAG_LABEL` / `PLAYBACK_MODE_LABEL` 同族：一处定义、多处消费。
 */
export const GROUP_BY_LABEL: Record<GroupBy, string> = {
	artist: '歌手',
	album: '专辑',
	tag: '风格',
};

/** 某一维度下的一个分组。 */
export type LibraryGroup = {
	/** 分桶键（原样：歌手名 / 专辑名 / 标签名）。空串只出现在 `tag` 维度，表示未打标。 */
	key: string;
	/** 显示用的名字。**未打标那一组**在这里换成说人话的「未打标」。 */
	label: string;
	/** 这一组里有几首。**曲目数**，不是别的。 */
	count: number;
};

/** `GET /api/library/groups?by=`（不带 `key`）的响应形状。 */
export type LibraryGroupsResult = {
	by: GroupBy;
	/** 可见曲库的**曲目数**（= 各组 count 之和的上界，tag 维度下会被数多次）。 */
	total: number;
	groups: LibraryGroup[];
};

/**
 * `GET /api/library/groups?by=&key=`（带 `key`）的响应形状 —— **某一个组里的曲目**。
 *
 * 为什么要这一半：分组视图若只能看组名，用户点了组之后还得回去搜索，
 * 而搜出来的是**子串匹配**的结果（可能多出别的歌）。组的成员是服务端算出来的，
 * 就该由服务端给。
 */
export type LibraryGroupTracksResult = {
	by: GroupBy;
	key: string;
	/** 本页起始下标。 */
	offset: number;
	/** 本页条数。 */
	count: number;
	/** 这个组里一共有几首（不受 limit / offset 限制）。 */
	total: number;
	songs: GroupTrackSummary[];
};

/** 组内一首曲目 —— 与 `search.ts` 的 `SongSummary` 同形（扫描产物 + 标签）。 */
export type GroupTrackSummary = {
	id: string;
	title: string;
	artist: string;
	album: string;
	durationSec: number;
	filePath: string;
	hasLyrics: boolean;
	hasCover: boolean;
	/** 有没有**同名的伴生视频**（`X.mp4` 配 `X.mp3`）。见 `server/library/video.ts`。 */
	hasVideo: boolean;
	tags: string[];
};

/** 运行时校验：路由不许信类型断言（`contract/tool.ts` 的 `isToolFailureKind` 同族）。 */
export function isGroupBy(value: unknown): value is GroupBy {
	return typeof value === 'string' && (GROUP_BY as readonly string[]).includes(value);
}
