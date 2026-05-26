# RFC-070 Proposal — Clarify Q&A Aging by Consumed-By-Run（用消费戳替代 iteration 比大小）

> 状态：Draft（2026-05-26）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 基线 RFC：[RFC-023 agent-clarify](../RFC-023-agent-clarify/proposal.md)、[RFC-056 clarify-cross-agent](../RFC-056-clarify-cross-agent/proposal.md)、[RFC-058 clarify-sessions-unification](../RFC-058-clarify-sessions-unification/proposal.md)、[RFC-064 unified-clarify-runtime](../RFC-064-unified-clarify-runtime/proposal.md)

## 1. 背景

### 1.1 我们到底想表达什么

整套 clarify aging（"老化"）规则要回答的只是一个问题：

> **这条 Q&A，有没有被一次产生了正常 `<workflow-output>` 的 done 跑消化过？**

- 没有 → 下一次 rerun 的 prompt 必须继续带上它，否则 agent 就丢了上下文（自反问会重问、跨节点反问会让 designer 失去最新指示）。
- 已有 → 下一次 rerun 不再带它，让 prompt 短下来 + 防止 agent 反复被同一份已解决的回答锚定。

这是一个**关于 Q&A 行本身的状态问题**，按因果（"在它之前/之后"）就能判定。

### 1.2 现状是怎么实现的

代码库一直在用 **两个 iteration 计数器的数值比大小** 模拟上述因果：

```ts
// crossClarify.ts:1383（designer External Feedback）
if (args.historyCutoff !== undefined && latest.iteration < args.historyCutoff) continue

// clarifyRounds.ts applyAgingCutoff（self + cross-questioner 两路）
rows.filter((r) => r.iteration >= cutoff)
```

`cutoff` 来自 `computeHistoryCutoff` —— "我之前同 node 最新一次 done-with-outputs 的 `clarifyIteration`"。
`row.iteration` 来自 Q&A 行的 `iteration` 列。只有当两边数值同尺度同语义，比大小才等价于"在它之前/之后"。

### 1.3 问题：iteration 计数器根本没对齐

库里同时活着至少 4 个 iteration 计数器，递增节奏完全不同：

| 计数器 | 谁递增 | 节奏 |
|---|---|---|
| `node_runs.clarifyIteration`（RFC-064 统一） | 任意 clarify round（self **或** cross）都 +1 | designer 视角全局 |
| `cross_clarify_sessions.iteration` | 仅本 cross-clarify 节点的新一轮 | per-(crossNode, loopIter) 局部 |
| `clarify_rounds.iteration`（kind='cross'，镜像上面） | 同上 | 局部 |
| `clarify_sessions.iteration`（self，RFC-023） | 仅本 designer 的 self-clarify 新一轮 | per-designer 局部 |

RFC-064 §3.4 的设计承诺 "the unified field aligns with `clarify_rounds.iteration` for both kinds" ——
**对 `kind='cross'` 字面不成立**：cross-clarify 的 round iteration 是在它自己的 lane 里递增，不会包含 self-clarify 增量。
**一旦 designer 在两次 cross-clarify 之间又跑过若干 self-clarify**（real-world 场景），unified cutoff 就会超过 cross 本地最大值，整一波最新 cross Q&A 被一刀切掉。

### 1.4 真实事故

任务 `01KSHDCASXA5GDKN3KDZVXYYT0`（用户实测）：

- `agent_m7p3n1` cross_clarify_sessions 三轮：iter = 0 / 1 / 2（cross 本地计数）。
- designer 最近一次 done-with-outputs 的 `clarifyIteration = 5`（统一计数；中间有大量 self-clarify + retry）。
- `computeHistoryCutoff` 返回 **5**。
- 第 6 次 rerun（由 cross iter=2 触发，clarifyIteration=6）拼 prompt 时，`crossClarify.ts:1383` 跑
  `latest.iteration=2 < historyCutoff=5` → `continue`，刚答完的 cross Q&A（含 `designer_run_triggered_at` 指向这次 rerun）**整条丢弃**。
- Designer 看不到本轮跨节点反问的问题与答案，prompt 当作"无新反馈"重跑。

### 1.5 这不是第一次，而且也不会是最后一次

从 RFC-056 落地到 RFC-064 收口，aging 这块的 dated patch / fix 已经累计 8 次：

```
3a96ec9 fix(scheduler): drop prior clarify Q&A on downstream-triggered rerun once outputs were captured
4a06170 fix(backend): RFC-056 patch 2026-05-27 — questioner aging cutoff must use crossClarifyIteration
653efc8 fix(backend): RFC-056 patch 2026-05-25 — isFresherNodeRun must consult crossClarifyIteration
63c1114 fix(backend): RFC-056 patch 2026-05-25 — questioner rerun mint helper must bump cross_clarify_iteration
51934c3 refactor: RFC-064 PR-B — unify clarify counter on node_runs
9206fcd fix(scheduler): clarify history cutoff must not fall back to priorDoneDesigner
b7c9a34 fix(scheduler,cross-clarify): RFC-064 §3.4 follow-up — thread historyCutoff into designer External Feedback
< 本 RFC 修的就是 b7c9a34 引入的新错位 >
```

**每一次都在修"该读哪个 counter / 该写哪个 counter 当 cutoff"**，没有一次质疑为什么用 counter 比大小本身。每加一种 rerun（review-iterate / process-retry / freshness top-up）、一个 consumer kind（self / cross-designer / cross-questioner）、一次 counter 重命名（cci → unified clarifyIteration），都会出一次同形 bug。

## 2. 目标 / 非目标

### 2.1 目标

- **G1**：把 clarify aging 的判定依据从"两个 iteration 计数器比大小"换成"Q&A 行身上有没有 consumed-by-run-id 戳"——一次完整地、所有 consumer kind 共用的、不依赖任何 counter 的状态判定。
- **G2**：覆盖现网三种 consumer 路径：
  - `self`（self-clarify rerun，consumer = asking agent 本人）
  - `cross-designer`（cross-clarify designer rerun，consumer = target designer）
  - `cross-questioner`（cross-clarify questioner cascade rerun，consumer = asking questioner 本人）
- **G3**：彻底取消 `computeHistoryCutoff` / `historyCutoff` 参数 + `applyAgingCutoff` iteration-comparison 路径，源代码层 grep guard 锁死。
- **G4**：任务 `01KSHDCASXA5GDKN3KDZVXYYT0` 现场可复现的 "designer 拿不到最新 cross-clarify Q&A" 真实场景在迁移后正向 case 一遍能跑过。

### 2.2 非目标

- **不改 `<workflow-clarify>` envelope 协议、不改 prompt 模板 / 渲染**——aging 是 prompt 拼装前的过滤阶段，本 RFC 只影响哪些行进 prompt、不影响"进了之后怎么渲染"。
- **不删除 / 合并 legacy `clarify_sessions` / `cross_clarify_sessions` 两表**——RFC-058 PR-B T18 + RFC-064 PR-C 待办 cleanup，不在本 RFC 范围；本 RFC 在所有相关表上一致补 consumed 列，让 cleanup 时一并 DROP 即可。
- **不动 `node_runs.clarifyIteration` 列 / RFC-064 unified counter**——这个字段还有别的用途（freshness 比较 / `isFresherForCutoff` 排序 / UI 显示），本 RFC 只让它**不再当 aging 的判定依据**。
- **不动 questioner 反问触发 / designer rerun cascade / cross-clarify 节点拓扑**——只改 prompt 拼装前的 aging 过滤。

## 3. 用户故事 / 验收标准

### 3.1 用户故事

**US-1（事故复现）**：作为反问触发了 designer 重跑的用户，我新答了一轮跨节点反问。designer 重跑时 prompt 必须包含本轮新问答，且不再包含之前已被一次 done-with-output 消化过的旧问答。

**US-2（多 self 夹一 cross）**：作为同时跑 self-clarify + cross-clarify 的工作流作者，designer 在两次 cross-clarify 之间跑了 N 次 self-clarify、产生了 outputs；之后又来一次 cross-clarify。最新这次 cross Q&A 必须照常进 prompt（不会被中间 self-clarify 的 outputs 提前老化）。

**US-3（rerun 不再炒冷饭）**：作为 review-iterate / process-retry / freshness top-up 触发 designer 重跑的用户，prompt 不能把上次 done-with-output 已消化过的 Q&A 再喂一遍——既省 token，也不让 agent 被旧答案再次锚定。

**US-4（questioner 反问历史）**：作为 cross-clarify questioner 的下游 cascade rerun 触发者，questioner 重跑时只需要看到"还没被一次 done-with-output 消化过的"自己的 Q&A 历史。

### 3.2 验收标准（AC）

**AC-1（事故场景）**：用 task `01KSHDCASXA5GDKN3KDZVXYYT0` 真实数据快照（cross iter=0/1/2 + designer 多次 done-with-outputs 跨 clarifyIteration 0..5）构造 case，跑迁移后的 `buildExternalFeedbackContext`，iter=2 这条 cross-clarify Q&A 必须出现在结果里。

**AC-2（多 self 夹 cross）**：构造 designer 经历 cross→self→self→cross 序列，第二次 cross Q&A 答完时第一次 cross 已被一次 done-with-output 消化；prompt 必须含第二次 cross 不含第一次 cross。

**AC-3（rerun 后炒冷饭）**：designer 已 done 且 output 已 capture；用 review-iterate 触发同 node_id 重跑 → External Feedback prompt 中**不**包含上一次已消化的 cross Q&A。

**AC-4（self 路径）**：等价 US-3 / AC-3 但走 self-clarify 路径（asking_node_id = consumer）。

**AC-5（questioner cascade）**：cross-clarify questioner 被 downstream cascade 重 mint；最近一次 questioner 自己跑出过 output 的 round 不再进 prompt，之后新答的 round 进 prompt。

**AC-6（counter 比大小已死）**：`computeHistoryCutoff` 函数在 src/ 不存在；`historyCutoff` 字符串在 src/（不含本 RFC 的 design 文件）出现 0 次；任何 iteration 数值比大小（`iteration < cutoff` / `iteration >= cutoff` 这类模式）在 aging 路径 0 次。

**AC-7（向后兼容）**：迁移脚本对历史数据回填 consumed_by_consumer_run_id / consumed_by_questioner_run_id 字段——按"该 Q&A 行 answered_at 之前最近一次同 node done-with-outputs 的 node_run"匹配，确保历史任务 reopen 时 prompt 行为字节级守恒（迁移后第一次 rerun 看到的 Q&A 集合与迁移前同函数同 cutoff 实算结果一致）。

**AC-8（grep guard 锁死）**：source-text 测试断言上述三点（AC-6 + 新 mark helper 调用点 + 新 aging predicate 字面量）保持稳定，未来再加任何 rerun / consumer / counter 不让规则失效。

## 4. 风险 / 反对意见预案

### 4.1 "为什么不直接用 timestamp 比较（方案 B）"

候选方案 B（"`answered_at > prior_done.started_at`"）也可以工作，但有两个弱点：
- 时钟单调性已经依赖 ULID + `unixepoch() * 1000`，但仍是间接信号（依赖 wall clock 一致性）。
- 同一毫秒内多事件的边界 case 比"行级戳"难锁。

方案 A 的"戳哪个 run 消化了我"是直接因果记录，零数学。

### 4.2 "为什么不直接迁 counter 对齐（方案 C）"

候选方案 C（"mint cross row 时直接落 unified clarifyIteration"）需要：
- 历史数据迁移把所有 cross row 的 iteration 列重算 = 数据迁移面积更大、风险更高。
- "per-source 最新一轮"的 questioner 视角语义在 unified 计数下不天然，要新写聚合规则。
- **根本没解决"用 counter 模拟因果"这个反模式**，将来加新 consumer kind / 新 rerun 模式还会踩同一个坑。

方案 A 把 aging 从数学问题降级成行级状态，不只解决当前 8 次的同形 bug，**结构性地关闭了这条 bug 出口**。

### 4.3 "你怎么保证 mark 的时机对"

design.md §4 详细写 mark 时机选择：必须在 node_run 转 `done` **且** `node_run_outputs` 已写入之后的事务里 mark，与现有 `setNodeRunStatus` / 输出落盘的顺序绑定。grep guard 锁住唯一 mark 入口；测试覆盖（B 组 ≥ 6 case）锁定时机不被破坏。

### 4.4 "迁移要不要 backfill 历史数据"

要。AC-7 明确字节级守恒：迁移后第一次 rerun 的 prompt 行为不能跟迁移前对同一份数据用 `computeHistoryCutoff` 实算的结果有任何 diff。design.md §6 给出 backfill SQL 蓝本。

## 5. 范围概要

| 维度 | 变更 |
|---|---|
| Schema | `clarify_rounds` / `clarify_sessions` / `cross_clarify_sessions` 三张表各加 `consumed_by_consumer_run_id` + `consumed_by_questioner_run_id`（后者仅 kind='cross' 用）2 列 |
| Migration | 新建 1 个 migration（编号 0036+，跟随 RFC-066 0034 / RFC-067 0033 / RFC-064 0035 之后），含列添加 + 历史 backfill SQL + 2 个索引 |
| 后端代码 | 删 `computeHistoryCutoff` 函数与所有调用点；删 `BuildExternalFeedbackArgs.historyCutoff` / `SelectAnsweredRoundsArgs.historyCutoff`；改 `buildExternalFeedbackContext` / `applyAgingCutoff` / `selectAnsweredRoundsForConsumer` 三处过滤为"`WHERE consumed_by_...run_id IS NULL`"；新加 `markClarifyRoundsConsumedBy(db, nodeRun)` helper，由 `setNodeRunStatus(... → 'done')` 之后 outputs 落盘的事务调用 |
| Runtime / Scheduler | 调用面只剩 mark helper 的一次注入；删 scheduler.ts:1535-1650 现有 3 处 `historyCutoffClarifyIteration` 透传 |
| 前端 | 零改动（aging 是后端 prompt 拼装阶段过滤） |
| 测试 | A 组 baseline ≥ 12 既有 case 锁 byte-equivalent；B 组 ≥ 14 case 锁新行为；C 组 ≥ 6 source-grep guard 锁 counter 路径已死 |

详细参 [design.md](./design.md) §2-§6 + [plan.md](./plan.md) §2 任务清单。

## 6. 与既有 RFC 的关系

- **RFC-023**（agent-clarify）：本 RFC 改 self-clarify aging 路径，envelope / prompt 模板 / 渲染零改。
- **RFC-056**（clarify-cross-agent）：本 RFC 改 cross-clarify designer + questioner aging 路径；session lifecycle / mint / reject / cascade 零改。
- **RFC-058**（clarify-sessions-unification）：本 RFC 在 `clarify_rounds` 上加新列与既有 `kind` 列正交；T18 延后的 legacy 两表 DROP 不受阻（清理 PR 时 consumed 列跟着一起 DROP）。
- **RFC-064**（unified-clarify-runtime）：本 RFC 取消 `computeHistoryCutoff` 这个 RFC-064 §3.4 单点—— §3.4 描述的 "GENERAL aging rule" 物理实现从"counter cutoff"换成"row consumed stamp"，规则本身（"prior done with outputs 消化过的 Q&A 不再喂"）字节守恒。
- **RFC-069**（multiplicity-validation-prepass）：纯 validator 重构，与本 RFC 完全无交叉。
