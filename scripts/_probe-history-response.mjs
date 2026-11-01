// §54-5 的执行：**同一个触发条件，在不同历史位置的反应差异**。
//
// ⛔ 这是「成为自己 vs 成为别人」的直接检验（2026-11-03 01:0x）：
//   判据：换一段历史，读数变不变？
//     不变 ⇒ 通用反应（成为别人）
//     变，且方向随历史演进 ⇒ 才可能是「这个 agent 在变」（成为自己）
//
// 触发条件 = 同一个 tool name + 同一个 error code（**必须同签名**，否则测的是不同事件）
// 反应指标 = 该失败之后、他说下一句之前：
//   retrySame   是否再调同一工具（0/1）
//   retryCount  同一工具再调几次
//   switchTool  是否换用别的工具（0/1）
//
// 分组 = 按事件绝对时间，全体触发事件按时间中位数切早/晚两半
//
// 用法：node _probe-history-response.mjs --from <清单.txt> [--min 20] [--json]

import { readFileSync } from 'node:fs'
import { collectEvents } from './appraisal-track.mjs'
import { toolFailureOf } from './tool-fail.mjs'

const argv = process.argv.slice(2)
const fromIdx = argv.indexOf('--from')
if (fromIdx < 0) { console.error('✗ 需要 --from <清单.txt>'); process.exit(1) }
const minIdx = argv.indexOf('--min')
const MIN_SIG = minIdx >= 0 ? Number(argv[minIdx + 1]) || 20 : 20
const files = readFileSync(argv[fromIdx + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
const wantJson = argv.includes('--json')
console.error(`扫 ${files.length} 个会话（同签名样本下限 ${MIN_SIG}）…`)

const triggers = []   // {t, sig, retrySame, retryCount, switchTool}

for (const f of files) {
  let evs
  try { evs = collectEvents(f) } catch { continue }
  if (!evs.length) continue

  // callId → tool name
  const nameOf = new Map()
  for (const { ev } of evs) {
    if (ev && ev.type === 'tool/call' && ev.data) {
      const id = ev.data.callId
      const n = ev.data.name
      if (id && n) nameOf.set(id, n)
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

    // 窗口：本失败之后 → 下一条 user/message（他说新话）之前
    let retrySame = 0, retryCount = 0, switchTool = 0
    const seenOther = new Set()
    for (let j = i + 1; j < evs.length; j++) {
      const n = evs[j].ev
      if (!n) continue
      if (n.type === 'user/message') break
      if (n.type !== 'tool/call' || !n.data) continue
      const nm = n.data.name
      if (nm === toolName) { retrySame = 1; retryCount++ }
      else if (nm) seenOther.add(nm)
    }
    if (seenOther.size > 0) switchTool = 1

    triggers.push({ t, sig: `${toolName}::${fail.kind === 'exit-nonzero' ? fail.detail : (fail.detail || 'err')}`, retrySame, retryCount, switchTool })
  }
}

// ── 样本量普查：哪些签名够做早晚对比 ──
const bySig = new Map()
for (const r of triggers) {
  if (!bySig.has(r.sig)) bySig.set(r.sig, [])
  bySig.get(r.sig).push(r)
}

const sortedAll = [...triggers].sort((a, b) => a.t - b.t)
const medianT = sortedAll.length ? sortedAll[Math.floor(sortedAll.length / 2)].t : 0

const rows = []
for (const [sig, list] of bySig) {
  if (list.length < MIN_SIG) continue
  const early = list.filter((r) => r.t <= medianT)
  const late = list.filter((r) => r.t > medianT)
  if (early.length < 5 || late.length < 5) continue
  const avg = (a, k) => a.reduce((p, q) => p + q[k], 0) / a.length
  rows.push({
    sig,
    n: list.length,
    nEarly: early.length,
    nLate: late.length,
    early: { retrySame: avg(early, 'retrySame'), retryCount: avg(early, 'retryCount'), switchTool: avg(early, 'switchTool') },
    late: { retrySame: avg(late, 'retrySame'), retryCount: avg(late, 'retryCount'), switchTool: avg(late, 'switchTool') },
  })
}
rows.sort((a, b) => b.n - a.n)

const out = { totalTriggers: triggers.length, distinctSigs: bySig.size, usableSigs: rows.length, minSig: MIN_SIG, rows }
if (wantJson) console.log(JSON.stringify(out, null, 2))
else {
  const f2 = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  —  ')
  console.log(`\n触发事件共 ${out.totalTriggers} 次，签名 ${out.distinctSigs} 种`)
  console.log(`够做早晚对比的签名（各半区≥5、总数≥${MIN_SIG}）：**${out.usableSigs}** 种\n`)
  if (!out.usableSigs) {
    console.log('⛔ 没有一个签名样本够 ⇒ 这个检验在当前语料上做不了（又撞 §40 那个老问题）。')
  } else {
    console.log('签名                                   n    早:重试率/次数/换工具      晚:重试率/次数/换工具')
    for (const r of rows) {
      console.log(
        `${r.sig.slice(0, 36).padEnd(36)} ${String(r.n).padStart(4)}   ` +
        `${f2(r.early.retrySame)}/${f2(r.early.retryCount)}/${f2(r.early.switchTool)}   ` +
        `${f2(r.late.retrySame)}/${f2(r.late.retryCount)}/${f2(r.late.switchTool)}`
      )
    }
    const changed = rows.filter((r) => Math.abs(r.late.retrySame - r.early.retrySame) > 0.1 || Math.abs(r.late.retryCount - r.early.retryCount) > 0.2)
    console.log(`\n⇒ 反应有明显变化的签名：${changed.length}/${rows.length}`)
    console.log(changed.length
      ? '⚠️ 有变化，但**不能直接当「成为自己」的证据**——要排除「历史后期整体任务类型变了」这个混淆。'
      : '⛔ 全部稳定 ⇒ 同一触发条件在不同历史位置反应一致 ⇒ 目前更像「成为别人」（通用反应）。')
  }
}
