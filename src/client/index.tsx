/**
 * 交易工作台面板，browser half。与上游 dsh-trading 的差别只有壳层的挂载方式：
 *
 * 上游用 `shell.overlay` + `shell-pad.css` 接管宿主栅格（整包替换会话页）；
 * 本插件改为宿主公开契约里的「页面」形态：
 *   - `sidebar.panellist`（id = dshtrading-panel）→ 左侧导航行，点开即整页
 *   - `main`（key = dshtrading-panel，与行 id 同名）→ 整页内容 TradingPage
 * 数据面/服务/工具卡/同步逻辑与上游同源（这里逐条保留，不改业务代码）。
 *
 * 注意：`main` 选中时宿主不再挂载 conversation，页面里也没有对话列——这是
 * 公开契约的边界，页面几何按原版「行情区 + 380px 功能列 + 44px 竖条」重排。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ISessions, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IndicatorMarketScope, IndicatorRegistry } from '@dshtrading/indicators'
import type { Instrument, MarketId } from '../trading/types.ts'
import { createSelectionStore, createWatchlistGroupsStore, createWatchlistSortStore, createWatchlistStore } from '../trading/store.ts'
import { createChartStateStore } from '../trading/chart-state.ts'
import { indicators, unmarkCustomIndicator } from '../trading/indicator-registry.ts'
import { customIndicatorLoader } from '../trading/indicator-load.ts'
import { stageViews } from '../trading/stage-views.ts'
import { createTradingBridgeService } from '../trading/api.ts'
import { OrderCard, WatchlistChipCard } from '../trading/toolview.tsx'
import { marketFoldStore } from '../trading/fold-store.ts'
import { rightbarStore } from '../trading/rightbar-store.ts'
import { deleteCustomIndicator, subscribeTradingBridgeReady, subscribeTradingEvents } from '../trading/api.ts'
import { wireHostWatchlistSync } from '../trading/host-watchlist-sync.ts'
import { wireHostChartSync } from '../trading/host-chart-sync.ts'
import { en, zh } from '../trading/locales.ts'
import '../trading/tokens.css'
import { TradingPage } from './TradingPage.tsx'
import { TradingRow } from './TradingRow.tsx'

/** 左侧导航行 id 与 `main` key 必须同名（宿主按 id 选中 main 面板）。 */
const PANEL_ID = 'dshtrading-panel'
/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.market'

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

type SessionIdParam = SessionTarget

interface WorkspaceNavigation {
  startSession(workspaceId?: string): void
  openSession(sessionId: string): void
  forkSession(sessionId: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
}

/** 官方设置壳（sidebar.settings 槽 registrant）声明在槽上的 store 外形。 */
interface SettingsShellStoreFace {
  create(): { actions: { open(): void } }
}

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-trading-market: dictionaries')

  const selection = createSelectionStore()
  const watchlists = createWatchlistStore()
  const watchlistGroups = createWatchlistGroupsStore()
  const watchlistSort = createWatchlistSortStore()
  const chart = createChartStateStore(indicators)
  const sessions = ctx.sessions as unknown as ISessions

  const startNewSession = (): void => {
    ;(ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined)?.startSession()
  }

  const openSettings = (): void => {
    const mark = (path: string): void => {
      try { document.body.dataset.dshtradingSettingsPath = path } catch { /* SSR guard */ }
    }
    const ledger = ctx.slots as unknown as {
      entries(key: string): readonly { store?: SettingsShellStoreFace }[]
    }
    try {
      const entry = ledger.entries('sidebar.settings')[0]
      if (entry?.store !== undefined) {
        entry.store.create().actions.open()
        mark('store')
        return
      }
    } catch { /* 未挂设置壳或 store 外形变化 → 落到 DOM */ }
    const trigger = document.querySelector<HTMLElement>(
      "[data-slot='sidebar.settings'] [aria-haspopup='dialog'],"
      + " div:has(> [data-shell-overlay]) > div:nth-child(1) [aria-haspopup='dialog']",
    )
    if (trigger !== null) {
      trigger.click()
      mark('trigger')
      return
    }
    const launcher = document.querySelector<HTMLElement>("[data-slot='sidebar.settings'] [aria-haspopup='menu']")
    if (launcher === null) {
      // main 面板模式没有宿主侧栏/账号菜单：先退回会话壳（宿主侧栏重新挂载），
      // 再走同一条设置路径 —— 上游在 8888 整壳形态下也是一步到位。
      try {
        const layout = ctx.get('layout') as unknown as { selectPanel?: (id: string | null) => void } | undefined
        if (layout?.selectPanel !== undefined) {
          layout.selectPanel(null)
          setTimeout(openSettings, 260)
          mark('layout')
          return
        }
      } catch { /* 无 layout 服务 */ }
      mark('none')
      return
    }
    launcher.click()
    let tries = 0
    const pickMenuItem = (): void => {
      const item = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menu'] button"))
        .find((el) => /^\s*(设置|Settings)/.test(el.textContent ?? '')) // i18n-allow: 匹配宿主已渲染的菜单文案
      if (item !== undefined) {
        item.click()
        mark('menu')
        return
      }
      if (++tries < 4) setTimeout(pickMenuItem, 50)
    }
    setTimeout(pickMenuItem, 0)
  }

  const marketFolded = marketFoldStore()
  const toggleMarketFold = (): void => { marketFolded.toggle() }

  interface SidebarRightFace {
    openTab(kind: string): void
    isExpanded(): boolean
    toggleExpanded(): void
  }
  const rightbar = rightbarStore()
  const sidebarRight = (): SidebarRightFace | undefined =>
    ctx.get('sidebarRight', false) as SidebarRightFace | undefined
  const openFilesPanel = (): void => { sidebarRight()?.openTab('files') }
  const collapseRightbar = (): void => {
    const svc = sidebarRight()
    if (svc?.isExpanded()) svc.toggleExpanded()
  }

  ctx.slots.onEntryError((slot: string, _entry: unknown, error: unknown) => {
    console.error(`[dsh-trading] slot entry crashed: ${slot}`, error)
  })

  ctx.reflect.provide('tradingStageViews', stageViews)
  ctx.reflect.provide('tradingBridge', createTradingBridgeService())

  ctx.slots.inject('tool.call.toolview', function* () {
    for (const market of ['crypto', 'us', 'cn', 'hk', 'futures', 'global'] as const) {
      yield ctx.slots.register({
        name: 'tool.call.toolview',
        key: `${market}_place_order`,
        locale: NS,
      }, OrderCard as never)
    }
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'watchlist_add', locale: NS }, WatchlistChipCard as never)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'watchlist_select', locale: NS }, WatchlistChipCard as never)
  })

  ctx.inject(['tradingIndicators'] as never, (scope) => {
    const service = (scope as unknown as { tradingIndicators: IndicatorRegistry }).tradingIndicators
    for (const definition of service.list()) indicators.register(definition)
  })

  void customIndicatorLoader.load()
  subscribeTradingBridgeReady(() => { customIndicatorLoader.bridgeReady() })
  subscribeTradingEvents({
    indicators: () => { customIndicatorLoader.reload() },
  })

  wireHostWatchlistSync({ watchlists, selection, groups: watchlistGroups })
  wireHostChartSync({ chart })

  // 注入面：与上游 MarketDock/QuotePane/SessionRail 三处 inject 合并成页面的一份，
  // 组件内部再按左栏/中栏/右列分发（TradingPage 的 TradingFace）。
  const face = {
    hooks: { selection, chart, watchlists, marketFolded, groups: watchlistGroups, sortPrefs: watchlistSort },
    middle: {
      toggleIndicator: (id: string) => { chart.togglePreset(id) },
      setIndicatorParams: (id: string, params: Record<string, number>, scopeKey?: string) => { chart.setParams(id, params, scopeKey) },
      setIndicatorVisible: (id: string, visible: boolean, scopeKey?: string) => {
        const split = scopeKey !== undefined ? scopeKey.indexOf(':') : -1
        if (scopeKey === undefined || split <= 0) return
        chart.setSymbolVisibility(id, scopeKey.slice(0, split), scopeKey.slice(split + 1), visible)
      },
      setIndicatorScope: (id: string, market: MarketId, scope: IndicatorMarketScope | undefined) => {
        chart.setMarketScope(id, market, scope)
      },
      removeIndicator: (id: string) => { if (chart.isActive(id)) chart.togglePreset(id) },
      deleteIndicator: async (id: string) => {
        const ok = await deleteCustomIndicator(id)
        if (ok) {
          indicators.unregister(id)
          unmarkCustomIndicator(id)
          chart.removeInstance(id)
        }
        return ok
      },
    },
    sidebar: {
      addInstrument: (market: MarketId, instrument: Instrument) => { watchlists.add(market, instrument) },
      removeInstrument: (market: MarketId, symbol: string) => { watchlists.remove(market, symbol) },
      selectInstrument: (instrument: Instrument) => { selection.select(instrument) },
      toggleFold: toggleMarketFold,
      openSettings,
      createGroup: (name: string) => watchlistGroups.create(name),
      renameGroup: (id: string, name: string) => watchlistGroups.rename(id, name),
      deleteGroup: (id: string) => watchlistGroups.delete(id),
      assignGroupMember: (id: string, market: string, symbol: string, member: boolean, name?: string) =>
        watchlistGroups.assignMember(id, market, symbol, member, name),
      setActiveGroup: (id: string | null) => { watchlistGroups.setActiveGroup(id) },
      setPinned: (key: string, pinned: boolean) => watchlistGroups.setPinned(key, pinned),
      cycleSort: (zone: 'rows' | 'pinned') => watchlistSort.cycle(zone),
    },
    openFilesPanel,
    collapseRightbar,
    closePanel: () => {
      const layout = ctx.get('layout') as unknown as { selectPanel?: (id: string | null) => void } | undefined
      layout?.selectPanel?.(null)
    },
    openSession: (sessionId: string) => {
      ;(ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined)?.openSession(sessionId)
    },
    startNewSession,
    rightbar,
  }

  // 页面本体：`main` 槽在侧栏导航行被点击时渲染。
  ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ t }),
  }, ((props: { t: typeof t }) => (
    <TradingPage t={props.t} face={face} />
  )) as never)

  // 侧栏导航行：宿主负责整行的点击/选中态/文字，这里只给图标。
  ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 3,
    locale: NS,
    label: () => t('entry.title') || '交易工作台',
  }, ((owner: { size?: number } = {}) => <TradingRow size={owner.size ?? 16} />) as never)
}
