/**
 * Shared API response + request types.
 *
 * 每个 BFF JSON 路由都返回统一的 `ApiResponse<T>` 信封 —— `{ code, data?, message }`。
 * `code` 成功为 `0`、失败为非零的 HTTP status；`data` 仅成功时出现；`message` 恒在。
 * 流式路由（`/api/player/events`）正常时输出 SSE 分帧，只在错误响应上用这个信封。
 *
 * 信封的构造只允许在 `server/http.ts` 里发生（`ok()` / `fail()`）。
 */

/** Uniform envelope: `code=0` success with `data`; non-zero failure with `message`. */
export type ApiResponse<T> = {
	code: number;
	data?: T;
	message: string;
};
