# RFC-014 Design — Iterate 多文档同步重生 + `__sibling_outputs__` Prompt 注入

> 状态：Draft（2026-05-16）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 修订基线：[RFC-005 design.md](../RFC-005-human-review/design.md) §5.2 / §7.2 / §9 / §11

## 1. 影响面总览

| 模块 | 文件 | 改动性质 |
| --- | --- | --- |
| 共享 prompt 引擎 | `packages/shared/src/prompt.ts` | 新增 builtin token + `ReviewPromptContext.siblingOutputs` 字段 + 默认 auto-append 段 |
| 共享 agent schema | `packages/shared/src/schemas/agent.ts` | `AgentSchema` / `CreateAgentSchema` / `UpdateAgentSchema` 新增 `syncOutputsOnIterate: z.boolean()`（默认 true） |
| 评审决策与重跑 | `packages/backend/src/services/review.ts` | iterate 分支合并策略反转 + sibling cascade 接入 iterate + 上游多 markdown 探测 + agent 开关读取 + sibling content 拉取 |
| 调度 / 资源准备 | `packages/backend/src/services/scheduler.ts` | `runOneNode` 在重跑前的 ReviewPromptContext 构造接 sibling outputs |
| 共享类型 | `packages/shared/src/review.ts` (或 `prompt.ts` 同处) | `ReviewPromptContext` 增字段；`SiblingOutput` 形态导出；`isMultiMarkdownUpstream` 接受 agent 开关参数 |
| Agent CRUD / 持久化 | `packages/backend/src/services/agents.ts` + `db/schema.ts` | drizzle migration 0004（或后续编号）`agents` 表新增 `sync_outputs_on_iterate INTEGER NOT NULL DEFAULT 1`；service 读写 + frontmatter 序列化 |
| Agent frontmatter 解析 | `packages/backend/src/services/agent-frontmatter.ts`（或同等位置）| 解析 / 序列化 `syncOutputsOnIterate` 字段；YAML 导入未指定 → 默认 true |
| 前端 Agent 表单 | `packages/frontend/src/routes/agents.*.tsx` + form 组件 | Add / Edit Agent 表单新增 toggle「Iterate 决策时同步刷新所有输出文档」 + helper 文案说明双重守卫 |
| 前端 inspector preview | `packages/frontend/src/components/NodeInspector.tsx` | prompt 预览支持 `__sibling_outputs__` token 替换占位 |
| 前端评审详情 | `packages/frontend/src/routes/reviews.detail.tsx` | iterate 决策后 toast：N 条兄弟评审已被同步打回 |
| 评审列表/历史 | `packages/frontend/src/routes/reviews.tsx` + `routes/reviews.detail.tsx` | v(n+1) 行显示"因 cascade 重生"标记（基于 `doc_versions.cascadeSourceReviewId`） |
| schema / migration | drizzle migration 0004 | **agents 表新加 1 列**；老行 backfill `1`；workflow / doc_versions / node_runs 零变动 |

## 2. 触发条件判定（"agent 开关 + 多 markdown 上游"双重守卫）

`isMultiMarkdownUpstream(args)` 纯函数，位于 `packages/shared/src/review.ts`：

- 输入：`{ outputs: AgentOutputDef[], syncOutputsOnIterate: boolean }`
- 输出：`{ trigger: boolean, markdownPorts: string[] }`。
- 规则（AND）：
  1. `syncOutputsOnIterate === true`；否则直接 `trigger=false`、`markdownPorts=[]`，调用方走 RFC-005 老路径。
  2. 过滤 `kind ∈ { 'markdown', 'markdown_file' }`（**省略 kind = 默认 'string'**，按 RFC-005 §3 既有语义）；`markdownPorts.length >= 2` 时 `trigger=true`。

**双守卫的产品意图**：开关是 agent 作者的"是否声明输出耦合"的意图层；markdown 数量是技术层"实际有可同步的兄弟"的事实层。两者缺一 → 退化到 RFC-005 现行 iterate。

**为什么是上游节点的 outputs 而不是 review 节点的输入端**：review 节点是叶子，单输入端只锚一个 port；"多 markdown 输出"是上游 agent 节点的拓扑属性，不是 review 节点本身的。三个 review 节点接在同一个 agent 的三个不同 port 上是 RFC-005 S4 的典型形态。

判定时机：`submitReviewDecision({ decision: 'iterated' })` 内部，拿到 target 的 `sourceNodeId`（即上游 agent 节点的 workflow node id）→ 从 workflow definition snapshot 取上游节点引用的 agent name → 从 `agents` 表（或 `tasks.agentSnapshots` 如有）取 `syncOutputsOnIterate` + `outputs`。

**agent 快照策略**：当前 `tasks` 表不存 agent 快照（agent 在跑中可被改）。本 RFC 选 **dispatch-time 读最新 agent**——iterate 触发时按当时的 agent 配置生效，而不是按 task launch 时的快照。原因：(1) 用户改 agent 配置的预期就是"下一轮决策按新配置走"；(2) 不引入 agent 快照表能避免一个跨 RFC 的大改动。<br>反向风险：用户在 review 决策**未提交时**改 agent toggle，会改变当前评审的级联面——需要 `submitReviewDecision` 在事务首部读一次 agent 行，整次决策固定一份 snapshot，避免事务中途竞态。

## 3. `__sibling_outputs__` 渲染契约

### 3.1 共享端字段

`packages/shared/src/prompt.ts`：

```ts
export interface ReviewPromptContext {
  rejection?: string
  comments?: string
  iterateTargetPort?: string
  /**
   * RFC-014: pre-rendered markdown listing the other markdown[_file] outputs
   * of the same upstream node. Only set on iterate path when the upstream
   * declares ≥ 2 markdown[_file] outputs. Already includes the leading
   * English consistency instruction line.
   */
  siblingOutputs?: string
}
```

`BUILTIN_VARS` 新增 `'__sibling_outputs__'`。`renderUserPrompt` switch 加一 case，未引用且非空时 auto-append `\n\n## Sibling Outputs\n${rc.siblingOutputs}`（与现有 review_comments / review_rejection 风格一致）。

### 3.2 后端渲染源

`services/review.ts` 新增 `buildSiblingOutputsBlock(args: { taskId, upstreamNodeRunId, siblingPorts: string[] }): Promise<string | undefined>`：

1. 对每个 sibling port，查询该 nodeRun 当前最新 decided 或 pending 的 `doc_versions` 行（按 `reviewIteration desc, createdAt desc` 取第一行）。
2. 读 `doc_versions.bodyFilePath` 文件正文；`markdown_file` 类型的 port 直接拼路径下文件内容（既有 `readDocVersionBody` 工具复用）。
3. 拼接：

```
You also produced the following sibling documents. They are tightly coupled with the document being revised; rewrite them coherently so the whole set stays consistent.

### {portA_name}
{portA_body}

### {portB_name}
{portB_body}
```

4. 任一 sibling 没有任何 doc_version（理论不可能——它是同一上游节点产出的，第一轮就该有 v1；但兜底防御）→ skip 该 port，剩余有的照拼；全 0 → 返 `undefined`，上游 caller 走"等同 RFC-005 现行 iterate"老路径。

英文前缀是稳定契约——`tests/review-sibling-outputs-prompt.test.ts` 断言字面量，不许后续无声改写。

### 3.3 ReviewPromptContext 构造拼接点

`buildReviewPromptContextForUpstream`（review.ts:1331-）目前根据最近 decided 的 doc_version 的 decision 字段（`rejected` / `iterated`）二分填充。改造为：

```ts
if (dv.decision === 'iterated') {
  const upstreamNodeRef = lookupUpstreamNodeRef(workflowDef, dv.sourceNodeId)
  const agent = await loadAgentByName(upstreamNodeRef.agentName) // 决策事务首部一次读
  const { trigger, markdownPorts } = isMultiMarkdownUpstream({
    outputs: agent.outputs.map((name) => ({ name, kind: agent.outputKinds?.[name] })),
    syncOutputsOnIterate: agent.syncOutputsOnIterate, // ← RFC-014 双守卫第一道
  })
  let siblingOutputs: string | undefined
  if (trigger) {
    const siblings = markdownPorts.filter((p) => p !== dv.sourcePortName)
    siblingOutputs = await buildSiblingOutputsBlock({
      taskId,
      upstreamNodeRunId: dv.sourceNodeRunId,
      siblingPorts: siblings,
    })
  }
  return {
    comments: renderedComments,
    iterateTargetPort: dv.sourcePortName,
    siblingOutputs,
  }
}
```

`undefined` siblingOutputs 让 prompt.ts 把 token 替换成 `''`（与现有 `iterateTargetPort` 缺省一致），且 auto-append 跳过该段。

## 4. iterate 合并策略反转

### 4.1 现行（RFC-005）

`submitReviewDecision` iterate 分支：
- 1 条 doc_version v(n+1) 落 target port（dispatchReviewNode 后续写入）。
- 其它 port 沿用 v1：本质上是"agent 输出全部 port，但 dispatchReviewNode 只为 target port 落新行"。

### 4.2 新行为（多 markdown 上游时）

`submitReviewDecision` iterate 分支：
- 新增前置：调用 `cascadeSiblingReviewsForIterate(args)`，把所有挂在同一上游、同一 sourceNodeRunId、port ≠ target 的 review 节点 reset 到 `pending` + `reviewIteration += 1` + WS 广播 `review.created`（与 reject 既有 cascade 同形）。
- dispatchReviewNode 后续会在上游 agent 重跑产出 envelope 后，对**每一个 markdown[_file] port**写 doc_versions v(n+1) 新行；reviewIteration 用 target port 的下一个值（caller 传入而非各 sibling 各自 +1）。
- worktree 文件：iterate 默认不回滚（保留 RFC-005 §2.1 #8 现行约定）；sibling 也不动文件。

### 4.3 cascadeSiblingReviewsForIterate

复用 `cascadeSiblingReviews`（reject 已有）的 SQL 模板，只改两点：
1. 默认 `cancelDocVersionsOnPending=true` 不变——sibling 旧的 pending doc_version 标记 `rejected` 归档（即便 sibling 是 `done(approved)`，它没有 pending doc_version，这一步 no-op）。
2. 已 `done(approved)` 的 sibling：除了 `status=pending` + `reviewIteration+=1`，还要把 review 节点的 `nodeRuns.status` 从 `done` 切回 `pending`（reject 的 cascade 默认就是这样，因为 reject 上游重跑会带新 doc_version 让 sibling 自动进 awaiting_review；iterate 路径同理）。

提取 `cascadeSiblingReviews` 第二参数 `triggeredBy: 'reject' | 'iterate'`，用于：
- WS 事件 payload 里 `reason` 字段 → 前端 toast 文案分流。
- 兼容性：reject 路径默认 `'reject'`，老测试不变。

### 4.4 doc_versions 写入路径

dispatchReviewNode（review.ts:295-）首次 awaiting_review 入档时，对每个 markdown[_file] port 写一行 doc_version。**当前实现已经是按 port 维度的循环**——不需要新增 schema，只需要：

1. 让 dispatchReviewNode 接受一个可选 `reviewIterationOverride: number` 参数。多 markdown iterate 路径下，scheduler 在上游 agent 节点重跑收尾后调度多个 review 节点的 dispatchReviewNode，传同一个 reviewIteration 值。
2. 单 port 路径（含 RFC-005 现行 iterate 老语义）走默认 `reviewIterationOverride=undefined` → fall back 到 `reviewIteration = run.reviewIteration + 1`，与现行行为完全一致。

`doc_versions.cascadeSourceReviewId TEXT NULL`：本 RFC **不新增列**；同批快照对齐用 `reviewIteration` 横向 join（同一 sourceNodeRunId + 同 reviewIteration 即同批），简化 schema 面。前端 reviews.detail "因兄弟 iterate 同步重生"的标记，由 frontend 在加载历史版本时通过"同一上游 nodeRunId 下同 reviewIteration 是否有别的 port 同时 +1"的派生判定算出（纯前端，无 DB 改动）。

## 5. 验证：reject 路径零回归

reject 路径的 cascade、回滚、prompt 注入全保持 RFC-005 现行。明确的反向保护：

- `reject` 分支的 ReviewPromptContext 构造 **不** 调 `buildSiblingOutputsBlock`——siblingOutputs 永远 `undefined`、`{{__sibling_outputs__}}` 替换为空串。
- `tests/review-prompt-injection.test.ts` 的 reject 路径 case 加断言：rendered prompt 不含 `## Sibling Outputs` / 不含英文一致性指令前缀。

## 6. 状态机增量

仅 iterate 路径的判定与级联面加分支，节点状态机本身（`pending` / `running` / `awaiting_review` / `done` / `failed` / `canceled`）与 RFC-005 §9 完全一致。新增状态转换图（仅文字描述）：

```
[iterate decision in multi-markdown upstream]
  ├── target review node: done → pending (reviewIteration += 1)   ← 与 RFC-005 现行一致
  ├── upstream agent node_run: done → pending (mint new attempt)  ← RFC-011 mint 新行
  ├── sibling review nodes (每个): {done|awaiting_review} → pending (reviewIteration += 1)  ← 新增
  └── sibling reviews 旧 pending doc_versions: marked rejected (归档)  ← 复用 reject cascade
```

## 7. 失败模式与降级

| 场景 | 行为 |
| --- | --- |
| 上游 agent 重跑时只产出 target port 内容、sibling 全空 envelope | 框架按现有"empty envelope = port content = ''"约定为该 sibling 落空白 v(n+1)；review 节点照常 awaiting_review；UI 渲染空文档由用户决定是否 reject |
| sibling port 在 doc_versions 表里没有任何已落档版本（理论不该发生） | buildSiblingOutputsBlock 跳过该 port；prompt 仍非空时正常注入；全 0 → siblingOutputs=undefined，等同 RFC-005 老 iterate |
| workflow definition snapshot 里上游节点的 outputs 字段缺失（极旧 v1 数据） | isMultiMarkdownUpstream 返回 trigger=false；安全降级到 RFC-005 老 iterate；不抛错 |
| agent 行已被删除（用户在 task 跑中删了 agent）| `loadAgentByName` 返回 null → 视为 `syncOutputsOnIterate=false` 退化；记 log.warn 不抛错；老 review 决策不卡 |
| agent `syncOutputsOnIterate=false` + 用户期望被同步 | 产品契约：agent 作者显式 opt-out，框架严格遵守；UI 评审页可加 muted hint「该 agent 已关闭同步刷新；其它兄弟文档将沿用上一版本」让审批者预判（A8c 不强制 hint，但可在 follow-up issue 加）|
| 用户对同一上游连续两次 iterate（不同 review、不同 target） | 两次独立 cascade；每次 reviewIteration += 1；prompt 注入的 sibling content 始终读最新 doc_version body（即上一次 cascade 写入的 v(n+1)） |
| 上游节点是 multi-process（agent-multi）的 markdown 输出 | RFC-005 B-T14 还没实现 multi-process review fanout；本 RFC 跟随 B-T14 状态 — 当前不支持，trigger 判定时若节点 kind=`agent-multi` 直接返回 trigger=false，等 B-T14 落地再补 |

## 8. 测试策略

### 8.1 backend（最低 +15 case）

`packages/backend/tests/`：

- `review-iterate-sibling-cascade.test.ts`（C1）
  - case 1：三 markdown 输出 + 三 review、agent `syncOutputsOnIterate: true`、iterate target=design → portA/B/C 各落 v2，reviewIteration 相等。
  - case 2：sibling 之前 done(approved) → cascade 后回 pending + reviewIteration+=1。
  - case 3：sibling 当前 awaiting_review（v2 pending 在用户写到一半）→ 旧 pending doc_version 归档 rejected、新 v3 落档。
- `review-sibling-outputs-prompt.test.ts`（C2）
  - case 1：渲染产物含英文前缀字面量 + 每个 sibling 一个 `### {port}` 段。
  - case 2：模板未引用 token → auto-append `## Sibling Outputs`。
  - case 3：模板引用 token → 替换文本与 auto-append 不双重出现。
- `review-iterate-single-port-baseline.test.ts`（C4）
  - case 1：单 markdown 输出节点 iterate → 仅 target port 落新 v；其它 port 不动；`__sibling_outputs__` 空串。
  - case 2：mixed markdown + string，sibling 是 string → 不进 sibling 集合，不 cascade。
- `review-iterate-partial-merge.test.ts`（RFC-005 C2 既有）
  - **改写**：顶部注释加 RFC-014 修订说明，断言反转——agent `syncOutputsOnIterate: true` + 多 markdown 不再"只接受 target"；agent opt-out 或 单 markdown 仍走老语义。
- `agent-sync-outputs-opt-out.test.ts`（C5）
  - case 1：agent `syncOutputsOnIterate: false` + 3 markdown 输出 + iterate → 仅 target port 落 v(n+1)、`__sibling_outputs__` 空串、无 cascade WS 事件、reject 路径行为不变。
  - case 2：CRUD：POST /api/agents 未传字段 → 入库默认 true；PUT 传 `false` → 持久化；GET 返回字段。
  - case 3：drizzle migration 0004：迁移前老行（缺列）迁移后查询返 `true` backfill 正确。

### 8.2 frontend（最低 +8 case）

`packages/frontend/tests/`：

- `node-inspector-prompt-preview-sibling.test.tsx`（2 case）：preview 含 token 时占位符替换；i18n hint 文案。
- `reviews-detail-cascade-toast.test.tsx`（2 case）：mock WS `review.created` 携带 `reason='iterate-sibling-cascade'` → toast 文案"M 条已通过的兄弟评审被同步重审"；reason='reject-sibling-cascade' → reject 老文案，不混。
- `reviews-detail-history-cascade-mark.test.tsx`（2 case）：版本列表渲染 v(n+1) 行附标记"因兄弟 iterate 同步重生"——通过派生判定（同 nodeRunId 同 reviewIteration ≥ 2 个 port）算出。
- `agent-form-sync-outputs-toggle.test.tsx`（2 case）：Add Agent 表单默认 toggle 打开（与默认 true 对齐）；Edit Agent 切 off 提交 → PATCH body 含 `syncOutputsOnIterate: false`。

### 8.3 源代码层兜底（C3）

`tests/review-prompt-builtin-tokens-source.test.ts`：扩展 RFC-005 既有源代码层 grep，新增 `__sibling_outputs__` 字面量出现在 `packages/shared/src/prompt.ts` 与 `services/review.ts`。

### 8.4 e2e

`e2e/review.spec.ts`：扩第 N 步——三 markdown 输出 workflow，对 design iterate，断言：
- prompt 文件（fixture 落盘）含 `## Sibling Outputs` 段。
- 三个 review 节点全部 awaiting_review v2。
- approve 三个 → task done。

## 9. 兼容性 / 迁移

- **DB**：drizzle migration 0004（编号按当前 head 顺延）`agents` 表新加 `sync_outputs_on_iterate INTEGER NOT NULL DEFAULT 1`；老行 backfill `1`。其它表零变动。
- **workflow definition**：零字段变化；既有 workflow YAML / DB 行直接享受新行为。
- **agent definition (frontmatter)**：新增可选布尔字段 `syncOutputsOnIterate`，缺省解析为 `true`。YAML 导入未指定 → `true`。Agent CRUD API 与 frontmatter 序列化双向 round-trip。
- **API**：REST `/api/agents/*` 响应体加 `syncOutputsOnIterate: boolean`；POST/PUT body 可选 default true。REST `/api/reviews/*` 与 WS 事件 schema 无新字段；`review.created` 事件 payload 可选 `reason` 字符串字段（向后兼容，老消费者忽略未识别字段）。
- **CLI / 配置**：无。

## 10. 相关 RFC 与 issue

- [[RFC-005]] human-review：本 RFC 修订其 §2.1 #8 / A3 / L2。
- [[RFC-011]] node-prompt-history：iterate mint 新 attempt 行为本 RFC 继承，sibling review 的新 attempt 同样走 mint 路径，复用 `superseded-by-review-iterated` errorMessage marker。
- [[RFC-013]] review-historical-versions：本 RFC 不动 doc_versions 表，历史浏览页面自动覆盖新行；只在 UI 层加 cascade 来源标记。
- RFC-005 follow-up B-T14 multi-process review fanout：本 RFC 显式跳过 agent-multi 节点，等 B-T14 落地再补一节"multi-process × sibling cascade"。
