# RFC-053 — node_run 生命周期硬化（技术设计）

> 配套 [proposal.md](./proposal.md)。所有引用以 `main@HEAD` 为准；行号
> 在重构过程中会变，文中只引"模块名 + 函数名"作锚点。

## 全景图

```
┌──────────────── PR-A：测试 baseline（无产品代码改动） ────────────────┐
│  +50-80 测试，分 8 类锁住 *当前* 行为。后续 PR 必须保持这条 baseline │
│  绿。详见本文 §测试策略。                                              │
└────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────── PR-B：P-1 node_runs.status 状态机化 ─────────────────┐
│  shared/lifecycle.ts → NodeRunStatus 联合 + LegalTransition 联合     │
│  backend/services/lifecycle.ts → transitionNodeRunStatus(db, id,     │
│    expectedFrom, to, otherFields) 走 CAS UPDATE                       │
│  替换全部 15+ 处 db.update(nodeRuns).set({ status }) 调用点           │
│  ESLint 自定义规则禁止裸写 status                                     │
└────────────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
┌─ PR-C：P-2 kind handler ┐ ┌─ PR-D：P-3 invariant ┐ ┌─ PR-E：P-6 stuck ┐
│  shared/node-kind-       │ │  services/lifecycle  │ │  services/        │
│  behavior.ts             │ │  Invariants.ts       │ │  stuckTaskDetect  │
│  retryNode / enforce-    │ │  启动 + 每小时扫     │ │  or.ts            │
│  Limits / orphans /      │ │  双层一致性          │ │  每 5 min 扫      │
│  gc / shutdown 全部走表  │ │  + lifecycle_alerts  │ │  + WS 推前端      │
└──────────────────────────┘ │  表                   │ │                   │
                              └───────────────────────┘ └───────────────────┘
```

PR-A 必须 first。PR-B 是 P-1，是 P-2/P-3/P-6 的前置（它们都需要走
helper 写 status）。P-2/P-3/P-6 之间无强依赖，可并行。

---

## P-1：node_runs.status 状态机化

### 联合类型 + 合法转移表

新文件 `packages/shared/src/lifecycle.ts`：

```ts
export const NODE_RUN_STATUS = [
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
  'done',
  'failed',
  'canceled',
  'interrupted',
] as const
export type NodeRunStatus = (typeof NODE_RUN_STATUS)[number]

// 终态：不允许 out-transition
export const TERMINAL_NODE_RUN_STATUSES = [
  'done', 'failed', 'canceled', 'interrupted',
] as const satisfies readonly NodeRunStatus[]

// 全部合法转移。新加 status 或新加事件时编译器在 switch
// exhaustiveness 处报错（见下面的 nextNodeRunStatus）。
export type NodeRunEvent =
  | { kind: 'mark-running' }                  // pending → running
  | { kind: 'mark-done' }                     // running → done
  | { kind: 'mark-failed'; reason: string }   // pending|running|awaiting_* → failed
  | { kind: 'mark-canceled'; reason: string } // 任何非终态 → canceled
  | { kind: 'mark-interrupted' }              // 任何非终态 → interrupted
  | { kind: 'park-review' }                   // pending|running → awaiting_review
  | { kind: 'park-human' }                    // pending|running → awaiting_human
  | { kind: 'approve-review' }                // awaiting_review → done
  | { kind: 'iterate-review' }                // awaiting_review → pending
  | { kind: 'reject-review' }                 // awaiting_review → pending
  | { kind: 'resume-clarify' }                // awaiting_human → running
  | { kind: 'cancel-by-supersede' }           // pending|running → canceled
                                              //（review iterate/reject 时
                                              //  mint 新 retry 把老行标 canceled）

export class IllegalNodeRunTransition extends Error {
  constructor(
    public readonly from: NodeRunStatus,
    public readonly event: NodeRunEvent['kind'],
    extra?: string,
  ) {
    super(`illegal node_run transition: ${from} -X-> via ${event}${extra ? ` (${extra})` : ''}`)
  }
}

export function nextNodeRunStatus(
  cur: NodeRunStatus,
  ev: NodeRunEvent,
): NodeRunStatus {
  // 表驱动 + exhaustiveness。注意：从终态出向永远抛 IllegalTransition。
  if ((TERMINAL_NODE_RUN_STATUSES as readonly NodeRunStatus[]).includes(cur)) {
    throw new IllegalNodeRunTransition(cur, ev.kind, 'cur is terminal')
  }
  switch (ev.kind) {
    case 'mark-running':
      if (cur === 'pending') return 'running'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-done':
      if (cur === 'running') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-failed':
      if (cur === 'pending' || cur === 'running' ||
          cur === 'awaiting_review' || cur === 'awaiting_human') return 'failed'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-canceled':
      return 'canceled'
    case 'mark-interrupted':
      return 'interrupted'
    case 'park-review':
      if (cur === 'pending' || cur === 'running') return 'awaiting_review'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'park-human':
      if (cur === 'pending' || cur === 'running') return 'awaiting_human'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'approve-review':
      if (cur === 'awaiting_review') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'iterate-review':
    case 'reject-review':
      if (cur === 'awaiting_review') return 'pending'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'resume-clarify':
      if (cur === 'awaiting_human') return 'running'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'cancel-by-supersede':
      if (cur === 'pending' || cur === 'running') return 'canceled'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    default: {
      // exhaustiveness：未来加事件时这里编译报错
      const _exhaustive: never = ev
      void _exhaustive
      throw new IllegalNodeRunTransition(cur, (ev as { kind: string }).kind)
    }
  }
}
```

### CAS 写入 helper

`packages/backend/src/services/lifecycle.ts`：

```ts
export async function transitionNodeRunStatus(args: {
  db: DbClient
  nodeRunId: string
  event: NodeRunEvent
  /** 额外字段一同 update（如 finishedAt / errorMessage / startedAt）。 */
  extra?: Partial<Pick<typeof nodeRuns.$inferInsert,
    'finishedAt' | 'errorMessage' | 'startedAt' | 'exitCode' | 'pid' |
    'reviewIteration' | 'clarifyIteration'>>
}): Promise<void> {
  const cur = (await args.db.select({ status: nodeRuns.status, id: nodeRuns.id })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, args.nodeRunId))
    .limit(1))[0]
  if (cur === undefined) {
    throw new NotFoundError('node-run-not-found', `node_run ${args.nodeRunId} not found`)
  }
  const to = nextNodeRunStatus(cur.status as NodeRunStatus, args.event)
  // CAS：WHERE status = expectedFrom 保证两个并发写者不会都成功。
  // SQLite UPDATE ... RETURNING 取实际受影响行数。
  const updated = await args.db
    .update(nodeRuns)
    .set({ status: to, ...(args.extra ?? {}) })
    .where(and(eq(nodeRuns.id, args.nodeRunId), eq(nodeRuns.status, cur.status)))
    .returning({ id: nodeRuns.id })
  if (updated.length === 0) {
    // 并发 race：另一个写者已经改了 status。重新读一次状态再决定如何
    // 报告——多数情况是 "duplicate decision" 这种业务上 OK 的并发。
    throw new ConcurrentNodeRunTransition(args.nodeRunId, cur.status, args.event.kind)
  }
}
```

### 改造点（grep 守卫）

`grep -rn "nodeRuns).set({ status" packages/backend/src` 当前命中 **15+
处**。每处映射到一个 event：

| 文件 | 原写法 | 新 event |
|---|---|---|
| `services/runner.ts` 起跑 | `set({ status: 'running' })` | `{kind: 'mark-running'}` |
| `services/runner.ts` 正常退出 | `set({ status: 'done', finishedAt })` | `{kind: 'mark-done'}` + extra |
| `services/runner.ts` 失败退出 | `set({ status: 'failed', errorMessage })` | `{kind: 'mark-failed', reason}` |
| `services/runner.ts` clarify park | `set({ status: 'awaiting_human' })` | `{kind: 'park-human'}` |
| `services/review.ts` dispatch park | `set({ status: 'awaiting_review' })` | `{kind: 'park-review'}` |
| `services/review.ts` approve done | `set({ status: 'done', finishedAt })` | `{kind: 'approve-review'}` + extra |
| `services/review.ts` iterate pending | `set({ status: 'pending', reviewIteration })` | `{kind: 'iterate-review'}` + extra |
| `services/review.ts` reject pending | `set({ status: 'pending', reviewIteration })` | `{kind: 'reject-review'}` + extra |
| `services/review.ts` supersede cancel | `set({ status: 'canceled', errorMessage })` | `{kind: 'cancel-by-supersede'}` + extra |
| `services/clarify.ts` answer resume | `set({ status: 'running' })` | `{kind: 'resume-clarify'}` |
| `services/task.ts` cancel | `set({ status: 'canceled' })` | `{kind: 'mark-canceled'}` |
| `services/task.ts` orphan reap | `set({ status: 'interrupted' })` | `{kind: 'mark-interrupted'}` |
| `services/shutdown.ts` graceful | `set({ status: 'canceled' })` | `{kind: 'mark-canceled'}` |
| `services/scheduler.ts` rare paths | （多处）| 对应 event |

每处仅改 3-5 行：替换 `db.update(...).set(...)` → `await
transitionNodeRunStatus({ db, nodeRunId, event, extra })`。CAS 失败的
race 由 catch `ConcurrentNodeRunTransition` 处理——多数业务上 OK，
极少数（runner 启动竞速）需要 log warn + retry / abort。

### ESLint 自定义规则（防回归）

`eslint.config.js` 增加规则 `no-direct-node-run-status-write`：扫
ASTNode 中 `db.update(nodeRuns).set(...)` 调用，若 `set()` 参数对象
含 `status` 键则报错。例外：`services/lifecycle.ts` 自己 + 一次性 fix-up
脚本 + 测试文件（路径白名单）。

---

## P-2：跨 kind 普适操作走 handler 表

### 表 + 类型

新文件 `packages/shared/src/node-kind-behavior.ts`：

```ts
import { type NodeKind } from './schemas/workflow'

export type RetryCascadeBehavior = 'mint-placeholder' | 'skip'
export type LimitsBehavior = 'enforce-time-budget' | 'opt-out'
export type OrphanReapBehavior = 'mark-interrupted' | 'leave-alone'
export type GcBehavior = 'gc-with-task' | 'pin'
export type ShutdownBehavior = 'graceful-abort' | 'no-op'

export interface NodeKindBehavior {
  retryCascade: RetryCascadeBehavior
  limits: LimitsBehavior
  orphanReap: OrphanReapBehavior
  gc: GcBehavior
  shutdown: ShutdownBehavior
}

export const NODE_KIND_BEHAVIORS: Record<NodeKind, NodeKindBehavior> = {
  'agent-single': {
    retryCascade: 'mint-placeholder',
    limits: 'enforce-time-budget',
    orphanReap: 'mark-interrupted',
    gc: 'gc-with-task',
    shutdown: 'graceful-abort',
  },
  'agent-multi': { /* 同 agent-single */ },
  'wrapper-git': { /* 同 agent-single，但 limits/gc 视 wrapper 状态 */ },
  'wrapper-loop': { /* 同 wrapper-git */ },
  'review':  { retryCascade: 'skip', limits: 'opt-out', orphanReap: 'leave-alone',
               gc: 'pin', shutdown: 'no-op' },
  'clarify': { retryCascade: 'skip', limits: 'opt-out', orphanReap: 'leave-alone',
               gc: 'pin', shutdown: 'no-op' },
  'input':   { retryCascade: 'skip', limits: 'opt-out', orphanReap: 'leave-alone',
               gc: 'gc-with-task', shutdown: 'no-op' },
  'output':  { retryCascade: 'skip', limits: 'opt-out', orphanReap: 'leave-alone',
               gc: 'gc-with-task', shutdown: 'no-op' },
} satisfies Record<NodeKind, NodeKindBehavior>
// `satisfies` 确保 NodeKind 任何新增 case 都强制填表（编译错）
```

### 改造点

- **`services/task.ts` retryNode** 把 RFC-052 写死的
  `NON_PROCESS_KINDS` Set 改成查表：
  ```ts
  if (NODE_KIND_BEHAVIORS[k].retryCascade === 'mint-placeholder') targets.add(id)
  ```
- **`services/limits.ts` enforceLimits** 在 task-level 算 budget 时已经
  按 task 算（不分 node），不需要改。但**新加** node-level budget（如
  未来 per-node timeout）会用 `limits === 'enforce-time-budget'`。
- **`services/orphans.ts` reapOrphanRuns** 当前所有 `status='running'`
  的 node_run 都标 interrupted；review/clarify 行不会是 running，但
  `awaiting_*` 行也算"daemon 重启后未完成"，是否要标 interrupted？
  当前**不标**——review/clarify 等用户外部输入，重启后状态不变。这条
  设计上现在就对，但**没有显式表态**。改造后表里 `orphanReap:
  'leave-alone'` 把这条隐含决定文档化。
- **`services/gc.ts` runWorktreeGc** 在 task 完成后回收 worktree；
  `gc: 'gc-with-task'` 全 kind 都是这个，没差异。`pin` 是 placeholder
  for 未来"长期 pinned by review pending"语义（不在本 RFC 实现）。
- **`services/shutdown.ts` gracefulShutdown** 调 `abortAllActiveTasks`；
  review/clarify 不算 active（没有 controller），自然不动。表里
  `shutdown: 'no-op'` 把这条文档化。

### 编译期保护

`satisfies Record<NodeKind, NodeKindBehavior>` 保证：
1. 任何新加的 NodeKind 必须填入这个表（缺 key → TS 报错）；
2. 任何新加的 behavior 维度（NodeKindBehavior 加字段）必须给每个 kind
   填上（缺 field → TS 报错）。

---

## P-3：双层 invariant 启动扫 + 周期扫

### 检查的不变量

- **R1 review 双层**：对每个 review 节点 + iteration，存在 doc_version
  decision='approved' ⟹ 对应 node_run.status='done'。
- **R2 review 双层（反向）**：对每个 review 节点 node_run.status='done'
  ⟹ 存在一条对应的 doc_version decision ∈ {'approved'}（其它决策类型
  不导致 done，approve 是 done 的唯一原因）。
- **C1 clarify 双层**：clarify_sessions.status='closed' ⟹ 对应
  node_run.status ∈ {'done', 'running'}（closed 后 runner 接管会进
  running 再 done；不应停在 awaiting_human）。
- **T1 task ↔ node_run**：tasks.status='awaiting_review' ⟹ 存在至少一
  个 node_run.status='awaiting_review' 属于这个 task。
- **T2 task ↔ node_run（对偶）**：tasks.status='awaiting_human' ⟹
  同上但用 awaiting_human。
- **T3 task done**：tasks.status='done' ⟹ 所有 `output` 节点的
  node_run.status='done'。
- **U1 单一活跃**：对每个 (task, nodeId, iteration) 至多 1 行
  status='awaiting_review' 或 'awaiting_human'。

### 新表 lifecycle_alerts（migration 0028）

```sql
CREATE TABLE lifecycle_alerts (
  id          text PRIMARY KEY,
  task_id     text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule        text NOT NULL,                    -- 'R1' / 'C1' / 'T1' / 'U1' ...
  severity    text NOT NULL,                    -- 'error' | 'warning'
  detail      text NOT NULL,                    -- JSON: 涉及哪些行
  detected_at integer NOT NULL,
  resolved_at integer
);
CREATE INDEX idx_lifecycle_alerts_task ON lifecycle_alerts (task_id, detected_at);
CREATE INDEX idx_lifecycle_alerts_open ON lifecycle_alerts (resolved_at, severity);
```

### 服务

`packages/backend/src/services/lifecycleInvariants.ts`：

```ts
export async function runLifecycleInvariants(args: {
  db: DbClient
  taskScope?: { taskId: string } | { since: number } | { all: true }
}): Promise<LifecycleAlertRow[]>
```

返回的 alert row 一并 upsert 到 `lifecycle_alerts` 表（rule + task_id 唯
一）。已 resolved 的旧 row 不重新触发；新发现的 row severity=error 写
ERROR 日志 + 触发 `tasksListBroadcaster` 的 `lifecycle.alert` 事件。

### 调度

- daemon 启动 ~5s 后跑一次 `{all: true}`（避免 startup 阻塞）；
- `BackgroundTasks` 每小时跑一次 `{since: now - 2h}`（增量）；
- 单 task scope `{taskId}` 暴露给路由 `POST /api/tasks/{id}/diagnose`
  供 UI "诊断" 按钮调。

---

## P-6：stuck-task detector

### 检测规则

`task.status` 维持 > N 分钟（默认 30）无新 `node_run_events` 写入，且：

- **S1**：status='awaiting_review' 但**没有任何 pending doc_version**
  关联此 task；
- **S2**：status='awaiting_human' 但**没有任何 open clarify_session**；
- **S3**：status='running' 但**所有 node_run 都已落终态**（scheduler
  应当推进却没推进）；
- **S4**：status='pending' > 5 分钟（应当被 daemon pickup 而没被）。

### 服务

`packages/backend/src/services/stuckTaskDetector.ts`：每 5 分钟跑，命
中规则 → 写 `lifecycle_alerts` rule='S1'/'S2'/'S3'/'S4' + 触发 WS。

### 前端 UI

- 任务详情页 header 加 `<StuckTaskBanner>` 组件，从
  `/api/tasks/{id}/alerts` 拉当前 task 的开放 alerts，展示红章 + 描述
  + 一个 "Diagnose" 按钮。
- "Diagnose" 弹出 `<TaskDiagnosePanel>`，调
  `POST /api/tasks/{id}/diagnose` 拿当前实时的 invariant 检查结果（不
  仅依赖周期扫的 stale 结果），展示每条 invariant 状态 + 涉及的 row id。
- i18n key 新增 `tasks.diagnose.*`（zh/en 对称）。

非目标：UI 不提供"修复"按钮——修复仍走人工 fixup 脚本（RFC-052 已
立了模板，未来类似 bug 各立各的）。UI 只提供"察觉"。

---

## 与现有模块的耦合

- **`services/scheduler.ts`** runScope 的 `latestPerNode` 不动；这是
  scheduler 内部的 row 挑选器，RFC-052 已经验证其语义在与 dispatch
  统一后是对的。本 RFC 不重写 scheduler。
- **`services/review.ts` / `services/clarify.ts`** 改的是写 status 的
  调用点，不动业务逻辑（iterate / approve / reject 的语义保持一致）。
- **`db/schema.ts`** 加一张 `lifecycle_alerts` 表；其它表不动。
- **WS**：`tasksListBroadcaster` 加 `lifecycle.alert` 事件；前端
  `useTasksSync` 收到后 invalidate 对应 task 的 alerts query。
- **migration**：新 migration `0028_lifecycle_alerts.sql`。drizzle-kit
  生成。

---

## 失败模式 + 边界

- **CAS 失败 race**（P-1）：两个并发 approve（用户 + 别处的某 cron）
  同时打到同一个 review，先到的成功；后到的 CAS 失败，submitReview
  Decision 路径已经有 status check 在前置（review.ts:1045），CAS 失败
  这条理论上不会被到达。但 helper 仍提供 `ConcurrentNodeRunTransition`
  作为保险，route handler 转 409。
- **lifecycle_alerts 误报**（P-3）：增量扫的时间窗如果设太短，
  invariant 检查可能在事务 commit 之间看到中间态。**缓解**：所有
  涉及 multi-write 的 service（approve / iterate）已经天然在同一个
  drizzle 事务里；invariant 扫读到的永远是事务后状态。还要担心的是
  跨表读不在同一事务里——helper 用 `db.transaction(async (tx) =>
  { ... })` 包裹整个 invariant 检查，保证一致性快照（SQLite WAL
  支持读快照）。
- **stuck detector 误报**（P-6）：用户故意把任务挂很久（审阅一份大
  文档 24h 不动）会被 S1 命中。**缓解**：S1 要求"无新事件 + 没 pending
  doc_version"——挂着等用户 review 时**有** pending doc_version，不
  会命中。S2/S3/S4 类似。
- **历史 task 的 alert noise**：deploy P-3 后启动扫会一次性挖出仓库
  历史里所有 stuck 的 task。**缓解**：第一次扫的结果默认 severity=
  'warning' 而非 'error'，让运维有时间清理；24h 后切到 'error'。
- **migration 0028 兼容**：drizzle migrator 会自动应用，但要确认本地
  + CI + 用户机器都跑。

---

## 测试策略

PR-A 是**测试 baseline**——50-80 case，**不动**生产代码。后续 PR 必
须保持这些测试全绿。case 按 8 类组织：

### 类 1：状态转移矩阵（约 15 case）

`packages/backend/tests/lifecycle-transition-matrix.test.ts`

按 (status, event) 笛卡尔积，每个组合一条 case：
- 8 个 status × 12 个 event = 96 个组合；
- 标记每个组合是"合法"还是"非法"——合法的断言转移后 status 正确，
  非法的断言抛 `IllegalNodeRunTransition`；
- PR-A 落"96 条 expect 列表"的 table-driven test，PR-B 引入 helper
  后这条 table 变成对 `nextNodeRunStatus()` 的直接断言。

### 类 2：多行 dispatch 一致性（约 10 case）

`packages/backend/tests/dispatch-multi-row-consistency.test.ts`

每条 case 构造 (clarifyIter, retryIndex, status) 三元组**对**：
- (0,0,done) + (0,1,failed_placeholder) → dispatch 短路 ok
- (1,0,pending) + (0,1,done) → scheduler 选 clarify rerun，dispatch
  跟上
- (0,0,canceled superseded) + (0,1,awaiting_review) → dispatch 选
  retry=1 ...
- 等等。每条都同时断言：scheduler.latestPerNode 选的 row id ==
  dispatch 操作的 row id。

### 类 3：双层 invariant（约 10 case）

`packages/backend/tests/lifecycle-invariants-review.test.ts`
`packages/backend/tests/lifecycle-invariants-clarify.test.ts`

每条 invariant（R1/R2/C1/T1/T2/T3/U1）至少一条"satisfied"+ 一条
"violated"，断言 `runLifecycleInvariants()` 返回的 alert 数组准确
区分。PR-A 没有 helper 时，写 utility 直接 SQL 检查；PR-D 引入
helper 后切换到 helper。

### 类 4：retry cascade 全 kind 矩阵（约 8 case）

`packages/backend/tests/retry-cascade-kind-matrix.test.ts`

8 个 NodeKind × "在下游 / 在 runRow.nodeId" 2 个位置 = 16 个组合，
锁住 retryNode mint 行的 kind 过滤。RFC-052 已有 2 case，补齐其余。

### 类 5：resume 幂等 + race（约 8 case）

`packages/backend/tests/resume-task-idempotent.test.ts`

- resumeTask 连续调两次 → 不重复 mint row、不重复触发 scheduler；
- 用户 approve A → 同一 task 上别处 cancel → resume 的状态如何；
- daemon 重启时 reapOrphanRuns + resumeTask 的顺序与幂等；
- 等等。

### 类 6：loop / fan-out / wrapper 嵌套（约 10 case）

`packages/backend/tests/lifecycle-wrapper-nested.test.ts`

- review inside loop wrapper：每个 iter 一份 doc_version + 行；
- review inside git wrapper：git 包裹的 baseline / final commit 与
  review 决策不冲突；
- fan-out inside loop：每 shard 一行 + aggregator 收尾；
- 等等。

### 类 7：approve / iterate / reject 的全字段断言（约 8 case）

`packages/backend/tests/review-decision-full-asserts.test.ts`

每条决策路径全字段断言：node_run.status / node_run.finishedAt /
doc_version.decision / doc_version.decidedAt / doc_version.commentsJson /
nodeRunOutputs（approved_doc, approval_meta）/ review_comments 删除。
锁住"决策走完后 DB 完整态" 不漏。

### 类 8：property-based 随机事件序列（约 3-5 case）

`packages/backend/tests/lifecycle-property.test.ts`

用 `fast-check`（看仓里有没有；没有的话手写一个简化版的
randomized sequencer，不引入新 dep）生成长度 5-20 的随机事件序列
（approve/iterate/reject/retry/cancel/clarify-answer/...），对每条
序列后的 DB 状态断言核心 invariant 全部成立。

⚠ 引入 fast-check 是新 dep，需要单独 approval；如果不想引入，类 8
退化为"手写 5 条精心挑选的 stress 序列"。

### 不在 PR-A 的测试

- **e2e Playwright**：本 RFC 不动前端关键流程；现有 e2e 不应回归。
- **migration smoke**：PR-D 加 lifecycle_alerts 表时单独写
  `migration-0028.test.ts`。
- **lint 自定义规则测试**：PR-B 加规则时附 `eslint-no-direct-status-
  write.test.ts`。

### 测试运行门槛

每个 PR 提交前本地跑：
1. `bun run typecheck`（三包零 error）
2. `bun run test`（套件 pass count 不下降；本 PR 新增 case 全绿）
3. `bun run lint`（三包零 warning）
4. `bun run format:check`

按 `[feedback_post_commit_ci_check]` 推完查 CI run 六 jobs。
