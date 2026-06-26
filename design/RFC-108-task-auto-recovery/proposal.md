# RFC-108 — 任务自动检查与恢复（Task Auto-Check & Recovery）

> 状态：Draft（待用户批准进入实现）
> 触发：2026-06-26 用户「充分调研所有功能，全面补充任务的自动检查恢复能力」。
> 调研来源：`design/arch-audit-2026-06-23/`（17 子系统深审）+ 本 RFC 专项 10 路并行恢复审计（结论见 design.md §1）。

## 1. 背景

平台是一个驱动多个 `opencode` CLI 进程作为协作 agent 的编排框架。任务（task）跑在 per-task 的 git worktree 里，经 daemon 单进程调度，状态机为
`pending / running / done / failed / canceled / interrupted / awaiting_review / awaiting_human`。

经全面回源调研得到一句话结论：**本平台「检测」做得很扎实、「修复」能力也很成熟，但二者之间的「线」是人**。

- **检测半（成熟）**：启动孤儿回收 `reapOrphanRuns`、卡死探测 `stuckTaskDetector` S1–S5（5min 周期 / 30min 静默门）、生命周期不变式 R1/R2/C1/T1/T2/T3/U1/CR-1（启动 + 每 1h，24h grace）、per-node 硬超时看门狗、1Hz 资源限额 ticker、snapshot-lost fail-closed 升级。全部 CAS 守卫、测试齐备。
- **修复半（成熟但纯人工）**：RFC-057 修复引擎（13 规则 × ~24 typed 选项，preflight + drift-guard + append-only `lifecycle_repair_audit` + 可选 resume）、`resumeTask`（幂等：CAS 所有权锁先于任何副作用、stale-child kill、per-node `pre_snapshot` 回滚）、单节点 retry 级联。

**缺口**：`applyRepairOption` 全仓**唯一调用方**是 HTTP 路由背后的「人工点击 + confirm:true」；探测 loop 只 WS 广播 `lifecycle.alert`；`start.ts` 启动跑完 `reapOrphanRuns` 后**从不调用 `resumeTask`**。全系统**仅有两处真正的自动恢复**：(1) 启动孤儿回收（只把行翻成 `interrupted`，然后等人）；(2) CR-1（自动废弃陈旧 cross-clarify 轮——确定性终态触发、幂等，本 RFC 要复制的范本）。其余 S1–S5、所有 R/T/U 不变式、每一次 resume/retry，**全是 alert-only 或人工点击**。

由此引出一批已确诊的真问题（证据 file:line 见 design.md）：

- **A. 配置默认值从未接线**：`defaultPerNodeTimeoutMs`（config 默认 30min）从未被 `resolveLaunchRuntimeConfig` 透传 → **default 配置下的节点跑在「无硬超时」**，hung-but-alive 的 opencode 子进程实质永生；`defaultPerTaskMaxDurationMs/MaxTotalTokens` 被任何消费方读取，default 配置任务**无时长/成本上限**。
- **B. 零自动续跑**：daemon 重启后 `reapOrphanRuns` 把一个 90% 完成的任务翻成 `interrupted`，然后它**永远等人点恢复**。
- **C. 检测→修复 loop 开环**：即便某规则只有唯一确定性低危非破坏性选项（如 `S4.kick-task`），也要人去打开诊断面板。对「单人无人值守 daemon」（设计定位）= 永久挂数小时～24h+。
- **D. S5 wedged-but-alive 子进程无 kill 路径**：S5 精确识别 hung 子进程（带 pid），但唯一修复选项是「acknowledge」（不改任何东西）；无 idle/heartbeat 看门狗。
- **E. 成员删除死锁**：`disableUser` 是软删除、不重指派任务；禁用某 awaiting_* 任务的唯一 owner 后，gate 行仍在（S1/S2 只在「证据行缺失」时告警，不管「能答的人没了」）→ **永久死锁且零可观测**。
- **F. 缺安全网**：恢复动作全是 `log.warn`、**无计数器/健康面/通知**；**无熔断**（自动续跑/修复一旦上线，确定性崩溃任务会无限自动重跑烧 LLM 成本）；driver 守卫是 per-call-site `isTaskActive` 约定（带 TOCTOU、多个 mutating 选项漏挂）。
- **G. 写时不变式缺位**：U1（每 slot ≤1 活跃行）是非唯一索引 + 24h 事后扫描，不是写时约束；task 级状态机有 CAS 无转移表（与 node_run 不对称）。
- **H. GC 反噬可恢复任务**：worktree GC 的候选集**含 `failed`/`interrupted`**——恰是 `resumeTask` 能恢复的状态；GC 开启时会删掉 worktree + 钉住的 snapshot ref → resume 变 snapshot-lost 永久丢失；resume 还**无 worktree 存在性前置检查**。

## 2. 目标 / 非目标

### 2.1 目标（v1，单一伞形 RFC-108 全覆盖）

把「检测」与「修复」之间那根线**先用四道安全护栏铺好，再把自动执行实现出来但默认关闭**，并顺手把一批已确诊的独立安全/正确性缺口修掉。具体：

1. **配置接线（P0）**：每个节点都有「always-armed 硬超时下限」、每个任务都有可选时长/成本预算。（决策 D2：30min 硬超时、可配置）
2. **四道安全护栏（默认关闭 / alert-only，是自动执行的前置条件）**：
   - **统一恢复可观测**：`recovery_events` 审计表覆盖**所有**系统恢复 actor + counters + 健康面 + WS `recovered`/`resolved` transition + 任务成员通知。
   - **熔断 + 隔离**：per-task 恢复尝试计数 + 指数退避 + `autoRecoverySuspended` soft flag（经新转移表）。
   - **driver-lease**：替代 `isTaskActive` 约定的 per-task 租约 + `touchesLiveState` 标注 + 引擎级 gate。
   - **`autoApplyEligible` 分类器**：在 `RepairOptionMeta` 上声明「唯一确定性可自动应用」vs「人工策略选择」+ property 测试锚。
3. **独立安全/正确性修复**：写时 U1 唯一约束（shadow-mode）、fail-safe survivor-kill（持久化 spawn 身份）、resume worktree 前置检查（干净 410）+ 跨 node_run 原子回滚、S2 cross-clarify 误杀修复、GC 排除可恢复 worktree + 多仓 GC、S6 成员删除**检测**（决策 D4：仅检测）、手动 `S5.kill-and-resume` 选项、`nextTaskStatus` 转移表 oracle + 共享状态集模块、廉价可观测补漏。
4. **自动执行（实现但全部默认关闭 / opt-in）**（决策 D1：全面但默认关闭）：
   - **boot auto-resume**（`autoResumeOnBoot` 默认 false）：对 `daemon-restart` cause 任务自动 `resumeTask`，behind 熔断 + snapshot-resolvable 前置。
   - **闭环 detect→classify→auto-repair loop**（`autoRepair` per-rule 默认 off）：`applyRepairOption(actor='system')` behind lease + grace + breaker，由 `autoApplyEligible` 驱动、逐规则白名单。
   - **心跳驱动 stalled-child auto-kill**（默认 off）。
   - **周期性 post-boot 孤儿 reconciler**（reap-to-interrupted 为安全默认；auto-resume 部分受上面开关门）。

### 2.2 非目标（本 RFC 不做 / 推后续 RFC）

- **不默认开启**任何自动执行（auto-resume / auto-repair / auto-kill 全部 opt-in、默认 false）。本 RFC 交付「能力 + 护栏」，开关由用户在确认安全后逐项打开。
- **不做成员删除的自动改归属 / 写时拦截**（决策 D4：仅检测；自动下放给 admin 跨授权边界，推 v2）。
- **不做 wedged-loop / fanout-shard-leak 检测（S7/S8）**——语义风险高（区分「合法长跑」与「真卡死」需读工作流定义 + per-iteration 进度），推 later。
- **不做 snapshot-lost 的 re-baseline / worktree-recreate 修复选项**——破坏性、严格人工，推 later。
- **不触碰单 daemon 假设**：lease / counters / tickers 用进程内实现即可，但必须标成**显式接缝**（不焊死），为未来团队服务器留 DB-backed seam。
- **不重写 scheduler god-module / 不做 runScope 统一**（arch-audit rank 9/17，独立大重构）。

## 3. 用户故事

1. **作为单人 daemon 用户**，当我机器重启 / daemon 崩溃后，我打开 `autoResumeOnBoot` 就能让进行中的任务**自动从断点续跑**，而不必逐个点「恢复」；万一某任务每次续跑都崩，熔断会在 N 次后把它**隔离**（soft 隔离，我一键清除），不会无限烧钱。
2. **作为用户**，我用默认配置启动任务，**不必**手动给每个节点设超时——平台保证 30min 硬超时下限，hung 的 opencode 子进程会被自动杀掉并把节点判 `node-timeout`。
3. **作为用户**，当某任务卡在「running 但所有节点已终态」这类**唯一确定性**故障时，我打开 `autoRepair` 对应规则，平台会**自动应用**那条安全修复（如 `S4.kick-task`）并在恢复事件页留痕；而「该判失败还是该重生」这类**需要我判断**的多选项故障仍然只告警、等我决定。
4. **作为用户**，我能在一个**系统健康页**看到：开放的生命周期告警、每次系统自动恢复（孤儿回收 / 续跑 / 自动修复 / 杀进程 / 隔离）的历史与计数器；任务列表行上直接有 **stuck 徽标**；任何系统对我任务做了恢复动作，我会收到通知。
5. **作为管理员**，当我禁用一个用户时，若这会让某 awaiting_* 任务**永久无人能答**，平台会**告警**（S6）让我察觉（而不是静默死锁）。
6. **作为开启了 worktree GC 的用户**，GC **不再**回收我还能 resume 的（failed/interrupted）任务的 worktree；若 worktree 确实已不在，resume 会给我一个干净的 410 而不是 500。

## 4. 验收标准

> 每条都须带测试（先红后绿）；运行门槛 `bun run typecheck && bun run test && bun run format:check` 全绿 + CI（含 binary smoke + e2e）；按 [feedback_post_commit_ci_check] push 后查 CI。

**配置接线（D2）**
- AC-1：default 配置（无 per-node `timeoutMs` override）启动的节点，`runNode` 收到的 `timeoutMs === defaultPerNodeTimeoutMs`（30min）；超时触发 SIGTERM→SIGKILL 并判 `node-timeout`。**含 repair/auto-repair 触发的 resume 路径**（`applyRepairOption`→`resumeTask` 经 repair deps 也带 floor，Codex 设计 gate P2）。（覆盖全部 `StartTaskDeps` 站点的 launch-path 测试）
- AC-2（机制接线 / 默认不限）：`startTask` 把 `input.maxDurationMs ?? cfg.defaultPerTaskMaxDurationMs`（>0 才落库）写入行——使配置字段从「死代码」变为真正消费（修 AR-02）。**v1 shipped 默认 = 0（unlimited）**：per-task 限额超限走 `cancelTask`、而 `canceled` **非 resumable**，1h 硬取消会不可恢复地误杀合法长跑多节点任务（hung 子进程已由 AC-1 的 per-node 30min floor 兜住、且 failed 节点可 retry）；故 v1 不默认设 per-task cap，仅把机制接通——operator 设 >0 即对所有任务生效。token 同理默认 0=unlimited（行为零变更）。**实现期 D5 微调**：shipped `defaultPerTaskMaxDurationMs` 由历史死值 1h 改 0；release note 提示「该字段现已真实生效，存量 config 若有非 0 值会开始限额，设 0 即不限」。

**安全护栏（默认关闭）**
- AC-3：`recovery_events` 表记录所有 actor（boot-reap / shutdown-flip / limit-cancel / snapshot-lost / CR-1 / 及未来 auto-*）的 before/after/reason；`/api/health`（或 `/api/recovery`）暴露 counters；ACL 按资源可见性过滤聚合视图。
- AC-4：熔断——某任务在窗口内自动恢复尝试超过 `maxAutoRecoveriesPerWindow`（默认 3/1h）后被置 `autoRecoverySuspended`，从两个自动 loop 排除；人工一键清除；隔离 flag 经 `nextTaskStatus` 写、非终态。
- AC-5：driver-lease——recovery actor 在任何 status-flip/resume 前须取得 per-task lease；活调度器持有期间，`applyRepairOption` 对 `touchesLiveState` 选项引擎级拒绝；lease TTL-bounded，boot reconcile 清陈旧 lease。
- AC-6：`autoApplyEligible` 仅标注唯一确定性 finalizer；property 测试断言分类器**永不**把破坏性/多选项/中高危选项判为 auto-eligible，且锁不变式 `autoApplyEligible ⟹ risk==='low' && !destructive`（Codex 设计 gate P2）；「规则恰有一个 eligible+available 选项」才入自动白名单；v1 自动集首发仅 `S4.kick-task`。

**独立安全/正确性修复**
- AC-7（AR-15）：GC 候选集**不含**「failed/interrupted 且无后继」的可恢复任务；`resumeTask` 顶部 `isGitWorkTree` 前置检查在 pending-CAS **之前**抛干净 410；多仓 GC 按子仓逐个 `removeWorktree`+`deleteSnapshotRefs`+容器 rmdir（停止泄漏）。翻转 `scheduler-audit-gap3-gc-terminal-statuses` 既有断言。
- AC-8（AR-17）：resume 多 node_run 回滚——任一行 snapshot 缺失则在**触碰任何 worktree 之前** escalateSnapshotLost；红测：两个 failed 顶层行、row2 被 gc-prune，断言 row1 worktree 未被 reset。
- AC-9（AR-16）：纯 cross-clarify 的 awaiting_human 任务 >30min **不**产生 S2 finding（`hasOpenClarifySession`/`S2.reopen` 改读 `clarify_rounds`）。
- AC-10（AR-14）：survivor-kill 要求 alive + binary-path + persisted token **三者皆真**才杀；alive-but-gate-rejected → 高危告警 + **拒绝**静默 flip / 拒绝 auto-resume；注入 `isProcessAlive`/`pidCommandLooksLikeAgentChild` seam 测三场景。
- AC-11（AR-13）：partial unique index `UNIQUE(taskId,nodeId,reviewIteration,COALESCE(shardKey,'')) WHERE status IN ('awaiting_review','awaiting_human')`；shadow-mode 先记冲突一版再 enforce；resume 在同事务把旧活跃行移出活跃集（合法 re-mint 不被拒）。
- AC-12（AR-06，D4）：S6——awaiting_* 任务若关联的可答成员（owner+collaborator）全被禁用则产 lifecycle_alert（独立 rule）；24h grace；纯检测、不改归属。
- AC-13（AR-05 manual）：新增 `S5.kill-and-resume` 修复选项（复用 `killStaleRunProcessTree`），人工立即可用。
- AC-14（AR-12/AR-19）：`nextTaskStatus(from,event)` 转移表 + `never` 穷举 + eslint `no-direct-task-status-write`；共享状态集模块（terminal/retryable/tone）+ 前端 4 站接线 + 源码穷举测试。

**自动执行（实现但默认 OFF — D1）**
- AC-15（AR-03）：`autoResumeOnBoot=true` 时，boot 对**本次** reaper 翻成 interrupted 且 `errorSummary='daemon-restart'`（非 failed/shutdown/limit/snapshot-lost）的任务 `resumeTask`，behind 熔断 + snapshot-resolvable；幂等 property 测试（重复跑不双写）。默认 false 时零行为变更。
- AC-16（AR-04）：`autoRepair` 某规则开启时，`AutoRepairLoop` 对「唯一 eligible+available」选项 `applyRepairOption(actorUserId='system')` behind lease+grace（alert 存活 ≥2 个探测 tick ~10min）+breaker；多选项/破坏性永不自动。默认全 off 时零行为变更。
- AC-17（AR-05 auto / AR-10）：心跳看门狗（默认 off）在 event 静默 > `heartbeatStallMs`（≥30min、event-reset、可配）时跑 RFC-098 kill-then-settle；周期 reconciler（每 5–10min）对 `isTaskActive===false` 的 running/pending in-daemon 孤儿 reap-to-interrupted（安全默认 on）。

**前端**
- AC-18：系统健康/恢复事件页 + 任务列表 stuck 徽标 + Settings auto-knobs 开关（全部复用公共组件，i18n 中英对称）；视觉对齐自查。

## 5. 决策登记

- **D1（恢复姿态）= 全面但默认关闭**：v1 落齐检测 + 四护栏 + 全部安全修复，并**实现** auto-resume / auto-repair / auto-kill，但全部默认 OFF（opt-in 开关）。理由：daemon 若是被任务自身的工作（死循环 / OOM）搞崩，auto-resume 会 crash-loop；必须先有熔断（AR-09）+ 可观测（AR-11）兜底与监视，才能安全开启。用户随时可开。
- **D2（默认单节点硬超时）= 接线 30min 硬超时（可配置）**：把现有 `defaultPerNodeTimeoutMs=30min` 接进启动 deps 作硬超时上限，operator 可全局改、单节点可调高。理由：最高 ROI 最低风险；review/clarify await 停在 `awaiting_human`（非 `runNode` 下的 running）不受影响；真要跑 >30min 的节点须显式声明。
- **D3（交付范围）= 单一伞形 RFC-108 全覆盖**：一个 RFC 覆盖全部 v1 能力，按能力组拆**有序多 PR**、单一审批 gate。理由：四护栏是后续自动 loop 的相互依赖前置，作为一个 umbrella 一起批最连贯。
- **D4（成员删除死锁）= 仅检测（新增 S6 告警）**：v1 只做检测半；自动改归属跨授权边界（谁现在可答 / 取消一个私有任务），只能下放给严格更高权限主体（admin）、仅在无歧义时、带审计——推 v2。写时拦截可能挡住正常离职流程，亦推 v2。
- **D5（工程默认，实现期可微调，operator 可配）**：熔断阈值 3/1h + 指数退避；lease 进程内 + TTL-bounded + 显式 DB-backed seam；U1 唯一索引先 shadow 一版再 enforce；auto-repair 白名单首发仅 `S4.kick-task`，再逐规则扩到 demote-task 族、再到 resurrect-* / `C1.resume-run` / `R1.approve-run` / `CR-1.retry-designer-rerun`，每条各自有 green 幂等 oracle 才扩。**永不自动**：destructive / 多选项（`*.mark-failed` / `*.cancel-task` / `U1.*`）。
- **D6（单 daemon 接缝）**：所有进程内恢复原语（lease / counters / ticker / `isTaskActive`）标为显式接缝，不焊死新假设，为团队服务器留 DB seam。
