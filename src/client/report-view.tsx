/**
 * 盯盘报告的「结构化视图」。
 *
 * 宿主半（src/watch-parse.ts）已经把 markdown 拆成 报告 → 分区 → 区块（条目/表格/注释/段落），
 * 行内还拆出了加粗与链接，这里只负责排版，不再做任何字符串解析：
 * 界面上不应该再出现 `#`、`**`、`|`、`>` 这些符号。
 *
 * 版式顺序：结论条（数据时间 / 信号数 / 涨跌家数 / 最大跌幅 / 变化项数）
 *          → 分区卡片（每条线一块）
 *          → 页脚（数据源、生成时间）。
 */
import type { ReactNode } from 'react'
import { sectionChanges } from '../watch-parse.ts'
import type { Inline, ParsedReport, ReportBlock, ReportItem, ReportTable, ReportSection } from '../watch-parse.ts'
import type { MarketLocaleKey } from '../trading/contract.ts'
import css from './reports-panel.module.css'

export type ReportsT = (key: MarketLocaleKey, params?: Record<string, string | number>) => string

export interface ReportSignalView {
  level: string | null
  text: string
}

export interface ReportChangeView {
  name: string
  value: string
}

export interface ReportViewProps {
  report: ParsedReport
  signals: readonly ReportSignalView[]
  changes: readonly ReportChangeView[]
  t: ReportsT
}

/** 只放行常规网页协议：报告正文来自抓取，`jacket:javascript:` 之类不该变成可点链接。 */
const SAFE_LINK = /^(https?:\/\/|mailto:)/i

type Tone = 'up' | 'down' | 'flat' | 'neutral'

function toneOfDelta(delta: number | null): Tone {
  if (delta === null || delta === 0) return 'flat'
  return delta > 0 ? 'up' : 'down'
}

/** `-4.82` → `-4.82%`；正数补 `+`，方便一眼分辨涨跌。 */
export function signedPercent(delta: number): string {
  const text = delta > 0 ? `+${delta.toFixed(2)}` : delta.toFixed(2)
  return `${text}%`
}

function trimUrl(text: string): string {
  const bare = text.replace(/^https?:\/\//i, '')
  return bare.length > 56 ? `${bare.slice(0, 55)}…` : bare
}

/**
 * 公告链接在报告里常常写成 `[整条 url](整条 url)`，整条塞进面板就是一团噪声。
 * 这里优先用写作文字；文字本身是 url 时退成文件名（`1225599826.PDF`），悬停再看完整地址。
 */
function linkLabel(part: { text: string; url: string }): string {
  const text = part.text.trim()
  if (text !== '' && !/^https?:\/\//i.test(text)) return text
  try {
    const segments = new URL(part.url).pathname.split('/').filter((segment) => segment !== '')
    const last = segments[segments.length - 1]
    if (last !== undefined && last !== '') return decodeURIComponent(last)
  } catch {
    // 非法 URL：退回截断展示
  }
  return trimUrl(part.url)
}

/**
 * 中文默认可以在任意两个字之间断行，于是「区间 777.75 – 783.00」会被拆成
 * 行尾「区」+ 下行「间 777.75」，读起来像乱码。这里把数值/区间/时间戳/带单位的价格
 * 包成不可断的行内片段，断行只发生在中文句子之间。
 */
const NOWRAP_PATTERN = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?|\d[\d,.]*\s*[–~-]\s*\d[\d,.]*|昨收\s*\d[\d,.]*|\d[\d,.]*\s*(?:美元\/盎司|美元|元\/克|元\/份|元|亿|万|%))/g

function nowrapify(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(NOWRAP_PATTERN)) {
    const at = match.index ?? 0
    if (at > last) nodes.push(text.slice(last, at))
    nodes.push(<span key={`${key}-nw-${at}`} className={css.nowrap}>{match[0]}</span>)
    last = at + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes.length === 0 ? [text] : nodes
}

function renderInlines(parts: readonly Inline[], keyPrefix: string): ReactNode[] {
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.kind === 'bold') return <strong key={key} className={css.bold}>{part.text}</strong>
    if (part.kind === 'link') {
      const label = linkLabel(part)
      if (!SAFE_LINK.test(part.url.trim())) {
        // 非 http(s)/mailto：按纯文本渲染，别把不可信协议挂成可点链接。
        return <span key={key} title={part.url}>{label}</span>
      }
      return (
        <a key={key} className={css.link} href={part.url} target="_blank" rel="noreferrer noopener" title={part.url}>
          {label}
        </a>
      )
    }
    return <span key={key}>{nowrapify(part.text, key)}</span>
  })
}

/** 数字单元格右对齐 + 等宽字体；`—`、`-` 这类占位符也算数字列，避免表格右半边歪掉。 */
function isNumericCell(text: string): boolean {
  const value = text.trim()
  if (value === '' ) return false
  if (value === '—' || value === '-' || value === '–') return true
  return /^[+-]?[\d,]+(?:\.\d+)?%?$/.test(value)
}

function alignments(head: readonly Inline[][], rows: readonly Inline[][][]): boolean[] {
  const width = head.length
  const flags: boolean[] = []
  for (let column = 0; column < width; column += 1) {
    if (column === 0) { flags.push(false); continue }
    const cells = rows.map((row) => row[column]).filter((cell): cell is Inline[] => Array.isArray(cell))
    if (cells.length === 0) { flags.push(false); continue }
    const numeric = cells.filter((cell) => isNumericCell(cell.map((part) => part.text).join(''))).length
    flags.push(numeric * 2 >= cells.length)
  }
  return flags
}

function InlineText({ parts, keyPrefix }: { parts: readonly Inline[]; keyPrefix: string }) {
  return <>{renderInlines(parts, keyPrefix)}</>
}

/** 涨跌幅列：表头写着「涨跌」的那一列；没有就退化成「按行认第一个百分比」。 */
function deltaColumnIndex(head: readonly Inline[][]): number {
  for (let index = 0; index < head.length; index += 1) {
    if (/涨跌|幅度/.test(head[index].map((part) => part.text).join(''))) return index
  }
  return -1
}

function TableBlock({ table, t }: { table: ReportTable; t: ReportsT }) {
  const alignRight = alignments(table.head, table.rows)
  const deltaColumn = deltaColumnIndex(table.head)
  return (
    <div className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          <tr>
            {table.head.map((cell, index) => (
              <th key={`h-${index}`} className={alignRight[index] === true ? css.num : undefined}>
                <InlineText parts={cell} keyPrefix={`h-${index}`} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => {
            const delta = table.deltas[rowIndex] ?? null
            return (
              <tr key={`r-${rowIndex}`}>
                {row.map((cell, columnIndex) => {
                  const text = cell.map((part) => part.text).join('')
                  // 只染「涨跌幅」那一列：表头指了列就只认这列，没表头才退回按行找百分比，
                  // 免得同一行里第二个百分比（成交量涨幅之类）被按行涨跌染错色。
                  const isDeltaCell = deltaColumn >= 0
                    ? columnIndex === deltaColumn && /\d/.test(text)
                    : delta !== null && isNumericCell(text) && /\d%/.test(text)
                  return (
                    <td
                      key={`c-${rowIndex}-${columnIndex}`}
                      className={alignRight[columnIndex] === true ? css.num : undefined}
                    >
                      {isDeltaCell
                        ? <span data-tone={toneOfDelta(delta)} className={css.delta}>{text}</span>
                        : <InlineText parts={cell} keyPrefix={`c-${rowIndex}-${columnIndex}`} />}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <span className={css.tableFoot}>{t('panel.reportsTableRows', { count: table.rows.length })}</span>
    </div>
  )
}

function ItemBlock({ item, t }: { item: ReportItem; t: ReportsT }) {
  return (
    <li className={css.item}>
      {item.level !== null && (
        <span className={css.level} data-level={item.level} title={t('panel.reportsLevel')}>{item.level}</span>
      )}
      {item.label !== null && <span className={css.itemLabel}>{item.label}</span>}
      <span className={css.itemText}><InlineText parts={item.inlines} keyPrefix={`i-${item.label ?? ''}`} /></span>
      {item.delta !== null && (
        <span className={css.delta} data-tone={toneOfDelta(item.delta)}>{signedPercent(item.delta)}</span>
      )}
      {item.details.length > 0 && (
        <span className={css.details}>
          {item.details.map((line, index) => (
            <span key={`d-${index}`} className={css.detailLine}>
              <InlineText parts={line} keyPrefix={`d-${index}`} />
            </span>
          ))}
        </span>
      )}
    </li>
  )
}

/**
 * 结论性条目要排在前面。北港那份「指标③ 重组进展」里 11 条公告先铺满一屏，
 * 真正要看的「命中里程碑：🟡 复牌」排在最后，一屏根本看不到。
 */
const KEY_ITEM = /命中里程碑|结论|跌破|突破|站上|失守|预警|风险提示/

function hoistKeyItems(items: readonly ReportItem[]): ReportItem[] {
  const key: ReportItem[] = []
  const rest: ReportItem[] = []
  for (const item of items) {
    const text = item.label !== null && item.label !== '' ? item.label : plainTextOf(item.inlines)
    if (KEY_ITEM.test(text)) key.push(item)
    else rest.push(item)
  }
  return key.length === 0 ? [...items] : [...key, ...rest]
}

function plainTextOf(parts: readonly Inline[]): string {
  return parts.map((part) => part.text).join('')
}

function BlockView({ block, index, t }: { block: ReportBlock; index: number; t: ReportsT }) {
  if (block.kind === 'table' && block.table !== undefined) {
    return <TableBlock table={block.table} t={t} />
  }
  if (block.kind === 'note') {
    return <p className={css.note}><InlineText parts={block.inlines ?? []} keyPrefix={`n-${index}`} /></p>
  }
  if (block.kind === 'paragraph') {
    return <p className={css.para}><InlineText parts={block.inlines ?? []} keyPrefix={`p-${index}`} /></p>
  }
  const items = block.items ?? []
  if (items.length === 1 && items[0].details.length === 0
    && items[0].level === null && items[0].delta === null) {
    // 单条目分区（「较上次变化」那类一行流）不套 bullet，读起来更像一句话。
    // 但带级别或涨跌幅的条目必须走 ItemBlock，否则「[高]」这种关键信息会被吞掉。
    const only = items[0]
    return (
      <p className={css.single}>
        {only.label !== null && <span className={css.itemLabel}>{only.label}</span>}
        <InlineText parts={only.inlines} keyPrefix={`s-${index}`} />
      </p>
    )
  }
  return (
    <ul className={css.items}>
      {hoistKeyItems(items).map((item, itemIndex) => <ItemBlock key={`i-${index}-${itemIndex}`} item={item} t={t} />)}
    </ul>
  )
}

function ChangesView({ changes }: { changes: readonly ReportChangeView[] }) {
  return (
    <div className={css.changes}>
      {changes.map((change, index) => (
        <div key={`ch-${index}`} className={css.changeRow}>
          <span className={css.changeName}>{change.name}</span>
          <span className={css.changeValue}>{change.value}</span>
        </div>
      ))}
    </div>
  )
}

function VerdictStrip({ report, signals, changes, t }: ReportViewProps) {
  const chips: { label: string; tone: Tone }[] = []
  if (report.asOf !== null) chips.push({ label: t('panel.reportsAsOf', { time: report.asOf }), tone: 'neutral' })
  // 同一个文件里追加了多份快照时，说清楚展示的是哪一份，别让人以为数据被合并了。
  if (report.snapshots > 1) {
    chips.push({ label: t('panel.reportsSnapshots', { count: report.snapshots }), tone: 'neutral' })
  }
  if (signals.length > 0) chips.push({ label: t('panel.reportsSignals', { count: signals.length }), tone: 'neutral' })
  // 「N 项变化」跟信号数同属计数，紧挨着放；否则窄栏换行后它单独占一行，像没写完。
  if (changes.length > 0) chips.push({ label: t('panel.reportsChanges', { count: changes.length }), tone: 'neutral' })
  const moved = report.summary.up + report.summary.down
  if (moved > 0) {
    // 涨跌家数只报事实，不上色：红绿在中文语境里只表达方向，
    // 「13 跌」染成绿色容易被读成「好」。
    chips.push({
      label: t('panel.reportsMovers', { down: report.summary.down, up: report.summary.up }),
      tone: 'neutral',
    })
  } else if (report.summary.flat > 0) {
    chips.push({ label: t('panel.reportsFlatOnly'), tone: 'flat' })
  }
  const worst = report.summary.worst
  if (worst !== null) {
    chips.push({ label: t('panel.reportsWorst', { name: worst.name, delta: signedPercent(worst.delta) }), tone: 'down' })
  }
  const best = report.summary.best
  if (best !== null && best.delta > 0) {
    chips.push({ label: t('panel.reportsBest', { name: best.name, delta: signedPercent(best.delta) }), tone: 'up' })
  }
  if (chips.length === 0) return null
  return (
    <div className={css.verdict}>
      {chips.map((chip, index) => (
        <span key={`chip-${index}`} className={css.chip} data-tone={chip.tone}>{chip.label}</span>
      ))}
    </div>
  )
}

export function ReportView({ report, signals, changes, t }: ReportViewProps) {
  // 信号是「今天该不该动手」的结论，先摆出来；其余分区保持报告原顺序。
  // 过去它排在第六块，窄栏里要滚两屏才看得见。
  const ordered = [
    ...report.sections.filter((section) => section.kind === 'signals'),
    ...report.sections.filter((section) => section.kind !== 'signals'),
  ]
  return (
    <div className={css.report} data-dshtrading-report-view="">
      <VerdictStrip report={report} signals={signals} changes={changes} t={t} />
      {ordered.map((section, index) => {
        // 「较上次变化」分区自己带行数据；其它分区（含信号）按区块渲染，
        // 信号条目的级别由 ItemBlock 显示，不再把全局信号列表塞进每个信号分区。
        const changeRows = section.kind === 'changes' ? sectionChanges(section) : []
        return (
          <section key={`sec-${index}`} className={css.card} data-kind={section.kind}>
            <div className={css.cardHead}>
              <span className={css.cardIndex}>{index + 1}</span>
              <span className={css.cardTitle}>{section.title ?? report.line ?? ''}</span>
            </div>
            <div className={css.cardBody}>
              {changeRows.length > 0
                ? <ChangesView changes={changeRows} />
                : section.blocks.map((block, blockIndex) => (
                  <BlockView key={`b-${index}-${blockIndex}`} block={block} index={blockIndex} t={t} />
                ))}
            </div>
          </section>
        )
      })}
      {report.footer.length > 0 && (
        <div className={css.footer}><InlineText parts={report.footer} keyPrefix="foot" /></div>
      )}
    </div>
  )
}
