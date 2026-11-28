/**
 * dsh-trading-panel host half.
 *
 * 除本包的浏览器半（React 视图）外，这里只补一件宿主侧能力：`/dshtrading-panel/api/files`
 * —— 文件面板的目录列举与文本预览。上游把「文件」页签挂在宿主 sidebar-right dock 上，
 * 而 main 面板模式没有那座 dock；面板化后由本路由补上等价能力（root 可指向工作区）。
 *
 * 交易数据面（/dshtrading/api、SSE、定时任务）仍由 @dshtrading/bot-api 提供，
 * 连接器与账本由 @dshtrading/{base,cn,us,hk,crypto,futures,global} 提供。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseReport, reportChanges, reportSignals } from './watch-parse.ts'
import { nodeProbe, pickWatchRoot, type RootChoice } from './watch-root.ts'

export const name = 'dsh-trading-panel'

// 解析器与工作区判定对外导出，node 测试直接对真实报告断言（见 scripts/test-watch.mjs）。
export { parseReport, reportChanges, reportSignals, parseInline, plainText } from './watch-parse.ts'
export { nodeProbe, pickWatchRoot, reportsDir } from './watch-root.ts'
export type { ParsedReport, ReportSection, ReportBlock, ReportItem, ReportTable, Inline } from './watch-parse.ts'
export type { RootChoice, RootSource } from './watch-root.ts'

const MOUNT = '/dshtrading-panel/api/files'
const TEXT_LIMIT = 512 * 1024
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv'])

interface WebServerLike {
  register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }): () => void
}

interface ConnectionLike {
  requestRejection(req: IncomingMessage): number | undefined
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}


/**
 * 工作区根判定：逻辑在 src/watch-root.ts（显式配置 → 真有最新盯盘报告的工作区 →
 * 登记表最近更新 → cwd）。这里只做带 TTL 的缓存：报告目录会随时间出现（新跑一次
 * 盯盘脚本），永久缓存会把面板钉在启动瞬间的空目录上。
 */
const ROOT_TTL_MS = 60_000
let cachedRoot: { at: number; value: RootChoice } | null = null

function rootInfo(): RootChoice {
  const now = Date.now()
  if (cachedRoot === null || now - cachedRoot.at > ROOT_TTL_MS) {
    cachedRoot = { at: now, value: pickWatchRoot({ ...nodeProbe(), bound: readBound() }) }
  }
  return cachedRoot.value
}

/**
 * 面板上「绑定工作区」的落盘位置：`$DSH_HOME/dsh-trading-panel/settings.json`。
 * 绑定优先于自动探测（仅次于环境变量），换台机器/换个人装插件时各自维护自己的。
 */
const SETTINGS_DIR = path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'dsh-trading-panel')
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json')

function readBound(): string | null {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as { watchRoot?: unknown }
    const value = typeof raw.watchRoot === 'string' ? raw.watchRoot.trim() : ''
    return value === '' ? null : value
  } catch {
    return null
  }
}

function writeBound(value: string | null): void {
  mkdirSync(SETTINGS_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify({ watchRoot: value }, null, 2), 'utf8')
  cachedRoot = null
}

interface WorkspaceRow {
  path: string
  name: string
  reports: number
  latest: number
  updatedAt: string | null
}

/** 列登记表里的工作区，并标出各自有多少份盯盘报告（绑定选择器用）。 */
function listWorkspaces(): WorkspaceRow[] {
  const probe = nodeProbe()
  const text = probe.readText(path.join(probe.home, 'storages', 'workspace.json'))
  let rows: { path?: string; updatedAt?: string }[] = []
  if (text !== null) {
    try {
      const parsed = JSON.parse(text) as { tables?: { workspaces?: Record<string, { path?: string; updatedAt?: string }> } }
      rows = Object.values(parsed.tables?.workspaces ?? {})
    } catch { rows = [] }
  }
  const seen = new Set<string>()
  const out: WorkspaceRow[] = []
  for (const row of rows) {
    const dir = typeof row.path === 'string' ? row.path.trim() : ''
    if (dir === '') continue
    const key = dir.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    let reports = 0
    let latest = 0
    for (const rel of ['reports/watch', 'reports']) {
      let names: string[] = []
      try {
        names = readdirSync(path.join(dir, rel)).filter((n) => n.toLowerCase().endsWith('.md'))
      } catch { continue }
      if (names.length === 0) continue
      reports = names.length
      for (const n of names) {
        try {
          const m = statSync(path.join(dir, rel, n)).mtimeMs
          if (m > latest) latest = m
        } catch { /* 断链：跳过 */ }
      }
      break
    }
    out.push({ path: dir, name: path.basename(dir) || dir, reports, latest, updatedAt: row.updatedAt ?? null })
  }
  out.sort((a, b) => (b.latest - a.latest) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  return out
}

/** POST 的 JSON body：绑定请求体很小，超过 4KB 直接截断。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 4096) break
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function root(): string {
  return rootInfo().root
}

/** 相对路径归一：拒绝绝对路径与 `..` 越界，返回 root 内的绝对路径。 */
function insideRoot(rel: string): string | null {
  const base = path.resolve(root())
  const target = path.resolve(base, rel === '' ? '.' : rel)
  const normalizedBase = base.toLowerCase().endsWith(path.sep) ? base.toLowerCase() : base.toLowerCase() + path.sep
  if (target.toLowerCase() !== base.toLowerCase() && !target.toLowerCase().startsWith(normalizedBase)) return null
  return target
}

async function listDir(rel: string): Promise<unknown> {
  const target = insideRoot(rel)
  if (target === null) return { ok: false, code: 'FILES_OUT_OF_ROOT', message: 'path escapes workspace root' }
  const info = await stat(target)
  if (!info.isDirectory()) return { ok: false, code: 'FILES_NOT_A_DIRECTORY', message: 'not a directory' }
  const dirents = await readdir(target, { withFileTypes: true })
  const entries = await Promise.all(dirents
    .filter((d) => !SKIP.has(d.name))
    .map(async (d) => {
      const full = path.join(target, d.name)
      let size = 0
      let mtime = 0
      try {
        const s = await stat(full)
        size = s.size
        mtime = s.mtimeMs
      } catch { /* 断链/无权限：保留 0 */ }
      return { name: d.name, dir: d.isDirectory(), size, mtime }
    }))
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  const relNormalized = path.relative(path.resolve(root()), target).split(path.sep).join('/')
  const parent = relNormalized === '' ? null : (relNormalized.includes('/') ? relNormalized.slice(0, relNormalized.lastIndexOf('/')) : '')
  return { ok: true, root: root(), path: relNormalized, parent, entries }
}

/**
 * 列表用的轻量摘要：一栏里能看懂「哪条线、什么时候、几个信号、几跌几涨」，
 * 不用点进去读 markdown 符号。没有的数字如实留 0/null，不拼「0 涨」这类噪声。
 */
interface ReportMeta {
  line: string
  asOf: string | null
  signals: number
  up: number
  down: number
  worst: { name: string; delta: number } | null
}

function reportMeta(text: string): ReportMeta {
  const report = parseReport(text)
  const { up, down, worst, signals } = report.summary
  return { line: report.line, asOf: report.asOf, signals, up, down, worst }
}

/**
 * 近期盯盘报告：扫 `<workspace>/reports/watch/*.md`（没有就退 `reports/*.md`），
 * 按修改时间倒序，每行带上报告摘要（线名/时间/信号数/涨跌家数/最大跌幅）。
 * 摘要读不到只影响那一行，不影响列表本身。
 */
async function listReports(limit: number): Promise<unknown> {
  const base = path.resolve(root())
  for (const rel of ['reports/watch', 'reports']) {
    const dir = path.join(base, rel)
    if (!existsSync(dir)) continue
    const dirents = await readdir(dir, { withFileTypes: true })
    const rows = await Promise.all(dirents
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
      .map(async (d) => {
        const full = path.join(dir, d.name)
        let size = 0
        let mtime = 0
        try {
          const st = await stat(full)
          size = st.size
          mtime = st.mtimeMs
        } catch { /* 断链/无权限：保留 0 */ }
        let meta: ReportMeta | null = null
        try {
          meta = reportMeta((await readFile(full)).toString('utf8'))
        } catch { /* 正文读不到：该行没有摘要 */ }
        return { name: d.name, path: `${rel}/${d.name}`, size, mtime, meta }
      }))
    rows.sort((a, b) => b.mtime - a.mtime)
    // 目录在但没有 md（或全是子目录）时继续往下一个布局找，别停在空目录上。
    if (rows.length === 0) continue
    return {
      ok: true,
      root: base,
      source: rootInfo().source,
      dir: rel,
      entries: rows.slice(0, Math.max(1, Math.min(limit, 50))),
    }
  }
  return { ok: true, root: base, source: rootInfo().source, dir: null, entries: [] }
}

/**
 * 单份报告：结构化解析结果 + 信号/变化条目。浏览器半只渲染这些块，不再拼字符串；
 * 原文另走 /read（同一路径），「看原文」按钮用。
 */
async function readReport(rel: string): Promise<unknown> {
  const target = insideRoot(rel)
  if (target === null) return { ok: false, code: 'FILES_OUT_OF_ROOT', message: 'path escapes workspace root' }
  const info = await stat(target)
  if (info.isDirectory()) return { ok: false, code: 'FILES_IS_DIRECTORY', message: 'is a directory' }
  if (info.size > TEXT_LIMIT) return { ok: false, code: 'FILES_TOO_LARGE', message: `file larger than ${TEXT_LIMIT} bytes`, size: info.size }
  const buffer = await readFile(target)
  const report = parseReport(buffer.toString('utf8'))
  return {
    ok: true,
    root: rootInfo().root,
    source: rootInfo().source,
    path: rel,
    size: info.size,
    mtime: info.mtimeMs,
    report,
    signals: reportSignals(report),
    changes: reportChanges(report),
  }
}

async function readText(rel: string): Promise<unknown> {
  const target = insideRoot(rel)
  if (target === null) return { ok: false, code: 'FILES_OUT_OF_ROOT', message: 'path escapes workspace root' }
  const info = await stat(target)
  if (info.isDirectory()) return { ok: false, code: 'FILES_IS_DIRECTORY', message: 'is a directory' }
  if (info.size > TEXT_LIMIT) return { ok: false, code: 'FILES_TOO_LARGE', message: `file larger than ${TEXT_LIMIT} bytes`, size: info.size }
  const buffer = await readFile(target)
  if (buffer.includes(0)) return { ok: false, code: 'FILES_BINARY', message: 'binary file', size: info.size }
  return { ok: true, path: rel, size: info.size, text: buffer.toString('utf8') }
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/

/** 代理地址：显式 DSH_TRADING_PROXY 优先，其次环境里的 HTTPS_PROXY，最后猜常见的本地混合端口。 */
function pickProxy(): string | undefined {
  const explicit = process.env.DSHTRADING_PROXY
  if (explicit !== undefined && explicit !== '') return explicit
  const env = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (env !== undefined && env !== '') return env
  return 'http://127.0.0.1:12450'
}

/** 只做一次 TCP 探活：代理没开就不改动全局 fetch，避免把内网请求也带进代理。 */
async function proxyAlive(proxy: string, timeoutMs = 1500): Promise<string | true> {
  const net = await import('node:net')
  const target = new URL(proxy)
  const host = target.hostname === '' ? '127.0.0.1' : target.hostname
  const port = Number(target.port === '' ? '80' : target.port)
  return await new Promise<string | true>((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (value: string | true): void => { if (settled) return; settled = true; socket.destroy(); resolve(value) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(`timeout ${timeoutMs}ms`))
    socket.once('error', (error: NodeJS.ErrnoException) => finish(String(error.code ?? error.message)))
  })
}

/**
 * 上游行情出口：Yahoo 等海外数据源在国内直连会被 403/RST（`Yahoo chart AAPL: HTTP 403 Forbidden`）。
 * 探测到本机代理可用时，只把**外网** fetch 交给它；127.0.0.1 / localhost 仍是直连，
 * 否则插件自己的 /dshtrading/api 会绕进代理。探测失败则完全不动，保持原行为。
 */
function proxyDiag(line: string): void {
  try {
    writeFileSync(path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'dsh-trading-panel-proxy.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' })
  } catch { /* 诊断写盘失败不影响主流程 */ }
}

async function installProxyFetch(): Promise<void> {
  const proxy = pickProxy()
  const probe = proxy === undefined ? 'no-proxy' : await proxyAlive(proxy)
  proxyDiag(`pick=${String(proxy)} probe=${String(probe)} fetch=${typeof globalThis.fetch}`)
  if (proxy === undefined || probe !== true) return
  try {
    const undici = await import('undici')
    const agent = new undici.ProxyAgent(proxy)
    const original = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const passthrough = (): Promise<Response> => original(input, init)
      if (!(typeof input === 'string' || input instanceof URL)) return passthrough()
      const raw = typeof input === 'string' ? input : input.href
      let host: string
      try { host = new URL(raw).hostname } catch { return passthrough() }
      if (LOOPBACK.test(host)) return passthrough()
      return undici.fetch(raw, { ...(init as Record<string, unknown>), dispatcher: agent } as never) as unknown as Promise<Response>
    }) as typeof fetch
    proxyDiag(`installed agent for ${proxy}`)
    console.log(`[dsh-trading-panel] 外网行情经代理 ${proxy}`)
  } catch (error) {
    proxyDiag(`failed: ${error instanceof Error ? error.message : String(error)}`)
    console.log('[dsh-trading-panel] 代理引导跳过：', error instanceof Error ? error.message : String(error))
  }
}

export function apply(ctx: {
  inject(services: string[], fn: (sub: { get<T>(name: string): T | undefined }) => void): void
  effect(fn: () => (() => void), label?: string): void
}): void {
  void installProxyFetch()
  ctx.inject(['webServer', 'connection'], (sub) => {
    const webServer = sub.get<WebServerLike>('webServer')
    const connection = sub.get<ConnectionLike>('connection')
    if (webServer === undefined || connection === undefined) return
    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const sub2 = url.pathname.startsWith(MOUNT) ? url.pathname.slice(MOUNT.length) || '/' : url.pathname
      try {
        if (req.method === 'GET' && sub2 === '/list') {
          sendJson(res, 200, await listDir(url.searchParams.get('path') ?? ''))
          return
        }
        if (req.method === 'GET' && sub2 === '/read') {
          sendJson(res, 200, await readText(url.searchParams.get('path') ?? ''))
          return
        }
        if (req.method === 'GET' && sub2 === '/reports') {
          const limit = Number(url.searchParams.get('limit') ?? '8')
          sendJson(res, 200, await listReports(Number.isFinite(limit) ? limit : 8))
          return
        }
        if (req.method === 'GET' && (sub2 === '/watch/report' || sub2 === '/report')) {
          sendJson(res, 200, await readReport(url.searchParams.get('path') ?? ''))
          return
        }
        if (req.method === 'GET' && sub2 === '/watch/reports') {
          const aliasLimit = Number(url.searchParams.get('limit') ?? '20')
          sendJson(res, 200, await listReports(Number.isFinite(aliasLimit) ? aliasLimit : 20))
          return
        }
        if (req.method === 'GET' && sub2 === '/workspaces') {
          sendJson(res, 200, {
            ok: true,
            root: rootInfo().root,
            source: rootInfo().source,
            bound: readBound(),
            workspaces: listWorkspaces(),
          })
          return
        }
        if (req.method === 'POST' && sub2 === '/bind') {
          const body = await readJsonBody(req)
          const raw = typeof body.path === 'string' ? body.path.trim() : ''
          if (raw === '') { sendJson(res, 400, { ok: false, code: 'BIND_EMPTY', message: 'path is required' }); return }
          const target = path.resolve(raw)
          if (!existsSync(target) || !statSync(target).isDirectory()) {
            sendJson(res, 400, { ok: false, code: 'BIND_NOT_A_DIRECTORY', message: `not a directory: ${target}` })
            return
          }
          writeBound(target)
          sendJson(res, 200, { ok: true, ...rootInfo(), bound: target })
          return
        }
        if (req.method === 'POST' && sub2 === '/unbind') {
          writeBound(null)
          sendJson(res, 200, { ok: true, ...rootInfo(), bound: null })
          return
        }
        if (req.method === 'GET' && sub2 === '/root') {
          sendJson(res, 200, { ok: true, ...rootInfo() })
          return
        }
        sendJson(res, 404, { ok: false, code: 'FILES_ROUTE_NOT_FOUND', message: `unknown route: ${sub2}` })
      } catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? 'FILES_ERROR' : 'FILES_ERROR'
        sendJson(res, code === 'ENOENT' ? 404 : 400, {
          ok: false,
          code,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    ctx.effect(() => webServer.register({ kind: 'prefix', path: MOUNT, handler }), 'dsh-trading-panel: /dshtrading-panel/api/files route')
  })
}
