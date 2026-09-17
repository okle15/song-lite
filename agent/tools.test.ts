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
import { createTools, formatPlayTime, summarizeTags } from './tools';

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
