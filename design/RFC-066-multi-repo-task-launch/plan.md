# RFC-066 — 任务分解（Multi-Repo Task Launch）

3 PR 强序（沿用 RFC-058 / RFC-064 模式）：单 PR 体量过大且分散到 shared
/ DB / scheduler / runner / frontend / e2e 多个层面，**拆 3 PR 让每个
PR 独立 push CI 全绿后再启下一 PR**。task id 前缀 `RFC-066-T*`。

## 概览

```
PR-A  (shared + DB + backend startTask + single-path byte baseline)
  ├─ T1  shared schemas（StartTask v2 / TaskRepo / Task.repos / prompt vars 占位符）
  ├─ T2  migration 0034 + drizzle schema
  ├─ T3  services/task.ts startTask 多仓分支 + materializeWorktree 扩展
  ├─ T4  getTask / listTasks 返回 repos[]
  ├─ T5  routes/tasks.ts 接受 v2 body
  ├─ T6  multi-repo gates（wrapper-git / upload）在 startTask 入口
  ├─ T7  shared + backend 测试 ≥ 30 case + single-path baseline 锁
  └─ T8  STATE.md / plan.md 索引 InProgress

PR-B  (scheduler / runner / diff / resume / runtime gate)
  ├─ T9   scheduler 入口兜底 wrapper-git gate + template var meta.repos[]
  ├─ T10  runner 透传 templateMeta 不动 cwd 逻辑（grep guard 保 cwd = task.worktreePath）
  ├─ T11  shared prompt.ts 渲染三个新占位符
  ├─ T12  services/task.ts worktreeDiffForTask 多仓拼接
  ├─ T13  resume + retry per-repo rollback（gitStashSnapshot N 次 + pre_snapshot_repos_json）
  ├─ T14  backend 测试 ≥ 30 case
  └─ T15  STATE.md 同步

PR-C  (frontend UI + 任务详情 + e2e)
  ├─ T16  RepoSourceRow（从 RepoSourceTabs 抽出）
  ├─ T17  RepoSourceList 容器 + +/- 按钮 + 预览名计算
  ├─ T18  routes/workflows.launch.tsx state migration + gate banner + buildLaunchBodyV2
  ├─ T19  routes/tasks.detail.tsx multi-repo header
  ├─ T20  i18n keys（cn/en 对称）
  ├─ T21  styles.css 命名空间
  ├─ T22  frontend 测试 ≥ 13 case
  ├─ T23  e2e/multi-repo-launch.spec.ts ≥ 2 scenario
  └─ T24  STATE.md / plan.md 索引 Done
```

---

## PR-A 详细任务

### T1 — shared schemas
- 新增 `packages/shared/src/schemas/task.ts`：
  - `MULTI_REPO_MAX = 8` 常量 export。
  - `StartTaskRepoSchema`（path/url 二选一 + 各自必填字段校验）。
  - 扩 `StartTaskSchema` 增 `repos: z.array(StartTaskRepoSchema).min(1).max(MULTI_REPO_MAX).optional()`；
    superRefine 加 legacy ↔ v2 互斥 / 至少一选一 / legacy path+url 互斥
    / legacy path 必填 baseBranch。
  - `TaskRepoSchema` 新 export（与 DB 列对齐）。
  - `TaskSchema` 加 `repoCount` + `repos: TaskRepoSchema[]`。
  - `TaskSummarySchema` 加 `repoCount`。
- 单测：见 design §5.1 S1-S9（≥ 9 case 集中在 `tests/start-task-schema-multi-repo.test.ts` + `tests/task-repo-schema.test.ts`）。

### T2 — migration 0034 + drizzle schema
- **PR 提交前**：grep `packages/backend/db/migrations/` 确认 0034 编号
  未被 RFC-064（PR-B T9 cci unify）抢占（RFC-067 已落 0033）；如撞号，
  按当前 HEAD + 1 顺延（典型为 0035），同步刷 design §1.4 / §5.2 B1-B3
  / `tests/upgrade-rolling.test.ts` 中的编号与 journal count，**不要**
  在两个未合并 PR 中并存同编号。
- 新文件 `packages/backend/db/migrations/0034_rfc066_task_repos.sql`
  （design §1.4）。
- `packages/backend/src/db/schema.ts` 新增 `taskRepos` 表对象；`tasks`
  加 `repoCount` 列；`nodeRuns` 加 `preSnapshotReposJson` 列。
- 单测：`tests/migration-0034-task-repos.test.ts` ≥ 3 case（design §5.2 B1-B3）。
- 更新 `tests/upgrade-rolling.test.ts` HEAD journal count 33→34（按实际
  落地编号调整）。

### T3 — services/task.ts startTask
- 抽 `normalizeStartTaskRepos(input)` 把 legacy / v2 收口成
  `StartTaskRepo[]`。
- 抽 `resolveRepoSourceSingle(spec, deps)` 把 path / URL 单仓解析逻辑
  挪出（path 模式 pass-through、URL 模式调 `resolveCachedRepo`）。**注**：
  RFC-068 FF 逻辑（若先落）已在 `resolveCachedRepo` warm path 内 +
  `resolveRepoSource` path 模式 opt-in 分支，随此抽取整体迁过去，每仓
  各自独立 FF，零额外代码。
- `materializeWorktree` 加可选 `overrideWorktreePath` 参数；single-path
  调用方不传，保 path layout 字节级。
- 实现 multi-repo materialize：`mkdir -p multi/{taskId}` + 顺序 N 次
  `createWorktree({ overrideWorktreePath })` + basename 冲突 `-2/-3`
  后缀解析。
- `tasks` 行 mirror `task_repos[0]`；`task_repos` 行批量 insert（同
  事务）。
- `upsertRecentRepo` 多仓时按 path-mode 仓数调用 N 次。
- **RFC-067 兼容**：RFC-067 已收口为纯 env 注入（`runner.ts` 设
  `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 四件套，**不写** worktree config）。
  env 是 opencode 子进程级、cwd 下任何子目录的 `git commit` 都生效——
  多仓身份**自动跨仓共享，零额外代码**。本 RFC 不引入 `git config` 写
  入步骤。
- 单测：`tests/start-task-legacy-byte-baseline.test.ts`（B6）+
  `tests/start-task-multi-repo-materialize.test.ts`（B7-B12，≥ 6 case）。

### T4 — getTask / listTasks 扩展
- `services/task.ts` `mapTaskRow` + 新 `mapTaskRepoRow`。
- `getTask` 查 `task_repos` 排序后注入 `repos`；`task_repos.length === 0`
  defensive fallback。
- `listTasks` 不返回 repos 详情（不在 list view 渲染），只算
  `repo_count` 字段（`tasks.repoCount`）。
- 单测：`tests/gettask-multi-repo.test.ts` ≥ 2 case（B26-B27）。

### T5 — routes/tasks.ts 接受 v2 body
- JSON body 路径：`StartTaskSchema` 已覆盖 superRefine；route 仅传透。
- multipart 路径：当前已要求 path mode；本 RFC 新增 `repos.length > 1
  + 走 multipart` → 422 + `multi-repo-upload-unsupported`（与 T6 gate
  统一）。
- 单测覆盖在 T7。

### T6 — multi-repo gates
- `startTask` 入口扫 workflow.definition.nodes 找 `wrapper-git`；
  扫 inputs 找 `kind:'upload'`；命中 + `repos.length > 1` → 422。
- 错误体含触发节点 / input key 列表，便于 UI 跳转。
- 单测：`tests/start-task-multi-repo-gates.test.ts` ≥ 3 case（B13-B15）。

### T7 — shared + backend 测试 ≥ 30 case
- 上述 case 全跑绿。
- 新增 source-level guard：`tests/source/start-task-single-path-baseline.test.ts`
  锁 `services/task.ts` 含字面 `// RFC-066: single-path byte-baseline branch`
  + `materializeWorktree` 单仓调用方不传 `overrideWorktreePath`。
- `bun run typecheck && bun run test && bun run format:check` 全绿。

### T8 — STATE.md / plan.md
- `STATE.md` 顶部"进行中 RFC"行追加 RFC-066 PR-A 指针。
- `design/plan.md` RFC 索引加 RFC-066 行：`In Progress (PR-A)`。
- commit message：`feat(backend,shared): RFC-066 PR-A multi-repo task launch — shared schemas + migration 0034 + startTask`。
- push 后查 GitHub Actions（feedback_post_commit_ci_check 规则）。

---

## PR-B 详细任务

> 前置：PR-A 已 push + CI 全绿。

### T9 — scheduler 入口兜底
- `runTask` 开始处加 `if (task.repoCount > 1 && wfDef.nodes.some(kind === 'wrapper-git'))` 兜底 throw。
- `scheduleAgentNode` 调 runner 时把 `templateMeta.repos` 从
  `task.repos` 映射喂进去（design §3.3）。
- 单测：`tests/scheduler-template-multi-repo.test.ts` B22-B24 中 1 case。

### T10 — runner 透传 templateMeta
- `runner.ts:99` `worktreePath` 仍是 `task.worktreePath`（grep guard
  防 mid-PR 改）。
- `templateMeta.repos` 透传到 `renderUserPrompt`（shared prompt.ts）。
- grep guard：`runner.ts` 中 `cwd:` 行只允许 1 处指向 opts.worktreePath。

### T11 — shared prompt.ts 渲染三占位符
- `shared/src/prompt.ts` `renderUserPrompt` 加：
  - `{{__repos__}}` → `meta.repos.map(r => r.worktreePath).join('\n')`
  - `{{__repo_names__}}` → `meta.repos.map(r => r.worktreeDirName).join('\n')`
  - `{{__repo_count__}}` → `String(meta.repos.length)`
- single-path 时 `meta.repos[0].worktreeDirName === ''` → `{{__repo_names__}}` 渲染为空串；行为定义清晰。
- 单测：`shared/tests/prompt-multi-repo-vars.test.ts` ≥ 3 case（S10-S12）。

### T12 — diff endpoint 多仓拼接
- `services/task.ts` `worktreeDiffForTask` 重构（design §3.5）。
- 1 MiB cap 复用 `worktreeDiff` 的常量。
- single-path 调 `worktreeDiff(task.worktreePath, task.baseCommit)`
  字节级保持。
- 单测：`tests/task-diff-multi-repo.test.ts` ≥ 3 case（B16-B18）。

### T13 — resume / retry per-repo rollback
- `services/task.ts` `rollbackForResume(task, run)` helper（design §3.6）。
- `services/scheduler.ts` `gitStashSnapshot` 写节点前按
  `task.repoCount` 选择写 `pre_snapshot`（单）或 `pre_snapshot_repos_json`
  （多）。
- 单测：`tests/resume-multi-repo-rollback.test.ts` ≥ 3 case（B19-B21）。

### T14 — backend 测试 ≥ 30 case
- 累计 T9-T13 + B25 cancel + B28-B30 fanout/clarify/review 多仓回归。
- 全套 `bun run typecheck && bun run test && bun run format:check` 全绿。

### T15 — STATE.md
- 加 PR-B 完工记录、commit hash。
- commit message：`feat(backend,shared): RFC-066 PR-B multi-repo task launch — scheduler/runner template vars + diff + resume`。
- push + CI 验证。

---

## PR-C 详细任务

> 前置：PR-A + PR-B 已 push + CI 全绿。

### T16 — RepoSourceRow
- 新文件 `packages/frontend/src/components/launch/RepoSourceRow.tsx`，从
  `RepoSourceTabs.tsx` 内部 markup 抽出。
- 保留所有 a11y 属性（role / aria-selected / testid）。
- 老 `RepoSourceTabs` 默认 export 保留为兼容入口（内部 `<RepoSourceList>`
  + 锁 length=1）以防外部调用。

### T17 — RepoSourceList
- 新文件 `packages/frontend/src/components/launch/RepoSourceList.tsx`。
- 实现 `computePreviewDirNames(repos)` 纯函数（与 backend 冲突解决等价）。
- +/− 按钮交互；MULTI_REPO_MAX 上限 disable。

### T18 — routes/workflows.launch.tsx
- state `source: RepoSource` → `repos: RepoSource[]`（默认 `[default]`）。
- mutation 按 `repos.length` 分流 buildLaunchBody / buildLaunchBodyV2。
- gate banner 与 Start disable 接线。

### T19 — routes/tasks.detail.tsx
- header 行下方加 multi-repo `<details>` 块（design §4.3）。
- 单仓 task 不渲染（baseline 字节守恒）。

### T20 — i18n keys（cn/en 对称）
- design §4.4 列的 10 个 key 全部加。
- 现有 i18n-keys-symmetry test 自动覆盖对称性。

### T21 — styles.css
- 新增 `.repo-source-list` / `.repo-source-list__actions` /
  `.repo-source-list__banner` / `.repo-source-row` / `.task-detail__multi-repo`
  系列规则。
- 沿用既有 `--spacing-*` / `--surface-*` token。

### T22 — frontend 测试 ≥ 13 case
- 所有 design §5.3 列表案例（F1-F13）落地。
- 既有 `launch-task-name-submit-paths.test.ts` 字节级守恒（F13）。
- `bun run typecheck && bun run test && bun run format:check` 全绿。

### T23 — e2e
- `packages/frontend/e2e/multi-repo-launch.spec.ts` 2 scenario：
  - happy：选 2 个临时 git repo → 启动 → 父目录 / 两子目录 / cwd 验证。
  - 拒：workflow 含 wrapper-git + 2 仓 → Start disabled + banner 文案。
- 复用既有 stub-opencode fixture。

### T24 — STATE.md / plan.md 收尾
- `STATE.md` 已完成 RFC 表 + 已完成 issue 表加 RFC-066 行。
- `design/plan.md` 索引改 Done。
- commit message：`feat(frontend): RFC-066 PR-C multi-repo task launch — RepoSourceList UI + task detail header + e2e`。

---

## 验收清单（每 PR 合并门槛）

- [ ] design.md §5 测试矩阵对应子集全绿。
- [ ] `bun run typecheck && bun run test && bun run format:check` 三件套全绿。
- [ ] push 后 GitHub Actions 全绿（含 build smoke + Playwright e2e）。
- [ ] 单仓行为字节级回归：`start-task-legacy-byte-baseline.test.ts`、
      `launch-task-name-submit-paths.test.ts` 等既有锁全过。
- [ ] commit message 含 `RFC-066 PR-X`；PR 描述链回本 RFC 三件套。
- [ ] 没有捎带删除他人代码 / 未追踪文件（CLAUDE.md 多人协作规则）。

## 估时

- PR-A：5-7 工作日（shared + migration + startTask 重构 + 30 case 测试）。
- PR-B：3-5 工作日（scheduler/runner/diff/resume + 30 case 测试）。
- PR-C：4-6 工作日（前端 UI + 详情 header + e2e + 13 case）。
- 总：12-18 工作日。

## 与其他 RFC 的强阻塞 / 弱耦合

- **不阻塞**：RFC-064（Unified Clarify Runtime）、RFC-065（Worktree
  Files Tab）继续并行；本 RFC 不动 clarify_rounds / worktree-files
  路由。
- **借用**：RFC-024 cached_repos / RFC-034 submodule init / RFC-060
  wrapper-fanout 既有逻辑直接复用，不改它们行为。
- **强依赖**：无（本 RFC 是独立纵切的新能力）。

## 风险与回退

- 单 PR 拆分清晰，回滚单 commit 即可。
- migration 0034 仅 additive，回滚 = DROP TABLE + DROP COLUMN，旧单仓
  数据完好。
- PR-A 落地后老 client 仍能正常用 legacy body 启动单仓 task；多仓需要
  等 PR-C 前端跟上。中间状态不会破坏既有功能。
