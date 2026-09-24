# 第一趟 · 跟着一次请求走

> 教材（带答案）。**读法：通读，不查代码**；读完再对着源码看一遍，那时每行都认得。
>
> 七站全在主干上、**全是 🔒**。会被学走的东西（🧊）不在主干里，它们藏在 ④ 提示词的
> 「工作方式」和 ③ 工具的「选择策略」里（`LEARNING.md` §1.2）。

---

# 站 0 · 全景

你敲一句「来点安静的」，到屏幕上出现回答，中间经过四个地方：

```
浏览器                    路由                      agent/run.ts              模型
  │                        │                            │                      │
  │  POST /api/agent       │                            │                      │
  │  {messages, snapshot}  │                            │                      │
  ├───────────────────────>│  ① 检查配置                │                      │
  │                        │  ② 取最后一句用户话        │                      │
  │                        │  ③ 生成 turnId（票根）     │                      │
  │                        ├───────────────────────────>│  ④ 转换（UIMessage→Model）│
  │                        │                            │  ⑤ 裁剪（丢掉旧轨迹）  │
  │                        │                            ├─────────────────────>│
  │                        │                            │  ⑥ 循环！要工具→执行→回填→再问
  │                        │<───────────────────────────┤  ⑦ 交回流             │
  │  <── SSE 流 ───────────┤  ⑧ 转帧 + 包响应           │                      │
  │                        │  ⑨ onEnd：落两处库         │                      │
```

**一句话**：`instructions` / `messages` / `tools` 是这一趟的全部输入，其余代码都在"准备这三个东西"和"把结果送出去"。

下面逐站看，**每站都问同一个问题：删了它会怎样？**

---

# 站 1 · 浏览器发了什么

请求体只有两个字段：

```ts
type Body = { messages?: UIMessage[]; snapshot?: Partial<PlayerSnapshot> | null };
```

- **`messages`** —— **整段会话历史**，不只本轮这句。有了它，你连着说「我想听 X」→「换一首」，第二句的「换」才知道换的是哪个。
- **`snapshot`** —— 播放状态，但**只取设备侧的四项**（音量 / 播放方式 / 随机 / 进度）。这几项的真相确实在浏览器里（服务端那份只是镜像）；而**曲目、队列、播放状态服务端自己就知道**，路由会现取——让浏览器当信使，那一圈只会丢信息（`server/player/prompt-snapshot.ts`）。

### `UIMessage` 不是字符串

消息的形状是 `parts` 数组（文字是一种 part、工具调用是另一种）。所以取"最后一句用户说了什么"**不能写** `messages.at(-1).content`：

```ts
const last = messages.filter((m) => m.role === 'user').at(-1);
return (last?.parts ?? []).filter(isTextUIPart).map((p) => p.text).join('').trim();
```

> **⚠️ 坑**：写成 `.content`，`tsc` 会拦你。**但真正该记住的是原因**——一条消息里可能**有一半不是文字**（工具轨迹、推理），"用户说的话"必须显式挑出来。

### 两行容易被忽略的

```ts
export const dynamic = 'force-dynamic';                  // SSE 不许静态优化
if (!message) return fail('message is required', 400);
```

第一行：被 Next 静态优化掉就没有流了。
第二行：**空消息在入口挡掉**——不然后面 `pruneMessages` 会把空消息当历史，产生一个"没有内容的用户轮次"，而模型面对空输入的行为不确定。

---

# 站 2 · 票根：`turnId` 为什么要提前生成

```ts
const turnId = crypto.randomUUID();
```

这行看着最没道理——**它在这里生成，却在两个完全不同的地方用到**：

| 用在哪 | 用途 |
|:---|:---|
| `generateMessageId: () => turnId` | 这条 assistant 消息的**主键**（存进 `messages`） |
| `recordTurn({ id: turnId, ... })` | `agent_turns` 表的主键（这一轮的观测行） |

**于是两张表天然可 join**——「说了什么」和「走了几步、花了多少」，不用发明关联字段：

```sql
SELECT m.content, t.steps, t.ms FROM messages m JOIN agent_turns t ON m.id = t.id;
```

### 为什么必须传 `generateMessageId`

**不传的后果不是"id 难看"，是数据丢失，而且不报错。**

SDK 大致是 `responseMessageId = generateMessageId != null ? ... : undefined`。少了它，这条回复的 id 是**空字符串**——而 id 是主键。于是每轮 assistant 回复**互相覆盖**，库里只留得下最后一条。

> **这个坑实测踩过（2026-09-16）。** 别背结论，记住**形状**：`id` 空 → 主键相同 → UPSERT 覆盖 → 静默丢数据。
> **凡是"某处缺省值会导致主键相同"的地方，都停下来看一眼。**

---

# 站 3 · 转换：`UIMessage` → `ModelMessage`

```ts
const history = await convertToModelMessages(opts.uiMessages, {
  tools,
  ignoreIncompleteToolCalls: true,
});
```

浏览器和数据库用 `UIMessage`（表现层形状），模型要 `ModelMessage`。**两种形状、两种用途，不能合并。**

### `ignoreIncompleteToolCalls` 治什么病

一种**必然发生**的脏数据：用户点了「停止」，那一轮的工具调用**只有 input、没有 output**。原样发上去，**下一轮的第一个请求就会炸**（`MissingToolResultsError`）——而且是在**用户早就忘了那次中断之后**。

> **⚠️ 两件事**：
> 1. 这里**没有 `try/catch`**——故意的。错误要冒泡到路由的 `onError`，统一变成前端一条可读的话。**在中间吞掉，前端就只剩一个悬空的"正在思考…"。**
> 2. **`await` 不能省**。省了**不会报类型错**（Promise 也是对象），错误会推迟到模型调用处，指向一个看不出因果的位置。这是 `run.ts` 最容易踩的一脚。
>
> **📌 SDK 的活**：形状转换、schema 对齐。**永远是你的**：哪些脏数据不许进模型、错误在哪一层被吞。

---

# 站 4 · 裁剪：丢掉「上轮搜了啥」

```ts
const messages = pruneMessages({
  messages: history,
  reasoning: 'none',
  toolCalls: 'before-last-message',
  emptyMessages: 'remove',
});
```

**为什么必须裁**：一轮工具调用比一句话啰嗦得多。搜一次曲库把 10 首歌写进历史就是几百 token，留 5 轮，**上下文一半是「上轮搜了啥」**——而它对下一轮通常没用：用户说「换一首」时，模型需要的是**「现在在放什么」**（在系统提示词的实时状态块里）。

| 参数 | 作用 | 代价 |
|:---|:---|:---|
| `reasoning: 'none'` | 推理过程**不进上下文**（实测能占三分之二的字符量） | 模型看不到自己上次怎么想的 |
| `toolCalls: 'before-last-message'` | 只保留最后一条消息之后的工具轨迹 = 本轮自己的 | **「刚才搜到的第三首放一下」答不了** |
| `emptyMessages: 'remove'` | 裁空了的消息直接去掉 | 无 |

### 三条要注意的

1. **裁剪只影响发出去的，不动库里存的**——存储层存全量。你随时能从库里翻出完整历史，**但模型看不到**。
2. `toolCalls` 那条**对应一个已拍板的产品取舍**。**改它就是改产品行为**，不是改 bug。最小改法是"保留最近一轮轨迹"。
3. `convertToModelMessages` 和 `pruneMessages` **为什么是两步**：它们假设的消息形状不同——**转换先把形状统一，裁剪才好按语义切**。合成一步，你没法单独测"形状对了没"和"该留的留了没"。

> **📌 SDK 的活**：提供裁剪能力。**永远是你的**：**裁多少**——纯成本决策，模型再强不会替你省钱。

---

# 站 5 · 循环就在这一行

```ts
const result = streamText({
  model: getModel(config),
  instructions: buildSystemPrompt(opts.snapshot, opts.preferences),
  messages,
  tools,
  stopWhen: isStepCount(MAX_STEPS),   // ← 循环在这里
  abortSignal: opts.signal,
});
return { result, tools };   // ⚠️ 流还没被消费
```

`run.ts` 里**一行循环代码都没有**，但 agent 确实在「要工具 → 执行 → 回填 → 再问」：

| 环节 | 谁负责 |
|:---|:---|
| 模型什么时候想调工具 | 模型自己（读 `tools` 的 schema 后决定） |
| 工具真的被执行 | **SDK** |
| 结果回填、再问一次 | **SDK** |
| **循环什么时候停** | **`stopWhen: isStepCount(MAX_STEPS)`** ← 你唯一写下的边界 |

**不用 SDK，手工实现的"灵魂"就是这三行**：

```python
while True:
    reply = model(messages, tools)          # ① 问
    if not reply.tool_uses: return reply    # ② 没有工具调用 → 结束（★ 灵魂）
    messages += [reply] + run_tools(reply.tool_uses)   # ③ 执行 + 回填
```

**`if not tool_uses: return` 就是灵魂**——终止条件不属于 SDK，属于你对这个 agent 的定义。

### `MAX_STEPS = 5` 为什么导出

因为**判"这一轮被截断了吗"要用同一个数**。撞上限时模型想调的第二个工具就没机会执行，**而这件事在输出里毫无痕迹**（模型只是"话没说完"）。**这个数如果另抄一份，两处就会悄悄不一致。**

### 其余两个参数

- `instructions` —— ⑦ 实时状态 + ⑥ 已知偏好都拼在这里，**不进 `messages`**。因为它们是「约束与事实」而不是对话——**进历史就会随历史一起落库、一起长大**。
- `abortSignal` —— 关页面 / 点停止就中断本轮。

> 返回 `{ result, tools }`，**流还没被消费**——怎么送出去由路由决定。所以 `run.ts` 只管"跑一轮"，不管"怎么传"。
>
> **📌 SDK 的活**：整段循环、终止判断的执行、usage 提取。**永远是你的**：**两个边界**——`tools`（它能做什么）和 `stopWhen`（什么时候必须停）。模型再强也不会自己告诉你"该停了"。

---

# 站 6 · 出流：转帧、包响应、落库

```ts
const stream = toUIMessageStream({ stream: result.stream, tools, originalMessages, ... });
return createUIMessageStreamResponse({ stream });
```

**为什么是两个函数**（ai@7 起拆开）：传输边界在路由里**显式可见**了——哪一步转帧、哪一步包 HTTP 响应，读这两行就知道。

### `originalMessages` 的双重作用

1. **传了它就等于开启 SDK 的持久化模式**。此时 `onEnd` 收到的是**含本轮 assistant 回复在内的完整消息列表**——所以落库**不需要"延迟一轮"**。
2. 它和 `generateMessageId` 是**一对**：前者给出"在哪些消息后面追加"，后者给出"追加的这条叫什么"。

### 两个回调怎么接力

```ts
let turnError: string | null = null;   // ← 声明在 POST 顶部

onError: (error) => {
  turnError = error instanceof Error ? error.message : String(error);
  return turnError;      // ① 一份给前端（401 / 模型名写错全靠它定位）
},
onEnd: async ({ messages, isAborted, finishReason }) => {
  appendMessages(messages);            // ② 落 messages 表
  recordTurn({ ..., error: turnError });// ③ 落 agent_turns 表，捎上刚存的错误
},
```

**两个回调分开，靠 `turnError` 串起来**——`onError` 先触发，但"这段流结束了"只有 `onEnd` 知道。**错误要先存下来，等收尾时一起落库。**

### `onEnd` 里为什么**有** try/catch，而 `run.ts` 里没有

| | 有没有 | 为什么 |
|:---|:---|:---|
| `run.ts` | ❌ | 错误要**冒泡到 `onError`**，中间吞掉前端就没提示了 |
| `onEnd` 取 steps/usage | ✅ | 这是**次要数据**：中断时可能拿不到，但**这一轮仍要落库**（被中断的轮次恰恰最需要看） |

> **判断"该不该吞异常"的通用办法**：**问它失败时谁需要知道。** 需要 → 抛；不需要 → 本地吞掉、继续干。
> 这条纪律在数据库层也是同一条（各张表的失败语义故意不同）。

`onEnd` 要 `await`——**挂成后台 promise 会让"刚问完就去查观测"时有时无，验证脚本间歇性失败**（这个形状的坑本项目踩过）。

> **📌 SDK 的活**：转帧、包响应、持久化时序。**永远是你的**：**落库与观测**——它是唯一能回答"那次为什么答错了"的东西。

---

# 站 7 · 流出去之后：agent 不通知前端

```
agent 调工具 → POST /api/player/queue → 服务端状态变了
                                          ↓
                              /api/player/events 广播新快照
                                          ↓
                                    浏览器自己跟上
```

| | 形态 | 用途 |
|:---|:---|:---|
| `/api/agent` | **请求-响应**（流式指的是首字延迟） | 用户说一句 → 回一段文字 + 工具轨迹 → 关流 |
| `/api/player/events` | **长连接广播** | 播放状态一变就推给所有浏览器 |

**记住这句**：**agent 不通知前端，前端自己会跟上。** 所以工具只要老老实实把状态改对，界面自然会变——**不需要在工具里写任何"通知"逻辑**。

> **这一站没有 SDK 的活**，它是你自己划的架构边界。

---

# 收尾

**三句**：
1. `instructions` / `messages` / `tools` 就是 agent 的全部输入。看不懂某个文件时，先问它属于哪一边。
2. **循环在你写的代码之外**。你只负责两个边界：`tools`（能做什么）和 `stopWhen`（什么时候必须停）。
3. **判断"该不该吞异常"，问它失败时谁需要知道。**

**七站的判定**：

| 站 | SDK 的活 | **永远是你的** | 判定 |
|:---|:---|:---|:---|
| 1 浏览器发什么 | 无（就是 HTTP） | 空消息挡在入口；`UIMessage` 里文字只是其中一种 part | 🔒 边界 |
| 2 票根 `turnId` | 无 | **主键怎么生成**（不传 `generateMessageId` = 静默丢数据） | 🔒 追查 |
| 3 转换 | 形状转换、schema 对齐 | 哪些脏数据不许进模型；错误在哪层被吞 | 🔒 |
| 4 裁剪 | 提供裁剪能力 | **裁多少**（纯成本决策） | 🔒 成本 |
| 5 循环 | 整段回环 + usage 提取 | **两个边界**：`tools` 与 `stopWhen` | 🔒 成本 + 边界 |
| 6 出流 | 转帧、包响应、持久化时序 | **落库与观测** | 🔒 追查 |
| 7 流出去之后 | 无 | **两条通道的分工** | 🔒 架构边界 |

**这一趟七站全是 🔒，一条 🧊 都没有。** 这不是巧合：

> **会被学走的东西不在主干里——主干是资产，措辞是耗材。**

---

# 你能自己验的三个动作（各 5 分钟）

- [ ] **验票根**：跑一次对话，`SELECT id FROM messages WHERE role='assistant'` 与 `SELECT id FROM agent_turns`——**两组 id 应该对得上**。
- [ ] **验裁剪**：连着问两轮都要搜索的问题，读 `agent_turns` 的 `input_tokens`。**第二轮不会把第一轮的搜索结果带上去**。
- [ ] **验截断**：问一个需要反复搜的刁钻问题（「找一首又像民谣又像电子、还是 2010 年前的、最好带女声的歌」），跑完看 `npm run turns` 有没有 ⚠ 触顶。**有的话，你刚刚亲眼见过 `MAX_STEPS` 生效。**（若你配了 `AGENT_MAX_COST_MICRO`，这一轮可能先撞上 **⚠ 预算** —— 两个标记分开，正是为了让你分得出该调哪一个：调步数上限对"钱花完了"毫无作用。）

**这一趟覆盖考卷题 6 / 7 / 8，以及题 12 的一半**（票根在站 2、取数在站 6；`truncated` 的双条件要对着 `turn-log.ts` 读）。
题 9 / 10 / 11 / 13 要跟着**工具**走第二趟（`agent/tools.ts` → `callBff` → 自家 BFF → 信封）。
