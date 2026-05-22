# RFC-057 设计

## 1. 总体形态

```
┌────────────────────── frontend ───────────────────────┐
│ <TaskDiagnosePanel>                                   │
│   ├ 每行 alert + [Repair…] 按钮                       │
│   └ 点 Repair → <RepairChoiceDialog>                  │
│        ├ GET /api/tasks/:id/alerts/:alertId/repair-options
│        ├ 列出 1..N 选项（label + risk chip + preview）│
│        ├ 选中后 <RepairConfirmModal> 二次确认         │
│        └ POST /api/tasks/:id/alerts/:alertId/repair   │
│             { optionId, confirm: true }               │
│                                                       │
│ WS lifecycle.alert (transition='resolved') → 关闭 banner│
└───────────────────────────────────────────────────────┘
        │ HTTP
        ▼
┌────────────────────── backend ────────────────────────┐
│ routes/tasks.ts:                                      │
│   GET /api/tasks/:id/alerts/:alertId/repair-options   │
│       → listRepairOptionsForAlert()                   │
│   POST /api/tasks/:id/alerts/:alertId/repair          │
│       → applyRepairOption({ alertId, optionId, ... })│
│                                                       │
│ services/lifecycleRepair.ts:                          │
│   • REPAIR_OPTIONS: Record<LifecycleAlertRule, RepairOptionDef[]>
│   • listRepairOptionsForAlert(alertId)                │
│       → 加载 lifecycle_alerts 行 + 走 preflight       │
│   • applyRepairOption(alertId, optionId, actorUserId) │
│       1) preflight 再跑一遍校验 detail 没漂移         │
│       2) BEGIN TX                                     │
│       3) option.apply(detail, db, deps) — 改库        │
│       4) audit INSERT 一行 lifecycle_repair_audit      │
│       5) COMMIT                                       │
│       6) runLifecycleInvariants({ taskId })           │
│       7) runStuckTaskDetector subset                  │
│       8) 返回 { ok, newAlerts: [...] }                │
└───────────────────────────────────────────────────────┘
```

## 2. 数据模型

### 2.1 新表 `lifecycle_repair_audit`（migration 0030）

```sql
CREATE TABLE lifecycle_repair_audit (
  id TEXT PRIMARY KEY NOT NULL,                -- ULID
  task_id TEXT NOT NULL,                       -- 不加 FK，因为修完任务可能被删除（GC）
  alert_id TEXT,                               -- 原 lifecycle_alerts.id，nullable（alert 可能已 resolved 被清理）
  alert_rule TEXT NOT NULL,                    -- 'R1' / 'S3' / ...
  alert_detail_json TEXT NOT NULL,             -- 修复时刻的 detail snapshot
  option_id TEXT NOT NULL,                     -- 'S3.resurrect-review-run' / ...
  actor_user_id TEXT,                          -- nullable: 单机模式无用户
  before_snapshot_json TEXT NOT NULL,          -- 受影响行的修复前内容（受 option 决定具体取哪些列）
  after_snapshot_json TEXT NOT NULL,           -- 修复后的内容
  outcome TEXT NOT NULL,                       -- 'success' | 'preflight-stale' | 'apply-failed'
  outcome_message TEXT,                        -- 失败时填错误摘要
  applied_at INTEGER NOT NULL                  -- unix ms
);
CREATE INDEX idx_lifecycle_repair_audit_task ON lifecycle_repair_audit (task_id, applied_at);
CREATE INDEX idx_lifecycle_repair_audit_rule ON lifecycle_repair_audit (alert_rule, applied_at);
```

零外键约束（task 被 GC 后 audit 仍保留，方便事后审计）。永不 DELETE。

### 2.2 `lifecycle_alerts.detail` 的契约扩展

不改表 schema，但约定每条 invariant/stuck 的 detail 必须带"修复需要的最小标识符"。**当前 detail 形态盘点**：

| Rule | detail 已有字段（足够 preflight 用）|
| --- | --- |
| R1 | `docVersionId, reviewNodeRunId, reviewNodeId, actualStatus` |
| R2 | `reviewNodeRunId, reviewNodeId` |
| C1 | `clarifySessionId, clarifyNodeRunId, clarifyNodeId, actualStatus, clarifySessionStatus` |
| T1 | `taskId` |
| T2 | `taskId` |
| T3 | `missingOutputNodeIds[]` |
| U1 | `key, nodeRunIds[], statuses[]` |
| CR-1 | `crossClarifySessionId, crossClarifyNodeId, targetDesignerNodeId, iteration` |
| S1 | `inactiveForMs, thresholdMs` —— **不够**，需加 `reviewNodeRunId` 候选 |
| S2 | `inactiveForMs, thresholdMs` —— **不够**，需加 `clarifyNodeRunId` 候选 |
| S3 | `totalRuns, terminalRuns, inactiveForMs` —— **不够**，需加 `repairHint`（最可疑 nodeRunId 候选 + kind） |
| S4 | `pendingForMs, thresholdMs` —— 足够（task-level） |

**改动**：`stuckTaskDetector.ts` 给 S1/S2/S3 的 detail 额外塞一个 `repairHint?: { kind, nodeRunId?, nodeId? }` 字段。invariant 规则的 detail 一字不改。

`repairHint` 不是契约性必填——preflight 走全表扫的方式自己也能定位，只是有 hint 时少一次 SELECT。

### 2.3 不动的 schema

`node_runs / tasks / doc_versions / clarify_sessions / cross_clarify_sessions / lifecycle_alerts` 全部不动 schema。

## 3. shared 层契约（`packages/shared/src/diagnose-repair.ts`）

```ts
import type { LifecycleAlertRule } from './lifecycle-alerts'

export type RepairRisk = 'low' | 'medium' | 'high'

/** Static descriptor — no apply function lives here; backend owns those. */
export interface RepairOptionMeta {
  id: string                 // e.g. 'S3.resurrect-review-run'
  rule: LifecycleAlertRule
  labelKey: string           // i18n key, e.g. 'diagnose.repair.S3.resurrectReviewRun.label'
  descriptionKey: string     // i18n key
  risk: RepairRisk
  /** True ⟹ frontend must show a second confirmation modal with destructive styling. */
  destructive: boolean
}

/** Returned by backend per (alert, option) — includes preflight result. */
export interface RepairOption extends RepairOptionMeta {
  available: boolean                  // false ⟹ shown grey + reason
  unavailableReasonKey?: string       // i18n key when available=false
  previewSteps: ReadonlyArray<string> // human-readable steps; rendered as <ol> in dialog
}

export interface RepairOptionsResponse {
  alertId: string
  alertRule: LifecycleAlertRule
  options: ReadonlyArray<RepairOption>
}

export interface RepairRequest {
  optionId: string
  confirm: true   // literal — Zod refuses anything else
}

export interface RepairResponse {
  ok: boolean
  auditId: string
  outcome: 'success' | 'preflight-stale' | 'apply-failed'
  outcomeMessage?: string
  /** Re-scan results after apply: alerts that are now resolved. */
  resolvedAlertIds: ReadonlyArray<string>
  /** Re-scan results: any NEW alerts that surfaced. */
  newAlerts: ReadonlyArray<{ id: string; rule: LifecycleAlertRule }>
}

/** Static option taxonomy. Backend's REPAIR_OPTIONS map must enumerate exactly
 * these option ids per rule; the compile-time check below enforces it. */
export const REPAIR_OPTION_IDS: Record<LifecycleAlertRule, ReadonlyArray<string>> = {
  R1:   ['R1.approve-run',          'R1.unapprove-doc',           'R1.mark-task-failed'],
  R2:   ['R2.demote-run-to-awaiting', 'R2.mark-task-failed'],
  C1:   ['C1.resume-run',           'C1.reopen-session'],
  T1:   ['T1.demote-task',          'T1.resurrect-review-run'],
  T2:   ['T2.demote-task',          'T2.resurrect-clarify-run'],
  T3:   ['T3.demote-task',          'T3.mark-task-failed'],
  U1:   ['U1.cancel-older-keep-newest', 'U1.cancel-newer-keep-oldest'],
  'CR-1': ['CR-1.acknowledge',      'CR-1.retry-designer-rerun'],
  S1:   ['S1.recreate-doc-version', 'S1.demote-task'],
  S2:   ['S2.demote-task',          'S2.reopen-session'],
  S3:   ['S3.resurrect-review-run', 'S3.resurrect-clarify-run', 'S3.demote-task', 'S3.mark-task-failed'],
  S4:   ['S4.kick-task',            'S4.cancel-task'],
} as const
```

**Exhaustiveness 守卫**：`REPAIR_OPTION_IDS satisfies Record<LifecycleAlertRule, ReadonlyArray<string>>` 编译期强制每条规则都有条目；backend 的 `REPAIR_OPTIONS` 实现表也以同样方式 satisfies。新增规则时编译失败，提醒补 options。

## 4. backend 实现

### 4.1 `services/lifecycleRepair.ts` 骨架

```ts
import { REPAIR_OPTION_IDS, type RepairOption, type RepairOptionMeta } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { transitionNodeRunStatus, setNodeRunStatus } from '@/services/lifecycle'
import { resumeTask } from '@/services/task'
import { dispatchReviewNode } from '@/services/review'

export interface RepairContext {
  db: DbClient
  alert: LifecycleAlertRow            // row from lifecycle_alerts
  task: Task                          // task at apply time
  actorUserId: string | null
  deps: { opencodeCmd?: string; subagentLiveCapture?: SubagentLiveCaptureConfig }
}

export interface PreflightResult {
  available: boolean
  unavailableReasonKey?: string
  previewSteps: string[]
  /** Cached lookups passed to apply() to avoid re-querying. */
  ctx: Record<string, unknown>
}

export interface ApplyResult {
  beforeSnapshot: Record<string, unknown>
  afterSnapshot: Record<string, unknown>
}

export interface RepairOptionDef extends RepairOptionMeta {
  preflight: (rc: RepairContext) => Promise<PreflightResult>
  apply: (rc: RepairContext, preflight: PreflightResult) => Promise<ApplyResult>
}

export const REPAIR_OPTIONS = {
  R1: [
    {
      id: 'R1.approve-run',
      rule: 'R1',
      risk: 'low',
      destructive: false,
      labelKey: 'diagnose.repair.R1.approveRun.label',
      descriptionKey: 'diagnose.repair.R1.approveRun.desc',
      preflight: async (rc) => { /* SELECT review run, check status === 'awaiting_review' */ },
      apply: async (rc, pre) => { /* transitionNodeRunStatus(approve-review), set decided_at */ },
    },
    { id: 'R1.unapprove-doc', /* ... */ },
    { id: 'R1.mark-task-failed', /* ... */ },
  ],
  R2: [ /* ... */ ],
  C1: [ /* ... */ ],
  T1: [ /* ... */ ],
  T2: [ /* ... */ ],
  T3: [ /* ... */ ],
  U1: [ /* ... */ ],
  'CR-1': [ /* ... */ ],
  S1: [ /* ... */ ],
  S2: [ /* ... */ ],
  S3: [ /* ... */ ],
  S4: [ /* ... */ ],
} as const satisfies Record<LifecycleAlertRule, RepairOptionDef[]>

// REPAIR_OPTION_IDS in shared 用同名 id 列表 → backend test 验证两边对齐
```

### 4.2 关键入口

```ts
export async function listRepairOptionsForAlert(args: {
  db: DbClient
  taskId: string
  alertId: string
  actorUserId: string | null
  deps: ...
}): Promise<RepairOptionsResponse>

export async function applyRepairOption(args: {
  db: DbClient
  taskId: string
  alertId: string
  optionId: string
  actorUserId: string | null
  deps: ...
}): Promise<RepairResponse>
```

`applyRepairOption` 主流程：

1. 加载 `lifecycle_alerts` 行；若 `resolved_at != null` → 409 already-resolved。
2. 加载对应 task；如果 task 不存在 → 404。
3. 在 REPAIR_OPTIONS 里查 (rule, optionId)；找不到 → 422 unknown-option。
4. `option.preflight(rc)` —— 如果 `available === false`，写一行 `outcome='preflight-stale'` 的 audit，返回 409 stale。
5. `option.apply(rc, preflight)` —— 整段包在 `db.transaction` 里（bun:sqlite synchronous 事务）；apply 内部全部走 RFC-053 helper。
6. INSERT lifecycle_repair_audit。
7. 立即调 `runLifecycleInvariants({ db, scope: { taskId }, onAlert: broadcaster })`，把这一 task 的 invariant alerts reconcile。
8. 立即调 `runStuckTaskDetector({ db, taskIdFilter: [taskId] })`（detector 现在是全量扫，本 RFC 给它加可选 `taskIdFilter` 参数；改动只在 `loadCandidates`）。
9. 返回 `RepairResponse` 含新旧 alert 集合。

### 4.3 各规则修复实现细节

下表给每个 optionId 列出 apply 函数会做什么。所有 transition 均走 RFC-053 helper。

#### R1: doc_version approved 但 review run 不是 done

| Option | Preflight | Apply |
| --- | --- | --- |
| `R1.approve-run` | review run 必须 `awaiting_review`（最常见的"按了 approve 但写入失败"形态） | `transitionNodeRunStatus(approve-review)` → `done`；写 `node_run_outputs`（onConflictDoUpdate 兜底 RFC-052 idempotent）；广播 |
| `R1.unapprove-doc` | doc_version 必须 `approved` 且 review run 是 terminal-non-done | `UPDATE doc_versions SET decision='pending', decided_at=NULL, decided_by=NULL WHERE id=?` |
| `R1.mark-task-failed` | task 不是 terminal | `UPDATE tasks SET status='failed', error_summary='manual-repair-R1', finished_at=now`；所有 `running/pending` node_run `transitionNodeRunStatus(mark-canceled)` |

#### R2: review run done 但无 approved doc_version

| Option | Preflight | Apply |
| --- | --- | --- |
| `R2.demote-run-to-awaiting` | review run 必须 `done` | `setNodeRunStatus(review run, awaiting_review, allowTerminal=true)`；不动 doc_versions；task 由后续 invariant 自然推进 |
| `R2.mark-task-failed` | 同 R1 | 同 R1 |

#### C1: clarify_session closed 但 clarify run 仍 awaiting_human

| Option | Preflight | Apply |
| --- | --- | --- |
| `C1.resume-run` | session.status ∈ {answered, canceled}；run.status='awaiting_human' | `transitionNodeRunStatus(resume-clarify)` → `done`；写 clarify outputs（已有 helper） |
| `C1.reopen-session` | run.status='awaiting_human' | `UPDATE clarify_sessions SET status='awaiting_human', answers_json=NULL, answered_at=NULL WHERE id=?` |

#### T1: task awaiting_review 但无 run awaiting_review

| Option | Preflight | Apply |
| --- | --- | --- |
| `T1.demote-task` | task.status='awaiting_review' | `UPDATE tasks SET status='interrupted', error_summary='manual-repair-T1'`；不动 node_runs；下一步：route handler 调 `resumeTask` |
| `T1.resurrect-review-run` | 存在 terminal-non-done review run 在当前 reviewIteration | `setNodeRunStatus(review run, awaiting_review, allowTerminal=true)`；任务保留 awaiting_review |

#### T2: task awaiting_human 但无 run awaiting_human

| Option | Preflight | Apply |
| --- | --- | --- |
| `T2.demote-task` | task.status='awaiting_human' | 同 T1.demote-task，调 resumeTask |
| `T2.resurrect-clarify-run` | 存在 terminal-non-done clarify run 在当前 clarifyIteration + 同 task 有 open clarify_session | `setNodeRunStatus(clarify run, awaiting_human, allowTerminal=true)` |

#### T3: task done 但有 output node 未 done

| Option | Preflight | Apply |
| --- | --- | --- |
| `T3.demote-task` | task.status='done' | `UPDATE tasks SET status='interrupted', finished_at=NULL, error_summary='manual-repair-T3'`；resumeTask 接管补齐 missing output node |
| `T3.mark-task-failed` | task.status='done' | `UPDATE tasks SET status='failed', error_summary='manual-repair-T3'` |

#### U1: 多活跃 run 共享 (nodeId, iter, shard)

| Option | Preflight | Apply |
| --- | --- | --- |
| `U1.cancel-older-keep-newest` | `detail.nodeRunIds.length >= 2` | 按 ulid 排序，最新一行保留，其余每个调 `transitionNodeRunStatus(cancel-by-supersede)` |
| `U1.cancel-newer-keep-oldest` | 同上 | 反向：最旧一行保留 |

#### CR-1: cross_clarify answered+continue + task failed

| Option | Preflight | Apply |
| --- | --- | --- |
| `CR-1.acknowledge` | session.status='abandoned'（invariant 已 upgrade） | 无 DB 改动；仅 audit + 标 alert resolved（让 admin 视觉上"清掉" banner） |
| `CR-1.retry-designer-rerun` | task.status='failed' 且 designer 节点存在 | `UPDATE tasks SET status='interrupted', error_summary='manual-repair-CR1'`；resumeTask 接管；scheduler 通过 RFC-056 §5.4 freshness invariant 自动 re-cascade |

#### S1: awaiting_review 但无 pending doc_version

| Option | Preflight | Apply |
| --- | --- | --- |
| `S1.recreate-doc-version` | 存在 awaiting_review review run | 调 `dispatchReviewNode(...)`（既有函数，会在 sourceRun.status=done 时新建 pending doc_version） |
| `S1.demote-task` | task.status='awaiting_review' | 同 T1.demote-task |

#### S2: awaiting_human 但无 open clarify_session

| Option | Preflight | Apply |
| --- | --- | --- |
| `S2.demote-task` | task.status='awaiting_human' | 同 T2.demote-task |
| `S2.reopen-session` | 存在该 run 关联的 closed clarify_session | 同 C1.reopen-session |

#### S3: running 但所有 node_run terminal

这是本次事故的形态。给 4 个选项是因为实际可能的卡死位置不同：

| Option | Preflight | Apply |
| --- | --- | --- |
| `S3.resurrect-review-run` | task 里存在 terminal-non-done review run 在当前 iter，且无同 iter `done` review row | review run → `pending`（用 `setNodeRunStatus(allowTerminal=true)`）；task → `interrupted`；resumeTask |
| `S3.resurrect-clarify-run` | 同上 + clarify kind | clarify run → `pending`；task → `interrupted`；resumeTask |
| `S3.demote-task` | task.status='running' | task → `interrupted`；resumeTask（兜底用，让 scheduler 自己决定下一步） |
| `S3.mark-task-failed` | task.status='running' | task → `failed`，error_summary='manual-repair-S3' |

#### S4: pending too long

| Option | Preflight | Apply |
| --- | --- | --- |
| `S4.kick-task` | task.status='pending' | `UPDATE tasks SET status='interrupted'` → resumeTask 重新拉起 |
| `S4.cancel-task` | task.status='pending' | `UPDATE tasks SET status='canceled', finished_at=now, error_summary='manual-repair-S4'`；不动 worktree |

### 4.4 route 设计

`packages/backend/src/routes/tasks.ts`（追加）：

```ts
app.get('/api/tasks/:id/alerts/:alertId/repair-options', async (c) => {
  const taskId = c.req.param('id')
  const alertId = c.req.param('alertId')
  const userId = c.get('userId') ?? null
  const result = await listRepairOptionsForAlert({ db: deps.db, taskId, alertId, actorUserId: userId, deps: ... })
  return c.json(result)
})

app.post('/api/tasks/:id/alerts/:alertId/repair', async (c) => {
  const body = RepairRequestSchema.parse(await c.req.json())  // Zod 强校验 confirm: true literal
  const taskId = c.req.param('id')
  const alertId = c.req.param('alertId')
  const userId = c.get('userId') ?? null
  const result = await applyRepairOption({
    db: deps.db, taskId, alertId, optionId: body.optionId,
    actorUserId: userId,
    deps: { opencodeCmd: resolveOpencodeCmd(...), subagentLiveCapture: resolveSubagentLiveCapture(...) },
  })
  return c.json(result, result.outcome === 'success' ? 200 : 409)
})
```

错误码映射（沿用项目既有 ConflictError / NotFoundError / ValidationError 三种）：

- 404 `task-not-found` / `alert-not-found`
- 409 `alert-already-resolved` / `repair-preflight-stale` / `task-not-resumable`（resume API 拒绝时）
- 422 `unknown-option` / `confirm-required`
- 500 `repair-apply-failed`（apply 抛异常，audit 仍落一行 `outcome='apply-failed'`）

## 5. 前端

### 5.1 组件结构

```
<TaskDiagnosePanel>
  └ <DiagnoseTable>
       └ <DiagnoseRow alert={...}>
            ├ rule + severity + detectedAt + detail (folded)
            └ <button.btn.btn--sm onClick={openRepair}>{t('...repair')}</button>

<RepairChoiceDialog open alertId taskId onClose onApplied>
  ├ GET /api/tasks/$taskId/alerts/$alertId/repair-options
  ├ <Select> 选项列表（不可用项 disabled，悬浮 tooltip 显 unavailableReasonKey）
  ├ <RepairPreview previewSteps={...} risk={...} destructive={...} />
  └ <Dialog.footer>
       └ <button.btn.btn--primary onClick={openConfirm}>{t('...next')}</button>

<RepairConfirmModal open optionMeta previewSteps onConfirm onCancel>
  └ destructive ? .btn--danger : .btn--primary
  └ POST /api/tasks/$taskId/alerts/$alertId/repair { optionId, confirm: true }
  └ onApplied(response)
```

### 5.2 公共组件复用

按 CLAUDE.md「Frontend UI consistency 强制原则」：

- 弹窗 **必须** `Dialog`（不允许新写 modal chrome）
- 选项列表 **必须** `Select`（不允许原生 `<select>`）
- 错误 banner **必须** `<ErrorBanner>`
- 危险按钮 **必须** `.btn .btn--sm .btn--danger`
- 二次确认 modal 复用 `Dialog`，不新写

### 5.3 WS 集成

复用 RFC-053 PR-E 的 `lifecycle.alert` WS 消息。`applyRepairOption` 后端调用 `runLifecycleInvariants` 已经会通过 `onAlert(row, transition)` 推 WS；前端 `useTasksSync` 收到后 invalidate `['tasks', taskId, 'alerts']`，TaskDiagnosePanel re-render，banner 自然消失。

### 5.4 不做的事

- 不做"Repair all alerts" 按钮（A-10）
- 不做拖拽 / 排序 alert 行
- 不做 audit log 浏览页（admin 走 SQL 看 `lifecycle_repair_audit` 表即可；后续 RFC 可以补 UI）

## 6. 测试策略

### 6.1 shared 测试（约 12 case）

- `REPAIR_OPTION_IDS` 12 条规则各自非空
- 没有重复 id
- 每个 id 命名格式 `<rule>.<kebab>`

### 6.2 backend unit 测试（每选项 ≥ 3 case，总 ~80 case）

每个 (rule, optionId) 三件套：

1. **happy path** — 准备脏数据使 invariant 触发；apply；断言 DB 形态 + audit 行 + invariant 复扫无该 alert
2. **preflight-stale** — 准备数据让 detail 不再匹配；apply；断言 409 + audit `outcome='preflight-stale'` + DB 零改动
3. **apply-error** — mock 内部依赖（resumeTask / dispatchReviewNode）抛错；断言 audit `outcome='apply-failed'` + DB 已回滚（事务）

### 6.3 backend route 测试（~15 case）

- GET options 返回 1..N 项，每项含 preview steps
- POST repair: confirm=true 才执行（缺 confirm → 422；confirm=false → 422）
- POST repair: alert 已 resolved → 409
- POST repair: option 不存在 → 422
- POST repair: actor 取 `c.get('userId')`，不接受 body.actorUserId（A-11）
- POST repair: 触发 `runLifecycleInvariants` 并广播 WS（用 broadcaster spy 验证）

### 6.4 grep 守卫（~5 case）

- `services/lifecycleRepair.ts` 不得含 `db.update(nodeRuns).set({ status:`（A-6）
- `services/lifecycleRepair.ts` 不得含 `db.delete(`（A-12）
- `lifecycleRepair.ts` 调用 `transitionNodeRunStatus` / `setNodeRunStatus` 至少 N 次（防回退）
- shared `REPAIR_OPTION_IDS` 12 个 key 必须与 `LifecycleAlertRule` 类型 union 完全对齐
- backend `REPAIR_OPTIONS` 的每个 optionId 必须出现在 shared `REPAIR_OPTION_IDS` 对应 rule 的列表里

### 6.5 frontend 测试（~20 case）

- `<RepairChoiceDialog>` 列表渲染（每条规则的 mock options 各一）
- 不可用选项 disabled + tooltip
- 选项切换更新 preview
- 点 Next → ConfirmModal；点 Cancel 关闭
- destructive=true 时按钮 `.btn--danger`
- apply 成功 toast + 关闭对话框
- apply 失败显 `<ErrorBanner>`
- TaskDiagnosePanel 每行渲染 Repair 按钮
- WS resolved 后 alert 行消失（mock WS）

### 6.6 e2e（1 spec, 4 case）

`packages/frontend/e2e/diagnose-repair.spec.ts`：

1. **S3 happy path** — 用 stub opencode 制造 wedge → diagnose 显 S3 → click Repair → 选 resurrect-review-run → confirm → 5s 内 banner 消失
2. **R1 happy path** — 制造 doc approved + run awaiting → repair → run done
3. **U1 cancel-older** — 制造两行 awaiting → repair → 旧行 canceled，新行保留
4. **preflight stale** — 两个 tab 同时打开 diagnose；一个先 repair；另一个 confirm 时 → 显 stale 错误

## 7. 实施顺序（4 PR）

详见 `plan.md`。

## 8. 风险拒绝

- **拒绝"修复脚本"扩散**：所有修复必须进 REPAIR_OPTIONS。新形态的 wedge 不允许新加 fixup 脚本，而是开 RFC 给 option 集合扩条目。
- **拒绝运行时插件加载**：option 集合是编译期静态表，与 RFC-049 §"显式拒绝运行时 plugin loader" 同精神。
- **拒绝 admin 直接传 SQL**：后端只接受 optionId，optionId 是受限 enum。
- **拒绝跨 task 批量**：UI / route 都不支持。
