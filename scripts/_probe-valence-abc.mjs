// A/B/C/D 四组消融对照（来自一份外部审阅意见的第六节）
//
// 审阅意见要求每组同时报告：
//   1. v 的均值、中位数、标准差
//   2. v<0 的比例
//   3. 低达成段与高达成段的 valence 分布差异
//   4. 负向维度的点亮率
//   5. 正向维度是否异常消失
//   （第 6 项「表扬前后状态变化」本轮不做，单列）
//
// ⚠️ 她的原文警告：「如果标准化参数使用完整 817 段数据，就把结果标记为离线回放结果。」
//    ⇒ 本脚本用全量算 median/MAD，**所有 C/D 组结果都必须标「离线回放」**。
//
// ⛔ 只读：不改 appraisal.mjs。v 的重算在这里独立实现（因为要绕开原公式）。
// 用法：node _probe-valence-abc.mjs <zstd>...

import { CFG, COORDS, EMOTION_DIMS, NON_EMOTION_DIMS, lightUp, toVA, adaptationOf } from './appraisal.mjs'
import { segmentSession } from './appraisal-track.mjs'

const files = process.argv.slice(2)
const EMO = EMOTION_DIMS
const NEG_V = EMO.filter((id) => COORDS[id][0] < 0)
const NEG_A = EMO.filter((id) => COORDS[id][1] < 0)
const POS = EMO.filter((id) => COORDS[id][0] > 0 && COORDS[id][1] >= 0)

// ── 第一遍：收集每段的原始量 ─────────────────────────────────
const rows = []
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
    // 复算原始分量（与 toVA 内部一致）
    const netPraise = g.praiseHard + g.praiseSoft * 0.5
    const successRate = g.tools > 0 ? (g.tools - g.fails) / g.tools : 0.5
    const d = Math.max(-1, Math.min(1, (adapt.recentRate - adapt.baseline) * 2))
    rows.push({
      d, netPraise, v0: va.v, a: va.a,
      high: g.tools >= 3 && (g.tools - g.fails) / Math.max(1, g.tools) >= 0.9,
      low: g.tools >= 3 && (g.tools - g.fails) / Math.max(1, g.tools) < 0.9,
    })
  }
}

const n = rows.length
const median = (arr) => {
  const s = [...arr].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length
const sd = (arr) => {
  const m = mean(arr)
  return Math.sqrt(arr.reduce((x, y) => x + (y - m) ** 2, 0) / arr.length)
}
const pct = (arr, p) => {
  const s = [...arr].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
}

// ── 标准化参数（全量算 ⇒ 离线回放）──────────────────────────
const dAll = rows.map((r) => r.d)
const dMed = median(dAll)
const dMAD = median(dAll.map((x) => Math.abs(x - dMed)))
const MAD_SCALE = 1.4826 * dMAD
console.log(`=== 标准化参数（全量 n=${n}，⇒ 离线回放，非泛化验证）===`)
console.log(`  median(d) = ${dMed.toFixed(5)}`)
console.log(`  MAD(d)    = ${dMAD.toFixed(5)}  ⇒ 1.4826·MAD = ${MAD_SCALE.toFixed(5)}`)
if (MAD_SCALE < 1e-9) console.log('  ⛔ MAD 退化（近零）⇒ C/D 组不可信，必须按她的警告处理')

const clamp1 = (x) => Math.max(-1, Math.min(1, x))
const TANH = Math.tanh
const CAP = CFG.valenceCap
const WORK = CFG.workWeight

// ── 四组 valence 定义 ────────────────────────────────────────
const VARIANTS = {
  'A 现口径 vWork+vPraise': (r) => r.v0,
  'B 仅 vWork': (r) => clamp1(TANH(r.d * WORK) * CAP),
  'C 标准化 vWork (k=1)': (r) => clamp1(TANH((((r.d - dMed) / (MAD_SCALE || 1)) / 1) * 1) * CAP),
  'C 标准化 vWork (k=2)': (r) => clamp1(TANH((((r.d - dMed) / (MAD_SCALE || 1)) / 2) * 1) * CAP),
  'C 标准化 vWork (k=3)': (r) => clamp1(TANH((((r.d - dMed) / (MAD_SCALE || 1)) / 3) * 1) * CAP),
}

// ── 逐组报告 ────────────────────────────────────────────────
console.log('\n=== 五组 valence 的分布（她要求报的第 1/2 项）===')
console.log('组                        v均    v中位   v标准差  v<0占比  v.min  v.max  平段占比(|v<0.18|)')

const summaries = {}
for (const [name, fn] of Object.entries(VARIANTS)) {
  const vs = rows.map(fn)
  const flat = rows.filter((r, i) => Math.hypot(vs[i], r.a) < CFG.minIntensity).length
  summaries[name] = { vs }
  console.log(
    `${name.padEnd(24)} ${mean(vs).toFixed(3).padStart(6)} ${median(vs).toFixed(3).padStart(7)} ` +
    `${sd(vs).toFixed(3).padStart(8)} ${(vs.filter((x) => x < 0).length / n * 100).toFixed(1).padStart(6)}% ` +
    `${Math.min(...vs).toFixed(3).padStart(7)} ${Math.max(...vs).toFixed(3).padStart(6)}  ${(flat / n * 100).toFixed(1).padStart(6)}%`
  )
}

// ── 第 3 项：高达成 vs 低达成的分布差异 ────────────────────
console.log('\n=== 高达成段 vs 低达成段的 valence（第 3 项）===')
console.log('组                        高达成 p50   低达成 p50   差     高-低 可分性(重叠比)')
for (const [name, fn] of Object.entries(VARIANTS)) {
  const hi = rows.filter((r) => r.high).map(fn)
  const lo = rows.filter((r) => r.low).map(fn)
  if (!hi.length || !lo.length) { console.log(`${name.padEnd(24)} —`); continue }
  const hiP = median(hi), loP = median(lo)
  // 重叠比：高的 p25 与低的 p75 之间的覆盖（越小越可分）
  const gap = pct(hi, 0.25) - pct(lo, 0.75)
  console.log(
    `${name.padEnd(24)} ${hiP.toFixed(3).padStart(9)} ${loP.toFixed(3).padStart(11)} ${(hiP - loP).toFixed(3).padStart(7)} ` +
    `${(gap > 0 ? '✓可分(gap ' + gap.toFixed(3) + ')' : '✗重叠(' + gap.toFixed(3) + ')').padStart(16)}`
  )
}

// ── 第 4/5 项：维度点亮 ─────────────────────────────────────
console.log('\n=== 维度点亮（第 4/5 项）===')
console.log('组                        负v维(19)  负a维(10)  正向维(11)  总点亮/段')
for (const [name, fn] of Object.entries(VARIANTS)) {
  const vs = summaries[name].vs
  let negVH = 0, negAH = 0, posH = 0, total = 0
  for (let i = 0; i < n; i++) {
    const res = lightUp({ v: vs[i], a: rows[i].a })
    const ids = res.lit.map((x) => x.id)
    total += ids.length
    if (ids.some((x) => NEG_V.includes(x))) negVH++
    if (ids.some((x) => NEG_A.includes(x))) negAH++
    if (ids.some((x) => POS.includes(x))) posH++
  }
  console.log(
    `${name.padEnd(24)} ${(negVH / n * 100).toFixed(1).padStart(9)}% ${(negAH / n * 100).toFixed(1).padStart(10)}% ` +
    `${(posH / n * 100).toFixed(1).padStart(10)}% ${(total / n).toFixed(2).padStart(10)}`
  )
}

console.log('\n⚠️ 关键观察点：')
console.log('  · B 组若「平段占比」暴涨 ⇒ 拆掉 praise 后 v 塌到 0，失去动态范围')
console.log('  · C 组若「负a维」仍近零 ⇒ 证明「a 那一半」用 v 的改法治不了')
console.log('  · 若 C 组「正向维」暴跌 ⇒ 标准化把正区吃掉了，是副产品')
