/**
 * 当日分时图（2026-11-24）：K 线区域里替代蜡烛图的一种视图。
 *
 * - 取数：1m K 线（连接器不支持时降 5m），只保留「最后一根 bar 所在市场本地交易日」的 bar
 *   ——非交易日时自动落到最近一个交易日，不需要维护节假日历。
 * - 画法：现价面积线（涨红跌绿，跟全局色板同源）+ 均价线（成交额加权）+ 昨收基准虚线。
 * - 实时：5s 轮询增量重取，配合每根 bar 的最后一价推进，盘中波动即时可见。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { AreaSeries, ColorType, CrosshairMode, LineSeries, LineStyle, createChart } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'
import { fetchKlines } from './api.ts'
import type { Kline, MarketId } from './types.ts'
import { getColorPalette, type ColorMode } from './color-mode.ts'
import { MARKET_TIMEZONE, marketLocalDay } from './market-time.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './intraday-chart.module.css'

const POLL_MS = 5000
const CANDIDATES = ['1m', '5m'] as const

export type Translate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export interface IntradayChartProps {
  market: MarketId
  symbol: string
  prevClose: number | undefined
  colorMode: ColorMode
  t: Translate
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function clockLabel(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function pricePrecision(values: readonly number[]): number {
  const sample = values.find(value => Number.isFinite(value) && value > 0)
  if (sample === undefined) return 2
  if (sample < 1) return 4
  if (sample < 10) return 3
  return 2
}

/** 只保留最后一根 bar 所在的市场本地交易日；时区未知（global）时原样返回。 */
function todayBars(market: MarketId, klines: readonly Kline[]): Kline[] {
  if (klines.length === 0) return []
  const tz = MARKET_TIMEZONE[market]
  if (tz === null || tz === undefined) return [...klines]
  const last = klines[klines.length - 1] as Kline
  const day = marketLocalDay(tz, last.openTime)
  return klines.filter(k => marketLocalDay(tz, k.openTime) === day)
}

export function IntradayChart({ market, symbol, prevClose, colorMode, t }: IntradayChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const priceRef = useRef<ISeriesApi<'Area'> | null>(null)
  const avgRef = useRef<ISeriesApi<'Line'> | null>(null)
  const referenceRef = useRef<ISeriesApi<'Line'> | null>(null)
  const [bars, setBars] = useState<Kline[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState<number>(0)
  const palette = getColorPalette(colorMode)

  // 取数：1m 优先，失败降 5m；5s 一拍（盘中实时波动）。
  useEffect(() => {
    if (symbol === '') return
    let cancelled = false
    let intervalIndex = 0
    const load = async (): Promise<void> => {
      for (let attempt = intervalIndex; attempt < CANDIDATES.length; attempt += 1) {
        const interval = CANDIDATES[attempt] as string
        try {
          const rows = await fetchKlines(market, symbol, interval, interval === '1m' ? 500 : 400)
          if (cancelled) return
          intervalIndex = attempt
          setBars(todayBars(market, rows))
          setError(null)
          setTick(Date.now())
          return
        } catch {
          if (cancelled) return
          // 该粒度不支持 → 换下一档；全都不支持则报错。
        }
      }
      if (!cancelled) {
        setBars([])
        setError('INTRADAY_UNSUPPORTED')
        setTick(Date.now())
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [market, symbol])

  const lastClose = bars.length > 0 ? (bars[bars.length - 1] as Kline).close : undefined
  const base = prevClose !== undefined && prevClose > 0 ? prevClose : bars.length > 0 ? (bars[0] as Kline).open : undefined
  const up = lastClose !== undefined && base !== undefined ? lastClose >= base : true
  const lineColor = up ? palette.upColor : palette.downColor
  const precision = useMemo(() => pricePrecision(bars.map(bar => bar.close)), [bars])
  // 均价 = 累计成交额 / 累计成交量（与线一致；无成交量时 undefined）。
  const avgPrice = useMemo(() => {
    let volumeSum = 0
    let amountSum = 0
    for (const bar of bars) {
      const volume = Number.isFinite(bar.volume) ? bar.volume : 0
      volumeSum += volume
      amountSum += volume * bar.close
    }
    return volumeSum > 0 ? amountSum / volumeSum : undefined
  }, [bars])

  // 建图：只在换标的时重建；配色/精度用 applyOptions 原地改（重建会把正在进行的
  // setData 打断成 "Object is disposed"）。
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const chart = createChart(host, {
      autoSize: false,
      width: host.clientWidth,
      height: host.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8a8f99',
        fontSize: 11,
        fontFamily: 'inherit',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(128, 138, 153, 0.10)' },
        horzLines: { color: 'rgba(128, 138, 153, 0.10)' },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        barSpacing: 3,
        // 默认刻度按 UTC 显示，A股会显示成 03:00；这里换成市场本地时刻。
        tickMarkFormatter: (time: number) => clockLabel(time * 1000),
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        timeFormatter: (time: number) => clockLabel(time * 1000),
      },
    })
    chartRef.current = chart
    priceRef.current = chart.addSeries(AreaSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    avgRef.current = chart.addSeries(LineSeries, {
      color: '#e6b23a',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    referenceRef.current = chart.addSeries(LineSeries, {
      color: 'rgba(128, 138, 153, 0.75)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    const onResize = (): void => {
      if (chartRef.current === null) return
      chart.resize(host.clientWidth, host.clientHeight)
    }
    const observer = new ResizeObserver(onResize)
    observer.observe(host)
    return () => {
      observer.disconnect()
      chart.remove()
      chartRef.current = null
      priceRef.current = null
      avgRef.current = null
      referenceRef.current = null
    }
  }, [market, symbol])

  // 配色 / 价格精度（涨跌方向、主题色板变化时原地更新）。
  useEffect(() => {
    const price = priceRef.current
    if (price === null) return
    price.applyOptions({
      lineColor,
      topColor: up ? palette.upAlpha(0.28) : palette.downAlpha(0.28),
      bottomColor: up ? palette.upAlpha(0.02) : palette.downAlpha(0.02),
      priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
    })
    chartRef.current?.applyOptions({
      localization: { priceFormatter: (value: number) => value.toFixed(precision) },
    })
  }, [lineColor, up, palette, precision])

  // 数据落地：现价线 + 均价线 + 昨收基准。
  useEffect(() => {
    const price = priceRef.current
    const avg = avgRef.current
    const reference = referenceRef.current
    if (price === null || avg === null || reference === null) return
    let volumeSum = 0
    let amountSum = 0
    const pricePoints: Array<{ time: UTCTimestamp; value: number }> = []
    const avgPoints: Array<{ time: UTCTimestamp; value: number }> = []
    for (const bar of bars) {
      const time = Math.floor(bar.openTime / 1000) as UTCTimestamp
      pricePoints.push({ time, value: bar.close })
      volumeSum += Number.isFinite(bar.volume) ? bar.volume : 0
      amountSum += (Number.isFinite(bar.volume) ? bar.volume : 0) * bar.close
      if (volumeSum > 0) avgPoints.push({ time, value: amountSum / volumeSum })
    }
    price.setData(pricePoints)
    avg.setData(avgPoints)
    reference.setData(base !== undefined && pricePoints.length > 0
      ? [{ time: pricePoints[0]!.time, value: base }, { time: pricePoints[pricePoints.length - 1]!.time, value: base }]
      : [])
  }, [bars, base])

  const change = lastClose !== undefined && base !== undefined && base > 0 ? ((lastClose - base) / base) * 100 : undefined

  return (
    <div className={css.wrap} data-dshtrading-intraday="">
      <div className={css.legend}>
        <span className={css.legendItem} style={{ color: lineColor }}>
          {t('intraday.price')} {lastClose !== undefined ? lastClose.toFixed(precision) : '—'}
        </span>
        <span className={css.legendItem} style={{ color: lineColor }}>
          {change !== undefined ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—'}
        </span>
        <span className={css.legendItem} style={{ color: '#e6b23a' }}>
          {t('intraday.avg')} {avgPrice !== undefined ? avgPrice.toFixed(precision) : '—'}
        </span>
        <span className={css.legendItem}>{t('intraday.base')} {base !== undefined ? base.toFixed(precision) : '—'}</span>
        <span className={css.legendSpacer} />
        <span className={css.legendHint} data-stale={Date.now() - tick > POLL_MS * 3 ? 'true' : undefined}>
          {t('intraday.live')} · {clockLabel(tick)}
        </span>
      </div>
      <div className={css.chart} ref={hostRef} />
      {error !== null && <div className={css.empty}>{t('intraday.unavailable')}</div>}
      {error === null && bars.length === 0 && <div className={css.empty}>{t('intraday.loading')}</div>}
    </div>
  )
}
