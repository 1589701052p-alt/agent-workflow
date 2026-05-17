# RFC-029 — 技术设计

> 配套文件：[proposal.md](./proposal.md) / [plan.md](./plan.md)

## 1. 总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│ runner.ts (本框架)                                                       │
│                                                                          │
│ 1) prepareRunDir({task, node, retry}):                                   │
│    OPENCODE_CONFIG_DIR=~/.agent-workflow/runs/{task}/{node}/.opencode/   │
│    OPENCODE_AW_INVENTORY_OUT=<runDir>/inventory.json                     │
│                                                                          │
│ 2) ensureInventoryPlugin(runDir):                                        │
│    把 binary 内嵌的 aw-inventory-dump.mjs 写到                          │
│    <runDir>/.opencode/plugins/aw-inventory-dump.mjs                      │
│                                                                          │
│ 3) buildInlineConfig({...}):                                             │
│    inline.plugin = [ ...existing,                                        │
│                     "file://<runDir>/.opencode/plugins/aw-inventory-dump.mjs"]
│    OPENCODE_CONFIG_CONTENT = JSON.stringify(inline)                      │
│                                                                          │
│ 4) spawn opencode run --format json ...   (现有路径)                     │
│         │                                                                │
│         ▼                                                                │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │ opencode 子进程 (boot 期)                                       │   │
│   │                                                                 │   │
│   │   Plugin.layer  → loadExternal([...plugin file://...])         │   │
│   │                 → applyPlugin(load, input, hooks)              │   │
│   │                 → plugin.server(input, options) 调用            │   │
│   │                                                                 │   │
│   │   aw-inventory-dump.server(input):                              │   │
│   │     queueMicrotask(async () => {                                │   │
│   │       const out = process.env.OPENCODE_AW_INVENTORY_OUT         │   │
│   │       if (!out) return                                          │   │
│   │       const agents  = await input.client.app.agents()           │   │
│   │       const skills  = await input.client.app.skills()           │   │
│   │       const mcps    = await input.client.mcp.status()           │   │
│   │       // plugin_origins 从 config hook 闭包里拿(见 §3.2)       │   │
│   │       await Bun.write(out, JSON.stringify({                     │   │
│   │         schemaVersion: 1, capturedAt: Date.now(),               │   │
│   │         agents, skills, mcps, plugins }))                       │   │
│   │     })                                                          │   │
│   │     return {                                                    │   │
│   │       config: async (cfg) => { pluginsCache = cfg.plugin_origins }
│   │     }                                                           │   │
│   │                                                                 │   │
│   │   opencode 继续走 session.prompt → 模型 turn → exit             │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│         │                                                                │
│         ▼                                                                │
│ 5) child.exited 后,services/inventory.ts.readSnapshot(runDir):           │
│       inventory.json 存在 + JSON 解析成功 → captured:true                │
│       任何失败 → captured:false + reason:<short-code>                    │
│       写入 node_runs.inventory_snapshot_json                             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        GET /api/tasks/:taskId/node-runs/:nodeRunId/inventory
        ─► routes/inventory.ts                                              
        ─► 200 InventorySnapshot                                            
                              │
                              ▼
        NodeDetailDrawer **Session** tab(RFC-027 落地后的 SessionTab):       
          ┌────────────────────────────────────────────┐                    
          │  attempts switcher (RFC-011 / RFC-027)     │                    
          ├────────────────────────────────────────────┤                    
          │  ◀── 本 RFC ──▶                            │                    
          │  <RuntimeInventorySection />               │                    
          │    ├─ <AgentsTable />                      │                    
          │    ├─ <SkillsTable />                      │                    
          │    ├─ <McpsTable />                        │                    
          │    └─ <PluginsTable />                     │                    
          ├────────────────────────────────────────────┤                    
          │  <ConversationFlow /> (RFC-027 主体)       │                    
          │    └─ <SubagentBlock> (recursive)          │                    
          └────────────────────────────────────────────┘                    
```

## 2. shared 层（packages/shared）

### 2.1 新文件 `src/inventory.ts`

```ts
import { z } from 'zod'

export const InventoryReasonCodeSchema = z.enum([
  'file-missing',
  'parse-failed',
  'opencode-pure-mode',
  'plugin-load-failed',
  'dump-plugin-internal-error',
  'non-agent-kind',
])
export type InventoryReasonCode = z.infer<typeof InventoryReasonCodeSchema>

export const InventoryAgentSchema = z.object({
  name: z.string(),
  mode: z.enum(['primary', 'subagent']).or(z.string()),
  modelProviderId: z.string().nullable().default(null),
  modelId: z.string().nullable().default(null),
  readonly: z.boolean().default(false),
  /** 'inline' | 'project' | 'global' | 'native' | 'unknown' */
  source: z.string(),
})

export const InventorySkillSchema = z.object({
  name: z.string(),
  source: z.string(),
  path: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
})

export const InventoryMcpSchema = z.object({
  name: z.string(),
  type: z.enum(['local', 'remote']).or(z.string()),
  status: z.enum([
    'connected',
    'disabled',
    'needs_auth',
    'needs_client_registration',
    'failed',
    'not_initialized',
  ]).or(z.string()),
  hint: z.string().nullable().default(null),
})

export const InventoryPluginSchema = z.object({
  specifier: z.string(),
  source: z.string(),
})

export const InventorySnapshotCapturedSchema = z.object({
  captured: z.literal(true),
  schemaVersion: z.literal(1),
  capturedAt: z.number(),
  agents: z.array(InventoryAgentSchema),
  skills: z.array(InventorySkillSchema),
  mcps: z.array(InventoryMcpSchema),
  plugins: z.array(InventoryPluginSchema),
})

export const InventorySnapshotMissingSchema = z.object({
  captured: z.literal(false),
  reason: InventoryReasonCodeSchema,
  message: z.string().nullable().default(null),
})

export const InventorySnapshotSchema = z.discriminatedUnion('captured', [
  InventorySnapshotCapturedSchema,
  InventorySnapshotMissingSchema,
])
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>
```

### 2.2 纯函数 `normalizeInventory(raw: unknown): InventorySnapshot`

输入是 dump plugin 写出的原始 JSON 对象(或 read 失败时构造的 error stub)。职责:

1. 缺字段 → 兜默认值(arrays → `[]`,nullable → `null`),不抛错。
2. `mcps` 字段在 plugin 侧是 `Record<name, MCP.Status>`(opencode SDK 返回形态),flatten 成 `InventoryMcp[]`:`name = entry key`,`type` 由 status 不直接给出 → 兜底 `'unknown'`,但 opencode 1.15 的 `MCP.Status` 含 server config 引用 → 见 §3.2.1 plugin 侧 transcode。
3. agents / skills 的 opencode 内部字段 → 本框架字段映射(参考 §3.2.1 一一对应表)。
4. 未知 status / source 字符串原样保留,UI 层用 fallback class + i18n 通用 key。

不在 shared 层做的事:不读 fs、不做 zod parse(返回的是已校验的对象,parse 在 backend route 出口做)。

### 2.3 纯函数 `inventoryReasonCode(err: unknown, ctx: { runDirExists: boolean, pureMode: boolean, nodeKind: NodeKind }): InventoryReasonCode`

集中决定原因码,使错误码不在散落 N 个 try/catch 里。

```
nodeKind === non-agent          → 'non-agent-kind'
pureMode === true               → 'opencode-pure-mode'
runDirExists === false          → 'plugin-load-failed' (跑都没跑起来)
err 是 SyntaxError               → 'parse-failed'
err 是 ENOENT                    → 'file-missing'
err 含 'dump-plugin'             → 'dump-plugin-internal-error'
其余                             → 'file-missing'(保守默认)
```

## 3. backend

### 3.1 binary 内嵌 dump plugin

`packages/backend/src/opencode-plugin/aw-inventory-dump.ts` 是 dump plugin 源码;`packages/backend/scripts/build-inventory-plugin.ts` 在 `prebuild` 阶段把它 bundle 成单文件 ESM `.mjs`,内容作为 base64 字符串常量写进 `src/opencode-plugin/embedded.ts`(模板:`export const AW_INVENTORY_DUMP_MJS = Buffer.from('...base64...', 'base64').toString('utf-8')`)。

运行时 `ensureInventoryPlugin(runDir)`:

```ts
const target = path.join(runDir, '.opencode', 'plugins', 'aw-inventory-dump.mjs')
if (existsSync(target)) return target  /* idempotent */
mkdirSync(path.dirname(target), { recursive: true })
writeFileSync(target, AW_INVENTORY_DUMP_MJS, 'utf-8')
return target
```

返回值给 `buildInlineConfig` 用作 `file://` 指针。

> 为什么不直接放 framework binary 同目录 ? 因为 binary 路径可能在 `/usr/local/bin/agent-workflow`,opencode 不一定有读权限;放到 runDir 既保证可读,又随 runDir 清理而清理。

### 3.2 dump plugin 实现要点（`aw-inventory-dump.ts`）

```ts
// 注意:本文件以 .mjs 形式被 opencode 子进程 import。
// 不要 import 任何项目内部代码,不要 import @opencode-ai/plugin 运行时(只用类型)。
// 全部依赖只有 process / Bun.write / globalThis.fetch (经 PluginInput.client 已经拿到)。

import type { PluginInput, Hooks, Config } from '@opencode-ai/plugin'

export default {
  id: 'aw-inventory-dump',
  async server(input: PluginInput): Promise<Hooks> {
    let pluginsCache: Array<{ specifier: string; source: string }> = []
    const out = process.env.OPENCODE_AW_INVENTORY_OUT
    let dumped = false

    async function dump() {
      if (dumped) return
      dumped = true
      if (!out) return  /* 静默,framework 未设置就别写 */
      try {
        const [agentsRes, skillsRes, mcpsRes] = await Promise.allSettled([
          input.client.app.agents(undefined, { throwOnError: true }),
          input.client.app.skills(undefined, { throwOnError: true }),
          input.client.mcp.status(undefined, { throwOnError: true }),
        ])
        const snapshot = {
          captured: true as const,
          schemaVersion: 1 as const,
          capturedAt: Date.now(),
          agents: agentsRes.status === 'fulfilled' ? transcodeAgents(agentsRes.value.data ?? []) : [],
          skills: skillsRes.status === 'fulfilled' ? transcodeSkills(skillsRes.value.data ?? []) : [],
          mcps:   mcpsRes.status === 'fulfilled'   ? transcodeMcps(mcpsRes.value.data ?? {})    : [],
          plugins: pluginsCache,
        }
        await Bun.write(out, JSON.stringify(snapshot))
      } catch (err) {
        /* 任何意外 → 写一份 reason='dump-plugin-internal-error' 的占位,让 framework 区分 */
        try {
          await Bun.write(out, JSON.stringify({
            captured: false, reason: 'dump-plugin-internal-error',
            message: err instanceof Error ? err.message : String(err),
          }))
        } catch { /* fs 都坏了的话,放弃 */ }
      }
    }

    /* 优先在 boot microtask 里 dump;若 boot 期 services 还没 ready,首条 chat.message 时再 dump 一次(idempotent) */
    queueMicrotask(dump)

    return {
      config: async (cfg: Config) => {
        pluginsCache = (cfg.plugin_origins ?? []).map((o) => ({
          specifier: typeof o.spec === 'string' ? o.spec : JSON.stringify(o.spec),
          source: o.source ?? 'unknown',
        }))
      },
      'chat.message': async () => { void dump() },
    }
  },
}
```

#### 3.2.1 opencode 字段 → 本框架字段映射

| 本框架 InventoryAgent | opencode `Agent.Info` 字段（`packages/opencode/src/agent/agent.ts`） |
|---|---|
| `name` | `name` |
| `mode` | `mode`('primary' / 'subagent') |
| `modelProviderId` | `model?.providerID` |
| `modelId` | `model?.modelID` |
| `readonly` | `permission` 推导(若 `permission.edit === 'deny'` 且 `permission.bash === 'deny'` → true) |
| `source` | `source.type`(opencode 1.15 已暴露)。若字段不存在 → `'unknown'` |

| 本框架 InventorySkill | opencode `Skill.Info` 字段 |
|---|---|
| `name` | `name` |
| `source` | `source.type`(若无 → `'unknown'`) |
| `path` | `source.path` 或 `path` |
| `description` | `description` |

| 本框架 InventoryMcp | opencode `MCP.Status`(map value)+ MCP config（map key 即 name） |
|---|---|
| `name` | map key |
| `type` | 通过 `status.config?.type` 或 fallback `'unknown'` |
| `status` | `status.status` |
| `hint` | `status.error` 或 `status.url` 或 `null` |

| 本框架 InventoryPlugin | `ConfigPlugin.Origin` 字段 |
|---|---|
| `specifier` | `ConfigPlugin.pluginSpecifier(origin.spec)` 等价(plugin 内不能 import opencode 源码,因此现场用 `typeof spec === 'string' ? spec : JSON.stringify(spec)` 兜底) |
| `source` | `origin.source` |

> 这一张映射表是脆弱面。任何 opencode 升级若改了 `Agent.Info / Skill.Info / MCP.Status / Origin` 字段名,本表都得跟。**测试策略**:plugin 侧 transcoder 是纯函数,fixture-driven 单测覆盖每一栏(`packages/backend/tests/inventory-transcode.test.ts`),fixture 改自 opencode 1.15 真实 SDK 类型;升级后 transcoder 单测先红,提示我们对齐。

### 3.3 DB migration `0014_rfc029_node_runs_inventory.sql`

```sql
ALTER TABLE node_runs ADD COLUMN inventory_snapshot_json TEXT;
```

- 无索引(查询路径只按 nodeRunId 主键查)。
- _journal.json 与 `meta/0014_snapshot.json` 走 `bun run db:generate`。**实际现有编号**:0010 RFC-026 / 0011 RFC-028 / 0012 RFC-027 / 0013 RFC-030(in-flight,untracked)/ 0014 本 RFC-029。RFC-030 若先合则我们这里要紧跟其后(按"小号先合"原则,需要 rebase 后重新 generate 让 0014 接在 0013 之后);若 RFC-030 后合则它在自己合并时调整(我们无需配合)。

### 3.4 `services/inventory.ts`

```ts
export async function readSnapshotFromRunDir(opts: {
  runDir: string
  nodeKind: NodeKind
  pureMode: boolean
}): Promise<InventorySnapshot> {
  if (opts.nodeKind !== 'agent') {
    return { captured: false, reason: 'non-agent-kind', message: null }
  }
  if (opts.pureMode) {
    return { captured: false, reason: 'opencode-pure-mode', message: null }
  }
  const file = path.join(opts.runDir, 'inventory.json')
  let raw: unknown
  try {
    raw = await Bun.file(file).json()
  } catch (err) {
    const code = inventoryReasonCode(err, {
      runDirExists: existsSync(opts.runDir),
      pureMode: false,
      nodeKind: 'agent',
    })
    return { captured: false, reason: code, message: errorMessage(err) }
  }
  /* dump plugin 写出来本身就是 captured:false 的占位(内部异常)时,直接透传 */
  if (typeof raw === 'object' && raw && (raw as any).captured === false) {
    return InventorySnapshotMissingSchema.parse(raw)
  }
  return InventorySnapshotCapturedSchema.parse(
    typeof raw === 'object' && raw ? normalizeInventoryRaw(raw) : {},
  )
}
```

### 3.5 runner.ts 改动

```diff
   const runDir = await prepareRunDir(...)
+  /* RFC-029: 把 dump plugin 写到 runDir,并把 file:// 指针塞进 inline.plugin */
+  const inventoryPluginPath = ensureInventoryPlugin(runDir)
+  inlineConfig.plugin = [...(inlineConfig.plugin ?? []), `file://${inventoryPluginPath}`]
+  const inventoryOutPath = path.join(runDir, 'inventory.json')
+  childEnv.OPENCODE_AW_INVENTORY_OUT = inventoryOutPath

   const child = Bun.spawn(['opencode', 'run', ...], { env: childEnv, cwd: worktreeDir, stdio: [...] })
   ...
   const exitCode = await child.exited
   ...
+  /* RFC-029: 读 inventory(失败兜底 captured:false) */
+  const inventory = await readSnapshotFromRunDir({
+    runDir,
+    nodeKind: opts.nodeKind,
+    pureMode: !!process.env.OPENCODE_PURE,
+  })
+  await db.update(nodeRuns).set({
+    inventorySnapshotJson: JSON.stringify(inventory),
+  }).where(eq(nodeRuns.id, opts.nodeRunId))
```

注意点:

- `ensureInventoryPlugin` 与 `OPENCODE_AW_INVENTORY_OUT` 设置必须在 spawn **之前**完成,否则 plugin 找不到 out 路径会静默 skip。
- runner 的 cleanup 顺序:**读完 inventory** → 才走 `rmSync(runRoot)`(与 RFC-027 同款"capture → cleanup" 守序)。
- non-agent kind 直接走 readSnapshotFromRunDir 的 `non-agent-kind` 分支,不读文件、不写 plugin、不污染 inline config(`if (nodeKind !== 'agent') return` 守门在 ensureInventoryPlugin 入口)。
- pure mode:framework 不强制透传 `OPENCODE_PURE` 给子进程,这里检测的是子进程 env(若上游真给了 `--pure`)。常态下不会触发。

### 3.6 REST 端点 `routes/inventory.ts`

```
GET /api/tasks/:taskId/node-runs/:nodeRunId/inventory
  → 200 InventorySnapshot   (含 captured 二态)
  → 404 node-run-not-found / task-not-found
  → 410 node-kind-not-supported  (input / output / wrapper / review / clarify)
```

实现要点:
- `node_runs.inventory_snapshot_json` 为 NULL 时,如果 nodeKind 是 agent → 200 + `{captured:false, reason:'file-missing'}`(后向兼容老行);否则 → 410。
- `JSON.parse` + `InventorySnapshotSchema.parse` 二段校验,parse 失败 → 200 + `{captured:false, reason:'parse-failed'}`(已经落库的 raw 还是保留,不删除)。

### 3.7 WS invalidation

无新增频道。前端 query key `['tasks', taskId, 'node-runs', nodeRunId, 'inventory']` 由 `useTaskSync` 既有的 `node.run.updated` 事件 invalidate(与 RFC-027 同套机制)。

## 4. 前端

### 4.1 NodeDetailDrawer Session 页签顶部

> **依赖前置**:本节假设 RFC-027 的 `SessionTab.tsx` 已经合并(`components/node-session/SessionTab.tsx`)。如果 RFC-027 还没落地,本 RFC 的前端部分(T9 ~ T11)**不开工**;后端部分(T1 ~ T8)可独立合并,inventory 已经落库,只是暂时没有 UI 展示。

`SessionTab.tsx` 内部布局调整(diff 在 RFC-027 已有顶层结构之上追加一行 Section):

```diff
   return (
     <div className="session-tab">
       <AttemptsSwitcher ... />
+      <RuntimeInventorySection nodeRunId={selectedAttempt.nodeRunId} nodeKind={nodeKind} />
       {isPromptCapableKind === false
         ? <div className="muted">{t('nodeDrawer.sessionNotApplicable')}</div>
         : <ConversationFlow tree={data.tree} />}
     </div>
   )
```

`RuntimeInventorySection` 行为:

- `nodeKind !== 'agent'` → 不渲染(返回 null)。这与 RFC-027 的 `sessionNotApplicable` 占位互不重叠:RFC-027 占位显示在 Section 下方对话流位置,Section 自身直接静默。
- `useQuery<InventorySnapshot>` 取 `/inventory` 端点;query key `['tasks', taskId, 'node-runs', nodeRunId, 'inventory']`,**包含 nodeRunId**,因此 attempts switcher 切换 attempt 时自动重拉。
- 容器:`<details className="inventory-section">`,默认 `closed`;`open` 状态用 `useState`(不放 query),attempts 切换时**保留**用户的折叠 / 展开偏好(AC-9)。
- summary 文案 `t('nodeDrawer.inventory.title')`(中文"运行时清单" / 英文"Runtime Inventory");summary 右侧附 4 个迷你 chip 显示总数:`A·5 S·3 M·2 P·1`,折叠态也能扫一眼概况。
- 展开后渲染 4 张 `<table>`(见 §4.2)。
- captured:false 时只渲染一个 `.inventory-section__missing` div + i18n `reason.{file-missing|parse-failed|...}` 文案,迷你 chip 隐藏。
- pending(attempt 处于 running 且 inventory 尚未写入)→ 显示一行加载占位 `t('nodeDrawer.inventory.pending')`,不渲染表;`useQuery` 的 `placeholderData` 兜底。

### 4.2 子组件

新文件 `components/inventory/`:

- `AgentsTable.tsx` — 列 `name / mode / model / readonly / source`,空数组时显示 i18n `inventory.empty`。
- `SkillsTable.tsx` — 列 `name / source / path / description`(description ellipsis,hover 全文)。
- `McpsTable.tsx` — 列 `name / status (badge with color) / type / hint`。
- `PluginsTable.tsx` — 列 `specifier / source`。
- `StatusBadge.tsx` — MCP 状态 chip,5 种颜色:`connected=success`,`disabled / not_initialized=muted`,`needs_auth=warn`,`needs_client_registration=warn`,`failed=danger`,未知 `unknown=muted`。

### 4.3 i18n（中英各一份）

```
nodeDrawer.inventory.title           = "Runtime Inventory" / "运行时清单"
nodeDrawer.inventory.pending         = "Capturing inventory…" / "正在捕获清单…"
nodeDrawer.inventory.chip.agents     = "A" / "智"
nodeDrawer.inventory.chip.skills     = "S" / "技"
nodeDrawer.inventory.chip.mcps       = "M" / "M"
nodeDrawer.inventory.chip.plugins    = "P" / "插"
nodeDrawer.inventory.subtitle.agents = "Agents" / "智能体"
nodeDrawer.inventory.subtitle.skills = "Skills" / "技能"
nodeDrawer.inventory.subtitle.mcps   = "MCP servers" / "MCP 服务"
nodeDrawer.inventory.subtitle.plugins= "Plugins" / "插件"
nodeDrawer.inventory.col.name        = "Name" / "名称"
nodeDrawer.inventory.col.mode        = "Mode" / "模式"
nodeDrawer.inventory.col.model       = "Model" / "模型"
nodeDrawer.inventory.col.readonly    = "Readonly" / "只读"
nodeDrawer.inventory.col.source      = "Source" / "来源"
nodeDrawer.inventory.col.path        = "Path" / "路径"
nodeDrawer.inventory.col.desc        = "Description" / "描述"
nodeDrawer.inventory.col.status      = "Status" / "状态"
nodeDrawer.inventory.col.type        = "Type" / "类型"
nodeDrawer.inventory.col.hint        = "Hint" / "提示"
nodeDrawer.inventory.col.specifier   = "Specifier" / "标识"
nodeDrawer.inventory.empty           = "(none)" / "（无）"
nodeDrawer.inventory.source.inline   = "inline" / "内联"
nodeDrawer.inventory.source.project  = "project" / "项目"
nodeDrawer.inventory.source.global   = "global" / "全局"
nodeDrawer.inventory.source.native   = "native" / "内置"
nodeDrawer.inventory.source.unknown  = "unknown" / "未知"
nodeDrawer.inventory.status.connected               = "connected" / "已连接"
nodeDrawer.inventory.status.disabled                = "disabled" / "已禁用"
nodeDrawer.inventory.status.needs_auth              = "needs auth" / "需要认证"
nodeDrawer.inventory.status.needs_client_registration = "needs client registration" / "需要注册客户端"
nodeDrawer.inventory.status.failed                  = "failed" / "失败"
nodeDrawer.inventory.status.not_initialized         = "not initialized" / "未初始化"
nodeDrawer.inventory.reason.file-missing            = "Inventory file was not produced (plugin may have failed to load)." / "未生成清单文件（插件可能加载失败）。"
nodeDrawer.inventory.reason.parse-failed            = "Inventory file was malformed." / "清单文件格式异常。"
nodeDrawer.inventory.reason.opencode-pure-mode      = "opencode --pure was set; external plugins disabled." / "opencode 处于 --pure 模式，未启用外部插件。"
nodeDrawer.inventory.reason.plugin-load-failed      = "Failed to write or load the inventory plugin." / "插件写入或加载失败。"
nodeDrawer.inventory.reason.dump-plugin-internal-error = "Inventory plugin reported an internal error." / "清单插件内部报错。"
```

### 4.4 样式

`styles.css` 新增约 60 行:

```css
/* Inventory 区段定位:Session 页签 attempts switcher 下方,ConversationFlow 上方;
   折叠态 1 行,展开态约 150 px。下边距用一根分隔线把它和对话流隔开。 */
.inventory-section { margin: 8px 0 12px; border-bottom: 1px solid var(--surface-border); padding-bottom: 8px; }
.inventory-section__summary { cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.inventory-section__chips { margin-left: auto; display: flex; gap: 4px; font-size: 11px; opacity: 0.7; }
.inventory-section__chip { padding: 0 4px; border-radius: 3px; background: var(--surface-muted); }
.inventory-section__missing { color: var(--muted); font-style: italic; margin-top: 8px; }
.inventory-section__pending { color: var(--muted); margin-top: 8px; }
.inventory-table { width: 100%; font-size: 12px; border-collapse: collapse; margin-top: 8px; }
.inventory-table th, .inventory-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--surface-border); }
.inventory-table tbody tr:hover { background: var(--surface-hover); }
.status-badge { padding: 2px 6px; border-radius: 4px; font-size: 11px; }
.status-badge--success { background: var(--success-bg); color: var(--success-fg); }
.status-badge--warn    { background: var(--warn-bg);    color: var(--warn-fg); }
.status-badge--danger  { background: var(--danger-bg);  color: var(--danger-fg); }
.status-badge--muted   { background: var(--surface-muted); color: var(--muted); }
```

## 5. 接口契约

```
GET /api/tasks/:taskId/node-runs/:nodeRunId/inventory

200 application/json:
  InventorySnapshotSchema(zod) — see shared §2.1
    captured:true  → { captured, schemaVersion, capturedAt, agents[], skills[], mcps[], plugins[] }
    captured:false → { captured, reason, message }

404 / 410 / 401：遵循现有 ApiError 包格（{ code, message }）
```

## 6. 测试策略

| 模块 | 文件 | 覆盖目标 | 数量 |
|------|------|----------|------|
| shared | `tests/inventory-schema.test.ts` | InventorySnapshotSchema 二态 discriminated union;每个子 schema 合法 / 缺字段兜默认 / 非法类型拒收 | 8 |
| shared | `tests/inventory-normalize.test.ts` | normalizeInventoryRaw:agents 空 / 仅 mode / 缺 model / 未知 source 兜底 / mcps Record → Array flatten 排序 | 8 |
| shared | `tests/inventory-reason-code.test.ts` | inventoryReasonCode 全分支:non-agent / pure / runDir 缺失 / ENOENT / SyntaxError / dump-plugin 字样 / 其他 | 7 |
| backend | `tests/migration-0014-inventory.test.ts` | ALTER 后老行 NULL / 新行可写 / 回滚不脏 | 3 |
| backend | `tests/inventory-service.test.ts` | readSnapshotFromRunDir:happy / 文件不存在 → file-missing / JSON 损坏 → parse-failed / non-agent skip / pure mode skip / dump-plugin 自报错占位透传 | 6 |
| backend | `tests/inventory-transcode.test.ts` | dump plugin 内嵌 transcoder(以纯函数形态从 `.mjs` 导出供测试 import):agent / skill / mcp / plugin 四类字段映射各 2 case(典型 + 缺字段兜底) | 8 |
| backend | `tests/inventory-plugin-embed.test.ts` | 编译产物 `embedded.ts` 中 AW_INVENTORY_DUMP_MJS base64 解码出来不空 + 包含 `client.app.agents()` 与 `client.mcp.status()` 字面量 + 源代码层 grep 锁 | 3 |
| backend | `tests/runner-inventory-integration.test.ts` | mock-opencode stub 在收到特定 env 时写一份预制 inventory.json;runner 集成读起入库 + non-agent kind 不污染 inline JSON 的 plugin 字段(grep) | 4 |
| backend | `tests/routes-inventory.test.ts` | GET /inventory 200 captured / 200 uncaptured(列 NULL)/ 200 uncaptured(JSON 解析失败 → parse-failed) / 404 / 410 | 5 |
| frontend | `tests/session-inventory-section.test.tsx` | nodeKind 非 agent 不渲染 / agent kind 渲染 details + summary / captured 二态分支 / 折叠展开默认态 / 切 attempt 时保留 open 状态 / mini chips 渲染 | 6 |
| frontend | `tests/session-tab-inventory-layout.test.tsx` | RFC-027 SessionTab 内 `<RuntimeInventorySection />` 出现在 `<AttemptsSwitcher />` 之后、`<ConversationFlow />` 之前(DOM 顺序断言) | 2 |
| frontend | `tests/inventory-tables.test.tsx` | 4 张表 column header 中英 + 排序 + 空态 + StatusBadge 五色类名 | 6 |
| frontend | `tests/i18n-inventory.test.ts` | i18n 双语完整性 + reason / status / source 所有 key 双侧存在 | 4 |
| frontend | `tests/inventory-grep.test.ts` | 源代码层锁:RuntimeInventorySection 必引用 useQuery `'/inventory'`、4 张子表都被 Section import、StatusBadge 仅在 McpsTable 使用、SessionTab.tsx 必须 import `RuntimeInventorySection` 且 **不在** StatsTab.tsx 出现 | 5 |
| e2e | `e2e/main.spec.ts` 增 1 case | 跑一个 agent 节点 → 打开 NodeDetailDrawer → 默认在 Session tab → 顶部 Runtime Inventory 折叠区可见 → 展开 → 看到 agent 行 / mcp 行 / plugin 行 / skill 行(用 stub-opencode 写预制 inventory.json) | 1 spec |

**测试合计预估 ≥ 73**,含源代码层 grep 兜底。

## 7. 与现有模块的耦合点

- **RFC-022 dependsOn inline JSON**:本 RFC 在 `inlineConfig.plugin` 字段**追加**一个 entry,不动 agent / mcp / skill 字段。RFC-022 的闭包合并函数 / runner.buildInlineConfig 接口不变,只多一行 plugin push;源码层 grep 锁 `aw-inventory-dump.mjs` 出现在 runner.ts 而不是别的地方。
- **RFC-027 Session View — UI 部分硬依赖**:本 RFC 的前端区段挂载在 RFC-027 的 `SessionTab.tsx` 内部,位于 attempts switcher 之下、ConversationFlow 之上。后端部分(dump plugin / migration / REST endpoint / runner 注入)完全独立。**实施顺序硬约束**:
  - 若 RFC-027 已合并 → 本 RFC 可单 PR 落地。
  - 若 RFC-027 未合并 → 本 RFC 拆为 PR-A(后端 T1~T8,inventory 已落库但无 UI)+ PR-B(前端 T9~T11,RFC-027 合并后再开)。
  - 两 RFC 在前端共享 attempts switcher 的事实由 RFC-027 已提取的 `useAttempts` hook 承担(若 RFC-027 还没抽这个 hook,本 RFC 不主动抽,直接读 RFC-027 的 props)。
  - DB migration 编号:**实际现有** 0010 RFC-026 / 0011 RFC-028 / 0012 RFC-027 / 0013 RFC-030(in-flight)/ **0014 RFC-029**。若 RFC-030 先合则我们 rebase 后重新 generate;若 RFC-030 后合则它自己调整。任何时候出现 journal 链断裂,按 RFC-024 修 0007 snapshot 链同款手法手动校正 `_journal.json`。
- **RFC-028 Agent MCP**:本 RFC 是 RFC-028 落地后最重要的"运行时验证面"——RFC-028 owner 实现时建议把 RFC-029 的 plan.md T1~T4 提到前置一并落地,以便 dev 时直接观察 inline mcp 合并结果。
- **RFC-026 clarify inline session**:不冲突。dump plugin 只在 boot 时 dump 一次,resume session 启动同样会触发 boot,从而每次 attempt 都有独立 inventory;node_runs.inventory_snapshot_json 与 opencode_session_id 并列,各自独立。

## 8. 失败模式总览

| 场景 | 行为 |
|------|------|
| opencode 未启用外部 plugin(--pure / Flag.OPENCODE_PURE) | 子进程根本不加载 dump plugin → inventory.json 不写 → readSnapshotFromRunDir 走 `file-missing`;runner 检测 `process.env.OPENCODE_PURE` 优先返回 `opencode-pure-mode` 更精确 |
| dump plugin 文件无法写入 runDir(权限 / 磁盘满)| ensureInventoryPlugin 抛 → runner 兜底 try/catch → 不阻塞 spawn,inline plugin 字段不追加,事后读 → `plugin-load-failed` |
| opencode SDK 方法 throw(版本 break)| dump plugin 内 Promise.allSettled 单条失败 → 对应数组用 `[]` 兜底;其它三类正常落库 |
| dump plugin 整段崩溃(import error / syntax)| opencode 自身 log.error + publishPluginError + 跳过该 plugin;主流程不动;inventory.json 不写 → `file-missing` |
| inventory.json 写到一半 opencode 被 kill | runner 读到截断 JSON → `parse-failed`;dump plugin 不做原子 rename,简化实现(失败兜底就是 raison d'être) |
| 同 task 内 N 个 node 并发跑(多 worktree / 多 runDir)| 每个 runDir 隔离,inventory.json 不冲突;dump plugin 文件随 runDir 独立复制 |
| 用户在 settings 里关掉 inventory snapshot 功能(未来的 feature flag)| v1 不实现 toggle;若未来要加,在 `inlineConfig.plugin` 追加这一步外面包一层 `if (settings.inventorySnapshotEnabled)` 即可 |

## 9. 配置 / 环境变量

新增 1 个 env(框架对子进程注入,用户不需要手设):

- `OPENCODE_AW_INVENTORY_OUT=<abs path>` — dump plugin 写出 JSON 的目标。framework 端默认 `<runDir>/inventory.json`。空字符串 / 未设置 → plugin 静默 skip(便于本地手跑 opencode 时也别让它误写到 cwd)。

不新增任何用户面 settings 字段;不修改 opencode 自身环境变量协议。

## 10. 实现里程碑（拆分提示）

参见 [plan.md](./plan.md)。默认单 PR(预估 +1500 行,含测试 +400 行);若 review 卡顿可拆 PR-A(纯 backend + dump plugin embed + DB + REST + 单测)+ PR-B(前端 UI + i18n + e2e + design 同步)。
