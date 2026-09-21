/**
 * 提示词用的播放快照 —— **每个字段都取自它自己的真相来源**。
 *
 * ── 为什么要这一步（2026-09-21）────────────────────────────────────────
 * `PlayerSnapshot` 里装着两种字段，而它们本来只有**一条**获取路径：浏览器随消息
 * 寄上来的一份副本。于是有了这样的形状 ——
 *
 *   | 字段                                       | 真相在哪            | 原先从哪拿    |
 *   | state / currentTrack / queue* / queueLabel  | 服务端单例（权威）  | 浏览器副本 ❌ |
 *   | volume / mode / shuffle / positionSec       | 设备侧（浏览器）    | 浏览器副本 ✅ |
 *
 * 第一行是**绕一圈的**：用户点「下一首」，改的本来就是服务端状态；可它要先 SSE
 * 推给浏览器、等浏览器下一次发消息时寄回来，才进得了 ⑦。这一圈**只会丢信息、
 * 不会加信息**，能丢的地方至少四处：SSE 断线、另一个标签页改的、服务端重启后
 * 浏览器还握着旧副本、以及**请求根本不由浏览器发起**（`curl`、将来的 ⑩ 触发器）。
 * 所以服务端权威的那几项在路由里**现取**。
 *
 * 第二行**不能改**：音量是「这台浏览器的音量」，开关在 `<audio>` 上，服务端手上
 * 的只是一份镜像（见 `contract/player.ts` 各字段注释）——服务端自己去取也还是
 * 镜像，不会更真。所以那一侧仍以浏览器为准。
 *
 * ── 为什么落在 `server/` ──────────────────────────────────────────────
 * 它要读服务端状态。纯的那一半（`mergeSnapshot`）单独拆出来是为了**可测**：
 * 路由里的代码单测够不着，而这条规则恰恰只在"两份数据不一致"时才起作用——
 * 只在真实浏览器里连点几下是撞不出这种错位的（要造出一份**故意错了的**副本）。
 */
import type { PlaybackMode, PlayerSnapshot } from '../../contract/player';
import { getSnapshot } from './state';

/**
 * 设备侧四项 —— **只有这四个字段允许被浏览器那份覆盖**。
 *
 * 返回类型写死成 `Pick<...>` 是故意的：服务端权威的部分于是在**类型层面**就
 * 不可能被 body 顺手改掉（`{ ...server, ...deviceOwned(...) }` 里第二个展开项
 * 长不出别的键）。将来给快照加字段时，如果它属于设备侧，要在这里显式加一笔——
 * **加字段的动作本身就是一次归类**。
 */
function deviceOwned(
	server: PlayerSnapshot,
	device: Partial<PlayerSnapshot>,
): Pick<PlayerSnapshot, 'positionSec' | 'volume' | 'mode' | 'shuffle'> {
	return {
		positionSec: num(device.positionSec, server.positionSec),
		volume: num(device.volume, server.volume, 1),
		mode: isMode(device.mode) ? device.mode : server.mode,
		shuffle: typeof device.shuffle === 'boolean' ? device.shuffle : server.shuffle,
	};
}

/**
 * 数字字段的形状检查：非有限数一律退回兜底值，`max` 用来夹住有量纲上限的字段。
 *
 * 为什么一个"只是拼提示词"的地方要看形状：这条路由是**公开的 HTTP 入口**，而
 * `body.snapshot` 此前只是被 `as PlayerSnapshot` 断言过一遍——`volume: "loud"`
 * 会安静地变成提示词里的「音量：NaN%」，`mode: "shuffle"` 会变成「播放方式：
 * undefined」。形状不对就退回服务端镜像：它是旧的，但至少是个**真值**。
 * （`agent/prompt.test.ts` 里那条「不得出现 undefined / null 字面量」钉的是同一个
 *  bug 类的另一端——一个在产出侧，一个在入口侧。）
 */
function num(v: unknown, fallback: number, max = Number.POSITIVE_INFINITY): number {
	return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : fallback;
}

function isMode(v: unknown): v is PlaybackMode {
	return v === 'seq' || v === 'rpt' || v === 'one';
}

/**
 * 合成"提示词该看到的一份"。**纯函数**：给什么就用什么，不读全局状态。
 *
 * `device` 缺省（没有浏览器上报）时整份取服务端——服务端镜像对设备侧字段来说
 * 是旧的，但"有一个可能旧的真值"远好过"没有"。
 */
export function mergeSnapshot(
	server: PlayerSnapshot,
	device?: Partial<PlayerSnapshot> | null,
): PlayerSnapshot {
	if (!device) return server;
	return { ...server, ...deviceOwned(server, device) };
}

/**
 * 每轮现取：服务端权威的字段现在读，设备侧的字段用浏览器随消息寄来的那份。
 *
 * 路由（⑧）只调它一行 —— 逻辑留在这里，因为**路由里的代码测不到**。
 */
export function promptSnapshot(device?: Partial<PlayerSnapshot> | null): PlayerSnapshot {
	return mergeSnapshot(getSnapshot(), device);
}
