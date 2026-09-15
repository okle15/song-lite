/**
 * Shared API response + request types — Phase 4 (envelope revised Phase 9).
 *
 * Decision E4 (revised per new.md §5.2): every BFF JSON route returns a
 * uniform `ApiResponse<T>` envelope — `{ code, data?, message }`. `code` is
 * `0` on success and a non-zero HTTP-style status on failure; `data` is
 * present only on success; `message` is always present. Streaming routes
 * (like `/api/chat`) emit SSE chunks instead and use the envelope only for
 * their non-streaming error responses.
 */

/** Uniform envelope: `code=0` success with `data`; non-zero failure with `message`. */
export type ApiResponse<T> = {
	code: number;
	data?: T;
	message: string;
};

/**
 * `/api/chat` request body. `userId` doubles as the conversation id (E6).
 * `source: 'eval'` marks offline-eval traffic: skips environment-block
 * injection and telemetry persistence (keeps eval runs comparable with
 * history). 本仓库（song-lite）暂无 Agent，这两个字段只保留契约形状。
 */
export type ChatRequest = {
	message: string;
	userId: string;
	source?: 'eval';
};

/**
 * Interaction log entry — new.md §6.1. Append-only record of every
 * user interaction (text/voice → local route or agent), used by
 * `/api/logs` for the evaluation dashboard.
 *
 * `routedTo` 取值：'local' = 播放器后端直处理；'agent' = 走 Agent。
 */
export type InteractionLog = {
	id: string;
	timestamp: string;
	userInput: string;
	inputType: 'text' | 'voice';
	intent: string;
	routedTo: 'local' | 'agent';
	toolsCalled: string[];
	result: unknown;
	userSatisfied?: boolean;
	errorTag?: string;
	cost?: number;
	latency: number;
};
