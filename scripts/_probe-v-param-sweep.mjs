// 对照基线：纯调参能不能达到「v 修好」的判据？
//
// 判据（与给 GPT 的提问包一致）：
//   · 21 个 cv<0 的维度，点亮率 ≥15%
//   · 同时 v<0 的段占比 <60%（不能反过来变成一片负）
//
// ⛔ 只读：靠 toVA(signals, cfg) 的 cfg 入参覆盖，**不改 appraisal.mjs 一行**。
// 用法：node _probe-v-param-sweep.mjs <zstd>...

import { CFG, COORDS, EMOTION_DIMS, lightUp, toVA, adaptationOf } from './appraisal.mjs'
import { segmentSession } from './appraisal-track.mjs'

const files = process.argv.slice(2)
const NEG_V_DIMS = EMOTION_DIMS.filter((id) => COORDS[id][0] < 0)
const NEG_A_DIMS = EMOTION_DIMS.filter((id) => COORDS[id][1] < 0)

console.log(`cv<0 的维度 ${NEG_V_DIMS.length} / ${EMOTION_DIMS.length}`)
console.log(`ca<0 的维度 ${NEG_A_DIMS.length} / ${EMOTION_DIMS.length}  → ${NEG_A_DIMS.join(' · ')}`)

// ⛔ 判据修正（2026-11-02 17:3x）：
//   旧判据「cv<0 里任意一维点亮 ≥15%」**没有分辨力** —— 现口径已 27.5%，
//   因为 cv<0 但 ca≥0 的那批维度本来就在大量点亮。
//   真问题在 **ca<0 那 10 个**：它们卡在 a≥0 上，几何上界最高才 0.99、最低 0.073。
console.log('\n判据（修正后）：')
console.log('  · 层1 v 能到负区：v<0 段占比 > 10%')
console.log('  · 层2 低唤醒维度能亮：**ca<0 那 10 个**的总点亮率 ≥15%')
console.log('  · 且 v<0 占比 <60%（不反过来变一片负）\n')

const GRID = []
for (const praiseWeight of [1.0, 0.5, 0.25]) {
  for (const workWeight of [0.6, 1.2]) {
    GRID.push({ praiseWeight, workWeight })
  }
}

const fmt = (x, n = 3) => x.toFixed(n)

console.log('praiseW  workW   v<0占比   v均    v.min  v.max  21维点亮率  点亮次数/段数  判据')
for (const g of GRID) {
  const cfg = { ...CFG, praiseWeight: g.praiseWeight, workWeight: g.workWeight }
  let segs = 0, negV = 0, vSum = 0
  let vMin = Infinity, vMax = -Infinity
  let hit = 0
  let negVHit = 0, negAHit = 0
  const perDim = new Map()

  for (const f of files) {
    const S = segmentSession(f)
    const seenOk = []
    for (let i = 0; i < S.length; i++) {
      const seg = S[i]
      for (const ok of seg.toolSeq) seenOk.push(ok)
      const adapt = adaptationOf(seenOk)
      const va = toVA({
        praiseHard: seg.praiseHard, praiseSoft: seg.praiseSoft, obstruction: seg.fails,
        toolResults: seg.tools, baseline: adapt.baseline, recentSuccessRate: adapt.recentRate,
        turnDelta: Math.max(1, seg.tools),
      }, cfg)
      segs++
      vSum += va.v
      if (va.v < 0) negV++
      if (va.v < vMin) vMin = va.v
      if (va.v > vMax) vMax = va.v

      const lit = lightUp(va, cfg).lit
      // 两层分别计
      if (lit.some((x) => NEG_V_DIMS.includes(x.id))) negVHit++
      if (lit.some((x) => NEG_A_DIMS.includes(x.id))) negAHit++
      // 逐维计数（ca<0 的那 10 个）
      for (const item of lit) {
        if (NEG_A_DIMS.includes(item.id)) perDim.set(item.id, (perDim.get(item.id) || 0) + 1)
      }
      hit += lit.length
    }
  }

  const negVRatio = negV / segs
  const dimVnegRate = negVHit / segs      // cv<0 那 19 个
  const dimAnegRate = negAHit / segs      // ca<0 那 10 个 ← 真问题
  const pass = dimAnegRate >= 0.15 && negVRatio > 0.10 && negVRatio < 0.60
  console.log(
    `${fmt(g.praiseWeight, 2).padStart(7)}  ${fmt(g.workWeight, 1).padStart(5)}   ` +
    `${(negVRatio * 100).toFixed(1).padStart(6)}%  ${fmt(vSum / segs).padStart(6)} ${fmt(vMin).padStart(7)} ${fmt(vMax).padStart(6)}  ` +
    `${(dimVnegRate * 100).toFixed(2).padStart(8)}%  ${(dimAnegRate * 100).toFixed(2).padStart(9)}%  ${String(negAHit).padStart(4)}/${segs}   ${pass ? '✓ 达标' : '✗'}`
  )
}

console.log('\n⚠️ 参考：现口径 = praiseWeight 1.0 / workWeight 0.6（第一行）')
console.log('   **ca<0 那列才是真问题** —— 它们卡在 a≥0 上，纯调参动不了 a。')
console.log('   19 维（cv<0）列近 30% 说明「负 v 区本身是用得到的」，问题不在 v 到不了负。')
