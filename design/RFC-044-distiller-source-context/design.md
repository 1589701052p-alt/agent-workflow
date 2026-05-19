# RFC-044 — Distiller Source Context Enhancement · Technical Design

## 1. 影响面 + 文件清单

| 层 | 文件 | 改动 |
|---|---|---|
| shared schema | `packages/shared/src/schemas/config.ts` | 加 `memoryDistillSourceContext` 字段（可选对象，两个 byte 上限子字段） |
| backend service | `packages/backend/src/services/memoryDistiller.ts` | `LoadedSourceEvents` 扩展两字段；`loadSourceEvents` 新增对 `node_run_events` + 文件系统的读；`buildDistillerUserPrompt` 渲染两个新 block |
| backend service | `packages/backend/src/services/memoryDistillScheduler.ts` | 把 `config.memoryDistillSourceContext` 转 `SourceContextBudget` 透传给 `loadSourceEvents` |
| backend cli | `packages/backend/src/cli/start.ts` | scheduler init 时多传一个 `sourceContextBudget` |
| backend test | `packages/backend/tests/memory-distiller-source-context.test.ts` | 新文件，单元覆盖 loader + builder |
| backend test | `packages/backend/tests/memory-distiller.test.ts` | 已有文件追加 3 case：grep 守卫 + degraded fallback + budget 透传 |
| backend test | `packages/backend/tests/memoryDistillScheduler.test.ts` | 已有文件追加 1 case：配置透传至 loader |
| shared test | `packages/shared/tests/config.test.ts` | 校验 `memoryDistillSourceContext` 子字段边界（0、默认、上限） |

DB / migration / WS / frontend / e2e / workflow YAML / agent frontmatter：**零改动**。
distill 详情页（RFC-043）展示 `user_prompt_md`，本 RFC 改写它的内容但不改它的字段——
前端零代码改动即可看到加强后的 prompt。

## 2. Config 扩展

`packages/shared/src/schemas/config.ts`：

```ts
// --- RFC-044 distiller source context budget ---
/**
 * Per-source byte cap for the new transcript / body blocks injected into
 * the distiller user prompt. When the original content exceeds the cap,
 * the loader keeps the first 50% + last 50% with a `[truncated N bytes]`
 * marker in the middle. Set any field to 0 to disable that block (the
 * builder will fall back to the RFC-041 behaviour for that source).
 *
 * Defaults: 16384 / 16384. Max: 65536.
 */
memoryDistillSourceContext: z
  .object({
    clarifyTranscriptMaxBytes: z.number().int().min(0).max(65536),
    reviewBodyMaxBytes: z.number().int().min(0).max(65536),
  })
  .optional(),
```

`SourceContextBudget` 类型导出供 backend 使用：

```ts
export const DEFAULT_SOURCE_CONTEXT_BUDGET = {
  clarifyTranscriptMaxBytes: 16384,
  reviewBodyMaxBytes: 16384,
} as const
export type SourceContextBudget = {
  clarifyTranscriptMaxBytes: number
  reviewBodyMaxBytes: number
}
```

## 3. Loader 扩展

`memoryDistiller.ts::LoadedSourceEvents`：

```ts
export interface LoadedSourceEvents {
  clarify: Array<{
    id: string
    taskId: string
    nodeId: string
    questions: string
    answers: string
    // RFC-044: pre-rendered markdown dialog block (already byte-clipped)
    // or null when the source node_run is missing / produced no events
    // (legacy pre-RFC-027 rows).
    sourceTranscriptMd: string | null
    sourceTranscriptReason: string | null  // human-readable reason when md=null
  }>
  review: Array<{
    id: string
    taskId: string
    nodeId: string
    decision: string
    bodyPath: string
    comments: Array<{ body: string; anchorParagraphIdx: number; selectedText: string }>
    // RFC-044: file content of bodyPath (already byte-clipped) or null
    // when the file is unreadable (gc'd / path drift).
    reviewedBodyMd: string | null
    reviewedBodyReason: string | null
  }>
  feedback: Array<{ id: string; taskId: string; bodyMd: string; createdAt: number }>
}
```

`loadSourceEvents` 新签名：

```ts
export async function loadSourceEvents(
  db: DbClient,
  jobs: MemoryDistillJob[],
  budget: SourceContextBudget = DEFAULT_SOURCE_CONTEXT_BUDGET,
): Promise<LoadedSourceEvents>
```

实现要点：

1. **Clarify transcript 加载**（仅当 `budget.clarifyTranscriptMaxBytes > 0`）
   - 对每行 clarify row 取 `sourceAgentNodeRunId`。
   - 一次性 batch 拉所有 source run ids 对应的 events（`SELECT * FROM node_run_events
     WHERE node_run_id IN (...) ORDER BY ts ASC, id ASC`），按 nodeRunId 分桶。
   - 对每桶：
     - events.length === 0 → `sourceTranscriptMd=null`, reason=`"no events captured for source node_run"`
     - 否则：取该 node_run 的 `prompt_text` + `started_at`（同一 SELECT 多拿两列），
       调 `parseSessionTree({rootSessionId, promptText, startedAt, primaryAgentName, events})`
       得到 SessionTree。
     - 把 SessionTree 渲染成 markdown 对话（详见 §4）。
     - byte 超 budget 时走 head/tail clip（§5）。
   - 如对应 node_run 整行不存在（cascade 删 / FK 漂移）→ `sourceTranscriptMd=null`,
     reason=`"source node_run not found"`。

2. **Review body 加载**（仅当 `budget.reviewBodyMaxBytes > 0`）
   - 对每行 review row 解析 `bodyPath`（相对路径，base = `Paths.appHome`）。
   - `Bun.file(absPath).text()` 拿全文；失败 catch → `reviewedBodyMd=null`,
     reason=`"reviewed body unreadable: <err.message>"`。
   - 成功后 byte 超 budget → head/tail clip。

3. **budget=0 退化**：两字段直接置 null，reason=`"disabled by config"`。这条 reason 不渲染
   到 prompt（builder 在 budget=0 时整块跳过，详见 §6）。

## 4. SessionTree → Markdown 渲染

新 helper：

```ts
// shared/src/sessionView.ts 或 backend 局部
export function renderSessionTreeToDistillerMd(tree: SessionTree): string
```

输出格式（与 RFC-027 SessionTab UI 视觉等价，但用 markdown 严格化）：

```md
**User**:
<promptText>

**Assistant**:
<assistant text part 1>

**Tool** `bash`:
```
<tool_use input.command>
```

**Tool result** `bash`:
```
<tool_result output, head-only 2KB>
```

**Assistant**:
<assistant text part 2>
```

实现策略：复用 `tree.messages[]`（已经按 ts + parent 链整理），逐条 message map 成
markdown 节。tool_result 单条已经在 parseSessionTree 阶段 clip 过；这里不重复 clip——
整段 transcript 的总 budget 由 loader 在外层一次性 head/tail clip。

`primaryAgentName` 用 source agent 的 name（loader 多查一行 `agents.name`），方便 distiller
看到"这是 senior-engineer 的对话"做 scope 判断；查不到回退 `"agent"`（已有默认）。

## 5. Head + Tail clip 算法

```ts
function clipHeadTail(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.byteLength <= maxBytes) return s
  const half = Math.floor((maxBytes - 64) / 2)  // 64 reserves for marker line
  const head = buf.subarray(0, half).toString('utf8')
  const tail = buf.subarray(buf.byteLength - half).toString('utf8')
  const dropped = buf.byteLength - 2 * half
  return `${head}\n\n... [truncated ${dropped} bytes] ...\n\n${tail}`
}
```

注意 UTF-8 多字节切片可能切到字符中段，得到的 string 末/首字节会出现替换字符 U+FFFD。
对 distiller 模型解读基本无影响（中文 / emoji 在头尾各损失 1-2 字符）；如需严谨实现，
在切片后用 `TextDecoder({ fatal: false })` 显式 decode（Bun 默认即如此）。

## 6. Builder 扩展

`buildDistillerUserPrompt` 在 clarify 段补一节：

```diff
   for (const ev of input.events.clarify) {
     lines.push(`### clarify:${ev.id} (node ${ev.nodeId})`)
     lines.push('Questions:')
     lines.push(stringifyForPrompt(ev.questions))
     lines.push('Answers:')
     lines.push(stringifyForPrompt(ev.answers))
+    lines.push('Source agent transcript:')
+    if (ev.sourceTranscriptMd !== null) {
+      lines.push(ev.sourceTranscriptMd)
+    } else {
+      lines.push(`(source-agent transcript unavailable: ${ev.sourceTranscriptReason ?? 'unknown'})`)
+    }
     lines.push('')
   }
```

review 段同样补：

```diff
   for (const ev of input.events.review) {
     lines.push(`### review:${ev.id} (node ${ev.nodeId}, decision=${ev.decision})`)
-    lines.push(`(reviewed body lives at ${ev.bodyPath})`)
+    lines.push(`Source path: ${ev.bodyPath}`)
+    lines.push('Reviewed document body:')
+    if (ev.reviewedBodyMd !== null) {
+      lines.push('```markdown')
+      lines.push(ev.reviewedBodyMd)
+      lines.push('```')
+    } else {
+      lines.push(`(reviewed body unavailable: ${ev.reviewedBodyReason ?? 'unknown'})`)
+    }
     if (ev.comments.length > 0) {
       lines.push('Comments:')
       ...
     }
     lines.push('')
   }
```

当 budget=0：loader 已经把 `sourceTranscriptMd` / `reviewedBodyMd` 都置 null 且 reason 是
`"disabled by config"`，builder 此时整块跳过——具体策略：在 builder 起头判一次
`if (budget.clarifyTranscriptMaxBytes === 0 && budget.reviewBodyMaxBytes === 0)` 退化到
RFC-041 旧行为；mixed 情况下分别按 reason 渲染（仍写一行占位以保持 prompt 结构稳定）。

但更简洁的做法是让 builder 接 budget 参数：

```ts
export interface BuildDistillerPromptInput {
  events: LoadedSourceEvents
  scopeContexts: ScopeContext[]
  taskId: string | null
  sourceContextBudget: SourceContextBudget
}
```

builder 在 clarify / review 段开头判 `budget.clarifyTranscriptMaxBytes > 0` / `> 0`
决定是否输出新 block。`disabled by config` 不暴露给 prompt——降噪。

## 7. Scheduler 透传

`memoryDistillScheduler.ts`：

```ts
// 已有 config.memoryDistillModel / memoryDistillerEnabled 透传路径
const sourceContextBudget =
  config.memoryDistillSourceContext ?? DEFAULT_SOURCE_CONTEXT_BUDGET

// 在 runDistill / runDistillBatch 调 loadSourceEvents 处多传一参数
const events = await loadSourceEvents(db, jobs, sourceContextBudget)
const prompt = buildDistillerUserPrompt({
  events,
  scopeContexts,
  taskId: ...,
  sourceContextBudget,
})
```

`start.ts` 在 scheduler init 时把 config 直接传入（既有路径已经传 `config` 整对象到
scheduler，加一行读取即可）。

## 8. SessionTree Render — primaryAgentName 解析

loader 需要 source agent 的 name。两条路：

1. 从 source node_run → 取 `agent_id`（已存在列） → 查 agents 表。
2. 偷懒：用 node_run.agent_name 列（如果有）。

查 schema：
- `node_runs` 表已有 `agent_id` 列（RFC-002 加的），但**没有** `agent_name`——名字得 join
  `agents` 表拿。

实现：在 loader 的 clarify 加载里一次性 batch SELECT `agents.id, agents.name WHERE id IN
(...)`，map 进每条 clarify event 的 transcript 渲染入参。查不到回退 `"agent"`。

## 9. 测试策略（详细）

### 9.1 `memory-distiller-source-context.test.ts` 新文件

| case | 验证点 |
|---|---|
| loadSourceEvents-clarify-transcript-loaded | 准备一个 clarify_session + 对应 node_run + 3 条 events，断言返回的 sourceTranscriptMd 非空且含 "**User**" / "**Assistant**" 字面 |
| loadSourceEvents-clarify-source-run-missing | clarify_session 存在但 sourceAgentNodeRunId 指向不存在的 node_run → sourceTranscriptMd=null, reason 含 "not found" |
| loadSourceEvents-clarify-events-empty | source node_run 存在但 events 表无对应行 → sourceTranscriptMd=null, reason 含 "no events" |
| loadSourceEvents-clarify-transcript-clipped | 构造长度 32KB 的 transcript + budget=16KB → 输出含 "[truncated " marker，长度 ≤ 16KB + 100 byte 余量 |
| loadSourceEvents-review-body-loaded | 准备 docVersions + 真文件 → reviewedBodyMd 含文件内容 |
| loadSourceEvents-review-body-missing-file | bodyPath 文件不存在 → reviewedBodyMd=null, reason 含 "unreadable" |
| loadSourceEvents-review-body-clipped | 32KB 文件 + budget=8KB → 输出含 "[truncated " marker |
| loadSourceEvents-budget-zero-disables | budget.clarifyTranscriptMaxBytes=0 → sourceTranscriptMd=null, reason="disabled by config" |
| buildDistillerUserPrompt-emits-transcript-section | 含一条 clarify event with sourceTranscriptMd 非空 → 输出含 "Source agent transcript:" + transcript |
| buildDistillerUserPrompt-emits-body-section | 含一条 review event with reviewedBodyMd 非空 → 输出含 "Reviewed document body:" + fenced markdown |
| buildDistillerUserPrompt-degraded-shows-placeholder | sourceTranscriptMd=null + reason → 输出含 "(source-agent transcript unavailable: ...)" |
| buildDistillerUserPrompt-budget-zero-skips-block | budget.clarifyTranscriptMaxBytes=0 → 输出**不**含 "Source agent transcript:" literal |

### 9.2 既有文件追加

`memory-distiller.test.ts`：
- grep 守卫：源码层断言 `memoryDistiller.ts` 含 `Source agent transcript:` + `Reviewed
  document body:` 两条 literal。
- 全量集成：跑一个完整 distill mock，断言生成的 user prompt 含两段且 distillation
  仍能产出 candidate。

`memoryDistillScheduler.test.ts`：
- 透传：传入自定义 config.memoryDistillSourceContext → spy `loadSourceEvents` 收到
  匹配的 budget 对象。

`shared/tests/config.test.ts`：
- schema 校验：合法 / min=0 / max=65536 / 越界 → zod 报错。

## 10. 失败模式 + 边界

| 场景 | 行为 |
|---|---|
| source node_run 已 cascade 删 | 占位 + reason |
| events 表为空（pre-RFC-027 数据） | 占位 + reason |
| docVersions.bodyPath 文件被 worktree GC | 占位 + reason，distill 继续 |
| body 是 binary（误入） | `Bun.file().text()` 返非法 utf-8 → reason 含 "decode failed"，置 null |
| budget=0 同时设两个 | builder 完全退化到 RFC-041 行为，回归测试不退化 |
| budget 超 65536 | zod schema 拒绝，settings PUT 返 422 |
| 单 distill job 含 100 clarify event | 在 5s debounce 内基本不会触发；最坏 100 × 16KB = 1.6MB prompt，opencode stdin 上限远大于此（OS pipe 通常 64KB-1MB，spawn 用 piped stdin 不走管道阈值）。仍加 sanity log `prompt-bytes` 便于观察 |
| distiller model 上下文超限 | 不在本 RFC 范围——属于 model 选型，由 admin 在 `memoryDistillModel` 配置上下文足够长的型号 |

## 11. 不破坏的既有契约

- `LoadedSourceEvents` 新字段都是可选 + null 友好——下游 `buildDistillerUserPrompt`
  既有调用对未填字段安全降级（既有 caller 一处，本 RFC 同步改）。
- `buildDistillerUserPrompt` 改签名加 `sourceContextBudget`，既有 caller 一处（`runDistill`），
  本 RFC 同步改；测试已覆盖。
- distill 详情页 `user_prompt_md` 列展示加强后的字符串——RFC-043 详情页 UI 无需改。

## 12. Roll-out

- 单 PR：`feat(memory): RFC-044 distiller source context (clarify transcript + review body)`。
- 全量绿后合入 main。
- 上线后观察 daemon log 中 `prompt-bytes` 指标 + distill 详情页人工 spot check。
- 关闭开关：把 `memoryDistillSourceContext.{clarifyTranscriptMaxBytes,
  reviewBodyMaxBytes}` 都设 0 → 行为退化到 RFC-041，无需 rollback PR。
