# 任务 / 节点生命周期状态机 — 架构审计 (2026-06-23)

> 子系统 key=`01-task-lifecycle`。范围：任务级与 node_run 级状态机、状态转移、CAS、失败恢复 / 修复、freshest-run 判定、node_run 行铸造、回滚、生命周期不变式扫描 + 修复引擎。
> 与既有审计的关系：scheduler-audit-2026-06-10 的 S-12 / S-13 / S-14 / S-16 大部分已被 RFC-092 / RFC-095 / RFC-097 / RFC-098 落地修复（见 §3 交叉印证）；本报告把精力放在**这些治理之后残留的架构缝**和**扩展性瓶颈**。

## 0. 健康度一句话

node_run 级状态机是全仓治理最好的子系统之一（单一转移表 + CAS + grep-ratchet + 单一铸造工厂 + 不变式扫描 + 修复引擎，且 S-12/S-13/S-14/S-16 都已闭环）；但**任务级状态机只做了 CAS 没做转移表**（`allowedFrom` 在 ~20 个调用点手抄、已现轻微漂移），**恢复/重试/启动三条入口各抄一遍 runTask kick 块**，前端独立重抄状态分类，且不变式仍是纯事后扫描——这三处是后续加功能的真实摩擦点。整体 P0 0、P1 3、P2 5。

## 1. 当前架构与职责（关键文件清单）

node_run 级与 task 级两套生命周期并行，治理成熟度不对称：

- **node_run 状态机（成熟）**：`packages/shared/src/lifecycle.ts`（`nextNodeRunStatus(from, event)` 单一转移表 + `never` 穷举 + `TERMINAL_NODE_RUN_STATUSES`）；`packages/backend/src/services/lifecycle.ts`（`transitionNodeRunStatus` / `setNodeRunStatus` CAS 写入唯一入口，eslint `no-direct-node-run-status-write` 锁）。
- **task 状态机（半成熟）**：`packages/backend/src/services/lifecycle.ts` 的 `setTaskStatus` / `trySetTaskStatus`（RFC-097 CAS）——**只有 CAS，没有 `nextTaskStatus` 转移表**；合法源集 `allowedFrom` 由每个调用点自带。
- **行铸造唯一工厂**：`packages/backend/src/services/nodeRunMint.ts`（`mintNodeRun`，21 调用点，grep-guard 锁；INSERT 与状态机 UPDATE 分治）。
- **freshness / freshest-run 原语**：`packages/backend/src/services/freshness.ts`（`isFresherNodeRun` 纯 ULID 序 + `pickFreshestRun` / `pickUpstreamSourceRun` / `pickReusableShardRun` / `buildFreshestDonePerNode` / `isNodeRunFresh` / `areTransitiveUpstreamsCompleted`）。
- **回滚唯一authority**：`packages/backend/src/services/nodeRollback.ts`（`rollbackNodeRunWorktrees`，两调用模式 resume/retry，多仓两阶段 all-or-nothing）。
- **恢复 / 重试入口**：`packages/backend/src/services/task.ts`（`resumeTask` / `retryNode` / `cancelTask` / `escalateSnapshotLost`）。
- **分桶 / 派发判定（scheduler 域，本报告仅交叉印证）**：`packages/backend/src/services/dispatchFrontier.ts`（`isDispatchable` 穷举 switch + `never`、`decideScopeOutcome`、`wrapperRevivalEvidence`）。
- **不变式 + 修复**：`lifecycleInvariants.ts`（R1/R2/C1/T1/T2/T3/U1/CR-1 八条事后扫描 + reconcile）、`stuckTaskDetector.ts`（S1-S5）、`lifecycleRepair.ts` + `lifecycleRepair/options-*.ts`（14 文件）、`shared/lifecycle-alerts.ts` + `shared/diagnose-repair.ts`（规则 / 选项 taxonomy）。
- **前端镜像**：`packages/frontend/src/components/NodeDetailDrawer.tsx`（`canRetryNodeRun`）、`packages/frontend/src/routes/tasks.detail.tsx`（`isTerminal`）、`packages/frontend/src/types/lifecycle.ts`（仅 re-export 规则类型）。

## 2. 设计问题（Design）

**[LIFE-01] 任务级状态机只做了 CAS、没有转移表——与 node_run 级治理不对称** — 级别 P1｜类型 design ｜证据 `packages/backend/src/services/lifecycle.ts:231-296`（`setTaskStatus`/`trySetTaskStatus` 接受调用方传入的 `allowedFrom`），对比 `packages/shared/src/lifecycle.ts:87-160`（node_run 有 `nextNodeRunStatus(from,event)` 单一表 + `never` 穷举）｜影响：RFC-097 把 S-14 的"盲写"修成了 CAS，但**没有把 node_run 的"转移表 SSOT"那一半也搬过来**。task 的合法转移规则散在 ~20 个调用点（`scheduler.ts` 11 处、`task.ts` 4 处、`orphans.ts` / `shutdown.ts` / `fusion.ts` 各 1、`lifecycleRepair/options-*` 12 处，见 grep）。没有任何单点能回答"task 从 X 经事件 Y 能否到 Z"；新增一个 task 状态（如未来 `paused`）或新事件需逐点排查所有 `allowedFrom`。已现漂移见 LIFE-02。｜建议：引入 `nextTaskStatus(from, event)` 纯函数（事件 ADT：`claim` / `park-review` / `park-human` / `complete` / `fail` / `cancel` / `interrupt` / `resume` / `retry`），`setTaskStatus` 的 `allowedFrom` 由事件推导（`allowedFromForTaskEvent(ev)`），与 node_run 完全对称；调用点改传 `event` 而非手抄数组。

**[LIFE-02] task `allowedFrom` 集合已现不一致——同语义转移在不同入口给出不同合法源** — 级别 P2｜类型 design｜证据：`canceled` 转移在 `task.ts:960-964`（`cancelTask` fallback）`allowedFrom: ['pending','running']`，而 `scheduler.ts:4294-4298`（`cancelTaskRow`）`allowedFrom: ['running']`；`failTask`（`scheduler.ts:4271-4272`）`allowedFrom: ['pending','running']` 而其它终态写法各异；revival 路径 `scheduler.ts:2805 / 3009 / 4081` 用 `['pending','awaiting_review','awaiting_human','interrupted','canceled']` 却**独缺 `failed`**，`scheduler.ts:3543 / 3856` 又用 `['pending','running','interrupted','failed','canceled']`（含 failed 缺 awaiting_*）｜影响：每个集合是一次人工判断，差异里混着"有意"（cancel 只该从 running 兜底）和"疑似遗漏"（revival 缺 failed？），无表可对照判定，正是 S-14 治理留下的尾巴。｜建议：随 LIFE-01 落表后这些差异要么被表统一、要么作为该事件的显式特例写进表注释，杜绝"读代码猜意图"。

**[LIFE-03] 生命周期不变式是纯事后扫描，不是写入时防护（R6 残留）** — 级别 P2｜类型 design｜证据 `lifecycleInvariants.ts:706-765`（8 条 1h 周期 + 24h grace 扫描）、`stuckTaskDetector.ts`（S1-S5 同机制）｜影响：scheduler-audit §④ R6 指出"事后校验替代写入时防护 + 修复工具自身可复制事故"。R1/R2/T1/T2/T3/U1/C1 全部是 read-time diff，违例最长 24h 才升 error。其中 T1/T2（task awaiting_* ⟹ ∃ node_run awaiting_*）、U1（每 slot ≤1 活跃行）这类**结构不变式本可在写入点断言**（park 时即检 task↔node_run 双向一致；mint awaiting_* 时即检 slot 唯一）。当前模型下，一次错误 park 要等到下一轮扫描才被发现，且只能靠人点修复选项收尾。｜建议：把可前移的结构规则（T1/T2/U1）做成 `setTaskStatus`/`mintNodeRun` 的 post-condition 断言（dev 模式抛、prod 记 alert），扫描退化为"捕获绕过断言的历史脏数据"的兜底网，而非第一道防线。

**[LIFE-04] node_run 直接 mint 在 `awaiting_review`/`awaiting_human`/`failed` 绕过转移表，park 语义无单点表达** — 级别 P2｜类型 design｜证据 `nodeRunMint.ts:42-45`（`MintableNodeRunStatus` 允许直接生于 `awaiting_review`/`awaiting_human`/`failed`/`running`/`done`），与 `shared/lifecycle.ts:45-46`（`park-review`/`park-human` 事件只作用于已存在行）｜影响：设计上"INSERT 归工厂、UPDATE 归状态机"是清晰的分治，但其副作用是"一个 node_run 进入 awaiting_human"有**两条不交叉的路径**（已存在行 `park-human` 事件 vs 新行直接 born-awaiting_human），任何"进入 park 时要做的事"（如 T1/T2 一致性、广播）必须在两处都接。这是 clarify/review park 历史多次漏接 task 同步的结构根因。｜建议：mint 工厂对 born-`awaiting_*`/`failed` 增加与状态机等价的 post-mint 钩子（或把 park 收敛为"mint pending → transition park"两步），让"进入 X 状态"恒有单一汇聚点。

## 3. 实现问题 / Bug（Impl）

**[LIFE-05] `resumeTask` 的 latestPerNode 漏 `parentNodeRunId===null` 过滤——fanout/loop 子行可冒充节点最新行、导致按子行 preSnapshot 回滚** — 级别 P1｜类型 impl-bug｜证据 `task.ts:1044-1052`：
```
const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))
const latestPerNode = new Map<string, (typeof runs)[number]>()
for (const r of runs) {
  const prev = latestPerNode.get(r.nodeId)
  if (prev === undefined || r.id > prev.id) latestPerNode.set(r.nodeId, r)  // ← 不过滤 child 行
}
const toRollback = [...latestPerNode.values()].filter(
  (r) => r.status === 'failed' || r.status === 'interrupted')
```
fanout/loop 子行携带 `nodeId = innerNode.id`（与内层节点同 nodeId）且 `parentNodeRunId != null`（`scheduler.ts:3473-3508` 铸造点确证）。scheduler 的所有 authority picker 都显式 `r.parentNodeRunId !== null → skip`（`scheduler.ts:1192`、`freshness.ts:185/271/299`），唯独此处没有。当某内层节点的最新行（按 id）恰是一条 `failed`/`interrupted` 的 fanout 子行时，它进入 `toRollback`，`rollbackNodeRunForResume(task, r, …)`（`task.ts:1068`）就会**按子行的 `preSnapshot` 回滚整任务 worktree**，而非该节点真正的顶层行快照。｜影响：恢复时回滚到错误基线——resume 模式 `resetOnEmptySnapshot:false` 下若子行 preSnapshot 为空会被跳过（侥幸无害），但子行带非空 preSnapshot 时会污染恢复起点；这正是 S-13"freshest 比较器 fork"在 resume 路径的残留实例（同文件 1340 行已正确改用 `pickFreshestRun({topLevelOnly:true})`，此处漏改）。｜建议：改为 `pickFreshestRun(runs.filter(r=>r.nodeId===…))` 按 nodeId 分组、或在循环里 `if (r.parentNodeRunId !== null) continue`；补红测：fanout 任务一个子行 failed 且 id 最大 + 顶层行 done，断言 resume 不按子行 preSnapshot 回滚。

**[LIFE-06] 三处 runTask "kick scheduler" 块逐字重抄（含 ~30 行 deps 透传 + identity-compare finally）** — 级别 P1｜类型 extensibility/coupling｜证据 `task.ts:811-851`（startTask）、`task.ts:1090-1129`（resumeTask）、`task.ts:1360-1385`（retryNode）三段 `new AbortController()` → `activeTasks.set` → `void runTask({…条件展开 opencodeCmd/defaultPerNodeTimeoutMs/subagentLiveCapture/commitPush.* …})` → `.catch().finally(identity-compare delete)` 几乎逐字相同｜影响：见 §4 EXT-1，这是"加新调度 dep / 加新 kick 入口"的多文件碰撞点，且三份的 deps 透传已经不完全一致（retryNode 缺 `commitPush.*` 透传——见 `task.ts:1362-1374` 对比 `1096-1114`），意味着用户对带 commit&push 节点的任务做单节点重试时，commit&push 的 model / 重试上限 / diff 上限**不会被透传**，回退到默认值。这是已发生的漂移，非仅风险。｜建议：抽 `kickScheduler(db, taskId, deps, log): AbortController`，三入口同调；deps 透传集中一处定义。

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节重点

**[EXT-1] 加一个新调度运行时配置 / 新"触发任务跑"入口 → 碰 3+ 处 runTask kick 块** — 触发场景：半年后给任务跑加一个新 dep（如 `defaultPerTaskTokenBudget`、或新的 commit&push 配置项），或新增一个入口需要 kick scheduler（如 LIFE-03 把某修复选项改成直接 kick）。根因：runTask 的"启动协议"（AbortController 生命周期 + activeTasks 注册 + deps 条件展开 + identity-compare 清理）没有被封装成一个函数，而是 inline 抄了 3 份（`task.ts:811/1090/1360`）。现在加功能要碰：startTask、resumeTask、retryNode 三段，且容易像 LIFE-06 那样漏抄一份（retryNode 已漏 commitPush）。目标形态：单一 `kickScheduler(taskId, deps)` 拥有启动协议；`StartTaskDeps → RunTaskArgs` 的映射只存在一处（理想是 `deps.toRunTaskArgs()`）；新 dep 加一次即三入口生效。

**[EXT-2] 加一个新任务状态 / 新任务级转移 → 无 SSOT，扫 ~20 个 `allowedFrom`** — 触发场景：产品要 `paused`（手动挂起）、`queued`（限额排队）、或 review 的"批量决议中"中间态。根因：LIFE-01——task 级只有 CAS，转移合法性散在每个写点。加状态要逐一审视 scheduler / task / orphans / shutdown / fusion / 12 个 repair option 的 `allowedFrom`，且没有 `never` 穷举兜底（不像 node_run 的 `isDispatchable` / `nextNodeRunStatus` 加值即编译失败）。漏改一处 = 静默非法转移或非法拒绝。目标形态：`nextTaskStatus(from,event)` + `allowedFromForTaskEvent(ev)` 单表（对称 node_run），调用点传事件；加状态触发编译期穷举失败，强制全表覆盖。

**[EXT-3] 加一条生命周期不变式 / 修复规则 → 跨 5+ 文件的协调改动** — 触发场景：新增一类卡死检测（如"fanout 父行 done 但某子行仍 running"）。根因：规则 taxonomy 横跨 `shared/lifecycle-alerts.ts`（`LIFECYCLE_ALERT_RULES`）、`shared/diagnose-repair.ts`（`REPAIR_OPTION_IDS`）、`lifecycleInvariants.ts`（`InvariantRule` 类型 + `INVARIANT_RULES` 数组 + `checkXX` 函数 + 扫描 loop 手工 `findings.push(...await checkXX)`）、`lifecycleRepair.ts`（`REPAIR_OPTIONS` map + import）、新建 `options-XX.ts`。好消息：`satisfies Record<LifecycleAlertRule,…>` + 编译期 union 守卫（`lifecycleInvariants.ts:76-85`）让漏接**编译失败而非静默**，这是正确的"fail loud"。坏消息：`runLifecycleInvariants` 的扫描 loop（`lifecycleInvariants.ts:732-739`）仍是手抄的 8 行 `findings.push`，加 check 函数要手动接进 loop——这一步无编译保护。目标形态：把 `checkXX` 收进一个 `INVARIANT_CHECKS: Record<InvariantRule, CheckFn>` 注册表，scan loop 遍历 `Object.values`；加规则=加一个表项，loop 零改动且类型强制覆盖全 union。

**[EXT-4] 前端独立重抄状态分类（terminal / retryable）→ 后端加状态前端不知情** — 触发场景：后端加 node_run 状态（如 `paused`）或改 retryable 规则。根因：`tasks.detail.tsx:879` 的 `isTerminal` 与 `NodeDetailDrawer.tsx:660` 的 `canRetryNodeRun` 各自硬列状态字面量，与后端 `TERMINAL_TASK_STATUSES`（`lifecycle.ts:200`）/ `TERMINAL_NODE_RUN_STATUSES`（`shared/lifecycle.ts:20`）无编译链；全前端另有 52 处状态字面量散用（grep）。`frontend/types/lifecycle.ts` 只 re-export 了 alert 规则，没 re-export 状态分类。目标形态：把 `isTerminalTaskStatus` / `isTerminalNodeRunStatus` / `isRetryableNodeRunStatus` 这三个谓词放进 `@agent-workflow/shared`，前后端同源；前端删本地副本改 import，后端加状态即前端编译可见。

**[EXT-5] 加一个新"为什么 mint 这行"的语境 → RerunCause 22 值枚举 + 散布的 cause 判定** — 触发场景：新增一种 rerun（如"定时重跑"、"上游 schema 漂移重派"）。根因：`shared/schemas/task.ts:462-508` 的 `RERUN_CAUSES` 已膨胀到 22 个枚举值，且消费侧（`schedulerMintCause` / `isClarifyRerunCause` 等，`nodeRunMint.ts:168-211`）是手写 switch/字面量比较。这是 S-25 把"代理信号"换成"持久化 cause 列"的正确方向，但 cause 的语义分组（哪些算 clarify-rerun、哪些算 revival）仍散在多个判定函数里手枚举。目标形态：给 cause 加一层"分类"元数据表（`CAUSE_META: Record<RerunCause, {family, gatesInlineResume, ...}>`），判定函数读元数据而非手列 cause，加 cause 时只补一行元数据。

## 5. 耦合 / 分层违规

**[LIFE-07] `lifecycleRepair.apply` 直接 import + 调 `resumeTask`，修复引擎与任务驱动深耦合** — 级别 P2｜类型 coupling｜证据 `lifecycleRepair.ts:42`（`import { resumeTask } from '@/services/task'`）+ `:293-308`（`resumeAfterApply` 时 `await resumeTask(...)`）｜影响：修复引擎（一致性域）直接调任务驱动（执行域），且 `schedulerLivenessGate`（`lifecycleRepair/helpers.ts:20`）靠 `isTaskActive` 这一 call-site 约定来防"修复写与活调度器互踩"（RFC-097 S-23 的补丁）。这正是 scheduler-audit R4"并发守卫是 call-site 约定而非结构保证"的实例：repair 的 preflight 必须每个都记得调 `schedulerLivenessGate`，漏调 = 修复与活 loop 双写。｜建议：长期把"持有任务驱动权"做成可获取的 lease/lock（结构保证），repair 在 apply 前申请 lease 而非查 `activeTasks.has`。

**[LIFE-08] node_run 状态机与 task 状态机分居两层（shared vs backend），但 task 终态集 `TERMINAL_TASK_STATUSES` 落在 backend** — 级别 P3｜类型 coupling｜证据 `shared/lifecycle.ts:20`（node_run 终态在 shared）vs `lifecycle.ts:200`（task 终态在 backend service）｜影响：两套终态定义层级不一致，前端要判 task 终态只能重抄（EXT-4 的根因之一）；node_run 终态前端能 import，task 终态不能。｜建议：`TERMINAL_TASK_STATUSES` + 谓词上提到 shared，与 node_run 对齐。

## 6. 测试 / 可观测性缺口

**[LIFE-09] 缺 "resume latestPerNode 不含 child 行" 的回归锁** — 级别 P2｜类型 test-gap｜证据：`task.ts:1044-1052` 无对应测试；`scheduler-boundary-resume-retryindex-vs-id.test.ts` 只锁了 id-vs-retryIndex 序，没锁 parent-null 过滤｜影响：LIFE-05 这条 bug 当前无网，未来即便修了也容易回退。｜建议：补一条 fanout 子行 id 最大 + failed 的 resume property test。

**[LIFE-10] task 转移合法性无 property test（node_run 有）** — 级别 P2｜类型 test-gap｜证据：`lifecycle-property.test.ts` / `lifecycle-transition-table.test.ts` 覆盖 node_run 的 `nextNodeRunStatus` 全表，但 task 侧因无转移表函数，无法做等价的"枚举 from×event 断言"｜影响：LIFE-02 的 `allowedFrom` 漂移没有任何 oracle 测试能发现；只有具体场景测试零散覆盖部分转移。｜建议：随 LIFE-01 落 `nextTaskStatus` 后补 task 版 transition-table property test。

**[LIFE-11] runTask deps 透传完整性无测试——retryNode 漏 commitPush 透传无人发现** — 级别 P2｜类型 test-gap/observability｜证据 LIFE-06：retryNode（`task.ts:1362`）相比 resumeTask（`task.ts:1096`）少了 `commitPushModel/MaxRepairRetries/DiffMaxBytes` 三个透传，无测试断言三入口 deps 一致｜影响：带 commit&push 的任务单节点重试会静默丢失配置；属"看不见的退化"。｜建议：抽 `kickScheduler`（EXT-1）后，对 deps→RunTaskArgs 映射加单测。

**[LIFE-12] 可观测性：stalled / lost-race 都只 log.warn，无指标** — 级别 P3｜类型 observability｜证据 `scheduler.ts:460/488/515/4283`（多处 "lost to a concurrent transition — respecting winner" 仅 warn）、`decideScopeOutcome` stalled 走 failTask｜影响：CAS 竞争丢失、stalled 收尾这类"系统在自愈但可能反复"的事件没有计数器，运维只能翻日志；高频 lost-race 是潜在调度 bug 信号却无聚合面。｜建议：给 CAS-loss / stalled / orphan-reap 加计数器，接入既有 lifecycle_alerts 或 metrics。

## 7. 目标形态（Target architecture）

1. **task 与 node_run 状态机完全对称**：`shared/lifecycle.ts` 同时拥有 `nextNodeRunStatus` 与 `nextTaskStatus`，二者都是 `(from,event)→to` 纯函数 + `never` 穷举 + `allowedFromForEvent` 派生；backend 的 `setTaskStatus`/`transitionNodeRunStatus` 都只接事件、不接手抄 `allowedFrom`（消灭 EXT-2 / LIFE-01 / LIFE-02）。
2. **进入某状态恒有单一汇聚点**：park / 终态 / revival 不论经 mint(INSERT) 还是 transition(UPDATE)，都过同一钩子（post-condition + 广播 + 一致性断言），消灭 LIFE-04 的双路径漏接。
3. **启动协议封装**：`kickScheduler(taskId, deps)` 唯一拥有 AbortController 生命周期 + activeTasks 注册 + deps 映射；新入口 / 新 dep 改一处（消灭 EXT-1 / LIFE-06 / LIFE-11）。
4. **freshest-run 全收敛**：所有"节点最新行"判定一律走 `pickFreshestRun`（含 `topLevelOnly`），源码文本断言禁止任何裸 `r.id > x.id` 节点级 pick（修 LIFE-05、补 S-13 收尾）。
5. **不变式分两层**：可前移的结构规则（T1/T2/U1）做写入时断言，事后扫描退化为脏数据兜底网；修复引擎通过 lease 而非 call-site `isTaskActive` 获取驱动权（修 LIFE-03 / LIFE-07）。
6. **规则注册表化**：`INVARIANT_CHECKS` / `STUCK_CHECKS` / `CAUSE_META` 表驱动，scan loop 与判定函数遍历表项，加规则/cause = 加一行（消灭 EXT-3 / EXT-5 的手工 loop）。
7. **状态分类谓词上提 shared**：terminal / retryable / dispatchable 的人类可读谓词前后端同源（消灭 EXT-4 / LIFE-08）。

## 8. Top 风险与建议优先级（排序表）

| 优先级 | ID | 标题 | 类型 | 一句话动作 |
|---|---|---|---|---|
| P1 | LIFE-05 | resumeTask latestPerNode 漏 parent-null 过滤，按子行回滚 | impl-bug | 加 `parentNodeRunId===null` 过滤 / 改 `pickFreshestRun`，补红测 |
| P1 | LIFE-06 | 三处 runTask kick 块重抄且 retryNode 漏 commitPush 透传 | coupling | 抽 `kickScheduler`，deps 映射集中一处 |
| P1 | LIFE-01 | task 状态机有 CAS 无转移表（与 node_run 不对称） | design | 引入 `nextTaskStatus`/`allowedFromForTaskEvent` SSOT |
| P2 | LIFE-02 | task `allowedFrom` 集合已现不一致 | design | 随 LIFE-01 落表统一，特例写注释 |
| P2 | LIFE-03 | 不变式纯事后扫描，可前移的结构规则未做写入断言 | design | T1/T2/U1 前移为写入 post-condition |
| P2 | LIFE-04 | mint 直接生于 park/failed，绕过转移表无单一汇聚点 | design | mint 加 post-mint 钩子 / park 拆两步 |
| P2 | LIFE-07 | 修复引擎直接 import resumeTask + call-site liveness 守卫 | coupling | 用 lease 替代 isTaskActive call-site 约定 |
| P2 | LIFE-09/10/11 | resume parent-null / task transition / deps 透传 三处测试缺口 | test-gap | 各补 oracle/property/单测 |
| P3 | LIFE-08 | task 终态集落 backend 而非 shared | coupling | 上提 shared |
| P3 | LIFE-12 | CAS-loss / stalled / orphan-reap 无指标 | observability | 加计数器 |

### 交叉印证：既有 scheduler-audit 项的现状

- **S-12（分桶不完备黑洞）**：已被 RFC-095/098 修复——`isDispatchable`（`dispatchFrontier.ts:296-357`）现为对 NodeRunStatus 全集的穷举 switch + `never`；`Frontier.blocked` 桶 + `decideScopeOutcome` 带阻塞节点诊断载荷（`dispatchFrontier.ts:363-441`）。**已闭环，不重复发现**。
- **S-13（freshest fork）**：authority 已收敛为 `isFresherNodeRun`（纯 id 序），多数 picker 改用 `pickFreshestRun`；**残留一处**即 LIFE-05（resumeTask latestPerNode），是该项在 resume 路径的未清尾巴。
- **S-14（tasks.status 盲写）**：已被 RFC-097 修复为 CAS（`setTaskStatus`/`trySetTaskStatus`）。**但只做了 CAS 这一半，没做转移表那一半**——即 LIFE-01/LIFE-02，是本报告对 S-14 的架构层延伸。
- **S-16（node_run 铸造散布）**：已被 RFC-098 修复——`mintNodeRun` 单一工厂 + grep-guard，全仓零裸 `insert(nodeRuns)`（grep 确证）。**已闭环**。
