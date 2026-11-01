// 两件事一起验：
//   A. 段内事件的时间戳分辨率够不够（决定「段内下钻到事件级」这条路走不走得通）
//   B. v 在**控制本段工具数**之后还剩多少信息（GPT 要的嵌套模型比较）
//
// ⛔ A 为什么必须先验（2026-11-03 00:4x）：
//   §48 得到的方向是「不升粒度、降到事件级」——把一段切成一串工具调用，
//   学 Butler & Barnard 的做法（他们切 2 秒）。但若段内事件间隔是几分钟，
//   那就只剩几个点，"轨迹"退化成离散序列，这条路也死。**先验，别先做。**
//
// ⛔ B 为什么不能用相关系数交差（GPT 原话）：
//   「v 对下一段工具数的预测，在控制本段工具数后还剩多少；加入 v 后模型是否改善」
//   ⇒ 报偏相关 + 线性嵌套 ΔR²。判据跑前冻结。
//
// 用法：node _probe-event-granularity.mjs --from <清单.txt> [--json]

import { readFileSync } from 'node:fs'
import { collectEvents } from './appraisal-track.mjs'
import { toVA, adaptationOf } from './appraisal.mjs'
import { segmentSession } from './appraisal-track.mjs'

const FROZEN = { partialDead: 0.05, dR2Dead: 0.005 }

const argv = process.argv.slice(2)
const fromIdx = argv.indexOf('--from')
if (fromIdx < 0) { console.error('✗ 需要 --from <清单.txt>'); process.exit(1) }
const files = readFileSync(argv[fromIdx + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
const wantJson = argv.includes('--json')
console.error(`扫 ${files.length} 个会话…`)

// 只统计「有意义」的事件 —— 排除 session-log/delivery-accepted 这类超高频内部日志
const KEEP = new Set(['turn/start', 'step/start', 'tool/call', 'tool/result', 'assistant/message', 'user/message', 'step/end', 'turn/end'])

const rows = []
const gaps = []          // 段内相邻事件间隔（秒）
const segEventCounts = []
const segSpans = []

for (const f of files) {
  let evs, S
  try { evs = collectEvents(f); S = segmentSession(f) } catch { continue }
  if (!S.length) continue

  // ── A：按 turn/start 切段，收集段内事件时间 ──
  const segTimes = []
  let cur = null
  for (const { ev } of evs) {
    const t = ev && ev.type
    if (t === 'turn/start') { cur = []; segTimes.push(cur) }
    if (!cur) continue
    if (!KEEP.has(t)) continue
    const tm = Number(ev.time)
    if (Number.isFinite(tm)) cur.push(tm)
  }

  // ── B：段级指标 ──
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
    seg.push({ v: va.v, tools: g.tools })
  }

  // 对齐：segTimes 与 S 都按 turn/start 切，长度应一致
  if (segTimes.length !== S.length) continue
  for (let i = 0; i < segTimes.length; i++) {
    const ts = segTimes[i]
    segEventCounts.push(ts.length)
    if (ts.length >= 2) {
      const span = (ts[ts.length - 1] - ts[0]) / 1000
      segSpans.push(span)
      for (let k = 1; k < ts.length; k++) {
        const d = (ts[k] - ts[k - 1]) / 1000
        if (d >= 0) gaps.push(d)
      }
    }
  }

  for (let i = 0; i < seg.length - 1; i++) {
    rows.push({ v: seg[i].v, tools: seg[i].tools, nextTools: seg[i + 1].tools })
  }
}

const pct = (arr, p) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
}

// ── 统计工具 ──
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
/** 一元 OLS 的 R²。 */
function r2simple(y, x) {
  const n = y.length
  const my = y.reduce((a, b) => a + b, 0) / n
  const mx = x.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my)
    sxx += (x[i] - mx) ** 2
    syy += (y[i] - my) ** 2
  }
  return sxx && syy ? (sxy * sxy) / (sxx * syy) : 0
}
/** 二元 OLS 的 R²（正规方程 2x2）。 */
function r2two(y, x1, x2) {
  const n = y.length
  const m = (a) => a.reduce((p, q) => p + q, 0) / n
  const my = m(y), m1 = m(x1), m2 = m(x2)
  let s11 = 0, s22 = 0, s12 = 0, sy1 = 0, sy2 = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const a = x1[i] - m1, b = x2[i] - m2, c = y[i] - my
    s11 += a * a; s22 += b * b; s12 += a * b
    sy1 += a * c; sy2 += b * c; syy += c * c
  }
  const det = s11 * s22 - s12 * s12
  if (Math.abs(det) < 1e-12 || syy === 0) return 0
  // 解 b1, b2
  const b1 = (sy1 * s22 - sy2 * s12) / det
  const b2 = (sy2 * s11 - sy1 * s12) / det
  return (b1 * sy1 + b2 * sy2) / syy
}

const y = rows.map((r) => r.nextTools)
const xv = rows.map((r) => r.v)
const xt = rows.map((r) => r.tools)

const rho_vn = spearman(xv, y)
const rho_tn = spearman(xt, y)
const rho_vt = spearman(xv, xt)
const partial = (rho_vn - rho_vt * rho_tn) / Math.sqrt((1 - rho_vt ** 2) * (1 - rho_tn ** 2))
const r2Base = r2simple(y, xt)
const r2Full = r2two(y, xt, xv)
const dR2 = r2Full - r2Base

const out = {
  n: rows.length,
  granularity: {
    segsWithEvents: segEventCounts.length,
    eventsPerSeg: { p10: pct(segEventCounts, 0.1), p50: pct(segEventCounts, 0.5), p90: pct(segEventCounts, 0.9), max: Math.max(...segEventCounts) },
    spanSec: { p10: pct(segSpans, 0.1), p50: pct(segSpans, 0.5), p90: pct(segSpans, 0.9) },
    gapSec: { p10: pct(gaps, 0.1), p50: pct(gaps, 0.5), p90: pct(gaps, 0.9), n: gaps.length },
    gapsUnder2s: gaps.filter((g) => g <= 2).length,
    gapsUnder10s: gaps.filter((g) => g <= 10).length,
  },
  nested: { rho_vn, rho_tn, rho_vt, partial, r2Base, r2Full, dR2 },
  frozen: FROZEN,
}

if (wantJson) {
  console.log(JSON.stringify(out, null, 2))
} else {
  const g = out.granularity
  console.log(`\n=== A. 段内事件时间戳分辨率（n=${out.n} 段）===`)
  console.log(`每段事件数：p10=${g.eventsPerSeg.p10}  p50=${g.eventsPerSeg.p50}  p90=${g.eventsPerSeg.p90}  max=${g.eventsPerSeg.max}`)
  console.log(`每段时长(秒)：p10=${g.spanSec.p10.toFixed(1)}  p50=${g.spanSec.p50.toFixed(1)}  p90=${g.spanSec.p90.toFixed(1)}`)
  console.log(`相邻事件间隔(秒)：p10=${g.gapSec.p10.toFixed(2)}  p50=${g.gapSec.p50.toFixed(2)}  p90=${g.gapSec.p90.toFixed(2)}  (共 ${g.gapSec.n} 个间隔)`)
  console.log(`间隔 ≤2 秒的：${g.gapsUnder2s} (${(g.gapsUnder2s / g.gapSec.n * 100).toFixed(1)}%)   ≤10 秒的：${g.gapsUnder10s} (${(g.gapsUnder10s / g.gapSec.n * 100).toFixed(1)}%)`)
  console.log(`\n⇒ 若「间隔 ≤2 秒」占比很低，就说明段内不是连续轨迹而是离散采样，学不了 Butler 的 2 秒切法。`)

  const q = out.nested
  console.log(`\n=== B. 控制工具数后 v 还剩多少（嵌套模型）===`)
  console.log(`  ρ(v, 下一段工具数)        = ${q.rho_vn.toFixed(3)}`)
  console.log(`  ρ(本段工具数, 下一段工具数) = ${q.rho_tn.toFixed(3)}`)
  console.log(`  ρ(v, 本段工具数)          = ${q.rho_vt.toFixed(3)}`)
  console.log(`  ── 偏相关 ρ(v, 下一段 | 本段工具数) = ${q.partial.toFixed(3)}`)
  console.log(`  R² 基线（只有工具数）     = ${q.r2Base.toFixed(4)}`)
  console.log(`  R² 扩展（工具数 + v）     = ${q.r2Full.toFixed(4)}`)
  console.log(`  ΔR²                       = ${q.dR2.toFixed(4)}`)
  const dead = Math.abs(q.partial) < FROZEN.partialDead && q.dR2 < FROZEN.dR2Dead
  console.log(`\n冻结判据：|偏相关|<${FROZEN.partialDead} 且 ΔR²<${FROZEN.dR2Dead} ⇒ v 在控制原料后无信息`)
  console.log(dead
    ? `⇒ ⛔ 成立：v 对下一段工具数**没有超出本段工具数的信息**。「有损压缩版」这个说法坐实。`
    : `⇒ ⚠️ 不完全成立，v 还留了一点（偏相关 ${q.partial.toFixed(3)} / ΔR² ${q.dR2.toFixed(4)}），需要看量级。`)
}
