// 「学会」还是「放弃」？—— 重试率下降的两种相反解读，靠**最终救回率**区分。
//
// ⛔ 为什么要做（2026-11-03 01:1x）：
//   §58 看到重试率从 3.5 次/失败 掉到 0.25 次/失败。我读成「学会了」。
//   但 arXiv 2601.04170（Agent Drift）给了反向解读：**行为漂移 = 出现非预期策略**，
//   其中包括「不再按原方式响应」。**降重试也可能是「放弃了」。**
//
//   判别办法：看同一个会话里，那次失败**最终有没有被救回来**（后续同工具成功调用）。
//     救回率不降 ⇒ 高效（学会不白费力气）
//     救回率下降 ⇒ 放弃（drift）
//
// 判据（跑前冻结）：
//   救回率差 > 0.10 且后段更低 ⇒ ⛔ 判为「放弃/漂移」
//   救回率差 ≤ 0.10            ⇒ ✅ 判为「高效/学会」
//
// 用法：node _probe-recovery-rate.mjs --from <清单.txt> [--n 4] [--json]

import { readFileSync } from 'node:fs'
import { collectEvents } from './appraisal-track.mjs'
import { toolFailureOf } from './tool-fail.mjs'

const FROZEN = { N: 4, minPerBucket: 8, driftGap: 0.10 }

const argv = process.argv.slice(2)
const fromIdx = argv.indexOf('--from')
if (fromIdx < 0) { console.error('✗ 需要 --from <清单.txt>'); process.exit(1) }
const nIdx = argv.indexOf('--n')
const N = nIdx >= 0 ? Math.max(2, Number(argv[nIdx + 1]) || FROZEN.N) : FROZEN.N
const files = readFileSync(argv[fromIdx + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
const wantJson = argv.includes('--json')
console.error(`扫 ${files.length} 个会话 · N=${N}…`)

const triggers = []
for (const f of files) {
  let evs
  try { evs = collectEvents(f) } catch { continue }
  if (!evs.length) continue

  // callId → name / 是否成功
  const nameOf = new Map()
  const okOf = new Map()   // callId -> true/false（该次调用的结果是否成功）
  for (const { ev } of evs) {
    if (!ev) continue
    if (ev.type === 'tool/call' && ev.data && ev.data.callId && ev.data.name) nameOf.set(ev.data.callId, ev.data.name)
    if (ev.type === 'tool/result' && ev.data && ev.data.message && ev.data.message.toolCallId) {
      okOf.set(ev.data.message.toolCallId, toolFailureOf(ev) === null)
    }
  }

  for (let i = 0; i < evs.length; i++) {
    const { ev } = evs[i]
    if (!ev || ev.type !== 'tool/result') continue
    const fail = toolFailureOf(ev)
    if (!fail) continue
    const callId = ev.data && ev.data.message && ev.data.message.toolCallId
    const toolName = callId ? nameOf.get(callId) : null
    if (!toolName) continue
    const t = Number(ev.time)
    if (!Number.isFinite(t)) continue

    // 窗口：本失败之后、**同一会话内**任意时刻，同工具是否出现过成功调用
    let recovered = 0
    for (let j = i + 1; j < evs.length; j++) {
      const n = evs[j].ev
      if (!n || n.type !== 'tool/result') continue
      const nid = n.data && n.data.message && n.data.message.toolCallId
      if (!nid) continue
      if (nameOf.get(nid) === toolName && okOf.get(nid) === true) { recovered = 1; break }
    }

    triggers.push({ t, sig: `${toolName}::${fail.kind === 'exit-nonzero' ? fail.detail : (fail.detail || 'err')}`, recovered })
  }
}

const bySig = new Map()
for (const r of triggers) {
  if (!bySig.has(r.sig)) bySig.set(r.sig, [])
  bySig.get(r.sig).push(r)
}

const rows = []
for (const [sig, list] of bySig) {
  if (list.length < N * FROZEN.minPerBucket) continue
  list.sort((a, b) => a.t - b.t)
  const per = Math.floor(list.length / N)
  const buckets = []
  for (let k = 0; k < N; k++) {
    const lo = k * per
    const hi = k === N - 1 ? list.length : (k + 1) * per
    const b = list.slice(lo, hi)
    buckets.push({
      n: b.length,
      recovery: b.reduce((p, q) => p + q.recovered, 0) / b.length,
      t0: b[0].t,
      t1: b[b.length - 1].t,
    })
  }
  const first = buckets.slice(0, Math.ceil(N / 2))
  const last = buckets.slice(-Math.ceil(N / 2))
  const avg = (arr) => arr.reduce((p, q) => p + q.recovery, 0) / arr.length
  const gap = avg(first) - avg(last)   // 正 = 后段更低
  let verdict
  if (gap > FROZEN.driftGap) verdict = '⛔ 后段救回率更低 ⇒ 更像「放弃/漂移」'
  else verdict = '✅ 救回率没降 ⇒ 更像「高效/学会」'
  rows.push({ sig, n: list.length, buckets, early: avg(first), late: avg(last), gap, verdict })
}
rows.sort((a, b) => b.n - a.n)

if (wantJson) console.log(JSON.stringify({ N, frozen: FROZEN, rows }, null, 2))
else {
  const d = (t) => new Date(t).toISOString().slice(0, 10)
  console.log(`\n触发 ${triggers.length} 次 · N=${N} · 每段≥${FROZEN.minPerBucket} 才入表`)
  console.log(`够格签名：${rows.length} 个\n`)
  if (!rows.length) console.log('⛔ 样本不够。')
  for (const r of rows) {
    console.log(`■ ${r.sig}  (n=${r.n})  前段救回率=${r.early.toFixed(3)}  后段=${r.late.toFixed(3)}  差=${r.gap.toFixed(3)}  ${r.verdict}`)
    console.log('   段   起止日期             n    最终救回率')
    r.buckets.forEach((b, k) => {
      console.log(`   ${String(k + 1).padStart(2)}   ${d(b.t0)}~${d(b.t1)}   ${String(b.n).padStart(3)}   ${b.recovery.toFixed(3)}`)
    })
    console.log('')
  }
  console.log(`冻结判据：前后段救回率差 >${FROZEN.driftGap} 且后段更低 ⇒「放弃」；否则「高效」。`)
}
