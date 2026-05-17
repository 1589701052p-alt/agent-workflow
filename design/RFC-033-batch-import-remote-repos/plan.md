# RFC-033 实施计划

> 配套 `proposal.md` + `design.md`。每条子任务一旦完成立即勾掉，并在 PR / commit message 引用 `RFC-033-Tn`。建议**单 PR 合**，除非冲突倒逼拆分。

## 子任务

### RFC-033-T1 — shared schema + WS message union

- 新文件 `packages/shared/src/schemas/repoBatchImport.ts`：`BatchImportRowStatus` / `BatchImportRow` / `BatchImportSnapshot` / `StartBatchImportRequest` / `RetryBatchImportRowRequest`
- `packages/shared/src/schemas/ws.ts`：加 `RepoImportWsMessage` union（`row.update` / `batch.completed` / `batch.error`）
- `packages/shared/src/index.ts` 导出新符号
- 测试：`repo-batch-import-schema.test.ts`（5 case 边界）+ `redact-url-leak.shared.test.ts`（1 case）
- 依赖：—
- 大小：S

### RFC-033-T2 — 后端 service `repoBatchImport.ts`

- 新文件 `packages/backend/src/services/repoBatchImport.ts`
  - 内部 `batches: Map<batchId, BatchRecord>` + 全局 semaphore 控制 cross-batch 并发
  - 公有 API：`startBatchImport` / `getBatchSnapshot` / `retryBatchRow` / `gcBatches`
  - `pumpQueue` 并发池 + `runRow` worker + waiter 机制
  - `clipAndRedact(msg, url)` 工具
  - settings 读取 `repoBatchImportConcurrency` / `repoBatchImportRetentionMs`
- 错误类：复用 `ValidationError` / `DomainError` / `NotFoundError`；新增 code `batch-empty` / `batch-too-large` / `batch-not-found` / `row-not-found` / `row-not-retryable`
- 测试：
  - `repo-batch-import.test.ts`（~8 case：happy / invalid url / clone fail / 并发上限 / 同 URL 去重 / 全 invalid / WS broadcast 计数）
  - `repo-batch-import-retry.test.ts`（5 case）
  - `repo-batch-import-gc.test.ts`（2 case）
  - `redact-url-leak-batch.test.ts`（源代码层 grep 兜底）
- 依赖：T1
- 大小：M

### RFC-033-T3 — WS broadcaster + server adapter

- `packages/backend/src/ws/broadcaster.ts`：新 `REPO_IMPORT_CHANNEL` 函数 + `repoImportsBroadcaster` typed broadcaster；`resetBroadcastersForTests` 加一行
- `packages/backend/src/ws/server.ts`：
  - `WS_PATH_RE.repoImport`
  - `ConnectionData['channel']` 新变体 `{ kind: 'repo-import'; batchId: string }`
  - `parseChannel` 多 match
  - `handleOpen` 新 case：subscribe + hello `{ type: 'hello', channel: 'repo-imports/<batchId>' }`
- 测试：`ws-repo-imports.test.ts`（3 case：hello / broadcast 透传 / 401）
- 依赖：T1, T2
- 大小：S

### RFC-033-T4 — HTTP 路由 `routes/cached-repos.ts` 三接口追加

- 同文件 append：`POST /api/cached-repos/batch-import` / `GET /api/cached-repos/imports/:batchId` / `POST /api/cached-repos/imports/:batchId/rows/:rowId/retry`
- 错误穿过中心 errorHandler：保证 4xx body 含 `code` + `message`（已 redact）
- 测试：`cached-repos-http-batch.test.ts`（~6 case：201 同步返回 / body 校验 / GET 404 / retry 200/404/409）
- 依赖：T2
- 大小：S

### RFC-033-T5 — daemon GC hook

- 在 `services/maintenance.ts`（或现有 hourly tick 入口）注册 `gcBatches`，日志一条 `evicted=N`
- 测试：用注入的 fake clock 调一次，确保 evicted 正确（与 T2 测试合并即可）
- 依赖：T2
- 大小：XS

### RFC-033-T6 — 前端 dialog 组件 + hook

- 新组件 `packages/frontend/src/components/repos/BatchImportDialog.tsx`（input / progress 两态）
- 新 hook `packages/frontend/src/hooks/useRepoImportWs.ts`（仿 `useTaskSync.ts`）
- i18n 加 ~18 key（中英）
- styles.css +`.batch-import-dialog` `.batch-import-table` 系列
- 测试：
  - `BatchImportDialog.test.tsx`（~6 case：modal 开关 / Start disabled / progress 渲染 / row.update reducer / completed UI / failed retry 按钮）
  - `useRepoImportWs.test.ts`（mock WebSocket 收 message 触发 callback）
- 依赖：T1, T4（API 落定）
- 大小：M

### RFC-033-T7 — `/repos` 页 header 接入

- `packages/frontend/src/routes/repos.tsx`：header 加「批量导入」按钮 + 渲染 `<BatchImportDialog>`
- `activeBatchId` localStorage 读写
- 每条 row.update → `qc.invalidateQueries({ queryKey: ['cached-repos'] })`
- 测试：`repos-page-batch-button.test.tsx`（header 按钮渲染 + 点击打开 dialog）
- 依赖：T6
- 大小：S

### RFC-033-T8 — settings 加 2 个字段

- `packages/shared/src/schemas/config.ts`：`repoBatchImportConcurrency` (default 3, 1..8) + `repoBatchImportRetentionMs` (default 3600000)
- `packages/backend/src/services/repoBatchImport.ts` 读这两个字段
- 测试：现有 `config.test.ts` 加 2 case 默认值 + 边界
- 依赖：T2（同 PR 内可以与 T2 同 commit）
- 大小：XS

### RFC-033-T9 — e2e

- `e2e/main.spec.ts` 新 test `RFC-033: batch import remote repos`：
  - 启动前在 tmp 建 2 个 bare 仓 A, B
  - 进 /repos → 点 批量导入 → 粘贴 `file://A` + `file://B` + `garbage`
  - 等 3 行渲染；2 行变 done，garbage 行 failed/repo-url-invalid
  - 等 batch.completed → 关闭弹窗
  - 主表多 2 行
- 依赖：T6, T7
- 大小：S

### RFC-033-T10 — STATE.md / plan.md 索引同步

- `design/plan.md` RFC 索引表追加 RFC-033 行（状态 Draft → In Progress → Done 按阶段更新）
- `STATE.md` 顶部"进行中 RFC"加 RFC-033 指针；完工后改 Done 并迁入"最近完成 RFC"
- 依赖：—（与 T1 同 commit 即可）
- 大小：XS

## PR 拆分建议

默认**单 PR**（10 个子任务 + 测试），命名 `feat(repos): RFC-033 batch import remote repos on /repos page`。

仅当出现下列任一情况才拆：
- T3 WS 改动与并行 RFC-029 / RFC-032 在 `ws/server.ts` / `ws/broadcaster.ts` 上冲突 → 拆 WS-only PR 让对方先 review
- T6 dialog + i18n diff > 600 行 → 拆前端 PR 后置
- 任何文件单文件 diff 超 600 行 → 评估拆

## 验收清单

- [ ] shared/`bun test` 全绿（T1 + 已有）
- [ ] backend/`bun test` 全绿（T2–T5 + T8 + 已有），新增 ~25 case
- [ ] frontend/`bun test` 全绿（T6–T7 + 已有），新增 ~9 case
- [ ] `bun run typecheck && bun run test && bun run format:check` 三连绿
- [ ] e2e Playwright 全绿（macOS + ubuntu，含 RFC-033 新 case）
- [ ] CI run（`gh run list -L 1`）通过后再标 Done（按 `feedback_post_commit_ci_check` 规则）
- [ ] 抽样含 token 的 URL → 走 batch import → 检查 log / WS payload / API response / 错误 message **均不**出现 `user:pass` 段
- [ ] daemon 重启后内存 batch 丢失但已成功 cached_repos 行保留（手动 smoke）
- [ ] STATE.md 顶部 "进行中 RFC" 标记移除、"最近完成 RFC" 表新增 RFC-033 行
