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
| `app/` | **只放路由**。页面外壳在 `page.tsx`；其余全是 `app/api/**/route.ts`，每个只做「解析参数 → 调域逻辑 → 包信封」 |
| `components/` | 浏览器侧组件与纯函数模块（**不设 `lib/` 子目录**）。需要 React 渲染的不写单测，无 React 依赖的纯模块要写 |
| `contract/` | 前后端**共享契约**，零业务依赖。前端能引用的服务端类型只能来自这里 |
| `server/` | 业务实现。根只留 `http.ts`（信封）与 `db.ts`（连接），其余归入 `library/ player/ records/` |
| `telemetry/` `eval/` | **已不存在**（随最简化删除），别再往这里加东西 |
| `scripts/` | `api-smoke.mjs` 接口体检 |
| `data/` | `music/` 是曲库源码资产；`app.db` 是运行时派生数据（gitignore） |

**依赖方向是单向的**：`app → server → contract`；`components → contract`（只 `import type`）。
`components/` 不许 import `server/`，`server/` 不许 import `next/server`（唯一例外是 `http.ts`，
它的职责就是适配成 HTTP 响应）。

---

## 数据与持久化

- **曲库不落库**：曲目来自对 `MUSIC_DIR` 的实时扫描（进程内 memo），真相在文件系统上。
- **数据库只存扫描不出来的东西**：目前只有 `plays`（播放历史）。
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
- **无头浏览器起不来时先查「用户是不是开着浏览器」**：已有常驻实例时新起的 headless 会被接管后秒退。
  **别去杀它**——那是用户自己的浏览器。此路不通时改用文本化断言或纯函数单测。
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
- 依赖表刻意保持极小：`next` / `react` / `react-dom` / `music-metadata`。
  **加依赖前先问「Node 内置能不能做」**——SQLite 就是这么解决的（`node:sqlite`，免掉
  better-sqlite3 的原生编译）。
- 装依赖前先停掉 dev / 生产服务，否则 Windows 下文件被占用会失败。
