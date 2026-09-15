/**
 * API 冒烟测试：逐个探测 BFF 路由，判断「真能用 / 空实现 / 不可用」。
 *
 * 为什么要有这个脚本：
 *  项目没有接口层测试（`npm test` 只覆盖纯函数模块），
 *  「某接口到底能不能用」只能靠人工 curl，结论无法复现。
 *  这里把能力边界固化成可重复运行的断言。
 *
 * 用法：
 *  BASE=http://127.0.0.1:3100 node scripts/api-smoke.mjs
 *
 * 退出码：0 = 全部通过；1 = 存在 FAIL（有用的接口坏了）。
 * KNOWN_EMPTY 类接口失败只警告不阻断（它们本来就没数据）。
 *
 * ⚠️ 它只判「接口通不通 / 有没有数据」——HTTP 层的能力边界，
 *  不判「回答对不对」——效果层。两者失败含义不同。
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';

/**
 * @type {Array<{
 *   id: string, method?: string, path: string, body?: unknown,
 *   form?: boolean,
 *   expect: 'ok' | 'empty' | 'unavailable',
 *   assert?: (json: any, status: number) => string | null,
 *   note?: string,
 * }>}
 */
const CASES = [
	// ── 曲库 ──
	{ id: 'library/search', path: '/api/library/search?q=', expect: 'ok', assert: (j) => (j.data?.total > 0 ? null : '曲库为空') },
	{ id: 'library/search(关键词)', path: '/api/library/search?q=奢香', expect: 'ok', assert: (j) => (j.data?.count > 0 ? null : '搜不到已知歌曲') },
	{ id: 'library/lyrics', path: '/api/library/lyrics?trackId=track-1', expect: 'ok', assert: (j) => (j.data?.lrc ? null : '无歌词') },
	{ id: 'library/stream-video', path: '/api/library/stream-video?trackId=track-1', expect: 'empty', note: '依赖 song.mvPath，无 MV 文件则 404' },

	// ── 播放器 ──
	{ id: 'player/play', method: 'POST', path: '/api/player/play', body: { trackId: 'track-1' }, expect: 'ok' },
	{ id: 'player/pause', method: 'POST', path: '/api/player/pause', body: {}, expect: 'ok' },
	{ id: 'player/resume', method: 'POST', path: '/api/player/resume', body: {}, expect: 'ok' },
	{ id: 'player/next', method: 'POST', path: '/api/player/next', body: {}, expect: 'ok' },
	// jump 收的是队列下标 `{ index }`，不是秒数
	{ id: 'player/jump', method: 'POST', path: '/api/player/jump', body: { index: 1 }, expect: 'ok' },

	// ── 电台 ──
	{ id: 'radio/now', path: '/api/radio/now', expect: 'ok' },

	// ── 偏好 ──
	{ id: 'preferences(GET)', path: '/api/preferences', expect: 'ok' },

	// ── 语音（已知不可用） ──
	{ id: 'voice(Whisper)', method: 'POST', path: '/api/voice', form: true, expect: 'unavailable', note: 'Agnes 网关无 whisper-1 通道 → 恒 502，需前端 Web Speech API 兜底' },

	// ── 运维 ──
	{ id: 'logs', path: '/api/logs?limit=5', expect: 'ok' },
];

async function call(c) {
	const url = BASE + c.path;
	const init = { method: c.method ?? 'GET' };
	if (c.body !== undefined) {
		init.headers = { 'Content-Type': 'application/json' };
		init.body = JSON.stringify(c.body);
	}
	if (c.form) {
		const fd = new FormData();
		fd.append('audio', new Blob([Buffer.from('fake')], { type: 'audio/webm' }), 't.webm');
		init.body = fd;
		delete init.headers;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60_000);
	try {
		const res = await fetch(url, { ...init, signal: controller.signal });
		// 音频/歌词等流接口不返回 JSON——先按 content-type 分流，
		// 别让 `res.json()` 把二进制当 JSON 解析（会静默丢失真实响应体）
		const ct = res.headers.get('content-type') ?? '';
		if (!ct.includes('json')) {
			await res.text().catch(() => '');
			return { status: res.status, json: {}, isJson: false };
		}
		const json = await res.json().catch(() => ({}));
		return { status: res.status, json, isJson: true };
	} catch (e) {
		return { status: 0, json: { message: e instanceof Error ? e.message : String(e) }, isJson: false };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 信封不变式校验（server/http.ts 的契约）：**信封的 code 必须与 HTTP status 一致**。
 *
 * 为什么值得单独断言：前端多处按 `res.ok` 判成败（HistoryPanel / PreferencePanel /
 * LibraryGrid / StatsCards），agent 侧 `callBff` 也先看 `response.ok`。
 * 一旦「错误只写在 body 里、HTTP 仍是 200」，这些调用方会把失败当成功——
 * 不报错、不崩溃，只是行为悄悄错。2026-09-10 统一前实测：38 处带了 `{ status }`、
 * 17 处忘了带，同一句 `code: 400` 在同一批路由里两种行为。
 *
 * @returns {string | null} 违规描述，合规返回 null
 */
function envelopeViolation(status, json) {
	if (status === 0) return null; // 网络层失败，与信封无关
	const code = json?.code;
	if (typeof code !== 'number') return `响应缺少信封 code 字段（HTTP ${status}）`;
	if (code === 0) {
		// 成功：ok() 允许 201（创建类），只要是 2xx 都算合规
		return status >= 200 && status < 300 ? null : `code=0 但 HTTP ${status}（成功必须是 2xx）`;
	}
	return code === status ? null : `信封 code=${code} 与 HTTP ${status} 不一致`;
}

const rows = [];
let failed = 0;
let envelopeViolations = 0;

for (const c of CASES) {
	const { status, json, isJson } = await call(c);
	const code = json?.code ?? status;
	let verdict;
	let detail = '';

	// 信封不变式：只对走统一信封的 JSON 响应生效（SSE/音频流不适用）
	const envErr = c.raw || !isJson ? null : envelopeViolation(status, json);
	if (envErr) {
		envelopeViolations += 1;
		console.log(`  ⚠ 信封不变式违规 [${c.id}]：${envErr}`);
	}

	if (c.expect === 'unavailable') {
		// 期望它不可用：真的不可用 = 与已知结论一致；突然可用反而是变更，值得注意
		verdict = code !== 0 ? 'KNOWN_OFF' : 'CHANGED';
		detail = code !== 0 ? (json.message ?? '').slice(0, 70) : '突然可用了？请确认网关配置';
	} else if (c.expect === 'empty') {
		verdict = 'KNOWN_EMPTY';
		const n = json?.data?.count ?? 0;
		detail = code === 0 ? `count=${n}（无数据）` : (json.message ?? '').slice(0, 70);
	} else if (c.raw) {
		// 不走统一信封的接口：只靠 assert 判断
		const assertErr = c.assert ? c.assert(json, status) : null;
		if (assertErr) {
			verdict = 'FAIL';
			failed += 1;
			detail = assertErr;
		} else {
			verdict = 'PASS';
		}
	} else {
		const assertErr = c.assert ? c.assert(json, status) : null;
		if (code === 0 && !assertErr) {
			verdict = 'PASS';
		} else {
			verdict = 'FAIL';
			failed += 1;
			detail = assertErr ?? json.message ?? `HTTP ${status}`;
		}
	}
	rows.push({ id: c.id, verdict, code, detail, note: c.note });
}

const W = Math.max(...rows.map((r) => r.id.length));
console.log(`\nAPI 冒烟测试  BASE=${BASE}\n${'─'.repeat(78)}`);
for (const r of rows) {
	console.log(`${r.id.padEnd(W)}  ${r.verdict.padEnd(12)} ${String(r.detail).slice(0, 46)}`);
}
console.log('─'.repeat(78));

const pass = rows.filter((r) => r.verdict === 'PASS').length;
const off = rows.filter((r) => r.verdict === 'KNOWN_OFF').length;
const empty = rows.filter((r) => r.verdict === 'KNOWN_EMPTY').length;
const changed = rows.filter((r) => r.verdict === 'CHANGED').length;
console.log(`可用 ${pass} · 已知空 ${empty} · 已知不可用 ${off} · 失败 ${failed} · 状态变化 ${changed}`);
console.log(
	envelopeViolations === 0
		? '信封不变式：全部通过（code 与 HTTP status 一致）'
		: `信封不变式：${envelopeViolations} 处违规 ⚠ 见上方 ⚠ 行`,
);

console.log('\n已知能力空洞：');
for (const r of rows.filter((x) => x.note)) console.log(`  • ${r.id}：${r.note}`);

process.exit(failed > 0 ? 1 : 0);
