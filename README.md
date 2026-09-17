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

**有**：曲库浏览与搜索（**含按风格标签搜**）、点击播放、进度拖动、上下首、播放队列、
播放模式（顺序 / 列表循环 / 单曲循环 / 随机）、**真实封面**（读文件内嵌 `APIC`，
无则回落「首字 + 渐变」）、歌词（含全屏沉浸页，**优先读文件内嵌 `USLT`**）、
音量 / 静音、背景主题、可拖拽可合并的多面板布局（宽屏两列：调列宽 / 卡片高度 /
整列内容倍数；窄屏单列：同列卡片之间照常可拖）、全局快捷键、播放历史落库。

**没有**（曾有过，2026-09-15 随最简化删除）：电台、偏好设置、语音输入、
MV 视频播放、统计概览。**AI 打标回来了，但换了形态**：不再依赖不可信的 ID3 `TCON`，
改由 `track_tags` 表承载（AI 打底 + 用户覆盖）——重跑打标**不会覆盖用户手改过的标签**。

**Agent**：对话是布局系统里的一张普通卡（`chat`，⌘K 唤起），协议交给 Vercel AI SDK
（`/api/agent`）。当前有 **14 个工具**：检索与播放 3 个（检索 / 播放单曲 / **按条件换一批队列**）、
播放控制 4 个（下一首 / 暂停 / 继续 / 按位置跳转）、**播放设置 2 个**（音量 / 播放方式）、
认知写入 3 个（记住 / 忘掉偏好、增删曲目标签）、只读回顾 2 个（播放历史、标签一览）。
另有**会话历史**（跨刷新保留，发送前裁掉历史轮的工具轨迹）与**记忆**（长期偏好跨对话注入
系统提示词）。系统提示词的实时状态块里带着**队列窗口**（当前附近几首 + 「前 / 后 N 首略」，
自定义队列还会写明「按什么挑的一批」）、**当前音量与播放方式**——`jump_in_queue` 的「第几首」、
`set_volume` 的「小声点」都照它数/算。**⑨ 观测**已接上最小版：每轮落一行
`agent_turns`（步数 / 工具链与各自耗时 / 是否被 `MAX_STEPS` 截断 / token / 错误），
用 `npm run turns` 看。**⑩ 触发器未做**——
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
  agent/        对话历史（message-log.ts）与偏好记忆（preference-log.ts）的读写
  library/      曲库：扫描 / 搜索 / 目录解析
  player/       播放状态机 / 音频流 / 响应体
  records/      播放历史读写
scripts/        api-smoke.mjs —— 接口体检
data/           music/（曲库源码资产）+ app.db（运行时派生，见 .gitignore）
```

---

## API 一览（16 个）

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/api/library/search?q=&limit=&offset=` | 曲库检索（`q` 空 = 整库），标题/歌手/专辑子串匹配，**并匹配标签**；`offset` 翻页（命中 > limit 时返回值会给出下一个 offset） |
| GET | `/api/library/stream?trackId=` | 音频字节流，支持 Range（seek 靠它） |
| GET | `/api/library/lyrics?trackId=&raw=` | LRC 歌词，**优先读音频内嵌（ID3 USLT）、`.lrc` 兜底**；`raw=1` 返回 text/plain |
| GET | `/api/library/cover?trackId=` | 内嵌封面（ID3 APIC）的**原始图片字节**；无封面 → 404，前端据此回落渐变 |
| GET/POST/DELETE | `/api/library/tags` | **曲目风格标签**。GET 列出（`?trackId=` 取单曲）；POST `{trackId, tags}` **重设**——**走这条 HTTP 路径就等于「人在说话」→ `source='user'`，无条件覆盖 AI**；DELETE `?trackId=` 清掉。agent 的 `set_track_tags` 工具走这里（它自己先读、再算增删、最后调这个重设） |
| GET | `/api/player/events` | **SSE**，播放状态的唯一推送源（快照含队列来源、音量、播放方式） |
| GET/POST | `/api/player/play` | GET 轮询当前状态；POST `{trackId}` 点播（**不在队列里就追加到队尾**，见 BLUEPRINT §7） |
| POST | `/api/player/pause` · `/resume` | 暂停 / 续播（无播放中 → 409） |
| POST | `/api/player/next` | 下一首；到队尾返回 `stopped` |
| POST | `/api/player/jump` | `{index}` 跳到队列第 index 首 |
| POST | `/api/player/queue` | **换一批队列**：`{trackIds, label}` 换成自定义队列并开播；**`{trackIds: []}`（或省略）= 恢复整个曲库**。agent 的 `build_queue` 走这里 |
| GET/POST | `/api/player/settings` | **音量 / 播放方式**。GET 读当前值；POST `{volume?, mode?, shuffle?}`（0–1，越界夹紧；只改给了的字段）。agent 的 `set_volume` / `set_playback_mode` 走这里 |
| GET | `/api/history?limit=` | 播放历史，时间倒序（默认 20，上限 200） |
| GET/POST/DELETE | `/api/preferences` | **偏好（Agent 的长期记忆）**。GET 列出；POST `{key, value}` 记住一条（同 key 覆盖）；DELETE `?key=` 忘掉一条。agent 的 `remember` / `forget_preference` 工具走的就是这里 |
| POST | `/api/agent` | **对话端点**（SSE）。body `{messages, snapshot}`；协议是 AI SDK 的 UI 消息流（响应头 `x-vercel-ai-ui-message-stream: v1`），收尾是**裸** `data: [DONE]` |

**统一信封**：所有 JSON 路由返回 `{ code, data?, message }`。
`code === 0` 表示成功（**不是 200**），失败时 `code` 等于 HTTP status。
构造只允许在 `server/http.ts` 的 `ok()` / `fail()` 里发生，路由不许手写信封。

---

## 数据与持久化

**曲库不落库。** 曲目是对 `MUSIC_DIR` 的一次目录扫描（`server/library/scanner.ts`），
进程内 memo。真相永远在文件系统上，再存一份到 SQLite 只会引入
「表里的行和盘上的文件对不上」这类问题。

**数据库只存扫描不出来的东西** —— 播放历史、对话历史、偏好与**曲目风格标签**：

```
data/app.db  (SQLite, node:sqlite —— Node 内置，零 npm 依赖)
  plays(id, track_id, title, artist, started_at)
  messages(id, role, parts, created_at)      -- 对话历史；id = 前端消息 id，upsert 天然幂等
  preferences(key, value, updated_at)        -- Agent 的长期记忆；key 唯一 = 同一条偏好
  track_tags(track_id, tags, source, updated_at)  -- 风格标签；track_id 唯一，source ∈ {ai, user}
  agent_turns(id, created_at, tools, steps, ms, input_tokens, …)  -- ⑨ 观测；一行 = 一轮对话
                                                  -- id = 那一轮 assistant 消息的 id（与 messages 同键，可 join）
```

- 建表语句**只在 `server/db.ts`** 出现。加表就往 `migrate()` 里追加一条。
- 五张表的**失败语义不同，且是有意的**：`plays` / `messages` / `agent_turns` 是流水，
  写失败只记日志
  （不该打断播放或对话）；`preferences` / `track_tags` 是 agent 对用户的**承诺**
  （它说了「记住了」「改好了」），写失败必须让模型知道——否则用户下次发现它又忘了，
  却找不到任何线索。
- **`agent_turns` 回答的是 `messages` 答不了的那一半**：几轮工具、哪个工具慢、
  有没有被 `MAX_STEPS` 截断、花了多少 token。一行 = 一轮（不是一条消息），
  用 `npm run turns` 看。它是 ⑨ 观测的最小版——**没有**逐 span 的 trace，
  也**没有**首字延迟（那要 hook 每个 chunk，属于动 ② 与 ⑧ 的冻结区）。
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

## 验证

```bash
npm run lint        # ESLint
npx tsc --noEmit    # 全仓类型检查
npm test            # 单测（node:test，纯函数模块）
npm run build       # 生产构建
BASE=http://127.0.0.1:3100 npm run smoke:api   # 接口冒烟（需先起服务）
npm run turns       # 看最近几轮对话的观测（⑨）：步数 / 工具链 / 耗时 / token / 触顶
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
