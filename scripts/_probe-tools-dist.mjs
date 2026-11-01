// 探查：段内工具数的真实分布，以及「去掉 max(1, tools)」对 a 的影响。
//
// ⛔ 只读、不改 appraisal.mjs。用途是给设计稿 §30-8e / 30-8f 标定分母用的硬数据。
// 用法：node _probe-tools-dist.mjs <zstd>...

import { toVA, adaptationOf } from './appraisal.mjs'
import { segmentSession } from './appraisal-track.mjs'

const files = process.argv.slice(2)
const toolsAll = []
const aWith = []   // turnDelta = max(1, tools)  ← 现 C 口径
const aRaw = []    // turnDelta = tools（不夹底）
const zeroSeg = { n: 0, total: 0 }

for (const f of files) {
  const segs = segmentSession(f)
  const seenOk = []
  let zero = 0
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i]
    for (const ok of g.toolSeq) seenOk.push(ok)
    const adapt = adaptationOf(seenOk)
    const base = {
      praiseHard: g.praiseHard,
      praiseSoft: g.praiseSoft,
      obstruction: g.fails,
      toolResults: g.tools,
      baseline: adapt.baseline,
      recentSuccessRate: adapt.recentRate,
    }
    toolsAll.push(g.tools)
    aWith.push(toVA({ ...base, turnDelta: Math.max(1, g.tools) }).a)
    aRaw.push(toVA({ ...base, turnDelta: g.tools }).a)
    if (g.tools === 0) zero++
    zeroSeg.total++
  }
  zeroSeg.n += zero
  console.log(`${f.split('\\').slice(-2)[0].slice(8, 16)}  段 ${String(segs.length).padStart(4)}  工具数 0 的段 ${String(zero).padStart(4)}`)
}

const q = (arr, p) => {
  const s = [...arr].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
}

console.log(`\n=== 段内工具数分布（n=${toolsAll.length}）===`)
for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 1]) {
  console.log(`  p${String(Math.round(p * 100)).padStart(3)}  ${String(q(toolsAll, p)).padStart(3)} 个`)
}
const mean = toolsAll.reduce((s, x) => s + x, 0) / toolsAll.length
console.log(`  mean ${mean.toFixed(2)} 个`)
console.log(`\n  直方（段数）：0 个 ${toolsAll.filter((x) => x === 0).length} · 1 个 ${toolsAll.filter((x) => x === 1).length} · 2 个 ${toolsAll.filter((x) => x === 2).length} · 3–5 个 ${toolsAll.filter((x) => x >= 3 && x <= 5).length} · 6–10 个 ${toolsAll.filter((x) => x >= 6 && x <= 10).length} · 11+ 个 ${toolsAll.filter((x) => x >= 11).length}`)
console.log(`  工具数 0 的段共 ${zeroSeg.n} / ${zeroSeg.total}`)

console.log(`\n=== 去掉 max(1, tools) 前后 ===`)
for (const [name, arr] of [['max(1,tools) 现口径', aWith], ['tools 原值（不夹底）', aRaw]]) {
  console.log(`  ${name.padEnd(22)} min ${q(arr, 0).toFixed(3)} · p50 ${q(arr, 0.5).toFixed(3)} · p90 ${q(arr, 0.9).toFixed(3)} · max ${q(arr, 1).toFixed(3)}`)
  console.log(`  ${''.padEnd(22)} a=0 的段 ${arr.filter((x) => x === 0).length} · a<0.1 的段 ${arr.filter((x) => x < 0.1).length} · a>0.8 的段 ${arr.filter((x) => x > 0.8).length}`)
}

// 反推：让 p50 的段落在 a≈0.58（CFG 注释里的设计期望）需要多大的分母
const medTools = q(toolsAll, 0.5)
console.log(`\n=== 分母标定参考 ===`)
console.log(`  工具数中位数 = ${medTools}`)
console.log(`  现分母 effortFullTurns=15 ⇒ tanh(${medTools}/15) = ${Math.tanh(medTools / 15).toFixed(3)}`)
for (const d of [2, 3, 5, 8]) {
  console.log(`  若分母改成 ${d} ⇒ tanh(${medTools}/${d}) = ${Math.tanh(medTools / d).toFixed(3)}   （p90=${q(toolsAll, 0.9)} 时 ${Math.tanh(q(toolsAll, 0.9) / d).toFixed(3)}）`)
}
