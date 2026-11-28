/**
 * 「盯盘报告到底读哪个工作区」——这里是唯一判定点。
 *
 * 旧逻辑取 workspace 登记表里**最近更新**的工作区，结果经常落到
 * `C:\Users\Administrator\.dsh\bots\workspace` 这类空目录上：报告面板要么空列表，
 * 要么看着别的目录。现在的顺序是：
 *
 *   1. 显式配置（DSH_TRADING_WATCH_ROOT / DSH_TRADING_FILES_ROOT）——用户说了算；
 *   2. 登记表里**确实有 reports/watch 且报告最新**的工作区——真在产出盯盘报告的那个；
 *   3. 登记表里最近更新的工作区（旧行为，兜底）；
 *   4. 进程 cwd（没有登记表时）。
 *
 * 判定依赖 fs，但全部通过 probe 注入，node 测试可以伪造登记表与目录。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type RootSource = 'config' | 'bound' | 'watch-reports' | 'recent-workspace' | 'cwd'

export interface RootChoice {
  root: string
  source: RootSource
}

export interface RootProbe {
  env: Record<string, string | undefined>
  /** 面板上手动绑定的工作区（$DSH_HOME/dsh-trading-panel/settings.json 的 watchRoot）。 */
  bound?: string | null
  home: string
  cwd: string
  /** 读文本文件，读不到返回 null（登记表缺失/损坏都走这条）。 */
  readText(file: string): string | null
  /** 目录下最新 .md 的 mtime（毫秒）；目录不存在或没有 md 返回 0。 */
  newestReportMtime(dir: string): number
}

export const WATCH_REL = 'reports/watch'
export const REPORTS_REL = 'reports'

interface RegistryRow {
  path?: string
  updatedAt?: string
}

function parseRegistry(text: string | null): RegistryRow[] {
  if (text === null) return []
  try {
    const parsed = JSON.parse(text) as { tables?: { workspaces?: Record<string, RegistryRow> } }
    return Object.values(parsed.tables?.workspaces ?? {}).filter(
      (row) => typeof row?.path === 'string' && row.path !== '',
    )
  } catch {
    return []
  }
}

/** 显式指定的根目录：空字符串视为没配（否则 `??` 会让 '' 挡住后面的回退），相对路径按宿主 cwd 解析。 */
function explicitRoot(probe: RootProbe): string | null {
  for (const raw of [probe.env.DSH_TRADING_WATCH_ROOT, probe.env.DSH_TRADING_FILES_ROOT]) {
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value !== '') return path.resolve(value)
  }
  return null
}

/** 判定工作区根。纯函数，无副作用。 */
export function pickWatchRoot(probe: RootProbe): RootChoice {
  const explicit = explicitRoot(probe)
  if (explicit !== null) return { root: explicit, source: 'config' }

  // 1.5 面板里选过「绑定工作区」：比自动探测更明确，仅次于环境变量。
  const bound = typeof probe.bound === 'string' ? probe.bound.trim() : ''
  if (bound !== '') return { root: path.resolve(bound), source: 'bound' }

  const rows = parseRegistry(probe.readText(path.join(probe.home, 'storages', 'workspace.json')))
  const seen = new Set<string>()
  const paths: string[] = []
  for (const row of rows) {
    if (row.path === undefined) continue
    const key = row.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(row.path)
  }

  // 2. 真在产出盯盘报告的工作区：reports/watch（旧布局退 reports）里最新 md 最大者。
  let bestPath: string | null = null
  let bestMtime = 0
  for (const candidate of paths) {
    const watchMtime = probe.newestReportMtime(path.join(candidate, WATCH_REL))
    const mtime = watchMtime > 0 ? watchMtime : probe.newestReportMtime(path.join(candidate, REPORTS_REL))
    if (mtime > bestMtime) {
      bestMtime = mtime
      bestPath = candidate
    }
  }
  if (bestPath !== null) return { root: bestPath, source: 'watch-reports' }

  // 3. 旧行为：登记表里最近更新的工作区。
  const sorted = [...rows].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  const recent = sorted[0]?.path
  if (recent !== undefined && recent !== '') return { root: recent, source: 'recent-workspace' }

  // 4. 没有登记表：cwd。
  return { root: probe.cwd, source: 'cwd' }
}

/** 报告目录绝对路径：优先 reports/watch，没有就退 reports。 */
export function reportsDir(root: string, probe: Pick<RootProbe, 'newestReportMtime'>): string {
  const watch = path.join(root, WATCH_REL)
  if (probe.newestReportMtime(watch) > 0) return watch
  return path.join(root, REPORTS_REL)
}

/** 真实 fs 探测。每次调用都重新读登记表/目录，不缓存（报告目录会随时间出现）。 */
export function nodeProbe(): RootProbe {
  return {
    env: process.env,
    home: process.env.DSH_HOME ?? path.join(homedir(), '.dsh'),
    cwd: process.cwd(),
    readText(file: string): string | null {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    newestReportMtime(dir: string): number {
      // 布局 `reports/watch/<标的>/<日期>.md`：只看顶层文件会把「有报告的工作区」判成空的，
      // 所以顶层 + 一层子目录一起扫（更深的层级不认，避免误判）。
      const scan = (target: string): number => {
        let newest = 0
        for (const entry of readdirSync(target, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
          try {
            const info = statSync(path.join(target, entry.name))
            if (info.mtimeMs > newest) newest = info.mtimeMs
          } catch {
            /* 断链/无权限：跳过这一份 */
          }
        }
        return newest
      }
      try {
        let newest = scan(dir)
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          try {
            const inner = scan(path.join(dir, entry.name))
            if (inner > newest) newest = inner
          } catch {
            /* 子目录不可读：跳过 */
          }
        }
        return newest
      } catch {
        return 0
      }
    },
  }
}
