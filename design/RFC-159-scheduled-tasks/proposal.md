# RFC-159 — 定时任务（周期性自动启动任务）

> 设计门 Codex 评审已过（3 high + 6 medium + 1 low 全折；核心方向与 owner/ACL/migration 承重假设经源码核实成立）。本稿为收口后版本。

## 背景

平台目前只能由用户在 `/workflows/$id/launch` 手动**即时**启动任务（`POST /api/tasks`）。用户提出：**能定期自动启动一个任务，任务参数不变**——同一份启动配置按周期反复重放。全仓当前无任何周期触发能力（`services/scheduler.ts` 是 per-node DAG runner，不是时间调度器）。

三条关键事实（调研 + 设计门核实）决定形态：

1. **启动的权威载荷 = `StartTaskSchema`**（`packages/shared/src/schemas/task.ts:265`）。虽然 URL 模式 `ref` 会折叠成 `baseBranch` 持久化、collaborators 会落 `task_collaborators`，但 **`fetchBeforeLaunch`、未脱敏的 credentialed `repoUrl`（持久化前被 `redactGitUrl`）、显式 `ref` vs 默认分支的意图、完整多仓 `repos[]` body 无法从任务行可靠重建**——因此定时任务定义必须**整份存下 `StartTask` body（JSON）**。
2. **已有可镜像的后台范式**：`services/memoryDistillScheduler.ts`（`next_run_at<=now` DB 轮询/认领/重排）+ `services/eventsArchive.ts`（ticker + `running` 单飞 + `.catch` 隔离 + `loadConfig` thunk）。daemon 无通用后台抽象，每循环 `start*(): { stop }`、`cli/start.ts` 第 8 段挂载 + shutdown 闭包 `.stop()`。
3. **owner 是显式 dep**（`startTask(input, { actorUserId })`，`services/task.ts:553`，不读请求上下文）；`services/fusion.ts` 已有「持久化 owner → 后台以其身份 `startTask`」先例；系统用户 `__system__` 为 admin/active。

## 目标

1. 用户可把一份**启动配置**存成「定时任务」，按**间隔**或**周期预设**自动重放启动，参数不变。
2. **两类调度**（用户拍板）：
   - **固定间隔**：每隔 N 分/时/天。
   - **周期预设**（替代裸 cron，规避 cron 语法/DST 边界地狱）：**每天 HH:MM** / **每周 W（可多选星期几）at HH:MM** / **每月 N 号 at HH:MM**。
   - **时区 = 创建者时区**（创建时经浏览器 `Intl` 捕获 IANA 名并落库；"每天 9 点" = 创建者本地 9 点，**不看 daemon 时区**）。
3. **归属创建者本人**（用户拍板）：自动启动的任务 owner = 创建者；到点经**共享门禁** `assertWorkflowLaunchable` 复核其对该 workflow 的 RFC-099 访问权，失权/被停用则本次触发失败并记录，绝不偷偷续跑。
4. **照常并发触发**（用户拍板）：每到触发点都启动新任务，不追踪上次是否仍在运行；缺席补偿合并为一次（daemon 停机重启不 burst 重放所有错过槽位）。**触发经有界并发池**，一个卡住的 launch 不阻塞其他 schedule 的调度。
5. **独立 `/scheduled` 管理页**（用户拍板）：列表 / 启停 / 编辑周期 / 删除 / 看下次触发 + 最近一次触发结果 + **本定时任务已启动过的任务列表**（经 `tasks.scheduled_task_id` 反查，实时状态、可点进）。
6. **启动表单增「存为定时任务」入口**：复用 `/workflows/$id/launch` 全部输入采集能力（动态输入/多仓/git 身份/协作者/working branch/autoCommitPush），零重写。

## 非目标

- **不做裸 cron 表达式**（用户拍板改友好预设）。「每 5 分钟」这类高频走**间隔**模式；预设覆盖「每天/每周/每月固定时刻」。
- **不支持必填 `kind:'upload'`（blob 上传）输入的工作流定时**：上传文件走 multipart、无法持久化重放——创建时校验拒绝（`scheduled-task-upload-required`）。**可选 upload 输入的工作流可定时**（触发时不提供该文件，与手动留空同）；`files`（路径字符串）/`git`/`enum`/`text` 均放行。
- **v1 不做失败触发的逐条历史**：成功触发经 `tasks.scheduled_task_id` 天然有完整历史；**未产生 task 的失败触发**（ACL/owner 失败）只在 schedule 行留「最近一次」（`last_status`/`last_error`/`last_run_at`）+ `consecutive_failures`。失败触发的完整审计流列 v1.1。
- **v1 不做 permanent vs transient 失败细分**：统一计入 `consecutive_failures`，达阈值自动停用；停用**可见**（WS 事件 + 详情页醒目态 + last_error），阈值 config 可调。细分列后续。
- 不改 opencode 注入 / runner / 决策流 / 编辑器画布；不做跨迭代 feedback；不进 RFC-099 五类 ACL。

## 用户故事

- 作为开发者，我配好「Code→Audit→Fix」工作流的启动参数（仓库、base=main、inputs），希望**每天早上 9 点**（我本地时区）自动跑一遍最新 main。→ 预设 daily `09:00` + base=main + `fetchBeforeLaunch`。
- 作为开发者，我希望**每隔 6 小时**对某仓库跑一次审计。→ 间隔 `every=6, unit=hours`。
- 作为开发者，我希望**每周一、周四早 8 点**跑巡检。→ 预设 weekly `daysOfWeek=[1,4]` `08:00`。
- 作为定时任务创建者，我能在 `/scheduled` 看下次触发、最近结果、以及本任务历次启动的真实 task（点进看状态）；随时启停/改周期/删除。
- 当我失去该 workflow 访问权或被停用，到点触发应**失败并记录**、连续失败自动停用（且我能看到停用原因），而不是继续以我身份跑。
- 作为管理员（持 `tasks:read:all`），我能看/管所有人的定时任务；普通用户彼此的完全不可见。

## 验收标准

1. `POST /api/scheduled-tasks` 用完整 `StartTaskSchema` 校验 `launchPayload`；非法 → 422；合法则按 spec 计算初始 `next_run_at` 落库、owner=actor。
2. 含**必填** `kind:'upload'` 输入的 workflow → 创建 422 `scheduled-task-upload-required`；可选 upload 放行。
3. `ScheduleSpec`（interval/daily/weekly/monthly 判别联合 + 创建者 IANA 时区）校验正/边界/错误；`computeNextRunAt` 对四类都正确：间隔**锚定上一槽 + intervalMs 推进到 >now**（固定 epoch、合并 missed、不漂移）；预设在**创建者时区**算下一 HH:MM（DST gap 顺延、overlap 取前，成文 + fixture 测试；每月缺该日则跳过该月）。
4. 后台循环：`running` 只护「快轮询 + 逐行 CAS 前进 `next_run_at`」；**触发经 `util/semaphore` 有界并发池**、各自异步记录，一个慢/卡 launch 不跳过后续 tick、不阻塞他 schedule；**在途集 ≤ `SCHEDULE_MAX_IN_FLIGHT`（背压：容量满则不再认领、溢出行留库）**；并发同 schedule 的 fire 记账走 **SQL 原子自增**（`consecutive_failures+1` 不丢、停用判据准、`last_*` 时序守卫）。
5. **创建/更新即经**共享 `assertWorkflowLaunchable(db, actor, workflowId)`（= `getWorkflow`+`canViewResource`+`assertNotBuiltin`，JSON/multipart/scheduler + create/update 共用）门禁（不可见/内置/删 → 404，不落库）；**到点再复核**（access 可能中途撤销）：workflow 删/不可见/内置/owner 非 active → 记 `failed`+`last_error`、不启动、`consecutive_failures++`；连续失败达 `maxConsecutiveFailures` 自动 `enabled=false` + 发 WS 事件。owner-actor 用 `buildActor` 合成。
6. 触发成功：`startTask` 以 `scheduledTaskId` dep **原子**写 `tasks.scheduled_task_id`（崩溃可 reconcile、无 orphan）；schedule 行 best-effort 记 `last_status='launched'`+`last_task_id`+`consecutive_failures=0`；spawned task 名 = `启动 body.name · <创建者时区触发时刻>`（≤255 截断）；任务归属创建者、出现在其列表；`GET /api/tasks?scheduledTaskId=` 派生触发历史。
7. 前端：启动表单「存为定时」入口（必填 upload 工作流禁用 + 提示）+ 独立 `/scheduled` 列表/详情；全复用公共组件（Dialog/Field/Segmented/NumberInput/Select/Switch/TextInput/StatusChip/EmptyState/ErrorBanner/ConfirmButton/DetailLayout），**无原生 chrome**；提供「下次 3 次触发」创建者时区预览。
8. WS `/ws/scheduled-tasks`：创建/改/删/触发/自动停用实时刷新；owner/admin 可见性门禁（RFC-152 ChannelSpec）。
9. ACL：`owner_user_id` 列 + `tasks:read:all` admin 旁路；非 owner 非 admin 列表过滤 + 详情 404。
10. 迁移 0080（`scheduled_tasks` 建表 + `tasks` 增 `scheduled_task_id` + 索引；journal idx 79，bump `upgrade-rolling.test.ts` 79→80）；全门禁绿（typecheck+lint+test+format + binary smoke）。
