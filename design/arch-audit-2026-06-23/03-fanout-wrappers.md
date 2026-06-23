# Fan-out / wrapper（git / loop / fanout）与分片 — 架构审计 (2026-06-23)

> 子系统 key: `03-fanout-wrappers`。范围：多进程节点分片、wrapper 嵌套语义、退出条件、分片注册表扩展性、per-shard 链路。
> 既有审计交叉印证基线：`design/scheduler-audit-2026-06-10.md`（S-3/S-4/S-5/S-6/S-7/S-18~S-21/S-28）、`design/dedup-audit-2026-06-13.md`。
> 重要状态背景：S-3/S-4/S-7/S-19/S-20/S-21/S-28 已被 **RFC-098 B3**（commit `46ff73b`）根治；S-5/S-6 已被 **RFC-094**（validator 守门）改为「启动前阻断」——**不是实现了嵌套，而是禁止了嵌套**。本报告不重复这些 bug 细节，聚焦它们暴露的架构与扩展性结构。

## 0. 健康度一句话

子系统在「单层 fanout / 单层 git / 单层 loop」happy path 上经过 RFC-098/094 加固后已相当稳健，但代价是**用「validator 禁入 + runtime 拒绝」把所有组合形态（嵌套、per-shard 链、非 agent-single inner）锁死成 v1 不支持**——三类 wrapper 共享同一 `nodeIds[]` 容器抽象却各写一套 run 函数，分片协议把 `list<T>` 硬编码成「按 `\n` split」，分片策略注册表（RFC-060）与旧的 diff 分片器（`util/diffSplit.ts`）并存且后者已成死代码，设计文档 §6.3/§5.1 仍描述早已被 RFC-060 删除的 `agent-multi` + `ShardingStrategy`——**这是一个「能跑但每加一个组合维度都要碰 scheduler + validator + schema + 前端四处」的高耦合区**。

## 1. 当前架构与职责（关键文件清单）

三类 wrapper（`wrapper-git` / `wrapper-loop` / `wrapper-fanout`）在 schema 层共享同一「持 `nodeIds[]` 内层子图」的容器形态，但在 scheduler 层是三个独立的 `run*WrapperNode` 函数，各自手写 resume / mark-running / 失败 / 持久化进度。Fanout 是唯一的分片机制（RFC-060 PR-E 删除了 `agent-multi`）：消费一个 `isShardSource: true` 且 kind 为 `list<T>` 的输入端口，把内容按 `\n` 切成 items，每个 item 一个 shard，per-shard 派发 `agent-single` inner，可选一个 `role='aggregator'` inner 在汇聚点跑一次。

- `packages/backend/src/services/fanout.ts` — 纯函数：`computeShardScope`（BFS 分 perShard/shared）+ `applyAutoPromote` + `estimateShardTotal`（笛卡尔守卫）+ `findBoundaryEdgesToInner`。
- `packages/shared/src/wrapperFanout.ts` — `findFanoutAggregator` / `countFanoutAggregators` / `deriveWrapperFanoutOutputs`（outlet 端口从内层 aggregator 派生）。
- `packages/shared/src/shardingRegistry.ts` — `resolveKeyOf`：按 item kind 解析 shardKey（path 家族用路径本身，其余 0-based index）。
- `packages/backend/src/services/exitCondition.ts` — loop 退出条件解析 + 求值（4 种 kind）。
- `packages/backend/src/services/wrapperProgress.ts` — 三类 wrapper 共享的 `wrapper_progress_json` 编解码（loop iteration / git baseline+preDirty / fanout reuseDisabled）。
- `packages/backend/src/services/scheduler.ts` — `runFanoutWrapperNode`(2948) / `dispatchFanoutShard`(3457) / `dispatchFanoutAggregator`(3725) / `runLoopWrapperNode`(2745) / `runGitWrapperNode`(4038)。
- `packages/backend/src/services/workflow.validator.ts` — fanout/wrapper 拓扑与禁入规则（aggregator placement、nested-loop、fanout-inner-chain、shardSource 形状）。
- `packages/backend/src/util/diffSplit.ts` — **旧 diff 分片器（per-file/per-n-files/per-directory），现已无生产消费者（见 IMPL-04）**。
- 前端：`canvas/{wrapperFit,wrapperMembership,wrapperOps,wrapperCandidates}.ts` 处理 wrapper 容器 UX；`fanoutSourceSync.ts` 已退化为全 no-op stub。

## 2. 设计问题（Design）

**[FANW-D1] 三类 wrapper 共享容器抽象却三套独立实现，每条语义逐项漂移** — 级别 P2｜类型 design/coupling｜证据 `scheduler.ts:2745`(loop) `:4038`(git) `:2948`(fanout) 各自手写 resume/mark-running/persist；`workflow.validator.ts:316-322` 三 case 各列 outputs；`wrapperFit.ts:188-192`/`wrapperMembership.ts:85`/`wrapperOps.ts:18-21` 处处 `kind !== 'wrapper-git' && !== 'wrapper-loop' && !== 'wrapper-fanout'` 三连判（grep 全仓 ≥6 处）｜影响：这正是 scheduler-audit 根因 R5「wrapper 三件套同一抽象三种实现」的架构表达——consumed provenance 历史上只有 fanout 写（S-7）、复活条件只认 pending（S-3）、迭代轴只修 wrapper 自身行漏 inner 行（S-6）、git baseline 缺 pre_diff（S-4），每个不一致都曾各爆一次 bug。加第四类 wrapper（或给三类同时加一个新能力如「inner 内 review」）必须改 N 处｜建议：抽 `WrapperRunner` 接口（`mintOrResume / persistProgress / finalize / deriveOutlets`）+ 一个 `WRAPPER_KINDS` 常量集合消除三连判（dedup-audit 已登记此类「公共原语被绕过」模式）。

**[FANW-D2] 分片协议把 `list<T>` 硬编码成「按 `\n` split + trim + 丢空」，没有结构化列表编码** — 级别 P1｜类型 design｜证据 `scheduler.ts:3129-3132` `rawContent.split('\n').map(trim).filter(len>0)`；上游一律 `join('\n')` 序列化（`scheduler.ts:4221` git_diff、`review.ts:1397` accepted、`distillerSourceContext.ts:40`）｜影响：对 `list<path>` 成立（路径几乎无换行），但 `shardingRegistry` 与 schema 明确把 shardSource 设计为「任意 `list<T>`」可扩展面。一旦 item 内含换行（如 `list<markdown>` 片段、`list<json>`）会**静默裂成多个 shard**；item trim 后为空会**静默丢失**（任务照样 green）。`list<list<T>>` 完全无法表达。这是一条隐藏的「静默错误」面，与 scheduler-audit 强调的最危险共性（任务显示成功但消费了错误输入）同源｜建议：引入显式列表编码（JSONL / 长度前缀 / `\0` 分隔），由 kind 决定 split 策略，纳入 shardingRegistry 的职责（见 FANW-X1）。

**[FANW-D3] 设计文档 §5.1/§6.3 与实现严重漂移：`agent-multi` + `ShardingStrategy` + `GitHelper.split` 全已删除** — 级别 P2｜类型 design｜证据 `design/design.md:582,593-596`（`kind: 'agent-multi'` + `shardingStrategy` + `sourcePort`）、`:655-658`（`type ShardingStrategy = per-file | per-n-files | per-directory`）、`:771` `GitHelper.split(diff, strategy)`——这些在 RFC-060 PR-E 已被 `wrapper-fanout` + `isShardSource` + `resolveKeyOf` 取代｜影响：design.md 是「权威」文档，新 session 按仓规先读 design 建立心智模型，会照着已不存在的 `agent-multi`/`ShardingStrategy` 设计去扩展，撞墙后才发现实现是另一套（RFC-060 内联在 §6.5 注里勘误了 git_diff，但 §5.1/§6.3 主干未同步）｜建议：把 §5.1 的 `agent-multi` 分支、§6.3 整节、§6.4 的退出条件清单（缺 `port-not-empty`）、`ShardingStrategy` 类型一次性改写为 RFC-060/098 现实，或在节首加权威指针「本节已被 RFC-060 取代，见 …」。

**[FANW-D4] fanout 失败语义是 fail-all-after-join，errors port / 部分容忍是文档承诺但未实现的 deferred** — 级别 P2｜类型 design｜证据 `scheduler.ts:3281-3291` 任一 shard failed → 整 wrapper failed、跳过聚合、不写 outlet；`design/design.md:777-787` 已勘误为 v1 fail-all 并把 errors port 标 deferred（WP-6b）｜影响：已被 scheduler-audit S-18 + RFC-094 覆盖并锁定，不是新发现。架构含义是：fanout 的「容错」是它最核心的卖点之一（Code→Audit→Fix 里一个 shard 挂不该拖垮全盘审计），却恰恰未实现——这制约了 fanout 作为「鲁棒并行审计」的产品定位｜建议：保持 deferred 标注，落地时与 done-only 聚合（S-21）+ 断点续跑（S-19）合并设计（已在 WP-6b 规划）。

**[FANW-D5] 笛卡尔守卫 `estimateShardTotal` 的嵌套乘子分支是死防御代码 + `expectedShardCount` 字段事实死字段** — 级别 P3｜类型 design｜证据 `fanout.ts:163-174` 只对 `inner.kind === 'wrapper-fanout'` 累乘 `expectedShardCount`，但 `scheduler.ts:3198-3211` 在派发前对任何非 `agent-single` inner（含 `wrapper-fanout`）直接 `v1-unsupported-inner-kind` failed——嵌套 fanout 在 mint 任何 shard 前就挂了，乘子分支永不触发；`expectedShardCount`（schema `workflow.ts:445`）因此也无人消费｜影响：守卫退化为 `outerShardCount > maxAllowed` 的单层判断；维护者读到「笛卡尔乘积守卫」会误以为嵌套 fanout 被支持｜建议：要么实现嵌套 fanout（让乘子活起来），要么把 `estimateShardTotal` 简化为单层 + 删 `expectedShardCount` 字段 + 注释说明嵌套是 runtime-rejected。

## 3. 实现问题 / Bug（Impl）

**[FANW-IMPL1] loop wrapper 用 `markWrapperTerminal(..., 'exhausted')` 写 node_run 终态——与 RFC-097 状态机一致但 design.md §6.4 的 `task.status = failed` 表述会误导** — 级别 P3｜类型 impl-bug/design｜证据 `scheduler.ts:2921` 写 node_run `exhausted`；`design/design.md:809-810` `wrapper.status = exhausted / task.status = failed`；CLAUDE.md 勘误「任务级从无 exhausted，loop 耗尽时任务以 failed 收场」｜影响：实现正确（node_run=exhausted、return kind=failed 让任务 failed），但 design 文字把 wrapper 与 task 两级 status 混写，是 RFC-097 勘误点的残留｜建议：design §6.4 文字对齐 RFC-097（node_run 级 exhausted、task 级 failed）。

**[FANW-IMPL2] shared inner 误接 shardSource 边时「复制第一个 shard 的值」是 acceptable degenerate，但实际复制的是 boundary 边语义而非第一 shard** — 级别 P3｜类型 impl-bug｜证据 `scheduler.ts:3292-3298` 注释称「boundary edge injection 仍复制 first shard's value」，但 `dispatchFanoutShard` 在 `shard === null`（shared 派发）时 `:3571` `if (shard !== null)` 整块跳过——shared inner **根本不注入任何 shard 值**，只拿 broadcast inputs。注释与代码不符｜影响：行为其实更安全（不乱注入），但注释撒谎，下一个维护者会基于错误注释推理。validator 是否真的拦住「shared inner 接 shardSource 边」未见专门规则｜建议：修正注释为「shared inner 不接收 shard 值」；补一条 validator 规则显式拒绝 shared inner 绑定 shardSource 端口（目前靠「validator should already prevent」的口头约定）。

**[FANW-IMPL3] `computeShardScope` BFS 对每个内层节点全量扫 `defn.edges`（O(V·E)），`findFanoutAggregator` 对每个 innerId 做 `defn.nodes.find`（O(N²)）** — 级别 P3｜类型 perf｜证据 `fanout.ts:86`（队列内层 `for e of defn.edges`）、`fanout.ts:166` `defn.nodes.find` per innerId、`wrapperFanout.ts:75,96` 同样 per-innerId find｜影响：每次 fanout 派发触发，但 workflow 规模通常小（几十节点），实际可忽略；属「热点调研 fortify 后再 refactor」范畴｜建议：派发入口构建一次 `nodeById` / `edgesBySource` 索引传入纯函数（与 validator 已有的 `nodeById` 一致），收敛重复扫描（dedup-audit 同主题）。

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节是重点

**[FANW-X1] 未来要支持 `list<string>` / `list<json>` / 富 item 作为 shardSource → 必须重写分片协议（split 在 scheduler，keyOf 在 registry，序列化散落各处）** — 级别 P1｜类型 extensibility｜
- 触发场景：半年后用户想 fan-out 一个「审计清单（每条多行 markdown）」或「JSON 任务数组」，而非纯路径列表。
- 根因：分片协议被切成三段且无单一事实源——（a）**split** 硬编码在 `scheduler.ts:3129` 按 `\n`；（b）**keyOf** 在 `shardingRegistry.ts`；（c）**序列化** 在每个上游各写一份 `join('\n')`（git_diff/accepted/distill…）。三段各自假设「item 即一行文本」。
- 现在加功能要碰：`scheduler.ts` 的 split 逻辑 + `shardingRegistry.ts` + 每个产 `list<T>` 的上游序列化点 + `kindParser`（确认 item kind）+ 测试。且因为是隐式 `\n` 契约，漏改一处就静默裂分片（FANW-D2）。
- 目标形态：把「list<T> 的编解码」收进 shardingRegistry 成为一对 `splitOf(itemKind) / keyOf(itemKind)`（甚至 `encodeList/decodeList`），上游统一调用 `encodeList(kind, items)`，fanout 入口统一 `decodeList(kind, content)`——一处定义、一处消费，新 item 类型只需注册一对函数。

**[FANW-X2] 未来要支持 fanout 内多步链（A→B per-shard）/ 非 agent-single inner（review/loop/git in fanout）→ 当前是 validator 禁入 + runtime 拒绝两道墙，实现要拆 dispatchFanoutShard 的「一个 inner 一次 runNode」假设** — 级别 P1｜类型 extensibility｜
- 触发场景：per-shard 做「审计→修复」两步（S-5 的正解）、或每个 shard 内嵌一个 review 人审、或 shard 内再 fanout。
- 根因：`dispatchFanoutShard`（`scheduler.ts:3457`）把「inner = 单个 agent-single、跑一次 runNode」焊死；per-shard 子图不走 `runScope`（与 loop/git wrapper 走 runScope 的方式根本不同）。`resolveUpstreamInputs` 过滤 `parentNodeRunId !== null` 的 shard-child 行，使 per-shard 链的 B 永远读到空（S-5）。所以 RFC-094 用 `fanout-inner-chain-unsupported`（validator）+ `v1-unsupported-inner-kind`（runtime）双墙堵死。
- 现在加功能要碰：`dispatchFanoutShard` 重写为「per-shard 跑一次 runScope，shard 值作为子 scope 的虚拟输入」+ `resolveUpstreamInputs` 让 shard-child 行对同 shard 同 wrapper 的兄弟可见 + 删 validator 两条禁入 + 删 runtime 拒绝 + scope 计算（已能 perShard 分桶，但派发侧没用上）+ 大量幂等/恢复测试。
- 目标形态：fanout 的 perShard 派发与 loop/git 一样委托给 `runScope`（带 shardKey 维度的 scope context），让「per-shard 子图」与「loop 内子图」共用同一个调度引擎——这样 review/clarify/嵌套 wrapper 在 shard 内自动可用（消除 D.T4/D.T5「PR-D2 再说」的整片缺口）。这是 fanout 从「单 agent 扇出」升级为「子图扇出」的关键重构。

**[FANW-X3] 未来要支持任意 wrapper 嵌套（loop-in-loop / fanout-in-loop 跨轮）→ 迭代轴是 wrapper 自身一根计数器，inner 行不带「外层轮次」维度** — 级别 P1｜类型 extensibility/design｜
- 触发场景：外层 loop 每轮跑一次内层 fanout 审计；或真正的嵌套 loop。
- 根因：`iteration` 是单一标量（`runScope` 的 `iteration` 参数），loop inner 行写 `iteration=i`（内层 loop 自己又从 0 计数），外层第 2 轮起内层 frontier 撞到第 1 轮 done 行直接 no-op（S-6）。RFC-094 用 `wrapper-loop-nested`（传递闭包：loop→git→loop / loop→fanout→loop 全命中）error 禁入。
- 现在加功能要碰：node_run 的 iteration 标量要升级为「迭代路径」（外层轮次链），freshness/frontier 的「同 iteration 复用」判定、`readPortAtIteration`、wrapperProgress、所有 `eq(nodeRuns.iteration, …)` 查询全部要带上嵌套维度。这是一次跨 scheduler/freshness/schema 的深改。
- 目标形态：用「scope 路径栈」（如 `[outerLoopIter, innerFanoutShardKey, …]`）替代单标量 iteration 作为 node_run 的执行坐标；frontier 与 freshness 按完整路径而非裸 iteration 判定复用。在此之前嵌套靠 validator 禁入是正确的止血，但它把「wrappers nest arbitrarily」（CLAUDE.md 产品承诺）降级为「v1 几乎不能嵌套」。

**[FANW-X4] 未来要恢复/扩展内置分片策略（per-file/per-N/per-directory）→ 旧 `diffSplit.ts` 是死代码，新 registry 只做 keyOf 不做 grouping** — 级别 P2｜类型 extensibility/coupling｜
- 触发场景：产品想回归「按目录/按 N 文件分片」（前端 i18n + design.md 都还在描述这能力）。
- 根因：RFC-060 把分片从「框架按策略切 diff」翻转成「上游产 `list<path>`，每路径一 shard」。`util/diffSplit.ts`（186 行、含 per-file/per-n/per-directory + binary footer）因此失去所有生产消费者（仅剩 `scripts/perf-sweep.ts` + 测试 + 一句过期注释 `util/git.ts:541`）。但前端 i18n（`zh-CN.ts:1430-1439` `fieldShardingStrategy`/`perNFiles`/`perDirectory`）与 design.md §6.3 仍宣传它。要 N-文件/目录分片，现在唯一办法是写一个 agent 把 `list<path>` 重新分组成 `list<list<path>>`——但 `list<list>` 又撞 FANW-D2。
- 现在加功能要碰：要么复活 `diffSplit.ts` 并接进 fanout（但它产 `Shard{content}`，与现行 `list<item>` 模型不兼容），要么在 registry 增「grouping 策略」维度。
- 目标形态：明确 `diffSplit.ts` 的去留——若策略分片是产品需求，把 grouping 提升为 shardingRegistry 的第二轴（`groupingOf(strategy)`）并删 `diffSplit.ts`；若不是，删死代码 + 删孤儿 i18n（FANW-X5）+ 改 design.md。当前并存是「两套分片思路同仓」的活化石。

**[FANW-X5] 孤儿前端 i18n（`fieldShardingStrategy` 等 6 个 key）无任何组件消费，但仍是双语维护负担** — 级别 P3｜类型 extensibility/test-gap｜证据 `i18n/zh-CN.ts:1430-1439,3797-3806` + `en-US.ts:1504-1515` 定义；grep `packages/frontend/src/components` 对 `fieldShardingStrategy`/`sharding.perNFiles`/`sharding.perDirectory` **零引用**（NodeInspector fanout 分支用 `isShardSource`，`NodeInspector.tsx:631-760`）｜影响：每次 i18n 改动都要带着这组死 key；它们还反过来「证明」分片策略 UI 存在，误导维护者｜建议：删除这 6 个 key（纯文档/i18n 清理，仓规允许直接提交），与 FANW-X4 的死代码清理一并。

**[FANW-X6] aggregator 是「fanout 内恰好一个 role='aggregator' agent」的隐式契约，扩展多 aggregator / 自定义汇聚逻辑要改多处 + 派生 outlet 逻辑** — 级别 P2｜类型 extensibility｜证据 `wrapperFanout.ts:67-130` outlet 从首个 aggregator 派生、`fanout.ts:64` scope 排除 aggregator、`validator:572-587` aggregator 必须在 fanout 内、`scheduler.ts:3336-3374` 派发 aggregator｜影响：「多 aggregator」当前是 validator error（`multiple-aggregators-in-fanout`），`deriveWrapperFanoutOutputs` 还专门写了「fallback 到第一个」的韧性分支；要支持 N 路汇聚或非 agent 汇聚（如内置 concat）要碰 wrapperFanout + fanout.ts + scheduler 三处｜建议：把「outlet 派生 + scope 排除 + 派发」收进单一 `FanoutTopology` 描述对象，由一处计算，多 aggregator 只是该对象的一个变体。

## 5. 耦合 / 分层违规

**[FANW-C1] 纯函数模块 `fanout.ts` 持类型断言「读 passthrough schema」而非用强类型节点** — 级别 P2｜类型 coupling｜证据 `fanout.ts:32-35,42-48,168` 反复 `node as Record<string, unknown>` 读 `nodeIds`/`inputs`/`expectedShardCount`；`wrapperFanout.ts:45,56` 同样｜影响：`wrapper-fanout` schema（`workflow.ts:427`）其实是强类型的，但消费侧绕过 schema 用 `Record<string,unknown>` 手取，类型安全在此断裂——schema 改字段名编译器不报错。dedup-audit 的「公共原语被绕过」在类型层的体现｜建议：消费侧用 `WrapperFanoutNode` 类型 + 一个 narrowing helper（`asFanout(node)`），让 schema 成为单一事实源。

**[FANW-C2] scheduler 的 fanout 派发与「单 agent 调度」逻辑重复 ~80 行（injection/concurrency/runNode 装配）** — 级别 P2｜类型 coupling/dedup｜证据 `dispatchFanoutShard:3613-3699` 与 `dispatchFanoutAggregator:3872-3954` 与单节点 `runOneNode` 分支三处各写一遍 `prepareNodeRunInjection` + `writeSem/globalSem/subprocessSem` 三锁 + `runNode(...)` 巨型参数对象；注释自承「bringing that whole branch in here would duplicate ~500 lines」（`scheduler.ts:3446-3449`）｜影响：per-shard 没有 clarify/review/retry 正是因为没复用单节点分支（D.T4/D.T5 缺口）；三份 runNode 装配漂移风险（如 RFC-067 git identity 要在三处都接线）｜建议：抽 `dispatchAgentNode(ctx)` 单一入口，shard/aggregator/单节点都走它，shard 维度作为可选 context——这同时解锁 FANW-X2 的 per-shard review/clarify。

## 6. 测试 / 可观测性缺口

**[FANW-T1] fanout 的「禁入 + 拒绝」双墙有测试锁定，但「item 含换行/空白静默裂分」无测试** — 级别 P2｜类型 test-gap｜证据 `tests/` 有 `fanout-shardkey-collision-oracle`、`scheduler-shard-item-kind-stringify`、`workflow-validator-wrapper-fanout` 等覆盖正路与禁入；但无测试断言「shardSource item 含 `\n` 时的分裂行为」「item trim 后为空被丢弃」（FANW-D2 的两个静默面）｜影响：这是「任务 green 但消费错误输入」的最危险类（scheduler-audit 反复强调），却无回归网｜建议：补一条 RED/锁定测试明确当前 `\n`-split 语义（item 含换行 → N shard），让未来 FANW-X1 重构时翻红即见意图。

**[FANW-T2] design.md 与 i18n 的漂移无「源码层文本断言」兜底** — 级别 P3｜类型 test-gap｜证据 无测试守卫「design.md 不得再出现 `agent-multi`/`ShardingStrategy` 作为现行设计」或「孤儿 i18n key 不得存在」｜影响：漂移（FANW-D3/X5）会持续累积｜建议：仓规已推崇「源码层文本断言兜底」（如 `selectionOnDrag` 不得出现在 WorkflowCanvas）——可加一条 i18n 死键检测（key 定义但无 `t('...')` 引用）进 CI。

**[FANW-O1] fanout 派发缺结构化可观测：shard 数量/失败 shardKey 清单只进 log.info 与 failed message，无 per-shard 进度事件** — 级别 P3｜类型 observability｜证据 `scheduler.ts:3388-3393` 仅 `stateLog.info('wrapper-fanout done', {shards})`；失败 message 是 `shardKey:message` 拼串（`:3283`）｜影响：用户在 N=256 shard 跑到一半时，前端只能看到 wrapper 行的聚合状态 + 各 shard 子行的 broadcastNodeStatus，没有「3/256 失败」的结构化汇总；调试大扇出靠翻 message 串｜建议：fanout 进度作为结构化事件（已有 `broadcastNodeStatus` per shard child，可在 wrapper 行附 `{done, failed, total}` 元数据）。

## 7. 目标形态（Target architecture）

这个子系统理想该是「**一个调度引擎 + 一个 wrapper 接口 + 一个分片协议**」，而非现在的「三个 run 函数 + 散落的 `\n` 约定 + 两套分片器」：

1. **统一 wrapper 运行器**：`WrapperRunner` 接口（`mintOrResume / persistProgress / runInner / finalize / deriveOutlets`），git/loop/fanout 各实现差异点，共享 resume/mark-running/consumed-provenance/失败处理骨架（消除 FANW-D1 / R5 的逐项漂移）。三连 `kind` 判用 `WRAPPER_KINDS` 集合替代。
2. **per-shard 走 runScope**：fanout 的 perShard 派发委托给与 loop/git 同一个 `runScope`，shard 值作为子 scope 虚拟输入，node_run 执行坐标从「裸 iteration 标量」升级为「scope 路径」（外层轮次 + shardKey）。这一步同时解锁 per-shard 链（X2）、shard 内 review/clarify（C2）、以及真正的嵌套（X3），把现在「validator 禁入」的能力变成「实现支持」。
3. **分片协议单一事实源**：`shardingRegistry` 升级为 `{ encodeList, decodeList, keyOf, groupingOf }` 四元组按 item kind 注册，上游统一 `encodeList`、fanout 入口统一 `decodeList`，删 `\n` 隐式约定（X1）、删死的 `diffSplit.ts` 或把其 grouping 接进 `groupingOf`（X4）。
4. **schema 强类型贯穿**：消费侧用 `WrapperFanoutNode` 而非 `Record<string,unknown>`，schema 成为单一事实源（C1）。
5. **文档/i18n 与实现归一**：design.md §5.1/§6.3 改写为 RFC-060/098 现实或加权威指针；删孤儿 i18n（X5）；CI 加死键 + 文本守卫（T1/T2）。

在 (2) 落地前，「validator 禁入嵌套/链/非-agent inner」是**正确且应保留**的止血——但要在 design 与 UI 上诚实标注「v1 不支持嵌套/per-shard 链」，而不是让 design.md/i18n 继续宣传不存在的能力。

## 8. Top 风险与建议优先级（排序表）

| 优先级 | ID | 标题 | 级别 | 类型 | 一句话建议 |
|---|---|---|---|---|---|
| 1 | FANW-D2 | `list<T>` 按 `\n` split 的静默裂分/丢空 | P1 | design | 引入显式列表编码，收进 registry |
| 2 | FANW-X1 | 富 item shardSource 要重写三段式分片协议 | P1 | extensibility | registry 升级为编解码单一事实源 |
| 3 | FANW-X2 | per-shard 链/非-agent inner 被双墙锁死 | P1 | extensibility | per-shard 派发改走 runScope |
| 4 | FANW-X3 | 任意嵌套受单标量 iteration 制约 | P1 | extensibility | iteration 升级为 scope 路径栈 |
| 5 | FANW-D1 | 三类 wrapper 三套实现逐项漂移 | P2 | design/coupling | 抽 WrapperRunner 接口 + WRAPPER_KINDS |
| 6 | FANW-D3 | design.md §5.1/§6.3 漂移到已删的 agent-multi | P2 | design | 改写或加权威指针 |
| 7 | FANW-C2 | fanout 派发与单节点调度重复 ~80 行 | P2 | coupling/dedup | 抽 dispatchAgentNode 单一入口 |
| 8 | FANW-X4 | 旧 diffSplit.ts 死代码 vs 新 registry 并存 | P2 | extensibility | 定去留：删或接进 groupingOf |
| 9 | FANW-X6 | aggregator 隐式契约扩展难 | P2 | extensibility | 收进 FanoutTopology 对象 |
| 10 | FANW-C1 | 纯函数模块绕过 schema 用 Record 断言 | P2 | coupling | 用强类型节点 + narrowing helper |
| 11 | FANW-T1 | 换行裂分无回归测试 | P2 | test-gap | 补 RED/锁定测试 |
| 12 | FANW-D5 | 笛卡尔守卫嵌套乘子死防御 + expectedShardCount 死字段 | P3 | design | 简化守卫 + 删字段或实现嵌套 |
| 13 | FANW-X5 | 孤儿 i18n 6 key | P3 | extensibility | 删除 |
| 14 | FANW-IMPL2 | shared inner 注释与代码不符 | P3 | impl-bug | 修注释 + 补 validator 规则 |
| 15 | FANW-IMPL1 | design §6.4 exhausted/task 两级混写 | P3 | impl-bug/design | 文字对齐 RFC-097 |
| 16 | FANW-IMPL3 | scope BFS O(V·E) / aggregator O(N²) | P3 | perf | 入口建索引传纯函数 |
| 17 | FANW-O1 | fanout 缺结构化进度可观测 | P3 | observability | wrapper 行附 {done,failed,total} |
| 18 | FANW-T2 | 漂移无文本断言兜底 | P3 | test-gap | CI 加死键 + 文本守卫 |

> 与既有审计的关系：S-3/S-4/S-7/S-19/S-20/S-21/S-28 已被 RFC-098 B3 覆盖修复；S-5/S-6 已被 RFC-094 改为 validator 禁入（**本报告 FANW-X2/X3 揭示其架构根因——禁入只是止血，真正解法是 per-shard 走 runScope + iteration 升级为路径**）；FANW-D4/D5 与 S-18/§6.3 重叠（已覆盖，本报告补足「为什么这制约产品定位」）。本报告新增的架构/扩展性洞察集中在 FANW-D1/D2/D3 + FANW-X1~X6 + FANW-C1/C2。
