# RFC-040 — 实施计划

> 配套 [proposal.md](./proposal.md) + [design.md](./design.md)。单 PR，按任务顺序写代码 + 测试。

## 拆分原则

**单 PR 合并**。改动收敛于：1 migration + 1 schema 列 + 1 shared 字段 + 1 新 backend 模块 + 1 既有 backend 文件（scheduler.ts 的两个 wrapper 函数重写）+ 9 个新测试文件 + 0 frontend / 0 i18n / 0 WS schema 改动。一次提交评审，回退是单 commit `git revert`。

> **不拆 schema-only vs logic** 两个 PR：schema 列单独落是浪费，落了无人用又会被怀疑死代码；只有 wrapper 续跑逻辑一起落，列才有意义。

## 任务列表

按"shared schema → DB / drizzle → backend module → scheduler 重写 → 测试 → 收尾"顺序。

### RFC-040-T1 — Shared schema

- `packages/shared/src/schemas/nodeRun.ts`：`NodeRunSchema` 末尾追加 `wrapperProgressJson: z.string().nullable().optional()`。
- 验证：`bun run typecheck` 全绿（既有前后端 import 不应破）。
- 不写专门测试（字段是可选 string，单测无价值；语义在 backend 模块测）。

### RFC-040-T2 — DB migration + drizzle schema

- 新文件 `packages/backend/db/migrations/0022_rfc040_wrapper_progress.sql`（内容见 design.md §2）。
- `packages/backend/src/db/schema.ts`：`nodeRuns` 表追加 `wrapperProgressJson: text('wrapper_progress_json')`，位置贴近 `inventorySnapshotJson`。
- 验证：`bun run drizzle-kit generate` 产物与手写 sql 一致；不一致按手写为准修 schema.ts。
- 测试：`packages/backend/tests/migration-0022.test.ts`（2 case：列存在 + 老行 NULL；老 wrapper 行 NULL 走 init 路径）。

### RFC-040-T3 — 新 backend 模块 `services/wrapperProgress.ts`

- 新文件 `packages/backend/src/services/wrapperProgress.ts`（内容见 design.md §4.1）：
  - `WrapperProgressSchema` zod
  - `encodeWrapperProgress` / `decodeWrapperProgress` 函数
- 测试：`packages/backend/tests/wrapper-progress-schema.test.ts`（6 case，覆盖 round-trip + 异常路径）。

### RFC-040-T4 — scheduler `runLoopWrapperNode` 重写

- `packages/backend/src/services/scheduler.ts:1000-1048`：按 design.md §4.2 重写。
  - 加 `findResumableWrapperRun` / `persistWrapperProgress` / `markWrapperTerminal` 三个 helper（放在 `runLoopWrapperNode` 上方）。
  - awaiting_human / awaiting_review 显式 match 上抛 + 更新 wrapper status。
  - 起始 iteration 从 progress 读，否则 0。
- 不动既有 exit_condition 评估 / output binding 逻辑。
- 测试：`scheduler-loop-clarify.test.ts`（≥ 2 case）+ `scheduler-loop-review.test.ts`（≥ 2 case）+ `scheduler-loop-multiprocess-clarify.test.ts`（≥ 1 case）。

### RFC-040-T5 — scheduler `runGitWrapperNode` 重写

- `packages/backend/src/services/scheduler.ts:1072-1143`：按 design.md §4.3 重写。
  - 复用 T4 引入的三个 helper。
  - awaiting_* 上抛 + 持久化 baseline。
  - 抽 `captureHead` 内部 helper（消除 init / 重启分支重复）。
- 测试：`scheduler-git-clarify.test.ts`（≥ 2 case）+ `scheduler-git-review.test.ts`（≥ 1 case）。

### RFC-040-T6 — 嵌套 / 续跑 / cancel 测试

- `scheduler-wrapper-nested-await.test.ts`（≥ 1 case AC-7：wrapper-git ∋ wrapper-loop ∋ {agent, clarify}）。
- `scheduler-wrapper-resume.test.ts`（≥ 1 case AC-8：模拟 daemon 重启，重入 runOneNode 复用 wrapperRunId）。
- `scheduler-wrapper-cancel-while-awaiting.test.ts`（≥ 1 case AC-9）。
- `scheduler-wrapper-resume-review-iterate.test.ts`（≥ 1 case：review-iterate 路径下 wrapper progress.iteration 不前进）。

### RFC-040-T7 — 既有套件零退化跑通

- `bun run typecheck`
- `bun run test`：重点关注 scheduler / clarify / review 系列既有测试不破。如有 fixture 因 wrapperProgressJson 字段未默认而红，加 `wrapperProgressJson: null` 字段（与 `inventorySnapshotJson: null` 同模式）。
- `bun run format:check`

### RFC-040-T8 — 收尾

- 本地三件套全绿。
- commit message：
  ```
  fix(scheduler): RFC-040 wrapper 节点上抛 awaiting_human / awaiting_review 并续跑

  - wrapper-loop / wrapper-git 在内层 scope 返回 awaiting_* 时上抛而非吞掉
  - node_runs 新增 wrapper_progress_json 列（migration 0022）持久化续跑上下文
  - 新 services/wrapperProgress.ts 模块负责 encode/decode/parse
  - findResumableWrapperRun + persistWrapperProgress + markWrapperTerminal 三 helper
  - 用户答 clarify / 决策 review 后 wrapper 在原 iteration / baseline 续跑
  - 修复 wrapper-git 在 clarify pending 时错误算 diff 的静默正确性 bug
  - 测试 +12（loop+clarify / loop+review / git+clarify / git+review /
    loop+multiprocess+clarify / 嵌套 / 续跑 / cancel / review-iterate /
    progress schema 单元 / migration）

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```
- push 后查 GitHub Actions HEAD CI（per [feedback_post_commit_ci_check]）；六 jobs 全绿。
- 同步：
  - `STATE.md` 顶部"进行中 RFC"行追加 RFC-040 完工记录（commit hash + CI run id）；
  - `design/plan.md` RFC 索引 RFC-040 状态 Draft → Done。

## 依赖

无前置依赖：RFC-038 是纯前端、不动 scheduler；RFC-036 / RFC-037 已落 main。

## Acceptance checklist

- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] GitHub Actions HEAD CI 六 jobs 全绿
- [ ] DB migration 0022 跑后 `node_runs.wrapper_progress_json` 列存在 + 老行 NULL
- [ ] AC-2：wrapper-loop ∋ {agent, clarify} 跑出 1 条 clarify_session（不是 maxIter 条），wrapper 状态 awaiting_human
- [ ] AC-3：答完 clarify 后 wrapper 在原 iteration 续跑 → 跑完 / 失败 / 继续
- [ ] AC-4：wrapper-loop ∋ {agent, review} 类似（review 路径）
- [ ] AC-5：wrapper-git ∋ {agent, clarify} **不算 diff** 直到 clarify 答完
- [ ] AC-6：wrapper-loop ∋ multi-process(agent) 一轮 N 个 clarify 不滚雪球
- [ ] AC-7：嵌套 wrapper-git ∋ wrapper-loop ∋ {agent, clarify} 正确链式
- [ ] AC-8：模拟 daemon 重启 wrapper 复用 wrapperRunId 续跑
- [ ] AC-9：cancel 在 awaiting 态生效
- [ ] AC-10：既有 wrapper / clarify / review 测试零退化
- [ ] AC-12：新增测试 ≥ 12 条
- [ ] AC-13：multi-person working tree 安全（未追踪文件不动）
- [ ] STATE.md / plan.md 同步落 Done

## Rollback

单 commit `git revert <sha>`。DB 列 `wrapper_progress_json` 可保留为冗余字段（回退后无应用消费，不影响其它路径）。
