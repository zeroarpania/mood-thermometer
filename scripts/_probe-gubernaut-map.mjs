// 验：「照抄 Gubernat 的 a 公式」到我们这套数据上行不行。
//
// Gubernat（gubernaut.txt line 325-338）：
//   P = I · max(0, −v)
//   arousal ← clip(arousal + g·P − d)
//
// ⛔ 关键疑问：它的 `v` 是**输入侧的语气**（IGL 给的外部信号），
//    而我们的 `v` 是**算出来的自身情绪状态**。若直接拿我们的 v 当门控变量，
//    `max(0, −v)` 在我们这儿大部分为 0 ⇒ arousal 只会一路衰减。
// 本脚本就是把这件事量出来。
//
// 用法：node _probe-gubernaut-map.mjs <zstd>...

import { toVA, adaptationOf, lightUp, COORDS } from './appraisal.mjs'
import { segmentSession } from './appraisal-track.mjs'

const LOW_A = Object.keys(COORDS).filter((id) => COORDS[id][1] <= -0.40)

const G = 0.2    // 增益，先试
const D = 0.05   // 衰减，先试
const ETA = 0.6  // Picard mood 的「加正减负」速率

const files = process.argv.slice(2)

const stats = {
  segs: 0,
  vNeg: 0,          // v < 0 的段
  gateNonZero: 0,   // max(0,−v) > 0 的段
  gateSum: 0,
  guberA: [],       // 照抄 Gubernat 得到的 arousal
  mood: [],         // Picard 式 mood（加正减负累积）
  nowA: [],         // 现口径 a
  lowLit: { guber: 0, mood: 0, now: 0 },
}

for (const f of files) {
  const segs = segmentSession(f)
  const seenOk = []
  let arousal = 0   // Gubernat 式状态
  let mood = 0      // Picard 式状态
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

    stats.segs++
    if (va.v < 0) stats.vNeg++
    const gate = Math.max(0, -va.v)
    if (gate > 0) stats.gateNonZero++
    stats.gateSum += gate

    // ① Gubernat 式：I = 归一化工作量，P = I · max(0,−v)
    const I = Math.tanh(Math.max(1, g.tools) / 15)
    const P = I * gate
    arousal = Math.max(-1, Math.min(1, arousal + G * P - D))
    stats.guberA.push(arousal)

    // ② Picard 式 mood：加正减负累积 + 常数衰减 + 饱和
    mood = Math.max(-1, Math.min(1, mood + ETA * va.v - D))
    stats.mood.push(mood)

    stats.nowA.push(va.a)

    // 点亮计数（低 a 那六维）
    const litNow = lightUp(va).lit.map((x) => x.id)
    if (litNow.some((id) => LOW_A.includes(id))) stats.lowLit.now++
    const litGuber = lightUp({ v: va.v, a: arousal }).lit.map((x) => x.id)
    if (litGuber.some((id) => LOW_A.includes(id))) stats.lowLit.guber++
    const litMood = lightUp({ v: va.v, a: mood }).lit.map((x) => x.id)
    if (litMood.some((id) => LOW_A.includes(id))) stats.lowLit.mood++
  }
}

const q = (arr, p) => {
  const s = [...arr].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
}
const fmt = (arr) => `min ${q(arr, 0).toFixed(3)} · p50 ${q(arr, 0.5).toFixed(3)} · max ${q(arr, 1).toFixed(3)} · 不同取值 ${new Set(arr).size}`

console.log(`段数 ${stats.segs}`)
console.log(`\n=== 门控变量 max(0,−v) 在我们数据上的实际表现 ===`)
console.log(`  v < 0 的段            ${stats.vNeg} / ${stats.segs}  (${(stats.vNeg / stats.segs * 100).toFixed(1)}%)`)
console.log(`  max(0,−v) > 0 的段    ${stats.gateNonZero} / ${stats.segs}  (${(stats.gateNonZero / stats.segs * 100).toFixed(1)}%)`)
console.log(`  Σ max(0,−v)           ${stats.gateSum.toFixed(2)}`)

console.log(`\n=== 三种 a 的分布 ===`)
console.log(`  ① 照抄 Gubernat（P=I·max(0,−v)，g=${G}, d=${D}）  ${fmt(stats.guberA)}`)
console.log(`  ② Picard 式 mood（加正减负，η=${ETA}, d=${D}）    ${fmt(stats.mood)}`)
console.log(`  ③ 现口径 a（瞬时）                                ${fmt(stats.nowA)}`)

console.log(`\n=== 「累/低落」六维点亮次数（共 ${stats.segs} 段）===`)
console.log(`  ① Gubernat 式 a  ${stats.lowLit.guber}`)
console.log(`  ② Picard mood    ${stats.lowLit.mood}`)
console.log(`  ③ 现口径 a       ${stats.lowLit.now}`)

const gNeg = stats.guberA.filter((x) => x < 0).length
console.log(`\n=== 判据 ===`)
console.log(`  照抄 Gubernat 后 a<0 的段：${gNeg} / ${stats.segs}`)
console.log(`  ${gNeg === 0 ? '⛔ 一个都没有 ⇒ 门控变量选错（我们的 v 是输出不是输入），公式照抄不通' : '✓ 有负值，公式在数值上跑得通'}`)
