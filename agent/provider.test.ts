/**
 * `agent/provider.ts` 的 `readCostLimitMicro` 单测 —— 成本闸门的**配置入口**。
 *
 * 为什么值得为一个 getter 单开一个文件：它的**坏值分支决定了服务的可用性**。
 * `AGENT_MAX_COST_MICRO` 写错时（`abc` / 留空 / 负号）有两种可能的"宽容"：
 *   - 当成"不限" → 用户什么都没损失（闸门本来默认就是关的）；
 *   - 当成 0 → 每一轮刚开头就被掐掉，症状是"助手突然什么都不肯说了"，
 *     而**没有任何一处会报错**（闸门按设计工作，只是上限被解析错了）。
 * 所以这几条断言不是形式，是那条「env 写错时安全方向是放行」的纪律的可执行版本。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCostLimitMicro } from './provider';

/** 临时改环境变量跑一段，跑完恢复原值（测试之间不互相污染）。 */
function withEnv(value: string | undefined, fn: () => void): void {
	const prev = process.env.AGENT_MAX_COST_MICRO;
	if (value === undefined) delete process.env.AGENT_MAX_COST_MICRO;
	else process.env.AGENT_MAX_COST_MICRO = value;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.AGENT_MAX_COST_MICRO;
		else process.env.AGENT_MAX_COST_MICRO = prev;
	}
}

test('没配 → 0（不限）：闸门默认是关的', () => {
	withEnv(undefined, () => assert.equal(readCostLimitMicro(), 0));
});

test('0 → 0（"不限"，不是"一分钱都不许花"）', () => {
	withEnv('0', () => assert.equal(readCostLimitMicro(), 0));
});

test('坏值 / 空 / 负数一律当"不限"，不许解析成 0 上限', () => {
	for (const bad of ['', 'abc', '-5', 'NaN', '  ']) {
		withEnv(bad, () => assert.equal(readCostLimitMicro(), 0, `输入 ${JSON.stringify(bad)}`));
	}
});

test('正常值取整返回（微美元是整数单位）', () => {
	withEnv('1500000', () => assert.equal(readCostLimitMicro(), 1_500_000));
	withEnv('123.9', () => assert.equal(readCostLimitMicro(), 123));
});
