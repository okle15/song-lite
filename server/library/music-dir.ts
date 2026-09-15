/**
 * 音乐库目录解析 — 方案 C 共享工具。
 *
 * 从 `MUSIC_DIR` 环境变量读取音乐库根目录。未配置时返回 null，
 * 调用方（scanner / stream）据此 fallback 到 mock 数据或返回 503。
 */
import { resolve } from 'node:path';

/**
 * 解析音乐库根目录。返回绝对路径或 null（未配置）。
 * scanner 和 stream 路由共用此函数，确保读到同一份文件。
 */
export function resolveMusicDir(): string | null {
	if (process.env.MUSIC_DIR) {
		return resolve(process.env.MUSIC_DIR);
	}
	return null;
}
