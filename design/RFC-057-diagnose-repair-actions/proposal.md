# RFC-057 Diagnose Panel —— 每条诊断异常都带修复选项

## 背景

RFC-053 落了一套完备的诊断体系：

- **lifecycle invariants**（`services/lifecycleInvariants.ts`）—— 8 条规则 `R1 / R2 / C1 / T1 / T2 / T3 / U1 / CR-1`，启动 + 每小时增量扫，违反则写入 `lifecycle_alerts`。
- **stuck-task detector**（`services/stuckTaskDetector.ts`）—— 4 条规则 `S1 / S2 / S3 / S4`，每 5 分钟跑，规则与 lifecycle alerts 共表。
- **`POST /api/tasks/:id/diagnose` / `GET /api/tasks/:id/alerts`** —— 给前端实时拉。
- **`<StuckTaskBanner>` + `<TaskDiagnosePanel>`** —— 任务详情页顶部红章 + 弹窗，把 `(rule × severity × detail.json)` 表格化展示给 admin。

**现在的痛点**：诊断**只读不动**。本月线上多次出现的实际事故：

1. 2026-05-22 task `01KS86DPCSERV7S41GQA5Y81RN` 因 `dispatchReviewNode` 在 `interrupted` review 行上尝试 `park-review` 抛 `IllegalNodeRunTransition`，runner 静默吞掉异常，task 永远卡在 `running`。lifecycle.stuck `findings=3` 把它扫到了，但 UI 上只能看到一行 `{rule:'S3', message:'...'}` JSON——admin 必须开 SQL shell 手改 `node_runs.status` + `tasks.status` 再调 `/resume`。
2. 2026-05-19 task `01KS1N8WVZWE8FTR4K9WSETRNW` 撞 RFC-052 review approve idempotent bug，最终也是 admin 用一次性 fixup 脚本 `scripts/fixup-rfc052-stuck-review.ts` 救活。
3. RFC-052 / RFC-053 / RFC-056 整个迭代里凡是涉及"线上脏数据补救"的，都靠 ad-hoc SQL 或一次性 fixup 脚本——脚本写完跑一遍就废，下一次 wedge 又得从零写一个。

这条路不可持续。每多发现一种 wedge 形态就攒一个 fixup 脚本，迟早脚本之间互相矛盾、缺审计、缺 typed 校验，admin 出错的代价也越来越大。

## 目标

把"诊断异常的修复"从"打开 SQL shell 改库"升级成"诊断详情里一个点击按钮 → 选择修复策略 → 二次确认 → 一行 audit 记录"。

具体目标：

1. **12 条诊断规则全覆盖**——`R1 / R2 / C1 / T1 / T2 / T3 / U1 / CR-1 / S1 / S2 / S3 / S4`，每条至少给 1 个修复选项；多数规则会给 2-3 个不同语义的修复策略让 admin 选（"重活节点 run" vs "让任务回滚重跑" vs "直接标 failed 放弃"），由 admin 看实际形态决定。
2. **修复选项是 typed 白名单**——每个 `(rule, optionId)` 都有静态声明的 `preflight`（校验数据形态还匹配 finding detail）+ `apply`（写 DB 的具体动作）。没有"自由 SQL 接口"，没有"通用 reset"。
3. **必须人工二次确认**——前端弹一个 `<RepairChoiceDialog>` 列出可用选项 + 每个选项的"会做什么"预览 + 风险 chip，admin 点选后再走一次 confirm modal，然后才落库；后端 `POST /api/tasks/:id/alerts/:alertId/repair` 也强校验 `body.confirm === true`。
4. **完整 audit**——新表 `lifecycle_repair_audit` 落 `(taskId, alertRule, optionId, actorUserId, beforeSnapshot, afterSnapshot, appliedAt, outcome)`，每次修复留痕；audit 行不删，便于事后回溯"哪个 admin 在何时把哪条 wedge 怎么救的"。
5. **修复后即时复扫**——`apply` 成功后立即重跑 `runLifecycleInvariants({taskId})` + `runStuckTaskDetector` 子集，推 WS `lifecycle.alert` 让 banner / panel 自动更新，alert 由 `resolveLifecycleAlerts` 标 `resolved_at`。
6. **复用 RFC-053 state machine**——所有 node_run 状态改写都走 `transitionNodeRunStatus` / `setNodeRunStatus`，绝不裸 `db.update(nodeRuns).set({ status })`；终态转换通过 `allowTerminal=true` 受控通道走（与 supersede / sibling-cascade 同等级），且每个修复选项明示是否需要 `allowTerminal`。

## 非目标

- **不做批量"修所有异常"按钮**。每条 alert × 每个 option 都要 admin 手动点。误点的代价是写脏一个 task，批量操作的代价是写脏一批 task。
- **不做自动修复 / cron**。lifecycle.invariants 和 stuck detector 仍然只检测、不动手；CR-1 既有的"answered+continue + task failed → 升级为 abandoned"是设计上明确同意的状态机 upgrade，本 RFC 不动它，但本 RFC 也不引入新的 auto-heal。
- **不开放自由 SQL / 通用 reset 端点**。每个修复选项都是命名好的、code review 过的 apply 函数；admin 无法通过 HTTP 触发未声明的写动作。
- **不迁移已有 fixup 脚本**。`scripts/fixup-rfc052-stuck-review.ts` 等历史脚本保留，本 RFC 的能力上线后这些脚本自然不会再被人写新的，但**已存在的不删**（CLAUDE.md 多人协作原则）。
- **不改诊断规则本身**。规则定义保持 RFC-053 PR-D/PR-E 现状；新加规则要走它自己的 RFC，本 RFC 只补"已有规则的修复入口"。
- **不引入 frontend 新公共组件库**。`<RepairChoiceDialog>` 全部复用 `Dialog` / `Select` / `Field` / `ErrorBanner` / `.btn` / `.segmented`（CLAUDE.md 前台界面统一风格原则）。

## 用户故事

### US-1 admin 在任务详情页救活 S3 wedge

我（admin）刷新 `/tasks/$id`，看到顶部红章 `Stuck task — 1 alert`。点 `Diagnose`：

> | Rule | Severity | Detected | Detail |
> | --- | --- | --- | --- |
> | **S3** task running 但所有 node_run terminal | error | 12:14 | `{ totalRuns: 27, terminalRuns: 27, inactiveForMs: 1h2m }` |
> | | | | **[Repair…]** |

点 **Repair…** 弹出 `<RepairChoiceDialog>`，列出 3 个修复选项：

1. **Resurrect review run + resume task**（推荐 / 风险：低）—— "扫到 `rev_5h9xpz` 有一条 `interrupted` 行（review_iteration=2，无同 iter `done`），把它打回 `pending`，task 打回 `interrupted`，调用 `/resume`。"
2. **Resurrect clarify run + resume task**（不可用）—— "未找到 `interrupted` clarify 行。"
3. **Demote task + resume**（风险：中）—— "只把 task 打回 `interrupted` 并调用 `/resume`，让 scheduler 自己重新决定下游；适用于卡死位置不明的场景。"
4. **Mark task failed**（风险：高 / 不可逆）—— "把 task 直接标 `failed`，保留 worktree，让 admin 之后人工善后。"

admin 点 1，二次确认 modal 显示"将执行的步骤"：
```
1. transitionNodeRunStatus({nodeRunId: '01KS87C2HK...', event: 'mark-pending'}) — review row → pending
2. UPDATE tasks SET status='interrupted', error_summary='manual-unstick' WHERE id='01KS86DP...'
3. resumeTask('01KS86DP...')
```
点 `Confirm`，apply 成功，banner 在 ~3 秒内消失（WS 推 `lifecycle.alert resolved`）。Audit Trail 多一行。

### US-2 R2 violation 的两种判断

R2（review run done 但无 approved doc_version）一般来自 RFC-052 残留脏数据。admin 看 detail 知道是历史脏数据 vs 是当下 bug——两种修法：

1. **Demote run to awaiting_review** —— 让用户重新决定，会再生 doc_version。
2. **Mark task failed** —— 数据已无法救，放弃推进。

admin 选哪个由他对具体 review 的判断决定。

### US-3 U1 多活跃 run 收口

U1（同 `(nodeId, iter, shard)` 多于 1 行 awaiting_review/awaiting_human）：

1. **Cancel older, keep newest**（默认）—— 按 ulid 取最新一行保留，其余走 `cancel-by-supersede` 终态。
2. **Cancel newer, keep oldest** —— 罕见，但当 admin 明确"新行是 race 错出的"时用。

## 验收标准

| ID | 描述 | 锁定方式 |
| --- | --- | --- |
| A-1 | 12 条规则各自至少给 1 个 `optionId`；`listRepairOptionsForAlert` 对每条规则返回非空数组 | `shared/diagnose-repair.test.ts` 12 case + exhaustiveness 静态守卫 |
| A-2 | 每个 `optionId` 都有 `preflight` 函数 + `apply` 函数 + i18n label key | 类型层 `RepairOptionDef satisfies ...` + grep 守卫 |
| A-3 | `POST /api/tasks/:id/alerts/:alertId/repair` 必须 `body.confirm === true` 才执行 | route test 4 case（缺 confirm / confirm=false / option 不存在 / preflight stale → 422/409） |
| A-4 | `apply` 后立即跑 `runLifecycleInvariants({taskId})`，原 alert 行 `resolved_at` 写入 | integration test 3 case（每条规则的 happy path 锁一个，跑完 alert 必须 resolved） |
| A-5 | `lifecycle_repair_audit` 表每次 apply 落一行，含 before/after snapshot | route test + 表 shape test |
| A-6 | 所有 node_run 写动作走 `transitionNodeRunStatus` / `setNodeRunStatus`，禁裸 update | grep 守卫（`packages/backend/src/services/lifecycleRepair.ts` 内不得出现 `db.update(nodeRuns).set({ status:`） |
| A-7 | 前端 `<RepairChoiceDialog>` 走 RFC-035 公共组件（Dialog/Select/Field），不引入新 chrome | frontend grep 守卫 + 截图对齐自查 |
| A-8 | 修复成功后 banner 在 5s 内消失（WS 推送） | e2e 1 case S3 happy path |
| A-9 | 修复选项的"会做什么"预览列出**确切**会写入的表 + 行 + 字段，admin 看完即知后果 | preflight 返回 `previewSteps: string[]` 字段，dialog 渲染逐行 |
| A-10 | 没有"修所有异常"批量入口；UI 上每个 alert 行独立 Repair 按钮 | 视觉对齐自查 + frontend 测试 |
| A-11 | actorUserId 从 `c.get('userId')`（已有 auth middleware）取，不可由 client 传 | route test 1 case 验证 client body 的 actorUserId 被忽略 |
| A-12 | 修复操作不删除任何数据行（只改 status / mint 新行）；audit 行只 append，永不 DELETE | grep 守卫 `lifecycleRepair.ts` 不含 `db.delete(` |

## 影响面

- **新增**：
  - shared: `packages/shared/src/diagnose-repair.ts`（option taxonomy / 类型 / 12 规则的 optionId 集合 / preview 步骤序列化）
  - backend: `packages/backend/src/services/lifecycleRepair.ts` + `packages/backend/src/routes/diagnoseRepair.ts`（挂在 `tasks.ts` 里）
  - DB: migration 0030 新表 `lifecycle_repair_audit`
  - frontend: `packages/frontend/src/components/tasks/RepairChoiceDialog.tsx`、`packages/frontend/src/components/tasks/RepairPreview.tsx`、`useRepairOptions` hook
  - WS: 复用既有 `lifecycle.alert` 消息（`transition: 'resolved'` 已存在）；不新增消息类型
  - i18n: ~30 个新 key（12 规则 × 平均 2.5 选项 + 通用 dialog 文案）
- **改动**：
  - `<TaskDiagnosePanel>` 每行加 `Repair…` 按钮；JSON detail 折叠到子行
  - `services/stuckTaskDetector.ts` 的 detail 加 `repairHint`（指向具体 nodeRunId）以便 preflight 不用重算
  - `services/lifecycleInvariants.ts` 的 detail 已经够用，零改动（detail 里已经带 `nodeRunId` / `docVersionId` 等键）
- **零改动**：
  - 诊断规则本身（R1..S4 的检测函数）
  - 任务调度（runner / scheduler 路径）
  - opencode 启动 / 输出协议
  - 现有 fixup 脚本（仍保留，作为 fallback / 文档）
  - 既有 `<StuckTaskBanner>` 显示逻辑

## 风险与权衡

- **风险 1：admin 点错按钮把好数据搞坏**。Mitigation：每个 option 都强制 preflight（apply 前再校验一次 detail 还匹配现在 DB 状态，不匹配 → 409 stale + 让 admin 重新 diagnose）；apply 都是 idempotent 形态（重复点不会重复改坏）；高风险 option（`mark-task-failed` / `cancel-newer-keep-oldest`）的 dialog 用 `.btn--danger` 样式 + 二次确认 modal。
- **风险 2：修复选项的语义随产品演化漂移**。Mitigation：每个 optionId 的 apply 都有专门的 unit test 锁 before/after 形态；新规则必须显式声明 options 列表，编译期 `Record<LifecycleAlertRule, RepairOptionDef[]> satisfies ...` exhaustiveness 守卫拒绝缺项。
- **风险 3：UI 暴露 internals 太多让普通用户被吓退**。Mitigation：这是 admin-only 路径——`<TaskDiagnosePanel>` 已经只对 admin 显示；修复入口沿用同一权限位（与 `lifecycle:diagnose` 同级，必要时新建 `lifecycle:repair`）。
- **风险 4：修复后 invariant 立刻又触发**。Mitigation：apply 成功后立刻同步跑一次 invariant 扫，把 resolved alert 标走；如果 invariant 仍然违反，UI 会**保留** alert 行但用更新后的 detail 重新渲染（admin 看了就知道"这条没真的修好"，可以再点另一个 option）。
- **权衡：是否允许跨 task 批量修复**？拒绝。本 RFC 显式不做。跨 task 操作意味着一次写多行不同 task，回滚困难；admin 可以挨个点。

## 与既有 RFC 的关系

- **RFC-052** 的 fixup 脚本被本 RFC 的 `repair` 机制取代（R1 / R2 / S1 / S3 几个选项里都覆盖了 RFC-052 那一类形态），但脚本本身保留。
- **RFC-053** 提供的 state machine + lifecycle alert 表是本 RFC 的基础设施，本 RFC **使用**它们而不修改。
- **RFC-056** 的 CR-1 invariant 已经是 self-upgrade（answered+continue + task failed → abandoned），本 RFC 给 CR-1 只挂"acknowledge"（标 alert resolved）和"retry-designer-rerun"（task 还可救时用）两个选项；不动 invariant 本身的 upgrade 逻辑。
- 不阻塞 RFC-054 任意 wave。
