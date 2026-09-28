/**
 * 「保存标签」那一下到底该做什么 —— 纯规则，一处落笔。
 *
 * 曲目标签这个输入框有一个**危险的歧义**：`POST /api/library/tags` 明确拒绝空标签
 * （至少要给一个），所以「把输入框删空」这件事没有对应的 POST。若把它当成
 * 「什么都没填 → 不发请求」，用户看到的是**点了没反应**（界面不动、控制台不报错），
 * 而他刚刚做的是一个再明确不过的动作：把这首歌的标签全去掉。
 *
 * 所以判据是：**空输入 = 明确的清空意图**（用户亲手删光了那些字），走 `DELETE`；
 * 只有「本来就一个标签都没有」时才是真的无事可做。
 *
 * ⚠️ 归一化只用 `contract/track-tags.ts` 的 `normalizeTags`，**不在这里拆词**。
 * 模型返回的 `["pop folk"]`、用户写的「民谣和流行」、脚本给的 `Pop,FOLK` 必须是
 * 同一条（那个文件头写了各自的代价）。这里若自己写一份，界面上「改了没改」的
 * 判断会与存储层不一致 —— 而这件事同样不报错。
 */
import { normalizeTags } from '@/contract/track-tags';

export type TagPlan =
	/** 点了也不会发生任何事。`reason` 只用于文案，不用于判据。 */
	| { kind: 'noop'; reason: 'same' | 'nothing-to-clear' }
	/** 把这批标签整体写上去（`source='user'`，无条件覆盖 AI）。 */
	| { kind: 'save'; tags: string[] }
	/** 清掉这首歌的全部标签（`DELETE`）。 */
	| { kind: 'clear' };

/**
 * @param input   输入框里的原文（用户想设成什么）
 * @param current 服务端现在记着的标签
 */
export function planTagSave(input: string, current: readonly string[]): TagPlan {
	const next = normalizeTags(input);
	const cur = normalizeTags(current);

	if (next.length === 0) {
		return cur.length === 0 ? { kind: 'noop', reason: 'nothing-to-clear' } : { kind: 'clear' };
	}
	// 集合相同即视为没改 —— 与存储层同一条规则（存储层也按排序后的形态比较，
	// 见 `server/library/tags.ts` 的 ON CONFLICT 覆盖）。顺序不同不算改动。
	if (next.length === cur.length && next.every((t, i) => t === cur[i])) {
		return { kind: 'noop', reason: 'same' };
	}
	return { kind: 'save', tags: next };
}

/** 按钮上的字跟着**即将发生的事**变 —— 不做这一步的话，「清空」和「保存」长得一样。 */
export function tagButtonLabel(plan: TagPlan): string {
	if (plan.kind === 'clear') return '清空标签';
	if (plan.kind === 'noop') return '没变化';
	return '保存';
}

/** 无事可做时按钮要禁用（点了没反应的控制件与坏掉的控制件长得一样）。 */
export function tagButtonDisabled(plan: TagPlan): boolean {
	return plan.kind === 'noop';
}
