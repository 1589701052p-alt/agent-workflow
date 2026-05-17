# RFC-030 — 技术设计

## 0. 范围回顾

- **触发方式**：完全按需，POST 接口。结果落 DB（`mcp_probes`，UNIQUE(mcpId)，UPSERT）。
- **UI 暴露面**：`/mcps` 列表行增列 + 行内展开；`/mcps/$name` 详情页加完整 Inventory 区。
- **数据维度**：serverInfo + protocolVersion + capabilities + tools (含 inputSchema) + resources (含 resourceTemplates) + prompts + 整体延时。
- **失败语义**：六种 error code，全部可回放（持久化 + 接口透传）。

## 1. 依赖

新增到 `packages/backend/package.json`：

```json
"@modelcontextprotocol/sdk": "<lock-matched-with-opencode>"
```

锁定版本对齐 `/Users/wangbinquan/Documents/code/opencode/bun.lock` 内的同名 dep（写 RFC 时记录 commit；落地时再次 grep 取最新已验证版本，避免半年期 API 漂移）。仅后端使用；前端无新增依赖。

## 2. 数据模型

### 2.1 新表 `mcp_probes`

`packages/backend/src/db/schema.ts` 末尾新增（不动 `mcps`）：

```ts
export const mcpProbes = sqliteTable('mcp_probes', {
  id: text('id').primaryKey(), // ULID
  mcpId: text('mcp_id').notNull().unique().references(() => mcps.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['ok', 'error'] }).notNull(),
  // 总延时（从开始 connect 到全部 list 完成或 fail）
  latencyMs: integer('latency_ms').notNull(),
  // 仅握手延时（connect + initialize），用于细粒度诊断
  handshakeMs: integer('handshake_ms'),
  // serverInfo & 协议信息（initialize 响应）
  serverInfoJson: text('server_info_json'), // {name, version}
  protocolVersion: text('protocol_version'),
  capabilitiesJson: text('capabilities_json'), // 原样透传 SDK 给出的 capabilities
  // 三类清单（任何一类失败为 null + error 走 errorDetailJson.partialFailures[]）
  toolsJson: text('tools_json'),               // Array<{name,title?,description?,inputSchema?}>
  resourcesJson: text('resources_json'),       // Array<{uri,name?,description?,mimeType?}>
  resourceTemplatesJson: text('resource_templates_json'),
  promptsJson: text('prompts_json'),           // Array<{name,description?,arguments?[]}>
  // 失败时填写
  errorCode: text('error_code'),               // see proposal §5 #4
  errorMessage: text('error_message'),
  errorDetailJson: text('error_detail_json'),  // {stderr?, httpStatus?, partialFailures?: [{method,message}]}
  schemaVersion: integer('schema_version').notNull().default(1),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
```

> 索引：UNIQUE(mcp_id) 已隐含 idx；不再加 (status) 索引——查询都按 mcp_id 走，行数等于 enabled mcp 数量（量级几十）。

Migration 文件命名：`packages/backend/db/migrations/00NN_rfc030_mcp_probes.sql`（编号衔接 RFC-029，写 RFC 时 RFC-027 已占 0012；RFC-029 plan.md 未明确分配，需要 plan.md 落地时实际生成的编号 +1）。

### 2.2 shared schema

`packages/shared/src/schemas/mcpProbe.ts`（新文件）：

```ts
export const McpToolInfoSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(), // 原始 JSON Schema，由前端 viewer 渲染
}).strict()

export const McpResourceInfoSchema = z.object({
  uri: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
}).strict()

export const McpResourceTemplateInfoSchema = z.object({
  uriTemplate: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
}).strict()

export const McpPromptArgumentSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
}).strict()

export const McpPromptInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  arguments: z.array(McpPromptArgumentSchema).optional(),
}).strict()

export const McpProbeErrorCode = z.enum([
  'connect-failed',
  'handshake-failed',
  'auth-required',
  'timeout',
  'partial',
  'internal-error',
  'mcp-disabled',
])

export const McpProbeSchema = z.object({
  id: z.string(),
  mcpId: z.string(),
  mcpName: z.string(), // joined for convenience
  status: z.enum(['ok', 'error']),
  latencyMs: z.number().int().nonnegative(),
  handshakeMs: z.number().int().nonnegative().nullable(),
  serverInfo: z.object({ name: z.string(), version: z.string().optional() }).nullable(),
  protocolVersion: z.string().nullable(),
  capabilities: z.record(z.string(), z.unknown()).nullable(),
  tools: z.array(McpToolInfoSchema).nullable(),
  resources: z.array(McpResourceInfoSchema).nullable(),
  resourceTemplates: z.array(McpResourceTemplateInfoSchema).nullable(),
  prompts: z.array(McpPromptInfoSchema).nullable(),
  errorCode: McpProbeErrorCode.nullable(),
  errorMessage: z.string().nullable(),
  errorDetail: z.record(z.string(), z.unknown()).nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict()
```

> `mcpName` 与 `mcpId` 共存：列表页 JOIN 后回传，避免前端二次匹配。

## 3. 后端服务

### 3.1 `services/mcpProbe.ts`（新文件，纯函数 + IO 边界清晰）

```
probeMcp(db, mcp): Promise<ProbeResultRow>
  ├─ 0. guard: if !mcp.enabled → throw ValidationError('mcp-disabled')
  ├─ 1. dedupe: if in-flight Map has mcp.name → return same promise
  ├─ 2. 开 transport（local: StdioClientTransport / remote: StreamableHTTPClientTransport
  │      with SSE fallback —— 同 opencode/packages/opencode/src/mcp/index.ts:418/332）
  ├─ 3. client.connect() + initialize → 计 handshakeMs
  ├─ 4. Promise.allSettled([listTools, listResources, listResourceTemplates, listPrompts])
  │      —— 每个 list 用 mcp.config.timeoutMs ?? 30_000 + AbortSignal
  │      —— rejected 项收进 partialFailures[]，不影响其他成员
  ├─ 5. transport.close() / stdio child kill（确保无残留）
  ├─ 6. 计 latencyMs；status =
  │      - error: connect/initialize 整体失败时
  │      - ok: initialize 成功（即便 partial）
  ├─ 7. upsertProbe(db, mcp.id, result)
  └─ 8. 从 in-flight Map 摘除
```

错误归一化：

```
异常 → code 映射:
  UnauthorizedError                    → 'auth-required'
  HTTP 401/403                         → 'auth-required'
  AbortError (总超时)                  → 'timeout'
  initialize 超时 / 协议错             → 'handshake-failed'
  ENOENT/EACCES (spawn) / fetch 失败   → 'connect-failed'
  其他                                 → 'internal-error'
```

环境隔离：
- stdio：`spawn(command[0], command.slice(1), { env: {...minimalEnv, ...mcp.config.env}, cwd: process.cwd() })`。`minimalEnv` 仅包含 `PATH` / `HOME` / `LANG`（其它继承一律剔除，防 daemon 凭据泄漏）。
- http：仅按 mcp.config.headers 注入；不带 daemon 任何 token。

超时控制：
- 单次 `initialize` 内部 SDK timeout：30s（与 opencode `DEFAULT_TIMEOUT` 一致）。
- 整次 probe 总超时：60s 硬上限 → `setTimeout(...).unref() + abort()`。
- 触发硬超时立即 transport.close + kill child + throw `timeout`。

凭据 redaction：
- stderr 与 HTTP body 在写入 `errorDetailJson` 前过 `redactSensitiveString`（RFC-024，`packages/backend/src/util/redact.ts`）。
- `errorDetailJson` 不许出现 mcp.config.env / headers 任何 value（实现时只 push 明确允许的字段 stderr / httpStatus / partialFailures）。

### 3.2 `services/mcpProbeStore.ts`

```
listProbes(db): Promise<McpProbe[]>
  // LEFT JOIN mcps → 输出 mcpName 字段，无 probe 行的 mcp 不出现（前端自行展示 unknown）

getProbe(db, mcpName): Promise<McpProbe | null>
upsertProbe(db, mcpId, result): Promise<McpProbe>
  // INSERT ... ON CONFLICT(mcp_id) DO UPDATE
```

### 3.3 `routes/mcps.ts` 扩展

新增三条路由，挂同一个 `mountMcpRoutes`：

```
GET  /api/mcps/probes           → listProbes()
GET  /api/mcps/:name/probe      → getProbe(name) | 404
POST /api/mcps/:name/probe      → probe + upsert + return row（含完整 tools/...）
```

POST 路径错误映射：
- `mcp-disabled`             → 422
- `mcp-not-found`            → 404
- 所有 probe 内部错误（含 timeout）→ **仍返回 200 + status='error'**（让 UI 一致展示），不抛 HTTP error；因为"探测失败"是预期产物。
- 仅 daemon 内部 bug（DB 写入失败等）→ 500。

### 3.4 in-flight 复用

`mcpProbe.ts` 模块顶部：
```ts
const inflight = new Map<string, Promise<ProbeRow>>()
```
- key = mcp.name
- POST 进入 → check inflight；命中 → 返回同 Promise（响应里加 header `x-probe-shared: 1` 便于测试）。
- finally 块清理 key。

## 4. 前端

### 4.1 `routes/mcps.tsx` 列表页改动

新增列 + 行展开：

```
| name | type | description | enabled | 状态 | 延时 | 工具数 |   |
```

- 状态列：`<McpProbeStatusChip status={...} />`，四态色：unknown 灰 / probing 蓝 / ok 绿 / error 红。
- 延时列：ok → "1.8 s"；其它 → em-dash。
- 工具数列：ok → tools.length；其它 → em-dash。
- 行可展开（箭头 ▶ → ▼）：展开块横向 chip 列出最多 12 个 tool 名，更多 → "+N more → 查看详情"；右侧两个按钮：
  - `重新探测`（loading 时禁用 + 替换为 spinner）。
  - `查看完整接口`（跳 `/mcps/$name` 详情页 `#inventory` 锚点）。
- 数据来源：列表页同时 fetch `GET /api/mcps` + `GET /api/mcps/probes`，前端 by `mcp.id` 合并。`probes` 缺失 = unknown。

### 4.2 `routes/mcps.detail.tsx` 改动

表单下方新增 `<McpInventoryPanel mcp={query.data} />`：

```
┌─ Interface Inventory ────────────────────────────────────────────────┐
│ [chip ok] 1.83 s · server foo v1.2.0 · MCP 2024-11-05               │
│ 最近探测 2026-05-17 10:23  [重新探测]                                │
│                                                                      │
│ ▼ Tools (7)                                                          │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │ query                                                       │    │
│   │   Run a read-only SQL query against the configured DB.      │    │
│   │   ▶ inputSchema                                             │    │
│   │     { "type":"object","properties":{ "sql":{"type":"string"}│    │
│   │       ,...}, "required":["sql"] }                           │    │
│   └─────────────────────────────────────────────────────────────┘    │
│   ... 6 more                                                         │
│                                                                      │
│ ▼ Resources (2) + Templates (1)                                      │
│ ▼ Prompts (0)                                                        │
│ ▼ capabilities { logging:true, prompts:false, ... }                  │
└──────────────────────────────────────────────────────────────────────┘
```

错误态：chip 红 + 错误摘要框（errorCode + errorMessage + 折叠 errorDetail JSON viewer）。

### 4.3 新组件清单

- `components/McpProbeStatusChip.tsx` —— 四态 chip + 颜色 token，复用 `chip` / `chip--ok` / `chip--err` / `chip--info` 样式。
- `components/mcps/McpInventoryPanel.tsx` —— 顶部 + 三段折叠 + capabilities。
- `components/mcps/McpToolRow.tsx` —— 单 tool 行；inputSchema 用现有 JSON viewer（如无，加一个轻量 `<pre><code>` + 缩进高亮即可，不引新库）。
- `lib/mcp-probe-query.ts` —— TanStack Query hook：`useMcpProbes()` / `useMcpProbe(name)` / `useProbeMcpMutation(name)`。

`mutate` 完成后 invalidate `['mcps', 'probes']` + `['mcps', name, 'probe']`。

### 4.4 i18n key（zh-CN / en-US 同步）

新增 namespace `mcps.probe.*`：
- `mcps.colStatus`, `mcps.colLatency`, `mcps.colToolCount`
- `mcps.probe.btnRun`, `mcps.probe.btnRunning`
- `mcps.probe.status.{unknown|probing|ok|error}`
- `mcps.probe.error.{connect-failed|handshake-failed|auth-required|timeout|partial|internal-error|mcp-disabled}`
- `mcps.probe.section.{tools|resources|prompts|capabilities}`
- `mcps.probe.toolDescriptionEmpty`, `mcps.probe.noInputSchema`
- `mcps.probe.lastProbed` —— "Last probed {{at}}"

## 5. 与其他 RFC 的关系

| RFC | 关系 | 说明 |
| --- | --- | --- |
| RFC-028 | 直接扩展 | `mcp_probes` 表通过 FK + ON DELETE CASCADE 跟 `mcps` 关联；删 MCP 自动清 probe 行。**不动** `mcps` 表本身字段。 |
| RFC-029 | 互补，不冲突 | RFC-029 是 task 运行时 opencode 进程内 dump；本 RFC 是配置态 daemon 主动 probe。前者数据走 `node_runs.inventory_snapshot_json`，后者走 `mcp_probes`。可以并存。 |
| RFC-027 | 无直接关系 | session view 不展示 MCP probe；如果未来想在 session 里看本节点用到的 MCP tools schema，再开 RFC，本期不做。 |
| RFC-024 | 复用 `redactSensitiveString` | stderr / HTTP body redact 走同一工具函数。 |

## 6. 失败模式枚举

| 场景 | errorCode | status | 表里其他字段 |
| --- | --- | --- | --- |
| stdio `command[0]` 不存在 (`ENOENT`) | `connect-failed` | error | tools/...全 null；errorDetail.stderr 含 spawn 错 |
| 子进程秒退 + 非 0 退出码 | `connect-failed` | error | errorDetail.stderr 含尾部 4 KiB（redacted） |
| stdio 起来但 30s 内无 initialize 响应 | `handshake-failed` | error | handshakeMs=30000 |
| http 4xx (401/403) | `auth-required` | error | errorDetail.httpStatus |
| http 5xx / 网络 reset | `connect-failed` | error | errorDetail.httpStatus / errorDetail.cause |
| initialize ok，listTools 失败 | `partial` | **ok** | tools=null + errorDetail.partialFailures=[{method:'tools/list', message}] |
| 总耗时 > 60s | `timeout` | error | latencyMs≈60000 |
| 触发本 RFC bug | `internal-error` | error | errorMessage 含 throw 字符串 |
| mcp.enabled=false | `mcp-disabled` | （不入库，422） | — |

## 7. 测试策略（与 CLAUDE.md "Test-with-every-change" 对齐）

### 7.1 shared

- `tests/mcp-probe-schema.test.ts`：
  - tool / resource / prompt schema 字段必选 / 可选边界。
  - errorCode enum 边界（不在枚举内 → reject）。
  - probe 整体 schema 接受 nullable / strict。

### 7.2 backend 单测

- `tests/services/mcpProbe.test.ts`（**核心**）：
  - mock transport 注入：成功完整 → status=ok + 四类全有。
  - listResources rejected → status=ok + errorCode=partial + resourcesJson=null。
  - initialize 超时 → handshake-failed。
  - `UnauthorizedError` → auth-required。
  - mcp.enabled=false → throw `mcp-disabled`，不 spawn。
  - 总超时 60s → timeout + transport.close 被调用。
  - in-flight 复用：同时调两次 → 第二次拿到同一 Promise；事后调用 transport 只起一次。
  - **redact 锚**：errorDetail.stderr 输入 `"PG_URL=postgresql://user:secret@..."` → 入库内容不含 `secret`。
  - **隔离锚**：spawn env 不包含 `process.env.SOME_DAEMON_TOKEN`（mock `process.env` 注入后断言）。

- `tests/services/mcpProbeStore.test.ts`：upsert idempotent，二次 probe 覆盖。

- `tests/routes/mcps-probe.test.ts`：
  - GET /api/mcps/probes 空表 → []。
  - GET /api/mcps/:name/probe 不存在 → 404。
  - POST /api/mcps/:name/probe disabled → 422 mcp-disabled。
  - POST 路径 probe 失败 → **200 + status=error**（确认不抛 5xx）。

- `tests/migration-00NN-mcp-probes.test.ts`：跑完后 mcp_probes 表存在 + ON DELETE CASCADE 生效（删 mcp 行后 probe 行消失）。

### 7.3 后端集成测

- `tests/mcp-probe-stdio-integration.test.ts`：起一个 fixture mock-mcp-stdio.ts（用 SDK 的 server 端）实现最小 initialize + tools/list（4 个 tool）→ 调 probe → 断言 tools 解析正确。
- `tests/mcp-probe-http-integration.test.ts`：用 Bun.serve 起一个 Streamable HTTP mock → probe → 断言 schema 透传。

### 7.4 前端单测

- `tests/mcp-probe-status-chip.test.ts`：四态色 / aria-label。
- `tests/mcps-list-probe-columns.test.tsx`：列渲染、行展开、tools chips 截断到 12。
- `tests/mcp-inventory-panel.test.tsx`：tools / resources / prompts 三段渲染；error 态错误框可展开 detail。
- `tests/locks/mcp-inventory-panel-i18n.test.ts`：源码不含硬编码中英文字符串（与 RFC-028 T9 同模式）。

### 7.5 e2e

- `tests/e2e/mcp-probe.spec.ts`：
  1. 准备：种子一个 local mock-mcp 入 DB。
  2. 访问 `/mcps` → 状态 chip = unknown → 展开行 → 点 "重新探测" → chip 变 ok + 工具数 = 4。
  3. 跳详情页 → Tools 折叠展开 → 第一个 tool 的 inputSchema 可见。
  4. 把 mock-mcp command 改成无效 → 重新探测 → chip = error + errorDetail 可展开看到 stderr 摘要。

## 8. 部署 / 回滚

- 上线无需配置变更；前端 enable 后自动可见新列。
- 回滚：drop `mcp_probes` 表 + 反向 migration（不删 `mcps` 任何字段，RFC-028 完整保留）。
- 性能旁路：探测每次起一次 stdio / 一次 http；并发守卫 + 按需触发 → daemon 负载可忽略。如发现真实场景下被滥用（用户狂点重试），加 rate limit 到 routes 层。

## 9. 预留扩展点（v2+）

- 定期后台 probe（settings 开关）。
- 历史时间线（改 UNIQUE(mcpId) → INDEX(mcpId, finishedAt DESC) + GC 策略）。
- "调用 tool" 试玩（独立 RFC，参数构造 + 权限）。
- OAuth 浏览器跳转 UI（独立 RFC）。
- `mcp.probe.enabled = false` settings 全局开关挂点（service 入口处一个 if）。
