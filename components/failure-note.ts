/**
 * 「这个动作没成功」那句话 —— 唯一出处。
 *
 * **网络层失败**与**服务端拒绝**不能合成一句：都是没成功，但下一步不同 ——
 * 前者值得重试，后者说明请求到了、是发出去的东西不被接受（再点一次同样的结果）。
 * 症状一样、修法相反，与 ⑨ 归因把「环境类」与「行为类」分开是同一条判据
 * （见 `server/agent/diagnose.ts`）。
 *
 * 提出来的理由：`forgetFailed`（记忆卡）与播放历史卡的「重播没成功」是**同一句话
 * 的两个用法**，各写一份就是同一份规则两处实现（BLUEPRINT §7 错题本记过两次
 * 这类腐化）。文案里那句话由调用方给 —— 它才是知道「这一下没成之后还剩什么」的人。
 */

/**
 * @param action 动作的名字，如 `'删除'` / `'重播'`
 * @param status `null` 表示请求根本没发出去（网络层失败）；数字是服务端回的状态码
 * @param tail   补在后面的处境说明（如 `'—— 这条还在。'`）
 */
export function failureNote(action: string, status: number | null, tail = ''): string {
	return status === null
		? `${action}没成功（网络没通）${tail}`
		: `${action}没成功（服务端回了 ${status}）${tail}`;
}
