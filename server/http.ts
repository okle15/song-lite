/**
 * server/http — BFF 响应信封的**唯一**构造点。
 *
 * 为什么单独一个文件：`contract/types.ts` 定了信封的**形状**（`ApiResponse`），
 * 但「信封 + HTTP status」的配对规则曾在每个 route 里各手写一遍。同一个形状抄
 * 几十遍的代价不是啰嗦，是**改不动**——加一个字段要改几十处，漏一处就静默不一致
 * （当时实测：同一句 `code: 400` 在一批路由里存在两种行为）。
 *
 * 分层例外（2026-09-10 明确）：`server/` 的域逻辑**不碰** `next/server`，
 * 本文件是唯一例外——它的职责就是把域层的返回值适配成 HTTP 响应。
 *
 * 不变式：**信封的 `code` 与 HTTP status 一致**（成功 `code: 0` + 200）。
 * 让二者一致是有意的：前端多处按 `res.ok` 判成败（LibraryGrid / PlayerBar /
 * NowPlaying），若错误只写在 body 里而 HTTP 仍是 200，这些调用方会把失败当成功。
 */
import { NextResponse } from 'next/server';
import type { ApiResponse } from '../contract/types';

/**
 * 成功响应。`message` 默认 `'ok'`；个别路由用非 'ok' 的说明文案
 * （如 `player/next` 的 `'queue empty'`）作为第二个参数传入。
 */
export function ok<T>(data: T, message = 'ok'): NextResponse<ApiResponse<T>> {
	return NextResponse.json<ApiResponse<T>>({ code: 0, data, message });
}

/**
 * 失败响应。`code` 既是信封里的错误码也是 HTTP status（400/403/404/500/503）。
 * 默认 400（参数错误）——调用方只需在非参数错误时显式传码。
 */
export function fail(message: string, code = 400): NextResponse<ApiResponse<never>> {
	return NextResponse.json<ApiResponse<never>>({ code, message }, { status: code });
}
