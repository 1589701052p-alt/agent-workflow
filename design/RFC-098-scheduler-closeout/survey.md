# RFC-098 落档前普查（5 分域，HEAD 0d3d41e，2026-06-12）

> 本文件是 design.md 的实证支撑：全部 file:line 以普查时 HEAD 为准，实现时按内容复核。

---

# 分域 wp5-locks

## WP-5 分域事实采集（S-9 / S-17 / S-24 / ⑥-10）@ HEAD 0d3d41e

前置状态：WP-4（RFC-097 任务级 CAS + 互斥）已完成（STATE.md:5），WP-5 依赖已满足；RFC-092 已落共享 rollbackNodeRunWorktrees（STATE.md:15 明示"三处 out-of-band 回滚多仓 no-op（⑥-10）归 WP-5"）。所有路径前缀 packages/backend/。

### 1. 信号量现状（S-17 事实）

**声明**：SchedulerState.globalSem/writeSem/subprocessSem = src/services/scheduler.ts:188-190；构造 :368-370（global=Semaphore(opts.maxConcurrentNodes??4)、write=Semaphore(1)、subprocess=Semaphore(opts.multiProcessSubprocessConcurrency??4)）——writeSem 仍是 per-runTask 局部实例，HTTP 服务拿不到。Semaphore 为 FIFO 计数信号量（src/util/semaphore.ts:70-130，暴露 available/queueLength，可用于"是否有在飞 writer"探测）。

**全部 acquire 点与顺序**（固定先 global 后 write，S-17 病灶）：

- 单节点 runOneNode：scheduler.ts:1617 `releaseGlobal = await globalSem.acquire()` → :1618 `releaseWrite = agent.readonly ? null : await writeSem.acquire()`；释放 :2145-2146（write 先 global 后）。
- fanout shard dispatchFanoutShard：:3113 global → :3114 subprocess → :3115 write；释放 :3173-3175。
- fanout aggregator：:3296 global → :3297 subprocess → :3298 write；释放 :3354-3356。
- commit&push：scheduler.ts:971 把 `() => state.writeSem.acquire()` 注入 runCommitPush 的 acquireWrite（C4 锁，只罩 `git add -A` + `git diff --cached`，commitPushRunner.ts:81-94 注释明示在 LLM 生成/commit/push 前释放——附录 C-9"commit 在锁外"属实，按 WP-5 顺带核实项处理）。
- wrapper-git/loop/fanout 本体在 runOneNode :1349-1356 提前 return，**不进任何信号量段**（S-24 前提成立）。
- 注释承诺位：scheduler.ts:616-618 "Writers still serialize via writeSem…readonly nodes run truly in parallel"。

**commit&push 冻结派发循环**：runScope 的 while(true) 派发循环（:667 起），节点 ok 后在循环体内同步 `await maybeRunCommitPush(state, node, iteration, log)`（:744-757，调用在 :749）。maybeRunCommitPush（:850-996）内部逐 repo 跑完整 opencode 会话（genViaOpencode→runNode :888-950，不取 globalSem），期间不 race 新完成、不派发 ready——S-17 第二半坐实。

### 2. 三处 out-of-band 回滚现状（S-9 + ⑥-10 事实）

共同形态：直接 `rollbackToSnapshot(单一 worktreePath, preSnapshot)`（util/git.ts:786 reset --hard + clean -fd + stash apply），单轨读 preSnapshot 列 ⇒ 多仓任务静默 no-op（preSnapshotReposJson 不读），且完全绕 writeSem（per-runTask 局部变量，结构性不可达）。

- **clarify.ts**：submitClarifyAnswers，taskRow 全行 :392-395、sourceRunRow 全行 :396-407（含 preSnapshotReposJson ✓）；inline-mode 跳过门 :425-431（sessionMode!=='inline' && preSnapshot 非空 && worktreePath 非空）；调用 :432，catch+warn :433-439。**改造参数在手**：taskRow 有 repoCount/worktreePath，缺 repos 数组（需补一条 taskRepos 查询或共享 helper）。
- **review.ts**：applyReviewDecision 驳回/迭代路径，taskRow :1640；`latest` 全行（pickFreshestRun :1701）；rollbackFlag 门 :1708、调用 :1710、catch+warn :1712-1717。**注意**：:1709-1718 用 `rolledBack` 布尔驱动 supersede 标记 `-rollback` 后缀（:1727-1736）——共享 rollbackNodeRunWorktrees 现返回 void 且逐仓 warn-and-continue（nodeRollback.ts:41-101），**需给它加成功信号返回值**（如 {attempted, failed}），否则 `-rollback` 语义丢失。
- **crossClarify.ts**：triggerDesignerRerun，args 只带 worktreePath（:755 签名，:786-799 回滚，调用 :793）；lastDesigner 全行（:772-777 select 全列 ✓）。**参数缺口**：args 无 task 行/repos，但函数已持 db+taskId，可内部自取；唯一生产调用点 crossClarify.ts:568 的外层有 taskRow（:520）。测试侧 10+ 文件直接构造 args（cross-clarify-service/baseline-patches/dual-write 等），故扩展字段必须可选或内部 db 查询。
- **改 rollbackNodeRunWorktrees({resetOnEmptySnapshot:false}) 的目标参数**：RollbackTarget={repoCount, worktreePath, repos[]}（nodeRollback.ts:28-33）。建议在 nodeRollback.ts 增 `loadRollbackTarget(db, taskRowOrId)`：读 tasks + taskRepos（按 repoIndex 排序，空则合成单仓条目——抄 scheduler.ts:235-260 / task.ts:1342-1349 的既有 fallback 形态），nodeRollback 现仅依赖 util/git+log，加 db/schema import 零环。resume 模式空 sha 跳过/空 worktreePath return（nodeRollback.ts:74,90-92）天然保住 clarify-service.test.ts:94"worktreePath '' 禁用回滚"的密封测试惯例。

### 3. 全局写锁注册表方案（环分析 + 接线）

**放置**：新模块 `src/services/taskWriteLocks.ts`，仅 import util/semaphore——零环。不能放 scheduler.ts（scheduler 已 import review/clarify 方向的多个服务，review.ts:29 又反向 import dispatchFrontier；clarify/review/crossClarify 反向 import scheduler 会成环）。接口：`getTaskWriteSem(taskId): Semaphore`（getOrCreate Map<taskId,Semaphore(1)>）+ `gcTaskWriteSem(taskId)`（仅当 available===capacity && queueLength===0 时删除）。
**接线**：① scheduler runTask :369 改 `writeSem: getTaskWriteSem(taskId)`（SchedulerState 字段名/类型不变，下游 :1618/:3115/:3298/:971 零改动）；② 三处 HTTP 回滚改 `getTaskWriteSem(taskId).run(() => rollbackNodeRunWorktrees(...))`（clarify 的 inline 跳过门留在锁外）；③ commitPush 经 state.writeSem 自动同把。
**释放/泄漏**：删除点只放 runTask 的 finally（与 task.ts:840-843 的 controller 身份比对 .finally 同节奏）+ HTTP 路径用完 gc-if-idle；单线程事件循环下 check-and-delete 同步原子。split-brain 风险（旧引用被缓存后注册表已换新实例）被两条规则封死：scheduler 是唯一长期缓存者且只在自身 finally 删；RFC-097 互斥保证无并发 runTask。HTTP 在任务 awaiting\_\* 挂起期临时铸的条目用后即删，残留上限为一个 Semaphore 对象/任务。

### 4. S-17 顺序反转具体改法 + 死锁分析

三处改法（readonly 路径不变，只动 writer）：

- :1617-1618 → 先 `releaseWrite = agent.readonly ? null : await writeSem.acquire()` 再 `releaseGlobal = await globalSem.acquire()`；:2145-2146 释放反序（先 global 后 write）。
- :3113-3115 → write → global → subprocess；:3173-3175 反序。
- :3296-3298 同型；:3354-3356 反序。

**死锁分析**：全局锁序收敛为 writeSem ≺ globalSem ≺ subprocessSem。反转后不存在"持 global/subprocess 再等 write"的路径（commitPush 与 HTTP 回滚都只单独取 writeSem；wrapper 本体不持任何 sem 即跑 inner scope，inner 节点各自独立取锁，无层级持有）⇒ 无环、无死锁。subprocessSem 只在 fanout 两点出现且恒处锁序末位，与反转不互斥。FIFO 保证持 writeSem 排队 globalSem 的 writer 不被 readonly 流饿死。**次生效应**：writer 持 writeSem 排队 global 期间，commit&push 的 acquireWrite 等待变长 ⇒ 派发循环冻结窗口可能加宽——commit&push 移出 race 主路径应与反转同 PR。移出方案（接口级）：把 :744-757 的 await 改为铸 synthetic in-flight promise 加入 Promise.race 集合，scope 终局（ok 出口）前 drain；C4 捕获原子性已由 writeSem 保证，"兄弟 writer 改动折进本次 commit"的归因模糊是既有行为（commit 等锁期间兄弟完成即已发生），不属新增类别，design 文档记录即可。

### 5. S-24 wrapper-git 套锁 + 空 catch 改 failed

现行：runGitWrapperNode :3384 起。baseline 捕获两处——fresh :3432、resume 损坏恢复 :3407（captureHead :3374-3382 自身也吞错返 ''）；finalize diff :3490-3495：`paths = await gitChangedFiles(...)` 的 catch 块（:3493-3495）把 DomainError（util/git.ts:636-641 'worktree-diff-failed'）吞成 `paths=[]` → :3496-3499 写空 git_diff + markWrapperTerminal('done')。markWrapperTerminal 签名支持 errorMessage（scheduler.ts:2335-2340）。wrapper-git 已被闸死单仓（scheduler.ts:316-330 multi-repo 拒入），task.worktreePath 可安全使用。
**套锁方案**：baseline 捕获（:3407/:3432）与 finalize 捕获段（:3490-3499，含 nodeRunOutputs 写入前的 diff 读取）各包一层 `state.writeSem`（注册表实例）acquire/release——与 C4 同语义"无 writer mid-write 时才采样"；wrapper 不在持锁期间跑 inner scope，无死锁。
**空 catch 改法**：catch 不再降级——`markWrapperTerminal(db, wrapperRunId, 'failed', \`git-diff-failed:${err.message}\`)` + broadcast failed + return {kind:'failed', summary:..., message:'git-diff-failed'}；真空 diff（正常返回空数组）才走 done。消息形态对齐既有 'wrapper-empty'/'inner failed' 短码 + supersede 前缀式可 grep 约定。

### 6. 测试面

**scheduler-audit-\* 锁定文件 FLIP**（本分域仅 s17 有锁定文件；**s09/s24 无专属 audit 锁文件**，红测需按报告 oracle 新写）：

- tests/scheduler-audit-s17-readonly-starved-by-writer-queue.test.ts：头注 :1-36 明示修复时翻红——末断言 :253 `expect(auditorStart).toBeGreaterThanOrEqual(earliestWriterEnd)` 翻转为 `toBeLessThan(earliestWriterEnd)`（readonly 与首 writer 真并行）；其 writer 两两不重叠断言（:238-246）保持绿。3 writer + readonly、capacity 2、gate 痕迹文件，结构性断言不赌毫秒。

**既有测试翻红/受影响排查**：

- tests/wrapper-git-list-path.test.ts:99-100 源码文本断言 `portName:'git_diff', content: paths.join('\n')`——S-24 改写 finalize 块时必须保住该文本或同步改断言。
- tests/reviews-iterate-mints-new-run.test.ts（:39-45 起多处）断言 `-rollback` 后缀——⑥-10 共享化必须保留成功信号（见 §2），否则翻红。
- tests/scheduler-boundary-fanout-concurrency.test.ts（:168/:200 两条墙钟下限）：A 是 readonly shard 走 caps=1 串行、B 是 writer 经 writeSem 串行——锁序反转后两floor均成立，保持绿（该文件即附录 B-3 的"信号量布线"回归网，WP-5 的 grep-guard/守卫执行入口设计约束所在）。
- tests/scheduler.test.ts "two write agents serialize"（s17 头注引 :622）墙钟串行——反转后 writer 依旧串行，绿。
- tests/rfc092-midrun-clarify-dispatch.test.ts：真实 runTask + 真实 submitClarifyAnswers mid-run；agent 全 readonly（:156 注释明示）⇒ submit 取任务写锁不阻塞，绿；但若 WP-5 采"defer 回滚给调度循环"变体则需重验。
- tests/clarify-service.test.ts（:15-18、:94）/ clarify-rerun-write-ordering.test.ts（:104,:123）/ cross-clarify 系列：均以 worktreePath '' 密封回滚——nodeRollback 内置空目标 return（:90-92）保持等价，绿；triggerDesignerRerun 扩参必须可选否则 10+ 构造点要改。
- tests/scheduler-audit-s04-git-wrapper-cumulative-diff.test.ts（S-4/WP-6c 锁）与 s07-s28（S-7/S-28 锁，git wrapper insert-pending/broadcast-running 行号 :3230-3231 已漂移至 :3431-3433 一带）：S-24 套锁不改变 diff 内容/状态时序语义，不翻红，但行号引用注释会过期。
- tests/scheduler-commit-push.test.ts / ws.test.ts：commit&push 移出主路径后只要 scope 终局前 drain，"task done 时 commit row 存在 + 已推远端"断言保持绿；ws 事件相对顺序需自查。
- tests/commit-push-runner.test.ts:246/:271：acquireWrite 注入契约（签名不变）——绿。

**需新写的 RED 测试**（报告 WP-5 oracle + S-24 建议）：① 4 写+N 读公平性（=s17 翻转）；② wrapper-git ∥ 顶层 writer 并发（diff 不含对方半成品/不争 index.lock）；③ clarify mid-run 对"在飞 writer"任务提交答案——回滚必须等 writer 释放锁（writer 持锁期 worktree 不被 reset）；④ finalize 前删 worktree → wrapper failed 且 errorMessage 含 git-diff-failed；⑤ 多仓任务三处 HTTP 回滚逐仓生效（⑥-10 翻转，可参数化三入口复用 rfc092-node-rollback.test.ts harness）。

### 7. 最小实现草案（接口/数据流级）

PR 内分四步（同 RFC 单 PR，依赖序）：

1. **taskWriteLocks.ts 注册表**（§3 接口）+ scheduler :369 接入 + runTask finally gc——纯重构零行为变化，既有绿网验证。
2. **⑥-10 三处接线**：nodeRollback.ts 增 `loadRollbackTarget(db, …)` helper + rollbackNodeRunWorktrees 增返回值 {attempted, failed}（向后兼容，void 调用方不受扰）；clarify :425-439 / review :1708-1718 / crossClarify :786-799 改 `getTaskWriteSem(taskId).run(() => rollbackNodeRunWorktrees(target, runRow, {resetOnEmptySnapshot:false}, log))`；review 用返回值驱动 rolledBack；crossClarify args 加可选 target（缺省内部 db 自取）。S-9 与 ⑥-10 同笔解决。
3. **S-17 反转**（§4 三点 + 释放反序）+ commit&push synthetic in-flight 化（:744-757）；s17 文件按头注翻转；更新 :616-618 注释。
4. **S-24 套锁 + fail-closed**（§5）；保住 wrapper-git-list-path 文本锚或同步更新。
   每步带对应 RED→GREEN 用例（§6 新写清单），门禁 typecheck+test+format+build:binary smoke。

---

# 分域 wp6b-fanout

## WP-6b（fanout 恢复幂等：S-19/S-20/S-21）分域事实采集 @ HEAD 0d3d41e

全部行号为现行源码定位（报告行号已漂移）。核心文件：`/Users/wangbinquan/Documents/proj/agent-workflow/packages/backend/src/services/scheduler.ts`（下称 scheduler.ts）。

### 1. S-19 现行形态：prior-child 复用查询 + 为何 daemon-restart 能复用而 failed-retry 不能

- **prior-child 复用查询**（dispatchFanoutShard，scheduler.ts:2964 起）：scheduler.ts:2988-2998 按 `(taskId, nodeId=innerNode.id, parentNodeRunId=wrapperRunId)` 检索后 `priorChildren.find((r)=>(r.shardKey??null)===rowShardKey)`（:2998）——锚点字段是 **当前 wrapperRunId + shardKey**，且只比 shardKey 不比 value。done 子行原样回放 outputs（:3000-3009）；非终态/failed 子行原地 reset pending 重跑（:3010-3022，allowTerminal + allowedFrom=['pending','running','interrupted','failed','canceled']）；查无 → 铸新行（:3023-3036，iteration 写入在 :3031）。
- **findResumableWrapperRun**（scheduler.ts:2292-2322）：按 `(taskId,nodeId,iteration)` 取 desc(id) limit 1，status ∈ {done, failed, exhausted} 视为 terminal 返回 null（:2312）；`interrupted`/`canceled`/`pending`/`awaiting_*` 非 terminal → 返回原行（canceled 是 RFC-095/S-22 扩的复活语义，:2313-2319 注释）。fanout 无专门判定，与 loop/git 共用此函数（fanout 调用点 :2600）。
- **daemon-restart 路径能复用的原因**：重启 reap 把 running wrapper 行翻成 `interrupted`（NODE_KIND_BEHAVIORS['wrapper-fanout'].orphanReap='mark-interrupted'，shared/src/node-kind-behavior.ts:159-165）→ findResumableWrapperRun 返回**同一行** → `wrapperRunId` 不变（:2602-2622 原行转 running）→ :2995 的 parentNodeRunId 等值条件命中旧 done 子行。锁定测试：scheduler-boundary-fanout-resume-duplicate-shards.test.ts。
- **failed-retry 重铸链路**：task failed → `retryNode`（task.ts:1077）对 wrapper 节点铸 retryIndex=max+1 的 `failed` 占位行（task.ts:1238-1252；继承源 pickFreshestRun topLevelOnly :1233，目标行直接继承 runRow :1236）或 `resumeTask`（task.ts:941；:999-1007 latestPerNode 无 parent 过滤）→ task CAS pending → runScope/deriveFrontier 视 failed 为 dispatchable（dispatchFrontier.ts:167-169）→ runFanoutWrapperNode → findResumableWrapperRun 取到最新行（failed 占位或 failed wrapper 行）→ **null** → `insertNodeRun` 铸全新 wrapperRunId（scheduler.ts:2624）→ :2995 锚定新 id 永远查不到前代 done 子行 → 全量重跑。

### 2. 锚点改 (taskId, nodeId, iteration, shardKey) 的方案（含 parentNodeRunId 归属 + frontier 安全）

**frontier 不可见性约束现行位置**：deriveFrontier 的 latestPerNode 在 scheduler.ts:1101 `if (r.parentNodeRunId !== null) continue` 跳过子行（报告旧 :1092）；同口径还有 freshness.ts:179（buildFreshestDonePerNode）、freshness.ts:207（pickFreshestRun topLevelOnly）、scheduler.ts:1582（mint 继承扫描）。**只要复用后的子行 parentNodeRunId 保持非 null，约束自动满足**——两种归属方案都安全，差异在历史可读性：

- **方案 A（推荐）：保留旧 parent + 查询放宽**。dispatchFanoutShard 的查询改为 `(taskId, nodeId=innerNode.id, iteration, shardKey)` + `parentNodeRunId IS NOT NULL`（排除 retryNode cascade 给 inner 节点铸的顶层 inert 占位行，task.ts:1225-1228 注释），按 isFresherNodeRun 取最新行：freshest 为 done 且 value-hash 匹配 → 直接回放 outputs（不改 parent，不铸行）；freshest 非 done 且 parentNodeRunId===当前 wrapperRunId → 原地重跑（保留现分支）；freshest 非 done 但属前代 → 铸新行挂当前 wrapper（不跨代改写历史行）。注意：用户直接 retryNode 某 shard 子行时，task.ts:1246-1247 铸的占位行继承该子行的 shardKey+旧 parent（非 null）→ 放宽查询会取到它（freshest 且非 done）→ 触发该 shard 重跑，恰符用户意图。**耦合点：aggregator 的 innerRows 查询（:3219-3228）必须同步放宽**（否则新 wrapper 的聚合查不到跨代复用的 done 子行）。现有索引 idx_node_runs_task (taskId,nodeId,iteration,retryIndex)（schema.ts:557）前缀可用，无需新索引。代价：frontend NodeDetailDrawer.tsx:109 按 parentNodeRunId 分组展示子行 → 复用的 done 子行仍显示在前代 wrapper 下（历史真实，可接受）。
- **方案 B（备选，更小实现）：retry 时继承（re-parent）**。新 wrapper 铸行后一次性 `UPDATE ... SET parentNodeRunId=新id WHERE parentNodeRunId=前代id AND status='done'`（前代 = 同 (taskId,nodeId,iteration) 的 freshest terminal wrapper 行）。aggregator/dispatch 查询零改动；缺点：改写历史归属（前代 failed wrapper 在 UI 失去 done 子行）、与 provenance 审计（S-20 consumed 代际对账）冲突。s18-s19 test 2 头注释（:31-34）两种修法都预留了翻转指引。

### 3. S-20 value 摘要：存储位置 schema 结论

- 现行缺口：复用只比 shardKey（scheduler.ts:2998/:3000）；非 path 类 list 的 key 是 0 基 index（shared/src/shardingRegistry.ts:75 `defaultIndexKeyOf`；path 族用 path 本身 :82-87）；wrapper 每次进入（含 resume）无条件用新 resolve 的 consumed **覆盖**旧值（scheduler.ts:2633-2649），错配证据被抹掉；items 重新 split 在 :2655-2658。
- **child 行无现成语义列**：node_runs 全列检查（schema.ts:424-560）——promptText/errorMessage/wrapperProgressJson（文档限定 wrapper 行，wrapperProgress.ts:1-35）/consumedUpstreamRunsJson（RFC-074 §8 明确 inner shard 行不写 provenance，scheduler.ts:2642-2645 注释）均不可挪用。**需迁移**：建议 0043（现最新 0042_rfc079）加 `node_runs.shard_value_hash TEXT`，铸行点 :3025-3035 写 sha256(shard.value)（createHash 先例 util/git.ts:8,257）；shared(null shard) 行不写。
- **wrapperProgressJson 可承载 per-shard hash map 但不推荐为主方案**：WrapperProgressSchema kind 枚举仅 'loop'|'git'（wrapperProgress.ts:41），需扩 `kind:'fanout' + shardHashes:Record<shardKey,hash>`；终态后 JSON 保留可读（scheduler.ts:2356-2358 注释），跨代读取需先定位前代 wrapper 行再解 JSON，查询绕、且 hash 与被复用行不在同一行上（错配面）。零迁移是唯一优势。
- **hash 之外必须加 consumed 代际门（path 族盲区的补偿）**：path 类 shard.value 即路径字符串，hash 恒等捕不到"同路径内容被改写"。在 :2646 覆盖写之前先读旧 consumedUpstreamRunsJson 与新 resolved consumed 比较（跨代复用则比前代 wrapper 行的 consumed）：不一致 → 本次禁用全部 done-shard 复用（flag 传入 dispatchFanoutShard）→ 再覆盖写。该门同时落实报告建议修法第二款。
- **hash 空值政策必须是 null=match（legacy 兼容）**：scheduler-boundary-fanout-resume-duplicate-shards.test.ts 与 scheduler-audit-s21 test 1 都预铸无 hash 子行且断言复用/不重跑（s21 断言整个恢复仅 spawn 1 次 agg，:285-289）——选 null=mismatch 两个测试立刻翻红。

### 4. S-21 aggregator：铸行形态 / 残留 / 复用方案

- 现行：dispatchFanoutAggregator（scheduler.ts:3201 起）每次进入无条件 `ulid()` 新铸（:3262-3273，shardKey=null, parentNodeRunId=wrapperRunId）；重启残留的 interrupted agg 行永久无人认领（s21 test 1 :308-311 锁定）。聚合挑行：innerRows 查询 `(taskId, edge.source.nodeId, parentNodeRunId=wrapperRunId)` 无 status 过滤无 orderBy（:3219-3228），perShard 用 `innerRows.find((r)=>r.shardKey===s.shardKey)` 取 SELECT 首行（:3233），shared 分支 `find(shardKey===null)` 同病（:3246）；当前仅因 fail-all（:2806-2816）进聚合时"碰巧"全 done 才无害。聚合输出复制到 wrapper outlet 在 :2890-2897。
- 复用分支方案（镜像 shard）：查 `(taskId, aggNode.id, iteration, shardKey IS NULL, parentNodeRunId IS NOT NULL)` 取 freshest——done 且按 id-order 比全部本轮参与 shard 行都新（isFresherNodeRun 口径，防止 shard 重跑后回放陈旧聚合）→ 复用 outputs；非终态/interrupted/failed 且属当前 wrapper → 原地 reset pending 重跑（s21 test 1 FLIP 期望正是 id===staleAggId 原地复用，:307）；属前代的非 done 残留 → 铸新行。
- innerRows 挑行改造：filter(status==='done') + 每 shardKey 按 isFresherNodeRun 取最新 + 锚放宽与第 2 节方案 A 同步（这是 6b 内部最强耦合：shard 跨代复用落地而 aggregator 锚不放宽 = 聚合静默读空）。

### 5. 测试面（FLIP / 保绿清单）

测试目录：`/Users/wangbinquan/Documents/proj/agent-workflow/packages/backend/tests/`。

**必翻（按文件内注释指引翻转）**：

- `scheduler-audit-s18-s19-fanout-failure-semantics.test.ts` **test 2 (S-19)**：FLIP 指引在头注释 :31-34 + 行内 :405-409、:421-433——mock 计数 '6'→'4'（run2 只重跑 1 个失败 shard）；方案 A 下新 wrapper 子行 3→1（仅失败 key）、byKey 2/2/2→2/1/1；方案 B 下按"done 子行被继承挂新 wrapper"重写 :421-439。`wrapperAfterRun2.length===2`、`newWrapper.status==='done'` 不变。**test 1 (S-18) 不翻**（fail-all 已按 RFC-094 方案 A 定版为正式回归锁，:15-20；6b 不动失败语义）。
- `scheduler-audit-s21-fanout-aggregator-idempotency.test.ts` **test 1**：FLIP 指引 :12-15——aggRows 2→1、残留行原地复用（id===staleAggId、status 'done'）、freshRow 断言删；spawn 计数 1、聚合 prompt 内容、outlet 'final' 断言保持。**test 2（源码文本锁）必翻红**：`innerRows.find((r)=>r.shardKey===s.shardKey)`、segment 不含 'status'/'orderBy'、body 不含 'priorChild'、`const aggRunId = ulid()` 四组断言全失配（:344-360）——按头注释 :27-30 改写为"必须包含 done 过滤/复用分支"的正向断言或删除。
  **必须保绿（修法约束）**：
- `scheduler-boundary-fanout-resume-duplicate-shards.test.ts`：口径是**同代**（同 wrapper 行 pending-resume）幂等——每 shardKey 恰 1 行（:279-285），靠"同代非终态子行原地重跑"分支保证；锚放宽不得移除该分支，hash 政策必须 null=match。
- `scheduler-audit-s07-s28-wrapper-consumed-status.test.ts`：fanout wrapper 行 consumed 非 null 的现状面——consumed 改"先比后写"仍写入即不翻。
  **评估不受影响（单次顺跑/纯函数面）**：scheduler-boundary-canceled-fanout-status、scheduler-boundary-fanout-concurrency、scheduler-boundary-fanout-shardkey-collision + fanout-shardkey-collision-oracle、scheduler-wrapper-fanout-e2e（5 用例）、scheduler-wrapper-fanout-routing、scheduler-audit-s05-fanout-inner-chain、dispatch-frontier-fanout-fresh（锁 fanout 用自身 iteration 扫描窗）、fanout-shard-scope、workflow-validator-wrapper-fanout。findResumableWrapperRun 本身不改（failed 保持 terminal，复用走子行锚）→ scheduler-boundary-wrapper-resume-interrupted 等 loop/git resume 测试零波及；若改走"failed wrapper 行可 resume"路线则该函数三 wrapper 共用、波及面扩大到 loop/git，**不建议**。
  **需新增 oracle（报告 6b 条目）**：failed→retry 不重跑 done shard（即 test 2 翻转）、重启后上游新内容对应 shard 重跑（新集成测试：pre-seed done 子行带 hash + 改输入 → 断言该 shard 重 spawn）、聚合阶段重启无重复行（即 s21 test 1 翻转）。

### 6. 最小实现草案（接口/数据流）

1. 迁移 0043：`ALTER TABLE node_runs ADD COLUMN shard_value_hash TEXT`（drizzle schema.ts nodeRuns 同步加列）。
2. 纯函数 `pickReusableShardRun(rows, {shardKey, valueHash})`（落 freshness.ts 或新 fanoutResume.ts；done-only + isFresherNodeRun + hash null=match）——对应热点重构"freshest-run 共享 picker"缝，shard 与 aggregator 共用一份，不 fork。
3. dispatchFanoutShard：查询锚改 (taskId, innerNodeId, iteration, shardKey, parentNodeRunId IS NOT NULL)；三分支（done+hash 匹配→回放 / 同代非 done→原地重跑 / 其余→铸新行写 hash）；签名加 `reuseDisabled: boolean`。
4. runFanoutWrapperNode：:2633-2649 改"读旧 consumed → 与新 consumed 比 → 不等则 reuseDisabled=true → 覆盖写"；跨代场景比前代 wrapper 行 consumed。
5. dispatchFanoutAggregator：加复用分支（第 4 节）；innerRows 改 done-filter + freshest-per-shardKey + 锚放宽（与 3 同口径）。
6. 测试：翻转 2 个 FLIP 文件 + 新增"上游变更 shard 重跑"用例；保绿清单回归跑全量 fanout 测试。

---

# 分域 wp6c-loopgit

【WP-6c 设计事实采集】基线 HEAD 0d3d41e（报告行号基于 f9db99f，已全部按内容重定位）。重要前置：报告 WP-1~5 的多数已以 RFC-092（pending 锚点 bypass + 共享回滚）、RFC-093（dbTxSync）、RFC-094（validator 禁入 + 注释清账）、RFC-095（穷举分桶 + canceled 复活 + decideScopeOutcome）、RFC-096（pickFreshestRun 收敛）、RFC-097（task status CAS）落地；WP-6c 是 wrapper 语义补全的剩余工作包，其依赖（WP-3 共享 picker）已满足。

━━ 一、S-7：loop/git wrapper 行不写 consumedUpstreamRunsJson ━━

▸ 现行写点普查（全仓 grep 确认）：

- agent 路径：packages/backend/src/services/scheduler.ts:1601-1604（pendingExisting 复用时重 stamp）、:1608-1613（fresh mint 经 insertNodeRun inherit）、:1715-1720（进程重试新行）。来源 = resolveUpstreamInputs 的 consumed 字典（:1504-1512），恒写、最少 '{}'。
- fanout wrapper：scheduler.ts:2633-2649 —— 进入时（mint/resume 之后、空源短路 :2659 与 shard 派发之前）调 resolveUpstreamInputs(node.id)（:2633）并把 consumed 写上 wrapper 行（:2646-2649，注释明写 RFC-074 §8 D3）。每次进入都覆盖写（含 resume——这正是 S-20 指出的覆盖掩盖问题，归 WP-6b）。
- loop wrapper：runLoopWrapperNode（scheduler.ts:2365-2528）全段零写入；行铸造点 :2440 `insertNodeRun(db, taskId, node.id, 'pending', 0, parentIteration)` 无 inherit → consumed=NULL。
- git wrapper：runGitWrapperNode（:3384-3502）同样零写入；铸造点 :3430。
- insertNodeRun（:3532-3564）：inherit?.consumedUpstreamRunsJson ?? null（:3559）。
- 后果机制：freshness.ts:54-65 isNodeRunFresh —— parseConsumedJson(null)={} → 空 map 恒 fresh（:26-40, :58-64）→ done wrapper 行永不判 stale（isDispatchable done∧fresh→false，dispatchFrontier.ts:165-166）。

▸ inner 外部上游集怎么算（关键事实）：v1 loop/git wrapper **不接受任何入边**（workflow.validator.ts:414-431，edge-target-port-missing 'does not accept inbound edges in v1'）——所以对齐 fanout 只复制 resolveUpstreamInputs(wrapper.id) 会得到恒 '{}'，没用。外部数据实际经「外部节点 → inner 节点」直连边进入（inner 的 resolveUpstreamInputs 用全量 definition.edges，:3766，iteration≤i 窗口 :3787）。正确的并集 = {e.source.nodeId | target ∈ wrapperInnerDescendants(w)（dispatchFrontier.ts:79-93）∪ {w}，source ∉ 该集合}，并复用 buildScopeUpstreams 的通道边跳过规则（scheduler.ts:4179-4195：**clarify**→clarify、**clarify_response**、**external_feedback**、to_designer、to_questioner）+ review inputSource 隐式依赖同款（:4206-4213）。注：把「target=wrapper 自身」也纳入是为覆盖 wrapper→wrapper 排序边（s04 测试即用 wg1→wg2 边）。每个 source 的 run id 选取必须与 resolveUpstreamInputs 同口径（:3786-3800：top-level∧done∧iteration≤窗口，先取最高 iteration、同 iteration 按 isFresherNodeRun 纯 id 序）——建议把这段两阶段 picker 抽成共享 pickUpstreamSourceRun（呼应 R2/「freshest-run 抽一次别 fork」既有缝；pickFreshestRun（freshness.ts:198-212）只覆盖 id 序不含 iteration 优先级）。
▸ 写入时机：对齐 fanout = 每次进入（fresh mint 与 resume 均写），位置在 inner runScope 之前——loop 落点 :2440-2442 之后进 for 循环（:2445）之前；git 落点 :3438 之后 runScope（:3440）之前。entry 时写而非 finalize：finalize 写会把「上游 mid-run 推进」记成新值反而掩盖 stale（与 fanout 语义一致）。
▸ 修复后果链（已验证机器兼容）：上游 rerun → wrapper done 行 stale → isDispatchable(done∧!fresh)=true → 重派 → findResumableWrapperRun（:2292-2322）见 done 为 terminal（:2312）返回 null → 铸新 wrapper 行 → loop 从 iteration 0 整体重跑 / git 重抓 baseline（正确语义）；inner 旧 done 行因 agent 自身 consumed 已记外部上游会在新一代 frontier 中自然判 stale 重跑。零 frontier 改动。需在 RFC §失败模式记录：wrapper 整体重跑时 worktree 残留无回滚（wrapper 行不抓 preSnapshot），属已知开放点。
▸ 顺带核实附录 C-8：isNodeRunFresh absent→fresh（freshness.ts:60-61）与裸 nodeId 键属实；S-7 修复不受影响（wrapper 的外部上游与 wrapper 同处 top scope，buildFreshestDonePerNode（freshness.ts:170-184）的 scopeIds 过滤能命中）。另发现 fanout 自身的 consumed 漏 broadcast 上游：inner 直连外部边的 consumed 在 :2764-2773 被显式丢弃（只取 inputs），wrapper 行只记 wrapper 自身入边——若 6c 抽出 computeWrapperConsumed 助手，fanout 可一并补齐（决策点：放 6c 或归 WP-6b/S-20）。

━━ 二、S-4：git wrapper 不扣 pre-existing 脏改动 + git-in-loop 累计 diff ━━

▸ 现行流程：fresh mint（:3429-3438）→ captureHead = 仅 `git rev-parse HEAD`（:3374-3382，catch 吞错返回 ''）→ persistWrapperProgress {kind:'git', baseline, phase:'inner-running'}；resume（:3399-3408）从 progress 读 baseline，malformed 才 best-effort 重抓（:3404-3407）；finalize（:3484-3498）→ gitChangedFiles(worktreePath, baseline||'HEAD')（util/git.ts:627-667：`diff --name-only <from>` + `ls-files --others --exclude-standard` 全部 untracked 无条件并入）→ catch 吞成 paths=[]（:3493-3495，S-24 域，WP-5 修，6c 不动但有交互）→ 写 git_diff 端口（list<path>，RFC-060 PR-E）→ done。design/design.md:821-837 的 pre_diff 扣除完全未实现；§6.5 文档仍写 unified-diff compose（与 list<path> 现实不符，需同步）。
▸ wrapperProgress payload 结构（wrapperProgress.ts:39-68）：{kind:'loop'|'git', iteration?, baseline?, phase}，zod .passthrough() 前向兼容——加字段安全。
▸ pre 集捕获两案评估：

- 案 A（推荐）：entry 时抓 pre 脏集（gitChangedFiles(worktree, baseline) 的路径 + 每路径 blob sha，`git hash-object` 批量；删除态用哨兵值），存 progress 新 optional 字段（如 preDirty: Record<path,sha>）。finalize 差集规则：post 路径 ∈ pre 且当前 hash == pre hash 才扣（wrapper 内又改过的文件保留）。优点：零新 git 对象、无 GC 风险（不扩 S-11 病面）、与 baseline 同款持久化语义（resume 不重抓）、内容级判定精确。缺点：progress JSON 体积随脏文件数增长（可设上限降级为纯路径集）。
- 案 B（否决）：gitStashSnapshot sha 存 progress。决定性缺陷：util/git.ts:763-769 是 plain `git stash create`，**不含 untracked**——而 untracked 恰是 S-4 主触发面（s04 测试的 fileA.txt 即 untracked）；且 dangling 对象会被 gc（audit S-11 同病扩面）；finalize 需 stash^3 树比对，实现更重。
- resume fallback 决策点：progress 缺 preDirty（旧行/损坏）时**必须回退为空集**（多报=今日行为），绝不可 resume 时重抓（会把 inner 已写文件误入 pre 集 → 静默漏报，比现状更糟）。
  ▸ git-in-loop 缺口与改法：每轮迭代铸独立 git wrapper 行（iteration 轴在 wrapper 行上已修好，s04 测试 :376-382 确认 2 行 2 迭代），但 agent 不 commit 时各轮 baseline 同为 HEAD 且前轮 untracked 残留 → 迭代 N diff = 0..N 并集。**无需「迭代间 baseline 重置」**：案 A 的 entry pre 集天然包含前轮残留 → 差集后即每轮独立 diff，一个机制同修 (a) 顺序双 wrapper 与 (b) git-in-loop。外层「last-iter wins」由 resolveUpstreamInputs 最高 iteration 优先（:3795）已成立。

━━ 三、S-3：approve-in-wrapper 永久卡死 ━━

▸ 现行 approve 路径：review.ts submitReviewDecision（:1438-）approve 分支 :1539-1635（多文档 approveMultiDocReview :1359-1436）——只写 approved*doc/approval_meta 输出 + transitionNodeRunStatus approve-review 翻 review 行 done（:1619-1624 / :1422-1427），**不铸任何 pending 行、不碰 wrapper 行**，返回 resumeRequired:true（:1634/:1435）→ routes/reviews.ts:174-200 fire-and-forget resumeTask（RFC-097 已做 task-not-resumable 分类吞错）。resumeTask 的 task allowedFrom 含 awaiting_review（task.ts:977）→ 调度器重入 → wrapper 行 awaiting*_ 的唯一放行通道 wrapperHasFreshInnerWork（dispatchFrontier.ts:106-125）只扫 status==='pending'（:122-124）→ 恒 false → isDispatchable :180-182 false → frontier 落 awaitingReview 桶（scheduler.ts:1200-1202）→ decideScopeOutcome 优先级 awaiting*review（dispatchFrontier.ts:255-260）→ 任务弹回 awaiting_review，永久循环。
▸ parked 祖先 wrapper 行怎么找：approve 分支当前不加载 workflowSnapshot（reject/iterate 有现成样板 review.ts:1640-1652）；containment 用 buildContainerMap 同型逻辑（scheduler.ts:4245-4281，innermost wins；SchedulerState.containerOf :333-336/:371 在 scheduler 内部，review.ts 需自建或抽共享纯函数）——从 dv.reviewNodeId 沿 containerOf 链上溯收集祖先 wrapper ids，对每个查 latest 行（pickFreshestRun）status ∈ awaiting*_（嵌套时整链可能各有一个 parked 行，需全翻）。
▸ 两案对比：

- 案一「approve 翻 wrapper 行 pending」：setNodeRunStatus to='pending' allowedFrom=['awaiting_review','awaiting_human']。机器全现成：isDispatchable(pending)=true（dispatchFrontier.ts:163-164）；findResumableWrapperRun 视 pending 非 terminal（:2312）→ 同行+progress 续跑；enter-running allowedFrom 已含 'pending'（:2425/:3415）；mid-run 场景直接走 RFC-092 pending 锚点 bypass（scheduler.ts:1175-1189）零 frontier 改动。缺点：① wrapper 复活知识泄入 review.ts（新增跨模块翻行点，S-16/R3 散布反模式扩面）；② 边角：同一 runScope 调用内对同一 wrapper 行二次 approve（两个顺序 review）时，wrapper 行 id 已入 dispatchedPendingRowIds（:660/:692-693 行 id 一次性豁免）→ 第二次翻 pending 被挡 → quiescent 落 blocked('pending-anchor-consumed') → stalled（S-1 同族退化，resume 可解但难看）。
- 案二「扩展 wrapperHasFreshInnerWork 认『inner review 行 done∧fresh』」：谓词改返回证据行（窗口内 max-id 的 inner pending 行 ∪ **限定 kind==='review'** 的 done∧fresh 行；函数已持有 definition 可查 kind——不限定 review 则任何 inner done 都解锁，clarify park 直接失效且 dispatch-frontier.test.ts:196-214/:247-256 翻红属真回归）。配合下节锚点扩展处理 mid-run。证据是 level 信号：跨 invocation 每次 resume 在同窗口二次 park 形态下会多一次空转再 park（有界，可接受）。
- RFC-095 一致性判定：RFC-095 复活机器 = 状态即信号 + isDispatchable/deriveFrontier 集中判定 + findResumableWrapperRun 同行续跑 + enter-running allowedFrom 扩源（rfc095-wrapper-canceled-revival.test.ts 锁三件套）。**案二与之同构**（决策留在 dispatchFrontier 集中点，review.ts 零新写点），且同一锚点机制顺手关闭 RFC-092 限制与 iterate/reject mid-run 三件事——推荐案二为主。案一是 audit 原文亦认可的「与 resume-clarify 同型显式 transition」，可作 fallback；不建议两案并存（双通道难以论证幂等）。

━━ 四、RFC-092 已知限制：wrapper 内 clarify mid-run 答复仍停泊 ━━

▸ 限制原文：design/RFC-092-scheduler-p0-stopgap/design.md:92-97 —— bypass 只豁免 pending 行不豁免 wrapper awaiting*\* 行；wrapperHasFreshInnerWork 判 true 仍被 dispatchedThisInvocation 挡下 → 任务停泊 awaiting_human（inbox 已空）需手动 resume；明示归 WP-6c。
▸ 现行 bypass 实现：runScope scheduler.ts:655（dispatchedThisInvocation）/:660（dispatchedPendingRowIds）/:692-693（锚点记账）；deriveFrontier :1175-1179 pendingAnchorReleasable（latest.status==='pending' ∧ 行 id ∉ 豁免集 ∧ nodeId ∉ openAskingNodeIds（:1142-1147，answer-write 竞态窗守卫））；:1180-1184 dispatchable = 传递上游完成 ∧ ∉inFlight ∧ (pendingAnchorReleasable ∨ ∉dispatchedThisInvocation) ∧ isDispatchable；:1187-1189 pendingAnchors 仅对 latest pending 记录。clarify 答复铸行：clarify.ts:441-462（pending rerun 在 sourceRunRow.iteration = loop 计数器 i = progress 窗口，先铸行后翻 session :465-470）。
▸ 具体改法：wrapperHasFreshInnerWork 重构为 wrapperRevivalEvidence(wrapperRow, rows, definition) → {rowId, nodeId} | null（窗口规则不变：loop 用 progress.iteration、git 用行自身 iteration，:113-120；证据 = 窗口内 max-id inner pending 行，案二时 ∪ review-kind done∧fresh 行；布尔壳保留兼容）。deriveFrontier 增 wrapperAnchorReleasable：latest.status ∈ awaiting*_ ∧ WRAPPER*KINDS ∧ evidence ≠ null ∧ evidence.rowId ∉ dispatchedPendingRowIds ∧ evidence.nodeId ∉ openAskingNodeIds；并入 :1183 的或式；ready 时 pendingAnchors.set(wrapperNodeId, evidence.rowId)（runScope :692-693 记账逻辑零改动）。
▸ 忙循环论证（五层，与 RFC-092 §1.3 同构）：① 证据行 id 一次性豁免——同一证据至多多放一次；② 派发即入 inFlight（:694）——同 tick 不重复；③ wrapper 复活立即翻 running（:2421-2437）——latest 离开 awaiting*_，谓词条件自然失效；④ inner runScope 经 pendingExisting 复用消费 pending 行（:1593-1604，行翻 running→终态）——证据消失；新证据只能由新的人工动作（答题/决策）铸出新 ULID；⑤ 病理兜底：inner 早退路径泄漏 pending 行（RFC-092 已知形态）时锚点已记账 → 不再放行 → 退化为 park/stalled 有界语义。open-asking 窗口（答案未写完、session 未翻 answered）由 ④' evidence.nodeId ∉ openAskingNodeIds 守卫（与 :1179 同款，session 翻 answered 后下一 tick 放行）。

━━ 五、测试面（FLIP 摘要 + 邻域依赖）━━

▸ 必翻（CURRENT-BEHAVIOR LOCK，文件头自带翻转指引）：

- tests/scheduler-audit-s03-wrapper-approve-stuck.test.ts：案二 → 4 处 [S-3 LOCK] false→true（:88-99 loop、:145-152 git）；案一 → 纯函数断言保持绿、文件头改「谓词契约锁定」并以 approve 路径集成测验证复活（指引 :15-25）。窗口取值规则用例（:112-121/:154-167）两案下都必须保持——复活证据必须落在 progress 窗口。
- tests/scheduler-audit-s04-git-wrapper-cumulative-diff.test.ts：:316-317 wg2Paths → ['fileB.txt']；:399-400 paths1 → ['iter-1.txt']；:289-300 机制锁扩展为断言两 wrapper 的 pre 集不同（wg2 pre 含 fileA.txt）。
- tests/scheduler-audit-s07-s28-wrapper-consumed-status.test.ts：[S-7 LOCK] :272-275（loop，无上游 def → 期待 '{}'）、:326-327（git）toBeNull→not.toBeNull；纯函数组 :84-98 的生产形态断言转为对照组；fanout 对照 :336-400 不动；**S-28 断言（:285-290/:331-333/:396-399）属 WP-6d 勿动**。
  ▸ 邻域（不应翻红，动刀后必跑）：
- tests/dispatch-frontier.test.ts：:179-214 wrapper N2 两用例（fixture 是 agent-single done）——案二扩展必须限定 review kind 才不翻；:216-285 窗口精确性用例全保持；需新增 review-done 证据正例。
- tests/rfc095-wrapper-canceled-revival.test.ts：三件套（canceled dispatchable / findResumableWrapperRun 非 terminal / allowedFrom 含 canceled）与 6c 正交；走 loop 路线 decode progress.iteration，S-4 给 git progress 加字段不影响（passthrough）；S-7 在复活路径也会写 consumed（entry 覆盖写），该测试不断言 consumed → 绿。注意其文件头引 ⑥-11：retryNode 以 wrapper 行为直接目标不走续跑——归 WP-6d，6c 勿顺手动。
- tests/scheduler-rfc040-wrapper-await.test.ts：锁「resume 不重抓 baseline、git_diff 只写一次」——S-4 实现必须同款「pre 集只在 fresh mint 抓、resume 从 progress 读、malformed 回退空集」否则可能翻红其 git_diff 断言；是 S-4 的关键邻域回归闸。
- tests/scheduler-audit-s01-pending-rerun-dispatch-dedup.test.ts：已是 RFC-092 修复后正确语义锁（非 current-behavior）；锚点扩展只增不改 pending 路径 → 应保持绿。
- tests/derive-frontier.test.ts（N3 fixture 为 failed，RFC-092 已核实不受影响）、tests/freshness.test.ts B1（null→fresh 机制保留）、tests/scheduler-audit-s06（validator 已禁嵌套 loop，RFC-094）、tests/scheduler-audit-gap4（readPortAtIteration，WP-6a 域）：均不受 6c 影响。
- packages/backend/src/services/scheduler.ts 既有集成测（scheduler.test.ts 单 wrapper-git 干净 worktree / 1 迭代 git-in-loop）：pre 集为空 → 行为不变。

━━ 六、最小实施方案草案（接口/数据流级别，建议单 RFC 内 3 task / 可拆 3 PR）━━

T1（S-7，无依赖）：① 抽 pickUpstreamSourceRun（resolveUpstreamInputs :3786-3800 的 iteration-窗口两阶段 picker）入 freshness.ts；② 新增纯函数 wrapperExternalUpstreamSources(wrapperNodeId, definition)（wrapperInnerDescendants + 通道边过滤 + review inputSource）放 dispatchFrontier.ts（保持纯模块契约）；③ scheduler 侧 computeWrapperConsumed(db, taskId, definition, wrapperId, iteration) → 写点：loop :2442 后 / git :3438 后（每次进入覆盖写，对齐 fanout）；④ oracle：翻 s07 + 新增「上游 clarify rerun 后 loop wrapper 判 stale 重派、git 重抓 baseline」集成测（audit :312 指定）。决策点：fanout broadcast 上游 consumed 缺口此包带修 or 留 WP-6b。
T2（S-4，无依赖）：① WrapperProgressSchema 加 optional preDirty: Record<path, sha>（'deleted' 哨兵）；② fresh-mint 分支抓 pre 集（gitChangedFiles + hash-object 批量），resume 从 progress 读、malformed 回退空集；③ finalize 差集（hash 相等才扣）；④ design.md §6.5 同步（list<path> 现实 + pre 扣除语义 + RFC-060 PR-E 降级记录）；⑤ oracle：翻 s04 两断言 + pre 集机制断言 + 跑 scheduler-rfc040-wrapper-await 闸。不动 :3493-3495 空 catch（S-24/WP-5 界面，注明交互）。
T3（S-3 + RFC-092 限制，依赖 T1 无强耦合）：① wrapperHasFreshInnerWork → wrapperRevivalEvidence（pending ∪ review-kind done∧fresh，窗口不变）；② deriveFrontier 增 wrapper 锚点 releasable + pendingAnchors 记录（:1175-1189 一处改动）；③ oracle：按案二翻 s03 四断言 + approve-inside-loop / approve-inside-git e2e（双 resume 断言 done）+ mid-run e2e（慢 sibling + wrapper 内 clarify 答复 / approve，断言任务自动 done 不需手动 resume）+ dispatch-frontier 新增 review-done 证据正例与「非 review inner done 不解锁」负例。若维护者择案一：改 review.ts approve 分支（加载 snapshot + containerOf 上溯 + 整链翻 pending），s03 保绿改契约锁，并接受双 approve 同调用的 stalled 退化（或叠加锚点扩展兜底）。
顺序建议：T1 → T2 → T3（T3 的 e2e 会同时覆盖 T1 的 stale 重派路径）；全程先翻/补 oracle 再动刀（fortify-then-refactor 仓规）。

---

# 分域 wp6d-wp10

【WP-6d + WP-10 分域事实普查】（全部 file:line 按现行 HEAD 0d3d41e 核对；报告原行号已漂移，下文一律给现行行号）

═══ 一、S-28：wrapper 行 DB 全程 pending / WS 广播 running ═══

■ 现行状态流（三类 wrapper 同型，三处 fresh-mint 点）：

- loop：`runLoopWrapperNode` fresh-mint `insertNodeRun(..., 'pending', 0, parentIteration)` → 立即 `broadcastNodeStatus(..., 'running')`，中间无任何 DB 转移 — packages/backend/src/services/scheduler.ts:2440-2441
- fanout：`runFanoutWrapperNode` 同型 — scheduler.ts:2624-2625
- git：`runGitWrapperNode` 同型 — scheduler.ts:3430-3431
- 对照：resume 路径（existing 非 running）三处都先 `setNodeRunStatus({to:'running', allowedFrom:['pending','awaiting_review','awaiting_human','interrupted','canceled'], allowTerminal:true})` 再广播 — loop scheduler.ts:2419-2438、fanout :2604-2622、git :3409-3428。即 pending→running 的 DB 转移在 resume 路径存在、fresh-mint 路径缺失。
- `insertNodeRun` 工厂（未导出）status 参数类型只允许 `'pending'|'done'|'awaiting_review'|'awaiting_human'`（不含 running）— scheduler.ts:3532-3546。
- `markWrapperTerminal` 注释失真确认：注释声称 "allowedFrom=['running'] is the typical legal source"，实际 allowedFrom=['pending','running','awaiting_review','awaiting_human']（fresh-mint wrapper 全程 pending，pending 才是典型来源）— scheduler.ts:2341-2349。
- runner eager 广播先于 CAS 同样在位：runner.ts:524-530（inject-snapshot eager write 后广播 `status:'running'`）发生在 mark-running CAS（`transitionNodeRunStatus({event:{kind:'mark-running'}})` runner.ts:664-669）之前——广播瞬间 DB 行仍 pending。另有合法的 mid-run 节流 running 重广播（runner.ts:809-818, 851/862/894-899），不在此问题内。

■ 最小改法草案：

1. 三处 fresh-mint 后立刻补一笔 `transitionNodeRunStatus({event:{kind:'mark-running'}})`（pending→running 是 RFC-053 既有合法转移，与 runner.ts:664 同款），广播移到转移之后。不建议让 insertNodeRun 直接铸 running（跳过状态机，且 commitPushRunner.ts:126 直接铸 'running' 的先例正是要被工厂收敛的形态）。
2. 之后收紧 `markWrapperTerminal` allowedFrom：去掉 'pending' 并修正注释（scheduler.ts:2342-2349）。影响面核查：mint 与首个 markWrapperTerminal 之间的全部调用点——fanout 的 inner-missing/agent-missing 失败（scheduler.ts:2714/2741/2751）、空 shardSource 短路 done（:2665，s07-s28 测试第三例锁定此路径）、loop/git 的 inner canceled/failed（:2458/:2463、:3446/:3451）——只要 mark-running 紧贴 mint，全部 from='running' 合法。resume 路径已显式转 running。唯一残余 pending 来源是 daemon 崩溃后的孤儿行，由 orphans reaper 翻 interrupted（pending/running 同等收割），不走 markWrapperTerminal。
3. runner 侧：eager 广播（runner.ts:524-530）要么下移到 mark-running 之后，要么 status 改播 'pending'（与 DB 一致）；在 lifecycle.ts 注释固化「先写 DB 后广播」规则。

═══ 二、⑥-11：retryNode 以 wrapper 自身 canceled 行为目标 → 不走续跑 ═══

■ 机制链（逐点核实）：

- retryNode 状态门只拒 pending/running（task.ts:1095-1100）+ RFC-097 CAS 翻 pending（task.ts:1108-1123，allowedFrom 含 canceled = RFC-095 复活路径）。
- 占位行铸造：`targets.add(runRow.nodeId)` 用户选中节点无条件入列（task.ts:1209）；对每个 target 铸 `status:'failed', retryIndex:max+1, errorMessage:'queued for retry'` 占位行，继承 iteration/reviewIteration/shardKey/parentNodeRunId/preSnapshot（task.ts:1238-1252）。wrapper 三件套 retryCascade='mint-placeholder'（packages/shared/src/node-kind-behavior.ts:141-165）→ 下游 wrapper 也铸。
- `findResumableWrapperRun` 取 (taskId,nodeId,iteration) 最新一行（desc(id) limit 1），status ∈ {done,failed,exhausted} → return null（RFC-095 后 canceled 已不再 terminal）— scheduler.ts:2298-2321。failed 占位行成为 latest → null → 三处 mint 新 wrapper 行 iteration 0 重启；git wrapper 还会 `captureHead` 重取 baseline（scheduler.ts:3432）。
- 派发入口：isDispatchable(failed)=true（dispatchFrontier.ts:151 起的穷举 switch，failed/interrupted case return true）→ wrapper 被重派进 runOneNode → 上述链条触发。
- 前端入口确认：`canRetryNodeRun` 把 canceled 列为可重试（packages/frontend/src/components/NodeDetailDrawer.tsx:660-672）——wrapper canceled 行的 UI retry 按钮确实拿不到续跑语义。

■ 修法两案（接口/数据流级）：

- 方案 A（retryNode 特判，改 task.ts）：当 target 行 nodeId 的 kind ∈ wrapper 三件套且 runRow.status ∈ {canceled,interrupted}（复活语义行）时不铸 failed 占位行——该行本身已是 isDispatchable 复活信号（RFC-095），任务翻 pending 后 runTask 重派 wrapper → findResumableWrapperRun 命中 canceled 行 → 续跑。kindOf map 现在只在 cascade=true 分支构建（task.ts:1150-1157），需提前到无条件构建。下游 cascade 的 wrapper 占位行保留（上游变更后重启 from iteration 0 是正确语义）。代价：retry-cascade-kind-matrix.test.ts 钉死的「target 无条件铸行」矩阵翻红（该文件头注 task.ts:9-11 已预告 "RFC-053 PR-C may change that"）。
- 方案 B（findResumableWrapperRun 认占位行，改 scheduler.ts）：查询去掉 limit 1，跳过 `errorMessage==='queued for retry'` 的 failed 行再看次新行；命中 canceled/interrupted/awaiting\_\* 即复用。建议用共享常量（先例：REVIEW_SUPERSEDE_MARKER_PREFIX 在 dispatchFrontier.ts 单一事实源、review.ts 引用拼接），勿散落字符串。代价：占位行残留为 latest 对其他 picker（pickFreshestRun/attempts 显示）的语义要逐点核查。
- 推荐：A 为主（占位行对 wrapper 复活语义本来就是噪声，不铸最干净）；若 WP-10 先行，B 可升级为按 `rerun_cause='retry-node'` 判定，两案统一。无论哪案，先给 rfc095-wrapper-canceled-revival.test.ts 补「直接以 wrapper 自身 canceled 行为目标」的 RED 用例（现文件刻意用 inner 行做目标绕开此入口，文件头有声明）。

═══ 三、S-16：裸 insert(nodeRuns) 清单（现行重数）+ mintNodeRun 工厂 ═══

■ 现行普查（grep 全 src 非测试，13 命中 / 6 文件，与报告口径一致，行号已漂移）：

1. scheduler.ts:3549 — `insertNodeRun` 半工厂内部（未导出；13 个 scheduler 内调用点：1333 output 虚拟 done、1426 cross-clarify 无 questioner 守卫、1446 persistent-stop done、1476 input 虚拟 done、1608 agent 首派/复活/stale 重派【继承 reviewIteration+shardKey+parentNodeRunId+consumed，scheduler.ts:1590-1613】、1715 进程重试【同继承集】、2440/2624/3430 三 wrapper fresh-mint【零继承】）
2. scheduler.ts:899 — commit&push 会话子行（parentNodeRunId=容器行, shardKey:null；无 review/consumed）
3. scheduler.ts:3025 — fanout shard 子行（parentNodeRunId=wrapperRunId, shardKey=rowShardKey；D3 设计内不写 consumed）
4. scheduler.ts:3263 — fanout aggregator 行（parentNodeRunId=wrapperRunId, shardKey:null）
5. review.ts:575 — awaiting_review 直铸（reviewIteration + consumedUpstreamRunsJson；无 shard/parent）
6. review.ts:1748 — iterate/reject 重跑行（retryIndex=next, parentNodeRunId:null 显式, preSnapshot 继承；无 shardKey/consumed）
7. clarify.ts:172 — clarify 节点 awaiting_human park 行（parent+shardKey 继承，iteration 恒 0）
8. clarify.ts:443 — clarify 答复重跑行（retryIndex 重置 0，iteration/parent/shard/reviewIteration/preSnapshot 全继承）
9. crossClarify.ts:210 — cross-clarify awaiting_human park 行（仅 iteration=loopIter）
10. crossClarify.ts:828 — designer 重跑行（retryIndex 刻意 ≥1 防误触 isClarifyRerun 门——crossClarify.ts:805-820 注释明示这是代理信号 hack；继承全集）
11. crossClarify.ts:944 — questioner stop/reject 重跑行（retryIndex 0，继承全集）
12. commitPushRunner.ts:126 — commit 容器行（直接铸 status:'running'！唯一非 pending 起步）
13. task.ts:1238 — retryNode failed 占位行（见 ⑥-11）
    继承字段全集（各点手抄子集）：retryIndex / iteration / reviewIteration / shardKey / parentNodeRunId / preSnapshot / consumedUpstreamRunsJson / startedAt / finishedAt / errorMessage。

■ mintNodeRun 工厂签名草案（cause 参数前置 WP-10）：
`mintNodeRun(db, { taskId, nodeId, status: 'pending'|'running'|'done'|'failed'|'awaiting_review'|'awaiting_human', cause: RerunCause, retryIndex?, iteration?, inheritFrom?: NodeRunRow|null /* 一处声明继承清单: reviewIteration,shardKey,parentNodeRunId,preSnapshot */, overrides?: { parentNodeRunId?, shardKey?, consumedUpstreamRunsJson?, errorMessage?, finishedAt? } }) → Promise<string>`

- 落位：新文件 services/nodeRunMint.ts（scheduler↔review/clarify/crossClarify 都要 import，放 scheduler 会扩大既有模块环——RFC-096 刚断半的环不要回灌）。
- 迁移序（两步，工厂先落=纯重构）：T1 工厂落地 + 13 处机械迁移（行为零变化，cause 参数先收集不落库或暂落 nodeRunEvents 审计事件）+ grep guard 测试（先例：lifecycle-grep-guard.test.ts 对 `.update(nodeRuns).set({status})` 的源码扫描 + `// rfc053-allow-direct-status-write` 行内豁免标记机制，复制为 `insert(nodeRuns)` 仅 nodeRunMint.ts 允许）；T2 = WP-10 加列后 cause 落库。

═══ 四、S-25 / WP-10：rerun_cause 列 + 门控 switch(cause) ═══

■ schema 现状：nodeRuns 表 packages/backend/src/db/schema.ts:424-560，现行列集 = id/taskId/nodeId/parentNodeRunId/iteration/shardKey/retryIndex/reviewIteration/status(10 值枚举)/startedAt/finishedAt/pid/exitCode/errorMessage/promptText/tok×5/preSnapshot/opencodeSessionId/inventorySnapshotJson/wrapperProgressJson/injectedMemoriesJson/portValidationFailuresJson/commitPushJson/preSnapshotReposJson/consumedUpstreamRunsJson。无任何 cause 类列。
■ 迁移惯例：packages/backend/db/migrations/00NN*{rfc}*{slug}.sql + meta/\_journal.json 追加 entry（最新 0042_rfc079_review_multidoc，journal idx 41）；加可空列用单句 ALTER（0040 先例：`ALTER TABLE node_runs ADD COLUMN consumed_upstream_runs_json text`）、删列才走 12-step rebuild（0041 先例）。rerun_cause 是可空 text → 单句 ALTER 即可；测试惯例配 migration-00NN-\*.test.ts。
■ RerunCause 枚举草案（从 13 铸行点反推全集；scheduler:1608 一个 mint 点按 latestExisting 分裂为三值）：
`'initial'`（首派，latestExisting===undefined）/ `'stale-redispatch'`（上游 fresher 致 done 行判 stale 重派）/ `'revival'`（canceled/interrupted latest 复活重铸，RFC-095/resume 路径）/ `'process-retry'`（scheduler:1715）/ `'clarify-answer'`（clarify.ts:443）/ `'cross-clarify-answer'`（crossClarify.ts:828 designer 更新）/ `'cross-clarify-questioner-rerun'`（crossClarify.ts:944，stop/reject 双路）/ `'review-iterate'` 与 `'review-reject'`（review.ts:1748 按 args.decision）/ `'review-park'`（review.ts:575）/ `'clarify-park'`（clarify.ts:172）/ `'cross-clarify-park'`（crossClarify.ts:210）/ `'retry-node'`（task.ts:1238 用户选中目标）/ `'retry-node-cascade'`（同点下游占位）/ `'fanout-shard'`（scheduler:3025）/ `'fanout-aggregator'`（scheduler:3263）/ `'wrapper-init'`（2440/2624/3430）/ `'commit-push'`（commitPushRunner:126）/ `'commit-push-session'`（scheduler:899）/ `'io-virtual'`（1333/1476）/ `'cross-clarify-guard'`（1426/1446）。
■ 门控区现行代理信号判定点（scheduler.ts 1823-2040，currentRunRow 读行 :1828-1830，cause 落列后即可随行读取——pendingExisting 复用路径 :1593-1604 也天然带上铸行时 cause）：

1. `clarifyGeneration = priorDoneGenerations.length`（:1841-1850，priorDoneGenerationsForRun 定义 :4018）——这是生成索引推导不是成因代理，**保留**（buildPromptContext targetIteration / memoryInject 锚点仍用）。
2. `isClarifyRerun = clarifyGeneration > 0 && retryIndex === 0`（:1868）→ 改 `cause === 'clarify-answer'`。消费点：inline sessionMode 门（:1886-1889）、priorSessionId 读取（:1869-1878）、applyLatestDirective（:1958/:1969）。
3. `isCrossClarifyTriggeredRerun = hasExternalFeedbackChannel && clarifyGeneration > 0`（:1912）→ 改 `cause === 'cross-clarify-answer'`（拓扑门可留作 belt-and-braces）。消费点：priorDoneDesigner 工作草稿注入（:1913-1923, :1990-2007）。
4. `isQuestionerCrossClarifyRerun = clarifyMode === 'cross'`（:1947，纯拓扑 + buildPromptContext 内 RFC-070 consumed-by 自门控）→ cause 为附加信号（'cross-clarify-questioner-rerun'），保留自门控。
5. directive='stop' 单轮门（:2015 effectiveHasClarifyChannel）随 2 联动。
6. **副产品**：crossClarify.ts:805-820 的「designer 重跑 retryIndex 刻意 ≥1 以保 isClarifyRerun=false」hack 在 switch(cause) 后可拆除（该注释整段是代理信号互相踩踏的活化石）；buildExternalFeedbackContext designerGeneration（:1976-1985）继续用 generation 推导不动。
   ■ 配套测试：`(consumerKind × cause)` 真值表新测试穷举注入矩阵（报告 WP-10 oracle 要求）。

═══ 五、测试面盘点 ═══

■ S-28 锁定/FLIP（无独立 s28 文件，并在 s07-s28）：packages/backend/tests/scheduler-audit-s07-s28-wrapper-consumed-status.test.ts——文件头 :16-23 给翻转指引；三处 [S-28 LOCK] 断言 `pairs[0]?.db === 'pending'` 修复后翻成 'running'：loop :289、git :332、fanout :398（观测法：taskBroadcaster.subscribe listener 同步执行，broadcast 瞬间同步读 DB，零竞态）。注意同文件 [S-7 LOCK]（consumed 恒 NULL，:275/:327）属 WP-6c 勿误翻。markWrapperTerminal allowedFrom 收紧波及核查清单：rfc095-wrapper-canceled-revival / scheduler-boundary-canceled-fanout-status / scheduler-wrapper-fanout-routing（均引用 wrapper 终态行为，预期 mark-running 紧贴 mint 后保持绿，动刀后逐一跑）。
■ ⑥-11：rfc095-wrapper-canceled-revival.test.ts 文件头明示用 inner 行做目标绕开此入口——修复时补 wrapper-自身-行目标 RED 用例；方案 A 翻红 retry-cascade-kind-matrix.test.ts 的「target 无条件铸行」钉点（文件头 :9-11 已预告可改）；scheduler-audit-s22-canceled-retry-stall.test.ts 已是 RFC-095 语义锁（非现状锁），目标为 agent 节点，预期不翻。
■ S-16：无专属 scheduler-audit-s16 锁定文件（不可直接测的结构项）；纯工厂重构以全量 3560 后端用例为回归网，预期零翻红；新增 grep guard（仿 lifecycle-grep-guard.test.ts）。s13 文件（scheduler-audit-s13-freshest-fork-source-guards.test.ts）是源码守卫棘轮，工厂改动若触碰 retryIndex 文本需核对 G8 白名单。
■ S-25：无专属 s25 锁定文件。门控既有回归网 ≈14 文件 / 65 用例：clarify-prompt-injection(16)、cross-clarify-update-mode-injection(6)、cross-clarify-questioner-context(6)、scheduler-clarify-dispatch(7)、scheduler-cross-clarify-dispatch(5，:535-639 复刻生产任务)、scheduler-clarify-inline(4)、clarify-stop-directive-scoped-to-clarify-rerun(4)、cross-clarify-stop-directive-scoped-to-cci-rerun(4)、scheduler-cross-clarify-no-runaway(4)、cross-clarify-designer-retry-index(3，**锁 retryIndex≥1 hack，拆 hack 时必翻**)、scheduler-clarify-mid-batch(2)、clarify-rerun-write-ordering(2)、rfc092-midrun-clarify-dispatch(1)、clarify-inline-isolated-parity(1)。switch(cause) 若行为等价，除 designer-retry-index 外预期全绿；它们是 WP-10 的主回归网。

═══ 实施顺序建议（分域内）═══
WP-6d 内序：S-28 三处 mark-running + 广播后移（小、独立、s07-s28 三断言翻转）→ markWrapperTerminal allowedFrom 收紧 + 注释修正 → ⑥-11 方案 A + RED 用例。WP-10 序：T1 mintNodeRun 工厂（纯重构 + grep guard）→ T2 migration 0043 加 rerun_cause 可空列 + 工厂落 cause + migration 测试 → T3 门控四点改 switch(cause) + (consumerKind×cause) 真值表 → T4 拆 crossClarify retryIndex hack（cross-clarify-designer-retry-index 翻转）。S-28 的 wrapper 样板收敛（三件套 mint/resume/terminal 同型代码抽 wrapperRuntime helper）建议在工厂落地后做，mint 点先收敛到工厂可少抄一遍。

---

# 分域 wp8-wp9

【WP-8+WP-9 事实普查（HEAD 0d3d41e，行号均为现行源码实测）】

━━━ 一、S-15 进程治理：现状事实 ━━━

A. spawn 形态与 kill 序列（packages/backend/src/services/runner.ts）

- Bun.spawn 调用点：runner.ts:747-754（cmd/cwd/env/stdout:'pipe'/stderr:'pipe'/stdin:'ignore'），未传 detached/signal/timeout/killSignal。
- pid 落库唯一写点：runner.ts:756-758 `db.update(nodeRuns).set({ pid: child.pid })`；schema 列 db/schema.ts:461 `pid: integer('pid')`，node_runs.startedAt 在 schema.ts:459。
- safeKill 签名：runner.ts:1506-1512 `function safeKill(child: Bun.Subprocess, signal: 'SIGTERM' | 'SIGKILL'): void`（try child.kill(signal) catch 吞）。全部调用点恰 2 个，均只传 SIGTERM：abort 路径 runner.ts:764-767（onAbort）、timeout 路径 runner.ts:773-779（setTimeout）。'SIGKILL' 字面量在 runner.ts 非注释行仅出现于签名 1 次。
- child.exited 无界等待：runner.ts:933 `const exitCode = await child.exited`，无 Promise.race/最终超时；紧随其后 runner.ts:940 `await Promise.all([stdoutPump, stderrPump])` 同样无界——注意：即便子进程死了，**孙进程继承的 stdout 管道 FD 不关，pump 也不 EOF**，这是第二个挂点（进程组杀可同时解决）。
- 最终状态判定：runner.ts:944-964 aborted→'canceled'('aborted by signal')、timedOut→'failed'('node-timeout: exceeded …ms')、exitCode!==0→failed。escalation 不影响该语义（aborted/timedOut 标志先行短路）。
- pluginInstaller 升级先例：pluginInstaller.ts:384-387 —— runCommand 的超时计时器直接 `child.kill('SIGKILL')` + reject（一击 SIGKILL，非 TERM→KILL 链；用的是 node:child_process spawn）。

B. Bun API 可行面（已实验验证，非猜测）

- @types/bun 1.3.13（bun-types bun.d.ts:6688-6701）：Bun.spawn 支持 `detached?: boolean` —— POSIX 下调 setsid()，子进程自成 session+进程组组长。另有 `timeout` / `killSignal` / `signal: AbortSignal` 原生选项（bun.d.ts:6894-6955），但都是一击式信号，无两段升级。
- 本机实验（bun 1.3.13 / darwin）：`Bun.spawn({detached:true})` 后 child pgid==pid；`process.kill(-child.pid,'SIGTERM')` 成功且**孙进程同灭**（bash 里 fork 的 sleep 也被杀）。结论：进程组杀完全可行，方案=detached:true + process.kill(-pid, sig)，fallback child.kill。无需标注待实验。
- 注意点：detached 后子进程不再随 daemon 终端信号死（现状本就如此，orphans.ts:9-11 自述 v1 不清理存活孤儿）；宽限计时器需 unref 防止 bun test 挂住。

C. pid 落库后零读点（确证）

- 唯一非展示读点不存在：task.ts:1486 `pid: r.pid` 是 API DTO 映射（纯展示）。orphans.ts / stuckTaskDetector.ts 全文零 pid 引用。
- 活性探测既有原语：util/lock.ts:103-112 `isProcessAlive(pid)`（process.kill(pid,0)，EPERM 视为存活）——只用于 daemon 单实例锁，可直接复用。
- 接入点 1 reapOrphanRuns：orphans.ts:26-86，boot 时（cli/start.ts:138）把全库 running/pending 行翻 interrupted；对 pid 非空且存活的行当前**不杀直接翻**，存活孤儿继续写 worktree、用户随即 resume 即并发写（S-15 爆炸半径）。pid 复用降噪：结合 node_runs.startedAt 时间窗（如 <48h）+ `ps -p pid -o command=` 含 opencode/bun 双门。
- 接入点 2 resumeTask：task.ts:941-1018（rollback 循环在 task.ts:1009-1018）、retryNode rollback 在 task.ts:1185——回滚前对目标行 pid 做存活检查；推荐"先组杀再回滚"而非 409（cancelTask 已是 abort+5s 轮询模型 task.ts:895-909）。

D. stuck 检测盲区 S5

- 现行规则结构：stuckTaskDetector.ts:1-24（S1-S4 注释）；候选集 loadCandidates :82-103（pending/running/awaiting\_\*）；任务级最新事件时间查询 latestEventTsForTask :110-120（max(nodeRunEvents.ts) join nodeRuns on taskId）——S5 的 per-run 版本照此模式按 nodeRunId 过滤即可。
- 盲区位置精确在 checkOne 的 running 分支 :242-264：S3 要求 `counts.total>0 && counts.active===0`；**active>0 且 30min 无事件**（挂死 opencode：running 行有、事件停了）恰好落空——freshness 闸 :203-208 已算好 inactiveForMs，S5 就是该分支的 else 半边（active>0 → 告警，detail 带 [{nodeRunId,nodeId,pid,lastEventTs}]）。
- 加 'S5' 的类型涟漪（全部编译期强制）：backend lifecycleInvariants.ts:63 `type StuckRule` + :102 `STUCK_RULES`；shared/src/lifecycle-alerts.ts:7-22 `LIFECYCLE_ALERT_RULES`；shared/src/diagnose-repair.ts:90-108 `REPAIR_OPTION_IDS`（satisfies Record<LifecycleAlertRule,…>）；backend lifecycleRepair.ts:75-88 `REPAIR_OPTIONS`（satisfies 要求**非空 tuple**——S5 至少要一个 option，可仿 S4 给 ['S5.cancel-task'] 或 acknowledge 型）。前端无 S1-S4 字面量硬编码（grep 确认），靠 shared union 编译检查。

━━━ 二、S-11 快照钉住：现状事实 ━━━

A. util/git.ts 现行实现

- gitStashSnapshot：util/git.ts:763-769 —— `git stash create`，干净树返回 ''；产物 commit 无任何 ref/reflog 钉住（s11 测试已实证 gc --prune=now 即灭）。
- rollbackToSnapshot：util/git.ts:786-801 —— 顺序 reset --hard HEAD(:787) → clean -fd(:791) → sha!=='' 时 stash apply --index(:795-799 抛 'worktree-apply-failed')。先销毁后恢复确证。
- runGit：util/git.ts:43-61（Bun.spawn 包装，never throws）——update-ref / cat-file 直接走它。
- 快照写点（仅 2 处，均在 scheduler）：scheduler.ts:1778 单仓（落 nodeRuns.preSnapshot，schema.ts:472）；scheduler.ts:1790-1813 多仓 per-repo map（落 preSnapshotReposJson，schema.ts:547）。**两处都在 nodeRunId/taskId 作用域内**，pinRef 命名素材现成。
- 回滚调用方现行坐标（报告行号已漂移）：共享回滚 nodeRollback.ts:41-101（RFC-092，per-repo catch+warn :77-83/:95-100）；scheduler 重试路径 scheduler.ts:1695-1708（catch+warn）；resume 壳 task.ts:870-881→resumeTask task.ts:1010 / retryNode task.ts:1185；三处 out-of-band：clarify.ts:425-439、review.ts:1707-1718、crossClarify.ts:787-800（全部 catch+warn 继续）。
- gitStashSnapshot 无其它调用方（全仓 grep 确认）。

B. refs 钉住方案落点

- ref 名建议 `refs/agent-workflow/snapshots/{taskId}/{nodeRunId}`（taskId 段为了按任务批删）。git worktree 的 refs 写入共享源仓 odb（refs/worktree/\* 之外都是 common ref），用户在源仓跑 gc 也会因 ref 可达而保留——正中报告"源仓共享对象库"痛点。多仓：每个子 worktree 在各自源仓 odb 建同名 ref，互不冲突。
- 谁删：**唯一安全删除点是 worktree GC**（gc.ts:72-75 removeWorktree 成功后，对 t.repoPath 执行 for-each-ref refs/agent-workflow/snapshots/{taskId} + update-ref -d 批删）。理由：cancelTask/终态都不能删——retryNode 允许 done/canceled/interrupted/awaiting*\* 全部复活（task.ts:1107-1123 allowTerminal 注释明示 canceled→pending 是 RFC-095 复活路径、done→pending 是显式重跑），resumeTask 允许 failed/interrupted/awaiting*\*（task.ts:955-965）；快照 ref 生命周期应 == worktree 生命周期。任务行是软删（task.ts:764 deletedAt），无硬删钩子。注意 gc.ts 多仓盲区（审计⑥缺口3：TERMINAL_STATUSES gc.ts:23-28 含可恢复的 interrupted/failed、多仓容器目录误用 removeWorktree）——WP-9 只挂单仓 ref 清理，多仓清理与缺口 3 同 PR 族处理并注明。
- fail-closed 改法：rollbackToSnapshot 在 :787 reset 之前、仅当 sha!=='' 时先 `git cat-file -e <sha>^{commit}`，失败→抛新 code 'snapshot-missing'（不动工作区）；sha==='' 路径（纯 reset+clean）语义不变——scheduler-boundary-presnapshot-rollback-skip.test.ts 锁的就是 '' 路径，不受影响。
- resume 升级为任务级错误的接线：rollbackNodeRunWorktrees 返回值从 void 改为 {failures:[{worktreeDirName?,code,message}]}（仅 snapshot-missing 升级，其它 code 维持 warn-and-continue 字节兼容）；resumeTask（task.ts:1009-1018，当前注释自认 warn-and-continue）/ retryNode（:1185）收到 snapshot-missing → setTaskStatus pending→failed（lifecycle.ts:223 CAS，allowedFrom:['pending']，errorSummary='snapshot-lost'）+ 向 HTTP 抛错。三处 out-of-band（clarify/review/crossClarify）本身有 HTTP 上下文，最小做法：fail-closed 后它们的 catch 不再掩盖销毁（工作区已不被破坏），可保留 warn；是否 re-throw 留 RFC 决策点。scheduler.ts:1695-1708 重试路径：snapshot-missing → 节点 failed 而非静默。

━━━ 三、测试面：翻红/FLIP 清单 ━━━

WP-8 必翻红（按文件头 FLIP 指引翻转为正向守卫）：

- tests/scheduler-audit-s15-sigterm-no-escalation-pid-unused.test.ts（源码文本守卫，4 组断言全翻）：:63 child.kill( 恰 1 次（组杀若走 process.kill(-pid) 则此断言仍可能成立，按实现重审）；:66 safeKill SIGTERM 恰 2→按新调用数；:69 SIGKILL 调用 0→≥1；:73 'SIGKILL' 字面量 1→更多；:80-82 Promise.race 0→≥1（**若实现不用 Promise.race 而用其它有界机制，守卫正则要同步改写**）；:89-96 task.ts pid 引用恰 1 行→resumeTask 读 pid 后增多；:102-103 orphans/stuck pid 计数 0→>0；:114-118 services 下 isProcessAlive 0→>0。
- 受影响但应保持绿：runner.test.ts:281-308（timeout→failed）/:310-339（abort→canceled）——配合型 mock 收到 SIGTERM 即死，升级链不触发；stuck-task-detector.test.ts:241-247（'at least one running node_run → no S3'：该场景在 S5 下会出新告警，断言只 filter S3 仍绿，但语义已变，**应顺手改成显式断言 S5 触发**）；:274-284 resolution 场景 inactive 仅 11min 不触 S5，绿。
- 需补/需改：shared/tests/diagnose-repair.test.ts（taxonomy 对齐运行时测试，加 S5）；lifecycleRepair.ts:75-88 + diagnose-repair.ts:90-108 编译期红直到补 S5 条目；orphans.test.ts / rfc097-pending-orphan-reap.test.ts / scheduler-audit-gap5-orphan-reap-task-status.test.ts：现有行 pid 均 NULL，设计上 pid===null 走老路径即保绿（gap5 文件第 1 半边的 FLIP 属 WP-1/WP-2，勿在本包动）。
- 新 oracle（报告 WP-8 要求）：新 fixture「不合作 mock」——tests/fixtures/ 下现有 mock-opencode.ts 是配合型（MOCK_OPENCODE_DELAY_MS 自然退出、无 SIGTERM trap，grep 确认零信号处理）；新建 stubborn-opencode.ts：`process.on('SIGTERM',()=>{})` + setInterval 持身 + 可选 Bun.spawn 孙进程并打印孙 pid；用例断言：timeoutMs 路径在 (timeout+grace+margin) 墙钟内返回 failed，且 child pid 与孙 pid 均 `process.kill(p,0)` 抛 ESRCH（组杀覆盖孙进程）。

WP-9 必翻红：

- tests/scheduler-audit-s11-stash-gc-prune-rollback.test.ts：test1（:85-111）——pin 落地后 for-each-ref 必须含 sha（:97-101 翻转）、gc --prune=now 后 objectExists 翻 true（:107-110）；**注意 test1 直接调 gitStashSnapshot 裸函数**，若 pin 做成可选参数（推荐 `gitStashSnapshot(path,{pinRef})`），test1 需改为传 pinRef 调用、并对裸调用保留"无 pin 仍是 dangling"的对照断言。test2（:113-150）——rejects code 'worktree-apply-failed'→'snapshot-missing'（:138-140）、a.txt 保留 'POST-GC-GARBAGE\n'、junk.txt 幸存（:143-144 翻转）。
- tests/git-snapshot.test.ts:87-92（'rollback with unknown sha → DomainError'）——核实者点名的「先销毁后报错」锁定：改写为 rejects code 'snapshot-missing' 且工作区未动（a.txt 仍 'changed\n'）；同文件 :65-77/:79-85 正常回滚与 '' 路径不受影响。
- 不受影响（已核对）：scheduler-audit-s02-multirepo-retry-rollback-noop.test.ts、scheduler-boundary-presnapshot-rollback-skip.test.ts（'' 路径）、rfc092-midrun-\*（真实有效 sha）。
- 新 oracle：pin 后 gc 存活 + gc.ts 删 ref（任务终态+worktree GC 后 for-each-ref 为空）+ resume 升级（prune 快照→resume→任务 failed/errorSummary='snapshot-lost' 且工作区未被 reset/clean）。

━━━ 四、最小实现方案草案（接口/数据流级） ━━━

WP-8（runner 为中心，单 PR 可控）：

1. runner.ts spawn 加 `detached: true`；新增 `function killTree(child, signal)`（process.kill(-child.pid, signal)，ESRCH/EPERM fallback child.kill）；新增 `armKillEscalation(child, log, graceMs=10_000)` 返回 {cancel}——onAbort(:764)/timeout(:775) 调它：先 killTree(SIGTERM)，unref 计时器 graceMs 后 killTree(SIGKILL)；child.exited 后 cancel()。
2. 有界收尾：`await child.exited` 与 `Promise.all([pumps])` 共同套一个最终 deadline（grace+5s margin 的 Promise.race）；超 deadline → 强制 status='failed', errorMessage='child-unkillable'（带 pid），放弃 pump 余量（reader.cancel()）。
3. pid 治理：isProcessAlive 从 util/lock.ts 导出复用（或挪 util/process.ts）；reapOrphanRuns 对 pid 非空行：isProcessAlive && startedAt 时间窗 && ps command 含 opencode/bun → killTree TERM→KILL（best-effort，失败照旧翻 interrupted）；resumeTask/retryNode 回滚前同款检查（kill-then-proceed）。
4. S5：stuckTaskDetector checkOne running 分支加 else（active>0）→ rule 'S5'，detail 含 active run 的 {nodeRunId,nodeId,pid,lastEventTs}；类型涟漪四处（lifecycleInvariants.ts:63/:102、shared lifecycle-alerts.ts、shared diagnose-repair.ts、backend lifecycleRepair.ts REPAIR_OPTIONS 非空 tuple）。
   数据流不变：runner 仍只产 RunResult，调度/状态机零改动（aborted/timedOut 短路在 :953-958 之前已定）。

WP-9（util/git.ts 为中心 + 三个接线点）：

1. `gitStashSnapshot(worktreePath, opts?: {pinRef?: string})`：sha 非空且 pinRef 给定 → `runGit(path, ['update-ref', pinRef, sha])`；pin 失败 log.warn 不阻塞节点（快照仍短期可用，RFC 里明示该取舍）。scheduler.ts:1778/:1793 传 `refs/agent-workflow/snapshots/${taskId}/${nodeRunId}`。
2. rollbackToSnapshot 头部加 cat-file -e fail-closed（新 DomainError code 'snapshot-missing'），'' 路径不变。
3. rollbackNodeRunWorktrees 返回 failures[]；resumeTask/retryNode 对 snapshot-missing → CAS pending→failed + HTTP 抛错；scheduler 重试路径节点级 fail；三处 out-of-band 保持 warn（已无销毁风险），是否上抛留决策点。
4. gc.ts removeWorktree 成功后批删 refs/agent-workflow/snapshots/{taskId}/\*（单仓先做；多仓与审计缺口 3 的 gc 多仓改造同族另立）。
   依赖/顺序：WP-9 与 WP-8 互相独立；WP-8 的 resume 前 pid 检查与 WP-9 的 resume 升级都改 task.ts resume/retry 入口，建议 WP-9 先行或同 PR 族避免两次动同函数；两包均不依赖 WP-4 之外的未落地工作（RFC-097 CAS 已在 HEAD 提供 setTaskStatus/trySetTaskStatus，lifecycle.ts:223/:272）。

关键风险标注：① s15 守卫的 Promise.race 正则与实现机制强耦合，实现若用别的有界等待要同步改守卫文案；② detached:true 改变 dev 场景 Ctrl-C 行为（子进程不随终端死）——本就是 orphans.ts:9-11 声明语义，但 e2e/CI 里若有依赖"杀 daemon 连带杀 mock"的隐式假设需跑全量验证；③ ref 钉住后用户源仓 odb 会长期持有快照对象直到 worktree GC——若用户关闭 worktreeAutoGc（gc.ts:42 enabled 门），refs 永不清理，RFC 应记录该权衡（可选追加"软删任务 ref 清扫"后续项）。
