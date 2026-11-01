// 会话池归属审计：DSH 会话目录下每个 bucket 到底是谁的。
//
// ⛔ 为什么有（2026-11-03 01:1x）：
//   使用者指出样本取岔了——`mcp__snowluma__*`（QQ 桥接）不是本工作区的技能，
//   其会话不属于本 agent，却被算进了 §44/§46/§49/§56/§57/§58/§59 的每一份统计。
//   ⇒ 先分清楚每个 bucket 是谁的，再谈重跑。
//
// 判据：**按工具指纹认人**，不按目录名猜。
//   本工作区的技能集（可核）：pwsh / read / write / edit / grep / glob / node ...
//   不属于的（如 mcp__snowluma__*）⇒ 该会话不是本工作区的。
//
// 用法：node _probe-bucket-audit.mjs [--json]

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from './session-turns.mjs'

// 会话数据目录：优先 DSH_SESSIONS，其次 DSH_HOME/sessions；都没设就报错退出（不猜路径）。
const ROOT = process.env.DSH_SESSIONS || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : '')
if (!ROOT) {
  console.error('✗ 需要设置 DSH_SESSIONS 或 DSH_HOME 环境变量')
  process.exit(2)
}
const wantJson = process.argv.includes('--json')

const buckets = []
for (const b of readdirSync(ROOT, { withFileTypes: true })) {
  if (!b.isDirectory()) continue
  const bp = join(ROOT, b.name)
  let subs = []
  try { subs = readdirSync(bp, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
  const info = { bucket: b.name, sessions: 0, toolCalls: 0, toolNames: {}, firstTime: Infinity, lastTime: 0 }
  for (const s of subs) {
    const f = join(bp, s.name, 'session.v4.jsonl.zstd')
    try { if (!statSync(f).isFile()) continue } catch { continue }
    let buf
    try { buf = readFileSync(f) } catch { continue }
    let frames
    try { frames = scanZstdFrames(buf).frames } catch { continue }
    let had = false
    for (const fr of frames) {
      let text
      try { text = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        const t = Number(ev.time)
        if (Number.isFinite(t)) { if (t < info.firstTime) info.firstTime = t; if (t > info.lastTime) info.lastTime = t }
        if (ev.type === 'tool/call' && ev.data && ev.data.name) {
          info.toolCalls++
          info.toolNames[ev.data.name] = (info.toolNames[ev.data.name] || 0) + 1
          had = true
        }
      }
    }
    if (had) info.sessions++
  }
  buckets.push(info)
}

buckets.sort((a, b) => b.sessions - a.sessions)

// 「本工作区」的判定：不含 mcp__snowluma__ 且工具集以本地 shell/编辑类为主
const isMine = (b) => !Object.keys(b.toolNames).some((n) => n.startsWith('mcp__snowluma__'))

if (wantJson) {
  console.log(JSON.stringify({ buckets: buckets.map((b) => ({ ...b, firstTime: b.firstTime === Infinity ? null : b.firstTime })) }, null, 2))
} else {
  const d = (t) => (t === Infinity || !t ? '—' : new Date(t).toISOString().slice(0, 10))
  console.log('\n=== 会话池归属审计 ===\n')
  for (const b of buckets) {
    const mine = isMine(b)
    console.log(`${mine ? '✅' : '⛔'} ${b.bucket}`)
    console.log(`   会话 ${b.sessions} · 工具调用 ${b.toolCalls} · 时间 ${d(b.firstTime)} → ${d(b.lastTime)}`)
    const top = Object.entries(b.toolNames).sort((x, y) => y[1] - x[1]).slice(0, 6)
    console.log(`   主营工具：${top.map(([n, c]) => `${n}×${c}`).join('  ')}`)
    const snow = Object.entries(b.toolNames).filter(([n]) => n.startsWith('mcp__snowluma__'))
    if (snow.length) console.log(`   ⛔ 含非本区工具：${snow.map(([n, c]) => `${n}×${c}`).join('  ')}`)
    console.log('')
  }
  const mineB = buckets.filter(isMine)
  const notB = buckets.filter((b) => !isMine(b))
  console.log(`⇒ 本工作区桶 ${mineB.length} 个（会话 ${mineB.reduce((s, b) => s + b.sessions, 0)}）`)
  console.log(`⇒ 非本工作区桶 ${notB.length} 个（会话 ${notB.reduce((s, b) => s + b.sessions, 0)}）`)
}
