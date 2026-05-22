# RFC-057 任务分解

## PR 拆分总览

| PR | 范围 | 依赖 | 预估测试数 |
| --- | --- | --- | --- |
| PR-A | shared + DB migration 0030 + backend repair engine 骨架 + 4 条规则（S3 / T1 / R1 / U1）端到端 | 独立 | ~25 |
| PR-B | backend 剩余 8 条规则（R2 / C1 / T2 / T3 / CR-1 / S1 / S2 / S4） | PR-A | ~50 |
| PR-C | frontend 三件组件 + `<TaskDiagnosePanel>` 接线 + i18n | PR-A（route 已落） | ~20 |
| PR-D | e2e + STATE.md / 索引完工 + grep 守卫加固 | PR-A + PR-B + PR-C | 1 spec / 4 case + 5 grep |

每个 PR 提交时必须保证 `bun run typecheck && bun run test && bun run format:check` 全绿；push 后查 CI（按 feedback_post_commit_ci_check）。

---

## PR-A — Shared 契约 + 修复引擎骨架 + 4 条规则

### T1. shared 类型 + option taxonomy

文件：`packages/shared/src/diagnose-repair.ts`（新）+ `packages/shared/src/index.ts` 导出。

- 定义 `RepairRisk / RepairOptionMeta / RepairOption / RepairOptionsResponse / RepairRequest / RepairResponse`
- 定义 `REPAIR_OPTION_IDS: Record<LifecycleAlertRule, ReadonlyArray<string>>` 锁住 12 条规则的 option 全集
- `RepairRequestSchema` Zod schema，强制 `confirm: z.literal(true)`
- 测试 `packages/shared/tests/diagnose-repair.test.ts`：
  - REPAIR_OPTION_IDS 覆盖 12 条规则
  - 每条规则 ≥ 1 个 id
  - 全集无重复 id
  - id 命名格式 `<rule>.<kebab>`
  - RepairRequestSchema reject confirm=false / 缺 confirm

### T2. DB migration 0030

文件：`packages/backend/src/db/migrations/0030_lifecycle_repair_audit.sql`（新）+ `packages/backend/src/db/schema.ts` 加表定义。

- 创建 `lifecycle_repair_audit` 表（见 design §2.1）
- 索引 `idx_lifecycle_repair_audit_task` + `idx_lifecycle_repair_audit_rule`
- 测试 `packages/backend/tests/migration-0030.test.ts`：
  - up 后表存在 + 含所有列
  - 索引存在
  - INSERT 一行 + SELECT 回读字节级一致
  - 老 DB（m0029）能升 m0030 不破坏

### T3. 修复引擎骨架

文件：`packages/backend/src/services/lifecycleRepair.ts`（新）

- `RepairContext / PreflightResult / ApplyResult / RepairOptionDef` 类型
- `listRepairOptionsForAlert` + `applyRepairOption` 入口
- 内部辅助：`loadAlert / loadTask / writeAudit / runPostRepairScan`
- `REPAIR_OPTIONS` 表先填本 PR 范围的 4 条规则（S3 / T1 / R1 / U1）；其它 8 条规则用占位 `[]` + 测试 skip 标记（避免编译失败，但 stage 化推进）。**编译期 exhaustiveness 守卫先放在 PR-A 末尾的 `satisfies` 但允许空数组**；PR-B 把空数组补满。
- 不允许 `db.update(nodeRuns).set({ status:` 直接写状态——一律走 RFC-053 helper

### T4. S3 修复 4 选项实现

文件：`packages/backend/src/services/lifecycleRepair.ts` 内 `REPAIR_OPTIONS.S3`。

实现 4 个 optionDef：

- `S3.resurrect-review-run`
- `S3.resurrect-clarify-run`
- `S3.demote-task`
- `S3.mark-task-failed`

每个 option 测试三件套（happy / preflight-stale / apply-error）：

`packages/backend/tests/lifecycle-repair-S3.test.ts`：12 case（4 选项 × 3）。

锁住 2026-05-22 的 `01KS86DPCSERV7S41GQA5Y81RN` 形态（review run interrupted + task running，apply 后变成 awaiting_review）。

### T5. T1 修复 2 选项实现

`REPAIR_OPTIONS.T1`：`T1.demote-task` + `T1.resurrect-review-run`。

测试 `lifecycle-repair-T1.test.ts`：6 case。

### T6. R1 修复 3 选项实现

`REPAIR_OPTIONS.R1`：`R1.approve-run` + `R1.unapprove-doc` + `R1.mark-task-failed`。

测试 `lifecycle-repair-R1.test.ts`：9 case。

锁住 RFC-052 的 task `01KS1N8WVZWE8FTR4K9WSETRNW` 形态。

### T7. U1 修复 2 选项实现

`REPAIR_OPTIONS.U1`：`U1.cancel-older-keep-newest` + `U1.cancel-newer-keep-oldest`。

测试 `lifecycle-repair-U1.test.ts`：6 case。

### T8. routes

文件：`packages/backend/src/routes/tasks.ts`（追加 2 个 endpoint）。

- `GET /api/tasks/:id/alerts/:alertId/repair-options`
- `POST /api/tasks/:id/alerts/:alertId/repair`

测试 `packages/backend/tests/diagnose-repair-routes.test.ts`：~10 case
- happy GET 返回 options
- POST confirm=true 成功
- POST 缺 confirm / confirm=false → 422
- POST 不存在的 alertId → 404
- POST 已 resolved 的 alert → 409
- POST 未知 optionId → 422
- POST body.actorUserId 被忽略，实际取 session userId
- POST 触发 WS broadcast（spy）
- preflight-stale → 409
- 404 unknown task

### T9. detail 增强：stuckTaskDetector repairHint

文件：`packages/backend/src/services/stuckTaskDetector.ts` 改动 S1 / S2 / S3 的 detail 构造。

加上 `repairHint?: { kind, nodeRunId? }`。零行为变更，纯 detail 字段扩展。

测试更新：现有 detector 测试 fixture 加 repairHint 字段断言。

### T10. grep 守卫

`packages/backend/tests/lifecycle-repair-grep-guard.test.ts`：

- `lifecycleRepair.ts` 不含 `db.update(nodeRuns).set({ status:`
- `lifecycleRepair.ts` 不含 `db.delete(`
- `lifecycleRepair.ts` 至少调用 `transitionNodeRunStatus` 8 次
- shared `REPAIR_OPTION_IDS` 12 个 key 覆盖完整 LifecycleAlertRule union
- backend `REPAIR_OPTIONS` 中 PR-A 已实现的 4 规则 id 必须与 shared 列表对齐

### PR-A 完工标准

- ≥ 25 新 case 全绿
- typecheck / test / format:check 全绿
- 手工验证：用 sqlite 模拟 task `01KS86DP...` 形态 → curl POST repair → DB 修复 → 复扫无 S3 alert

---

## PR-B — 剩余 8 条规则

### T11. R2 修复 2 选项

`R2.demote-run-to-awaiting` + `R2.mark-task-failed`。测试 6 case。

### T12. C1 修复 2 选项

`C1.resume-run` + `C1.reopen-session`。测试 6 case。

### T13. T2 修复 2 选项

`T2.demote-task` + `T2.resurrect-clarify-run`。测试 6 case。

### T14. T3 修复 2 选项

`T3.demote-task` + `T3.mark-task-failed`。测试 6 case。

### T15. CR-1 修复 2 选项

`CR-1.acknowledge` + `CR-1.retry-designer-rerun`。测试 6 case。
特殊：`acknowledge` apply 不改 DB，只写 audit + 标 alert resolved。

### T16. S1 修复 2 选项

`S1.recreate-doc-version`（调 `dispatchReviewNode`，最复杂）+ `S1.demote-task`。测试 6 case。

### T17. S2 修复 2 选项

`S2.demote-task` + `S2.reopen-session`。测试 6 case。

### T18. S4 修复 2 选项

`S4.kick-task` + `S4.cancel-task`。测试 6 case。

### T19. 把 PR-A 的 exhaustiveness 守卫从 "允许空数组" 收紧为 "必须 ≥ 1 项"

`REPAIR_OPTIONS satisfies Record<LifecycleAlertRule, [RepairOptionDef, ...RepairOptionDef[]]>` 让空数组编译失败。

### PR-B 完工标准

- ≥ 50 新 case 全绿
- 与 PR-A 累计 ≥ 75 case 全绿
- 所有 12 条规则的 REPAIR_OPTIONS 非空

---

## PR-C — Frontend UI

### T20. shared 类型 re-export 给 frontend

确认 `RepairOption / RepairOptionsResponse / RepairRequest / RepairResponse` 从 shared 正确导出，frontend 可直接 import。

### T21. `<RepairPreview>` 组件

文件：`packages/frontend/src/components/tasks/RepairPreview.tsx`（新）

- 接收 `previewSteps: string[] / risk / destructive`
- 渲染 `<ol>` 步骤列表 + 风险 chip（`<StatusChip>` 复用）
- destructive=true 时整段背景色微调（`.repair-preview--destructive`）

### T22. `<RepairChoiceDialog>` 组件

文件：`packages/frontend/src/components/tasks/RepairChoiceDialog.tsx`（新）

- props: `taskId / alertId / open / onClose / onApplied`
- useQuery 拉 `GET /alerts/:alertId/repair-options`
- 用公共 `<Select>` 列出选项；不可用项 disabled
- 选中后渲染 `<RepairPreview>`
- footer: `<button.btn.btn--sm onClick={openConfirm}>Next</button>`

### T23. `<RepairConfirmModal>` 组件

文件：`packages/frontend/src/components/tasks/RepairConfirmModal.tsx`（新）

- props: `optionMeta / previewSteps / onConfirm / onCancel`
- 复用 `Dialog` 嵌套（外层 RepairChoiceDialog 关闭 / 内层 confirm 打开）
- destructive=true → `.btn--danger` + 文案警告
- 点 Confirm → POST `/alerts/:alertId/repair { optionId, confirm: true }`
- 成功 → onApplied(result) + toast；失败 → `<ErrorBanner>`

### T24. `<TaskDiagnosePanel>` 接线

文件：`packages/frontend/src/components/tasks/TaskDiagnosePanel.tsx`（改）

- 每行 alert 加 `Repair…` 按钮
- 点击 set state 打开 `<RepairChoiceDialog>`
- onApplied → invalidate `['tasks', taskId, 'alerts']` + 重跑 mutation
- detail JSON 折叠到 `<details>`（默认收起，减少视觉噪音）

### T25. i18n

文件：`packages/frontend/src/i18n/zh-CN.ts` + `packages/frontend/src/i18n/en-US.ts`

新增 ~50 key（按 design §4.3 表，每个 optionDef 2 个 key + 通用 dialog 6 个 + risk chip 3 个）。

测试 `i18n-keys-symmetry`（已有 union 校验自动覆盖）。

### T26. 前端测试 ~20 case

文件：
- `packages/frontend/tests/repair-choice-dialog.test.tsx`（~6 case）
- `packages/frontend/tests/repair-confirm-modal.test.tsx`（~5 case）
- `packages/frontend/tests/task-diagnose-panel-repair-wiring.test.tsx`（~5 case）
- `packages/frontend/tests/repair-preview.test.tsx`（~4 case）

### T27. styles.css

新增 `.repair-preview` / `.repair-preview--destructive` / `.repair-choice__option` namespace 约 15 选择器；复用 Dialog / Select 既有 chrome。

### PR-C 完工标准

- ≥ 20 新 case 全绿
- 视觉对齐自查与 `/agents` / `/workflows` / `/repos` 一致（按钮高度、圆角、spacing）

---

## PR-D — e2e + 收尾

### T28. e2e spec

文件：`packages/frontend/e2e/diagnose-repair.spec.ts`（新）

4 case（见 design §6.6）。

新 fixture：`packages/frontend/e2e/fixtures/stub-opencode-wedge.sh`（造 S3 wedge）。

### T29. STATE.md 更新

把 RFC-057 从 "进行中 RFC" 改为 Done；在已完成 issue 表里加一行。

### T30. design/plan.md RFC 索引更新

把 RFC-057 行的状态从 Draft 改为 Done，commit hash + CI run id 填入。

### T31. 文档：把 `scripts/fixup-rfc052-stuck-review.ts` 标 deprecated

在脚本头部加注释指向 RFC-057 的 R1 修复选项，作为新形态首选；脚本保留供历史 task 救场。

### PR-D 完工标准

- e2e 全绿（含 6 jobs 矩阵）
- STATE.md + plan.md 同步推送

---

## 全局测试预算

| 来源 | 预估 |
| --- | --- |
| shared diagnose-repair | 6 |
| backend per-rule unit (12 规则 × 平均 2.5 选项 × 3 case) | ~90 |
| backend routes | ~10 |
| backend grep 守卫 | ~5 |
| backend migration 0030 | ~4 |
| frontend unit (4 组件) | ~20 |
| e2e | 4 |
| **合计** | **~140 新 case** |

零既有套件退化是硬门。

## 验收清单（合并前自查）

- [ ] 12 条 LifecycleAlertRule 在 `REPAIR_OPTION_IDS` 和 `REPAIR_OPTIONS` 中均非空
- [ ] 每个 optionId 有 unit test 三件套（happy / stale / error）
- [ ] grep 守卫 5 条全绿
- [ ] frontend 复用 Dialog / Select / Field / ErrorBanner，零自写 modal/select/input chrome
- [ ] i18n 中英对称
- [ ] migration 0030 升级测试 + 老 DB 兼容
- [ ] e2e S3 happy path 5s 内 banner 消失
- [ ] STATE.md / plan.md 同步
- [ ] CI 6 jobs（lint+typecheck+test × 2 平台 + build smoke × 2 + e2e × 2）全绿
- [ ] 视觉对齐自查（按钮 / spacing / 色阶与既有页面一致）

## 落地后跟进（非本 RFC 范围）

- audit log 浏览页 UI（admin 看历史修复操作）
- 可选 repair 选项的快捷键 / 命令面板
- 把"修复成功 toast"接到全局通知中心
- 为高频形态预设"推荐 option"标记（current UI 用 `risk: 'low'` 隐式标第一个 low-risk 为默认选中）
