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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'dsh-trading-panel'

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

/** 工作区根：显式环境变量优先，其次取 DSH 工作区登记表里默认工作区的 path。 */
function resolveRoot(): string {
  const explicit = process.env.DSH_TRADING_FILES_ROOT
  if (explicit !== undefined && explicit !== '') return explicit
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  try {
    const file = path.join(home, 'storages', 'workspace.json')
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        global?: { defaultWorkspaceId?: string }
        tables?: { workspaces?: Record<string, { path?: string; updatedAt?: string }> }
      }
      const rows = parsed.tables?.workspaces ?? {}
      // 取最近更新的工作区：defaultWorkspaceId 只是「默认」的一个，用户真正在用的
      // 往往是最新那个（面板无会话上下文可读，只能按登记表时间推断）。
      const entries = Object.values(rows).filter((row) => row?.path !== undefined && row.path !== '')
      entries.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      const preferred = parsed.global?.defaultWorkspaceId
      const picked = entries[0] ?? (preferred !== undefined ? rows[preferred] : undefined)
      if (picked?.path !== undefined && picked.path !== '') return picked.path
    }
  } catch { /* 登记表缺失/损坏 → 退回 cwd */ }
  return process.cwd()
}

let cachedRoot: string | null = null
function root(): string {
  cachedRoot ??= resolveRoot()
  return cachedRoot
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
 * 近期盯盘报告：扫 `<workspace>/reports/watch/*.md`（没有就退 `reports/*.md`），
 * 按修改时间倒序。左栏「盯盘报告」用它把工作区里真实产出的日报列出来——
 * 只读、只列文件名与时间，正文仍走 /read 预览。
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
        let size = 0
        let mtime = 0
        try {
          const st = await stat(path.join(dir, d.name))
          size = st.size
          mtime = st.mtimeMs
        } catch { /* 断链/无权限：保留 0 */ }
        return { name: d.name, path: `${rel}/${d.name}`, size, mtime }
      }))
    rows.sort((a, b) => b.mtime - a.mtime)
    return { ok: true, dir: rel, entries: rows.slice(0, Math.max(1, Math.min(limit, 50))) }
  }
  return { ok: true, dir: null, entries: [] }
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
        if (req.method === 'GET' && sub2 === '/root') {
          sendJson(res, 200, { ok: true, root: root() })
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
