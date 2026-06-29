# RFC-126 — 任务分解（option A）

单 PR。commit 前缀：`feat(rfc): RFC-126 取消「已关闭」问题态、修 failed→resume 丢答案`。
规模：中（neuter CR-1 + 去 closed 列 + 测试 + 一个极小数据 migration），**零 schema、不动其它不变量**。

## 子任务

| ID | 任务 | 文件 |
|----|------|------|
| RFC-126-T1 | **neuter CR-1**：`checkCR1` 改无参 `(): LifecycleInvariantFinding[] => return []`（注释 RFC-126；调用点改 `checkCR1()`；删 CR-1 退役后变 unused 的 import 保 lint 干净；保留 INVARIANT_RULES + repair 注册不动） | `services/lifecycleInvariants.ts` |
| RFC-126-T1.5 | **数据 migration**：存量 `abandoned`→`answered`（`crossClarifySessions`+`clarifyRounds`，清 `abandonedAt`）+ 标 resolved 存量 `rule='CR-1'` lifecycle_alert（注意 `--> statement-breakpoint`，见 reference_migration_statement_breakpoint） | `db/schema.ts` 不动 + 新 migration |
| RFC-126-T2 | shared：`TaskQuestionPhase` 删 `'closed'`；`deriveQuestionPhase` 删 abandoned/canceled→closed 早返回（回落自然派生） | `packages/shared/src/task-questions.ts` |
| RFC-126-T3 | backend：`taskQuestions.ts:731` 终态守卫去 `closed` | `services/taskQuestions.ts` |
| RFC-126-T3.5 | backend：`reconcileTaskQuestionsForRound` 开头跳过 `canceled`/`abandoned` 轮（不建条目，防御 Codex P2#2 的 actionable 化；测试覆盖 canceled 轮不产条目） | `services/taskQuestions.ts` |
| RFC-126-T4 | frontend：`TaskQuestionList` type/`PHASE_ORDER`/`PHASE_KIND` 去 closed + `phase!=='closed'` 守卫；`ClarifyQuestionHandler:54` + `tasks.detail:656` 守卫去 closed | `components/tasks/TaskQuestionList.tsx`, `components/clarify/ClarifyQuestionHandler.tsx`, `routes/tasks.detail.tsx` |
| RFC-126-T5 | i18n：删 `taskQuestions.phase.closed`（类型 + zh 值 + en 值） | `i18n/zh-CN.ts`, `i18n/en-US.ts` |
| RFC-126-T6 | 复现测试 RED→GREEN（resume 后反馈仍在 + failed+CR-1 后轮仍 answered） | `packages/backend/tests/cross-clarify-service.test.ts` |
| RFC-126-T7 | 删/改受影响测试：删 `cross-clarify-abandoned-invariant.test.ts`；改 `task-questions-phase`(closed→自然相位) / `lifecycle-invariants-current`(去 abandoned) / `lifecycle-repair-CR1`(随 CR-1 退役处理) | `packages/backend/tests/*`, `packages/shared/tests/*` |
| RFC-126-T8 | 索引/状态：`design/plan.md` RFC-126 + `STATE.md` | `design/plan.md`, `STATE.md` |

## 落码顺序建议
T1（neuter，复现测试转绿先验修复）→ T2（shared phase，typecheck 全引用点暴露）→ T3/T4/T5（去 closed wiring）→ T6/T7（测试）。

## 验收清单
- [ ] 复现测试 GREEN：failed→CR-1 后轮仍 `answered`；resume 后 `buildExternalFeedbackContext` 仍含答案。
- [ ] CR-1 不产 abandoned、不发告警；历史 CR-1 告警被 reconcile 自动 resolved。
- [ ] 看板无「已关闭」列；`deriveQuestionPhase` 不返回 closed；历史 abandoned 行回落自然相位不崩。
- [ ] 其它 7 不变量 + self-clarify + 设计者重跑/questioner 级联 + answered/awaiting 流 + `migration-0031` 不改判定即绿。
- [ ] typecheck + 后端 bun test + 前端 vitest + format 全绿；Codex 设计+实现 gate fold；CI 全绿。

## 非目标 / 后续（hygiene 专项）
- 删 `abandoned`/`canceled` schema 枚举（migration）。
- 清反问页 abandoned chip / `CrossClarifyNode` 状态色 / `crossClarify.abandoned*` i18n / abandoned 死读分支 / CR-1 死 repair。
- 全删 CR-1（从 `INVARIANT_RULES`/repair 注册移除 + 编译守卫）——本 RFC 取 neuter（保留注册让历史告警自愈），全删留 hygiene。
