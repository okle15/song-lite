/**
 * AI 批量打标 —— 给曲库里的歌补上风格标签（写入时 `source: 'ai'`）。
 *
 * ── 为什么这件事是离线的脚本，而不是一个 API ────────────────────────
 * 它要跑几十秒到几分钟（每批一次 LLM 调用），不是一次用户请求能等的。
 * BLUEPRINT §3 对这类任务的既有模式就是「直接调，不经 HTTP」
 * （见「让它周一早上自己推歌单」那一行）。所以本脚本直接 import `server/` 的模块。
 *
 * ── 为什么 ID3 的 genre 完全不作依据 ──────────────────────────────
 * 本曲库实测：6 首中文流行**全部**被标成 `Blues`。照抄它等于给每首歌贴上同一个
 * 错标签，而**错标签比没有标签更糟** —— 检索会一本正经地给出错误结果，且没人会
 * 怀疑。所以 `Song` 里根本没有 genre 字段（见 `server/library/index.ts`），
 * 这里的判断完全基于模型对曲目 / 歌手的了解。
 *
 * ── 与用户标签的关系：绝不覆盖 ────────────────────────────────────
 * `setTrackTags(..., 'ai')` 遇到用户已设的行会原样保留并回 `applied: false`
 * （见 `server/library/tags.ts`）。所以这个脚本**可以随时重跑**，不会抹掉
 * 用户的主观偏好 —— 那正是优先级最高的那一层。
 *
 * ── 用法 ──────────────────────────────────────────────────────────
 *   npm run tag:library              只给「还没有标签」的歌打标
 *   npm run tag:library -- --all     重新给全部歌打标（仍不动用户标签）
 *   npm run tag:library -- --dry     只打印结果，不写库
 */
import { generateText, type LanguageModel } from 'ai';
import { getModel, readAgentConfig } from '../agent/provider';
import { normalizeTags } from '../contract/track-tags';
import { getSongs, type Song } from '../server/library';
import { listTrackTags, setTrackTags } from '../server/library/tags';

/** 每批几首：太小则调用次数多，太大则单次上下文长、一首判断错会拖累整批。 */
const BATCH_SIZE = 20;

const SYSTEM = [
	'你是曲库标签助手。给你一批曲目的元数据，为每一首给出风格标签。',
	'',
	'规则：',
	'1. 每首给 1-3 个标签，按重要程度排序。',
	'2. 标签用小写英文单词（如 pop / rock / folk / ballad / dance / instrumental），',
	'   这样检索时不受中英文写法影响。',
	'3. 依据是你对这些曲目、歌手、专辑的了解；不要依赖任何元数据字段。',
	'4. 完全无法判断时给空数组。不要猜，也不要输出 unknown 之类的占位词。',
	'',
	'只输出 JSON，不要任何解释文字：',
	'{"tags":[{"trackId":"...","tags":["pop","ballad"]}]}',
].join('\n');

/** 从模型输出里抠出 JSON 对象：容忍 ```json 围栏与前后废话。 */
function extractJson(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const body = fenced ? fenced[1] : text;
	const start = body.indexOf('{');
	const end = body.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(body.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** 调一次模型，返回 `trackId → 标签数组`。只认本批曲目里出现过的 trackId。 */
async function tagBatch(model: LanguageModel, batch: Song[]): Promise<Map<string, string[]>> {
	const payload = batch.map((s) => ({
		trackId: s.id,
		title: s.title,
		artist: s.artist,
		album: s.album,
	}));

	const { text } = await generateText({
		model,
		system: SYSTEM,
		prompt: `为这 ${payload.length} 首曲目打标：\n${JSON.stringify(payload)}\n\n只输出 JSON。`,
	});

	const parsed = extractJson(text) as { tags?: unknown } | null;
	const rows = Array.isArray(parsed?.tags) ? parsed.tags : null;
	if (!rows) {
		throw new Error(`模型没有返回可解析的 JSON，原始输出前 200 字：${text.slice(0, 200)}`);
	}

	const known = new Set(batch.map((s) => s.id));
	const out = new Map<string, string[]>();
	for (const row of rows as unknown[]) {
		if (!row || typeof row !== 'object') continue;
		const { trackId, tags } = row as { trackId?: unknown; tags?: unknown };
		if (typeof trackId !== 'string' || !known.has(trackId)) continue;
		out.set(trackId, normalizeTags(Array.isArray(tags) ? (tags as string[]) : []));
	}
	return out;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const reTagAll = argv.includes('--all');
	const dryRun = argv.includes('--dry');

	const config = readAgentConfig();
	if (!config) {
		console.error('缺少 LLM 凭证：请在 .env.local 里配置 LLM_API_KEY（见 agent/provider.ts）。');
		process.exitCode = 1;
		return;
	}

	const songs = await getSongs();
	if (songs.length === 0) {
		console.error('曲库为空 —— 检查 .env.local 的 MUSIC_DIR 是否指向真实目录。');
		process.exitCode = 1;
		return;
	}

	const existing = new Map(listTrackTags().map((t) => [t.trackId, t]));
	const userPinned = [...existing.values()].filter((t) => t.source === 'user').length;
	const pending = reTagAll ? songs : songs.filter((s) => !existing.has(s.id));

	console.log(
		`曲库 ${songs.length} 首 · 已有标签 ${existing.size} 首（其中用户设定 ${userPinned} 首）· 本次待打标 ${pending.length} 首`,
	);
	if (pending.length === 0) {
		console.log('没有待打标的曲目。加 --all 可重新打标。');
		return;
	}
	if (dryRun) console.log('（--dry：只打印，不写库）\n');

	const model = getModel(config);
	let written = 0;
	let keptUser = 0;
	let missed = 0;

	for (let i = 0; i < pending.length; i += BATCH_SIZE) {
		const batch = pending.slice(i, i + BATCH_SIZE);
		console.log(`→ 第 ${i / BATCH_SIZE + 1} 批（${batch.length} 首）请求模型…`);

		let tags: Map<string, string[]>;
		try {
			tags = await tagBatch(model, batch);
		} catch (err) {
			console.error(`  这一批失败，跳过：${err instanceof Error ? err.message : err}`);
			missed += batch.length;
			continue;
		}

		for (const song of batch) {
			const got = tags.get(song.id);
			if (!got || got.length === 0) {
				console.log(`  · ${song.title} — 模型未能判断，留空`);
				missed += 1;
				continue;
			}

			if (dryRun) {
				console.log(`  · ${song.title} → ${got.join(', ')}`);
				continue;
			}

			try {
				const result = setTrackTags(song.id, got, 'ai');
				if (result.applied) {
					written += 1;
					console.log(`  · ${song.title} → ${got.join(', ')}`);
				} else {
					keptUser += 1;
					console.log(`  · ${song.title} — 保留用户标签（${result.current.tags.join(', ')}）`);
				}
			} catch (err) {
				console.error(`  · ${song.title} — 写库失败：${err instanceof Error ? err.message : err}`);
				missed += 1;
			}
		}
	}

	if (dryRun) return;
	console.log(`\n完成：写入 ${written} · 保留用户标签 ${keptUser} · 未打上 ${missed}`);
}

void main();
