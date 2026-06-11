# RFC-097 — 技术设计

行号基线：`2dbfcf1`（2026-06-12 普查实证）。普查 agent 已对 27 个 `update(tasks)` 写点逐点
确认 file:line / 隐含 from / 测试依赖；本文是其结论的规范化。

## 1. 助手（services/lifecycle.ts 追加，1:1 镜像 node_runs 侧）

```ts
export const TERMINAL_TASK_STATUSES = ['done', 'failed', 'canceled', 'interrupted'] as const
// structuralDiff/store.ts:53-58 的私有副本改 import 本常量。

export async function setTaskStatus(args: {
  db: DbClient
  taskId: string
  to: TaskStatus
  allowedFrom: readonly TaskStatus[]
  allowTerminal?: boolean // 默认 false：from ∈ TERMINAL 时抛 Illegal
  extra?: TaskStatusUpdateExtra // finishedAt/errorSummary/errorMessage/failedNodeId 白名单
  reason: string // 审计日志
}): Promise<void> // CAS affected=0 → ConcurrentTaskTransition (409)

export async function trySetTaskStatus(同参): Promise<boolean> // 不抛，返回是否赢
```

任务状态全集 8 值（shared schemas/task.ts:6-21）：pending / running / done / failed /
canceled / interrupted / awaiting_review / awaiting_human。**无任务级 exhausted**（CLAUDE.md
的生命周期清单与实现不符——实现为准，顺手在 CLAUDE.md 勘误一行）。

合法转移矩阵（普查 §2；⛔=终态 from，仅 allowTerminal 持有者可越）：

| from \ to      | pending                       | running    | done  | failed            | canceled     | interrupted            | awaiting\_\* |
| -------------- | ----------------------------- | ---------- | ----- | ----------------- | ------------ | ---------------------- | ------------ |
| pending        | —                             | ✅ runTask | —     | ✅ failTask(早期) | ✅ cancel/S4 | ⚠️ S4.kick(人工)       | —            |
| running        | —                             | —          | ✅    | ✅                | ✅           | ✅ orphans/shutdown/S3 | ✅           |
| awaiting\_\*   | ✅ resume                     | —          | —     | ✅ R1/R2          | —            | ✅ S1/S2/T1/T2(人工)   | —            |
| failed ⛔      | ✅ resume/retry               | —          | —     | —                 | —            | ⚠️ CR-1                | —            |
| interrupted ⛔ | ✅ resume/retry               | —          | —     | —                 | —            | —                      | —            |
| canceled ⛔    | ✅ retry(**RFC-095 revival**) | —          | —     | —                 | —            | —                      | —            |
| done ⛔        | ✅ retry(显式重试)            | —          | ⚠️ T3 | ⚠️ T3             | —            | —                      | —            |

allowTerminal 持有者恰 4 类：resumeTask（from 含 failed/interrupted）、retryNode（from 含
done/failed/canceled/interrupted）、修复 CR-1（failed→interrupted）、修复 T3（done→
interrupted / done→failed，全仓唯一终态→终态改写）。

## 2. 27 写点迁移表（普查全文收录；执行时逐行照做）

> 格式：`写点 | to | allowedFrom | CAS 失败处置 | 备注`。行号基线 2dbfcf1。

**scheduler.ts（6）**

1. :273 runTask 入口 | running | {pending} | **log + return**（不铸行——S-8 复活/二次接管修复点；用 trySetTaskStatus） | 不顺手重置 startedAt（⑥-1 单独立项）
2. :396 | awaiting_review | {running} | 尊重赢家：log + return 不 emit | —
3. :407 | awaiting_human | {running} | 同上 | —
4. :414 | done | {running} | 尊重赢家（重读；canceled 赢则不 emit done） | **CAS 前补 `opts.signal?.aborted` 终检，aborted → 改走 cancelTaskRow（cancel 应赢）**
5. :3513 failTask | failed | {pending, running} | canceled 赢 → 尊重 log；其余 log.error | 调用点 :268 在 mark-running 前（from=pending）；:289/:308/:334/:381/:386 在其后（from=running）——对抗检视勘误：初版误把 :334 归前
6. :3525 cancelTaskRow | canceled | {running} | 幂等：已被 fallback/failTask 落终态 → 尊重 log | —

**task.ts（3）** 7. :904 cancelTask fallback | canceled | {pending, running} | **不抛**：重读返回赢家 | :879 状态门保留为 fast-path 409 8. :968 resumeTask | pending | {failed, interrupted, awaiting_review, awaiting_human}（allowTerminal） | **抛 409 task-not-resumable**（保持既有合同） | **前移为所有权锁**：CAS 赢 → 才回滚 + kick（§3）9. :1169 retryNode | pending | {done, failed, canceled, interrupted, awaiting_review, awaiting_human}（allowTerminal） | 抛 409 | 同上前移（铸占位行也在 CAS 之后）

**limits / orphans / shutdown（3）** 10. limits.ts:48 | （非 status 写） | 改 CAS `WHERE status='canceled'` | skip + log（done/failed 赢家不被 limit 文案污染） | 仅 errorSummary/errorMessage 11. orphans.ts:40 | interrupted | {running} | skip + log（对齐同函数 node_runs 分支处置） | — 12. shutdown.ts:39 | interrupted | {running} | ignore | —

**lifecycleRepair（15；allowedFrom = 各自 preflight 状态门，CAS 失败统一抛并映射既有
`repair-preflight-stale` 语义 → 操作员重新诊断）** 13. CR1:81 | interrupted | {failed} ⚠️allowTerminal | 14. R1:295 | failed | {pending,running,awaiting\_\*} | 15. R2:135 同 R1 | 16. S1:192 | interrupted | {awaiting_review} | 17. S2:44 | interrupted | {awaiting_human} |
18-20. S3:162/237/289 | interrupted | {running} | 21. S3:338 | failed | {running} | 22. S4:47 | interrupted | {pending}（人工 kick 逃生转移，进表） | 23. S4:92 | canceled | {pending} | 24. T1:112 | interrupted | {awaiting_review} | 25. T2:100 | interrupted | {awaiting_human} | 26. T3:45 | interrupted | {done} ⚠️allowTerminal（extra: finishedAt=null） | 27. T3:89 | failed | {done} ⚠️allowTerminal

## 3. 任务级互斥（S-8）

- **task.ts 导出 `isTaskActive(taskId): boolean`**（activeTasks.has）。
- **resumeTask 新序列**：① `isTaskActive` → 409 `task-already-active`；② 状态门 fast-path
  （现行 :931-941 保留）；③ `setTaskStatus(pending, from=可恢复集, allowTerminal)` —— CAS 即
  所有权锁，输者 409 `task-not-resumable`；④ 赢者执行 git 回滚（失败不回退状态——任务停在
  pending，与现行回滚失败 warn-continue 一致，runTask 照常 kick）；⑤ 注册 controller +
  `void runTask`。
- **retryNode 同型**：CAS 翻 pending 前移到回滚与铸占位行之前——输者不再污染 node_runs /
  worktree。
- **runTask 入口**：`trySetTaskStatus(running, from={pending})` 失败 → log + return（既不
  复活 canceled / done，也不二次接管 running）。
- **controller 身份**：activeTasks.set 前若已有条目 → 不应发生（入口已拒），防御性 log；
  `.finally` 改 `if (activeTasks.get(id) === controller) activeTasks.delete(id)`。
- **① 的 409 code（对抗检视 R5 合同自洽）**：复用既有 `task-not-resumable`（message 注明
  "task is actively running"）——`resume-task-idempotent` R5 与 proposal「409 合同不变」
  非目标同时成立，不新增错误码。
- **崩溃窗口补偿（对抗检视 1a，必做）**：CAS 前移使「回滚中途 daemon 崩溃」从『任务仍
  failed/interrupted，用户自助再 Resume』恶化为『卡 pending 无人认领』（boot 收割只翻
  running、stuckTaskDetector S4 只报警——既有 gap5 的任务侧不对称）。随本 RFC 在
  `reapOrphanRuns` 增加 **pending→interrupted** 任务收割分支：boot 在 HTTP listen 之前跑，
  彼刻一切 pending 任务必为孤儿（startTask 是 insert 后同进程 kick），零误伤；顺手关掉
  gap5 的任务侧并与 node_runs 侧（本就收割 pending 行）对齐。配重启恢复用例。
- **残余语义（不修，测试锁定意图）**：CAS 单胜只保证同一状态纪元——胜者 kick 的 runTask
  极速 failed 后，迟到的第二个 resume 看到 from=failed 合法再胜（等价于用户连按两次
  Resume，无双写者）。`rfc097-resume-mutex` 加「胜者速败后输者再胜」用例。

## 4. S-23：修复工具的调度器活性

- lifecycleRepair.ts **已经** import task.ts（resumeTask，:41-42）——直接再 import
  `isTaskActive` 即最小路径（对抗检视核实零新增依赖边、无环；task.ts 不引 lifecycleRepair）。
  动 task/scheduler 互引面后推前跑一次 `bun run build:binary`（模块环 smoke 惯例）。
- S3 / S4 / T 系 / CR1 等会 resumeAfterApply 或翻 running 任务状态的 options：preflight 增
  「`isTaskActive(task.id)` → unavailable('scheduler-active')」。
- apply 写全部走 §2 表的 CAS；affected=0 → `repair-preflight-stale`。

## 5. S-27：reviews.ts 分类吞

`.catch(() => {})` → clarify.ts:270-281 同款：`task-not-resumable`（含新 `task-already-active`）
→ log.info（预期：活调度循环经 RFC-092 pending 锚点自取）；其余 → log.warn。

## 6. 失败模式

| 风险                                                                                | 缓解                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 某写点 allowedFrom 收窄误伤既有路径                                                 | §2 表逐点取自普查的隐含 from（含测试依赖核对：lifecycleRepair 全套 / limits / orphans / shutdown / resume-idempotent / s22 / rfc095-revival 均已逐个核为绿）；全量套件为界                                                                                                                                                                                                                                                                                                                     |
| resumeTask CAS 前移后回滚失败留 pending                                             | 与现行 warn-continue 等价（任务 pending + runTask kick 照常；回滚失败本就只 warn）；用例锁定                                                                                                                                                                                                                                                                                                                                                                                                   |
| done-vs-cancel 终检后仍有微窗口                                                     | done CAS(from=running) 与 cancelTask fallback CAS(from={pending,running}) 互斥，谁 affected=1 谁赢——窗口内两写恰一胜，无互踩                                                                                                                                                                                                                                                                                                                                                                   |
| lifecycleRepair CAS 失败语义变化                                                    | 映射既有 repair-preflight-stale（操作员重新诊断），api-tasks-repair 合同不变                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 27 点改造引入漏改                                                                   | s14 翻转为 allowlist 棘轮（含 status 的 update(tasks) 直写仅 lifecycle 模块）——漏改点直接红；棘轮射程为 src/（scripts/fixup-rfc052 的直写在射程外，棘轮注释注明豁免与理由）                                                                                                                                                                                                                                                                                                                    |
| 回滚中途 daemon 崩溃留 pending 孤儿                                                 | §3 崩溃窗口补偿：reapOrphanRuns 增 pending→interrupted 任务收割 + 重启恢复用例                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **测试暗雷：10 文件 ≈30 处以 awaiting\_\*/failed 状态直接重入 runTask 模拟 resume** | 对抗检视全量清单（review-state-machine / review-iterate ×3 / clarify-review-combination ×18 / rfc092-midrun-review / rfc040-wrapper-await ×2 / scheduler-clarify-inline ×3 / clarify-inline-isolated / resume-task-idempotent R5）——统一新增测试 helper `reenterScheduler(db, taskId, opts)`（重置 pending + runTask，模拟 resumeTask 语义；范本 scheduler-clarify-dispatch.test.ts:404 的显式重置）逐点替换；loop-exhausted-resume:167 同样重置以保住 oracle（否则 CAS no-op 使其断言空洞绿） |

## 7. 测试策略

1. 翻转 `scheduler-audit-s08-*`（canceled/done 任务 runTask → 不复活不铸行；活任务二次
   runTask → 拒绝）与 `scheduler-audit-s14-*`（allowlist 棘轮）。
2. 新增 `rfc097-task-status-cas.test.ts`：setTaskStatus/trySetTaskStatus 单测（CAS 赢/输、
   allowTerminal 闸、extra 白名单、Illegal/Concurrent 错误形态）；转移矩阵表驱动。
3. 新增 `rfc097-resume-mutex.test.ts`：真并发双 resume（慢回滚 harness——预置 preSnapshot 让
   rollback 走真实 git await，第二个 resume 在窗口内发起）→ 恰一个成功 / 一个 409（code
   task-not-resumable）/ 单 controller / 零双铸行；retryNode 同型一条；「胜者速败后输者
   再胜」意图锁定一条。
   3b. 测试迁移（对抗检视暗雷清单）：新增共享 helper `reenterScheduler` 并替换 10 文件 ≈30 处
   直接重入点（断言语义不变——helper 即 resumeTask 的测试等价物）；loop-exhausted-resume
   重置 pending 保 oracle。
   3c. 新增重启恢复用例：pending 任务（模拟回滚中途崩溃残留）→ reapOrphanRuns → interrupted
   → resumeTask 可恢复。
4. 新增 `rfc097-cancel-wins.test.ts`：abort 落在最后 signal 检查之后 → 任务终态 canceled 非
   done；limits 对已 done 任务 → errorSummary 不被覆写。
5. 新增 S-23 用例：调度器活跃（注入 isTaskActive=true）时 S3 preflight → unavailable。
6. 回归网：resume-task-idempotent / s22 / rfc095-wrapper-canceled-revival / lifecycleRepair
   全套 / limits / orphans / shutdown / api-tasks-repair / reviews 路由 + 全量套件。
