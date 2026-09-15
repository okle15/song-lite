# Private Music Hub · song-lite

一个**可运行的最小音乐平台**：**只有前端 + BFF，没有任何 Agent 代码**。

播放、搜索、歌词、队列、电台、历史统计全部可用；右下角「AI 对话」
打的是 `/api/chat` —— 该路由是个**占位实现**，只回一句固定文本。

```
┌──────────────┐  fetch /api/**   ┌──────────────────────────────────────┐
│ components/  │ ───────────────► │ app/api/**  BFF 路由（17 个）         │
│  React UI    │ ◄─────────────── │  统一信封 {code,data,message}        │
└──────┬───────┘  SSE /api/chat   └──────────────────┬───────────────────┘
       │                                             ▼
       │                              server/**  业务实现（player/library/
       └── 播放器事件走 SSE            radio/records/user/llm）
```

## 快速开始

```bash
npm install
npm run build && npm start -- -p 3100     # 生产模式：验证一律走这里
# 开发模式（Turbopack dev 下 SSE 首连接会挂起，属 dev-only）
npm run dev
```

打开 http://127.0.0.1:3100 —— 左侧「曲库」选一首即可播放，底部播放条切歌。

其它命令：

| 命令 | 作用 |
|:--|:--|
| `npm test` | 单测（node:test + node:assert，无额外框架） |
| `npm run lint` | ESLint |
| `npm run smoke:api` | 逐个探测 BFF 端点（需服务已启动） |

## 目录结构

| 目录 | 职责 | 依赖方向 |
|:--|:--|:--|
| `app/` | 路由层。`page.tsx`/`layout.tsx` 是应用外壳；`api/**` 是 17 个 BFF 端点，**不写业务实现** | → `server/` |
| `components/` | 浏览器侧 React 组件（播放器 / 歌词 / 队列 / 面板布局 / 对话气泡） | 只读 `contract/` |
| `contract/` | 前端与 `server/` **共用**的协议与 wire 类型，**零业务依赖** | 叶子层 |
| `server/` | 业务实现：`player/ library/ radio/ records/ user/ llm/`。不认识 `Request`/`Response` | → `contract/` |
| `scripts/` | 接口体检脚本 | — |
| `data/` | 曲库音频（`data/music/*.mp3`）+ SQLite 库 + JSON 存储 | — |

**没有的目录**：`agent/`、`telemetry/`、`eval/`（连同 `architecture.test.ts`）
已整体移除。`song` 仓库里有这些，需要时去那边看实现。

## 接口清单

**全部 17 个端点都被前端实际调用**，没有「留给将来」的接口：

| 端点 | 用途 |
|:--|:--|
| `POST /api/chat` | 对话面板（**当前为占位**） |
| `GET /api/library/search?q=` | 曲库搜索（服务端搜索 + 250ms debounce） |
| `GET /api/library/stream?trackId=` | 音频流（支持 Range → 206） |
| `GET /api/library/stream-video?trackId=` | MV 播放（曲目未配对 MV 时不可用） |
| `GET /api/library/lyrics?trackId=&raw=1` | LRC 歌词 |
| `GET /api/player/events` | **播放器状态 SSE**（前端唯一的状态来源） |
| `POST /api/player/play` · `pause` · `resume` · `next` · `jump` | 播放控制 |
| `GET /api/logs` | 历史 / 统计面板 |
| `GET\|PUT\|DELETE /api/preferences` | 偏好面板 |
| `POST /api/radio/start` · `stop` · `GET /api/radio/now` | 电台按钮与栏目轮询 |
| `POST /api/voice` | 语音转写（Whisper 后端） |

## 对话接口：现状

`app/api/chat/route.ts` 只做三件事：校验请求体（`{message, userId}`）、
按 **AI SDK 原生 UI 消息流**回一段固定文本、以**裸 `data: [DONE]`** 收尾。

它刻意保持了与真实 Agent 一致的线格式（`x-vercel-ai-ui-message-stream: v1`
响应头 + `start`/`text-start`/`text-delta`/`text-end`/`finish` 五帧），
所以前端 `components/use-chat-stream.ts` 与共享装配层 `contract/chat-chunks.ts`
不需要为此做任何适配 —— 将来要换成真 Agent 时，只需替换这一个路由里的
「产出流」那一步，请求校验、响应头、错误信封（`server/http.ts` 的 `fail()`）
都不用动。

## 数据

| 路径 | 内容 |
|:--|:--|
| `data/music/` | 曲库音频 + 同名 `.lrc` 歌词（扫描器按目录实时索引） |
| `data/logs.db` | 播放等本地操作流水，前端「历史 / 统计」面板读它 |
| `data/radio.db` | 电台曲目画像 + 节目史 |
| `data/preferences.json`、`data/lexicon-learned.json` | 用户偏好副本、已学到的新词映射 |

换曲库：改 `.env.local` 的 `MUSIC_DIR`，或把音频丢进 `data/music/`（重启后自动识别）。

## 进一步阅读

- [RADIO.md](./RADIO.md) —— 电台子系统（排片 / 打分 / 口播 / 边播补标 / 中文语义解析）
- [AGENTS.md](./AGENTS.md) —— 协作与验证规则

## 与 `song` 的关系

`song` 是功能完整的版本（Agent + 工具 + 离线评估体系）。
本仓库从它复制了**前端与 BFF 的全部实现**（这两部分逐字节未改），
然后清掉了 Agent、评估旁路，以及所有前端未调用的端点。需要某块能力时，
去 `song` 对应目录抄回来即可。
