/**
 * 首页 —— **服务端外壳**（server component，注意本文件没有 `'use client'`）。
 *
 * 存在理由只有一个：**对话历史必须在首屏 HTML 里就存在**。若交给浏览器 mount 之后
 * 再 fetch，用户会先看到「你好，我是你的音乐助手」、几百毫秒后历史才顶上来——那次
 * 可见的状态切换就是「闪」。服务端在产出 HTML 之前读库，就根本不存在「之后」。
 *
 * 代价（已接受，见 2026-09-16 的决策）：
 *  - 每次页面请求多读一次 SQLite（`node:sqlite` 是同步 API，微秒级）；
 *  - 首屏 HTML 变大（历史嵌在 HTML / RSC payload 里）。几十条消息无所谓。
 *
 * ⚠️ **`force-dynamic` 不能删。** server component 默认会在 `next build` 时被预渲染，
 * 而历史数据**不来自** fetch / headers / cookies，Next 探测不到它需要动态渲染——
 * 一旦被静态化，历史就定格在「构建那一刻」，此后永久不变。症状不是「闪一下」，
 * 而是「永远错」：你在页面上说了十句话，刷新后仍是构建时那个空状态。
 * 判定方法：删掉这一行跑 `next build`，产物里会出现一个预渲染的 HTML。
 */
import { recentMessages } from '@/server/agent/message-log';
import { Home } from './home-client';

export const dynamic = 'force-dynamic';

export default function Page() {
	return <Home initialMessages={recentMessages()} />;
}
