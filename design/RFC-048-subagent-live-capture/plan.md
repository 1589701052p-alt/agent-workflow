# RFC-048 — 任务分解

单 PR 交付：`feat(runner): RFC-048 subagent 实时回流`。如 §拆分建议触发再拆。

## 子任务

### RFC-048-T1 — shared config schema
- `packages/shared/src/schemas/config.ts`：加 `SubagentLiveCaptureSchema`（`pollMs ∈ [0, 60000]` int / `consecutiveFailureLimit ∈ [1, 100]` int）+ `DEFAULT_SUBAGENT_LIVE_CAPTURE = { pollMs: 1500, consecutiveFailureLimit: 5 }`。挂上 `ConfigSchema.subagentLiveCapture?` + `ConfigPatchSchema` 同步。
- 测试：`packages/shared/tests/config-rfc048.test.ts`（约 8 case）：accept 合法 / omit undefined / 0 pollMs / 上界 60000 / 60001 拒 / 负 pollMs 拒 / limit 边界 1 与 100 / 浮点拒 / DEFAULT 双值守卫。
- 依赖：无。
- 验收：shared 套件全绿。

### RFC-048-T2 — `subagentLiveCapture.ts` 实现
- 新文件 `packages/backend/src/services/subagentLiveCapture.ts`：
  - `startLiveSubagentCapture(opts: LivePollOptions): LivePollerHandle`。
  - 内部 setInterval tick 实现（详见 design.md §2）：root sessionId 延迟、readonly DB 句柄复用、BFS、partId 内存 dedupe、sibling sessionId 一次性 load、WS broadcast、失败累计 / disable。
  - `getInsertedPartIdsBySession(): Map<string, Set<string>>` 让 runner post-run 传给 `captureChildSessions`。
- 测试：`packages/backend/tests/subagent-live-capture.test.ts`（约 12 case，详见 design.md §9.1 + §9.2）。
- 依赖：T1。
- 验收：backend 套件全绿；handle.stop() idempotent；abort signal 触发 stop。

### RFC-048-T3 — `captureChildSessions` partId-level dedupe
- `packages/backend/src/services/sessionCapture.ts`：
  - `CaptureChildSessionsOptions` 加可选 `alreadyInsertedPartIds?: Map<string, Set<string>>`。
  - INSERT 前按 sessionId 取对应 Set 过滤 part 行；缺省（旧 callers）行为字节级不变。
- 测试：`session-capture.test.ts` 加 3 case：缺省时全量 INSERT / 提供 Set 时过滤 / Set 含全部 partId 时 INSERT 0 行 + 不抛错。
- 依赖：无；可与 T2 并行。
- 验收：现有 capture 套件零退化。

### RFC-048-T4 — runner 接入
- `packages/backend/src/services/runner.ts`：
  - `RunNodeOptions` 加可选 `subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }`（缺省取 DEFAULT）。
  - spawn 之后启动 `startLiveSubagentCapture`（传 AbortController.signal、broadcaster callback）。
  - `await child.exited` 之后调 `liveCtrl.abort() + livePoller.stop()`。
  - post-run `captureChildSessions` 调用透传 `alreadyInsertedPartIds = livePoller.stats().insertedPartIdsBySession`。
- 测试：`packages/backend/tests/runner-subagent-live-capture.test.ts`（约 5 case，详见 design.md §9.3）。
- 依赖：T1 + T2 + T3。
- 验收：mock spawn + mock SQLite fixture 端到端跑通；`pollMs=0` 退化测试通过。

### RFC-048-T5 — scheduler / cli 透传
- `packages/backend/src/services/scheduler.ts`：把 `config.subagentLiveCapture` 经 scheduler tick 链路传到 `RunNodeOptions.subagentLiveCapture`。
- `packages/backend/src/cli/start.ts`：从 config load 读出对应字段。
- 测试：`scheduler-subagent-live-capture-passthrough.test.ts`（2 case：default / explicit override）。
- 依赖：T4。
- 验收：scheduler 套件全绿。

### RFC-048-T6 — 源代码层 grep 守卫
- `packages/backend/tests/subagent-live-capture-source.test.ts`：
  - `runner.ts`：`startLiveSubagentCapture(` 恰好 1 次；`liveCtrl.abort()` 在 `child.exited` 之后；post-run `captureChildSessions` 行索引仍存在。
  - `subagentLiveCapture.ts`：`'subagent-live-poll-error'` / `'subagent-live-poll-disabled'` 各恰好 1 次。
- 依赖：T2 + T4。
- 验收：grep 断言全过。

### RFC-048-T7 — STATE / plan 同步
- `design/plan.md` RFC 索引表加一行 RFC-048（Draft → In Progress → Done）。
- `STATE.md` 顶部"进行中 RFC"加一行；落地后改 Done 并挪到"已完成 RFC"段。
- 依赖：T1-T6 全部落地、本地三件套全绿。

### RFC-048-T8 — push + CI 检查
- 推之前本地：`bun run typecheck && bun run test && bun run format:check`。
- 推后立刻按 [[feedback_post_commit_ci_check]] 查 GitHub Actions 六 job 状态。
- 依赖：T1-T7。

## PR 拆分建议

默认单 PR。若集成测试（T4）调起来比预期复杂，可拆为：

- **PR-A**：T1 + T2 + T3 + T6 的 sessionCapture/grep 部分（纯新增 + 一处可选参数），落库零行为变更——零风险。
- **PR-B**：T4 + T5 + T6 的 runner/grep 部分 + T7，真正接通 runner。

拆分前提是 PR-A merged 时 lint+test 仍全绿（T2 的 helper 即便没被 runner 用上也应该自我验证）。

## 验收清单

- [ ] shared 加 `subagentLiveCapture` config + 测试。
- [ ] `startLiveSubagentCapture` 实现 + 单元测试。
- [ ] `captureChildSessions` 增加 partId-level dedupe 可选参数 + 测试。
- [ ] runner 接入 live poller，post-run capture 透传 dedupe Set。
- [ ] scheduler / cli 透传 config。
- [ ] `pollMs=0` 退化测试：行为字节级 = RFC-027。
- [ ] WS broadcast 在非空 tick 触发；空 tick 不广播。
- [ ] 连续失败 disable + warn log。
- [ ] grep 守卫文件全过。
- [ ] RFC-027 / RFC-026 既有测试零退化。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] CI 六 job 全绿。
- [ ] 手动验证：跑一个会调 `task` 工具的 agent，运行中 Session 页签 subagent 卡片随时间逐步充实。

## 风险 / 回滚

- 风险：opencode SQLite 并发读取在某些 opencode 版本下抖动 → tick 失败计数达 limit → live poll 自动 disable + post-run 兜底走 RFC-027。
- 风险：每 nodeRun 多一份内存 Set（partId 字符串集合，量级 < 10K/run）→ 内存影响可忽略；超长 run 监控可在 `livePoller.stats()` 输出。
- 回滚：把 default `pollMs` 改成 0（一行 config 改动即关闭）；或在 runner 里删 T4 的接入块即可（其它新加文件不带副作用）。

## 与 RFC-047 的协调

- RFC-047 立项在前，落 `RunNodeOptions.nodeId` 字段已是事实；本 RFC 复用该字段。
- 两个 RFC 触碰 runner.ts 同一区间但不同行，merge 顺序无关。若 RFC-047 先 merge，本 RFC rebase 即可；反之 RFC-047 加 `nodeId` 的 diff 在本 RFC 也独立可见。
