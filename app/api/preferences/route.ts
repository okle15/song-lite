/**
 * Preferences route — 偏好 CRUD 端点。
 *
 * - GET    /api/preferences         读取当前偏好
 * - POST   /api/preferences         合并更新（部分字段，agent 工具同步用）
 * - PUT    /api/preferences         全量覆盖（前端直接编辑用）
 * - DELETE /api/preferences         清除到默认
 *
 * 权威源是 迁移前的 usePersistentState；本路由操作 BFF 副本（data/preferences.json）。
 * agent 的 update_preferences 工具会 POST 同步到此；前端直接 PUT 编辑也写到这里。
 */
import {
	clearPreferences,
	readPreferences,
	replacePreferences,
	writePreferences,
	type Preferences,
} from '@/server/user/preferences-store';
import { ok, fail } from '@/server/http';

export async function GET() {
	const prefs = await readPreferences();
	return ok(prefs);
}

export async function POST(request: Request) {
	let body: Partial<Preferences>;
	try {
		body = (await request.json()) as Partial<Preferences>;
	} catch {
		return fail('Invalid JSON body', 400);
	}
	const merged = await writePreferences(body);
	return ok(merged);
}

export async function PUT(request: Request) {
	let body: Preferences;
	try {
		body = (await request.json()) as Preferences;
	} catch {
		return fail('Invalid JSON body', 400);
	}
	// 基本校验：数组字段必须是数组
	if (!Array.isArray(body.favoriteGenres) || !Array.isArray(body.favoriteMoods) || !Array.isArray(body.dislikedGenres)) {
		return fail('favoriteGenres/favoriteMoods/dislikedGenres must be arrays', 400);
	}
	const replaced = await replacePreferences({
		favoriteGenres: body.favoriteGenres,
		favoriteMoods: body.favoriteMoods,
		dislikedGenres: body.dislikedGenres,
		notes: typeof body.notes === 'string' ? body.notes : '',
	});
	return ok(replaced);
}

export async function DELETE() {
	const cleared = await clearPreferences();
	return ok(cleared);
}
