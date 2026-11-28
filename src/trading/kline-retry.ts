/**
 * K 线取数的退避重试 + 失败归因（纯函数，不依赖 React/DOM）。
 *
 * 为什么需要（2026-11-25 诊断）：腾讯 fqkline 的日/周/月端点被自家 WAF 间歇拦成
 * HTTP 501，连接器把 5xx 折成 `TRADING_EXCHANGE_ERROR`，而桥的跨源兜底只认
 * `TRADING_NETWORK` / `TRADING_UPSTREAM_ERROR` —— 于是同标的同周期明明别的源有数据，
 * 也被当成业务错误原样抛到界面，一次抖动就让图表整块空白。
 *
 * 这里只做两件不改变数据链路的事：
 * 1. 对**确实是瞬态**的失败（5xx / 网络 / 429 / 上游非 JSON 拦截页）按 1s、3s 退避重试；
 * 2. 把最终失败归因成「已重试几次 + 原始 code/message」两块，供横幅给人看的那句话与
 *    「详情」折叠共用。符号/周期不认识、权限缺失这类重试无用的失败不重试，也不吞掉。
 */

/** 退避档位：首次失败后 1s 再试，仍失败 3s 后再试，仍失败才报错（共 3 次取数）。 */
export const KLINE_RETRY_DELAYS_MS = [1_000, 3_000] as const

/** 桥/连接器里明确属于「过一会儿可能就好了」的错误码。 */
const TRANSIENT_CODES = new Set(['TRADING_NETWORK', 'TRADING_UPSTREAM_ERROR', 'TRADING_RATE_LIMITED'])

/**
 * 消息层面的瞬态特征。`TRADING_EXCHANGE_ERROR` 是个大口袋（4xx/5xx/拦截页都往里装），
 * 只能看原文：连接器保留了 `HTTP 501 Not Implemented`、`non-JSON payload`、`ECONNRESET`
 * 这类可判别片段，据此把「上游临时拦截」与「这个标的没有数据」分开。
 */
const TRANSIENT_MESSAGE = /\bHTTP 5\d\d\b|non-JSON payload|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i

type Errorish = { code?: unknown; status?: unknown; message?: unknown }

const asErrorish = (error: unknown): Errorish => (typeof error === 'object' && error !== null ? (error as Errorish) : {})

/** 原始错误文本（保留 code 前缀与上游 URL，报告/「详情」直接展示，不做二次改写）。 */
export function errorText(error: unknown): string {
  return String((error as { message?: string })?.message ?? error)
}

/**
 * 排障用的完整详情：桥有两条错误路径——HTTP 非 2xx 抛 `BridgeError(status, 'bridge …')`
 * 时 message 里没有 code，业务信封（HTTP 200 + ok:false）时 message 已带 `CODE: ` 前缀。
 * 这里统一补上前缀（已有就不重复），原始上游 URL 仍留在 message 里。
 */
export function errorDetail(error: unknown): string {
  const message = errorText(error)
  const code = (error as { code?: unknown })?.code
  if (typeof code !== 'string' || code === '' || message.startsWith(`${code}:`)) return message
  return `${code}: ${message}`
}

/** 这次失败是否值得重试；符号/周期不认识等确定性失败返回 false。 */
export function isTransientKlineError(error: unknown): boolean {
  const e = asErrorish(error)
  if (typeof e.status === 'number' && e.status >= 500) return true
  const code = typeof e.code === 'string' ? e.code : undefined
  if (code !== undefined && TRANSIENT_CODES.has(code)) return true
  if (code === 'TRADING_EXCHANGE_ERROR') return TRANSIENT_MESSAGE.test(errorText(error))
  return TRANSIENT_MESSAGE.test(errorText(error))
}

/** 最终失败：带上「已重试几次」，原始错误挂在 cause 上，一律不吞。 */
export class KlineLoadFailure extends Error {
  readonly retried: number
  readonly detail: string

  constructor(cause: unknown, retried: number) {
    super(errorText(cause))
    this.name = 'KlineLoadFailure'
    this.retried = retried
    this.detail = errorDetail(cause)
    this.cause = cause
  }
}

/** 把任意异常归一成横幅要的两块信息（已重试次数 + 原始详情）。 */
export function describeKlineFailure(error: unknown): { retried: number; detail: string } {
  if (error instanceof KlineLoadFailure) return { retried: error.retried, detail: error.detail }
  return { retried: 0, detail: errorDetail(error) }
}

export interface KlineRetryOptions {
  /** 覆盖退避档位（测试用）。 */
  delays?: readonly number[]
  /** 覆盖 sleep（测试用，避免真等）。 */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/**
 * 取一次 K 线，失败且属瞬态时按 `delays` 退避重试；成功返回 `{ value, retried }`，
 * 最终失败抛 `KlineLoadFailure`（含已重试次数与原始错误）。
 */
export async function withKlineRetry<T>(run: () => Promise<T>, options: KlineRetryOptions = {}): Promise<{ value: T; retried: number }> {
  const delays = options.delays ?? KLINE_RETRY_DELAYS_MS
  const sleep = options.sleep ?? defaultSleep
  let retried = 0
  for (;;) {
    try {
      return { value: await run(), retried }
    } catch (error) {
      if (!isTransientKlineError(error) || retried >= delays.length) throw new KlineLoadFailure(error, retried)
      const delay = delays[retried]
      retried += 1
      await sleep(delay ?? 0)
    }
  }
}
