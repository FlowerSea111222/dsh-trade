/**
 * 文件面板（右缘竖条的文件夹按钮）。
 *
 * 上游把「文件」页签挂在宿主 sidebar-right dock 上（`sidebarRight.openTab('files')`），
 * 但 `main` 面板模式下没有那座 dock —— 面板化后文件能力由本组件 + 宿主路由
 * `/dshtrading-panel/api/files/{list,read}` 补上，位置与原版一致（380px 右列）。
 */
import { useEffect, useMemo, useState } from 'react'
import css from './files-panel.module.css'

const MOUNT = '/dshtrading-panel/api/files'
const PREVIEW_LIMIT = 512 * 1024

interface DirEntry {
  name: string
  dir: boolean
  size: number
  mtime: number
}

interface ListWire {
  ok: boolean
  root?: string
  path?: string
  parent?: string | null
  entries?: DirEntry[]
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

export interface FilesPanelProps {
  t: (key: 'files.open') => string
  /** 关闭面板（竖条按钮/头部 ×）。 */
  /** 打开时定位到的相对路径（文件则直接预览，目录则进入该目录）。 */
  initialPath?: string | null
  onClose(): void
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function joinRel(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`
}

export function FilesPanel({ t, initialPath, onClose }: FilesPanelProps) {
  const initial = initialPath !== undefined && initialPath !== null && initialPath !== '' ? initialPath : null
  const initialDir = initial === null ? '' : (initial.includes('/') ? initial.slice(0, initial.lastIndexOf('/')) : '')
  const initialName = initial === null ? null : (initial.includes('/') ? initial.slice(initial.lastIndexOf('/') + 1) : initial)
  const [rel, setRel] = useState(initialDir)
  const [list, setList] = useState<ListWire | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [selected, setSelected] = useState<string | null>(initialName)
  const [preview, setPreview] = useState<ReadWire | null>(null)

  // 从「盯盘报告」跳进来：直接取该文件正文（列表照样按目录加载，供上下文浏览）。
  useEffect(() => {
    if (initial === null) return
    let cancelled = false
    void fetch(`${MOUNT}/read?path=${encodeURIComponent(initial)}`, { headers: { accept: 'application/json' } })
      .then(async (response) => (await response.json()) as ReadWire)
      .then((wire) => { if (!cancelled) setPreview(wire) })
      .catch(() => { if (!cancelled) setPreview({ ok: false, code: 'FILES_FETCH_FAILED', message: 'read failed' }) })
    return () => { cancelled = true }
  }, [initial])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    void fetch(`${MOUNT}/list?path=${encodeURIComponent(rel)}`, { headers: { accept: 'application/json' } })
      .then(async (response) => (await response.json()) as ListWire)
      .then((wire) => {
        if (cancelled) return
        setList(wire)
        setStatus(wire.ok ? 'ready' : 'error')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => { cancelled = true }
  }, [rel])

  const openEntry = (entry: DirEntry): void => {
    if (entry.dir) {
      setSelected(null)
      setPreview(null)
      setRel(joinRel(rel, entry.name))
      return
    }
    setSelected(entry.name)
    setPreview(null)
    void fetch(`${MOUNT}/read?path=${encodeURIComponent(joinRel(rel, entry.name))}`, { headers: { accept: 'application/json' } })
      .then(async (response) => (await response.json()) as ReadWire)
      .then((wire) => { setPreview(wire) })
      .catch(() => { setPreview({ ok: false, code: 'FILES_FETCH_FAILED', message: 'read failed' }) })
  }

  const crumbs = useMemo(() => {
    const parts = rel === '' ? [] : rel.split('/')
    return [{ label: list?.root?.split(/[\\/]/).filter(Boolean).pop() ?? 'root', path: '' }]
      .concat(parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join('/') })))
  }, [rel, list?.root])

  return (
    <div className={css.panel}>
      <div className={css.head}>
        <span className={css.title}>{t('files.open')}</span>
        <span className={css.spacer} />
        <button type="button" className={css.closeBtn} onClick={onClose} aria-label="close">×</button>
      </div>
      <div className={css.crumbs}>
        {crumbs.map((crumb, index) => (
          <span key={crumb.path === '' ? 'root' : crumb.path} className={css.crumbWrap}>
            {index > 0 && <span className={css.sep}>/</span>}
            <button
              type="button"
              className={css.crumb}
              data-active={crumb.path === rel ? 'true' : undefined}
              onClick={() => { setRel(crumb.path); setSelected(null); setPreview(null) }}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </div>
      <div className={css.body}>
        {status === 'loading' && <div className={css.hint}>载入中…</div>}
        {status === 'error' && (
          <div className={css.hint}>{list?.code ?? 'FILES_ERROR'} · {list?.message ?? '无法读取目录'}</div>
        )}
        {status === 'ready' && (
          <ul className={css.list}>
            {rel !== '' && list?.parent !== null && list?.parent !== undefined && (
              <li>
                <button type="button" className={css.row} onClick={() => { setRel(list.parent ?? ''); setSelected(null); setPreview(null) }}>
                  <span className={css.icon}>↰</span>
                  <span className={css.name}>..</span>
                </button>
              </li>
            )}
            {(list?.entries ?? []).map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className={css.row}
                  data-active={selected === entry.name ? 'true' : undefined}
                  onClick={() => { openEntry(entry) }}
                >
                  <span className={css.icon} data-dir={entry.dir ? 'true' : undefined}>{entry.dir ? '▸' : '·'}</span>
                  <span className={css.name}>{entry.name}</span>
                  {!entry.dir && <span className={css.size}>{formatSize(entry.size)}</span>}
                </button>
              </li>
            ))}
            {(list?.entries ?? []).length === 0 && <li className={css.hint}>空目录</li>}
          </ul>
        )}
        {preview !== null && (
          <div className={css.preview}>
            <div className={css.previewHead}>
              <span className={css.previewName}>{selected}</span>
              {preview.ok && <span className={css.size}>{formatSize(preview.size ?? 0)}</span>}
            </div>
            {preview.ok
              ? <pre className={css.pre}>{preview.text?.slice(0, PREVIEW_LIMIT)}</pre>
              : <div className={css.hint}>{preview.code} · {preview.message}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
