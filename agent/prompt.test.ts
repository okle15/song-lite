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
import {
	PATCH_IDS,
	buildSystemPrompt,
	disabledPatches,
	promptVersion,
	unknownPatchIds,
} from './prompt';

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
	// （「看下面的【当前状态】」「【已知偏好】里已经有的意思不要重复记」），
	// 用裸关键词会命中那些提及，测出来的顺序就不是小节顺序了。
	assert.ok(
		p.indexOf('## 当前状态') < p.indexOf('## 已知偏好'),
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

/* ── ⑦ 有有效期，不是实时值（2026-09-21 加）──────────────────────────
 *
 * 为什么值得测：这一块原来写的是「由前端实时上报，**可信**」——那是把「尽量新」
 * 说成了「就是现在」，代价是模型答出一个已经过期的曲名：用户当场发现，而代码
 * 不报错、测试也不红。
 * （同一句承诺当时还散在另外两处：BODY 的「现在在放什么」那条工作方式、
 *   `set_volume` 的 description。三处一起改的，因为**同一件事写两遍就会各自演化**。）
 *
 * 同日稍后：曲目 / 队列 / 播放状态改由路由**现取**（`server/player/prompt-snapshot.ts`），
 * 于是"过期"只剩两头 —— ① 本轮内不会更新（模型自己调的工具会让它作废）
 * ② 音量 / 播放方式上报有延迟。下面两条钉的就是这两头，**别把它们又合成一句
 * "这是快照"了事**：合并之后判据就不可执行了。
 */

test('播放状态块：不许承诺「实时 / 可信」，且必须声明本轮内不会自己更新', () => {
	const p = buildSystemPrompt(snap());
	assert.match(p, /当前状态（收到本条消息时的状态）/);
	assert.match(p, /本轮\*\*不会自己更新\*\*/); // 真正的有效期：到模型自己动手为止
	assert.doesNotMatch(p, /实时上报/); // 它不是实时的
	assert.doesNotMatch(p, /状态（[^）]*可信/); // 也不许再用「可信」给它背书
});

test('播放状态块：过期判据必须可执行——以工具返回值为准', () => {
	// 「可能过期」这种描述模型**没法执行**：它不知道该在什么时候怀疑，就会照旧引用旧曲名。
	// 判据要落在**模型自己做过的事**上（本轮动过播放 → 那份快照作废），它才有得可依。
	const p = buildSystemPrompt(snap());
	assert.match(p, /调用过任何改变播放/);
	assert.match(p, /工具返回值\*\*为准/); // ⑦ 的免责说明里
	assert.match(p, /以工具返回值为准/); // BODY 的工作方式那条也要跟上
	// 但也不能矫枉过正成"每次答之前先确认一遍"——那等于把「不要为这个调工具」推翻
	assert.match(p, /不必为此额外调工具/);
});

/* ── 补丁段落与开关（2026-09-23 加：给「失败案例集」造入口）────────────
 *
 * 为什么值得测：`PROMPT_DISABLE` 是「这条补丁还需不需要」这个问题的**唯一入口**
 * ——关掉它、跑 `npm run cases`、看数字。所以它坏掉的方式不是"程序崩"，是
 * **研究结论错**，而且错得看不出来：
 *   - 关不掉 → 你以为跑了不带补丁的一遍，其实带着 → 结论「补丁还有用」（假阳性）；
 *   - 关太多 → 把边界（纯文本气泡、记忆准入）也关掉 → 产品坏掉，而 prompt 只是变短了；
 *   - 指纹不跟着变 → 两版的行混进同一组 → 数字对不出来，而那正是这整套东西的意义。
 * 下面四条各钉一个。
 */

test('补丁开关：关掉的段落**整段消失**，而且不连坐', () => {
	const on = buildSystemPrompt(snap());
	const off = buildSystemPrompt(snap(), null, ['work_style']);

	assert.match(on, /## 工作方式/);
	assert.doesNotMatch(off, /## 工作方式/, '关掉后这一节必须整段不见，而不是留个空标题');
	assert.doesNotMatch(off, /放某首歌/, '正文也不能有残留');

	// 关一个不能连坐。这条不是洁癖：如果实现是"整份正文重拼"，关一个补丁顺手丢掉
	// 别的东西时，上面两条断言照样绿 —— 而对比出来的差别就不再是这个补丁造成的了。
	assert.match(off, /## 能力边界/);
	assert.match(off, /## 当前状态/);
	assert.match(off, /## 已知偏好/);
});

test('补丁全关掉，边界也必须在：铁律 4 / 6 不是补丁', () => {
	// LEARNING.md §0 的第四类：读起来像"提醒模型"，删掉产品就坏。判据是
	// 「删掉它，是模型行为变差、还是产品事实被违反」——后一类**不给开关**。
	// 这条钉的是"别顺手把边界也登记进 PATCHES"这个动作本身。
	const p = buildSystemPrompt(snap(), null, [...PATCH_IDS]);
	assert.match(p, /不要用 Markdown 标记/, '气泡只渲染纯文本——关掉它产品就坏');
	assert.match(p, /只有稳定的偏好与长期约束才值得记/, '记忆的准入标准，是这个产品的定义');
	assert.match(p, /曲名 \/ 歌手只能来自工具返回值/);
	assert.match(p, /工具失败必须如实告知/);
});

test('指纹：同输入同值、改开关必变（它是分组对比的键）', () => {
	assert.equal(promptVersion([]), promptVersion([]), '同输入必须同值，否则"分组"无从谈起');
	assert.notEqual(promptVersion([]), promptVersion(['work_style']), '带 / 不带补丁必须是两个版本');
});

test('拼错的补丁 id 不静默：认得出、且不与默认版同组', () => {
	const bad = ['wrok_style'];
	assert.deepEqual(unknownPatchIds(bad), ['wrok_style'], '路由靠它发警告（否则一条手误没人知道）');
	assert.deepEqual(unknownPatchIds(['work_style']), [], '正确的 id 不该被算成未知');

	// 行为上它**什么也没关**（过滤器不认识它）——所以「不带补丁也能过」会是个假结论。
	// 唯一的补救是让它**看得见**：指纹不同，于是它不会冒充默认版混进去。
	assert.match(buildSystemPrompt(snap(), null, bad), /## 工作方式/, '未知 id 关不掉任何东西');
	assert.notEqual(promptVersion(bad), promptVersion([]), '但换了指纹，于是自成一版');
	assert.notEqual(promptVersion(bad), promptVersion(['work_style']), '也不等于"真的关掉"那一版');
});

test('PROMPT_DISABLE 是唯一入口：空格容错、未知项原样保留、每次都重新读', () => {
	const restore = process.env.PROMPT_DISABLE;
	try {
		delete process.env.PROMPT_DISABLE;
		assert.deepEqual(disabledPatches(), [], '没设 = 全启用');

		// 两侧空格必须吃掉：不然 `PROMPT_DISABLE= work_style` 会永远关不掉，
		// 而界面上一切正常——只是那条补丁一直在，研究结论因此反了。
		process.env.PROMPT_DISABLE = ' work_style ';
		assert.deepEqual(disabledPatches(), ['work_style']);
		assert.doesNotMatch(buildSystemPrompt(snap()), /## 工作方式/, '环境变量真能关掉它');

		process.env.PROMPT_DISABLE = 'work_style,nope';
		assert.deepEqual(disabledPatches(), ['work_style', 'nope'], '未知项原样保留（见上一条）');

		process.env.PROMPT_DISABLE = '';
		assert.deepEqual(disabledPatches(), [], '空串 = 全启用');

		// 「每次调用重新求值」在上面几步里已经被证明了：改完环境变量立刻生效。
		// 若哪天有人把它改成模块级常量，那几条断言会一起红——这正是要的效果，
		// 因为 `PROMPT_DISABLE` 的用法就是"换个值再起一个进程"。
	} finally {
		if (restore === undefined) delete process.env.PROMPT_DISABLE;
		else process.env.PROMPT_DISABLE = restore;
	}
});
