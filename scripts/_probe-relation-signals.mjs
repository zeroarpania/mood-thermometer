// 关系/伦理维度的**覆盖率普查**（不是预测检验）。
//
// ⛔ 为什么先做这个（2026-11-03 00:4x）：
//   §46 定了换源的及格线（要打过 ρ(tools→nextTools)=0.496）。但在谈「过不过坎」
//   之前，得先回答一个更前置的问题：**这个源在数据里到底有没有货？**
//   覆盖率太低 ⇒ 连验证都做不了，谈不上过不过坎。
//
// 候选信号（全部是 v 从未吃过的）：
//   关系侧：approval/asked（我请示）· approval/decided（他批/拒）·
//           段内他说的话条数 · 纠正词（不对/别/不要/先别…）
//   伦理侧：约束/安全词（删/危险/授权/权限/注意/小心/红线…）
//
// 判据（跑前定死）：
//   覆盖率 ≥10% 且落在 ≥30 个会话 ⇒ 候选可用，可进入下一轮「过坎」检验
//   覆盖率 <5% 或集中在 <10 个会话 ⇒ 样本不足，无法验证
//   其余 ⇒ 待定
//
// 用法：node _probe-relation-signals.mjs --from <清单.txt> [--json]

import { readFileSync } from 'node:fs'
import { collectEvents } from './appraisal-track.mjs'
import { extractUserText } from './collect-user-speech.mjs'

const FROZEN = { covUsable: 0.10, covDead: 0.05, minSessions: 30, deadSessions: 10 }

const argv = process.argv.slice(2)
const fromIdx = argv.indexOf('--from')
if (fromIdx < 0) {
  console.error('✗ 需要 --from <清单.txt>')
  process.exit(1)
}
const files = readFileSync(argv[fromIdx + 1], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
const wantJson = argv.includes('--json')
console.error(`扫 ${files.length} 个会话…`)

const RE_CORRECT = /不对|不是这样|别|不要|先别|停下|错了|重来|改一下|再想想到|走不通/
const RE_SAFETY = /删|危险|授权|权限|注意|小心|红线|安全|备份/
// 称呼词：不同使用者的叫法不同，用环境变量配置（正则片段，多个用 | 分隔）。留空 = 不测这个信号。
const RE_NAME = process.env.ADDRESS_TERMS ? new RegExp(process.env.ADDRESS_TERMS) : null

const SIGNALS = ['approvalAsked', 'approvalDecided', 'userMsg', 'correction', 'safety', 'nameAddr']
const perSignal = Object.fromEntries(SIGNALS.map((s) => [s, { segs: 0, sessions: new Set() }]))
let totalSegs = 0
let totalSessions = 0

for (const f of files) {
  let evs
  try { evs = collectEvents(f) } catch { continue }
  totalSessions++
  const segs = []
  let cur = null
  for (const { ev } of evs) {
    const t = ev && ev.type
    if (t === 'turn/start') { cur = { s: {} }; segs.push(cur); continue }
    if (!cur) continue
    if (t === 'approval/asked') cur.s.approvalAsked = 1
    else if (t === 'approval/decided') cur.s.approvalDecided = 1
    else if (t === 'user/message') {
      const txt = extractUserText(JSON.stringify(ev))
      if (!txt) continue
      cur.s.userMsg = 1
      if (RE_CORRECT.test(txt)) cur.s.correction = 1
      if (RE_SAFETY.test(txt)) cur.s.safety = 1
      if (RE_NAME && RE_NAME.test(txt)) cur.s.nameAddr = 1
    }
  }
  totalSegs += segs.length
  for (const g of segs) {
    for (const sig of SIGNALS) {
      if (g.s[sig]) {
        perSignal[sig].segs++
        perSignal[sig].sessions.add(f)
      }
    }
  }
}

const rows = SIGNALS.map((sig) => {
  const { segs, sessions } = perSignal[sig]
  const cov = totalSegs ? segs / totalSegs : 0
  const ns = sessions.size
  let verdict
  if (cov >= FROZEN.covUsable && ns >= FROZEN.minSessions) verdict = '✅ 可进入「过坎」检验'
  else if (cov < FROZEN.covDead || ns < FROZEN.deadSessions) verdict = '⛔ 样本不足，无法验证'
  else verdict = '⚠️ 待定'
  return { signal: sig, segs, coverage: cov, sessions: ns, verdict }
})

if (wantJson) {
  console.log(JSON.stringify({ totalSegs, totalSessions, frozen: FROZEN, rows }, null, 2))
} else {
  console.log(`\n段 ${totalSegs} · 会话 ${totalSessions}`)
  console.log('\n=== 关系/伦理候选信号的覆盖率 ===')
  console.log('信号              含该信号的段   覆盖率    会话数   判决')
  for (const r of rows) {
    console.log(
      `${r.signal.padEnd(16)} ${String(r.segs).padStart(8)}  ${(r.coverage * 100).toFixed(1).padStart(6)}%  ${String(r.sessions).padStart(6)}   ${r.verdict}`
    )
  }
  const usable = rows.filter((r) => r.verdict.startsWith('✅'))
  console.log(`\n冻结判据：覆盖率≥${FROZEN.covUsable * 100}% 且 ≥${FROZEN.minSessions} 会话 ⇒ 可用；<${FROZEN.covDead * 100}% 或 <${FROZEN.deadSessions} 会话 ⇒ 无法验证`)
  console.log(usable.length
    ? `\n⇒ ${usable.length} 个候选够格进入下一轮（对 0.496 那道坎）。`
    : '\n⇒ 一个都不够格：这批「关系/伦理」信号在当前语料里要么太稀，要么集中在少数会话里。')
}
