# RFC-159 — 技术设计

> 设计门 Codex 收口版。单一事实源：`shared` 的 `ScheduleSpec` + `scheduleTime.ts`（`computeNextRunAt` + 创建者时区下次触发，纯函数、双端共用）；backend `services/scheduledTasks.ts`（CRUD + fire）+ `services/scheduledTaskScheduler.ts`（后台循环，镜像 `memoryDistillScheduler`+`eventsArchive`）+ 共享 `assertWorkflowLaunchable` / `buildStartTaskDeps`；前端复用 `lib/launch-repo-source.ts` 启动 body 构造器。

## 1. 数据模型（新表 `scheduled_tasks` + `tasks.scheduled_task_id` + 迁移 0080）

`packages/backend/src/db/schema.ts`（列惯例锚点：`tasks.ownerUserId` :518、`mcps.enabled` :190、`memory_distill_jobs.nextRunAt` :1607、JSON 列 = 纯 `text` + `JSON.stringify` 写 + Zod 读，无 `mode:'json'`）：

```ts
export const scheduledTasks = sqliteTable(
  'scheduled_tasks',
  {
    id: text('id').primaryKey(), // ULID
    name: text('name').notNull(), // 定时任务显示名（管理用，≠ 启动 body.name）
    ownerUserId: text('owner_user_id').notNull(), // 创建者；到点以其身份启动
    launchPayload: text('launch_payload').notNull(), // JSON: 完整 StartTask body
    scheduleSpec: text('schedule_spec').notNull(), // JSON: ScheduleSpec 判别联合（含 kind + 创建者时区）
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    nextRunAt: integer('next_run_at'), // enabled 时 = 下次触发 epoch ms；disabled → null（不参与轮询）
    lastRunAt: integer('last_run_at'), // 循环上次「尝试触发」时刻（成功或失败）
    lastStatus: text('last_status', { enum: ['launched', 'failed'] }),
    lastError: text('last_error'), // 未产生 task 的失败原因（ACL/owner 等）
    lastTaskId: text('last_task_id'), // best-effort：最近一次成功启动的 task（便捷指针）
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    dueIdx: index('idx_scheduled_tasks_due').on(t.enabled, t.nextRunAt), // 轮询扫描面
    ownerIdx: index('idx_scheduled_tasks_owner').on(t.ownerUserId),
  }),
)
```

**成功触发的「真身链接」= `tasks.scheduled_task_id`（设计门 finding 1）**：给现有 `tasks` 表加一 nullable 列 + 索引：

```ts
// tasks 表新增列
scheduledTaskId: text('scheduled_task_id'), // 该 task 由哪个定时任务启动；手动启动为 NULL
// tasks 表新增索引
schedTaskIdx: index('idx_tasks_scheduled_task').on(t.scheduledTaskId),
```

**为何链在 `tasks` 上而非事后 UPDATE schedule 行**：`scheduledTaskId` 随 `startTask` 的 task insert **原子落库**（`services/task.ts:853` 同一 insert），因此即便「先 CAS 前进 next_run_at → launch → 事后记 last_\*」的最后一步 UPDATE 失败或 daemon 崩溃，**真身仍可由 `tasks.scheduled_task_id` reconcile**，不产生 orphan、不留假失败。schedule 行的 `last_\*` 只是便捷缓存；触发历史/次数一律以 `tasks` 为准（`run_count` 派生自 `COUNT(*) WHERE scheduled_task_id=id`，不设漂移列）。

迁移 `packages/backend/db/migrations/0080_rfc159_scheduled_tasks.sql`（手写、每语句间 `--> statement-breakpoint`，禁止把断点 token 写进注释——0052/0053 事故）：

```sql
CREATE TABLE IF NOT EXISTS `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`launch_payload` text NOT NULL,
	`schedule_spec` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_status` text,
	`last_error` text,
	`last_task_id` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scheduled_tasks_due` ON `scheduled_tasks` (`enabled`,`next_run_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scheduled_tasks_owner` ON `scheduled_tasks` (`owner_user_id`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `scheduled_task_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_scheduled_task` ON `tasks` (`scheduled_task_id`);
```

journal `meta/_journal.json` 追加 `{ "idx": 79, "version": "6", "when": <上一条 when + 1e8>, "tag": "0080_rfc159_scheduled_tasks", "breakpoints": true }`；bump `upgrade-rolling.test.ts`（标题 :230 79→80、断言 :282 `toBe(80)`、账本注释加一行）。`TaskSchema`/`TaskSummarySchema` 增 `scheduledTaskId: z.string().nullable()`——**既有 task 全字段锁测试随之 bump**（RFC-146/158 同型：加列即改锁）。

## 2. ScheduleSpec + 下次触发计算（`shared`，纯函数，无 cron 解析器）

`packages/shared/src/schemas/scheduledTask.ts`：

```ts
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) // 'HH:MM' 24h
const TZ = z.string().min(1).refine(isValidIanaTz, { message: 'invalid-timezone' }) // Intl 校验
export const IntervalSpecSchema = z.object({
  kind: z.literal('interval'),
  every: z.number().int().min(1).max(1000),
  unit: z.enum(['minutes', 'hours', 'days']),
})
export const DailySpecSchema = z.object({ kind: z.literal('daily'), at: HHMM, timezone: TZ })
export const WeeklySpecSchema = z.object({
  kind: z.literal('weekly'),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1), // 0=周日..6=周六（JS getDay）
  at: HHMM,
  timezone: TZ,
})
export const MonthlySpecSchema = z.object({
  kind: z.literal('monthly'),
  dayOfMonth: z.number().int().min(1).max(31),
  at: HHMM,
  timezone: TZ,
})
export const ScheduleSpecSchema = z.discriminatedUnion('kind', [
  IntervalSpecSchema, DailySpecSchema, WeeklySpecSchema, MonthlySpecSchema,
])
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>
```

`packages/shared/src/scheduleTime.ts`（纯函数、双端共用、零依赖，仅用运行时自带 `Intl`）：

- `tzOffsetMs(epoch, tz): number` —— 用 `Intl.DateTimeFormat(undefined, { timeZone: tz, ... })` 的 `formatToParts` 反推该时区在该瞬间的 UTC 偏移（标准「任意时区 offset」技法，DST 由「按瞬间查偏移」天然处理）。
- `zonedWallClockToEpoch({year,month,day,hour,minute}, tz): number` —— 把「时区 Z 的墙钟」转 epoch。**候选集算法**（R2-d + R3-3 + R4-2，正确覆盖 gap/overlap、**与偏移符号及半球无关**）：`guess = Date.UTC(...)`。**关键（R4-2）：候选偏移必须取自 transition 两侧、而非 guess 自参照的两遍**——否则南半球/正偏移 overlap（如 `Australia/Sydney 2026-04-05 02:30`）自参照两遍只落到较晚实例、`min` 无从补救。做法：在 `guess` 邻近**两侧**各探偏移 `offA = tzOffsetMs(guess - 26h)`、`offB = tzOffsetMs(guess + 26h)`（±26h 必跨任一单次 DST 切换、覆盖切换前后两个偏移；取去重集），生成候选 `cand = { guess - offA, guess - offB }`；逐个**回环校验**（格式化回 Z、墙钟 == 请求值即「有效发生」）：
  - **正常**：恰一个有效 → 返回它。
  - **overlap**（墙钟出现两次，两候选均有效）→ 返回 `min(有效候选)` = **较早**者（候选已含两侧偏移，`min` 恒取最早、南北半球一致）。
  - **gap**（墙钟不存在，均**无效**，如 `America/New_York` `2026-03-08 02:30`）→ **顺延**到 spring-forward 后第一个有效瞬间（在 [guess-26h, guess+26h] 内二分/线性探 transition 边界，落切换后首个有效分钟）。
  语义成文 + fixture 锁：`America/New_York` 春进(gap)/秋退(overlap) + `Australia/Sydney`（南半球 overlap 取早，锁 R4-2）+ `Australia/Lord_Howe`（半时 DST 正偏移）。
- `computeNextRunAt(spec, now, anchor?): number` —— 统一入口：
  - `interval`：`unitMs = {minutes:60_000, hours:3_600_000, days:86_400_000}[unit] * every`；**锚定** `base = anchor ?? now`；`let n = base + unitMs; if (n <= now) n = base + Math.ceil((now-base)/unitMs)*unitMs; while (n <= now) n += unitMs; return n`。→ **固定 epoch，不随 tick 延迟/慢 launch 漂移**（finding 5），且合并 missed 槽为一次（finding 4）。
  - `daily`/`weekly`/`monthly`：在 `timezone` 里取 `now` 的墙钟日期，逐日/逐周几/逐月**有界前推**（daily ≤1 天、weekly ≤7 天、monthly ≤ ~62 天，缺该日的月**跳过**），首个 `> now` 的 `at` 时刻经 `zonedWallClockToEpoch` 转 epoch。**无逐分钟扫描、无 cron 边界地狱**（finding 7）。

创建时 `next_run_at = computeNextRunAt(spec, now, anchor=now)`；触发 CAS 前进时 `anchor = 该行旧 next_run_at`（interval 固定 epoch）。前端「下次 3 次触发」预览 = 迭代 `computeNextRunAt`（预设 ≤ 常数步，无卡顿风险）。

## 3. CRUD 服务 + 路由（镜像 `mcps`）+ 共享启动门禁/deps 工厂

**共享启动门禁**（设计门 finding 10）——把 `routes/tasks.ts:236-246`（JSON）与 `:790-795`（multipart）重复的门禁抽成一份，JSON/multipart/scheduler 三处共用（**不塞进 `startTask`**，因 fusion 等服务层内置调用需绕过 route guard）：

```ts
// services/taskLaunchGate.ts
export async function assertWorkflowLaunchable(db, actor, workflowId): Promise<Workflow> {
  const wf = await getWorkflow(db, workflowId)
  if (wf === null || !(await canViewResource(db, actor, 'workflow', wf)))
    throw new NotFoundError('workflow-not-found', ...) // invisible==missing
  assertNotBuiltin('workflow', wf) // RFC-104
  return wf
}
```

**共享 deps 工厂**（设计门 finding 4）——HTTP launch 每次请求读 live config（`opencodeCmd`/`subagentLiveCapture`/runtime config，`routes/tasks.ts:201,248-255`；`resolveSubagentLiveCapture` 现为 route-local）。抽 **`buildStartTaskDeps(db, configPath, actorUserId): StartTaskDeps`**（**每次 fire/请求都读 live config**；**R2-e：`db` 是必填 dep、不可由 configPath 重建，故显式入参/闭包携带**——其余生产字段 `subagentLiveCapture`/`commitPush`/`mergeAgent`/`maxConcurrentNodes`/`defaultRuntime`/`defaultNodeRetries`/`opencodeCmd`/`defaultPerNodeTimeoutMs` 均由 config 派生，`awaitScheduler`/`preCreatedWorktree`/`preResolvedSource` 为 route/测试专属、后台 fire 一律省略），route 与 scheduler 共用——避免 scheduler 在 daemon 启动时冻结 deps 导致与手动 launch 在 config 改动后行为漂移。

**`services/scheduledTasks.ts`**（形状抄 `services/mcp.ts`：`list/get/create/update/delete` + `rowToView` JSON.parse+Zod，损坏抛 `ValidationError('scheduled-task-row-corrupt')`）。

`createScheduledTask(db, input, { actor })`（**接 `actor` 而非仅 `ownerUserId`——供 create 时门禁**；owner = `actor.user.id`）：
1. `StartTaskSchema.parse(input.launchPayload)`（保证可重放）。
2. **创建时启动门禁（R2-b，新 HIGH）**：`await assertWorkflowLaunchable(db, actor, body.workflowId)`——**创建/更新即校验**，不可见/内置/已删 workflow 直接 404，杜绝「建一个引用不可见 workflow 的定时任务、到 fire 才失败」的探测/延迟失败。（fire 时**仍**复核——access 可能在 create 与 fire 之间被撤销。）
3. **upload 守卫（finding 8，收窄为必填）**：门禁返回的 `wf.definition.inputs` 含 `kind==='upload' && required` → `ValidationError('scheduled-task-upload-required')`。可选 upload 放行（触发时不提供该 key，与手动留空同）。
4. `ScheduleSpecSchema.parse(input.scheduleSpec)`。
5. `nextRunAt = enabled ? computeNextRunAt(spec, Date.now(), Date.now()) : null`。
6. insert，返回 view。

`updateScheduledTask(db, id, patch, { actor })`：owner/admin 门禁；改 `name/enabled/scheduleSpec/launchPayload`（launchPayload 变更同过 StartTaskSchema + upload 守卫）。**R3-1 重门禁规则**：**只要「更新后」的 schedule 为 `enabled=true`（含 spec-only 改、含 disabled→enabled 复启、含 launchPayload 改），就重跑 `assertWorkflowLaunchable(db, actor, wf)`**——堵住「schedule-only PUT 复启一个引用已失可见性/已内置 workflow 的定时任务、拖到 fire 才失败」（R3-1）；**若更新结果为 `enabled=false`（用户在停用/清理）则跳过门禁**（允许对已删/失权 workflow 的定时任务做停用与删除，不被 404 卡死）。spec 变更或 disabled→enabled 重算 `nextRunAt`（`consecutiveFailures` 归零）；enabled→disabled 置 `nextRunAt=null`。

**`routes/scheduledTasks.ts`**（抄 `routes/mcps.ts`：`actorOf(c)`、`safeJson`、201/204）。可见性 **`canViewScheduledTask(db, actor, row)`** = `actor` 持 `tasks:read:all`（admin/`__system__`）**或** `row.ownerUserId === actor.user.id`（镜像 `canViewTask` 去成员分支）：

| 路由 | 行为 |
| --- | --- |
| `GET /api/scheduled-tasks` | 列表 `filter(canView)` |
| `GET /api/scheduled-tasks/:id` | 载入 + canView 否则 `NotFoundError`（invisible==missing） |
| `POST /api/scheduled-tasks` | `CreateScheduledTaskSchema` + `createScheduledTask(db, data, { actor: actorOf(c) })`（内含创建时 `assertWorkflowLaunchable`）；201 |
| `PUT /api/scheduled-tasks/:id` | 载入 + owner/admin + `UpdateScheduledTaskSchema` + `updateScheduledTask(db, id, patch, { actor: actorOf(c) })`（launchPayload 变更再门禁）；重算 next_run_at |
| `DELETE /api/scheduled-tasks/:id` | 载入 + owner/admin；204 |
| `POST /api/scheduled-tasks/:id/run-now`（可选 T7） | 手动立即触发一次（走 §5 `fireSchedule`，不动 next_run_at）；owner/admin |

**触发历史**：`GET /api/tasks` 增可选 `scheduledTaskId` 过滤（列表路由已有 `scope` 过滤面，加一个 where 条件）；`canViewTask` 天然管可见性。`mountScheduledTaskRoutes(app, deps)` 加进 `server.ts` mount 列表。shared schema：`ScheduledTaskSchema`（`launchPayload: StartTaskSchema`、`scheduleSpec: ScheduleSpecSchema` + 状态列）/ `CreateScheduledTaskSchema`（`name/launchPayload/scheduleSpec/enabled(default true)`）/ `UpdateScheduledTaskSchema`（strict partial），`index.ts` re-export。（注：`StartTaskSchema` 为 `.superRefine` schema，作 `z.object({ launchPayload: StartTaskSchema })` 子字段可 `.parse`——设计门已核实。）

## 4. daemon 后台循环（`services/scheduledTaskScheduler.ts`）

设计门 finding 2：**`running` 只护「快轮询 + 逐行 CAS 认领」（DB-only、毫秒级）；触发经有界并发池异步执行，不在全局循环里串行 await 外部 I/O**——一个卡住的 clone/worktree 只占一个并发槽，不跳过后续 tick、不阻塞他 schedule。

```ts
export const SCHEDULE_TICK_MS = 30_000        // 预设分钟粒度足够；轻于 1Hz
export const SCHEDULE_FIRE_CONCURRENCY = 4    // util/semaphore 实际并发
export const SCHEDULE_MAX_IN_FLIGHT = 32      // R2-a：在途（已认领未完成）硬上限＝backlog 界
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10 // config.scheduledTasksMaxFailures 可覆盖

export function startScheduledTaskLoop(opts: {
  db; loadConfig: () => Config; buildLaunch: (ownerUserId: string, scheduledTaskId: string) => ScheduleLaunch; intervalMs?
  // ScheduleLaunch = (body: StartTask) => Promise<{ id: string }>（注入型，测试传 fake，无需真跑 opencode）
}): { stop } {
  const sem = new Semaphore(SCHEDULE_FIRE_CONCURRENCY)
  let running = false
  let inFlight = 0                                    // R2-a：dispatched-but-not-done 计数
  const handle = setInterval(() => {
    if (running) return
    if (opts.loadConfig().scheduledTasksEnabled === false) return // 每 tick 读 live config
    running = true
    const capacity = Math.max(0, SCHEDULE_MAX_IN_FLIGHT - inFlight) // 只认领装得下的
    ;(capacity === 0 ? Promise.resolve([]) : pollAndClaim(opts.db, Date.now(), capacity))
      .then((claimed) => {
        for (const c of claimed) {
          inFlight++
          void sem.run(() => fireClaimed(opts, c)).finally(() => { inFlight-- })
        }
      })
      .catch((err) => log.error('scheduled-task poll failed', { error: msgOf(err) }))
      .finally(() => { running = false })              // 立即释放：fires 异步跑
  }, opts.intervalMs ?? SCHEDULE_TICK_MS)
  ;(handle as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(handle) }
}
```

- **R2-a 背压**：单 tick 只认领 `capacity = SCHEDULE_MAX_IN_FLIGHT - inFlight` 行；卡住的 launch 让 inFlight 高企 → 后续 tick `capacity=0` **不再认领**，溢出行仍 `next_run_at<=now` **留在库里**、待容量释放后的 tick 再捞——**在途集恒 ≤ SCHEDULE_MAX_IN_FLIGHT，不随 tick 无界增长**（原设计的隐患）。
- `pollAndClaim(db, now, limit)`：`SELECT * WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=now ORDER BY next_run_at ASC LIMIT :limit`；逐行 **CAS 前进**（**先前进 next_run_at 再触发**）：`next = computeNextRunAt(spec, now, anchor=row.nextRunAt)`；`UPDATE ... SET next_run_at=:next, updated_at=:now WHERE id=:id AND next_run_at=:prev AND enabled=1`。`changes===0`（并发 tick 抢先）→ 丢弃。返回认领成功的行 = **每槽单飞锁**（不需 status 列）。**R4-1：claim 绝不写 `last_run_at`**——`last_run_at` 仅由 record\* 展示写入（= firedAt），否则 claim 写 `now`（>firedAt）会自阻塞后续 `last_run_at<=firedAt` 展示守卫、令 last_status 永不更新。
- `fireClaimed(opts, row)`：`const firedAt = row.nextRunAt`（**本 fire 的槽时刻**——即被 CAS 前进「前」的旧值，作 last_* 时序守卫键，语义 = 最近一次已记录结果的槽）；`try { const r = await fireSchedule(...) ; recordSuccess(db, row.id, r.taskId, firedAt) } catch (err) { recordFailure(db, row.id, msgOf(err), firedAt) }`。
- **R2-c / R3-2 原子记账**（并发同 schedule fire——「照常并发触发」下高频 interval 会真实重叠——**禁读快照再写**；**计数/停用**与**展示字段**拆成两条职责各异的 SQL，展示字段全部 firedAt 时序守卫）：
  - `recordSuccess(db, id, taskId, firedAt)` = 两句：① **计数** `UPDATE SET consecutive_failures=0 WHERE id=:id`（成功断连败流）；② **展示（时序守卫）** `UPDATE SET last_status='launched', last_error=NULL, last_task_id=:taskId, last_run_at=:firedAt WHERE id=:id AND (last_run_at IS NULL OR last_run_at <= :firedAt)`（旧 fire 迟到不覆盖新 fire 的 last_\*）。真身已由 `tasks.scheduled_task_id` 原子落库，此 best-effort 写丢失亦可 reconcile。
  - `recordFailure(db, id, msg, firedAt)` = 两句：① **计数+停用**（SQLite 单 UPDATE 里 SET 表达式读**旧**值，故 `CASE WHEN consecutive_failures+1>=:max` 与 `SET consecutive_failures=consecutive_failures+1` 同源一致）`UPDATE SET consecutive_failures = consecutive_failures + 1, enabled = CASE WHEN consecutive_failures + 1 >= :max THEN 0 ELSE enabled END WHERE id=:id AND enabled=1 RETURNING enabled`——重叠 fire 各 +1 不丢、停用判据准；**自动停用恰一次**：`WHERE enabled=1` 使跨阈值首个 fire 命中（旧 enabled=1）、`RETURNING enabled=0` → 发 WS `scheduled-task.auto-disabled`（finding 9），其余在途 fire `WHERE enabled=1` 不再命中（changes=0）→ 不重复自增/发事件；② **展示（时序守卫，不含 last_task_id——失败不改「最近成功 task」指针）** `UPDATE SET last_status='failed', last_error=:msg, last_run_at=:firedAt WHERE id=:id AND (last_run_at IS NULL OR last_run_at <= :firedAt)`（R3-2：last_status/last_error 也受 firedAt 守卫，旧失败不覆盖新结果）。
  - （已知最小近似：success 的 `consecutive_failures=0` 不带 firedAt 序，极端乱序重叠下计数可能偏一——只影响 auto-disable 触发时机的启发式、不影响任何一次 launch 正确性；持续损坏的 schedule cf 仍会爬到阈值。文档化，不过度工程。）

**至多一次/槽**：CAS 先前进 next_run_at；崩溃在 fire 中途 → 该槽 next 已推进、不重复；已创建的 task 由 `scheduled_task_id` 可辨认。无需 `recoverRunning`。

**wiring（`cli/start.ts` 第 8 段，3 处编辑）**：import；`const scheduledTaskTicker = startScheduledTaskLoop({ db, loadConfig: () => loadConfig(Paths.config), buildLaunch: (owner, scheduledTaskId) => async (body) => (await startTask(body, { ...buildStartTaskDeps(db, Paths.config, owner), scheduledTaskId })) })`；shutdown 闭包加 `scheduledTaskTicker.stop()`。

## 5. 到点触发：owner-actor 合成 + 共享门禁 + 重放

`fireSchedule(db, row, buildLaunch, now)`（`services/scheduledTasks.ts`，db-only + 注入 launch，可测）：

```ts
const body = StartTaskSchema.parse(JSON.parse(row.launchPayload)) // 防御性再校验
body.name = decorateTaskName(body.name, row.scheduleSpec, now)    // `${base} · <创建者时区触发时刻>`，≤255 截断
const owner = await getUserById(db, row.ownerUserId)
if (!owner || owner.status !== 'active') throw new ValidationError('owner-inactive', ...)
const actor = buildActor({ user: owner, source: 'daemon' })       // finding: buildActor 补全 TS 形状
await assertWorkflowLaunchable(db, actor, body.workflowId)         // 共享门禁（del/forbidden/builtin → throw）
const launch = buildLaunch(row.ownerUserId, row.id)               // 闭包携 owner + scheduledTaskId
const task = await launch(body)                                   // = startTask(body, { ...deps, scheduledTaskId })
return { taskId: task.id }
```

`scheduledTaskId` **不进 `StartTask` body**（保持用户可见载荷纯净），而是经 `StartTaskDeps.scheduledTaskId?: string` 注入、在 task insert 时 stamp `tasks.scheduled_task_id`（`services/task.ts:893` 邻域加一字段）。`buildLaunch(ownerUserId, scheduledTaskId)` 闭包把二者塞进 deps：`(body) => startTask(body, { ...buildStartTaskDeps(db, cfg, ownerUserId), scheduledTaskId })`。collaborators 的 active 校验在 `startTask` 内 `recordLaunchContext`（任一非 active → `invalid-collaborator` → 回滚 → 被 catch 记失败）。**RFC-099 prompt 隔离**：`scheduled_task_id` 是运行属性、**绝不进 agent prompt**（与 owner 归属同规矩，rfc099-prompt-isolation 测试面覆盖）。

**复用现有门禁原语**（经共享 `assertWorkflowLaunchable`，与 route 同源，零 fork）。`canViewResource` 不读 `actor.permissions` 但查 `resource_grants`，`buildActor` 保证 `user.id/user.role` 齐备（设计门核实）。

## 6. 前端

**（a）启动表单「存为定时」**（`routes/workflows.launch.tsx`）：「启动」旁加 `.btn` 次要动作「存为定时任务」→ `<ScheduleDialog>`（`<Dialog>`）：`<Field label=名称><TextInput/></Field>` + `<Field group label=周期><Segmented options={间隔|每天|每周|每月}/></Field>` + 分支字段（interval：`<NumberInput/>`+`<Select unit/>`；daily/weekly/monthly：`<TextInput type=time at/>` +（weekly）星期多选 `<Segmented multi>` /（monthly）`<NumberInput dayOfMonth/>`）+「下次 3 次触发」创建者时区预览 + `<Switch enabled/>`。**时区**创建时经 `Intl.DateTimeFormat().resolvedOptions().timeZone` 捕获写入 spec（UI 显示"按你的本地时区 <tz>"）。确认时用**同一** `buildLaunchBody*`（`lib/launch-repo-source.ts`）生成 `launchPayload`，`POST /api/scheduled-tasks`。**必填 upload 工作流**：`workflow.definition.inputs` 有 `kind:'upload' && required` → 「存为定时」`disabled` + `<Field hint>` 提示（前端挡 + 后端兜底）。

**（b）`/scheduled` 列表**（新 `routes/scheduled.tsx`，抄 `routes/tasks.tsx`）：`.page`/`.page__header--row`；`useQuery(['scheduled-tasks','list'])`；`LoadingState`→`ErrorBanner`→`EmptyState`→`.data-table`（列：名称/workflow/周期摘要/`<Switch enabled>`/下次触发/`<StatusChip lastStatus>`）；行点击 → `/scheduled/$id`；行内启停/删除 `e.stopPropagation()`。「新建」→ 导航 `/workflows`。

**（c）`/scheduled/$id` 详情**（新 `routes/scheduled.$id.tsx`，抄 `memory.distill-jobs.$jobId.tsx` + `DetailLayout`）：配置 + 编辑（名称/周期/启用，`PUT`）；下次触发；**最近一次**（`last_status` chip + `last_error` + `last_task_id`→`/tasks/$id`）；**已因连续失败停用**醒目态（finding 9）；**触发历史** = `useQuery(['tasks', {scheduledTaskId}])` → `GET /api/tasks?scheduledTaskId=` 的 task 列表（实时状态、点进）；`<ConfirmButton danger>` 删除。

**（d）WS**（`WS_PATHS.scheduledTasks='/ws/scheduled-tasks'`）：RFC-152 `ChannelSpec` 加项（owner/admin gatedSubscribe）；server create/update/delete/fire/auto-disabled broadcast；前端 `useScheduledTaskWs`（抄 `useMemoryDistillJobWs`+`useWsInvalidation`）失效 list/detail。

**（e）导航 + i18n**：`lib/nav.ts` tasks 组加 `{ to:'/scheduled', i18nKey:'nav.scheduled' }`；`router.tsx` 注册（detail 在 list 前）；`en-US.ts`/`zh-CN.ts` 加 `nav.scheduled`（Scheduled/定时任务）+ 全文案键。

## 7. 与现有模块的耦合点

- **`StartTaskSchema`**——复用为 `launchPayload` 校验（新消费者，契约不变）。
- **`startTask` / `StartTaskDeps`**——加 `scheduledTaskId?: string`（task insert stamp `tasks.scheduled_task_id`）；owner 注入点不变。
- **`tasks` 表 + `TaskSchema`/`TaskSummarySchema`**——加 `scheduledTaskId` 列/字段（全字段锁测试 bump）；`GET /api/tasks` 加 `scheduledTaskId` 过滤。
- **门禁原语**——抽 `assertWorkflowLaunchable` 供 JSON/multipart route + scheduler 共用（route 改为调它，**保行为字节等价 + 测试锁**）。
- **deps 构造**——抽 `buildStartTaskDeps(db, configPath, actorUserId)`（route + scheduler 共用，per-call live config；`resolveSubagentLiveCapture` 从 route-local 上提；`db` 显式入参，见 R2-e）。
- **`lib/launch-repo-source.ts`**——只复用不改。
- **`cli/start.ts` 第 8 段 + shutdown 闭包**——加 2 行。
- **`config`**——加 `scheduledTasksEnabled`(default true) + `scheduledTasksMaxFailures`(default 10)，loop 每 tick 经 thunk 读 live。
- **RFC-152 WS 注册表 / `WS_PATHS`**——加一 ChannelSpec + 一路径。
- **不碰**：`task_collaborators` / `services/scheduler.ts`(runner) / opencode 注入 / RFC-099 五类 ACL 表。

## 8. 失败模式

| 场景 | 处理 |
| --- | --- |
| `launchPayload` 非法 | 创建 422；触发时行损坏 → `scheduled-task-row-corrupt` catch→记失败 |
| 创建/更新引用不可见/内置/已删 workflow | **create/update 时** `assertWorkflowLaunchable` → 404，不落库（R2-b：不容「建了到 fire 才失败」的探测/延迟失败） |
| workflow 有必填 upload 输入 | 创建 422 `scheduled-task-upload-required`（前端禁用入口）；可选 upload 放行 |
| ScheduleSpec 非法（时区/HHMM/dayOfWeek 越界） | 创建 422；前端预览即时红 |
| daemon 停机错过多槽 | CAS 前进只取 `computeNextRunAt(anchor,now)` 首个 >now 槽 → **合并为一次**，不 burst |
| 两 tick 重叠 / 慢 launch | tick `running` 只护 poll+claim；fire 经有界池异步；CAS 每槽单飞 → 不重复、不阻塞他 schedule |
| 慢/卡 launch（clone/worktree hang）大量堆积 | **R2-a**：`inFlight` 达 `SCHEDULE_MAX_IN_FLIGHT` → 后续 tick `capacity=0` 不再认领、溢出行留库待容量——在途集有界，不 OOM |
| 高频 interval 同 schedule fire 重叠 | **R2-c**：`recordFailure` 走 SQL 原子 `consecutive_failures+1` + 同句 CASE 判停用；`last_*` 时序守卫（旧 fire 迟到不覆盖新的）——不丢计数、停用判据准 |
| owner 失权/workflow 转私有/grant 撤销 | `assertWorkflowLaunchable` → `workflow-not-found` → 记失败、cf++ |
| workflow 删/内置 | `getWorkflow`null/`assertNotBuiltin` → 记失败、cf++ |
| owner 停用/删 | `owner.status!=='active'` → `owner-inactive` → 记失败 |
| collaborator 非 active | `recordLaunchContext` 抛 `invalid-collaborator` → 回滚 → catch 记失败 |
| 连续失败 ≥ max | 自动 `enabled=false` + WS `auto-disabled` + 详情页醒目态 + last_error（finding 9 可见）；用户可重新启用（cf 归零） |
| 崩溃在 CAS 后、fire 前/中 | 该槽已前进（至多一次）；已建 task 由 `scheduled_task_id` reconcile，无 orphan（finding 1 修复） |
| 事后 record UPDATE 失败 | 真身已在 `tasks.scheduled_task_id`；last_\* 缓存不准但历史/次数以 tasks 为准 |
| DST gap/overlap（预设时刻） | **R2-d**：`zonedWallClockToEpoch` 回环校验判 gap → 顺延至 spring-forward 后有效瞬间（非 naive 二次偏移的往回落）；overlap 取前；`America/New_York` fixture 锁 |
| 每月缺该日（如 2 月 31） | 跳过该月，取下个有该日的月 |
| 全局关停 | `config.scheduledTasksEnabled=false` → tick 直接 return |

## 9. 测试策略（Test-with-every-change 必写清单）

**shared**
- `scheduleTime.test.ts`：`computeNextRunAt` 四类——interval **锚定不漂移**（anchor+intervalMs、合并 missed、tick 延迟不累积）；daily/weekly/monthly 在给定时区算下次；**DST fixture**（如 `America/New_York` 2026 春进/秋退：gap 顺延、overlap 取前）；monthly 缺日跳月；`tzOffsetMs`/`zonedWallClockToEpoch` 边界。
- `scheduledTask.test.ts`：`ScheduleSpecSchema` 四判别正/拒（HHMM 格式、dayOfWeek/dayOfMonth 越界、非法时区）；`Create/Update` schema。

**backend**
- `scheduled-tasks-crud.test.ts`：create 校验 `launchPayload`(StartTaskSchema) / **创建时 `assertWorkflowLaunchable`（不可见/内置/删 → 404，R2-b）** / **必填 upload 422、可选 upload 放行** / spec 校验 / 初始 next_run_at；update 重算 + cf 归零 + launchPayload 变更再门禁；owner/admin 门禁；`rowToView` 损坏抛错。
- `scheduled-tasks-acl.test.ts`：非 owner 非 admin 列表过滤 + 详情 404；`tasks:read:all` 全见。
- `scheduled-task-scheduler.test.ts`（注入 fake launch + 真 in-memory db）：pollAndClaim 选 due + **CAS 前进先于 fire**（源码顺序 + 行为）；**有界并发 + 背压**（慢 launch 不阻塞他 schedule、running 立即释放、`inFlight` 达 `SCHEDULE_MAX_IN_FLIGHT` 后 tick 不再认领、溢出行留库——R2-a）；**原子记账**（并发同 schedule 两 fire 各失败 → cf==2 不丢、跨阈值恰一次自动 disable+WS；旧 fire 迟到不覆盖新 last_\*——R2-c）；成功记 launched + `tasks.scheduled_task_id` 原子 stamp；各失败路径（owner-inactive/workflow-not-found/forbidden/builtin/invalid-collaborator）记 failed+cf++；缺席合并为一次；`scheduledTasksEnabled=false` 短路。
- `task-launch-gate.test.ts`：`assertWorkflowLaunchable` 三处（JSON/multipart/scheduler）**行为等价**（del/forbidden/builtin 各 case）；route 改造前后字节等价锁。
- `start-task-deps.test.ts`：`buildStartTaskDeps` 每次读 live config（改 config 后 route 与 scheduler 一致）。
- `tasks-scheduled-link.test.ts`：`startTask` 带 `scheduledTaskId` dep → `tasks.scheduled_task_id` 落库；`GET /api/tasks?scheduledTaskId=` 过滤 + `canViewTask` 门禁。
- `upgrade-rolling.test.ts` journal 79→80；migration-0080 冒烟（两表结构 + `tasks.scheduled_task_id` + 索引）；既有 task 全字段锁 bump。

**frontend（vitest）**
- 纯函数预言：`scheduleSummary(spec)`（周期摘要双语）、`decorateTaskName`（≤255 截断）、下次触发预览——抽出单测。
- `ScheduleDialog`：Segmented 四模式切换 + 字段；时区捕获显示；必填 upload 禁用「存为定时」+ 提示；确认发 `buildLaunchBody` body。
- `/scheduled` 列表/详情：三态；启停 `PUT`；删除 ConfirmButton；触发历史列表（tasks by scheduledTaskId）；自动停用醒目态。
- 源码文本锁：`/scheduled` 无原生 `<select>`/`<input className="form-input">`。

## 10. 迁移

单迁移 `0080_rfc159_scheduled_tasks.sql`：建 `scheduled_tasks` + 两索引 + `ALTER tasks ADD scheduled_task_id` + 索引（纯增，无 backfill、无存量清洗——既有 task 的 `scheduled_task_id` 恒 NULL=手动启动，语义正确）。启动即建（flock 单实例、启动迁移，无旧代码写库窗口）。回滚：删列删表（无外键指向）。
