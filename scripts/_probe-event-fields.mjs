// 探查：会话事件里到底有哪些字段（只看结构，不打印内容）。
// ⛔ 只读。用途：核实「还能抓什么数据」，不凭字段名推断。
// 用法：node _probe-event-fields.mjs <zstd>

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const cuts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) cuts.push(i)
}
const parts = []
for (let k = 0; k < cuts.length; k++) {
  const s = cuts[k], e = k + 1 < cuts.length ? cuts[k + 1] : buf.length
  try { parts.push(zstdDecompressSync(buf.subarray(s, e))) } catch { /* 坏帧跳过 */ }
}
const text = Buffer.concat(parts).toString('utf8')

const shapes = new Map()
const sample = new Map()
for (const line of text.split('\n')) {
  if (!line) continue
  let ev; try { ev = JSON.parse(line) } catch { continue }
  const t = ev.type
  if (!t) continue
  if (!shapes.has(t)) {
    shapes.set(t, new Set())
    sample.set(t, ev)
  }
  const keys = Object.keys(ev.data || {})
  for (const k of keys) shapes.get(t).add(k)
}

console.log('事件类型：字段清单（data 下的键）\n')
for (const [t, set] of shapes) {
  console.log(`  ${t.padEnd(22)} ${[...set].join(' · ') || '（无 data）'}`)
}

// 对 tool/result 再看深一层：message.content 里的块类型
console.log('\n=== tool/result · data.message.content 的块类型 ===')
const tr = sample.get('tool/result')
if (!tr) console.log('  （这个会话里没有 tool/result）')
else {
  const c = tr.data && tr.data.message && tr.data.message.content
  if (!Array.isArray(c)) console.log('  （不是数组）')
  else {
    for (const blk of c) {
      console.log(`  block.type = ${blk && blk.type}   keys = ${Object.keys(blk || {}).join(' · ')}`)
    }
  }
  console.log('  data 的键：', Object.keys(tr.data || {}).join(' · '))
}

// assistant/message 的 usage 字段
console.log('\n=== assistant/message · data.usage 的键 ===')
const am = sample.get('assistant/message')
if (!am) console.log('  （这个会话里没有 assistant/message）')
else {
  console.log('  data 的键：', Object.keys(am.data || {}).join(' · '))
  console.log('  usage 的键：', Object.keys((am.data && am.data.usage) || {}).join(' · '))
  console.log('  顶层键：', Object.keys(am).join(' · '))
}

// 有没有时间字段
console.log('\n=== 时间相关字段 ===')
for (const [t, ev] of sample) {
  const timeKeys = []
  for (const k of Object.keys(ev)) if (/time|date|ts|at$/i.test(k)) timeKeys.push(k)
  for (const k of Object.keys(ev.data || {})) if (/time|date|ts|at$/i.test(k)) timeKeys.push(`data.${k}`)
  console.log(`  ${t.padEnd(22)} ${timeKeys.join(' · ') || '（无）'}`)
}
