// 追 0.497：为什么 `ρ(本段工具数, 下一段工具数)` 换样本几乎不动？
//
// ⛔ 使用者的怀疑（2026-11-03 01:2x）：筛掉污染数据后样本从 3573→3262，这个数却纹丝不动，
//   「太扎眼了，太稳定了」。正常相关系数不该这么稳。
//
// 要验的假设（按顺序排除）：
//   H1 分布塌缩：tools / nextTools 大量 0 与 1 ⇒ 秩只有少数几档，ρ 被锁住
//   H2 算法错：rank 函数对 ties 处理有问题
//   H3 真相关：确实是稳定的真关系
//
// 判据（跑前冻结）：
//   若 ties 比例 > 50%，或子样本 ρ 的标准差 < 0.02 ⇒ 判为「锁死」（H1）
//   否则 ⇒ 判为「真稳定」
//
// 用法：node _probe-tools-autocorr.mjs --from <清单.txt> [--json]

import { readFileSync } from 'node:fs'
import { segmentSession } from './appraisal-track.mjs'

const FROZEN = { tiesDead: 0.5, sdDead: 0.02, bootN: 200 }

const argv = process.argv.slice(2)
const fromIdx = argv.indexOf('--from')
if (fromIdx < 0) { console.error('✗ 需要 --from'); process.exit(1) }
const files = readFileSync(argv[fromIdx + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
const wantJson = argv.includes('--json')
console.error(`扫 ${files.length} 个会话…`)

const pairs = []   // {tools, nextTools}
const perSession = []  // 每个会话自己的 pairs（供 bootstrap）
for (const f of files) {
  let S
  try { S = segmentSession(f) } catch { continue }
  if (S.length < 2) continue
  const own = []
  for (let i = 0; i < S.length - 1; i++) {
    const r = { tools: S[i].tools, nextTools: S[i + 1].tools }
    own.push(r)
    pairs.push(r)
  }
  perSession.push(own)
}

const xs = pairs.map((p) => p.tools)
const ys = pairs.map((p) => p.nextTools)

const rank = (arr) => {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => x0(a) - x0(b)).map((p) => p)
  function x0(p) { return p[0] }
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
function pearson(a, b) {
  const n = a.length
  const ma = a.reduce((p, q) => p + q, 0) / n
  const mb = b.reduce((p, q) => p + q, 0) / n
  let sa = 0, sb = 0, sab = 0
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sa += da * da; sb += db * db; sab += da * db }
  return sa && sb ? sab / Math.sqrt(sa * sb) : NaN
}
function spearman(a, b) { return pearson(rank(a), rank(b)) }

// ── 分布 ──
const dist = (arr) => {
  const m = new Map()
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1)
  return [...m.entries()].sort((p, q) => p[0] - q[0])
}
const distX = dist(xs)
const distY = dist(ys)
const tiesShare = (arr) => {
  const m = new Map()
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1)
  let tied = 0
  for (const c of m.values()) if (c > 1) tied += c
  return arr.length ? tied / arr.length : 0
}

const rhoS = spearman(xs, ys)
const rhoP = pearson(xs, ys)

// ── bootstrap：按会话整块重抽样（保持会话内部相关结构）──
const boot = []
for (let b = 0; b < FROZEN.bootN; b++) {
  const pick = []
  for (let k = 0; k < perSession.length; k++) if (Math.random() < 0.5) pick.push(k)
  if (!pick.length) continue
  const bx = [], by = []
  for (const k of pick) for (const p of perSession[k]) { bx.push(p.tools); by.push(p.nextTools) }
  if (bx.length > 10) boot.push(spearman(bx, by))
}
const mean = boot.reduce((p, q) => p + q, 0) / boot.length
const sd = Math.sqrt(boot.reduce((p, q) => p + (q - mean) ** 2, 0) / boot.length)
boot.sort((a, b) => a - b)

// ── 分组看 nextTools 均值 ──
const groups = new Map()
for (const p of pairs) {
  const k = p.tools >= 5 ? '5+' : String(p.tools)
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(p.nextTools)
}
const gOrder = (k) => (k === '5+' ? 5 : Number(k))
const groupRows = [...groups.entries()].sort((a, b) => gOrder(a[0]) - gOrder(b[0]))
  .map(([k, arr]) => ({ tools: k, n: arr.length, meanNext: arr.reduce((p, q) => p + q, 0) / arr.length, share: arr.length / pairs.length }))

const out = {
  n: pairs.length,
  rhoSpearman: rhoS,
  rhoPearson: rhoP,
  ties: { x: tiesShare(xs), y: tiesShare(ys) },
  distTop: { x: distX.slice(0, 6), y: distY.slice(0, 6) },
  boot: { n: boot.length, mean, sd, p05: boot[Math.floor(boot.length * 0.05)], p95: boot[Math.floor(boot.length * 0.95)] },
  groups: groupRows,
  frozen: FROZEN,
}

if (wantJson) console.log(JSON.stringify(out, null, 2))
else {
  console.log(`\n样本 n=${out.n}\n`)
  console.log(`=== 主结果 ===`)
  console.log(`  Spearman ρ = ${rhoS.toFixed(3)}`)
  console.log(`  Pearson  r = ${rhoP.toFixed(3)}`)
  console.log(`\n=== H1：分布是否塌缩 ===`)
  console.log(`  ties 比例：tools=${(out.ties.x * 100).toFixed(1)}%  nextTools=${(out.ties.y * 100).toFixed(1)}%`)
  console.log(`  tools 前 6 档：${distX.slice(0, 6).map(([v, c]) => `${v}×${c}`).join('  ')}`)
  console.log(`  nextTools 前 6 档：${distY.slice(0, 6).map(([v, c]) => `${v}×${c}`).join('  ')}`)
  console.log(`\n=== H3：bootstrap（按会话整块抽一半，${boot.length} 次）===`)
  console.log(`  mean=${mean.toFixed(3)}  sd=${sd.toFixed(3)}  p05=${boot[Math.floor(boot.length * 0.05)].toFixed(3)}  p95=${boot[Math.floor(boot.length * 0.95)].toFixed(3)}`)
  console.log(`\n=== 分组看形状 ===`)
  console.log('  本段工具数   段数    占比    下一段工具数均值')
  for (const g of groupRows) console.log(`  ${g.tools.padEnd(10)} ${String(g.n).padStart(5)}  ${(g.share * 100).toFixed(1).padStart(5)}%   ${g.meanNext.toFixed(2)}`)
  console.log('')
  const dead = (out.ties.x > FROZEN.tiesDead || out.ties.y > FROZEN.tiesDead) || sd < FROZEN.sdDead
  console.log(dead
    ? '⇒ ⛔ 判为「锁死」：分布大量并列 + 子样本几乎不波动 ⇒ 这个 0.497 是秩结构造成的，不能当强相关的证据。'
    : '⇒ ✅ 判为「真稳定」：ties 不极端且子样本有正常波动 ⇒ 这个相关是实的。')
}
