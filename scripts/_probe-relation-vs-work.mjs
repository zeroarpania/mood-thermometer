// 关系/伦理信号能不能打过「工作量」基线（对 §46 的 0.496 那道坎）。
//
// ⛔ 为什么必须跑这个（2026-11-03 00:5x）：
//   覆盖率普查（_probe-relation-signals.mjs）筛出两个够格的候选：userMsg / correction。
//   但这两个都**极可能是工作量的另一个别名** —— 活干得多，出错被纠正的机会也多。
//   如果打不过 `ρ(tools_t, nextTools) = 0.496`，那它们跟 v 是同一个病。
//
// 设计：**跨族预测**。用「关系侧信号」预测「下一段的工作行为」，
//   而不是拿关系信号预测关系信号（那是同一信号族的时间延续，§45-3 已明令禁止）。
//
// 判据（跑前冻结）：
//   Δρ = |ρ(关系信号, 目标)| − |ρ(本段工具数, 目标)|
//   Δρ ≤ 0.05  ⇒ ⛔ 否决：只是工作量的别名
//   Δρ > 0.05 且 |ρ| > 0.10 ⇒ ✅ 有增量
//
// 用法：node _probe-relation-vs-work.mjs --from <清单.txt> [--json]

import { readFileSync } from 'node:fs'
import { collectEvents } from './appraisal-track.mjs'
import { extractUserText } from './collect-user-speech.mjs'

const FROZEN = { margin: 0.05, minAbs: 0.10 }
const RE_CORRECT = /不对|不是这样|别|不要|先别|停下|错了|重来|改一下|再想想到|走不通/

const argv = process.argv.slice(2)
const fromIdx = argv.indexOf('--from')
if (fromIdx < 0) { console.error('✗ 需要 --from <清单.txt>'); process.exit(1) }
const files = readFileSync(argv[fromIdx + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
const wantJson = argv.includes('--json')
console.error(`扫 ${files.length} 个会话…`)

function outLenOf(ev) {
  const c = ev && ev.data && ev.data.message && ev.data.message.content
  if (!Array.isArray(c)) return 0
  let n = 0
  for (const x of c) if (x && x.type === 'text' && typeof x.text === 'string') n += x.text.length
  return n
}

const rows = []
for (const f of files) {
  let evs
  try { evs = collectEvents(f) } catch { continue }
  const segs = []
  let cur = null
  for (const { ev } of evs) {
    const t = ev && ev.type
    if (t === 'turn/start') {
      cur = { tools: 0, userMsgCount: 0, correction: 0, outLen: 0 }
      segs.push(cur)
      continue
    }
    if (!cur) continue
    if (t === 'tool/result') cur.tools++
    else if (t === 'assistant/message') cur.outLen += outLenOf(ev)
    else if (t === 'user/message') {
      const txt = extractUserText(JSON.stringify(ev))
      if (!txt) continue
      cur.userMsgCount++
      if (RE_CORRECT.test(txt)) cur.correction = 1
    }
  }
  for (let i = 0; i < segs.length - 1; i++) {
    segs[i].nextTools = segs[i + 1].tools
    segs[i].nextOutLen = segs[i + 1].outLen
  }
  for (let i = 0; i < segs.length - 1; i++) rows.push(segs[i])
}

const n = rows.length
console.log(`\n有下一段的段 n=${n}`)

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

const results = []
for (const target of ['nextTools', 'nextOutLen']) {
  for (const sig of ['correction', 'userMsgCount']) {
    const xs = rows.map((r) => r[sig])
    const ys = rows.map((r) => r[target])
    const base = rows.map((r) => r.tools)
    const rhoSig = spearman(xs, ys)
    const rhoBase = spearman(base, ys)
    const delta = Math.abs(rhoSig) - Math.abs(rhoBase)
    let verdict
    if (!Number.isFinite(rhoSig)) verdict = '无法算'
    else if (delta <= FROZEN.margin) verdict = '⛔ 否决：工作量的别名'
    else if (Math.abs(rhoSig) > FROZEN.minAbs) verdict = '✅ 有增量'
    else verdict = '⚠️ 待定'
    results.push({ target, sig, rhoSig, rhoBase, delta, verdict })
  }
}

if (wantJson) {
  console.log(JSON.stringify({ n, frozen: FROZEN, results }, null, 2))
} else {
  const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  —  ')
  console.log('\n=== 关系信号 vs 工作量基线（跨族预测） ===')
  console.log('目标 + 信号               ρ(信号)   ρ(工具数基线)   Δρ      判决')
  for (const r of results) {
    console.log(
      `${(r.target + ' ← ' + r.sig).padEnd(26)} ${f3(r.rhoSig).padStart(7)}  ${f3(r.rhoBase).padStart(11)}   ${(r.delta >= 0 ? '+' : '') + f3(r.delta).padStart(7)}  ${r.verdict}`
    )
  }
  console.log(`\n冻结判据：Δρ = |ρ(信号)| − |ρ(本段工具数)|；≤${FROZEN.margin} 否决`)
  const pass = results.filter((r) => r.verdict.startsWith('✅'))
  console.log(pass.length
    ? `\n⇒ ${pass.length} 项有增量。`
    : '\n⇒ 全部否决：关系侧信号在这批数据里也打不过「本段工具数」，跟 v 一个病。')
}
