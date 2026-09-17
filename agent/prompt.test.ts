/**
 * `agent/prompt.ts` 单测 —— 只覆盖 `buildSystemPrompt` 里那段**动态**的部分。
 *
 * 为什么值得测：静态正文（铁律、工作方式）改一次就是一次人工 review，写测试只会
 * 变成"改 prompt 就得改测试"的噪音。真正会悄悄错的是把快照翻译成人话的那几行：
 *  - 状态三元判断写反 → 已暂停被说成"播放中"，模型据此答错，但代码不报错；
 *  - 前端没上报时留给模型的是一句 `undefined` / `null` ——模板字面量漏字段的典型
 *    产物，模型会照着这个字面量理解处境。
 * 所以这里只钉"翻译"这一层：快照 → 状态块（⑦，含队列列表），偏好列表 → 偏好块（⑥）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlayerSnapshot } from '../contract/player';
import { buildSystemPrompt } from './prompt';

/** 造一个 n 首的队列。曲名可预期，方便断言窗口取到了哪几首。 */
const QUEUE_OF = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		id: `曲目${i + 1}.mp3`,
		title: `曲目${i + 1}`,
		artist: '测试歌手',
	}));

const snap = (over: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
	state: 'playing',
	// id 形态取真实值（曲库内相对路径），不用已经退休的 `track-N`
	// —— fixture 用旧形态会让人以为 id 还是编号。
	currentTrack: {
		id: '荷塘月色 - 凤凰传奇.mp3',
		title: '荷塘月色',
		artist: '凤凰传奇',
		album: '最炫民族风',
		hasCover: true,
	},
	positionSec: 42,
	// 这三个字段必须**自洽**：queueSize 6 / queueIndex 2 就得真有 6 项。
	// 从前这里只放 1 项，于是「队列列表」只能走进"数组比条数短"的降级分支——
	// 测试照样绿，却没测到主路径（差一个窗口就整段失效，而断言看不见）。
	queueSize: 6,
	queueIndex: 2,
	queue: QUEUE_OF(6),
	// 队列来源：默认是「整个曲库」，此时不该在提示词里多一句解释（见 queueLines）。
	queueSource: 'library',
	queueLabel: null,
	// 设备侧设定：**必须给全**，否则模型看到的是 undefined% —— 而它本来就
	// 靠这几个数回答「现在多大声」「是不是单曲循环」（见 stateLines）。
	volume: 0.8,
	mode: 'seq',
	shuffle: false,
	...over,
});

test('buildSystemPrompt：播放中', () => {
	const p = buildSystemPrompt(snap());
	assert.match(p, /状态：播放中/);
	assert.match(p, /当前曲目：荷塘月色 — 凤凰传奇/);
	assert.match(p, /队列：共 6 首，当前第 3 首/); // queueIndex 是 0 基，展示要 +1
});

test('buildSystemPrompt：已暂停 / 未播放', () => {
	assert.match(buildSystemPrompt(snap({ state: 'paused' })), /状态：已暂停/);
	assert.match(buildSystemPrompt(snap({ state: 'stopped' })), /状态：未播放/);
});

test('buildSystemPrompt：无曲目、空队列', () => {
	const p = buildSystemPrompt(snap({ currentTrack: null, queueSize: 0, queueIndex: 0, queue: [] }));
	assert.match(p, /当前曲目：（无）/);
	assert.match(p, /队列：（空）/);
});

test('buildSystemPrompt：前端未上报时的兜底', () => {
	const p = buildSystemPrompt(null);
	assert.match(p, /前端未上报/);
	assert.doesNotMatch(p, /undefined|null/); // 模板漏字段的字面量不能漏给模型
});

test('buildSystemPrompt：快照齐备时不得出现 undefined / null 字面量', () => {
	for (const s of [snap(), snap({ state: 'paused' }), snap({ currentTrack: null })]) {
		assert.doesNotMatch(buildSystemPrompt(s), /undefined|null/);
	}
});

/* ── ⑥ 记忆的注入面（2026-09-16 加）────────────────────────────────── */

test('buildSystemPrompt：偏好逐条注入，并带上 key', () => {
	// key 是给模型看的：它据此知道改主意时该覆盖哪个，而不是另记一条。
	const p = buildSystemPrompt(snap(), [
		{ key: 'disliked_genre', value: '摇滚' },
		{ key: 'quiet_at_night', value: '睡前放轻音乐' },
	]);
	assert.match(p, /已知偏好/);
	assert.match(p, /- 摇滚（disliked_genre）/);
	assert.match(p, /- 睡前放轻音乐（quiet_at_night）/);
});

test('buildSystemPrompt：没有偏好时给一句可执行的说明，而不是留空', () => {
	// 留空的话模型分不清「没有偏好」和「你没把偏好传进来」——前者该照常服务，
	// 后者意味着它以为自己失明了。一句「暂无」+ 该怎么做，才不留歧义。
	for (const input of [undefined, null, []]) {
		const p = buildSystemPrompt(snap(), input);
		assert.match(p, /已知偏好[\s\S]*（暂无）/, `输入 ${JSON.stringify(input)} 时未给出兜底说明`);
	}
});

test('buildSystemPrompt：偏好与实时状态互不吞并（两条都在，顺序稳定）', () => {
	const p = buildSystemPrompt(snap(), [{ key: 'disliked_genre', value: '摇滚' }]);
	assert.match(p, /状态：播放中/);
	assert.match(p, /disliked_genre/);
	// 断言用**小节标题**而不是关键词：BODY 里为了写铁律提到过这两个中文词
	// （「看下面的【当前播放状态】」「【已知偏好】里已经有的意思不要重复记」），
	// 用裸关键词会命中那些提及，测出来的顺序就不是小节顺序了。
	assert.ok(
		p.indexOf('## 当前播放状态') < p.indexOf('## 已知偏好'),
		'状态块应在偏好块之前',
	);
});

test('buildSystemPrompt：偏好为空或缺省时不得出现 undefined / null 字面量', () => {
	for (const input of [undefined, null, []]) {
		assert.doesNotMatch(buildSystemPrompt(snap(), input), /undefined|null/);
	}
});

/* ── ⑦ 的队列列表（2026-09-17 加）────────────────────────────────────
 *
 * 为什么值得测：`jump_in_queue` 的 `position` **唯一**的参照就是这个列表。
 * 它一坏，工具不是报错而是**跳去另一首**——模型拿着一个没有参照的数字，
 * 猜错了也不会有人发现。所以这里钉三件事：编号从 1 开始、当前那一首有标记、
 * 长队列真的被裁成窗口（裁不掉的话，几百首的曲库会把提示词撑爆）。
 */

test('队列列表：编号从 1 开始，当前那一首有 ▶ 标记', () => {
	const p = buildSystemPrompt(snap()); // 6 首、当前第 3 首
	assert.match(p, /▶ 第 3 首：曲目3 — 测试歌手/);
	assert.match(p, /· 第 1 首：曲目1 — 测试歌手/);
	assert.match(p, /· 第 6 首：曲目6 — 测试歌手/);
	// 6 首 ≤ 窗口（前后各 4）+ 1，整列都在，不该出现「略」
	assert.doesNotMatch(p, /首略/);
});

test('队列列表：长队列只展示当前附近，两侧用「略」交代剩余', () => {
	const long = Array.from({ length: 20 }, (_, i) => ({
		id: `长${i + 1}.mp3`,
		title: `长${i + 1}`,
		artist: '歌手',
	}));
	// 20 首、当前第 11 首（0 基 10）→ 窗口 7..15，前面 6 首、后面 5 首
	const p = buildSystemPrompt(snap({ queueSize: 20, queueIndex: 10, queue: long }));
	assert.match(p, /（前 6 首略）/);
	assert.match(p, /（后 5 首略）/);
	assert.match(p, /▶ 第 11 首：长11 — 歌手/);
	assert.match(p, /· 第 7 首：长7 — 歌手/);
	assert.match(p, /· 第 15 首：长15 — 歌手/);
	// 窗口外的**一个都不能漏进来**——否则"窗口"没生效，行数会随曲库长度长
	assert.doesNotMatch(p, /长6 —/);
	assert.doesNotMatch(p, /长16 —/);
});

test('队列列表：前端只给了条数、没给数组时退回摘要，不编造歌名', () => {
	const p = buildSystemPrompt(snap({ queue: [] }));
	assert.match(p, /队列：共 6 首，当前第 3 首/);
	assert.doesNotMatch(p, /第 1 首：/);
});

test('队列列表：有队列但没在放时，不许写成「当前第 0 首」', () => {
	// queueIndex 为 -1 是「播完停止」的样子——+1 之后就变成「当前第 0 首」，
	// 模型会把这句当事实转述给用户。这类"差一"错误只在展示层出现，代码不报错。
	const p = buildSystemPrompt(snap({ state: 'stopped', currentTrack: null, queueIndex: -1 }));
	assert.match(p, /队列：共 6 首$/m);
	assert.doesNotMatch(p, /当前第 0 首/);
	// 当前项没有指向任何一首，标记也不能乱标
	assert.doesNotMatch(p, /▶/);
});

test('队列列表：不得出现 undefined / null 字面量（空数组也没有）', () => {
	for (const s of [snap({ queue: [] }), snap({ queueIndex: -1 }), snap({ queueSize: 0, queue: [] })]) {
		assert.doesNotMatch(buildSystemPrompt(s), /undefined|null/);
	}
});

/* ── ⑦ 的音量与播放方式（2026-09-17 加）────────────────────────────────
 *
 * 为什么值得测：这两个数是 `set_volume` / `set_playback_mode` 的**输入**。
 * 「小声点」是相对量——提示词里没有当前值时，模型只能凭空挑一个数（可能从 80%
 * 一口气设成 5%），而它猜错的方式用户当场就能听出来。所以这里钉：两个数都在、
 * 单位是百分数、三种模式各有各的中文名（不给 `rpt` 这种只有代码看得懂的词）。
 */

test('播放状态块：音量按百分数写出来，一眼能懂', () => {
	// 0.8 → 「80%」。写成 0.8 的话模型要么照抄给用户（"音量已设为 0.8"），
	// 要么自己乘 100——两种都是本可以不必发生的偏差。
	assert.match(buildSystemPrompt(snap({ volume: 0.8 })), /音量：80%/);
	assert.match(buildSystemPrompt(snap({ volume: 0 })), /音量：0%/);
	assert.match(buildSystemPrompt(snap({ volume: 1 })), /音量：100%/);
});

test('播放状态块：三种循环方式各有中文名，不是 seq / rpt / one', () => {
	assert.match(buildSystemPrompt(snap({ mode: 'seq' })), /播放方式：顺序播放/);
	assert.match(buildSystemPrompt(snap({ mode: 'rpt' })), /播放方式：列表循环/);
	assert.match(buildSystemPrompt(snap({ mode: 'one' })), /播放方式：单曲循环/);
	// 随机是**独立开关**，要与循环方式一起出现，不能被它盖掉
	assert.match(buildSystemPrompt(snap({ mode: 'one', shuffle: true })), /播放方式：单曲循环（随机）/);
	assert.match(buildSystemPrompt(snap({ shuffle: false })), /播放方式：顺序播放\n/);
});

test('队列来源：自定义队列要写清「按什么挑的」，默认整库时不啰嗦', () => {
	const custom = buildSystemPrompt(snap({ queueSource: 'custom', queueLabel: '安静的歌' }));
	assert.match(custom, /队列：共 6 首（按「安静的歌」挑的一批），当前第 3 首/);
	// 整库那一批不加这句：那是默认形态，写出来只是噪音（而且每轮都在）
	assert.doesNotMatch(buildSystemPrompt(snap()), /挑的一批/);
	// 有 custom 但没 label（理论上不该发生）时也不能吐出 undefined
	const bare = buildSystemPrompt(snap({ queueSource: 'custom', queueLabel: null }));
	assert.doesNotMatch(bare, /undefined|null/);
});
