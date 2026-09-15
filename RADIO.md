# 私人电台（private radio）

一个**长驻的编排器**：按时段把本地曲库编排成节目，接管播放器队列，
并像 DJ 一样口播。**编排是确定性算法，不调用 LLM**。

## 1. 总体架构

```
┌────────────────────────────────────────────────────────────────┐
│                    server/radio/station.ts（长驻）              │
│   globalThis 单例 · 15s tick · 换栏目 / 补档 / 推进 / 让位       │
│        │                    │                     │            │
│        ▼                    ▼                     ▼            │
│  director.ts            memory.ts           player/state.ts    │
│  时段栏目+选曲打分   SQLite 曲目画像+节目史   队列/播放状态+SSE    │
│  （确定性，零 token）  （data/radio.db）      （既有播放内核）     │
└────────────────────────────┬───────────────────────────────────┘
                             │ ensureQueue / playTrackById / subscribe
                             ▼
              ┌──────────────────────────────┐
              │  BFF API（唯一汇聚点）         │
              │  /api/radio/now · start · stop│
              └──────────────┬───────────────┘
                             ▼
                    浏览器 APlayer（发声端）
```

三条关键决策：

1. **编排是确定性算法，不是 LLM 循环。** 时段栏目表 + 打分公式 +
   记忆去重，毫秒级、零 token、断网也能跑。这是「长驻」可靠性的前提。
2. **电台不发声，只发指令。** 出声的永远是接入的播放器客户端
   （现在 = 浏览器 APlayer，通过既有 SSE 快照同步）。全部能力都是普通
   REST，没有私有通道。
3. **记忆在播放边界记账。** 电台订阅 player-state 快照：上一首电台曲目
   被切走时按完成度记账 —— 播满 60% 记 `play`，否则记 `skip`（负反馈）。
   用户跳歌这个最真实的信号，下一档节目就会体现。

## 2. 运行循环（station.ts 的 tick）

每 15 秒一次，按序检查，**全部异常自吞**（电台不能因一次抖动死掉）：

```
1. 时段变了？      当前栏目 ≠ 现在时段 → 收播旧栏目（归档记忆）→ 编排新栏目 → 口播 → 接管队列
2. 还没有栏目？    （开台初期曲库未就绪）→ 编排第一档
3. 用户手动暂停？  → 让位，本轮什么都不做（电台不抢麦）
4. 队列剩 ≤1 首？  → 编排下一组追加到队尾（加更，口播不打断）
5. 播放器空转？    → 推进到排片下一位
```

防重入：单例挂 `globalThis.__radioStation`，dev 模式 HMR 重载模块不会重复开台、
不丢状态；心跳定时器 `unref()`，不阻止 Node 进程自然退出。

## 3. 选曲打分（director.ts，刻意保持可解释）

| 信号 | 权重 | 来源 |
| :--- | :--- | :--- |
| 时段气质匹配（mood / genre） | +0.18 / +0.10 | 时段栏目表 × 曲目元数据 |
| 时段亲和（这个点常听它） | +0.15 × 亲和度 | 记忆：`hour_hist` 24 小时直方图 |
| 熟悉度（对数衰减防霸榜） | +0.04 × log2(1+播放次数) | 记忆：`play_count` |
| 跳过率惩罚 | −0.35 × 跳过占比 | 记忆：`skip_count` |
| 2 小时内播过 | −0.5（画像里刚播再 −0.3） | 节目史去重窗口 |
| 用户偏好（favoriteGenres / Moods） | +0.12 / +0.08 | preferences 副本 |
| 用户不喜欢（dislikedGenres） | −0.3 | preferences 副本 |

每首歌的命中原因都记录在排片里（`/api/radio/now` 的 `playlist[].reasons`），
状态页可以解释「为什么放这首」。曲库小时打分只是软引导，不会让台开天窗。

## 4. 数据模型（memory.ts，SQLite `data/radio.db`）

```sql
track_stats     -- 每首歌的长期画像
  track_id, play_count, skip_count,
  last_played_at, last_skipped_at,
  total_sec, hour_hist        -- '{"23":4,"1":2}' 时段直方图

radio_programs  -- 节目史（既审计轨迹，也是「最近播过」去重源）
  id, started_at, ended_at, name, daypart_id, hour, track_ids, dj_line
```

记忆的两个回流口：**播放完成度记账**（§1 决策 3）与**节目史归档**
（换栏目 / 收播时 `endProgram`）。关台不丢数据，下次开台 DJ 口播会引用
累计数字（「已经陪你播过 N 档节目」）。

## 5. API 与前端入口

| 方法 | 路径 | 作用 |
| :--- | :--- | :--- |
| GET | `/api/radio/now` | 状态面：开关、当前栏目、排片+打分依据、DJ 口播、记忆概况、最近节目 |
| POST | `/api/radio/start` | 开台（幂等）：编排当前时段栏目并接管队列开播 |
| POST | `/api/radio/stop` | 收播：停心跳、归档节目；播放器保持现状 |

```bash
curl -X POST http://127.0.0.1:3000/api/radio/start
curl http://127.0.0.1:3000/api/radio/now | jq '.data.program, .data.djLines[0]'
curl -X POST http://127.0.0.1:3000/api/radio/stop
```

前端入口：顶栏「📻 电台」按钮（`components/RadioButton.tsx`）。开台后按钮常亮，
每 20s 轮询 `/api/radio/now`，tooltip 展示最新 DJ 口播。

可观测：DJ 口播与服务日志同流（`[radio] ...` 前缀）；节目史在
`/api/radio/now` 的 `recentPrograms`。

## 6. 标签体系 —— 曲库怎么被「盘活」

曲库标签贫瘠（genre 常缺、mood 几乎没有），所以标签有三个来源，按优先级融合
（`memory.ts` 的 `fusedTags`）：

| 来源 | 含义 | 可信度 |
| :--- | :--- | :--- |
| `user` | 用户显式标注 | 最高，覆盖其它一切 |
| `llm` | 模型按标题/歌手/专辑判断 | confidence 0.7，有想象成分 |
| `inferred` | 按风格推断（`jazz→relaxed`） | 粗粒度 |
| `id3` | 文件自带 | 经常缺失，且**实测本曲库有误标** |

⚠️ **`fusedTags` 的语义是「user/llm 取代原字段」，不是并集。** 并集会让
「布鲁斯」命中全库（本曲库 6 首中文流行的 ID3 genre 全被标成 `blues`）。
判断「这首歌是什么风格/情绪」一律走 `fusedTags(song)`，别直接读
`song.genre` / `song.mood`。

**边播边补标**（`tagger.ts` 的 `enqueueLazy`）：歌曲开播时若还没有 LLM 标签，
就塞进串行后台队列补标。第一遍播用自带/推断标签，第二遍起就有模型标签了。
省 token —— 只标你真正听过的歌。入口挂在 `/api/library/stream` 上，
每次播放自动触发，无需手动操作。

打标结果经受控词表白名单校验（`ALLOWED_MOODS` / `ALLOWED_GENRES`），
脏值在这里被兜住（`cleanTags`，有单测）。

## 7. 中文语义解析（lexicon.ts）

用户搜「欢快的爵士」时，`parseQuery` 把中文词归一化成英文标签，
再交给 `server/library/search.ts` 与曲库标签比对：

- **主观形容词**（欢快/安静/丧）→ mood 标签簇，带权重（越靠前越直接）
- **专业术语**（爵士/布鲁斯/古典）→ genre 标签，做别名折叠（爵士/Jazz/jazz → jazz）

解析是**纯函数**，贪心长词匹配，不依赖 LLM。`data/lexicon-learned.json`
里存的是「学到的新词」映射，由 `parseQuery` 一并读入且**优先于内置词典**。

⚠️ 词典给出的标签必须与 `tagger.ts` 的 `ALLOWED_MOODS` / `ALLOWED_GENRES`
同词表，否则「中文能搜到、打标却写不进」—— `tagger.test.ts` 里有一条断言
专门钉住这个对齐关系。
