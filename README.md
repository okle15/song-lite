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

**有**：曲库浏览与搜索、点击播放、进度拖动、上下首、播放队列、播放模式（顺序 / 列表循环 /
单曲循环 / 随机）、歌词（含全屏沉浸页）、音量 / 静音、背景主题、可拖拽可合并的多面板布局、
全局快捷键、播放历史落库。

**没有**（曾有过，2026-09-15 随最简化删除）：电台、偏好设置、AI 对话、语音输入、
MV 视频播放、统计概览、LLM 打标。要恢复它们，看 git 历史（`RADIO.md` 一并删除）。

---

## 目录结构

```
app/            只放路由。页面外壳在 page.tsx，其余全是 app/api/**/route.ts
components/     浏览器侧（不设 lib/ 子目录）。纯函数模块的单测就近放
contract/       前后端共享契约，零业务依赖（player.ts 是 SSE 的 wire 类型）
server/         业务实现。根只留 http.ts（信封）与 db.ts（连接）
  library/      曲库：扫描 / 搜索 / 目录解析
  player/       播放状态机 / 音频流 / 响应体
  records/      播放历史读写
scripts/        api-smoke.mjs —— 接口体检
data/           music/（曲库源码资产）+ app.db（运行时派生，见 .gitignore）
```

---

## API 一览（10 个）

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/api/library/search?q=&limit=` | 曲库检索（`q` 空 = 整库），标题/歌手/专辑子串匹配 |
| GET | `/api/library/stream?trackId=` | 音频字节流，支持 Range（seek 靠它） |
| GET | `/api/library/lyrics?trackId=&raw=` | LRC 歌词；`raw=1` 返回 text/plain |
| GET | `/api/player/events` | **SSE**，播放状态的唯一推送源 |
| GET/POST | `/api/player/play` | GET 轮询当前状态；POST `{trackId}` 点播 |
| POST | `/api/player/pause` · `/resume` | 暂停 / 续播（无播放中 → 409） |
| POST | `/api/player/next` | 下一首；到队尾返回 `stopped` |
| POST | `/api/player/jump` | `{index}` 跳到队列第 index 首 |
| GET | `/api/history?limit=` | 播放历史，时间倒序（默认 20，上限 200） |

**统一信封**：所有 JSON 路由返回 `{ code, data?, message }`。
`code === 0` 表示成功（**不是 200**），失败时 `code` 等于 HTTP status。
构造只允许在 `server/http.ts` 的 `ok()` / `fail()` 里发生，路由不许手写信封。

---

## 数据与持久化

**曲库不落库。** 曲目是对 `MUSIC_DIR` 的一次目录扫描（`server/library/scanner.ts`），
进程内 memo。真相永远在文件系统上，再存一份到 SQLite 只会引入
「表里的行和盘上的文件对不上」这类问题。

**数据库只存扫描不出来的东西** —— 目前只有播放历史：

```
data/app.db  (SQLite, node:sqlite —— Node 内置，零 npm 依赖)
  plays(id, track_id, title, artist, started_at)
```

- 建表语句**只在 `server/db.ts`** 出现。加表就往 `migrate()` 里追加一条。
- 写入时机：`/api/player/{play,next,jump}` **成功切歌**时记一行（`pause`/`resume` 不算新播放）。
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
```

前端回归**一律走生产模式**（`npm run build && npm start -- -p 3100`），
不要在 dev 下排查 SSE——Turbopack dev 的 SSE 首连接会挂起，那是 dev-only 现象。

`scripts/api-smoke.mjs` 会顺带断言**信封不变式**（`code` 与 HTTP status 一致），
以及「播放之后历史确实落库了」。

---

## 文档索引

| 文档 | 何时读 |
|:---|:---|
| [AGENTS.md](./AGENTS.md) | 改代码前必读：协作红线、验证与调试、目录约定 |
