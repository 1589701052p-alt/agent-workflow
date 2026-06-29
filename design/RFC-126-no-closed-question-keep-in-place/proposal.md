# RFC-126 — 取消「已关闭」问题态：任务失败也把反问问题留在原地（修 resume 丢答案）

状态：Draft（待用户批准进入实现）
触发：2026-06-29 用户追问「failed 任务 resume 后这些问题就被扔了？」→ 复现测试坐实 **数据丢失**（见下）→ 用户拍板「不应该有关闭的问题，任务挂了也保留在原地」+ 选 **A：CR-1 彻底不动该轮、也不再发告警**。

## 1. 背景 / 已坐实的 bug

RFC-120 看板有个 `closed`（已关闭）相位。经查（见 §证据）：
- `closed` 仅在来源反问轮 `status ∈ {canceled, abandoned}` 时派生（`shared/task-questions.ts:152-155`，最优先判定）。
- `canceled` **无任何写入点**（死分支）。`abandoned` 的**唯一生产者**是 CR-1 生命周期不变量，且 CR-1 **只在 `taskStatus==='failed'` 时触发**（`lifecycleInvariants.ts:515`）。

**数据丢失（已写复现测试、RED 坐实）**：跨节点反问人答完（continue，指派设计者）但设计者重跑还没消费时任务 `failed` → CR-1 把该轮升级 `abandoned`。`abandoned` 是**黏的**（无任何代码在 resume/retry 时还原），且 `buildExternalFeedbackContext` **跳过 abandoned 轮**。于是**该 failed 任务被 resume 后，设计者重跑再也拿不到那条人答的反馈——被静默扔掉**。复现测试（`cross-clarify-service.test.ts`，RED）：answered→有反馈；failed+CR-1→abandoned；resume→`buildExternalFeedbackContext` 返回 `undefined`。

根因：CR-1 的 `abandoned` 是按"任务彻底失败、永不再跑"的假设做的归档，但 **resume 打破了这个假设**，二者没接上 → 人的输入丢失。

## 2. 目标（option A）

- **G1 修数据丢失**：failed 任务的已答反问轮**保持 `answered`**；resume 后设计者重跑照常消费 → 人答的反馈**不丢**。复现测试由 RED 转 GREEN（断言 resume 后反馈仍在）。
- **G2 取消 CR-1 的 abandon + 告警**：CR-1 不再把任何轮升级为 `abandoned`、不再发对应 lifecycle 告警（轮"留在原地"，当无事发生）。
- **G3 取消「已关闭」看板列**：`closed` 相位移除（type / `PHASE_ORDER` / `PHASE_KIND` / i18n / `deriveQuestionPhase` 早返回 / 各 `phase!=='closed'` 守卫）。问题永远停在其自然相位（待指派/处理中/…）。
- **G4 零回归**：其它 7 条不变量（R1/R2/C1/T1/T2/T3/U1）、self-clarify、answered/awaiting_human 流、设计者重跑就绪判定、questioner stop 级联、RFC-070 消费戳——全部逐字不动。

## 3. 非目标

- **不删 `abandoned` 的 DB 枚举值**（`crossClarifySessions.status` / `clarifyRounds.status` 保留 `'abandoned'`/`'canceled'`，**无 schema migration**）。只是**不再产生**新的 abandoned 行。**但有一个极小数据 migration**：把存量 `abandoned` 行 un-abandon 回 `answered`（清 abandonedAt）+ 标 resolved 存量 CR-1 告警——否则历史 abandoned 行会"看着可操作却发不出去"（Codex 设计 gate P2），un-abandon 后它们变可投递、resume 能消费（= "留在原地"正解）。
- **不强行清理 `abandoned` 的死读分支 / 反问页 abandoned chip / 画布状态色**（它们对历史 abandoned 行仍正确渲染、对新任务永不出现，属安全死代码）——这些纯 hygiene 清理留**后续专项**，本 RFC 聚焦"修丢失 + 去 closed 列"，**收窄改动面 + 降多人树冲突风险**。
- 不动 `canceled`（本就无写入点）。

## 4. 用户故事

- 作为答题人，我答完一条跨节点反问后任务挂了；我**修好原因 resume** 任务 → 设计者重跑**仍收到我之前的答案**，不用重答。
- 作为任务成员，我看任务「问题」标签页**不再有「已关闭」列**；任务即便失败，问题也停在它当时的相位（待指派/处理中/已处理待确认），resume 后自然继续。

## 5. 验收标准

1. 复现测试转 GREEN：failed → CR-1 扫描后该轮**仍 `answered`**（不再 abandoned）；resume 后 `buildExternalFeedbackContext` **仍返回含答案的反馈**。
2. CR-1 不再产生任何 `abandoned` 行、不再发 CR-1 告警。
3. 看板无「已关闭」列；`deriveQuestionPhase` 不再返回 `closed`；历史 abandoned 行（若有）回落到自然相位（不崩）。
4. 其它 7 条不变量 + self-clarify + 设计者重跑/questioner 级联 + answered/awaiting 流的既有测试**不改判定即绿**。
5. 受影响测试更新到位（删 CR-1 abandon/repair 专测、改 phase 测试的 closed 断言）；门槛全绿（typecheck + 后端 bun test + 前端 vitest + format）+ CI 全绿 + Codex 设计/实现 gate fold。
