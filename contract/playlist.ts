/**
 * 歌单的**共享契约**。零业务依赖。
 *
 * ── 为什么歌单是**两张表**而不是「一张表 + 一个存 id 数组的列」──────────
 * 用 JSON 列存曲目看起来最省事，但它把「只动那一项」变成了不可能：
 * 删掉一首歌 = 把整列读出来、删一个、整列写回去 —— 那就是**整表替换**。
 * 而整表替换正是这个项目反复出事的那一族（`MEMORY.md` §2.4）：
 *
 *     模型只看得到队列**窗口**（或清单的一页），让它"把这一批写回去"，
 *     它会把自己看得见的那部分当成全部 —— 用户原来那一整批被悄悄换走，两次都不报错。
 *
 * 拆成 `playlists` / `playlist_items` 之后，「去掉一首」就是一行 `DELETE ... WHERE
 * playlist_id=? AND track_id=?`，**只动那一项**。代价是多一张表，收益是
 * 「每个内容编辑都有一个只动那一项的入口」这条判据能成立。
 *
 * ── id 是不透明的生成串，**名字不是标识** ────────────────────────────
 * 用户会改歌单名（「跑步」→「夜跑」），而改名不该变成一次数据迁移：
 * 所有引用它的地方（队列 label、未来的分享）都拿 id 说话。
 * 判据见 `MEMORY.md` §2.3 —— **改「唯一标识」= 数据迁移，第一件事是全量扫持久引用**。
 * 所以 `id` 由服务端生成、不可预测，名字只是个显示字段。
 */

/** 歌单列表里的一行。 */
export type PlaylistSummary = {
	id: string;
	name: string;
	/** 里面有几首。**来自服务端的真实计数**，不是"我这次取了几条"。 */
	count: number;
	createdAt: string;
	updatedAt: string;
};

/** 歌单里的一首歌（曲名由服务端按 id 现查，库里没有就 `missing`）。 */
export type PlaylistTrack = {
	trackId: string;
	title: string;
	artist: string;
	/** 这个文件已经不在曲库里了。**照旧列出**，理由同 `FlagRow.missing`。 */
	missing: boolean;
};

/** 单个歌单的详情 = 摘要 + 曲目清单。 */
export type PlaylistDetail = PlaylistSummary & { tracks: PlaylistTrack[] };

/**
 * 一次「追加」的结果。
 *
 * `skipped` 是**已经在这一份里的**那些（重复添加）—— 它不是失败：
 * 幂等是常态（用户点两次、两个入口各加一次）。把它报成失败会推着调用方
 * 去编一个补救动作，而这里什么都不用做。
 */
export type PlaylistAddResult = {
	added: number;
	skipped: number;
};

/** 歌单名的边界。短到能显示在按钮上，长到放得下一句中文。 */
export const PLAYLIST_NAME_MAX = 40;
