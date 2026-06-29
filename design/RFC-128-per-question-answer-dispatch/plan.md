# RFC-128 — 任务分解 / plan

> 依赖 **RFC-127**（借壳执行）。动 clarify「整轮 seal」核心 → 分阶段 P0–P5，**self/questioner 逐题重跑（P5）末位、可独立回退而不影响 P1–P4 的 designer 主线**。
> migration 号取落地时下一个空号（现存最新 0066；RFC-127 的 `node_runs` 列在前，本 RFC 的 `task_questions.sealed_at` 取其后）。

## 阶段与子任务

### RFC-128-P0（锁网，先行，无生产改动）

- **T0**：补「整轮 seal 全链路」回归网——self 单 rerun（`clarify.ts:473`）、cross questioner cascade、§18 部分下发、RFC-126 `failed→resume` answered 存活、RFC-070 整轮 aging。**先有网再动刀**（[hotspot-fortify-refactor] 同法）。

### RFC-128-P1（落库地基，纯后端 golden-lock）

- **T1**：`task_questions` 加 `sealed_at` 列（+ `sealed_by`）+ migration（journal +1 → bump `upgrade-rolling.test.ts`；`--> statement-breakpoint`）。
- **T2**：`reconcileDesiredEntries`（`shared/task-questions.ts:113`）门控 `roundAnswered`→逐题 `questionSealed[qid]`；幂等 upsert 不变。
- **T3**：`answers_json` 逐题 merge 写；`sealAnswersServerSide`（`clarify.ts:1010`）去「空数组抛错」（`:1014`）、改「只 seal 传入子集并 merge」。
- **T4**：轮 `awaiting_human→answered` 仅「全题 seal」时翻；partial 纯派生（不新增 DB status，护 RFC-126）。
- 测：AC-1/2/3 + 破坏面 §8 全套绿（黄金锁：无 override/单题全答 = 旧整轮行为逐字一致）。

### RFC-128-P2（逐题 seal 端点 + defer 意图 + 待下发 gate）

- **T5**：`POST /api/tasks/:id/questions/answer`（`requireTaskMember`）seal 单题 merge + 落 `sealed_at`；或扩 `POST /api/clarify/:nodeRunId/answers` 接受 `questionIds` 子集 + `defer`（复用 `ensureClarifyMember`/`resumeTask`，改动更小）——实现 gate 二选一。
- **T6**：`defer=true`（集中界面）→ 不立即续跑、进待指派；`defer=false`（反问页）→ 现状立即。
- **T7**：`stageTaskQuestion`（`taskQuestions.ts:790`）加「该题已 seal」gate（未 seal 4xx）；前端 `hasStage`（`TaskQuestionList.tsx:344`）加 answered 条件。
- **T7b（待下发即下发）**：staged 列去每卡 checkbox + 选择 state；「批量下发」下发**全部** staged（非所选）；后端 dispatch 端点不变。把 §18「勾选→下发所选」测试改为「批量下发→全部 staged」。
- 测：AC-5/7/12。

### RFC-128-P3（designer 域逐题下发，低风险）

- **T8**：designer 逐题答→reconcile 出该题 designer 条目→走既有 `dispatchTaskQuestions`（§18）+ RFC-127 借壳；部分下发、`dispatched_at IS NULL` CAS 防重（`taskQuestionDispatch.ts:416`）。
- 测：AC-8。

### RFC-128-P4（两入口 UI）

- **T9**：集中回答面——任务详情新 pane，`listTaskQuestions` 取待答题、按 `originNodeRunId` 分组平铺多个 `QuestionForm`；逐题草稿（已支持跨轮）+ 逐题/批量「确定」调 T5 端点（`defer=true`）；scope 仅 cross 渲染、directive 按轮呈现；改派下拉 `ClarifyQuestionHandler`。复用公共原语、无原生 chrome；i18n 中英对称；视觉对齐自查。
- **T10**：`/clarify`（`clarify.detail.tsx`）读 `listTaskQuestions` per-question 态，已 seal/已下发题置灰只读 + 提交排除（防重复下发靠 CAS）。
- 测：AC-4/6（前端 vitest）。

### RFC-128-P5（self/questioner 逐题重跑，最高风险，单独 PR + 单独 Codex gate）

- **T11**：渐进式注入——新 builder：本题问题+答案 + 兄弟题状态标注块（pending/in-queue/已处理），指示「只处理本题、勿重复追问」；中间态 worktree 累积。
- **T12**：条目级反馈/消费戳扩 self/questioner（仿 RFC-120 §2.4 designer）——每条逐题 rerun 只 stamp/注入本题。
- **T13**：directive 节点级继承（不下沉逐题，§3）；下游 freshness 取最终产出。
- 测：AC-9 三坑回归 + design §5.2 自检表（5 项全过才合）。

## PR 拆分

- **PR-A**：P0（锁网）。
- **PR-B**：P1（落库地基）。
- **PR-C**：P2+P3（端点+gate+designer 逐题下发）。
- **PR-D**：P4（两入口 UI）。
- **PR-E**：P5（self/questioner 逐题重跑，可独立回退）。

## 验收清单

proposal `AC-1`~`AC-11` 全绿；门槛 typecheck+test+format:check + CI；**Codex 双 gate**（设计 gate 落码前对全 RFC 跑一次、P5 实现前**单独**再跑一次对抗审 §5.2 自检表）；push 后查 CI。**若 P5 Codex gate 复现 RFC-125 级致命问题 → 回退 P5、与用户重新权衡，P1–P4 designer 主线不受影响**。
