# RFC-020 任务分解

> 单 PR，commit message 前缀 `feat(input): RFC-020 input 节点支持本地文件上传`。Stage 顺序按依赖排，但同一 PR 提交。

## 子任务

### RFC-020-T1 — shared schema 扩展

- 文件：`packages/shared/src/schemas/workflow.ts`
- 改动：
  - `WORKFLOW_INPUT_KIND` 加 `'upload'`
  - 新 `UploadInputSchema`（kind literal + `targetDir` 校验 + `accept` / `maxFileSize` / `minCount` / `maxCount`）
  - export `UploadInputSchema`
- 测试：`packages/shared/tests/workflow-input-upload.test.ts`（4 case：happy / `..` / `/abs` / 边界）

### RFC-020-T2 — backend upload 服务 + worktree 落盘

- 新文件：`packages/backend/src/services/upload.ts`
  - `applyUploadsToWorktree(plan): Promise<UploadResult>` 纯流程（无 db 依赖）
  - 工具函数：`sanitizeFilename` / `resolveUniqueName` / `assertInsideWorktree` / `sniffMime`
- 依赖：新增 `file-type`（已在 RFC-019 引入则复用；否则在 `packages/backend/package.json` 加）
- 测试：`packages/backend/tests/upload-apply-to-worktree.test.ts`（8 case，覆盖 §6 列出的全部场景）

### RFC-020-T3 — `startTask` 抽出 `materializeWorktree` + preCreatedWorktree 入参

- 文件：`packages/backend/src/services/task.ts`
- 改动：
  - 抽出私有 `materializeWorktree({ input, appHome }): Promise<{ worktreePath; branch; baseCommit; earlyError }>`
  - `startTask(input, deps)` 新增可选 `deps.preCreatedWorktree?` 入参；若给了就跳过创建
- 测试：扩 `packages/backend/tests/task-start.test.ts`（如不存在就建）
  - 1 case：传 `preCreatedWorktree` → 不调 git 子进程、wt 字段透传
  - 1 case：不传 → 走原路径
- 注意：保持 JSON 分支语义完全不变（回归保护用现有 task-start 测试套接住）

### RFC-020-T4 — `POST /api/tasks` multipart 分支

- 文件：`packages/backend/src/routes/tasks.ts`
- 改动：
  - 入口判 `content-type`，分流 multipart vs JSON
  - multipart：解析 `payload` JSON → resolveWorkflow → 校验 upload 输入的 minCount/maxCount → `materializeWorktree` → `applyUploadsToWorktree` → 把 packed paths 写入 `input.inputs[key]` → `startTask({...input}, {preCreatedWorktree})`
  - 任一步抛 → 400/500 + 不写 task 行（earlyError 仍走 startTask 内部那条路）
- 配套：`config.ts` 加 `uploadLimits` + 默认值
- 测试：`packages/backend/tests/tasks-multipart.test.ts`（6 case，覆盖 §6 backend HTTP 层）

### RFC-020-T5 — validator 规则

- 文件：`packages/backend/src/services/workflow.validator.ts`
- 改动：遍历 `definition.inputs[]`，对 `kind: 'upload'` 校验 `targetDir` 非空、不含 `..`、不以 `/` 起头；error severity
- 测试：`packages/backend/tests/workflow-validator-upload-input.test.ts`（3 case：缺 targetDir / `..` / happy）

### RFC-020-T6 — 前端 `UploadPicker` + launcher 接线

- 新文件：`packages/frontend/src/components/launch/UploadPicker.tsx`（拖拽 + 点选 + 已选列表 + remove + maxCount 拒收）
- 改动：`packages/frontend/src/routes/workflows.launch.tsx`
  - 平行 state `uploads: Record<string, File[]>`
  - `DynamicInput` 接 `kind === 'upload'` 分支
  - Start 按钮 disabled 计算覆盖 uploads（required / minCount）
  - 提交时构造 `FormData`；通过新 `api/client.ts` 的 `postMultipart` 助手发出
- 改动：`packages/frontend/src/api/client.ts` 新 `postMultipart(url, fd, signal?)`
- 抽出纯函数：`packages/frontend/src/components/launch/buildLaunchFormData.ts`（便于单测）
- 测试：
  - `packages/frontend/tests/upload-picker.test.tsx`（3 case）
  - `packages/frontend/tests/launch-upload-form-data.test.ts`（4 case，纯函数）
  - `packages/frontend/tests/launch-upload-disabled.test.tsx`（3 case）
  - `packages/frontend/tests/launch-route-upload-wiring.test.ts`（源码层兜底）

### RFC-020-T7 — editor `NodeInspector` 支持 upload kind 字段

- 文件：`packages/frontend/src/components/canvas/NodeInspector.tsx`
- 改动：input-kind 下拉加 `upload` 选项；upload 分支字段表单（targetDir / accept / maxFileSize / minCount / maxCount）；targetDir 红字校验
- 测试：`packages/frontend/tests/node-inspector-upload-input.test.tsx`（4 case：切 kind 显字段 / `..` 红字 / accept token 输入 / maxFileSize 边界）

### RFC-020-T8 — i18n 与样式

- `packages/frontend/src/i18n/en-US.ts` / `zh-CN.ts`：加 §3.4 列出的 key
- `packages/frontend/src/styles.css`：`.upload-picker` 系列 class（borrow `.files-picker` 视觉）

### RFC-020-T9 — STATE / plan / e2e

- `STATE.md`：进行中 RFC 标 Done，已完成 RFC 索引追加一行
- `design/plan.md` RFC 索引表 status: Draft → In Progress → Done
- e2e：在 `packages/frontend/e2e/main.spec.ts` 加 1 个 upload 端到端流程（可选；若 e2e 设施成本高则放 follow-up RFC）

## 验收清单（PR 必须全绿）

- shared / backend / frontend 三处全部测试通过
- `bun run typecheck && bun run test && bun run format:check`
- 上传 50MiB pdf / 100 文件压力跑一次（手工 smoke）
- 上传一个含 `..` 的 filename 的工艺 multipart → 400，不留临时文件
- 上传成功后启动一个含 wrapper-git 的 workflow → `tasks/:id/diff` 显示新增 untracked 文件
- 不含 upload 的旧 workflow launcher 完全不变（regression）

## 不在本 RFC 范围

- 目录上传（`webkitdirectory`）
- ZIP 自动解压
- workflow 级共享上传库（跨 task 复用）
- 流式上传 / 断点续传
- import via URL

如需要其中任一项，后续单独立 RFC，先不阻塞本 PR。
