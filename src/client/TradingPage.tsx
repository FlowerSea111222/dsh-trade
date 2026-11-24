/**
 * 交易工作台整页（main 槽）：左 272px 自选栏 | 中 行情/策略/知识库 | 右 面板列 380px + 44px 竖条。
 *
 * 这是对 dsh-trading 原版「整包接管」壳的**同构重排**：原版把内容画在 shell.overlay
 * 上并用 shell-pad.css 改写宿主栅格；面板只能占一个 main 槽，于是把同一批组件
 * （MarketSidebar / MiddleStage / 五个右列面板）装进自建栅格里，几何按原版比例对齐：
 * 中栏 = 视口剩余宽度，右列 = 380px 面板 + 44px 竖条（原版对话列 + 竖条）。
 *
 * 数据面全部复用原版 client 模块（api.ts / store.ts / labels），不另起一套。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MarketLocaleKey } from '../trading/contract.ts'
import type { ChartState } from '../trading/chart-state.ts'
import type { IndicatorMarketScope } from '@dshtrading/indicators'
import type { FoldStore } from '../trading/fold-store.ts'
import type { Observable, SelectionState, WatchlistGroupOpResult, WatchlistGroupsState, WatchlistSortMode, WatchlistSortPrefs, WatchlistSortZone, Watchlists } from '../trading/store.ts'
import type { Instrument, MarketId } from '../trading/types.ts'
import { MarketSidebar } from '../trading/MarketSidebar.tsx'
import { MiddleStage } from '../trading/MiddleStage.tsx'
import { ScheduledTasksPanel } from '../trading/ScheduledTasksPanel.tsx'
import { FlashPanel } from '../trading/FlashPanel.tsx'
import { MacroPanel } from '../trading/MacroPanel.tsx'
import { PolymarketPanel } from '../trading/PolymarketPanel.tsx'
import { FilesPanel } from './FilesPanel.tsx'
import { ReportsPanel } from './ReportsPanel.tsx'
import {
  IconClose, IconClock, IconFlash, IconFolder, IconFoldPanel, IconGlobe, IconPrediction, IconReport,
  IconQuotes, IconSettings, IconUpdate, IconWallet, IconWatchlist,
} from '../trading/icons.tsx'
import dockCss from '../trading/market-dock.module.css'
import css from './page.module.css'

type T = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface TradingFace {
  hooks: {
    selection: Observable<SelectionState>
    chart: Observable<ChartState>
    watchlists: Observable<Watchlists>
    marketFolded: FoldStore
    groups: Observable<WatchlistGroupsState>
    sortPrefs: Observable<WatchlistSortPrefs>
  }
  middle: {
    toggleIndicator(id: string): void
    setIndicatorParams(id: string, params: Record<string, number>, scopeKey?: string): void
    setIndicatorVisible(id: string, visible: boolean, scopeKey?: string): void
    setIndicatorScope(id: string, market: MarketId, scope: IndicatorMarketScope | undefined): void
    removeIndicator(id: string): void
    deleteIndicator(id: string): Promise<boolean>
  }
  sidebar: {
    addInstrument(market: MarketId, instrument: Instrument): void
    removeInstrument(market: MarketId, symbol: string): void
    selectInstrument(instrument: Instrument): void
    toggleFold(): void
    openSettings(): void
    createGroup(name: string): Promise<WatchlistGroupOpResult>
    renameGroup(id: string, name: string): Promise<WatchlistGroupOpResult>
    deleteGroup(id: string): Promise<boolean>
    assignGroupMember(id: string, market: string, symbol: string, member: boolean, name?: string): Promise<boolean>
    setActiveGroup(id: string | null): void
    setPinned(key: string, pinned: boolean): Promise<boolean>
    cycleSort(zone: WatchlistSortZone): WatchlistSortMode
  }
  /** 文件页签走宿主右侧栏 dock（与原版 SessionRail 同一条通路）。 */
  openFilesPanel(): void
  collapseRightbar(): void
  /** 退回对话壳（面板占满主区时，宿主侧栏不渲染，只能自备出口）。 */
  closePanel(): void
  openSession(sessionId: string): void
  startNewSession(): void
}

/** Observable → useX(selector)（宿主 InjectFace 的 hooks 契约等价实现）。 */
function makeHook<T>(obs: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useObs<S>(selector: (value: T) => S): S {
    return useSyncExternalStore(obs.subscribe, () => selector(obs.getSnapshot()))
  }
}

/** 可拖拽列的宽度区间与持久化键（localStorage，纯前端偏好）。 */
const LEFT_W_KEY = 'dshtrading.panel.leftWidth'
const RIGHT_W_KEY = 'dshtrading.panel.rightWidth'
const LEFT_W_MIN = 200
const LEFT_W_MAX = 560
const RIGHT_W_MIN = 260
const RIGHT_W_MAX = 860
/** 中栏保底宽度：窗口再窄也不让左右两列把行情区挤没。 */
const CENTER_W_MIN = 380
/** 右缘竖条宽度（tabs 列）。 */
const RAIL_W = 44
/** 分栏手柄宽度。 */
const RESIZER_W = 5

function clampWidth(value: number, min: number, max: number, reserved = 0, avail?: number): number {
  // available 是面板自己的宽度（不是 window.innerWidth —— 面板只占宿主 main 区，
  // 宿主侧栏展开时会窄 280px，用窗口宽会算大）。reserved = 另一侧列宽。
  const width = avail ?? window.innerWidth
  const ceiling = Math.min(max, width - RAIL_W - 2 * RESIZER_W - reserved - CENTER_W_MIN)
  return Math.round(Math.max(min, Math.min(value, Math.max(min, ceiling))))
}

function storedWidth(key: string, fallback: number, reserved = 0): number {
  try {
    const raw = window.localStorage.getItem(key)
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) && value > 0 ? clampWidth(value, 120, 1200, reserved) : fallback
  } catch {
    return fallback
  }
}

type PanelId = 'tasks' | 'flash' | 'macro' | 'prediction' | 'files' | 'reports'

export function TradingPage({ t, face }: { t: T; face: TradingFace }) {
  const [panel, setPanel] = useState<PanelId | null>('reports')
  /** 从「盯盘报告」跳进文件面板时要定位的文件相对路径。 */
  const [filesPath, setFilesPath] = useState<string | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  /** 左右两列宽度：null = 用 CSS 的 clamp 默认值；拖过之后是像素值并落 localStorage。 */
  const [leftW, setLeftW] = useState<number | null>(() => (typeof window === 'undefined' ? null : storedWidth(LEFT_W_KEY, 0, 380) || null))
  const [rightW, setRightW] = useState<number | null>(() => (typeof window === 'undefined' ? null : storedWidth(RIGHT_W_KEY, 0, 272) || null))
  const leftRef = useRef<HTMLElement | null>(null)
  const rightRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (leftW === null) return
    try { window.localStorage.setItem(LEFT_W_KEY, String(leftW)) } catch { /* 隐私模式忽略 */ }
  }, [leftW])
  useEffect(() => {
    if (rightW === null) return
    try { window.localStorage.setItem(RIGHT_W_KEY, String(rightW)) } catch { /* 隐私模式忽略 */ }
  }, [rightW])

  /**
   * 拖动分栏：pointerdown 起监听、pointerup 收尾；宽度只在这里改。
   * 用 window 级监听而不是 pointer capture —— 指针移出面板时也要跟手。
   */
  /** 双击复位：回到 CSS 默认宽度，同时清掉持久化的值（否则下次进入又恢复旧宽度）。 */
  const resetWidth = (kind: 'left' | 'right'): void => {
    try { window.localStorage.removeItem(kind === 'left' ? LEFT_W_KEY : RIGHT_W_KEY) } catch { /* 忽略 */ }
    if (kind === 'left') setLeftW(null)
    else setRightW(null)
  }

  const beginResize = (kind: 'left' | 'right') => (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = kind === 'left'
      ? (leftRef.current?.getBoundingClientRect().width ?? 272)
      : (rightRef.current?.getBoundingClientRect().width ?? 380)
    // 面板实际宽度 + 另一侧列宽：拖动时给中栏留出位置，避免把行情区压到 0。
    const avail = leftRef.current?.parentElement?.clientWidth ?? window.innerWidth
    const otherWidth = kind === 'left'
      ? (rightRef.current?.getBoundingClientRect().width ?? 380)
      : (leftRef.current?.getBoundingClientRect().width ?? 272)
    const onMove = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - startX
      if (kind === 'left') setLeftW(clampWidth(startWidth + delta, LEFT_W_MIN, LEFT_W_MAX, otherWidth, avail))
      else setRightW(clampWidth(startWidth - delta, RIGHT_W_MIN, RIGHT_W_MAX, otherWidth, avail))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }


  const useSelection = makeHook(face.hooks.selection)
  const useChart = makeHook(face.hooks.chart)
  const useWatchlists = makeHook(face.hooks.watchlists)
  const useGroups = makeHook(face.hooks.groups)
  const useSortPrefs = makeHook(face.hooks.sortPrefs)
  const useMarketFolded = (selector: (value: boolean) => unknown) => leftCollapsed === selector(true)

  const toggle = (id: PanelId): void => {
    const next = panel === id ? null : id
    setPanel(next)
  }

  const close = (id: PanelId): void => {
    setPanel(null)
  }

  const tabs: { id: PanelId; icon: React.ReactNode; label: string; pressed: boolean; onClick(): void }[] = [
    { id: 'tasks', icon: <IconClock size={16} />, label: t('tasks.open'), pressed: panel === 'tasks', onClick: () => { toggle('tasks') } },
    { id: 'flash', icon: <IconFlash size={16} />, label: t('stage.flash'), pressed: panel === 'flash', onClick: () => { toggle('flash') } },
    { id: 'macro', icon: <IconGlobe size={16} />, label: t('stage.macro'), pressed: panel === 'macro', onClick: () => { toggle('macro') } },
    { id: 'files', icon: <IconFolder size={16} />, label: t('files.open'), pressed: panel === 'files', onClick: () => { toggle('files') } },
    { id: 'reports', icon: <IconReport size={16} />, label: t('panel.reports'), pressed: panel === 'reports', onClick: () => { toggle('reports') } },
    { id: 'prediction', icon: <IconPrediction size={16} />, label: t('stage.prediction'), pressed: panel === 'prediction', onClick: () => { toggle('prediction') } },
  ]

  return (
    <>
    <div className={css.page} data-dshtrading-panel-page="">
      {/* 面板模式没有宿主标题栏：自带一条细顶栏，标题 + 当前标的 + 明显的「退出」。 */}
      <header className={css.header}>
        <span className={css.headerTitle}>{t('entry.title') || '交易工作台'}</span>
        <button
          type="button"
          className={css.headerExit}
          aria-label={t('rail.exit') || '退出'}
          title={t('rail.exit') || '退出'}
          onClick={() => { face.closePanel() }}
        >
          <IconClose size={14} />
          {t('panel.exit') || '退出'}
        </button>
      </header>

      <div className={css.body}>
      {leftCollapsed ? (
        // 折叠态对齐原版 MarketDock：左缘 44px 竖条（展开/自选/行情 + 底部更新与设置）。
        <aside className={css.leftFolded} data-dshtrading-panel-left="" data-folded="true">
          <div className={dockCss.rail} role="toolbar" aria-orientation="vertical">
            <button
              type="button"
              className={dockCss.railButton}
              aria-label={t('sidebar.expand')}
              title={t('sidebar.expand')}
              onClick={() => { setLeftCollapsed(false) }}
            >
              <IconFoldPanel size={16} />
            </button>
            <button
              type="button"
              className={dockCss.railButton}
              data-active="true"
              aria-label={t('tab.watch')}
              title={t('tab.watch')}
              onClick={() => { setLeftCollapsed(false) }}
            >
              <IconWatchlist size={16} />
            </button>
            <div className={dockCss.railDivider} aria-hidden="true" />
            <button
              type="button"
              className={dockCss.railButton}
              aria-label={t('stage.quote')}
              title={t('stage.quote')}
              onClick={() => { setLeftCollapsed(false) }}
            >
              <IconQuotes size={16} />
            </button>
            <button
              type="button"
              className={dockCss.railButton + ' ' + dockCss.railUpdate}
              aria-label={t('entry.update')}
              title={t('entry.update')}
              onClick={() => { window.dispatchEvent(new CustomEvent('dshtrading-updater-open')) }}
            >
              <IconUpdate size={16} />
            </button>
            <button
              type="button"
              className={dockCss.railButton + ' ' + dockCss.railSettings}
              aria-label={t('entry.settings')}
              title={t('entry.settings')}
              onClick={() => { face.sidebar.openSettings() }}
            >
              <IconSettings size={16} />
            </button>
          </div>
        </aside>
      ) : (
        <aside
          className={css.left}
          data-dshtrading-panel-left=""
          ref={leftRef}
          style={leftW === null ? undefined : { flexBasis: leftW, width: leftW }}
        >
          <MarketSidebar
            t={t}
            useSelection={useSelection}
            useWatchlists={useWatchlists}
            useGroups={useGroups}
            useSortPrefs={useSortPrefs}
            useMarketFolded={useMarketFolded}
            addInstrument={face.sidebar.addInstrument}
            removeInstrument={face.sidebar.removeInstrument}
            selectInstrument={face.sidebar.selectInstrument}
            openSettings={face.sidebar.openSettings}
            createGroup={face.sidebar.createGroup}
            renameGroup={face.sidebar.renameGroup}
            deleteGroup={face.sidebar.deleteGroup}
            assignGroupMember={face.sidebar.assignGroupMember}
            setActiveGroup={face.sidebar.setActiveGroup}
            setPinned={face.sidebar.setPinned}
            cycleSort={face.sidebar.cycleSort}
            onFold={() => { setLeftCollapsed(true) }}
                      />
        </aside>
      )}

      {!leftCollapsed && (
        <div
          className={css.resizer}
          data-dshtrading-panel-resizer="left"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('panel.resizeLeft') || '调整自选栏宽度'}
          title={t('panel.resizeLeft') || '调整自选栏宽度'}
          onPointerDown={beginResize('left')}
          onDoubleClick={() => { resetWidth('left') }}
        />
      )}

      <main className={css.center} data-dshtrading-panel-center="">
        <MiddleStage
          t={t}
          useSelection={useSelection}
          useChart={useChart}
          toggleIndicator={face.middle.toggleIndicator}
          setIndicatorParams={face.middle.setIndicatorParams}
          setIndicatorVisible={face.middle.setIndicatorVisible}
          setIndicatorScope={face.middle.setIndicatorScope}
          removeIndicator={face.middle.removeIndicator}
          deleteIndicator={face.middle.deleteIndicator}
        />
      </main>

      <div className={css.rightArea}>
        {panel !== null && (
          <div
            className={css.resizer}
            data-dshtrading-panel-resizer="right"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('panel.resizeRight') || '调整右侧面板宽度'}
            title={t('panel.resizeRight') || '调整右侧面板宽度'}
            onPointerDown={beginResize('right')}
            onDoubleClick={() => { resetWidth('right') }}
          />
        )}
        {panel !== null && (
          <div
            className={css.panelCol}
            data-dshtrading-panel-col=""
            ref={rightRef}
            style={rightW === null ? undefined : { flexBasis: rightW, width: rightW }}
          >
            <div className={css.panelSlot}>
              {panel === 'tasks' && (
                <ScheduledTasksPanel
                  t={t}
                  openSession={(sessionId: string) => { setPanel(null); face.openSession(sessionId) }}
                  close={() => { close('tasks') }}
                />
              )}
              {panel === 'flash' && <FlashPanel t={t} onClose={() => { close('flash') }} />}
              {panel === 'macro' && <MacroPanel t={t} onClose={() => { close('macro') }} />}
              {panel === 'prediction' && <PolymarketPanel t={t} onClose={() => { close('prediction') }} />}
              {panel === 'files' && <FilesPanel t={t} initialPath={filesPath} onClose={() => { close('files') }} />}
              {panel === 'reports' && <ReportsPanel t={t} onClose={() => { close('reports') }} />}
            </div>
          </div>
        )}

        <nav className={css.rail} role="toolbar" aria-orientation="vertical" data-dshtrading-panel-rail="">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              className={css.railBtn}
              aria-pressed={tab.pressed}
              aria-label={tab.label}
              title={tab.label}
              onClick={tab.onClick}
            >
              {tab.icon}
            </button>
          ))}
          <div className={css.railSpacer} />

          {/* 面板占满整个主区、宿主侧栏不渲染，必须自带「回到对话」的出口。 */}
          <button
            type="button"
            className={css.railBtn}
            aria-label={t('rail.exit') || '退出'}
            title={t('rail.exit') || '退出'}
            onClick={() => { face.closePanel() }}
          >
            <IconClose size={16} />
          </button>
        </nav>
      </div>
      </div>
    </div>
    </>
  )
}
