// 核实：失败判据有没有漏，并看「只有 isError」那批到底是什么。
//   `appraisal-track.mjs` / `appraisal-wire.mjs` 的 toolOk() 只判 `ev.data.error`
//   但事件结构里还有 `data.message.isError`（布尔）。
// ⛔ 只读。用法：node _probe-error-fields.mjs <zstd>...

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const files = process.argv.slice(2)
const T = { total: 0, dataError: 0, isErrorTrue: 0, both: 0, isErrOnly: 0, dataErrOnly: 0, exitCodeHit: 0 }
const samples = []

for (const file of files) {
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
  for (const line of text.split('\n')) {
    if (!line) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'tool/result') continue
    T.total++
    const hasDataErr = Boolean(ev.data && ev.data.error)
    const isErr = Boolean(ev.data && ev.data.message && ev.data.message.isError)
    if (hasDataErr) T.dataError++
    if (isErr) T.isErrorTrue++
    if (hasDataErr && isErr) T.both++
    else if (isErr && !hasDataErr) T.isErrOnly++
    else if (hasDataErr && !isErr) T.dataErrOnly++

    const c = ev.data && ev.data.message && ev.data.message.content
    const txt = Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join('\n') : ''
    if (/\[exit code: -?\d+\]/.test(txt)) T.exitCodeHit++

    if (isErr && !hasDataErr && samples.length < 10) {
      const callId = ev.data && ev.data.message && ev.data.message.toolCallId
      samples.push({ callId: String(callId || '').slice(0, 8), head: txt.slice(0, 110).replace(/\s+/g, ' ') })
    }
  }
}

console.log(`tool/result 总数 ${T.total}`)
console.log(`  data.error 存在      ${T.dataError}`)
console.log(`  message.isError=true ${T.isErrorTrue}`)
console.log(`  两者都有             ${T.both}`)
console.log(`  ⚠️ 只有 isError       ${T.isErrOnly}   ← 现 toolOk() 会漏掉这些`)
console.log(`  ⚠️ 只有 data.error    ${T.dataErrOnly}`)
console.log(`  正文里有 [exit code: N]  ${T.exitCodeHit}`)

console.log(`\n=== 「只有 isError」的样本（最多 10 条，各取正文前 110 字）===`)
for (const s of samples) console.log(`  [${s.callId}] ${s.head || '（正文为空）'}`)
