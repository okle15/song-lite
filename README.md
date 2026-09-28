# song-lite

一个**只做本地播放**的个人音乐助手。没有账号、没有云同步、没有后台服务，
`next start` 起来就是一个能听歌的页面。

它同时是一个**底座**：功能刻意削到最简（前端播放 + 支撑它的 API + 一张播放历史表），
后续能力（推荐、电台、Agent 对话…）在这个底座上慢慢加。

---

## 快速开始

```bash
npm install
cp .env.example .env.local        # 至少填 MUSIC_DIR
npm run build && npm start -- -p 3100
# 打开 http://127.0.0.1:3100
```

`.env.local` 里**只有 `MUSIC_DIR` 真正影响功能**：不设时曲库为空（没有 mock 兜底，
不会假装有歌）。

---

## 功能边界

**有**：曲库浏览与搜索（**含按风格标签搜**、**翻页与总数**：「已显示 12 / 共 20 首」+「加载更多」）、
点击播放、进度拖动、上下首、播放队列、播放模式（顺序 / 列表循环 / 单曲循环 / 随机）、
**真实封面**（读文件内嵌 `APIC`，无则回落「首字 + 渐变」）、歌词（含全屏沉浸页，
**优先读文件内嵌 `USLT`**）、音量 / 静音、背景主题、可拖拽可合并的多面板布局（宽屏两列：
调列宽 / 卡片高度 / 整列内容倍数；窄屏单列：同列卡片之间照常可拖）、全局快捷键、
**播放历史看得见且可重播**、**曲目风格标签看得见、可改**（两者都在下面单说）。

**没有**（曾有过，2026-09-15 随最简化删除）：电台、偏好设置、语音输入、
MV 视频播放、统计概览。**AI 打标回来了，但换了形态**：不再依赖不可信的 ID3 `TCON`，
改由 `track_tags` 表承载（AI 打底 + 用户覆盖）——重跑打标**不会覆盖用户手改过的标签**。
**「记忆」卡（2026-09-24）不是"偏好设置"回来了** —— 两者判据不同：那张被删的表单问的是
「用户想配置什么」，这张卡问的是「**AI 已经记下了什么、能不能撤**」。它是 ⑥ 的**读侧**，
只做「列出 + 逐条删」，**没有手动新增的入口**（偏好是 agent 对用户的理解，不是用户填的配置项）。
动机写在 `agent/prompt.ts` 铁律 6 的原文里：**记错比不记更糟 —— 它会长期影响以后每一次对话，
而用户不知道你记了什么**。那个「不知道」在此之前没有任何出口。

**「播放历史」卡（2026-09-28）同样不是一个新的数据面**：`GET /api/history` 与 `recent_plays`
工具一直读的就是同一份 `plays` 表，**缺的只是出口** —— 用户看不见模型看到的那份清单，也没法
自己重播。它是**第 7 张卡**，也是第三张「清单」卡（前两张：「记忆」「定时任务」）。
每行可点重播；曲名在**写入时**冗余存了一份，所以被移走 / 改名、甚至删掉的歌，**这一行仍读得通**，
点下去才撞上 404 —— 那种情况有专门的一句话（「已经不在曲库里了 —— 记录里留着的是当时那一份」），
而不是笼统的「重播失败」。⚠️ 它**不是**推送：数据是 GET 现取的，切到这张卡时才重取一次
（同一首歌原地重播不改变刷新信号，所以那一次会少一条最新记录，直到下次切歌）。

**曲库抽屉里的标签（2026-09-28）**：每首歌下面一行标签 chip —— **常驻显示，不做 hover 才出现**
（触摸屏上根本没有 hover），点它打开底部的编辑条。编辑条会**先说清这组是谁写的**：
「现在这组是 AI 打的（你改了就以你为准）」/「现在这组是你定过的（AI 打标不会再覆盖它）」
—— `source`（`ai` / `user`）**只看结果看不出来**，而它决定了下次批量打标会不会动这一条。
按钮文案跟着**即将发生的事**变（没变化 → 禁用；把输入框清空 → 「清空标签」），
保存后显示的用**服务端回来的那一份**（拆词 / 排序 / 大小写在服务端归一化）。

**Agent**：对话是布局系统里的一张普通卡（`chat`，⌘K 唤起），协议交给 Vercel AI SDK
（`/api/agent`）。当前有 **17 个工具**（数的是 `createTools` 的注册表键，全部外置，没有内联工具）：
检索与播放 3 个（检索 / 播放单曲 / **按条件换一批队列**）、
播放控制 4 个（下一首 / 暂停 / 继续 / 按位置跳转）、**播放设置 2 个**（音量 / 播放方式）、
认知写入 3 个（记住 / 忘掉偏好、增删曲目标签）、只读回顾 2 个（播放历史、标签一览）、
**排期 3 个**（排 / 看 / 撤，见 ⑩）。
另有**会话历史**（跨刷新保留，发送前裁掉历史轮的工具轨迹）与**记忆**（长期偏好跨对话注入
系统提示词，**并在「记忆」卡上列出来、可逐条撤回** —— 见下面「没有」那段里
「为什么这不是偏好设置回来了」的辨析）。系统提示词的实时状态块里带着**队列窗口**（当前附近几首 + 「前 / 后 N 首略」，
自定义队列还会写明「按什么挑的一批」）、**当前音量与播放方式**、以及**现在的时刻**——
`jump_in_queue` 的「第几首」、`set_volume` 的「小声点」都照它数/算，而 `schedule_task`
要的绝对时间由模型自己算（所以它看得到「现在」，且工具会把服务端规范化后的时间念回去）。

**⑨ 观测**：每轮落一行 `agent_turns`（步数 / 工具链与各自耗时 / 是否被 `MAX_STEPS` 截断 /
token / **首字延迟** / **模型与花了多少钱** / 错误），工具逐 span 另落 `agent_spans`，
用 `npm run turns` 看 —— 它不只是把数字列出来，还会**归因**：把那些数字排成一句能据以行动的
话（「这一轮为什么是这样、下一步动哪儿」），并把**环境类**（网关/服务没跑）与**行为类**
（它自己就能修）分开（`server/agent/diagnose.ts`）。
**⑩ 触发器**：任务表 + `POST /api/tasks/tick` 的执行器 + 上面的三个工具。
⚠️ **它不是"定时器功能"**——定时器属于**部署环境**（`npm run tasks:tick` 或 cron 一行），
代码里落的是「**任务**」这个概念：跨轮的目标（推到哪儿了、下次该不该继续）。
加什么、加在哪、凭什么这么判断，全在 [BLUEPRINT.md](./BLUEPRINT.md)。

---

## 目录结构

```
app/            路由 + 页面外壳
  page.tsx        服务端外壳（无 'use client'）：读一次对话历史，当 props 递下去
  home-client.tsx 浏览器主体（'use client'）—— 其余前端代码都在这里
  api/**/route.ts 全部 HTTP 端点
components/     浏览器侧（不设 lib/ 子目录）。纯函数模块的单测就近放
contract/       前后端共享契约，零业务依赖（player.ts 是 SSE 的 wire 类型）
agent/          Agent 本体：provider / run / tools / prompt（构成见 BLUEPRINT.md §2）
server/         业务实现。根只留 http.ts（信封）与 db.ts（连接）
  agent/        对话历史(message-log) · 偏好记忆(preference-log) · ⑨ 观测(turn-log)
                · ⑩ 排期(tasks) · 成本计价(pricing) 的读写
                · ⑨ 归因(diagnose) —— 纯函数：把观测里的候选答案排成一句能据以行动的话
  library/      曲库：扫描 / 搜索 / 目录解析
  player/       播放状态机 / 音频流 / 响应体
  records/      播放历史读写
scripts/        api-smoke.mjs 接口体检 · turns.mts 看观测 · cases.mts 失败案例集
                · cases-diff.mts 对比两份报告 · tasks-tick.mts 打一次 ⑩ 的 tick
                · auto-tag.mts AI 打标
cases/          failure-cases.json 失败案例集 + report.ts 报告形状与「该不该删」的判定
                （**测 agent 的，不是 agent 的一部分**）
data/           music/（曲库源码资产）+ app.db（运行时派生，见 .gitignore）
```

---

## API 一览（18 个）

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/api/library/search?q=&limit=&offset=` | 曲库检索（`q` 空 = 整库），标题/歌手/专辑子串匹配，**并匹配标签**；`offset` 翻页（命中 > limit 时返回值会给出下一个 offset） |
| GET | `/api/library/stream?trackId=` | 音频字节流，支持 Range（seek 靠它） |
| GET | `/api/library/lyrics?trackId=&raw=` | LRC 歌词，**优先读音频内嵌（ID3 USLT）、`.lrc` 兜底**；`raw=1` 返回 text/plain |
| GET | `/api/library/cover?trackId=` | 内嵌封面（ID3 APIC）的**原始图片字节**；无封面 → 404，前端据此回落渐变 |
| GET/POST/DELETE | `/api/library/tags` | **曲目风格标签**。GET 列出（`?trackId=` 取单曲）；POST `{trackId, tags}` **重设**——**走这条 HTTP 路径就等于「人在说话」→ `source='user'`，无条件覆盖 AI**；DELETE `?trackId=` 清掉。agent 的 `set_track_tags` 工具走这里（它自己先读、再算增删、最后调这个重设）；**曲库抽屉里用户也能直接改**（每首歌下面那行标签 chip → 底部编辑条；GET 带 `?trackId=` 时还会返回 `source`，界面靠它说清「这组是 AI 打的还是你定过的」） |
| GET | `/api/player/events` | **SSE**，播放状态**推给浏览器**的唯一来源（快照含队列来源、音量、播放方式）。agent 的 ⑦ **不走它**——服务端权威的那几项在路由里现取 |
| GET/POST | `/api/player/play` | GET 轮询当前状态；POST `{trackId}` 点播（**不在队列里就追加到队尾**，见 BLUEPRINT §7） |
| POST | `/api/player/pause` · `/resume` | 暂停 / 续播（无播放中 → 409） |
| POST | `/api/player/next` | 下一首；到队尾返回 `stopped` |
| POST | `/api/player/jump` | `{index}` 跳到队列第 index 首 |
| POST | `/api/player/queue` | **换一批队列**：`{trackIds, label}` 换成自定义队列并开播；**`{trackIds: []}`（或省略）= 恢复整个曲库**。agent 的 `build_queue` 走这里 |
| GET/POST | `/api/player/settings` | **音量 / 播放方式**。GET 读当前值；POST `{volume?, mode?, shuffle?}`（0–1，越界夹紧；只改给了的字段）。agent 的 `set_volume` / `set_playback_mode` 走这里 |
| GET | `/api/history?limit=` | 播放历史，时间倒序（默认 20，上限 200）。界面上是第 7 张卡「播放历史」（每行可点重播；点一首已经不在曲库里的歌 → 404，卡片有专门文案） |
| GET/POST/DELETE | `/api/preferences` | **偏好（Agent 的长期记忆）**。GET 列出；POST `{key, value}` 记住一条（同 key 覆盖）；DELETE `?key=` 忘掉一条。agent 的 `remember` / `forget_preference` 工具走的就是这里，**界面的「记忆」卡也是** —— agent 与浏览器共用同一个 API 面（同一套校验、同一个信封），所以两边看到的必然是同一份，不存在"第二套入口各自漂移" |
| GET/POST/PATCH | `/api/tasks` | **⑩ 排期（对用户的承诺）**。GET 列出（未完成的按该做的时间在前 + 最近做过的几条）；POST `{goal, dueAt, repeat?, repeatDays?}` 排一件（`dueAt` 必须是 ISO 8601——**不接受自然语言**，否则"现在几点"会有两份算法；`repeat` ∈ `none` / `daily` / `weekly`，`weekly` 不传 `repeatDays` 就是"每周同一天"、传了则给 0–6 的星期号，如 `[1,3,5]`）；PATCH `{id}` 撤销一件还没做完的（撤一件已完成的不算错，回 `cancelled:false`）。**参数错一律回 400 而不是 500**，判据与消息都由 `server/agent/tasks.ts` 的 `validateCreate` 给（400 = 模型换个说法就能改，500 = 服务端坏了、原样重试也没用）。⚠️ **重复任务的第一个落点也会被推到未来**：模型把时间算到了过去（实测确实会，且星期几还是对的）时，这行不会带着过去的 `due_at` 入库、然后被下一次 tick **立刻执行**——建表就复用 `nextRepeatDue`，与重排走同一条规则；一次性的（`none`）**不推**，"已经晚了就现在做"正是用户要的。agent 的 `schedule_task` / `list_scheduled_tasks` / `cancel_scheduled_task` 走这里。⚠️ **执行不在这条路由**，见下 |
| POST | `/api/tasks/tick` | **⑩ 的执行面（打点）**。认领**一件**到期任务并跑一轮完整对话，`ran:false` = 这次没活干（正常结果）。刻意没有常驻定时器：**谁来打点都行**（cron / `npm run tasks:tick`），正确性由原子认领保证，不由"只有一个人在打点"这个假设保证。网关没配时**先挡在认领之前**（不白费 `attempts`）。一次只跑一条——一轮 7–14 秒，一次请求跑 N 条会撞平台超时，那时前面几条的副作用已经发生了 |
| POST | `/api/agent` | **对话端点**（SSE）。body `{messages, snapshot}`——`snapshot` **只用来取设备侧的四项**（音量 / 播放方式 / 随机 / 进度），曲目与队列服务端自己知道（见 `server/player/prompt-snapshot.ts`）；协议是 AI SDK 的 UI 消息流（响应头 `x-vercel-ai-ui-message-stream: v1`），收尾是**裸** `data: [DONE]`。另回两个自定义头 **`x-prompt-version` / `x-prompt-disabled`**——那是本轮实际用的系统提示词（`npm run cases` 拿它当报告标题，比自己 import 源码算一遍可靠：服务可能正跑着上一次构建的产物） |

**统一信封**：所有 JSON 路由返回 `{ code, data?, message }`。
`code === 0` 表示成功（**不是 200**），失败时 `code` 等于 HTTP status。
构造只允许在 `server/http.ts` 的 `ok()` / `fail()` 里发生，路由不许手写信封。

---

## 数据与持久化

**曲库不落库。** 曲目是对 `MUSIC_DIR` 的一次目录扫描（`server/library/scanner.ts`），
进程内 memo。真相永远在文件系统上，再存一份到 SQLite 只会引入
「表里的行和盘上的文件对不上」这类问题。

**数据库只存扫描不出来的东西** —— 播放历史、对话历史、偏好、**曲目风格标签**与**排期任务**：

```
data/app.db  (SQLite, node:sqlite —— Node 内置，零 npm 依赖)
  plays(id, track_id, title, artist, started_at)
  messages(id, role, parts, created_at)      -- 对话历史；id = 前端消息 id，upsert 天然幂等
  preferences(key, value, updated_at)        -- Agent 的长期记忆；key 唯一 = 同一条偏好
  track_tags(track_id, tags, source, updated_at)  -- 风格标签；track_id 唯一，source ∈ {ai, user}
  tasks(id, goal, due_at, repeat, repeat_days, status, attempts, last_error,
        result, created_at, last_run_at)     -- ⑩ 排期；一行 = 一件"跨轮的目标"
                                                 -- repeat ∈ {none, daily, weekly}
                                                 -- repeat_days：weekly 的"哪几天"（JSON，0=周日…6=周六）
                                                 --   weekly 恒非空（没说哪天就按 due_at 的星期填上）
                                                 -- status ∈ {pending, running, done, failed, cancelled}
                                                 -- last_run_at = 租约起点（不是"做完的时刻"）
  agent_turns(id, created_at, tools, steps, ms, input_tokens, output_tokens, …)  -- ⑨ 观测；一行 = 一轮对话
                                                  -- id = 那一轮 assistant 消息的 id（与 messages 同键，可 join）
                                                  -- prompt_version / prompt_disabled：那一轮用的是哪份系统提示词
                                                  -- model / cost_micro：那一轮用的模型与花了多少（微美元整数）
                                                  -- first_token_ms：首字延迟（NULL = 一个字都没吐）
  agent_spans(turn_id, idx, tools, tool_ms, finish_reason)  -- ⑨ 逐 span；一行 = 一轮里的一步
                                                  -- 主键 (turn_id, idx)，重放是覆盖
```

- 建表语句**只在 `server/db.ts`** 出现。加表就往 `migrate()` 里追加一条；**给已有的表加列**时
  还要登记进 `ADDED_COLUMNS`——`CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作，
  只改 `CREATE` 的话老库升上来会少那一列（而写入是流水语义，于是观测静默停摆、不报错）。
- 七张表的**失败语义不同，且是有意的**：`plays` / `messages` / `agent_turns` / `agent_spans`
  是流水，写失败只记日志
  （不该打断播放或对话）；`preferences` / `track_tags` / `tasks` 是 agent 对用户的**承诺**
  （它说了「记住了」「改好了」「明早七点叫醒你」），写失败必须让模型知道——否则用户下次
  发现它又忘了、或一直干等一件**根本没排上**的事，却找不到任何线索。
- **`agent_turns` 回答的是 `messages` 答不了的那一半**：几轮工具、哪个工具慢、
  有没有被 `MAX_STEPS` 截断、花了多少 token 与多少钱、用户等了多久才看到第一个字。
  一行 = 一轮（不是一条消息），用 `npm run turns` 看。
  它**不存"模型耗时"**：那只能算成残差（轮耗时 − 工具耗时），里面混着网络与排队，
  叫成"模型耗时"就是把推算说成实测——所以只给"这一步用了哪些工具、工具自己花了多久"。
- **`agent_spans` 是从已有数据下钻出来的**，不是新埋的点：`runAgent` 早就把每步的
  工具结果交出来了，原来只汇总成 `agent_turns.tools` 一个字符串。现在逐 step 落一行，
  于是"第 3 步卡了 9 秒"能被看见——而它恰恰是总耗时异常时唯一能定位的地方。
- **`cost_micro` 记的是微美元整数，且与 `model` 同一行、同一次写入**：价格随模型走，
  混着两种价目画出来的曲线**什么异常都看不出来**（与 `prompt_version` 同一形状）。
  单价来自 `LLM_PRICES`（**没配就记 NULL = 不知道**，不是 0 = 免费）。
- **`tasks` 的三条不写对就不报错的地方**（详见 `server/agent/tasks.ts` 文件头）：
  认领必须原子（否则同一件事跑两遍，用户听到两句一样的话，日志里没有异常行）；
  租约过期的 `running` 必须放回 `pending`（否则进程被 kill 过的那件**再也不会被执行**）；
  **重复任务**的补跑要**推到未来为止**（否则停服两天后连着触发——堆积的补跑是"连着放两遍歌"；
  `weekly` 还多一层：**星期也要对**，两个条件必须写在同一个循环里，分开写就会让"每周一"
  从第二周起变成"每周二"，而它不报错）。
- **`track_tags` 是「这首歌算什么风格」的唯一出处**：ID3 的 `TCON` 在本曲库全被误标
  （6 首中文流行全标成 `blues`），所以风格一律不信文件、只看这张表。
  两条写入路径，**谁说了算由来源决定**：`npm run tag:library`（AI 批量打底，
  `source='ai'`）与 `POST /api/library/tags`（用户重设，`source='user'`）——
  **`ai` 永不覆盖已有的 `user`**，判定在 `server/library/tags.ts`；
  归一化在 `contract/track-tags.ts`，工具侧与存储侧共用同一份。
- `messages` 存的是消息 **parts 全文（含工具轨迹）**，因为刷新页面时轨迹卡片要能原样恢复；
  而送给模型的上下文由 `agent/run.ts` 在**发送前**裁剪（`pruneMessages`）。存储存全量、
  发送才裁剪，两个目标才能同时成立——合成一步必然牺牲一个。
- `preferences` 的 `key` 是「什么算同一条偏好」的载体（`contract/preference.ts` 的
  `normalizePreferenceKey` 统一归一化），所以用户说五遍「不喜欢摇滚」只会有一条。
  注入时取最近更新的 30 条，全量塞进系统提示词——不做向量检索。
- 写入时机：`/api/player/{play,next,jump,queue}` **成功切歌**时记一行（`pause`/`resume` 不算新播放）。
- 刻意**不开 WAL**：默认 journal 模式下落盘只有单个 `.db`，不留 `-wal` / `-shm` 尾巴，
  「删一个文件就干净」。
- 删掉 `data/app.db` 即归零，服务下次写入时自动重建。

---

## 失败案例集与 prompt 补丁

`agent/prompt.ts` 的正文分**两层**：`CORE`（身份 + 能力边界 + 六条铁律）与 `PATCHES`
（**会过时的那一层** —— 为绕开模型当时的某种缺陷而写的「某类说法 → 该调哪个工具」路由表）。

分开的理由不是让 prompt 变短，是让**「这条补丁还需不需要」变成一个能跑出数字的问题**：
`PROMPT_DISABLE=work_style` 起一个实例，那一整段就关掉了。五件套：

| 件 | 在哪 | 它解决什么 |
|:---|:---|:---|
| 补丁段落化 + 开关 | `agent/prompt.ts` 的 `PATCHES` / `PROMPT_DISABLE` | 把一条补丁变成一个**可以关掉的变量**（关掉是整段消失，不留「本节已关闭」——那会多出一个不属于补丁的变量） |
| 版本指纹 | 同上 `promptVersion()` → 响应头 `x-prompt-version` + `agent_turns.prompt_version` | 两版的数字**不会混在一起**；`npm run turns` 出现多个版本时自动给分组小计 |
| 失败案例集 | `cases/failure-cases.json` | 判据只落在**可观察的事实**上（调了哪个工具、回答里有没有某个字符串、走了几步） |
| 重跑入口 | `scripts/cases.mts`（`npm run cases`） | 打自家 `/api/agent`，从 UI 消息流里读工具链与文本，出报告（`CASES_REPORT=<path>` 落成 JSON） |
| 对比两份报告 | `cases/report.ts` + `scripts/cases-diff.mts`（`npm run cases:diff`） | 把"两张截图对着看"变成一条打印出来的判定：**保留 / 可以删 / 测不出** |

怎么用 —— **先起临时实例**（它会往 `messages` / `agent_turns` 写真实行，所以 `BASE` 是必填的，
没有默认值）：

```bash
APP_DB_PATH="C:/tmp/song-lite-cases.db" npm start -- -p 3200
BASE=http://127.0.0.1:3200 CASES_REPEAT=3 CASES_REPORT=full.json CASES_LABEL=full \
  npm run cases                                  # 带补丁

PROMPT_DISABLE=work_style APP_DB_PATH="C:/tmp/song-lite-cases-b.db" npm start -- -p 3201
BASE=http://127.0.0.1:3201 CASES_REPEAT=3 CASES_REPORT=no-ws.json CASES_LABEL=no-work_style \
  npm run cases                                  # 不带补丁

npm run cases:diff -- full.json no-ws.json       # 两份放一起才给结论
```

**不带也全过 → 那条补丁可以删了**；不带时有失败 → 它还在起作用，保留（失败的那几条就是它的边界）。

`cases:diff` 把这一步从"两张截图对着看"变成一条打印出来的判定，并且**四种情形下拒绝下结论**
（每一种都会让人误删）：两次是同一版 · "带补丁"那版还关着别的补丁 · 关掉之后的失败全是环境类 ·
带补丁那版自己也红了。退出码 0 = 每条补丁都有明确结论，1 = 有补丁**测不出**。

`CASES_LABEL` 只是给人认的标签；**对比的方向不看它**，看响应头 `x-prompt-disabled` ——
手写的标签可能写反，响应头不会。

三条不许省：
- **`CASES_REPEAT`**：模型是随机的，一次跑一遍不足以下结论；跑 3 遍、报告里显示 `k/N`，
  看到的才是"它稳定地做不到"还是"这次恰好做到了"。
- **失败分两类，只有一类是证据**：**判据类**（它选了哪个工具 / 工具成没成功 / 走了几步 /
  说了什么）才归因给补丁；**环境类不算**（超时 / 流内报错 / 工具执行失败 / 队列复位失败），
  报告里带 `⚠ 环境` 前缀。⚠️ **流没正常结束时行为判据一律不评**——「没有调 `build_queue`」
  在超时那一遍里可能只是"它还没来得及调"。少了这条区分，一次网关抖动会被记成"补丁还在起作用"，
  而那条补丁就**永远删不掉**（没人敢删一条"有失败案例守着"的东西）。
- **基线**（`guards` 为空的用例）红了就是**环境**坏了（模型不通 / 曲库是空的 / 服务是旧构建）——
  那次跑里补丁组的失败**不能**归因给补丁。它是对照组，不是凑数。

---

## ⑩ 排期怎么跑起来

**代码里没有定时器，这是有意的**（dev 热重载会越起越多、多实例各起一个、无状态部署里
进程随时被回收）。应用的职责是「**被叫到时，原子地认领一件到期任务并做完**」，
「什么时候叫」属于部署环境：

```bash
# 本机手动打一次（试一条一分钟后的任务时够用）
BASE=http://127.0.0.1:3100 npm run tasks:tick

# 生产：cron 一分钟一次（是谁在打点不影响正确性）
* * * * * curl -fsS -X POST http://127.0.0.1:3100/api/tasks/tick >/dev/null
```

打点的人**可以不止一个**：认领靠 `UPDATE … WHERE status='pending'` 之后的 `changes`
判定，两个人同时进来只有一个会跑。反过来，「只有一个人在打点」这个假设置于代码之外，
所以代码不依赖它。

---

## 验证

```bash
npm run lint        # ESLint
npx tsc --noEmit    # 全仓类型检查
npm test            # 单测（node:test，纯函数模块）
npm run build       # 生产构建
BASE=http://127.0.0.1:3100 npm run smoke:api   # 接口冒烟（需先起服务）
npm run turns       # 看最近几轮对话的观测（⑨）：步数 / 工具链 / 耗时 / 首字延迟 / token / 钱
                    #   / 触顶 / **预算**（两种「被上限停住」分开标、分开数——症状一样、修法相反）
                    #   并给出**归因**（这一轮为什么是这样、下一步动哪儿）+ 归因分布
BASE=http://127.0.0.1:3100 npm run tasks:tick   # 打一次 ⑩ 的 tick（跑一件到期任务；需先起服务）
npm run cases       # 失败案例集（需先起**临时实例**并把 BASE 指过去，见上）
                    #   CASES_REPORT=<path> 把这次跑落成 JSON；CASES_LABEL=<text> 给这一版起个名
npm run cases:diff -- <A.json> <B.json>          # 两份报告放一起 → 「保留 / 可以删 / 测不出」
```

前端回归**一律走生产模式**（`npm run build && npm start -- -p 3100`），
不要在 dev 下排查 SSE——Turbopack dev 的 SSE 首连接会挂起，那是 dev-only 现象。

`scripts/api-smoke.mjs` 会顺带断言**信封不变式**（`code` 与 HTTP status 一致），
以及「播放之后历史确实落库了」。

---

## 文档索引

| 文档 | 何时读 |
|:---|:---|
| [BLUEPRINT.md](./BLUEPRINT.md) | 动 Agent 之前必读：十个部件在哪、需求往哪个部件下手、选型判据、错题本、路线图 |
| [AGENTS.md](./AGENTS.md) | 改代码前必读：协作红线、验证与调试、目录约定 |
| [LEARNING.md](./LEARNING.md) | 想知道「哪条 prompt 该删、哪个部件才是护城河」：一把尺子（🔒 学不走 / 🧊 会被学走 / ⚪ 弯路 / ⚠️ 像补丁其实是边界）+ 本项目逐项体检。配 `LEARNING-01-跟着一次请求走.md`（教材）与 `LEARNING-QUIZ.md`（考卷） |
