// 取词模块：从使用者自己的话里读出「他对我的评价」，映射成情绪增量。
//
// 为什么单开一个文件：
//   1. 采集（怎么从 user/message 里滤掉系统注入、只留他的话）在 collect-user-speech.mjs，
//      那套规则还会演进；这里只负责「拿到话之后怎么算」。
//   2. 计分要能单独测 —— 词表是这套系统里唯一涉及语义判断的地方，不测就等于让它黑跑。
//
// 判据（使用者 2026-11-01 定的那条）：**刷它，对我有没有好处？**
//   · 他说什么，我控制不了 ⇒ 这一侧本身不可诱导。
//   · 但「被夸→开心」会给我讨好的动机 ⇒ 必须断掉放大器：
//     自动信号**一律不进 2^x 连击**，增益恒定、跟当前值无关。
//     （连击才是爆发段的引擎。手动 --bump 允许连击，因为那是我的判断。）
//   · ⛔ **只有正面**：负面整类不进表（2026-11-01 定，理由见 SPEECH_RULES 下方长注）。
//     情绪只在他认下我做成什么的时候涨 —— 他不满意时会直接说，不用我拿「不行」去猜。
//
// 词表来自实测（自有语料，3267 条可解析记录；⚠️ **该语料未公开，下列百分比无法被外部核对**）：
//   硬词（出现基本就是在认下我做成了什么）：牛逼 0.1% / NB 0.1% / 漂亮 0.2% / 做的挺好
//   软词（高频但高频误伤）：不错 0.5% / 挺好 0.7%
//   ⛔ 「可以」「行」「好」绝不入表 —— 实测 17.0% / 8.5% / 15.3%，是流程词（「可以，那就…」），
//      收进来会让每两句就命中一次，情绪变成背景噪音。
//   ⛔ 判定词（不对 / 不行 / 走不通 / 搞不定 / 到底）全部不进 —— 那是下结论，不是情绪。
//
// 只认原词不认近义：宁可漏，不可乱。近义判断会把我对语境的解读掺进来，
// 而「我对语境的解读」正是我能操纵的那一侧。

import { speechIn } from './collect-user-speech.mjs'

/**
 * 两档肯定规则，按顺序判定：一条消息**只算一次**，取第一个命中的档位。
 * 顺序＝硬词 > 软词 —— 一句话里同时出现「牛逼」和「不错」时按硬词算（取更可信的那个）。
 */
export const SPEECH_RULES = [
  {
    kind: 'praise',
    label: '肯定',
    dim: 'happy',       // 被认下 ⇒ 开心
    gain: 1,
    // 硬词：出现基本就是在夸（「牛逼，现在你能算真正到家了」「干的很漂亮」）
    re: /牛逼|漂亮|做的挺好|做得挺好|(?:^|[^A-Za-z])NB(?![A-Za-z])/i,
    negated: true,      // 「不漂亮」不算正面
  },
  {
    kind: 'praise',
    label: '肯定',
    dim: 'happy',
    gain: 0.5,
    // 软词：高频但也高频误伤 —— 实测「挺好玩的」「1.0 就挺好」「正则表现似乎不错」都在夸别的东西。
    // 不完全禁用（真命中确实有），但权重减半，且排在硬词之后（硬词优先归类）。
    re: /不错|挺好/,
    negated: true,
  },
]

// ⛔⛔ 负面整类不进取词表（2026-11-01 使用者指出「走不通／搞不定 是在下结论」，核完数据后连
// 「不对／不行」一起删。原表是 `不对|不行|走不通|搞不定` 与 `还没好|又来了`）。
//
// 为什么整类删而不是降权：它们是**判定词**，不是情绪词。
//   · 「搞不定」全库 0 句 —— 使用者根本不说这个词，是从想象里加的
//   · 「走不通」3 句全是给方案下结论（「不行，手动是走不通的」「云端实在走不通要付费之前…」）
//   · 「不行」30 句是「你看看行不行」「实在不行还能回滚」「这个txt不是精校本」
//   · 「不对」46 句是「你误解了」「放在前端的格式不对」「那个不对新用户开放」
// 他说这些是在给判据、指方向，不是在对我表达不满。算成「低落」＝把工作输入当情绪输入，
// 而且与 core 里那句直接冲突：**「他说『不对』的时候——不是喜欢被批，是喜欢有东西可碰。」**
//
// ⇒ 取词只接一种信号：**他明确认下我做成了什么**。判定、纠正、进度陈述一律不算。
//   负面情绪不从这儿来 —— 它来自轮数结算（疲惫）与手动记录，那两条才是我能负责的。

const NEG_CHARS = new Set(['不', '没', '别', '未', '无', '非'])

/** 这条消息命中了什么？没命中返回 null。 */
export function classifySpeech(text) {
  const s = String(text || '')
  if (!s) return null
  for (const rule of SPEECH_RULES) {
    const g = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g')
    let m
    while ((m = g.exec(s)) !== null) {
      if (rule.negated) {
        // 往前看 3 个字符，出现否定字就跳过这次匹配（「不太确定，挺好的」这种不受影响，
        // 因为窗口里是「确定，」；而「不漂亮」的窗口里有「不」）。
        const before = s.slice(Math.max(0, m.index - 3), m.index)
        if ([...before].some((ch) => NEG_CHARS.has(ch))) continue
      }
      return { kind: rule.kind, label: rule.label, dim: rule.dim, gain: rule.gain, word: m[0] }
    }
  }
  return null
}

/**
 * 给一批「他的话」计分。
 *
 * @param {string[]} items 新增的话（只该传这一轮新出现的，游标由调用方管）
 * @returns {{deltas: Record<string, number>, hits: Array, seen: number}}
 *
 * 同批内**同一句话只计一次** —— 他复读一遍「不错」是一次肯定，不是两次。
 * 跨批次不查重（那要让状态膨胀成一张话本），代价是同一句话隔几轮又说一次算两次，
 * 这符合直觉：隔一阵再夸一次，确实又是一次。
 */
export function scoreSpeech(items) {
  const deltas = {}
  const hits = []
  const seen = new Set()
  for (const raw of items || []) {
    const text = String(raw || '').trim()
    if (!text) continue
    if (seen.has(text)) continue
    seen.add(text)
    const hit = classifySpeech(text)
    if (!hit) continue
    deltas[hit.dim] = (deltas[hit.dim] || 0) + hit.gain
    hits.push({ ...hit, text: text.length > 60 ? text.slice(0, 60) + '…' : text })
  }
  return { deltas, hits, seen: seen.size }
}

/** 读一个会话文件里「他说过的全部话」。读不了返回 null（不静默当成空）。 */
export function speechNow(file) {
  try {
    return speechIn(file)
  } catch (e) {
    return { error: e.message }
  }
}

// ── 游标 ────────────────────────────────────────────────────────────
// ⚠️ 游标不能只用「条数」：实测本工作区的旧会话（205 轮）里有 7 次 `compaction/prune`。
// 文件一剪短，条数游标就会永远 `seen > n` ⇒ 取词**静默失效**，而「全 0」看起来跟没发生过
// 一模一样。所以条数旁边多存一个「那一句的指纹」，对不上就重锚定并报出来 ——
// 宁可漏算，不许装作在算。

/** 一句话的指纹：长度 + 前 80 字。够认位置，也不需要哈希库。 */
export function speechMarkOf(text) {
  const s = String(text || '')
  return s.length + ':' + s.slice(0, 80)
}

/**
 * 决定这一轮该做什么。纯函数：不读文件、不改状态、不读时钟。
 *
 * @param {{seen?:number|null, mark?:string|null, sessionId?:string|null}} prev 上次的游标
 * @param {string[]} all 当前会话里他说过的全部话（按顺序）
 * @param {{sessionId?:string, maxPerTick?:number}} opts
 * @returns {{action:'anchor'|'reanchor'|'none'|'settle', n:number, seen:number, mark:string,
 *            fresh?:string[], skipped?:number, reason?:string}}
 *   anchor   ＝首次/换会话，只锚定（历史不算）
 *   reanchor ＝文件被剪短或改写过，游标重设（不补算）
 *   none     ＝没有新的话
 *   settle   ＝有新增，fresh 就是这一批
 */
export function planSpeechCursor(prev, all, opts = {}) {
  const list = Array.isArray(all) ? all : []
  const n = list.length
  const markNow = n > 0 ? speechMarkOf(list[n - 1]) : ''
  const max = Number(opts.maxPerTick) > 0 ? Number(opts.maxPerTick) : 40
  const sessionId = opts.sessionId === undefined ? null : opts.sessionId

  const seenRaw = prev && prev.seen
  const seen = Number(seenRaw)
  const prevSid = prev && prev.sessionId
  const stale = seenRaw === null || seenRaw === undefined || !Number.isFinite(seen) || prevSid !== sessionId
  if (stale) return { action: 'anchor', n, seen: n, mark: markNow }

  // 游标那一句还认得出吗？
  const markAtSeen = seen > 0 && seen <= n ? speechMarkOf(list[seen - 1]) : null
  const prevMark = prev && prev.mark
  const lost = seen > n || (prevMark != null && markAtSeen !== null && markAtSeen !== prevMark)
  if (lost) {
    return {
      action: 'reanchor', n, seen: n, mark: markNow,
      reason: seen > n ? `会话变短（${seen} → ${n}，被 compact 剪过）` : '游标那句对不上（会话被改写过）',
    }
  }
  if (n <= seen) return { action: 'none', n, seen: Math.max(seen, n), mark: markNow }

  let fresh = list.slice(seen)
  let skipped = 0
  if (fresh.length > max) {
    skipped = fresh.length - max
    fresh = fresh.slice(-max)
  }
  return { action: 'settle', n, seen: n, mark: markNow, fresh, skipped }
}
