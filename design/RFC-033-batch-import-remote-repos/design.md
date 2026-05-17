# RFC-033 技术设计

> 配套 `proposal.md`。在与 `design/design.md` 冲突时，本文件就 RFC-033 引入的接口、数据流、错误码具有最终解释权；其它部分仍以 `design/design.md` 为准。

## 1. Shared schema 改动（`packages/shared/src/`）

### 1.1 新文件 `schemas/repoBatchImport.ts`

```ts
import { z } from 'zod'

export const BatchImportRowStatusSchema = z.enum([
  'queued',
  'cloning',
  'done',
  'failed',
])
export type BatchImportRowStatus = z.infer<typeof BatchImportRowStatusSchema>

export const BatchImportRowSchema = z.object({
  rowId: z.string(),            // ULID per row, stable across status changes
  inputUrl: z.string(),         // raw input as user typed (already redacted in response)
  inputUrlRedacted: z.string(),
  status: BatchImportRowStatusSchema,
  /** Only set when status === 'done'. */
  cold: z.boolean().nullable(),
  /** True if the warm-path fetch succeeded; null on cold/failed. */
  fetchOk: z.boolean().nullable(),
  /** cached_repos.id once available; null otherwise. */
  cachedRepoId: z.string().nullable(),
  /** Error code on failed; null otherwise. */
  errorCode: z.string().nullable(),
  /** Human-readable, already redacted, ≤400 chars. */
  message: z.string().nullable(),
  /** Wall-clock ISO timestamps for UI sort/age. */
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})
export type BatchImportRow = z.infer<typeof BatchImportRowSchema>

export const BatchImportSnapshotSchema = z.object({
  batchId: z.string(),
  state: z.enum(['running', 'completed']),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  rows: z.array(BatchImportRowSchema),
})
export type BatchImportSnapshot = z.infer<typeof BatchImportSnapshotSchema>

export const StartBatchImportRequestSchema = z.object({
  urls: z.array(z.string().min(1)).min(1).max(100),
})
export type StartBatchImportRequest = z.infer<typeof StartBatchImportRequestSchema>

export const RetryBatchImportRowRequestSchema = z.object({
  url: z.string().min(1).optional(),
})
export type RetryBatchImportRowRequest = z.infer<typeof RetryBatchImportRowRequestSchema>
```

### 1.2 `schemas/ws.ts` 新增 union 分支

```ts
export type RepoImportWsMessage =
  | { type: 'row.update'; row: BatchImportRow }
  | { type: 'batch.completed'; batchId: string; completedAt: string }
  | { type: 'batch.error'; batchId: string; errorCode: string; message: string }

export const REPO_IMPORT_WS_CONTROL_HELLO = 'repo-imports' as const
```

`packages/shared/src/index.ts` 导出新符号。

## 2. 后端 — 新模块 `services/repoBatchImport.ts`

### 2.1 内部数据结构

```ts
interface BatchRecord {
  batchId: string
  state: 'running' | 'completed'
  createdAt: number
  completedAt: number | null
  rows: Map<string, MutableRow>      // rowId → mutable
  order: string[]                    // preserve insertion order
  pendingQueue: string[]             // rowIds awaiting a worker slot
  inFlight: Set<string>
}

interface MutableRow {
  rowId: string
  inputUrl: string
  status: BatchImportRowStatus
  cold: boolean | null
  fetchOk: boolean | null
  cachedRepoId: string | null
  errorCode: string | null
  message: string | null
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

const batches = new Map<string, BatchRecord>()
```

### 2.2 公有 API

```ts
export interface RepoBatchImportDeps {
  db: DbClient
  appHome?: string
  /** Override clone executor (tests). Defaults to resolveCachedRepo. */
  resolveCachedRepo?: typeof resolveCachedRepo
  /** Concurrency cap shared across batches. Default from settings. */
  concurrency?: number
  /** TTL for completed batches before GC. Default 60 min. */
  retentionMs?: number
  now?: () => number
}

export function startBatchImport(
  deps: RepoBatchImportDeps,
  input: { urls: string[] },
): { batchId: string; snapshot: BatchImportSnapshot }

export function getBatchSnapshot(batchId: string): BatchImportSnapshot | null

export function retryBatchRow(
  deps: RepoBatchImportDeps,
  batchId: string,
  rowId: string,
  override?: { url?: string },
): BatchImportSnapshot

/** Called from daemon hourly tick. */
export function gcBatches(now?: () => number): { evicted: number }
```

### 2.3 `startBatchImport` 流程

1. Trim 每个 `urls[i]`，丢弃空行；保留首次出现，case-sensitive 去重。
2. 若去重后 length === 0 → 抛 `ValidationError('batch-empty', ...)`。
3. 若 > 100 → 抛 `ValidationError('batch-too-large', { max: 100 })`。
4. `batchId = ulid()`，建 `BatchRecord` 入 map。
5. 对每个 url：
   - `rowId = ulid()`
   - `parseGitUrl(url)` 为 null → row 初始 `status='failed', errorCode='repo-url-invalid', message='unsupported or malformed Git URL'`，**不入队列**
   - 否则 row 初始 `status='queued'`，append 到 `pendingQueue`
6. 立刻返回 `{ batchId, snapshot: serialize(record) }`（HTTP response 同步走完）
7. `queueMicrotask(() => pumpQueue(deps, record))` 启动 worker；不 await

### 2.4 `pumpQueue` 并发池

```ts
async function pumpQueue(deps, record) {
  while (record.pendingQueue.length > 0 || record.inFlight.size > 0) {
    while (
      record.inFlight.size < (deps.concurrency ?? defaultConcurrency()) &&
      record.pendingQueue.length > 0
    ) {
      const rowId = record.pendingQueue.shift()!
      record.inFlight.add(rowId)
      runRow(deps, record, rowId).catch((err) =>
        // Swallow — runRow already marks row failed; here we only catch
        // accidental escapes to keep the loop alive.
        log.warn('runRow leaked exception', { batchId: record.batchId, rowId, err }),
      )
    }
    await waitForAnyRowToFinish(record)  // resolves once inFlight shrinks
  }
  record.state = 'completed'
  record.completedAt = (deps.now ?? Date.now)()
  repoImportsBroadcaster.broadcast(REPO_IMPORT_CHANNEL(record.batchId), {
    type: 'batch.completed',
    batchId: record.batchId,
    completedAt: new Date(record.completedAt).toISOString(),
  })
}
```

`waitForAnyRowToFinish` 用一个 module-local `Map<batchId, Array<() => void>>` 等待器；`runRow` 完成后触发其中一个。

> **进程级并发上限**：把"3 并发"再用一个全局 semaphore 包一次，让多个并发 batch 共用同一上限，避免开 N 个 batch 起 N*3 个 clone。`defaultConcurrency()` 从 settings 读，1..8。

### 2.5 `runRow`

```ts
async function runRow(deps, record, rowId) {
  const row = record.rows.get(rowId)!
  row.status = 'cloning'
  row.startedAt = now()
  emitRowUpdate(record, row)
  try {
    const result = await (deps.resolveCachedRepo ?? resolveCachedRepo)(
      { db: deps.db, appHome: deps.appHome },
      { url: row.inputUrl },
    )
    row.status = 'done'
    row.cold = result.cold
    row.fetchOk = result.fetchOk
    row.cachedRepoId = result.cached.id
    row.message = result.cold
      ? 'cloned'
      : result.fetchOk
        ? 'cache hit (fetched)'
        : 'cache hit (fetch failed; cache reused)'
  } catch (err) {
    row.status = 'failed'
    if (err instanceof DomainError || err instanceof ValidationError) {
      row.errorCode = err.code
      row.message = clipAndRedact(err.message, row.inputUrl)
    } else {
      row.errorCode = 'internal-error'
      row.message = clipAndRedact((err as Error).message ?? 'unknown', row.inputUrl)
    }
  } finally {
    row.finishedAt = now()
    record.inFlight.delete(rowId)
    emitRowUpdate(record, row)
    resolveWaiter(record)
  }
}

function clipAndRedact(s: string, url: string): string {
  return redactGitUrl(s).slice(0, 400)
}
```

### 2.6 `retryBatchRow`

- 找 row：不存在 → `NotFoundError('row-not-found')`
- row.status 不是 `failed` 或 `done` → `DomainError('row-not-retryable', 409)`
- 若 override.url 提供：替换 row.inputUrl 并做 `parseGitUrl` 预校验；非法 → 直接置 row.failed/repo-url-invalid，emit + 返回 snapshot
- 否则：清掉所有终态字段（cold/fetchOk/cachedRepoId/errorCode/message/startedAt/finishedAt），`status='queued'`，push 到 pendingQueue 尾部
- 若 record.state === 'completed'：rewind 到 'running'，重新启动 pumpQueue
- emit row.update

### 2.7 `gcBatches`

- 遍历 `batches`：state === 'completed' 且 `now - completedAt > retentionMs` → delete
- daemon 在 `services/maintenance.ts`（hourly tick 所在位置；若名字不同则按现有实际文件）注册调用；返回 `{ evicted }` 写日志
- **不**主动取消 running 批次

### 2.8 `serialize(record)` → `BatchImportSnapshot`

- 按 `record.order` 顺序拉 row
- 每个 row 数值时间戳转 ISO；redact `inputUrl` → `inputUrlRedacted`
- response 中 `inputUrl` 字段也走 redact（前端不需要原始 token；保留原始仅在内存中给 worker 用）

### 2.9 错误码汇总

| code | HTTP | 来源 |
|------|------|------|
| `batch-empty` | 400 | startBatchImport |
| `batch-too-large` | 400 | startBatchImport |
| `batch-not-found` | 404 | getBatchSnapshot HTTP wrapper |
| `row-not-found` | 404 | retryBatchRow |
| `row-not-retryable` | 409 | retryBatchRow |
| `repo-url-invalid` | n/a (row state) | parseGitUrl 失败的行 |
| `repo-clone-failed` | n/a (row state) | resolveCachedRepo rethrow |
| `repo-cache-locked` | n/a (row state) | resolveCachedRepo rethrow |
| `internal-error` | n/a (row state) | 兜底 |

## 3. WS 通道

### 3.1 `ws/broadcaster.ts`

```ts
import type { RepoImportWsMessage } from '@agent-workflow/shared'
export const REPO_IMPORT_CHANNEL = (batchId: string): ChannelKey => `repo-import:${batchId}`
export const repoImportsBroadcaster = new TypedBroadcaster<RepoImportWsMessage>()
// resetBroadcastersForTests() 多加一行 repoImportsBroadcaster.reset()
```

### 3.2 `ws/server.ts`

- `WS_PATH_RE` 加 `repoImport: /^\/ws\/repo-imports\/([^/?#]+)$/`
- `ConnectionData['channel']` 多一变体 `{ kind: 'repo-import'; batchId: string }`
- `parseChannel` 多 match；不接受 `?since=`
- `handleOpen` 新增 case：subscribe + hello `{ type: 'hello', channel: 'repo-imports/<batchId>' }`，不做任何 replay
- 不复用 task replay 逻辑

### 3.3 hello control message

复用现有 `WsControlMessage`；`channel` 字段格式 `repo-imports/{batchId}`。

## 4. HTTP 路由（`routes/cached-repos.ts`）

在同文件追加：

```ts
app.post('/api/cached-repos/batch-import', async (c) => {
  const body = StartBatchImportRequestSchema.parse(await c.req.json())
  const { snapshot } = startBatchImport({ db: deps.db }, body)
  return c.json(snapshot, 201)
})

app.get('/api/cached-repos/imports/:batchId', (c) => {
  const snap = getBatchSnapshot(c.req.param('batchId'))
  if (!snap) throw new NotFoundError('batch-not-found', 'batch not found or expired')
  return c.json(snap)
})

app.post('/api/cached-repos/imports/:batchId/rows/:rowId/retry', async (c) => {
  const body = c.req.header('content-length')
    ? RetryBatchImportRowRequestSchema.parse(await c.req.json())
    : {}
  const snap = retryBatchRow({ db: deps.db }, c.req.param('batchId'), c.req.param('rowId'), body)
  return c.json(snap)
})
```

无新中间件。

## 5. 前端改动

### 5.1 `routes/repos.tsx` header

- 在 `<header className="page__header">` 内追加按钮 `批量导入`（`t('repos.batchImport.button')`）
- 点击 → `setOpenBatchImport(true)`，渲染 `<BatchImportDialog open onClose batchId={activeBatchId} onBatchIdChange={setActiveBatchId} />`
- `activeBatchId` 从 `localStorage('repo-import-batch-id')` 初始化；setter 同步写回（null → 删 key）
- 每收到一条 `row.update` 且 `status==='done'`：`qc.invalidateQueries({ queryKey: ['cached-repos'] })`

### 5.2 新组件 `components/repos/BatchImportDialog.tsx`

两态：
- `view = 'input'`：textarea + Start 按钮；Start 后 POST → 拿 batchId、setActiveBatchId、`view='progress'`
- `view = 'progress'`：表格 + 「关闭」 / 「再来一批」
  - 数据源 = `useQuery(['repo-import', batchId])` 初始拉 snapshot；用 `useRepoImportWs(batchId)` 接管 row 状态 patch（内存 reducer）
  - 单行 actions：
    - `failed`：「重试」按钮 → `POST .../rows/:rowId/retry`；可选用 prompt 让用户改 URL 后再发
    - `done`：「在表格中查看」滚到主表对应行（用 `cachedRepoId` 找）
    - `queued / cloning`：禁用所有 action
- modal close：清 `activeBatchId`（如果状态是 `completed`）或保留（仍 running）

### 5.3 新 hook `hooks/useRepoImportWs.ts`

参考 `useTaskSync.ts`：建 WebSocket → onmessage 解析 → 调 reducer。提供：

```ts
export function useRepoImportWs(
  batchId: string | null,
  onRow: (row: BatchImportRow) => void,
  onBatchCompleted: () => void,
): { connected: boolean }
```

token 从全局 config（与 `useTasksSync` 相同读法）取。

### 5.4 i18n keys（新增，中英）

```
repos.batchImport.button             "批量导入" / "Batch import"
repos.batchImport.title              "批量导入远端仓"
repos.batchImport.placeholder        "每行一个 SSH 或 HTTPS Git URL"
repos.batchImport.start              "开始导入"
repos.batchImport.cancel             "取消"
repos.batchImport.close              "关闭"
repos.batchImport.again              "再来一批"
repos.batchImport.col.index          "#"
repos.batchImport.col.url            "URL"
repos.batchImport.col.status         "状态"
repos.batchImport.col.detail         "详情"
repos.batchImport.col.actions        "操作"
repos.batchImport.status.queued      "等待中"
repos.batchImport.status.cloning     "克隆中…"
repos.batchImport.status.done.cold   "克隆成功"
repos.batchImport.status.done.hit    "已缓存（已 fetch）"
repos.batchImport.status.done.hit.fetchFail "已缓存（fetch 失败）"
repos.batchImport.status.failed      "失败"
repos.batchImport.retry              "重试"
repos.batchImport.retryWithEdit      "修改 URL 后重试"
repos.batchImport.batchEmpty         "请粘贴至少一行 URL"
repos.batchImport.batchTooLarge      "单批最多 100 行"
```

### 5.5 styles

`styles.css` +`.batch-import-dialog` `.batch-import-table` 系列；表头/行高/状态颜色（success / running / failed）三档；textarea min-height 200px。

## 6. 配置（settings.json）

新增：

```jsonc
{
  "repoBatchImportConcurrency": 3,    // 1..8
  "repoBatchImportRetentionMs": 3600000  // 默认 60 min
}
```

`ConfigSchema` 注册；`startBatchImport` 走 `getConfig()` 兜底默认。

## 7. 测试策略

### 7.1 Shared (`packages/shared/tests/`)

- `repo-batch-import-schema.test.ts`：所有 zod schema 边界（rowId 必填 / urls 0 拒、101 拒、100 接受 / status enum）—— 5 case
- `redact-url-leak.shared.test.ts`：snapshot 路径里 `inputUrlRedacted` 不含 `user:pass`（用样本含 token 的 URL）—— 1 case

### 7.2 Backend (`packages/backend/tests/`)

- `repo-batch-import.test.ts`（核心）
  - happy path：3 URL → 全 done；rows 顺序保持
  - 1 行非法 URL：初始即 failed，其余 done
  - 1 行 clone 失败（mock resolveCachedRepo 抛 `DomainError('repo-clone-failed')`）：row failed，其余 done，state 终为 completed
  - 并发上限：5 URL + concurrency=2 → 任意时刻 inFlight ≤ 2（断言通过 spy 拿到的并发峰值）
  - 同 URL 重复：去重一份，第二份不入队
  - 全 invalid：state 直接 completed，无 worker 启动
  - WS broadcast：emit `row.update` 计数 = 总行数 + 状态变更次数（queued→cloning→done = 2 次 per success；queued→failed = 1 次）+ `batch.completed` 1 次
  - 共 ~8 case
- `repo-batch-import-retry.test.ts`
  - failed 行 retry → 重新走 → 这次 mock 返回成功 → done
  - done 行 retry → 重置 + 重跑（断言不报错）
  - running 行 retry → 409 row-not-retryable
  - retry with override URL → 用新 URL；保留 rowId
  - retry on completed batch → state 切回 running，新 batch.completed 再次发出
  - 共 5 case
- `repo-batch-import-gc.test.ts`
  - 跑完后 mock now() 推进 > retentionMs → gcBatches 报告 evicted=1 → getBatchSnapshot null
  - running 批次永不被 GC
  - 共 2 case
- `cached-repos-http-batch.test.ts`
  - POST /batch-import 立即返回 201（同步路径 ≤ 50ms 时序断言，用 vi.useFakeTimers 控制）
  - body 校验：超 100、空、非数组
  - GET /imports/:batchId 200 / 404
  - POST retry happy / 404 / 409
  - 共 ~6 case
- `ws-repo-imports.test.ts`
  - 订阅 → 收到 hello
  - row.update / batch.completed 都能透传
  - 错 token 401
  - 共 3 case
- `redact-url-leak-batch.test.ts`：源代码层 grep —— `services/repoBatchImport.ts` 中所有引用 `inputUrl` / 拼 message 的位置必须在同函数内出现 `redactGitUrl` 或穿过 `clipAndRedact`
- 总计 backend ~25 case

### 7.3 Frontend (`packages/frontend/tests/`)

- `BatchImportDialog.test.tsx`
  - 打开 / 关 modal
  - textarea 空 → Start disabled
  - Start 后切到 progress 视图，rows 渲染
  - 收到 row.update reducer 正确合并
  - batch.completed 后底栏出现关闭 + 再来一批
  - failed 行的「重试」按钮可用
  - 共 ~6 case
- `useRepoImportWs.test.ts`：mock WebSocket，收 message → 触发 callback；token 缺失不连
- `repos-page-batch-button.test.tsx`：header 按钮可见 + 点击打开 dialog
- 总计 frontend ~9 case

### 7.4 e2e（`e2e/main.spec.ts`）

- `RFC-033: batch import remote repos`：
  - 启动前在 tmp 建 2 个 bare 仓 A, B
  - 进 /repos → 点 批量导入 → textarea 粘贴 `file://A\nfile://B\ngarbage`
  - Start → 等表格出现 3 行
  - 等 A / B 两行变 done，garbage 行 failed/repo-url-invalid
  - 等 batch.completed → 关闭弹窗
  - 主表多出 2 行 cached repos
  - 共 1 测试

## 8. 安全 / 隐私

- 内存中保留原始 URL（含 token）以便重试 / cache hit；进程外不下行
- `BatchImportRow.inputUrl` 在 HTTP / WS / 日志中已 redact → 字段实际为 `inputUrlRedacted` + alias `inputUrl`（同值），前端只看 redacted
- 错误 message 经 `clipAndRedact`：clip 400 字符 + redactGitUrl
- WS token 校验沿用现有 `timingSafeEquals`，与 task 通道一致

## 9. 多人协作守则

- 不动 RFC-024 既有 `services/gitRepoCache.ts` 公有 API（仅作为调用方使用）
- 与 RFC-032 nav-redesign 的潜在冲突：仅触及 `routes/repos.tsx` 的 header 区域（追加按钮），不动 page shell；RFC-032 若改路由位置，本 RFC 跟随
- 新文件集中可识别：`packages/backend/src/services/repoBatchImport.ts`、`packages/backend/src/ws/repoImports.ts`（如选择拆出 channel 注册）、`packages/frontend/src/components/repos/BatchImportDialog.tsx`、`packages/frontend/src/hooks/useRepoImportWs.ts`、`packages/shared/src/schemas/repoBatchImport.ts`
- 仅对既有文件做加性修改：`routes/cached-repos.ts`（3 个 endpoint 追加）、`ws/server.ts`（1 个 path regex + 1 个 channel case）、`ws/broadcaster.ts`（新增 broadcaster export）、`routes/repos.tsx`（header 加按钮）

## 10. 后续可演进点（非本 RFC 范畴）

- 文件 / CSV 上传
- GitHub / GitLab API 自动列举 owner 仓
- 导入完成后批量起任务（multi-launcher）
- 持久化批次到 DB，daemon 重启后续跑
- 并发上限按 host 分组（每 host 1 个并发，避免触发 GitHub 限流）
- HTTPS 私有仓 PAT 在 settings 统一管理（与 RFC-024 §11 协同）
