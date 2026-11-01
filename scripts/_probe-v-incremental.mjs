// 否决性检验：**v 打不打得过它自己的构成成分**（增量效度）。
//
// ⛔ 为什么有这个（2026-11-03 00:2x，GPT 审阅意见 §四 的落地）：
//   原计划跑完那 7 步验证流程太重。先做一个最便宜、能直接否决的：
//   如果 v 的预测力不超过「本段工具数」「本段成功率」这两个构成成分，
//   那后面 6 步（冻结模型、时间切分、跨情境复核、干预验证）全都不用做。
//
// 被预测目标：**下一段的行为**，且这两样 v 从未吃过：
//   ① nextTools  下一段工具调用数
//   ② nextOutLen 下一段 assistant 输出总字符数
//
// ⛔ 判据在跑之前写死，跑完不许改（GPT 意见第四节「冻结模型」）：
//   Δρ = |ρ(v, 目标)| − max(|ρ(tools, 目标)|, |ρ(rate, 目标)|)
//   Δρ ≤ 0.05                      ⇒ 否决：v 无增量效度
//   Δρ > 0.05 且 |ρ(v, 目标)| > 0.10 ⇒ 通过：v 有增量效度
//   其余                            ⇒ 待定
//
// 用法：
//   node _probe-v-incremental.mjs --from <清单.txt>
//   node _probe-v-incremental.mjs --from <清单.txt> --json

import { readFileSync } from 'node:fs'
import { toVA, adaptationOf } from './appraisal.mjs'
import { segmentSession, collectEvents } from './appraisal-track.mjs'

const FROZEN = { margin: 0.05, minAbs: 0.10 }

const argv = process.argv.slice(2)
const fromIdx = argv.indexOf('--from')
if (fromIdx < 0) {
  console.error('✗ 需要 --from <清单.txt>（用 _probe-corpus-scan.mjs --files --out 生成）')
  process.exit(1)
}
const files = readFileSync(argv[fromIdx + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
const wantJson = argv.includes('--json')
console.error(`读 ${files.length} 个会话…`)

/** assistant/message 的输出字符数（只算 type==='text' 的块）。 */
function outLenOf(ev) {
  const c = ev && ev.data && ev.data.message && ev.data.message.content
  if (!Array.isArray(c)) return 0
  let n = 0
  for (const x of c) if (x && x.type === 'text' && typeof x.text === 'string') n += x.text.length
  return n
}

/** 按 turn/start 切段，只统计每段输出字符数。与 segmentSession 的切分口径一致。 */
function outLenSegments(file) {
  const segs = []
  let cur = null
  for (const { ev } of collectEvents(file)) {
    const t = ev && ev.type
    if (t === 'turn/start') { cur = { outLen: 0 }; segs.push(cur); continue }
    if (!cur) continue
    if (t === 'assistant/message') cur.outLen += outLenOf(ev)
  }
  return segs
}

// ── 采集 ────────────────────────────────────────────────────
const rows = []   // {v, tools, rate, failsNow, nextTools, nextOutLen}
let segErr = 0
for (const f of files) {
  let S, L
  try { S = segmentSession(f); L = outLenSegments(f) } catch (e) { segErr++; continue }
  if (S.length !== L.length) {
    // ⛔ 段数不一致 = 两条切分口径错位，宁可停也不许拼
    console.error(`✗ 段数不一致，跳过：${f}\n  segmentSession=${S.length}  outLenSegments=${L.length}`)
    segErr++
    continue
  }
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
    seg.push({
      v: va.v,
      tools: g.tools,
      rate: g.tools > 0 ? (g.tools - g.fails) / g.tools : null,
      outLen: L[i].outLen,
      nextTools: null,
      nextOutLen: null,
    })
  }
  // ⚠️ 字段名教训（11-02 18:2x）：next 一律显式赋值，不靠拼接字符串
  for (let i = 0; i < seg.length - 1; i++) {
    seg[i].nextTools = seg[i + 1].tools
    seg[i].nextOutLen = seg[i + 1].outLen
  }
  for (const r of seg) if (r.nextTools !== null) rows.push(r)
}

const n = rows.length
console.log(`\n会话 ${files.length}（跳过 ${segErr}）· 有下一段的段 n=${n}`)

// ── 统计 ────────────────────────────────────────────────────
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

function test(targetKey, label) {
  const ok = rows.filter((r) => Number.isFinite(r[targetKey]) && r.v !== null)
  const rhoV = spearman(ok.map((r) => r.v), ok.map((r) => r[targetKey]))
  const rhoT = spearman(ok.map((r) => r.tools), ok.map((r) => r[targetKey]))
  const withRate = ok.filter((r) => r.rate !== null)
  const rhoR = withRate.length > 10
    ? spearman(withRate.map((r) => r.rate), withRate.map((r) => r[targetKey]))
    : NaN
  const best = Math.max(Math.abs(rhoT), Number.isFinite(rhoR) ? Math.abs(rhoR) : 0)
  const delta = Math.abs(rhoV) - best
  let verdict
  if (!Number.isFinite(rhoV)) verdict = '无法算'
  else if (delta <= FROZEN.margin) verdict = '⛔ 否决：v 无增量效度'
  else if (Math.abs(rhoV) > FROZEN.minAbs) verdict = '✅ 通过：v 有增量效度'
  else verdict = '⚠️ 待定'
  return { label, targetKey, n: ok.length, nRate: withRate.length, rhoV, rhoT, rhoR, best, delta, verdict }
}

const results = [test('nextTools', '下一段工具数'), test('nextOutLen', '下一段输出长度')]

if (wantJson) {
  console.log(JSON.stringify({ n, segErr, frozen: FROZEN, results }, null, 2))
} else {
  const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  —  ')
  console.log('\n=== 增量效度：v vs 它自己的构成成分 ===')
  console.log(`目标                 n      ρ(v)    ρ(tools)  ρ(rate)   Δρ     判决`)
  for (const r of results) {
    console.log(
      `${r.label.padEnd(18)} ${String(r.n).padStart(5)}  ${f3(r.rhoV)}  ${f3(r.rhoT).padStart(8)}  ${f3(r.rhoR).padStart(8)}  ${(r.delta >= 0 ? '+' : '') + f3(r.delta).padStart(6)}  ${r.verdict}`
    )
  }
  console.log(`\n冻结判据（跑前定，不许改）：Δρ = |ρ(v)| − max(|ρ(tools)|,|ρ(rate)|)；≤${FROZEN.margin} 否决，>${FROZEN.margin} 且 |ρ(v)|>${FROZEN.minAbs} 通过`)
  const bad = results.filter((r) => r.verdict.startsWith('⛔'))
  console.log(bad.length === results.length
    ? '\n⇒ 两个目标全被否决：v 的全部预测力都来自它自己的构成成分。'
    : `\n⇒ ${bad.length}/${results.length} 个目标被否决。`)
}
