// 训练/验证切分（GPT 审阅意见第六节末的要求）
//
// 她的原话：「如果标准化参数使用完整 817 段数据，就把结果标记为离线回放结果。
//   以后要验证泛化能力，应使用按时间切分的训练集和验证集，
//   不能让未来数据参与历史段的基线计算。」
//
// 做法：
//   1. 按每个会话**最早事件时间**排序（不靠 id、不靠文件 mtime）
//   2. 前 4 个会话 = 标定集（算 median(d) / MAD(d)）
//   3. 后 2 个会话 = 验证集（只报指标，参数全来自标定集）
//   4. 同时报「全量标定」做对照（那是离线回放，泛化上不算数）
//
// ⛔ 只读。用法：node _probe-train-test-split.mjs <zstd>...

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { CFG, COORDS, EMOTION_DIMS, lightUp, toVA, adaptationOf } from './appraisal.mjs'
import { segmentSession } from './appraisal-track.mjs'

const files = process.argv.slice(2)
const EMO = EMOTION_DIMS
const NEG_A = EMO.filter((id) => COORDS[id][1] < 0)

/** 该会话最早的事件时间（13 位毫秒）。 */
function firstEventTime(file) {
  const buf = readFileSync(file)
  const cuts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) cuts.push(i)
  }
  let min = Infinity
  for (let k = 0; k < cuts.length; k++) {
    const s = cuts[k], e = k + 1 < cuts.length ? cuts[k + 1] : buf.length
    let text
    try { text = zstdDecompressSync(buf.subarray(s, e)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      if (typeof ev.time === 'number' && ev.time < min) min = ev.time
    }
  }
  return min
}

// ── 1. 按时间排序 ─────────────────────────────────────────────
const sessions = files.map((f) => ({
  f,
  id: f.split('\\').slice(-2)[0].slice(8, 16),
  t: firstEventTime(f),
}))
sessions.sort((a, b) => a.t - b.t)

const fmtTime = (t) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
console.log('=== 会话按最早事件时间排序 ===')
for (const s of sessions) console.log(`  ${s.id}  ${fmtTime(s.t)}`)
const spanDays = (sessions[sessions.length - 1].t - sessions[0].t) / 86400000
console.log(`  时间跨度 ${spanDays.toFixed(2)} 天\n`)

// ── 2. 抽每段的量 ─────────────────────────────────────────────
function rowsOf(file) {
  const S = segmentSession(file)
  const seenOk = []
  const out = []
  for (let i = 0; i < S.length; i++) {
    const g = S[i]
    for (const ok of g.toolSeq) seenOk.push(ok)
    const adapt = adaptationOf(seenOk)
    const va = toVA({
      praiseHard: g.praiseHard, praiseSoft: g.praiseSoft, obstruction: g.fails,
      toolResults: g.tools, baseline: adapt.baseline, recentSuccessRate: adapt.recentRate,
      turnDelta: Math.max(1, g.tools),
    })
    const d = Math.max(-1, Math.min(1, (adapt.recentRate - adapt.baseline) * 2))
    const rate = g.tools > 0 ? (g.tools - g.fails) / g.tools : 0.5
    out.push({ v0: va.v, a: va.a, d, hi: g.tools >= 3 && rate >= 0.9, lo: g.tools >= 3 && rate < 0.9 })
  }
  return out
}

const rowsBySession = new Map(sessions.map((s) => [s.id, rowsOf(s.f)]))
const calibIds = sessions.slice(0, 4).map((s) => s.id)
const validIds = sessions.slice(4).map((s) => s.id)
const calib = calibIds.flatMap((id) => rowsBySession.get(id))
const valid = validIds.flatMap((id) => rowsBySession.get(id))
const all = [...calib, ...valid]

console.log(`标定集（前 4）：${calibIds.join(' ')} ⇒ ${calib.length} 段`)
console.log(`验证集（后 2）：${validIds.join(' ')} ⇒ ${valid.length} 段\n`)

// ── 3. 参数只在标定集上算 ────────────────────────────────────
const median = (arr) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length
const sd = (arr) => { const m = mean(arr); return Math.sqrt(arr.reduce((x, y) => x + (y - m) ** 2, 0) / arr.length) }
const pct = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] }

const calibD = calib.map((r) => r.d)
const dMed = median(calibD)
const dMAD = median(calibD.map((x) => Math.abs(x - dMed)))
const scale = 1.4826 * dMAD || 1
// 全量对照（离线回放，泛化上不算数）
const allD = all.map((r) => r.d)
const allMed = median(allD)
const allMAD = median(allD.map((x) => Math.abs(x - allMed)))
const allScale = 1.4826 * allMAD || 1

console.log('=== 标准化参数 ===')
console.log(`  标定集（前 4，合规）: median=${dMed.toFixed(5)}  MAD=${dMAD.toFixed(5)}  scale=${scale.toFixed(5)}`)
console.log(`  全量（离线回放，不算）: median=${allMed.toFixed(5)}  MAD=${allMAD.toFixed(5)}  scale=${allScale.toFixed(5)}\n`)

const clamp1 = (x) => Math.max(-1, Math.min(1, x))
const CAP = CFG.valenceCap
const WORK = CFG.workWeight

// ── 4. 指标计算 ──────────────────────────────────────────────
function report(label, rows, vFn) {
  const vs = rows.map(vFn)
  const hi = rows.filter((r) => r.hi).map(vFn)
  const lo = rows.filter((r) => r.lo).map(vFn)
  const gap = (hi.length && lo.length) ? pct(hi, 0.25) - pct(lo, 0.75) : NaN
  const flat = rows.filter((r, i) => Math.hypot(vs[i], r.a) < CFG.minIntensity).length / rows.length
  let negAHit = 0
  for (let i = 0; i < rows.length; i++) {
    if (lightUp({ v: vs[i], a: rows[i].a }).lit.some((x) => NEG_A.includes(x.id))) negAHit++
  }
  return {
    label,
    n: rows.length,
    mean: mean(vs), med: median(vs), sd: sd(vs),
    negV: vs.filter((x) => x < 0).length / rows.length,
    hi: hi.length, lo: lo.length,
    gap, flat,
    negA: negAHit / rows.length,
  }
}

const V = {
  A: (r) => r.v0,
  C1: (r) => clamp1(Math.tanh(((r.d - dMed) / scale) / 1) * CAP),
  C2: (r) => clamp1(Math.tanh(((r.d - dMed) / scale) / 2) * CAP),
  C3: (r) => clamp1(Math.tanh(((r.d - dMed) / scale) / 3) * CAP),
  // 全量参数的 C（对照，离线回放）
  Call2: (r) => clamp1(Math.tanh(((r.d - allMed) / allScale) / 2) * CAP),
}

console.log('=== 第一层：valence 本身（她说的真判据）===')
console.log('组                        段数   v均     v中位   v标准差  v<0    高/低段数   gap    平段占比  负a维(观测)')
const CASES = [
  ['A 现口径 · 验证集', valid, V.A],
  ['C k=2 标定集参数 · 验证集', valid, V.C2],
  ['C k=1 标定集参数 · 验证集', valid, V.C1],
  ['C k=3 标定集参数 · 验证集', valid, V.C3],
  ['A 现口径 · 标定集', calib, V.A],
  ['C k=2 标定集参数 · 标定集', calib, V.C2],
  ['⚠️C k=2 全量参数 · 验证集(回放)', valid, V.Call2],
]
const out = []
for (const [label, rows, fn] of CASES) {
  const r = report(label, rows, fn)
  out.push(r)
  console.log(
    `${label.padEnd(28)} ${String(r.n).padStart(4)} ${r.mean.toFixed(3).padStart(7)} ${r.med.toFixed(3).padStart(7)} ` +
    `${r.sd.toFixed(3).padStart(8)} ${(r.negV * 100).toFixed(1).padStart(5)}% ${String(r.hi).padStart(5)}/${String(r.lo).padEnd(4)} ` +
    `${(Number.isNaN(r.gap) ? '—' : r.gap.toFixed(3)).padStart(6)} ${(r.flat * 100).toFixed(1).padStart(7)}% ${(r.negA * 100).toFixed(1).padStart(9)}%`
  )
}

// ── 5. 判据 ──────────────────────────────────────────────────
const vC2 = out.find((r) => r.label.startsWith('C k=2 标定集参数 · 验证集'))
const vA = out.find((r) => r.label.startsWith('A 现口径 · 验证集'))
console.log('\n=== 判据（handoff 里预先定死的）===')
console.log(`  验证集 C(k=2)：gap = ${vC2.gap.toFixed(3)}  平段 = ${(vC2.flat * 100).toFixed(1)}%`)
console.log(`  验证集 A      ：gap = ${vA.gap.toFixed(3)}  平段 = ${(vA.flat * 100).toFixed(1)}%`)
const pass = vC2.gap >= 0.20 && vC2.flat <= 0.20
console.log(`  ${pass ? '✓ 达标' : '✗ 未达标'}（要求 gap≥0.20 且 平段≤20%）`)
