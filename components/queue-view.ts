/**
 * 「播放队列」卡的纯规则 —— 这张卡**所有句子**的唯一出处。
 *
 * 提出来的理由与 `memory-view.ts` / `tag-editor.ts` 一样：这里的每一句话都对应一个
 * **会出错的判断**，而它们散在 JSX 里就没有人测得到。同族还有 `list-phase.ts`
 * （四态顺序）与 `failure-note.ts`（两种失败分开说）。
 *
 * ── 这张卡为什么需要这些句子（2026-09-28 加 × 与「恢复整个曲库」时写的）──
 *
 * 队列从 2026-09-17 起**不再恒等于整个曲库**（`queueSource`），但这件事一直没有地方看得见：
 * 卡片副标题原本只写「6 首」，用户看着 6 首会以为曲库丢了歌；而 agent 组的那一批只有
 * 一个名字，缺「它不会跟着曲库变」这句话，也缺一条**退回去**的路。
 *
 * 同一批工作里还定下了「去掉一首」的语义（在服务端 `removeFromQueue`），它有一条
 * 会影响界面的后果：**在「整个曲库」队列上干掉一首，这一批的身份就从 `library`
 * 变成 `custom`** —— 否则下一次点播会把去掉的那首原样找回来（详见那个函数的注释）。
 * 所以 `queueFootNote` 的两种说法不是措辞差别，是**两种不同的处境**：
 *  - 有名字 → 「按『安静的歌』挑的」，是**别人**（agent）组的一批，用户没参与；
 *  - 没名字 → 「你改过的」，是**他自己**从整个曲库里删出来的。
 * 前者要被理解，后者要被确认（确认他刚才那一下确实生效了）。
 */
import type { QueueSource } from '@/contract/player';
import { failureNote } from './failure-note';

/**
 * 队列卡副标题：这一批是**什么**、有多少首。
 *
 * 为什么 `'library'` 也要把「整个曲库」写出来：副标题不写它，用户看到「6 首」时无法
 * 判断这是「曲库只有 6 首」还是「队列被换过」—— 两种处境下一步完全不同，而数字一样。
 * 这是 BLUEPRINT §7 那条「界面上每个数字都要能回答『它是哪一问的答案』」的又一次应用。
 */
export function queueTitle(source: QueueSource, label: string | null, size: number): string {
	if (source === 'custom') return `${label ?? '你改过的这批'} · ${size} 首`;
	return `整个曲库 · ${size} 首`;
}

/**
 * 卡片底部那句说明 + 「恢复整个曲库」按钮的可见性（`null` = 不显示这一块）。
 *
 * 只有自定义队列才需要它：整库队列就是答案本身，没有「为什么不是全部」要解释，
 * 也没有「退回去」可退（按一下「恢复整个曲库」等于什么也没发生 —— 一个点了没反应的
 * 按钮比没有按钮更让人怀疑）。
 */
export function queueFootNote(source: QueueSource, label: string | null): string | null {
	if (source !== 'custom') return null;
	return label
		? `这一批是按「${label}」挑的，不跟着曲库变。`
		: '这一批你改过（从整个曲库里去掉过歌），不跟着曲库变。';
}

/**
 * × 没成功时那句提示。`status` 传 `null` 表示请求根本没发出去。
 *
 * **404 要单独说**：它不是「去掉失败」，而是「你看到的列表已经旧了」—— 这首歌在
 * 服务端已经不在队列里（多半是助手刚换了一批，而这一份视图没跟上）。说成「失败」
 * 会推着用户再点一次，而再点一次的结果仍然是 404。**这条状态码是唯一能区分
 * 「没做到」与「已经不用做了」的信号**，所以按它分叉，不按文案猜（同
 * `agent/tools.ts` 的 `classifyStatus`）。
 */
export function removalNote(status: number | null): string {
	if (status === 404) return '它已经不在队列里了 —— 你看到的列表已经旧了。';
	return failureNote('去掉', status, '—— 队列没变。');
}

/**
 * 「恢复整个曲库」没成功时那句提示。
 *
 * 409 是这条路由**唯一**的失败形态（`POST /api/player/queue` 的「曲库是空的，没有
 * 可播放的内容」）—— 那说明曲库里一首歌都没有，不是网络或权限问题。把它说成
 * 「恢复失败（服务端回了 409）」等于让用户去猜 409 是什么意思。
 */
export function restoreNote(status: number | null): string {
	if (status === 409) return '曲库是空的，没有可恢复的内容。';
	return failureNote('恢复整个曲库', status);
}
