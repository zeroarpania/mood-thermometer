// 语料池普查：DSH 会话目录里到底有多少会话能拿来喂这套测量。
//
// ⛔ 为什么有这个（2026-11-02 接续会话）：
//   上会话的账本写着「从 11188 个 session.v4.jsonl.zstd 随机抽 60 个」，判据是
//   「可用 ≥800 会话 ⇒ 扩样本」。**实测总量只有 257 个文件**（176 MB），
//   11188 那个数不成立。若照旧判据走，永远达不到 800 ⇒ 判据必须按真实分母重定。
//
//   真正卡住结论的不是「会话数」，是**段（turn/start）数与正类（失败）数**：
//   现有六会话 = 817 段 / 正类仅 60（7.4%）。所以本脚本直接报「全部 257 个会话
//   合起来能出多少段、多少条真失败」，用绝对量判断扩样本够不够，不再靠会话数拍脑袋。
//
// 四项通过判据（全过才算「可用会话」）：
//   A 能解压     ：坏帧 0 且成功解压字节 > 0
//   B 有 tool/result
//   C 有 turn/start
//   D 有 usage   ：assistant/message 里带 data.usage 的比例 ≥ 0.9
//
// 用法：
//   node _probe-corpus-scan.mjs           全量扫描并打印汇总
//   node _probe-corpus-scan.mjs --json    机器可读
//   node _probe-corpus-scan.mjs --limit 20  只扫前 20 个（自测用）
//
// 失败判据统一走 tool-fail.mjs，⛔ 不在这里另写一份。

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from './session-turns.mjs'
import { toolFailureOf } from './tool-fail.mjs'

// 会话数据目录：优先 DSH_SESSIONS，其次 DSH_HOME/sessions。
const ROOT = process.env.DSH_SESSIONS || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : '')
const USAGE_COVERAGE_MIN = 0.9

/** 找出全部 session.v4.jsonl.zstd（一层 bucket / 一层 session-id / 文件）。 */
function listSessionFiles() {
  const out = []
  let buckets = []
  try { buckets = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return out }
  for (const b of buckets) {
    const bp = join(ROOT, b.name)
    let subs = []
    try { subs = readdirSync(bp, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
    for (const s of subs) {
      const f = join(bp, s.name, 'session.v4.jsonl.zstd')
      try { if (statSync(f).isFile()) out.push({ bucket: b.name, session: s.name, file: f }) } catch { /* 无此文件 */ }
    }
  }
  return out
}

/** 扫一个文件，返回计数。 */
function scanOne(entry) {
  const r = {
    file: entry.file,
    bucket: entry.bucket,
    session: entry.session,
    bytes: 0,
    decBytes: 0,
    frames: 0,
    badFrames: 0,
    events: 0,
    badLines: 0,
    turnStart: 0,
    toolResult: 0,
    toolCall: 0,
    assistant: 0,
    assistantWithUsage: 0,
    userMessage: 0,
    fails: 0,
    error: null,
  }
  let buf
  try {
    buf = readFileSync(entry.file)
  } catch (e) {
    r.error = 'READ:' + (e && e.message)
    return r
  }
  r.bytes = buf.length
  let frames
  try {
    const s = scanZstdFrames(buf)
    frames = s.frames
  } catch (e) {
    r.error = 'FRAME:' + (e && e.message)
    return r
  }
  r.frames = frames.length
  for (const fr of frames) {
    let text
    try {
      const raw = zstdDecompressSync(buf.subarray(fr.start, fr.end))
      r.decBytes += raw.length
      text = raw.toString('utf8')
    } catch {
      r.badFrames++
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { r.badLines++; continue }
      r.events++
      switch (ev.type) {
        case 'turn/start': r.turnStart++; break
        case 'tool/call': r.toolCall++; break
        case 'tool/result':
          r.toolResult++
          if (toolFailureOf(ev)) r.fails++
          break
        case 'assistant/message':
          r.assistant++
          if (ev.data && ev.data.usage) r.assistantWithUsage++
          break
        case 'user/message': r.userMessage++; break
        default: break
      }
    }
  }
  return r
}

/** 四项判据。 */
function verdict(r, coverageMin = USAGE_COVERAGE_MIN) {
  const A = !r.error && r.decBytes > 0 && r.badFrames === 0
  const B = r.toolResult > 0
  const C = r.turnStart > 0
  const D = r.assistant > 0 && r.assistantWithUsage / r.assistant >= coverageMin
  return { A, B, C, D, usable: A && B && C && D }
}

// ⛔ 归属过滤：会话目录下可能混着**别的 agent** 的会话（别的产品、别的桥接、别的工作区）。
//   不猜归属——必须显式指定范围，否则统计里会掺进不属于本 agent 的数据。
//   三种指定方式：--bucket <目录名> / --all-buckets / 设 WORKSPACE_BUCKET 环境变量。
const OWN_BUCKET = process.env.WORKSPACE_BUCKET || null

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const allBuckets = argv.includes('--all-buckets')
const bucketIdx = argv.indexOf('--bucket')
const explicitBucket = bucketIdx >= 0 ? argv[bucketIdx + 1] : null
if (!explicitBucket && !allBuckets && !OWN_BUCKET) {
  console.error('✗ 需要指定范围：--bucket <目录名>、--all-buckets，或设 WORKSPACE_BUCKET 环境变量')
  process.exit(2)
}
const bucketFilter = explicitBucket || (allBuckets ? null : OWN_BUCKET)
const limitIdx = argv.indexOf('--limit')
const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) || 0 : 0

const all = listSessionFiles().filter((e) => !bucketFilter || e.bucket === bucketFilter)
const files = limit > 0 ? all.slice(0, limit) : all

if (!wantJson) {
  console.error(`扫描 ${files.length} 个会话文件（桶过滤=${bucketFilter || '全部'}）…`)
}

const rows = []
let done = 0
for (const entry of files) {
  const r = scanOne(entry)
  r.v = verdict(r)
  rows.push(r)
  done++
  if (!wantJson && done % 25 === 0) console.error(`  …已扫 ${done}/${files.length}`)
}

// --files：只吐可用会话的绝对路径（喂给 _probe-v-selfconsistency.mjs --from）
// ⚠️ 路径含中文 ⇒ 一律由脚本自己写 UTF-8（PowerShell 重定向会写成 UTF-16，node 读回来是乱码）
if (argv.includes('--files')) {
  const paths = rows.filter((r) => r.v.usable).map((r) => r.file)
  const outIdx = argv.indexOf('--out')
  if (outIdx >= 0) {
    const outPath = argv[outIdx + 1]
    writeFileSync(outPath, paths.join('\n') + '\n', 'utf8')
    console.error(`已写 ${paths.length} 条可用会话路径 → ${outPath}`)
  } else {
    for (const p of paths) console.log(p)
  }
  process.exit(0)
}

const sum = {
  files: rows.length,
  usable: rows.filter((r) => r.v.usable).length,
  decodeFail: rows.filter((r) => !r.v.A).length,
  noToolResult: rows.filter((r) => !r.v.B).length,
  noTurnStart: rows.filter((r) => !r.v.C).length,
  noUsage: rows.filter((r) => !r.v.D).length,
  bytes: rows.reduce((a, r) => a + r.bytes, 0),
  decBytes: rows.reduce((a, r) => a + r.decBytes, 0),
  segments: rows.reduce((a, r) => a + r.turnStart, 0),
  toolResults: rows.reduce((a, r) => a + r.toolResult, 0),
  fails: rows.reduce((a, r) => a + r.fails, 0),
  assistant: rows.reduce((a, r) => a + r.assistant, 0),
  assistantWithUsage: rows.reduce((a, r) => a + r.assistantWithUsage, 0),
  badFrames: rows.reduce((a, r) => a + r.badFrames, 0),
  badLines: rows.reduce((a, r) => a + r.badLines, 0),
  events: rows.reduce((a, r) => a + r.events, 0),
  errorFiles: rows.filter((r) => r.error).length,
}
sum.failRate = sum.toolResults ? +(sum.fails / sum.toolResults * 100).toFixed(2) : 0
sum.avgSegments = sum.usable ? +(sum.segments / sum.usable).toFixed(1) : 0
sum.avgToolPerSeg = sum.segments ? +(sum.toolResults / sum.segments).toFixed(2) : 0

if (wantJson) {
  console.log(JSON.stringify({ sum, rows }, null, 2))
} else {
  const p = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '-')
  const n = files.length
  console.log('')
  console.log('=== 语料池普查（' + n + ' 个会话文件） ===')
  console.log(`体积：压缩 ${(sum.bytes / 1048576).toFixed(1)} MB → 解压 ${(sum.decBytes / 1048576).toFixed(1)} MB`)
  console.log(`事件：${sum.events} 条 · 坏帧 ${sum.badFrames} · 坏行 ${sum.badLines} · 读/切帧失败文件 ${sum.errorFiles}`)
  console.log('')
  console.log('四项通过率：')
  console.log(`  A 能解压          ${n - sum.decodeFail}/${n}  ${p(n - sum.decodeFail, n)}`)
  console.log(`  B 有 tool/result  ${n - sum.noToolResult}/${n}  ${p(n - sum.noToolResult, n)}`)
  console.log(`  C 有 turn/start   ${n - sum.noTurnStart}/${n}  ${p(n - sum.noTurnStart, n)}`)
  console.log(`  D 有 usage(≥90%)  ${n - sum.noUsage}/${n}  ${p(n - sum.noUsage, n)}`)
  console.log(`  ⇒ 四项全过（可用会话） ${sum.usable}/${n}  ${p(sum.usable, n)}`)
  console.log('')
  console.log('可用样本绝对量：')
  console.log(`  段（turn/start）总数     ${sum.segments}   （可用会话平均 ${sum.avgSegments} 段/会话）`)
  console.log(`  tool/result 总数         ${sum.toolResults}   （平均 ${sum.avgToolPerSeg} 条/段）`)
  console.log(`  其中真失败               ${sum.fails}   ⇒ 失败率 ${sum.failRate}%`)
  console.log(`  assistant/message        ${sum.assistant}（带 usage ${sum.assistantWithUsage}，覆盖 ${p(sum.assistantWithUsage, sum.assistant)}）`)
  console.log('')
  const perSeg = sum.segments ? (sum.fails / sum.segments) : 0
  console.log(`外推：若把可用会话全用上，段数 ${sum.segments}、可在段粒度检出的失败约 ${Math.round(perSeg * sum.segments)} 条`)
  console.log(`对比现有六会话基线：817 段 / 失败 60 段（7.4%）⇒ 扩大倍数 ≈ ${sum.segments ? (sum.segments / 817).toFixed(1) : '-'}×`)
  console.log('')
  const bad = rows.filter((r) => !r.v.usable)
  if (bad.length) {
    console.log('未通过的会话（前 15 个）：')
    for (const r of bad.slice(0, 15)) {
      const why = [r.v.A ? '' : 'A解压', r.v.B ? '' : 'B无tool/result', r.v.C ? '' : 'C无turn/start', r.v.D ? '' : 'D无usage'].filter(Boolean).join(',')
      console.log(`  ${r.bucket}/${r.session.slice(0, 8)}  ${(r.bytes / 1024).toFixed(0)}KB  turns=${r.turnStart} tools=${r.toolResult}  ✗ ${why}${r.error ? ' err=' + r.error : ''}`)
    }
    if (bad.length > 15) console.log(`  …另 ${bad.length - 15} 个`)
  }
}
