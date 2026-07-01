# RFC-131 技术设计：任务级问题队列 + agent 产出后统一老化

> 配套 `proposal.md`。本文是权威技术设计，待 Codex 设计 gate + 用户批准。

## 0. 术语

- **origin**（产出源）：问题的原提问/产出节点。`task_questions.origin_node_run_id` 指向提问轮的 intermediary run；决定**产出归属 + 下游接线**（谁的输出端口、走谁的下游）。
- **target**（执行者）：实际承接、跑这个问题的 agent 节点。= `default_target_node_id ?? override_target_node_id`。**改派 = 改 `override_target_node_id`**。
- **队列**：任务级 `task_questions` 表，按 `target` 分组投影 = 「每个 target 节点的问题队列」。无新表。
- **老化（consume）**：一个 target 节点**正常输出走完（最新 top-level run `done` + 写了 output port）**后，它队列里所有已答（`sealed_at` 非空）问题「老化」——不再注入后续 rerun（产出已定型，下游用产物）。

## 1. 数据模型（复用现有，最小改动）

复用 `task_questions`（RFC-120/128 已有列）：

| 列 | 语义（RFC-131） |
|----|----------------|
| `origin_node_run_id` | origin（产出归属 + 下游） |
| `default_target_node_id` / `override_target_node_id` | target（执行者）；改派改 override |
| `sealed_at` | 已答（进入 target 队列的可注入集） |
| `dispatched_at` | 已下发（可被 mint rerun） |
| `role_kind` | self / questioner / designer / manual |
| `iteration` / `loop_iter` | 队列的 (target, iteration) 分组键 |

**老化不落新列（派生式，见 §2）**。`clarify_rounds` 的 `consumed_by_*_run_id` 保留供 non-deferred 旧路径 + 读侧兼容，新路径不依赖它。

> 备选（戳式）：新增 `clarify_rounds.consumed_by_target_run_id`，runner `done+output` 时标。放弃理由见 §2。

## 2. 消费判据统一（核心）——派生式老化

**新纯函数**（取代 `isQueueEntryRenderableForRun` window + `isDispatchedEntryConsumed` mode + `consumed_by_*` 戳）：

```ts
/** 一个 target 队列里、承接 rerun 为 sinceRunId（问题 trigger_run_id）的问题是否「已被产出老化」。
 *  = 该 (target, iteration) 有一个 top-level run 处于 done + 捕获 ≥1 <workflow-output>，且其 id ≥
 *  sinceRunId（ULID 单调 → 承接 rerun 本身或其后产出）。sinceRunId===null（未绑）→ false（首次注入）。 */
function isTargetNodeConsumed(
  targetNodeId: string,
  iteration: number,
  sinceRunId: string | null,
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
): boolean {
  if (sinceRunId === null) return false
  return runs.some(
    (r) =>
      r.nodeId === targetNodeId &&
      r.iteration === iteration &&
      r.parentNodeRunId === null &&
      r.status === 'done' &&
      outputRunIds.has(r.id) &&
      r.id >= sinceRunId,
  )
}
```

**时序锚 `sinceRunId`（实现中细化，design 初稿漏了 round N+1 陷阱）**：笼统「target 有过 done+output」会**误伤 round N+1**——一个 node 产出后可再开新一轮反问，那批新问题的承接 rerun id 大于上次产出 run id，绝不能被上次产出老化。锚用问题注入时绑定的**承接 rerun（`trigger_run_id`）+ ULID id 序**（`r.id >= sinceRunId`），而非 `startedAt` 时间锚（rerun mint 时 startedAt=null、runner spawn 才 set，脆弱）。多轮天然累积：round 1 的承接 rerun done-无-output 时不老化，随 round 2 一起注入（**去掉 renderableForRun 的 window 上界**——那个「下一 clarify rerun」上界正是多轮丢历史根因）。

**三态规则（本 RFC 的关键正确性）**：

| target 最新 top-level run | 老化？ | 后果 |
|---------------------------|-------|------|
| `done` + output（正常产出） | ✅ 老化 | 队列已答问题定型、不再注入 |
| `done` **无** output（问了下一轮反问） | ❌ 不老化 | 答案留队列、下一次 rerun **继续注入**（修 round 1 丢失 + 天然避免死锁） |
| `failed` / `canceled` / `interrupted` | ❌ 不老化 | revivable（retry/resume 重跑）、不放行、不误消费 |
| `pending` / `running` / `awaiting_*` | ❌ 不老化 | 在飞 |
| `done`+output 但 `id < sinceRunId`（round N+1 前的旧产出） | ❌ 不老化 | 新一轮问题由它自己的承接 rerun 产出老化，不被上一轮旧产出误老化 |

**为什么派生（而非戳）**：
- **单一事实源**：老化状态从 run 状态直接派生，不需要 runner 显式标一列、也不会因崩溃漏标而不一致（RFC-098 崩溃 replay 天然一致）。
- **零 migration**：不加列，升级窗口的在飞任务直接按现有 run 状态派生老化，历史问答不丢。
- **幂等**：读多少次都一样，无写副作用。

**review 打回重做**（用户拍板「消费掉」）：target 第一次 `done+output`（产出）即老化；review reject → 重做是新 run，但队列问题已老化 → **不重注入**；重做靠 RFC-119 prior-output 块带上次产物。这与派生自洽（老化只看「有没有出现过 done+output」，出现过就永久老化）。

## 3. 注入统一

**新 `buildClarifyQueueContext`**（收编 `buildClarifyNodeQueueContext` + `buildPromptContext` 的 per-question 半）：

- 取 target 节点队列里 **所有 `sealed` 且 target 未老化**（`!isTargetNodeConsumed`）的问题；
- **跨轮累积**、按 `clarify_rounds.iteration` 顺序渲染；
- 历史轮（非本次 dispatch）**read-only**（全量问答、无 sibling scope、无 directive）；当前轮（本次 dispatch 的 partial 子集）保留 RFC-128 P5-BC 的 sibling scope 块；
- **零 attribution**（RFC-099，源自 `clarify_rounds`）。

**golden-lock**：non-deferred / 单轮全量下发 → 与旧 `buildPromptContext` **逐字不变**（历史轮为空时退化为单轮渲染）。

## 4. 改派后的下游接线（RFC-127 收编）——设计决策 D3

**保留 RFC-127 借壳的产出语义**，只把消费账本简化：

- **run.node_id = origin**（产出归属 + 下游拓扑不变）；
- **agent = target 的 agent**（借壳执行者的脑子 body/model/runtime；`buildBorrowedAgent` 保留）；
- **下游 = origin 节点的输出端口**（改派只改「谁干活」，不改「工作流拓扑/谁的下游」）。

即「改派 = 改 target（执行者）」，但 **origin 决定下游**——designer 问题改派给 X 处理，产出仍走原 designer 的下游，不断链。

| role | origin | target（default） | 可改派？ |
|------|--------|-------------------|---------|
| self | 提问 agent 节点 | = origin | 否（自问自答） |
| questioner | questioner 节点 | = origin | 否 |
| designer | designer 节点 | = origin（可 override） | ✅ 改 override |
| manual | 手动问题 origin | 指定 target | ✅ |

**简化点**：RFC-127 的三账本（immediate / designer / deferred-self-questioner）借壳冲突判定，收敛为「同 (target, iteration) 一条在飞 rerun」的串行化（§7 in-flight）+ 派生老化。`resolveBorrowForNode` 仍用于把 target 的 agent 解析出来给 scheduler spawn（借壳 spawn 路径不变）。

## 5. non-deferred 双路径（保留）

- non-deferred（RFC-125 旧 quick-channel）：`submitClarifyAnswers` 立即 mint continuation + `buildPromptContext` 整轮注入 + `consumed_by_*` 戳消费——**字节级不变**（RFC-125 golden-lock）。
- deferred（新模型）：任务级队列 + 派生老化 + `buildClarifyQueueContext`。
- scheduler XOR 二选一（现状机制保留）：deferred + 有 dispatched 问题 → 新路径；否则 → 旧整轮路径。

## 6. 迁移策略

**派生方案 → 零 schema migration**：
- 不加列。升级后，新代码按现有 `task_questions`（origin/target/sealed/dispatched）+ run 状态派生老化。
- 升级窗口在飞任务：历史 round 的 target 若已 `done+output` → 派生为已老化（与旧 window 消费结果一致）；未产出 → 未老化、继续注入（比旧 window 更宽松、不丢历史轮，正是修复目标）。
- 无回填、无 dual-write（派生无持久态）。
- 回退安全：代码回退即回到旧 window/戳逻辑，DB 无残留。

## 7. 防护保留（不因简化放松）

1. **readiness gate**（`dispatchTaskQuestions`）：问题 `sealed_at` 非空才能下发（不变）。
2. **in-flight 串行化**：同 (target, iteration) 同时只一条在飞 rerun（防 double-mint）。**per-entry in-flight 语义**（`assertNoInFlightDispatch` / `openImmediateRounds` 与 `isDispatchedEntryConsumed` 的 `'in-flight'` mode）：一个 dispatched 条目的承接 handler run 处于非 `done`（`status !== 'done'`：pending/running）→ 在飞 → 拦新 dispatch；`done`（含 done-无-output）→ 已 terminate、不拦。**这里不用 `isTargetNodeConsumed`（老化）**——见 §7 末「语义分层勘误」。
3. **park**：未下发的 `sealed` 问题 → 钉住 origin 提问节点（frontier 不越过）；`partitionUndispatchedParkTargets` 用 **per-entry in-flight**：某 home 节点有 undispatched sealed 且**无**在飞 dispatched（其 handler run 非 `done`）→ park 等下发；有在飞 dispatched（handler pending/running）→ 不 park（否则 strand 已 mint 的 rerun）。**这里也不能用 `isTargetNodeConsumed`**：若按「target 未产出=在飞不 park」字面实现，一个 done-无-output（问下轮反问、已 terminal、节点 idle）的 target 会被判「未产出→不 park」→ frontier 越过该 idle 节点 → 它的 undispatched sealed 问题**永远没机会下发到新 rerun**（死锁）。handler `done`（含 done-无-output）→ 释放 park。
4. **question-write 锁**（`getTaskQuestionWriteSem`）：seal / dispatch / 老化读一致性保留。

**语义分层勘误（实现中确立，design 初稿的「gate/park 收敛为 isTargetNodeConsumed」措辞过度）**：反问流水有两套正交判据，**不可混用**——
- **注入判据**（哪些问题进 prompt）= `isTargetNodeConsumed`（target `done`+output 派生老化 + `trigger_run_id` id 序）。只用于 `buildClarifyNodeQueueContext` / `buildNodeQueueExternalFeedback`。
- **调度判据**（在飞串行 / mint-guard / frontier park）= per-entry in-flight（承接 handler run `status !== 'done'`）。用于 gate / park。
一个 done-无-output 的 clarify 中间态：注入判据「不老化、下轮继续注入」+ 调度判据「已 terminate、释放 gate/park 让下轮 dispatch」——**两者都要**，若统一到 `isTargetNodeConsumed` 则 park 会死锁。这正是前序 `1fb1646` 的 `LedgerOpenMode` 分层洞察，RFC-131 保留而非收敛掉它。

## 8. 失败模式

| 场景 | 现状风险 | RFC-131 处理 |
|------|---------|-------------|
| 同 target 上 self + designer 两 cause | double-mint | in-flight 串行（一条在飞）+ auto-split 分批 |
| `done`-无-output（问下轮）死锁 | 前序 1fb1646 修 | **天然避免**：done-无-output 不老化、下轮继续注入 + 可下发 |
| 改派后旧 target 队列残留 | 幽灵注入 | 改派改 override → 问题只进新 target 队列（按 target 投影，旧 target 不再取到） |
| review 重做重复注入 | 双来源冲突 | 已老化不重注 + prior-output（用户拍板消费掉） |
| park deadlock（sealed 未下发 + origin 死） | 永久 park | readiness gate + dispatcher 序列化 + 终态 CAS |

## 9. 测试策略（必写）

**纯函数**（首选可断言面）：
- `isTargetNodeConsumed`：无 run / pending / done-无-output / done+output / failed 各 case → 老化判定。
- `buildClarifyQueueContext`：多轮全历史注入 ✓ / done+output 老化后不注入 ✓ / done-无-output 不老化仍注入 ✓ / 历史 read-only 无 scope ✓ / 当前轮 sibling scope ✓ / 零 attribution ✓ / golden-lock non-deferred 逐字 ✓。

**集成**：
- 多轮 self-clarify e2e：round 1 + round 2 → 产出 prompt 含两轮（复现并锁死 `01KWDKBS` 那类 bug）。
- 改派：改 target → 问题进目标队列、下游归 origin。
- review reject → 重做不重注 + prior-output。
- 防护：readiness / in-flight 串行 / park。
- 迁移/派生：升级窗口在飞任务不丢历史轮。

**回归锁**：`rfc128-p5-bc`（golden-lock/partial/double-injection）、`rfc127-*-borrow`（借壳 spawn）、`clarify-rerun-ledger-deadlock`（前序死锁）——迁移到新判据后仍绿或按新语义更新。

## 10. 与前序改动的收敛

| 前序 | 处理 |
|------|------|
| 死锁 fix（`isDispatchedEntryConsumed` in-flight/revivable mode，`openImmediateRounds` mode，commit `1fb1646`） | **注入判据**换派生老化（`isTargetNodeConsumed` + trigger id 序）；**调度 mode 保留**——§7「语义分层勘误」：gate/park 的 in-flight/revivable mode 正交于「产出老化」（在飞串行 vs 该不该进 prompt），不收敛掉（若收敛 park 会死锁）。 |
| history 补丁（`9b1c30e` `buildClarifyNodeQueueContext` 补历史轮） | 被 `buildClarifyQueueContext` 统一取代（更彻底：覆盖纯重跑、不依赖「有新 dispatch」）。 |
| RFC-127 借壳三账本 | 收编为「target 队列 + in-flight 串行」；`buildBorrowedAgent` / spawn 路径保留（§4 D3）。 |

## 11. 接口契约

```ts
// 老化判据（纯、派生）
isTargetNodeConsumed(targetNodeId, iteration, runs, outputRunIds): boolean

// 队列注入（取代 buildClarifyNodeQueueContext + buildPromptContext per-question 半）
buildClarifyQueueContext(args: {
  db; definition; taskId; consumerKind; consumerNodeId; dispatchedRunId; targetIteration;
  sessionMode?; applyLatestDirective?; directiveOverride?; directiveOverrideAt?;
}): Promise<ClarifyPromptContext | undefined>

// in-flight 串行 / park 改按 target 派生（dispatchTaskQuestions / partitionUndispatchedParkTargets）
```

## 12. 关键 file:line 索引

```
task_questions / clarify_rounds            packages/backend/src/db/schema.ts
消费判据（改/弃）                            clarifyRounds.ts:844 isQueueEntryRenderableForRun → 弃
                                            clarifyRerunLedger.ts isDispatchedEntryConsumed → 收敛
注入（改）                                   clarifyRounds.ts:302/612 selectAnsweredRoundsForConsumer/buildClarifyNodeQueueContext
in-flight / readiness（改按 target）         taskQuestionDispatch.ts:510/820 assertNoInFlightDispatch
park（改按 target）                          taskQuestions.ts partitionUndispatchedParkTargets
老化触发（派生，读时算；无 runner 写点）      —（派生，无需 runner.ts 标）
借壳 spawn（保留）                            taskQuestionDispatch.ts resolveBorrowForNode + buildBorrowedAgent
```
