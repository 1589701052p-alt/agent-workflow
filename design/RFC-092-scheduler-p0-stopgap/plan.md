# RFC-092 — 任务分解

单 PR（RFC 默认；main 直推）。commit 前缀：`fix(backend): RFC-092 调度器 P0 止血（S-1 运行中答复屏蔽 + S-2 多仓重试回滚）`。

## 子任务

### RFC-092-T1 — 共享回滚原语 `nodeRollback.ts`

- 新建 `packages/backend/src/services/nodeRollback.ts`：`rollbackNodeRunWorktrees`（design §2.1）。
- `task.ts` `rollbackNodeRunForResume` 改薄壳委托（`resetOnEmptySnapshot: false`），行为字节级等价。
- 新测试 `rfc092-node-rollback.test.ts`（design §5-6）。
- 回归：`resume-multi-repo-rollback.test.ts` 及 resume 相关既有用例全绿。
- 依赖：无。

### RFC-092-T2 — scheduler 重试路径接线（S-2 + S-2b）

- runOneNode attempt 循环：快照写入同步存 `lastFreshSnapshot` 局部；回滚改调
  `rollbackNodeRunWorktrees`（`resetOnEmptySnapshot: true`）；删 `readSnapshotForLatestRun`
  （design §2.2-2.3）。
- 翻转 `scheduler-audit-s02-*`；更新 `scheduler-audit-s13-*` 源码守卫；新增
  `rfc092-followup-chain-rollback.test.ts`（S-2b）。
- 回归：`scheduler-boundary-presnapshot-rollback-skip.test.ts` 全绿（单仓空快照 reset 语义不变）。
- 依赖：T1。

### RFC-092-T3 — deriveFrontier pending 锚点行 id 豁免（S-1）

- runScope 新增 `dispatchedPendingRowIds`；deriveFrontier dispatchable 判定加
  `pendingAnchorReleasable`（design §1.2，行 id 一次性豁免）。
- `loadOpenClarify` 增补 `openAskingNodeIds`（design §1.2b 竞态守卫，cross-clarify 同口径）。
- 翻转 `scheduler-audit-s01-*` / `scheduler-audit-s12-*`（`derive-frontier.test.ts` N3 已核实
  无需调整）。
- 依赖：无（与 T1/T2 正交，可并行实现，同一 commit 交付）。

### RFC-092-T4 — mid-run 集成测试 + 对抗检视反例回归

- 新增 `rfc092-midrun-clarify-dispatch.test.ts` / `rfc092-midrun-review-iterate.test.ts`
  （design §5-7/8：慢 sibling + 运行中提交，断言任务 done、rerun 生效、sibling 无扰）。
- 新增 `rfc092-leaked-pending-bounded.test.ts` / `rfc092-answer-race-window.test.ts`
  （design §5-10/11）。
- 依赖：T3。

### RFC-092-T5 — 注释修正 + 收尾

- routes/clarify.ts:255-262、routes/reviews.ts:180-182 失真注释按 design §3 改写（纯注释）。
- `design/plan.md` RFC 索引置 Done；`STATE.md` 移除「进行中 RFC」行并登记完成条目。
- 门禁：`bun run typecheck` + 根 `bun test` + `bun run format:check`；推送后查 CI。
- 依赖：T1-T4。

## 验收清单

见 proposal.md「验收标准」。要点：4 个 audit 锁定文件按头指引翻转后全绿、4 个新测试文件全绿、
既有 resume / presnapshot / dispatch-frontier 回归网全绿、CI 全绿。
