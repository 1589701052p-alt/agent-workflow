# RFC-159 — 任务分解

> 设计门 Codex 收口版（3 high + 6 medium + 1 low 全折）。相较初稿的结构变化：① 无 cron 解析器 → `scheduleTime.ts` 周期预设 + 创建者时区；② 新增独立的「启动路径 behavior-preserving 重构」任务（抽 `assertWorkflowLaunchable` + `buildStartTaskDeps`）；③ 触发链改 `tasks.scheduled_task_id` 原子落库；④ 循环改有界并发。

## 子任务

### RFC-159-T1 — shared：ScheduleSpec + scheduleTime 下次触发 + schemas
- `packages/shared/src/scheduleTime.ts`：`tzOffsetMs` / `zonedWallClockToEpoch`（Intl，DST gap 顺延/overlap 取前）/ `computeNextRunAt`（interval 锚定不漂移 + daily/weekly/monthly 创建者时区有界前推、缺月跳过）。
- `packages/shared/src/schemas/scheduledTask.ts`：`Interval/Daily/Weekly/MonthlySpecSchema` 判别联合（HHMM/dayOfWeek/dayOfMonth/IANA 时区校验）/ `ScheduledTaskSchema`（`launchPayload:StartTaskSchema`、`scheduleSpec:ScheduleSpecSchema` + 状态列）/ `Create`/`Update`；`index.ts` re-export。
- 测试：`scheduleTime.test.ts`（四类 + DST fixture + 锚定不漂移 + 缺月跳过）+ `scheduledTask.test.ts`（判别正/拒）。
- **依赖**：无。**PR-1 可独立先合**（纯 shared）。

### RFC-159-T2 — backend：启动路径 behavior-preserving 重构（无 schema 变更）
- 抽 `services/taskLaunchGate.ts` `assertWorkflowLaunchable(db, actor, workflowId)`；`routes/tasks.ts` JSON(:236-246)+multipart(:790-795) 两处改为调它（**字节等价**）。
- 抽 `buildStartTaskDeps(db, configPath, actorUserId): StartTaskDeps`（per-call 读 live config，`resolveSubagentLiveCapture` 从 route-local 上提；`db` 显式入参——R2-e）；`routes/tasks.ts` 改为调它。
- 测试：`task-launch-gate.test.ts`（三 case 行为等价 + route 改造前后锁）+ `start-task-deps.test.ts`（改 config 后 route/scheduler 一致）。
- **依赖**：无。**PR-2 独立、低风险**（纯重构，为 T3 铺路；也修 finding 4/10 的既有 fork 面）。

### RFC-159-T3 — backend：schema + CRUD + 后台循环 + 触发
- 迁移 `0080`（`scheduled_tasks` 建表 + 两索引 + `ALTER tasks ADD scheduled_task_id` + 索引）+ journal idx 79 + `upgrade-rolling` 79→80 + 既有 task 全字段锁 bump。
- `db/schema.ts`：`scheduledTasks` 表 + `tasks.scheduledTaskId` 列；`StartTaskDeps.scheduledTaskId?` → task insert stamp；`TaskSchema`/`TaskSummarySchema` 加字段；`GET /api/tasks` 加 `scheduledTaskId` 过滤。
- `services/scheduledTasks.ts`：`list/get/create/update/delete` + `rowToView`（create/update：**`assertWorkflowLaunchable` 创建时门禁 R2-b** + StartTaskSchema 校验 + **必填 upload 守卫** + 初始 next_run_at；接 `{ actor }`）+ `fireSchedule`（`buildActor` 合成 owner-actor + `assertWorkflowLaunchable` 复核 + 注入 launch + `decorateTaskName`）。
- `routes/scheduledTasks.ts`：5 路由 + `canViewScheduledTask`（`tasks:read:all` 旁路 + owner）；`server.ts` mount。
- `services/scheduledTaskScheduler.ts`：`pollAndClaim(db,now,limit)`（CAS 前进）+ `fireClaimed`（有界 `util/semaphore` + **`inFlight`/`SCHEDULE_MAX_IN_FLIGHT` 背压 R2-a** + **原子 SQL 记账 recordSuccess/Failure R2-c** + 自动 disable+WS）+ `startScheduledTaskLoop`；`config` 加 `scheduledTasksEnabled`/`scheduledTasksMaxFailures`；`cli/start.ts` wiring + shutdown。
- 测试：`scheduled-tasks-crud`（含创建时门禁 404）/`scheduled-tasks-acl`/`scheduled-task-scheduler`（CAS 先于 fire、有界并发+背压、原子记账并发不丢计数、各失败路径、缺席合并、自动 disable、短路）/`tasks-scheduled-link` + migration-0080 冒烟（proposal §验收 1-6,9,10）。
- **依赖**：T1 + T2。**PR-3**。

### RFC-159-T4 — frontend：启动表单「存为定时」
- `routes/workflows.launch.tsx` 加动作 + `ScheduleDialog`（Segmented 间隔/每天/每周/每月 + 分支字段 + 创建者时区捕获显示 + 下次 3 次触发预览）；复用 `buildLaunchBody*`；必填 upload 工作流禁用 + 提示。
- 抽 `lib/schedule-view.ts`：`scheduleSummary`/`decorateTaskName`/预览（纯函数，复用 shared `scheduleTime`）。
- 测试：`ScheduleDialog` 渲染 + 纯函数预言 + no-native-chrome 锁。
- **依赖**：T1（spec/预览）+ T3（POST 端点）。**PR-4（与 T5 同 PR）**。

### RFC-159-T5 — frontend：/scheduled 列表 + 详情 + 导航 + 触发历史
- `routes/scheduled.tsx`（列表）+ `routes/scheduled.$id.tsx`（详情：编辑/启停/删除/最近触发/**自动停用醒目态**/**触发历史=GET /api/tasks?scheduledTaskId**）。
- `lib/nav.ts` + `router.tsx`（detail 在 list 前）+ i18n 双语。
- 测试：列表/详情三态 + 启停 PUT + 删除 + 历史列表 + 停用态。
- **依赖**：T3（端点）。**PR-4**。

### RFC-159-T6 — WS `/ws/scheduled-tasks`
- `shared/schemas/ws.ts` 加 `WS_PATHS.scheduledTasks`；RFC-152 ChannelSpec（owner/admin gatedSubscribe）；server create/update/delete/fire/**auto-disabled** broadcast；`hooks/useScheduledTaskWs.ts`。
- 测试：ws 注册表逐帧 + 可见性门禁（非 owner 非 admin 丢帧）+ auto-disabled 帧。
- **依赖**：T3 + T5。**PR-5**。

### RFC-159-T7 —（可选）`POST /:id/run-now` 手动立即触发
- 路由 + 详情页「立即运行一次」；走 `fireSchedule` 不动 next_run_at；owner/admin。
- 测试：run-now 成功/失败 + 门禁。
- **依赖**：T3 + T5。**PR-5，可延后**。

### RFC-159-T8 — 门禁 + 视觉基线 + Codex 实现门
- `typecheck && lint && test && format:check` 全绿；binary smoke（shared 新导出，防模块环 [reference_binary_build_module_cycle]）。
- `/scheduled` 页视觉：[feedback_frontend_visual_verify_repro] 光/暗双模验；e2e 视觉基线**新增** `scheduled.png`（新路由，不动既有页基线）。
- Codex 实现门（[feedback_codex_review_after_changes] impl gate）。
- **依赖**：全部。**PR-5 收尾**。

## PR 拆分建议

- **PR-1 = T1**（纯 shared，零风险先合）。
- **PR-2 = T2**（启动路径 behavior-preserving 重构，独立可合、字节等价 + parity 测试）。
- **PR-3 = T3**（schema + CRUD + 循环 + 迁移，一体后端能力）。
- **PR-4 = T4 + T5**（前端创建入口 + 管理页 + 历史）。
- **PR-5 = T6 + T7 + T8**（WS + 可选 run-now + 门禁/视觉/实现门）。

每 PR 独立过门禁（typecheck+lint+test+format + binary smoke）；[feedback_post_commit_ci_check] 推后即查 CI；[feedback_grep_locks_before_push] 改符号前盘测试源码锁。多人树 [feedback_dont_delete_others_code_for_ci]/[feedback_shared_index_commit_race] 精确路径 `git commit -- <paths>`。

## 验收清单（对应 proposal §验收标准）

- [ ] 1 create StartTaskSchema 校验 + 初始 next_run_at（T3）
- [ ] 2 必填 upload 422、可选 upload 放行（T3 + T4 禁用）
- [ ] 3 ScheduleSpec 四类 + scheduleTime（interval 锚定不漂移 / 预设创建者时区 / DST / 缺月跳过）（T1）
- [ ] 4 running 只护 poll+claim、有界并发触发、CAS 先于 fire（T3）
- [ ] 5 assertWorkflowLaunchable 三处共用 + buildActor + 各失败记 failed + 自动 disable+WS（T2+T3+T6）
- [ ] 6 tasks.scheduled_task_id 原子链接 + 时间戳命名 + GET tasks?scheduledTaskId 历史（T3）
- [ ] 7 前端入口 + 管理页全复用公共组件、无原生 chrome、下次触发预览（T4/T5）
- [ ] 8 WS 实时（含 auto-disabled）+ 可见性门禁（T6）
- [ ] 9 owner 列 + admin 旁路 + 非授权 404/过滤（T3）
- [ ] 10 迁移 0080（两表 + tasks 列）+ upgrade-rolling 79→80 + 全门禁绿（T3/T8）

## 门禁流程（按 CLAUDE.md + 记忆）

1. ✅ RFC 三件套写完 → **Codex 设计门评审**（3 high + 6 medium + 1 low 全折，本稿已收口）。
2. **待用户批准**（ExitPlanMode / 显式确认）后方进入实现（**不边写 RFC 边改代码**）。
3. 实现每子任务带测试落 commit；每 PR 过门禁 + CI 查绿 + Codex 实现门。
4. 收尾更新 `STATE.md`（RFC-159 → Done）+ `design/plan.md` RFC 索引状态。
