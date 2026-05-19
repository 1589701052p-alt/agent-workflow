# RFC-043 — 任务拆分

> 单 PR 推送（feat(memory): RFC-043 distill job detail page）。任务编号 `RFC-043-Tx`。

## 任务清单

### RFC-043-T1 · DB migration + schema 同步
- `packages/backend/db/migrations/0024_rfc043_distill_capture.sql`：5 ALTER + 1 CREATE TABLE +
  2 INDEX（design §2）。
- `packages/backend/src/db/schema.ts`：同步 `memoryDistillJobs` 5 新列 + 新 `memoryDistillEvents` 表
  定义。
- 测试：`migration-0024-distill-capture.test.ts` 2 case（schema 字段齐全 / FK CASCADE）。
- 验收：`bun run typecheck` 全绿；本地启动 daemon 触发自动 migration 不报错。

### RFC-043-T2 · shared schema
- `packages/shared/src/schemas/memory.ts` 追加 4 新 schema（`MemoryDistillEventSchema` /
  `MemoryDistillSessionViewSchema` / `MemoryDistillCandidateSnapshotSchema` /
  `MemoryDistillJobDetailSchema`），`MemoryDistillJobSchema` 加新可选字段。
- 测试：`memory-detail-schemas.test.ts` 4 case（zod 解析 happy / 老 job 不含新字段仍解析 /
  dedupSnapshot null 容错 / candidates 空数组）。
- 验收：shared 测试一次过。
- 依赖：无（与 T1 并行可）。

### RFC-043-T3 · backend capture 路径扩展
- `packages/backend/src/services/memoryDistiller.ts`：spawn 前后插入 5 新列写入；调
  `captureDistillJobSession`。改 attempts 时不重写 user prompt。
- `packages/backend/src/services/distillSessionCapture.ts`（新）：BFS opencode SQLite + transcode
  → 写 `memory_distill_events`。
- 复用 `extractSessionIdFromStderr`、`clipAndRedact`、`transcodeOpencodeRowsToEvents`。
- 测试：
  - `memoryDistiller-capture-integration.test.ts` 5 case（design §8.1）。
  - `distillSessionCapture.test.ts` 4 case。
- 验收：`bun run test` backend 一次过；零退化既有 RFC-027 / RFC-041 测试。
- 依赖：T1 + T2。

### RFC-043-T4 · backend detail service + 2 endpoints
- `packages/backend/src/services/memoryDistillJobDetail.ts`（新）：`getDistillJobDetail`。
- `packages/backend/src/routes/memoryDistillJobs.ts`：加 `GET /:jobId` + `GET /:jobId/session` 两
  端点，挂 `requirePermission('memory:read_distill_jobs')`。
- 测试：
  - `memoryDistillJobDetail.test.ts` 8 case（design §8.1）。
  - `routes-memory-distill-job-detail.test.ts` 5 case（含 admin/non-admin、404、session 多
    attempt 分组、capture-failed marker 走 attempts:[] + 提示）。
- 验收：backend 测试 + lint 全绿。
- 依赖：T1 + T2 + T3。

### RFC-043-T5 · frontend lib + 路由 + 6 组件
- `packages/frontend/src/routes/memory.distill-jobs.$jobId.tsx`（新顶层路由）。
- `packages/frontend/src/components/memory/distill-job-detail/`：
  - `DetailHeader.tsx`
  - `SourceEventsList.tsx`
  - `ScopeAndDedupSnapshot.tsx`
  - `CandidatesList.tsx`
  - `FailureDiagnostics.tsx`
  - `ConversationSection.tsx`（复用 RFC-027 `ConversationFlow`，含 `AttemptPickerLite` 子组件）
- `packages/frontend/src/lib/distill-job-detail.ts`（5 纯函数）。
- 复用：`<DetailLayout>` / `<EmptyState>` / `<StatusChip>` / `<Select>`（均 RFC-035/036 共享）。
- 测试：design §8.2 共 +18（路由 3 / source-events 4 / candidates 3 / diagnostics 3 /
  conversation 4 / table-row-click 2 / 纯函数 lib 5 → 实际拆 7 文件 +24 case，按设计 list）。
- 验收：`bun run typecheck && bun run test` 全绿。
- 依赖：T2 + T4。

### RFC-043-T6 · MemoryDistillJobsTable 整行点击改造
- 行整行 `onClick` 跳路由；retry/cancel 按钮 stopPropagation；hover 样式（RFC-035 token）。
- 测试：`distill-job-detail-table-row-click.test.tsx` 2 case（已包含在 T5）。
- 验收：现有 `memory-distill-jobs-table.test.tsx` 零退化。
- 依赖：T5（路由必须先存在，否则跳转 404 测试要 mock 路由）。

### RFC-043-T7 · i18n + styles + grep 守卫 + STATE.md
- `packages/frontend/src/i18n/{en-US,zh-CN}.ts`：~22 新 key（design §6.5）。
- `packages/frontend/src/styles.css`：`.distill-job-detail` 命名空间 ~30 选择器。
- `packages/frontend/tests/i18n-distill-job-detail-keys.test.ts` 2 case + `distill-detail-grep.test.ts`
  2 case。
- `STATE.md` 顶部 "进行中 RFC" 加行；落 commit 后转 Done。
- `design/plan.md` RFC 索引追加 RFC-043 行。
- 验收：`bun run format:check` 全绿；i18n 对称测试一次过。
- 依赖：T5 + T6。

### RFC-043-T8 · 收尾门槛
- `bun run typecheck && bun run test && bun run format:check` 全绿。
- 单 PR push，commit message `feat(memory): RFC-043 distill job detail page`。
- 推完按 `[feedback_post_commit_ci_check]` 查 GitHub Actions run 状态。

## 依赖图

```
T1 ─┐
    ├─ T3 ─┐
T2 ─┤      ├─ T4 ─ T5 ─ T6 ─ T7 ─ T8
    └──────┘
```

## PR 拆分备用方案（若 review 反馈太大）

- **PR1（backend-only）**：T1 + T2 + T3 + T4 + 对应测试 + STATE.md "in-flight" 一行。
- **PR2（frontend）**：T5 + T6 + T7 + i18n + styles + grep + STATE.md 转 Done。

两 PR 间 backend 接口已存在 + 老 `MemoryDistillJobsTable` 仍正常工作（行不可点击但 retry/cancel
不变），不破任何既有功能。

## 验收清单（PR 上线前）

- [ ] migration 0024 双向 idempotent（重启 daemon 不重复创建表）
- [ ] admin 访问 `/memory/distill-jobs/$jobId` 渲染 6 section
- [ ] non-admin 访问被 403 + 前端 AdminOnly 占位
- [ ] 老 job（migration 前数据）详情页不报错
- [ ] failed job 显示诊断 + 即使 capture 失败也能看 stderr
- [ ] success job 显示对话流 + attempts 切换可用
- [ ] candidates 点击跳 `/memory?focus=<memoryId>`
- [ ] sourceEvents 三类深链全部点击可达，删源行灰显
- [ ] `MemoryDistillJobsTable` 整行点击跳详情，retry/cancel 按钮不被误触发
- [ ] stderr / git URL secret redact 生效
- [ ] CI（typecheck + test + format + e2e + build smoke）全绿
- [ ] STATE.md 顶部更新 + design/plan.md 索引 +1 行
