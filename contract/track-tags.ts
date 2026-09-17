/**
 * 曲目标签的**归一化规则** —— 唯一出处。
 *
 * 为什么单独成文件（而不是工具侧写一份、存储侧再写一份）：标签是「同一个意思可以有
 * 多种写法」的典型场景。模型会返回 `["pop folk"]` 这种**整串**、用户在对话里会说
 * 「民谣和流行」、脚本可能给出 `Pop,FOLK`。各处各自拆分的话，库里会同时存在
 * `pop folk` 与 `pop` + `folk` 三条，**检索时互相看不见，而且不报任何错**。
 *
 * 与 `contract/preference.ts` 是同一思路：规则一处落笔，工具 / 存储 / 脚本共用。
 * 后者管「什么算同一条偏好」，本文件管「什么算同一个标签」。
 */

/** 分隔符：逗号（中英）、顿号、分号、竖线、斜杠、空白 —— 模型与用户会混着写。 */
const SEPARATORS = /[,，、;；|/\s]+/;

/** 包裹用的引号与书名号，归一化时剥掉。 */
const WRAPPERS = /^["'「『《]+|["'」』》]+$/g;

/**
 * 单个标签的规范形态：剥掉包裹符 → 去首尾空白 → 小写。空串则返回 null。
 *
 * 不做同义词合并（`rock` / `摇滚`）—— 那是词表的事，属于将来的「词典层」，
 * 塞进归一化会让这里同时承担「清洗」和「理解」两件事。
 */
export function normalizeTag(raw: string): string | null {
	const trimmed = raw.trim().replace(WRAPPERS, '').trim().toLowerCase();
	return trimmed ? trimmed : null;
}

/**
 * 任意输入（字符串 / 字符串数组）拆成标签数组：去空、去重、**排序**。
 *
 * 排序是为了让「同一组标签」永远得到同一个存库字符串 —— 否则
 * `pop,folk` 与 `folk,pop` 会被当成两次不同的写入。
 */
export function normalizeTags(input: string | readonly string[] | null | undefined): string[] {
	if (!input) return [];
	const raw = Array.isArray(input) ? input : [input];
	const out = new Set<string>();
	for (const one of raw) {
		for (const part of String(one).split(SEPARATORS)) {
			const tag = normalizeTag(part);
			if (tag) out.add(tag);
		}
	}
	return [...out].sort();
}

/** 标签数组 → 存库形态（逗号分隔）。 */
export function formatTags(tags: readonly string[]): string {
	return normalizeTags(tags).join(',');
}

/**
 * 存库形态 → 标签数组。
 *
 * 直接复用 `normalizeTags`：数据库里那串也是逗号分隔的，
 * 而它本来就会按分隔符拆——**读和写因此走同一条规则**，不会漂移。
 */
export function parseTags(stored: string | null | undefined): string[] {
	return normalizeTags(stored ?? '');
}
