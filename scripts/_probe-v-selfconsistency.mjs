// 验 `v` 有没有真实信息量 —— 关键是避开同源自相关。
//
// ⛔ 为什么不能只看同期相关：
//   `v` 本身就是由「最近成功率 − EMA 基线」算出来的。
//   所以 ρ(v_t, 本段失败率_t) 必然高 —— 那是**循环**，不是证据。
//
// ✅ 真判据是**跨期预测力**：`v_t` 能不能预测「下一段」的结果。
//   若能，说明 v 携带的是运行状态的真实信号；
//   若同期高、跨期≈0，说明 v 只是把当期失败率换了个写法。
//
// 用法：node _probe-v-selfconsistency.mjs <zstd>...

import { CFG, COORDS, EMOTION_DIMS, toVA, adaptationOf } from './appraisal.mjs'
import { segmentSession } from './appraisal-track.mjs'

// 两种用法：
//   node _probe-v-selfconsistency.mjs <zstd文件>...       手动列文件
//   node _probe-v-selfconsistency.mjs --from <清单.txt>    读 _probe-corpus-scan.mjs --files 的产物
const fromIdx = process.argv.indexOf('--from')
let files
if (fromIdx >= 0) {
  const { readFileSync } = await import('node:fs')
  files = readFileSync(process.argv[fromIdx + 1], 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean)
  console.log(`语料池模式：${files.length} 个可用会话`)
} else {
  files = process.argv.slice(2)
}

// ── 采集 ────────────────────────────────────────────────────
const rows = []   // {v, a, failsNow, failsNext, tools, toolsAll, rateNow}
for (const f of files) {
  const S = segmentSession(f)
  const seenOk = []
  const seg = []
  for (let i = 0; i < S.length; i++) {
    const g = S[i]
    for (const ok of g.toolSeq) seenOk.push(ok)
    const adapt = adaptationOf(seenOk)
    const va = toVA({
      praiseHard: g.praiseHard, praiseSoft: g.praiseSoft, obstruction: g.fails,
      toolResults: g.tools, baseline: adapt.baseline, recentSuccessRate: adapt.recentRate,
      turnDelta: Math.max(1, g.tools),
    })
    seg.push({
      v: va.v, a: va.a,
      failsNow: g.fails, failsNext: null,
      tools: g.tools,
      rateNow: g.tools > 0 ? (g.tools - g.fails) / g.tools : null,
    })
  }
  // ⛔ 字段名是 failsNow，不是 fails —— 写错过一次，导致 failsNext 全 undefined
  for (let i = 0; i < seg.length - 1; i++) seg[i].failsNext = seg[i + 1].failsNow
  for (const r of seg) if (r.failsNext !== null) rows.push(r)
}

const n = rows.length
console.log(`段数（有下一段的）n=${n}`)

// ── 统计工具 ──────────────────────────────────────────────────
const rank = (arr) => {
  const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0])
  const r = new Array(arr.length)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg
    i = j + 1
  }
  return r
}
function spearman(xs, ys) {
  const rx = rank(xs), ry = rank(ys)
  const m = rx.length
  const mx = rx.reduce((a, b) => a + b, 0) / m
  const my = ry.reduce((a, b) => a + b, 0) / m
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < m; i++) {
    num += (rx[i] - mx) * (ry[i] - my)
    dx += (rx[i] - mx) ** 2
    dy += (ry[i] - my) ** 2
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN
}
/** AUC：score 越高越可能是正类。 */
function auc(scores, labels) {
  const pairs = scores.map((s, i) => [s, labels[i]]).sort((x, y) => x[0] - y[0])
  let rankSum = 0, pos = 0
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][1] === 1) { rankSum += i + 1; pos++ }
  }
  const neg = pairs.length - pos
  if (!pos || !neg) return NaN
  return (rankSum - pos * (pos + 1) / 2) / (pos * neg)
}

// ── ① 同期（对照，同源，必然高）───────────────────────────────
const hasRate = rows.filter((r) => r.rateNow !== null)
console.log(`\n=== ① 同期相关（⛔ 同源对照，不能当证据）===`)
console.log(`  ρ(v_t, 本段成功率_t) = ${spearman(hasRate.map((r) => r.v), hasRate.map((r) => r.rateNow)).toFixed(3)}   (n=${hasRate.length})`)

// ── ② 跨期预测（真判据）─────────────────────────────────────
console.log(`\n=== ② 跨期预测（✅ 真判据：v_t 能否预测下一段）===`)
const failsNextArr = rows.map((r) => r.failsNext)
const vArr = rows.map((r) => r.v)
console.log(`  ρ(v_t, 下一段失败数)     = ${spearman(vArr, failsNextArr).toFixed(3)}`)
const nextHasTools = rows.filter((r) => r.tools > 0)
console.log(`  ρ(v_t, 本段工具数)       = ${spearman(vArr, rows.map((r) => r.tools)).toFixed(3)}`)

// 下一段是否失败（有工具且有失败）
const labelNextFail = rows.map((r) => (r.failsNext > 0 ? 1 : 0))
const posN = labelNextFail.reduce((a, b) => a + b, 0)
console.log(`  下一段有失败的段数       = ${posN} / ${n} (${(posN / n * 100).toFixed(1)}%)`)
if (posN > 5 && posN < n - 5) {
  const a1 = auc(vArr, labelNextFail)
  console.log(`  AUC(v_t → 下一段是否失败) = ${a1.toFixed(3)}   ${a1 < 0.5 ? '(方向反了：v 低→更可能失败，符合预期，取 1−AUC=' + (1 - a1).toFixed(3) + ')' : ''}`)
} else {
  console.log(`  AUC 跳过（正负样本太不平衡）`)
}

// ── ③ 分档看单调性 ──────────────────────────────────────────
console.log(`\n=== ③ 按 v 分五档，看下一段失败率是否单调 ===`)
const sorted = [...rows].sort((a, b) => a.v - b.v)
const q = Math.floor(n / 5)
console.log('  档位        v 范围            n    下一段有失败占比  本段平均工具数')
for (let k = 0; k < 5; k++) {
  const lo = k * q
  const hi = k === 4 ? n : (k + 1) * q
  const bucket = sorted.slice(lo, hi)
  const failRate = bucket.filter((r) => r.failsNext > 0).length / bucket.length
  const avgTools = bucket.reduce((s, r) => s + r.tools, 0) / bucket.length
  console.log(
    `  Q${k + 1}  ${bucket[0].v.toFixed(3).padStart(7)} ~ ${bucket[bucket.length - 1].v.toFixed(3).padStart(7)} ${String(bucket.length).padStart(5)}  ` +
    `${(failRate * 100).toFixed(1).padStart(9)}%  ${avgTools.toFixed(2).padStart(9)}`
  )
}

// ── ④ 判据 ──────────────────────────────────────────────────
const crossRho = spearman(vArr, failsNextArr)
const flat = Math.abs(crossRho) < 0.05
console.log(`\n=== 判据 ===`)
console.log(`  同期 ρ（对照）高是必然的；真看跨期的 |ρ| = ${Math.abs(crossRho).toFixed(3)}`)
if (flat) {
  console.log(`  ⛔ |ρ| < 0.05 ⇒ **v 对下一段没有任何预测力**，同期的高相关只是把当期成功率换了写法。`)
} else if (crossRho < 0) {
  console.log(`  ✅ ρ < 0 且非零 ⇒ v 低时下一段更容易失败，v 携带真实信号（方向符合预期）。`)
} else {
  console.log(`  ⚠️ ρ > 0 ⇒ 方向反常（v 高→下一段更容易失败），需人工判断。`)
}
