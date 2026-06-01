# RFC-074 Plan — Provenance-Based Node Freshness

> 状态：**Done（2026-06-01）** —— PR-A + PR-B + PR-C 全部落地。
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
>
> **PR-C 实施记录（2026-06-01，一体内聚单 commit）**：`isFresherNodeRun` 改纯 ULID id 排序；删 cci-bump
> max+1（triggerDesignerRerun / mintQuestionerRerun / 自-clarify rerun）；scheduler 的 clarify 代际从
> 派生而来（`priorDoneGenerationsForRun` = 同 (node,iteration,shardKey) 的 prior-done top-level 行按 id<current
> 计数），`readPriorAgentSessionId` 改 id-order 取 prior 代；`clarifyRounds.buildPromptContext` 去 cci-scoping
> 三 consumerKind 统一靠 RFC-070 consumed-by 戳；D11 身份键 id 化（`memoryInject` 代际锚=最大 id≤current 的
> retry=0 行 / `lifecycleRepair` T2·S3 / `sessionView` prompt 排序 / 前端 `injected-memories-card`
> `findFirstAttemptSibling`）；`lifecycleInvariants` U1 去 cci 维度 + CR-1 迁 RFC-070 `consumed_by_consumer_run_id`
> 戳（D8）；shared `NodeRunSchema` 删 cci 字段；前端「第 N 轮」改 `clarifyRoundForRun` row 序号派生；migration
> 0041 12-step rebuild DROP `node_runs.clarify_iteration`（journal→41）；物理删 4 个死函数
> （`applyClarifyFreshnessInvariant` / `cascadeDownstreamFromDesigner` / `loadDefinitionForTask` /
> `isReviewClarifyAlignedWithUpstream`）。C 组 `rfc074-prc-cci-retirement.test.ts`（C1-C12：id 排序 / DROP 列 /
> grep 守门——src+shared+frontend 0 个 LIVE cci 用法 + 3 死函数 0 命中）。事故 `01KSHVXCH6` 回放重写为
> provenance（`isNodeRunFresh`）口径。**门禁**：typecheck（3 包）+ format 全绿；后端零非-env 失败
> （仅 daemon/ws/cli/mcp 环境前置失败，pristine main 同样红）；前端 2230 全绿。**测试基线等价口径**：所有
> 旧的「靠 ulid() 调用序」或「手 seed 非因果 id」的 freshness 测试改因果 id / monotonicFactory（生产侧 rerun
> 总在更晚 ms 由用户动作触发→id 单调，仅同步测试 seeding 需此处置）。
>
> **Post-merge 正确性审查 + 补强（2026-06-01，CI 全绿 tip `f5f6f11`）**：PR-A/B/C 落地后全量复审
> （多-agent + 逐行 hand-verify + 实跑），核心 freshness 正确、零调度 bug。修 1 个真实展示层回归 +
> 补齐验收清单缺测：**F2**（commit `9693b82`）designer cross-clarify rerun 在 `retry=max+1` mint（**故意**：
> 保 scheduler `isClarifyRerun=clarifyGeneration>0&&retryIndex===0` 自-clarify inline 门为假，cross-clarify
> 走 retry-无关的 `isCrossClarifyTriggeredRerun`），但三个代际消费者（`memoryInject.loadInjectedSnapshotFromFirstAttempt`
> / 前端 `clarifyRoundForRun` / `findFirstAttemptSibling`）按 `retryIndex===0` 过滤代际锚 → 漏 designer 代、
> 「第 N 轮」少计 + 注入快照取错代（纯展示，违 AC PR-C「§6.5 UI 与迁移前一致」）。修：三者统一改 **retry-无关的
> prior-`done` 边界口径**（镜像 `priorDoneGenerationsForRun`——代际起于首行或前一 top-level 行 `done` 之后；
> retry 只跟在 `failed` 后＝同代，`scheduler.ts:498` `decideEnvelopeFollowup` 实证），订正 5 个「retry 跟 done」
> 不真实 fixture；**F3**（`9693b82`）§4.3/D9 多跳 staged-demote 集成测试 `S-RFC074`（in→A→B→C 全-agent、
> 逐 batch demote[B]→demote[C]，断言 consumed 指向 fresh 上游——RFC #1 风险此前无专测）；**F4/F5**（`9693b82`）
> memoryInject 多代际 + 前端「第 N 轮」designer/US-2 parity 单测（T-C4a）；**F7/F8**（`ee06769`）§8/D3 wrapper-
> provenance-atomic 锁（`freshness.test.ts` B5 + 源码锁）+ migration-0041 含行数据拷贝逐列 round-trip + 索引/FK
> 存活锁；**F9**（`2ecca40`）lifecycleRepair T2 id-代际选择 C 组锁（T-C4b）+ harness `id` 槽。门禁：typecheck（3
> 包）+ lint + format 绿；前端 2233（vitest 4.1.8）；RFC-074 后端生态 120 pass/1 skip/0 fail；CI 全绿。**deferred
> （非阻塞）**：demote safety-cap（终止性结构性保证、过紧 cap 反伤深链）/ S3·sessionView 多代际锁（低值）/ 过时
> cci-first 注释（纯文案）。**至此 RFC-074 真正完工**（原 PR-C 标 Done 偏早，本次补强后名副其实）。

## 1. PR 拆分（3 PR 强序，决策 D7）

- **PR-A**：baseline 锁定，零生产改动。CI 全绿 + 用户验收 → 启 PR-B。
- **PR-B**：provenance + 删两层 cascade + 修 bug + review refresh。cci 列暂留只做排序。**真正的 bug fix 在此落地，独立可发**。上线稳定 → 启 PR-C。
- **PR-C**：cci 彻底退役（id 排序 + 删 bump 机械 + DROP 列 + 24 文件清理 + UI 派生 + lifecycleInvariants U1 迁 consumed-by 戳）。**可缓**。

不引入 feature flag（与 RFC-064 / RFC-070 同模式）。

## 2. 任务分解

### PR-A：baseline 加固

| ID | 说明 | 范围 |
|---|---|---|
| **T-A1** | 新建 `isfresher-noderun-baseline.test.ts`：A1-A6 锁 `isFresherNodeRun` 现有 `(cci,retryIndex,id)` 排序逐 case（为 PR-C 切 id 排序做等价基线） | backend/tests |
| **T-A1b** | **新建 `resolve-upstream-inputs-picker-baseline.test.ts`（D10）**：锁 `resolveUpstreamInputs` 现有 `(iteration,retryIndex)` 选行结果，含"多代 done 行并存时选哪行"——为 PR-B picker 统一做翻转审计基线（含已知潜伏 bug 行为，PR-B 改期望时逐条标注是"修正" | backend/tests |
| **T-A2** | 扩 `scheduler-cross-clarify-freshness-invariant.test.ts` + cross-clarify cascade 套件：A7-A12 锁 Layer A/B 可观察结果（上游 rerun→下游重跑 / **多跳纯-agent 链 mid-loop 逐层传播** / 幂等）——这组是 §4.3 critical 的等价基线 | backend/tests |
| **T-A3** | 扩 review iterate/reject/approve 套件：A13-A17 + 再评合同 | backend/tests |
| **T-A4** | 新建 `provenance-incident-replay.test.ts`：A18-A20 事故 task `01KSHVXCH6RQ5F5P64MZ4FZVN6` 快照回放 | backend/tests |
| **T-A4b** | **已落地（探索期产出，未 commit）**：`clarify-review-combination-scenarios.test.ts`（17 场景）+ `fixtures/scenario-opencode.ts`（plan 驱动 stub）。当前 12 PASS（回归锁）+ 5 skip（4 RED bug：S8/S3/S6/S12 + S19 fanout defer）。PR-A 纳入：保留 12 个 PASS 作为回归锁随套件跑绿；4 个 RED 维持 skip（PR-B un-skip）。typecheck/test/format 已全绿 | backend/tests |
| **T-A5** | push 后查 GH Actions CI 全绿（[feedback_post_commit_ci_check]）+ 用户验收 | — |

### PR-B：provenance + bug fix

| ID | 说明 | 文件 |
|---|---|---|
| **T-B1** | migration：`node_runs` 加 `consumed_upstream_runs_json`（历史行 NULL）；docVersions.decision 加 'superseded'；journal +1；drizzle schema 同步 | backend/db |
| **T-B2** | 新增 `isNodeRunFresh(run, freshestDonePerUpstream)` 纯函数 + `parseConsumedJson` | backend/src/services/scheduler.ts（或 freshness.ts） |
| **T-B3** | `resolveUpstreamInputs` 返回 `{inputs, consumed}`；dispatch 时落 consumed 到新 node_run；picker 与 freshestDone 统一（AC-7） | backend/src/services/scheduler.ts |
| **T-B4** | review dispatch 记 `consumed={sourceNodeId: sourceRun.id}` | backend/src/services/review.ts |
| **T-B5** | `runScope` 入口 completed 收紧为「latest done AND isNodeRunFresh」；删 `applyClarifyFreshnessInvariant` 入口调用 | backend/src/services/scheduler.ts |
| **T-B6** | **⚠️ §4.3 critical / D9：每-batch fixed-point freshness 重算（替代 Layer A 预 mint 的职责）**。新增 demote 能力：每 batch 后 + ready-empty 分支重读 DB、重建 latestPerNode+freshestDonePerUpstream（含 iteration 作用域 §3.2）、对 completed 节点重算 isNodeRunFresh、stale→remaining（不 mint）、有变化则 while-loop 再跑一轮；safety cap=scope 节点数。**这是本 RFC 最易写漏点**，独立任务、独立强测 | backend/src/services/scheduler.ts |
| **T-B6b** | freshestDone 的 iteration 作用域实现（key=`(upstreamNodeId, consumed 行 iteration)`，loop-wrapper + 跨边界输入正确）（§3.2） | backend/src/services/scheduler.ts |
| **T-B7** | 删 `applyClarifyFreshnessInvariant` 函数 | backend/src/services/scheduler.ts |
| **T-B8** | 删 `cascadeDownstreamFromDesigner` + `triggerDesignerRerun` 内调用 | backend/src/services/crossClarify.ts |
| **T-B9** | 删 `isReviewClarifyAlignedWithUpstream` + `dispatchReviewNode` alignment 短路 | backend/src/services/review.ts |
| **T-B10** | review awaiting 上游变 → 事务化 mint v(n+1) + v(n) superseded + 作废 v(n) review_comments + broadcast | backend/src/services/review.ts |
| **T-B11** | 前端 review supersede banner +「旧版批注已失效」提示 + 自动切 v(n+1) | frontend/src/components |
| **T-B12** | i18n（zh+en） | frontend/src/i18n |
| **T-B13** | B 组 ≥ 18 case（§11.2）：isNodeRunFresh 单元 / consumed 记录 / completed+**每-batch fixed-point 重算** / 多跳纯-agent 链 mid-loop 逐层 demote（B8-B10，§4.3）/ 事故修复 / review refresh / crash recovery / null=fresh / **B17 clarify-only-no-output 上游** / **B18 review resume 幂等（删短路后）** | backend/tests |
| **T-B13b** | **un-skip 组合场景的 4 个 RED 作为 fix-verification**（`clarify-review-combination-scenarios.test.ts`）：S8（`A(问)→B→检视`，头号触发器）/ S3（iterate+clarify 原始事故）/ S6（reject+clarify）/ S12（diamond 静默重跑）去掉 `test.skip` → 必须转绿；12 个 PASS 回归锁保持绿（AC-12） | backend/tests |
| **T-B14** | 前端 review banner 渲染测试 | frontend/tests |
| **T-B15** | 3-trio gate + Playwright e2e + GH Actions CI 全绿 | — |

> **实施记录（2026-06-01）**：PR-B 后端落地完成。两处偏离本表的低风险决策（皆为减小 churn + 遵 D7"bug fix 独立于 cci 退役"）：
> 1. **T-B7/T-B9 + cascade 函数只删调用、函数留死代码到 PR-C**：`applyClarifyFreshnessInvariant` / `isReviewClarifyAlignedWithUpstream` / `cascadeDownstreamFromDesigner` / `loadDefinitionForTask` 的*调用*已删（即行为变更），但函数本体导出保留（避免 lint 未用报错 + 保住 PR-A baseline 与他人 RFC-056 测试），随 PR-C 的 grep-guard（C11）一起物理删。
> 2. **T-B11/T-B12/T-B14（前端 supersede banner + i18n + banner 渲染测试）延后到小后续 PR**：review 刷新后自动切 v(n+1) 已由既有 `useTaskSync` query invalidation 工作；banner 仅是 §7 awaiting-refresh 边界场景"旧批注已失效"的 UX 解释，不影响正确性。后端 supersede 数据（`decision='superseded'` + `decisionReason='upstream-refreshed'`）已就绪，banner 随时可在其上构建。

### PR-C：cci 退役

| ID | 说明 | 文件 |
|---|---|---|
| **T-C1** | `isFresherNodeRun` 改 id 排序（或 (retryIndex,id)）；与 PR-A baseline 等价验证 | backend/src/services/scheduler.ts |
| **T-C2** | 删 cci-bump max+1 机械（triggerDesignerRerun / mintQuestionerRerun / clarify rerun） | backend/src/services/crossClarify.ts、clarify.ts |
| **T-C3** | lifecycleInvariants U1 dedup key 去 cci + designer-run 检查迁 RFC-070 consumed-by 戳（D8） | backend/src/services/lifecycleInvariants.ts |
| **T-C4a** | **⚠️ D11 身份键替换（非 grep-删，逐项单测，§6.4.1）**：`memoryInject.ts` 代际身份从 `(...,cci,retry=0)` 七元组改 id-based（同代最早 retry=0 行 / generation 锚点）——**memoryInject 必须单测代际取对** | backend/src/services/memoryInject.ts |
| **T-C4b** | D11 身份键替换：lifecycleRepair T2（cci 分组选最新代→id）/ S3（dedup key→id）/ U1（去 cci 维度）；sessionView prompt 历史排序 `(cci,retryIndex)`→`(retryIndex,id)` 须与迁移前顺序一致 | backend/src/services/lifecycleRepair/*、sessionView.ts |
| **T-C4c** | 其余纯读写/注释去 cci（runner、clarifyRounds、lifecycle、task mapper、workflow.validator 注释、lifecycleRepair helpers/types） | backend/src |
| **T-C5** | shared `NodeRunSchema` 删 cci 字段；ws / clarify schema 清理 | shared/src/schemas |
| **T-C6** | 前端 5 文件「第 N 轮」改 row 序号派生（NodeDetailDrawer / SessionTab / node-history / injected-memories-card / rfc026-events） | frontend/src |
| **T-C7** | migration 12-step rebuild DROP `node_runs.clarify_iteration`；journal +1 | backend/db |
| **T-C8** | C 组 ≥ 12 case（§11.3）：id 排序等价 / U1 守恒 / UI 派生显示一致 / DROP 列序列化 / grep guard | backend+frontend/tests |
| **T-C9** | 3-trio gate + Playwright e2e + GH Actions CI 全绿 | — |

## 3. 任务依赖

```
PR-A：T-A1..T-A4 并行 → T-A5（最后）
PR-B 前置：T-A5 用户验收
PR-B 内部：
  T-B1（migration）→ T-B2/T-B3/T-B4（记录+判定）→ T-B5/T-B6（scheduler 集成）
  T-B7/T-B8/T-B9（三处删除）依赖 T-B5 完成
  T-B10 → T-B11 → T-B12（review refresh 前后端）
  T-B13/T-B14 测试与实现并行；T-B15 gate 最后
PR-C 前置：PR-B 上线稳定
PR-C 内部：
  T-C1 依赖 PR-A baseline；T-C2 依赖 T-C1
  T-C3 依赖 RFC-070 consumed-by 戳就绪（已 Done）
  T-C4/T-C5/T-C6 去 cci（C5 shared 改后 C6 前端类型同步）
  T-C7（DROP 列）必须在 C1-C6 全部不再读 cci 后
  T-C8/T-C9 最后
```

## 4. 验收清单

PR-A 合并：
- [ ] A 组 ≥ 20 case 全绿（含事故快照）
- [ ] 现有套件零退化；3-trio + e2e + CI 全绿
- [ ] 用户确认行为零退化 → 启 PR-B

PR-B 合并：
- [ ] B 组 ≥ 18 case 全绿（含 §4.3 多跳 agent 链 mid-loop demote + B17 clarify-only + B18 review resume 幂等）
- [ ] AC-1~AC-7 + AC-9 + AC-10 逐条人工验证
- [ ] 事故 task 回放：approve 后无 spurious 评审
- [ ] 3-trio + e2e + CI 全绿
- [ ] STATE.md「进行中 RFC」更新；plan.md 索引保持 Draft（PR-C 未完）

PR-C 合并：
- [ ] C 组 ≥ 12 case 全绿；AC-8 + AC-11 验证
- [ ] grep guard：cci 三 package 0 命中；三个删除函数 0 命中
- [ ] UI「第 N 轮」显示与迁移前一致
- [ ] 3-trio + e2e + CI 全绿
- [ ] STATE.md「进行中」→「已完工」；plan.md 索引 Draft → Done

## 5. 估算

| 阶段 | 工作日 |
|---|---|
| PR-A baseline | 2-3 |
| PR-B provenance + bug fix + review refresh | 4-6 |
| PR-C cci 退役（24 文件 × 3 package） | 4-6 |
| **总计** | **10-15** |

PR-B 单独即修复用户事故，可优先交付；PR-C 是结构性清理，可在 PR-B 稳定后排期。

## 6. 风险点与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| **删 Layer A 后多跳 agent 链 mid-loop 传播漏拉齐**（§4.3/D9，本 RFC 最易写漏点：每-batch fixed-point 重算替代的是 Layer A 预 mint，不只是 Layer B） | 🔴 | T-B6 独立任务实现 demote 重算；A2 baseline 锁多跳传播可观察结果；B8-B10 必须含 A→B→C 全 agent、A 重跑→B/C 逐 batch demote 的强测；漏则 silent 错（下游基于 stale 上游跑完） |
| `resolveUpstreamInputs` picker 统一是行为变更（修 `(iteration,retryIndex)` 选错旧行潜伏 bug，§5.1/D10） | 🟠 | T-A1b baseline 锁现有选行；PR-B 统一后逐条审计翻转断言、每个标注"修正 vs 回归" |
| memoryInject/lifecycleRepair/sessionView 的 cci 是身份/分组/排序键非显示（§6.4.1/D11） | 🟠 | T-C4a/b 用 id 做代际身份替换、逐项单测；memoryInject 代际取对必须单测 |
| 纯 id 排序未必总选对最新行（Phase 2 核心） | 🟠 | T-A1 baseline 逐 case 锁 `isFresherNodeRun`；T-C1 切 id 后全绿才算等价；不确定保留 `(retryIndex,id)` 双层 |
| loop-wrapper iteration 作用域错配（freshestDone 拿错代） | 🟡 | T-B6b 按 `(nodeId, consumed 行 iteration)` 取 freshestDone；B 组含 loop 内 + 跨边界输入 case |
| Phase 1→2 freshestDone 选行漂移 | 🟡 | proposal §4.2 论证 cci-order 与 id-order 选同一行；T-C1 显式对拍 |
| review refresh 事务边界 | 🟡 | T-B10 三步包同一事务；B14-B15 断回滚一致 |
| legacy in-flight task null=fresh 漏一个本应 stale 节点（AC-10 边界） | 🟢 | 有意偏向"不乱重评"；重新 launch 修复；新 task 不受影响 |
| 全删 cci 波及 24 文件 | 🟢 | 3 PR 强序，PR-C 独立可缓；grep guard 锁 0 残留 |
| lifecycleInvariants U1 迁戳依赖 RFC-070 | 🟢 | RFC-070 已 Done，consumed-by 戳就绪；T-C3 直接复用 |
| 多人并发树冲突 | 🟢 | 改动集中 scheduler/crossClarify/review/clarify + provenance 新列，遵循 CLAUDE.md 并发改动保留原则，按路径精确 git add |
