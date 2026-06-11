# RFC-098 — 技术设计（规范性裁决）

行号基线：`0d3d41e`。**实证细节全部在同目录 `survey.md`**（五分域普查：现行代码坐标、FLIP/
保绿清单、可行性实验）；本文只做规范性决策与接口契约，实现时以 survey 对应分域为操作手册、
按内容复核行号。

## B1 — WP-5（survey §wp5-locks）

1. **写锁注册表**：新模块 `services/taskWriteLocks.ts`（仅依赖 util/semaphore，零环）：
   `getTaskWriteSem(taskId): Semaphore(1)` + `gcTaskWriteSem(taskId)`（仅 idle 时删）。
   scheduler 构造点改取注册表（SchedulerState.writeSem 字段不变，下游零改动）；删除点 =
   runTask finally；HTTP 路径用后 gc-if-idle。
2. **⑥-10 接线**：nodeRollback.ts 增 `loadRollbackTarget(db, taskId)`（tasks + taskRepos，
   单仓合成 fallback 抄既有形态）；clarify/review/crossClarify 三处回滚改
   `getTaskWriteSem(taskId).run(() => rollbackNodeRunWorktrees(target, run, {resetOnEmptySnapshot:false}, log))`。
   **rollbackNodeRunWorktrees 返回值升级**（与 B2/WP-9 统一一次改）：
   `{ attempted: boolean; failures: Array<{worktreeDirName?: string; code: string; message: string}> }`
   ——review.ts 的 `-rollback` 后缀语义由 attempted∧failures空 驱动（保住
   reviews-iterate-mints-new-run 正则锁）；crossClarify 的 triggerDesignerRerun 扩参必须可选
   （10+ 测试构造点），内部 db 自取 target。
3. **S-17 锁序反转**：三个取锁点（单节点/shard/aggregator）改 writeSem ≺ globalSem ≺
   subprocessSem，释放反序。死锁分析见 survey（全局锁序收敛、无层级持有、FIFO 防饿）。
4. **commit&push 移出派发循环**：node-ok 分支不再同步 await，改铸 synthetic in-flight
   promise 加入 race 集合，scope ok 出口前 drain。归因模糊为既有行为，文档记录。
5. **S-24**：runGitWrapperNode 的 baseline 捕获与 finalize diff 段各包 writeSem；finalize
   catch 不再降级——`markWrapperTerminal('failed', 'git-diff-failed:<msg>')` + return failed；
   保住 wrapper-git-list-path 的源码文本锁（`portName:'git_diff', content: paths.join('\n')`）。
6. C-9（commit 锁外）：随 4 的移出一并文档记录（write-tree 方案不做，超界）。

## B2 — WP-9 + WP-8（survey §wp8-wp9）

**WP-9**：

1. `gitStashSnapshot(path, opts?: {pinRef?})`：sha 非空且有 pinRef → `update-ref` 钉
   `refs/agent-workflow/snapshots/{taskId}/{nodeRunId}`；pin 失败 warn 不阻塞。scheduler 两个
   快照写点传 ref。
2. `rollbackToSnapshot` fail-closed：sha 非空时先 `cat-file -e <sha>^{commit}`，失败抛
   `'snapshot-missing'`（**不动工作区**）；`''` 路径（reset+clean）语义不变。
3. resume/retry 对 snapshot-missing 升级：rollbackNodeRunWorktrees 的 failures 含
   snapshot-missing → resumeTask/retryNode `setTaskStatus(pending→failed,
errorSummary='snapshot-lost')` + HTTP 抛错；scheduler 重试路径 → 节点 failed；三处
   out-of-band 保持 warn（fail-closed 后已无销毁风险）。
4. ref 清理：gc.ts removeWorktree 成功后批删 `refs/agent-workflow/snapshots/{taskId}`（单仓；
   多仓与缺口 3 同族另立）。用户关 worktreeAutoGc 时 refs 长期保留——记录权衡。

**WP-8**：

1. runner spawn 加 `detached: true`；`killTree(child, sig)` = `process.kill(-pid, sig)`
   fallback `child.kill`（Bun 1.3.13 darwin 实测组杀含孙进程）；`armKillEscalation`：
   SIGTERM → 10s unref 计时器 → SIGKILL；abort/timeout 两路接入。
2. 有界收尾：`child.exited` + pumps 套最终 deadline（grace+5s margin race）；超限强制
   `failed: 'child-unkillable'` + reader.cancel。
3. pid 治理：`isProcessAlive` 自 util/lock.ts 复用导出；reapOrphanRuns 对 pid 存活行（+
   startedAt 时间窗 + ps command 双门）先 killTree 再翻 interrupted；resumeTask/retryNode
   回滚前同款 kill-then-proceed。
4. stuck S5：checkOne running 分支 else 半边（active>0 ∧ 30min 无事件 → 告警带
   {nodeRunId,nodeId,pid,lastEventTs}）；类型涟漪四处（lifecycleInvariants / shared
   lifecycle-alerts / shared diagnose-repair / lifecycleRepair REPAIR_OPTIONS 需非空 tuple——
   给 S5 配 acknowledge 型 option）。
5. 新 fixture `stubborn-opencode.ts`（trap SIGTERM + 孙进程），oracle：墙钟有界 + 孙进程同灭。

## B3 — WP-6b/6c/6d（survey §wp6b-fanout / §wp6c-loopgit / §wp6d-wp10 前半）

**裁决的方案选型**：

- S-4 → **案 A**：wrapperProgress 加 optional `preDirty: Record<path, sha>`（'deleted' 哨兵；
  fresh-mint 抓、resume 从 progress 读、malformed 回退空集=今日行为）；finalize 差集规则
  「post ∈ pre ∧ hash 相等才扣」。一个机制同修顺序双 wrapper 与 git-in-loop。否决案 B
  （stash create 不含 untracked + 扩 S-11 病面）。design/design.md §6.5 同步。
- S-3 + RFC-092 限制 → **案二**：`wrapperHasFreshInnerWork` 重构为
  `wrapperRevivalEvidence(wrapperRow, rows, definition) → {rowId, nodeId} | null`（证据 =
  窗口内 max-id inner **pending** 行 ∪ **kind==='review' 限定**的 done∧fresh 行；窗口规则
  不变；布尔壳保留）。deriveFrontier 增 wrapperAnchorReleasable（evidence.rowId ∉
  dispatchedPendingRowIds ∧ evidence.nodeId ∉ openAskingNodeIds），并入既有或式，
  pendingAnchors 记证据行 id——五层忙循环论证见 survey。review.ts 零新写点，与 RFC-095
  复活机器同构。
- S-7：新纯函数 `wrapperExternalUpstreamSources(wrapperId, definition)`（inner 后代 ∪ 自身
  的外部源；通道边过滤 + review inputSource 同款）放 dispatchFrontier.ts；
  `pickUpstreamSourceRun`（iteration 窗口两阶段 picker）从 resolveUpstreamInputs 抽入
  freshness.ts（「抽一次别 fork」第二缝的延伸）；loop/git 每次进入（mint/resume）在 inner
  runScope 前覆盖写 consumed（对齐 fanout）。后果链（stale → 重派 → 新 wrapper 行从 0 重跑 /
  git 重抓 baseline）零 frontier 改动。
- S-19/S-20/S-21（fanout 恢复幂等）：
  - migration **0043**：`node_runs.shard_value_hash TEXT`（可空）；shard 铸行写
    sha256(shard.value)，shared 行不写；**hash 空值政策 null=match**（两个既有测试钉死）。
  - 复用锚点放宽为 `(taskId, innerNodeId, iteration, shardKey, parentNodeRunId IS NOT NULL)`
    （跨代 done 子行可复用；同代非终态原地重跑分支保留——duplicate-shards 测试钉死）；
    纯函数 `pickReusableShardRun(rows, {shardKey, valueHash})`（done-only + isFresherNodeRun +
    hash null=match）落 freshness.ts，shard 与 aggregator 共用。
  - consumed 代际门：wrapper 进入时先比旧/新 consumed（跨代比前代 wrapper 行），不一致 →
    `reuseDisabled=true` 全量重跑，再覆盖写（补 S-20 的覆盖掩盖 + path 族 hash 盲区）。
  - aggregator：复用分支（freshest done 镜像 + 比全部参与 shard 行新才回放；同代非终态原地
    重跑）；innerRows 改 done-filter + freshest-per-shardKey；锚与 shard 同步放宽。
  - findResumableWrapperRun 不动（failed 保持 terminal；复用走子行锚）——loop/git resume
    测试零波及。
- S-28：三处 wrapper fresh-mint 后补 `transitionNodeRunStatus(mark-running)`、广播后移；
  markWrapperTerminal allowedFrom 去 'pending' + 注释修正；runner eager 广播下移到
  mark-running 之后；lifecycle.ts 固化「先写 DB 后广播」注释。
- ⑥-11 → **方案 A**：retryNode 对 target 为 wrapper kind ∧ runRow.status ∈
  {canceled, interrupted} 时不铸 failed 占位行（行本身即复活信号）；kindOf map 提前到无条件
  构建；下游 cascade 占位保留。retry-cascade-kind-matrix 钉点按其头注预告翻转；先给
  rfc095-wrapper-canceled-revival 补 wrapper-自身-行目标 RED 用例。

## B4 — WP-10（survey §wp6d-wp10 后半）

1. **T-a mintNodeRun 工厂（纯重构）**：新模块 `services/nodeRunMint.ts`（避免回灌
   scheduler↔review 环）；签名见 survey（status 白名单含 'running' 以收编 commitPushRunner
   的直铸；inheritFrom 单一继承清单 = reviewIteration/shardKey/parentNodeRunId/preSnapshot；
   overrides 显式）。13 处裸 insert 机械迁移（cause 参数即收集）；grep guard（仿
   lifecycle-grep-guard：`insert(nodeRuns)` 仅 nodeRunMint.ts 允许 + 行内豁免标记）。
2. **T-b migration 0044**：`node_runs.rerun_cause TEXT`（可空）；RerunCause 枚举 ~20 值
   （survey 草案为准，shared schemas 定义）；工厂落库 + migration 测试。
3. **T-c 门控 switch(cause)**：scheduler 注入门控区四个代理信号点按 survey 映射改写
   （isClarifyRerun → cause==='clarify-answer' 等；clarifyGeneration 保留为生成索引非成因；
   拓扑门留 belt-and-braces）；`(consumerKind × cause)` 真值表测试。
4. **T-d 拆 hack**：crossClarify designer 重跑的 `retryIndex 刻意 ≥1` 代理 hack 移除
   （cross-clarify-designer-retry-index 测试按新语义翻转）。
5. 门控既有回归网 ≈14 文件 65 用例为界（survey 列明），除 designer-retry-index 外应全绿。

## 失败模式（全 RFC 级）

| 风险                                         | 缓解                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 批间相互踩（B1 改锁序、B3 改 wrapper 派发）  | 串行分批，每批全量门禁 + CI 绿才进下一批；批内 FLIP/保绿清单照 survey 执行                                           |
| 锁序反转死锁                                 | survey §wp5 锁序收敛证明（writeSem ≺ globalSem ≺ subprocessSem 无环）；并发回归网（fanout-concurrency 墙钟下限）保绿 |
| wrapperRevivalEvidence 扩展破坏 clarify park | review-kind 限定（dispatch-frontier N2 用例保绿）+ 负例（非 review inner done 不解锁）+ 五层忙循环论证用例化         |
| 跨代 shard 复用读到陈旧聚合/错配             | done-only + 比全部参与行新 + hash + consumed 代际门四重；duplicate-shards 同代口径保绿                               |
| detached 改变 CI 信号语义                    | 全量 e2e 验证；orphans.ts 既有声明语义未变                                                                           |
| s15/s11 源码守卫与实现机制强耦合             | 实现后按真实机制改写守卫文案（survey 已预警 Promise.race 正则点）                                                    |
| migration ×2                                 | 单句 ALTER 可空列（0040 先例）；migration-00NN 测试惯例                                                              |
| WP-10 触碰 fix 最密门控区                    | 工厂先行纯重构（全量回归网为界）→ 列后行 → 门控逐点改造每点配真值表；hack 拆除单独成步                               |

## 测试策略

每批的翻转/保绿/新增清单**以 survey.md 对应分域 §测试面为操作手册**（已逐文件列明 FLIP 行号
与保绿约束），此处不重复。全程纪律：先翻/补 oracle 再动刀；每批跑 lint + typecheck + 全量 +
format + build:binary；推送后 CI 绿再进下一批。
