// 数一个 DSH 会话文件里「有多少轮」。
//
// 为什么有这个：心情温度计的时间轴要用「真实对话轮数」，而不是「mood.mjs 跑了几次」。
// 会话文件是 session.v4.jsonl.zstd —— **多帧拼接的 zstd 容器**，每帧独立可解压。
// 直接 zstdDecompressSync(整个文件) 只会吐出第一帧，所以必须先切帧再逐帧解。
//
// 切帧逻辑照抄 DSH 自己的实现（app.asar → lib/types/zstd.js → scanZstdFrames）：
// 纯结构游走，不解压，按 zstd 帧头（magic 4B + 描述符 + 可选字段 + 若干 block）走完一帧。
// 这样又快又不会因为版本差异踩坑。
//
// 用法：
//   node session-turns.mjs                 自动用 DSH_SESSION_ID 找当前会话
//   node session-turns.mjs <文件路径>       指定文件
//   node session-turns.mjs --json          机器可读

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { toolFailureOf } from './tool-fail.mjs'

const ZSTD_MAGIC = 4247762216   // 0xFD2FB528，小端读作 UInt32

/** 照抄 DSH 的 scanZstdFrames：只走结构，不解压。 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset); offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** 找到当前（或指定）会话文件。 */
export function locateSession(arg) {
  if (arg && existsSync(arg)) return arg
  const id = arg || process.env.DSH_SESSION_ID
  if (!id) return null
  const root = process.env.DSH_SESSIONS || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : '')
  try {
    for (const bucket of readdirSync(root)) {
      const p = join(root, bucket, id, 'session.v4.jsonl.zstd')
      if (existsSync(p)) return p
    }
  } catch { /* 目录不存在就当找不到 */ }
  return null
}

/** 数一个会话文件。 */
export function countSession(file) {
  const buf = readFileSync(file)
  const { frames, tornStart } = scanZstdFrames(buf)
  const events = {}
  let parsed = 0
  let badLines = 0
  let badFrames = 0
  for (const f of frames) {
    let text
    try {
      text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8')
    } catch {
      badFrames++
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { badLines++; continue }
      parsed++
      const t = typeof ev.type === 'string' ? ev.type : 'unknown'
      events[t] = (events[t] || 0) + 1
    }
  }
  return {
    file,
    bytes: buf.length,
    frames: frames.length,
    tornStart: tornStart === undefined ? null : tornStart,
    badFrames,
    events: parsed,
    badLines,
    byType: events,
    // 「轮」＝我回一次话。assistant/message 与 step/start 一一对应（都是 161），
    // 而 user/message 混着系统注入的消息，比实际对话多一截，不能当轮数。
    turns: events['assistant/message'] || 0,
    userMessages: events['user/message'] || 0,
  }
}

/** 从一条 tool/result 里取出正文文本。 */
export function resultTextOf(ev) {
  const c = ev && ev.data && ev.data.message && ev.data.message.content
  if (!Array.isArray(c)) return ''
  return c.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join('\n')
}

/**
 * 扫一个会话文件里的「我自己的失败」。
 *
 * 2026-11-01 立：负面情绪不从使用者那儿采（他不给，也采不到），从**我自己的作业结果**采。
 * 只认两种客观凭据 —— 它们不经过我的嘴，所以我没法美化：
 *   ① `data.error` 非空（工具真的报错了，如 FS_STALE_VERSION）
 *   ② 正文里带 `[exit code: N≠0]`（命令非零退出，DSH 只在非零时加这个标记）
 * 返回按 seq 升序，游标用 seq（单调，compact 剪不断）。
 *
 * ⚠️ 实测密度很低（旧会话 227 条 tool/result 里只有 3 条失败，1.3%）—— 这是事实：
 * 我失败本来就少，所以负面情绪大部分时候该是 0。接它不是因为要它常亮，是要它真。
 */
export function failuresIn(file) {
  const buf = readFileSync(file)
  const { frames } = scanZstdFrames(buf)
  const out = []
  for (const f of frames) {
    let text
    try { text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (ev.type !== 'tool/result') continue
      const seq = Number(ev.seq)
      if (!Number.isFinite(seq)) continue
      // ⛔ 判据统一走 tool-fail.mjs（2026-11-02 16:0x 修：旧版只判 data.error，漏 39.4% 真失败）
      const fail = toolFailureOf(ev)
      if (fail) out.push({ seq, ...fail })
    }
  }
  out.sort((a, b) => a.seq - b.seq)
  return out
}

// ── CLI ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const json = argv.includes('--json')
const arg = argv.find((a) => !a.startsWith('--'))

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const file = locateSession(arg)
  if (!file) {
    console.error('✗ 找不到会话文件。传路径，或设置 DSH_SESSION_ID。')
    process.exit(1)
  }
  const r = countSession(file)
  if (json) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    console.log(`文件：${r.file}`)
    console.log(`大小：${r.bytes} 字节 · 帧数：${r.frames}${r.tornStart !== null ? `（末尾有未完成帧 @${r.tornStart}）` : ''}`)
    console.log(`事件：${r.events} 条${r.badLines ? `（坏行 ${r.badLines}）` : ''}${r.badFrames ? `（坏帧 ${r.badFrames}）` : ''}`)
    console.log(`轮数：${r.turns} 轮   （user/message 条数；assistant/message ${r.assistant} 条）`)
    console.log('')
    console.log('事件类型分布：')
    for (const [k, v] of Object.entries(r.byType).sort((a, b) => b[1] - a[1])) {
      console.log('  ' + k.padEnd(28) + v)
    }
  }
}
