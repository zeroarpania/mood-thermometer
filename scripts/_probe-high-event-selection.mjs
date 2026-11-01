// 验「选项①（只在高事件段做轨迹）能不能锤」的唯一硬伤：**选择偏差**。
//
// ⛔ 问题（2026-11-03 00:5x）：
//   §49 显示只有 p90 档（≥57 个事件）的段点数够做轨迹。但那档段是「干活特别多」的段，
//   而 §44 已证「工具数越多 → 下一段越容易失败」。若高事件段系统性 =「忙/高压」，
//   那用它做轨迹只测得到「忙的时候长什么样」，测不到「累」。
//
// 判据（跑前冻结）：
//   若 p90 档的 工具数/失败率/v 与其余段差异显著 ⇒ 有选择偏差 ⇒ 选项①不能锤
//
// 用法：node _probe-high-event-selection.mjs --from <清单.txt> [--json]

import { readFileSync } from 'node:fs'
import { collectEvents, segmentSession } from './appraisal-track.mjs'
import { toVA, adaptationOf } from './appraisal.mjs'

const FROZEN = { highEventsPerSeg: 57 }   // p90，来自 §49

const argv = process.argv.slice(2)
const fromIdx = argv.indexOf('--from')
if (fromIdx < 0) { console.error('✗ 需要 --from <清单.txt>'); process.exit(1) }
const files = readFileSync(argv[fromIdx + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
const wantJson = argv.includes('--json')
console.error(`扫 ${files.length} 个会话…`)

const KEEP = new Set(['turn/start', 'step/start', 'tool/call', 'tool/result', 'assistant/message', 'user/message', 'step/end', 'turn/end'])

const high = []   // 事件数 ≥ 阈值
const low = []    // 其余

for (const f of files) {
  let evs, S
  try { evs = collectEvents(f); S = segmentSession(f) } catch { continue }
  if (!S.length) continue

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
  if (segTimes.length !== S.length) continue

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
    const rec = {
      events: segTimes[i].length,
      tools: g.tools,
      fails: g.fails,
      rate: g.tools > 0 ? (g.tools - g.fails) / g.tools : null,
      v: va.v,
    }
    if (rec.events >= FROZEN.highEventsPerSeg) high.push(rec)
    else low.push(rec)
  }
}

const mean = (arr, k) => {
  const a = arr.map((r) => r[k]).filter((x) => x !== null && Number.isFinite(x))
  return a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN
}
const med = (arr, k) => {
  const a = arr.map((r) => r[k]).filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y)
  return a.length ? a[Math.floor(a.length / 2)] : NaN
}

const cmp = (label, k) => ({
  label,
  high: { mean: mean(high, k), median: med(high, k) },
  low: { mean: mean(low, k), median: med(low, k) },
})

const rows = [cmp('事件数', 'events'), cmp('工具数', 'tools'), cmp('失败数', 'fails'), cmp('成功率', 'rate'), cmp('v', 'v')]

const out = {
  threshold: FROZEN.highEventsPerSeg,
  nHigh: high.length,
  nLow: low.length,
  highShare: high.length / (high.length + low.length),
  rows,
}
if (wantJson) console.log(JSON.stringify(out, null, 2))
else {
  const f2 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  —  ')
  console.log(`\n高事件段（≥${FROZEN.highEventsPerSeg} 事件）：${high.length} 段（${(out.highShare * 100).toFixed(1)}%）`)
  console.log(`其余段：${low.length} 段\n`)
  console.log('量           高事件段(均值/中位)      其余段(均值/中位)')
  for (const r of rows) {
    console.log(`${r.label.padEnd(10)} ${f2(r.high.mean).padStart(9)} / ${f2(r.high.median).padStart(9)}   ${f2(r.low.mean).padStart(9)} / ${f2(r.low.median).padStart(9)}`)
  }
  const toolGap = mean(high, 'tools') / (mean(low, 'tools') || 1)
  const vGap = mean(high, 'v') - mean(low, 'v')
  console.log(`\n⇒ 高事件段的工具数是其余的 ${toolGap.toFixed(1)} 倍；v 偏移 ${vGap >= 0 ? '+' : ''}${f2(vGap)}`)
  console.log(toolGap > 2
    ? `⛔ 差异过大 ⇒ **高事件段 = 忙段**，用它们做轨迹有系统性选择偏差 ⇒ 选项①不能锤。`
    : `⚠️ 差异不明显，选项①的选择偏差没那么严重，可以再议。`)
}
