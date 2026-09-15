/**
 * 偏好存储 — BFF 侧副本，供前端 UI 直接读写。
 *
 * 权威源仍是 迁移前的 usePersistentState（在 SQLite 里，agent 每轮读取）。
 * 本模块维护一份 JSON 文件副本（data/preferences.json），让前端无需消耗
 * token 即可查看/编辑/清除偏好。
 *
 * 同步策略：agent 的 update_preferences 工具在写 持久化状态的同时，
 * 也 POST 到 /api/preferences 同步本副本。前端直接 PUT 本副本时，下一轮
 * agent 渲染仍读 BFF 的权威源——所以前端的直接编辑需通过聊天告诉 agent
 * 或在 agent 端也同步（当前版本：前端直接编辑只更新 BFF 副本，agent 下一轮
 * 调 update_preferences 时会覆盖；如需立即生效，让用户在聊天里重述偏好）。
 *
 * 简化权衡：单用户单会话场景下，双写一致性问题可接受。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** 偏好结构 — 必须与 main.ts 的 Preferences 保持一致。 */
export type Preferences = {
	favoriteGenres: string[];
	favoriteMoods: string[];
	dislikedGenres: string[];
	notes: string;
};

export const DEFAULT_PREFS: Preferences = {
	favoriteGenres: [],
	favoriteMoods: [],
	dislikedGenres: [],
	notes: '',
};

const PREFS_PATH = resolve('data/preferences.json');

/** 读取偏好。文件不存在或解析失败时返回 DEFAULT_PREFS。 */
export async function readPreferences(): Promise<Preferences> {
	try {
		const text = await readFile(PREFS_PATH, 'utf8');
		const parsed = JSON.parse(text) as Partial<Preferences>;
		return {
			favoriteGenres: Array.isArray(parsed.favoriteGenres) ? parsed.favoriteGenres : [],
			favoriteMoods: Array.isArray(parsed.favoriteMoods) ? parsed.favoriteMoods : [],
			dislikedGenres: Array.isArray(parsed.dislikedGenres) ? parsed.dislikedGenres : [],
			notes: typeof parsed.notes === 'string' ? parsed.notes : '',
		};
	} catch {
		return { ...DEFAULT_PREFS };
	}
}

/**
 * 合并写入偏好。只更新传入的字段，其他字段保留。
 * 对应 update_preferences 工具的"部分更新"语义。
 */
export async function writePreferences(patch: Partial<Preferences>): Promise<Preferences> {
	const current = await readPreferences();
	const next: Preferences = {
		favoriteGenres: patch.favoriteGenres ?? current.favoriteGenres,
		favoriteMoods: patch.favoriteMoods ?? current.favoriteMoods,
		dislikedGenres: patch.dislikedGenres ?? current.dislikedGenres,
		notes: patch.notes ?? current.notes,
	};
	await persist(next);
	return next;
}

/** 全量覆盖偏好（前端直接编辑时用）。 */
export async function replacePreferences(prefs: Preferences): Promise<Preferences> {
	await persist(prefs);
	return prefs;
}

/** 清除偏好到默认值。 */
export async function clearPreferences(): Promise<Preferences> {
	await persist({ ...DEFAULT_PREFS });
	return { ...DEFAULT_PREFS };
}

async function persist(prefs: Preferences): Promise<void> {
	await mkdir(dirname(PREFS_PATH), { recursive: true });
	await writeFile(PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf8');
}
