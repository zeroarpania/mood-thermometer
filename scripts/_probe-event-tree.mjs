// 探查：几个关键事件的完整键树（只看结构，值只给类型/长度，不打印内容）。
// ⛔ 只读。用途：核实 workspace/changes 与 tool/call 里到底有什么，不凭字段名推断。
// 用法：node _probe-event-tree.mjs <zstd>

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

const wanted = new Set(['workspace/changes', 'tool/call', 'tool/result'])
const first = new Map()
const counts = new Map()
for (const line of text.split('\n')) {
  if (!line) continue
  let ev; try { ev = JSON.parse(line) } catch { continue }
  if (!wanted.has(ev.type)) continue
  counts.set(ev.type, (counts.get(ev.type) || 0) + 1)
  if (!first.has(ev.type)) first.set(ev.type, ev)
}

function describe(v, depth = 0) {
  if (v === null) return 'null'
  if (Array.isArray(v)) {
    if (!v.length) return 'array[0]'
    const head = describe(v[0], depth + 1)
    return `array[${v.length}] of ${head}`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (!keys.length) return '{}'
    const ind = '  '.repeat(depth + 1)
    return '{\n' + keys.map((k) => `${ind}${k}: ${describe(v[k], depth + 1)}`).join('\n') + '\n' + '  '.repeat(depth) + '}'
  }
  if (typeof v === 'string') return `string(${v.length})`
  return `${typeof v}(${String(v).length})`
}

for (const t of wanted) {
  const ev = first.get(t)
  console.log(`\n=== ${t}  共 ${counts.get(t) || 0} 条 · 结构如下 ===`)
  if (!ev) { console.log('  （本会话没有）'); continue }
  console.log(describe(ev))
}
