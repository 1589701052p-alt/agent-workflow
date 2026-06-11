# RFC-097 — tasks.status 转移表 + CAS + 任务级互斥（RFC-053 三件套复制到任务层）

> 状态：Draft。来源：`design/scheduler-audit-2026-06-10.md` 改进路线 **WP-4**（S-8 / S-14 /
> S-23 / S-27；对应既有队列「runner/task nextTaskStatus CAS」）。触发：2026-06-12 用户「继续」。
> 落档前已做 27 写点逐点普查（design.md §2 迁移表全部 file:line 实证）。

## 背景

node_runs 在 RFC-053 后有完整治理三件套（转移表 + CAS 助手 + 直写禁令守卫）；tasks 表三者
皆无——**27 个直接 `update(tasks)` 写点散布 15 文件**，全部读-判-写无原子性：

- **S-8（P1）**：resumeTask / retryNode 的状态门→git 回滚（真实 await 窗口）→翻 pending→
  `void runTask` 序列无互斥；runTask 入口无条件写 running（可复活 canceled 任务、二次接管
  活任务）；`activeTasks.set` 直接覆盖旧 controller、`.finally` 删除不比对身份。现网触发器
  现成：reviews.ts 自动 resume 与用户手动 resume 并发。后果：同一 worktree 双写者、stash
  互踩、终态由后写者随机决定。现状锁定：`scheduler-audit-s08-*`。
- **S-14（P2）**：三个可命名互踩窗口——runTask 复活已 canceled 任务；最后一轮 signal 检查后
  到达的 abort 被 done 覆盖；limits 在 cancelTask 失败（任务已 done/failed）后仍覆写
  errorSummary。现状锁定：`scheduler-audit-s14-*`（27 写点清单守卫）。
- **S-23（P2）**：lifecycleRepair 的 preflight 只断言任务状态、无法证明调度器已死；S3 修复 +
  auto-resume 可叠加出双调度器（修复工具复制它要修的事故类别）。
- **S-27（P3）**：reviews.ts 自动 resume 的 `.catch(() => {})` 全吞（RFC-092 已修注释，行为
  待修）。

## 目标

1. **转移表 + CAS 助手**（backend `services/lifecycle.ts`，1:1 镜像 node_runs 侧
   `setNodeRunStatus` 形态：allowedFrom + allowTerminal 逃生门 + extra 白名单 + reason +
   Concurrent/Illegal 错误）；吸收 structuralDiff/store.ts 的私有终态集副本。
2. **27 写点逐点迁移**（design §2 表：每点显式 allowedFrom + CAS 失败处置）；终态改写仅 4 个
   调用方持 allowTerminal（resumeTask / retryNode / 修复 CR-1 / T3×2）。
3. **任务级互斥**：resumeTask / retryNode 把「CAS 翻 pending」前移为所有权锁（赢者才回滚 /
   铸行 / kick），入口先查 activeTasks 拒绝活任务；runTask 入口 CAS pending→running（失败即
   return，不复活不二次接管）；activeTasks 删除前比对 controller 身份。
4. **cancel 应赢**：scheduler 终态写（done / awaiting\_\*）CAS 前补最后一次 aborted 检查；
   cancelTask fallback 写改 CAS、失败重读返回赢家。
5. **S-23**：task.ts 导出 `isTaskActive`；lifecycleRepair S3/T 系 preflight 增加调度器活性
   检查（活跃 → unavailable）；apply 写走 CAS，失败映射既有 `repair-preflight-stale`。
6. **S-27**：reviews.ts 自动 resume 改分类吞（模板 clarify.ts 同款）。
7. **守卫**：s14 翻转为「`update(tasks)` 含 status 的直写仅允许 lifecycle 模块」allowlist
   棘轮；s08 按 FLIP 翻转。

## 非目标

- 不动 startedAt 语义（缺口 ⑥-1 limits 墙钟问题，单独立项——表里明确「勿顺手做」）。
- 不引入任务级 `exhausted` 状态（CLAUDE.md 提及但实现从未有；维持 8 值全集）。
- 不动 node_runs 侧任何东西；不动 shared 包（转移表 backend 本地，零 binary 风险面）。
- 不改 resumeTask 对外 409 合同（`task-not-resumable` 保持，resume-task-idempotent 测试为界）。

## 验收标准

- [ ] `scheduler-audit-s08-*` 翻转：canceled/done 任务直接 runTask → 不复活（任务状态不变、
      不铸行）；活任务二次 runTask → 拒绝。
- [ ] `scheduler-audit-s14-*` 翻转：含 status 的 `update(tasks)` 直写仅存在于 lifecycle 模块
      （allowlist 棘轮）。
- [ ] 新增真并发 oracle：双 resume（回滚 await 中间发起第二次）恰一个成功一个 409、零双铸行；
      cancel-vs-done 竞态 canceled 赢；limits 对已 done 任务不再覆写 errorSummary。
- [ ] S-23：调度器活跃时 S3 修复 preflight → unavailable；修复 apply 的 CAS 失败 →
      repair-preflight-stale。
- [ ] canceled revival（s22 / rfc095-wrapper-canceled-revival）、resume-task-idempotent、
      lifecycleRepair 全套、limits/orphans/shutdown 既有用例全绿。
- [ ] `bun run lint` + `bun run typecheck` + 根 `bun test` + `bun run format:check` 全绿
      （lint 这次进推前清单）；CI 全绿。
