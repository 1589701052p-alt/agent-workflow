# RFC-049 — 技术设计

> 配套 `proposal.md`。本文件给具体接口契约、改动落点、失败模式 + 测试策略。

## 1. 改动总览

| 层      | 文件                                                                          | 改动                                                                                                                  |
| ------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| shared  | `packages/shared/src/prompt.ts`                                               | `EnvelopeFollowupInput` 加可选 `portValidationFailures` + `agentOutputKinds` + `perKindRepairBlocks`（pre-rendered，由 backend 调 handler 生成后塞进来；shared 侧只拼接，不导入 backend handler）；`renderEnvelopeFollowupPrompt` 按 G3 矩阵 + per-kind 顺序锚点渲染 |
| shared  | `packages/shared/src/schemas/nodeRun.ts`                                      | `NodeRunSchema` 加 `portValidationFailures: ...nullable().default(null)`，与新 DB 列 1:1 对齐                          |
| backend | `packages/backend/db/migrations/0026_port_validation_failures.sql`            | 新 migration：`ALTER TABLE node_runs ADD COLUMN port_validation_failures_json TEXT`（nullable，老行恒 NULL）          |
| backend | `packages/backend/src/db/schema.ts`                                           | `nodeRuns` 表新字段 `portValidationFailuresJson: text('port_validation_failures_json')`                              |
| backend | `packages/backend/src/services/outputKinds/types.ts`                          | 新文件，export `OutputKindHandler` 接口（kind / subReasons / buildPromptGuidance / validate / buildRepairBlock 五字段）+ `ValidateCtx` / `ValidateResult` / `KindFailure` 类型；文件头注释"四方法上限，新增能力请走单独 RFC；不导出到 shared 公共 barrel" |
| backend | `packages/backend/src/services/outputKinds/{string,markdown,markdownFile}.ts` | 新目录，每个 kind 一个文件 `export default` 一个 `OutputKindHandler`：string/markdown 的 buildPromptGuidance/buildRepairBlock 返 null、validate 永真；markdownFile 实现 5 个 subReason 失败（`empty-path` / `escapes-worktree` / `missing-file` / **`wrong-extension`** / **`empty-file`**）+ buildPromptGuidance（搬自原 `buildMarkdownFilePortGuidance`）+ buildRepairBlock |
| backend | `packages/backend/src/services/outputKinds/index.ts`                          | 静态 import 三个 handler 组成 `HANDLERS: Record<AgentOutputKind, OutputKindHandler>` const；模块加载期 assert subReasons 拍平唯一（重名 throw `subReason collision: ...`）；export `getOutputKindHandler(kind)` + `iterateHandlers(kinds)` |
| backend | `packages/backend/src/services/envelope.ts`                                   | `resolvePortContent` / `resolvePortContentDetailed` 改走 handler dispatch；errorMessage prefix swap 到 `port-validation-${kind}-${sub}` 命名空间；**删除 `tryReadInWorktreeMarkdownPath` 整段**（forgiveness path） |
| backend | `packages/backend/src/services/scheduler.ts`                                  | `decideEnvelopeFollowup` 识别 `port-validation-` 前缀；followup attempt 调 backend 侧 `composePerKindRepairBlocks(failures, agent.outputKinds)` 把每 kind 的 repair 段预渲染成 `perKindRepairBlocks` 字符串数组，再透传到 shared `renderEnvelopeFollowupPrompt`；failures 从新列 SELECT 而不是 errorMessage 后半段 parse |
| backend | `packages/backend/src/services/runner.ts`                                     | `RunNodeOptions.envelopeFollowupPortValidations?: Array<{port,kind,subReason,detail?}>`；validate 失败时 INSERT failures 到新列；followup 分支调 `composePerKindRepairBlocks` 把 handler 渲染出的字符串数组带进 prompt 渲染；**首轮 prompt build 路径同步迁移**——`buildProtocolBlock` 改成从 `iterateHandlers(agent.outputKinds)` 调 `buildPromptGuidance` 拼，原 `buildMarkdownFilePortGuidance` 函数从 shared/prompt.ts 移除，调用方改成 handler.buildPromptGuidance |
| backend | `packages/backend/src/services/task.ts`                                       | `rowToNodeRun` mapper 透传 `portValidationFailures` 字段（坏 JSON 兜底 null + warn 不 5xx）                            |
| backend | `packages/backend/tests/`                                                     | 见 §6 测试矩阵                                                                                                          |
| shared  | `packages/shared/tests/`                                                      | 见 §6 测试矩阵                                                                                                          |

DB migration 0026（**新增一列**）+ schema.ts / nodeRun.ts 同步；零 WS schema / 前端代码改动。

## 2. shared — prompt.ts 接口扩展

### 2.1 `EnvelopeFollowupInput` 新字段

```ts
export interface EnvelopeFollowupInput {
  // ... 既有字段
  hasClarifyChannel: boolean
  clarifyDirective?: 'continue' | 'stop'
  reason: 'envelope-missing' | 'both-present' | 'clarify-malformed' | 'port-validation'

  /**
   * RFC-049 — 端口内容校验失败列表。仅当 reason === 'port-validation' 时非空。
   * 与 RFC-042 既有四 reason 互斥触发；scheduler 选最新一次失败的失败类型。
   * `subReason` 是 handler 内部的扁平短码（如 `missing-file`）；errorMessage
   * 里的 `<kind>-<sub>` 命名空间复合码不在这里重复表达，kind 单独存一列。
   */
  portValidationFailures?: ReadonlyArray<{
    port: string
    kind: AgentOutputKind
    subReason: string  // 由对应 handler 的 subReasons 集合宣告；未知 sub 直接透传（degraded 兼容）
    detail?: string
  }>

  /**
   * RFC-049 — 节点 agent 的 outputKinds 字典；shared prompt 渲染时不直接使用
   * （shared 不知道 handler 实现），但作为 reason==='port-validation' 的契约
   * 标记位 + 让"哪些 port 声明为哪种 kind"在 prompt 文案里可被引用。
   */
  agentOutputKinds?: AgentOutputKindsMap

  /**
   * RFC-049 — backend 侧预渲染的 per-kind repair block 字符串数组。
   *
   * shared/prompt.ts 不导入 backend 的 `OutputKindHandler`（保 shared 不依赖
   * backend），由 scheduler/runner 在调用前对每 kind 调 `handler.buildRepairBlock`
   * 拼出非空段，按 failures 首次出现顺序去重塞进数组。shared 侧 renderEnvelope
   * FollowupPrompt 只负责"按顺序锚点拼接"，不感知 kind 细节。
   *
   * 仅当 reason === 'port-validation' 时非空；其它 reason 下未定义。
   */
  perKindRepairBlocks?: ReadonlyArray<string>
}
```

### 2.2 `renderEnvelopeFollowupPrompt` 渲染顺序锚点

按 proposal §G3 表，文案结构（自顶向下）固定为：

```
\n\n---\n**<<opening label>>** <one-line summary>

- <bullet 1>          <— bi-modal preamble bullets，hasClarifyChannel=true 时出现
- <bullet 2>
- ...

<<perKindRepairBlocks[0]>>   <— 由 backend handler 预渲染，shared 直接拼接
<<perKindRepairBlocks[1]>>   <— failures 首次出现顺序去重；每 handler 自己负责段头
<<perKindRepairBlocks[N]>>      标记（如 markdown_file handler 自渲染 `**Port
                                content validation — markdown_file.**`）；shared
                                只在段间插空行。

<<trailer>>   <— hasClarifyChannel=true + directive=continue 时出现 RFC-039 strong-bias 短句
```

- M2（hasClarifyChannel=false + markdown_file 失败）：bi-modal preamble **不出现**（hasClarifyChannel=false），直接进 perKindRepairBlocks 段；末尾不追加 trailer。
- M4（hasClarifyChannel=true + markdown_file 失败 + directive 无 / stop）：bi-modal preamble + perKindRepairBlocks 段；末尾不追加 RFC-039 strong-bias trailer。
- M5（hasClarifyChannel=true + markdown_file 失败 + directive=continue）：M4 的全部 + 末尾追加 RFC-039 strong-bias trailer。

源码层 grep 守卫：测试断言 prompt.ts 同时出现"既有 bi-modal preamble 函数 + perKindRepairBlocks 数组迭代 + 既有 RFC-039 trailer 文案"，顺序串联只能在 `renderEnvelopeFollowupPrompt` 一处发生。kind-specific 文案（如 markdown_file 的 "two-step protocol" 短句）**不**出现在 shared/prompt.ts 里——已搬进 backend `markdownFile.ts` handler，shared 侧只见 pre-rendered 字符串。

### 2.3 backend `composePerKindRepairBlocks(failures, outputKinds)` + handler.buildRepairBlock

shared 侧**不**再有 `buildPortValidationRepairBlock` 这个集中函数。取而代之：

- backend `outputKinds/index.ts` export 一个 helper `composePerKindRepairBlocks(failures, outputKinds) → readonly string[]`：
  1. 把 failures 按 `kind` 分桶（保 first-occurrence 顺序）；
  2. 对每个 kind 调 `HANDLERS[kind].buildRepairBlock({ failures: kindFailures, ports: kindPorts })`；
  3. 把非 null 段按桶顺序组成字符串数组返回。
- 每个 handler 的 `buildRepairBlock` 自渲染本 kind 的**完整一段**，包括段头标记（如 markdown_file handler 输出 `\n\n[Port content validation — markdown_file.]\n- port \`docpath\`: file at the given path does not exist. ENOENT ...\n\nFor ports declared markdown_file (docpath) you MUST follow the two-step protocol — write the file to disk first, then place ONLY the worktree-relative path inside the matching <port> tag.`）；shared 侧只在段之间插空行，不感知 kind 细节。
- markdownFile handler 的 sub-reason 短词表（实现层内部映射，外部 grep 不到）：
  - `empty-path → empty path`
  - `escapes-worktree → path escapes the task worktree`
  - `missing-file → file at the given path does not exist`
  - `wrong-extension → path extension is not .md / .markdown`
  - `empty-file → file exists but content is empty after trim`
- string / markdown handler 的 `buildRepairBlock` 永远返回 `null`（这两种 kind 不会失败）；degraded 兼容：handler 不在 HANDLERS 表里时 helper 跳过该 failure（warn log），不阻塞 followup 渲染。
- 单元测试：handler.buildRepairBlock 各 case（见 §6.2）+ `composePerKindRepairBlocks` 集成测试（见 §6.5）。

## 3. backend — outputKinds 目录

### 3.1 目录骨架

```
packages/backend/src/services/outputKinds/
├── types.ts         // OutputKindHandler 接口 + ValidateCtx / ValidateResult / KindFailure 类型；文件头注释"四方法上限"
├── string.ts        // export default { kind: 'string', subReasons: new Set(), buildPromptGuidance: () => null, validate: () => { ok: true, ... }, buildRepairBlock: () => null }
├── markdown.ts      // 同 string；契约就是 no validation
├── markdownFile.ts  // 完整实现：subReasons = {empty-path, escapes-worktree, missing-file, wrong-extension, empty-file}；buildPromptGuidance = 原 buildMarkdownFilePortGuidance 短句；validate = 5 层校验；buildRepairBlock = 自渲染 "[Port content validation — markdown_file.]" 完整一段
└── index.ts         // 静态 import 三个 handler；HANDLERS const + 模块加载期 assert subReasons 拍平唯一；export getOutputKindHandler / iterateHandlers / composePerKindRepairBlocks
```

### 3.2 `OutputKindHandler` 接口

```ts
// packages/backend/src/services/outputKinds/types.ts
//
// 四方法上限——新增能力（如多进程 sharding strategy / aggregator / telemetry tag）
// 请走单独 RFC 评估，不要私自往这里加字段。本接口不导出到 packages/shared 的公共
// API barrel，作为 internal extension point 使用。

import type { AgentOutputKind } from '@agent-workflow/shared'

export interface ValidateCtx {
  worktreePath: string
  port: string
  kind: AgentOutputKind
}

export type ValidateResult =
  | { ok: true; body: string; sourcePath?: string }
  | { ok: false; subReason: string; detail: string }

export interface KindFailure {
  port: string
  kind: AgentOutputKind
  subReason: string  // handler 内部扁平短码，由 handler.subReasons 宣告
  detail?: string
}

export interface OutputKindHandler<K extends AgentOutputKind = AgentOutputKind> {
  readonly kind: K
  readonly subReasons: ReadonlySet<string>

  /** 首轮 user prompt 注入。仅收到声明为本 kind 的端口；null = 跳过。 */
  buildPromptGuidance(input: { ports: readonly string[] }): string | null

  /** envelope 解析后的 per-port 校验。失败返 { ok:false, subReason: '<本 handler subReasons 中的一项>', detail } —— **不抛**，由 envelope.ts 统一转 ValidationError。 */
  validate(rawContent: string, ctx: ValidateCtx): ValidateResult

  /** followup repair 段。仅收到本 kind 的失败和端口；handler 自渲染段头标记 + 全部正文；null = 跳过（string/markdown 永远返 null）。 */
  buildRepairBlock(input: { failures: readonly KindFailure[]; ports: readonly string[] }): string | null
}
```

```ts
// packages/backend/src/services/outputKinds/index.ts

import stringHandler from './string'
import markdownHandler from './markdown'
import markdownFileHandler from './markdownFile'
import type { OutputKindHandler, KindFailure } from './types'
import type { AgentOutputKind, AgentOutputKindsMap } from '@agent-workflow/shared'

const HANDLERS: Record<AgentOutputKind, OutputKindHandler> = {
  string: stringHandler,
  markdown: markdownHandler,
  markdown_file: markdownFileHandler,
}

// 模块加载期 assert：所有 handler 的 subReasons 拍平唯一，重名直接 throw。
{
  const claimed = new Map<string, AgentOutputKind>()
  for (const h of Object.values(HANDLERS)) {
    for (const sub of h.subReasons) {
      const prev = claimed.get(sub)
      if (prev) throw new Error(`subReason collision: '${sub}' claimed by both ${prev} and ${h.kind}`)
      claimed.set(sub, h.kind)
    }
  }
}

export function getOutputKindHandler(kind: AgentOutputKind): OutputKindHandler | undefined {
  return HANDLERS[kind]
}

export function iterateHandlers(outputKinds: AgentOutputKindsMap): Array<{ handler: OutputKindHandler; ports: string[] }> {
  // 按 outputKinds 字典中 distinct kind 的 first-occurrence 顺序返回，每项带本 kind 的 ports 数组。
  // ...
}

export function composePerKindRepairBlocks(
  failures: readonly KindFailure[],
  outputKinds: AgentOutputKindsMap,
): readonly string[] {
  // 按 failures 中 kind 的 first-occurrence 顺序去重；对每个 kind 调 handler.buildRepairBlock，
  // 非 null 段加入返回数组。kind 在 HANDLERS 表里不存在 → warn log + 跳过（degraded）。
  // ...
}
```

每个 handler 的实现要点（参考代码骨架，落地按 RFC-049 PR-A/PR-B 拆分）：

- `string.ts` / `markdown.ts`：`subReasons = new Set()`；`buildPromptGuidance / buildRepairBlock` 永远 `() => null`；`validate` 永远 `{ ok: true, body: rawContent }`。
- `markdownFile.ts`：`subReasons = new Set(['empty-path', 'escapes-worktree', 'missing-file', 'wrong-extension', 'empty-file'])`；`buildPromptGuidance({ ports })` 输出原 `buildMarkdownFilePortGuidance` 的两步协议短句（参数化 ports 列表）；`validate(rawContent, ctx)` 按序执行五层校验（与原文一致，含 wrong-extension 大小写不敏感、empty-file trim 校验）；`buildRepairBlock({ failures, ports })` 自渲染段头 `[Port content validation — markdown_file.]` + 每 failure 一行 + 末尾"two-step protocol"提醒。

### 3.3 envelope.ts 改造（含 forgiveness path 删除）

`resolvePortContentDetailed` 主路径改成：

```ts
import { getOutputKindHandler } from './outputKinds'

// kind 未声明 → raw 字符串透传（forgiveness path 已删除，agent 想读文件请显式声明）
if (opts.kind === undefined) {
  return { body: rawContent }
}

const handler = getOutputKindHandler(opts.kind)
if (!handler) {
  // 理论不可达——AgentOutputKind 枚举与 HANDLERS 表 1:1；这里防 dev-time 漏注册。
  throw new Error(`outputKind handler not registered: ${opts.kind}`)
}

const result = handler.validate(rawContent, {
  worktreePath,
  port: opts.port,
  kind: opts.kind,
})

if (result.ok) {
  return { body: result.body, sourcePath: result.sourcePath }
}

// errCode 用 kind 命名空间：port-validation-${kind}-${sub}
throw new PortValidationError(
  `port-validation-${opts.kind}-${result.subReason}`,
  `port-validation-${opts.kind}-${result.subReason}: ${result.detail}`,
  { port: opts.port, kind: opts.kind, subReason: result.subReason, detail: result.detail },
)
```

老的 `ValidationError('markdown-file-empty-path', ...)` / `('markdown-file-escapes-worktree', ...)` / `('markdown-file-read-failed', ...)` 全删；老的 `tryReadInWorktreeMarkdownPath` 函数定义 + 调用点全删。新 `PortValidationError` 是 `ValidationError` 的子类，多带一个 structured `failure: { port, kind, subReason, detail }` 字段（其中 `subReason` 是扁平短码，不带 kind 前缀），runner catch 时把 `failure` 序列化进新列 `port_validation_failures_json`（见 §4.2）。一次 throw 一个 failure（**目前**——见 §7 多端口同时失败的设计说明）。

## 4. backend — scheduler.ts 决策扩展

### 4.1 `decideEnvelopeFollowup` 新分支

`packages/backend/src/services/scheduler.ts:337`（已有），改造为：

```ts
const PORT_VALIDATION_PREFIX = 'port-validation-'

export function decideEnvelopeFollowup(prev: PreviousAttemptShape): EnvelopeFollowupDecision {
  // 既有四前缀 + 三前置条件 — 保留
  // 新增：errorMessage 以 PORT_VALIDATION_PREFIX 开头 → reason='port-validation'
  //       并把 prev.portValidationFailures 直接透传（runner / scheduler 在写
  //       node_runs 失败时把 failures payload 也写进 prev 结构）。
  //
  // **kind 解码**：errorMessage 形如 `port-validation-<kind>-<sub>: <detail>`；
  // 这里只用外层 `port-validation-` prefix 命中追问决策。具体 <kind> 路由到哪个
  // handler 的 buildRepairBlock 由后续 composePerKindRepairBlocks 处理；这里
  // 不解析 <kind> 段，避免双解析。
  //
  // failures 字段是从 node_runs.port_validation_failures_json 新列读出来的
  // 结构化数据（含明确的 kind 字段），决策端不依赖 errorMessage 后半段 string-parse。
}
```

`PreviousAttemptShape` 新增可选 `portValidationFailures?: Array<KindFailure>` 字段；runner 在 `resolvePortContent` 失败时把 failures 写到 node_runs 失败上下文（实现位置：runner.ts 现有 `errorMessage` 落库前后），scheduler 决定追问时 SELECT 出来读。

**未知 kind 的 degraded 处理**：scheduler 解码 failures 时若发现某行 `kind` 不在 HANDLERS 表（例如老 task 落库时 RFC-049 还在 PR-A 阶段，落库的 kind 集合与现在不一致——理论上不会但兜底），composePerKindRepairBlocks 跳过该 failure + warn log，followup 仍照常发出，prompt 文案只是少一段 kind-specific 提示，不阻塞流程。

### 4.2 failures payload 落新列

migration 0026 加 nullable JSON 列 `node_runs.port_validation_failures_json`。schema 形如：

```json
[
  {
    "port": "docpath",
    "kind": "markdown_file",
    "subReason": "missing-file",
    "detail": "markdown_file 'report.md': ENOENT: no such file or directory"
  }
]
```

写入路径：runner 在 envelope.ts throw `PortValidationError` 后的 catch 块里 `JSON.stringify(err.failure)` 写新列；errorMessage 列保留人类可读短文案（`port-validation-markdown_file-missing-file: markdown_file 'report.md': ENOENT ...`，含 kind 命名空间），与现状一致。

读取路径：scheduler 决定追问时 SELECT `port_validation_failures_json`，`JSON.parse + zod safeParse` 还原 failures 数组；坏 JSON 兜底为 `[]` + warn 不 5xx（与 RFC-046 `parseInjectedSnapshotJson` 同模式）。老行（pre-migration / 非 port-validation 失败）该列 NULL → scheduler 透传给 `decideEnvelopeFollowup` 时拿不到 failures，只能靠 errorMessage prefix 命中决定要不要追问（degraded：能追问但 prompt 不知道具体哪个 port，followup 文案退化成"上一次有 port-validation 失败，请检查 outputKinds 端口"——可接受兜底）。

### 4.3 followup attempt 路径

scheduler 决定走 followup 后，调 runNode 时透传：

```ts
await runNode({
  // ... 既有字段
  envelopeFollowup: true,
  envelopeFollowupReason: 'port-validation',
  envelopeFollowupPortValidations: decoded.failures,
  // hasClarifyChannel / clarifyDirective 既有逻辑保留
})
```

runner 在 `renderEnvelopeFollowupPrompt` 入口前调 `composePerKindRepairBlocks(decoded.failures, opts.agent.outputKinds)` 把每 kind 的 repair 段预渲染成 `perKindRepairBlocks: readonly string[]`，再连同 `portValidationFailures` + `agentOutputKinds` 一起透传给 shared 侧。shared 侧只在顺序锚点上拼接字符串数组，不感知具体 kind 文案。

## 5. backend — runner.ts 改动

- `RunNodeOptions` 加 `envelopeFollowupPortValidations?: ReadonlyArray<KindFailure>`。
- followup 分支（runner.ts:478 附近的 `renderEnvelopeFollowupPrompt({...})`）调 `composePerKindRepairBlocks(envelopeFollowupPortValidations, opts.agent.outputKinds)` 拿 `perKindRepairBlocks`，再连同 `portValidationFailures` + `agentOutputKinds` 一起透传给 shared 渲染器。
- **首轮 prompt build 路径同步迁移**：`buildProtocolBlock(agent)` 改成调 `iterateHandlers(agent.outputKinds)`，对每个 distinct kind 调 `handler.buildPromptGuidance({ ports })`，把非 null 段拼到现有 protocol block 末尾。原 shared 里的 `buildMarkdownFilePortGuidance` 函数被 `markdownFile.ts` handler 的 `buildPromptGuidance` 实现替代，shared 侧函数移除（PR-A 范围）。
- envelope.ts 抛 `PortValidationError` 时，runner catch 块同步落库：`UPDATE node_runs SET port_validation_failures_json = ?, errorMessage = ? WHERE id = ?`。errorMessage 仍按现状写人类可读短文案（含 kind 命名空间前缀）。
- 不动 spawn / argv / inject 路径。

## 5.1 task.ts mapper

`rowToNodeRun`（task.ts）加一行：`portValidationFailures: parsePortValidationFailuresJson(row.portValidationFailuresJson)`。helper 复用 RFC-046 `parseInjectedSnapshotJson` 同模式（坏 JSON 返 null + warn）。NodeRunSchema 新字段对前端不可见——本 RFC 零前端代码改动；该字段只供 scheduler 内部消费。

## 6. 测试策略

### 6.1 shared

- `packages/shared/tests/envelope-followup-port-validation.test.ts`（新）— 6 case 覆盖 M1-M6 矩阵（不可达分支断言"perKindRepairBlocks 数组空时不出现 repair 段"），断言 shared 侧渲染只是把 `perKindRepairBlocks: readonly string[]` 按顺序锚点拼接。
- `packages/shared/tests/render-envelope-followup-with-perkind-blocks.test.ts`（新）— 5 case 单元测 `renderEnvelopeFollowupPrompt` + perKindRepairBlocks 入参：(a) 空数组不出现 repair 段；(b) 单段正确出现在 bi-modal 与 RFC-039 trailer 之间；(c) 多段按数组顺序串联 + 空行隔开；(d) reason='envelope-missing' 时即便 perKindRepairBlocks 非空也不渲染（互斥）；(e) RFC-039 strong-bias trailer 永远在最末（多 kind 段不会把它夹中间）。
- 既有 `envelope-followup-prompt.test.ts`（RFC-042 落地的 6 case + RFC-042-FU planned 3 case，如有）零退化。
- **grep 守卫**：shared/prompt.ts 必不再出现 `buildMarkdownFilePortGuidance` 函数定义（已搬进 backend handler）；必不再出现 "two-step protocol" 字面（kind-specific 文案不在 shared）。

### 6.2 backend — outputKinds handler + interface

- `tests/output-kinds-handler-interface.test.ts`（新）— 5 case：
  1. 三个 handler 都实现完整接口（kind / subReasons / buildPromptGuidance / validate / buildRepairBlock 全字段在场，且 buildPromptGuidance / buildRepairBlock 是函数）。
  2. `HANDLERS` 表三 key 完整（string / markdown / markdown_file）且与 AgentOutputKind 枚举一一对应。
  3. 模块加载期 subReasons 拍平唯一断言成功（无 throw）。
  4. **fake-handler 冒烟**——构造一个 fake `code_file` handler，用 vi.mock 临时注入 HANDLERS 表，断言 `iterateHandlers` + `composePerKindRepairBlocks` + `buildProtocolBlock`（首轮）三处主干无需改即可消费它；从 fake handler 抛出失败到 errorMessage 命名空间 `port-validation-code_file-<sub>` 正确生成。
  5. **subReason 命名空间冲突**——动态构造两个 handler 声明同名 `subReasons`，重新触发 `outputKinds/index.ts` 模块加载，断言 throw `subReason collision: <code> claimed by ...`。
- `tests/output-kinds-string.test.ts`（新）— 3 case（validate 任意输入都 ok / buildPromptGuidance 返 null / buildRepairBlock 返 null）。
- `tests/output-kinds-markdown.test.ts`（新）— 3 case（同上）。
- `tests/output-kinds-markdown-file.test.ts`（新）— 11 case：
  - validate：happy / empty-path / escapes-worktree / wrong-extension `.txt` / wrong-extension 无后缀 / missing-file / empty-file / .markdown 大小写不敏感正例（8 case）；
  - buildPromptGuidance：含两步协议短句 + 端口列表正确（1 case）；
  - buildRepairBlock：含 detail + 多端口保序（2 case）。

### 6.3 backend — envelope.ts prefix swap + forgiveness 删除

- 既有 `tests/envelope-resolve-port-md-path.test.ts` / `envelope-resolve-port-detailed.test.ts` / `envelope-parse-md-edge-cases.test.ts` — 改 errorCode 锚点到**命名空间形态** `port-validation-markdown_file-<sub>` + **forgiveness 自动读 .md 文件的 case 改写**为"raw 字符串透传"，或迁移到声明了 outputKinds 的等价 case。
- 新增 `tests/envelope-prefix-swap-source.test.ts`（源码层 grep 守卫）：envelope.ts 必出现 5 个新 `port-validation-markdown_file-` errCode 字面；必不再出现 `markdown-file-empty-path` / `markdown-file-escapes-worktree` / `markdown-file-read-failed` 旧字面；**必不再出现非命名空间的 `port-validation-empty-path` 等"裸 sub"形态**（防中间态遗留）；必不再含 `tryReadInWorktreeMarkdownPath` / `function tryReadInWorktreeMarkdownPath` 字面。
- 新增 `tests/envelope-undeclared-kind-raw-passthrough.test.ts` 2 case（kind 未声明 + .md 路径 → 返回 raw 字符串；kind 未声明 + 任意字符串 → 返回 raw 字符串），锁住 forgiveness 删除后的契约。

### 6.4 backend — migration 0026 + 新列读写

- `tests/migration-0026-port-validation-failures.test.ts`（新）— 3 case（列存在 / nullable / 老行 SELECT 出来是 NULL）。
- `tests/runner-writes-port-validation-failures-column.test.ts`（新）— 4 case（empty-path 失败时列写有效 JSON / wrong-extension 失败时列写有效 JSON / 成功 run 列保持 NULL / 老 node_run 行 NULL → mapper 不崩 + warn 不 5xx）。

### 6.5 backend — scheduler / runner / composePerKindRepairBlocks

- `tests/scheduler-port-validation-followup-decide.test.ts`（新）— 7 case：
  1. 5 种 subReason 各 1：errorMessage 以 `port-validation-markdown_file-<sub>:` 开头 + 三前置满足 + 新列含 failures → `{ kind: 'followup', reason: 'port-validation', failures: [...] }`。
  2. 任一 subReason + exitCode=137 → `{ kind: 'fresh-session' }`。
  3. 任一 subReason + opencodeSessionId=null → `{ kind: 'fresh-session' }`。
  4. errorMessage 不带前缀 → 不走本 RFC 路径（保留 RFC-042 逻辑）。
  5. 新列 NULL（老行）但 errorMessage 命中 → degraded 模式：还是走 followup，但 failures 列表为 []。
  6. 新列存的 JSON 坏掉 → 同 case 5 退化。
  7. `port-validation-<未知 kind>-<sub>:` 前缀命中 → 仍走 followup（依赖外层 prefix），composePerKindRepairBlocks 跳过未知 kind 段 + warn log（kind degraded 验证）。
- `tests/scheduler-port-validation-followup-branch.test.ts`（新）— 7 case 覆盖 5 类 subReason × followup pass + exitCode!=0 兜底 + followup-again-on-retry。
- `tests/compose-per-kind-repair-blocks.test.ts`（新）— 5 case：(a) 单 kind 单 failure → 数组长度 1 + 段含 markdown_file handler 自渲染的段头标记；(b) 单 kind 多 failure → 同段含多行；(c) 多 kind 失败（构造 fake handler 注入临时表）→ 数组按 first-occurrence 顺序 + 段间空行；(d) 未知 kind failure → 跳过 + warn log；(e) 空 failures → 数组长度 0。
- `tests/runner-port-validation-followup.test.ts`（新）— 4 case（promptText 含 port 名 / 含 sub-reason 短词 / 含两步协议短句（由 handler 渲染） + hasClarifyChannel=true 时 bi-modal 在前 RFC-039 在后 / 新列 SELECT 出来的 failures 正确透传到 composePerKindRepairBlocks 再到 renderEnvelopeFollowupPrompt）。

### 6.6 正交回归

跑全套现有 backend tests，断言以下不变：

- RFC-042 既有 8 + 4 + 4 + 2 + 1 + 2 测试零退化。
- RFC-005 review / RFC-014 sibling cascade / RFC-023 clarify / RFC-026 inline / RFC-040 wrapper / RFC-047 / RFC-048 既有套件零退化。

### 6.7 三件套 + CI

`bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions 六 jobs 全绿。

## 7. 失败模式（明确允许 / 不处理 / 多端口 fail-fast 说明）

- 模型在 followup 这一轮**再次**漏文件 → 算一次新的 port-validation 失败，按 retries 预算继续追问或降级（A5）。
- 模型在 followup 这一轮把 envelope 整个漏了 → 退化到 RFC-042 envelope-missing 追问（同 retries 预算，下一格仍可继续）。
- 模型在 followup 这一轮把端口路径改成另一个**也不存在**的路径 → 仍是 `missing-file` failure，追问继续，文案里 detail 会变化（新路径 + 新 err.message）。
- 路径合法但文件被**外部进程并发删除** → `missing-file`；追问要求模型重新落盘。
- worktree 被 `git worktree remove` 干掉 → realpath 越界 → `escapes-worktree`；追问通常救不回（worktree 没了），但 retries 耗完后正常 fail，task 走 cascade（与现状一致）。
- **多端口同时失败的设计**：今天 `resolvePortContentDetailed` 一次只处理一个 port、遇到首次失败就 throw。multi-port 同时不合规时，runner 只看到 first failure；followup 这一轮模型按追问把首个 port 补好后，下次 attempt 又会撞到第二个失败。也就是说 N 个 port 都坏需要 N 次 followup attempt（每次烧一格 retry）。**本 RFC 接受这个 cost**：(a) 多 port 同时失败是低频；(b) fail-fast 让追问文案保持简短聚焦；(c) 真要一次性 collect 所有 failures 需要把 envelope.ts 的 throw-then-collect 模型重构为 reduce-style，是大改，远超本 RFC 范围。后续若需要 batch failures，单独立 follow-up RFC。

## 8. 与 RFC-042 / RFC-042-FU planned 关系再表述

| RFC                                                          | 范围                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| RFC-042（Done）                                              | envelope 形态错 → 同 session 追问；默认 retries=3；引入 `renderEnvelopeFollowupPrompt` |
| RFC-042 Planned follow-up（proposal §F）                     | followup prompt 里同步 markdown_file 两步协议**提醒文案**——只动 prompt 文案那一面     |
| **RFC-049（本 RFC）**                                        | **把"端口内容校验失败"也纳入追问**——动决策（识别集合）、动校验层（per-kind validate）、动 prompt（per-port repair 段 + 矩阵正交叠加）|

RFC-042 Planned follow-up 的 G-F1/G-F2 verb 在新 handler 架构下落地形态变了：当 reason='envelope-missing' 且节点 outputKinds 含 markdown_file 时，runner 也可以选择性地调 `markdownFile` handler 的 `buildPromptGuidance` 把两步协议短句插进 followup prompt（envelope-missing 路径自己的渲染锚点上），handler 的同一份文案被 reason='port-validation' / reason='envelope-missing' 两条路径共用。没有重复字符串、没有抢位，新 kind 落地时 envelope-missing followup 也自然带上对应提示。RFC-042-FU 是否单独落 PR、还是被本 RFC PR 一起带掉，留 plan.md §PR 拆分讨论。
