/**
 * 盯盘报告解析 + 工作区判定的 node 测试（项目没有测试框架，就用这个脚本）：
 *   node scripts/test-watch.mjs
 *
 * 断言对象是**真实产物** test/fixtures/{gold,bbw}.md（经济工作区 reports/watch 的拷贝），
 * 不是手写的理想样本——解析器要为这几份真实报告工作，不是为了过测试。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseReport,
  reportSignals,
  reportChanges,
  parseInline,
  plainText,
  pickWatchRoot,
} from '../lib/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(path.join(here, '..', 'test', 'fixtures', name), 'utf8')

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(detail === undefined ? name : `${name} — ${detail}`)
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------- 行内解析
{
  const parts = parseInline('**粗体** 普通 [链接](http://a.b/c) 裸 http://x.y/z')
  eq('行内:片段数', parts.length, 5)
  eq('行内:加粗', parts[0].kind, 'bold')
  eq('行内:加粗文本', parts[0].text, '粗体')
  eq('行内:链接', parts[2].kind, 'link')
  eq('行内:链接地址', parts[2].url, 'http://a.b/c')
  eq('行内:裸URL', parts[4].url, 'http://x.y/z')
  eq('行内:纯文本求和', plainText(parts), '粗体 普通 链接 裸 http://x.y/z')
}

// ---------------------------------------------------------------- 黄金报告
const gold = parseReport(fixture('gold.md'))
{
  eq('黄金:线名', gold.line, '黄金盯盘')
  eq('黄金:数据时间', gold.asOf, '2026-11-24 21:35')
  check('黄金:分区数≥7', gold.sections.length >= 7, `got ${gold.sections.length}`)
  check('黄金:分区标题都非空', gold.sections.every((section) => section.title !== ''))
  check('黄金:有两个以上表格', gold.summary.tables >= 2, `got ${gold.summary.tables}`)
  check('黄金:至少 1 条信号', gold.summary.signals >= 1, `got ${gold.summary.signals}`)

  const signals = reportSignals(gold)
  check('黄金:信号条目非空', signals.length >= 1)
  eq('黄金:信号等级', signals[0].level, '高')
  check('黄金:信号文本提到金矿股', signals[0].text.includes('金矿股'), signals[0].text)

  const changes = reportChanges(gold)
  check('黄金:较上次变化≥4 项', changes.length >= 4, `got ${changes.length}`)
  check('黄金:变化项有名字', changes.every((row) => row.name !== ''))
  check('黄金:变化项有数值', changes.filter((row) => row.value !== '').length >= 4)

  check('黄金:跌多于涨', gold.summary.down > gold.summary.up, `down=${gold.summary.down} up=${gold.summary.up}`)
  check('黄金:最大跌幅存在', gold.summary.worst !== null && gold.summary.worst.delta < 0)
  check('黄金:最大跌幅在 10% 以内', gold.summary.worst !== null && Math.abs(gold.summary.worst.delta) < 10)
  check('黄金:页脚有数据源说明', plainText(gold.footer).includes('数据源'), plainText(gold.footer).slice(0, 60))
  check('黄金:页脚没留在分区里', gold.sections.every((section) => section.blocks.every((block) => !(block.kind === 'note' && plainText(block.inlines ?? []).includes('生成时间')))))
  eq('黄金:页脚时间兜底不带 T', gold.asOf?.includes('T') ?? false, false)

  // 表格首格是名称，涨跌幅列被识别（ETF/金矿股各有一张表）。
  const tables = gold.sections.flatMap((section) => section.blocks.filter((block) => block.kind === 'table').map((block) => block.table))
  check('黄金:表格有行', tables.every((table) => table.rows.length > 0))
  check('黄金:每行有涨跌幅', tables.every((table) => table.deltas.every((delta) => delta !== null)))
  check('黄金:每行有名称', tables.every((table) => table.names.every((name) => name !== '')))
}

// ---------------------------------------------------------------- 北部湾港报告
const bbw = parseReport(fixture('bbw.md'))
{
  check('北港:线名含股票名', bbw.line.includes('北部湾港'), bbw.line)
  eq('北港:数据时间', bbw.asOf, '2026-11-24 18:31')
  check('北港:分区数≥3', bbw.sections.length >= 3, `got ${bbw.sections.length}`)
  check('北港:重组里程碑能被认出', bbw.sections.some((section) => section.title.includes('重组进展'))
    && bbw.sections
      .flatMap((section) => section.blocks.flatMap((block) => block.items ?? []))
      .some((item) => `${item.label ?? ''}${plainText(item.inlines)}`.includes('命中里程碑')))

  // 公告条目：正文 + 缩进续行里的原文链接。
  const details = bbw.sections
    .flatMap((section) => section.blocks.filter((block) => block.kind === 'items').flatMap((block) => block.items ?? []))
    .filter((item) => item.details.length > 0)
  check('北港:有带续行的条目', details.length >= 1, `got ${details.length}`)
  check('北港:续行里能取到链接', details.some((item) => item.details.some((line) => line.some((part) => part.kind === 'link'))))

  // 关键回归：无符号百分比（净利率 13.6%）不能被当成涨跌幅。
  check('北港:无符号百分比不进涨跌统计', bbw.movers.every((row) => Math.abs(row.delta) < 20), JSON.stringify(bbw.movers.slice(0, 5)))
  check('北港:日期条目不算涨跌', bbw.movers.every((row) => !/^\d{8}$/.test(row.name)))
}

// ---------------------------------------------------------------- 空/异常输入
{
  const empty = parseReport('')
  eq('空文本:标题为空', empty.title, '')
  eq('空文本:无分区', empty.sections.length, 0)
  eq('空文本:时间为空', empty.asOf, null)
  eq('空文本:无涨跌', empty.movers.length, 0)

  const garbage = parseReport('| a | b |\n| --- | --- |\n| 1 | 2 |\n> 生成时间 2026-01-02 03:04\n- [高]\n')
  eq('脏文本:表格识别', garbage.summary.tables, 1)
  eq('脏文本:时间为空', garbage.asOf, '2026-01-02 03:04')
  eq('脏文本:空信号不计', garbage.summary.signals, 0)
  check('脏文本:不抛异常', true)
}

// ---------------------------------------------------------------- 工作区判定
const registry = JSON.stringify({
  tables: {
    workspaces: {
      bot: { path: path.join('C:', 'ws', 'bots'), updatedAt: '2026-11-24T13:41:00Z' },
      econ: { path: path.join('C:', 'ws', 'econ'), updatedAt: '2026-11-24T00:17:00Z' },
    },
  },
})

function probe(options) {
  const { env = {}, lines = registry, mtimes = {}, cwd = path.join('C:', 'cwd') } = options
  return {
    env,
    home: path.join('C:', 'home'),
    cwd,
    readText(file) {
      return file.toLowerCase().endsWith(path.join('storages', 'workspace.json').toLowerCase()) ? lines : null
    },
    newestReportMtime(dir) {
      return mtimes[dir] ?? 0
    },
  }
}

const watchDir = (root) => path.join(root, 'reports', 'watch')
/** 面板里手动绑定的工作区：优先于自动探测，仅次于环境变量。 */
const boundProbe = (bound) => ({ ...probe({ mtimes: { [watchDir(path.join('C:', 'ws', 'econ'))]: 5000 } }), bound })
const reportsDirOnly = (root) => path.join(root, 'reports')

{
  const env = pickWatchRoot(probe({ env: { DSH_TRADING_WATCH_ROOT: path.join('C:', 'ws', 'env') }, mtimes: { [watchDir(path.join('C:', 'ws', 'econ'))]: 999 } }))
  eq('判定:显式配置优先', env.root, path.join('C:', 'ws', 'env'))
  eq('判定:显式配置来源', env.source, 'config')

  const econ = path.join('C:', 'ws', 'econ')
  const bots = path.join('C:', 'ws', 'bots')
  const byWatch = pickWatchRoot(probe({ mtimes: { [watchDir(econ)]: 5000, [watchDir(bots)]: 100 } }))
  eq('判定:选报告最新的工作区', byWatch.root, econ)
  eq('判定:来源=watch-reports', byWatch.source, 'watch-reports')

  const byLegacyDir = pickWatchRoot(probe({ mtimes: { [reportsDirOnly(econ)]: 5000 } }))
  eq('判定:旧 reports 布局也算', byLegacyDir.root, econ)

  const byRecent = pickWatchRoot(probe({ mtimes: {} }))
  eq('判定:没有报告时退最近更新', byRecent.root, bots)
  eq('判定:来源=recent-workspace', byRecent.source, 'recent-workspace')

  const fallback = pickWatchRoot(probe({ lines: null, cwd: path.join('C:', 'cwd2') }))
  eq('判定:无登记表退 cwd', fallback.root, path.join('C:', 'cwd2'))
  eq('判定:来源=cwd', fallback.source, 'cwd')

  const broken = pickWatchRoot(probe({ lines: '{ not json' }))
  eq('判定:登记表损坏退 cwd', broken.source, 'cwd')

  const bound = path.join('C:', 'ws', 'bound')
  const byBound = pickWatchRoot(boundProbe(bound))
  eq('判定:绑定工作区优先于自动探测', byBound.root, bound)
  eq('判定:来源=bound', byBound.source, 'bound')

  const boundBeatsEnv = pickWatchRoot({ ...boundProbe(bound), env: { DSH_TRADING_WATCH_ROOT: path.join('C:', 'ws', 'env') } })
  eq('判定:环境变量仍压过绑定', boundBeatsEnv.source, 'config')

  const blankBound = pickWatchRoot(boundProbe('   '))
  eq('判定:空白绑定按未绑处理', blankBound.source, 'watch-reports')
}

// ---------------------------------------------------------------- 同日多快照（回归）
// 真实情况：同一天重跑会往同一个文件追加新快照，gold-2026-11-21/22/23 都是这种文件。
// 过去只认第一个 H1，等于把三天前的数据当今天显示（asOf 19:10、信号 18 条、涨跌 45 家）。
{
  const multi = parseReport(fixture('gold-multi.md'))
  eq('多快照:显示最新快照时间', multi.asOf, '2026-11-23 21:36')
  eq('多快照:快照计数', multi.snapshots, 3)
  eq('多快照:分区不被合并', multi.sections.length, 7)
  eq('多快照:分区标题取最新那份', multi.sections[0].title, '一、国际金价')
  check('多快照:信号只算最新快照', multi.summary.signals < 10, `signals=${multi.summary.signals}`)
  check('多快照:涨跌家数只算最新快照', multi.summary.up + multi.summary.down < 25, `${multi.summary.up}/${multi.summary.down}`)
  eq('多快照:标题时间取最新', multi.title, '黄金盯盘 · 2026-11-23 21:36')
  const footerText = multi.footer.map((part) => part.text).join('')
  eq('多快照:页脚只有一段', (footerText.match(/生成时间/g) ?? []).length, 1)

  // 单快照文件不该凭空多出快照计数。
  eq('单快照:计数为 1', parseReport(fixture('gold.md')).snapshots, 1)
}

// ---------------------------------------------------------------- 结果
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed} 通过 / ${failures.length} 失败`)
for (const failure of failures) console.log(`  ✗ ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
