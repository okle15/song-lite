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
	if (c.body !== undefined) {
		init.headers = { 'Content-Type': 'application/json' };
		init.body = JSON.stringify(c.body);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60_000);
	try {
		const res = await fetch(url, { ...init, signal: controller.signal });
		// 音频/歌词等流接口不返回 JSON——先按 content-type 分流，
		// 别让 `res.json()` 把二进制当 JSON 解析（会静默丢失真实响应体）
		const ct = res.headers.get('content-type') ?? '';
		if (!ct.includes('json')) {
			await res.text().catch(() => '');
			return { status: res.status, json: {}, isJson: false };
		}
		const json = await res.json().catch(() => ({}));
		return { status: res.status, json, isJson: true };
	} catch (e) {
		return { status: 0, json: { message: e instanceof Error ? e.message : String(e) }, isJson: false };
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
{
	const probe = await call({ path: '/api/library/search?q=&limit=50' });
	const songs = probe.json?.data?.songs ?? [];
	const first = songs[0];
	if (first?.title) keyword = String(first.title).slice(0, 2);
	if (first?.id) trackId = String(first.id);
	// 歌词 / 封面不是每首都有，各自挑一首**确实有**的来验：拿没有封面的曲目去请求
	// 封面必然 404，那是设计里的正常分支（前端据此回落渐变），不该报成接口坏了。
	lyricId = String((songs.find((s) => s.hasLyrics) ?? first)?.id ?? '');
	coverId = String(songs.find((s) => s.hasCover)?.id ?? '');
}

/**
 * @type {Array<{
 *   id: string, method?: string, path: string, body?: unknown,
 *   expect: 'ok' | 'empty',
 *   assert?: (json: any, status: number) => string | null,
 *   note?: string,
 * }>}
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
	const { status, json, isJson } = await call(c);
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
	} else if (!isJson) {
		// 流 / 二进制接口（音频、`lyrics?raw=1`、封面）：没有信封可看，2xx 即通过。
		// 响应体已在 `call()` 里读掉丢弃 —— 封面动辄几百 KB，不能留在内存里等断言。
		if (status >= 200 && status < 300) {
			verdict = 'PASS';
			detail = `HTTP ${status}（流）`;
		} else {
			verdict = 'FAIL';
			failed += 1;
			detail = `HTTP ${status}（流，期望 2xx）`;
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
