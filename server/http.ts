/**
 * server/http — BFF 响应信封的**唯一**构造点。
 *
 * 为什么单独一个文件：`contract/types.ts` 定了信封的**形状**（`ApiResponse`），
 * 但「信封 + HTTP status」的配对规则散落在 24 个 route 里手写了 90+ 次。
 * 同一个形状写 90 遍的代价不是啰嗦，是**改不动**——加一个字段要改 90 处，
 * 漏一处就静默不一致（改前实测：38 处带 `{ status }`、17 处忘了带，
 * 同一句 `code: 400` 在同一批路由里两种行为）。
 *
 * 分层例外（2026-09-10 明确）：`server/` 的域逻辑**不碰** `next/server`，
 * 本文件是唯一例外——它的职责就是把域层的返回值适配成 HTTP 响应。
 *
 * 不变式：**信封的 `code` 与 HTTP status 一致**（成功 200）。
 * 让二者一致是有意的：前端多处按 `res.ok` 判成败（HistoryPanel / PreferencePanel /
 * LibraryGrid / StatsCards），若错误只写在 body 里而 HTTP 仍是 200，
 * 这些调用方会把失败当成功。工具侧 `callBff` 同样先看 `response.ok`，
 * 因此它已同步改为「优先读信封 message，再回落到状态文本」，保证报错信息不回退。
 */
import { NextResponse } from 'next/server';
import type { ApiResponse } from '../contract/types';

/**
 * 成功响应。`message` 默认 `'ok'`；个别路由用非 'ok' 的说明文案
 * （如 `player/next` 的 `'queue empty'`）作为第二个参数传入。
 * `init` 仅用于非 200 的成功语义（目前只有 `playlists` 创建返回 201）。
 */
export function ok<T>(data: T, message = 'ok', init?: ResponseInit): NextResponse<ApiResponse<T>> {
	return NextResponse.json<ApiResponse<T>>({ code: 0, data, message }, init);
}

/**
 * 失败响应。`code` 既是信封里的错误码也是 HTTP status（400/403/404/500/503）。
 * 默认 400（参数错误）——调用方只需在非参数错误时显式传码。
 */
export function fail(message: string, code = 400): NextResponse<ApiResponse<never>> {
	return NextResponse.json<ApiResponse<never>>({ code, message }, { status: code });
}
