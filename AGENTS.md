# 项目协作规则

改代码前先读 [README.md](./README.md) 与本节。违反红线的修改会被回滚。

---

## 这个项目是什么

**只做本地播放**的个人音乐助手，Next.js 16 单进程（前端 + BFF 在一起）。
功能刻意保持最简：任何新能力都应当先问「它是不是非加不可」，而不是「顺手也加上」。

---

## 目录约定

| 目录 | 放什么 |
|:---|:---|
| `app/` | 路由 + 页面外壳。`page.tsx` 是**服务端外壳**（读一次对话历史当 props 递下去，因此没有 `'use client'`，且必须 `export const dynamic = 'force-dynamic'`）；`home-client.tsx` 是浏览器主体；`app/api/**/route.ts` 每个只做「解析参数 → 调域逻辑 → 包信封」 |
| `components/` | 浏览器侧组件与纯函数模块（**不设 `lib/` 子目录**）。需要 React 渲染的不写单测，无 React 依赖的纯模块要写 |
| `contract/` | 前后端**共享契约**，零业务依赖。前端能引用的服务端类型只能来自这里 |
| `agent/` | Agent 本体：`provider`（接入）/ `run`（循环）/ `tools`（工具）/ `prompt`（提示词）。**不 import `server/`**——工具用 HTTP 打自家 BFF。十个部件的落点见 [BLUEPRINT.md](./BLUEPRINT.md) |
| `server/` | 业务实现。根只留 `http.ts`（信封）与 `db.ts`（连接），其余归入 `agent/ library/ player/ records/` |
| `telemetry/` `eval/` | **已不存在**（随最简化删除），别再往这里加东西 |
| `scripts/` | `api-smoke.mjs` 接口体检 |
| `data/` | `music/` 是曲库源码资产；`app.db` 是运行时派生数据（gitignore） |

**依赖方向是单向的**：`app → server → contract`；`components → contract`（只 `import type`）；
`agent → contract`，且 **`agent/` 不许 import `server/`**——工具一律用 HTTP 打自家 BFF 路由，
agent 与浏览器因此共用同一个 API 面，不存在「第二套入口各自漂移」。
`components/` 不许 import `server/`，`server/` 不许 import `next/server`（唯一例外是 `http.ts`，
它的职责就是适配成 HTTP 响应）。

---

## 数据与持久化

- **曲库不落库**：曲目来自对 `MUSIC_DIR` 的实时扫描（进程内 memo），真相在文件系统上。
- **数据库只存扫描不出来的东西**：`plays`（播放历史）、`messages`（对话历史）、
  `preferences`（⑥ 记忆，一行 = 一条长期偏好）与 `track_tags`（曲目风格，一行 = 一首歌）。
- **风格标签的优先级由「入口」决定，不由调用方声明**：走 `POST /api/library/tags`
  （人或 agent 在说话）= `source='user'`，无条件覆盖；AI 批量打标走 `npm run tag:library`
  （`scripts/auto-tag.mts`）直连 `server/library/tags.ts` 写 `source='ai'`，
  **永不覆盖已有的 `user`**。拆词 / 去重 / 排序规则在 `contract/track-tags.ts`，不许另写一份。
- **`messages.id` 就是前端消息 id**，靠 `ON CONFLICT(id) DO UPDATE` 实现幂等；顺序锚在 `rowid`
  ——别用 `created_at` 排序（一轮的 user / assistant 会在同一毫秒落库，撞车）。
- **`messages` 存 parts 全量（含工具轨迹），裁剪只发生在发送前**（`agent/run.ts` 的 `pruneMessages`）。
  存全量是为了刷新后轨迹卡片能原样恢复，发送前裁是为了上下文干净——合成一步必然牺牲一个。
- **`preferences` 用 `key` 唯一性定义「什么算同一条偏好」**：同 key 覆盖，不追加（否则用户说五遍
  「不喜欢摇滚」会记五条）。归一化规则（大小写 / 空格 / 连字符）在 `contract/preference.ts`，
  **工具侧与存储侧共用同一份**，不许另写一份。
- **四张表的失败语义不同，且是有意的**：`plays` / `messages` 是**流水**，写失败只记日志（不该打断
  播放或对话）；`preferences` / `track_tags` 是 agent 对用户的**承诺**（它已经说了「好，我记住了」
  /「改好了」），写失败必须抛到路由 → 变成工具失败 → 模型据实告知。
  **加新表时先问一句：它失败时，谁需要知道？**
- **偏好注入只读最近 30 条**（`MAX_INJECTED_PREFERENCES`），不删任何行；**不做自动过期**——
  时效语义（「最近别放摇滚」）交给 `value` 的自然语言承载。加一个 `expires_at` 却不写任何检查
  它的代码，只会让人以为系统在做过期判断。
- **建表语句只在 `server/db.ts` 出现**。加表就往 `migrate()` 里追加 `CREATE TABLE IF NOT EXISTS`。
  一旦别处也写一份，两处必然漂移（历史上 `logs.db` 与 `eval.db` 的双份表定义就是这么来的）。
- **写入时机是「成功切歌」**：`/api/player/{play,next,jump}`。`pause`/`resume` 不记，
  否则「听了多少首」会随暂停次数虚高。
- **写历史失败不能抛**：记历史是旁路，磁盘满 / 权限不对都不该把播放打断。
- 刻意**不开 WAL**，落盘只有单个 `.db` 文件——「删一个文件就干净」是有意保留的性质。

---

## 验证与调试

- **前端回归一律走生产模式**：`npm run build && npm start -- -p 3100`。
  Turbopack dev 下 SSE 首连接会挂起（dev-only），别在 dev 下反复排查。
- **改了 `agent/**` 任何文件后必须 `npm run build` 再验**：生产模式不热更新，服务端跑的是
  构建产物。改完不重建就去点对话，看到的是**上一版行为**——不报错、不提示，最容易误判成
  「我的改动没生效」或「prompt 没用」。
- **`next build` 后必须重启 `next start`**：老服务把构建清单常驻内存，磁盘被重建后它会继续
  下发**旧 HTML**，引用的旧 chunk 已不存在 → 静态请求 500 → 浏览器报
  `ChunkLoadError: Failed to load chunk`。症状极具误导性：**SSR 首屏正常渲染**，
  但 **hydration 从不发生**，于是所有交互都是死的（点按钮没反应），而 console 里一条报错都没有。
  判据：`curl -s <页面> | grep -o '/_next/static/chunks/[a-z0-9_]*\.js' | sort -u` 逐个探测是否 200。
  动手前先 `netstat -ano | grep :3100` 确认端口上的进程是本次起的。
- **本机验证一律绕代理**：环境里 `HTTP_PROXY/HTTPS_PROXY` 指向本地代理，**localhost 流量也会被截走**，
  可能拿到陈旧或伪造的响应。curl 加 `--noproxy '*'`，统一用 `127.0.0.1` 而非 `localhost`。
- **长驻进程（`next start` / 无头浏览器）必须 `run_in_background`**：用 `cmd &` 起的进程会随该次
  调用结束被回收，表现为「刚探测到端口在听、几秒后全变 `ERR_CONNECTION_REFUSED`」。
- **无头浏览器起不来时先分清是哪一个浏览器**：系统装的 Chrome / Edge 在本沙箱起不来
  （`--headless=new` 会因 updater 命名管道被拒而 0 字节退出）；且**用户自己开着浏览器时，
  新起的实例会被接管后秒退**——别去杀它。**换 Playwright 自带的 Chromium 就能起**
  （2026-09-17 实测，系统 Chrome 同参数仍然失败）：`playwright-core` 装在隔离工作区
  `~/.workbuddy/binaries/node/workspace`，`executablePath` 指
  `~/AppData/Local/ms-playwright/chromium-1187/chrome-win/chrome.exe`，
  配 `--no-sandbox --no-proxy-server`，页面一律用 `127.0.0.1`。
- **拖拽类交互必须真拖，截图和单测都覆盖不到**：用 `page.mouse.down/move/up` 走完整
  pointer 序列，并**穷举「每个可见控件 × 两个方向」**——只测一个方向看不出单向死区
  （BLUEPRINT §7 的「死控件」两条就是这么漏掉的）。顺手在控件中心做
  `document.elementFromPoint()` 命中测试，一眼看出它是不是被别的元素盖住。
- **但「穷举控件」还不够，必须再穷举「状态 × 宽度」**：控件的存在与否取决于布局状态
  （卡片被隐藏 / 合并成标签页后，一列可能只剩一张卡），而宽度决定 CSS 走哪条分支。
  默认布局 + 一个宽度下测出来的"能用"，覆盖不到用户自己调过的布局。做法：把布局
  直接写进 `localStorage['music-panel-layout:lite']` 再 reload，扫「状态 × 宽度」矩阵
  （2026-09-17 就是这么才发现：窄屏下"每列只剩一张卡"时**一条分隔条都没有**，
  而默认布局上一切正常）。
- **无头浏览器的 HTTP 缓存也会骗人**：即使服务已重启，旧 profile 缓存的 runtime 仍指向旧 chunk 名。
  换新 `--user-data-dir` 再验一次，别急着怀疑代码。

---

## 静态检查

- `npx tsc --noEmit` 覆盖全仓（`tsconfig.json` 用**显式 include 列表**，不是 `**/*`）。
- `npm run lint`（ESLint 9 + `eslint-config-next`）。
  注意 `react-hooks/set-state-in-effect` 很严：localStorage 还原 / 广播订阅这类 effect
  需要 `/* eslint-disable react-hooks/set-state-in-effect */` 包裹。
- **单测：`npm test`**（`tsx --test`，node:test + node:assert，无额外框架）。
  新增目录要同步改 `package.json` 里的 glob。
- **单测就近放**：测 `contract/` 的模块就放 `contract/`，测 `server/player/media.ts` 就放它旁边。

---

## 依赖与安装

- **装依赖用 `npm install`，不是 `pnpm install`**（`.npmrc` 里明写的项目约定）：
  本沙箱里 pnpm 对本仓库的依赖偶发 symlink 错误，且实测会**无输出永久挂起**。
- 依赖表刻意保持极小，**加依赖前先问「Node 内置能不能做」**——SQLite 就是这么解决的
  （`node:sqlite`，免掉 better-sqlite3 的原生编译）。当前直接依赖 8 个：
  `next` / `react` / `react-dom`（骨架）、`music-metadata`（ID3）、
  `ai` + `@ai-sdk/openai-compatible` + `@ai-sdk/react`（Agent 三件套，各自职责见 [BLUEPRINT.md](./BLUEPRINT.md) §4）、
  `zod`（工具入参 schema）。
- **`zod` 钉在 `4.4.3`，别随手升级**：4.6.5 起改写了 `$ZodType` 的泛型签名，`tool()` 的
  `inputSchema` 会**全线报 TS2769「No matching overload」**——报错指向 `tool()` 调用处、
  不指向版本，极易误判成自己写法有错。升版前先跑 `npx tsc --noEmit`。
- 装依赖前先停掉 dev / 生产服务，否则 Windows 下文件被占用会失败。
