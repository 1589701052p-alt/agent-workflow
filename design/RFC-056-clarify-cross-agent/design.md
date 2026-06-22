# RFC-056 Design — 跨 agent 反问（Cross-Agent Clarify）：技术设计

> 状态：Draft（2026-05-22）
> 关联文档：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 复用基线：[RFC-023](../RFC-023-agent-clarify/design.md)、[RFC-026](../RFC-026-clarify-inline-session/design.md)、[RFC-039](../RFC-039-clarify-ask-bias/design.md)、[RFC-014](../RFC-014-iterate-sibling-regen/design.md)、[RFC-053](../RFC-053-node-run-lifecycle-hardening/design.md)

## 1. 概览

本 RFC 引入第 9 类 NodeKind `clarify-cross-agent`，把 RFC-023 self-clarify 的 "agent 自反问 → 自己重跑" 模型扩展为 "questioner agent 反问 → designer agent 重跑" 的跨 agent 反馈环。

技术上分 7 块改动（按依赖链顺序）：

1. **shared/schemas**：新增 NodeKind + 节点字段 + workflow $schema v4 + envelope 解析路径 mode 标识。
2. **shared/clarify-cross.ts** 新模块：cross-clarify 专属纯函数（buildExternalFeedbackBlock / summariseCrossAnswer 等），与 `shared/clarify.ts` 并列、不重叠。
3. **shared/prompt.ts**：3 个新 builtin token + 协议块扩展。
4. **backend migration 0029**：新表 `cross_clarify_sessions` + `node_runs.cross_clarify_iteration` 列。
5. **backend services/crossClarify.ts** 新模块：session lifecycle / 多源等待汇总 / reject 持久 / abandoned 升级；与 `services/clarify.ts` 完全并列。
6. **backend scheduler / runner**：分支 hook 多源等待 + cascade reset + reject directive 检查；envelope 解析 cross-clarify mode 关问题数上限。
7. **frontend**：列表 chip + 详情页 Reject 按钮 + 二次确认 modal + 多源 banner + Inspector segmented + canvas drag 三边自动建。

数据流示意（单源 happy path）：

```
[input] ─▶ [designer] ─▶ [questioner] ─▶ [reviewDesign(review)]
              ▲                │
              │                │  __clarify__ (auto)
              │                ▼
              │           ┌─────────────────────┐
              │   manual  │ cross-clarify node  │
              └──────to_designer──────────────  │ (1 in, 2 out)
                          │ to_questioner       │
                          └────────auto─────────┘
                                  │
                                  ▼
                          questioner.__clarify_response__
```

边语义：

- `questioner.__clarify__ → newNode.questions`（auto，反向拖动）：questioner 吐出的 `<workflow-clarify>` envelope 进入 cross-clarify 节点。
- `newNode.to_questioner → questioner.__clarify_response__`（auto，反向拖动）：cross-clarify 节点把 answers 反馈给 questioner（与 RFC-023 同结构；运行时实际通过 cross_clarify_sessions 注入，边只是画布视觉锚点）。
- `newNode.to_designer → designer.__external_feedback__`（manual）：cross-clarify 节点把 answers 喂给 designer 触发重跑（运行时通过 cross_clarify_sessions 关系列定位 designer node_run，边只是画布视觉锚点 + validator 拓扑校验的依据）。

## 2. 节点拓扑 & 端口契约 & validator

### 2.1 NodeKind 定义

`packages/shared/src/schemas/workflow.ts` 加：

```ts
export const CROSS_CLARIFY_INPUT_PORT_NAME = 'questions'
export const CROSS_CLARIFY_OUT_TO_DESIGNER_PORT = 'to_designer'
export const CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT = 'to_questioner'
export const CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT = '__external_feedback__'

export type ClarifyCrossAgentSessionMode = 'isolated' | 'inline'

export interface ClarifyCrossAgentNode {
  id: NodeId
  kind: 'clarify-cross-agent'
  position: { x: number; y: number }
  label?: string
  sessionModeForDesigner?: ClarifyCrossAgentSessionMode   // 默认 isolated
  sessionModeForQuestioner?: ClarifyCrossAgentSessionMode // 默认 isolated
}
```

`NodeKind` union 加 `'clarify-cross-agent'`。`WorkflowDefinitionSchema` 的 `nodes` discriminated union 加分支。`RFC-053` 的 `NODE_KIND_BEHAVIORS` 加新条目（retryCascade=true / limits=human / orphanReap=true / gc=task / shutdown=preserve），编译期 exhaustiveness 守卫强制必填。

### 2.2 validator 规则

`packages/shared/src/workflow-validator.ts` 加 7 规则（沿用既有 `WorkflowIssue` 结构）：

| code                                            | severity | 触发条件                                                                              |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `cross-clarify-input-source-missing`            | fail     | cross-clarify 节点的 `questions` input 端口无 incoming edge                           |
| `cross-clarify-target-not-agent-single`         | fail     | `questions` 端 incoming edge source 节点 kind 不是 `agent-single`                     |
| `cross-clarify-has-downstream`                  | fail     | cross-clarify 节点除 2 个合法 output port 外有任何其它 outgoing edge                  |
| `cross-clarify-manual-edge-missing`             | warning  | `to_designer` output 端口无 outgoing edge                                             |
| `cross-clarify-target-not-ancestor`             | warning  | `to_designer` 端 outgoing edge target 节点不是 questioner 的上游祖先（拓扑闭包检查） |
| `cross-clarify-auto-edge-deleted`               | warning  | `to_questioner` 自动建的边被手动删除                                                  |
| `cross-clarify-self-review-warning`             | warning  | `to_designer` target 节点的 agent name === questioner 节点的 agent name              |

实现要点：

- **祖先关系判定**：从 questioner 节点出发，沿 incoming edges 做 BFS 收集所有祖先 NodeId 集合；manual-edge target 不在该集合 → warning。注意 wrapper-loop / wrapper-git 内层节点在 BFS 时按 wrapper container 边表达式正确穿透（与现有 cycle detection 同 helper）。
- **故意环白名单**：cross-clarify 节点的 2 条 outgoing 边（to_designer / to_questioner）以及 `__clarify_response__` / `__external_feedback__` 系统端口的 incoming 边在现有 cycle detection 中视为 "feedback edges"，不计入死锁判定（与 RFC-023 `__clarify_response__` 已有的白名单同思路）。

### 2.3 反向拖动 + manual edge 行为

`packages/frontend/src/canvas/handleConnect.ts`（RFC-007 已有 helper）扩展：

- 反向拖动 source = cross-clarify.questions handle、target = agent-single 节点 → 自动建 2 条边：`agent.__clarify__ → newNode.questions` + `newNode.to_questioner → agent.__clarify_response__`。视觉风格 / 动画 / handle 高亮与 RFC-023 反向拖动行为完全一致。
- cross-clarify 节点的 `to_designer` output handle 在 canvas 上始终可见；用户拖出 → target 必须是 agent-single（否则取消连接 + toast "must be agent-single"）→ 框架在 target 节点上动态注册 `__external_feedback__` target handle（仅当被 ≥ 1 cross-clarify manual-edge 指向时可见）。
- 删 `to_questioner → questioner.__clarify_response__` 边只触发 warning（不阻塞），运行时 answers 注入仍通过 cross_clarify_sessions 关系列定位 questioner node_run，与 RFC-023 同模式。

## 3. DB schema 变更（migration 0029）

### 3.1 node_runs 新列

```sql
ALTER TABLE node_runs ADD COLUMN cross_clarify_iteration INTEGER NOT NULL DEFAULT 0;
```

- 仅 designer 角色的 agent-single node_run 在被 cross-clarify 反馈触发重跑时递增。
- 与 `clarify_iteration` / `review_iteration` / `retry_index` 四者**正交**——四个计数器各管各的语义，互不重置。

### 3.2 新表 cross_clarify_sessions

```sql
CREATE TABLE cross_clarify_sessions (
  id                              TEXT PRIMARY KEY,            -- ULID
  task_id                         TEXT NOT NULL,
  cross_clarify_node_id           TEXT NOT NULL,              -- workflow.definition NodeId（稳定锚）
  cross_clarify_node_run_id       TEXT NOT NULL,              -- 当前 awaiting / answered 那个 node_run（与 review_sessions 同模式）
  source_questioner_node_id       TEXT NOT NULL,              -- 反问 agent 节点 NodeId
  source_questioner_node_run_id   TEXT NOT NULL,              -- 产出 envelope 的 questioner node_run
  target_designer_node_id         TEXT,                       -- 由 manual edge 解析；NULL 表示未连或运行时找不到
  loop_iter                       INTEGER NOT NULL DEFAULT 0, -- wrapper-loop 内 iter 索引（非 loop 内恒 0）
  iteration                       INTEGER NOT NULL DEFAULT 0, -- 该 cross-clarify 节点在本 loop_iter 内累计反问轮数
  questions_json                  TEXT NOT NULL,              -- envelope.questions（完整 JSON，问题数无上限）
  answers_json                    TEXT,                       -- 人填的 answers + custom_text（submit / reject 后写入；NULL 表示 awaiting）
  directive                       TEXT,                       -- 'continue' | 'stop'（submit→continue / reject→stop；NULL 表示 awaiting）
  status                          TEXT NOT NULL DEFAULT 'awaiting_human',
                                                              -- 'awaiting_human' | 'answered' | 'abandoned'
  designer_run_triggered_at       TEXT,                       -- 多源汇总后 designer 重跑 spawn 时间戳（ISO8601；abandoned 时仍可为 NULL）
  created_at                      TEXT NOT NULL,
  answered_at                     TEXT,
  abandoned_at                    TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (cross_clarify_node_run_id) REFERENCES node_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (source_questioner_node_run_id) REFERENCES node_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_cross_clarify_sessions_task ON cross_clarify_sessions(task_id);
CREATE INDEX idx_cross_clarify_sessions_node ON cross_clarify_sessions(cross_clarify_node_id, loop_iter, iteration);
CREATE INDEX idx_cross_clarify_sessions_designer ON cross_clarify_sessions(target_designer_node_id, status);
CREATE INDEX idx_cross_clarify_sessions_status ON cross_clarify_sessions(status);
```

- **directive 持久语义**：reject 写入 directive='stop' 后，该 cross_clarify_node_id 在本 task 内任何后续 questioner cascade rerun 都按 stop 处理。runtime 在 dispatch cross-clarify 节点时先 SELECT `WHERE cross_clarify_node_id=? AND directive='stop' ORDER BY iteration DESC LIMIT 1`，命中即跳过 awaiting_human、走 RFC-039 STOP CLARIFYING 注入。
- **loop_iter 维度**：wrapper-loop 进入新 iter 时由 scheduler 写新 loop_iter 值；同 (cross_clarify_node_id, loop_iter) 在不同 iter 内独立维护 iteration 序列；reject 持久 stop 跨 loop_iter（按 cross_clarify_node_id 唯一查询，不限制 loop_iter）。
- **abandoned 升级条件**（RFC-053 invariant CR-1 新加）：`status='answered' AND directive='continue' AND target_designer_node_id IS NOT NULL` 且对应 designer 节点在 task=failed 状态下无 cross_clarify_iteration ≥ session.iteration 的 done node_run → 升级 status='abandoned' + abandoned_at=now()。daemon 启动 5s 后全扫一次 + 每小时增量。

### 3.3 workflow $schema_version bump v3 → v4

`packages/shared/src/schemas/workflow.ts` 的 `$schema_version` 枚举加 4；migration helper `migrateWorkflowDefinition(v3 → v4)` 是 no-op（仅版本号 bump，结构兼容）。GET 路径透明把 v3 上提为 v4。新写入 PUT 强制 v4。YAML 导入：v4 输入接收 cross-clarify 节点；v3 输入含 cross-clarify 节点拒导（v3 本就没该 NodeKind）。

## 4. envelope 协议 & 解析

### 4.1 复用 `<workflow-clarify>`

questioner agent 输出 envelope 形态 / JSON schema 与 RFC-023 完全一致（每题 id / title / kind / recommended / options，options 2-4）。**唯一差异**：cross-clarify 节点关联的 agent 的解析器**关闭问题数上限**——`packages/shared/src/clarify.ts` 的 `parseClarifyEnvelopeBody` 新增第二个可选参数 `{ maxQuestions?: number }`，cross-clarify mode 下传 `Infinity`、self-clarify mode 保留 `CLARIFY_MAX_QUESTIONS=5`。其余截断 / 校验逻辑（选项截断、kind 校验、options ≥ 2）全部 reuse。

### 4.2 mode 标识

`packages/backend/src/runner.ts` 在为 questioner agent 构 envelope 解析上下文时，按 workflow.definition 检查该 agent 的 `__clarify__` outgoing edge target 是 RFC-023 `clarify` 节点还是本 RFC `clarify-cross-agent` 节点，传不同的 `maxQuestions` 给 parser。两种 target 共存时（罕见但合法）按"任一 target 是 cross → 关上限"。

### 4.3 互斥 envelope（reuse RFC-023）

questioner 同回复同时含 `<workflow-clarify>` + `<workflow-output>` → fail node_run + `clarify-and-output-both-present`（与 RFC-023 同错误码、同 retry 路径）。不为 cross-clarify 单独开新错误码。

## 5. Runtime 机制

### 5.1 envelope 解析 → cross_clarify_sessions 写入

questioner node_run done 后，runner 检查 envelope kind：

- envelope = `<workflow-output>`：正常走 questioner 主 output 下游链路。
- envelope = `<workflow-clarify>`：
  1. 检查该 questioner 是否已被 cross_clarify_sessions 标 stop（SELECT WHERE source_questioner_node_id=? AND directive='stop' LIMIT 1）。命中 → fail node_run + warning `cross-clarify-questioner-emit-after-stop`，retries 兜底（让 questioner 自我修正下次直接 output）。
  2. 未命中 → 解析 envelope JSON（cross mode = 无问题数上限）→ `crossClarifyService.createSession({...})` 写新行（status='awaiting_human'、directive=NULL、answers_json=NULL、loop_iter / iteration 由 service 推断）→ 创建 cross-clarify node_run 进 awaiting_human（lifecycle 转移 pending → awaiting_human 走 RFC-053 transitionNodeRunStatus）。
  3. 广播 WS `cross-clarify.created`。

### 5.2 人 submit / reject 处理

`POST /api/clarify/:nodeRunId/answer` 路由根据 node 的 NodeKind 分支到 `clarifyService` 或 `crossClarifyService`。`crossClarifyService.commitAnswers(sessionId, { answers, directive, ifMatchIteration })`：

- 乐观锁：`UPDATE cross_clarify_sessions SET answers_json=?, directive=?, status='answered', answered_at=now() WHERE id=? AND status='awaiting_human' AND iteration=ifMatchIteration` —— 行数 = 0 → 409 conflict。
- directive='continue'（submit）：调 `evaluateDesignerRerunReadiness(taskId, target_designer_node_id)`：
  - 查所有指向同 designer 的 cross-clarify 节点的 latest session（按 loop_iter 维度），逐个判断 status：
    - `awaiting_human` → 未就绪、return false。
    - `answered` directive='continue' → 计入 designer External Feedback。
    - `answered` directive='stop' → 跳过（不进 External Feedback、不阻塞）。
    - `abandoned` → 跳过（已失效）。
  - 全部就绪 → return true + 收集 directive='continue' 的 session 列表。
- ready=true → `triggerDesignerRerun(designerNodeId, sources)`：
  1. **不回退 worktree**（patch 2026-06-22）：cross-clarify `continue` 是"带 External Feedback 修订"而非重试，designer 既有产出与下游叠加的改动一律保留（prior 草稿经 scheduler `## Prior Output (to be updated)` prompt 块回灌）。旧版此步为 RFC-014 `rollbackBeforeRetry(designerNodeRunId)`，已撤——见 [patch-2026-06-22-designer-rerun-no-rollback](./patch-2026-06-22-designer-rerun-no-rollback.md)。
  2. 新建 designer node_run，`cross_clarify_iteration = max(prev) + 1`。
  3. prompt 构造（见 §6）。
  4. 触发 sibling cascade（下游全 reset pending、复用 RFC-014 helper）。被持久 stop 的 cross-clarify 节点 cascade 时**仍 reset 为 pending 但 dispatch 时检测 directive='stop' 跳过 awaiting**，questioner 重跑带 STOP CLARIFYING 注入（见 §5.4）。
  5. 广播 WS `cross-clarify.designer-rerun-batched`（含 source nodeId 列表 + designer node_run_id）。
- directive='stop'（reject）：跳过 designer 触发逻辑，直接：
  1. RFC-014 cascade reset：把 questioner 节点的 latest done node_run rollback + 创建新 questioner node_run。
  2. questioner prompt 走 STOP 注入（见 §5.4）。
  3. 广播 WS `cross-clarify.rejected`。

### 5.3 ifMatchIteration 乐观锁多 tab race

两个 tab 同时 submit 同一 session → 后写者 `WHERE iteration=N AND status='awaiting_human'` 行数 = 0，返回 409，前端走"另一处已提交"only-read fallback（与 RFC-023 同模式）。

### 5.4 questioner 重跑路径

questioner node_run cascade reset 后 dispatch 时：

- 查所有 cross_clarify_node_id 与本 questioner 关联的 sessions（SELECT WHERE source_questioner_node_id=?）。
- 若任一 session.directive='stop'（按 cross_clarify_node_id 分组取 latest）→ prompt 走 STOP 路径：append RFC-039 `## User directive: STOP CLARIFYING` anchor + 全量 Q&A 历史（含 reject 时填的 answers）+ "your output must be `<workflow-output>`" 强指令。RFC-039 已有 anchor 文案在 `packages/shared/src/clarify.ts` 的 `renderClarifyDirectiveTrailer('stop')` —— 直接 reuse。
- 所有 sessions.directive='continue' → 走 submit 路径：append `## Clarify Q&A` 段（全量历史 Q&A）+ RFC-039 ask-bias preamble（hasClarifyChannel=true 时 "默认你应当先反问"）。RFC-039 现有 trailer + preamble 全部 reuse。

inline session 模式（sessionModeForQuestioner='inline'）：spawn 命令行追加 `--session <questioner.opencode_session_id>`，prompt 走精简版（仅追加本轮 answers diff + 短指令，不重复完整 Q&A 历史），与 RFC-026 inline 路径同模式。

### 5.5 designer 重跑路径

designer node_run 新建后 dispatch：

- 收集 External Feedback sources（multi-source aggregation）：按 source_questioner_node_id 字典序、对每个 source 拉取该 source 在 latest loop_iter 内最新一条 directive='continue' 的 answered session。
- prompt 构造（见 §6）。
- inline session 模式（sessionModeForDesigner='inline'）：spawn 命令行追加 `--session <designer.opencode_session_id>`，prompt 走精简版（仅追加 External Feedback 本轮 diff + 短指令），与 RFC-026 inline 路径同模式 + fallback 同模式。
- **不回退 worktree**（patch 2026-06-22）：designer 重跑不再 rollback 到 pre_snapshot，在现有工作树上原地修订（§5.2 步骤 1）；prior 草稿经 scheduler `## Prior Output (to be updated)` prompt 块回灌。
- **现状勘误**：上面这条 inline session 接线后端**尚未消费**——`cross-clarify-answer` 重跑被排除在 `isClarifyRerunCause` 之外，designer 重跑恒以 isolated 跑，`sessionModeForDesigner`（含编辑器开关）当前为空配置。inline 续接为待办（见 [patch-2026-06-22-designer-rerun-no-rollback](./patch-2026-06-22-designer-rerun-no-rollback.md) §2.3 / §6）。

### 5.6 reject 后 cascade 与持久 stop 优先级

cascade reset 触发 cross-clarify 节点重 dispatch 时，先 SELECT `WHERE cross_clarify_node_id=? AND directive='stop' LIMIT 1`：

- 命中 → 跳过 awaiting_human、直接把节点标 done（lifecycle transition pending → done with reason='persistent-stop'）+ 不写新 session。questioner 自然 cascade rerun 走 §5.4 STOP 注入。
- 未命中 → 正常 awaiting envelope 输入（即 questioner 重跑出新 envelope 后再开新 session）。

## 6. Prompt 注入

### 6.1 designer prompt：External Feedback 段

`packages/shared/src/clarify-cross.ts` 新模块：

```ts
export interface CrossClarifySourceContext {
  sourceQuestionerNodeId: string
  iteration: number                  // 该 source 在本轮的累计 iteration
  questions: ClarifyQuestion[]       // reuse RFC-023 ClarifyQuestion
  answers: ClarifyAnswer[]           // reuse RFC-023 ClarifyAnswer
  syntheses: string[]                // 对应每题的 framework synthesis（reuse summariseClarifyAnswer）
}

export function buildExternalFeedbackBlock(
  sources: CrossClarifySourceContext[],
): string {
  // 按 sourceQuestionerNodeId 字典序排序，每个 source 渲染 sub-section
  // 顶部 "## External Feedback (round {max_iteration})"
  // 每个 source: "### From '{nodeId}' (round {iteration})"
  // 题目 / 答案 / framework synthesis（reuse summariseClarifyAnswer 纯函数）
}

export function summariseCrossAnswer(
  question: ClarifyQuestion,
  answer: ClarifyAnswer,
): string {
  // reuse summariseClarifyAnswer 单题路径
}
```

### 6.2 builtin token

`packages/shared/src/prompt.ts` 加 3 token：

| token                                  | 渲染内容                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `{{__external_feedback__}}`            | `buildExternalFeedbackBlock(sources)` 完整 markdown 块                                          |
| `{{__external_feedback_iteration__}}`  | designer 当前 cross_clarify_iteration（整数字符串）                                             |
| `{{__external_feedback_sources__}}`    | 当前批次 source NodeId 逗号分隔列表（"securityCross, uxCross"）                                 |

模板未引用任何上述 token 时框架 auto-append `## External Feedback` 段（紧贴 user prompt 末尾，与 RFC-023 `## Clarify Q&A` auto-append 同位置约定——倒数第二段）。

### 6.3 designer 同时挂 self-clarify 的双段渲染

prompt 末尾顺序：

```
... user prompt body ...

## Self Clarify Q&A
[RFC-023 path: __clarify_questions__ / __clarify_answers__ 渲染]

## External Feedback
[本 RFC path: __external_feedback__ 渲染]

[ask-bias preamble / 协议块（RFC-039）]
```

两段独立 auto-append（互不依赖）。两个 iteration 字段（clarify_iteration / cross_clarify_iteration）独立递增、prompt 段独立渲染、互不污染。

### 6.4 questioner prompt：reuse RFC-023 + reject STOP

questioner 模板用 RFC-023 4 token（`{{__clarify_questions__}}` 等），作用对象是本 cross-clarify 节点关联的 cross_clarify_sessions（按 loop_iter 限定本 iter 范围）。reject 触发的重跑 prompt 末尾追加 `## User directive: STOP CLARIFYING`（renderClarifyDirectiveTrailer('stop') reuse RFC-039 文案 + 全量 Q&A 历史 + "output 唯一合法" 强指令）。

## 7. UI / 路由

### 7.1 /clarify 列表 chip

`packages/frontend/src/routes/clarify/index.tsx` 列表项加 chip 区分 self vs cross：

```tsx
<ListItem>
  <Chip variant={item.kind === 'cross' ? 'info' : 'neutral'}>
    {t(item.kind === 'cross' ? 'clarify.list.chip.cross' : 'clarify.list.chip.self')}
  </Chip>
  ...
</ListItem>
```

i18n keys 新增：`clarify.list.chip.self` / `clarify.list.chip.cross` 双语对称。

### 7.2 /clarify/:nodeRunId 详情页

按 NodeKind 分支渲染 footer：

```tsx
{node.kind === 'clarify-cross-agent' && (
  <ButtonGroup>
    <Button variant="primary" disabled={!requiredAnswered} onClick={onSubmit}>
      {t('clarify.button.submit')}
    </Button>
    <Button variant="danger" disabled={!requiredAnswered} onClick={() => setRejectModalOpen(true)}>
      {t('crossClarify.button.reject')}
    </Button>
  </ButtonGroup>
)}
```

reject 二次确认 modal：

```tsx
<Dialog
  open={rejectModalOpen}
  title={t('crossClarify.rejectModal.title')}
  body={t('crossClarify.rejectModal.body')}
  footer={
    <>
      <Button onClick={() => setRejectModalOpen(false)}>{t('common.cancel')}</Button>
      <Button variant="danger" onClick={onConfirmReject}>
        {t('crossClarify.rejectModal.confirm')}
      </Button>
    </>
  }
/>
```

多源等待 banner（submit 完后渲染）：

```tsx
{multiSourcePending.length > 0 && (
  <Banner variant="warning">
    {t('crossClarify.multiSourceBanner', { remaining: multiSourcePending.length })}
    {multiSourcePending.map(s => (
      <Link key={s.nodeRunId} to={`/clarify/${s.nodeRunId}`}>{s.nodeLabel}</Link>
    ))}
  </Banner>
)}
```

### 7.3 NodeInspector 字段

`packages/frontend/src/canvas/NodeInspector.tsx` 给 cross-clarify 节点选中时渲染：

```tsx
<Field label={t('crossClarify.inspector.sessionModeForDesigner.label')}>
  <Segmented
    value={node.sessionModeForDesigner ?? 'isolated'}
    options={[
      { value: 'isolated', label: t('crossClarify.sessionMode.isolated') },
      { value: 'inline', label: t('crossClarify.sessionMode.inline') },
    ]}
    onChange={v => onUpdate({ sessionModeForDesigner: v })}
  />
</Field>
<Field label={t('crossClarify.inspector.sessionModeForQuestioner.label')}>
  <Segmented ...similar />
</Field>
```

公共组件复用：Segmented / Dialog / Banner / Button / Chip / Field 均 RFC-035 已有原语。

### 7.4 canvas drag

`packages/frontend/src/canvas/handleConnect.ts` 加分支：

- 反向拖动 cross-clarify.questions → agent-single → 自动建两条边（同 RFC-023 行为，只是节点 kind 不同）。
- 正向拖动 cross-clarify.to_designer → agent-single → 在 target 节点 ports 动态加 `__external_feedback__` target handle、写入 workflow.definition edge。

## 8. WS event

`packages/shared/src/schemas/ws.ts` 加 4 个 event variant（与 `clarify.created` / `clarify.answered` 并列）：

```ts
export type CrossClarifyWsMessage =
  | { type: 'cross-clarify.created'; taskId: TaskId; nodeRunId: NodeRunId; sessionId: string }
  | { type: 'cross-clarify.answered'; taskId: TaskId; nodeRunId: NodeRunId; sessionId: string; directive: 'continue' | 'stop' }
  | { type: 'cross-clarify.rejected'; taskId: TaskId; nodeRunId: NodeRunId; sessionId: string }
  | { type: 'cross-clarify.designer-rerun-batched'; taskId: TaskId; designerNodeRunId: NodeRunId; sourceNodeIds: NodeId[] }
```

`WorkflowsWsMessage` discriminated union 加上述 4 个。前端 `useWebSocket` 钩子按 type 路由 invalidation：

- `cross-clarify.created` → invalidate `/api/clarify` list query。
- `cross-clarify.answered` / `cross-clarify.rejected` → invalidate 列表 + 详情。
- `cross-clarify.designer-rerun-batched` → invalidate task 详情节点运行 tab。

## 9. inline session 失败回退

复用 RFC-026 fallback 模式，差异：错误码用 `inline-cross-clarify-fallback-to-isolated`（subreason: `missing-session-id` / `session-not-found` / `unsupported-opencode-version`）。`packages/backend/src/runner.ts` 的 inline spawn helper 抽出统一接口：

```ts
spawnWithOptionalInlineSession({
  agentNodeRunId,
  sessionMode,              // 'isolated' | 'inline'
  fallbackWarningCode,      // 'inline-clarify-fallback-to-isolated' | 'inline-cross-clarify-fallback-to-isolated'
  ...
})
```

self-clarify (RFC-026) / cross-clarify designer / cross-clarify questioner 三路径共享 helper、各自传不同 warning code。`packages/backend/tests/cross-clarify-inline-fallback.test.ts` 枚举三 subreason 验证。

## 10. abandoned 状态升级（RFC-053 invariant CR-1）

`packages/backend/src/services/lifecycleInvariants.ts` 加新 invariant rule `CR-1`:

```ts
{
  code: 'CR-1',
  description: 'cross_clarify_sessions answered+continue with parent task failed and no consuming designer node_run → abandon',
  scope: 'task',
  check: async (ctx) => {
    const stuck = await db.select(...).from(crossClarifySessions)
      .where(and(
        eq(crossClarifySessions.status, 'answered'),
        eq(crossClarifySessions.directive, 'continue'),
        eq(crossClarifySessions.taskId, ctx.taskId),
        isNotNull(crossClarifySessions.targetDesignerNodeId),
      ))
    // 对每条 stuck，查 designer 节点是否有 cross_clarify_iteration >= session.iteration 的 done node_run
    // 若 parent task 已 failed 且 designer 没 done → 升级 abandoned
    ...
  },
  upgrade: 'auto', // 不只是 alert，直接 UPDATE status='abandoned' + abandoned_at=now()
}
```

写法与 RFC-053 R1/R2/C1/T1/T2/T3/U1 同结构；daemon 启动 5s 后全扫一次 + 每小时增量；UI Banner 不变（沿用 RFC-053 stuck-task detector），仅在 /clarify 详情页加 abandoned chip 显示。

## 11. 测试策略

### 11.1 backend 单测（≥ +40）

按 §B3 分布：shared schemas 6 / envelope 解析 4 / cross-clarify service 12 / scheduler 8 / REST + WS 6 / inline 4。每个文件顶部注释链 RFC-056 + 关键断言概述（沿用 RFC-051 / RFC-053 风格）。

### 11.2 frontend 单测（≥ +18）

按 §B4 分布：/clarify 路由 chip / Reject 6 / canvas drag 5 / Inspector 4 / shared utils 3。

### 11.3 e2e（+1 spec 文件，≥ 1 case）

`packages/frontend/e2e/cross-clarify.spec.ts` 覆盖 A1 happy path。fixture `stub-opencode` 编排 5 轮 spawn 期望（designer v1 / questioner v1 clarify env / designer v2 with External Feedback assertion / questioner v2 output / review pass）。

### 11.4 回归防护守门

C1-C9 9 条 source code / behavior 守门测试（详见 proposal.md §C）。

### 11.5 RFC-053 invariant 测

新加 CR-1 invariant 单测（happy abandoned 升级 / 幂等扫 / 不误升 in-flight designer）。

### 11.6 既有套件零退化

- RFC-023 clarify 套件：byte-for-byte 字符串断言不变（buildClarifyProtocolBlock / renderClarifyDirectiveTrailer 主体不动，仅 parser 加可选参数默认值 = 旧值）。
- RFC-026 inline：spawnWithOptionalInlineSession helper 重构后 self-clarify 路径行为字节级一致（dataclass diff guard）。
- RFC-014 sibling cascade：cross-clarify cascade reset 走同一 helper、参数注入路径不变。

## 12. 关键决策理由与替代方案

详见 proposal.md §5。本节补两个 design 层细节：

1. **envelope parser 改造方式：可选参数 default = 旧值 vs 新解析器函数**。选 default 可选参数——避免在 runner 多处分支判断；新解析器函数会让 self-clarify / cross-clarify 路径走完全独立的解析器，难维护。
2. **多源等待"原子检查"实现：SELECT FOR UPDATE vs 应用层比较**。SQLite WAL 模式下 SELECT FOR UPDATE 语义弱，改为应用层在事务内：先 UPDATE session 写 answered → SELECT 所有指向同 designer 的 latest sessions → 若全部 status ∈ {answered, abandoned} 且至少一条 directive='continue' → 在同一事务内启动 designer rerun trigger（写新 node_run 行）。事务内 SQLite serial write 保证不会有两个 submit 同时通过 readiness check。
3. **abandoned 升级是 invariant 自动 vs 触发器 vs 应用层**：选 invariant 自动（RFC-053 已有 1h 扫描 loop），无需新调度器；触发器（SQLite 不擅长 cross-table trigger）、应用层（task fail 路径要散见多处）都劣于 invariant。
