/**
 * API 冒烟测试：逐个探测 BFF 路由，判断「真能用 / 已知空」。
 *
 * 为什么要有这个脚本：
 *  项目没有接口层测试（`npm test` 只覆盖纯函数模块），
 *  「某接口到底能不能用」只能靠人工 curl，结论无法复现。
 *  这里把能力边界固化成可重复运行的断言。
 *
 * 用法：
 *  BASE=http://127.0.0.1:3100 node scripts/api-smoke.mjs
 *
 * 退出码：0 = 全部通过；1 = 存在 FAIL（有用的接口坏了）。
 * KNOWN_EMPTY 类接口失败只警告不阻断（它们本来就没数据）。
 *
 * ⚠️ 它只判「接口通不通 / 有没有数据」——HTTP 层的能力边界，
 *  不判「回答对不对」——效果层。两者失败含义不同。
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';

async function call(c) {
	const url = BASE + c.path;
	const init = { method: c.method ?? 'GET' };
	if (c.headers) {
		// 显式请求头（如视频的 `Range`）。⚠️ 必须放在 form 分支**之前**但**不覆盖**
		// form 的自己那一段：multipart 的 Content-Type 要由 fetch 自己带 `boundary`。
		init.headers = { ...c.headers };
	}
	if (c.form instanceof FormData) {
		// multipart：**不许**自己设 Content-Type —— 那会把 fetch 要带的
		// `boundary=...` 覆盖掉，服务端就解不出来了（症状是 req.formData() 抛错 → 400）。
		init.body = c.form;
	} else if (c.body !== undefined) {
		init.headers = { ...init.headers, 'Content-Type': 'application/json' };
		init.body = JSON.stringify(c.body);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60_000);
	try {
		const res = await fetch(url, { ...init, signal: controller.signal });
		// 音频/歌词/视频等流接口不返回 JSON——先按 content-type 分流，
		// 别让 `res.json()` 把二进制当 JSON 解析（会静默丢失真实响应体）
		const ct = res.headers.get('content-type') ?? '';
		const contentRange = res.headers.get('content-range');
		if (!ct.includes('json')) {
			await res.text().catch(() => '');
			return { status: res.status, json: {}, isJson: false, ct, contentRange };
		}
		const json = await res.json().catch(() => ({}));
		return { status: res.status, json, isJson: true, ct, contentRange };
	} catch (e) {
		return { status: 0, json: { message: e instanceof Error ? e.message : String(e) }, isJson: false, ct: '', contentRange: null };
	} finally {
		clearTimeout(timer);
	}
}

// 关键词与 trackId 都从**实际曲库**派生，而不是写死 —— 曲库换了（换 mp3 / 改文件名）
// 时不会假红。`Song.id` 就是曲库内相对路径，所以它同时是 `?trackId=` 与 `{trackId}`
// 的合法取值。
// 2026-09-17 教训：这里曾写死 `track-1`。id 从「slug 编号」改成相对路径后，播放与
// 歌词两条用例就静默变成了永久 FAIL —— 脚本照跑、不报错，只是没人看它输出。
let keyword = '';
let trackId = '';
let lyricId = '';
let coverId = '';
/**
 * 伴生视频的两个探针 id（2026-09-28 加）：一个**确有** `X.mp4`，一个**确无**。
 *
 * 两条都是"曲库换一批就变"的事实，所以各自在缺条件时自动略过 —— 但**必须两条都在**：
 * 只验"有视频时能放"的话，「没有视频却回落成音频」这种缺陷永远看不出来，
 * 而它表现为**画面不播、也不报错**。
 */
let videoId = '';
let noVideoId = '';
/** 曲库里有几首（决定「翻页」用例能不能成立）。 */
let songCount = 0;
/** 歌单用例之间要传递 id（建 → 加 → 读 → 删 是一条链，各用例不能各建各的）。 */
let playlistId = '';
/** 分组用例要用的组名（取自**真实曲库**，不写死 —— 换曲库时不假红）。 */
let groupKey = '';
{
	const probe = await call({ path: '/api/library/search?q=&limit=50' });
	const songs = probe.json?.data?.songs ?? [];
	songCount = Number(probe.json?.data?.total ?? songs.length) || 0;
	const first = songs[0];
	if (first?.title) keyword = String(first.title).slice(0, 2);
	if (first?.id) trackId = String(first.id);
	// 歌词 / 封面不是每首都有，各自挑一首**确实有**的来验：拿没有封面的曲目去请求
	// 封面必然 404，那是设计里的正常分支（前端据此回落渐变），不该报成接口坏了。
	lyricId = String((songs.find((s) => s.hasLyrics) ?? first)?.id ?? '');
	coverId = String(songs.find((s) => s.hasCover)?.id ?? '');
	// 伴生视频：`videoPath` 是扫描产物（`Song` 上就有），没配到的那些是 null。
	videoId = String(songs.find((s) => s.videoPath)?.id ?? '');
	noVideoId = String(songs.find((s) => !s.videoPath)?.id ?? '');
	groupKey = String(first?.artist ?? '');
}

/**
 * 音量 / 播放方式的**现场**。下面是真实库上的一次真实改动，跑完必须还原 ——
 * 把用户的音量留在 42% 是那种"没人看得出来"的副作用（服务端那份还是它给 agent
 * 看的镜像，留着错值会让模型据实说错话）。
 */
const settingsBefore = (await call({ path: '/api/player/settings' })).json?.data ?? null;

/**
 * @type {Array<{
 *   id: string, method?: string, path: string, body?: unknown,
 *   expect?: 'ok' | 'empty' | 'fail',
 *   expectStatus?: number,
 *   assert?: (json: any, status: number) => string | null,
 *   note?: string,
 * }>}
 *
 * `expect: 'fail'` = **「被正确拒绝」也是一种通过**（2026-09-28 加）：判据是
 * `expectStatus`，因为「该拒的没拒」与「该通的没通」是两种病，混在一起报会让人
 * 去查错方向。用它的用例（`player/queue/remove` 的缺参与不在队列）判的正是
 * 「服务端有没有守住边界」，而不是「接口能不能用」。
 */
const CASES = [
	// ── 曲库 ──
	{ id: 'library/search', path: '/api/library/search?q=', expect: 'ok', assert: (j) => (j.data?.total > 0 ? null : '曲库为空') },
	{
		id: 'library/search(关键词)',
		path: `/api/library/search?q=${encodeURIComponent(keyword)}`,
		expect: 'ok',
		assert: (j) => (j.data?.count > 0 ? null : `搜不到已知歌曲「${keyword}」`),
		note: '查询词取自曲库首曲标题前两字',
	},
	...(songCount > 1
		? [
				{
					id: 'library/search(offset)',
					path: '/api/library/search?q=&limit=1&offset=1',
					expect: 'ok',
					// 只断言「回传了 offset」是空的：它证明参数被解析了，却证明不了它**被用了**。
					// 真正有意义的是「第二页不是第一页那一首」。
					assert: (j) =>
						j.data?.songs?.[0]?.id && j.data.songs[0].id !== trackId
							? null
							: `翻页没生效：offset=1 仍然返回首曲 ${trackId}`,
					note: '曲库只有一首时本用例自动略过（翻页无从验证）',
				},
			]
		: []),
	{
		id: 'library/lyrics',
		path: `/api/library/lyrics?trackId=${encodeURIComponent(lyricId)}`,
		expect: 'ok',
		assert: (j) => (j.data?.lrc ? null : '无歌词'),
		note: '优先读音频内嵌歌词（ID3 USLT），.lrc 只是兜底',
	},
	// 下面两条返回的是**流**（text/plain / 图片字节），没有信封 —— 2xx 即通过。
	{
		id: 'library/lyrics(raw)',
		path: `/api/library/lyrics?trackId=${encodeURIComponent(lyricId)}&raw=1`,
		expect: 'ok',
	},
	...(coverId
		? [
				{
					id: 'library/cover',
					path: `/api/library/cover?trackId=${encodeURIComponent(coverId)}`,
					expect: 'ok',
					note: '内嵌封面的原始字节；曲库里若没有带封面的曲目，本用例自动略过',
				},
			]
		: []),

	// ── 伴生视频（`X.mp4` 配 `X.mp3`，2026-09-28 加）──
	// 两个方向都要有：**该放的放得出来**（200 + `video/*`、Range 得 206）、
	// **没有的必须 404**。少了后者，「没有视频就回落到音频」这种缺陷永远查不出来 ——
	// 而它的症状是 `<video>` 拿到一段解不了的字节然后**静默不播**。
	...(videoId
		? [
				{
					id: 'library/video(伴生视频)',
					path: `/api/library/video?trackId=${encodeURIComponent(videoId)}`,
					expect: 'ok',
					assert: (_j, status, meta) =>
						(status === 200 || status === 206) && String(meta?.ct ?? '').startsWith('video/')
							? null
							: `期望 200/206 + video/*，实际 ${status} ${meta?.ct}`,
					note: '曲库里若没有配到视频的曲目，本用例自动略过（见文末视频隔离实例）',
				},
				{
					id: 'library/video(Range → 206)',
					path: `/api/library/video?trackId=${encodeURIComponent(videoId)}`,
					headers: { Range: 'bytes=0-0' },
					expect: 'ok',
					assert: (_j, status, meta) =>
						status === 206 && /^bytes 0-0\//.test(String(meta?.contentRange ?? ''))
							? null
							: `期望 206 + Content-Range: bytes 0-0/*，实际 ${status} ${meta?.contentRange}`,
					note: '拖动进度条靠的就是这条（与音频流共用 server/player/media.ts）',
				},
			]
		: []),
	...(noVideoId
		? [
				{
					id: 'library/video(没有伴生视频 → 404)',
					path: `/api/library/video?trackId=${encodeURIComponent(noVideoId)}`,
					expect: 'fail',
					expectStatus: 404,
					note: '通过判据是「被拒绝」：回落到音频 = 画面静默不播，比 404 难查得多',
				},
			]
		: []),

	// ── 播放器 ──
	{ id: 'player/play', method: 'POST', path: '/api/player/play', body: { trackId }, expect: 'ok' },
	{ id: 'player/pause', method: 'POST', path: '/api/player/pause', body: {}, expect: 'ok' },
	{ id: 'player/resume', method: 'POST', path: '/api/player/resume', body: {}, expect: 'ok' },
	{ id: 'player/next', method: 'POST', path: '/api/player/next', body: {}, expect: 'ok' },
	// jump 收的是队列下标 `{ index }`，不是秒数
	{ id: 'player/jump', method: 'POST', path: '/api/player/jump', body: { index: 1 }, expect: 'ok' },

	// ── 持久化（放在播放用例之后：它断言的就是「上面那些播放确实落库了」）──
	{
		id: 'history',
		path: '/api/history?limit=50',
		expect: 'ok',
		assert: (j) => (Array.isArray(j.data?.plays) && j.data.plays.length > 0 ? null : '播放后播放历史仍为空'),
	},

	// ── 队列：按条件组队列的落点（换一批 → 读回 → 恢复整库）──
	// 只能验「换成了一批、再恢复回整库」，验不了「挑得对不对」——那是效果层，
	// 不在本脚本的能力边界内（见文件头）。
	{
		id: 'player/queue(自定义)',
		method: 'POST',
		path: '/api/player/queue',
		body: { trackIds: [trackId], label: '冒烟探针' },
		expect: 'ok',
		assert: (j) =>
			j.data?.queueSource === 'custom' && j.data?.queueSize === 1
				? null
				: `队列未换成自定义：source=${j.data?.queueSource} size=${j.data?.queueSize}`,
		note: '自带还原用例：下一条把队列恢复成整库',
	},
	{
		id: 'player/queue(恢复整库)',
		method: 'POST',
		path: '/api/player/queue',
		body: { trackIds: [] },
		expect: 'ok',
		// 空数组 = 「没有条件」那一批 = 整个曲库。这条同时是上一条的清理动作：
		// 留下一个只有一首歌的队列，下一次「下一首」就会撞到队尾。
		assert: (j) =>
			j.data?.queueSource === 'library' && j.data?.queueSize > 0
				? null
				: `未恢复整库：source=${j.data?.queueSource} size=${j.data?.queueSize}`,
	},

	// ── 队列：去掉一首（2026-09-28 新增的出口，队列卡上每行的 ×）──
	// 三类判据缺一不可：**该拒的拒**（缺参 400 / 不在队列 404）、**该删的删掉**、
	// 以及**身份跟着改**（否则下一次点播会把删掉的找回来，而界面已经说成功了）。
	{
		id: 'player/queue/remove(缺参)',
		method: 'POST',
		path: '/api/player/queue/remove',
		body: {},
		expect: 'fail',
		expectStatus: 400,
		note: '通过判据是「被拒绝」：没有 trackId 就不许动队列',
	},
	{
		id: 'player/queue/remove(不在队列里)',
		method: 'POST',
		path: '/api/player/queue/remove',
		body: { trackId: '__smoke_missing__.mp3' },
		expect: 'fail',
		expectStatus: 404,
		note: '404 =「你看到的列表旧了」，不是崩溃（前端据此说事实）',
	},
	{
		id: 'player/queue/remove',
		method: 'POST',
		path: '/api/player/queue/remove',
		body: { trackId },
		expect: 'ok',
		assert: (j) => {
			const ids = (j.data?.queue ?? []).map((t) => t.id);
			if (j.data?.queueSize !== songCount - 1) {
				return `去掉后应少一首：${j.data?.queueSize}（曲库 ${songCount}）`;
			}
			if (ids.includes(trackId)) return '被去掉的那一首还留在队列里';
			if (j.data?.queueSource !== 'custom') {
				return `身份没跟着改：${j.data?.queueSource}（下次点播会把它找回来）`;
			}
			return null;
		},
		note: '自带还原：下一条把队列恢复成整库',
	},
	{
		id: 'player/queue(还原整库·兜底)',
		method: 'POST',
		path: '/api/player/queue',
		body: { trackIds: [] },
		expect: 'ok',
		assert: (j) =>
			j.data?.queueSource === 'library' && j.data?.queueSize === songCount
				? null
				: `未回到开跑时的整库队列：source=${j.data?.queueSource} size=${j.data?.queueSize}`,
		note: '上一条把队列改成了「曲库减一首」，这里必须还原成整库',
	},

	// ── 音量 / 播放方式：改 → 读回 → 夹紧 → **还原现场** ──
	{
		id: 'player/settings(POST 音量)',
		method: 'POST',
		path: '/api/player/settings',
		body: { volume: 0.42 },
		expect: 'ok',
		assert: (j) =>
			typeof j.data?.volume === 'number' && Math.abs(j.data.volume - 0.42) < 1e-6
				? null
				: `音量未生效：${JSON.stringify(j.data?.volume)}`,
	},
	{
		id: 'player/settings(GET 读回)',
		path: '/api/player/settings',
		expect: 'ok',
		assert: (j) =>
			typeof j.data?.volume === 'number' && Math.abs(j.data.volume - 0.42) < 1e-6
				? null
				: '写入后读不回来（GET 与 POST 应共用同一份状态）',
	},
	{
		id: 'player/settings(越界夹紧)',
		method: 'POST',
		path: '/api/player/settings',
		body: { volume: 5 },
		expect: 'ok',
		// 越界不报错、夹到边界 —— 前端拖到边缘时给的就是 0 或 1，为它抛 400 没意义
		assert: (j) => (j.data?.volume === 1 ? null : `越界值应夹到 1，实际 ${JSON.stringify(j.data?.volume)}`),
	},
	{
		id: 'player/settings(POST 播放方式)',
		method: 'POST',
		path: '/api/player/settings',
		body: { mode: 'one', shuffle: true },
		expect: 'ok',
		assert: (j) =>
			j.data?.mode === 'one' && j.data?.shuffle === true
				? null
				: `播放方式未生效：mode=${j.data?.mode} shuffle=${j.data?.shuffle}`,
	},

	// ── ⑥ 记忆（写 → 读回 → 删，三步按顺序跑；探针 key 在循环外兜底清理）──
	// 为什么要按顺序写三条用例：单条只能验「接口通不通」，而偏好真正会坏的地方是
	// **往返一致性**——写进去的 key 归一化后能不能被读回来、删的时候认不认得它。
	{
		id: 'preferences(POST)',
		method: 'POST',
		path: '/api/preferences',
		body: { key: 'Smoke Probe', value: '冒烟探针' },
		expect: 'ok',
		// 故意写一个带空格与大写的 key：路由必须把它归一化成 smoke_probe 再回传，
		// 否则「同一条偏好」的判等就失效了（用户说两遍会记两条）。
		assert: (j) =>
			j.data?.preference?.key === 'smoke_probe'
				? null
				: `key 未归一化：拿到 ${JSON.stringify(j.data?.preference?.key)}`,
	},
	{
		id: 'preferences(GET)',
		path: '/api/preferences',
		expect: 'ok',
		assert: (j) =>
			j.data?.preferences?.some((p) => p.key === 'smoke_probe') ? null : '写入后读不回来',
	},
	{
		id: 'preferences(DELETE)',
		method: 'DELETE',
		path: '/api/preferences?key=smoke_probe',
		expect: 'ok',
		assert: (j) => (j.data?.removed === true ? null : '删除应返回 removed:true'),
	},

	// ── 曲目风格标签（写 → 读回 → 删；同样必须按顺序跑）──
	// 探针 id 用一个**库里不存在**的串：这条路径不校验 trackId 在不在库（它只管存），
	// 所以用假 id 就不会把真实歌曲的标签覆盖成探针值。
	{
		id: 'library/tags(POST)',
		method: 'POST',
		path: '/api/library/tags',
		body: { trackId: 'smoke-probe-track', tags: 'Pop,  Chinese  Pop' },
		expect: 'ok',
		// 故意喂「重复 + 大小写混杂 + 多余空白」：归一化必须落到 chinese,pop（拆词 + 去重 + 排序）。
		// 同时验 source 由**入口**定成 user —— 请求体里根本没给这个字段，给了也不算数。
		assert: (j) => {
			const t = j.data?.tag;
			if (t?.source !== 'user') return `source 应为 user（由入口决定），实际 ${JSON.stringify(t?.source)}`;
			const joined = Array.isArray(t.tags) ? t.tags.join('|') : null;
			return joined === 'chinese|pop' ? null : `标签未归一化：${JSON.stringify(t?.tags)}`;
		},
	},
	{
		// 无参形态是 `list_tags` 工具（答「都有哪些风格」）的数据源。它与上面那条
		// `?trackId=` 是同一路由的两个分支，**两条都要有用例**：只测一条时，另一条
		// 改坏了没人知道（`if (trackId)` 写反过一次都看不出来）。
		id: 'library/tags(GET 全量)',
		path: '/api/library/tags',
		expect: 'ok',
		assert: (j) =>
			j.data?.tags?.some((row) => row.trackId === 'smoke-probe-track')
				? null
				: '无参 GET 没带上刚写入的那条（全量表应含它）',
		note: '必须排在 tags(POST) 之后——它断言的就是"刚写进去的能被全量读出来"',
	},
	{
		id: 'library/tags(GET)',
		path: '/api/library/tags?trackId=smoke-probe-track',
		expect: 'ok',
		assert: (j) =>
			j.data?.tag?.tags?.includes('pop') ? null : '写入后读不回来（GET ?trackId= 应返回单条）',
	},
	{
		id: 'library/tags(DELETE)',
		method: 'DELETE',
		path: '/api/library/tags?trackId=smoke-probe-track',
		expect: 'ok',
		assert: (j) => (j.data?.removed === true ? null : '删除应返回 removed:true'),
	},

	// ── 收藏 / 屏蔽（写 → 读回 → 删；探针 id 用**库里不存在**的串）──
	// 这两条路由**不校验 trackId 在不在曲库**（标记只管存 id），所以用假 id 就不会
	// 动到真实歌曲。而 `rows[].missing: true` 正好被这条用例顺带验掉：假 id 一定
	// 查不到曲名，于是它必须是 missing —— 那正是「收藏过一首后来改名的歌」的形状。
	{
		id: 'library/favorites(POST)',
		method: 'POST',
		path: '/api/library/favorites',
		body: { trackId: 'smoke-probe-fav', favorite: true },
		expect: 'ok',
		assert: (j) => {
			if (j.data?.changed !== true) return `首次收藏应 changed:true，实际 ${JSON.stringify(j.data?.changed)}`;
			const row = j.data?.rows?.find((r) => r.trackId === 'smoke-probe-fav');
			if (!row) return 'POST 回的整份清单里没有刚收藏的那条';
			// 解封 / 取消那一侧靠 `trackId` 操作，清单里没有它 = 模型看得见却动不了。
			return row.missing === true ? null : '库里不存在的 id 应标 missing:true';
		},
	},
	{
		id: 'library/favorites(POST 幂等)',
		method: 'POST',
		path: '/api/library/favorites',
		body: { trackId: 'smoke-probe-fav', favorite: true },
		expect: 'ok',
		assert: (j) =>
			j.data?.changed === false
				? null
				: `重复收藏应是 changed:false（本来就是这个状态，不是失败），实际 ${JSON.stringify(j.data?.changed)}`,
		note: '必须排在 favorites(POST) 之后——它验的就是"第二次写不产生改动"',
	},
	{
		id: 'library/favorites(GET)',
		path: '/api/library/favorites',
		expect: 'ok',
		assert: (j) =>
			j.data?.rows?.some((r) => r.trackId === 'smoke-probe-fav')
				? null
				: 'GET 清单里没有刚收藏的那条',
	},
	{
		id: 'library/favorites(DELETE)',
		method: 'DELETE',
		path: '/api/library/favorites?trackId=smoke-probe-fav',
		expect: 'ok',
		assert: (j) => (j.data?.removed === true ? null : '取消收藏应返回 removed:true'),
	},
	{
		id: 'library/hidden(POST)',
		method: 'POST',
		path: '/api/library/hidden',
		body: { trackId: 'smoke-probe-hidden', hidden: true },
		expect: 'ok',
		assert: (j) => {
			if (j.data?.changed !== true) return `首次屏蔽应 changed:true，实际 ${JSON.stringify(j.data?.changed)}`;
			return j.data?.rows?.some((r) => r.trackId === 'smoke-probe-hidden')
				? null
				: 'POST 回的整份清单里没有刚屏蔽的那条';
		},
	},
	{
		// **解封出口**：被屏蔽的歌在 `/api/library/search` 里已经搜不到了，
		// 这条 GET 是唯一还能拿到它 id 的地方（红线③）。它坏了 = 屏蔽变成单向的。
		id: 'library/hidden(GET 解封出口)',
		path: '/api/library/hidden',
		expect: 'ok',
		assert: (j) => {
			const row = j.data?.rows?.find((r) => r.trackId === 'smoke-probe-hidden');
			if (!row) return '解封出口里没有刚屏蔽的那条 —— 被屏蔽的歌将再也拿不到 id';
			return typeof row.trackId === 'string' && row.trackId.length > 0 ? null : '清单里的行必须带 trackId';
		},
	},
	{
		id: 'library/hidden(DELETE)',
		method: 'DELETE',
		path: '/api/library/hidden?trackId=smoke-probe-hidden',
		expect: 'ok',
		assert: (j) => (j.data?.removed === true ? null : '解除屏蔽应返回 removed:true'),
	},

	// ── 歌单（建 → 加 → 读 → 删；必须按顺序跑）──
	// ⚠️ 这些是**真写进两张表**的，所以收尾那段要把探针歌单清掉（见文末 cleanup）。
	{
		id: 'playlists(POST 新建)',
		method: 'POST',
		path: '/api/playlists',
		body: { name: '冒烟探针歌单' },
		expect: 'ok',
		assert: (j) => {
			const p = j.data?.playlist;
			if (!p?.id) return '新建后没回歌单（id 都没有，后面整条链无从下手）';
			if (p.count !== 0) return `新建的应是空歌单，实际 count=${p.count}`;
			playlistId = String(p.id);
			return null;
		},
	},
	{
		id: 'playlists(GET 列出)',
		path: '/api/playlists',
		expect: 'ok',
		assert: (j) =>
			j.data?.playlists?.some((p) => p.id === playlistId)
				? null
				: '列表里没有刚建的那份（计数由 SQL 数，不是"这次取了几条"）',
		note: '必须排在 playlists(POST 新建) 之后',
	},
	{
		id: 'playlists/items(POST 追加)',
		method: 'POST',
		path: '/api/playlists/items',
		body: () => ({ id: playlistId, trackIds: ['smoke-probe-in-playlist'] }),
		expect: 'ok',
		assert: (j) => {
			if (j.data?.added !== 1) return `首次追加应 added:1，实际 ${JSON.stringify(j.data?.added)}`;
			const t = j.data?.playlist?.tracks?.find((x) => x.trackId === 'smoke-probe-in-playlist');
			if (!t) return '追加后清单里没有它';
			// 假 id 一定查不到曲名 → 必须标 missing。这正是「歌里那首被改名的」的形状。
			return t.missing === true ? null : `库里没有的 id 应标 missing:true，实际 ${JSON.stringify(t.missing)}`;
		},
	},
	{
		id: 'playlists/items(POST 幂等)',
		method: 'POST',
		path: '/api/playlists/items',
		body: () => ({ id: playlistId, trackIds: ['smoke-probe-in-playlist'] }),
		expect: 'ok',
		assert: (j) =>
			j.data?.added === 0 && j.data?.skipped === 1
				? null
				: `重复追加应 added:0 / skipped:1（重复是常态，不是失败），实际 ${JSON.stringify({ added: j.data?.added, skipped: j.data?.skipped })}`,
		note: '必须排在 playlists/items(POST 追加) 之后',
	},
	{
		// 「该拒的没拒」与「该通的没通」是两种病：删条目**只收 trackId**，
		// 不给 trackId 就该 400（位置型参数一旦放行，删错歌就不报错）。
		id: 'playlists/items(DELETE 缺 trackId)',
		method: 'DELETE',
		path: () => `/api/playlists/items?id=${encodeURIComponent(playlistId)}`,
		expect: 'fail',
		expectStatus: 400,
		note: '通过判据是「被拒绝」：删一首必须按 id，不接受位置',
	},
	{
		id: 'playlists/items(DELETE 去掉一首)',
		method: 'DELETE',
		path: () => `/api/playlists/items?id=${encodeURIComponent(playlistId)}&trackId=smoke-probe-in-playlist`,
		expect: 'ok',
		assert: (j) => (j.data?.removed === true ? null : `去掉应返回 removed:true，实际 ${JSON.stringify(j.data?.removed)}`),
	},
	{
		id: 'playlists(DELETE 删整份)',
		method: 'DELETE',
		path: () => `/api/playlists?id=${encodeURIComponent(playlistId)}`,
		expect: 'ok',
		assert: (j) => (j.data?.removed === true ? null : '删整份应返回 removed:true'),
		note: '自带清理：删完这条，探针歌单就不在库里了',
	},

	// ── 曲库运维 + 分组（2026-09-28 加）──
	// 三条路由都验「服务端算出来的东西对不对」，而不是「接口能不能通」：
	// 分组最容易坏的方式是**在错误的一侧分桶**（拿一页当全部），那种错 200 也照样回。
	{
		id: 'library/groups(按歌手)',
		path: '/api/library/groups?by=artist',
		expect: 'ok',
		assert: (j) => {
			if (!Array.isArray(j.data?.groups)) return `groups 不是数组：${JSON.stringify(j.data)}`;
			// 各组之和必须等于曲目数（歌手维度下**每首只属于一个组**，与 tag 维度不同）。
			const sum = j.data.groups.reduce((s, g) => s + Number(g.count ?? 0), 0);
			if (sum !== j.data.total) return `各组之和 ${sum} ≠ total ${j.data.total}`;
			return j.data.total > 0 ? null : '曲库为空，分组无从验证';
		},
		note: '歌手维度下每首只归一组，所以各组之和**应该**等于 total —— 与 tag 维度不同',
	},
	{
		id: 'library/groups(按风格：没标签的必须有一组)',
		path: '/api/library/groups?by=tag',
		expect: 'ok',
		assert: (j) => {
			if (!Array.isArray(j.data?.groups)) return 'groups 不是数组';
			// 「未打标」那一组的 key 是**空串**。少了它，打标脚本就无从下手
			// （与 list_hidden 必须带 id 同一条：看不见的东西没法被处理）。
			const hasUntagged = j.data.groups.some((g) => g.key === '');
			return hasUntagged ? null : '缺 key 为空串的「未打标」组';
		},
	},
	{
		id: 'library/groups(非法维度 → 400)',
		path: '/api/library/groups?by=genre',
		expect: 'fail',
		expectStatus: 400,
		note: '通过判据是「被拒绝」：静默回落成 artist 会让调用方以为自己传的维度生效了',
	},
	{
		id: 'library/groups(组内成员)',
		path: `/api/library/groups?by=artist&key=${encodeURIComponent(groupKey)}&limit=20`,
		expect: 'ok',
		assert: (j) => {
			if (!Array.isArray(j.data?.songs)) return 'songs 不是数组';
			// 成员资格由服务端算，所以组内每一首的 artist 都必须正好是组名
			// （子串匹配会放进组外的歌 —— 那是"点一个组看到别的歌"的根因）。
			const bad = j.data.songs.filter((s) => s.artist !== groupKey);
			return bad.length === 0 ? null : `组里有不属于这个歌手的歌：${bad.map((s) => s.title).join('、')}`;
		},
		note: `组名取自真实曲库（${groupKey || '无'}）`,
	},
	{
		id: 'library/rescan',
		method: 'POST',
		path: '/api/library/rescan',
		expect: 'ok',
		assert: (j) => {
			if (typeof j.data?.total !== 'number') return `total 不是数字：${JSON.stringify(j.data)}`;
			// `previousTotal` 只许是数字或 null（null = 这次之前没扫过）。
			const p = j.data.previousTotal;
			if (p !== null && typeof p !== 'number') return `previousTotal 形状不对：${JSON.stringify(p)}`;
			return j.data.total > 0 ? null : '曲库为空，重扫无从验证';
		},
		note: '⚠️ 这条会真的重扫（清缓存再扫一遍），代价 ≈150ms/6 首',
	},
	{
		id: 'library/inspect(整库体检)',
		path: '/api/library/inspect',
		expect: 'ok',
		assert: (j) => {
			if (typeof j.data?.total !== 'number') return 'total 不是数字';
			if (!Array.isArray(j.data?.untaggedIds)) return 'untaggedIds 不是数组（打标脚本的输入）';
			if (j.data.withTags + j.data.withoutTags !== j.data.total) {
				return `withTags(${j.data.withTags}) + withoutTags(${j.data.withoutTags}) ≠ total(${j.data.total})`;
			}
			if (j.data.untaggedIds.length !== j.data.withoutTags) {
				return `untaggedIds 有 ${j.data.untaggedIds.length} 个，withoutTags 却是 ${j.data.withoutTags}`;
			}
			return null;
		},
		note: '两个数必须自洽，且 untaggedIds 的条数要等于 withoutTags',
	},
	{
		id: 'library/inspect(单曲)',
		path: () => `/api/library/inspect?trackId=${encodeURIComponent(trackId)}`,
		expect: 'ok',
		assert: (j) => (j.data?.song?.id === trackId ? null : `单曲详情回的不是请求的那一首：${JSON.stringify(j.data?.song?.id ?? null)}`),
	},
	{
		id: 'library/inspect(不存在的曲目 → 404)',
		path: '/api/library/inspect?trackId=smoke-probe-not-a-song.mp3',
		expect: 'fail',
		expectStatus: 404,
		note: '通过判据是「被拒绝」：回一个空结果会让人以为"这首有 0 个标签"',
	},

	// ── 语音输入（③ 的一条 multipart 路由）──
	// 分两层验：**参数的拒绝**是确定的（缺字段 / 空文件 / 超限，与本机配没配无关），
	// 而**转写本身**取决于 `VOICE_MODEL` 配没配 —— 那一层用 `either`，两种都算过，
	// 但都必须"说清楚"（成功要有 text；没配要是 503 且明说该配什么）。
	{
		id: 'voice/transcribe(缺 file → 400)',
		method: 'POST',
		path: '/api/voice/transcribe',
		form: (() => {
			const fd = new FormData();
			fd.append('other', 'not-audio');
			return fd;
		})(),
		expect: 'fail',
		expectStatus: 400,
	},
	{
		id: 'voice/transcribe(空音频 → 400)',
		method: 'POST',
		path: '/api/voice/transcribe',
		form: (() => {
			const fd = new FormData();
			fd.append('file', new Blob([]), 'voice.webm');
			return fd;
		})(),
		expect: 'fail',
		expectStatus: 400,
		note: '0 字节 = 没录到声音；回 400 而不是把空音频送去网关',
	},
	{
		id: 'voice/transcribe(超过上限 → 413)',
		method: 'POST',
		path: '/api/voice/transcribe',
		form: (() => {
			const fd = new FormData();
			// 上限 + 1 字节。真分配 8MB 会让这条用例变慢，但它是唯一能在端到端
			// 验「上限真的生效」的办法（上限本身在 `contract/voice.ts`，只有一处）。
			fd.append('file', new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]), 'voice.webm');
			return fd;
		})(),
		expect: 'fail',
		expectStatus: 413,
	},
	{
		id: 'voice/transcribe(已配 / 未配都说清楚)',
		method: 'POST',
		path: '/api/voice/transcribe',
		form: (() => {
			const fd = new FormData();
			fd.append('file', new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])]), 'voice.webm');
			return fd;
		})(),
		expect: 'either',
		assert: (j, status) => {
			if (status === 200) {
				return typeof j.data?.text === 'string' ? null : `200 却没给 text：${JSON.stringify(j.data)}`;
			}
			if (status === 503) {
				return /VOICE_MODEL/.test(j.message ?? '')
					? null
					: `503 但没说该配什么（message=${JSON.stringify(j.message)}）`;
			}
			// 502 = 配了但网关拒绝（这段假音频本来就不是真音频，网关拒它是正常的）
			if (status === 502) return null;
			return `既没成功也没明说没配：HTTP ${status} ${JSON.stringify(j.message)}`;
		},
		note: '本机没配 VOICE_MODEL → 503；配了 → 200 或 502（探针不是真音频）。两种都必须有话说',
	},

	// ── ⑩ 排期（**只读**，故意不写）──
	// 写路径不在这里：POST 一条任务之后**没有"彻底删掉"的接口**（用户语义是"取消"，
	// 取消掉的行动静留在表里，会出现在模型的 `list_scheduled_tasks` 里，还会占掉
	// `closed` 那几个名额）。跑一次冒烟就在真库里留一条「已取消｜冒烟探针」，
	// 是那种"没人看得出来"的污染 —— 与 `/api/agent` 不进冒烟同一条判断。
	// 所以写 / 认领 / 执行那一整条链的验证方式是**临时实例**：见 README 的 ⑩ 一节
	// 与 `scripts/tasks-tick.mts`。
	{
		id: 'tasks(GET)',
		path: '/api/tasks',
		expect: 'ok',
		// 断的是**形状**（两组数组都在），不是内容 —— 真库里可能一件任务都没有。
		// 这条能抓住的是：路由没了 / 信封坏了 / `open` 与 `closed` 被改名了。
		assert: (j) =>
			Array.isArray(j.data?.open) && Array.isArray(j.data?.closed)
				? null
				: `返回形状不对：${JSON.stringify(Object.keys(j.data ?? {}))}`,
		note: '只读探针；写路径靠临时实例 + `npm run tasks:tick` 验',
	},
];

/**
 * 信封不变式校验（server/http.ts 的契约）：**信封的 code 必须与 HTTP status 一致**。
 *
 * 为什么值得单独断言：前端按 `res.ok` 判成败（LibraryGrid / PlayerBar / NowPlaying）。
 * 一旦「错误只写在 body 里、HTTP 仍是 200」，这些调用方会把失败当成功——
 * 不报错、不崩溃，只是行为悄悄错。2026-09-10 统一前实测：38 处带了 `{ status }`、
 * 17 处忘了带，同一句 `code: 400` 在同一批路由里两种行为。
 *
 * @returns {string | null} 违规描述，合规返回 null
 */
function envelopeViolation(status, json) {
	if (status === 0) return null; // 网络层失败，与信封无关
	const code = json?.code;
	if (typeof code !== 'number') return `响应缺少信封 code 字段（HTTP ${status}）`;
	if (code === 0) {
		// 成功：只要 2xx 都算合规
		return status >= 200 && status < 300 ? null : `code=0 但 HTTP ${status}（成功必须是 2xx）`;
	}
	return code === status ? null : `信封 code=${code} 与 HTTP ${status} 不一致`;
}

const rows = [];
let failed = 0;
let envelopeViolations = 0;

for (const c of CASES) {
	// ⚠️ `path` / `body` 允许写成函数：**用例是在循环里才跑的**，而有些值（比如
	// 上一条用例新建出来的歌单 id）在 `CASES` 构造时还不存在。写成字符串就会拿到空串，
	// 于是请求打到 `?id=` 上 —— 症状是"返回 400 但断言说 added 是 undefined"，
	// 看着像接口坏了，其实是这条链把自己的 id 弄丢了（2026-09-28 实测）。
	const { status, json, isJson, ct, contentRange } = await call({
		...c,
		path: typeof c.path === 'function' ? c.path() : c.path,
		body: typeof c.body === 'function' ? c.body() : c.body,
	});
	// 流接口那一侧（音频 / 歌词 raw / 封面 / 视频）没有信封，能给它断言的只有
	// 状态码与响应头，所以把两者一起交给 `assert`（`meta` 这个参数是后加的，
	// 既有那些 `(j) => …` 的用例不受影响）。
	const meta = { ct, contentRange };
	const code = json?.code ?? status;
	let verdict;
	let detail = '';

	// 信封不变式：只对走统一信封的 JSON 响应生效（SSE/音频流不适用）
	const envErr = !isJson ? null : envelopeViolation(status, json);
	if (envErr) {
		envelopeViolations += 1;
		console.log(`  ⚠ 信封不变式违规 [${c.id}]：${envErr}`);
	}

	if (c.expect === 'empty') {
		verdict = 'KNOWN_EMPTY';
		const n = json?.data?.count ?? 0;
		detail = code === 0 ? `count=${n}（无数据）` : (json.message ?? '').slice(0, 70);
	} else if (c.expect === 'fail') {
		// 「按预期被拒」——判据是状态码。信封不变式在上面已经查过（code ≡ status），
		// 所以这里只需比 status。
		if (status === c.expectStatus) {
			verdict = 'PASS';
			detail = `HTTP ${status}（按预期拒绝）`;
		} else {
			verdict = 'FAIL';
			failed += 1;
			detail = `期望被拒 HTTP ${c.expectStatus}，实际 ${status} ${(json?.message ?? '').slice(0, 40)}`;
		}
	} else if (!isJson) {
		// 流 / 二进制接口（音频、`lyrics?raw=1`、封面、视频）：没有信封可看，2xx 即通过。
		// 响应体已在 `call()` 里读掉丢弃 —— 封面动辄几百 KB，不能留在内存里等断言。
		// 想再严一点就自己给 `assert(json, status, meta)`（视频那两条用它查 MIME / Range）。
		const err = c.assert ? c.assert(json, status, meta) : null;
		if (status >= 200 && status < 300 && !err) {
			verdict = 'PASS';
			detail = `HTTP ${status}（流）`;
		} else {
			verdict = 'FAIL';
			failed += 1;
			detail = err ?? `HTTP ${status}（流，期望 2xx）`;
		}
	} else if (c.expect === 'either') {
		// 结果**取决于本机配置**的接口（如语音转写：没配 VOICE_MODEL 就是 503）。
		// 判据交给 `assert`，它必须同时说明「成功时该符合什么」与「失败时该像哪一档」——
		// 这样配了 / 没配都不假红，而「编一个结果」仍然会被抓住。
		const err = c.assert ? c.assert(json, status) : null;
		if (err) {
			verdict = 'FAIL';
			failed += 1;
			detail = err;
		} else {
			verdict = 'PASS';
			detail = code === 0 ? 'ok（本机已配）' : `HTTP ${status}（明说没配——不是静默失败）`;
		}
	} else {
		const assertErr = c.assert ? c.assert(json, status) : null;
		if (code === 0 && !assertErr) {
			verdict = 'PASS';
		} else {
			verdict = 'FAIL';
			failed += 1;
			detail = assertErr ?? json.message ?? `HTTP ${status}`;
		}
	}
	rows.push({ id: c.id, verdict, code, detail, note: c.note });
}

// 兜底清理：偏好 / 标签用例写的都是**真实库**（data/app.db）。即使上面那两条 DELETE
// 失败，也不能把探针留在用户的库里 —— 偏好探针会出现在之后每一轮对话的系统提示词里，
// 标签探针会一直挂在标签列表里。
await call({ method: 'DELETE', path: '/api/preferences?key=smoke_probe' }).catch(() => {});
await call({ method: 'DELETE', path: '/api/library/tags?trackId=smoke-probe-track' }).catch(() => {});
// 收藏 / 屏蔽的探针同样要收走：它们是**真写进两张表**的，留下来会出现在
// 用户的「收藏 / 已屏蔽」视图里 —— 而那种污染没人会在冒烟报告里看出来。
await call({ method: 'DELETE', path: '/api/library/favorites?trackId=smoke-probe-fav' }).catch(() => {});
await call({ method: 'DELETE', path: '/api/library/hidden?trackId=smoke-probe-hidden' }).catch(() => {});
// 歌单探针：上面那条「删整份」正常跑完就已经清掉了，这里只是**兜底**
// （中途某条用例失败时它会留在库里 —— 而用户会在自己的歌单列表里看见一个「冒烟探针歌单」）。
if (playlistId) {
	await call({ method: 'DELETE', path: `/api/playlists?id=${encodeURIComponent(playlistId)}` }).catch(() => {});
}

// 音量 / 播放方式同理：把它们还原成开跑前的现场。少了这一步，跑一次冒烟就会把
// 用户的音量固定成 42%、播放方式固定成单曲循环 + 随机。
const settingsFallback = {
	volume: typeof settingsBefore?.volume === 'number' ? settingsBefore.volume : 0.8,
	mode: settingsBefore?.mode ?? 'seq',
	shuffle: typeof settingsBefore?.shuffle === 'boolean' ? settingsBefore.shuffle : false,
};
await call({ method: 'POST', path: '/api/player/settings', body: settingsFallback }).catch(() => {});

// 还原本身也要**被验证**，否则它和「没写还原」在报告里长得一样（都只有一次静默 POST）。
// 判据就是 BLUEPRINT §7 里写的：跑完再 GET 一次，值应与跑之前相同。
const settingsAfter = (await call({ path: '/api/player/settings' }).catch(() => null))?.json?.data ?? null;
const restoredOk =
	settingsAfter !== null &&
	Math.abs((settingsAfter.volume ?? -1) - settingsFallback.volume) < 1e-6 &&
	settingsAfter.mode === settingsFallback.mode &&
	settingsAfter.shuffle === settingsFallback.shuffle;
if (!restoredOk) failed += 1;
rows.push({
	id: 'player/settings(还原现场)',
	verdict: restoredOk ? 'PASS' : 'FAIL',
	code: 200,
	detail: restoredOk
		? `音量 ${Math.round(settingsFallback.volume * 100)}% · ${settingsFallback.mode}${settingsFallback.shuffle ? ' · 随机' : ''}`
		: `未还原成开跑前的值：${JSON.stringify(settingsAfter)}`,
	note: '开跑前先 GET 存现场，跑完写回并**读回确认**',
});

const W = Math.max(...rows.map((r) => r.id.length));
console.log(`\nAPI 冒烟测试  BASE=${BASE}\n${'─'.repeat(78)}`);
for (const r of rows) {
	console.log(`${r.id.padEnd(W)}  ${r.verdict.padEnd(12)} ${String(r.detail).slice(0, 46)}`);
}
console.log('─'.repeat(78));

const pass = rows.filter((r) => r.verdict === 'PASS').length;
const empty = rows.filter((r) => r.verdict === 'KNOWN_EMPTY').length;
console.log(`可用 ${pass} · 已知空 ${empty} · 失败 ${failed}`);
console.log(
	envelopeViolations === 0
		? '信封不变式：全部通过（code 与 HTTP status 一致）'
		: `信封不变式：${envelopeViolations} 处违规 ⚠ 见上方 ⚠ 行`,
);

const noted = rows.filter((x) => x.note);
if (noted.length > 0) {
	console.log('\n说明：');
	for (const r of noted) console.log(`  • ${r.id}：${r.note}`);
}

process.exit(failed > 0 ? 1 : 0);
