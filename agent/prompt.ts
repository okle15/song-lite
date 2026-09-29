/**
 * Agent 的系统提示词。
 *
 * 组织原则（沿用本项目在提示词上踩过的坑）：**同一条规则只写一次**。
 * 工具自身「怎么用、参数是什么」由 `tools.ts` 的 `description` 承担，
 * 这里只写**行为约束**（做不到什么、什么不许写、失败了怎么说）。
 * 两处都写一遍的代价不是啰嗦，是措辞会各自演化成两种语义。
 *
 * ── 2026-09-23：正文分成「核心」与「补丁」两层 ──────────────────────────
 *
 * 起因是 `LEARNING.md` §1.2 那张表：里面列的每一条都是**为绕开模型当时的某种
 * 缺陷而写**的（寿命约一代），而它们和真正的边界（气泡只渲染纯文本、曲名只存在于
 * 曲库）**混在同一段文字里**，看不出谁该留、谁该走。
 *
 * 混着的代价不是"不够整齐"，是**没有判据**：想删一条只能靠感觉，感觉又会被
 * 「删了成功率会不会掉」的恐惧压住 —— 于是 prompt 只增不减。
 *
 * 所以这里把「会过时的那一层」抽成 `PATCHES`，每条一个 id、可以用环境变量
 * **单独关掉**。这不是为了让 prompt 变短，是为了让「这条补丁还需不需要」变成
 * 一个**能跑出数字的问题**：带 / 不带各跑一遍 `cases/` 里的失败案例集
 * （`npm run cases`），不带也过 → 删掉它。
 *
 * ⚠️ **别把核心也搬进 PATCHES**。判断标准见 LEARNING.md §0 的第四类：
 * 删掉它，是「模型行为变差」还是「产品事实被违反」？后一类（铁律 4 的纯文本气泡、
 * 铁律 6 的记忆准入标准、`set_track_tags` 的 add/remove 形状）**不是补丁，是边界**，
 * 关掉它产品就坏——它们留在 `CORE` 里，压根不给开关。
 */
import { createHash } from 'node:crypto';
import { PLAYBACK_MODE_LABEL } from '../contract/player';
import type { Preference } from '../contract/preference';
import type { PlayerSnapshot } from '../contract/player';
// ④ 引 ③ 的一个**纯格式化函数**（不是工具定义）：它与工具返回值必须用**同一种
// 时间写法**，否则模型核对不了自己算出来的时间 —— 两边各写一遍就是两处会漂移的
// 实现，而漂移的表现是"提示词里的现在"与"工具念回来的时间"长得不像同一件事。
import { formatAbsolute } from './tools';

/**
 * 静态正文里**不随任何开关变化**的部分：身份 + 能力边界 + 铁律。
 *
 * 铁律里有两条是「语气像补丁、其实是边界」的（LEARNING.md §0 第四类），
 * 所以它们虽然读起来像"提醒模型"，也只能待在这里：
 *   - 铁律 4「不要用 Markdown」→ 对话气泡**只渲染纯文本**，模型强到天上去，
 *     星号写进去也是原样显示；
 *   - 铁律 6「只有稳定的偏好才值得记」→ 这是**记忆的准入标准**，是这个产品的定义。
 */
const CORE = `你是「私人音乐平台」的播放助手。用户用自然语言让你控制播放、检索曲库。

## 能力边界
你**只能**通过工具操作播放器，没有别的能力。不存在的工具就是做不到的事，
直接说明做不到，不要假装完成了。

## 铁律
1. **曲名 / 歌手只能来自工具返回值**。这个曲库里有什么歌，只有 search_library
   说了算——不要凭记忆写曲名，不要猜 id。宁可多搜一次。
2. **工具失败必须如实告知**。工具返回失败时把原因说给用户（如「曲目不存在」），
   不许改口说「已为你播放」。失败后不要用同样的参数重试第二次。
3. **不要输出裸 JSON 或工具调用语法**。要调工具就调；给用户的回答是自然语言。
4. **不要用 Markdown 标记**（\`**粗体**\`、\`#\` 标题、反引号等）。对话气泡只渲染
   纯文本，写进去的星号和井号会**原样显示**出来，看起来像坏掉了。
   想强调曲名就直接写，不需要装饰。
5. **回答短**。用户在听歌，不需要长篇解释——一句话说清做了什么即可。
6. **只有稳定的偏好与长期约束才值得记**（remember_preference）。一次性的要求
   （「放首慢歌」「大声点」「就循环这一首」）、播放状态、能从曲库搜到的事实，都不要记——
   **音量与播放方式属于设备侧的临时状态**，改完就完了，当成偏好记下来只会
   在下次对话里冒出一句莫名其妙的约束。
   **记错比不记更糟**：它会长期影响以后每一次对话，而用户不知道你记了什么。
   用户说「不用记了 / 忘掉刚才那句」就用 forget_preference 删掉。
   【已知偏好】里已经有的意思不要重复记，改主意时用**同一个 key 覆盖**。`;

/**
 * **可退役的补丁段落**。
 *
 * 每一条的形状都是「某类说法 → 该调哪个工具」——也就是一份**路由表**。
 * 它的存在理由是：模型自己挑工具时偶尔挑错（「放点安静的」走 play_track
 * 而不是 build_queue，于是队列停在整库）。这个理由**会随模型换代变薄**，
 * 而且已经有一条更强的替代路径：每个工具的 `description` 里本来就写着
 * 「什么时候用它」。两者重叠。
 *
 * 所以它的处置方式是「带失败案例观察，准备删」——不是现在删，也不是永远留。
 */
export const PATCHES = {
	work_style: {
		label: '工作方式',
		text: `## 工作方式
- 「放某首歌」：先 search_library 拿到 id，再 play_track。两步不能省。
- 「来点安静的」「放点摇滚的」这类**要连续听某一批**的要求：用 build_queue——
  它一次就把条件搜成队列并开播，之后的「下一首」会顺着这批往下走。
  用户说的是**某一首具体的歌**才走上面那两步。要恢复整个曲库时也用 build_queue（条件留空）。
- 「下一首 / 暂停 / 继续」：直接调对应工具，不用先搜。
- 「跳到第几首 / 回到第一首」：用 jump_in_queue，位置**从 1 开始**，编号就是上面队列列表
  里的编号。说的是**曲名**才走 search_library + play_track 那两步。
- 「这首别放了 / 把刚才那首从队列里去掉」：用 remove_from_queue，trackId 先 search_library 拿到。
  **不要拿 build_queue 代替** —— 它是换掉整队；用户说的是"去掉一首"，用换批去实现会把他原来
  那一批也带走，而这一步不会报错。去掉的正好是正在放的那首时**播放不会停**，会接着往下走。
- 「大声点 / 小声点 / 太吵了 / 静音」：用 set_volume。**先看下面【当前状态】里的音量**，
  在它基础上改（现在 80% 说「小声点」，40-50 是合理的）。答话时把新的音量说出来。
- 「单曲循环 / 列表循环 / 顺序播放 / 随机播放 / 别随机了」：用 set_playback_mode。
- 搜索结果多于一首时选最匹配的那首；只有确实分不清是哪个，才反问一句。
- 用户问「现在在放什么」「接下来是什么」：看下面的【当前状态】（队列列表也在那里），
  不要为这个调工具。**唯一例外是本轮你自己动过播放**（调过 play_track / next_track /
  build_queue 这类），那时它上面的曲目已经旧了，以工具返回值为准。
- 用户问「我最近听了什么」「昨天放的是什么」：用 recent_plays 查，不要凭记忆答。
- 用户问「都有哪些风格」「你能按什么标签筛」：用 list_tags。给某首歌定新标签之前也先看它
  一眼——库里已有的用词优先复用，别造同义词（pop / 流行 / 华语流行 各记一套，检索就散了）。
- **搜不到 ≠ 没有这首歌**：曲库是扫出来的，用户刚丢进目录的歌要 rescan_library 重扫一次
  才可见。用户说「我加了新歌」「怎么搜不到我刚下的那首」→ 先重扫再搜，别直接说"库里没有"。
- 要按歌手 / 专辑 / 风格挑歌，先 list_library_groups 看一眼库里**实际有哪些名字**，
  别凭印象猜（猜错就变成"搜不到"，然后你会去告诉用户一首他根本没有的歌不存在）。
- 用户表达长期口味（「我不喜欢摇滚」「晚上别放吵的」）：用 remember_preference 记一条，
  同时照常把这次的播放需求做完（两件事都要做，不要只顾记账）。
- 用户纠正某首歌的风格（「这首不是摇滚」「奢香夫人是民族风」）：用 set_track_tags，并说清
  是**加上**还是**去掉**某个词（add / remove）。标签是**判断**，不是从文件里读到的事实——
  所以用户说了就算，而且这条判断比自动打的标签优先，不会被以后的自动打标冲掉。
  改之前先 search_library 看清它当前的标签。
- 「明天早上 / 每天 / 每周几」这类**说了时间的将来事**（「明早七点放首歌」「每天早上放点新闻」
  「每周一给我推一批」）：用 schedule_task，dueAt 自己按下面【现在】算出 ISO 时间。
  **频率要说对**：每天 → repeat=daily；「每周几」→ repeat=weekly（只重复一天时不用传
  repeatDays，dueAt 落在星期几就是星期几）；「每周一三五」这种多天 → repeatDays 给 0–6。
  返回值会把时间与频率念回来，**照着核一遍**再说给用户 —— 排错时间不会报错，
  它只会在错的时间响，或者根本不响。用户要的是**现在**就做，就别用这个工具，直接做。`,
	},
} as const;

export type PatchId = keyof typeof PATCHES;

/** 全部补丁 id，顺序即正文里的出现顺序（指纹依赖这个顺序，所以不许随手重排）。 */
export const PATCH_IDS = Object.keys(PATCHES) as PatchId[];

/** 控制补丁关闭的环境变量名。值形如 `work_style` 或 `a,b`。 */
const DISABLE_ENV = 'PROMPT_DISABLE';

/**
 * 本轮关掉了哪些补丁。**每次调用重新求值**（与 `server/db.ts` 的 `resolveDbPath`
 * 同一个理由：模块加载时定死的话，进程起来之后改环境变量就不生效了——而
 * `PROMPT_DISABLE` 的用法恰恰是"换一个值再起一个进程"，测试也靠它造两种版本）。
 *
 * ⚠️ 返回值**不过滤未知项**，这是有意的：把 `work_style` 拼成 `wrok_style` 时，
 * 静默忽略的后果是「你以为跑了不带补丁的一遍，其实带着」——报告会说
 * 「不带补丁也能过」，而那是个假结论。这里保留原样，于是拼错会同时体现在两处：
 * `agent_turns.prompt_disabled` 列里看得见，且指纹与任何一版都不同
 * （见 `promptVersion`），数字不会悄悄混进别的组。
 */
export function disabledPatches(): string[] {
	const raw = process.env[DISABLE_ENV];
	if (!raw) return [];
	return raw
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** 关不掉的 id（拼错、或写了个已删除的补丁名）。给调用方发一条醒目的日志。 */
export function unknownPatchIds(disabled: string[] = disabledPatches()): string[] {
	return disabled.filter((id) => !(id in PATCHES));
}

/**
 * 静态正文 = CORE + 所有**未关闭**的补丁，按 `PATCH_IDS` 的顺序。
 *
 * 关掉的段落不是"留空"而是**整段消失**——这很重要：留一行「（本节已关闭）」
 * 会额外改变提示词长度与语义，让"带/不带"这组对比多出一个不属于补丁的变量。
 */
function staticPrompt(disabled: string[] = disabledPatches()): string {
	const blocks = [CORE];
	for (const id of PATCH_IDS) {
		if (disabled.includes(id)) continue;
		blocks.push(PATCHES[id].text);
	}
	return blocks.join('\n\n');
}

/**
 * 本轮提示词的**指纹**（8 位十六进制）—— `agent_turns.prompt_version` 的来源。
 *
 * 它只覆盖**静态正文与开关清单**，不含 ⑦ 状态与 ⑥ 偏好：那两块每轮都不一样，
 * 算进去就等于每轮一个版本，「按版本分组对比」这件事直接不成立。要分的是
 * **哪份提示词**，不是「哪一刻的提示词」。
 *
 * 关掉的补丁会改变指纹（因为它改变了正文），所以「带 work_style」与「不带」
 * 天然是两个版本，观测里的数字不会混在一起。BLUEPRINT §9 说 prompt 版本管理
 * 已从"可选项"变成前置，指的就是这件事。
 *
 * ⚠️ **开关清单本身也进 hash**，这一点单独写下来是因为它不直观：只 hash 正文的话，
 * 一个**拼错**的 id（`wrok_style`）不会改变正文（过滤器不认识它、什么也没关），
 * 于是指纹与默认版**完全相同** → 两版的行混进同一个分组 → 报告会给出
 * 「不带补丁也能通过」这个假结论。把清单拼进去，拼错至少让它是**独立的一组**。
 *
 * 取 8 位而不是全量：撞车概率（几个版本之间）可以忽略，而这一列要进每一行观测，
 * 还要在人眼前打印。
 */
export function promptVersion(disabled: string[] = disabledPatches()): string {
	const material = `${disabled.join(',')}\n${staticPrompt(disabled)}`;
	return createHash('sha256').update(material).digest('hex').slice(0, 8);
}

/**
 * 队列列表在提示词里**当前前后各展示几条**。
 *
 * 为什么是窗口而不是全量：队列默认就等于整个曲库（`ensureQueue(getSongs())`），
 * 曲库长到几百首时全量塞进去就是几百行——而模型真正用得上的只有"当前附近"：
 * 「接着放什么」「跳到第几首」参照的都是当前位置。窗口两侧各留一句
 * 「前 / 后 N 首略」，于是**行数恒定而信息不丢**。
 *
 * 没有这个列表时 `jump_in_queue` 的 position 是**没有参照**的——模型只能瞎猜，
 * 而且猜错不报错（跳过去另一首，用户还得自己发现）。
 */
const QUEUE_WINDOW = 4;

/** 队列那几行。条数取 `queueSize`、名字取 `queue` 数组——两者同源，但数组可能被截断。 */
function queueLines(snapshot: PlayerSnapshot): string {
	const { queueSize, queueIndex, queue } = snapshot;
	if (queueSize <= 0) return '- 队列：（空）';

	// queueIndex 是 0 基，展示一律 +1；-1 表示"队列在、但没在放"（播完停止的样子）
	const current = queueIndex >= 0 ? queueIndex : -1;
	// 队列**从哪来**要写出来（2026-09-17 起队列不再恒等于整库）：`'custom'` 是
	// 不跟着曲库变的一批。有名字的是 agent 按条件挑的（`build_queue`）；**没名字的是
	// 用户自己改过的**（从整库队列里去掉过歌，服务端就地提升成 custom，见 `removeFromQueue`）。
	// 两种都要说：前者答"怎么就这么几首"，后者答"为什么新加的歌没进来" —— 而后者
	// 恰恰是**没有任何名字可依托**的那一种，不写出来模型就只能看着一个普通的队列数目。
	// ⚠️ 与 `components/queue-view.ts` 的 `queueFootNote`（说给**用户**的同一件事）是双胞胎：
	// 那一个是浏览器里的常驻脚注，这一行是模型每轮看到的处境——两处措辞要一起改。
	const source =
		snapshot.queueSource === 'custom'
			? snapshot.queueLabel
				? `（按「${snapshot.queueLabel}」挑的一批）`
				: '（你改过的一批，不跟着曲库变）'
			: '';
	const head = `- 队列：共 ${queueSize} 首${source}${current >= 0 ? `，当前第 ${current + 1} 首` : ''}`;

	// 前端只带了部分队列（甚至没带数组）时，不再编造歌名，只给摘要
	if (queue.length === 0) return head;

	const anchor = Math.min(current >= 0 ? current : 0, queue.length - 1);
	const from = Math.max(0, anchor - QUEUE_WINDOW);
	const to = Math.min(queue.length, anchor + QUEUE_WINDOW + 1);
	const rows = [head];
	if (from > 0) rows.push(`  （前 ${from} 首略）`);
	for (let i = from; i < to; i++) {
		rows.push(`${i === current ? '▶' : '·'} 第 ${i + 1} 首：${queue[i].title} — ${queue[i].artist}`);
	}
	if (to < queue.length) rows.push(`  （后 ${queue.length - to} 首略）`);
	return rows.join('\n');
}

/** 把前端上报的快照压成几行中文，供模型理解当前处境。 */
function stateLines(snapshot?: PlayerSnapshot | null): string {
	// 「现在」**必须放在 ⑦ 里**，而且必须是每轮现算的：它是"此刻事实"，
	// 与播放状态同属 BLUEPRINT §2 对 ⑦ 的定义。2026-09-23 加它的直接原因很具体：
	// `schedule_task` 要求模型**自己算出 ISO 时间**，而在此之前提示词里根本没有
	// "现在几点"（`formatPlayTime` 的注释里早就记着这件事）—— 模型只能猜，而排期
	// 猜错**不会报错**：它会在错误的时间响，或者永远不响。
	//
	// 放这里还有个缓存上的好处：它在静态正文**之后**，所以前缀缓存不受影响
	// （⚠️ 谁把它挪到 `CORE` 前面，缓存就全废，且不报错 —— 见 LEARNING.md §5）。
	const now = `- 现在：${formatAbsolute(new Date().toISOString())}`;
	if (!snapshot) return `${now}\n- （前端未上报，可用工具或直接询问用户）`;
	const status =
		snapshot.state === 'playing' ? '播放中' : snapshot.state === 'paused' ? '已暂停' : '未播放';
	const track = snapshot.currentTrack
		? `${snapshot.currentTrack.title} — ${snapshot.currentTrack.artist}`
		: '（无）';
	// 音量与播放方式也要在这里露出来（2026-09-17 加）：它们本身改变不了什么，
	// 但**没有它们模型就改不动它们**——「小声点」是相对量，看不见当前值就只能瞎猜一个数，
	// 而猜错（从 80% 一口气设成 5%）用户当场就能听出来。
	// 这两项是设备侧的设定（前端随口上报、服务端镜像），所以与状态、曲目并列写在一行里。
	const settings =
		`- 音量：${Math.round(snapshot.volume * 100)}%` +
		`，播放方式：${PLAYBACK_MODE_LABEL[snapshot.mode]}${snapshot.shuffle ? '（随机）' : ''}`;
	return `- 状态：${status}\n- 当前曲目：${track}\n${queueLines(snapshot)}\n${settings}`;
}

/**
 * ⑥ 记忆的注入面 —— 把偏好列表压成几行。**全量注入**，不做检索：
 * 个人偏好是「少量、长期、每条都短」的（「不喜欢摇滚」），几十条也就几百 token，
 * 全量塞进提示词最简单也最可靠。向量检索是「偏好上万条」时才需要的解。
 *
 * 传 `key` 是有用的：模型因此知道改主意时该复用哪个 key 覆盖，而不是另记一条。
 */
function preferenceLines(preferences?: Preference[] | null): string {
	if (!preferences || preferences.length === 0) {
		return '- （暂无）用户表达稳定喜好时，用 remember_preference 记下来。';
	}
	return preferences.map((p) => `- ${p.value}（${p.key}）`).join('\n');
}

/**
 * ⑦ 那一块的免责说明 —— **不许再写「实时 / 可信」**（2026-09-21 改）。
 *
 * 这一块的有效期只到**模型自己第一次改动播放为止**。原因是结构性的：
 * `instructions` 是 `streamText` 的**参数**，求值一次，之后 `MAX_STEPS` 步循环里
 * 每一步用的都是同一份，而一轮生成实测 7–14 秒（e2e：14630 / 7060ms）。
 * 所以模型调完 play_track 再问「现在在放什么」，它手里还是开局那一眼。
 *
 * 措辞上不许**承诺做不到的事**：原来写「由前端实时上报，**可信**」——那是把
 * 「尽量新」说成了「就是现在」，代价是模型答出一个已经过期的曲名：用户当场
 * 就能发现，而这条链路上没有任何地方会报错。
 *
 * 判据只给一条，因为它是模型**自己就能执行**的：**你本轮动过播放，它就作废。**
 * 这是唯一免费的兜法——工具返回值本来就是权威的，不需要任何新代码。
 * 另两项（音量 / 播放方式）连这条都兜不住：它们的真相在浏览器里，服务端就算
 * 自己去取也只是镜像，所以只能说明"它是近似值"。
 *
 * 注：曲目 / 队列 / 播放状态现在由路由在请求进来时**现取**（`server/player/
 * prompt-snapshot.ts`），于是那几项不再是"浏览器发消息那一刻拍的副本"。但
 * **本轮内它仍然不会更新**——下面这段话说的正是后面这件事，改措辞时别混起来。
 */
const SNAPSHOT_NOTE = `⚠️ 它在本轮**不会自己更新**：
- **你本轮调用过任何改变播放 / 队列的工具之后，它就已经作废**——此后一律以**工具返回值**为准
  （工具会告诉你改成了什么），不要拿这里的老曲目去回答「现在在放什么」。
- 音量与播放方式是**设备侧**设定，上报有零点几秒延迟，只能当近似基准。
本轮你没有动过播放，就照它答，不必为此额外调工具。`;

/**
 * 拼出本次请求的系统提示词：静态正文（核心 + 启用中的补丁）+ ⑦ 播放快照 + ⑥ 已知偏好。
 *
 * 三者都走**同一个通道**（`instructions`），和 `messages`（⑤ 会话历史）分开——
 * 因为它们是「约束与事实」，不是「对话」。若把状态或偏好塞进 messages，
 * 它们会随历史一起落库、一起长大，几轮之后提示词里躺着十条过期的状态。
 *
 * 注意 `instructions` 是 `streamText` 的**参数**：求值一次，之后 `MAX_STEPS` 步循环里
 * 每一步用的都是同一份。所以这里拼进去的东西**天生是"开局快照"**，见 `SNAPSHOT_NOTE`。
 *
 * `disabled` 默认取环境变量；显式传入的用途是单测（钉住「关掉某条补丁后，
 * 它那段文字真的不在结果里」，而不是"我传了参数"）。
 */
export function buildSystemPrompt(
	snapshot?: PlayerSnapshot | null,
	preferences?: Preference[] | null,
	disabled: string[] = disabledPatches(),
): string {
	return `${staticPrompt(disabled)}

## 当前状态（收到本条消息时的状态）
${stateLines(snapshot)}

${SNAPSHOT_NOTE}

## 已知偏好（每轮现读，可信）
${preferenceLines(preferences)}`;
}
