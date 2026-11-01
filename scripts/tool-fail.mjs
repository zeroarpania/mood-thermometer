// 工具结果「算不算失败」的**唯一判据**。
//
// ⛔ 为什么有这个文件（2026-11-02 16:0x 查明的漏判）：
//   原先三个地方各自判一次失败，都只看 `ev.data.error`：
//     · `appraisal-track.mjs` 的 toolOk()
//     · `appraisal-wire.mjs` 的 toolSequence()
//     · `session-turns.mjs` 的 failuresIn()
//   而**真失败的超集是 `ev.data.message.isError`**。六会话 2561 条 tool/result 实测：
//     data.error 存在 43 · isError=true 71 · 两者都有 43 · **只有 isError 28** · 只有 data.error 0
//   ⇒ 旧判据漏掉 28/71 = **39.4% 的真失败**。
//   已抽 10 条看正文，漏掉的全是真失败（`chrome ... did not expose CDP`、`当前会话尚未绑定小说`、
//   `节点不存在：…`、`版本已变化，当前版本 6`、`picturereader: VLM HTTP 400`、
//   `SetNamedSecurityInfoW failed (Win32 5)`）。
//
// ⇒ 此后三处一律从这里取，⛔ 不许再各写一份。判据散在多处，改一处漏两处就是既成事实。

/**
 * tool/result 的正文文本（`data.message.content` 里 type==='text' 的部分拼起来）。
 * ⚠️ 这里自带一份实现（不在 session-turns 里 import），是为了避免循环依赖 ——
 *    session-turns 自己要 import 本文件。函数只有几行，重复成本低于环。
 */
export function resultTextOf(ev) {
  const c = ev && ev.data && ev.data.message && ev.data.message.content
  if (!Array.isArray(c)) return ''
  return c.filter((x) => x && x.type === 'text' && x.text).map((x) => x.text).join('\n')
}

/**
 * 判定一个 tool/result 是否失败，返回 `{kind, detail}` 或 `null`。
 *
 * 判据三条，按优先级：
 *   ① `data.error` 非空 —— 旧字段，先判它，**保证已有 detail 语义不变**
 *      （`self-test.mjs` 断言过 `detail === 'FS_STALE_VERSION'`，顺序不能反）
 *   ② `data.message.isError === true` —— DSH 自己的布尔标记，是 ① 的超集
 *   ③ 正文里 `[exit code: N]` 且 N !== 0 —— 命令级失败兜底
 *
 * @param {object} ev 一条会话事件
 * @returns {{kind:'tool-error'|'exit-nonzero', detail:string}|null}
 */
export function toolFailureOf(ev) {
  if (!ev || ev.type !== 'tool/result') return null
  const d = ev.data || {}
  const msg = d.message || {}

  // ① 旧字段优先：保持 detail 语义（兼容 self-test 与历史 detail）
  if (d.error) {
    const e = d.error
    return { kind: 'tool-error', detail: String((e && (e.code || e.name)) || e) }
  }
  // ② 真失败的超集：DSH 的布尔标记
  if (msg.isError === true) {
    return { kind: 'tool-error', detail: 'isError' }
  }
  // ③ 命令级兜底
  const m = resultTextOf(ev).match(/\[exit code: (-?\d+)\]/)
  if (m && Number(m[1]) !== 0) return { kind: 'exit-nonzero', detail: 'exit ' + m[1] }
  return null
}

/** 便捷版：这个工具结果算失败吗？ */
export function toolFailed(ev) {
  return toolFailureOf(ev) !== null
}
