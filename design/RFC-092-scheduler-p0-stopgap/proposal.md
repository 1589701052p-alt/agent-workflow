# RFC-092 — 调度器 P0 止血：运行中答复被屏蔽（S-1）+ 多仓重试回滚 no-op（S-2）

> 状态：Draft。来源：`design/scheduler-audit-2026-06-10.md` 改进路线 **WP-1**（含顺带项 S-26 的
> clarify 路由注释修正）。触发：2026-06-10 用户「调研节点调度问题 → 先补全用例 → 开（始修复）」。

## 背景

调度子系统专项调研（97 agent 对抗核实）确认两个 P0，均已有 characterization 测试锁定现状
（commit `b934a01`），本 RFC 修复并按测试文件头指引翻转断言：

- **S-1**：工作流有并行分支时（菱形 `in → {A, B}`），A 发 clarify 后用户在 B 还在跑时通过 UI
  答题（clarify 收件箱按 session 状态列出，不看 task 状态），`submitClarifyAnswers` 为 A 铸出
  pending rerun 行；但 A 已在本次 `runScope` 调用的 `dispatchedThisInvocation` 去重集里
  （scheduler.ts:606/636/1123），rerun 行被永久屏蔽且不落任何分桶 → B 跑完后 scope 静默 →
  任务以无诊断价值的 `scheduler stalled` 假失败收场，已答的 clarify 看似丢失。review 的
  iterate / reject 在 sibling in-flight 时提交同样命中（review.ts:1742-1757、:1792-1797）。
  两个 REST 路由都把 `resumeTask` 的 task-not-resumable 静默吞掉（routes/clarify.ts:269-276、
  routes/reviews.ts:180-182），用户没有任何出路。锁定测试：
  `scheduler-audit-s01-pending-rerun-dispatch-dedup.test.ts`。
- **S-2**：多仓任务（repoCount>1）的**进程内重试**回滚是静默 no-op：快照写入双轨（单仓写
  `preSnapshot` scheduler.ts:1604，多仓写 `preSnapshotReposJson` :1627），但重试回滚读取单轨
  （`readSnapshotForLatestRun` :3793 只读 `preSnapshot`）恒得 `''`，再对非 git 的多仓容器目录
  执行回滚、git 报错被 :1529-1534 吞掉——失败尝试的脏工作区原样喂给下一次重试，最终 diff 混入
  垃圾改动且现网不可见。resume 路径早已正确（task.ts:870-915 `rollbackNodeRunForResume`，有
  `resume-multi-repo-rollback.test.ts` 防护），这是 RFC-066 移植时只改 resume 漏改 scheduler
  内重试的双轨漂移。锁定测试：`scheduler-audit-s02-multirepo-retry-rollback-noop.test.ts`。
  调研期间另发现同源单仓变体 **S-2b**（见 design.md §S-2b）：followup 尝试不写快照
  （scheduler.ts:1598 条件跳过），其行 `preSnapshot` 为 NULL，`readSnapshotForLatestRun` 按
  `desc(retryIndex)` 选中它后回滚同样退化。

## 目标

1. 任务运行中（有 sibling in-flight）提交 clarify 答复 / review 决策后，**正在运行的调度循环
   在下一个 tick 自然拾起 rerun 行**并派发——不再假失败，无需用户手动 resume。
2. 多仓任务进程内重试前，**每个子仓**都回滚到上一次 fresh-session 尝试的 pre-snapshot 状态；
   单仓 followup 链后的重试回滚到正确基线（S-2b）。
3. 共享 task.ts 的多仓回滚实现（「抽一次别 fork」），顺带消灭 `readSnapshotForLatestRun` 这处
   `desc(retryIndex)` 排序分叉（调研 S-13 五处 fork 之一）。
4. 顺带：修正 routes/clarify.ts:255-257 引用已删除机制（`rescanScopeForNewPendingRows`）的失真
   安全论证注释（S-26 的 clarify 路由部分；其余 S-26 注释清账归 WP-6a）。

## 非目标

- 不动 S-1 同域的其他分桶黑洞（running/canceled/skipped → WP-2 `decideScopeOutcome` 穷举）。
- 不动 `dispatchedThisInvocation` 对**非 pending** 行的去重语义（N3 busy-loop 防护原样保留）。
- 不动 resumeTask / retryNode 的互斥与 CAS（S-8/S-14 → WP-4）。
- 不动快照**写入**侧（多仓仍写 `preSnapshotReposJson`、followup 仍不写快照——只修读取/回滚侧）。
- 不动 `rollbackToSnapshot` 自身的 fail-closed 语义（S-11 → WP-9）。
- 不清理 S-26 其余失真注释（dispatchFrontier.ts/scheduler.ts 的 "UNWIRED" 段等 → WP-6a）。
- **不修 wrapper 内 clarify 的 mid-run 答复**（wrapper awaiting\_\* 行不走 pending-bypass，任务会
  停泊 awaiting_human 需手动 resume——状态真实、可解锁，非假失败；扩 bypass 到 wrapper 锚点归
  WP-6c 与 S-3 一并处理，见 design §1.4）。
- **不修 clarify.ts:425-439 / review.ts:1704-1715 / crossClarify.ts:782 三处 out-of-band 回滚的
  多仓 no-op**（S-2 同家族——单轨读 `preSnapshot`，多仓恒跳过；对抗检视新发现，已登记调研报告
  ⑥-10。共享函数落地后它们的修复是机械接线，归 WP-5 写锁注册表时一并走，避免本 P0 止血扩面）。

## 用户故事

1. 我在任务运行中打开 clarify 收件箱答题：提交后任务继续推进直到 done——而不是几分钟后变成
   `failed: scheduler stalled`、答案石沉大海。
2. 我对运行中任务的某文档 review 提交 iterate：上游 agent 按新意见重跑，sibling 分支不受影响。
3. 我的双仓任务里写者第一次尝试写了一半失败：自动重试从两个子仓的干净基线重来，最终 diff 里
   没有第一次的半成品。

## 验收标准

- [ ] `scheduler-audit-s01-*.test.ts` 按文件头指引翻转后全绿（pending rerun 行被放行）。
- [ ] `scheduler-audit-s02-*.test.ts` 翻转后全绿（attempt 2 起点两个子仓干净；双轨写入证据断言
      保留——写入侧未动）。
- [ ] `scheduler-audit-s12-*.test.ts` 状态全集表中 `pending`（∈ dispatchedThisInvocation ∧
      ∉ inFlight）一行的期望从「无桶」翻转为「ready」。
- [ ] `scheduler-audit-s13-*.test.ts` 源码守卫按头指引更新：`readSnapshotForLatestRun` 已删除、
      scheduler.ts 不再含该 `desc(retryIndex)` 用法。
- [ ] 新增集成测试：mid-run clarify 答复（慢 sibling）→ 任务最终 done 且 rerun prompt 含答案；
      mid-run review iterate → 上游重跑、任务 done。
- [ ] 新增回归测试：S-2b followup 链后重试回滚到最后一次 fresh-session 快照；泄漏 pending 行
      有界终结（对抗检视反例 1a）；答复竞态窗口不无答案起跑（反例 1b）。
- [ ] 既有测试无未解释红（`derive-frontier.test.ts` N3 已核实 fixture 为 failed、不受影响；
      `source-text-rfc066-pr-b-guards.test.ts` PB-G4 薄壳形态约束保持绿）。
- [ ] `bun run typecheck` + 根 `bun test` + `bun run format:check` 全绿；CI 全绿。
