/**
 * 盯盘报告面板（右列第三栏，默认自动打开）。
 *
 * 数据来自宿主半的 `/dshtrading-panel/api/files/reports`（扫工作区 reports/watch/*.md），
 * 打开即自动载入最新一份正文，点列表任意一行切换；不复制正文，只做索引 + 预览。
 */
import { useEffect, useMemo, useState } from 'react'
import css from './reports-panel.module.css'

const MOUNT = '/dshtrading-panel/api/files'
const REFRESH_MS = 5 * 60 * 1000

interface ReportRow {
  name: string
  path: string
  size: number
  mtime: number
}

interface ReportsWire {
  ok: boolean
  dir?: string | null
  entries?: ReportRow[]
  code?: string
  message?: string
}

interface ReadWire {
  ok: boolean
  text?: string
  size?: number
  code?: string
  message?: string
}

export interface ReportsPanelProps {
  t: (key: 'panel.reports' | 'panel.reportsEmpty' | 'panel.reportsBack' | 'panel.reportsLoading') => string
  onClose(): void
}

function stamp(mtime: number): string {
  if (!mtime) return ''
  const d = new Date(mtime)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatSize(size: number): string {
  if (!size) return ''
  if (size < 1024) return `${size} B`
  return `${(size / 1024).toFixed(1)} KB`
}

export function ReportsPanel({ t, onClose }: ReportsPanelProps) {
  const [rows, setRows] = useState<ReportRow[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [current, setCurrent] = useState<ReportRow | null>(null)
  const [preview, setPreview] = useState<ReadWire | null>(null)

  // 报告索引（5 分钟刷新一次，盯盘器每天落盘，不需要更密）
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`${MOUNT}/reports?limit=50`, { credentials: 'same-origin' })
        const wire = await res.json() as ReportsWire
        if (!alive) return
        if (wire.ok) {
          setRows(wire.entries ?? [])
          setListError(null)
        } else {
          setRows([])
          setListError(`${wire.code ?? 'REPORTS_ERROR'} · ${wire.message ?? ''}`)
        }
      } catch {
        if (alive) { setRows([]); setListError('REPORTS_FETCH_FAILED') }
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, REFRESH_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  // 自动打开最新一份（没有就停在列表）
  useEffect(() => {
    if (current !== null || rows === null || rows.length === 0) return
    setCurrent(rows[0])
  }, [rows, current])

  const currentPath = current?.path ?? null
  useEffect(() => {
    if (currentPath === null) { setPreview(null); return }
    let alive = true
    setPreview(null)
    void fetch(`${MOUNT}/read?path=${encodeURIComponent(currentPath)}`, { credentials: 'same-origin' })
      .then(async (res) => (await res.json()) as ReadWire)
      .then((wire) => { if (alive) setPreview(wire) })
      .catch(() => { if (alive) setPreview({ ok: false, code: 'REPORTS_READ_FAILED', message: '' }) })
    return () => { alive = false }
  }, [currentPath])

  const title = useMemo(() => t('panel.reports'), [t])

  return (
    <div className={css.panel} data-dshtrading-panel-reports="">
      <div className={css.head}>
        <span className={css.title}>{title}</span>
        <span className={css.spacer} />
        <button type="button" className={css.closeBtn} onClick={onClose} aria-label="close">×</button>
      </div>

      <div className={css.list}>
        {rows === null && <div className={css.hint}>{t('panel.reportsLoading')}</div>}
        {rows !== null && rows.length === 0 && <div className={css.hint}>{listError ?? t('panel.reportsEmpty')}</div>}
        {rows !== null && rows.map(row => (
          <button
            key={row.path}
            type="button"
            className={css.row}
            data-active={current?.path === row.path ? 'true' : undefined}
            title={row.path}
            onClick={() => { setCurrent(row) }}
          >
            <span className={css.name}>{row.name.replace(/\.md$/i, '')}</span>
            <span className={css.meta}>
              <span className={css.time}>{stamp(row.mtime)}</span>
              <span className={css.size}>{formatSize(row.size)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className={css.previewHead}>
        <span className={css.previewName} title={current?.path ?? ''}>
          {current ? current.name.replace(/\.md$/i, '') : ''}
        </span>
        <span className={css.spacer} />
        {current !== null && (
          <button type="button" className={css.backBtn} onClick={() => { setCurrent(null); setPreview(null) }}>
            {t('panel.reportsBack')}
          </button>
        )}
      </div>
      <div className={css.body}>
        {preview === null && current !== null && <div className={css.hint}>{t('panel.reportsLoading')}</div>}
        {preview !== null && !preview.ok && (
          <div className={css.hint}>{preview.code ?? 'REPORTS_ERROR'} · {preview.message ?? ''}</div>
        )}
        {preview !== null && preview.ok && <pre className={css.text}>{preview.text ?? ''}</pre>}
      </div>
    </div>
  )
}
