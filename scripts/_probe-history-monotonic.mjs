// §56-5 的执行：**N 段单调性** —— 把"早/晚两半"换成"按时间均分 N 段"，看曲线形状。
//
// ⛔ 为什么必须做（2026-11-03 01:0x）：
//   §56 只切了两半，看到 4/4 都变，但没区分两种截然不同的情况：
//     A. **单调演进** —— 随着历史积累一路往一个方向走 ⇒ 像在"变"
//     B. **中途跳变** —— 某一段突然掉头 ⇒ 更可能是任务构成变了，不是"变"
//   两者的证据强度差一个量级。判据必须在跑之前定死。
//
// 判据（冻结）：
//   ρ = Spearman(段序, 重试率)
//   |ρ| ≥ 0.8              ⇒ 「单调演进」
//   相邻段差 > 0.3         ⇒ 「跳变」（优先于单调判定）
//   其余                    ⇒ 「无规律」
//
// 用法：node _probe-history-monotonic.mjs --from <清单.txt> [--n 4] [--json]

import { readFileSync } from 'node:fs'
import { collectEvents } from './appraisal-track.mjs'
import { toolFailureOf } from './tool-fail.mjs'

const FROZEN = { N: 4, minPerBucket: 8, monotoneRho: 0.8, jumpGap: 0.3 }

const argv = process.argv.slice(2)
const fromIdx = argv.indexOf('--from')
if (fromIdx < 0) { console.error('✗ 需要 --from <清单.txt>'); process.exit(1) }
const nIdx = argv.indexOf('--n')
const N = nIdx >= 0 ? Math.max(2, Number(argv[nIdx + 1]) || FROZEN.N) : FROZEN.N
const files = readFileSync(argv[fromIdx + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
const wantJson = argv.includes('--json')
console.error(`扫 ${files.length} 个会话 · N=${N} 段…`)

const triggers = []
for (const f of files) {
  let evs
  try { evs = collectEvents(f) } catch { continue }
  if (!evs.length) continue
  const nameOf = new Map()
  for (const { ev } of evs) {
    if (ev && ev.type === 'tool/call' && ev.data && ev.data.callId && ev.data.name) nameOf.set(ev.data.callId, ev.data.name)
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
    let retrySame = 0, retryCount = 0
    for (let j = i + 1; j < evs.length; j++) {
      const n = evs[j].ev
      if (!n) continue
      if (n.type === 'user/message') break
      if (n.type !== 'tool/call' || !n.data) continue
      if (n.data.name === toolName) { retrySame = 1; retryCount++ }
    }
    triggers.push({ t, sig: `${toolName}::${fail.kind === 'exit-nonzero' ? fail.detail : (fail.detail || 'err')}`, retrySame, retryCount })
  }
}

const bySig = new Map()
for (const r of triggers) {
  if (!bySig.has(r.sig)) bySig.set(r.sig, [])
  bySig.get(r.sig).push(r)
}

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
      retrySame: b.reduce((p, q) => p + q.retrySame, 0) / b.length,
      retryCount: b.reduce((p, q) => p + q.retryCount, 0) / b.length,
      t0: b[0].t,
      t1: b[b.length - 1].t,
    })
  }
  const rates = buckets.map((b) => b.retrySame)
  const rho = spearman(buckets.map((_, i) => i), rates)
  let maxGap = 0
  for (let k = 1; k < rates.length; k++) maxGap = Math.max(maxGap, Math.abs(rates[k] - rates[k - 1]))
  let verdict
  if (maxGap > FROZEN.jumpGap) verdict = '⛔ 跳变（更可能是任务构成变了）'
  else if (Number.isFinite(rho) && Math.abs(rho) >= FROZEN.monotoneRho) verdict = '✅ 单调演进'
  else verdict = '⚠️ 无规律'
  rows.push({ sig, n: list.length, buckets, rho, maxGap, verdict })
}
rows.sort((a, b) => b.n - a.n)

if (wantJson) {
  console.log(JSON.stringify({ N, frozen: FROZEN, totalTriggers: triggers.length, rows }, null, 2))
} else {
  console.log(`\n触发 ${triggers.length} 次 · N=${N} · 每段≥${FROZEN.minPerBucket} 才入表`)
  console.log(`够格的签名：**${rows.length}** 个\n`)
  if (!rows.length) {
    console.log('⛔ 没有签名样本够分 N 段 ⇒ 单调性在这个语料上做不了。')
  }
  for (const r of rows) {
    const d = (t) => new Date(t).toISOString().slice(0, 10)
    console.log(`■ ${r.sig}  (n=${r.n})  ρ=${Number.isFinite(r.rho) ? r.rho.toFixed(2) : '—'}  最大相邻落差=${r.maxGap.toFixed(2)}  ${r.verdict}`)
    console.log(`   跨度 ${d(r.buckets[0].t0)} → ${d(r.buckets[r.buckets.length - 1].t1)}`)
    console.log('   段   起止日期             n    重试率   重试次数')
    r.buckets.forEach((b, k) => {
      console.log(`   ${String(k + 1).padStart(2)}   ${d(b.t0)}~${d(b.t1)}   ${String(b.n).padStart(3)}   ${b.retrySame.toFixed(3)}   ${b.retryCount.toFixed(2)}`)
    })
    console.log('')
  }
  console.log(`冻结判据：|ρ|≥${FROZEN.monotoneRho} ⇒ 单调；相邻落差>${FROZEN.jumpGap} ⇒ 跳变（优先）。`)
}
