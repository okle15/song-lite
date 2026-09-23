/**
 * `agent/tools.ts` 的单测 —— 用**本地桩服务**验证"工具到底发了什么请求、回了什么话"。
 *
 * 为什么值得测（而不是靠 `smoke:api` 覆盖）：冒烟测的是**路由**通不通，而这里要测的是
 * **工具与路由之间那层翻译**。那层错起来全是静默的：
 *  - `jump_in_queue` 的 position 是 1 基、`jumpToIndex` 收的是 0 基下标。差一写错时
 *    请求照样 200、工具照样回"已跳到第 5 首"，只是**跳到了另一首**——用户自己发现。
 *  - 历史时间戳原样丢给模型，它答不了"昨天放的是什么"（提示词里没有"现在"）。
 *  - 标签汇总漏掉 `source`，模型就不知道哪些标签是用户定的、不该被它改。
 * 这三类都不会让任何东西变红，所以在这里钉住。
 *
 * 桩服务用的是 `node:http`（零依赖）：起在 0 号端口，把每个请求的 method / path / body
 * 记下来，回一个写死的信封。`createTools` 收的就是 `baseUrl`，所以整条链路是真的——
 * 只有出口被换成了桩。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { ToolOutcome } from '../contract/tool';
import { createTools, formatAbsolute, formatPlayTime, summarizeTags } from './tools';

type Hit = { method: string; path: string; body: unknown };

/** 桩服务的**回包**用 `unknown`：测试里喂的就是各种形状的信封，包括不合法的那些。 */
async function stub(reply: unknown, status = 200) {
	const hits: Hit[] = [];
	const server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			hits.push({
				method: req.method ?? '',
				path: req.url ?? '',
				body: raw ? JSON.parse(raw) : undefined,
			});
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(reply));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		hits,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/**
 * 按**请求**决定回包的桩。上面那个 `stub` 对所有请求回同一个信封，够用于
 * 「一个工具只打一条路由」的情形；而 `set_track_tags` 要**先读后写**、
 * `build_queue` 要**先搜后组**——两条路由的回包必须不同，否则第二条拿到的是
 * 第一条的答案，测试会绿得毫无意义。
 */
async function stubRoutes(route: (hit: Hit) => unknown) {
	const hits: Hit[] = [];
	const server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			const hit: Hit = {
				method: req.method ?? '',
				path: req.url ?? '',
				body: raw ? JSON.parse(raw) : undefined,
			};
			hits.push(hit);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(route(hit)));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		hits,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/**
 * 回**非 JSON** 的桩 —— 用来造"打到了别的服务"这种情形（B1 的 `transport`）。
 *
 * 为什么必须单独造：它和"服务压根没起来"归同一类 kind，但**只有这个**能在
 * 一个测试里稳定复现（关掉端口的那个见下面 `deadBaseUrl`）。两者原来与
 * "曲目不存在"被压成同一句「请求失败」，于是模型对三种完全不同的处境
 * 给同一个反应 —— 现在它们分开，各自要有断言守着。
 */
async function stubRaw(raw: string, status = 200, contentType = 'text/html') {
	const server = createServer((_req, res) => {
		res.writeHead(status, { 'Content-Type': contentType });
		res.end(raw);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/**
 * 一个**没有人监听**的地址：先把桩起起来拿到端口，再把它关掉。
 *
 * 比起写死 `http://127.0.0.1:1`（那个端口理论上可能真有人用），这样拿到的
 * 端口是**刚刚被释放**的 —— 连接会被拒绝，正是"服务没跑"的如实复现。
 */
async function deadBaseUrl(): Promise<string> {
	const s = await stub({ code: 0 });
	const { baseUrl } = s;
	await s.close();
	return baseUrl;
}

/**
 * 调 `execute` 时的第二个参数。SDK 把它声明成必填（`ToolExecutionOptions`），
 * 而本项目的工具一个字段都不用——给个空上下文即可。
 */
const CTX = { toolCallId: 'test-call', messages: [], context: {} };

/**
 * 调一次工具并收窄输出。
 *
 * 为什么要收窄：SDK 把 `execute` 的返回类型声明成 `OUTPUT | AsyncIterable<OUTPUT>`
 * （它得支持流式工具），所以 `await` 之后仍是联合——本项目的工具全是"一问一答"。
 * 顺带这也是一条**契约断言**：哪天真有工具返回流，前端 `ChatCard` 也读不懂它。
 *
 * 注意这里只收窄**出口**：`input` 在各处照旧逐个显式写出，打错字段名照样编译不过。
 */
async function run<Out>(pending: PromiseLike<Out> | Out): Promise<ToolOutcome> {
	const out = await pending;
	assert.ok(!(Symbol.asyncIterator in Object(out)), '工具不该返回流式输出');
	return out as ToolOutcome;
}

/** 相对时间的 fixture：`ago(2h)` = 2 小时前的 ISO。 */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ── recent_plays ────────────────────────────────────────────────── */

test('recent_plays：打对路径，并把历史译成带相对时间的人话', async () => {
	const s = await stub({
		code: 0,
		data: {
			count: 3,
			plays: [
				{ id: 3, trackId: 'a.mp3', title: '荷塘月色', artist: '凤凰传奇', startedAt: ago(2 * HOUR) },
				{ id: 2, trackId: 'b.mp3', title: '全是爱', artist: '凤凰传奇', startedAt: ago(30 * HOUR) },
				{ id: 1, trackId: 'c.mp3', title: '奢香夫人', artist: '凤凰传奇', startedAt: ago(3 * DAY) },
			],
		},
	});
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).recent_plays.execute!({ limit: 5 }, CTX));
		assert.equal(s.hits[0].method, 'GET');
		assert.equal(s.hits[0].path, '/api/history?limit=5');
		assert.equal(out.ok, true);
		// 格式：序号 + 曲名 — 歌手 +（绝对时间，相对时间）
		assert.match(out.text, /1\. 荷塘月色 — 凤凰传奇（\d{2}-\d{2} \d{2}:\d{2}，2 小时前）/);
		// 「昨天」是这套相对时间的**全部意义**：没有它，模型答不了「昨晚听了什么」
		assert.match(out.text, /昨天/);
		assert.match(out.text, /3 天前/);
	} finally {
		await s.close();
	}
});

test('recent_plays：不传 limit 时默认 10（由工具补，不是靠路由的默认值）', async () => {
	const s = await stub({ code: 0, data: { count: 0, plays: [] } });
	try {
		await run(createTools({ baseUrl: s.baseUrl }).recent_plays.execute!({}, CTX));
		assert.equal(s.hits[0].path, '/api/history?limit=10');
	} finally {
		await s.close();
	}
});

test('recent_plays：空历史给一句可直说的话，不是空串', async () => {
	const s = await stub({ code: 0, data: { count: 0, plays: [] } });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).recent_plays.execute!({}, CTX));
		assert.equal(out.text, '还没有播放记录。');
	} finally {
		await s.close();
	}
});

/* ── jump_in_queue ───────────────────────────────────────────────── */

test('jump_in_queue：position（1 基）必须变成 index（0 基）', async () => {
	const s = await stub({
		code: 0,
		data: { state: 'playing', currentTrack: { title: '曲目5', artist: '歌手' } },
	});
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).jump_in_queue.execute!({ position: 5 }, CTX),
		);
		assert.equal(s.hits[0].method, 'POST');
		assert.equal(s.hits[0].path, '/api/player/jump');
		// ← 本条测试的存在理由：写成 { index: 5 } 也能"成功"，只是跳错了地方
		assert.deepEqual(s.hits[0].body, { index: 4 });
		assert.match(out.text, /已跳到第 5 首：曲目5 — 歌手/);
	} finally {
		await s.close();
	}
});

test('jump_in_queue：越界时把路由的原因带给模型，并指回去看队列列表', async () => {
	const s = await stub({ code: 404, message: 'queue index out of range: 9' }, 404);
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).jump_in_queue.execute!({ position: 10 }, CTX),
		);
		assert.equal(out.ok, false);
		assert.match(out.text, /queue index out of range/);
		assert.match(out.text, /队列/, '失败话术要把模型引回队列列表，否则它只会再猜一次');
	} finally {
		await s.close();
	}
});

/* ── list_tags ───────────────────────────────────────────────────── */

test('list_tags：汇总成词表，按出现次数降序；用户定过的**单列一行**', async () => {
	const s = await stub({
		code: 0,
		data: {
			tags: [
				{ tags: ['pop', 'folk'], source: 'ai' },
				{ tags: ['pop'], source: 'ai' },
				{ tags: ['pop', '民族风'], source: 'user' },
			],
		},
	});
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).list_tags.execute!({}, CTX));
		assert.equal(s.hits[0].method, 'GET');
		assert.equal(s.hits[0].path, '/api/library/tags');
		assert.equal(out.ok, true);
		assert.match(out.text, /共 3 个标签（3 首歌已有标签）：/);
		// 逐项列表里**只有词与首数**，不带任何来源标记
		assert.match(out.text, /pop（3 首）、/);
		assert.match(out.text, /folk（1 首）/);
		assert.ok(out.text.indexOf('pop（') < out.text.indexOf('folk（'), '次数多的应排在前面');
		// 来源是一条**独立的事实行**，不逐项塞进括号里：括号里是数量（每项都有、
		// 彼此可比较），这一行是来源（回答"哪些是我自己定的"该整句念出来）。
		// 这一行按码位排序（ASCII 在 CJK 之前，与 `summarizeTags` 的字母序同一规则）。
		assert.match(out.text, /其中用户自己定过的：pop、民族风/);
	} finally {
		await s.close();
	}
});

test('list_tags：一个 user 标签都没有时，不提来源这一行', async () => {
	const s = await stub({ code: 0, data: { tags: [{ tags: ['pop'], source: 'ai' }] } });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).list_tags.execute!({}, CTX));
		assert.match(out.text, /pop（1 首）/);
		assert.doesNotMatch(out.text, /用户自己定过/);
	} finally {
		await s.close();
	}
});

test('list_tags：库里一个标签都没有时给一句可直说的话', async () => {
	const s = await stub({ code: 0, data: { tags: [] } });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).list_tags.execute!({}, CTX));
		assert.equal(out.text, '曲库里还没有任何风格标签。');
	} finally {
		await s.close();
	}
});

/* ── set_track_tags：增量语义（2026-09-17 从「整体替换」改过来）──────
 *
 * 为什么这一组是本文件里最该存在的：替换语义的失败方式是**静默的数据丢失**。
 * 用户说「这首其实是民谣」，模型只写「民谣」，原有的 `中国风,广场舞` 就没了——
 * 工具回「已设为民谣」、请求 200、界面无异常，只有回头翻标签列表才看得出来。
 * 增量之后，「没写到的部分」在语义上等于不变，漏写不可能造成丢失。
 * 这里钉住三件事：**先读后写**、**空集走 DELETE 而不是 POST 空数组**、
 * **两个参数都没给时不许当成"清空"**。
 */

/** 造一个「读标签 → 写标签」两跳的桩，并记下那两跳。 */
function tagsStub(current: string[], source = 'ai') {
	return stubRoutes((hit) => {
		if (hit.method === 'GET') return { code: 0, data: { tag: { tags: current, source } } };
		if (hit.method === 'DELETE') return { code: 0, data: { removed: true } };
		const body = hit.body as { tags?: string[] };
		return { code: 0, data: { tag: { tags: body.tags ?? [], source: 'user' } } };
	});
}

test('set_track_tags：add 是在原有标签上**添**，不是替换', async () => {
	const s = await tagsStub(['中国风', '广场舞']);
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).set_track_tags.execute!(
				{ trackId: '奢香夫人 - 凤凰传奇.mp3', add: '民谣' },
				CTX,
			),
		);
		// 第一跳必须是「读」：增量语义建立在这个读之上，没有它就只能猜或覆盖
		assert.equal(s.hits[0].method, 'GET');
		assert.equal(s.hits[0].path, '/api/library/tags?trackId=' + encodeURIComponent('奢香夫人 - 凤凰传奇.mp3'));
		assert.equal(s.hits[1].method, 'POST');
		assert.equal(s.hits[1].path, '/api/library/tags');
		// ← 本条测试的存在理由：把 add 当成 tags 整体替换时，这里只剩 ['民谣']
		assert.deepEqual((s.hits[1].body as { tags: string[] }).tags, ['中国风', '广场舞', '民谣']);
		assert.equal(out.ok, true);
		assert.match(out.text, /现在是「中国风、广场舞、民谣」/);
		assert.match(out.text, /加上：民谣/);
		assert.match(out.text, /去掉：无/);
	} finally {
		await s.close();
	}
});

test('set_track_tags：remove 删掉最后一个标签时走 DELETE，不发空数组', async () => {
	const s = await tagsStub(['rock']);
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).set_track_tags.execute!(
				{ trackId: 'a.mp3', remove: 'rock' },
				CTX,
			),
		);
		// POST 那条路由明确拒绝空标签（400「至少要给一个标签」），走它必然失败
		assert.equal(s.hits.length, 2);
		assert.equal(s.hits[1].method, 'DELETE');
		assert.match(s.hits[1].path, /trackId=a\.mp3/);
		assert.equal(out.ok, true);
		assert.match(out.text, /现在没有任何标签/);
		assert.match(out.text, /去掉：rock/);
	} finally {
		await s.close();
	}
});

test('set_track_tags：两个参数都没给时**一个请求都不发**，更不能当成清空', async () => {
	const s = await tagsStub(['pop']);
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).set_track_tags.execute!({ trackId: 'a.mp3' }, CTX));
		assert.equal(out.ok, false);
		assert.equal(s.hits.length, 0, '没有明确意图时不该碰库——清空是最危险的动作');
		assert.match(out.text, /add|remove/);
	} finally {
		await s.close();
	}
});

test('set_track_tags：加的和删的都没命中时说「没有变化」，也不写库', async () => {
	const s = await tagsStub(['pop']);
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).set_track_tags.execute!(
				{ trackId: 'a.mp3', add: 'pop', remove: 'rock' },
				CTX,
			),
		);
		assert.equal(out.ok, true);
		assert.equal(s.hits.length, 1, '什么都没变时不该产生写入');
		assert.match(out.text, /没有变化/);
	} finally {
		await s.close();
	}
});

/* ── search_library 的翻页（2026-09-17 加）────────────────────────── */

const song = (i: number) => ({
	id: `曲${i}.mp3`,
	title: `曲${i}`,
	artist: '歌手',
	album: '专辑',
	durationSec: 180,
	tags: [] as string[],
});

test('search_library：offset 拼进请求，编号是**整批里的位置**而不是本页内的 1..N', async () => {
	const s = await stub({ code: 0, data: { total: 30, songs: [song(11), song(12)] } });
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).search_library.execute!({ query: '曲', limit: 2, offset: 10 }, CTX),
		);
		assert.equal(s.hits[0].path, `/api/library/search?q=${encodeURIComponent('曲')}&limit=2&offset=10`);
		// 翻到第二页时又从 1 开始编号的话，同一个编号会指两首不同的歌——
		// 模型转述给用户就是错的，而且没人会发现。
		assert.match(out.text, /11\. 曲11 — 歌手/);
		assert.match(out.text, /12\. 曲12 — 歌手/);
		assert.match(out.text, /本页第 11–12 首/);
		assert.match(out.text, /还有 18 首，用 offset=12 接着看/);
	} finally {
		await s.close();
	}
});

test('search_library：不传 offset 时显式带 0（不靠路由的默认值兜底）', async () => {
	const s = await stub({ code: 0, data: { total: 1, songs: [song(1)] } });
	try {
		await run(createTools({ baseUrl: s.baseUrl }).search_library.execute!({ query: '' }, CTX));
		assert.equal(s.hits[0].path, '/api/library/search?q=&limit=10&offset=0');
	} finally {
		await s.close();
	}
});

test('search_library：翻过头时明说「已经翻过头了」，不能拿总数当结论', async () => {
	// 总数 3、offset 10 → 这一页是空的。这里若沿用「命中 3 首」的模板，
	// 模型会以为后面就是没有，而真实情况是它自己要错了页码。
	const s = await stub({ code: 0, data: { total: 3, songs: [] } });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).search_library.execute!({ query: 'x', offset: 10 }, CTX));
		assert.equal(out.ok, true);
		assert.match(out.text, /翻过头/);
		assert.match(out.text, /只有 3 首/);
	} finally {
		await s.close();
	}
});

/* ── build_queue：按条件组队列（2026-09-17 加）────────────────────── */

/** 「先搜后组」两跳的桩。 */
function queueStub(found: { total: number; songs: unknown[] }) {
	return stubRoutes((hit) =>
		hit.path.startsWith('/api/library/search')
			? { code: 0, data: found }
			: {
					code: 0,
					data: {
						state: 'playing',
						currentTrack: { title: '曲11', artist: '歌手' },
						queueSize: 2,
						queueSource: 'custom',
						queueLabel: '安静的歌',
						missing: [],
					},
				},
	);
}

test('build_queue：先按条件搜，再把这一批交给队列接口，并开播', async () => {
	const s = await queueStub({ total: 2, songs: [song(11), song(12)] });
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).build_queue.execute!(
				{ query: '安静', limit: 2, label: '安静的歌' },
				CTX,
			),
		);
		assert.equal(s.hits[0].method, 'GET');
		assert.equal(s.hits[0].path, `/api/library/search?q=${encodeURIComponent('安静')}&limit=2`);
		assert.equal(s.hits[1].method, 'POST');
		assert.equal(s.hits[1].path, '/api/player/queue');
		// 传的是**解析后的 id 列表**，不是原始条件：条件→曲目是 search 的职责，
		// 队列接口只管「换成这些」（见 queue 路由的文件头）。
		assert.deepEqual(s.hits[1].body, { trackIds: ['曲11.mp3', '曲12.mp3'], label: '安静的歌' });
		assert.equal(out.ok, true);
		assert.match(out.text, /队列已换成「安静的歌」，共 2 首/);
	} finally {
		await s.close();
	}
});

test('build_queue：条件留空 = 恢复整个曲库（空数组就是「没有条件」那一批）', async () => {
	const s = await queueStub({ total: 0, songs: [] });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).build_queue.execute!({}, CTX));
		assert.equal(s.hits.length, 1, '恢复整库与"按条件挑"是两条路，不该先去搜一次');
		assert.equal(s.hits[0].path, '/api/player/queue');
		assert.deepEqual(s.hits[0].body, { trackIds: [] });
		assert.equal(out.ok, true);
		assert.match(out.text, /恢复为整个曲库/);
	} finally {
		await s.close();
	}
});

test('build_queue：没匹配到时不改队列，并把话说清楚', async () => {
	const s = await queueStub({ total: 0, songs: [] });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).build_queue.execute!({ query: '不存在的风格' }, CTX));
		// 搜失败就**不该**再去组队列：空数组会被队列路由理解成「恢复整库」，
		// 于是「没找到」变成「把用户的队列清成整库」——两件完全不同的事。
		assert.equal(s.hits.length, 1);
		assert.equal(out.ok, false);
		assert.match(out.text, /队列没有改动/);
	} finally {
		await s.close();
	}
});

test('build_queue：命中比这批多时，把「取了前几首」说出来', async () => {
	const s = await queueStub({ total: 9, songs: [song(11), song(12)] });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).build_queue.execute!({ query: '安静', limit: 2 }, CTX));
		assert.match(out.text, /命中 9 首，本批取了前 2 首/);
	} finally {
		await s.close();
	}
});

/* ── set_volume / set_playback_mode：设备侧设定（2026-09-17 加）───── */

/** 回一个「服务端照收」的设置响应。 */
const settingsStub = (data: Record<string, unknown>) => stub({ code: 0, data });

test('set_volume：对外百分数、对内 0–1，并回读服务端的实际值', async () => {
	const s = await settingsStub({ volume: 0.85, mode: 'seq', shuffle: false });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).set_volume.execute!({ level: 85 }, CTX));
		assert.equal(s.hits[0].path, '/api/player/settings');
		assert.deepEqual(s.hits[0].body, { volume: 0.85 });
		assert.match(out.text, /音量已设为 85%/);
	} finally {
		await s.close();
	}
});

test('set_volume：报的是**服务端回读**的值，不是用户给的值', async () => {
	// 服务端会夹紧（0–1）。若照抄入参，"设成 200%" 这种话就会说给用户听，
	// 而实际音量停在 100%——用户当场能发现，代码却不会红。
	const s = await settingsStub({ volume: 1, mode: 'seq', shuffle: false });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).set_volume.execute!({ level: 100 }, CTX));
		assert.match(out.text, /音量已设为 100%/);
	} finally {
		await s.close();
	}
});

test('set_volume：0 说成「已静音」，而不是「音量已设为 0%」', async () => {
	const s = await settingsStub({ volume: 0, mode: 'seq', shuffle: false });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).set_volume.execute!({ level: 0 }, CTX));
		assert.match(out.text, /已静音/);
	} finally {
		await s.close();
	}
});

test('set_playback_mode：只改循环方式时，body 里不带 shuffle', async () => {
	const s = await settingsStub({ volume: 0.8, mode: 'one', shuffle: false });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).set_playback_mode.execute!({ mode: 'one' }, CTX));
		// `undefined` 的键会被 JSON.stringify 丢掉——路由按「只改给了的字段」实现，
		// 多带一个 false 就等于顺手把用户开着的随机关掉。
		assert.deepEqual(s.hits[0].body, { mode: 'one' });
		assert.match(out.text, /播放方式已设为：单曲循环。/);
	} finally {
		await s.close();
	}
});

test('set_playback_mode：只改随机时，不去复述没动过的循环方式', async () => {
	const s = await settingsStub({ volume: 0.8, mode: 'seq', shuffle: true });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).set_playback_mode.execute!({ shuffle: true }, CTX));
		assert.deepEqual(s.hits[0].body, { shuffle: true });
		assert.match(out.text, /随机播放/);
		// 「只改随机」却报一句「顺序播放」的话，读起来像循环方式也被重置了
		assert.doesNotMatch(out.text, /顺序播放/);
	} finally {
		await s.close();
	}
});

test('set_playback_mode：两个参数都没给时不发请求，并说清该给什么', async () => {
	const s = await settingsStub({ volume: 0.8, mode: 'seq', shuffle: false });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).set_playback_mode.execute!({}, CTX));
		assert.equal(out.ok, false);
		assert.equal(s.hits.length, 0);
	} finally {
		await s.close();
	}
});

/* ── 失败路径：所有工具都靠 `callBff` 把失败收敛成返回值，不抛 ── */

test('BFF 回非 0 信封时：工具返回 ok:false 并把原因带出来，而不是抛异常', async () => {
	const s = await stub({}, 500); // 信封不合法（没有 code）
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).recent_plays.execute!({}, CTX));
		assert.equal(out.ok, false);
		assert.match(out.text, /HTTP 500/);
	} finally {
		await s.close();
	}
});

/* ── 两个纯函数（上面那些测试其实都压在它们身上）─────────────────── */

test('formatPlayTime：各档位相对时间', () => {
	// 用固定的"现在"，避免跨小时边界抖动；下面这些 ISO 不带 Z，按本地时间解析，
	// 与 `now` 同基准（工具里也是同一个 Date）。
	const now = new Date('2026-09-17T16:00:00');
	const at = (iso: string) => formatPlayTime(iso, now);
	assert.equal(at('2026-09-17T15:59:40'), '09-17 15:59，刚刚');
	assert.equal(at('2026-09-17T15:58:00'), '09-17 15:58，2 分钟前');
	assert.equal(at('2026-09-17T14:00:00'), '09-17 14:00，2 小时前');
	assert.equal(at('2026-09-16T10:00:00'), '09-16 10:00，昨天');
	assert.equal(at('2026-09-14T16:00:00'), '09-14 16:00，3 天前');
	// 超过一周不再给相对说法（"23 天前"没有信息量），只留日期
	assert.equal(at('2026-09-07T16:00:00'), '09-07 16:00');
});

test('formatPlayTime：脏值原样返回；未来时间既不写「-2 小时前」也不写「刚刚」', () => {
	const now = new Date('2026-09-17T16:00:00');
	assert.equal(formatPlayTime('不是时间', now), '不是时间');
	assert.equal(formatPlayTime('', now), '');
	// 时钟漂移或手工改过库时会出现未来时间：宁可只说日期，也不要一个负数。
	// 这条一开始是红的——判档的顺序写成了先 `diff < MINUTE`，负数当然也小于它，
	// 于是两小时后才发生的播放被说成「刚刚」。相对时间的**否定分支必须排在最前**。
	assert.equal(formatPlayTime('2026-09-17T18:00:00', now), '09-17 18:00');
});

test('summarizeTags：同次数按字母序，排序必须稳定', () => {
	// 不稳定的话，同一个库每次请求给出的提示词都不一样——排查问题时无从对比
	const rows = [
		{ tags: ['rock', 'ballad'], source: 'ai' },
		{ tags: ['dance'], source: 'ai' },
	];
	assert.deepEqual(summarizeTags(rows), [
		{ tag: 'ballad', count: 1, user: false },
		{ tag: 'dance', count: 1, user: false },
		{ tag: 'rock', count: 1, user: false },
	]);
	assert.deepEqual(summarizeTags([]), []);
});

test('summarizeTags：user 是"或"——一个标签只要有一行来自用户就算', () => {
	const rows = [
		{ tags: ['pop'], source: 'ai' },
		{ tags: ['pop'], source: 'user' },
	];
	assert.deepEqual(summarizeTags(rows), [{ tag: 'pop', count: 2, user: true }]);
});

/* ── formatAbsolute（⑩ 排期用；要求与 formatPlayTime 正好相反）──────
 *
 * 这两个函数回答的是两类问题，所以对"时间"的写法要求相反：
 *   - `formatPlayTime` 回答「我昨晚听了什么」→ 必须给相对说法（提示词里没有"现在"）；
 *   - `formatAbsolute` 回答「你排的是几点」→ **不能**给相对说法，因为排期是**将来**的，
 *     「明天」会随读它的那一刻改变，而模型需要一个不会动的锚来核对时区。
 */

test('formatAbsolute：只给「月-日 时:分，星期几」，不给相对说法', () => {
	assert.equal(formatAbsolute('2026-09-24T07:00:00'), '09-24 07:00，周四');
	// 分与时都要补零 —— 「9:5」会让模型按 09:50 去理解
	assert.equal(formatAbsolute('2026-09-23T09:05:00'), '09-23 09:05，周三');
	// 周日是 getDay()=0，单独钉一下（Intl 的中文输出与 getDay 的下标不一定对应，
	// 所以 WEEKDAYS 是自己钉的一份，错了不会有人报错）
	assert.equal(formatAbsolute('2026-09-27T10:00:00'), '09-27 10:00，周日');
});

test('formatAbsolute：脏值原样返回，不编一个时间出来', () => {
	assert.equal(formatAbsolute('不是时间'), '不是时间');
	assert.equal(formatAbsolute(''), '');
});

/* ── B1 失败分类：kind ──────────────────────────────────────────────
 *
 * 判据是「谁来修」，且**只用 HTTP status** 归类（不读 message 的措辞 ——
 * 按文案猜会在 BFF 改一次文案之后静默失效，与「按 toolCallId 配对而不是按下标」
 * 同源：别用一个会变的信号去替代那个稳定的信号）。
 *
 * 压平时期这些失败长得一模一样：模型只能从一句中文里猜「这事还值不值得换个
 * 说法再试」，而"要不要换做法"恰恰是它比这段代码强的地方。所以 B1 改的是**接口**，
 * 不是提示词 —— 这里一个字都不建议。
 */

/** 打一条一定失败的请求，看它被归成哪一类。统一走 `recent_plays`（只打一条路由）。 */
async function probeKind(status: number, reply: unknown): Promise<ToolOutcome> {
	const s = await stub(reply, status);
	try {
		return await run(createTools({ baseUrl: s.baseUrl }).recent_plays.execute!({}, CTX));
	} finally {
		await s.close();
	}
}

test('kind：404 → not_found（模型该如实说没有，别重试）', async () => {
	const out = await probeKind(404, { code: 404, message: '曲目不存在' });
	assert.equal(out.ok, false);
	assert.equal(out.kind, 'not_found');
	assert.equal(out.text, '读取播放历史失败：曲目不存在', '分类不该改动给模型看的那句话');
});

test('kind：400 / 422 → bad_request（模型自己能修：换个参数再试）', async () => {
	assert.equal((await probeKind(400, { code: 400, message: 'limit 非法' })).kind, 'bad_request');
	assert.equal((await probeKind(422, { code: 422, message: '参数不合法' })).kind, 'bad_request');
});

test('kind：401 / 403 → forbidden（谁都不行，得人去配）', async () => {
	assert.equal((await probeKind(401, { code: 401, message: 'unauthorized' })).kind, 'forbidden');
	assert.equal((await probeKind(403, { code: 403, message: 'forbidden' })).kind, 'forbidden');
});

test('kind：5xx → unavailable（稍后重试可能就好了）', async () => {
	assert.equal((await probeKind(500, { code: 500, message: '内部错误' })).kind, 'unavailable');
	assert.equal((await probeKind(503, { code: 503, message: '在重启' })).kind, 'unavailable');
});

test('kind：HTTP 200 但 code 非 0 → unknown（不猜）', async () => {
	// 本项目的约定是"失败时 code 才等于 HTTP status"，所以 200 + code≠0 是
	// **我们没见过**的组合。归成任何一类都是在替模型判断，于是归 unknown。
	const out = await probeKind(200, { code: 500, message: '说不清' });
	assert.equal(out.ok, false);
	assert.equal(out.kind, 'unknown');
});

test('kind：响应不是 JSON → transport（打到的可能不是本项目）', async () => {
	const s = await stubRaw('<html><body>404 Not Found</body></html>', 404);
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).recent_plays.execute!({}, CTX));
		assert.equal(out.ok, false);
		// 这条是本组测试存在的理由：原来它与"曲目不存在"被压成同一句「请求失败」，
		// 于是模型对"打到了别的服务"和"这首曲子没有"给出同一个反应。
		assert.equal(out.kind, 'transport');
		assert.match(out.text, /不是 JSON/);
		assert.match(out.text, /404/, '响应码要透出来，否则没法判断打到了哪里');
	} finally {
		await s.close();
	}
});

test('kind：根本连不上 → transport（通常是服务没跑，重试无用）', async () => {
	const out = await run(
		createTools({ baseUrl: await deadBaseUrl() }).recent_plays.execute!({}, CTX),
	);
	assert.equal(out.ok, false);
	assert.equal(out.kind, 'transport');
	assert.match(out.text, /请求失败/);
});

test('成功的返回值**不带** kind（带了会被模型与前端当失败处理）', async () => {
	const s = await stub({ code: 0, data: { count: 0, plays: [] } });
	try {
		const out = await run(createTools({ baseUrl: s.baseUrl }).recent_plays.execute!({}, CTX));
		assert.equal(out.ok, true);
		assert.equal(out.kind, undefined);
	} finally {
		await s.close();
	}
});

test('失败时模型看到的话前面多一个 [kind] 标签；成功时不加', async () => {
	// `toModelOutput` 是界面与模型之间的那条缝：store 里是 ok + kind + text 三件，
	// 而模型只该看到"一段话 + 一个标签"。做成 JSON 对象语义更干净，但会让
	// 成功与失败**形状不同** —— 模型对"同一工具两种形状"的处理不如对前缀稳。
	const tools = createTools({ baseUrl: 'http://127.0.0.1:1' });
	const mapped = (output: ToolOutcome) =>
		JSON.stringify(tools.recent_plays.toModelOutput!({ toolCallId: 't', input: {}, output }));

	assert.equal(
		mapped({ ok: false, text: '读取播放历史失败：曲目不存在', ms: 3, kind: 'not_found' }),
		'{"type":"text","value":"[not_found] 读取播放历史失败：曲目不存在"}',
	);
	assert.equal(
		mapped({ ok: true, text: '还没有播放记录。', ms: 3 }),
		'{"type":"text","value":"还没有播放记录。"}',
	);
	// ok=true 时不加前缀：成功就是成功，别给它贴一个失败的标签
	assert.equal(mapped({ ok: true, text: 'ok', ms: 1, kind: null }), '{"type":"text","value":"ok"}');
});

/* ── ⑩ 触发器：排 / 看 / 撤 ─────────────────────────────────────────
 *
 * 加这三个工具不是"多了三个功能"，而是补齐了 BLUEPRINT §2 里唯一空着的那个
 * 部件 —— 在这之前 agent 只可能被"用户这一秒说了句话"唤醒。
 *
 * 这里钉的是**工具与路由之间那份约定**（method / path / body / 念回去的话），
 * 不是路由本身（那是 `api-smoke` 的活）。尤其 `dueAt`：它由**模型自己算**，
 * 所以工具要把服务端规范化后的时间念回去 —— 模型据此才有机会发现自己算错了时区
 * （而它算错时，没有任何东西会报错）。
 */

/** 一件任务在 wire 上的样子（`/api/tasks` 的响应行）。 */
const taskRow = (over: Record<string, unknown> = {}) => ({
	id: 't-1',
	goal: '放一首轻音乐',
	dueAt: '2026-09-24T07:00:00+08:00',
	repeat: 'none',
	// 服务端**恒给出**这个字段（`createTask` 把 weekly 没指定的星期补上），
	// 所以夹具照实写 — 少写一个字段的夹具会掩盖"念回去时漏了频率"这类缺陷。
	repeatDays: [],
	status: 'pending',
	attempts: 0,
	result: null,
	lastError: null,
	...over,
});

test('schedule_task：POST /api/tasks，body 是 {goal, dueAt, repeat}（repeat 缺省补 none）', async () => {
	const s = await stub({ code: 0, data: { task: taskRow() } });
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).schedule_task.execute!(
				{ goal: '放一首轻音乐', dueAt: '2026-09-24T07:00:00+08:00' },
				CTX,
			),
		);
		assert.equal(s.hits[0].method, 'POST');
		assert.equal(s.hits[0].path, '/api/tasks');
		// 缺省值由**工具**补，不靠路由的默认值 —— 否则"谁负责补"在两处之间漂移
		assert.deepEqual(s.hits[0].body, {
			goal: '放一首轻音乐',
			dueAt: '2026-09-24T07:00:00+08:00',
			repeat: 'none',
		});
		assert.equal(out.ok, true);
		assert.match(out.text, /已排期（id=t-1）：09-24 07:00，周四/);
		assert.match(out.text, /要做的事：放一首轻音乐/);
		assert.ok(!/每天重复/.test(out.text), 'repeat=none 时不该说"每天"');
	} finally {
		await s.close();
	}
});

test('schedule_task：repeat=daily 时明确说"每天重复"（说漏了用户会以为只做一次）', async () => {
	const s = await stub({ code: 0, data: { task: taskRow({ repeat: 'daily' }) } });
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).schedule_task.execute!(
				{ goal: '每天八点放新闻', dueAt: '2026-09-24T08:00:00+08:00', repeat: 'daily' },
				CTX,
			),
		);
		assert.equal((s.hits[0].body as { repeat: string }).repeat, 'daily');
		assert.match(out.text, /每天重复/);
	} finally {
		await s.close();
	}
});

test('schedule_task：repeat=weekly 只重复一天时不用传 repeatDays —— 服务端按 dueAt 的星期补', async () => {
	// 「每周一早上放首歌」：dueAt 落在哪天就是哪天。工具**不自己算星期**，
	// 它把服务端给的那份念回去（两个地方各算一遍就是两处会漂移的实现）。
	const s = await stub({
		code: 0,
		data: { task: taskRow({ repeat: 'weekly', repeatDays: [1] }) },
	});
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).schedule_task.execute!(
				{ goal: '每周一放歌', dueAt: '2026-09-28T07:00:00+08:00', repeat: 'weekly' },
				CTX,
			),
		);
		assert.equal((s.hits[0].body as { repeat: string }).repeat, 'weekly');
		// 没传就是没传 —— 不塞一个空的 []（那会让服务端分不清"没指定"与"指定了零天"）
		assert.equal((s.hits[0].body as { repeatDays?: unknown }).repeatDays, undefined);
		assert.match(out.text, /每周一重复/, '念回去才知道它理解成了哪几天');
	} finally {
		await s.close();
	}
});

test('schedule_task：weekly 多天时 body 带 repeatDays，并念回"每周一三五"', async () => {
	const s = await stub({
		code: 0,
		data: { task: taskRow({ repeat: 'weekly', repeatDays: [1, 3, 5] }) },
	});
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).schedule_task.execute!(
				{
					goal: '每周一三五放歌',
					dueAt: '2026-09-28T07:00:00+08:00',
					repeat: 'weekly',
					repeatDays: [1, 3, 5],
				},
				CTX,
			),
		);
		assert.deepEqual((s.hits[0].body as { repeatDays: number[] }).repeatDays, [1, 3, 5]);
		// 频率说漏了，模型就会以为"排上了"等于"按我要的排上了" —— 而每周一与每天差七倍
		assert.match(out.text, /每周一三五重复/);
	} finally {
		await s.close();
	}
});

test('schedule_task：服务端没返回 task → 明确失败，不许回一句"已排期"', async () => {
	// 这是 kind:'unknown' 的真实用法：信封是成功的，但缺了我们要的那个字段。
	// 这里若静默当成功，模型会对用户说"记下了" —— 而库里什么都没有，
	// 用户会一直干等（见 `server/agent/tasks.ts` 的失败语义）。
	const s = await stub({ code: 0, data: {} });
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).schedule_task.execute!(
				{ goal: 'g', dueAt: '2026-09-24T07:00:00+08:00' },
				CTX,
			),
		);
		assert.equal(out.ok, false);
		assert.equal(out.kind, 'unknown');
		assert.match(out.text, /没有返回任务/);
	} finally {
		await s.close();
	}
});

test('schedule_task：排期失败要说出来（"说了记住了、其实没排上"是最坏的结果）', async () => {
	const s = await stub({ code: 500, message: '磁盘满了' }, 500);
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).schedule_task.execute!(
				{ goal: 'g', dueAt: '2026-09-24T07:00:00+08:00' },
				CTX,
			),
		);
		assert.equal(out.ok, false);
		assert.equal(out.kind, 'unavailable');
		assert.match(out.text, /^排期失败：磁盘满了/);
	} finally {
		await s.close();
	}
});

test('list_scheduled_tasks：GET /api/tasks；空库给一句可直说的话', async () => {
	const s = await stub({ code: 0, data: { open: [], closed: [] } });
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).list_scheduled_tasks.execute!({}, CTX),
		);
		assert.equal(s.hits[0].method, 'GET');
		assert.equal(s.hits[0].path, '/api/tasks');
		assert.equal(out.text, '还没有排过任何任务。');
	} finally {
		await s.close();
	}
});

test('list_scheduled_tasks：待执行的与做过的都要报，且状态说清楚', async () => {
	const s = await stub({
		code: 0,
		data: {
			open: [
				taskRow({ id: 't-1', goal: '明早放轻音乐' }),
				taskRow({ id: 't-2', goal: '十分钟后暂停', status: 'running' }),
			],
			closed: [
				taskRow({ id: 't-3', goal: '昨天那件事', status: 'done', result: '已播放《荷塘月色》' }),
				taskRow({ id: 't-4', goal: '不想要了', status: 'cancelled' }),
				taskRow({ id: 't-5', goal: '放不出来', status: 'failed', lastError: '曲库是空的' }),
			],
		},
	});
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).list_scheduled_tasks.execute!({}, CTX),
		);
		assert.equal(out.ok, true);
		assert.match(out.text, /待执行（按该做的时间）：/);
		assert.match(out.text, /最近做过的：/);
		// 撤销要靠 id，所以"还没做"的那几行必须带上它
		assert.match(out.text, /id=t-1/);
		// 正在做的要看得见：用户问"排上了吗"时它可能正在做，答"还没做"是错的
		assert.match(out.text, /（正在做）/);
		// 三种收尾状态各要说清 —— "完成了""取消了""失败了"对用户是三件不同的事，
		// 混成一句"已结束"会让模型把失败的任务说成做过了
		assert.match(out.text, /· 已完成｜昨天那件事｜已播放《荷塘月色》/);
		assert.match(out.text, /· 已取消｜不想要了｜/);
		assert.match(out.text, /· 失败｜放不出来｜曲库是空的/);
	} finally {
		await s.close();
	}
});

test('list_scheduled_tasks：只报未完成会让模型把"做过的事"答成"没有这件事"', async () => {
	// 这条是 `closed` 那一段存在的理由。断言方式刻意选成"有 open 也有 closed 时，
	// 两者的内容都出现在同一段话里" —— 只出现 open 就算红。
	const s = await stub({
		code: 0,
		data: {
			open: [taskRow({ id: 't-a', goal: '还没做的' })],
			closed: [taskRow({ id: 't-b', goal: '做过的', status: 'done', result: '做了' })],
		},
	});
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).list_scheduled_tasks.execute!({}, CTX),
		);
		assert.match(out.text, /还没做的/);
		assert.match(out.text, /做过的/);
	} finally {
		await s.close();
	}
});

test('list_scheduled_tasks：清单里要标出频率（否则"每周一"与"就这一次"长得一样）', async () => {
	// 用户说「把每周那件撤了」时，模型只能靠这一行里的频率去认 —— 认错就撤掉另一件，
	// 而撤回是**不可逆**的（撤掉的不会自己回来）。
	const s = await stub({
		code: 0,
		data: {
			open: [
				taskRow({ id: 't-w', goal: '每周一放歌', repeat: 'weekly', repeatDays: [1, 3, 5] }),
				taskRow({ id: 't-d', goal: '每天放新闻', repeat: 'daily' }),
				taskRow({ id: 't-o', goal: '明早放歌' }),
			],
			closed: [],
		},
	});
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).list_scheduled_tasks.execute!({}, CTX),
		);
		assert.match(out.text, /（每周一三五）/);
		assert.match(out.text, /（每天）/);
		// 只做一次的**不加括号**：多一个空括号会让人以为"这里本来该有个频率"
		assert.ok(!/（\s*）/.test(out.text), '不该出现空的频率括号');
		assert.match(out.text, /id=t-o/);
	} finally {
		await s.close();
	}
});

test('cancel_scheduled_task：PATCH /api/tasks，body 只有 {id}', async () => {
	const s = await stub({ code: 0, data: { id: 't-1', cancelled: true } });
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).cancel_scheduled_task.execute!({ id: 't-1' }, CTX),
		);
		assert.equal(s.hits[0].method, 'PATCH');
		assert.equal(s.hits[0].path, '/api/tasks');
		assert.deepEqual(s.hits[0].body, { id: 't-1' });
		assert.equal(out.ok, true);
		assert.match(out.text, /已撤销排期 t-1/);
	} finally {
		await s.close();
	}
});

test('cancel_scheduled_task：cancelled=false 是"来晚了一步"，**不是失败**', async () => {
	// 做成 ok:false 的话，模型会对用户说"取消失败了" —— 而那件事其实是
	// **已经做完了**（或 id 不对）。两种都不该报成错误，让模型如实说就行。
	const s = await stub({ code: 0, data: { id: 't-1', cancelled: false } });
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).cancel_scheduled_task.execute!({ id: 't-1' }, CTX),
		);
		assert.equal(out.ok, true);
		assert.equal(out.kind, undefined);
		assert.match(out.text, /没有改动任何东西/);
	} finally {
		await s.close();
	}
});

test('cancel_scheduled_task：撤不到要说得出原因（模型据此决定要不要换个 id 再试）', async () => {
	const s = await stub({ code: 404, message: '没有这件任务' }, 404);
	try {
		const out = await run(
			createTools({ baseUrl: s.baseUrl }).cancel_scheduled_task.execute!({ id: '编的' }, CTX),
		);
		assert.equal(out.ok, false);
		assert.equal(out.kind, 'not_found');
		assert.match(out.text, /^撤销失败：/);
	} finally {
		await s.close();
	}
});
