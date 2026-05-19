# RFC-047 — 任务分解

单 PR 交付：`feat(runner): RFC-047 注入快照早写`。

## 子任务

### RFC-047-T1 — `RunNodeOptions` 扩字段
- 在 `packages/backend/src/services/runner.ts` 的 `RunNodeOptions` 接口加必填 `nodeId: string`。
- `packages/backend/src/services/scheduler.ts` 所有 `runNode(...)` 调用点显式传入 `nodeId`（每处都已经持有 `node.id`）。
- 影响测试：现有 `runner-*.test.ts` 里直接 mock `runNode` 的 case 需要补 `nodeId` 字段；逐一过一遍。
- 依赖：无。
- 验收：typecheck 全绿；现有套件零退化。

### RFC-047-T2 — runner 内增加早写 + WS 广播
- 在 `runner.ts` inject 阶段（normal + followup 两条路径汇合点）之后，spawn opencode 之前，插入：
  - 一次 `db.update(nodeRuns).set({ injectedMemoriesJson }).where(eq(nodeRuns.id, opts.nodeRunId))`；
  - 一次 `taskBroadcaster.broadcast(TASK_CHANNEL(opts.taskId), { id: -1, type: 'node.status', nodeRunId: opts.nodeRunId, nodeId: opts.nodeId, status: 'running' })`；
  - 包在 try/catch 里，失败走 warn log，不抛。
- log tag：`inject-snapshot-eager-write`（成功） / `inject-snapshot-eager-write-failed`（失败）。
- 总 UPDATE（runner.ts:772-792）保持不动，作为兜底。
- 依赖：T1。
- 验收：手动跑一个含 agent 节点的 task，运行中 SELECT 行能看到列已填。

### RFC-047-T3 — 单元测试
- 新 `packages/backend/tests/runner-inject-snapshot-eager-write.test.ts`（5 case）：
  1. 正常路径：mock `injectMemoryForRun` 返 snapshot，mock spawn 长阻塞 → SELECT 列已有值。
  2. 早写抛错降级：mock `db.update` 早写处 throw → runner 不抛 + 总 UPDATE 仍落值。
  3. followup-inherit：`envelopeFollowup=true` + attempt 0 行预置 snapshot → 早写列等于 attempt 0。
  4. null snapshot：inject 返 null → 早写列保持 null。
  5. WS 广播：spy broadcaster → 收到额外一次 `node.status: running`。
- 依赖：T2。
- 验收：5 case 一次过，本地 backend 套件全绿。

### RFC-047-T4 — 源代码层 grep 守卫
- 新 `packages/backend/tests/runner-inject-snapshot-eager-write-source.test.ts`：
  - 读 `runner.ts` 源文件文本，断言：
    - 出现 `'inject-snapshot-eager-write'` 字面量恰好 1 次；
    - 出现 `'inject-snapshot-eager-write-failed'` 字面量恰好 1 次；
    - 早写 UPDATE 行索引 < 总 UPDATE 行索引（保证早写在前）；
    - 总 UPDATE 仍包含 `injectedMemoriesJson:` 字面。
- 依赖：T2。
- 验收：断言全过；后续重构如果挪动早写位置必须更新此守卫。

### RFC-047-T5 — STATE / plan 同步
- `design/plan.md` RFC 索引表加一行 RFC-047（Draft → In Progress → Done）。
- `STATE.md` 顶部"进行中 RFC"加一行指向本目录；落地后改 Done 并挪到"已完成 RFC"段。
- 依赖：T1-T4 全部落地、本地三件套全绿。

### RFC-047-T6 — push + CI 检查
- 推之前本地：`bun run typecheck && bun run test && bun run format:check`。
- 推后立刻按 [[feedback_post_commit_ci_check]] 查 GitHub Actions 六 job 状态。
- 依赖：T1-T5。

## PR 拆分建议

单 PR 即可。若 T1 改动面意外铺得很大（runNode 调用点散落多处），可拆 T1 单独先合，再合 T2-T4。

## 验收清单

- [ ] `RunNodeOptions.nodeId` 加上，scheduler 所有调用点传入。
- [ ] runner inject 阶段后早写 UPDATE + WS 广播落地。
- [ ] 总 UPDATE 仍写 `injectedMemoriesJson`。
- [ ] 单元测试 5 case 全过。
- [ ] grep 守卫 1 文件全过。
- [ ] RFC-046 既有 92 case 零退化。
- [ ] STATE.md / plan.md 状态同步。
- [ ] `bun run typecheck && bun run test && bun run format:check` 本地全绿。
- [ ] CI 六 job 全绿。
- [ ] 手动验证：跑一个 agent task，运行中 Session 页签即可看到 `Injected memories (N)` 卡片。

## 风险 / 回滚

- 风险点：runner 多写一次 SQL 在极端 SQLite busy 场景可能加剧锁竞争。Mitigation：早写已包 try/catch warn 降级，且 SQLite 走 WAL/NORMAL，单节点 runner 序列化访问自己的 row。
- 回滚：删掉 T2 加的早写代码块即可，列读写路径回到 RFC-046 状态（前端依然能在 run 结束后看到卡片）。零 schema / migration 改动让回滚成本接近零。
