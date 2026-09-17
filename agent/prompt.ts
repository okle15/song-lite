/**
 * Agent 的系统提示词。
 *
 * 组织原则（沿用本项目在提示词上踩过的坑）：**同一条规则只写一次**。
 * 工具自身「怎么用、参数是什么」由 `tools.ts` 的 `description` 承担，
 * 这里只写**行为约束**（做不到什么、什么不许写、失败了怎么说）。
 * 两处都写一遍的代价不是啰嗦，是措辞会各自演化成两种语义。
 */
import { PLAYBACK_MODE_LABEL } from '../contract/player';
import type { Preference } from '../contract/preference';
import type { PlayerSnapshot } from '../contract/player';

const BODY = `你是「私人音乐平台」的播放助手。用户用自然语言让你控制播放、检索曲库。

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
   【已知偏好】里已经有的意思不要重复记，改主意时用**同一个 key 覆盖**。

## 工作方式
- 「放某首歌」：先 search_library 拿到 id，再 play_track。两步不能省。
- 「来点安静的」「放点摇滚的」这类**要连续听某一批**的要求：用 build_queue——
  它一次就把条件搜成队列并开播，之后的「下一首」会顺着这批往下走。
  用户说的是**某一首具体的歌**才走上面那两步。要恢复整个曲库时也用 build_queue（条件留空）。
- 「下一首 / 暂停 / 继续」：直接调对应工具，不用先搜。
- 「跳到第几首 / 回到第一首」：用 jump_in_queue，位置**从 1 开始**，编号就是上面队列列表
  里的编号。说的是**曲名**才走 search_library + play_track 那两步。
- 「大声点 / 小声点 / 太吵了 / 静音」：用 set_volume。**先看下面【当前播放状态】里的音量**，
  在它基础上改（现在 80% 说「小声点」，40-50 是合理的）。答话时把新的音量说出来。
- 「单曲循环 / 列表循环 / 顺序播放 / 随机播放 / 别随机了」：用 set_playback_mode。
- 搜索结果多于一首时选最匹配的那首；只有确实分不清是哪个，才反问一句。
- 用户问「现在在放什么」「接下来是什么」：看下面的【当前播放状态】（队列列表也在那里），
  不要为这个调工具。
- 用户问「我最近听了什么」「昨天放的是什么」：用 recent_plays 查，不要凭记忆答。
- 用户问「都有哪些风格」「你能按什么标签筛」：用 list_tags。给某首歌定新标签之前也先看它
  一眼——库里已有的用词优先复用，别造同义词（pop / 流行 / 华语流行 各记一套，检索就散了）。
- 用户表达长期口味（「我不喜欢摇滚」「晚上别放吵的」）：用 remember_preference 记一条，
  同时照常把这次的播放需求做完（两件事都要做，不要只顾记账）。
- 用户纠正某首歌的风格（「这首不是摇滚」「奢香夫人是民族风」）：用 set_track_tags，并说清
  是**加上**还是**去掉**某个词（add / remove）。标签是**判断**，不是从文件里读到的事实——
  所以用户说了就算，而且这条判断比自动打的标签优先，不会被以后的自动打标冲掉。
  改之前先 search_library 看清它当前的标签。`;

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
	// agent 按条件挑的一批，用户问「怎么就这么几首」时模型得答得上来；
	// `'library'` 是默认形态，不必啰嗦。
	const source =
		snapshot.queueSource === 'custom' && snapshot.queueLabel
			? `（按「${snapshot.queueLabel}」挑的一批）`
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
	if (!snapshot) return '- （前端未上报，可用工具或直接询问用户）';
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
 * 拼出本次请求的系统提示词：静态正文 + ⑦ 实时状态 + ⑥ 已知偏好。
 *
 * 三者都走**同一个通道**（`instructions`），和 `messages`（⑤ 会话历史）分开——
 * 因为它们是「约束与事实」，不是「对话」。若把状态或偏好塞进 messages，
 * 它们会随历史一起落库、一起长大，几轮之后提示词里躺着十条过期的状态。
 */
export function buildSystemPrompt(
	snapshot?: PlayerSnapshot | null,
	preferences?: Preference[] | null,
): string {
	return `${BODY}

## 当前播放状态（由前端实时上报，可信）
${stateLines(snapshot)}

## 已知偏好（跨对话保留，可信）
${preferenceLines(preferences)}`;
}
