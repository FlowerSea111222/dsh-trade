/**
 * 盯盘报告面板（右列第三栏）。
 *
 * 数据链路：宿主半扫「经济工作区」的 reports/watch/*.md
 *   `/watch/reports` 列表（带线名/时间/信号数，列表行自己就是一句话摘要）
 *   `/watch/report`  结构化正文（宿主半解析 markdown → 分区/条目/表格，前端只排版）
 *   `/read`          原文（「原文」标签用，保留可核对性）
 *
 * 之前这里直接把 markdown 原文塞进 <pre>，所以面板里全是 `##`、`**`、`|`。
 */
import { useEffect, useState } from 'react'
import type { ParsedReport } from '../watch-parse.ts'
import type { MarketLocaleKey } from '../trading/contract.ts'
import { ReportView } from './report-view.tsx'
import type { ReportChangeView, ReportSignalView } from './report-view.tsx'
import css from './reports-panel.module.css'

const MOUNT = '/dshtrading-panel/api/files'
/** 盯盘脚本一天写几份，一分钟足够新；太密只是空转。 */
const REFRESH_MS = 60_000
/** 宿主启动初期插件路由可能还没挂上，失败后静默重试的次数与间隔。 */
const LIST_RETRY_MAX = 3
const LIST_RETRY_MS = 1_500

interface ReportMeta {
  line: string | null
  asOf: string | null
  signals: number
  up: number
  down: number
  worst: { name: string; delta: number } | null
}

interface ReportRow {
  name: string
  path: string
  folder?: string
  size: number
  mtime: number
  meta?: ReportMeta
}

interface ListWire {
  ok: boolean
  root?: string | null
  source?: string | null
  entries?: ReportRow[]
  code?: string
  message?: string
}

interface DetailWire {
  ok: boolean
  root?: string
  source?: string
  path?: string
  size?: number
  mtime?: number
  report?: ParsedReport
  signals?: ReportSignalView[]
  changes?: ReportChangeView[]
  code?: string
  message?: string
}

interface ReadWire {
  ok: boolean
  text?: string
  code?: string
  message?: string
}

interface WorkspaceRow {
  path: string
  name: string
  reports: number
  latest: number
  updatedAt: string | null
}

interface WorkspacesWire {
  ok: boolean
  root?: string
  source?: string
  bound?: string | null
  workspaces?: WorkspaceRow[]
}

function baseName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? dir : parts[parts.length - 1]
}

export interface ReportsPanelProps {
  t: (key: MarketLocaleKey, params?: Record<string, string | number>) => string
  onClose(): void
}

const SOURCE_KEYS: Record<string, MarketLocaleKey> = {
  bound: 'panel.reportsSource.bound',
  config: 'panel.reportsSource.config',
  'watch-reports': 'panel.reportsSource.watch-reports',
  'recent-workspace': 'panel.reportsSource.recent-workspace',
  cwd: 'panel.reportsSource.cwd',
}

function stamp(mtime: number): string {
  if (!mtime) return ''
  const d = new Date(mtime)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fileName(path: string): string {
  return path.replace(/\.md$/i, '')
}

/** 报告列表里用日期当名字：`黄金/2026-11-28.md` → `2026-11-28`。 */
function dateLabel(name: string): string | null {
  const hit = /(\d{4}-\d{2}-\d{2})/.exec(name)
  return hit === null ? null : hit[1]
}

/** 按 folder 分组，保持列表原有的 mtime 倒序（组序 = 组内最新一份的时间）。 */
function groupRows(rows: ReportRow[]): [string, ReportRow[]][] {
  const groups = new Map<string, ReportRow[]>()
  for (const row of rows) {
    const key = row.folder === undefined || row.folder === '' ? '未分类' : row.folder
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [row])
    else bucket.push(row)
  }
  return [...groups.entries()]
}

function errorText(code: string | undefined, fallback: string): string {
  return code === undefined || code === '' ? fallback : code
}

export function ReportsPanel({ t, onClose }: ReportsPanelProps) {
  const [rows, setRows] = useState<ReportRow[] | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailWire | null>(null)
  const [mode, setMode] = useState<'structured' | 'raw'>('structured')
  const [raw, setRaw] = useState<ReadWire | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  // 只有当前报告所在的文件夹默认展开，其余折叠成一行索引（14 份报告一屏塞不下）。
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [bound, setBound] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[] | null>(null)
  const [bindBusy, setBindBusy] = useState(false)

  // 绑定选择器：工作区清单只在打开面板/换绑时拉，省得跟着 60 秒轮询一起刷。
  useEffect(() => {
    let alive = true
    void fetch(`${MOUNT}/workspaces`, { credentials: 'same-origin' })
      .then(async (res) => (await res.json()) as WorkspacesWire)
      .then((wire) => {
        if (!alive || !wire.ok) return
        setBound(wire.bound ?? null)
        setWorkspaces(wire.workspaces ?? [])
      })
      .catch(() => { /* 选择器拉不到就保持空清单，报告列表仍照常 */ })
    return () => { alive = false }
  }, [refreshKey])

  const bind = async (target: string | null): Promise<void> => {
    if (bindBusy) return
    setBindBusy(true)
    try {
      await fetch(`${MOUNT}/${target === null ? 'unbind' : 'bind'}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: target === null ? '{}' : JSON.stringify({ path: target }),
      })
      // 换根之后旧的 currentPath 在新工作区里多半不存在，先清掉再重拉，避免白打一次 404。
      setPickerOpen(false)
      setCurrentPath(null)
      setDetail(null)
      setRaw(null)
      setRefreshKey((value) => value + 1)
    } finally {
      setBindBusy(false)
    }
  }

  // 列表：进面板拉一次，之后每 60 秒一次；「刷新」按钮立刻重拉。
  // 宿主刚启动那几秒插件路由还没注册（FILES_ROUTE_NOT_FOUND），面板如果直接摆错误态
  // 用户重启 DSH 后第一眼看到的就是「读取失败」。所以失败先静默重试 3 次再报错。
  useEffect(() => {
    let alive = true
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | null = null
    const schedule = (): void => {
      if (!alive || attempt >= LIST_RETRY_MAX) return
      attempt += 1
      retry = setTimeout(() => { void load() }, LIST_RETRY_MS)
    }
    const fail = (code: string): void => {
      // 还在重试窗口里就保持「读取中」，别先闪一次空态 + 一次错误态。
      if (attempt >= LIST_RETRY_MAX) {
        setRows([])
        setListError(code)
        return
      }
      schedule()
    }
    const load = async (): Promise<void> => {
      if (retry !== null) { clearTimeout(retry); retry = null }
      try {
        const res = await fetch(`${MOUNT}/watch/reports?limit=50`, { credentials: 'same-origin' })
        const wire = await res.json() as ListWire
        if (!alive) return
        setRoot(wire.root ?? null)
        setSource(wire.source ?? null)
        if (wire.ok) {
          attempt = 0
          setRows(wire.entries ?? [])
          setListError(null)
        } else {
          fail(errorText(wire.code, 'REPORTS_ERROR'))
        }
      } catch {
        if (alive) fail('REPORTS_FETCH_FAILED')
      }
    }
    void load()
    const timer = setInterval(() => { attempt = 0; void load() }, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
      if (retry !== null) clearTimeout(retry)
    }
  }, [refreshKey])

  // 默认打开最新一份；选中的文件被清理了就回到最新一份。
  useEffect(() => {
    if (rows === null) return
    if (rows.length === 0) { setCurrentPath(null); return }
    if (currentPath !== null && rows.some((row) => row.path === currentPath)) return
    setCurrentPath(rows[0].path)
  }, [rows, currentPath])

  const currentMtime = rows?.find((row) => row.path === currentPath)?.mtime ?? 0

  useEffect(() => {
    if (currentPath === null || (rows !== null && !rows.some((row) => row.path === currentPath))) {
      setDetail(null)
      setRaw(null)
      return
    }
    let alive = true
    setDetail(null)
    void fetch(`${MOUNT}/watch/report?path=${encodeURIComponent(currentPath)}`, { credentials: 'same-origin' })
      .then(async (res) => (await res.json()) as DetailWire)
      .then((wire) => { if (alive) setDetail(wire) })
      .catch(() => { if (alive) setDetail({ ok: false, code: 'REPORTS_READ_FAILED' }) })
    return () => { alive = false }
  }, [currentPath, currentMtime, refreshKey])

  // 原文按需载入，不跟结构化视图抢首屏。
  useEffect(() => {
    setRaw(null)
    if (mode !== 'raw' || currentPath === null) return
    let alive = true
    void fetch(`${MOUNT}/read?path=${encodeURIComponent(currentPath)}`, { credentials: 'same-origin' })
      .then(async (res) => (await res.json()) as ReadWire)
      .then((wire) => { if (alive) setRaw(wire) })
      .catch(() => { if (alive) setRaw({ ok: false, code: 'REPORTS_READ_FAILED' }) })
    return () => { alive = false }
  }, [mode, currentPath, currentMtime, refreshKey])

  const currentRow = rows?.find((row) => row.path === currentPath) ?? null
  const currentFolder = currentRow === null || currentRow === undefined
    ? null
    : currentRow.folder === undefined || currentRow.folder === ''
      ? '未分类'
      : currentRow.folder
  /** 用户手动点过的文件夹优先，没点过的：当前报告所在的展开、其余折叠。 */
  const isFolded = (folder: string): boolean => {
    const manual = folded[folder]
    if (manual !== undefined) return manual
    return folder !== currentFolder
  }
  const sourceKey = source === null ? undefined : SOURCE_KEYS[source]
  const loading = rows === null
  const empty = rows !== null && rows.length === 0

  return (
    <div className={css.panel} data-dshtrading-panel-reports="">
      <div className={css.head}>
        <span className={css.title}>{t('panel.reports')}</span>
        <span className={css.pickerWrap}>
          <button
            type="button"
            className={css.pickerBtn}
            data-bound={bound === null ? undefined : 'true'}
            title={`${t('panel.reportsBind')} · ${root ?? ''}`}
            onClick={() => { setPickerOpen((open) => !open) }}
          >
            <span className={css.pickerName}>{root === null ? t('panel.reportsBind') : baseName(root)}</span>
            {sourceKey !== undefined && <span className={css.sourceChip}>{t(sourceKey)}</span>}
            <span className={css.caret} aria-hidden="true">▾</span>
          </button>
          {pickerOpen && (
            <>
              <div className={css.menuScrim} onClick={() => { setPickerOpen(false) }} />
              <div className={css.menu} role="menu">
                <button
                  type="button"
                  className={css.menuItem}
                  data-active={bound === null ? 'true' : undefined}
                  onClick={() => { void bind(null) }}
                >
                  <span className={css.menuName}>{t('panel.reportsBindAuto')}</span>
                  {bound === null && <span className={css.menuTick}>✓</span>}
                </button>
                {(workspaces ?? []).map((ws) => (
                  <button
                    key={ws.path}
                    type="button"
                    className={css.menuItem}
                    data-active={bound === ws.path ? 'true' : undefined}
                    title={ws.path}
                    onClick={() => { void bind(ws.path) }}
                  >
                    <span className={css.menuName}>
                      {ws.name}
                      {ws.reports > 0 && <span className={css.menuBadge}>{ws.reports}</span>}
                    </span>
                    <span className={css.menuPath}>{ws.path}</span>
                    {bound === ws.path && <span className={css.menuTick}>✓</span>}
                  </button>
                ))}
                {workspaces !== null && workspaces.length === 0 && (
                  <div className={css.menuHint}>{t('panel.reportsBindEmpty')}</div>
                )}
                <div className={css.menuHint}>{t('panel.reportsBindHint')}</div>
              </div>
            </>
          )}
        </span>
        <span className={css.spacer} />
        <button
          type="button"
          className={css.iconBtn}
          onClick={() => { setRefreshKey((value) => value + 1) }}
          title={t('panel.reportsRefresh')}
          aria-label={t('panel.reportsRefresh')}
        >⟳</button>
        <button type="button" className={css.closeBtn} onClick={onClose} aria-label="close">×</button>
      </div>

      {!loading && !empty && (
        <div className={css.list}>
          {groupRows(rows ?? []).map(([folder, items]) => {
            const open = !isFolded(folder)
            return (
              <div key={folder} className={css.folderBlock}>
                <button
                  type="button"
                  className={css.folderRow}
                  aria-expanded={open}
                  onClick={() => { setFolded((prev) => ({ ...prev, [folder]: open })) }}
                >
                  <span className={css.folderCaret} data-open={open ? 'true' : undefined}>▸</span>
                  <span className={css.folderName}>{folder}</span>
                  <span className={css.folderCount}>{items.length}</span>
                </button>
                {open && items.map((row) => {
                  const signals = row.meta?.signals ?? 0
                  const label = dateLabel(row.name) ?? fileName(row.name)
                  const sub = [row.meta?.asOf === null || row.meta?.asOf === undefined ? '' : '', signals > 0 ? t('panel.reportsSignals', { count: signals }) : '']
                    .filter((part) => part !== '')
                    .join(' · ')
                  return (
                    <button
                      key={row.path}
                      type="button"
                      className={css.row}
                      data-active={currentPath === row.path ? 'true' : undefined}
                      title={`${row.meta?.line ?? ''} ${row.path}`.trim()}
                      onClick={() => { setCurrentPath(row.path) }}
                    >
                      <span className={css.rowMain}>
                        <span className={css.rowName}>{label}</span>
                        {sub !== '' && <span className={css.rowSub}>{sub}</span>}
                      </span>
                      <span className={css.rowMeta}>
                        {signals > 0 && <span className={css.badge} data-tone="warn">{signals}</span>}
                        <span className={css.time}>{stamp(row.mtime)}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      <div className={css.detailHead}>
        <span className={css.detailTitle} title={currentPath ?? ''}>
          {detail?.report?.line ?? (currentRow === null ? t('panel.reports') : fileName(currentRow.name))}
        </span>
        {detail?.report?.asOf != null && <span className={css.detailSub}>{detail.report.asOf}</span>}
        <span className={css.spacer} />
        {detail?.ok === true && detail.report !== undefined && (
          <span className={css.tabs}>
            <button
              type="button"
              className={css.tab}
              data-active={mode === 'structured' ? 'true' : undefined}
              onClick={() => { setMode('structured') }}
            >{t('panel.reportsStructured')}</button>
            <button
              type="button"
              className={css.tab}
              data-active={mode === 'raw' ? 'true' : undefined}
              onClick={() => { setMode('raw') }}
            >{t('panel.reportsRaw')}</button>
          </span>
        )}
      </div>

      <div className={css.body}>
        {loading && <div className={css.hint}>{t('panel.reportsLoading')}</div>}

        {empty && (
          <div className={css.hint}>
            <div className={css.hintTitle}>{bound === null ? t('panel.reportsEmpty') : t('panel.reportsBindEmpty')}</div>
            <div className={css.hintSub}>{t('panel.reportsEmptyHint')}</div>
            {root !== null && <div className={css.hintCode}>{t('panel.reportsRoot', { root })}</div>}
            {listError !== null && (
              <div className={css.hintCode}>{t('panel.reportsListFailed', { code: listError })}</div>
            )}
            <button type="button" className={css.retryBtn} onClick={() => { setRefreshKey((value) => value + 1) }}>
              {t('panel.reportsRetry')}
            </button>
          </div>
        )}

        {!loading && !empty && detail === null && currentPath !== null && (
          <div className={css.hint}>{t('panel.reportsLoading')}</div>
        )}

        {detail !== null && !detail.ok && (
          <div className={css.hint}>
            <div className={css.hintTitle}>{t('panel.reportsReadFailed', { code: errorText(detail.code, 'REPORTS_ERROR') })}</div>
            {root !== null && <div className={css.hintCode}>{t('panel.reportsRoot', { root })}</div>}
            <button type="button" className={css.retryBtn} onClick={() => { setRefreshKey((value) => value + 1) }}>
              {t('panel.reportsRetry')}
            </button>
          </div>
        )}

        {detail !== null && detail.ok && mode === 'structured' && (
          detail.report === undefined
            ? <div className={css.hint}>{t('panel.reportsReadFailed', { code: 'REPORTS_EMPTY' })}</div>
            : (
              <ReportView
                report={detail.report}
                signals={detail.signals ?? []}
                changes={detail.changes ?? []}
                t={t}
              />
            )
        )}

        {mode === 'raw' && detail?.ok === true && (
          raw === null
            ? <div className={css.hint}>{t('panel.reportsLoading')}</div>
            : raw.ok
              ? <pre className={css.raw}>{raw.text ?? ''}</pre>
              : <div className={css.hint}>{t('panel.reportsReadFailed', { code: errorText(raw.code, 'REPORTS_ERROR') })}</div>
        )}
      </div>
    </div>
  )
}
