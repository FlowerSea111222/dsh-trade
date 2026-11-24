/**
 * 左栏底部「盯盘报告」：把自选列表下方的空白，换成工作区里真实产出的日报。
 *
 * 数据来自宿主半新加的 `/dshtrading-panel/api/files/reports`（扫 reports/watch/*.md），
 * 点一行直接打开「文件」面板并定位到该报告——这里只做索引，不复制正文。
 */
import { useEffect, useState } from 'react'
import css from './left-reports.module.css'

interface ReportRow {
  name: string
  path: string
  size: number
  mtime: number
}

interface Wire {
  ok: boolean
  dir: string | null
  entries: ReportRow[]
}

interface Props {
  title: string
  emptyText: string
  /** 打开文件面板并定位到该报告。 */
  onOpen: (path: string) => void
}

const REFRESH_MS = 5 * 60 * 1000

function stamp(mtime: number): string {
  if (!mtime) return ''
  const d = new Date(mtime)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function LeftReports({ title, emptyText, onOpen }: Props) {
  const [rows, setRows] = useState<ReportRow[] | null>(null)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/dshtrading-panel/api/files/reports?limit=8', { credentials: 'same-origin' })
        const wire = await res.json() as Wire
        if (alive && wire.ok) setRows(wire.entries)
      } catch {
        if (alive) setRows([])
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return (
    <section className={css.wrap} aria-label={title}>
      <div className={css.head}>
        <span className={css.title}>{title}</span>
      </div>
      {rows === null
        ? null
        : rows.length === 0
          ? <p className={css.hint}>{emptyText}</p>
          : (
            <ul className={css.list}>
              {rows.map(row => (
                <li key={row.path}>
                  <button type="button" className={css.row} title={row.path} onClick={() => { onOpen(row.path) }}>
                    <span className={css.name}>{row.name.replace(/\.md$/i, '')}</span>
                    <span className={css.time}>{stamp(row.mtime)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
    </section>
  )
}
