# RFC-067 — 任务分解

**单 PR**。Scope 小、跨层薄、与正在进行的 RFC-064 / 065 / 066 无代码交叉，
没有理由拆分。

## 子任务

### RFC-067-T1 — Shared schema + 测试

- `packages/shared/src/schemas/task.ts`
  - `StartTaskSchema`：加 `gitUserName?` / `gitUserEmail?` 字段。
  - `superRefine` 追加 XOR + 邮箱正则两条 issue（错误码
    `git-identity-incomplete` / `git-identity-email-invalid`）。
  - `TaskSchema`：加 `gitUserName: z.string().nullable()` /
    `gitUserEmail: z.string().nullable()`。
- 新文件 `packages/shared/tests/start-task-schema-git-identity.test.ts`：
  6 case（详 design.md §5.1）。

验收：`bun --filter @agent-workflow/shared test` 全绿；3-trio 全绿。

### RFC-067-T2 — DB migration + drizzle schema

- 新文件 `packages/backend/migrations/0034_task_git_identity.sql`：
  两条 `ALTER TABLE tasks ADD COLUMN` 语句。
- `packages/backend/src/db/schema.ts`：`tasks` 表对象加 2 行
  `gitUserName` / `gitUserEmail`（`text(...)` 无 `.notNull()`）。
- `packages/backend/tests/upgrade-rolling.test.ts`：HEAD journal count
  bump（依据当前 HEAD 实际数 +1；落 PR 时再 grep 一次防与 RFC-066 等并行
  迁移撞号）。
- 新增 1 case 在 `packages/backend/tests/migration-0034-task-git-identity.test.ts`：
  pre-migration 行迁移后 git_user_name/email 都是 NULL。

**冲突预案**：若落 PR 时 HEAD migration 已到 0034，本 RFC bump 到 0035；
journal idx test 跟着改。

### RFC-067-T3 — Backend persist + worktree config

- `packages/backend/src/services/task.ts` `startTask`：
  - 派生 `gitUserName` / `gitUserEmail`（trim → null）。
  - INSERT 时带上。
  - `git worktree add` 之后两条 `git config user.name/email`（条件：两值
    都真）。
- 不改 `getTaskById` mapper —— drizzle select 已自动带新列；只在
  `TaskSchema` 透传。

### RFC-067-T4 — Runner env 注入 + 调用点透传

- `packages/backend/src/services/runner.ts`：
  - `RunnerOpts` 加 `gitUserName?` / `gitUserEmail?`。
  - env dict spread 之后追加四件套（仅在两值都真时）。
- `packages/backend/src/services/scheduler.ts`：所有 `runAgentNode` /
  spawn opencode 入口（grep `runAgentNode(\|runner\.start\(`）从已加载的
  `task` 行透传两字段。

**冲突预案**：RFC-064 PR-B 若提前落，调用点行号会移；调整搜索定位即可，
两字段透传与 RFC-064 重构方向正交。

### RFC-067-T5 — Backend 行为测试

- 新文件 `packages/backend/tests/task-start-git-identity.test.ts`：
  12 case（详 design.md §5.2）。Spawn 行为用现有 `mockOpencode` /
  `recordSpawnEnv` fixture（沿用 RFC-031 / RFC-029 测试模式）。

### RFC-067-T6 — Frontend 表单

- `packages/frontend/src/lib/launch-repo-source.ts`：
  - `LaunchCommonPayload` 加两字段。
  - `buildLaunchBody` / `buildLaunchFormDataV2` 末尾条件写入。
- `packages/frontend/src/routes/workflows.launch.tsx`：
  - useState 两个；派生 `gitIdentityOk` / `pairingError` / `emailError`；
    入 `canStart`。
  - `<details>` 折叠区 + 两 `<TextInput>`（用公共 Form primitive）+ error
    节点。
  - 提交时 trim 后通过 `buildLaunchBody`。
- `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts`：6 个新 key cn/en
  对称。
- 复用 `<Field>` / `<TextInput>` / `.error-text` 公共原语；**禁止**自写
  border / focus / chrome（CLAUDE.md "前端 UI 统一风格" 硬约束）。

### RFC-067-T7 — Frontend 测试

- 扩 `packages/frontend/tests/workflows-launch.test.tsx`：2 case（默认折叠
  关闭 happy + 提交 body 不含字段）。
- 新文件 `packages/frontend/tests/launch-git-identity.test.tsx`：4 case
  （半填 pairing error / email 无 @ / 两个合法 → body 含字段 / i18n cn/en
  锁）。
- 新文件 `packages/frontend/tests/launch-body-builder-git-identity.test.ts`：
  pure `buildLaunchBody` 输入 → 输出 6 表项快照（与 shared schema 一致性
  锁）。

### RFC-067-T8 — Source-text 守门 + 收尾

- `packages/backend/tests/source-text-rfc067-guards.test.ts`：
  - `services/runner.ts` 必须含全部四个 env 全名 `GIT_AUTHOR_NAME` /
    `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL`，并
    且都在同一个条件块内（防部分注入）。
  - `services/task.ts` 写 worktree config 的 `git config user.name` /
    `git config user.email` 各出现至少 1 次。
  - schema XOR 错误码 `git-identity-incomplete` / 邮箱错误码
    `git-identity-email-invalid` 两常量在 shared 模块出现且没被偷偷 rename。
- `STATE.md` 顶部"进行中 RFC"行改成"完工"行；`design/plan.md` RFC 索引
  状态 Draft → Done；commit message 前缀 `feat(scope): RFC-067 任务级 Git
  提交身份`。
- push 后查 GitHub Actions（按 [feedback_post_commit_ci_check] 规则）。

## 验收清单

- [ ] T1 shared 6 case 全绿
- [ ] T2 migration 0034（或 bump）+ drizzle schema 加列；journal idx test 同步
- [ ] T3 `startTask` 持久化 + worktree config 双写
- [ ] T4 runner 四件套注入 + 调用点透传
- [ ] T5 backend 12 case 全绿（含并行 env 隔离）
- [ ] T6 表单字段折叠区 + 6 个 i18n key cn/en 对称
- [ ] T7 frontend 6 case 全绿
- [ ] T8 source-text 守门 + STATE.md / plan.md 索引更新
- [ ] 3-trio (`bun run typecheck` / `bun run test` / `bun run format:check`)
  全绿
- [ ] push 后 CI run 全 15 jobs 绿（参 [feedback_post_commit_ci_check]）

## 依赖

- 无强阻塞；与 RFC-064 / 065 / 066 在不同代码段，可与之并行落（migration
  编号需要落 PR 前再确认一次）。

## 估算

约 1-2 工作日（含测试 + CI 验证）。
