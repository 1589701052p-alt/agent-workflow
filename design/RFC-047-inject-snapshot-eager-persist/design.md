# RFC-047 — 技术设计

## 1. 现状回顾

`packages/backend/src/services/runner.ts:runNode` 的相关时序（行号以当前 HEAD `fd36097` 为准）：

```
~270  insert node_runs row (status=pending) — by scheduler before runNode
~318  // RFC-041 PR3: inject memory
330   let injectedSnapshot: InjectedMemorySnapshot[] | null = null
331-355  if (!envelopeFollowup) { snapshot = (await injectMemoryForRun(...)).snapshot }
356-392  else { snapshot = await loadInjectedSnapshotFromFirstAttempt(...) }
394-...  serialize OPENCODE_CONFIG_CONTENT
...      spawn opencode, wait, parse stdout, sessionCapture, etc.
744-770  read inventory snapshot file (post-process)
772-792  UPDATE node_runs SET status, finishedAt, exitCode, errorMessage,
         inventorySnapshotJson, injectedMemoriesJson, tokInput, ... WHERE id = ?
```

也就是说 `injectedSnapshot` 在第 392 行**已经决出**，但它要等到第 ~785 行那条聚合 UPDATE 才被持久化。中间 opencode 子进程可能跑几秒、几分钟、甚至几十分钟（含 review / clarify await_human），这段时间内列一直 NULL，前端 SessionTab 的 `InjectedMemoriesCard` 走"老行兼容"分支。

`useTaskSync.ts:28-29` 监听 `node.status` 事件后会 invalidate `['tasks', taskId, 'node-runs']`，触发 `GET /api/tasks/:taskId/node-runs` 重拉 → `rowToNodeRun` 把 `injected_memories_json` parse 成 `injectedMemories` 字段。所以只要列被写出并伴随一次 ws 事件，前端就能在运行中看到注入快照。

## 2. 改造点：runner 内增加一处早写

在 `runner.ts:392` 之后、`394` 注释之前，插入一段「早写」逻辑。语义上是把现有总 UPDATE 中 `injectedMemoriesJson:` 那一项**额外**做一次单列 UPDATE。

伪代码（最终实现以 PR diff 为准）：

```ts
// RFC-047: write injected snapshot eagerly so the Session-tab card
// becomes visible while the agent is still running. Idempotent with
// the final UPDATE at step 11 (same value, same column).
try {
  await opts.db
    .update(nodeRuns)
    .set({
      injectedMemoriesJson:
        injectedSnapshot === null ? null : JSON.stringify(injectedSnapshot),
    })
    .where(eq(nodeRuns.id, opts.nodeRunId))
  // [rfc047/inject-snapshot-eager-write] tag for grep guard + event stream
  log.info('inject-snapshot-eager-write', {
    nodeRunId: opts.nodeRunId,
    count: injectedSnapshot?.length ?? 0,
  })
  opts.onInjectedSnapshotPersisted?.(opts.nodeRunId)
} catch (err) {
  log.warn('inject-snapshot-eager-write-failed', {
    nodeRunId: opts.nodeRunId,
    error: err instanceof Error ? err.message : String(err),
  })
  // Non-fatal: the final UPDATE at step 11 still carries injectedMemoriesJson,
  // so behavior degrades exactly to RFC-046 (visible only after run ends).
}
```

`onInjectedSnapshotPersisted` 是一个新增的可选回调（参见 §3 WS 触发）。

总 UPDATE（runner.ts:772-792）那条 `injectedMemoriesJson: injectedSnapshot === null ? null : JSON.stringify(injectedSnapshot)` **不动**，作为 fail-safe 兜底（早写崩了，run 结束仍补落同值）。

## 3. WS 通知

前端 `useTaskSync` 在收到下列任一事件后会 invalidate `['tasks', taskId, 'node-runs']`：

- `task.status` / `task.done`
- `node.status`
- `node.event`

scheduler 在 runner 开始前已经 broadcast 过一次 `node.status: running`（见 `scheduler.ts:1240` 等多处 `broadcastNodeStatus`）。早写发生在那次广播之后、opencode 进程开始流式输出之前，需要**额外**一次能让前端 invalidate 的事件。两种取法：

**方案 A（首选）**：复用 `node.status: running` 再 broadcast 一次。
- 行为：在早写成功后，调一次 `broadcastNodeStatus(taskId, nodeRunId, nodeId, 'running')`。
- 缺点：状态没有真实变化，可能对未来基于状态翻转计数的逻辑有副作用——但今天 useTaskSync 仅做 invalidate，无副作用；scheduler 多处也对同一节点重复广播 `running`（loop / wrapper 路径），与本 RFC 行为同构。
- 优点：零新 WS 类型，零 shared schema 改动。

**方案 B**：发一条 `node.event` 类型消息，payload 表明是 inject 落库通知。
- 现有 `TaskWsMessage` union 里 `node.event` 已存在（`useTaskSync.ts:31`）。直接 broadcast 一条 `{ type: 'node.event', nodeRunId, nodeId, kind: 'memory.inject.persisted' }`。
- 优点：语义清晰，未来如果加专属 UI（"Live · 注入完成"）可以直接订这条。
- 缺点：要确认 `TaskWsMessage` 的 `node.event` 定义是否对 `kind` 字段开放——若需要扩 schema 就是额外改动。

**最终采用方案 A**。零 schema 改动 / 零前端代码改动 / useTaskSync 已经 invalidate node-runs，最小侵入。

调用点：早写 try 块成功路径末尾，紧跟 log.info 后：

```ts
broadcastNodeStatus(opts.taskId, opts.nodeRunId, opts.nodeId, 'running')
```

`broadcastNodeStatus` 当前是 scheduler 私有 helper（`scheduler.ts:1771`），需要做一次最小重构：要么从 scheduler 里 export 出来，要么把 broadcaster 调用直接搬进 runner（已有 `taskBroadcaster` / `TASK_CHANNEL` import 不存在 — 需新增 import）。倾向把 helper 抽到 `services/wsHelpers.ts` 或直接在 runner 里 inline 调 `taskBroadcaster.broadcast`，避免 runner ↔ scheduler 形成循环依赖。

> 注意：runner 当前不持有 `nodeId`——scheduler 调 `runNode` 时只传 `nodeRunId`。需要把 `nodeId` 通过 `RunNodeOptions` 显式带过来，或者用一次 `SELECT nodeId FROM node_runs WHERE id = ?` 查回（多一次小 query，但路径冷）。倾向加 `nodeId` 到 `RunNodeOptions`（scheduler 调用处都已知 nodeId）。

## 4. 失败模式

- **早写 DB throw**：catch 内 warn + 继续 run；总 UPDATE 在 run 结束补落（≡ RFC-046 行为）。前端这次 run 仍要等到结束才看见卡片，但 run 本身不退化。
- **早写之后 spawn opencode 失败**：runner 当前路径会跳到错误处理走总 UPDATE 写 status=failed + finishedAt + 注入列。早写已经把 inject 列写好，总 UPDATE 用同值再写一次，无副作用。
- **早写之后 daemon 重启**：节点状态走 `interrupted`，scheduler 不会重新 inject——column 已写入，admin 在恢复 / 复盘时仍能看到曾经注入的快照。
- **followup attempt 0 行不存在**（race）：`loadInjectedSnapshotFromFirstAttempt` 返 null，早写也写 null；最终行为与 RFC-046 §3.2 一致。
- **早写并发**：每个 `node_runs.id` 由单一 runner 协程独占，无并发写同一行。早写与总 UPDATE 由同一协程顺序发出，列值最终一致。

## 5. 接口契约

**`RunNodeOptions` 改动**：加一个必填字段 `nodeId: string`（scheduler 已经持有），让 runner 不必再 SELECT 一次。其余字段不动。

**runner 行为合约新增条款**：
- "RFC-047: after the inject step (success or followup-inherit) and before the opencode spawn, the runner MUST emit a single UPDATE to `node_runs.injected_memories_json` for the current row, followed by a `node.status: running` broadcast. Failure of either step degrades to legacy RFC-046 (visible only after run ends)."

**前端**：零代码改动。`InjectedMemoriesCard` 已经按列值渲染。Optionally 可以在卡片旁加一个 `Live` 灰色 chip 来标识"运行中已注入"——本 RFC 不强制，留作后续小补丁。

## 6. 与 runtime inventory 的对比 / caveat

`inventory_snapshot_json`（RFC-029）来自 opencode dump 插件在子进程退出时落到 `runRoot` 的 JSON 文件，结构性必须等子进程结束才能读。要做"运行中实时显示 inventory"需要改 opencode 插件（让它在启动时就把基础 inventory dump 一次，运行中追加 delta），属于 RFC-029 / opencode 上游变更，**不在本 RFC 范围**。

本 RFC 落地后，UX 状态对比：

|        | inject 快照（本 RFC） | runtime inventory |
| ------ | -------------------- | ----------------- |
| 运行中 | ✅ 可见               | ❌ 仍 NULL        |
| 结束后 | ✅ 可见               | ✅ 可见           |

如果未来要补齐 inventory 实时性，独立立 RFC。

## 7. 测试策略

新增 `packages/backend/tests/runner-inject-snapshot-eager-write.test.ts` 覆盖：

1. **正常路径**：mock `injectMemoryForRun` 返回 snapshot，mock `spawn` 阻塞（模拟 opencode 仍在跑）；调用 `runNode` 不等其完成 → 在 spawn 阻塞期间 SELECT `node_runs.injected_memories_json` 应已有期望值。
2. **失败降级**：mock `db.update` 在早写处 throw 一次 → runner 不抛 + 总 UPDATE 仍把 `injectedMemoriesJson` 落库。
3. **followup-inherit**：`opts.envelopeFollowup = true` + attempt 0 行已有 snapshot → 早写 column 等于 attempt 0 的 snapshot。
4. **null snapshot**：inject 返回 `null`（block 未拼出）→ 早写写 null（与已有列状态一致，不需要 special-case）。
5. **WS 广播**：spy `taskBroadcaster.broadcast`，确认早写成功后被调一次且 payload `type === 'node.status' && status === 'running'`（除 scheduler 那次以外的额外一次；用 broadcast call 序断言）。

**代码层 grep 守卫**新增 `runner-inject-snapshot-eager-write-source.test.ts`：grep `packages/backend/src/services/runner.ts` 必须出现：
- `'inject-snapshot-eager-write'` 字面量（log tag）正好 1 次（warn 用 `-failed` 后缀，独立 1 次）；
- 早写 UPDATE 调用点必须在总 UPDATE 之前；
- 总 UPDATE 仍包含 `injectedMemoriesJson:`。

**回归**：RFC-046 既有 `memory-inject*.test.ts` / `injected-memories-card.test.ts*` / `task-service-node-run-projection-injected.test.ts` 等不动且零退化。

**前端**：不引入 frontend 测试改动（卡片行为没变）。

## 8. 落地清单（详见 plan.md）

1. `RunNodeOptions` 加 `nodeId`，scheduler 所有调用点显式传入。
2. runner 在 inject 完成后插入早写 + WS broadcast；总 UPDATE 不变。
3. 新增 1 个单元测试文件（5 case）+ 1 个 grep 守卫文件。
4. STATE.md / plan.md 索引更新。
5. 单 PR：`feat(runner): RFC-047 早写注入快照让 Session tab 运行中可见`。
