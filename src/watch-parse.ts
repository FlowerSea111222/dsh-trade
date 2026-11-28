/**
 * 盯盘报告解析（宿主半，纯函数，无 node 依赖）。
 *
 * 数据来源只有一个：经济工作区里盯盘脚本已经写好的 `reports/watch/*.md`
 * （gold-watch.py / bbw-watch.py 的产物）。这里只做「读」——把 markdown 拆成
 * 结构化块交给浏览器半渲染，**不推断、不补数**：没解析出来的字段就是 null，
 * UI 据此显示原始文本，绝不编造一个数字。
 *
 * 为什么放在宿主半：解析只有一处实现，能直接用 node 脚本对真实报告做断言；
 * 浏览器半只负责画，不再碰字符串拼接。
 */

/** 行内片段：普通文本 / 加粗 / 链接（`**x**`、`[a](b)`、裸 URL 已消解）。 */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'link'; text: string; url: string }

export type SignalLevel = '高' | '中' | '低'

export interface ReportItem {
  /** 冒号/加粗前缀提炼出的标签（≤12 字），没有就是 null。 */
  label: string | null
  /** 主体内容（已去标签）。 */
  inlines: Inline[]
  /** 条目后面的缩进续行（公告链接等）。 */
  details: Inline[][]
  /** 信号等级（仅 `[高] …` 这类行）。 */
  level: SignalLevel | null
  /** 带符号的涨跌幅（只在能确定是涨跌幅时给出）。 */
  delta: number | null
}

export interface ReportTable {
  /** 表头（行内片段）。 */
  head: Inline[][]
  /** 数据行，每格是行内片段。 */
  rows: Inline[][][]
  /** 每行第一格纯文本，用于配对涨跌幅。 */
  names: string[]
  /** 每行涨跌幅（按「涨跌」列或该行唯一的带符号百分比取值）。 */
  deltas: (number | null)[]
}

export interface ReportBlock {
  kind: 'items' | 'table' | 'note' | 'paragraph'
  items?: ReportItem[]
  table?: ReportTable
  inlines?: Inline[]
}

export type SectionKind = 'signals' | 'changes' | 'normal'

export interface ReportSection {
  title: string
  kind: SectionKind
  blocks: ReportBlock[]
}

export interface ReportSummary {
  up: number
  down: number
  flat: number
  worst: { name: string; delta: number } | null
  best: { name: string; delta: number } | null
  signals: number
  changes: number
  tables: number
}

export interface ParsedReport {
  /** H1 原文（同一天多次追加时，取最后一份快照的 H1）。 */
  title: string
  /** 盯盘线名（H1 里 `·` 之前那段）。 */
  line: string
  /** 数据时间 `YYYY-MM-DD HH:mm`，取标题或页脚「生成时间」。 */
  asOf: string | null
  sections: ReportSection[]
  /** 页脚（生成时间 / 数据源说明）。 */
  footer: Inline[]
  summary: ReportSummary
  /** 条目里的涨跌（含表外行），供 UI 排「涨跌」提示。 */
  movers: { name: string; delta: number }[]
  /**
   * 文件里有几份快照。盯盘脚本同日重跑会追加一整份（`# 标题` 再起一行），
   * 这种文件只呈现最后一份，数量用来在面板上提示「这是第 N 次」。
   */
  snapshots: number
}

const ITEM_PATTERN = /^\s*[-*]\s+/
const TABLE_PATTERN = /^\s*\|/
const NOTE_PATTERN = /^\s*>\s?/
const LEVEL_PATTERN = /^\[(高|中|低)\]\s*/
const SEPARATOR_CELL = /^:?-{2,}:?$/
const ASOF_PATTERN = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})/

/** markdown 行内 → 片段数组。没有标记时返回单个 text 片段。 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s)）]+)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) })
    if (match[1] !== undefined) out.push({ kind: 'bold', text: match[1] })
    else if (match[2] !== undefined) out.push({ kind: 'link', text: match[2] === '' ? (match[3] ?? '') : match[2], url: match[3] ?? '' })
    else if (match[4] !== undefined) out.push({ kind: 'link', text: match[4], url: match[4] })
    last = pattern.lastIndex
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out.length > 0 ? out : [{ kind: 'text', text }]
}

/** 行内片段 → 纯文本（用于标签/名称/兜底展示）。 */
export function plainText(inlines: readonly Inline[]): string {
  return inlines.map((part) => part.text).join('')
}

/** 带符号百分比 → 数字。只认 `+1.2%` / `-3.60%`，无符号（净利率 13.6%）不算。 */
function signedPercent(text: string): number | null {
  const match = /([+-]\d+(?:\.\d+)?)\s*%/.exec(text)
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * 条目里的涨跌幅：只认**括号内的带符号百分比**（`（-0.31%，昨收 …）`）。
 * 裸的 `相对锚 -37.8%`、`净利率 13.6%` 是估值口径/财务比率，不是当日涨跌，
 * 混进涨跌统计会凭空造出一个 -37.8% 的"最大跌幅"。
 */
function quotePercent(text: string): number | null {
  const match = /[（(]\s*([+-]\d+(?:\.\d+)?)\s*%/.exec(text)
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/** 表格单元格里的涨跌幅（有「涨跌」列时允许无符号的 0.00%）。 */
function cellPercent(text: string): number | null {
  const signed = signedPercent(text)
  if (signed !== null) return signed
  const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(text.trim())
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim()
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const cells = body.endsWith('|') ? body.slice(0, -1) : body
  return cells.split('|').map((cell) => cell.trim())
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => SEPARATOR_CELL.test(cell))
}

/** 单条列表项：拆出标签、等级、涨跌幅。 */
function buildItem(raw: string): ReportItem {
  let rest = raw
  let level: SignalLevel | null = null
  const levelMatch = LEVEL_PATTERN.exec(rest)
  if (levelMatch !== null) {
    level = levelMatch[1] as SignalLevel
    rest = rest.slice(levelMatch[0].length)
  }

  let label: string | null = null
  const bold = /^\*\*([^*]+)\*\*\s*/.exec(rest)
  if (bold !== null && bold[1].trim() !== '' && bold[1].trim().length <= 12 && rest.slice(bold[0].length).trim() !== '') {
    label = bold[1].trim()
    rest = rest.slice(bold[0].length)
  } else {
    const colon = /^([^：:]{1,12})[：:]\s*/.exec(rest)
    if (colon !== null && rest.slice(colon[0].length).trim() !== '') {
      label = colon[1].trim()
      rest = rest.slice(colon[0].length)
    }
  }

  const inlines = parseInline(rest.trim())
  return { label, inlines, details: [], level, delta: quotePercent(plainText(inlines)) }
}

function buildTable(lines: readonly string[]): ReportTable {
  const cells = lines.map(splitTableRow)
  const headRaw = cells[0] ?? []
  const head = headRaw.map(parseInline)
  const deltaColumn = headRaw.findIndex((cell) => /涨跌/.test(cell))
  const bodyRows = cells.slice(1).filter((row) => !isSeparatorRow(row))
  const rows = bodyRows.map((row) => row.map(parseInline))
  const names = bodyRows.map((row) => row[0] ?? '')
  const deltas = bodyRows.map((row) => {
    if (deltaColumn >= 0) {
      const value = cellPercent(row[deltaColumn] ?? '')
      if (value !== null) return value
    }
    for (const cell of row) {
      const value = signedPercent(cell)
      if (value !== null) return value
    }
    return null
  })
  return { head, rows, names, deltas }
}

function splitSections(lines: readonly string[]): { title: string | null; body: string[] }[] {
  const out: { title: string | null; body: string[] }[] = []
  let current: { title: string | null; body: string[] } = { title: null, body: [] }
  for (const line of lines) {
    const heading = /^##+\s+(.*)$/.exec(line)
    if (heading !== null) {
      if (current.title !== null || current.body.some((row) => row.trim() !== '')) out.push(current)
      current = { title: heading[1].trim(), body: [] }
      continue
    }
    if (/^#\s+/.test(line)) continue
    current.body.push(line)
  }
  if (current.title !== null || current.body.some((row) => row.trim() !== '')) out.push(current)
  return out
}

function sectionKind(title: string): SectionKind {
  if (/信号/.test(title)) return 'signals'
  if (/变化/.test(title)) return 'changes'
  return 'normal'
}

/**
 * 按 H1 切快照。盯盘脚本「同日重跑追加」时，一个文件里会有多份完整报告
 * （每份都从 `# 标题 · 时间` 重新开始，`##` 分区编号也从「一、」重来）。
 * 只呈现最后一份，否则面板上会出现三套「一、国际金价」和三倍信号。
 */
function splitSnapshots(lines: readonly string[]): { title: string; body: string[] }[] {
  const snaps: { title: string; body: string[] }[] = []
  let current: { title: string; body: string[] } | null = null
  for (const line of lines) {
    if (/^#\s+/.test(line)) {
      if (current !== null) snaps.push(current)
      current = { title: line.replace(/^#\s+/, '').trim(), body: [] }
      continue
    }
    if (current === null) current = { title: '', body: [] }
    current.body.push(line)
  }
  if (current !== null) snaps.push(current)
  return snaps.filter((snap) => snap.title !== '' || snap.body.some((line) => line.trim() !== ''))
}

function buildBlocks(body: readonly string[]): ReportBlock[] {
  const blocks: ReportBlock[] = []
  let items: ReportItem[] = []
  let table: string[] = []
  let paragraph: string[] = []
  let note: string[] = []

  const flushItems = (): void => { if (items.length > 0) { blocks.push({ kind: 'items', items }); items = [] } }
  const flushTable = (): void => { if (table.length > 0) { blocks.push({ kind: 'table', table: buildTable(table) }); table = [] } }
  const flushParagraph = (): void => {
    if (paragraph.length > 0) { blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join(' ')) }); paragraph = [] }
  }
  const flushNote = (): void => {
    if (note.length > 0) { blocks.push({ kind: 'note', inlines: parseInline(note.join(' ')) }); note = [] }
  }
  const flushAll = (): void => { flushItems(); flushTable(); flushParagraph(); flushNote() }

  for (const raw of body) {
    const line = raw.trimEnd()
    if (line.trim() === '') { flushAll(); continue }

    if (TABLE_PATTERN.test(line)) { flushItems(); flushParagraph(); flushNote(); table.push(line); continue }
    flushTable()

    if (NOTE_PATTERN.test(line)) { flushItems(); flushParagraph(); note.push(line.replace(NOTE_PATTERN, '')); continue }
    flushNote()

    if (ITEM_PATTERN.test(line)) {
      flushParagraph()
      items.push(buildItem(line.replace(ITEM_PATTERN, '')))
      continue
    }

    // 缩进续行：挂到上一条列表项（公告链接/补充说明）。列表外则当段落。
    if (/^\s{2,}\S/.test(raw) && items.length > 0) {
      const last = items[items.length - 1]
      last.details.push(parseInline(line.trim()))
      continue
    }

    flushItems()
    paragraph.push(line.trim())
  }
  flushAll()
  return blocks
}

function noteText(block: ReportBlock): string {
  return block.kind === 'note' ? plainText(block.inlines ?? []) : ''
}

/** 解析一份盯盘报告。任何字段缺失都返回 null / 空数组，不抛异常。 */
export function parseReport(text: string): ParsedReport {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const snapshots = splitSnapshots(lines)
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : { title: '', body: lines }
  const title = latest.title
  const line = title.split('·')[0]?.trim() ?? title
  const titleStamp = ASOF_PATTERN.exec(title)?.[1]?.replace('T', ' ') ?? null

  const sections: ReportSection[] = splitSections(latest.body)
    .map(({ title: heading, body }) => ({
      title: heading ?? '',
      kind: heading === null ? 'normal' : sectionKind(heading),
      blocks: buildBlocks(body),
    }))
    .filter((section) => section.title !== '' || section.blocks.length > 0)

  // 页脚：生成时间 / 数据源说明是整篇的元信息，不该落进「较上次变化」卡片里。
  const footer: Inline[] = []
  for (const section of sections) {
    const kept: ReportBlock[] = []
    for (const block of section.blocks) {
      const noteBody = noteText(block)
      if (noteBody !== '' && /(生成时间|数据源)/.test(noteBody)) footer.push(...(block.inlines ?? []))
      else kept.push(block)
    }
    section.blocks = kept
  }

  const footerText = footer.map((part) => part.text).join(' ')
  const asOf = titleStamp ?? ASOF_PATTERN.exec(footerText)?.[1]?.replace('T', ' ') ?? null

  // 只有真正写了内容的信号才算一条：`- [高]` 这种空壳不该让「1 条信号」出现在结论条上。
  const signals: number = sections
    .filter((section) => section.kind === 'signals')
    .reduce((sum, section) => sum + section.blocks
      .filter((block) => block.kind === 'items')
      .flatMap((block) => block.items ?? [])
      .filter((item) => plainText(item.inlines).trim() !== '' || item.details.length > 0)
      .length, 0)

  const changes: number = sections
    .filter((section) => section.kind === 'changes')
    .reduce((sum, section) => sum + section.blocks
      .filter((block) => block.kind === 'items')
      .flatMap((block) => block.items ?? [])
      .map((item) => plainText(item.inlines).split('；').filter((part) => part.trim() !== '').length)
      .reduce((inner, value) => inner + value, 0), 0)

  const movers: { name: string; delta: number }[] = []
  let tableCount = 0
  for (const section of sections) {
    for (const block of section.blocks) {
      if (block.kind === 'table' && block.table !== undefined) {
        tableCount += 1
        const current = block.table
        current.deltas.forEach((delta, index) => {
          const name = current.names[index]?.trim() ?? ''
          if (delta !== null && name !== '') movers.push({ name, delta })
        })
      }
      if (block.kind === 'items') {
        for (const item of block.items ?? []) {
          if (item.delta === null) continue
          const name = item.label ?? plainText(item.inlines).slice(0, 12)
          if (name !== '') movers.push({ name, delta: item.delta })
        }
      }
    }
  }

  const up = movers.filter((row) => row.delta > 0).length
  const down = movers.filter((row) => row.delta < 0).length
  const flat = movers.length - up - down
  const worst = movers.reduce<{ name: string; delta: number } | null>(
    (acc, row) => (acc === null || row.delta < acc.delta ? row : acc), null)
  const best = movers.reduce<{ name: string; delta: number } | null>(
    (acc, row) => (acc === null || row.delta > acc.delta ? row : acc), null)

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
      tables: tableCount,
    },
    movers,
    snapshots: Math.max(snapshots.length, 1),
  }
}

/** 单个「信号」分区里的条目（带上级别），供分区自己渲染，不跨分区重复。 */
export function sectionSignals(section: ReportSection): { level: SignalLevel | null; text: string }[] {
  const out: { level: SignalLevel | null; text: string }[] = []
  if (section.kind !== 'signals') return out
  for (const block of section.blocks) {
    for (const item of block.items ?? []) {
      const text = plainText(item.inlines).trim()
      if (text !== '') out.push({ level: item.level, text })
    }
    const note = block.kind === 'note' ? plainText(block.inlines ?? []).trim() : ''
    if (note !== '') out.push({ level: null, text: note })
  }
  return out
}

/** 单个「较上次变化」分区的 name/value 行，供分区自己渲染。 */
export function sectionChanges(section: ReportSection): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = []
  if (section.kind !== 'changes') return out
  for (const block of section.blocks) {
    for (const item of block.items ?? []) {
      for (const part of plainText(item.inlines).split('；')) {
        const text = part.trim()
        if (text === '') continue
        const match = /^(.+?)\s+([+-]?[\d,.]+%?)$/.exec(text)
        if (match !== null) out.push({ name: match[1].trim(), value: match[2] })
        else out.push({ name: text, value: '' })
      }
    }
  }
  return out
}

/** 信号分区 → 扁平信号列表（等级 + 文本），无信号返回空数组。 */
export function reportSignals(report: ParsedReport): { level: SignalLevel | null; text: string }[] {
  return report.sections.flatMap((section) => sectionSignals(section))
}

/** 「较上次变化」条目 → [{name, value}]，没有就空数组。 */
export function reportChanges(report: ParsedReport): { name: string; value: string }[] {
  return report.sections.flatMap((section) => sectionChanges(section))
}
