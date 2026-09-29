/**
 * 跨层架构守卫 —— 守的是「分层依赖方向」这件**类型系统表达不了**的事。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────
 * 本项目的依赖方向是单向的：`app → server → contract`，`components → contract`，
 * `agent → contract` 且 **`agent/` 不许 import `server/`**（工具一律用 HTTP 打自家
 * BFF，于是 agent 与浏览器共用同一个 API 面）。这些规则**写在文档里会被忽略**
 * —— `AGENTS.md` 自己就写着「改代码前先读」，而违反它的那次改动照样能过 tsc、
 * 过 eslint、过 398 个用例，因为**类型层面它们是合法的**。
 * 写进测试才拦得住。
 *
 * ── 三条自证纪律（这个文件里每条断言都遵守）──────────────────────
 * ① **清单只算一次**：`SOURCES` 在模块顶层算好，扫描点与「范围自证」共用它。
 *    各写一遍的后果实测过 —— 把扫描点的根收窄成 `server/`，自证照样绿，
 *    自证成了自娱自乐。
 * ② **每条规则都要有样本自证**：喂一个**已知违规**的字符串给它，认不出来就红。
 *    否则「正则写窄了」与「没有违规」长得一模一样。
 * ③ **注释里的话不算数**：扫描前先剥掉注释，别让守卫去管注释的**措辞**
 *    （实测过：代码修好之后，那行「原先写的是 …」的说明句反而成了违规）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALL_CARD_IDS, CARD_LABELS } from './components/panel-layout';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** 不参与「源码」统计的目录。`.workbuddy/` 是 IDE 工作区（记忆、备份、一次性脚本），不是产品代码。 */
const SCAN_EXCLUDES = ['node_modules', '.git', '.next*', '.workbuddy', 'data'];
/**
 * 参与「源码」统计的后缀。
 * ⚠️ 这里**必须与 include 模式列举的后缀对得上**，而且极易漏 —— 实测过一次：
 * 写成 `.ts|.tsx|.mts|.mjs` 时，一个顶层 `x.cts` 会被这条正则**直接跳过**，
 * 于是「它没被 tsc 检查」这件事永远查不出来（守卫自己也犯了它要拦的那个错）。
 * 加后缀时两处一起改：这里，与 `tsconfig.include`。
 */
const SOURCE_EXT = /\.(ts|tsx|mts|cts|mjs|cjs)$/;

function excluded(rel: string): boolean {
	return rel
		.split('/')
		.some((seg) => SCAN_EXCLUDES.some((rule) => (rule.endsWith('*') ? seg.startsWith(rule.slice(0, -1)) : seg === rule)));
}

/**
 * 全仓源码清单。⚠️ **只算一次**，下面所有断言与自证都只读它（纪律 ①）。
 * 顺序稳定（已排序），所以断言失败时的输出是可复读的。
 */
const SOURCES: string[] = (() => {
	const out: string[] = [];
	const rec = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (excluded(rel)) continue;
			if (entry.isDirectory()) rec(join(dir, entry.name), rel);
			else if (SOURCE_EXT.test(entry.name)) out.push(rel);
		}
	};
	rec(ROOT, '');
	return out.sort();
})();

function read(rel: string): string {
	return readFileSync(join(ROOT, rel), 'utf8');
}

/** 把块注释换成**等长空白**：行结构保留（行号不错位），但注释里的路径不参与匹配。 */
function stripBlockComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 整行的行注释 / JSDoc 正文行 —— 不参与匹配（但**不**剥行尾注释：那会误伤字符串里的 `//`，如 URL）。 */
function isCommentLine(line: string): boolean {
	return /^\s*(\/\/|\*)/.test(line);
}

/**
 * 剥掉**行尾**注释。判据用「`//` 前面那个字符不是 `:`」来保护 `http://` 这类写法。
 *
 * 为什么连行尾注释也要剥：不剥的话 `const x = ok(); // 别用 NextResponse`
 * 会被判成违规 —— 于是守卫开始管**注释的措辞**，代码修好之后它反而红，
 * 人就会开始绕过它。这与「注释里的 import 不算引用」是同一条纪律。
 */
function stripLineComment(line: string): string {
	return line.replace(/(^|[^:])\/\/.*$/, '$1');
}

type ImportRef = { spec: string; isTypeOnly: boolean; line: number };

/**
 * 扫出源码里每条 import / export-from 引用的模块。
 *
 * 为什么要写这个而不是一行正则：本仓**有跨行 import**（如
 * `panel-layout.test.ts` 的具名导入），单行正则会把它们整条漏掉 ——
 * 而"漏掉"与"没有违规"同形。
 * 取语句结尾的判据是「到下一个 `;`」；没有 `;` 时按 500 字符截断兜底，
 * 免得一路吃到文件末尾、把毫不相干的 `from '...'` 认成这一条。
 */
function scanImports(src: string): ImportRef[] {
	const s = stripBlockComments(src);
	const out: ImportRef[] = [];
	const re = /(^|\n)[ \t]*(import|export)\b/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		const start = m.index + m[1].length;
		const semi = s.indexOf(';', start);
		const end = semi >= 0 && semi - start <= 500 ? semi + 1 : start + 500;
		const stmt = s.slice(start, end);
		const spec =
			/from\s*['"]([^'"]+)['"]/.exec(stmt)?.[1] ?? /^\s*import\s*['"]([^'"]+)['"]/.exec(stmt)?.[1];
		if (spec) {
			out.push({
				spec,
				isTypeOnly: /^\s*(?:import|export)\s+type\b/.test(stmt),
				line: s.slice(0, start).split('\n').length,
			});
		}
		re.lastIndex = start + (stmt.length || 1);
	}
	return out;
}

/** 引用的模块是不是「某个目录下的东西」（兼容 `@/x`、`../x`、`./x`、裸 `x/` 四种写法）。 */
function refsDir(spec: string, dir: string): boolean {
	return new RegExp(`(^|/)${dir}(/|$)`).test(spec);
}

/** 从一段文本里取出全部单引号字面量。 */
function literals(text: string, re: RegExp = /'([^']+)'/g): string[] {
	return text ? [...text.matchAll(re)].map((x) => x[1]) : [];
}

/** 从一个对象字面量块里取出顶层键名（`chat: '…'` 与 `'chat': '…'` 两种写法都认）。 */
function objectKeys(block: string): string[] {
	if (!block) return [];
	const out: string[] = [];
	for (const line of block.split('\n')) {
		const m = /^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(line);
		if (m) out.push(m[1] ?? m[2]);
	}
	return out;
}

/** 末段扩展名：`x.cts` → `cts`，`x.d.ts` → `ts`，没有点 → 空串。 */
function lastExt(name: string): string {
	const i = name.lastIndexOf('.');
	return i < 0 ? '' : name.slice(i + 1);
}

/**
 * 这条 tsconfig 的 include 模式会认领这个相对路径吗。
 *
 * ⚠️ **这不是通用 glob，是照着 tsc 的实测行为校准过的。** 通用 glob 的直觉在这里
 * 会骗人：`*.ts` 按 glob 语义应该匹配顶层 `x.cts`（`*` 吃掉 `x.c`），而 tsc **不认**。
 *
 * 实测数据（本仓 TypeScript，探针 = 一个带类型错误的文件 + `tsc --noEmit` 看它报不报）：
 *
 *   | include 里有 `*.ts` | tsc 检查吗 |
 *   |---|---|
 *   | `__probe.ts`  | ✅ 报错 → 检查 |
 *   | `__probe.cts` | ❌ 静默 → **不检查** |
 *   | `__probe.mts` | ❌ 静默 → **不检查** |
 *   | `__probe.tsx` | ❌ 静默 → **不检查** |
 *
 * 即：除了 glob 本身要匹配，**文件名最后一截扩展名还必须与模式的扩展名相同**。
 * 想重新校准就跑上面那组探针，别凭直觉改这个函数。
 *
 * ⚠️ 本来更稳的做法是直接 `tsc --listFilesOnly` 问它本人，实测过：本沙箱里
 * **node 里 spawn node 一律 EBUSY**（连普通进程都不行，不只是测试上下文），所以做不到。
 * 这是本守卫唯一的"自己实现的语义"，也正因如此上面那组校准样本被钉进了用例。
 */
function includeMatches(glob: string, rel: string): boolean {
	const body = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*\//g, '\u0000')
		.replace(/\*/g, '[^/]*')
		.replace(/\u0000/g, '(?:[^/]+/)*');
	if (!new RegExp(`^${body}$`).test(rel)) return false;
	return lastExt(rel) === lastExt(glob);
}

// ── 范围自证 ──────────────────────────────────────────────────────

test('守卫范围自证：扫到的确实是全仓源码，且覆盖各家关键文件', () => {
	// 下限定得比实际低一截但足够拦住「根被收窄成某个子目录」那种失误。
	assert.ok(SOURCES.length >= 100, `扫到的源码只有 ${SOURCES.length} 个 —— 扫描范围被收窄了？`);
	for (const must of [
		'agent/tools.ts',
		'agent/run.ts',
		'app/api/agent/route.ts',
		'app/home-client.tsx',
		'cases/report.ts',
		'components/panel-layout.ts',
		'contract/types.ts',
		'scripts/cases.mts',
		'server/db.ts',
	]) {
		assert.ok(SOURCES.includes(must), `扫描范围漏了 ${must}`);
	}
	assert.ok(
		!SOURCES.some((f) => f.startsWith('.workbuddy/')),
		'不该把 .workbuddy/ 当源码扫进来（那是 IDE 工作区，不是产品代码）',
	);
	// 后缀自证：漏掉一个后缀 = 那一类文件**完全逃出本守卫**（实测漏过 `.cts`，
	// 于是"它没被 tsc 检查"这件事永远查不出来）。所以逐个喂样本。
	for (const f of ['x.ts', 'x.tsx', 'x.mts', 'x.cts', 'x.mjs', 'x.cjs']) {
		assert.ok(SOURCE_EXT.test(f), `扫描后缀没认领 ${f} —— 这类文件会完全逃出本守卫`);
	}
});

test('守卫样本自证：各种 import 写法都认得出来，注释里的路径不认', () => {
	const sample = [
		"import type { A } from '../server/db';",
		'import {',
		'  B,',
		"} from '@/server/x';",
		"import '../server/side-effect';",
		"export type { C } from '../server/c';",
		'import d from "https://esm.sh/x";',
	].join('\n');
	const refs = scanImports(sample);
	const specs = refs.map((r) => r.spec);
	for (const want of ['../server/db', '@/server/x', '../server/side-effect', '../server/c', 'https://esm.sh/x']) {
		assert.ok(specs.includes(want), `样本自证失败：没认出 ${want}（认出的是 ${specs.join(', ')}）`);
	}
	assert.equal(refs.find((r) => r.spec === '../server/db')?.isTypeOnly, true, '`import type` 没被识别');
	assert.equal(refs.find((r) => r.spec === '@/server/x')?.isTypeOnly, false, '普通 import 被误判成 type');

	// 噪声自证：注释里写什么都行，一个都不许被认出来
	assert.deepEqual(
		scanImports("// 见 server/db.ts 的说明\n/* import x from '../server/x'; */\n"),
		[],
		'注释里的 import 被当成真引用了 —— 守卫开始管注释的措辞，人会开始绕过它',
	);
});

// ── 依赖方向 ──────────────────────────────────────────────────────

/** 按目录收集违规引用。`allowTypeOnly` 为真时 `import type` 不算违规。 */
function violationsIn(dir: string, opts: { allowTypeOnly?: boolean; target: (spec: string) => boolean }) {
	const bad: string[] = [];
	for (const f of SOURCES.filter((x) => x.startsWith(`${dir}/`) && !x.endsWith('.test.ts'))) {
		for (const ref of scanImports(read(f))) {
			if (!opts.target(ref.spec)) continue;
			if (opts.allowTypeOnly && ref.isTypeOnly) continue;
			bad.push(`${f}:${ref.line}  ${ref.spec}`);
		}
	}
	return bad;
}

test('跨层：agent/ 只许用 `import type` 引 server/ —— 工具一律走 HTTP 打自家 BFF', () => {
	const bad = violationsIn('agent', { allowTypeOnly: true, target: (s) => refsDir(s, 'server') });
	assert.deepEqual(
		bad,
		[],
		`agent/ 不许在运行时 import server/（只许 import type）：\n${bad.join('\n')}\n` +
			'理由是「agent 与浏览器共用同一个 API 面」—— 一旦直连 server/，就出现了第二套入口各自漂移。',
	);
});

test('跨层：components/ 一律不许碰 server/ —— 浏览器侧只能 `import type` 引 contract/', () => {
	const bad = violationsIn('components', { target: (s) => refsDir(s, 'server') });
	assert.deepEqual(bad, [], `components/ 不许 import server/：\n${bad.join('\n')}`);
});

test('跨层：server/ 不许 import `next/server` —— 唯一例外是 server/http.ts 这个信封适配层', () => {
	const ALLOW = new Set(['server/http.ts', 'server/http.test.ts']);
	const bad: string[] = [];
	for (const f of SOURCES.filter((x) => x.startsWith('server/'))) {
		if (ALLOW.has(f)) continue;
		for (const ref of scanImports(read(f))) {
			if (ref.spec === 'next/server') bad.push(`${f}:${ref.line}  ${ref.spec}`);
		}
	}
	assert.deepEqual(bad, [], `server/ 的域逻辑不许碰 HTTP 层：\n${bad.join('\n')}`);
});

test('跨层：contract/ 零业务依赖 —— 只许引 node: 内建与同层的 `./x`', () => {
	const bad: string[] = [];
	for (const f of SOURCES.filter((x) => x.startsWith('contract/') && !x.endsWith('.test.ts'))) {
		for (const ref of scanImports(read(f))) {
			// ⚠️ 这里**不能**放行所有 `.` 开头的写法。放行的后果实测过一次：
			// `contract/__probe.ts` 里写 `import { getDb } from '../server/db'` ——
			// 它确实以 `.` 开头，于是守卫放行了，而它已经逃出了 contract/。
			// 只认同层的 `./x`（`./` 之后紧跟的字符不是 `.` 也不是 `/`）。
			if (ref.spec.startsWith('node:') || /^\.\/[^./]/.test(ref.spec)) continue;
			bad.push(`${f}:${ref.line}  ${ref.spec}`);
		}
	}
	assert.deepEqual(bad, [], `contract/ 是前后端共享契约，不许依赖任何业务层：\n${bad.join('\n')}`);
});

test('跨层：路由只「解析参数 → 调域逻辑 → 包信封」—— NextResponse 只许出现在 server/http.ts', () => {
	const routes = SOURCES.filter((f) => /^app\/api\/.*\/route\.ts$/.test(f));
	assert.ok(routes.length >= 15, `路由只扫到 ${routes.length} 条 —— 范围收窄了？`);
	const bad: string[] = [];
	for (const f of routes) {
		stripBlockComments(read(f))
			.split('\n')
			.forEach((line, i) => {
				if (isCommentLine(line)) return;
				if (/NextResponse/.test(stripLineComment(line))) bad.push(`${f}:${i + 1}  ${line.trim()}`);
			});
	}
	assert.deepEqual(bad, [], `路由不许手写信封，请用 server/http.ts 的 ok() / fail()：\n${bad.join('\n')}`);
});

// ── 跨层清单：同一份东西的多个物理副本必须集合相等 ─────────────────

test('跨层清单：卡片 id 的六处副本集合必须相等（联合类型 / 数组 / 标签表 / 提示表 / 渲染 switch / 运行时）', () => {
	const layoutSrc = read('components/panel-layout.ts');
	const menuSrc = read('components/LayoutMenu.tsx');
	const homeSrc = read('app/home-client.tsx');

	const groups: Record<string, string[]> = {
		'type CardId': literals(layoutSrc.match(/export type CardId\s*=\s*([^;]+);/)?.[1] ?? ''),
		ALL_CARD_IDS: literals(layoutSrc.match(/export const ALL_CARD_IDS[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? ''),
		CARD_LABELS: objectKeys(layoutSrc.match(/export const CARD_LABELS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? ''),
		CARD_HINTS: objectKeys(menuSrc.match(/const CARD_HINTS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? ''),
		'renderCard 的 case': literals(
			homeSrc.match(/const renderCard[\s\S]*?\n\t\};/)?.[0] ?? '',
			/case\s+'([^']+)'/g,
		),
		// 与**运行时**那份对一次，而不是从源码再抄一遍：源码里五份副本一起错的可能性是有的。
		'ALL_CARD_IDS(运行时)': [...ALL_CARD_IDS],
		'CARD_LABELS(运行时)': Object.keys(CARD_LABELS),
	};

	// 先证明每个解析器都不是"解析出空集"——空集与"没违规"长得一样。
	for (const [name, list] of Object.entries(groups)) {
		assert.ok(list.length >= 7, `解析器可能坏了：${name} 只解析出 ${list.length} 项（${JSON.stringify(list)}）`);
	}

	const base = [...groups['type CardId']].sort();
	for (const [name, list] of Object.entries(groups)) {
		assert.deepEqual(
			[...list].sort(),
			base,
			`${name} 与 CardId 集合不相等 —— 加了新卡片却只改了其中一处？\n` +
				`（renderCard 是个**没有 default 的 switch**：漏一个 case 会静默渲染成空白）`,
		);
	}
});

// ── 静态检查的盲区 ────────────────────────────────────────────────

test('守卫样本自证：include 匹配器必须复现 tsc 的实测行为', () => {
	// 这八条是**实测出来**的，不是按 glob 直觉推的（见表里那份校准记录）。
	// 谁改匹配器，谁就要让它们继续成立 —— 否则「匹配器被放宽」会把不检查的文件
	// 静默算成检查了，而那正是这条守卫唯一要拦的东西。
	assert.equal(includeMatches('*.ts', '__probe.ts'), true, '顶层 .ts 应被 *.ts 认领');
	assert.equal(includeMatches('*.ts', '__probe.cts'), false, '实测：tsc 不检查顶层 .cts');
	assert.equal(includeMatches('*.ts', '__probe.mts'), false, '实测：tsc 不检查顶层 .mts');
	assert.equal(includeMatches('*.ts', '__probe.tsx'), false, '实测：tsc 不检查顶层 .tsx');
	assert.equal(includeMatches('agent/**/*.ts', 'agent/tools.ts'), true, '双星号要匹配零层');
	assert.equal(includeMatches('agent/**/*.ts', 'agent/deep/x.ts'), true, '双星号要匹配多层');
	assert.equal(includeMatches('agent/**/*.ts', 'server/db.ts'), false, '目录不符不许放行');
	assert.equal(includeMatches('next-env.d.ts', 'next-env.d.ts'), true, '无通配的模式走精确匹配');
});

test('静态盲区：每个源码文件都得被 tsconfig.include 认领（`.mts` / `.mjs` 最容易漏）', () => {
	// tsconfig.json 带行注释，直接 JSON.parse 会炸；行注释里没有 URL，整行剥掉是安全的。
	const tsconfig = JSON.parse(read('tsconfig.json').replace(/^\s*\/\/.*$/gm, '')) as { include?: string[] };
	const include = tsconfig.include ?? [];
	// 自证：模式本身读到了。读不到会让下面的差集变成"全都漏了"，看着像全线崩。
	assert.ok(include.length >= 5, `tsconfig.include 只读到 ${include.length} 条 —— 解析坏了？`);

	const missed = SOURCES.filter((f) => !include.some((g) => includeMatches(g, f)));
	assert.deepEqual(
		missed,
		[],
		`这些源码不会被 tsc 检查（tsconfig.include 没认领）：\n${missed.join('\n')}\n` +
			'新增任何后缀（.mts / .mjs / .cts）时先确认 include 认不认它 —— 认不出时**不报错**，只是静默不检查。',
	);
});

// ── 屏蔽 / 收藏：§0 那三条红线（2026-09-28 一并进守卫）──────────────
//
// 为什么这三条必须写成断言：它们的失效方式**全都是静默的**。
//   - 漏过滤一处 → 被屏蔽的歌从那条路回来。而队列本来就长成「一批歌」，
//     多一首看不出来，日志一行没有，界面照常工作。
//   - 解封出口没了 → 用户再也拿不到那首歌的 id，只能"算了"。
// 两条都不会让任何东西变红，所以只能靠这里。
//
// 注意守卫自己的盲区：这里用的是**文本匹配**，所以它只能拦住"照着这个形状写"
// 的绕路。真正兜住「过滤点只有一处」的是 `server/library/visible.test.ts`
// （行为层面）与下面这几条（形状层面）—— 两层各管一半，别指望一层。

/** 去掉注释与空行的代码行。判「有没有这一行」时只看代码，注释里的措辞不算。 */
function codeOf(rel: string): string[] {
	return stripBlockComments(read(rel))
		.split('\n')
		.filter((l) => !isCommentLine(l) && l.trim() !== '')
		.map(stripLineComment);
}

const VISIBLE = 'server/library/visible.ts';

/**
 * 守卫**不扫自己**。
 *
 * 这不是偷懒：本文件为了写下这几条规则，正文里必然含 `hiddenIds()`、`localStorage`、
 * `favorite` 这些词 —— 扫自己就是拿"规则的描述"当"规则的违反"。⚠️ 这跟下面
 * 「谓词要带曲目上下文」是同一条教训的两个面：**文本守卫只认形状，而形状会撞车**。
 * 真要查本文件有没有违规，有 tsc 与 eslint 管着。
 */
const SELF = 'architecture.test.ts';

/**
 * 「在这判曲目屏蔽了吗」的判据。
 *
 * 三段都要有，缺一段就会误报（实测过两段版本）：
 *   ① 一个集合查询（`.has(` / `.includes(`）；
 *   ② 集合名带 hidden / blocked；
 *   ③ **同一行里有曲目上下文**（song / track / id）。
 * ③ 最容易被漏掉，而漏掉它的后果是命中 `panel-layout.ts` 的
 *   `if (!seenCards.has(c) && !hidden.includes(c))` —— 那里的 `hidden` 是
 *   **布局里被隐藏的卡片**，跟曲目屏蔽毫无关系。
 */
function judgesHidden(line: string): boolean {
	return (
		/\.has\(|\.includes\(/.test(line) &&
		/hidden|blocked/i.test(line) &&
		/song|track|\bid\b|曲目/i.test(line)
	);
}

test('红线①：屏蔽的过滤谓词只有一处 —— 别的文件不许自己判「这首被屏蔽了吗」', () => {
	// 自证一：这条规则不是空的。`visible.ts` 里**必须**有那个谓词，
	// 否则「没人写 `.has(`」既是"规则生效"也是"规则失效"，两种解读一样绿。
	const visible = codeOf(VISIBLE);
	assert.ok(
		visible.some(judgesHidden),
		`${VISIBLE} 里找不到过滤谓词 —— 要么它被挪走了（那这条守卫要跟着改），要么这条规则已经空转`,
	);

	// 自证二：**噪音样本**不能命中。命中了就是误报，而误报会逼着人放宽规则，
	// 最后规则名存实亡（与「样本自证只配正样本」是对称的两半）。
	assert.equal(
		judgesHidden('if (!seenCards.has(c) && !hidden.includes(c)) hidden.push(c);'),
		false,
		'布局里「被隐藏的卡片」不是曲目屏蔽 —— 命中它就是误报',
	);
	// 自证三：真违规必须命中。
	assert.equal(
		judgesHidden('const ok = songs.filter((s) => !hiddenIds().has(s.id));'),
		true,
		'真违规没被认出来 —— 这条规则已经拦不住它要拦的东西',
	);

	const offenders = SOURCES.filter(
		(f) => f !== VISIBLE && f !== SELF && codeOf(f).some(judgesHidden),
	);
	assert.deepEqual(
		offenders,
		[],
		`这些文件自己判了屏蔽：\n${offenders.join('\n')}\n` +
			'过滤谓词的唯一实现在 server/library/visible.ts 的 splitHidden()。' +
			'多写一处 = 曲库多一个出口没过滤，而被屏蔽的歌混在一批歌里**看不出来**。',
	);
});

test('红线①（续）：`hiddenIds()` 的调用点也只许在那几处（它产出的集合只喂给过滤点）', () => {
	const ALLOWED = ['server/library/index.ts', 'server/library/search.ts', 'server/library/flags.ts'];
	const callers = SOURCES.filter(
		(f) => f !== SELF && codeOf(f).some((l) => /hiddenIds\(\)/.test(l)),
	);
	const extra = callers.filter((f) => !ALLOWED.includes(f));
	assert.deepEqual(
		extra,
		[],
		`这些地方在调 hiddenIds()：\n${extra.join('\n')}\n` +
			`允许的只有：${ALLOWED.join(' / ')}。新增一个调用点前先问：它是不是又一个"列出曲库"的出口？`,
	);
	// 自证：白名单里的文件真的存在（写错名字会让这条规则悄悄变宽）。
	for (const f of ALLOWED) {
		assert.ok(SOURCES.includes(f), `${f} 不在 SOURCES 里 —— 白名单写错了？`);
	}
	assert.ok(
		callers.includes('server/library/index.ts'),
		'index.ts（getSongs 所在）该是 hiddenIds() 的调用方 —— 不是的话过滤点已经被挪走了',
	);
});

test('红线②：可见曲库的产出点必须过 `mergePreservingHidden()`（整批替换的唯一合并入口）', () => {
	const index = codeOf('server/library/index.ts');
	// 自证：这个文件里确实有「产出可见曲库」的那一行。
	assert.ok(
		index.some((l) => /export async function getSongs/.test(l)),
		'index.ts 里找不到 getSongs() —— 可见曲库的产出点被挪走了，这条守卫要跟着改',
	);
	assert.ok(
		index.some((l) => /mergePreservingHidden\(/.test(l)),
		'getSongs() 绕过了 mergePreservingHidden()：整批替换没过合并入口，' +
			'这次过滤就被跳过了 —— 静默的，界面上只是多一首歌。',
	);
	// 反向自证：它不能是个没人用的死函数（死函数 = 红线② 形同虚设）。
	const users = SOURCES.filter((f) => codeOf(f).some((l) => /mergePreservingHidden\(/.test(l)));
	assert.ok(
		users.length >= 2,
		`mergePreservingHidden 只有 ${users.length} 处引用（定义 + 0 个消费者？）: ${users.join(', ')}`,
	);
	assert.ok(
		codeOf(VISIBLE).some((l) => /export function mergePreservingHidden/.test(l)),
		`${VISIBLE} 该是它的唯一定义处`,
	);
});

test('红线③：解封出口不许减 —— 必须同时有「屏蔽清单的 GET」与「list_hidden 工具」', () => {
	const route = codeOf('app/api/library/hidden/route.ts');
	assert.ok(
		route.some((l) => /export async function GET/.test(l)),
		'GET /api/library/hidden 没了：被屏蔽的歌在 search_library 里已经搜不到，' +
			'这条路一断，用户就**再也拿不到它的 id**，屏蔽变成单向的。',
	);
	const tools = codeOf('agent/tools.ts');
	assert.ok(
		tools.some((l) => /list_hidden: tool\(/.test(l)),
		'list_hidden 工具没了：agent 那一侧的解封出口没了（人这一侧是上面的 GET）',
	);
	// 光"能列出来"不够 —— **必须带 id**。清单里漏 id，模型看得见却动不了它。
	assert.ok(
		codeOf('server/library/flag-rows.ts').some((l) => /trackId/.test(l)),
		'flag-rows 不带 trackId：清单就只是给人看的，模型拿不到 id 去解除',
	);
});

test('收藏 / 屏蔽不许回本机：它们是「人的偏好」，真相只在服务端', () => {
	// 自证：这条规则**不是**"不许用 localStorage"（音量 / 模式本来就该存本机），
	// 而是"不许把收藏 / 屏蔽存本机"。所以判据带一个收藏相关的词。
	const ALLOWED = ['components/flag-client.ts']; // 唯一例外：一次性迁移（读旧值并入服务端）
	const offenders = SOURCES.filter(
		(f) =>
			f !== SELF &&
			!ALLOWED.includes(f) &&
			codeOf(f).some((l) => /localStorage/.test(l) && /favorit|hidden/i.test(l)),
	);
	assert.deepEqual(
		offenders,
		[],
		`这些文件把收藏 / 屏蔽写进了 localStorage：\n${offenders.join('\n')}\n` +
			'判据（见 contract/library-flags.ts 文件头）：音量是**设备的事实**，收藏是**人的偏好**；' +
			'人的偏好不进服务端，agent 就永远是瞎的 —— 它答不了「我收藏了哪些」。',
	);
});

test('歌单：没有「整表替换」入口 —— 歌单路由不许有 PUT / PATCH', () => {
	const files = SOURCES.filter((f) => f.startsWith('app/api/playlists'));
	// 自证：找得到这批文件。找不到时下面的差集是空数组，看着像"没有违规"。
	assert.ok(files.length >= 2, `只找到 ${files.length} 个歌单路由文件 —— 扫描范围写错了？`);

	const offenders = files.filter((f) =>
		codeOf(f).some((l) => /export (async )?function (PUT|PATCH)\b/.test(l)),
	);
	assert.deepEqual(
		offenders,
		[],
		`这些路由提供了整表替换：\n${offenders.join('\n')}\n` +
			'⚠️ 调用方（尤其是模型）只看得到清单的一页，给它一个"写回这一批"的入口，' +
			'它会把自己看得见的那部分当成全部 —— 用户的歌单被悄悄换走，**两次都不报错**。' +
			'改内容一律走「追加」与「按 id 删一项」（见 contract/playlist.ts 文件头）。',
	);
});

test('歌单：删一首**只按 id**，不收位置（位置是某一份视图里的下标，会指到另一首歌）', () => {
	const src = read('agent/tools.ts');
	const at = src.indexOf('remove_from_playlist: tool(');
	assert.ok(at > 0, 'agent/tools.ts 里找不到 remove_from_playlist —— 工具被改名或删了，这条守卫要跟着改');
	// 只看 schema 那一块：描述文字里出现「第几首」是正常的（那正是在劝模型别用位置）。
	const schema = src.slice(src.indexOf('inputSchema', at), src.indexOf('execute:', at));
	assert.ok(schema.length > 0, '读不到 inputSchema');
	assert.match(schema, /trackId:/, '删歌单条目必须收 trackId');
	assert.doesNotMatch(
		schema,
		/\b(position|index|at)\s*:/,
		'schema 里出现了位置参数 —— 按下标删的那一天就是删错歌的那一天（视图一变就指到别处）',
	);
});

/* ── 曲库运维 + 分组视图（2026-09-28）──────────────────────────────
 *
 * 三条，形状各不相同，但**坏掉时全都不报错**：
 *   ① 分组维度只许有一处定义（抄一份就会漂移：工具认的与路由收的对不上）；
 *   ② 分组态必须禁用搜索（两个形状同时生效时「共 N 组」其实是「这一页里出现了 N 组」）；
 *   ③ 体检只读（清单里的 `organize` 落地成「报告」而不是「挪文件」—— 挪文件 = id 漂移
 *      = 数据迁移，而本机无回收站）。
 */

const GROUPS_CONTRACT = 'contract/library-groups.ts';

/** 「这一行自己列出了全部三个维度吗」—— 抄一份维度清单就会命中。 */
function listsAllDimensions(line: string): boolean {
	return ["'artist'", "'album'", "'tag'"].every((q) => line.includes(q));
}

test('分组维度只许有一处定义（`GROUP_BY`）—— 别处不许再抄一份清单', () => {
	// 自证①：谓词认得出已知违规样本。
	assert.ok(
		listsAllDimensions("const X = ['artist', 'album', 'tag'] as const;"),
		'谓词坏了：连"照着抄一份"都认不出来（认不出 = 与"没有违规"同形）',
	);
	// 自证②（噪音）：只列两个维度不算 —— 少了 tag 就不是同一份清单。
	assert.ok(
		!listsAllDimensions("const X = ['artist', 'album'] as const;"),
		'谓词太宽：只列两个维度也算违规的话，规则会被放宽到名存实亡',
	);

	const offenders = SOURCES.filter(
		(f) => f !== SELF && f !== GROUPS_CONTRACT && codeOf(f).some(listsAllDimensions),
	);
	assert.deepEqual(
		offenders,
		[],
		`这些文件自己列了一份分组维度：\n${offenders.join('\n')}\n` +
			'⚠️ 维度清单一旦有两份就会漂移（加维度时只改一处 → 工具收得到、路由却拒掉），' +
			'而漂移**不报错**，表现为"按某个维度分组永远返回空"。工具 schema 请直接 `z.enum(GROUP_BY)`。',
	);
});

test('分组态必须禁用搜索（不然「共 N 组」其实是「这一页里出现了 N 组」）', () => {
	const grid = 'components/LibraryGrid.tsx';
	const code = codeOf(grid).join('\n');
	assert.match(
		code,
		/disabled=\{groupBy/,
		`${grid} 的搜索框没有跟着 groupBy 禁用 —— 判据见 contract/library-groups.ts 文件头：` +
			'搜索结果是平铺的一页，分组是整库的全部分桶，两者同时生效时每个数字都在撒谎。',
	);
	assert.match(code, /<LibraryGroups/, `${grid} 没有渲染分组视图 —— 分组出口掉了`);
});

test('曲库体检是**只读**的：`server/library/` 不许动文件系统', () => {
	// 判据：改名 / 移动 = 新 id（`Song.id` 是相对路径）= `plays` 与 `track_tags` 全失联
	// （改「唯一标识」= 数据迁移），而本机无回收站、删了就真没了。
	// 所以「整理」只能落到只读报告上 —— 这条守卫管的就是"不许有人顺手把它做成真整理"。
	// ⚠️ **两种写法都要认**（§2.4「存储改道守门」那一族的老教训：
	// 只认"调用"会让 `import { renameSync } from 'node:fs'` 整个隐形 —— 而那正是
	// 「这个函数打算动文件系统」的第一个信号）。
	const WRITE_CALLS = /\b(writeFileSync|writeFile|appendFileSync|renameSync|unlinkSync|rmSync|mkdirSync|copyFileSync)\s*\(/;
	const WRITE_IMPORTS =
		/import\s*\{[^}]*\b(writeFile|writeFileSync|appendFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|mkdir|mkdirSync|copyFile|copyFileSync)\b[^}]*\}\s*from\s*['"]node:fs/;
	const WRITES = (line: string): boolean => WRITE_CALLS.test(line) || WRITE_IMPORTS.test(line);
	// 自证：两种写法的已知违规样本都认得出（认不出 = 与"没有违规"同形）。
	assert.ok(WRITES('await renameSync(a, b);'), '谓词坏了：调用写法都认不出来');
	assert.ok(
		WRITES("import { renameSync } from 'node:fs';"),
		'谓词坏了：import 写法认不出来 —— 只要把调用藏进 import 就能绕过',
	);
	// 自证（噪音）：只读的 fs 调用与 import 都不算违规。
	assert.ok(!WRITES('const e = await readdir(dir);'), '谓词太宽：readdir 不该被判成写');
	assert.ok(!WRITES("import { readdirSync } from 'node:fs';"), '谓词太宽：只读的 import 不算');

	// 单测**不算**：它们自己管临时目录（`mkdtempSync` + `rmSync` 是标准收尾），
	// 而本条守的是**产品代码**不许动曲库。把测试卷进来只会逼着人放宽规则。
	const offenders = SOURCES.filter(
		(f) =>
			f !== SELF &&
			f.startsWith('server/library/') &&
			!f.endsWith('.test.ts') &&
			codeOf(f).some(WRITES),
	);
	assert.deepEqual(
		offenders,
		[],
		`这些曲库文件在写文件系统：\n${offenders.join('\n')}\n` +
			'⚠️ 曲库的真相在文件系统上，但**改它 = 改 id = 数据迁移**。' +
			'要"整理"请产出只读报告（见 server/library/inspect.ts 文件头），动哪一处由人决定。',
	);
});

// ── 语音输入：两条回落链是**镜像**的，不许被"统一" ────────────────
//
// 为什么值得一条守卫：把 `model` 也接上回落链是**最自然的一次"顺手改动"**
// （"既然 key/base 都能回落，model 也回落一下吧"），而它坏掉时不报错 ——
// 网关只回 `No available channel for model whisper-1`，看着像网关配置坏了。
// `agent/provider.ts` 的文件头早就写着这条教训，本守卫的作用是**让代码也记住它**。

test('语音转写：`model` 两条链互不回落（对话模型 ≠ 转写模型）', () => {
	// 判据落在**两个具体文件**上，而不是「全仓谁提到了这个名字」：
	// 名字会出现在提示串里（路由的 `'…填 VOICE_MODEL…'`、冒烟的正则），
	// 那些是**说得出的那句话**，不是回落链。真正要拦的是**读环境变量时的参数**。
	const codeHas = (rel: string, name: string) => codeOf(rel).some((l) => l.includes(name));

	// 自证一：两个文件各自**确实读了自己的那个**（否则这条守卫是空转的）。
	assert.ok(codeHas('agent/voice.ts', 'VOICE_MODEL'), '谓词坏了：voice.ts 读 VOICE_MODEL 都认不出');
	assert.ok(codeHas('agent/provider.ts', 'AGENT_MODEL'), '谓词坏了：provider.ts 读 AGENT_MODEL 都认不出');
	// 自证二：谓词对**已知违规样本**命中（认不出 = 拦不住真正的漂移）。
	assert.ok(codeHas('agent/voice.ts', 'pick'), '谓词坏了：连 pick( 都认不出');

	// 正向：转写链不许碰对话模型。
	assert.ok(
		!codeHas('agent/voice.ts', 'AGENT_MODEL'),
		'agent/voice.ts 里出现了 AGENT_MODEL —— 对话模型不是转写模型，网关只会回 No available channel',
	);
	// 反向：对话链不许碰转写模型（provider.ts 的头注释早就写着这条教训）。
	// ⚠️ `VOICE_API_BASE` 不含 `VOICE_MODEL`，所以 base 的回落不会被误伤。
	assert.ok(
		!codeHas('agent/provider.ts', 'VOICE_MODEL'),
		'agent/provider.ts 里出现了 VOICE_MODEL —— 转写模型不是对话模型（注释里写着，代码别忘）',
	);
});

test('语音：录音格式清单只在 `contract/` 里 —— 前端组件不许自己抄一份 mime', () => {
	// 判据：候选表 / 后缀表都定义在 `contract/voice.ts`。组件里再写一遍字面量，
	// 两份就会漂移（一边加了 mp4、另一边没加 → **某台设备上点了麦克风什么都不会发生**）。
	// ⚠️ 只扫 `components/`：`server/player/media.ts` 里的 mime 是**曲目**的内容类型
	// （另一件事），把它卷进来只会逼着人放宽规则。
	const MIME_LITERAL = /['"]audio\/[a-z0-9.+-]+/i;
	// 自证：谓词认得出违规样本；也只认 mime 这一种形状。
	assert.ok(MIME_LITERAL.test("new MediaRecorder(s, { mimeType: 'audio/webm' })"), '谓词坏了：认不出 mime 字面量');
	assert.ok(!MIME_LITERAL.test("const ext = voiceExtFor(mime);"), '谓词太宽：普通代码不该被判成 mime 字面量');

	const offenders = SOURCES.filter(
		(f) =>
			f !== SELF &&
			f.startsWith('components/') &&
			!f.endsWith('.test.ts') &&
			codeOf(f).some((l) => MIME_LITERAL.test(l)),
	);
	assert.deepEqual(
		offenders,
		[],
		`这些组件里写死了音频 mime：\n${offenders.join('\n')}\n` +
			'请从 `contract/voice.ts` 引 `VOICE_MIME_CANDIDATES` / `VOICE_FILE_EXT`（候选表只许一处）。',
	);
});

// ── 伴生视频（2026-09-28）────────────────────────────────────────
//
// 三条，坏掉时**全都不报错**：
//   ① 视频扩展名清单被抄了第二份 → 两份漂移；表现是"某个格式配得上却送不出去"，
//      而送出去的是 `application/octet-stream`，`<video>` 静默不播；
//   ② 画面自己拥有一套播放（原生 controls / 自造 audio）→ 两路声音、两个真相，
//      听起来只是"有回声"、看起来只是"进度条与画面各说各话"；
//   ③ 视频路由在"这首歌没有伴生视频"时回落到音频 → `<video>` 拿到一段解不了的
//      字节，然后**静默不播**。那种"没有反应"比一个 404 难查得多。

/**
 * 源码里出现的「视频扩展名字面量」个数（`'.mp4'` / `".mkv"` 两种引号都认）。
 *
 * 判「这里抄了一份视频清单」用的是**整支文件**的计数而不是单行：清单写成一行数组
 * 和写成一列 `'x.mp4': 'video/mp4'` 是同一份东西的两种排版，只看单行的话后者会漏。
 */
const VIDEO_EXT_LITERAL = /['"]\.(?:mp4|m4v|webm|mkv|mov)['"]/g;

function countVideoExtLiterals(rel: string): number {
	return [...codeOf(rel).join('\n').matchAll(VIDEO_EXT_LITERAL)].length;
}

test('伴生视频：扩展名清单只有一处（`server/library/video.ts`）', () => {
	// 自证：谓词认得出「照着抄一份」的两种排版，也认不出音频扩展名。
	const asArray = "const X = ['.mp4', '.m4v', '.webm'];";
	const asTable = "const T = {\n\t'.mkv': 'video/x-matroska',\n\t'.mov': 'video/quicktime',\n};";
	assert.equal(
		[...asArray.matchAll(VIDEO_EXT_LITERAL)].length,
		3,
		'谓词坏了：数组那种排版认不出来',
	);
	assert.equal(
		[...asTable.matchAll(VIDEO_EXT_LITERAL)].length,
		2,
		'谓词坏了：一行一个键的 MIME 表认不出来（这正是最像"正经代码"的那种抄法）',
	);
	assert.equal(
		[...'const A = new Set([".mp3", ".flac"]);'.matchAll(VIDEO_EXT_LITERAL)].length,
		0,
		'谓词太宽：把音频扩展名算成视频清单了',
	);

	// 正向自证：清单的**正主**确实列了它们（否则下面那条规则可能只是扫了个空文件）。
	const VIDEO = 'server/library/video.ts';
	assert.ok(
		countVideoExtLiterals(VIDEO) >= 5,
		`${VIDEO} 里只数出 ${countVideoExtLiterals(VIDEO)} 个视频扩展名 —— 清单被挪走了？这条守卫要跟着改`,
	);

	const offenders = SOURCES.filter(
		(f) => f !== SELF && f !== VIDEO && !f.endsWith('.test.ts') && countVideoExtLiterals(f) >= 3,
	);
	assert.deepEqual(
		offenders,
		[],
		`这些文件自己列了一份视频扩展名：\n${offenders.join('\n')}\n` +
			'⚠️ 两份清单会漂移（加格式时只改一处 → 配得上却送不出去，或反过来），' +
			'而漂移**不报错**：`<video>` 只是安静地不播。扩展名请从 `server/library/video.ts` 引，' +
			'MIME 表也住在那里（`video.test.ts` 有一条双向集合相等断言钉着两者）。',
	);
});

test('伴生视频：画面不拥有播放（不给原生 controls / 必须静音 / 必须跟音频时钟）', () => {
	const VIDEO_SURFACE = 'components/TrackVideo.tsx';
	const code = codeOf(VIDEO_SURFACE).join('\n');
	// 非空自证：文件改名/被删时，下面的 doesNotMatch 会因为"扫了个空串"而全绿。
	assert.ok(code.length > 200, `${VIDEO_SURFACE} 读不出代码 —— 它被改名或删了？这条守卫要跟着改`);

	/** 「这一行让画面自己拥有了播放」。三句都是一次"两个真相"的开端。 */
	const OWNS_PLAYBACK = /\bcontrols\b|new Audio\(|<audio\b/;
	// 自证：两种写法认得出，且不误伤普通代码。
	assert.ok(OWNS_PLAYBACK.test('<video controls />'), '谓词坏了：原生 controls 认不出');
	assert.ok(OWNS_PLAYBACK.test('const a = new Audio(url);'), '谓词坏了：自造 audio 认不出');
	assert.ok(!OWNS_PLAYBACK.test('const controlled = 1;'), '谓词太宽：把变量名判成 controls 了');

	assert.match(
		code,
		/\bmuted\b/,
		`${VIDEO_SURFACE} 没有静音：两路声音会叠在一起 —— 而且不报错，听起来只是"有回声"`,
	);
	assert.match(
		code,
		/PLAYER_EVENTS\.time|currentTime/,
		`${VIDEO_SURFACE} 不再跟音频时钟：画面会自己播自己的，与进度条各说各话`,
	);
	assert.ok(
		!OWNS_PLAYBACK.test(code),
		`${VIDEO_SURFACE} 让画面自己拥有了播放（原生 controls / 自造 audio）。` +
			'声音只许来自 APlayer 的 audio，画面只是跟着它走的一个表面 —— 否则两个播放键都"生效"，然后开始各说各话。',
	);
});

test('伴生视频：没有视频就 404，不许回落到音频', () => {
	const VIDEO_ROUTE = 'app/api/library/video/route.ts';
	/** 「这一行拿的是**音频**路径」。只认 `song.filePath` —— 视频路由该拿 `song.videoPath`。 */
	const readsAudioPath = (line: string): boolean => /\.filePath\b/.test(line);
	// 自证：认得出违规样本，也不会把 `song.videoPath` 误判成音频路径。
	assert.ok(readsAudioPath('const relPath = song.filePath;'), '谓词坏了：读音频路径都认不出来');
	assert.ok(!readsAudioPath('const relPath = song.videoPath;'), '谓词太宽：`.videoPath` 被当成音频路径了');

	const lines = codeOf(VIDEO_ROUTE);
	assert.ok(lines.length > 5, `${VIDEO_ROUTE} 读不出代码 —— 被改名或删了？`);
	assert.ok(
		lines.some((l) => /song\.videoPath/.test(l)),
		`${VIDEO_ROUTE} 不再读 song.videoPath —— 那它拿什么当视频？`,
	);
	assert.ok(
		!lines.some(readsAudioPath),
		`${VIDEO_ROUTE} 里出现了 song.filePath：那是**音频**路径。` +
			'回落到音频会让 `<video>` 拿到一段它解不了的字节，然后**静默不播** —— ' +
			'那种"画面没反应"比一个 404 难查得多（404 至少说得出口）。',
	);
	assert.ok(
		lines.some((l) => /VIDEO_CONTENT_TYPES/.test(l)),
		`${VIDEO_ROUTE} 没有引 server/library/video.ts 的 MIME 表 —— 两份清单迟早会漂移`,
	);
});

// ── 守卫自己也要自证「装上了」 ────────────────────────────────────

test('守卫自证：单测的数据根改道确实装上了（不装 = 改道与生产库守卫同时失效）', () => {
	assert.equal(
		process.env.SONGLITE_TEST_SETUP_RAN,
		'1',
		'scripts/test-setup.mjs 没被 --import 装上 —— 此时改道与生产 data/ 守卫**同时**失效，' +
			'而它们失效的方式是"什么都不报"。跑测试请用 npm test。',
	);
	const override = process.env.APP_DB_PATH ?? '';
	assert.notEqual(override, '', '数据根没有被改道：APP_DB_PATH 是空的');
	assert.notEqual(
		resolve(override),
		join(ROOT, 'data', 'app.db'),
		'数据根指向了生产库 —— 测试会写进真库',
	);
});
