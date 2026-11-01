// 验收：修完之后，失败数是不是从「只算 data.error」变成「含 isError」。
// ⛔ 走真实调用链：直接调 session-turns.mjs 的 failuresIn()，不自己重写判据。
// 用法：node _verify-fail-fix.mjs <zstd>...

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { failuresIn, countSession, scanZstdFrames } from './session-turns.mjs'
import { resultTextOf } from './tool-fail.mjs'

const files = process.argv.slice(2)

/**
 * 旧判据：**完整复刻修改前的 failuresIn() 逻辑** ——
 *   ① 先看 data.error（命中即算，且 continue，不再看 exit code）
 *   ② 没有 data.error 时，看正文 `[exit code: N≠0]`
 * ⛔ 上一版对照只数了 data.error、漏了 ② 分支，导致差额虚高。这里必须两分支都算。
 */
function oldStyleFailures(file) {
  const buf = readFileSync(file)
  const { frames } = scanZstdFrames(buf)
  let n = 0
  for (const f of frames) {
    let text
    try { text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      if (ev.type !== 'tool/result') continue
      if (ev.data && ev.data.error) { n++; continue }
      const m = resultTextOf(ev).match(/\[exit code: (-?\d+)\]/)
      if (m && Number(m[1]) !== 0) n++
    }
  }
  return n
}

let sumNew = 0, sumOld = 0, sumResults = 0, sumTurns = 0
const kinds = new Map()

console.log('会话        轮数  工具结果  旧判据(data.error)  新判据(failuresIn)  种类分布')
for (const f of files) {
  const id = f.split('\\').slice(-2)[0].slice(8, 16)
  const conv = countSession(f)
  const results = conv.byType['tool/result'] || 0
  const turns = conv.byType['turn/start'] || 0
  const oldN = oldStyleFailures(f)
  const fails = failuresIn(f)
  const k = new Map()
  for (const x of fails) k.set(x.kind, (k.get(x.kind) || 0) + 1)
  for (const [kk, vv] of k) kinds.set(kk, (kinds.get(kk) || 0) + vv)
  sumNew += fails.length; sumOld += oldN; sumResults += results; sumTurns += turns
  console.log(`${id}  ${String(turns).padStart(5)} ${String(results).padStart(8)} ${String(oldN).padStart(18)} ${String(fails.length).padStart(18)}  ${[...k.entries()].map(([a, b]) => a + '×' + b).join(' ')}`)
}

console.log(`\n合计：轮 ${sumTurns} · 工具结果 ${sumResults}`)
console.log(`  旧判据（data.error）       ${sumOld}`)
console.log(`  新判据（failuresIn）       ${sumNew}`)
console.log(`  差额（补回的漏判）          ${sumNew - sumOld}`)
console.log(`  失败率：旧 ${(sumOld / sumResults * 100).toFixed(2)}%  →  新 ${(sumNew / sumResults * 100).toFixed(2)}%`)
console.log(`  种类：${[...kinds.entries()].map(([a, b]) => a + '×' + b).join(' · ')}`)
