/**
 * /api/player/queue/remove —— **从队列里去掉一首**（队列卡上那个 ×）。
 *
 * 这条路由最初补的是一个**界面缺口**：在它之前，「队列」这件事的三件写里有两件已经有人
 * 能做 —— agent 用 `build_queue` 换一批（`POST /api/player/queue`）、`next_track` 往后跳
 * —— 而「这首我不想听了，从队列里去掉」在队列卡上一直无处表达（`QueueList` 只能看、
 * 只能点着跳）。于是 `POST /api/player/queue` 成了全仓**唯一一条没有前端调用方**的路由；
 * 现在它有了同一族的兄弟，而且**两侧都齐了**（写类能力本来就该两边都能做）：
 *
 *   | 想干的事 | 路由 | 谁在用 |
 *   | 换一批（含「恢复整个曲库」） | `POST /api/player/queue` | agent 的 `build_queue` + 队列卡底部的「恢复整个曲库」 |
 *   | **去掉一首** | `POST /api/player/queue/remove` | 队列卡上每行的 × **+ agent 的 `remove_from_queue`** |
 *   | 跳一首 | `POST /api/player/jump` | 队列卡点一行 + 快捷键 |
 *
 * **入参是 `trackId`，不是下标**（理由写在 `server/player/state.ts` 的
 * `removeFromQueue` 上）：下标是「某一份视图」里的位置，而队列会被别处改，
 * 每次改动都经 SSE 推一份新列表 —— 按下标删最坏会**删掉另一首歌而且不报错**；
 * 按 id 删最坏是删不到，报 404，用户看得见。
 *
 * **为什么不复用 `POST /api/player/queue`**（把剩下的 id 整份发回去重设队列）：
 * 那条路由的契约是「换一批**并开播第一首**」，用它删一首会把你正在听的那首换掉，
 * 还会往 `plays` 记一行「开始播第 1 首」。更要紧的是它要求调用方把**整份列表**发回来，
 * 而前端那份可能比服务端旧 —— 那就是**静默丢歌**（同族：整表替换类的写路径）。
 * 本路由只发送「去掉哪一首」这一条最小信息，剩下的由服务端的真值决定。
 *
 * 404（这首歌不在队列里）不是崩溃，是「你看到的列表已经旧了」：
 * 前端据此说事实（「它已经不在队列里了」），而不是说「去掉失败」。
 * ⚠️ **agent 侧同判据**：`remove_from_queue` 把 404 收成**成功** + 「队列没有改动」，
 * 而不是失败 —— 报成失败会推着模型去编一个补救动作，而这里什么都不用做。
 * 空队列是**合法终态**（与播完最后一首同形），所以去掉最后一首也返回 200。
 *
 * 切歌成功即记一行播放历史（与 `next` / `jump` 同一条规矩）：去掉当前那首会使
 * 下一首**真的开始播**，那就是一次「开始播了一首」。去掉别的项不记。
 */
import { removeFromQueue } from '@/server/player/state';
import { playerPayload } from '@/server/player/payload';
import { recordPlay } from '@/server/records/play-log';
import { ok, fail } from '@/server/http';

export async function POST(request: Request) {
	let body: { trackId?: unknown };
	try {
		body = await request.json();
	} catch {
		return fail('Invalid JSON body', 400);
	}

	const trackId = typeof body.trackId === 'string' ? body.trackId : '';
	if (!trackId) {
		return fail('trackId is required', 400);
	}

	const removed = removeFromQueue(trackId);
	if (!removed) {
		return fail(`队列里没有这一首：${trackId}`, 404);
	}

	// 「开始播了一首」的判据用返回值里的 `started`，不是在外面比 id：同一首歌在队列里
	// 出现两次时，id 比对会把一次真实的重新开始看漏（那种情形下 `started` 仍然是对的）。
	if (removed.started) {
		const track = removed.started;
		recordPlay({ id: track.id, title: track.title, artist: track.artist });
	}
	// 响应体就是标准的播放载荷：`queue` 数组在，调用方自己核「那一首确实没了」。
	// 不额外回 `removed: trackId` 这类字段 —— 它只是把入参回声一遍，多一个没人读的契约。

	return ok(playerPayload(removed.state, { withQueue: true }), 'queue item removed');
}
