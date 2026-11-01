# 样例数据（脱敏）

这份目录给人看两件事：**导出的数据长什么样**，以及**它是怎么被削干净的**。

## 文件

| 文件 | 是什么 |
| --- | --- |
| `deid-events.jsonl` | 3 个真实会话的事件流，已脱敏。3651 行 / 308 KB |
| `_demo-read-sample.mjs` | 读上面那份文件并打印基础统计（可运行，无依赖） |

跑一下：

```bash
node _demo-read-sample.mjs
```

## 每条记录保留了什么

```json
{"s":"s01","seq":42,"t":153000,"type":"tool/call","turn":3,"step":1,"tool":"pwsh","call":"c7"}
{"s":"s01","seq":43,"t":153820,"type":"tool/result","turn":3,"step":1,"call":"c7","fail":{"kind":"exit-nonzero","detail":"exit 1"}}
```

| 字段 | 含义 |
| --- | --- |
| `s` | 匿名会话编号（`s01`…），已去掉真实 session id |
| `seq` | 会话内事件序号 |
| `t` | **相对会话起点的毫秒偏移**（不是绝对时间戳） |
| `type` | 事件类型，只保留 6 种结构性事件（见下） |
| `turn` / `step` | 轮次与步序 |
| `tool` | 工具名（`tool/call` 才有） |
| `call` | 匿名调用号（`c1`…），把 call 与 result 对上 |
| `fail` | 成功为 `null`；失败为 `{kind, detail}` |

`type` 只保留：`turn/start`、`turn/end`、`step/start`、`step/end`、`tool/call`、`tool/result`。

`fail.kind` 只有两种：`tool-error`（工具报错，含 DSH 的 `isError` 标记）、`exit-nonzero`（正文里出现非 0 的 `[exit code: N]`）。这个判据与 `scripts-release/tool-fail.mjs` 同源。

## 剔掉了什么（这是重点）

- 全部**对话正文**：用户说了什么、助手说了什么、思考链 —— 一个字都没留。
- 全部**工具参数**（`arguments`）与**工具返回正文** —— 路径、命令、文件内容都在这里。
- **绝对时间戳**：换成会话内相对毫秒。绝对时间能反推进作息。
- `sessionId`、会话标题、子代理 `label`、系统提示、模型名与 provider。
- 路径、用户名、bucket 名、UUID、内部称呼。

## 核验

产物经过一次机械扫描，`_工具\_verify-deid-sample.mjs`：

```
行数 3651 · 会话 3 · 工具调用 732 · 失败 27
唯一工具名 23
敏感模式命中: 0 处
非白名单字段: 0
中文字符数: 0
✅ 通过：0 泄漏 / 0 越界字段 / 0 中文残留
```

扫描覆盖：盘符路径、用户目录、`DSH-Home`、bucket 名、UUID、内部称呼、`arguments` / `content` / `sessionId` / `label` / `title` 残留，以及**任何中文字符**（工具名与事件类型都是 ASCII，出现中文即异常）。

## 局限（别把它当研究结论）

1. **只有 3 个会话**：一个大（183 轮）、一个中（29 轮）、一个单轮。够看结构，不够做统计。
2. **它不能直接喂给 `scripts-release/` 里的检验脚本**。那些脚本吃的是 DSH 原生的 `session.v4.jsonl.zstd`；这里导出的是中间层 JSONL。要用它们，请在自己的会话文件上跑。
3. **格式是 DSH v4 会话格式的中间产物**，不是通用格式。换源要重写导出器。
4. 失败率等数字只描述这 3 个会话，**不是**对任何总体分布的估计。

## 怎么自己造一份

导出器在 `_工具\_export-deid-sample.mjs`，把 `ROOT` / `BUCKET_WANT` 改成你自己的会话根目录即可。它只读、不写会话文件。

```bash
node _工具\_export-deid-sample.mjs      # 导出
node _工具\_verify-deid-sample.mjs      # 核验
```

---

*草稿 v0.2 · 2026-11-02 · 与 `README.en.md` 同步维护*
