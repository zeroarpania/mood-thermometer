// 探查：验「累 = 工作量 × 达成度」的组合模型，并量「密度」的分布。
//
// 使用者 15:4x 的模型（原话）：
//   「干活多 + 有产出 → 兴奋 + 少量疲劳」
//   「干活多 + 产出少或未达到预期 → 烦躁 + 大量疲劳」
//   ⇒ 二维组合，不是单独判定「累」。
//
// ⛔ 只读、不改 appraisal.mjs。
// 用法：node _probe-effort-outcome.mjs <zstd>...

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { toVA, adaptationOf, lightUp } from './appraisal.mjs'
import { segmentSession } from './appraisal-track.mjs'

/** 按 turn 聚合：assistant/message 条数（step 数）。 */
function stepsByTurn(file) {
  const buf = readFileSync(file)
  const cuts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) cuts.push(i)
  }
  const parts = []
  for (let k = 0; k < cuts.length; k++) {
    const s = cuts[k], e = k + 1 < cuts.length ? cuts[k + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(s, e))) } catch { /* 坏帧跳过 */ }
  }
  const text = Buffer.concat(parts).toString('utf8')
  const byTurn = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'assistant/message') continue
    const t = ev.data && ev.data.turn
    if (t === undefined) continue
    byTurn.set(t, (byTurn.get(t) || 0) + 1)
  }
  return byTurn
}

const files = process.argv.slice(2)
const newCell = () => ({ v: [], a: [], bl: [], rate: [], disp: [], top: new Map(), n: 0 })
const CELLS = {
  'effort高·达成高': newCell(),
  'effort高·达成低': newCell(),
  'effort低·达成高': newCell(),
  'effort低·达成低': newCell(),
  '无作业(tools=0)': newCell(),
}
const densities = []
const EFFORT_CUT = 3   // 工具数 ≥3 算「干活多」
const RATE_CUT = 0.9   // 段内成功率 ≥0.9 算「达成」

for (const f of files) {
  const segs = segmentSession(f)
  const steps = stepsByTurn(f)
  const seenOk = []
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i]
    for (const ok of g.toolSeq) seenOk.push(ok)
    const adapt = adaptationOf(seenOk)
    const va = toVA({
      praiseHard: g.praiseHard,
      praiseSoft: g.praiseSoft,
      obstruction: g.fails,
      toolResults: g.tools,
      baseline: adapt.baseline,
      recentSuccessRate: adapt.recentRate,
      turnDelta: Math.max(1, g.tools),
    })
    const stepN = steps.get(i + 1) || 0
    if (g.tools > 0 && stepN > 0) densities.push(g.tools / stepN)

    let cell
    if (g.tools === 0) cell = '无作业(tools=0)'
    else {
      const rate = (g.tools - g.fails) / g.tools
      cell = (g.tools >= EFFORT_CUT ? 'effort高' : 'effort低') + '·' + (rate >= RATE_CUT ? '达成高' : '达成低')
    }
    const C = CELLS[cell]
    C.n++
    C.v.push(va.v)
    C.a.push(va.a)
    C.bl.push(va.why.baseline)
    C.rate.push(va.why.recentRate)
    C.disp.push(va.why.displacement)
    const res = lightUp(va)
    const top = res.flat ? '平' : (res.lit[0] ? res.lit[0].id : '平')
    C.top.set(top, (C.top.get(top) || 0) + 1)
  }
}

const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : NaN)
const fmtTop = (m, n) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
  .map(([k, c]) => `${k}×${c}(${(c / n * 100).toFixed(0)}%)`).join(' ')

console.log(`切分：工具数 ≥${EFFORT_CUT} 为 effort 高 · 段内成功率 ≥${RATE_CUT} 为达成高\n`)
console.log('格子                n     v均    a均    首位分布（前 3）')
for (const [name, C] of Object.entries(CELLS)) {
  if (!C.n) { console.log(`${name.padEnd(18)} ${String(0).padStart(4)}   —`); continue }
  console.log(`${name.padEnd(18)} ${String(C.n).padStart(4)}  ${mean(C.v).toFixed(3).padStart(6)} ${mean(C.a).toFixed(3).padStart(6)}  ${fmtTop(C.top, C.n)}`)
}

// ── 位移诊断：vWork = (recentRate − baseline) * 2 ─────────────────
// 若两格 displacement 分不开 ⇒ 「位移被压平」是分布事实，不是个别会话。
const qq = (arr, p) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
}
const med = (arr) => qq(arr, 0.5)

console.log('\n=== 位移诊断（vWork 的原料：baseline / recentRate / displacement）===')
console.log('格子                n   baseline均  recentRate均  disp.min  disp.p50  disp.max   disp极差  |disp|≥0.1 占比')
const dispMed = {}
for (const [name, C] of Object.entries(CELLS)) {
  if (!C.n) continue
  dispMed[name] = med(C.disp)
  const big = C.disp.filter((x) => Math.abs(x) >= 0.1).length
  console.log(
    `${name.padEnd(18)} ${String(C.n).padStart(4)}  ${mean(C.bl).toFixed(3).padStart(9)} ${mean(C.rate).toFixed(3).padStart(12)} ` +
    `${qq(C.disp, 0).toFixed(3).padStart(9)} ${med(C.disp).toFixed(3).padStart(9)} ${qq(C.disp, 1).toFixed(3).padStart(9)} ` +
    `${(qq(C.disp, 1) - qq(C.disp, 0)).toFixed(3).padStart(8)} ${(big / C.n * 100).toFixed(1).padStart(10)}%`
  )
}

// ── 判据：两格的 displacement 中位数差 < 0.05 ⇒ 位移失效 ──────────
const A = dispMed['effort高·达成高']
const B = dispMed['effort高·达成低']
if (Number.isFinite(A) && Number.isFinite(B)) {
  const d = Math.abs(A - B)
  console.log(`\n  ⭐ 判据：达标高 vs 达成低的 displacement 中位数差 = ${d.toFixed(4)}`)
  console.log(`     ${d < 0.05 ? '⛔ < 0.05 ⇒ 位移失效，「达成度」根本没进 v' : '✓ ≥ 0.05 ⇒ 位移还有信号，问题不在位移'}`)
  console.log(`     （达成高 ${A.toFixed(4)} · 达成低 ${B.toFixed(4)}）`)
}

console.log(`\n=== 密度 = 本段工具数 / 本段 step 数（n=${densities.length}，只算 tools>0 且 step>0 的段）===`)
const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] }
for (const p of [0, 0.25, 0.5, 0.75, 0.9, 1]) console.log(`  p${String(Math.round(p * 100)).padStart(3)}  ${q(densities, p).toFixed(3)}`)
console.log(`  mean ${mean(densities).toFixed(3)}`)
