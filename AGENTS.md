<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

# 协作规则

开工前先扫一眼 [README.md](./README.md)（结构 / 运行 / 接口清单）。
电台专题见 [RADIO.md](./RADIO.md)。

**当前无 Agent**：`agent/`、`telemetry/`、`eval/` 都已移除；`/api/chat` 是占位实现。
`components/**` 从 `song` 逐字节复制而来，**不要改**（视觉冻结）；
`app/api/**` 只保留前端实际调用的 17 个端点 —— 加接口前先确认真有调用方。

## 验证与调试

- **前端回归一律走生产模式**：`npm run build && npm start -- -p 3100`。
  Turbopack dev 下 SSE 首连接会挂起（dev-only），别在 dev 下反复排查。
- **`next build` 后必须重启 `next start`**：老服务把构建清单常驻在内存里，磁盘重建后它会继续
  下发**旧 HTML**，旧 chunk 已不存在 → 静态请求 500 → **hydration 从不发生、交互全死、
  console 却零报错**。动手前先 `netstat -ano | grep :3100` 确认端口上的 PID 归属。
- **长驻进程（`next start` / 无头浏览器）必须后台运行**：用 `cmd &` 起的进程会随该次调用
  被回收，表现为「刚探测到端口在听、几秒后 ERR_CONNECTION_REFUSED」。
- **本机验证一律绕代理**：环境里 `HTTP_PROXY` 指向 `127.0.0.1:62302`，**localhost 流量也会被
  它截走**，可能拿到陈旧响应。curl 加 `--noproxy '*'`，浏览器加 `--no-proxy-server`，
  统一用 `127.0.0.1` 而非 `localhost`。
- **无头浏览器起不来先查「用户是不是开着同类浏览器」**：已有常驻实例时，新启的 headless
  会被它接管后立刻退出。**别去杀它**——那是用户自己的浏览器。此路不通时，把被测逻辑里
  不依赖 React 的部分抽成纯函数再单测。
- **断言前先确认构建产物含新代码**：`grep -rl "新增字符串" .next/static`。

## 装依赖

- 用 **`npm install`**，不要用 `pnpm install`（本机 pnpm 对 `@ai-sdk/*` 的 symlink 偶发
  `UNKNOWN`，且实测会**无输出永久挂起**）。装之前先停掉 dev / 生产服务。

## 静态检查

- 单测：`npm test`（`tsx --test`，node:test + node:assert，无额外框架）。**新增含测试的目录要同步
  改 `package.json` 的 glob**。单测**就近放**，测 `server/radio/tagger.ts` 就放它旁边。
- `components/` 里只放**无 React 依赖**的纯模块单测；需要渲染的走浏览器 CDP 文本化断言。
- `tsc --noEmit` 的 `include` 是**显式列表**，不是 `**/*`——工作区里可能残留 gitignore 的第三方
  源码目录，通配符会把它们卷进类型检查。新增顶层目录时记得补一条。
- `eslint` 的 `react-hooks/set-state-in-effect` 严：localStorage 还原类 effect 需要
  `/* eslint-disable react-hooks/set-state-in-effect */` 包裹。
- SQLite 参数类型写 `SQLInputValue`，不要写 `unknown`（`@types/node@22` 收窄了签名）。

## 分层（改动前对照）

| 层 | 目录 | 约束 |
|:--|:--|:--|
| 路由 | `app/` | 只放路由与外壳，**不写业务实现**；不手写信封（用 `server/http.ts` 的 `ok()`/`fail()`） |
| 前端 | `components/` | 浏览器侧，**不 import `server/`**；事件名走 `PLAYER_EVENTS` 常量 |
| 契约 | `contract/` | **零业务依赖**——不 import `server/`、`app/`；连 `ai` 包都不引（前端要能安全引用） |
| 业务 | `server/` | 不认识 `Request`/`Response`；不 import `next/server` |

一段代码该放哪：**浏览器跑 → `components/`；被 `app/api` 直接调 → `server/`；
前端与 `server/` 都要读 → `contract/`。**

三处易踩的约定：

- **信封成功是 `code: 0`**（`ok()` 固定返回 0），**不是 200**；只有 `fail()` 才让
  `code === HTTP status`。别按「成功 = 200」写断言。
- **SSE 收尾是裸 `data: [DONE]` 哨兵**，前端 `use-chat-stream.ts` 按裸字符串匹配。
  **不要 JSON 编码它。** `/api/chat` 的占位实现遵循同一条。
- **曲目标签一律走 `fusedTags(song)`**，别读 `song.genre` / `song.mood`（本曲库 ID3 有误标）。
  标签值要过 `normalizeTag` 拆词（模型会返回 `["pop folk"]` 这种整串）。

## 关于 `/api/chat`

- 线格式是 **AI SDK 原生 UI 消息流**：`start` / `text-start` / `text-delta` / `text-end` /
  `finish` 五帧 + 裸 `[DONE]`，响应头 `x-vercel-ai-ui-message-stream: v1`。
- 共享装配语义在 `contract/chat-chunks.ts`（前端气泡的文本归约、`extractUsage`）。
  换实现时复用它，**不要另写一份**（历史上分头实现过，然后漂移了）。
- 要接真 Agent：参考 `song` 仓库的 `app/api/chat/route.ts` 与 `agent/src/`。
