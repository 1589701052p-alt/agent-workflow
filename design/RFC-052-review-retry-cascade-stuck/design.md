# RFC-052 — review retry-cascade 卡死（技术设计）

> 配套 [proposal.md](./proposal.md)。所有引用行号以 `main@HEAD` 为准。

## 现场快照

```
tasks.id                = 01KS1N8WVZWE8FTR4K9WSETRNW
tasks.status            = awaiting_review
node_runs:
  rev_976wza   retry=0  status=awaiting_review   finished_at=1779329208140  (= v5.decidedAt)
  rev_976wza   retry=1  status=failed            error_message='queued for retry'
  agent_p69bj1 retry=0..9                         retry=9 done @1779288901848
  clarify_2x0gwq retry=0 done; retry=1 failed 'queued for retry'
  out_4mt4t1   retry=0 (failed unrelated); retry=1 failed 'queued for retry'
doc_versions:
  v1..v4 iterated
  v5  approved  decided_at=1779329208139  review_iteration=4
  v6  approved  decided_at=1779329213922  review_iteration=4   ← phantom
```

## 根因分解

### A. `retryNode` 给非进程节点 mint `queued for retry` 占位行

`packages/backend/src/services/task.ts:641-669`：

```ts
const targets = new Set<string>([runRow.nodeId])
for (const id of downstream) targets.add(id)
for (const nodeId of targets) { /* insert nodeRuns retryIndex+1 status=failed */ }
```

`downstream` 是按 edges DFS 出的所有下游 nodeId 集合。当用户对一个 agent
节点点 Retry，rev_976wza / clarify_* / out_* 全被纳入 targets。这些 kind
的 `runOneNode` 路径（`scheduler.ts:640, 665-674`）压根不"运行"
node_run row、不更新 status —— mint 出来的占位行从此**永远停在
`status=failed, errorMessage='queued for retry'`**。

### B. `dispatchReviewNode` 的 row 选择与 scheduler 不一致 + 无条件复位

`packages/backend/src/services/review.ts:386-425`：

```ts
const reviewRuns = await db.select().from(nodeRuns).where(...)
const reuse = reviewRuns.find(r => r.parentNodeRunId === null)   // ← 取第一个，按 SQL 默认顺序
if (reuse !== undefined) {
  reviewNodeRunId = reuse.id
  reviewIteration = reuse.reviewIteration
  if (reuse.status !== 'awaiting_review') {
    await db.update(nodeRuns)
      .set({ status: 'awaiting_review', startedAt: reuse.startedAt ?? Date.now() })
      .where(eq(nodeRuns.id, reviewNodeRunId))
  }
}
```

两个相互独立的 bug：

1. **挑选器**：scheduler 那边用 `isFresherNodeRun`（clarifyIter →
   retryIndex → ulid，`scheduler.ts:295-307`）选 latestPerNode；
   dispatchReviewNode 这里用 `Array.find`，凭 SQL 默认顺序（实际是
   插入顺序，即 retry=0 在前）。当 task 经历过上游级联，scheduler 认为
   latest 是 retry=1，dispatchReviewNode 操作的是 retry=0，**两个分支看
   的不是同一行**。
2. **状态机**：选出 row 之后无条件比 `!== 'awaiting_review'` 就改回。
   `done` / `canceled` / `failed` 这种终态会被一并复位。本应该是
   "若该行已落终态，整个 review 就已经走完，dispatch 直接返回 ok"。

### C. approved 分支的 outputs insert 不幂等

`packages/backend/src/services/review.ts:1109-1148`：

```ts
if (args.decision === 'approved') {
  ...
  await args.db.insert(nodeRunOutputs).values([
    { nodeRunId, portName: 'approved_doc', content: ... },
    { nodeRunId, portName: 'approval_meta', content: ... },
  ])                                                // ← 撞 PK 抛 SqliteError
  await args.db.update(nodeRuns).set({ status: 'done', finishedAt: decidedAt })
    .where(eq(nodeRuns.id, args.nodeRunId))         // ← 永不到这里
  ...
  return { ..., resumeRequired: true }
}
```

`node_run_outputs.PRIMARY KEY(node_run_id, port_name)`。**首次** approve
已经写入了 (retry=0, approved_doc) 和 (retry=0, approval_meta)。bug B 把
retry=0 拉回 awaiting_review、建出 v6，用户**再次** approve 时第二条
insert 撞 PK 抛出，使得 row update 永远不发生、`resumeRequired` 也不再
传给路由层 —— task / row 的状态全部冻在中间态。

## 修复设计

修三层。可以按优先级独立落 PR，但建议一起出，给 task 卡死 user 一个完整
答复。

### Fix-1 — `dispatchReviewNode` 选行 + 终态短路（review.ts）

```ts
// 替换 reviewRuns.find(...) 那段
let reuse: (typeof reviewRuns)[number] | undefined
for (const r of reviewRuns) {
  if (r.parentNodeRunId !== null) continue
  if (isFresherNodeRun(r, reuse)) reuse = r
}

if (reuse !== undefined) {
  // 终态短路：review 已经走完，不再 mint v(n+1)、不再回弹状态。
  if (reuse.status === 'done' || reuse.status === 'canceled') {
    broadcastReviewCreated(...)  // 不发；或者保留 broadcast-noop（见下）
    return { kind: 'ok', summary: '', message: '' }
  }
  reviewNodeRunId = reuse.id
  reviewIteration = reuse.reviewIteration
  if (reuse.status !== 'awaiting_review') {
    await db.update(nodeRuns)
      .set({ status: 'awaiting_review', startedAt: reuse.startedAt ?? Date.now() })
      .where(eq(nodeRuns.id, reviewNodeRunId))
  }
}
```

注意：

- 与 scheduler 用同一个 `isFresherNodeRun`（已 export）选 row。
- 进入 `done` 终态返回 `kind: 'ok'`，让 `runOneNode` 把这个节点 mark
  为 completed —— 下游可以正常推进。
- `failed` 不进短路：那条占位行可能就是 Fix-2 想消灭的目标；如果上游
  确实没修，scheduler 仍会让 review 重新走一轮 awaiting_review，符合
  原意。
- `runScope` 的 `latestPerNode` 已经把 `status === 'done'` 视为
  pre-completed（`scheduler.ts:432-437`），所以理论上不会再走到 dispatch；
  但这是 latest 比较器的下游、不是 dispatch 自己的下游，挂个双保险更稳。

### Fix-2 — `retryNode` 不再为非进程节点 mint 占位（task.ts）

```ts
const NON_PROCESS_KINDS = new Set(['review', 'clarify', 'output', 'input'])

const downstreamProcess = downstream.filter((id) => {
  const node = definition.nodes.find((n) => n.id === id)
  return node !== undefined && !NON_PROCESS_KINDS.has(node.kind)
})
const targets = new Set<string>([runRow.nodeId, ...downstreamProcess])
```

注意：

- 这里**只**剔除下游里的非进程节点。如果用户直接对一个 review / clarify
  节点点 Retry，那是另一种语义（rerun upstream），走 review.ts 的
  iterate-style 路径，不进这里。
- wrapper-git / wrapper-loop 仍按进程节点处理：它们有自己的 node_run row +
  状态机，要级联。
- `definition` 来源：retryNode 已经从 task.workflowSnapshot 反解出
  `WorkflowDefinition`（见同函数上方）。无需新增 IO。
- 为确保 type-safe，新加一个 `shared` 端的 helper
  `isProcessNodeKind(kind: WorkflowNodeKind): boolean`（true iff kind ∈
  {agent, agent-multi, wrapper-git, wrapper-loop}）。位置：
  `packages/shared/src/workflow-kind.ts`，已有 kind 枚举的话直接补一个
  predicate。

### Fix-3 — approved 分支幂等（review.ts）

```ts
// 把两条 values 拆成 ON CONFLICT 形式：
await args.db
  .insert(nodeRunOutputs)
  .values({ nodeRunId: args.nodeRunId, portName: 'approved_doc', content: approvedDocContent })
  .onConflictDoUpdate({
    target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
    set: { content: approvedDocContent },
  })
await args.db
  .insert(nodeRunOutputs)
  .values({ nodeRunId: args.nodeRunId, portName: 'approval_meta', content: meta })
  .onConflictDoUpdate({
    target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
    set: { content: meta },
  })
await args.db.update(nodeRuns).set({ status: 'done', finishedAt: decidedAt })
  .where(eq(nodeRuns.id, args.nodeRunId))
```

drizzle/sqlite 已支持 `onConflictDoUpdate`（grep 现有用法验证）；若验证
后发现版本不支持，退化方案是先
`db.delete(nodeRunOutputs).where(and(eq(nodeRunId, x), inArray(portName, ['approved_doc', 'approval_meta'])))`
再 insert。

注意：

- 即便 outputs insert 出现"重复" upsert，行为也仅是把同一份 content 重写
  一次，对下游 resolvePortContent 完全幂等。
- 修了 Fix-1 之后这条路径**理论上**不会被二次踩中，但作为最后一道
  防线保留 —— 任何未来的边缘并发都不会再把 node_run 留在中间态。

### Fix-4 — 一次性 task 修复

写一段 `scripts/fixup-rfc052-stuck-review.ts`（或一段 SQL）做以下事：

```sql
-- 1. 把 retry=0 推到终态 done。
UPDATE node_runs
SET status = 'done', finished_at = unixepoch() * 1000
WHERE id = '01KS1PWMB07JQ4SMWG44G7XXXE';

-- 2. 清掉 retry=1 占位（rev_976wza / clarify_2x0gwq / out_4mt4t1）。
DELETE FROM node_runs
WHERE id IN (
  '01KS2PTM6PW2FCTSW7HYK4Y4M0',  -- rev_976wza retry=1
  '01KS2PTM6N0N5TMWRAVG3MRJPB',  -- clarify_2x0gwq retry=1
  '01KS2PTM6QFFH6M5DH61WQ1JGR'   -- out_4mt4t1 retry=1
);

-- 3. 补 review 的 approved_doc / approval_meta（如果缺）。
INSERT OR REPLACE INTO node_run_outputs VALUES ...;

-- 4. 推动 task：把 status 改为 pending，让 resumeTask 重新跑下游 output。
UPDATE tasks SET status='pending', error_summary=NULL, error_message=NULL, failed_node_id=NULL
WHERE id='01KS1N8WVZWE8FTR4K9WSETRNW';
```

实际执行前先在脚本里 `SELECT` 一次确认 row 数对得上，避免误删；再走
`resumeTask` 让 scheduler 把 out_4mt4t1 跑完、把 task 推到 done。

> 备选：如果 v6.approved 的 `approved_doc` content 与 v5 一致，可以保留
> v6（语义上"用户的最后一次确认"），把 v5 改成 superseded 之类；但
> doc_versions 表当前没有 superseded 这一档，最低成本是直接保留两条
> approved row，UI 不会再爆（详情页只看最近 approved 的那条）。

## 与现有模块的耦合

- `services/scheduler.ts` —— 不动，但 `isFresherNodeRun` 被 dispatchReviewNode
  复用（已经导入过）。
- `services/task.ts` —— retryNode 的下游集合算法改一行；
  `runTask` 的 e2e 路径不动。
- `services/review.ts` —— dispatchReviewNode + submitReviewDecision 各改
  10 来行。
- `shared` —— 新增 / 扩展 `isProcessNodeKind` 谓词（如果还没有的话）。
- WS 广播：dispatchReviewNode 在终态短路时**不**触发 review.created
  广播；客户端按现有 invalidate 路径自然刷新。

## 失败模式 + 边界

- **并发 approve**：两个标签页同时 approve 同一 v(n)。Fix-3 的
  upsert 保护 outputs；status 检查（`review.ts:1045`）保证第二个请求
  在 `run.status !== 'awaiting_review'` 时正常返回 409，前端按现有
  error toast 处理。
- **fan-out 内含 review**：review 节点目前不被 fan-out，dispatch 里
  `parentNodeRunId !== null` 的子行被跳过（line 1224）—— 不变。
- **iterate 与 retry 同时发生**：iterate 在 review.ts:1310 把 review 的
  status 改回 pending；如果同时上游有 retry storm，target 集合里没有
  review 了（Fix-2），不会再 mint review 占位行；dispatchReviewNode 看到
  review row 为 pending → 走正常 awaiting_review 路径。OK。
- **historical tasks**：已有的占位行（status=failed, 'queued for retry'）
  在没有触发 Fix-4 的 task 里还在。如果它们没有上面那个第一次 approve
  的特殊路径，dispatchReviewNode 仍可能挑到错行——所以 Fix-1 的
  "用 isFresherNodeRun 重选"是必要的，不只是 Fix-2 的预防性修补。

## 测试策略

新增测试，所有放 `packages/backend/test/`。

1. `review-dispatch-terminal-state.test.ts`（Fix-1）：
   - 构造 task：1 个 agent + 1 个 review，review row retry=0 status=done。
   - 给同 task 再造 review row retry=1 status=failed（模拟级联占位）。
   - 调 `dispatchReviewNode` → 期望返回 `{kind: 'ok'}`、不动 retry=0 状态、
     不创建新 doc_version。
2. `review-dispatch-row-selection.test.ts`（Fix-1）：
   - 构造 review row retry=0 status=pending、retry=1 status=awaiting_review。
   - 调 `dispatchReviewNode` → 期望选 retry=1（isFresherNodeRun winner），
     不动 retry=0、不重复 mint doc_version。
3. `retry-node-no-review-cascade.test.ts`（Fix-2）：
   - workflow agent→clarify→review→output，对 agent 调 retryNode。
   - 期望 retry+1 行**只**出现在 agent（+ wrapper 若有），其他 kind 不
     被 mint。
4. `review-approve-idempotent.test.ts`（Fix-3）：
   - 构造 review row awaiting_review + 一份 pending doc_version。
   - 先手动 insert `(nodeRunId, 'approved_doc', 'old')` 到 node_run_outputs
     模拟"上一次 approve 失败留下的残骸"。
   - 调 submitReviewDecision approved → 期望不抛、outputs 被 update 成新
     content、node_run.status='done'、finishedAt 被写入。
5. `task-01KS1N8W-fixup.test.ts`（Fix-4，可选）：仅当我们把 fix-up 落
   成可重跑脚本时加。

回归 / 兼容：

- 不动 `isFresherNodeRun` 语义，相关 lock-in test
  （`review-iterate-inherits-clarify-iteration.test.ts` 等）不应回归。
- 不动 review iterate / reject 路径；现有 sibling cascade /
  rollback test 不应回归。
- `bun run typecheck && bun run test && bun run format:check` 全绿；
  按 [feedback_post_commit_ci_check] 推完查 CI run。
