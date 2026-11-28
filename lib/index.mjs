import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
// src/watch-parse.ts
const ITEM_PATTERN = /^\s*[-*]\s+/;
const TABLE_PATTERN = /^\s*\|/;
const NOTE_PATTERN = /^\s*>\s?/;
const LEVEL_PATTERN = /^\[(高|中|低)\]\s*/;
const SEPARATOR_CELL = /^:?-{2,}:?$/;
const ASOF_PATTERN = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})/;
/** markdown 行内 → 片段数组。没有标记时返回单个 text 片段。 */
function parseInline(text) {
	const out = [];
	const pattern = /\*\*([^*]+)\*\*|\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s)）]+)/g;
	let last = 0;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		if (match.index > last) out.push({
			kind: "text",
			text: text.slice(last, match.index)
		});
		if (match[1] !== void 0) out.push({
			kind: "bold",
			text: match[1]
		});
		else if (match[2] !== void 0) out.push({
			kind: "link",
			text: match[2] === "" ? match[3] ?? "" : match[2],
			url: match[3] ?? ""
		});
		else if (match[4] !== void 0) out.push({
			kind: "link",
			text: match[4],
			url: match[4]
		});
		last = pattern.lastIndex;
	}
	if (last < text.length) out.push({
		kind: "text",
		text: text.slice(last)
	});
	return out.length > 0 ? out : [{
		kind: "text",
		text
	}];
}
/** 行内片段 → 纯文本（用于标签/名称/兜底展示）。 */
function plainText(inlines) {
	return inlines.map((part) => part.text).join("");
}
/** 带符号百分比 → 数字。只认 `+1.2%` / `-3.60%`，无符号（净利率 13.6%）不算。 */
function signedPercent(text) {
	const match = /([+-]\d+(?:\.\d+)?)\s*%/.exec(text);
	if (match === null) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}
/**
* 条目里的涨跌幅：只认**括号内的带符号百分比**（`（-0.31%，昨收 …）`）。
* 裸的 `相对锚 -37.8%`、`净利率 13.6%` 是估值口径/财务比率，不是当日涨跌，
* 混进涨跌统计会凭空造出一个 -37.8% 的"最大跌幅"。
*/
function quotePercent(text) {
	const match = /[（(]\s*([+-]\d+(?:\.\d+)?)\s*%/.exec(text);
	if (match === null) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}
/** 表格单元格里的涨跌幅（有「涨跌」列时允许无符号的 0.00%）。 */
function cellPercent(text) {
	const signed = signedPercent(text);
	if (signed !== null) return signed;
	const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(text.trim());
	if (match === null) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}
function splitTableRow(line) {
	const trimmed = line.trim();
	const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
	return (body.endsWith("|") ? body.slice(0, -1) : body).split("|").map((cell) => cell.trim());
}
function isSeparatorRow(cells) {
	return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL.test(cell));
}
/** 单条列表项：拆出标签、等级、涨跌幅。 */
function buildItem(raw) {
	let rest = raw;
	let level = null;
	const levelMatch = LEVEL_PATTERN.exec(rest);
	if (levelMatch !== null) {
		level = levelMatch[1];
		rest = rest.slice(levelMatch[0].length);
	}
	let label = null;
	const bold = /^\*\*([^*]+)\*\*\s*/.exec(rest);
	if (bold !== null && bold[1].trim() !== "" && bold[1].trim().length <= 12 && rest.slice(bold[0].length).trim() !== "") {
		label = bold[1].trim();
		rest = rest.slice(bold[0].length);
	} else {
		const colon = /^([^：:]{1,12})[：:]\s*/.exec(rest);
		if (colon !== null && rest.slice(colon[0].length).trim() !== "") {
			label = colon[1].trim();
			rest = rest.slice(colon[0].length);
		}
	}
	const inlines = parseInline(rest.trim());
	return {
		label,
		inlines,
		details: [],
		level,
		delta: quotePercent(plainText(inlines))
	};
}
function buildTable(lines) {
	const cells = lines.map(splitTableRow);
	const headRaw = cells[0] ?? [];
	const head = headRaw.map(parseInline);
	const deltaColumn = headRaw.findIndex((cell) => /涨跌/.test(cell));
	const bodyRows = cells.slice(1).filter((row) => !isSeparatorRow(row));
	return {
		head,
		rows: bodyRows.map((row) => row.map(parseInline)),
		names: bodyRows.map((row) => row[0] ?? ""),
		deltas: bodyRows.map((row) => {
			if (deltaColumn >= 0) {
				const value = cellPercent(row[deltaColumn] ?? "");
				if (value !== null) return value;
			}
			for (const cell of row) {
				const value = signedPercent(cell);
				if (value !== null) return value;
			}
			return null;
		})
	};
}
function splitSections(lines) {
	const out = [];
	let current = {
		title: null,
		body: []
	};
	for (const line of lines) {
		const heading = /^##+\s+(.*)$/.exec(line);
		if (heading !== null) {
			if (current.title !== null || current.body.some((row) => row.trim() !== "")) out.push(current);
			current = {
				title: heading[1].trim(),
				body: []
			};
			continue;
		}
		if (/^#\s+/.test(line)) continue;
		current.body.push(line);
	}
	if (current.title !== null || current.body.some((row) => row.trim() !== "")) out.push(current);
	return out;
}
function sectionKind(title) {
	if (/信号/.test(title)) return "signals";
	if (/变化/.test(title)) return "changes";
	return "normal";
}
/**
* 按 H1 切快照。盯盘脚本「同日重跑追加」时，一个文件里会有多份完整报告
* （每份都从 `# 标题 · 时间` 重新开始，`##` 分区编号也从「一、」重来）。
* 只呈现最后一份，否则面板上会出现三套「一、国际金价」和三倍信号。
*/
function splitSnapshots(lines) {
	const snaps = [];
	let current = null;
	for (const line of lines) {
		if (/^#\s+/.test(line)) {
			if (current !== null) snaps.push(current);
			current = {
				title: line.replace(/^#\s+/, "").trim(),
				body: []
			};
			continue;
		}
		if (current === null) current = {
			title: "",
			body: []
		};
		current.body.push(line);
	}
	if (current !== null) snaps.push(current);
	return snaps.filter((snap) => snap.title !== "" || snap.body.some((line) => line.trim() !== ""));
}
function buildBlocks(body) {
	const blocks = [];
	let items = [];
	let table = [];
	let paragraph = [];
	let note = [];
	const flushItems = () => {
		if (items.length > 0) {
			blocks.push({
				kind: "items",
				items
			});
			items = [];
		}
	};
	const flushTable = () => {
		if (table.length > 0) {
			blocks.push({
				kind: "table",
				table: buildTable(table)
			});
			table = [];
		}
	};
	const flushParagraph = () => {
		if (paragraph.length > 0) {
			blocks.push({
				kind: "paragraph",
				inlines: parseInline(paragraph.join(" "))
			});
			paragraph = [];
		}
	};
	const flushNote = () => {
		if (note.length > 0) {
			blocks.push({
				kind: "note",
				inlines: parseInline(note.join(" "))
			});
			note = [];
		}
	};
	const flushAll = () => {
		flushItems();
		flushTable();
		flushParagraph();
		flushNote();
	};
	for (const raw of body) {
		const line = raw.trimEnd();
		if (line.trim() === "") {
			flushAll();
			continue;
		}
		if (TABLE_PATTERN.test(line)) {
			flushItems();
			flushParagraph();
			flushNote();
			table.push(line);
			continue;
		}
		flushTable();
		if (NOTE_PATTERN.test(line)) {
			flushItems();
			flushParagraph();
			note.push(line.replace(NOTE_PATTERN, ""));
			continue;
		}
		flushNote();
		if (ITEM_PATTERN.test(line)) {
			flushParagraph();
			items.push(buildItem(line.replace(ITEM_PATTERN, "")));
			continue;
		}
		if (/^\s{2,}\S/.test(raw) && items.length > 0) {
			items[items.length - 1].details.push(parseInline(line.trim()));
			continue;
		}
		flushItems();
		paragraph.push(line.trim());
	}
	flushAll();
	return blocks;
}
function noteText(block) {
	return block.kind === "note" ? plainText(block.inlines ?? []) : "";
}
/** 解析一份盯盘报告。任何字段缺失都返回 null / 空数组，不抛异常。 */
function parseReport(text) {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const snapshots = splitSnapshots(lines);
	const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : {
		title: "",
		body: lines
	};
	const title = latest.title;
	const line = title.split("·")[0]?.trim() ?? title;
	const titleStamp = ASOF_PATTERN.exec(title)?.[1]?.replace("T", " ") ?? null;
	const sections = splitSections(latest.body).map(({ title: heading, body }) => ({
		title: heading ?? "",
		kind: heading === null ? "normal" : sectionKind(heading),
		blocks: buildBlocks(body)
	})).filter((section) => section.title !== "" || section.blocks.length > 0);
	const footer = [];
	for (const section of sections) {
		const kept = [];
		for (const block of section.blocks) {
			const noteBody = noteText(block);
			if (noteBody !== "" && /(生成时间|数据源)/.test(noteBody)) footer.push(...block.inlines ?? []);
			else kept.push(block);
		}
		section.blocks = kept;
	}
	const footerText = footer.map((part) => part.text).join(" ");
	const asOf = titleStamp ?? ASOF_PATTERN.exec(footerText)?.[1]?.replace("T", " ") ?? null;
	const signals = sections.filter((section) => section.kind === "signals").reduce((sum, section) => sum + section.blocks.filter((block) => block.kind === "items").flatMap((block) => block.items ?? []).filter((item) => plainText(item.inlines).trim() !== "" || item.details.length > 0).length, 0);
	const changes = sections.filter((section) => section.kind === "changes").reduce((sum, section) => sum + section.blocks.filter((block) => block.kind === "items").flatMap((block) => block.items ?? []).map((item) => plainText(item.inlines).split("；").filter((part) => part.trim() !== "").length).reduce((inner, value) => inner + value, 0), 0);
	const movers = [];
	let tableCount = 0;
	for (const section of sections) for (const block of section.blocks) {
		if (block.kind === "table" && block.table !== void 0) {
			tableCount += 1;
			const current = block.table;
			current.deltas.forEach((delta, index) => {
				const name = current.names[index]?.trim() ?? "";
				if (delta !== null && name !== "") movers.push({
					name,
					delta
				});
			});
		}
		if (block.kind === "items") for (const item of block.items ?? []) {
			if (item.delta === null) continue;
			const name = item.label ?? plainText(item.inlines).slice(0, 12);
			if (name !== "") movers.push({
				name,
				delta: item.delta
			});
		}
	}
	const up = movers.filter((row) => row.delta > 0).length;
	const down = movers.filter((row) => row.delta < 0).length;
	const flat = movers.length - up - down;
	const worst = movers.reduce((acc, row) => acc === null || row.delta < acc.delta ? row : acc, null);
	const best = movers.reduce((acc, row) => acc === null || row.delta > acc.delta ? row : acc, null);
	return {
		title,
		line,
		asOf,
		sections,
		footer,
		summary: {
			up,
			down,
			flat,
			worst: worst !== null && worst.delta < 0 ? worst : null,
			best: best !== null && best.delta > 0 ? best : null,
			signals,
			changes,
			tables: tableCount
		},
		movers,
		snapshots: Math.max(snapshots.length, 1)
	};
}
/** 单个「信号」分区里的条目（带上级别），供分区自己渲染，不跨分区重复。 */
function sectionSignals(section) {
	const out = [];
	if (section.kind !== "signals") return out;
	for (const block of section.blocks) {
		for (const item of block.items ?? []) {
			const text = plainText(item.inlines).trim();
			if (text !== "") out.push({
				level: item.level,
				text
			});
		}
		const note = block.kind === "note" ? plainText(block.inlines ?? []).trim() : "";
		if (note !== "") out.push({
			level: null,
			text: note
		});
	}
	return out;
}
/** 单个「较上次变化」分区的 name/value 行，供分区自己渲染。 */
function sectionChanges(section) {
	const out = [];
	if (section.kind !== "changes") return out;
	for (const block of section.blocks) for (const item of block.items ?? []) for (const part of plainText(item.inlines).split("；")) {
		const text = part.trim();
		if (text === "") continue;
		const match = /^(.+?)\s+([+-]?[\d,.]+%?)$/.exec(text);
		if (match !== null) out.push({
			name: match[1].trim(),
			value: match[2]
		});
		else out.push({
			name: text,
			value: ""
		});
	}
	return out;
}
/** 信号分区 → 扁平信号列表（等级 + 文本），无信号返回空数组。 */
function reportSignals(report) {
	return report.sections.flatMap((section) => sectionSignals(section));
}
/** 「较上次变化」条目 → [{name, value}]，没有就空数组。 */
function reportChanges(report) {
	return report.sections.flatMap((section) => sectionChanges(section));
}
// src/watch-root.ts
/**
* 「盯盘报告到底读哪个工作区」——这里是唯一判定点。
*
* 旧逻辑取 workspace 登记表里**最近更新**的工作区，结果经常落到
* `C:\Users\Administrator\.dsh\bots\workspace` 这类空目录上：报告面板要么空列表，
* 要么看着别的目录。现在的顺序是：
*
*   1. 显式配置（DSH_TRADING_WATCH_ROOT / DSH_TRADING_FILES_ROOT）——用户说了算；
*   2. 登记表里**确实有 reports/watch 且报告最新**的工作区——真在产出盯盘报告的那个；
*   3. 登记表里最近更新的工作区（旧行为，兜底）；
*   4. 进程 cwd（没有登记表时）。
*
* 判定依赖 fs，但全部通过 probe 注入，node 测试可以伪造登记表与目录。
*/
const WATCH_REL = "reports/watch";
const REPORTS_REL = "reports";
function parseRegistry(text) {
	if (text === null) return [];
	try {
		const parsed = JSON.parse(text);
		return Object.values(parsed.tables?.workspaces ?? {}).filter((row) => typeof row?.path === "string" && row.path !== "");
	} catch {
		return [];
	}
}
/** 显式指定的根目录：空字符串视为没配（否则 `??` 会让 '' 挡住后面的回退），相对路径按宿主 cwd 解析。 */
function explicitRoot(probe) {
	for (const raw of [probe.env.DSH_TRADING_WATCH_ROOT, probe.env.DSH_TRADING_FILES_ROOT]) {
		const value = typeof raw === "string" ? raw.trim() : "";
		if (value !== "") return path.resolve(value);
	}
	return null;
}
/** 判定工作区根。纯函数，无副作用。 */
function pickWatchRoot(probe) {
	const explicit = explicitRoot(probe);
	if (explicit !== null) return {
		root: explicit,
		source: "config"
	};
	const bound = typeof probe.bound === "string" ? probe.bound.trim() : "";
	if (bound !== "") return {
		root: path.resolve(bound),
		source: "bound"
	};
	const rows = parseRegistry(probe.readText(path.join(probe.home, "storages", "workspace.json")));
	const seen = /* @__PURE__ */ new Set();
	const paths = [];
	for (const row of rows) {
		if (row.path === void 0) continue;
		const key = row.path.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		paths.push(row.path);
	}
	let bestPath = null;
	let bestMtime = 0;
	for (const candidate of paths) {
		const watchMtime = probe.newestReportMtime(path.join(candidate, WATCH_REL));
		const mtime = watchMtime > 0 ? watchMtime : probe.newestReportMtime(path.join(candidate, REPORTS_REL));
		if (mtime > bestMtime) {
			bestMtime = mtime;
			bestPath = candidate;
		}
	}
	if (bestPath !== null) return {
		root: bestPath,
		source: "watch-reports"
	};
	const recent = [...rows].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0]?.path;
	if (recent !== void 0 && recent !== "") return {
		root: recent,
		source: "recent-workspace"
	};
	return {
		root: probe.cwd,
		source: "cwd"
	};
}
/** 报告目录绝对路径：优先 reports/watch，没有就退 reports。 */
function reportsDir(root, probe) {
	const watch = path.join(root, WATCH_REL);
	if (probe.newestReportMtime(watch) > 0) return watch;
	return path.join(root, REPORTS_REL);
}
/** 真实 fs 探测。每次调用都重新读登记表/目录，不缓存（报告目录会随时间出现）。 */
function nodeProbe() {
	return {
		env: process.env,
		home: process.env.DSH_HOME ?? path.join(homedir(), ".dsh"),
		cwd: process.cwd(),
		readText(file) {
			try {
				return readFileSync(file, "utf8");
			} catch {
				return null;
			}
		},
		newestReportMtime(dir) {
			try {
				let newest = 0;
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
					try {
						const info = statSync(path.join(dir, entry.name));
						if (info.mtimeMs > newest) newest = info.mtimeMs;
					} catch {}
				}
				return newest;
			} catch {
				return 0;
			}
		}
	};
}
// src/index.ts
/**
* dsh-trading-panel host half.
*
* 除本包的浏览器半（React 视图）外，这里只补一件宿主侧能力：`/dshtrading-panel/api/files`
* —— 文件面板的目录列举与文本预览。上游把「文件」页签挂在宿主 sidebar-right dock 上，
* 而 main 面板模式没有那座 dock；面板化后由本路由补上等价能力（root 可指向工作区）。
*
* 交易数据面（/dshtrading/api、SSE、定时任务）仍由 @dshtrading/bot-api 提供，
* 连接器与账本由 @dshtrading/{base,cn,us,hk,crypto,futures,global} 提供。
*/
const name = "dsh-trading-panel";
const MOUNT = "/dshtrading-panel/api/files";
const TEXT_LIMIT = 524288;
const SKIP = /* @__PURE__ */ new Set([
	".git",
	"node_modules",
	"__pycache__",
	".venv"
]);
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(payload);
}
/**
* 工作区根判定：逻辑在 src/watch-root.ts（显式配置 → 真有最新盯盘报告的工作区 →
* 登记表最近更新 → cwd）。这里只做带 TTL 的缓存：报告目录会随时间出现（新跑一次
* 盯盘脚本），永久缓存会把面板钉在启动瞬间的空目录上。
*/
const ROOT_TTL_MS = 6e4;
let cachedRoot = null;
function rootInfo() {
	const now = Date.now();
	if (cachedRoot === null || now - cachedRoot.at > ROOT_TTL_MS) cachedRoot = {
		at: now,
		value: pickWatchRoot({
			...nodeProbe(),
			bound: readBound()
		})
	};
	return cachedRoot.value;
}
/**
* 面板上「绑定工作区」的落盘位置：`$DSH_HOME/dsh-trading-panel/settings.json`。
* 绑定优先于自动探测（仅次于环境变量），换台机器/换个人装插件时各自维护自己的。
*/
const SETTINGS_DIR = path.join(process.env.DSH_HOME ?? path.join(homedir(), ".dsh"), "dsh-trading-panel");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");
function readBound() {
	try {
		const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
		const value = typeof raw.watchRoot === "string" ? raw.watchRoot.trim() : "";
		return value === "" ? null : value;
	} catch {
		return null;
	}
}
function writeBound(value) {
	mkdirSync(SETTINGS_DIR, { recursive: true });
	writeFileSync(SETTINGS_FILE, JSON.stringify({ watchRoot: value }, null, 2), "utf8");
	cachedRoot = null;
}
/** 列登记表里的工作区，并标出各自有多少份盯盘报告（绑定选择器用）。 */
function listWorkspaces() {
	const probe = nodeProbe();
	const text = probe.readText(path.join(probe.home, "storages", "workspace.json"));
	let rows = [];
	if (text !== null) try {
		const parsed = JSON.parse(text);
		rows = Object.values(parsed.tables?.workspaces ?? {});
	} catch {
		rows = [];
	}
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const row of rows) {
		const dir = typeof row.path === "string" ? row.path.trim() : "";
		if (dir === "") continue;
		const key = dir.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		let reports = 0;
		let latest = 0;
		for (const rel of ["reports/watch", "reports"]) {
			let names = [];
			try {
				names = readdirSync(path.join(dir, rel)).filter((n) => n.toLowerCase().endsWith(".md"));
			} catch {
				continue;
			}
			if (names.length === 0) continue;
			reports = names.length;
			for (const n of names) try {
				const m = statSync(path.join(dir, rel, n)).mtimeMs;
				if (m > latest) latest = m;
			} catch {}
			break;
		}
		out.push({
			path: dir,
			name: path.basename(dir) || dir,
			reports,
			latest,
			updatedAt: row.updatedAt ?? null
		});
	}
	out.sort((a, b) => b.latest - a.latest || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
	return out;
}
/** POST 的 JSON body：绑定请求体很小，超过 4KB 直接截断。 */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk;
		size += buf.length;
		if (size > 4096) break;
		chunks.push(buf);
	}
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed !== null && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
function root() {
	return rootInfo().root;
}
/** 相对路径归一：拒绝绝对路径与 `..` 越界，返回 root 内的绝对路径。 */
function insideRoot(rel) {
	const base = path.resolve(root());
	const target = path.resolve(base, rel === "" ? "." : rel);
	const normalizedBase = base.toLowerCase().endsWith(path.sep) ? base.toLowerCase() : base.toLowerCase() + path.sep;
	if (target.toLowerCase() !== base.toLowerCase() && !target.toLowerCase().startsWith(normalizedBase)) return null;
	return target;
}
async function listDir(rel) {
	const target = insideRoot(rel);
	if (target === null) return {
		ok: false,
		code: "FILES_OUT_OF_ROOT",
		message: "path escapes workspace root"
	};
	if (!(await stat(target)).isDirectory()) return {
		ok: false,
		code: "FILES_NOT_A_DIRECTORY",
		message: "not a directory"
	};
	const dirents = await readdir(target, { withFileTypes: true });
	const entries = await Promise.all(dirents.filter((d) => !SKIP.has(d.name)).map(async (d) => {
		const full = path.join(target, d.name);
		let size = 0;
		let mtime = 0;
		try {
			const s = await stat(full);
			size = s.size;
			mtime = s.mtimeMs;
		} catch {}
		return {
			name: d.name,
			dir: d.isDirectory(),
			size,
			mtime
		};
	}));
	entries.sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1);
	const relNormalized = path.relative(path.resolve(root()), target).split(path.sep).join("/");
	const parent = relNormalized === "" ? null : relNormalized.includes("/") ? relNormalized.slice(0, relNormalized.lastIndexOf("/")) : "";
	return {
		ok: true,
		root: root(),
		path: relNormalized,
		parent,
		entries
	};
}
function reportMeta(text) {
	const report = parseReport(text);
	const { up, down, worst, signals } = report.summary;
	return {
		line: report.line,
		asOf: report.asOf,
		signals,
		up,
		down,
		worst
	};
}
/**
* 近期盯盘报告：扫 `<workspace>/reports/watch/*.md`（没有就退 `reports/*.md`），
* 按修改时间倒序，每行带上报告摘要（线名/时间/信号数/涨跌家数/最大跌幅）。
* 摘要读不到只影响那一行，不影响列表本身。
*/
async function listReports(limit) {
	const base = path.resolve(root());
	for (const rel of ["reports/watch", "reports"]) {
		const dir = path.join(base, rel);
		if (!existsSync(dir)) continue;
		const dirents = await readdir(dir, { withFileTypes: true });
		const rows = await Promise.all(dirents.filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md")).map(async (d) => {
			const full = path.join(dir, d.name);
			let size = 0;
			let mtime = 0;
			try {
				const st = await stat(full);
				size = st.size;
				mtime = st.mtimeMs;
			} catch {}
			let meta = null;
			try {
				meta = reportMeta((await readFile(full)).toString("utf8"));
			} catch {}
			return {
				name: d.name,
				path: `${rel}/${d.name}`,
				size,
				mtime,
				meta
			};
		}));
		rows.sort((a, b) => b.mtime - a.mtime);
		if (rows.length === 0) continue;
		return {
			ok: true,
			root: base,
			source: rootInfo().source,
			dir: rel,
			entries: rows.slice(0, Math.max(1, Math.min(limit, 50)))
		};
	}
	return {
		ok: true,
		root: base,
		source: rootInfo().source,
		dir: null,
		entries: []
	};
}
/**
* 单份报告：结构化解析结果 + 信号/变化条目。浏览器半只渲染这些块，不再拼字符串；
* 原文另走 /read（同一路径），「看原文」按钮用。
*/
async function readReport(rel) {
	const target = insideRoot(rel);
	if (target === null) return {
		ok: false,
		code: "FILES_OUT_OF_ROOT",
		message: "path escapes workspace root"
	};
	const info = await stat(target);
	if (info.isDirectory()) return {
		ok: false,
		code: "FILES_IS_DIRECTORY",
		message: "is a directory"
	};
	if (info.size > TEXT_LIMIT) return {
		ok: false,
		code: "FILES_TOO_LARGE",
		message: `file larger than ${TEXT_LIMIT} bytes`,
		size: info.size
	};
	const report = parseReport((await readFile(target)).toString("utf8"));
	return {
		ok: true,
		root: rootInfo().root,
		source: rootInfo().source,
		path: rel,
		size: info.size,
		mtime: info.mtimeMs,
		report,
		signals: reportSignals(report),
		changes: reportChanges(report)
	};
}
async function readText(rel) {
	const target = insideRoot(rel);
	if (target === null) return {
		ok: false,
		code: "FILES_OUT_OF_ROOT",
		message: "path escapes workspace root"
	};
	const info = await stat(target);
	if (info.isDirectory()) return {
		ok: false,
		code: "FILES_IS_DIRECTORY",
		message: "is a directory"
	};
	if (info.size > TEXT_LIMIT) return {
		ok: false,
		code: "FILES_TOO_LARGE",
		message: `file larger than ${TEXT_LIMIT} bytes`,
		size: info.size
	};
	const buffer = await readFile(target);
	if (buffer.includes(0)) return {
		ok: false,
		code: "FILES_BINARY",
		message: "binary file",
		size: info.size
	};
	return {
		ok: true,
		path: rel,
		size: info.size,
		text: buffer.toString("utf8")
	};
}
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/;
/** 代理地址：显式 DSH_TRADING_PROXY 优先，其次环境里的 HTTPS_PROXY，最后猜常见的本地混合端口。 */
function pickProxy() {
	const explicit = process.env.DSHTRADING_PROXY;
	if (explicit !== void 0 && explicit !== "") return explicit;
	const env = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
	if (env !== void 0 && env !== "") return env;
	return "http://127.0.0.1:12450";
}
/** 只做一次 TCP 探活：代理没开就不改动全局 fetch，避免把内网请求也带进代理。 */
async function proxyAlive(proxy, timeoutMs = 1500) {
	const net = await import("node:net");
	const target = new URL(proxy);
	const host = target.hostname === "" ? "127.0.0.1" : target.hostname;
	const port = Number(target.port === "" ? "80" : target.port);
	return await new Promise((resolve) => {
		const socket = net.connect({
			host,
			port
		});
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(`timeout ${timeoutMs}ms`));
		socket.once("error", (error) => finish(String(error.code ?? error.message)));
	});
}
/**
* 上游行情出口：Yahoo 等海外数据源在国内直连会被 403/RST（`Yahoo chart AAPL: HTTP 403 Forbidden`）。
* 探测到本机代理可用时，只把**外网** fetch 交给它；127.0.0.1 / localhost 仍是直连，
* 否则插件自己的 /dshtrading/api 会绕进代理。探测失败则完全不动，保持原行为。
*/
function proxyDiag(line) {
	try {
		writeFileSync(path.join(process.env.DSH_HOME ?? path.join(homedir(), ".dsh"), "dsh-trading-panel-proxy.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}\n`, { flag: "a" });
	} catch {}
}
async function installProxyFetch() {
	const proxy = pickProxy();
	const probe = proxy === void 0 ? "no-proxy" : await proxyAlive(proxy);
	proxyDiag(`pick=${String(proxy)} probe=${String(probe)} fetch=${typeof globalThis.fetch}`);
	if (proxy === void 0 || probe !== true) return;
	try {
		const undici = await import("undici");
		const agent = new undici.ProxyAgent(proxy);
		const original = globalThis.fetch;
		globalThis.fetch = ((input, init) => {
			const passthrough = () => original(input, init);
			if (!(typeof input === "string" || input instanceof URL)) return passthrough();
			const raw = typeof input === "string" ? input : input.href;
			let host;
			try {
				host = new URL(raw).hostname;
			} catch {
				return passthrough();
			}
			if (LOOPBACK.test(host)) return passthrough();
			return undici.fetch(raw, {
				...init,
				dispatcher: agent
			});
		});
		proxyDiag(`installed agent for ${proxy}`);
		console.log(`[dsh-trading-panel] 外网行情经代理 ${proxy}`);
	} catch (error) {
		proxyDiag(`failed: ${error instanceof Error ? error.message : String(error)}`);
		console.log("[dsh-trading-panel] 代理引导跳过：", error instanceof Error ? error.message : String(error));
	}
}
function apply(ctx) {
	installProxyFetch();
	ctx.inject(["webServer", "connection"], (sub) => {
		const webServer = sub.get("webServer");
		const connection = sub.get("connection");
		if (webServer === void 0 || connection === void 0) return;
		const handler = async (req, res) => {
			const rejection = connection.requestRejection(req);
			if (rejection !== void 0) {
				res.writeHead(rejection);
				res.end(rejection === 401 ? "unauthorized" : "forbidden");
				return;
			}
			const url = new URL(req.url ?? "/", "http://dsh.local");
			const sub2 = url.pathname.startsWith(MOUNT) ? url.pathname.slice(27) || "/" : url.pathname;
			try {
				if (req.method === "GET" && sub2 === "/list") {
					sendJson(res, 200, await listDir(url.searchParams.get("path") ?? ""));
					return;
				}
				if (req.method === "GET" && sub2 === "/read") {
					sendJson(res, 200, await readText(url.searchParams.get("path") ?? ""));
					return;
				}
				if (req.method === "GET" && sub2 === "/reports") {
					const limit = Number(url.searchParams.get("limit") ?? "8");
					sendJson(res, 200, await listReports(Number.isFinite(limit) ? limit : 8));
					return;
				}
				if (req.method === "GET" && (sub2 === "/watch/report" || sub2 === "/report")) {
					sendJson(res, 200, await readReport(url.searchParams.get("path") ?? ""));
					return;
				}
				if (req.method === "GET" && sub2 === "/watch/reports") {
					const aliasLimit = Number(url.searchParams.get("limit") ?? "20");
					sendJson(res, 200, await listReports(Number.isFinite(aliasLimit) ? aliasLimit : 20));
					return;
				}
				if (req.method === "GET" && sub2 === "/workspaces") {
					sendJson(res, 200, {
						ok: true,
						root: rootInfo().root,
						source: rootInfo().source,
						bound: readBound(),
						workspaces: listWorkspaces()
					});
					return;
				}
				if (req.method === "POST" && sub2 === "/bind") {
					const body = await readJsonBody(req);
					const raw = typeof body.path === "string" ? body.path.trim() : "";
					if (raw === "") {
						sendJson(res, 400, {
							ok: false,
							code: "BIND_EMPTY",
							message: "path is required"
						});
						return;
					}
					const target = path.resolve(raw);
					if (!existsSync(target) || !statSync(target).isDirectory()) {
						sendJson(res, 400, {
							ok: false,
							code: "BIND_NOT_A_DIRECTORY",
							message: `not a directory: ${target}`
						});
						return;
					}
					writeBound(target);
					sendJson(res, 200, {
						ok: true,
						...rootInfo(),
						bound: target
					});
					return;
				}
				if (req.method === "POST" && sub2 === "/unbind") {
					writeBound(null);
					sendJson(res, 200, {
						ok: true,
						...rootInfo(),
						bound: null
					});
					return;
				}
				if (req.method === "GET" && sub2 === "/root") {
					sendJson(res, 200, {
						ok: true,
						...rootInfo()
					});
					return;
				}
				sendJson(res, 404, {
					ok: false,
					code: "FILES_ROUTE_NOT_FOUND",
					message: `unknown route: ${sub2}`
				});
			} catch (error) {
				const code = error instanceof Error ? error.code ?? "FILES_ERROR" : "FILES_ERROR";
				sendJson(res, code === "ENOENT" ? 404 : 400, {
					ok: false,
					code,
					message: error instanceof Error ? error.message : String(error)
				});
			}
		};
		ctx.effect(() => webServer.register({
			kind: "prefix",
			path: MOUNT,
			handler
		}), "dsh-trading-panel: /dshtrading-panel/api/files route");
	});
}
export { apply, name, nodeProbe, parseInline, parseReport, pickWatchRoot, plainText, reportChanges, reportSignals, reportsDir };
