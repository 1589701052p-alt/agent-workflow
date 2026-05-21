# RFC-053 — node_run 生命周期硬化：状态机 + kind handler + 双层 invariant + stuck 探测（产品视角）

## 背景

[RFC-052](../RFC-052-review-retry-cascade-stuck/proposal.md) 修了一个 task
卡死的具体 bug，但事后分析（见 RFC-052 design.md "根因分解" + 后续讨论
"为什么会引发这个问题"）暴露了一个更深的结构问题：

> 同一份概念状态（"这条 review 现在处于哪一阶段"）**被多份数据各表征
> 一部分**，而**多个模块各自带着一套不一致的隐式假设去读写它**。其中
> 任何一个假设被边缘路径打破，链条就在最弱的那一环开裂。

具体地，当前架构有 6 个"风险源"：

1. **`node_runs.status` 是一个没有状态机的可变字段**——7-8 处代码可以
   `db.update(...).set({ status: '...' })`，**没有任何**地方校验转移
   是否合法。`done → awaiting_review` 这种逻辑非法转移没人拦。
2. **同一 nodeId 多行 + 各模块用不同挑选器**——scheduler 用
   `isFresherNodeRun`、dispatchReviewNode 用 `Array.find`、retryNode 用
   `desc(retryIndex).limit(1)`；同一张表得出不同的"哪一行是当前态"。
3. **跨 kind 的"普适操作"硬编码、不走 handler 表**——retryNode 的
   cascade 把所有下游一视同仁，不知道 review/clarify/output/input 是
   非进程节点。enforceLimits / orphans / gc / shutdown 同款。
4. **review 有"双层状态"：node_runs + doc_versions**——两层各自被写，
   没 invariant 保证它们一致；clarify 也是同款双层（node_runs +
   clarify_sessions）。
5. **关键路径靠 fire-and-forget**——`void resumeTask(...).catch(() => {})`
   一旦后台拉链摔了，前端不知道、metrics 不喊、用户主观感觉"卡了"。
6. **没有"跨模块一致性"层面的测试**——单测都是"沿着已知路径走"，缺
   "无论你按啥顺序触发 approve/iterate/reject/retry/cancel，下面这些
   invariant 是否始终成立"的 property-based 测试。

RFC-052 修的是 instance；本 RFC 修的是产生 instance 的**温床**。

## 目标

把上面 6 类风险源全部消解到"结构上不可能再犯"：

- **G1：node_runs.status 转移函数化（P-1）**——所有写者强制走单一
  `transitionNodeRunStatus()` helper；非法转移在 service 层抛
  `IllegalNodeRunTransition`，永远到不了 DB。
- **G2：跨 kind 普适操作走 handler 表（P-2）**——每个 NodeKind 必须
  显式声明 `onRetryCascade / onEnforceLimits / onOrphanReap / onGc /
  onShutdown` 等的行为；TypeScript exhaustiveness 在编译期强制新 kind
  必填。
- **G3：双层 invariant 启动扫 + 周期扫（P-3）**——doc_versions ↔
  node_runs、clarify_sessions ↔ node_runs 两条一致性红线在 daemon 启动
  时全量扫一遍 + 每小时增量扫；任何不一致 log ERROR + 标记 task 让
  用户感知。
- **G4：stuck-task detector（P-6）**——任何 task 状态 > N 分钟无新事件
  且 (a) task.status='awaiting_review' 但没 pending doc_version /
  (b) task.status='awaiting_human' 但 clarify_session.status='closed' /
  (c) task.status='running' 但所有 node_run 已落终态——daemon 主动
  发现，WS 推到前端，UI 标红章 + 提供"查看诊断"。
- **G5：测试 baseline 锁定（测试补强阶段）**——在重构前先把全 bug 区
  当前行为锁成可执行的 invariant；重构每个 PR 必须保持这条 baseline
  全绿才能合并。

## 非目标

- **不改 review 业务语义**——iterate / approve / reject 决策路径产品
  行为不变，只是底层写状态走 helper。
- **不做事件源化（P-5）**——node_runs 仍是可变行 + status 列；不引入
  独立的 node_run_events 当唯一真实源。事件源化是更深的重构，本 RFC
  不做。
- **不引入新依赖**（XState / 类似状态机库）——helper 是手写的，约 50
  行，TypeScript exhaustiveness 配合 union 类型即可表达全部转移。引入
  库带来的 bundle size / 学习成本不值得。
- **不改 doc_versions / clarify_sessions schema**——双层 invariant 是
  读侧检查，不动两层数据各自的写法。
- **不改 wrapper-loop / wrapper-git 的语义**——它们目前的状态机本来
  就比较自包含（progress_json 推进），只是顺手统一一下写 status 的
  路径。

## 用户故事

- **设计师**对 review 文档点 approve 后立刻看到任务进入下游 / done。
  不再有"approve 后冒出 v(n+1)" / "approve 两次还在等"这类回弹。
- **运维**接到用户反馈"任务卡了"时，能在 daemon log 里直接看到
  `ERROR review-consistency-violation task=01K... doc_version=approved
  node_run=awaiting_review`，不必去 DB 里手查关系。
- **运维**打开任务详情，看到顶部红章"⚠ task 30 min 无进展，可能卡死，
  点击查看诊断"——而不是等用户来投诉。
- **未来添加新 NodeKind 的开发者**，加 kind 时编译器直接报错"你没在
  KindHandler 表里填这个 kind 的行为"——不会忘了某条 cross-cutting
  路径。
- **未来添加新 status 写者的开发者**写 `db.update(nodeRuns).set({ status:
  ... })` 时 lint 报错（自定义规则）："必须走 transitionNodeRunStatus"。
  非法转移在单测里立刻爆。

## 验收标准

1. **全 bug 区测试 baseline 锁定** —— 在重构前合并 PR-A，新增
   50-80 case 覆盖：
   - 完整 (status, event) → newStatus 转移矩阵（每个合法 + 每个非法都
     有一条 case）；
   - 多行 dispatch 一致性（placeholder / clarify rerun / iterate /
     retry cascade 各种组合）；
   - 双层 invariant 守护（doc_versions × node_runs；clarify_sessions ×
     node_runs）；
   - retry cascade 全 kind 矩阵（每个 NodeKind 都有一条测试）；
   - resume 幂等性 + 并发 approve + resume race；
   - loop / fan-out / wrapper 嵌套交叉路径。
2. **P-1 落地** —— `transitionNodeRunStatus()` helper 上线，所有写
   `nodeRuns.status` 的位置（grep 守卫为 0 直接 update）改成走它；
   合法转移表覆盖全部 8 种 status；新单测锁住 `done` / `canceled` /
   `failed` / `interrupted` 是终态。
3. **P-2 落地** —— 新 `shared/src/node-kind-behavior.ts` 导出
   `NODE_KIND_BEHAVIORS` 表；retryNode / enforceLimits / orphans / gc /
   shutdown 全部改用查表；新增 NodeKind 时编译器报错（exhaustiveness）。
4. **P-3 落地** —— `services/lifecycleInvariants.ts` 启动时扫一遍 +
   每小时扫一次；命中不一致 log ERROR + 写一行到新表 `lifecycle_alerts`
   供 UI 拉。
5. **P-6 落地** —— `services/stuckTaskDetector.ts` 每 5 分钟跑一次；
   找到候选 task 发 WS 事件 + 写 `lifecycle_alerts`。前端在 task 详情
   顶部加红章 + 诊断弹窗。
6. **PR-A 全绿** —— typecheck + lint + format:check + 测试 1764+50+ pass
   / 0 new fail；CI 六 jobs 全绿。
7. **PR-B/C/D/E 全绿** —— 每个 PR 单独可合，依赖关系明确（B 依赖 A、
   C/D/E 依赖 B），最终五个 PR 合完后整套 GitHub Actions 全绿且不引入
   新 flake。
