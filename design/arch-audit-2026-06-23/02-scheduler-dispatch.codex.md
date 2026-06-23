# Codex 核验：调度器与派发前沿（scheduler 巨石） (02-scheduler-dispatch)

> 对应报告：`design/arch-audit-2026-06-23/02-scheduler-dispatch.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **SCHED-01 属实，P1 合理**：`globalSem` 在每次 `runTask` 内构造，实际是 per-task，而设计要求 daemon 级全局 semaphore。证据：`packages/backend/src/services/scheduler.ts:389-403`，设计为全局：`design/design.md:755-756`。`activeTasks` 也只是跨任务 AbortController registry，不承载并发协调：`packages/backend/src/services/task.ts:72-80`。
- **SCHED-02 属实，且问题比报告更重**：`Semaphore.capacity` 是 `readonly` 且无 resize：`packages/backend/src/util/semaphore.ts:10-18`；配置 PUT 只落盘返回，没有触发调度器更新：`packages/backend/src/routes/config.ts:15-18`。热更新承诺未实现：`design/design.md:1363`。
- **SCHED-04 属实，P2 合理**：`runOneNode` 从 `output/input/wrapper/review/clarify/cross-clarify/agent` 路由到执行细节都内联在一个函数里，且无 `Record<NodeKind, ...>` 穷举路由表。证据：`packages/backend/src/services/scheduler.ts:1448-1649`、agent 主路径继续到 `packages/backend/src/services/scheduler.ts:1768-2447`。
- **SCHED-05 基本属实，但更像“未完成的事实源”而非运行时 bug**：矩阵明说只有 `retryCascade` 被消费，其余四维是 intended behavior：`packages/shared/src/node-kind-behavior.ts:15-21`；实际只有 retry cascade 读取矩阵：`packages/backend/src/services/task.ts:1316-1323`。`orphans/limits/gc/shutdown` 仍按状态/任务维度工作：`packages/backend/src/services/orphans.ts:40-47`、`packages/backend/src/services/limits.ts:33-58`、`packages/backend/src/services/gc.ts:50-84`、`packages/backend/src/services/shutdown.ts:22-53`。
- **SCHED-06 属实，但建议降为 P3/P2 边界**：双重 release 会把 `available` 抬过容量，且测试没有覆盖 double-release。证据：`packages/backend/src/util/semaphore.ts:36-57`，现有测试只覆盖基本 acquire/FIFO/run：`packages/backend/tests/semaphore.test.ts:13-87`。当前调用点 finally 配对看起来正确：`packages/backend/src/services/scheduler.ts:2444-2447`、`packages/backend/src/services/scheduler.ts:3694-3698`、`packages/backend/src/services/scheduler.ts:3950-3954`。
- **SCHED-07 属实为性能风险**：每个 `runScope` tick 全 task 扫 `node_runs`，另查两张 clarify session 表。证据：`packages/backend/src/services/scheduler.ts:741-755`、`packages/backend/src/services/scheduler.ts:888-921`；scope/iteration 过滤在内存中做：`packages/backend/src/services/scheduler.ts:1188-1195`。
- **SCHED-08 属实，但不是 impl-bug，降为 P3 coupling**：cross-clarify 守卫内联约 90 行，而 review 是一行委托。证据：`packages/backend/src/services/scheduler.ts:1496-1509` vs `packages/backend/src/services/scheduler.ts:1524-1613`。
- **CHK-2 属实为扩展瓶颈，不是当前 bug**：fanout v1 明确只支持 `agent-single`，运行时拒绝其他 inner kind：`packages/backend/src/services/scheduler.ts:2931-2940`、`packages/backend/src/services/scheduler.ts:3198-3210`。
- **SCHED-09/SCHED-10 属实**：`task.ts` import scheduler，scheduler 又 import task：`packages/backend/src/services/task.ts:58`、`packages/backend/src/services/scheduler.ts:125`；scheduler import 面很宽：`packages/backend/src/services/scheduler.ts:66-139`。
- **SCHED-12 基本属实，建议降为 P3 observability**：runner 有 `nodeRunEvents`，但 `runScope` 只派生 `Frontier` 后调度，没有持久化 tick/frontier 决策事件。证据：`packages/backend/src/services/scheduler.ts:741-783`；stalled 诊断只在最终 outcome 出现：`packages/backend/src/services/dispatchFrontier.ts:426-438`。

## REFUTED / 伪问题（给反证 file:line）

- **SCHED-03 中“deriveFrontier 留在巨石里使它无法独立单测”不成立**：`deriveFrontier` 已导出：`packages/backend/src/services/scheduler.ts:1175-1187`，测试直接 import 它：`packages/backend/tests/derive-frontier.test.ts:14`、`packages/backend/tests/scheduler-audit-s12-status-bucket-universe.test.ts:50`。保留“文件边界割裂”作为结构问题可以，但不能作为“无法单测/无法复用”的证据。
- **SCHED-07 的“tick 内 rows 下传给内层 runScope，同一 tick rows 不变”建议不成立**：`runScope` 自己会 `Promise.race` 等节点完成后进入下一 tick 并重读 DB：`packages/backend/src/services/scheduler.ts:731-783`；内层 wrapper 也会在执行期间产生新 `node_runs`。把同一份 rows 递归复用会看不到内层完成/park/rerun 行，风险高。优化方向应是 scoped query/index 或事件化增量，而不是复用旧快照。
- **SCHED-05 里把 orphans 不读矩阵说成直接错行为过强**：当前 orphan reaper 只处理 `running/pending`，这与矩阵注释中“awaiting_* survive daemon restart”的意图一致：`packages/backend/src/services/orphans.ts:40-47`、`packages/shared/src/node-kind-behavior.ts:65-80`。问题是“事实源未接入”，不是已证明的现行错误。
- **CHK-6 深层复活不是报告新发现，而是代码已明示的 accepted limitation**：`wrapperRevivalEvidence` 注释明确记录 depth-1 限制：`packages/backend/src/services/dispatchFrontier.ts:204-216`。可列为未来风险，但不应包装成审计新证据。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **HTTP 路径完全未传 `maxConcurrentNodes` — P1 — `packages/backend/src/routes/tasks.ts:250-258`, `packages/backend/src/services/task.ts:813-834`, `packages/backend/src/services/scheduler.ts:155-157` — 影响：不只是热更新无效，正常从 API start/resume/retry 的任务也永远走 scheduler 默认 4；只有测试直调 `runTask({ maxConcurrentNodes })` 会生效。全仓生产代码仅声明/消费该字段，没有 route wiring：`rg maxConcurrentNodes` 只命中 `scheduler.ts`。**
- **resume/retry 也未传 commitPush 配置 — P2 — `packages/backend/src/routes/tasks.ts:376-383`, `packages/backend/src/routes/tasks.ts:445-456`, `packages/backend/src/services/task.ts:1096-1114`, `packages/backend/src/services/task.ts:1362-1374` — 影响：startTask 会传 `commitPush`，但 resume/retry 不传；如果任务在恢复/单节点重试后触发 auto commit&push，会退回默认 commitPush 配置，行为与 start 路径不一致。**
- **fanout wrapper 不参与 visual bounds 校验 — P3 — `packages/backend/src/services/workflow.validator.ts:819-825`, `packages/shared/src/schemas/workflow.ts:392-405` — 影响：`wrapper-fanout` 也使用 `nodeIds[]` 容器模型，但 validator 的“inner positioned inside wrapper bounds”只检查 git/loop，编辑器/快照可能接受视觉上脱离 fanout 容器的 inner 节点，进一步加剧 fanout 子图维护成本。**

## 建议批判（对目标形态 / 重构建议的评价与更优解）

- **SchedulerCoordinator 是必要方向，但必须保留 RFC-097 状态机边界**：协调器可以持有全局 node semaphore、active task controllers 和队列；但任务状态仍应只经 `setTaskStatus/trySetTaskStatus`，不能把状态写封进裸回调。当前 CAS 不变量在 `packages/backend/src/services/lifecycle.ts:231-296`，scheduler 终态也遵守：`packages/backend/src/services/scheduler.ts:449-515`。
- **先修 wiring，再谈全局队列**：第一步应把 `maxConcurrentNodes` 从 config route/start/resume/retry 传进 scheduler，并加跨任务集成测试；否则“全局 semaphore”会掩盖一个更基础的配置未接线问题。
- **NodeExecutor 注册表方向合理，但别把 `NODE_KIND_BEHAVIORS` 直接膨胀成万能矩阵**：dispatch、retryCascade、settlesWithoutRow 可以纳入穷举注册表；limits/gc/shutdown 当前多是 task 级行为，强行 per-kind 化可能过度设计。更优是拆成“运行时执行注册表”和“跨切面行为矩阵”，只让真实消费者读取真实维度。
- **fanout 收敛到 runScope 是对的，但不能一次性重写**：现有 fanout 有 shard reuse/valueHash/aggregator 语义：`packages/backend/src/services/scheduler.ts:3479-3515`、`packages/backend/src/services/scheduler.ts:3725-3954`。应先抽 `ShardingStrategy` 和 shard row lifecycle，再让 shard scope 复用 `runScope`，避免破坏 RFC-098 fanout resume/reuse 语义。
- **opencode env merge 不应下沉到多个 executor 复制**：runner 当前集中设置 `process.env` + `PWD` + `OPENCODE_CONFIG_DIR` + `OPENCODE_CONFIG_CONTENT`：`packages/backend/src/services/runner.ts:720-738`。executor 拆分后仍应让所有 opencode spawn 经 runner，避免破坏 opencode env 合并优先级。
- **RFC-099 prompt 隔离要作为重构验收项**：runner 只持久化实际 prompt：`packages/backend/src/services/runner.ts:633-669`；任务路由拒绝旧 assignments 字段并只用成员制授权：`packages/backend/src/routes/tasks.ts:218-258`。重构 executor/dispatch loop 时不能把 actor、owner、review decision author 等身份元数据注入 agent prompt。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：报告对 scheduler 巨石、per-task semaphore、fanout 重复路径、kind 行为事实源未接入的判断基本扎实；但有少数证据夸大，并漏掉了 `maxConcurrentNodes` 在 HTTP 生产路径完全未接线这一更直接的问题。
