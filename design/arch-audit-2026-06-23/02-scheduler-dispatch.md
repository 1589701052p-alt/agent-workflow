# 调度器与派发前沿（scheduler 巨石） — 架构审计 (2026-06-23)

> 本报告聚焦**架构层 + 扩展性**，与既有 `design/scheduler-audit-2026-06-10.md`（2 P0 + 9 P1 + 15 P2）+ `design/dedup-audit-2026-06-13.md` 不重复。既有审计已穷举「恢复 / 重试 / 反问 / 嵌套 wrapper / 并发」五轴上的静默错误与假失败 bug（S-1~S-28），且 RFC-092 / RFC-095 / RFC-097 / RFC-098 已大量闭合（S-1/S-8/S-12/S-15/S-17/S-22/S-24/S-28 已落地修复，逐条交叉印证见 §3）。本报告把镜头拉到「这个巨石本身的形状」：职责边界、加新功能要碰多少处、目标形态。
>
> 行号基线：当前工作树（`scheduler.ts` 4962 行；`dispatchFrontier.ts` 441 行；`runner.ts` 1835 行；`util/semaphore.ts` 71 行）。

## 0. 健康度一句话

派发**大脑**（`isDispatchable` / `wrapperRevivalEvidence` / `decideScopeOutcome` / `deriveFrontier`）经三轮对抗评审已抽成可断言纯函数、质量很高；但**派发躯干**仍是一个 4962 行的 god-module，`runOneNode`（~1144 行）把「按 kind 路由 + 取数 + 注入 + 重试 + 快照回滚 + 铸行 + 信号量 + commit&push」全揉成一坨，三套 wrapper 各写一份、加任何新节点种类 / 新 sharding 策略 / 跨任务并发控制都要在巨石里动刀——**逻辑正确性高，结构可扩展性差**。

## 1. 当前架构与职责

`runTask`（任务入口，CAS 抢占 running）→ `runTaskInner`（加载快照、建 `SchedulerState`、建三把信号量、拓扑校验）→ `runScope`（RFC-076 PR-B completion-driven 主循环：每 tick 全量重读 `node_runs` → `deriveFrontier` 纯派生前沿 → `Promise.race` 等任一在飞完成 → 再派生）→ `runOneNode`（按 `node.kind` if-chain 路由：output/input/wrapper-git/wrapper-loop/wrapper-fanout/review/clarify/clarify-cross-agent/agent；agent 路径自带重试内循环 + RFC-042 envelope-followup + 快照回滚）。wrapper-loop / wrapper-git 递归回 `runScope`；wrapper-fanout 走独立的 `dispatchFanoutShard` / `dispatchFanoutAggregator`（不复用 runScope）。`runner.runNode` 干净地只负责「单次 spawn opencode 子进程 + 解析 XML envelope + 返回 RunResult」（边界清晰，是全模块最健康的一层）。

关键文件清单：
- `services/scheduler.ts:646` `runScope`（主循环）、`:1175` `deriveFrontier`（前沿派生，**实为纯函数却留在巨石里**）、`:1448` `runOneNode`（~1144 行 god-function）、`:2745` `runLoopWrapperNode`、`:2948` `runFanoutWrapperNode`、`:3457` `dispatchFanoutShard`、`:3725` `dispatchFanoutAggregator`、`:4038` `runGitWrapperNode`
- `services/dispatchFrontier.ts`（纯谓词：`isDispatchable` `:296`、`wrapperRevivalEvidence` `:218`、`decideScopeOutcome` `:396`、`wrapperExternalUpstreamSources` `:127`）
- `services/freshness.ts`（freshest-run / consumed 纯原语，RFC-096 收敛）
- `services/runner.ts:376` `runNode`（单次 spawn）、`:1657` `armKillEscalation`（SIGTERM→SIGKILL）
- `services/task.ts:80` `activeTasks`（唯一的 daemon 级协调载体）、`:986` `resumeTask`、`:1142` `retryNode`
- `util/semaphore.ts`、`services/taskWriteLocks.ts`（per-task writeSem 注册表）
- `shared/src/node-kind-behavior.ts`（`NODE_KIND_BEHAVIORS` 矩阵，**意图上的 per-kind 单一事实源，实际只有 1/5 维被消费**）

## 2. 设计问题（Design）

**[SCHED-01] 全局信号量退化成「per-task 信号量」，跨任务无并发上限** — 级别 **P1**｜design / coupling ｜证据 `scheduler.ts:397`（`globalSem: new Semaphore(opts.maxConcurrentNodes ?? 4)` 在 `runTaskInner` 内**每任务新建一把**）vs `design/design.md:755`（「**全局 semaphore**：容量 `max_concurrent_nodes`（默认 4）」明确是单一全局上限），对照 `:756` 写锁被显式标注 per-task ｜影响：设计意图是「整个 daemon 最多 4 个节点并发」，实现给每个任务各 4 个名额——N 个并发任务 = N×4 个 opencode 进程同时跑（真实 LLM 成本 + 内存 + 句柄）。`design/design.md:758` 的 1Hz 资源限额检查是 per-task 时长/token 上限，**不**管全局进程数，所以这条没有兜底。根因是架构缺一个 daemon 级调度协调者：唯一的跨任务载体是 `task.ts:80` 的 `activeTasks: Map<taskId, AbortController>`，没有放共享信号量的地方，于是退化成局部变量。｜建议：把 `globalSem` 提为 daemon 级单例（与 `activeTasks` 同层的 scheduler-coordinator 模块），`SchedulerState.globalSem` 改取该单例；`maxConcurrentNodes` 设置变更时调整其容量（见 SCHED-02）。这天然也是 SCHED-01 之外「无全局任务并发上限」问题的修复点。

**[SCHED-02] `maxConcurrentNodes` 热更新设计承诺未实现，且 Semaphore 容量不可变** — 级别 **P2**｜design / impl-bug ｜证据 `design/design.md:1363`（「`maxConcurrentNodes` 改动 → 立即调整 semaphore 容量；正在等待的节点根据新容量重新唤醒」）vs `util/semaphore.ts:14`（`capacity` 是 `readonly`，无 `resize`）+ `scheduler.ts:397`（容量在 task 启动那刻一次性 snapshot `opts.maxConcurrentNodes`，运行中任务永不感知 settings 变更）｜影响：用户在 Settings 调大/调小并发，对所有在跑任务无效，必须重启 daemon 才生效——与设计文档承诺直接冲突。｜建议：给 `Semaphore` 加 `resize(n)`（扩容时唤醒等待者、缩容时只阻止新 acquire）；结合 SCHED-01 的单例化，settings 变更回调直接 `globalSem.resize()`。

**[SCHED-03] 「派发大脑」纯函数被人为劈成两个文件，单一职责被文件边界割裂** — 级别 **P2**｜design / coupling ｜证据 `deriveFrontier`（前沿**编排**：读 rows → latestPerNode → freshestDone → completed → ready → 分桶）在 `scheduler.ts:1175`，而它消费的纯谓词 `isDispatchable` / `wrapperRevivalEvidence` / `decideScopeOutcome` 在 `dispatchFrontier.ts`；`deriveFrontier` 自身只依赖纯模块（dispatchFrontier / freshness / wrapperProgress + types，无 DB / 无 scheduler 内部状态——见 `scheduler.ts:743` 的纯参数调用），**完全可以、也应该**搬进 `dispatchFrontier.ts`。RFC-076 §3 原文就说「放 freshness.ts ……或新建 dispatchFrontier.ts」，最终大脑落两处。｜影响：一个完整的纯派发决策单元被切成「半个在巨石、半个在纯模块」，读者要跨文件拼，且 `deriveFrontier` 留在巨石里使它无法独立单测以外被复用、也使巨石永远砍不到「真正纯函数已外移」的程度。｜建议：把 `deriveFrontier` + `Frontier` interface + `SETTLES_WITHOUT_ROW_KINDS` + `isLiveStatus` 整体迁进 `dispatchFrontier.ts`，使该文件成为「派发前沿的完整事实源」，scheduler 只 import 它。零行为变更（已是纯函数）。

**[SCHED-04] `runOneNode` 是 god-function：按 kind 路由与节点执行细节强耦合** — 级别 **P2**｜design / extensibility ｜证据 `scheduler.ts:1448-2592`（约 1144 行单函数）内联了：abort 短路、output-sink 物化、input 物化、4 个 wrapper kind 的 `if (node.kind === ...) return runXxx(...)` 跳转（`:1486-1494`）、review 路由（`:1496`）、clarify no-op（`:1512`）、cross-clarify 守卫（`:1524`，含 stop 短路 + 缺 questioner 防御）、agent 主路径（取数 `:1660` / 注入 `:1675` / 铸行 `:1717` / 信号量 `:1791` / 重试内循环 `:1811` / envelope-followup `:1819` / 快照回滚 `:1869` / commit 钩子由调用方触发）｜影响：路由表（哪个 kind 走哪条执行路径）和每条路径的实现挤在一个函数里，新增节点种类必须切进这个 1144 行的 if-chain，且无任何「漏接一个 kind 会编译失败」的护栏（与 `dispatchFrontier.ts` 的 exhaustive switch 形成反差——派发判定有 never 守卫，派发**路由**没有）。｜建议：抽 `dispatchByKind(kind) → NodeExecutor` 注册表（每 kind 一个 executor 模块，`satisfies Record<NodeKind, NodeExecutor>` 编译期穷举），agent executor 内部再拆「取数 / 注入 / 重试 / 回滚」四个协作单元。详见 §4 CHK-1 / §7。

**[SCHED-05] `NODE_KIND_BEHAVIORS` 矩阵是 80% 摆设：单一事实源被声明但未被消费** — 级别 **P2**｜design / extensibility ｜证据 `shared/src/node-kind-behavior.ts:15`（自述「**Today**: only `retryCascade` is consulted at runtime」）；5 个维度里只有 `retryCascade` 被 `task.ts:1319` 真正读，`limits` / `orphanReap` / `gc` / `shutdown` 都是「文档值，可以和现行 kind-blind 代码不一致而不报错」（`:18-21`）。实证：`orphans.ts:43-47` 仍按 `status IN ('running','pending')` 盲查、**完全不查矩阵的 `orphanReap`**；其它三维同理。｜影响：这是一个「看起来已经解决了 per-kind 一致性」的陷阱——下一个加节点种类的人会以为填好矩阵就万事大吉，实际四个维度的运行时行为根本不读它，新 kind 在那四处仍走 kind-blind 默认。这正是 dedup-audit「公共原语已存在但被绕过」结论在调度域的活体标本：原语在，消费方没接。｜建议：要么把四个维度真正接到 `orphans.ts` / `limits.ts` / `gc.ts` / `shutdown.ts`（让矩阵名副其实），要么把未消费维度从矩阵删掉、降级为注释（避免假事实源）。前者更优——它顺带把「加新 kind 要碰 orphans/limits/gc/shutdown 四个文件」收敛成「只填矩阵一行」。

## 3. 实现问题 / Bug（Impl）

> 本子系统的运行时 bug 在 scheduler-audit + RFC-098 后已大量闭合，本节只记**仍存活**或**审计未覆盖**的实现缺陷。

**[SCHED-06] `Semaphore.release()` 无双重释放守卫，多余 release 会把容量「凭空放大」** — 级别 **P2**｜impl-bug ｜证据 `util/semaphore.ts:51-57`（`release()` 无条件 `this.remaining += 1`；`acquire()` 返回的 release 闭包 `:38` 无 once 保护）｜影响：任何调用点 try/finally 写错、或一个 release 被调两次（巨石里手工 acquire/release 配对达 5 处：`scheduler.ts:1791-1792`、`:3635-3637`、`:3893-3895`，每处 2-3 把锁、catch/finally 分支多），就会让 `remaining` 超过 `capacity`，并发上限被静默突破且永不报错——典型「漏接也能全绿」。当前各调用点恰好配对正确，但这是结构性脆弱点，不是安全保证。｜建议：release 闭包加 `let released = false` once 守卫；或 `release()` 内 `if (this.remaining >= this.capacity) throw`（fail-loud）。配单测：double-release 不增 available。对抗自检：已确认 `run()` helper（`:63`）是安全的，但手工 acquire 的 5 处不走 helper。

**[SCHED-07] 每 tick 全量重读整张 `node_runs`（不按 scope/iteration 收窄），嵌套 wrapper 下 N 层各读一遍** — 级别 **P2**｜perf ｜证据 `scheduler.ts:741`（`db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))` —— 只按 taskId 过滤，scope/iteration 全在内存 filter，见 `deriveFrontier:1190-1192`）+ `:742` `loadOpenClarify` 再发 2 条 select（`:894`/`:905`）= **每 tick 3 条查询**；tick 由每次节点完成触发（`Promise.race`），且 loop/git wrapper 递归进 `runScope` 后**内层 scope 仍读全表**（同一 where，无收窄）｜影响：RFC-076 §8 R3 已承认并 deferred，但随着「单任务图节点数 / 行数（每轮 review/clarify/retry 都 mint 新行）」增长，复杂度 ≈ O(层数 × tick数 × 全表行数)。今天图 ≤ 数十节点尚可，但这是「图一变大就线性恶化」的扩展性地雷，且 loadOpenClarify 的两条 clarify-session 查询纯属可避免的重复 round-trip。｜建议：tick 内一次性读全表后，递归把 `rows` 作为参数下传给内层 `runScope`（同一 tick 内 rows 不变，无需重读）；或给查询加 `iteration` / scope 列索引收窄。优先做「rows 下传」——既省查询又消除「内外层看到不同快照」的潜在不一致。

**[SCHED-08] cross-clarify 路由内联在 `runOneNode`、与 review/clarify 路由风格不一致（一处 ~90 行业务逻辑混进 god-function）** — 级别 **P3**｜impl-bug / coupling ｜证据 `scheduler.ts:1524-1614`：review 是一行 `return dispatchReviewNode(...)`（`:1501`），clarify 是一行 no-op（`:1521`），但 cross-clarify 把「live-row 幂等查询 `:1547` + 缺 questioner 运行时防御 `:1563` + persistent-stop 短路 `:1588`」整块 ~90 行直接写在巨石里，没有像 review 那样下放给 `crossClarify.ts`｜影响：同类「特殊节点路由」三种写法，加深 runOneNode 体量与 kind-routing 的不一致；cross-clarify 的运行时守卫散落在调度器而非其服务模块。｜建议：抽 `dispatchCrossClarifyGuard(...)` 进 `crossClarify.ts`，runOneNode 内对齐 review 的一行委托。

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节重点

**[CHK-1] 加一种新节点种类（场景：未来要加 `wrapper-parallel` / `human-task` / `subworkflow` 节点）** — 根因：派发**路由**没有注册表，是手工 if-chain；per-kind 行为分散在 7+ 个文件且无编译期穷举护栏。现在要碰的点：① `runOneNode` 的 if-chain（`scheduler.ts:1486-1640`）加分支；② `runTaskInner:319` 的 kind 白名单校验；③ `dispatchFrontier.ts` 的 `isDispatchable` exhaustive switch（这一处**会**编译失败，是好的）；④ `deriveFrontier` 的 `SETTLES_WITHOUT_ROW_KINDS` / 分桶逻辑；⑤ `NODE_KIND_BEHAVIORS` 矩阵（编译失败，好）；⑥ `orphans.ts` / `limits.ts` / `gc.ts` / `shutdown.ts` 四处 kind-blind 默认（**不会**报错，静默走错——SCHED-05）；⑦ `WRAPPER_KINDS` 集合（若是 wrapper）。即：~10 处，其中只有 2 处有编译护栏，其余靠人肉记忆。目标形态：单一 `NODE_EXECUTORS satisfies Record<NodeKind, NodeExecutor>` 注册表，executor 声明 `{ dispatch, isResumeAnchor, settlesWithoutRow, orphanReap, ... }`；runOneNode 退化成 `NODE_EXECUTORS[kind].dispatch(ctx)`；deriveFrontier / orphans / limits / gc 全查同一矩阵。加新 kind = 新增一个 executor 文件 + 编译器逼你填全维度。

**[CHK-2] 在 wrapper-fanout 里放非 agent 节点（场景：每个 shard 要先 git-snapshot 再跑 agent，或 fanout 套 review / 嵌套 fanout）** — 根因：fanout **不复用 `runScope`**，自己写了 `dispatchFanoutShard`（`scheduler.ts:3457`，~244 行）+ `dispatchFanoutAggregator`（`:3725`，~246 行），把 agent 执行路径（取数 / 注入 / 信号量 / 铸行 / runNode）又抄了一份；硬编码 `if (inner.kind !== 'agent-single') → failed`（`:3198`，错误信息直言「v1 supports agent-single only ... PR-D2 will extend」）。现在要扩展就得：在 shard 执行路径里重新实现 wrapper-git / review / 嵌套调度——等于把 runScope 的能力在 fanout 分支里二次发明。目标形态：fanout 也走「每 shard 一次 `runScope(innerScope, shardCtx)`」，让三套 wrapper 收敛到同一个「递归进 runScope」模型（loop/git 已是），fanout 只额外负责「拆 diff 成 shards + 给每个 shard 注入 shardValue + 聚合」。这直接消解 scheduler-audit R5（一抽象三实现）的结构根因，也是 dedup-audit「被绕过各写一份」在调度域最大的一块。

**[CHK-3] 加一种新 sharding 策略（场景：per-hunk / per-symbol / per-test-file 分片）** — 根因：分片 key 派生 `resolveKeyOf(itemKind)`（`scheduler.ts:3170`）+ item 来源耦合在 fanout 巨函数里，且 `dispatchFanoutShard` 与 fanout 主体强绑。今天加策略要懂整个 fanout dispatch 流程才能下手。目标形态：把「分片」抽成纯函数接口 `ShardingStrategy: (sourceContent, opts) => Shard[]`（`fanout.ts` 已有 `computeShardScope` 雏形可承接），fanout 主体只 `strategy.split(...)` 然后对每个 shard 跑 runScope——策略可注册、可单测、可被 RFC-055 的 inspector 复用。

**[CHK-4] 加跨任务全局并发治理 / 优先级队列（场景：限制 daemon 同时跑的 opencode 进程总数、给任务排队、按用户配额调度）** — 根因：没有 daemon 级 scheduler-coordinator。唯一跨任务载体是 `task.ts:80` 的 `activeTasks` Map（纯 AbortController 登记）；`runTask` 一被调用就立刻全速跑（`task.ts:813` `void runTask`），没有任何准入控制；globalSem 还是 per-task（SCHED-01）。现在要加全局治理，得动 startTask / resumeTask / retryNode 三个入口 + 巨石的信号量构造。目标形态：引入 `SchedulerCoordinator` 单例持有「全局 nodeSem + 待跑队列 + 每任务 controller 登记」，所有 runTask 经它准入；per-task 的只剩 writeSem（本就该 per-task）。这是 SCHED-01/02/CHK-4 的共同落点。

**[CHK-5] 把 `runScope` 拆出 scheduler.ts 单测 / 在其上加新调度策略（场景：换 work-stealing、加节点级超时驱动的重调度、可观测的 tick 事件流）** — 根因：`runScope` 与 `runOneNode` / 三个 wrapper runner / `maybeRunCommitPush` 全在同一 4962 行文件里互相直接引用，循环依赖 `scheduler.ts ↔ task.ts`（`scheduler.ts:58` import runTask from task? 实为 `task.ts:58 import runTask from './scheduler'` + `scheduler.ts:125 import {emitTaskStatus,getTask} from task`）使任何外移都要先解环。现在「调度循环」这个最该独立演进的核心，被焊死在巨石中央。目标形态：`runScope` + `deriveFrontier` 提成 `dispatchLoop.ts`，对 `runOneNode` 经一个 `NodeRunner` 接口注入（依赖倒置，断开对 wrapper 实现的直接依赖），对 task.ts 的 `emitTaskStatus/getTask` 也经回调注入——既解循环依赖（memory 记载的 binary-build module-cycle 风险），又让调度策略可替换、可独立测。

**[CHK-6] 给嵌套 wrapper 加深层复活（场景：loop-in-git 内层 approve / 深层 clarify answer 要唤醒最外层 wrapper）** — 根因：`wrapperRevivalEvidence`（`dispatchFrontier.ts:218`）的迭代窗是 **depth-1**（`:211` 注释明记「Known DEPTH-1 limitation」：内层 loop 的计数器 `j` 上的证据不会释放外层 wrapper）。这是设计已知接受的限制，但随「wrapper 嵌套被更广泛使用」会成为真实功能缺口。现在要修得重做迭代窗的多层映射。目标形态：复活证据按「证据行所属 scope 的迭代轴」逐层向上传播（每层 wrapper 解码自己 progress 的 iteration 作窗），而非用最外层单一窗扫全部后代。需配多层嵌套集成测试。

## 5. 耦合 / 分层违规

**[SCHED-09] `scheduler.ts ↔ task.ts` 循环依赖** — 级别 **P2**｜coupling ｜证据 `task.ts:58` `import { runTask } from './scheduler'` + `scheduler.ts:125` `import { emitTaskStatus, getTask } from '@/services/task'`｜影响：两个最大的服务模块互相引用，是 memory 记载的 single-binary build module-init-cycle 风险高发区（RFC-079 incident 同源）；也使 `runScope` 无法独立外移（CHK-5）。｜建议：依赖倒置——scheduler 需要的 `emitTaskStatus`/`getTask` 经 `SchedulerState` 字段或回调注入，断开 scheduler → task 的静态 import。

**[SCHED-10] 巨石直接 import 15 个兄弟服务，调度器同时是「编排者 + 各服务的胶水」** — 级别 **P3**｜coupling ｜证据 `scheduler.ts:66-137` 共 34 条 import，含 agent / agentDeps / mcpClosure / pluginClosure / clarify / clarifyRounds / exitCondition / lifecycle / nodeRunMint / taskWriteLocks / review / runner / envelope / commitPushRunner / task / nodeRollback ｜影响：调度器知道太多下游细节（注入闭包、commit&push、回滚、各 service 的具体函数），是 god-module 的必然伴生；任何下游签名变更都涟漪到巨石。｜建议：随 §7 的 executor 拆分，把「注入闭包 / 回滚 / commit」这些下沉到 agent-executor 模块，runScope 只认 `NodeRunner` 接口。

**[SCHED-11] 信号量取用顺序是 call-site 约定、无结构守卫（已部分缓解但仍是约定）** — 级别 **P3**｜coupling ｜证据 `scheduler.ts:1791-1792`（writeSem ≺ globalSem）、`:3635-3637` / `:3893-3895`（writeSem ≺ globalSem ≺ subprocessSem）三处手工布线相同锁序，RFC-098 survey §wp5 有死锁收敛证明但靠人工保证｜影响：已被 scheduler-audit R4 / S-17 覆盖（**标注：已被 scheduler-audit 覆盖**），此处仅补「这是 god-module 的结构性弱点延续」的架构视角——锁序对错由 3 个独立 dispatch 路径各自重复，是 CHK-2「fanout 各写一份」的副产品；fanout 收敛回 runScope 后，锁序也收敛到一处。

## 6. 测试 / 可观测性缺口

**[SCHED-12] 派发循环无 tick 级可观测性，stalled 是唯一诊断出口** — 级别 **P2**｜observability ｜证据：`runScope` 主循环（`:731-844`）除节点状态 broadcast 外，无「本 tick 派生了什么前沿 / 为什么某节点没进 ready / 派了几轮」的结构化日志或事件；`decideScopeOutcome` 的 `blocked` 诊断（`dispatchFrontier.ts:428`）只在**最终 stalled** 时才暴露｜影响：调度疑难（为什么任务卡住 / 为什么多跑一轮）只能靠事后 stalled 文案 + 人脑重放，没有「派发决策审计轨迹」。这也是「调度策略可演进」的前提缺失（CHK-5）。｜建议：`deriveFrontier` 返回值已是结构化 `Frontier`，加一个 opt-in 的 tick 事件（nodeRunEvents 或独立 debug 通道）记录每 tick 的 `{ready, blocked, completed.size}`，CI 下默认开、生产可关。

**[SCHED-13] `release()` 双重释放 / 容量突破无测试（SCHED-06 的护栏缺口）** — 级别 **P3**｜test-gap ｜证据：`util/semaphore.test.ts` 若存在也未覆盖 double-release（`release()` 无守卫即说明）｜建议：随 SCHED-06 修复补「double-release 不抬高 available」「resize 扩缩容唤醒/阻塞」红测。

**[SCHED-14] 「globalSem 应为全局」无源码层守卫** — 级别 **P3**｜test-gap ｜证据：SCHED-01 的退化无任何测试锁定「N 并发任务时同时在飞节点 ≤ maxConcurrentNodes」｜建议：随 SCHED-01 修复加并发集成测试（2 任务各 ≥4 就绪节点 → 断言全局同时在飞 ≤ 容量）。

## 7. 目标形态（Target architecture）

理想的调度子系统应是**三层 + 一个注册表**，巨石按职责裂解：

1. **`SchedulerCoordinator`（daemon 单例，新模块）** — 持有全局 `nodeSem`（可 resize）+ 准入队列 + `activeTasks` 登记 + 跨任务并发/优先级治理。所有 `runTask` 经它准入。落点：SCHED-01/02、CHK-4、SCHED-14。

2. **`dispatchLoop.ts`（纯编排，从 scheduler.ts 外移）** — `runScope` + `deriveFrontier` + `Frontier` + `decideScopeOutcome`（与 dispatchFrontier 的谓词合并成「完整派发大脑」一个文件）。对节点执行只认 `NodeRunner` 接口（依赖倒置），tick 内一次读 rows 下传递归层。落点：SCHED-03、SCHED-07、SCHED-09、CHK-5、SCHED-12。

3. **`NODE_EXECUTORS satisfies Record<NodeKind, NodeExecutor>`（注册表，shared 矩阵的运行时升级）** — 每 kind 一个 executor 模块声明全部 cross-cutting 维度（dispatch / isResumeAnchor / settlesWithoutRow / orphanReap / limits / gc / shutdown）。runOneNode 退化成 `NODE_EXECUTORS[kind].dispatch(ctx)`；orphans/limits/gc/shutdown/deriveFrontier 全查同一矩阵；加新 kind = 新增一文件 + 编译器逼填全维度。落点：SCHED-04/05、SCHED-08、CHK-1。

4. **三套 wrapper 收敛到「递归进 runScope」** — fanout 改为「拆 shards（可插拔 `ShardingStrategy`）→ 每 shard 一次 runScope」，与 loop/git 同模型，删除 `dispatchFanoutShard`/`dispatchFanoutAggregator` 对 agent 执行路径的重抄。落点：CHK-2/CHK-3、SCHED-11、消解既有审计 R5。

5. **`agent-executor` 子模块** — 把 runOneNode 的 agent 路径（取数 / 注入闭包 / 重试内循环 / envelope-followup / 快照回滚 / 铸行）拆成协作单元，commit&push / 回滚 / 注入这些下沉到这里，解开 SCHED-10 的胶水耦合。

落地纪律：以上全是结构重构，须走 RFC（CLAUDE.md 强制），且每步以「既有 scheduler/clarify/review/loop/fanout 套件 + e2e 全绿」为等价锚（RFC-076 R2 同款），先抽纯函数（可穷举单测）再 wire。

## 8. Top 风险与建议优先级

| 优先级 | ID | 标题 | 级别 | 类型 | 一句话 |
| --- | --- | --- | --- | --- | --- |
| 1 | SCHED-01 | 全局信号量退化成 per-task，跨任务无并发上限 | P1 | design/coupling | N 任务 = N×4 进程，违背 design.md:755，无兜底 |
| 2 | SCHED-02 | maxConcurrentNodes 热更新未实现 + 容量不可变 | P2 | design/impl-bug | 设置改了对在跑任务无效，违背 design.md:1363 |
| 3 | SCHED-04 | runOneNode god-function，kind 路由无穷举护栏 | P2 | extensibility | 1144 行 if-chain，加 kind 碰 ~10 处 |
| 4 | SCHED-05 | NODE_KIND_BEHAVIORS 矩阵 4/5 维未被消费 | P2 | extensibility | 假单一事实源，orphans/limits/gc/shutdown 仍 kind-blind |
| 5 | CHK-2 | fanout 不复用 runScope，只能装 agent-single | P2 | extensibility | shard 执行路径二次发明 runScope，R5 结构根因 |
| 6 | SCHED-06 | Semaphore.release() 无双重释放守卫 | P2 | impl-bug | 误调即静默突破并发上限、永不报错 |
| 7 | SCHED-07 | 每 tick 全量重读 node_runs，嵌套 N 层各读一遍 | P2 | perf | 图变大线性恶化 + loadOpenClarify 冗余 2 查询 |
| 8 | SCHED-03 | deriveFrontier 纯函数留在巨石、大脑劈两文件 | P2 | coupling | 完整派发决策被文件边界割裂 |
| 9 | SCHED-09 | scheduler ↔ task 循环依赖 | P2 | coupling | binary-build module-cycle 风险，挡住 runScope 外移 |
| 10 | SCHED-12 | 派发循环无 tick 级可观测性 | P2 | observability | 调度疑难只能靠 stalled 文案事后重放 |
