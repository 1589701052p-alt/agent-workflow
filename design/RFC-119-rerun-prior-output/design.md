# RFC-119 技术设计

## 1. 现状勘察结论（file:line）

### 1.1 提示词拼装
- 主函数 `renderUserPrompt(input: RenderPromptInput): string` —— `packages/shared/src/prompt.ts:312`。段落顺序：
  1. body（模板 `{{token}}` 替换，`prompt.ts:337`）
  2. 输入 auto-append（未被模板引用的端口 `## <port>`，`prompt.ts:390`；inlineMode 跳过）
  3. review（rc）段落 `prompt.ts:410-440`
  4. clarify（cc）段落 `prompt.ts:453-473`
  5. cross-clarify（xcc）段落 `prompt.ts:487-507`：`## Prior Output (to be updated)` → `## External Feedback` → `## Update Directive`
  6. trailing 协议块 `prompt.ts:526-534`（clarify-only 或 `<workflow-output>` 协议）
- `inlineMode = cc?.mode === 'inline'`（`prompt.ts:335`）—— 同会话续跑标志。
- followup（同会话错误修复重试）走**另一条**函数 `renderEnvelopeFollowupPrompt`（`prompt.ts:798`），**不经** `renderUserPrompt`、不带输入/输出——因为会话里已有；runner 在 `opts.envelopeFollowup === true` 时选它（`runner.ts:735`）。

### 1.2 cross-clarify 现有「prior output」机制（要复用 / 推广的模板）
- 共享原语 `buildPriorOutputBlock(outputs: {portName, content}[]): string` —— `packages/shared/src/clarify.ts:564`。逐条渲染 `### <portName>\n\n<content>`，丢弃空内容，**保留调用方顺序**。这是通用件（虽放在 clarify.ts）。
- 严格指令文案 `CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT` —— `clarify.ts:407`（含「Do NOT regenerate the output from scratch」）。标题常量 `clarify.ts:403-404`。
- 渲染：`prompt.ts:487-507`，仅当 `crossClarifyContext.priorOutputBlock` 非空时 emit 两段。
- scheduler 计算：`scheduler.ts:2340-2357`，门控 `isCrossClarifyTriggeredRerun && priorDoneDesigner !== undefined && crossClarifyContext !== undefined`。其中 `isCrossClarifyTriggeredRerun = hasExternalFeedbackChannel && clarifyGeneration > 0`（`scheduler.ts:2246`）；`priorDoneDesigner = pickFreshestRun(priorDoneGenerations, …)`（`scheduler.ts:2253`）；产物读取 `scheduler.ts:2345-2356`（`select node_run_outputs where nodeRunId = priorDone.id` → `byPort` → 按 `agent.outputs` 排序 → `buildPriorOutputBlock`）。

### 1.3 重跑路径与「上次产物」可得性
- 所有重跑都 **mint 新 node_run 行**，旧行保留；产物表 `node_run_outputs`(`nodeRunId, portName, content, kind`, PK=(nodeRunId,portName))，**仅在 run `status==='done'` 时写入**（`runner.ts` 落库），重试用 `onConflictDoUpdate`。
- **评审 reject/iterate**（`review.ts:1746-1777`）：旧 done run 经 `setNodeRunStatus(to:'canceled', allowedFrom:[…,'done'], reason: REVIEW_SUPERSEDE_MARKER_PREFIX…)` 置 **canceled**；mint 新行 `cause:'review-iterate'|'review-reject'`、`iteration: latest.iteration`（**同 iteration**）、`preSnapshot: latest.preSnapshot`。**旧行的 `node_run_outputs` 不删**。
- **手动重试**（`task.ts:1970-1979`）：mint 新行 `cause:'retry-node'`(目标)/`'retry-node-cascade'`(下游)、`iteration: inherit?.iteration ?? 0`（目标=同 iteration）、`inheritFrom`；**不删旧行 / 不删旧 outputs**；旧 done 行**保持 done**。
- **反问**（`clarify.ts`）：mint 重跑行 `cause:'clarify-answer'`、同 iteration；旧 done 行保持 done。
- **恢复 / 级联**：同样 mint 新行、同 iteration。
- 已有 done-only 选择器 `priorDoneGenerationsForRun`（`scheduler.ts:4788`）：返回「同 (taskId,nodeId,iteration,shardKey)、`status='done'`、`parentNodeRunId=null`、`id < 当前`」的行。**注释明确「`done`（非 canceled）以免 review-iterate supersede 标记灌水 generation 计数」**——所以**它服务 `clarifyGeneration` 计数，必须保持 done-only，本 RFC 绝不改它**。
- 关键推论：**评审重跑时旧产物 run 已是 `canceled`** → done-only 的 `priorDoneGenerationsForRun` 取不到 → 必须用一个「**任何状态、只要有 node_run_outputs 行**」的更广查找。

## 2. 设计总览

把「重跑回灌上次输出」做成**与具体 cause 无关**的单一注入点，挂在 agent 节点派发处：

> 只要本节点存在「同 (iteration, shardKey)、id 早于本次、top-level（parentNodeRunId=null）、且有 `node_run_outputs` 行」的更早 run，就取**最新的**那条、渲染其产物为 `## Prior Output (to update or regenerate)` + 中性 `## Update Directive`，注入新进程 prompt。

为何 cause-agnostic 成立（见 §1.3）：所有重跑都在**同一 iteration**内 mint 新行，而循环的下一迭代是 iteration+1。所以「同 iteration 内存在更早的、产出过的 run」精确等价于「这是一次重跑且上次产出过」。它天然：
- 覆盖反问 / 评审 / 重试 / 级联 / 恢复（都同 iteration、都有更早 done 产物）；
- 排除首次运行（无更早行）；
- 排除循环下一迭代（更早产物在 iteration-1，被 iteration 过滤掉）；
- 排除 failed run（无 outputs）。

## 3. 接口契约

### 3.1 共享层新增常量（`packages/shared/src/clarify.ts`，与 RFC-056 原语同处）

```ts
/** RFC-119: heading for the generalized rerun prior-output section. Distinct
 *  from the RFC-056 cross-clarify heading so the two contracts never alias. */
export const RERUN_PRIOR_OUTPUT_BLOCK_TITLE = '## Prior Output (to update or regenerate)' as const

/** RFC-119: neutral directive for non-cross-clarify reruns. Honors the user's
 *  「更新或重新生成」: bias toward incremental update, allow full regenerate when
 *  the feedback is fundamental, and demand the COMPLETE output (not a diff). */
export const RERUN_UPDATE_DIRECTIVE_TEXT = [
  'The "Prior Output" section above is what you produced on your previous run of',
  'this node. This run exists because that output needs to change — see the',
  'feedback in the sections above (review decision, clarification answers, or a',
  'manual retry). Update the prior output to address that feedback, preserving the',
  'parts it does not contradict; regenerate it from scratch only if the feedback',
  'requires fundamental changes. Either way you MUST emit the COMPLETE updated',
  'output in the workflow-output envelope — never a diff or a description of',
  'changes alone.',
].join(' ')
```

（标题 `## Update Directive` 与 cross-clarify 复用同一字面量——它是通用标题，且两路径互斥，不会同现。）

### 3.2 共享层 `RenderPromptInput` 加字段（`packages/shared/src/prompt.ts`）

```ts
export interface PriorOutputUpdateContext {
  /** Pre-rendered prior-output markdown (via buildPriorOutputBlock). Empty /
   *  undefined ⇒ suppress both sections. */
  block?: string
}

export interface RenderPromptInput {
  // …既有字段不变…
  /** RFC-119: generalized prior-output context for NON-cross-clarify reruns
   *  (review reject/iterate, manual retry, cascade, resume, self-clarify).
   *  Mutually exclusive with crossClarifyContext.priorOutputBlock — the
   *  scheduler sets at most one. */
  priorOutputUpdate?: PriorOutputUpdateContext
}
```

### 3.3 渲染逻辑（`prompt.ts`，插在 xcc 段落之后、trailing 之前 ~line 508）

```ts
// RFC-119: generalized rerun prior-output. Emits ONLY when:
//   - priorOutputUpdate.block is non-empty, AND
//   - cross-clarify is NOT already owning the prior-output block (xcc path),
//   - NOT an inline session resume (the session already holds the output),
//   - NOT mandatory ask-back (clarify-only protocol — "update your output"
//     would contradict "you must ask back, don't output").
const pou = input.priorOutputUpdate
if (
  pou?.block !== undefined &&
  pou.block.trim().length > 0 &&
  !(xcc?.priorOutputBlock !== undefined && xcc.priorOutputBlock.trim().length > 0) &&
  !inlineMode &&
  input.hasClarifyChannel !== true
) {
  sections += `\n\n${RERUN_PRIOR_OUTPUT_BLOCK_TITLE}\n${pou.block}`
  sections += `\n\n## Update Directive\n${RERUN_UPDATE_DIRECTIVE_TEXT}`
}
```

段落顺序：review/clarify 反馈在前（§1.1 第 3/4 步），prior output + 指令紧随其后、trailing 之前——读起来是「这是反馈 → 这是你上次做的 → 现在更新/重做」。

### 3.4 后端共享 helper（`scheduler.ts`，抽出避免 fork）

```ts
/** RFC-119/RFC-056: read a prior run's captured port outputs and render them
 *  in the agent's declared-output order via buildPriorOutputBlock. Shared by
 *  the cross-clarify update-mode path AND the generalized rerun path. */
async function composePriorOutputBlock(
  db: DbClient, priorRunId: string, agentOutputs: readonly string[],
): Promise<string> {
  const captured = await db.select().from(nodeRunOutputs)
    .where(eq(nodeRunOutputs.nodeRunId, priorRunId))
  const byPort = new Map(captured.map((r) => [r.portName, r.content]))
  const ordered = (agentOutputs ?? [])
    .map((p) => ({ portName: p, content: byPort.get(p) ?? '' }))
    .filter((o) => o.content.length > 0)
  return buildPriorOutputBlock(ordered)
}

/** RFC-119: freshest prior TOP-LEVEL run of this node at the SAME
 *  (iteration, shardKey), minted before this run (id < current), that captured
 *  ≥1 output row — REGARDLESS of final status. Unlike priorDoneGenerationsForRun
 *  (done-only, for clarifyGeneration counting) this MUST see review-supersede
 *  'canceled' rows, which keep their node_run_outputs. */
async function freshestPriorRunWithOutput(
  db: DbClient,
  run: { taskId: string; nodeId: string; iteration: number; shardKey: string | null; id: string },
): Promise<typeof nodeRuns.$inferSelect | undefined> {
  const rows = await db.select().from(nodeRuns).where(and(
    eq(nodeRuns.taskId, run.taskId),
    eq(nodeRuns.nodeId, run.nodeId),
    eq(nodeRuns.iteration, run.iteration),
  ))
  const candidates = rows
    .filter((r) => (r.shardKey ?? null) === (run.shardKey ?? null)
      && r.parentNodeRunId === null && r.id < run.id)
    .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)) // id desc (freshest first)
  for (const c of candidates) {
    const has = await db.select({ p: nodeRunOutputs.portName }).from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, c.id)).limit(1)
    if (has.length > 0) return c
  }
  return undefined
}
```

候选集很小（一个节点本轮的几次尝试），N 次 limit-1 查询可忽略；通常最新一条即命中。

### 3.5 cross-clarify 重构（byte-identical）

把 `scheduler.ts:2345-2356` 的内联逻辑替换为调用 `composePriorOutputBlock`：

```ts
// before: const captured = …; const byPort = …; const ordered = …; const priorOutputBlock = buildPriorOutputBlock(ordered)
const priorOutputBlock = await composePriorOutputBlock(db, priorDoneDesigner.id, agent.outputs ?? [])
if (priorOutputBlock.length > 0) crossClarifyContext.priorOutputBlock = priorOutputBlock
```

输出逐字相同（helper 即原逻辑），cross-clarify 测试不动。

### 3.6 泛化路径计算（`scheduler.ts`，在 `effectiveHasClarifyChannel` 已知之后）

```ts
// RFC-119: generalized prior-output for NON-cross-clarify reruns. Skip when:
//   - cross-clarify already owns it (isCrossClarifyTriggeredRerun),
//   - inline session resume (session holds the output),
//   - mandatory ask-back active (clarify-only protocol this round).
let priorOutputUpdate: PriorOutputUpdateContext | undefined
if (
  currentRunRow !== undefined &&
  !isCrossClarifyTriggeredRerun &&
  !resumeDecision.inlineMode &&
  !effectiveHasClarifyChannel
) {
  const priorRun = await freshestPriorRunWithOutput(db, {
    taskId, nodeId: node.id, iteration: currentRunRow.iteration,
    shardKey: currentShardKey, id: currentRunRow.id,
  })
  if (priorRun !== undefined) {
    const block = await composePriorOutputBlock(db, priorRun.id, agent.outputs ?? [])
    if (block.length > 0) priorOutputUpdate = { block }
  }
}
```

并在 `runNode({...})` 调用（`scheduler.ts` ~2425）追加 `...(priorOutputUpdate !== undefined ? { priorOutputUpdate } : {})`。

### 3.7 runner 透传（`runner.ts`）

- `RunNodeOptions` 加可选 `priorOutputUpdate?: PriorOutputUpdateContext`。
- 非 followup 分支的 `renderUserPrompt({...})`（`runner.ts:747`）追加 `...(opts.priorOutputUpdate !== undefined ? { priorOutputUpdate: opts.priorOutputUpdate } : {})`。followup 分支不传（天然不注入，符合 D5）。

## 4. 决策

- **D1 cause-agnostic 单注入点**：以「同 iteration 内存在更早 done-产出的 top-level run」为信号，而非逐 cause 特判。覆盖全部重跑原因（用户决策），天然排除首次/循环下一迭代。
- **D2 放宽查找到「任何状态、有 outputs」**：新建 `freshestPriorRunWithOutput`；**不改** `priorDoneGenerationsForRun`（done-only 服务 clarifyGeneration 计数，是 load-bearing 不变式）。理由：评审 supersede 把旧 done 置 canceled，done-only 取不到。
- **D3 抽 `composePriorOutputBlock`、复用 `buildPriorOutputBlock`**：cross-clarify 与泛化路径共用同一渲染件，cross-clarify 输出 byte-identical。遵守「抽一次别 fork」。
- **D4 中性指令 + 保留 cross-clarify 严格指令**：新路径用 `RERUN_UPDATE_DIRECTIVE_TEXT`（贴合用户「更新或重新生成」、要求吐完整结果）；cross-clarify 保留 `CROSS_CLARIFY_UPDATE_DIRECTIVE_TEXT`（「Do NOT regenerate」，RFC-056 有意、已测）。两路径**互斥**（prompt 层 `xcc.priorOutputBlock` 占用时不重复 + scheduler 层 `!isCrossClarifyTriggeredRerun`）。
- **D5 同会话续跑不注入**：envelope-followup 天然走 `renderEnvelopeFollowupPrompt`；inline clarify resume 由 `resumeDecision.inlineMode`（scheduler）+ `inlineMode`（prompt）双门控。会话里已有上次输出，重灌浪费 token 且诱发陈旧锚定。
- **D6 强制反问态不注入**：`effectiveHasClarifyChannel=true` 时协议块是 clarify-only、要求 agent 反问，注入「更新你的输出」自相矛盾。scheduler + prompt 双门控（纯防御——该组合正常流几乎不可能：产出 output 需 'stop' 轮，'stop' 后 effectiveHasClarifyChannel 即 false）。
- **D7 始终开启、无开关**（用户决策）：前提不满足时自然不注入。
- **D8 文件型端口逐字渲染存储内容（路径）**：与 cross-clarify 一致。iterate 通常不回滚→文件在→agent 读路径增量改；reject 若回滚→文件没→中性指令「重新生成」臂兜底。**已知边界**：reject+回滚+文件型端口时 prior output 指向已删文件——文档化，v2 可选「文件存在时内联正文」增强（best-effort，经 RFC-049/107 既有 worktree 内安全读取）。
- **D9 不覆盖多进程 shard 子运行**：查找限 `parentNodeRunId=null`；shard 从各自 diff 切片重导。

## 5. 失败模式 / 边界

| 场景 | 行为 |
|---|---|
| 首次运行（无更早 run） | `freshestPriorRunWithOutput` 返回 undefined → 不注入 ✓ |
| 循环下一迭代 | 更早产物在 iteration-1，被 iteration 过滤 → 不注入 ✓ |
| 上次 run failed（无 outputs） | 无 node_run_outputs 行 → 跳过该候选 ✓ |
| 上次产出全端口空 | `composePriorOutputBlock` 返回 '' → 不注入 ✓ |
| 评审 supersede（旧 done→canceled） | `freshestPriorRunWithOutput` 含 canceled、命中 ✓（done-only 取不到，故 D2） |
| 连续重试（done→failed→retry） | 跳过无 outputs 的 failed，回退到更早 done-产出行 ✓ |
| cross-clarify 设计者重跑 | 走 xcc 原路径、严格指令、byte-identical；泛化路径被 `!isCrossClarifyTriggeredRerun` 跳过 ✓ |
| inline clarify 续跑 | 双门控跳过 ✓ |
| envelope-followup | 走 `renderEnvelopeFollowupPrompt`，不经此路径 ✓ |
| 强制反问轮 | `effectiveHasClarifyChannel` 门控跳过 ✓ |
| reject+回滚+文件端口 | 渲染存储的（现已失效）路径；中性指令「重新生成」兜底（D8 已知边界） |
| 多进程 shard 子 run | `parentNodeRunId≠null` 被过滤 → 不注入（D9） |

## 6. 测试策略（每条都必写）

### 6.1 shared 纯函数（`packages/shared/tests/rerun-prior-output.test.ts`）
- 常量锁：`RERUN_PRIOR_OUTPUT_BLOCK_TITLE === '## Prior Output (to update or regenerate)'`；`RERUN_UPDATE_DIRECTIVE_TEXT` 含 'update' 且含 'regenerate' 且含 'complete'（区别于 cross-clarify 的 'not regenerate'，防被误改成同一文案）。
- `renderUserPrompt` + `priorOutputUpdate.block` 非空 → 含两段、顺序（prior output 在 review/clarify 反馈之后、trailing 之前）。
- `priorOutputUpdate.block` 空/undefined → 不含两段。
- **互斥**：同时给 `crossClarifyContext.priorOutputBlock` 与 `priorOutputUpdate.block` → 只 emit cross-clarify 的 `## Prior Output (to be updated)`，**不** emit 泛化的 `(to update or regenerate)`、不重复。
- **inlineMode**（`clarifyContext.mode='inline'`）+ `priorOutputUpdate` → 不 emit。
- **强制反问**（`hasClarifyChannel:true`）+ `priorOutputUpdate` → 不 emit。
- 与 review/clarify 段落共存：含 `## Review Comments` 同时含泛化 prior output，顺序正确。

### 6.2 cross-clarify 回归（既有，必须全绿）
- `packages/shared/tests/cross-clarify-update-mode.test.ts`、`packages/backend/tests/cross-clarify-update-mode-injection.test.ts` 等 **逐字不变通过**（验证 D3 重构 byte-identical）。

### 6.3 backend 选择器 + 注入（`packages/backend/tests/rerun-prior-output-injection.test.ts`，照 `cross-clarify-update-mode-injection.test.ts` 用内存 DB）
- `freshestPriorRunWithOutput`：done-prior 命中；canceled-prior（review supersede）命中；无 prior→undefined；不同 iteration 的 prior 不命中；shardKey 隔离；failed(无 outputs) 跳过、回退到更早 done；`parentNodeRunId≠null`(shard) 不命中。
- `composePriorOutputBlock`：按 `agent.outputs` 顺序、丢空端口、空集→''。
- 端到端（构造评审 supersede 行 + 新 pending 行 → 跑到该 agent 的 prompt 渲染）：prompt 含泛化 prior output（取自 canceled 旧行的 outputs）。

### 6.4 源码文本回归（巨型 scheduler 兜底，照本仓惯例）
- 断言 `scheduler.ts` 含 `freshestPriorRunWithOutput` 且泛化计算门控含 `!isCrossClarifyTriggeredRerun`、`!resumeDecision.inlineMode`、`!effectiveHasClarifyChannel`（防有人删门控导致 cross-clarify 双注入 / 续跑误注入回归）。
- 断言 `priorDoneGenerationsForRun` 仍 `status='done'`（防有人「顺手」放宽它破坏 clarifyGeneration 计数）。

## 7. 运行门槛
`bun run typecheck && bun run test && bun run format:check` 全绿；二进制 build smoke 无模块环；推后查 GitHub Actions（按 [feedback_post_commit_ci_check]）。Codex 设计 gate（本文档）+ 实现 gate（改完）各跑一次、findings 全 fold（按 [feedback_codex_review_after_changes]）。
