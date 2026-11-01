// 采集使用者在指定工作区里说过的原话，供建立语言习惯词表用。
//
// 为什么要专门写一个：`user/message` 里混着大量系统注入（接续指令、AGENTS.md、
// runtime context、记忆快照……），直接数会把它们当成「他说的话」。
// 这里用一套前缀规则滤掉，剩下的才进语料。
//
// 用法：
//   node collect-user-speech.mjs                扫全部会话，打印统计
//   node collect-user-speech.mjs --dump <文件>   把语料写成 JSON（供后续分析）
//   node collect-user-speech.mjs --show 40      顺带打印前 N 条

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from './session-turns.mjs'

// 会话数据目录：优先 DSH_SESSIONS，其次 DSH_HOME/sessions。
// 两个都没设时 walkAll() 返回空 —— 不猜路径。
const ROOT = process.env.DSH_SESSIONS || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : '')
// 只扫某个工作区的会话桶（目录名）。留空 = 扫全部。
const BUCKET = process.env.WORKSPACE_BUCKET || ''

// 系统注入的典型开头 —— 命中的一律不算他的话
const SYS_PREFIX = [
  '<system-reminder>',
  'Current runtime context',
  'Time sampled while preparing',
  'Agent session-',
  '[接续前刷新仪式]',
  '[记忆系统',
  '<memory_system>',
  '[Retrieved memory',
  '【记忆',
  '[记忆唤回]',
  '[审计提醒',
  '⟦外部内容',
  // ↓ 这些是**我写给子代理的任务提示**，子代理会话里它也被记成 user/message。
  //   他说话是口语，我写任务是用文书体 —— 这个差别就是分界线。
  '任务：',
  '任务:',
  '你在读一份',
  '你在读',
  '用 read_image',
  '用 write 工具',
  '用 read 工具',
  '请逐张',
  '要求：',
  '要求:',
  '## ',
]

// 出现在正文里就说明不是他的话（子代理消息、系统转述）
const SYS_CONTAINS = [
  'Agent session-',
  'sent a message:',
  'The following workspace instructions',
  'Current DSH file policy',
]

/** 从一帧解出来的 JSONL 里取出「他说的」那句话。 */
export function extractUserText(line) {
  let ev
  try { ev = JSON.parse(line) } catch { return null }
  if (ev.type !== 'user/message') return null
  const c = ev.data && ev.data.content
  if (!Array.isArray(c)) return null
  const txt = c.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join('\n').trim()
  if (!txt) return null
  for (const p of SYS_PREFIX) if (txt.startsWith(p)) return null
  for (const p of SYS_CONTAINS) if (txt.includes(p)) return null
  // 整段就是一条系统提示的，也别当他的话
  if (txt.includes('<system-reminder>') && txt.length > 2000) return null
  // 我写的任务提示里路径密得像清单；他说话时偶尔带一个路径，但不会连着甩一串
  const pathHits = (txt.match(/[A-Z]:\\\\/g) || []).length
  if (pathHits >= 3) return null
  // 超长的基本是材料转述，不是他说的话
  if (txt.length > 4000) return null
  return txt
}

/** 扫一个会话文件，返回他的话。 */
export function speechIn(file) {
  const buf = readFileSync(file)
  const { frames } = scanZstdFrames(buf)
  const out = []
  for (const fr of frames) {
    let t
    try { t = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8') } catch { continue }
    for (const line of t.split('\n')) {
      const s = extractUserText(line)
      if (s) out.push(s)
    }
  }
  return out
}

/** 扫整个 bucket。 */
export function walkAll() {
  if (!ROOT) return { files: 0, items: [] }
  const bucketDir = BUCKET ? join(ROOT, BUCKET) : ROOT
  if (!existsSync(bucketDir)) return { files: 0, items: [] }
  const items = []
  let files = 0
  for (const sid of readdirSync(bucketDir)) {
    const dir = join(bucketDir, sid)
    let st
    try { st = statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    const f = join(dir, 'session.v4.jsonl.zstd')
    if (!existsSync(f)) continue
    files++
    for (const s of speechIn(f)) items.push({ session: sid, text: s, at: statSync(f).mtimeMs })
  }
  return { files, items }
}

const isMain = process.argv[1] && process.argv[1].endsWith('collect-user-speech.mjs')
if (isMain) {
  const argv = process.argv.slice(2)
  const dumpAt = argv.indexOf('--dump')
  const showAt = argv.indexOf('--show')
  const showN = showAt >= 0 ? Number(argv[showAt + 1] || 20) : 0

  const t0 = Date.now()
  const { files, items } = walkAll()
  const ms = Date.now() - t0

  const uniq = [...new Set(items.map((x) => x.text))]
  const lens = uniq.map((s) => s.length).sort((a, b) => a - b)
  const q = (p) => lens[Math.floor(lens.length * p)] || 0

  console.log(`会话文件 ${files} 个 · 耗时 ${ms} ms`)
  console.log(`他的话 ${items.length} 条 · 去重后 ${uniq.length} 条`)
  console.log(`长度：最短 ${lens[0] || 0} · 25% ${q(0.25)} · 中位 ${q(0.5)} · 75% ${q(0.75)} · 最长 ${lens[lens.length - 1] || 0}`)
  console.log(`≤6 字 ${uniq.filter((s) => s.length <= 6).length} · 7-20 字 ${uniq.filter((s) => s.length > 6 && s.length <= 20).length} · 21-80 字 ${uniq.filter((s) => s.length > 20 && s.length <= 80).length} · >80 字 ${uniq.filter((s) => s.length > 80).length}`)

  if (dumpAt >= 0) {
    const out = argv[dumpAt + 1]
    writeFileSync(out, JSON.stringify(items, null, 1), 'utf8')
    console.log(`\n语料已写入：${out}（${items.length} 条）`)
  }
  if (showN > 0) {
    console.log('\n=== 前 ' + showN + ' 条（按会话顺序）===')
    uniq.slice(0, showN).forEach((s, i) => console.log((i + 1) + '. 「' + s.replace(/\n/g, ' ').slice(0, 200) + '」'))
  }
}
