# RFC-033 远端仓页面批量导入远端仓

> 状态：Draft
> 关联：RFC-024（`/repos` 页 + `cached_repos` 表 + `resolveCachedRepo` 单 URL 缓存克隆）；WS 基础设施（`packages/backend/src/ws/`）；不与并发热区 `services/scheduler.ts` / `services/runner.ts` / `services/review.ts` / `services/clarify.ts` 冲突。

## 背景

当前 `/repos` 页面（RFC-024）只能**被动**展示用户从 Launcher 启过任务后产生的 cached repos——条目是从 `POST /api/tasks` 走 `repoUrl` 流程时**隐式**写入 `cached_repos` 表的。这意味着：

- 想"先备好一批仓再开始工作"的用户必须挨个发起一次假任务来触发 clone
- 评审 / Audit 场景下"一次给框架投喂十几个第三方仓"没有顺手的入口
- `/repos` 页只有 Refresh / Delete 两个动作（`packages/frontend/src/routes/repos.tsx:78-101`），缺少"新增"这一最基本的列表操作

我们需要在 `/repos` 页加一个"批量导入"入口，让用户能：

1. 一次贴入多行 SSH / HTTPS Git URL（每行一个）
2. 后端入队异步 mirror clone，不阻塞页面
3. UI 实时（WS 推进度）显示每行状态：等待 / 克隆中 / 成功（cold 或 hit）/ 失败（脱敏 stderr）
4. 单行失败不影响其余行；全部完成后保留结果汇总，用户可关闭弹窗或继续导入下一批

## 目标

- `/repos` 页头部新增「批量导入」按钮，点开 modal：textarea（每行一个 URL，可粘贴一批） + Start + 实时表
- 后端新接口 `POST /api/cached-repos/batch-import` → 即时返回 `{ batchId, rows }`（每行预解析后的初始状态：`queued` 或 `invalid-url`）；不阻塞 HTTP 调用等待 clone
- 后端 batch worker 用并发池（默认 3 并发，配置可改）逐条调既有的 `resolveCachedRepo`；同 URL 借现有 `withUrlLock` 自然串行
- 新 WS 通道 `/ws/repo-imports/{batchId}`：推送 row 状态变更 + batch 完成事件
- 新接口 `GET /api/cached-repos/imports/:batchId` 用于 WS 断线 / 页面刷新后拉当前快照
- 完整 row 状态：`queued` → `cloning` → `done`（带 `cold: boolean` + cached repo 引用） / `failed`（带 `code` + 脱敏 message）；URL 语法非法的行**不入队**，初始就是 `failed/repo-url-invalid`
- 同 URL 已存在 cache：走 `resolveCachedRepo` 自动 fetch 后归类为 `done` + `cold=false`，不报错也不重 clone
- 批次状态：`running` → `completed`（所有行终态后置位，不论成败）；非 `completed` 状态在内存里保留 60 min，过期 GC，期间 `GET` 仍可取
- 失败行可在表内点「重试」单条重发：复用同一 batchId 重置该行状态 → 重新跑

## 非目标

- **不做 import 历史持久化**：批次 + 行状态仅存于 daemon 内存，daemon 重启即丢；用户关心的最终成果（cached_repos 行）已经在 DB 里
- **不做"导入失败时自动回滚已成功的行"**：与"逐条独立"语义冲突；用户对成功行可在主表用 Delete
- **不做文件 / CSV 上传**：v1 只接受 textarea；多行文本已经能用顶层粘贴覆盖典型 GitHub repo 列表
- **不做 OAuth / GitHub API 自动列举 owner 仓**：超出 RFC-024 不引入 credential 管理的边界
- **不做导入完成后自动起任务**：本 RFC 只产出 cached repo，起任务仍走 Launcher
- **不改 RFC-024 既有 `resolveCachedRepo` 行为**：本 RFC 是其上层 batch 调度器
- **不改 Launcher / 任务流程**：单 URL 起任务隐式 clone 路径继续工作
- **不引入新 DB 表**：复用 `cached_repos`；批次态在内存

## 用户故事

1. 用户在浏览器打开 `/repos`，看到顶部除了 Refresh All 之外多了一个「批量导入」按钮
2. 点按钮 → 弹 modal：标题"批量导入远端仓"，正文一个 textarea（占位文字"每行一个 SSH 或 HTTPS Git URL"），下面有 Start / 取消
3. 粘贴 12 行 URL（含 1 行明显错的 `not a url`），点 Start
4. modal 切到「导入进度」视图：12 行表格，列：`#`、`URL（脱敏）`、`状态`、`详情`、`操作（重试/删除）`
   - 错误那行立即显示 `失败 · repo-url-invalid`
   - 其余 11 行 `等待中`，前 3 个并发跳成 `克隆中…`
5. 每个 clone 完成（或失败）通过 WS 推过来，对应行变 `成功（cold）` / `成功（hit）` / `失败 · repo-clone-failed · auth fail`（脱敏 stderr 摘要）
6. 12 行都到终态后，modal 底部出现「关闭」按钮 + 「再来一批」按钮；同时主页的 cached repos 列表自动刷新（沿用 react-query invalidate）
7. 用户对失败那一行点「重试 URL」（小弹框允许修改 URL 后再发）或「跳过」（仅在 UI 移除该行，不影响别人）
8. 用户关闭页签前 batch 未完成 → 重开 modal 走 `GET /api/cached-repos/imports/:batchId` 续接（前端用 localStorage 记最后一次活跃 batchId）

## 验收标准

- 顶部「批量导入」按钮渲染在 `/repos` 页 header，无任何 cached repos 时也可见
- modal 在打开时聚焦 textarea，Esc 关闭，背景遮罩点击不关闭（防误关丢失输入）
- Start 前前端做一次 `parseGitUrl` 预校验：所有行 trim + 去空行 + 去重；空 textarea → 按钮 disabled
- `POST /api/cached-repos/batch-import` 在收到 1..N 行后立即返回（< 200ms 时序保证，clone 不占 HTTP 等待）：
  - body: `{ urls: string[] }`，最多 100 行；超限 → 400 `batch-too-large`
  - 全部为空 / 全部去重后为空 → 400 `batch-empty`
  - 返回 `{ batchId: ULID, rows: BatchImportRow[] }`，rows 顺序 = 去重后输入顺序
- WS `/ws/repo-imports/{batchId}` 与现有 `/ws/tasks/*` 同款 token 校验、同款 `hello` 控制帧；`?since=N` 不支持（批次内存不入库，无 replay）
- WS 消息类型：`row.update`（单行状态变化）+ `batch.completed`（全终态）+ `batch.error`（worker 自身崩溃，少见兜底）
- 关注脱敏：任何 row 的 message / error 字段在送往前端 / 日志 / WS 之前必须经 `redactGitUrl`，包含 token 的 URL 不得原样下行；新增 source-grep 兜底测试
- 并发：单 batch 内最多 3 个 clone 并发（`settings.repoBatchImportConcurrency`，默认 3，1..8 区间）；不同 batch 间共享同一全局 limiter（避免开两个 batch 一起 6 个 clone 把磁盘打爆）
- 同 URL 同批：去重在前端做、后端也兜底；同 URL 跨批：靠 `resolveCachedRepo` 内的 `withUrlLock` 串行，第二批拿到 cache hit
- 已存在 cache 的 URL：返回 `status: 'done'`、`cold: false`、`message: 'cache hit (fetched)'`；如 fetch 失败但 cache 可用，仍 `done` + `cold: false` + `fetchOk: false` 字段
- 单行失败不传染：`failed` 行 push 到 WS 后 worker 继续吃下一行
- 重试单条接口 `POST /api/cached-repos/imports/:batchId/rows/:rowId/retry`（可选带 `{ url?: string }` 改写 URL）：行状态重置为 `queued` → worker 重新拿 → 再走 clone；只允许在终态行上调用，否则 409 `row-not-retryable`
- 批次内存 60 min 后被 background GC（沿用 daemon 已有的 hourly tick）；GC 后 `GET` 返回 404 `batch-not-found`
- 主页 cached repos 列表在每条 row 变 `done` 时被前端 react-query invalidate（成功一条就刷一次）
- 启用 `bun run typecheck && bun run test && bun run format:check` 全绿；新增测试覆盖至少 20 case（详见 `design.md §测试策略`）

## 与现有模块的关系

- `services/gitRepoCache.ts`：零改动；只复用 `resolveCachedRepo` / `parseGitUrl` / `redactGitUrl`
- `routes/cached-repos.ts`：在同文件挂载 `POST /api/cached-repos/batch-import` / `GET /api/cached-repos/imports/:batchId` / `POST /api/cached-repos/imports/:batchId/rows/:rowId/retry`，与既有 list/refresh/delete 三个 endpoint 并列
- `ws/broadcaster.ts`：新增 `repoImportsBroadcaster` + `REPO_IMPORT_CHANNEL(batchId)`；与 task/tasksList/workflows broadcaster 同模式
- `ws/server.ts`：parseChannel 多识别一条正则 `/^\/ws\/repo-imports\/([^/?#]+)$/`，开 ws 时订阅对应 channel；不支持 `?since=` replay
- 前端 `routes/repos.tsx`：header 加按钮；modal 新增组件 `BatchImportDialog.tsx`；新 hook `useRepoImportWs(batchId)`
- 不动 `services/scheduler.ts` / `services/runner.ts` / `services/review.ts` / `services/clarify.ts` / `services/task.ts`
- 不改 DB schema、不新增 migration

## 失败模式回顾

| 场景 | 处理 |
|------|------|
| 行 URL 语法非法 | 入队前置 `parseGitUrl` 失败 → 行初始即 `failed/repo-url-invalid`，不占并发槽 |
| 行 clone 失败 | `resolveCachedRepo` 抛 `DomainError('repo-clone-failed', ...)` → 行 `failed/repo-clone-failed` + 脱敏 stderr 摘要（首 400 字符） |
| 行 fetch 失败但 cache 可用 | `done/cold=false/fetchOk=false`（非致命，与 RFC-024 行为一致） |
| 行 clone 卡住 → 触发 `repo-cache-locked` 超时 | 行 `failed/repo-cache-locked` 30 min 后置位；worker 继续下一行 |
| 同 URL 多行（去重后还有重复，例如大小写差异） | 后端 worker 内置二次去重 + 同 URL withUrlLock 自然串行；后到的那个会立刻 cache hit |
| 用户关掉浏览器 | 后端继续跑；下次打开 modal 时按 localStorage 里上次 batchId 拉 `GET /imports/:batchId` 续接 |
| daemon 重启 | 进行中 batch 全部丢失（内存态），前端 WS 收 close → modal 提示"daemon 重启，请重新发起"；DB 里已成功的 cached_repos 行**保留**（resolveCachedRepo 中途 crash 不会写半成品 INSERT，因 INSERT 在 atomic rename 之后） |
| 批次大小 > 100 行 | 400 `batch-too-large`，前端表单红字 |
| URL 含 user:pass token 在日志 / WS / response 中泄漏 | 全链路 `redactGitUrl`；新增源代码层 grep 兜底测试 |
| GC 超期后用户重连 | `GET` 404，前端 modal 切回输入态，localStorage 该 batchId 清掉 |
| 异常重复点 Start | 弹窗内 Start 按钮在请求 in-flight 时 disabled；后端不做幂等性，因为 batchId 由后端生成、每次返回不同 |

## 多人协作

- 不与 RFC-032（nav-redesign，Draft 中）共享 `/repos` 路由内部结构改动；如 RFC-032 把 `/repos` 整体搬位置，本 RFC 跟随；如 RFC-032 后落地，对方负责把新 BatchImportDialog 引用一并迁
- 不动 `services/scheduler.ts` / `services/runner.ts`（主并发热区）
- 新增文件集中：`services/repoBatchImport.ts`、`routes/cached-repos.ts`（既有文件追加）、`ws/repoImports.ts`（新文件，channel 注册集中点）、`frontend/src/components/repos/BatchImportDialog.tsx`、`frontend/src/hooks/useRepoImportWs.ts`
- 与 RFC-024 已落地的 `services/gitRepoCache.ts` 不互改，保持单一职责
