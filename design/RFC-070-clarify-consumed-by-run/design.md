# RFC-070 Design — Clarify Q&A Aging by Consumed-By-Run：技术设计

> 状态：Draft（2026-05-26）
> 关联文档：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 复用基线：[RFC-023](../RFC-023-agent-clarify/design.md)、[RFC-056](../RFC-056-clarify-cross-agent/design.md)、[RFC-058](../RFC-058-clarify-sessions-unification/design.md)、[RFC-064](../RFC-064-unified-clarify-runtime/design.md)

## 1. 概览

把 clarify aging 的判定依据从 **"两个 iteration counter 比大小"** 换成 **"Q&A 行身上有没有 consumed-by-run-id 戳"**。

数据流（新）：

```
[Q&A 行生命周期]
mint(awaiting_human) ──► answered ──► ...
                          │
                          ▼
                  consumed_by_consumer_run_id = NULL
                  consumed_by_questioner_run_id = NULL    （cross 才用）

[某次 consumer node_run 转 done]
setNodeRunStatus(run, 'done')
  └─ writes node_run_outputs (if outputs captured)
     └─ markClarifyRoundsConsumedBy(db, run)
        └─ UPDATE clarify_rounds
              SET consumed_by_consumer_run_id = run.id
              WHERE <consumer 路径 SELECT predicate>
                AND consumed_by_consumer_run_id IS NULL
              （+ 同步 dual-write 到 legacy clarify_sessions / cross_clarify_sessions）

[下一次该 consumer rerun 拼 prompt]
SELECT ... WHERE <consumer 路径 predicate>
              AND <对应 consumed 列> IS NULL
              AND status = 'answered'
              [+ kind / directive / loop_iter / shardKey 已有过滤]
```

零 counter 比较，零 iteration 数学。

## 2. Schema 变更

### 2.1 三张表对称加列

```sql
-- packages/backend/db/migrations/00NN_rfc070_clarify_consumed_by_run.sql
ALTER TABLE `clarify_rounds`
  ADD COLUMN `consumed_by_consumer_run_id` TEXT NULL
    REFERENCES `node_runs`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE `clarify_rounds`
  ADD COLUMN `consumed_by_questioner_run_id` TEXT NULL
    REFERENCES `node_runs`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE `clarify_sessions`
  ADD COLUMN `consumed_by_consumer_run_id` TEXT NULL
    REFERENCES `node_runs`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;
-- clarify_sessions 是 self-clarify 表，questioner = consumer，单列足够

ALTER TABLE `cross_clarify_sessions`
  ADD COLUMN `consumed_by_consumer_run_id` TEXT NULL
    REFERENCES `node_runs`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;
ALTER TABLE `cross_clarify_sessions`
  ADD COLUMN `consumed_by_questioner_run_id` TEXT NULL
    REFERENCES `node_runs`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;

CREATE INDEX `idx_clarify_rounds_consumed_consumer`
  ON `clarify_rounds`(`consumed_by_consumer_run_id`);
CREATE INDEX `idx_clarify_rounds_consumed_questioner`
  ON `clarify_rounds`(`consumed_by_questioner_run_id`);
```

为什么 dual-write 到三张表：

- `clarify_rounds` 是 RFC-058 统一读表（self + cross 都走它）。
- `clarify_sessions` / `cross_clarify_sessions` 是 RFC-023 / RFC-056 legacy 表，部分代码仍直接读（见 `crossClarify.ts:1358` `buildExternalFeedbackContext` 直接读 `crossClarifySessions`）。RFC-058 PR-B T18 / RFC-064 PR-C 延后的 legacy DROP 之前，必须保持两边一致——本 RFC 不动 DROP 时机，只在两边对称加列 + 同步写。

### 2.2 列语义

| 列名 | 含义 | 哪种 kind 用 |
|---|---|---|
| `consumed_by_consumer_run_id` | 此 Q&A 被"主要消费者"消化过的 node_run.id；NULL = 还没消化过 | self（consumer = asking）、cross（consumer = target_designer） |
| `consumed_by_questioner_run_id` | 此 cross Q&A 被"反问者本人"在下游 cascade rerun 中消化过的 node_run.id；NULL = 还没消化过 | 仅 cross（asking_node_id 重跑时） |

self 路径只用 `consumer` 一列；cross 路径两列并行使用。

### 2.3 历史数据 backfill

迁移脚本同事务 backfill：对每条 answered 且无 consumed 戳的 round，找"answered_at 之前最近一次同 consumer node 的 done-with-outputs node_run"作为消化者。SQL 蓝本：

```sql
-- consumer 路径（self: asking_node_id；cross-designer: target_consumer_node_id）
UPDATE clarify_rounds AS cr
SET consumed_by_consumer_run_id = (
  SELECT nr.id FROM node_runs nr
  WHERE nr.task_id = cr.task_id
    AND nr.node_id = CASE cr.kind
                        WHEN 'self'  THEN cr.asking_node_id
                        WHEN 'cross' THEN cr.target_consumer_node_id
                     END
    AND nr.status = 'done'
    AND EXISTS (SELECT 1 FROM node_run_outputs nro WHERE nro.node_run_id = nr.id)
    AND nr.finished_at IS NOT NULL
    AND nr.finished_at < cr.answered_at  -- 严格 "之前"
  ORDER BY nr.finished_at DESC
  LIMIT 1
)
WHERE cr.status = 'answered'
  AND cr.consumed_by_consumer_run_id IS NULL;

-- questioner 路径（仅 cross）
UPDATE clarify_rounds AS cr
SET consumed_by_questioner_run_id = (
  SELECT nr.id FROM node_runs nr
  WHERE nr.task_id = cr.task_id
    AND nr.node_id = cr.asking_node_id
    AND nr.status = 'done'
    AND EXISTS (SELECT 1 FROM node_run_outputs nro WHERE nro.node_run_id = nr.id)
    AND nr.finished_at IS NOT NULL
    AND nr.finished_at < cr.answered_at
  ORDER BY nr.finished_at DESC
  LIMIT 1
)
WHERE cr.kind = 'cross'
  AND cr.status = 'answered'
  AND cr.consumed_by_questioner_run_id IS NULL;
```

同结构 backfill 也对 `clarify_sessions` / `cross_clarify_sessions` 跑。语义守恒：backfill 后再读"`WHERE consumed IS NULL`"得到的 round 集合，与迁移前用 `computeHistoryCutoff(.., consumerRun)` + `iteration < cutoff` 实算的"剩下应进 prompt"集合**字节级一致**（这条 invariant 是 AC-7 的可测试形态，PR-A baseline 5 case 锁住）。

边界 case：`answered_at IS NULL`（撤回 / abandoned / awaiting_human）/ `finished_at IS NULL`（interrupted / canceled）→ backfill 不动，consumed 戳保持 NULL，下次 rerun 行为与迁移前一致。

## 3. 服务层变更

### 3.1 删除：`computeHistoryCutoff` + `historyCutoff` 参数

- 删 `services/clarifyRounds.ts:84-121` `computeHistoryCutoff` 函数体 + export。
- 删 `services/clarifyRounds.ts` `SelectAnsweredRoundsArgs.historyCutoff` 字段、`applyAgingCutoff(rows, cutoff)` helper、`BuildPromptContextArgs.historyCutoff`。
- 删 `services/clarify.ts:589` `historyCutoffClarifyIteration?` 入参与 `:626-636` cutoff 应用块。
- 删 `services/crossClarify.ts:1316` `BuildExternalFeedbackArgs.historyCutoff?` + `:1383` `if (...latest.iteration < historyCutoff) continue` 块。
- 删 `services/scheduler.ts:1535-1542` `priorCompletedCutoff` / `historyCutoffClarifyIteration` 计算 + `:1603-1605` / `:1626-1628` / `:1649-1651` 三处透传。

### 3.2 新增：`markClarifyRoundsConsumedBy(db, nodeRun)` helper

文件位置：`packages/backend/src/services/clarifyRounds.ts`（与既有读路径同模块；不去新建文件以减小调用 graph 改动面）。

```ts
/**
 * RFC-070: stamp Q&A rows this node_run consumed. Called exactly once per
 * node_run lifecycle, from the transaction that:
 *   1. transitions node_run.status to 'done'
 *   2. inserts node_run_outputs row(s) for captured `<workflow-output>` ports
 *
 * If the run did NOT capture any output (clean clarify-only run / failed
 * before output / etc.), this helper is NOT called — the rows stay
 * consumed=NULL so the next rerun continues to see them.
 *
 * Three predicate branches, all using `consumed IS NULL` so multiple done
 * runs in flight never double-stamp:
 *
 *   self consumer path:
 *     UPDATE clarify_rounds + clarify_sessions
 *     SET consumed_by_consumer_run_id = run.id
 *     WHERE kind='self' AND asking_node_id = run.node_id
 *           AND task_id = run.task_id
 *           AND status='answered'
 *           AND consumed_by_consumer_run_id IS NULL
 *           [+ shardKey filter when run.shardKey is set]
 *
 *   cross-designer consumer path:
 *     UPDATE clarify_rounds + cross_clarify_sessions
 *     SET consumed_by_consumer_run_id = run.id
 *     WHERE kind='cross' AND target_consumer_node_id = run.node_id
 *           AND task_id = run.task_id
 *           AND status='answered'
 *           AND directive='continue'
 *           AND consumed_by_consumer_run_id IS NULL
 *
 *   cross-questioner consumer path:
 *     UPDATE clarify_rounds + cross_clarify_sessions
 *     SET consumed_by_questioner_run_id = run.id
 *     WHERE kind='cross' AND asking_node_id = run.node_id
 *           AND task_id = run.task_id
 *           AND status='answered'
 *           AND consumed_by_questioner_run_id IS NULL
 */
export async function markClarifyRoundsConsumedBy(
  db: DbClient,
  run: { id: string; taskId: string; nodeId: string; shardKey: string | null },
): Promise<void>
```

调用点（单点注入）：

- `services/scheduler.ts` 收尾 `transitionNodeRunStatus(.., 'done')` + outputs persist 的事务里，跟在 outputs 写完之后。
- 不在 `setNodeRunStatus` 通用 helper 里挂，避免一切 awaiting→done 的转换（含 clarify-only no-output 完成）都被卷入；保持"只有真正产 output 才算消化"语义。
- grep guard（C 组）：`markClarifyRoundsConsumedBy(` 在 src/ 仅 1 次定义 + 仅 1 次调用。

### 3.3 改写：三处读路径过滤

#### 3.3.1 `selectAnsweredRoundsForConsumer`（self + cross-questioner 共用）

`packages/backend/src/services/clarifyRounds.ts:180`：

```ts
// self 路径（line 183-199 范围）
const rows = await args.db.select().from(clarifyRounds)
  .where(and(
    eq(clarifyRounds.taskId, args.taskId),
    eq(clarifyRounds.kind, 'self'),
    eq(clarifyRounds.askingNodeId, args.consumerNodeId),
    eq(clarifyRounds.status, 'answered'),
    isNull(clarifyRounds.consumedByConsumerRunId),         // ⬅ 新加
  ))

// cross-questioner 路径（line 230+ 范围）
const rows = await args.db.select().from(clarifyRounds)
  .where(and(
    eq(clarifyRounds.taskId, args.taskId),
    eq(clarifyRounds.kind, 'cross'),
    eq(clarifyRounds.askingNodeId, args.consumerNodeId),
    eq(clarifyRounds.loopIter, loopIter),
    eq(clarifyRounds.status, 'answered'),
    isNull(clarifyRounds.consumedByQuestionerRunId),       // ⬅ 新加
  ))
```

剩下的 cross-designer 路径仍在 clarifyRounds.ts 的 §201-228，类似加 `isNull(clarifyRounds.consumedByConsumerRunId)`。

#### 3.3.2 `buildExternalFeedbackContext`（cross-designer External Feedback 拼装）

`packages/backend/src/services/crossClarify.ts:1356-1370`：

```ts
const rows = await args.db.select().from(crossClarifySessions)
  .where(and(
    eq(crossClarifySessions.taskId, args.taskId),
    eq(crossClarifySessions.crossClarifyNodeId, nodeId),
    eq(crossClarifySessions.loopIter, args.loopIter),
    eq(crossClarifySessions.status, 'answered'),
    eq(crossClarifySessions.directive, 'continue'),
    isNull(crossClarifySessions.consumedByConsumerRunId),  // ⬅ 新加
  ))
  .orderBy(desc(crossClarifySessions.iteration))
  .limit(1)
```

删除 §1383 的 `if (latest.iteration < args.historyCutoff) continue` 块。

#### 3.3.3 `applyAgingCutoff` 调用全删除

`packages/backend/src/services/clarifyRounds.ts:311` `applyAgingCutoff(priorRounds, args.historyCutoff)` 调用删除——上游 SELECT 已用 `consumed IS NULL` 过滤，剩下行就是该进 prompt 的全集，下游不再做二次裁剪。

## 4. Mark 时机的不变式

正确性的核心是 mark 必须发生在 **"output 真的落盘了"** 之后。两件事：

1. **必要条件**：node_run 转 done **且** 至少有一行 `node_run_outputs` 被插入。clean clarify-only 完成（只 emit `<workflow-clarify>` envelope，没 emit `<workflow-output>`）的 node_run 不算消化——这与现行 `computeHistoryCutoff` 的 "outputs-presence" gate 完全等价。
2. **充分条件**：node_run 转 done 后 outputs 已可见、且事务未回滚。

实现：在 scheduler 收尾 done 的 `db.transaction(...)` 里，先 `transitionNodeRunStatus(.., 'done')`、再 `persistNodeRunOutputs(...)`、再 `if (outputsCount > 0) await markClarifyRoundsConsumedBy(db, run)`。

源代码层断言（C 组 grep guard）：

- `markClarifyRoundsConsumedBy(` 调用必须出现在与 `persistNodeRunOutputs` 同一函数体且在其之后。
- `markClarifyRoundsConsumedBy(` 不能出现在 `setNodeRunStatus` / `transitionNodeRunStatus` 通用 helper 里。
- 任何"`iteration < ` / `iteration >= `" 在 services/clarify*.ts / scheduler.ts 与 aging 相关命名（`historyCutoff` / `cutoff` / `agingCutoff`）的代码上下文出现 = 0。

## 5. Counter 路径全删的 grep guard 清单

放在 `packages/backend/tests/rfc070-aging-stamp-grep-guards.test.ts`（新增）：

| 项 | 期望命中数 | 锁定意图 |
|---|---|---|
| `computeHistoryCutoff` in `packages/backend/src/` | 0 | 函数已删 |
| `historyCutoff` in `packages/backend/src/` | 0 | 参数已删 |
| `applyAgingCutoff` in `packages/backend/src/` | 0 | helper 已删 |
| `iterationField` in `packages/backend/src/` | 0 | 之前 RFC-064 patch 留的入参，本 RFC 一并清掉 |
| `markClarifyRoundsConsumedBy` 定义 in `packages/backend/src/services/clarifyRounds.ts` | 1 | helper 单点定义 |
| `markClarifyRoundsConsumedBy(` 调用 in `packages/backend/src/services/scheduler.ts` | 1 | mark 单点注入 |
| `consumedByConsumerRunId` schema 字段定义 in `packages/backend/src/db/schema.ts` | 3 | clarifyRounds / clarifySessions / crossClarifySessions 三表对称 |
| `consumedByQuestionerRunId` schema 字段定义 in `packages/backend/src/db/schema.ts` | 2 | clarifyRounds / crossClarifySessions（无 clarifySessions） |
| `isNull(...consumedBy...)` in services/clarify*.ts | ≥ 4 | 4 处读路径过滤都加了 IS NULL gate |

## 6. 测试策略

三组对称：A baseline / B 新行为 / C source-grep guard。

### 6.1 A 组：byte-equivalent baseline（PR-A 加固，≥ 12 case）

锁住"迁移前后对同一份数据，prompt 集合字节守恒"。每条 case 喂相同的 task 快照 + run 快照给迁移前 / 迁移后的 `buildExternalFeedbackContext` + `selectAnsweredRoundsForConsumer`，断言结果数组深度相等。

- A1-A3：cross-designer 路径 byte-equiv（含事故场景快照 A1）
- A4-A6：self 路径 byte-equiv
- A7-A9：cross-questioner 路径 byte-equiv
- A10：no-output 完成（clarify-only run）不变更 consumed 戳
- A11：interrupted / canceled / failed 完成不变更 consumed 戳
- A12：backfill 后立刻读，与迁移前 `computeHistoryCutoff` 实算结果字节级 diff = 0

### 6.2 B 组：新行为 + 事故修复（PR-B 主测，≥ 14 case）

- B1（**事故修复**）：US-1 / AC-1 — 用 `01KSHDCASXA5GDKN3KDZVXYYT0` 数据，迁移后 designer rerun prompt 含 cross iter=2 Q&A
- B2：US-2 / AC-2 — 多 self 夹一 cross 不误老化最新 cross
- B3：US-3 / AC-3 — review-iterate 触发的 rerun 不再炒冷饭
- B4：US-3 self 路径变体 / AC-4
- B5：US-4 / AC-5 — questioner cascade rerun 只看未消化的自己 Q&A
- B6：mark helper 在 transition done + outputs persist 之后调用、之前不调用
- B7：mark helper 对 outputs=0 的完成跳过、对 outputs≥1 的完成执行
- B8：mark helper 用 `IS NULL` 防双盖（两个并行 done run 不互相覆盖戳）
- B9：迁移后第一次 mint 新 Q&A 行 consumed 戳为 NULL
- B10：cross row 两列独立（designer 戳了 questioner 未戳，反之亦然，prompt 读对应列）
- B11：legacy `clarify_sessions` / `cross_clarify_sessions` 与 `clarify_rounds` consumed 戳同步（dual-write）
- B12：legacy 表 backfill 与统一表 backfill 结果一致（同一 round 在两表 consumed 戳一致）
- B13：shardKey 过滤仍生效（self 路径多 shard 子节点各自独立）
- B14：FK ON DELETE SET NULL — 删除 node_run 时 consumed 戳被清空、不留悬空 ID

### 6.3 C 组：source-text 守门（PR-B 收口，≥ 6 case）

按 §5 grep 清单逐条断言。文件：`packages/backend/tests/rfc070-aging-stamp-grep-guards.test.ts`。

### 6.4 既有套件回归

跑：
- `tests/cross-clarify-external-feedback-aging.test.ts`（commit b7c9a34 加的 3 case，本 RFC 后大半应弃用——只保留"freshness top-up 不重喂"语义层 case，删 cutoff iteration 比大小的 setup）
- `tests/clarify-history-cutoff-*.test.ts`（RFC-064 §3.4 加的 4-6 case，本 RFC 后整文件删除或大改）
- `tests/clarify-rounds-service.test.ts`（RFC-058 unified service，按新过滤口子改）
- `tests/scheduler-clarify-baseline.test.ts`、`tests/scheduler-cross-clarify-dispatch.test.ts`（RFC-064 落地时的回归套件）
- `tests/cross-clarify-*.test.ts` 全部（含 RFC-056 patch / RFC-063 / RFC-064 相关）

A 组锁字节守恒，B 组覆盖新路径，C 组锁 counter 路径已死——三组通过即完备。

## 7. 实施期决策点（design 阶段已敲定）

- **D1（mark 入口位置）**：单点放 scheduler done 事务，**不**放 `setNodeRunStatus` 通用 helper。理由：clarify-only no-output 完成路径也走 setNodeRunStatus，但不应该 mark。
- **D2（FK ON DELETE 策略）**：`SET NULL`，不 CASCADE。理由：被消化的 Q&A 行不应因消化者 node_run 被删而连带消失，retry 历史可能需要保留 Q&A 记录。
- **D3（双列 vs 单列）**：cross 路径必须双列（designer + questioner 独立），self 路径单列。理由：proposal §1.3 + design §2.2，两个 consumer 独立 rerun，不能互相覆盖戳。
- **D4（dual-write 范围）**：legacy `clarify_sessions` / `cross_clarify_sessions` 与 `clarify_rounds` 都加 consumed 列 + 都 dual-write。理由：RFC-058 T18 + RFC-064 PR-C 延后 DROP 之前两表仍然被直接读，否则 `buildExternalFeedbackContext` 读 cross_clarify_sessions 拿不到戳。
- **D5（不删 RFC-064 unified counter）**：`node_runs.clarifyIteration` 列保留，仍用于 freshness 比较 / `isFresherForCutoff` 排序 / UI 显示。本 RFC 只让它**不再作为 aging 判定依据**。

## 8. 失败模式 / 边界

- **mark 写一半事务回滚**：若 outputs 已写入但 mark UPDATE 失败 → 同事务回滚一并撤销 outputs 写入 → 下次 rerun 行为正确。
- **历史数据 backfill 失配**：极端边界（同毫秒答完 + 多 done run 同时落 output）的 backfill 选择可能与迁移前实算 diff。AC-7 测试覆盖单 ms 内严格一致；diff 监控通过 A12 case 兜底，diff > 0 直接拦 CI。
- **drizzle schema 改动并发**：`clarify_sessions` / `cross_clarify_sessions` 的 drizzle schema 字段添加与 `clarify_rounds` 一同落，同事务 migration 0NN 编号严格按 plan.md §3 安排。
- **FK ON DELETE SET NULL 与 node_run 删除路径并发**：当前 node_run 不存在程序删路径（只有 task cascade），SET NULL 行为不会被触发；为防御性写 + 加一条 B14 case 锁住。
