# RFC-048 — 技术设计

## 1. 现状回顾（HEAD = `fd36097`）

- `runner.ts:506-623` spawn opencode child → 并发 `stdoutPump` + `stderrPump`，事件按行写 `node_run_events`，`parent_session_id=null`。
- `runner.ts:727-742` 子进程退出后调一次 `captureChildSessions`：
  - 打开 opencode XDG SQLite（`resolveOpencodeDbPath` → `~/.local/share/opencode/opencode.db`）。
  - BFS `session.parent_id` 树。
  - 对每个 child sessionId SELECT 全部 message + part，调 `transcodeOpencodeRowsToEvents`（`sessionCapture.ts:123-172`）转成 NDJSON envelope，整批 INSERT。
  - 兄弟 nodeRun 已写过的 sessionId 整段 skip（`loadSiblingsCapturedSessionIds`）。
- 前端 `SubagentBlock.tsx:19-20` 已对 `child === null || child.captureComplete === false` 渲染「captureMissing + outputFallback」状态——意味着部分到位的 child 也能正常展示。

差距：BFS 只跑一次。本 RFC 把它变成"运行中 N 次（增量）+ 退出后 1 次（兜底）"。

## 2. 关键新组件：`liveSubagentCapture`

放在 `packages/backend/src/services/subagentLiveCapture.ts`（独立文件，与 `sessionCapture.ts` 解耦——后者仍保留 post-run 全量 capture 语义；本 RFC 复用其 `transcodeOpencodeRowsToEvents` / `resolveOpencodeDbPath` / `loadSiblingsCapturedSessionIds` 三个导出物）。

接口草案：

```ts
export interface LivePollOptions {
  nodeRunId: string
  taskId: string
  /** root opencode session id; null until stdoutPump first sees it. */
  getRootSessionId: () => string | null
  db: DbClient
  log?: Logger
  opencodeDbPath?: string   // tests
  pollMs: number            // 0 = disabled
  consecutiveFailureLimit: number
  signal: AbortSignal       // tied to child.exited, see §3
  broadcastNodeEvent?: (payload: NodeEventPayload) => void
}

export interface LivePollerHandle {
  stop(): void
  /** Snapshot for tests / observability. */
  stats(): { ticks: number; insertedRows: number; failedTicks: number; disabled: boolean }
}

export function startLiveSubagentCapture(opts: LivePollOptions): LivePollerHandle
```

实现要点：

1. **延迟启动**：`pollMs = 0` 直接返回 no-op handle。否则用 `setInterval` 起 tick，但**第一个 tick 等 `getRootSessionId()` 返回非 null**——root sessionId 由 stdoutPump 在收到第一条 evt 时回填，通常子进程启动后 100-500ms 内。
2. **持有一个 readonly DB 句柄**：避免每 tick 反复 open/close 抖。第一次 open 失败计入失败计数；后续 tick 复用同一 `Database` 句柄；handle.stop() 时 close。
3. **每 tick 逻辑**：
   - 若 `disabled` 标志为 true 直接返回。
   - 取 root sessionId；为 null 直接返回。
   - BFS（同 `captureChildSessions`）拿 child session 列表。
   - 对每个 child sessionId：
     - 若在 `siblingsCapturedSessionIds`（启动时一次性 load + 不再 refresh，参见 §4）→ skip。
     - 取当前 nodeRun 已写 partId 集合（启动时建空 Set，每 INSERT 后追加）。
     - SELECT message / part rows ordered by `time_created, id`；**只过滤掉本 nodeRun 已写的 partId**——SELECT 仍取全量（schema 不支持 incremental cursor，BFS 后内存过滤是最简且正确）。
     - `transcodeOpencodeRowsToEvents` → drop 已写 partId → INSERT 剩余行 → 更新 Set。
   - 累加本 tick `insertedRows`；若 > 0 broadcast 一条 `node.event`：

     ```ts
     opts.broadcastNodeEvent?.({
       type: 'node.event',
       nodeRunId: opts.nodeRunId,
       nodeId: opts.nodeId,
       kind: 'subagent.events.appended',
       insertedRows,
       sessionIds: [...changedSessions],
     })
     ```
   - tick 抛错 → catch 内 `consecutiveFailures++`；达 limit → 置 disabled + warn `subagent-live-poll-disabled`；否则 warn `subagent-live-poll-error`。

4. **优雅停止**：`stop()` 清 `setInterval` + close DB handle + 把 `disabled = true`。runner 用 AbortSignal 把 child.exited 链接进来，`signal.addEventListener('abort', () => handle.stop())`。

## 3. runner 接入

`runner.ts:506-623` 区段改造：

```ts
// 6. Stream stdout + stderr into node_run_events.
const stdoutPump = pumpLines(child.stdout, async (line) => { ... })  // unchanged
const stderrPump = pumpLines(child.stderr, async (line) => { ... })  // unchanged

// 6b. RFC-048: spin up subagent live poller alongside the child. The
//     handle stops automatically when child.exited fires (see step 7).
const liveCtrl = new AbortController()
const livePoller = startLiveSubagentCapture({
  nodeRunId: opts.nodeRunId,
  taskId: opts.taskId,
  nodeId: opts.nodeId,                 // RFC-047 已经把 nodeId 加进 RunNodeOptions
  getRootSessionId: () => sessionId ?? null,
  db: opts.db,
  log,
  pollMs: opts.subagentLiveCapture?.pollMs ?? DEFAULT_LIVE_POLL_MS,
  consecutiveFailureLimit:
    opts.subagentLiveCapture?.consecutiveFailureLimit ?? DEFAULT_LIVE_FAIL_LIMIT,
  signal: liveCtrl.signal,
  broadcastNodeEvent: (payload) =>
    taskBroadcaster.broadcast(TASK_CHANNEL(opts.taskId), { id: -1, ...payload }),
})

// 7. Wait for exit + drain streams.
const exitCode = await child.exited
liveCtrl.abort()   // stop poller before flushing tail
livePoller.stop()  // idempotent
await Promise.all([stdoutPump, stderrPump])
```

post-run `captureChildSessions` 调用点（`runner.ts:727-742`）保留不动——它继续做完整 BFS，但 partId-level dedupe 由本 RFC 加进 `captureChildSessions`（见 §4）让它与 live poll 写过的行不重复。

## 4. `captureChildSessions` 的最小改动：partId-level dedupe

现状：post-run capture 用 `loadSiblingsCapturedSessionIds` 做的是**整 sessionId** 排除——意味着如果某个 child sessionId 还没被任何 nodeRun 写过，post-run 就把它整段 INSERT。本 RFC 把 live poll 引入后，post-run 仍会针对**本 nodeRun 已部分写过的 sessionId** 再次 INSERT 全部 part 行——会重复。

改动：

- `captureChildSessions` 新增可选 `alreadyInsertedPartIds: Map<string, Set<string>>`（按 sessionId 分桶的 partId 集合）参数。
- 若提供，则在 INSERT 前过滤掉已在集合中的 partId。
- 若不提供（pollMs=0 或其它老路径），行为字节级回退到 RFC-027（仍按 sessionId 整段 skip 兄弟，但本 nodeRun 内部不去重——因为没有 live poll 写过任何东西）。
- runner 在 post-run 调 capture 时把 `livePoller.stats().insertedPartIdsBySession`（新加 getter）传进去。

代价：`captureChildSessions` 多一个可选参数 + 一个 in-memory Set 检查；旧测试零退化。

## 5. WS 通知

新增 `node.event` payload kind `subagent.events.appended`：

```ts
{
  type: 'node.event',
  nodeRunId: string,
  nodeId: string,
  kind: 'subagent.events.appended',
  insertedRows: number,
  sessionIds: string[],
}
```

`packages/shared/src/schemas/ws.ts` 的 `NodeEventMessage` 已经有 `kind: string` 字段（参见 `useTaskSync.ts:31` 命中），不需要扩 union。前端 `useTaskSync.ts:31-35` 已经在 `node.event` 触发 invalidate `['tasks', taskId, 'node-runs']`——本 RFC 复用，零前端代码改动。

可选小补丁（不在硬验收里）：额外 invalidate `['tasks', taskId, 'node-runs', nodeRunId, 'session']` 让 SessionTab 的 `SessionBody` 也立即重拉；当前 `useTaskSync` 没显式 invalidate 这条 key，session 重拉靠的是 react-query 在切 attempt 时按 key 变化触发。如果实测发现 `/session` 接口不会跟着 `node-runs` invalidation 一起重拉（取决于 session 接口是否被 `staleTime` 钉住），加这条 invalidate；否则不动。

## 6. Config

`packages/shared/src/schemas/config.ts` 末尾加：

```ts
export const SubagentLiveCaptureSchema = z.object({
  pollMs: z.number().int().min(0).max(60_000),
  consecutiveFailureLimit: z.number().int().min(1).max(100),
})

export const DEFAULT_SUBAGENT_LIVE_CAPTURE: SubagentLiveCapture = {
  pollMs: 1500,
  consecutiveFailureLimit: 5,
}
```

挂在 `ConfigSchema` 上：`subagentLiveCapture: SubagentLiveCaptureSchema.optional()`；`ConfigPatchSchema` 同步。`cli/start.ts` 把它经 scheduler `RunNodeOptions.subagentLiveCapture` 透传到 runner。

## 7. 失败模式 / 边界

| 场景 | 行为 |
| --- | --- |
| `pollMs=0` | startLiveSubagentCapture 返回 no-op handle，行为字节级 = RFC-027 |
| opencode.db 不存在 | 首次 open throw → consecutiveFailures=1；持续直到达 limit → disabled |
| opencode 升级换 schema | SELECT throw → 同上 |
| child sessionId 还没被 BFS 看到 | tick 不做事；待下一 tick BFS 命中 |
| root sessionId 永远未填（stdout 无 sessionID 事件） | tick 全部短路 return；post-run 也短路（既有行为） |
| inline rerun（兄弟 nodeRun 已持有 child events） | 启动时 load 一次 `siblingsCapturedSessionIds` → 整段 skip → 内存 Set 不增长 → 永远 0 INSERT |
| 多个 child 同时 emit | 一次 tick 内全部 INSERT；broadcast 一条聚合 `node.event` |
| daemon 重启 | nodeRun 切到 interrupted，live poll handle 随 process 一起死；post-run 不跑（runNode 没机会到那一步）；既有 RFC-027 在 interrupted 后也不补 capture，行为一致 |
| 早写抛错 + post-run 也抛错 | RFC-027 `subagent_capture_failed` marker 写入；live poll 期间 INSERT 的部分行保留——SessionTab 显示部分到位的 child + captureMissing chip |

## 8. 与 `runner.ts:705` 上下文回流的关系

stdout 上的 `tool_use` 事件里包含 `task` 工具调用（subagent-call 的入口），`parseSessionTree.ts:259-275` 会把它转成 `subagent-call` message，引用 `childSessionId` 字段。这些事件来自 stdout，从 child 进程启动那一刻就 live；本 RFC 让 child 内部对话也 live，二者拼合就是用户感受到的"subagent 一边跑一边出"。零交互冲突。

## 9. 测试策略

### 9.1 单元（pure）

`packages/backend/tests/subagent-live-capture.test.ts`：

- **首 tick 全 INSERT**：seed opencode SQLite fixture 含 1 个 child + 3 个 part；run 1 tick → INSERT 3 行；内存 Set 长度 = 3。
- **二次 tick 增量**：再 append 2 个 part 到 fixture → 第 2 tick INSERT 2 行；Set 长度 = 5。
- **partId dedupe**：第 3 tick 不变 → INSERT 0 行；不广播。
- **新 child 出现**：第 4 tick 把 fixture 加一个 child（depth=2，包 2 个 part）→ INSERT 2 行；broadcast 1 条 sessionIds 含新 child id。
- **sibling skip**：seed `node_run_events` 让另一 nodeRun 已经持有 child sessionId → live poll 整段 skip；INSERT 0 行；Set 不增长。

### 9.2 失败 disable

- mock `Database` open throw 5 次 → 第 6 次起 tick early-return；warn `subagent-live-poll-disabled` 命中一次；`stats().disabled === true`。
- mock SELECT 一半抛错 → 当前 tick warn `subagent-live-poll-error`、`consecutiveFailures` +1；下次 tick 恢复 → 计数清零。

### 9.3 runner 集成

`packages/backend/tests/runner-subagent-live-capture.test.ts`：

- mock spawn 5 秒、mock opencode SQLite 在 t=500ms / t=2000ms / t=4500ms 各加一批 part → runner 跑完后 `node_run_events` 行数 = 总 part 数；每批之间有 WS broadcast；post-run capture 跑但 INSERT 0 行（已被 live poll 写完）。
- 同上但 child 在 t=4900ms 又写最后一条 part → post-run capture 兜底 INSERT 1 行；总数仍 = 总 part 数。
- `pollMs=0`：runner 行为字节级 = RFC-027（live poll 不启动；post-run 跑全量 BFS）。

### 9.4 grep 守卫

`packages/backend/tests/subagent-live-capture-source.test.ts`：

- `runner.ts` 出现 `startLiveSubagentCapture(` 恰好 1 次；`liveCtrl.abort()` 在 `child.exited` 之后；post-run `captureChildSessions` 调用未删。
- `subagentLiveCapture.ts` 出现 `'subagent-live-poll-error'` 与 `'subagent-live-poll-disabled'` 各恰好 1 次。

### 9.5 回归

- `session-capture.test.ts` / `parse-session-tree*.test.ts` / `session-view-parse*.test.ts` 全绿。
- RFC-026 inline rerun `clarify-inline-*.test.ts` 全绿（sibling skip 路径未变）。
- 全套本地 `bun test` 通过；GitHub Actions 六 job 全绿。

## 10. 开发顺序（详见 plan.md）

1. shared schema + DEFAULT 常量 + zod 测试。
2. `subagentLiveCapture.ts` 实现 + 单元测试。
3. `captureChildSessions` 增加 partId-level dedupe 可选参数 + 测试。
4. runner 接入 + 集成测试 + grep 守卫。
5. `cli/start.ts` 透传 config。
6. STATE / plan 索引更新。
7. 单 PR：`feat(runner): RFC-048 subagent 会话事件运行中实时回流`。
