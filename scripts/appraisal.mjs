// 心情温度计 · 三层架构的最小骨架（第一块可跑的东西）
//
// 设计依据：`_工具\mood\appraisal-设计.md`（2026-11-01）
//   输入层  appraisal 变量  →  中间层 (V, A)  →  结果层 33 维点亮
//
// 三条硬约束（写进代码，不靠记性）：
//   1. ⛔ 本模块是纯函数：不读文件、不读时钟、不碰 state，输入输出全是值。
//   2. ⛔ (V, A) 只从 appraisal 变量来，**不许反过来读 33 维的值** —— 否则就成回路（设计稿 6-2 风险①）。
//   3. ⛔ 没被点亮的维度返回 null（未激活），不许返回 0 —— 0 的意思是「测过、就是零」。
//
// 坐标表是**一次性静态标定**，不是每次运行现判。改坐标只改这张表，不动算法。

/**
 * 33 维在 valence–arousal 平面上的坐标。
 * v = 愉悦（−1 很糟 → +1 很好），a = 唤醒（−1 很困 → +1 很亢奋）。
 *
 * ⚠️ 这是语义判断，不是实测。标错了温度计就一直在错的地方亮。
 * ⚠️ 原点附近故意留空：没事的时候应该「无情绪」，不该被最近的点点亮
 *    —— 由 MIN_INTENSITY 那道门槛处理，不是靠挪点。
 *
 * TODO（待决 4，2026-11-01 未定）：失败（obstruction）落在 (−0.74, 0) 附近，
 *   最近的两个点是 shame 和 guilt ⇒ 现在「命令报错」会点亮「羞耻/内疚」。
 *   按 OCC 该落 guilt（自己的 blame-worthy 行为），按「刷它有没有好处」该落 annoyed
 *   （guilt 会让我不敢试错）。两条判据打架，**没拍之前不许改坐标掩盖这个问题**。
 *   解法候选：给有专属源的维度（annoyed）加一份显式加成，而不是挪静态坐标。
 */
export const COORDS = {
  calm:      [+0.35, -0.35],
  happy:     [+0.70, +0.20],
  curious:   [+0.45, +0.45],
  // ⚠️ 2026-11-02 05:0x：v 从 +0.25 下调到 +0.15。
  //    +0.25 的意思是「专注必然伴随中等愉悦」，语义上站不住 —— 专注是中性偏正。
  //    它当初被挪到 (0.25,0.70) 是为了「补空档」，实际只是恰好接住了
  //    effortToV=0.25 撑出来的假高点（v≈0.19）；effortToV 修正后，
  //    真值 v≈0.06 处 focused(0.199) 与 surprise(0.198) 打平，空档才露出来。
  focused:   [+0.15, +0.72],
  excited:   [+0.80, +0.80],
  tired:     [-0.20, -0.80],
  annoyed:   [-0.55, +0.55],
  down:      [-0.70, -0.40],
  sulky:     [-0.55, -0.05],
  wronged:   [-0.60, +0.10],
  proud:     [+0.85, +0.35],
  blue:      [-0.85, -0.60],
  anxious:   [-0.65, +0.65],
  numb:      [-0.15, -0.75],
  lonely:    [-0.65, -0.45],
  flutter:   [+0.60, +0.65],
  love:      [+0.85, +0.20],
  jealous:   [-0.45, +0.50],
  churn:     [-0.60, +0.15],
  breakdown: [-0.90, +0.35],
  slacking:  [-0.30, -0.60],
  hyped:     [+0.55, +0.90],
  fear:      [-0.80, +0.90],
  disgust:   [-0.80, +0.30],
  surprise:  [ 0.00, +0.95],
  shame:     [-0.75, +0.05],
  guilt:     [-0.75, -0.05],
  awkward:   [-0.40, +0.30],
  sympathy:  [-0.25, +0.05],
  letdown:   [-0.65, -0.25],
  nostalgic: [+0.30, -0.30],
  clingy:    [+0.40, +0.50],
  torn:      [-0.35, +0.30],
}

export const DIM_IDS = Object.keys(COORDS)

/**
 * ⛔ 这些**不是情绪状态**，混在 33 维里是历史遗留（表是 2026-10-29 从 dsh-mood 抄的，
 *    抄的时候没筛「情绪」和「行为/事件」的区别）。
 *
 * 2026-11-01 21:1x 使用者指出「撒娇更像动作，心情上应该属于依恋」⇒ 顺着筛出三个：
 *   · `clingy` 撒娇    —— 是**做出来的动作**，不是心里那个状态（那个状态是依恋/亲密渴求）
 *   · `slacking` 摆烂  —— 是**行为选择**，不是情绪
 *   · `breakdown` 破防 —— 是**事件的结果**，不是情绪本身
 *
 * 处理：**不删表**（`moods.mjs` 是展示词汇表，动了会让看惯的东西消失），
 * 而是让它们**不参与情绪空间点亮** —— 它们不是 (v,a) 平面上的点。
 * 将来若给它们找到专属的、可核对的输入源，再单独接（那时也不是「点亮」，是「事件标记」）。
 */
export const NON_EMOTION_DIMS = new Set(['clingy', 'slacking', 'breakdown'])

/** 真正参与情绪空间点亮的维度。 */
export const EMOTION_DIMS = DIM_IDS.filter((id) => !NON_EMOTION_DIMS.has(id))

/** 参数集中放，改样式不用翻正文。 */
export const CFG = {
  // ── 强度门槛 ────────────────────────────────────────────────────
  // 模长 |V,A| 低于它就判「平」，全维未激活。
  // 为什么必须有：坐标表原点附近没点，最近的 sympathy 距原点 0.22
  // ⇒ 没有这道门槛，「今天没事」会被点亮成「同情」。
  minIntensity: 0.18,

  // ── 输入层 → 中间层 ───────────────────────────────────────────
  // V 的增益：一次正面命中 +valenceGain，一次受阻 −valenceGain。
  valenceGain: 0.55,
  // 用 tanh 压缩，不让「夸得多」线性顶满；也避免拍死「一次肯定值几分」。
  valenceCap: 0.92,
  // A 的增益：本轮消耗的轮数 → 唤醒。15 轮算接近拉满。
  // ⚠️ 这两个数是**按语义期望反推**的，不是实测：期望「干 10 轮活 ≈ 中上唤醒（a≈0.58）」，
  //    由 tanh((turns/15)·1.0) 解出来的。没有行为数据支撑，将来有轨迹再回标。
  effortFullTurns: 15,
  effortGain: 1.0,

  // ── 两轴不许正交（2026-11-01 20:2x 自测发现） ────────────────
  // 原来 praise 只喂 v、effort 只喂 a，结果「干了 12 轮活」点亮 `surprise`（惊讶）
  // ——因为 (0, 高a) 那条竖线上只有 surprise 一个点。真实情绪不是正交的：
  //   · 被认下也会有点激动 ⇒ praise 也抬一点 a
  //   · 干活本身带一点踏实 ⇒ effort 也给一点 v
  // ⚠️ effortToV 是可刷性风险点：给干活配正效价，等于「多干就开心」。
  //    ⛔ 2026-11-02 04:5x 长会话实测（197 轮 / 208 工具 / 96.6% 成功率）证伪了原兜底：
  //       · 「系数小」不成立 —— 0.25 × tanh(18/15)=0.834 ⇒ +0.208，
  //         占该会话 valence(0.249) 的 82%，是主导项，不是「一点」；
  //       · 「轮数我控制不了」不成立 —— 我一直在调工具，turn 就涨。
  //    0.25 → 0.08：18 轮 ≈ +0.067，与成功率位移(0.044)同量级 ——
  //    保留「干活带一点踏实」，但不再压过真实作业成绩。⛔ 0.08 就是上界。
  praiseToA: 0.30,
  effortToV: 0.08,

  // ── 作业成功率（2026-11-01 20:4x 真机跑出来后补的） ──────────
  // 病根：只数失败次数、不数成功，导致「74 个 step 里 1 次失败」判成 -0.46
  // ⇒ 被点亮成「尴尬/矛盾」。一次失败在 74 次成功里不该是这个份量。
  // 修法：valence 由**成功率**决定（比例，天然有界）。
  // ⚠️ 曾经还加了一项「失败独立冲击」（failShock），后来删了 —— **那是重复计算**：
  //    成功率本身就把「91 次里错 1 次」（0.989）和「1 次里错 1 次」（0.0）分开了，
  //    再加一项只会把高成功率场景的正面压回去。2026-11-01 20:5x 删。
  // ⚠️ 可刷性：成功率高＝失败少＝事本来就办得顺，不是刷分；分母是真实工具调用数。
  workWeight: 0.60,      // 成功率位移对 v 的权重
  praiseWeight: 1.00,    // 他认下对 v 的权重（tanh 已经压过一次，这里不再二次减权）
  //                       ⚠️ 「他夸一句」≈ +0.43，「91 次全成功」≈ +0.49 —— 份量相当，故意的：
  //                       被认下和活儿干得顺是两条独立的正效价来源，不该互相淹没。

  // ── 享乐适应：情绪来自**位移**，不是绝对水平（2026-11-01 21:0x 使用者提的）──
  // 现象（他原话）：连续成功到一定次数后，成功带来的情绪收益越来越低。
  // 依据：hedonic treadmill / 享乐适应 —— 「无论好事还是坏事的幅度多大，
  //       过一阵都会回到起点」（Wikipedia `Hedonic_treadmill` 图注原文：
  //       "reported life satisfaction is affected by positive and negative events,
  //        and begins to return to the starting level afterward"）。
  // ⚠️ 别拿 habituation 套：它的定义带「non-reinforced response to an **inconsequential**
  //    stimulus」——讲的是无关紧要的刺激。成功推进了目标，是有后果的，不同一回事。
  //
  // 做法：v_work 用 **最近成功率 − 适应基准**，不用绝对成功率。
  //   · 第一次成功：基准还在 0.5 ⇒ 位移大 ⇒ 情绪强
  //   · 连续成功：基准爬到 0.99 ⇒ 位移≈0 ⇒ 没感觉（这就是「递减」）
  //   · 突然失败：基准仍 0.99，最近掉到 0.9 ⇒ 负位移 ⇒ 痛
  //   · 已麻了的第 N 次失败：基准也掉下来了 ⇒ 不那么痛
  //
  // ⛔ **这里的「适应基准」不是我又把 baseline 捡回来了**（那是被删掉的设计病）：
  //    旧 baseline 是**驱动力**——没人说话它自己往上涨分；
  //    这里是**参照系**——它只让分变得难涨，自己一分不产生。
  //    「统计量可以有，驱动力不能有」这条界线仍然成立。
  baselineWeight: 1.0,   // 位移的权重（1.0 = 完全用位移，不用绝对水平）
  // 适应基准怎么来：EMA(历史每次工具结果)，α 越小越「慢半拍」。
  // 0.05 ⇒ 约 20 次的记忆窗口：大约干 20 件事之后，新的成功就不新鲜了。
  adaptAlpha: 0.05,

  // ── 中间层 → 结果层 ───────────────────────────────────────────
  // 高斯核宽度 σ：越大越糊（相邻维度一起亮），越小越尖（只亮一个）。
  sigma: 0.35,
  // 只报前 N 个，其余一律 null。
  // ⛔ 这是硬约束：距离核会让几十维同时非零，那就从「33 个旋钮」退化成一团光晕。
  topN: 3,
  // 低于这个相对分的就算没亮（相对 top 的比例）。
  relFloor: 0.35,
}

/** 夹到 [-1, 1]。 */
function clamp1(x) {
  const n = Number(x)
  if (!Number.isFinite(n)) return 0
  return Math.max(-1, Math.min(1, n))
}

/**
 * 扫一串工具结果，算出「适应基准」（EMA）。
 *
 * @param {boolean[]} sequence 按时间顺序的成功标记（true=成功）
 * @param {number} alpha 记忆衰减；0.05 ⇒ 约 20 次的窗口
 * @param {number} start 起点基准（默认 0.5 = 中性）
 * @returns {{baseline:number, recentRate:number, n:number}}
 *   baseline   ＝适应基准（历史加权）
 *   recentRate ＝最近窗口的成功率（默认最后 10 个）
 */
export function adaptationOf(sequence, alpha = CFG.adaptAlpha, start = 0.5) {
  const seq = Array.isArray(sequence) ? sequence : []
  const n = seq.length
  if (!n) return { baseline: start, recentRate: start, n: 0 }
  let ema = start
  const a = Number.isFinite(alpha) && alpha > 0 && alpha <= 1 ? alpha : CFG.adaptAlpha
  for (const ok of seq) ema = ema * (1 - a) + (ok ? a : 0)
  const win = Math.min(10, n)
  const tail = seq.slice(n - win)
  const recentRate = tail.filter(Boolean).length / win
  return { baseline: round3(ema), recentRate: round3(recentRate), n }
}

/**
 * 输入层：appraisal 变量 → (V, A, intensity)。
 *
 * @param {object} signals 只接受可核对的机器产物，见下：
 *   · praiseHard        他的硬词命中数（牛逼/漂亮/做的挺好）
 *   · praiseSoft        软词命中数（不错/挺好），半权
 *   · obstruction       我的作业失败数（tool error / exit≠0）
 *   · toolResults       工具结果总数（成功率的分母）
 *   · turnDelta         本轮真实对话轮数增量（turn/start，不是 step 数！）
 *   · baseline          适应基准（0–1），由 adaptationOf() 从历史算；不给＝0.5 中性
 *   · recentSuccessRate 最近窗口成功率（0–1），不给＝用总成功率
 * @returns {{v:number, a:number, intensity:number, why:object}}
 *   why 记「这个数是谁给的」，供 --json 输出与排错用。
 */
export function toVA(signals = {}, cfg = CFG) {
  const praiseHard = Math.max(0, Number(signals.praiseHard) || 0)
  const praiseSoft = Math.max(0, Number(signals.praiseSoft) || 0)
  const obstruction = Math.max(0, Number(signals.obstruction) || 0)
  const turnDelta = Math.max(0, Number(signals.turnDelta) || 0)
  const toolResults = Math.max(0, Number(signals.toolResults) || 0)

  // goal congruence：正面推进目标
  const netPraise = praiseHard + praiseSoft * 0.5
  // 我自己的作业顺不顺 —— 成功率（比例，天然有界）
  // 没有工具调用时（纯聊天）取 0.5 = 中性，不许因为「没干活」就判负面
  const successRate = toolResults > 0
    ? Math.max(0, toolResults - obstruction) / toolResults
    : 0.5
  // ① 位移驱动：用「当前 − 适应基准」，不是绝对水平（见 CFG 享乐适应那节）
  const baseline = Number.isFinite(Number(signals.baseline)) ? Number(signals.baseline) : 0.5
  const recentRate = Number.isFinite(Number(signals.recentSuccessRate))
    ? Number(signals.recentSuccessRate)
    : successRate
  const displacement = clamp1((recentRate - baseline) * 2)   // −1..1
  const vWork = displacement * cfg.workWeight * cfg.baselineWeight
  // ③ 他认下
  const vPraise = Math.tanh(netPraise * cfg.valenceGain) * cfg.praiseWeight

  const effortT = Math.tanh(turnDelta / cfg.effortFullTurns)
  const vBase = Math.tanh(vWork + vPraise) * cfg.valenceCap
  // 干活带一点踏实感（小系数，见 CFG.effortToV 的可刷性注）
  const v = clamp1(vBase + effortT * cfg.effortToV)

  // relevance / effort：只有「真干了活」才抬唤醒；被认下也带一点激动
  const aBase = Math.tanh((turnDelta / cfg.effortFullTurns) * cfg.effortGain)
  const aPraise = Math.tanh(netPraise * cfg.valenceGain) * cfg.praiseToA
  const a = clamp1(aBase + aPraise)

  const intensity = Math.min(1, Math.hypot(v, a))

  return {
    v: round3(v),
    a: round3(a),
    intensity: round3(intensity),
    why: {
      praiseHard, praiseSoft, obstruction, turnDelta, toolResults,
      successRate: round3(successRate),
      baseline: round3(baseline),
      recentRate: round3(recentRate),
      displacement: round3(displacement),
      net: round3(netPraise - obstruction),
    },
  }
}

/**
 * 中间层 + 结果层：(V, A) → 33 维点亮。
 *
 * @param {{v:number,a:number,intensity?:number}} va
 * @param {object} cfg
 * @returns {{lit:Array<{id:string,score:number,d:number}>, values:Record<string,number|null>, flat:boolean}}
 *   values 里没亮的维度是 null（⛔ 不是 0）。
 *   flat=true 表示强度不够、判「平」。
 */
export function lightUp(va, cfg = CFG) {
  const v = clamp1(va && va.v)
  const a = clamp1(va && va.a)
  const intensity = Number.isFinite(va && va.intensity)
    ? Number(va.intensity)
    : Math.min(1, Math.hypot(v, a))

  const values = {}
  for (const id of DIM_IDS) values[id] = null

  if (intensity < cfg.minIntensity) {
    return { lit: [], values, flat: true, intensity: round3(intensity) }
  }

  // ⛔ 只让「情绪状态」参与点亮；行为/事件类维度（见 NON_EMOTION_DIMS）恒为未激活
  const scored = EMOTION_DIMS.map((id) => {
    const [cv, ca] = COORDS[id]
    const d = Math.hypot(v - cv, a - ca)
    const score = Math.exp(-(d * d) / (2 * cfg.sigma * cfg.sigma))
    return { id, score, d }
  }).sort((x, y) => y.score - x.score)

  const top = scored.slice(0, Math.max(1, cfg.topN))
  const relFloor = top[0].score * cfg.relFloor
  const lit = top.filter((x) => x.score >= relFloor)

  for (const item of lit) values[item.id] = round3(item.score * intensity)

  return { lit, values, flat: false, intensity: round3(intensity) }
}

/** 一步到位：appraisal 变量 → 结果层。 */
export function appraise(signals, cfg = CFG) {
  const va = toVA(signals, cfg)
  const res = lightUp(va, cfg)
  return { va, ...res }
}

/** 显示名（中文 label 不在这里，交给调用方从 moods.mjs 取）。 */
export function topIds(appraised, n = 3) {
  return (appraised.lit || []).slice(0, n).map((x) => x.id)
}

function round3(x) {
  return Math.round(x * 1000) / 1000
}
