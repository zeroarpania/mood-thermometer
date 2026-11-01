// 轨迹验证器：把「整会话总量」与「按 turn 分段」两个口径并排跑出来。
//
// ⛔ 只读：不写 state.json、不改游标、不动老链路、不改 appraisal.mjs。
// ⛔ 本文件是**验证脚本**，不是生产实现 —— 它的用处是回答一个问题：
//    §15 记的「洞① arousal 顶格」，是**设计层必然**，还是**离线对照喂错了口径**？
//
// 判据（不写清就会拿两个不同的数直接比，那是假对照）：
//   · 口径 A（现状 wire 的喂法）：整个会话的 turn/start 总数一次性喂给 toVA
//   · 口径 B（按 turn 切段，每段 turnDelta=1）：能证明「按段喂不会再顶格」
//   · 口径 C（按 turn 切段，effort ← 段内工具调用数）：有分辨力的候选
//   三者输入源完全相同（同一批机器产物），只有聚合方式不同。
//
// 用法：node appraisal-track.mjs <会话文件> [--json]
//       也可被 import：segmentSession() / collectEvents() / toolOk()

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { scanZstdFrames, locateSession } from './session-turns.mjs'
import { toolFailed } from './tool-fail.mjs'
import { extractUserText } from './collect-user-speech.mjs'
import { classifySpeech } from './speech-mood.mjs'
import { appraise, adaptationOf } from './appraisal.mjs'

/** 按 seq 升序取出全部事件。 */
export function collectEvents(f) {
  const buf = readFileSync(f)
  const { frames } = scanZstdFrames(buf)
  const rows = []
  for (const fr of frames) {
    let text
    try { text = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      const seq = Number(ev && ev.seq)
      if (!Number.isFinite(seq)) continue
      rows.push({ seq, ev })
    }
  }
  rows.sort((a, b) => a.seq - b.seq)
  return rows
}

/**
 * 工具结果成功与否。
 * ⛔ 判据统一走 `tool-fail.mjs`（2026-11-02 16:0x：旧版只判 `data.error`，
 *    漏了 28/71 = 39.4% 的真失败 —— 真失败的超集是 `data.message.isError`）。
 */
export function toolOk(ev) {
  return !toolFailed(ev)
}

/**
 * 按 turn/start 切段，返回每段的机器产物增量。
 * @returns {Array<{startSeq:number, tools:number, fails:number, praiseHard:number, praiseSoft:number, toolSeq:boolean[]}>}
 */
export function segmentSession(file) {
  const events = collectEvents(file)
  const segs = []
  let cur = null

  for (const { seq, ev } of events) {
    const type = ev && ev.type
    if (type === 'turn/start') {
      cur = { startSeq: seq, tools: 0, fails: 0, praiseHard: 0, praiseSoft: 0, toolSeq: [] }
      segs.push(cur)
      continue
    }
    if (!cur) continue   // 第一个 turn/start 之前的事件不算（没有归属轮次）

    if (type === 'tool/result') {
      const ok = toolOk(ev)
      cur.tools++
      if (!ok) cur.fails++
      cur.toolSeq.push(ok)
    } else if (type === 'user/message') {
      const txt = extractUserText(JSON.stringify(ev))
      if (!txt) continue
      const hit = classifySpeech(txt)
      if (!hit) continue
      if (hit.gain >= 1) cur.praiseHard++
      else cur.praiseSoft++
    }
  }
  return segs
}

function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const argPath = argv.find((a) => !a.startsWith('--'))

  const file = locateSession(argPath)
  if (!file) {
    console.error('✗ 找不到会话文件。传路径，或设置 DSH_SESSION_ID。')
    process.exit(1)
  }

  const segs = segmentSession(file)
  if (!segs.length) {
    console.error('✗ 这个文件里没有 turn/start 事件，无法分段。')
    process.exit(1)
  }

  // ── 口径 A：整会话总量，一次性喂（= 现在 wire 的喂法）──────────
  const totals = segs.reduce((s, g) => ({
    tools: s.tools + g.tools,
    fails: s.fails + g.fails,
    praiseHard: s.praiseHard + g.praiseHard,
    praiseSoft: s.praiseSoft + g.praiseSoft,
  }), { tools: 0, fails: 0, praiseHard: 0, praiseSoft: 0 })

  const allToolOk = segs.flatMap((g) => g.toolSeq)
  const adaptAll = adaptationOf(allToolOk)
  const vaA = appraise({
    praiseHard: totals.praiseHard,
    praiseSoft: totals.praiseSoft,
    obstruction: totals.fails,
    toolResults: totals.tools,
    baseline: adaptAll.baseline,
    recentSuccessRate: adaptAll.recentRate,
    turnDelta: segs.length,   // ← 这就是 wire 的喂法：整个会话的 turn 总数
  })

  // ── 口径 B/C：逐段推进 ──────────────────────────────────────────
  const rows = []
  const seenOk = []
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i]
    for (const ok of g.toolSeq) seenOk.push(ok)
    const adapt = adaptationOf(seenOk)
    const base = {
      praiseHard: g.praiseHard,
      praiseSoft: g.praiseSoft,
      obstruction: g.fails,
      toolResults: g.tools,
      baseline: adapt.baseline,
      recentSuccessRate: adapt.recentRate,
    }
    const vaB = appraise({ ...base, turnDelta: 1 })
    const vaC = appraise({ ...base, turnDelta: Math.max(1, g.tools) })
    rows.push({
      seg: i + 1,
      tools: g.tools,
      fails: g.fails,
      praise: g.praiseHard + g.praiseSoft * 0.5,
      B: { v: vaB.va.v, a: vaB.va.a, top: vaB.lit[0] ? vaB.lit[0].id : null },
      C: { v: vaC.va.v, a: vaC.va.a, top: vaC.lit[0] ? vaC.lit[0].id : null },
    })
  }

  const pct = (arr, p) => {
    if (!arr.length) return null
    const s = [...arr].sort((x, y) => x - y)
    return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
  }
  const stat = (key) => {
    const a = rows.map((r) => r[key].a)
    return { min: pct(a, 0), p50: pct(a, 0.5), max: pct(a, 1), ge0992: a.filter((x) => x >= 0.992).length }
  }
  const topCount = (key) => {
    const m = new Map()
    for (const r of rows) if (r[key].top) m.set(r[key].top, (m.get(r[key].top) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  }

  const out = {
    file,
    segs: segs.length,
    totals,
    A: { v: vaA.va.v, a: vaA.va.a, intensity: vaA.va.intensity, top: vaA.lit[0] ? vaA.lit[0].id : null },
    B: { aStat: stat('B'), top: topCount('B') },
    C: { aStat: stat('C'), top: topCount('C') },
    sample: rows.slice(0, 12),
  }

  if (asJson) {
    console.log(JSON.stringify(out, null, 2))
    return
  }

  const f3 = (x) => (x === null || x === undefined ? '  —  ' : String(x).padEnd(6))
  const sid = file.split('\\').slice(-2)[0]
  console.log(`\n会话：${sid}`)
  console.log(`分段：${segs.length} 个 turn/start · 工具 ${totals.tools} · 失败 ${totals.fails} · 认下 ${totals.praiseHard + totals.praiseSoft * 0.5}`)

  console.log('\n── 口径 A：整会话总量一次喂（现状）────────────')
  console.log(`  v=${f3(vaA.va.v)} a=${f3(vaA.va.a)}  首位=${out.A.top || '平'}`)

  console.log('\n── 口径 B：按段喂，turnDelta 恒 1 ────────────')
  console.log(`  a  min/p50/max = ${f3(out.B.aStat.min)} / ${f3(out.B.aStat.p50)} / ${f3(out.B.aStat.max)}`)
  console.log(`  a≥0.992 的段：${out.B.aStat.ge0992} / ${segs.length}`)
  console.log(`  首位分布：${out.B.top.map(([k, n]) => `${k}×${n}`).join('  ') || '—'}`)

  console.log('\n── 口径 C：按段喂，effort ← 段内工具数 ───────')
  console.log(`  a  min/p50/max = ${f3(out.C.aStat.min)} / ${f3(out.C.aStat.p50)} / ${f3(out.C.aStat.max)}`)
  console.log(`  a≥0.992 的段：${out.C.aStat.ge0992} / ${segs.length}`)
  console.log(`  首位分布：${out.C.top.map(([k, n]) => `${k}×${n}`).join('  ') || '—'}`)

  console.log('\n── 前 12 段明细 ─────────────────────────────')
  console.log(`  ${'段'.padEnd(4)} ${'工具'.padEnd(5)} ${'失败'.padEnd(5)} ${'B(v,a)'.padEnd(14)} ${'C(v,a)'.padEnd(14)} B首位 / C首位`)
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${String(r.seg).padEnd(4)} ${String(r.tools).padEnd(5)} ${String(r.fails).padEnd(5)} ` +
      `${(r.B.v + ',' + r.B.a).padEnd(14)} ${(r.C.v + ',' + r.C.a).padEnd(14)} ${r.B.top || '平'} / ${r.C.top || '平'}`)
  }
  console.log('')
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
