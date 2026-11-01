// 样例数据的最小可运行示例：读 deid-events.jsonl，算出几项基础统计。
// 目的是让你确认「这份样例能跑」以及「你自己的数据该导出成什么形状」。
//
// 用法：node _demo-read-sample.mjs [deid-events.jsonl]
import { readFileSync } from 'node:fs'

const F = process.argv[2] || new URL('./deid-events.jsonl', import.meta.url)
const rows = readFileSync(F, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const byS = new Map()
for (const r of rows) {
  if (!byS.has(r.s)) byS.set(r.s, [])
  byS.get(r.s).push(r)
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : 'n/a')
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

console.log(`文件 ${String(F)}`)
console.log(`行数 ${rows.length} · 会话 ${byS.size}\n`)

for (const [sid, rs] of [...byS.entries()].sort()) {
  const calls = rs.filter((r) => r.type === 'tool/call')
  const results = rs.filter((r) => r.type === 'tool/result')
  const fails = results.filter((r) => r.fail)
  const turns = rs.filter((r) => r.type === 'turn/start').length
  const spanMin = (rs[rs.length - 1].t - rs[0].t) / 60000
  const gaps = []
  for (let i = 1; i < rs.length; i++) gaps.push(rs[i].t - rs[i - 1].t)

  const toolCount = {}
  for (const c of calls) toolCount[c.tool] = (toolCount[c.tool] || 0) + 1
  const top = Object.entries(toolCount).sort((a, b) => b[1] - a[1]).slice(0, 5)

  console.log(`=== ${sid} ===`)
  console.log(`  轮 ${turns} · 工具调用 ${calls.length} · 失败 ${fails.length}（${pct(fails.length, results.length)}）`)
  console.log(`  跨度 ${spanMin.toFixed(1)} 分钟 · 事件间隔中位 ${median(gaps)} ms`)
  console.log(`  高频工具 ${top.map(([k, v]) => `${k}×${v}`).join('  ')}`)
  const kinds = {}
  for (const f of fails) kinds[f.fail.kind] = (kinds[f.fail.kind] || 0) + 1
  if (Object.keys(kinds).length) console.log(`  失败种类 ${JSON.stringify(kinds)}`)
  console.log('')
}

const allFail = rows.filter((r) => r.fail).length
const allResults = rows.filter((r) => r.type === 'tool/result').length
console.log(`合计失败率（按 tool/result 计） ${allFail}/${allResults} = ${pct(allFail, allResults)}`)
console.log('⚠️ 这是样例数据的统计，不是研究结论 —— 样本只有 3 个会话。')
