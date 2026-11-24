/**
 * 左栏底部「模拟持仓」：填掉自选列表下方那片空白，并给出模拟盘的即时状态。
 *
 * 数据面直接订阅原版 `paperTradingStore`（本地撮合账本，localStorage 持久化），
 * 不新造取数逻辑、不引入第二份持仓真值；没有持仓时给可操作提示而不是空面板。
 */
import { useSyncExternalStore } from 'react'
import type { MarketLocaleKey } from '../trading/contract.ts'
import { paperTradingStore } from '../trading/paper-trading-store.ts'
import type { PaperPosition } from '../trading/paper-trading-store.ts'
import css from './left-positions.module.css'

type T = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

interface Props {
  t: T
  /** 打开右侧「资产」面板（看全部持仓/委托/成交）。 */
  onOpen: () => void
}

function money(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function qty(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

export function LeftPositions({ t, onOpen }: Props) {
  const account = useSyncExternalStore(
    listener => paperTradingStore.subscribe(listener),
    () => paperTradingStore.getAccount(),
  )
  const positions: PaperPosition[] = account.positions
  const invested = positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0)
  const total = account.cash + invested

  return (
    <section className={css.wrap} aria-label={t('trade.tab.positions')}>
      <div className={css.head}>
        <span className={css.title}>{t('trade.tab.positions')}</span>
        <button type="button" className={css.more} onClick={onOpen} title={t('trade.holdings.panel.open')}>
          {t('trade.holdings.panel.open')}
        </button>
      </div>

      <div className={css.sums}>
        <div className={css.sum}>
          <span className={css.sumLabel}>{t('trade.drawer.total')}</span>
          <span className={css.sumValue}>{money(total)}</span>
        </div>
        <div className={css.sum}>
          <span className={css.sumLabel}>{t('trade.paper.available')}</span>
          <span className={css.sumValue}>{money(account.cash)}</span>
        </div>
      </div>

      {positions.length === 0
        ? <p className={css.hint}>{t('trade.empty')}</p>
        : (
          <ul className={css.list}>
            {positions.map(p => (
              <li key={p.symbol}>
                <button type="button" className={css.row} onClick={onOpen} title={p.symbol}>
                  <span className={css.symbol}>{p.symbol}</span>
                  <span className={css.size}>{qty(p.size)}</span>
                  <span
                    className={css.pnl}
                    data-na={p.unrealizedPnl === undefined ? 'true' : undefined}
                    data-dir={p.unrealizedPnl === undefined ? undefined : (p.unrealizedPnl >= 0 ? 'up' : 'down')}
                  >
                    {p.unrealizedPnl === undefined
                      ? '—'
                      : `${p.unrealizedPnl >= 0 ? '+' : ''}${money(p.unrealizedPnl)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
