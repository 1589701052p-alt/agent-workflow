# RFC-046 — 设计

## 1. 总览

落库 + 透传 + UI 三段，全部加性：

```
runner.ts
  └─ injectMemoryForRun(...)           ← 改造为同时返回 block + snapshot
       └─ loadInjectableMemoriesEnriched(...) ← 新 loader, SELECT 多 4 列
       └─ formatMemoryBlock(set)              ← 不变
  └─ persist node_run row {
       ...既有列,
       injectedMemoriesJson: JSON.stringify(snapshot) | NULL,
     }

GET /api/tasks/:id  + GET /api/tasks/:id/node-runs/:nrid
  └─ rowToNodeRun(...) parse injectedMemoriesJson → InjectedMemorySnapshot[] | null

<SessionTab>
  └─ <InjectedMemoriesCard run={nodeRun} firstAttemptRun={...} />   ← 新组件
```

Envelope-followup 续跑（runner.ts:320 `opts.envelopeFollowup === true`）走单独
分支：跳过 inject（行为不变），但落库前 SELECT 同 `(taskId, nodeId, iteration,
shardKey, reviewIteration, clarifyIteration, retry_index=0)` 的兄弟行，把它的
`injected_memories_json` 复制到当前 retry 行。

## 2. 数据模型

### 2.1 schema 改动

`packages/backend/src/db/schema.ts` `node_runs` 表加 1 列：

```ts
/**
 * RFC-046: snapshot of the approved memories that were injected into this
 * agent run's inline prompt (the `## Learned context` block produced by
 * `formatMemoryBlock`). JSON-serialized `InjectedMemorySnapshot[]` (see
 * shared/schemas/memory.ts). NULL when:
 *   - the run pre-dates RFC-046 (legacy rows),
 *   - kind is non-agent (input/output/wrapper/review/clarify never inject),
 *   - all four scopes resolved to zero memories (mirrors formatMemoryBlock
 *     returning null — the prompt was byte-for-byte unchanged, so there
 *     is genuinely nothing to record).
 *
 * For envelope-followup retries (RFC-042) the column is back-filled from
 * the retry_index=0 sibling row at write time — the followup spawn skips
 * inject but the same opencode session still carries the original block.
 *
 * The snapshot is the *clipped* set (after per-scope budget cut), not the
 * full loader result, so it byte-for-byte matches what the model actually
 * saw. Body / title / tags are captured verbatim so future RFC-045 edits
 * to the canonical memories table never rewrite history.
 */
injectedMemoriesJson: text('injected_memories_json'),
```

Migration 0026（编号按落地时序协调；若 RFC-043 / RFC-045 先落，按实际续号），仅
`ALTER TABLE node_runs ADD COLUMN injected_memories_json TEXT`。无 backfill。

### 2.2 shared schema

`packages/shared/src/schemas/memory.ts` 末段追加：

```ts
export const InjectedMemorySnapshotSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  scopeType: z.enum(['agent', 'workflow', 'repo', 'global']),
  scopeId: z.string().nullable(),
  title: z.string().min(1).max(120),
  bodyMd: z.string().min(1).max(4000),
  tags: z.array(z.string()).max(16),
  sourceKind: z.string(),
  approvedAt: z.number().int().nonnegative().nullable(),
})

export type InjectedMemorySnapshot = z.infer<typeof InjectedMemorySnapshotSchema>
```

`packages/shared/src/schemas/nodeRun.ts`（或现存 `NodeRunSchema` 定义点）追加：

```ts
injectedMemories: z.array(InjectedMemorySnapshotSchema).nullable().optional(),
```

> 设 optional 而非 nullable-required，避免老前端 / 老客户端在 zod parse 旧 API 响应时炸——旧响应根本不带这个键。

### 2.3 不变之处

- `memories` 表本身不动。
- `formatMemoryBlock` 行为不动；它仍按 clip 后集合渲染同一段 markdown。
- 现有 grep 守卫 `runner.ts must include formatMemoryBlock(`（memory-inject.test.ts）不动。

## 3. 后端改动

### 3.1 `services/memoryInject.ts`

#### 3.1.1 enrich loader

新增字段 + 修改 `loadInjectableMemories` 返回行类型，或新增并列函数
`loadInjectableMemoriesEnriched`。**首选并列函数**，避免影响既有 grep / 测试：

```ts
export interface InjectableMemoryRowEnriched extends InjectableMemoryRow {
  version: number
  tags: string[]                       // already parsed from JSON column
  sourceKind: string
  approvedAt: number | null
}

export interface InjectableMemorySetEnriched {
  byScope: {
    agent: InjectableMemoryRowEnriched[]
    workflow: InjectableMemoryRowEnriched[]
    repo: InjectableMemoryRowEnriched[]
    global: InjectableMemoryRowEnriched[]
  }
}
```

SELECT 列扩展为 `id, scope_type, scope_id, title, body_md, created_at, version,
tags, source_kind, approved_at`；`tags` 仍是 JSON 串需 `JSON.parse` 兜底（坏 JSON
回空数组 + warn log）。

#### 3.1.2 改造 `injectMemoryForRun`

```ts
export interface InjectMemoryResult {
  block: string | null
  snapshot: InjectedMemorySnapshot[] | null
}

export async function injectMemoryForRun(deps: {...}): Promise<InjectMemoryResult> {
  // ... existing scope resolution
  const set = await loadInjectableMemoriesEnriched(deps.db, {...})
  const { block, clippedSnapshot } = formatMemoryBlockWithSnapshot(set, budget)
  return { block, snapshot: block === null ? null : clippedSnapshot }
}

// 内部新私有函数；formatMemoryBlock 的小幅 wrapper，复用 clipByBudget。
function formatMemoryBlockWithSnapshot(
  set: InjectableMemorySetEnriched,
  budget: ScopeBudget,
): { block: string | null; clippedSnapshot: InjectedMemorySnapshot[] } {
  const agent = clipByBudget(set.byScope.agent, budget.agent)
  const workflow = clipByBudget(set.byScope.workflow, budget.workflow)
  const repo = clipByBudget(set.byScope.repo, budget.repo)
  const global = clipByBudget(set.byScope.global, budget.global)
  const all = [...agent, ...workflow, ...repo, ...global]
  if (all.length === 0) return { block: null, clippedSnapshot: [] }
  // ... same block render as formatMemoryBlock today
  return { block, clippedSnapshot: all.map(toSnapshot) }
}
```

> `clipByBudget` 签名是泛型友好的（`readonly InjectableMemoryRow[]`），enriched 子类型直接通；类型 narrow 时显式 `as InjectableMemoryRowEnriched[]` 或把签名改成 `<T extends InjectableMemoryRow>`。优先后者，零运行时开销。

block 渲染逻辑保留为旧 `formatMemoryBlock`（已被 grep guard 锁），新私有函数复用同一渲染——避免漂移。最干净的做法是 `formatMemoryBlock` 内部调用新函数取 block 字段：

```ts
export function formatMemoryBlock(set, budget = DEFAULT_BUDGET): string | null {
  return formatMemoryBlockWithSnapshot(set as InjectableMemorySetEnriched, budget).block
}
```

`InjectableMemorySet` 在所有现存测试里只读字段 `id/scopeType/scopeId/title/bodyMd/createdAt`，扩展为父子集合不破坏老 fixture（多余字段 ignore）。

### 3.2 `services/runner.ts`

#### 3.2.1 非 followup 路径（runner.ts:320 当前 if 块）

```ts
let injectedSnapshot: InjectedMemorySnapshot[] | null = null
if (opts.envelopeFollowup !== true) {
  try {
    const { block, snapshot } = await injectMemoryForRun({ ... })
    if (block !== null) {
      const primary = inlineConfig.agent[opts.agent.name]
      if (primary !== undefined && typeof primary.prompt === 'string') {
        primary.prompt = `${primary.prompt}\n\n${block}`
      }
    }
    injectedSnapshot = snapshot
  } catch (err) {
    log.warn('memory-inject-failed', { nodeRunId: opts.nodeRunId, error: ... })
    // injectedSnapshot stays null — same fail-safe as today.
  }
}
```

#### 3.2.2 followup 路径

`runner.ts` 在落 `node_runs` 行的 path（搜 `tokTotal: result.tokTotal` 或类似最终 UPDATE）之前：

```ts
if (opts.envelopeFollowup === true) {
  injectedSnapshot = await loadInjectedSnapshotFromFirstAttempt(deps.db, {
    taskId: opts.taskId,
    nodeId: opts.nodeId,
    iteration: opts.iteration,
    shardKey: opts.shardKey ?? null,
    reviewIteration: opts.reviewIteration,
    clarifyIteration: opts.clarifyIteration,
  })
  // null safe — NULL on attempt 0 stays NULL on this row too.
}
```

新 helper 放在 `services/memoryInject.ts`：

```ts
export async function loadInjectedSnapshotFromFirstAttempt(
  db: DbClient,
  ctx: {
    taskId: string
    nodeId: string
    iteration: number
    shardKey: string | null
    reviewIteration: number
    clarifyIteration: number
  },
): Promise<InjectedMemorySnapshot[] | null> {
  const row = (
    await db
      .select({ json: nodeRuns.injectedMemoriesJson })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, ctx.taskId),
          eq(nodeRuns.nodeId, ctx.nodeId),
          eq(nodeRuns.iteration, ctx.iteration),
          ctx.shardKey === null
            ? isNull(nodeRuns.shardKey)
            : eq(nodeRuns.shardKey, ctx.shardKey),
          eq(nodeRuns.reviewIteration, ctx.reviewIteration),
          eq(nodeRuns.clarifyIteration, ctx.clarifyIteration),
          eq(nodeRuns.retryIndex, 0),
        ),
      )
      .limit(1)
  )[0]
  if (row?.json == null) return null
  try {
    return z.array(InjectedMemorySnapshotSchema).parse(JSON.parse(row.json))
  } catch (err) {
    log.warn('rfc046/inherit-parse-failed', { taskId: ctx.taskId, err: ... })
    return null
  }
}
```

#### 3.2.3 落库

把 `injectedMemoriesJson` 加到 runner 最终 `UPDATE` 列集合：

```ts
.set({
  ...,
  injectedMemoriesJson: injectedSnapshot === null
    ? null
    : JSON.stringify(injectedSnapshot),
})
```

> 失败 / 取消 / 中断分支：runner 在 catch 块写 `failed` 状态时不刷 `injectedMemoriesJson`（默认 NULL）——这与"运行实际没注入到模型"的事实一致，前端不显示老行兼容文案而显示"0 注入"。如果 inject 已经成功但后续 spawn 失败，仍写入 snapshot（因为模型已经看到了那段），与现状 `tokTotal` 等列的语义一致。

### 3.3 REST 端点

`routes/tasks.ts` 把 `rowToNodeRun` 内的 `injectedMemoriesJson` parse 出来挂到响应：

```ts
function rowToNodeRun(row: NodeRunRow): NodeRun {
  return {
    ...,
    injectedMemories: parseInjectedMemoriesField(row.injectedMemoriesJson),
  }
}

function parseInjectedMemoriesField(json: string | null): InjectedMemorySnapshot[] | null {
  if (json == null) return null
  try {
    return z.array(InjectedMemorySnapshotSchema).parse(JSON.parse(json))
  } catch (err) {
    log.warn('rfc046/api-parse-failed', { err: ... })
    return null   // degrade to "Not captured", do not 5xx
  }
}
```

`GET /api/tasks/:taskId`（带 `runs[]`）、`GET /api/tasks/:taskId/node-runs/:nrid` 复用同一函数。

### 3.4 WS

不引入新消息。`node.update` 在 runner 落 `node_runs` 最终 UPDATE 后已经推送一次；订阅者重新 `invalidateQueries(['task', taskId])` 自然吃到新字段。

## 4. 前端改动

### 4.1 组件树

```
SessionTab.tsx
  ├─ <AttemptPicker />                       ← 既有 (RFC-011/RFC-027)
  ├─ <InjectedMemoriesCard ... />            ← 新
  └─ <ConversationFlow events={...} />       ← 既有 (RFC-027)
```

### 4.2 `<InjectedMemoriesCard>` 设计

```tsx
interface Props {
  run: NodeRun                                // active attempt 的 nodeRun
  firstAttemptRun?: NodeRun                   // retry_index=0 兄弟 run (用于 followup 锚点)
}

function InjectedMemoriesCard({ run, firstAttemptRun }: Props) {
  // 不渲染：非 agent kind
  if (!isAgentKind(run.kind)) return null

  const isFollowup = run.envelopeFollowup === true && run.retryIndex > 0
  const list = run.injectedMemories  // InjectedMemorySnapshot[] | null
  const groups = groupByScope(list ?? [])

  // 三态计算 N
  const labelN = list === null ? '—' : String(list.length)
  const status: 'captured' | 'empty' | 'pre-rfc046' =
    list === null ? 'pre-rfc046' : list.length === 0 ? 'empty' : 'captured'

  return (
    <details className="injected-memories-card">
      <summary>
        {t('nodeSession.injectedMemoriesTitle', { n: labelN })}
        {isFollowup && (
          <span className="injected-memories-card__inherit">
            {t('nodeSession.inheritedFromAttempt0')}
          </span>
        )}
      </summary>
      {status === 'pre-rfc046' && <p className="muted">{t('nodeSession.notCaptured')}</p>}
      {status === 'empty' && <p className="muted">{t('nodeSession.empty')}</p>}
      {status === 'captured' && (
        <ScopeGroupedList groups={groups} />
      )}
    </details>
  )
}
```

`<ScopeGroupedList>`：四组 fixed 顺序 `agent / workflow / repo / global`，每组标题 + 列表。条目用 `<details>`（嵌套，行级 toggle 看 body 全文）：

```tsx
<details className="injected-memory-row">
  <summary>
    <ScopeChip type={m.scopeType} id={m.scopeId} />
    <span className="injected-memory-row__title">{m.title}</span>
    <span className="injected-memory-row__version">v{m.version}</span>
    {m.tags.map((t) => <TagChip key={t} label={t} />)}
    <span className="injected-memory-row__preview">{previewOf(m.bodyMd)}</span>
  </summary>
  <MarkdownRenderer source={m.bodyMd} />
</details>
```

`previewOf` 取前 200 字符 + ellipsis。

### 4.3 纯函数（便于单测）

`lib/injected-memories-card.ts`：

```ts
export function groupByScope(list: readonly InjectedMemorySnapshot[]): {
  agent: InjectedMemorySnapshot[]
  workflow: InjectedMemorySnapshot[]
  repo: InjectedMemorySnapshot[]
  global: InjectedMemorySnapshot[]
}
export function previewOf(bodyMd: string, max = 200): string
export function isAgentKind(kind: string): boolean
export function decideStatus(list: InjectedMemorySnapshot[] | null | undefined):
  'captured' | 'empty' | 'pre-rfc046'
```

### 4.4 i18n

`i18n/zh-CN.ts` / `en-US.ts` 新增（成对）：

| key | zh-CN | en-US |
|-----|-------|-------|
| `nodeSession.injectedMemoriesTitle` | `已注入记忆 ({{n}})` | `Injected memories ({{n}})` |
| `nodeSession.injectedMemoriesEmpty` | `本次未注入任何记忆` | `No memories injected` |
| `nodeSession.injectedMemoriesNotCaptured` | `本次运行早于 RFC-046，未记录注入清单` | `Inject record not captured (pre-RFC-046 run)` |
| `nodeSession.injectedMemoriesInheritedFromAttempt0` | `沿用 attempt 0 的注入快照` | `Inherited from attempt 0` |
| `nodeSession.injectedMemoriesGroupAgent` | `Agent 范围` | `Agent scope` |
| `nodeSession.injectedMemoriesGroupWorkflow` | `Workflow 范围` | `Workflow scope` |
| `nodeSession.injectedMemoriesGroupRepo` | `Repo 范围` | `Repo scope` |
| `nodeSession.injectedMemoriesGroupGlobal` | `全局` | `Global` |
| `nodeSession.injectedMemoriesVersionLabel` | `v{{n}}` | `v{{n}}` |
| `nodeSession.injectedMemoriesUpdatedSinceRun` | `运行后已被编辑` | `Updated since this run` |

`zh-CN.ts` 的 `Resources` 接口同步加同名字段（仓约一直要求双侧扁平 key 集合相等，详见既有 `i18n-keys-symmetry.test.ts`）。

### 4.5 样式

`styles.css` 新命名空间 `.injected-memories-card`：

- `<details>` 默认折叠，宽度填满，左侧 2px accent border + 圆角 6px。
- `<summary>` 24px 行高、token chip 间距 8px。
- `__inherit` chip 11px 灰底（与 RFC-026 `chip.inline` 同视觉语言）。
- `.injected-memory-row` 嵌套 `<details>` 用更窄缩进，preview 文本单行截断 + ellipsis。

不引入 emoji（CLAUDE.md 默认禁，沿用现有 chip 文字风格）。

## 5. 测试策略

### 5.1 shared

`packages/shared/test/injected-memory-schema.test.ts`：

| # | 用例 |
|---|------|
| S1 | `InjectedMemorySnapshotSchema.parse` round-trip 完整 fixture（agent / workflow / repo / global 各 1） |
| S2 | `scopeId: null` 在 scopeType ≠ 'global' 时仍接受（不强制约束，前端 / DB 不依赖此处兜底） |
| S3 | tags 17 条 → 拒绝（沿用 MemorySchema 16 上限语义） |
| S4 | 错 scopeType → 拒绝 |
| S5 | `NodeRunSchema.parse(legacyRow)`（不带 `injectedMemories`）不报错（optional） |

### 5.2 backend

`packages/backend/test/memory-inject-snapshot.test.ts`：

| # | 用例 |
|---|------|
| B1 | `injectMemoryForRun` 返回 `{ block, snapshot }` 双字段；snapshot 全字段对齐 DB 行 |
| B2 | budget clip 后才落库——故意把一条 tail-of-agent-scope clip 掉，snapshot 不含它，block 也不含 |
| B3 | 四 scope 全空 → snapshot = null（与 block = null 同步） |
| B4 | enriched loader 解析坏 `tags` JSON → 该行 tags = []，不抛错 |

`packages/backend/test/runner-injected-memories.test.ts`：

| # | 用例 |
|---|------|
| R1 | 正常 agent 跑通 → `node_runs.injected_memories_json` 落 N 条 JSON |
| R2 | envelope-followup retry → 当前行 json = attempt-0 行 json 的拷贝（指针级相等的字符串） |
| R3 | envelope-followup retry 但 attempt-0 行 NULL → 当前行也 NULL |
| R4 | non-agent kind（input / output / wrapper / review / clarify） → 列恒为 NULL（runner 走不到 inject 分支） |
| R5 | inject 抛错 → 列为 NULL，agent run 仍按现状跑通（fail-safe 保留） |
| R6 | `formatMemoryBlock` 字节级输出与改造前对账（grep guard 同时回归） |

`packages/backend/test/api-task-injected-memories.test.ts`：

| # | 用例 |
|---|------|
| A1 | `GET /api/tasks/:id` 嵌套 runs[] 含 `injectedMemories: [...]` |
| A2 | `GET /api/tasks/:id/node-runs/:nrid` 单返同字段 |
| A3 | DB json 损坏 → API 回 `injectedMemories: null` + warn log 不 5xx |
| A4 | 老行（NULL）→ API 回 `null` |

`packages/backend/test/migration-0026.test.ts`：

| # | 用例 |
|---|------|
| M1 | 新表创建后 `node_runs.injected_memories_json` 存在且为 nullable text |
| M2 | 老 row（无该列）upgrade 后字段读出来是 null |

### 5.3 frontend

`packages/frontend/test/injected-memories-card.test.tsx`：

| # | 用例 |
|---|------|
| F1 | `kind=input/wrapper-git/wrapper-loop/review/clarify/output` 时组件返回 null |
| F2 | `injectedMemories === null` → 显示 "Inject record not captured" |
| F3 | `injectedMemories === []` → 显示 "No memories injected"，标题 N=0 |
| F4 | 3 条 mix scope → 按 agent → workflow → repo → global 顺序 grouped 渲染，标题 N=3 |
| F5 | 单条 body 长 500 字符 → summary 渲染 200 字符 + ellipsis；点 details 展开后 MarkdownRenderer 收到全文 |
| F6 | followup retry → 标题旁出现 `Inherited from attempt 0` chip |
| F7 | followup retry + attempt 0 也 null → 三态显示 "Not captured"（NULL 优先于 followup 文案） |
| F8 | version chip / tag chip 渲染 |
| F9 | i18n 中英 round-trip + key-symmetry 测试通过 |
| F10 | `decideStatus(undefined)` 等价 `'pre-rfc046'`（兼容 optional） |

`packages/frontend/test/session-tab-injected-memories-mount.test.tsx`：

| # | 用例 |
|---|------|
| M1 | `<SessionTab>` 渲染时 `<InjectedMemoriesCard>` 出现在 `<AttemptPicker>` 之后、`<ConversationFlow>` 之前（DOM 顺序断言） |
| M2 | 源码层 grep guard：`SessionTab.tsx` 必含 `<InjectedMemoriesCard` 字面 |

## 6. 性能与一致性

- 落库一次额外 `JSON.stringify`（N ≤ 20 条 × 平均 1KB → 20KB 量级）+ 一次 UPDATE 列。延迟 < 1ms。
- envelope-followup 走多一次 SELECT（`(task_id, node_id, iteration, shard_key, review_iter, clarify_iter, retry_index=0)`，命中既有索引 `idx_node_runs_task_node`）。命中率 100%（attempt 0 必先于 followup 跑出来）。
- 不引入新事务。该列与 `tokTotal` 等列同一最终 UPDATE，原子性已经由 SQLite WAL 保证。
- 内存：snapshot 在 runner 进程内仅持有 N ≤ 20 行 × ~1KB；序列化为 JSON 后 ≤ 25KB；远低于既有 `inventorySnapshotJson` 量级。

## 7. 错误恢复 / 边界

| 场景 | 行为 |
|------|------|
| `injectMemoryForRun` 抛错 | snapshot = null（与 block = null 同），run 继续。fail-safe 保留 |
| `JSON.stringify(snapshot)` 抛错（理论不会） | 抛进 runner catch → fall through 到上面分支，列写 null |
| API parse 损坏 JSON | 回 null + warn，不 5xx |
| 老行（NULL） | API 回 null，前端 "Not captured" |
| followup attempt 0 行 NULL | followup 行也 NULL，"Not captured"（统一兜底；不在 UI 上特殊标"该看 attempt 0"，因为 attempt 0 本就没记录） |
| 跨 retry 同 attempt 0 多行（理论不应出现） | `.limit(1)` 取第一条 |
| body_md 含 ` ` 等不可序列化字符 | JSON.stringify 已经标准化；不额外清理（zod parse 时按字符串放行） |
| body_md 含 Markdown 注入（XSS） | 既有 `<MarkdownRenderer>` 已 sanitize；新组件不引入额外 XSS 面 |
| RFC-045 落地后 admin 编辑 memory body | snapshot 是当时的 v；前端 `<MarkdownRenderer>` 渲染历史 body 与 `/memory/$id` 当前 body 可能不一致——这是"快照"语义本身，不视为 bug。可选展示 `Updated since this run` chip 由前端按 active memory 对比 version 计算 |
| memory 被 archived / superseded / rejected | snapshot 仍可见（来自快照），不去 `memories` 表 join；展示与当前状态无关 |

## 8. 与既有代码的耦合

| 模块 | 耦合点 | 改动量 |
|------|-------|--------|
| `services/memoryInject.ts` | 加 enriched loader + `formatMemoryBlockWithSnapshot` 私有函数 + `injectMemoryForRun` 返回签名 + `loadInjectedSnapshotFromFirstAttempt` | ~80 行加性，0 删除 |
| `services/runner.ts` | 两处：snapshot 接收 + followup 分支 + 最终 UPDATE 列 | ~30 行加性 |
| `routes/tasks.ts` | `rowToNodeRun` parse | ~10 行加性 |
| `db/schema.ts` | 加列 | 1 字段 |
| migrations/`0026_xxx.sql` | ALTER TABLE | 1 行 |
| `shared/schemas/memory.ts` | 加 `InjectedMemorySnapshotSchema` | ~15 行 |
| `shared/schemas/nodeRun.ts` | optional field | 1 行 |
| `components/node-session/SessionTab.tsx` | mount 新卡片 | 3 行 |
| `components/node-session/InjectedMemoriesCard.tsx` | 新组件 | ~120 行 |
| `lib/injected-memories-card.ts` | 4 个纯函数 | ~50 行 |
| `i18n/{zh-CN,en-US}.ts` | 10 key 双侧 | ~30 行 |
| `styles.css` | 命名空间 | ~40 行 |

无 WS schema 改动；无 scheduler / wrapper / clarify / review / runtime / opencode 源码改动。

## 9. 回滚

- 回滚 PR 时把列保留为 dead column（SQLite 不支持 `DROP COLUMN`<3.35；项目用的 bun:sqlite 一般支持但仍按"never drop"惯例）。
- 前端 / 后端 / shared 改动全部回滚 = 行为回到 RFC-041 现状（live read，不落库）。
- 数据迁移：列里历史 JSON 留着无副作用；任何升级也能再次读取。
