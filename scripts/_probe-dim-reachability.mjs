// 验「第三维必要性」：纯几何，不靠会话数据。
//
// 论证链：
//   1. `a` 的可行域是 [0,1]（§36：两篇文献 + 我们实现）。
//   2. 某维度的坐标是 (cv, ca)。v 可自由取到 cv（v∈[-1,1]），
//      但 a 最低只到 0 —— 所以到该点的**最近距离** = max(0, −ca)。
//   3. score = exp(−d²/(2σ²)) ⇒ 该维度的**分数上界** = exp(−max(0,−ca)²/(2σ²))。
//   4. 进 top3 需要 score ≥ top1 × relFloor。
//      ⇒ 若上界 < 典型 top1 × relFloor，这个维度**在任何数据下都进不了 top3**。
//
// ⛔ 只读，不改 appraisal.mjs。
// 用法：node _probe-dim-reachability.mjs <zstd>...   （给会话文件则同时跑实测）

import { COORDS, CFG, EMOTION_DIMS, lightUp, toVA, adaptationOf } from './appraisal.mjs'
import { segmentSession } from './appraisal-track.mjs'

const sigma = CFG.sigma
const relFloor = CFG.relFloor

console.log(`σ=${sigma} · relFloor=${relFloor} · minIntensity=${CFG.minIntensity}`)
console.log(`a 的可行域按 [0,1] 计（§36：文献与实现一致）\n`)

// ── ① 几何上界 ──────────────────────────────────────────────────
const rows = []
for (const id of EMOTION_DIMS) {
  const [cv, ca] = COORDS[id]
  const dMin = Math.max(0, -ca)          // a 最低只能到 0
  const maxScore = Math.exp(-(dMin * dMin) / (2 * sigma * sigma))
  rows.push({ id, cv, ca, dMin, maxScore })
}
rows.sort((x, y) => y.maxScore - x.maxScore)

console.log('=== 每个维度在「a≥0」约束下的分数上界（高→低）===')
console.log('  id          ca    最近距离  分数上界')
for (const r of rows) {
  console.log(`  ${r.id.padEnd(11)} ${String(r.ca).padStart(5)}  ${r.dMin.toFixed(2).padStart(6)}  ${r.maxScore.toFixed(3).padStart(8)}`)
}

const negA = rows.filter((r) => r.ca < 0)
console.log(`\n  ca < 0 的维度：${negA.length} / ${rows.length}  → ${negA.map((r) => r.id).join(' · ')}`)
console.log(`  ca ≥ 0 的维度：${rows.length - negA.length}`)

// ── ② 实测：这些维度到底能不能进 top3 ─────────────────────────
const files = process.argv.slice(2)
if (files.length) {
  const hitTop = new Map()
  let segs = 0
  for (const f of files) {
    const S = segmentSession(f)
    const seenOk = []
    for (let i = 0; i < S.length; i++) {
      const g = S[i]
      for (const ok of g.toolSeq) seenOk.push(ok)
      const adapt = adaptationOf(seenOk)
      const va = toVA({
        praiseHard: g.praiseHard, praiseSoft: g.praiseSoft, obstruction: g.fails,
        toolResults: g.tools, baseline: adapt.baseline, recentSuccessRate: adapt.recentRate,
        turnDelta: Math.max(1, g.tools),
      })
      const res = lightUp(va)
      segs++
      for (const item of res.lit) hitTop.set(item.id, (hitTop.get(item.id) || 0) + 1)
    }
  }

  console.log(`\n=== 实测：${segs} 段里各维度进 top${CFG.topN} 的次数（只列 ca<0 的，共 ${negA.length} 个）===`)
  console.log('  id          ca    分数上界  实测点亮  占段数')
  for (const r of negA) {
    const n = hitTop.get(r.id) || 0
    console.log(`  ${r.id.padEnd(11)} ${String(r.ca).padStart(5)}  ${r.maxScore.toFixed(3).padStart(8)}  ${String(n).padStart(8)}  ${(n / segs * 100).toFixed(2).padStart(6)}%`)
  }

  // 观察到的 top1 分数水平（用来对照上界够不够）
  console.log(`\n  ⚠️ 「分数上界」是 a=0 时的理论上限；实测 top1 通常远高于它，`)
  console.log(`     所以上界 < top1×relFloor 的维度是**结构性不可达**。`)
}
