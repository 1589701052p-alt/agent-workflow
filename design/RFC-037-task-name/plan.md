# RFC-037 — 实施计划

> 配套 [proposal.md](./proposal.md) + [design.md](./design.md)。单 PR，按任务顺序写代码 + 测试。

## 拆分原则

**单 PR 合并**。本 RFC 改动收敛：1 列 + 3 schema + 3 backend service + 3 route + ~6 frontend file + 13 i18n key + 35+ 测试 + 25–40 fixture 补丁。一次提交评审更省心，回退也是单 commit `git revert`。

## 任务列表

按"shared schema → DB / drizzle → backend service → backend route → frontend launcher → frontend tasks page → 全链路 inbox/clarify/review → fixture 全套补 → 跑通三件套"顺序。

### RFC-037-T1 — shared schemas

- `packages/shared/src/schemas/task.ts`：加 `TaskNameSchema` 常量；`TaskSchema` / `TaskSummarySchema` 加 `name: z.string()`；`StartTaskSchema` 加 `name: TaskNameSchema`（必填，trim, 1..255）。
- `packages/shared/src/schemas/clarify.ts`：`ClarifySessionSummarySchema` 加 `taskName: z.string()`。
- `packages/shared/src/schemas/review.ts`：`ReviewSummarySchema` 加 `taskName: z.string()`。
- 测试：`packages/shared/tests/task-name-schema.test.ts`（7 case）+ `clarify-review-task-name-schema.test.ts`（4 case）。

### RFC-037-T2 — DB migration + drizzle schema

- 新文件 `packages/backend/db/migrations/0021_rfc037_task_name.sql`（design.md §2 内容）。
- `packages/backend/src/db/schema.ts`：`tasks` 表 `name: text('name').notNull()`，位置贴近 `branch` / `baseBranch`。
- 验证：`bun run drizzle-kit generate` 产物与手写 sql 一致（不一致按手写 sql 修 schema.ts）。
- 测试：`packages/backend/tests/migration-0021.test.ts`（3 case，覆盖回填两种 fallback + 列存在）。

### RFC-037-T3 — backend service：startTask + rowToTask + rowToSummary

- `packages/backend/src/services/task.ts`：
  - INSERT 列表加 `name`，values 接入 `input.name`（已被 schema trim）。
  - `rowToTask` / `rowToTaskSummary` 透传 `name: row.name`。
- `packages/backend/src/services/taskCollab.ts`：若有自定义 SELECT 也带上 name 列（沿用 `tasks.*` 即可，本来就 SELECT 全列）。
- 测试：`packages/backend/tests/tasks-list-and-get-name.test.ts`（2 case：list + single 都含 name 且等于 INSERT 时的 trim 值）。

### RFC-037-T4 — backend service：clarify + review summary join taskName

- `packages/backend/src/services/clarify.ts`：`listClarifySummaries` 在既有 `loadAgentNodeTitlesByTask` 调用旁加一个 `loadTaskNamesByTask`，按 `taskId → name` 写到每行 `taskName`；`getClarifySession` 单行路径同步 join。
- `packages/backend/src/services/review.ts`：`listReviewSummaries` 加 LEFT JOIN tasks 拿 name，rowToSummary 塞 `taskName`。
- 测试：`packages/backend/tests/clarify-service-task-name.test.ts`（2 case）+ `review-service-task-name.test.ts`（1–2 case）。

### RFC-037-T5 — backend route：POST /api/tasks 全路径校验

- `packages/backend/src/routes/tasks.ts`：JSON body + multipart 分支都走 `StartTaskSchema.safeParse`，error 422 标准化。
- multipart 分支显式从 `formData.get('name')` 读出字段后并入对象再 parse。
- 测试：`packages/backend/tests/tasks-create-name.test.ts`（8 case：JSON + multipart 各种 happy + 422 path）。

### RFC-037-T6 — frontend launcher：name 字段 + 提交路径

- `packages/frontend/src/routes/workflows.launch.tsx`：加 state + 顶部 Field + `canSubmit` 加 `nameReady`；三条提交路径都串入 `name`。
- `packages/frontend/src/lib/launch-repo-source.ts`：`buildLaunchBody` / `buildLaunchFormDataV2` 签名 + 实现加 name。
- `packages/frontend/src/components/launch/buildLaunchFormData.ts`：multipart 加 `formData.append('name', name)`。
- 测试：`launch-task-name-required.test.tsx`（4 case）+ `launch-task-name-submit-paths.test.ts`（4 case）。

### RFC-037-T7 — frontend tasks 列表：Linear 风

- `packages/frontend/src/routes/tasks.tsx`：列顺序改 `Name / Workflow / Status / Started / Repo / Error`，name 单元格内含副标题 short id。
- `packages/frontend/src/styles.css`：新增 `.task-name-cell` 三条选择器。
- 测试：`tasks-list-name-column.test.tsx`（4 case：首列文本 / 副标题 / column 顺序 / empty state 文案不变）。

### RFC-037-T8 — frontend task detail：H1

- `packages/frontend/src/routes/tasks.detail.tsx`：H1 改 `task.name`，ID 副标题；tab title 同步（若现有 `useDocumentTitle`）。
- 测试：`tasks-detail-h1.test.tsx`（2 case：H1 文本 / ID 副标题渲染）。

### RFC-037-T9 — inbox / clarify / review 链路

- `packages/frontend/src/lib/homepage.ts`：`mergeInboxItems` clarify + review 行透传 `taskName`。
- `packages/frontend/src/components/shell/InboxDrawer.tsx`：每行渲染 task name chip。
- `packages/frontend/src/routes/clarify.tsx` / `clarify.detail.tsx`：列表 + 详情显示 task name。
- `packages/frontend/src/routes/reviews.tsx` / `reviews.detail.tsx`：同上。
- 测试：`inbox-drawer-task-name.test.tsx`（2 case）+ `homepage-lib-task-name.test.ts`（2 case）+ 各 route 视具体已有测试形态决定追加 1–2 case。

### RFC-037-T10 — i18n keys 中英对称

- `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts`：加 design.md §5.5 列出的 13 key。
- `Resources` interface 同步扩展。
- 测试：`i18n-task-name-keys.test.ts`（含 5 case 校验 keys 存在 + 文案非空 + 中英 union 等价）。

### RFC-037-T11 — fixture 全套补丁

- 跑 `bun run typecheck` 拿到所有红点；逐个把 task / TaskSummary / ClarifySessionSummary / ReviewSummary literal 补上对应字段（建议默认值：`name: 'fixture-task'`、`taskName: 'fixture-task'`）。
- 跑 `bun run test`：把行号红测全部喂到 `name` / `taskName` 缺失的 fixture，补字段。
- 估计 25–40 文件改动；不要为了"清理"动其它字段。

### RFC-037-T12 — 三件套校验 + 收尾

- 本地：`bun run typecheck && bun run test && bun run format:check`。
- commit 前 `git status` 确认 working tree 没碰到他人 untracked。commit message 形态：

  ```
  feat(tasks): RFC-037 任务名称必填 + 全链路呈现

  - tasks 表新增 name NOT NULL 列 + 0021 migration 回填 workflowName/兜底 task-{shortId}
  - shared TaskSchema / TaskSummarySchema / StartTaskSchema / ClarifySessionSummarySchema / ReviewSummarySchema 加 name|taskName 必填
  - launcher 表单顶部任务名输入框 + 三条提交路径串入 + 422 兜底
  - tasks 列表 Linear 风（Name 首列 + ID 副标题）
  - detail 页 H1 = task.name
  - inbox/clarify/review 全链路透传 taskName
  - 测试 +35 一次过；fixture 全套补字段；零退化

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```

- push 后查 GitHub Actions HEAD CI（per [feedback_post_commit_ci_check]）。
- STATE.md 把 RFC-037 行从"进行中"挪到"已完成"段，commit hash 落入。
- design/plan.md RFC 索引 RFC-037 状态 Draft → Done。

## 依赖

无前置依赖。RFC-036 已落 origin/main，本 RFC 独立。

## Acceptance checklist

- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] GitHub Actions HEAD CI 六 jobs 全绿
- [ ] DB migration 0021 跑后老 task 行 `name` 非空
- [ ] POST /api/tasks 缺 name / 纯空白 → 422
- [ ] POST /api/tasks 含 `"  hello  "` → 入库 `"hello"`
- [ ] POST /api/tasks 含 256 字符 → 422
- [ ] GET /api/tasks 与 GET /api/tasks/:id 响应含 `name`
- [ ] GET /api/clarify 与 GET /api/reviews 响应行含 `taskName`
- [ ] `/workflows/$id/launch` 表单顶部有任务名输入框，必填校验生效
- [ ] `/tasks` 列表首列 Name，ID 在副标题
- [ ] `/tasks/$id` H1 = task.name
- [ ] inbox drawer / clarify 列表 / clarify 详情 / reviews 列表 / reviews 详情都显示 task name
- [ ] 中英 i18n 对称 + Resources 接口同步
- [ ] 既有套件零退化（fixture 补完后所有原测试通过）
- [ ] 多人 working tree 安全（未追踪文件不动）
- [ ] STATE.md / plan.md 同步落 Done

## Rollback

单 commit `git revert <sha>`。DB 列 `name` 可保留（drizzle schema 回退后该列变成 unused，下次 migration 再处理；保留比删更安全）。所有应用层 / 前端 / WS 路径回退后老行为完全恢复。
