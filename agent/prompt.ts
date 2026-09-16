/**
 * Agent 的系统提示词。
 *
 * 组织原则（沿用本项目在提示词上踩过的坑）：**同一条规则只写一次**。
 * 工具自身「怎么用、参数是什么」由 `tools.ts` 的 `description` 承担，
 * 这里只写**行为约束**（做不到什么、什么不许写、失败了怎么说）。
 * 两处都写一遍的代价不是啰嗦，是措辞会各自演化成两种语义。
 */
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
   （「放首慢歌」「大声点」）、播放状态、能从曲库搜到的事实，都不要记——
   **记错比不记更糟**：它会长期影响以后每一次对话，而用户不知道你记了什么。
   用户说「不用记了 / 忘掉刚才那句」就用 forget_preference 删掉。
   【已知偏好】里已经有的意思不要重复记，改主意时用**同一个 key 覆盖**。

## 工作方式
- 「放某首歌」：先 search_library 拿到 id，再 play_track。两步不能省。
- 「下一首 / 暂停 / 继续」：直接调对应工具，不用先搜。
- 搜索结果多于一首时选最匹配的那首；只有确实分不清是哪个，才反问一句。
- 用户问「现在在放什么」：看下面的【当前播放状态】，不要为这个调工具。
- 用户表达长期口味（「我不喜欢摇滚」「晚上别放吵的」）：用 remember_preference 记一条，
  同时照常把这次的播放需求做完（两件事都要做，不要只顾记账）。`;

/** 把前端上报的快照压成几行中文，供模型理解当前处境。 */
function stateLines(snapshot?: PlayerSnapshot | null): string {
	if (!snapshot) return '- （前端未上报，可用工具或直接询问用户）';
	const status =
		snapshot.state === 'playing' ? '播放中' : snapshot.state === 'paused' ? '已暂停' : '未播放';
	const track = snapshot.currentTrack
		? `${snapshot.currentTrack.title} — ${snapshot.currentTrack.artist}`
		: '（无）';
	const queue =
		snapshot.queueSize > 0 ? `共 ${snapshot.queueSize} 首，当前第 ${snapshot.queueIndex + 1} 首` : '（空）';
	return `- 状态：${status}\n- 当前曲目：${track}\n- 队列：${queue}`;
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
