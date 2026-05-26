# RFC-070 Plan — Clarify Q&A Aging by Consumed-By-Run：任务分解

> 状态：Draft（2026-05-26）
> 关联文档：[proposal.md](./proposal.md)、[design.md](./design.md)
> 估算：≈ 6-9 工作日 / 2 PR 强序
> 启动前置：RFC-064 落地稳定（main 上 cci 列已 DROP / `services/crossClarify.ts` 仍在但 unified counter 落地 / `computeHistoryCutoff` 单一入口已就绪）；RFC-066 / RFC-067 / RFC-068 / RFC-069 已 Done，working tree 无冲突

## 1. PR 拆分

沿用 RFC-058 / RFC-064 模式："PR-A baseline 加固锁字节守恒 + PR-B 重构改实现"。aging 这块过去 8 次踩坑就是因为没先锁基线，本 RFC 不会重复这个错。

| PR | 范围 | 估算 | 任务 |
|---|---|---|---|
| PR-A | A 组 ≥ 12 baseline case 锁迁移前后字节守恒（含事故场景快照 A1） | 2-3 d | T1-T3 |
| PR-B | schema + migration + 服务层换实现 + B 组 14 + C 组 6 case + 既有套件回归 | 4-6 d | T4-T11 |

**PR-A 必须先 push + CI 全绿 + 用户验收**再启 PR-B；PR-B 期间任何 A 组 case 红 = 字节守恒被破坏 = 回滚重做，不允许"先改 A 组再上 B 组"绕。

## 2. PR-A 任务清单

**T1 baseline 数据准备**（0.5 d）
- 抓取 task `01KSHDCASXA5GDKN3KDZVXYYT0` 的完整快照（tasks / node_runs / clarify_rounds / clarify_sessions / cross_clarify_sessions / node_run_outputs 全字段）作为 A1 case 数据源
- 整理为 JSON fixture `packages/backend/tests/fixtures/rfc070-incident-01ksh-dcas.json`
- 同步抓 3-4 个 self-only / cross-only / mixed 真实任务快照作 A2-A6 数据源

**T2 A 组 baseline case（≥ 12）**（1.5-2 d）
- 文件：`packages/backend/tests/rfc070-baseline-byte-equiv.test.ts`（新）
  - A1：事故场景 — 现行 `computeHistoryCutoff` + `buildExternalFeedbackContext` 调用对 fixture 跑出 prompt 集合 P_now；记录 P_now 为 expected
  - A2-A3：cross-designer 其它 byte-equiv 快照
  - A4-A6：self 路径 byte-equiv（asking_node_id = consumer）
  - A7-A9：cross-questioner 路径 byte-equiv（asking_node_id 重跑读自己 Q&A）
  - A10：clarify-only no-output 完成路径，记录"现行调用不影响 consumed 戳"的等价表征（cutoff 不变 → prompt 集合不变）
  - A11：interrupted / canceled / failed 终态记录"无新 cutoff 入路径"
  - A12：backfill 等价性断言占位（PR-B 时填迁移后实算 = A1-A11 expected）
- **断言形态**：每 case 调现行函数得到 `actual`，与 hand-derived `expected`（人工算或源数据反演）`deep equal`。先把 PR-A 的 A 组测试**全跑绿**，作为"基线封箱"。

**T3 PR-A 收尾**（0.5 d）
- 跑 3-trio：`bun run typecheck && bun run test && bun run format:check`
- backend 既有套件零退化
- commit 单测试 PR，message `test(backend): RFC-070 PR-A — baseline byte-equiv aging snapshots`
- push + 等 CI 全绿（注意 RFC-066 / RFC-067 后 working tree 多人协作惯例，按路径精确 `git add`，不用 `-A`）
- 用户验收 → STATE.md PR-A 行
- **必须停下来等用户批准启动 PR-B**

## 3. PR-B 任务清单

**T4 migration 0NN_rfc070_clarify_consumed_by_run.sql**（0.5 d）
- 编号：紧跟 main 当前最大 idx（RFC-064 PR-B 落地的 0035 是当前最大；如有新增按时间序排，本 RFC 取下一个空号）
- 内容（design.md §2.1 完整 SQL）：
  - 3 表对称加 consumed 列（self 表单列、cross / 统一表双列）+ FK ON DELETE SET NULL
  - 2 个索引（`idx_clarify_rounds_consumed_consumer` / `idx_clarify_rounds_consumed_questioner`）
  - backfill UPDATE（design.md §2.3 SQL）按 consumer kind + answered_at < finished_at 关联 done-with-outputs run
- 同步 `packages/backend/db/migrations/meta/_journal.json` idx +1
- drizzle schema `packages/backend/src/db/schema.ts` 3 表加字段对应 column 声明
- typecheck 全绿

**T5 删除旧 cutoff 代码路径**（0.5-1 d）
- 删 `services/clarifyRounds.ts:84-121` `computeHistoryCutoff` 函数
- 删 `services/clarifyRounds.ts` `applyAgingCutoff` + `SelectAnsweredRoundsArgs.historyCutoff` + `BuildPromptContextArgs.historyCutoff`
- 删 `services/clarify.ts:589` `historyCutoffClarifyIteration?` 入参 + `:626-636` cutoff 应用块
- 删 `services/crossClarify.ts:1316` `BuildExternalFeedbackArgs.historyCutoff?` + `:1383` iteration < cutoff 块
- 删 `services/scheduler.ts:1500-1605` 3 处 `historyCutoffClarifyIteration` 计算 + 透传
- typecheck 全绿（此时既有套件全红——预期，T7 修）

**T6 新加 `markClarifyRoundsConsumedBy` + scheduler 注入**（1 d）
- `services/clarifyRounds.ts` 新增 export `markClarifyRoundsConsumedBy(db, run)`（design.md §3.2 实现）
- `services/scheduler.ts` 收尾 done 事务里跟在 `persistNodeRunOutputs` 之后调用（仅当 `outputsCount > 0`）
- typecheck 全绿

**T7 三处读路径过滤改写**（0.5-1 d）
- `services/clarifyRounds.ts:180+` `selectAnsweredRoundsForConsumer` 三分支各加 `isNull(...consumedBy...)` 过滤（design.md §3.3.1）
- `services/crossClarify.ts:1356-1383` `buildExternalFeedbackContext` SELECT 加 `isNull(crossClarifySessions.consumedByConsumerRunId)`、删旧 iteration cutoff 分支（design.md §3.3.2）
- `services/clarifyRounds.ts:300+` `buildPromptContext` 删 `applyAgingCutoff` 调用、上游 SELECT 已过滤无需二次裁剪（design.md §3.3.3）
- typecheck 全绿

**T8 B 组新行为 case（≥ 14）**（1-1.5 d）
- 文件：`packages/backend/tests/rfc070-aging-stamp-behavior.test.ts`（新）
  - B1 事故修复：跑迁移 + backfill + 新代码，A1 数据下 designer rerun prompt 含 cross iter=2 Q&A
  - B2-B5：US-2/3/4 + AC-2/3/4/5（多 self 夹 cross / review-iterate 不炒冷饭 / self 路径变体 / questioner cascade）
  - B6 mark 时机锁：transition done + outputs persist 之后调用、之前不调用
  - B7 outputs=0 跳过 mark / outputs≥1 执行 mark
  - B8 IS NULL 防双盖（两并行 done 不互覆）
  - B9 新 mint Q&A 行 consumed=NULL
  - B10 cross 双列独立（designer / questioner 各自戳）
  - B11 三表 consumed 戳 dual-write 一致
  - B12 legacy 表 backfill 与统一表 backfill 结果一致
  - B13 shardKey 过滤仍生效
  - B14 FK ON DELETE SET NULL（删 node_run → consumed 戳清空，不留悬空）

**T9 C 组 source-grep guard（≥ 6）**（0.5 d）
- 文件：`packages/backend/tests/rfc070-aging-stamp-grep-guards.test.ts`（新）
- 实现 design.md §5 grep 清单 9 项断言：
  - `computeHistoryCutoff` / `historyCutoff` / `applyAgingCutoff` / `iterationField` 在 src/ 共 0 命中
  - `markClarifyRoundsConsumedBy` 定义 = 1、调用 = 1
  - `consumedByConsumerRunId` schema 字段 = 3、`consumedByQuestionerRunId` = 2
  - `isNull(...consumedBy...)` ≥ 4

**T10 既有套件回归 + A 组 A12 闭环**（1-1.5 d）
- 用 PR-A 落的 A 组 expected 集合（A1-A11）跑迁移 + backfill 后的新代码，全部断言相等
- 填 A12：backfill 后实算 = PR-A baseline expected（**核心** AC-7 字节守恒断言）
- 跑既有套件并按需删 / 改：
  - `tests/cross-clarify-external-feedback-aging.test.ts`（b7c9a34 留下的 3 case）— 删 setup 里的 historyCutoff 参数、保留"freshness top-up 不重喂"语义层 case
  - `tests/clarify-history-cutoff-*.test.ts`（RFC-064 §3.4 加的 4-6 case）— 改 setup 用 consumed 戳，保留 cutoff 语义的语义层断言
  - `tests/clarify-rounds-service.test.ts`（RFC-058 unified service）— 改 SELECT 入口断言
  - `tests/scheduler-clarify-baseline.test.ts` / `tests/scheduler-cross-clarify-dispatch.test.ts` — typecheck 跟随 args 变化
- 3-trio 全绿

**T11 PR-B 收尾**（0.5 d）
- commit + push
- 等 CI 全绿
- 更新 `design/plan.md` "RFC 索引" 表 Draft → Done
- 更新 STATE.md
- 用户验收

## 4. 风险 / 防御要点

1. **A 组测试必须在 PR-A 单独 push 落主线绿**——sequence 反了等于把 baseline 加固这块再次踩 RFC-056 的覆辙。
2. **backfill SQL 错位**：A12 case 是兜底闸；如果实算 ≠ baseline，CI 拦住，不让 PR-B merge。
3. **多人 working tree 协作**（CLAUDE.md "Multi-person collaboration"）：
   - 不主动 `git add -A` / `.`
   - 不删别人的未追踪文件
   - commit message 只写自己范围
4. **migration 编号竞争**：本 RFC migration 落地时主线最大 idx 已是 0035（RFC-064 PR-B）。如果中间还有别的 RFC 落地推到更高，本 RFC 跟当时最大 idx + 1 安排。
5. **`services/crossClarify.ts` 物理删延后**：RFC-064 PR-C 待办；本 RFC 不动文件位置，只改文件内函数体；将来真删时把 consumed 相关 helper 一并搬。

## 5. 测试加固注释模板

按 CLAUDE.md "Test-with-every-change"，每个新测试文件顶端注释要点：

```ts
// RFC-070 — locks in clarify aging behavior under "consumed-by-run-id" stamp
// model (proposal.md §1, design.md §3-§4).
//
// Why these tests exist:
//   - The aging cutoff was previously a numeric `iteration < cutoff` compare
//     between two counters that drifted apart (RFC-064 §3.4 unified one side
//     but not cross-clarify session iteration). Eight dated patches across
//     2026-05-22 ~ 05-27 all addressed "which counter to read" without ever
//     questioning the counter model itself. The most recent failure:
//     task `01KSHDCASXA5GDKN3KDZVXYYT0` had cross-clarify iter=2 dropped
//     from the designer rerun's prompt because cutoff=5 (clarifyIteration
//     from a prior done) > 2 (cross-local iteration counter).
//   - RFC-070 replaces the comparison with a row-level state: each Q&A row
//     carries a `consumed_by_consumer_run_id` / `consumed_by_questioner_run_id`
//     stamp; aging = "WHERE consumed IS NULL". Zero math, no counter
//     alignment burden, structurally closes the entire bug class.
//
// If any of these cases turns red:
//   - DO NOT relax assertions to make them pass.
//   - The whole point of RFC-070 is that this aging rule cannot silently
//     drift; a red test means a real regression. Trace back to the mark
//     helper (markClarifyRoundsConsumedBy) call site, or the aging SELECT
//     predicate (isNull(...consumedBy...)).
```

每个新测试文件 describe 顶层加这段注释——未来 refactor 时把它变红能立刻看出意图（CLAUDE.md "回归防护命名"）。
