# RFC-037 — 技术设计

> 配套 [proposal.md](./proposal.md)。proposal 钉产品意图，本文件钉技术契约 + 文件级落点。

## 1. 模块拓扑

```
packages/backend/
  db/migrations/
    0021_rfc037_task_name.sql        # ALTER TABLE tasks ADD name + 回填 SQL
  src/
    db/schema.ts                     # tasks.name 列声明
    services/
      task.ts                        # startTask 写 name；rowToTask 透传 name；rowToSummary 透传 name
      clarify.ts                     # listClarifySummaries join tasks.name
      review.ts                      # listReviewSummaries join tasks.name
      taskCollab.ts                  # 协作可见性列表也带 taskName（如有 join）
    routes/
      tasks.ts                       # POST 走 StartTaskSchema 校验；multipart 分支显式读 name 字段
packages/shared/src/
  schemas/
    task.ts                          # TaskSchema/TaskSummarySchema/StartTaskSchema 加 name
    clarify.ts                       # ClarifySessionSummarySchema 加 taskName
    review.ts                        # ReviewSummarySchema 加 taskName
packages/frontend/src/
  routes/
    workflows.launch.tsx             # 任务名输入框 + canSubmit 加 name 校验
    tasks.tsx                        # Linear 风列表 first col = Name, ID 副标题
    tasks.detail.tsx                 # H1 = task.name，ID 副标题
    clarify.tsx / clarify.detail.tsx # 列表 / 详情显示 taskName
    reviews.tsx / reviews.detail.tsx # 列表 / 详情显示 taskName
  lib/
    launch-repo-source.ts            # buildLaunchBody / buildLaunchFormDataV2 串入 name
    homepage.ts                      # mergeInboxItems clarify+review 行追加 taskName 透传
  components/
    launch/buildLaunchFormData.ts    # multipart 形态串入 name
    shell/InboxDrawer.tsx            # clarify+review 两行渲染 taskName
  i18n/{en-US,zh-CN}.ts              # 新 keys：launch.fieldTaskName/Hint, tasks.colName,
                                     # tasks.detailTitleId, inbox.taskName, clarify.taskName, review.taskName
```

不动模块：runner / scheduler / workflow editor / opencode plugin / WS broadcaster 内部 / git wrapper / loop wrapper / mcp / oidc / auth middleware。

## 2. DB 设计

### Migration 0021_rfc037_task_name.sql

```sql
-- step 1: 加列允许空，回填，再改 NOT NULL（SQLite 不支持 ALTER COLUMN，走 PRAGMA 复制重建）。
-- 简化版：SQLite 允许 ALTER ADD 带 DEFAULT 常量 + NOT NULL（仅当 DEFAULT 非动态表达式时合法）。
-- 我们先 ADD 允许空、UPDATE 回填、然后在 drizzle schema 里声明 NOT NULL。
-- 老行在 runtime 经过 zod parse 时若回填遗漏会 422；SQL 兜底确保不出现空值。

ALTER TABLE `tasks` ADD `name` text;
--> statement-breakpoint
UPDATE `tasks`
SET `name` = COALESCE(
  (SELECT `name` FROM `workflows` WHERE `workflows`.`id` = `tasks`.`workflow_id`),
  'task-' || substr(`id`, -10)
)
WHERE `name` IS NULL OR `name` = '';
```

> **为什么不在 SQL 层落 NOT NULL** —— SQLite 给已有表加 NOT NULL 列必须走表重建（PRAGMA writable_schema 或 CREATE TABLE \_new + INSERT SELECT + DROP + RENAME），改动面太大。drizzle schema 声明 NOT NULL + zod 必填 + 应用层写入路径全部强制非空 → 运行时不会再产生空值。回填 SQL 已经把所有老行填满，列实质上是 NOT NULL。

### Drizzle schema 改动

```ts
// packages/backend/src/db/schema.ts — tasks 表声明追加：
name: text('name').notNull(),
```

放在 `schemaVersion` 之前、与 `branch` / `baseBranch` 同段（保持表声明顺序贴近表语义）。

### 索引

不加索引。本 RFC 不支持按 name 搜 / 排序；name 仅在 SELECT 时透传。

## 3. Shared schema

### `packages/shared/src/schemas/task.ts`

```ts
const TASK_NAME_MAX = 255

export const TaskNameSchema = z
  .string()
  .trim()
  .min(1, 'name must not be empty')
  .max(TASK_NAME_MAX, `name must be ≤ ${TASK_NAME_MAX} chars`)

export const TaskSchema = z.object({
  id: z.string(),
  name: z.string(),                  // 已 trim 持久化值，可信
  workflowId: z.string(),
  // ... 既有字段不动
})

export const TaskSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  workflowId: z.string(),
  workflowName: z.string().nullable(),
  // ... 既有字段不动
})

export const StartTaskSchema = z
  .object({
    workflowId: z.string().min(1),
    name: TaskNameSchema,            // 必填 + trim + 长度上限
    repoPath: z.string().min(1).optional(),
    // ... 既有字段不动
  })
  .superRefine((value, ctx) => { /* 既有 path/url 互斥校验不动 */ })
```

> **trim 语义**：`TaskNameSchema` 用 `z.string().trim().min(1)` —— zod 在 parse 时先 trim 再 min 校验，所以 `"   "` → `""` → 触发 `min(1)` 错误。后端拿到的 `name` 永远是 trim 后非空字符串，可以无脑 INSERT。

### `packages/shared/src/schemas/clarify.ts`

```ts
export const ClarifySessionSummarySchema = z.object({
  // ... 既有字段
  taskName: z.string(),              // 新字段，必填；后端 join tasks.name 透传
  // sourceAgentNodeTitle 等之前加的可选字段位置不变
})
```

### `packages/shared/src/schemas/review.ts`

```ts
export const ReviewSummarySchema = z.object({
  // ... 既有字段
  taskName: z.string(),              // 新字段，必填；后端 join tasks.name 透传
})
```

> **为什么必填而非可选**：proposal §2 已锁定 "name NOT NULL"。所有 task 行都有 name；list / single 任何路径返出的 summary 都能拿到。可选字段反而让前端写一堆 `?? ''` fallback，越脏越多。

## 4. 后端

### 4.1 `services/task.ts`

- `StartTaskInput` 类型已经由 shared `StartTaskSchema` 推导；`startTask(input, deps)` 在已有 path/url 解析逻辑前 / 后任何位置都 OK，但要把 `name = input.name` 写进 INSERT。
- `INSERT INTO tasks (id, name, workflow_id, ...)` 显式列名 + 把 name 加进 values 数组。
- `rowToTask(row)` / `rowToTaskSummary(row)` 在返回对象时透传 `name: row.name`。
- 422 path 回滚逻辑不动（name 校验在 schema 层就已经返 422，不会进 INSERT）。

### 4.2 `services/clarify.ts`

- `listClarifySummaries` 现有的 `loadAgentNodeTitlesByTask` 已经一次拉所有相关 tasks 行解 snapshot 抽 title。本次同一个 SELECT 直接同时取 `tasks.name`，map 成 `taskId → name`，在 `rowToSummary` / `sessionToSummary` 路径上一并塞 `taskName`。
- 单 session 路径（`getClarifySession`）：需要 join `tasks.name` —— 之前没有这个 join 的话本次加一个 LEFT JOIN tasks 拿 name；理论上 task 必存，LEFT JOIN 是为了不让 INNER JOIN 在边界 task 已被硬删的情况下吞掉行。

### 4.3 `services/review.ts`

- `listReviewSummaries` 同上：join `tasks.name`，rowToSummary 塞 `taskName`。

### 4.4 `routes/tasks.ts`

- POST handler 走 `StartTaskSchema.safeParse(body)` → 自动覆盖。
- multipart 分支（既有 RFC-020 upload 用）：从 form-data 读 `name` 字段（`form.get('name')`），与其它字段一起组装成对象再走 `StartTaskSchema`。前端 `buildLaunchFormData{,V2}` 已经写入 `formData.append('name', name)`。

### 4.5 不动

- WS broadcaster：`broadcaster.task.update` 等通道 payload 直接序列化 task row，新字段自动随附；前端 `useTasksSync` 走 zod parse 也会拿到。
- multi-user 可见性（RFC-036）：完全沿用现有 owner / collaborator 过滤；新字段只是结果集多一列。

## 5. 前端

### 5.1 launcher (`routes/workflows.launch.tsx`)

新增 state：

```ts
const [taskName, setTaskName] = useState('')
```

表单顶部（在 `<RepoSourceTabs>` **之前**）插入：

```tsx
<Field
  label={t('launch.fieldTaskName')}
  required
  hint={t('launch.fieldTaskNameHint')}
>
  <TextInput value={taskName} onChange={setTaskName} required maxLength={255} />
</Field>
```

`canSubmit` 加项：

```ts
const nameReady = taskName.trim().length > 0
const canSubmit = nameReady && sourceReady && !missingRequired && repoIssue === null && !start.isPending
```

提交三条路径都补 name：

```ts
// JSON 路径：
return api.post<Task>('/api/tasks', buildLaunchBody(source, { workflowId: id, name: taskName, inputs }))

// path-mode multipart：
const payload = { workflowId: id, name: taskName, repoPath, baseBranch, inputs }
return api.postMultipart<Task>('/api/tasks', buildLaunchFormData(payload, uploads))

// url-mode multipart：
return api.postMultipart<Task>(
  '/api/tasks',
  buildLaunchFormDataV2(source, { workflowId: id, name: taskName, inputs }, uploads),
)
```

`lib/launch-repo-source.ts` 的 `buildLaunchBody` / `buildLaunchFormDataV2` 签名加 `name` 字段；前者把 name 塞进 body object，后者 `formData.append('name', name)`。`components/launch/buildLaunchFormData.ts` 同形。

### 5.2 tasks 列表 (`routes/tasks.tsx`)

列顺序改为：`Name / Workflow / Status / Started / Repo / Error`（最左去掉独立 ID 列，ID 折进 Name 单元格副标题）。

```tsx
<thead>
  <tr>
    <th>{t('tasks.colName')}</th>
    <th>{t('tasks.colWorkflow')}</th>
    <th>{t('tasks.colStatus')}</th>
    <th>{t('tasks.colStarted')}</th>
    <th>{t('tasks.colRepo')}</th>
    <th>{t('tasks.colError')}</th>
    <th aria-label="actions" />
  </tr>
</thead>
<tbody>
  {data.map((row) => (
    <tr key={row.id}>
      <td className="task-name-cell">
        <Link to="/tasks/$id" params={{ id: row.id }} className="data-table__link task-name-cell__name">
          {row.name}
        </Link>
        <code className="task-name-cell__id" title={row.id}>
          {row.id.slice(-10)}
        </code>
      </td>
      {/* 其它 td 顺序不变 */}
    </tr>
  ))}
</tbody>
```

新增 css 类（追加到 `styles.css`）：

```css
.task-name-cell { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.task-name-cell__name { font-weight: 500; word-break: break-word; }
.task-name-cell__id { font-size: var(--font-xs); color: var(--text-muted); }
```

### 5.3 task detail (`routes/tasks.detail.tsx`)

H1 改为 `task.name`；副标题加一行 `#<full id>` + copy 按钮（沿用既有 `<CopyButton>` 如存在，否则简单 `<code>`）。浏览器 tab title 同步：现有逻辑（如有 useDocumentTitle）值改为 `task.name`，无则不强加。

### 5.4 inbox / clarify / review 联动

- `lib/homepage.ts mergeInboxItems`：clarify+review 两条分支生成的 row 加 `taskName` 字段；类型在前端本地 type 里同步声明。
- `components/shell/InboxDrawer.tsx`：每行渲染 `<span className="inbox-row__task">{row.taskName}</span>` chip，紧邻原 source/title。
- `routes/clarify.tsx` / `routes/clarify.detail.tsx`：列表行 + 详情顶部增加 task name 标题。
- `routes/reviews.tsx` / `routes/reviews.detail.tsx`：同上。

### 5.5 i18n keys（中英对称）

新增 13 key（不重新换全套）：

```
launch.fieldTaskName              "任务名称" / "Task name"
launch.fieldTaskNameHint          "用于在列表 / 收件箱里区分本次任务，最多 255 字符。" / "Used to distinguish this task in lists and inbox. Up to 255 chars."
launch.errorTaskNameRequired      "请填写任务名称" / "Task name is required"
tasks.colName                     "名称" / "Name"
tasks.detailTitleIdLabel          "任务 ID" / "Task ID"
inbox.taskNamePrefix              "任务" / "Task"
clarify.taskNameLabel             "所属任务" / "Task"
review.taskNameLabel              "所属任务" / "Task"
common.copy                       "复制" / "Copy"        # 可能已存在，若已存在跳过
```

落 `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts`；`Resources` 接口同步扩展。`tests/i18n-keys-symmetry.test.ts` 自动卡死中英对称。

## 6. 测试策略

总量目标 ≥ 35（实际可能 40+）。覆盖矩阵：

### 6.1 shared（≥ 7）

`packages/shared/tests/task-name-schema.test.ts`

- `TaskNameSchema` parse `"hello"` OK，得 `"hello"`
- parse `"  hello  "` OK，得 `"hello"`
- parse `""` → fail（min 1）
- parse `"   "` → fail（trim 后 min 1）
- parse 256 字符 → fail
- parse 255 字符 → OK
- `StartTaskSchema` 缺 name → fail；含 name → OK；name+repoPath+baseBranch 一起 OK

`packages/shared/tests/clarify-review-task-name-schema.test.ts`

- `ClarifySessionSummarySchema` 缺 taskName → fail；含 taskName → OK
- `ReviewSummarySchema` 同形

### 6.2 backend（≥ 14）

`packages/backend/tests/migration-0021.test.ts`

- 跑 0020 + 写老 task 行（无 name 列）→ 跑 0021 → 老行 name = workflowName
- 老行对应 workflow 已删 → name = `task-{last10}`
- ALTER ADD column 后再 INSERT 不带 name 列（用旧应用层）→ runtime 路径 422，不靠 DB 防御（设计上的契约，单测点醒未来读者）

`packages/backend/tests/tasks-create-name.test.ts`

- POST 缺 name → 422 `validation`
- POST `name: ''` → 422
- POST `name: '   '` → 422
- POST `name: '  hello  '` → 201 + DB 存 `'hello'`
- POST `name: 'x'.repeat(256)` → 422
- POST `name: 'x'.repeat(255)` → 201
- POST multipart 缺 name → 422
- POST multipart name → 201 + DB 存 trim 值

`packages/backend/tests/clarify-service-task-name.test.ts`

- `listClarifySummaries` 每行 `taskName` 等于 `tasks.name`
- 单 session 路径 `getClarifySession` 返回结构含 `taskName`

`packages/backend/tests/review-service-task-name.test.ts`

- `listReviewSummaries` 每行 `taskName` 等于 `tasks.name`

`packages/backend/tests/tasks-list-and-get-name.test.ts`

- GET `/api/tasks` 每行含 `name`
- GET `/api/tasks/:id` 含 `name`

### 6.3 frontend（≥ 12）

`packages/frontend/tests/launch-task-name-required.test.tsx`

- 渲染 launcher，name 空 → Start disabled
- 填 name `"   "` → Start disabled（trim 后空）
- 填 name `"hello"` → Start enabled（前置 sourceReady 满足时）
- 填超过 255 字符 → 输入框 maxLength 截断（断言 DOM value 长度 ≤ 255）

`packages/frontend/tests/launch-task-name-submit-paths.test.ts`

- JSON 路径 mutate body 含 `name`
- path-mode multipart formData 含 `name` 字段
- url-mode multipart formData 含 `name` 字段
- `buildLaunchBody` / `buildLaunchFormDataV2` / `buildLaunchFormData` 三函数签名快照（pure unit test）

`packages/frontend/tests/tasks-list-name-column.test.tsx`

- 列表渲染 `data` 含 name → first col 是 name，second col 是 workflowName
- 同 row 含 short id 副标题（slice -10）
- 没数据时 EmptyState 文案不变

`packages/frontend/tests/tasks-detail-h1.test.tsx`

- detail 页 H1 = task.name
- ID 副标题含完整 ID

`packages/frontend/tests/inbox-drawer-task-name.test.tsx`

- mock clarify/review summary 含 taskName → drawer 显示 chip 文本
- taskName=undefined（旧后端 fallback 路径）→ 退到 task short id（兜底）

`packages/frontend/tests/homepage-lib-task-name.test.ts`

- `mergeInboxItems` clarify + review 行透传 `taskName`

`packages/frontend/tests/i18n-task-name-keys.test.ts`

- 中英 keys 全部存在 + 文案非空
- 既有 i18n symmetry test 自动覆盖（无需重写）

### 6.4 e2e（可选 1 case，本 PR 不强增）

如果时间允许：`e2e/main.spec.ts` 在 "Launch task → see task detail" path 里加 fill task name + 断言 H1 文本。**非验收必要**，留作改动到 main.spec 时顺手补。

### 6.5 fixture 批量更新

所有以下 fixture 都要补 `name` 字段（具体行内补 `'fixture-task'` 或贴近上下文的字符串，让套件零退化）：

- `packages/frontend/tests/**/*.{ts,tsx}` 中含 `TaskSummary` / `Task` literal 的位置
- `packages/backend/tests/**/*.ts` 中 INSERT `tasks` 或 mock task row 的位置
- `packages/shared/tests/**/*.ts` 中 task fixture

预计影响 25–40 个测试文件 fixture 加字段。

## 7. 失败模式

| 场景                                       | 行为                                                  |
| ------------------------------------------ | ----------------------------------------------------- |
| 老脚本调 POST 不传 name                    | 422 + validation 错误体，明确指向 `name` 字段        |
| 前端表单 name 空但绕过 disabled 提交       | 后端 422，前端 mutate.error 渲染 ErrorBanner          |
| migration 跑到一半被 kill                  | SQLite 事务回滚；已有列保留为 NULL，下次启动重跑      |
| migration 后某些行 name = `task-xxxxxxxxx` | 视作"匿名老任务"，列表 + detail 仍然渲染该值          |
| name 包含 emoji / 中文 / 特殊符号          | 按 utf-8 存；前端按 plain text 渲染，不做 markdown    |
| WS 推送字段缺失（理论不可能）              | 前端 zod parse 报错 → useEffect 里 onError 安静打日志 |

## 8. 兼容与回退

- **API**：`POST /api/tasks` 新增 required field 是 **breaking change for automation clients**。本 RFC 接受这个破坏（用户已确认）。release notes 必须列出来。
- **DB**：migration 单向，回退路径是删列 + 重写 schema（手工，不写自动 down migration —— 本仓既有惯例）。
- **多人协作**：合 PR 时若主干已有别人改了 `task.ts` schema 或加了 task 字段，rebase 优先保留对方改动，本 RFC 字段插在 schema 末尾即可避免冲突。

## 9. 与其它 RFC 的兼容

- **RFC-005 human review** / **RFC-013 review historical versions**：review summary 新加 taskName 字段，不影响 reviewDocVersion 内部数据流。
- **RFC-023 agent clarify** / **RFC-026 inline session**：clarify summary 新加 taskName，sourceAgentNodeTitle 已存在的可选字段位置不变，老客户端忽略新字段不会报错（zod 默认行为）。
- **RFC-024 launch from git URL**：name 字段独立于 repo 来源，URL / path 两条分支等价处理。
- **RFC-032 nav redesign** / **RFC-035 UX consistency**：列表布局改用 Linear 风后，复用 `.data-table` + 新增 `.task-name-cell` 样式；按 RFC-035 命名约定加。
- **RFC-036 multi-user collab**：name 与权限 / 可见性正交；task 列表 / clarify list / review list 的 owner+collaborator 过滤逻辑不动。

## 10. 与 opencode 源码的关系

无。本 RFC 不涉及 opencode 进程 / CLI 参数 / env / XML envelope。runner / scheduler 零改动。
