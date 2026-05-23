# RFC-060 — Fanout as Wrapper（技术设计）

## 0. 阅读建议

跟 `proposal.md` 配套读。本文按"先 kind 系统、再 agent flavor、再 wrapper schema、再 runtime"顺序展开；每一节先讲"现状"，再讲"目标态"，再讲"迁移路径"。施工细节归 `plan.md`。

## 1. 范围与边界

### 1.1 改动覆盖

- shared schemas：`packages/shared/src/schemas/{workflow,agent}.ts`、`packages/shared/src/outputKinds/*.ts`、新建 `packages/shared/src/kindParser.ts`、`packages/shared/src/shardingRegistry.ts`。
- backend：`packages/backend/src/services/{workflow,workflow.validator,scheduler,review,clarify,crossClarify,runner,envelope}.ts`、新增 `packages/backend/src/services/fanout.ts`。
- frontend：`packages/frontend/src/{components,routes,canvas}`，主要是 `NodeInspector` / wrapper 画布渲染 / agent 编辑器 / cartesian warning 渲染。
- DB：无 migration（NodeKind / output kind 字符串变更不入 schema 约束；agent.md frontmatter 存在 `frontmatter_extra` 列、无 column 改动）。
- e2e：新增 `playwright/fanout-as-wrapper.spec.ts`。

### 1.2 明确不动

- workflow `$schema_version`：本 RFC 不 bump（既有 4，本 RFC 落地后仍为 4；理由：v3→v4 是 RFC-056 因新增 NodeKind 而 bump，但 v4 并未承诺"将不再新增 NodeKind"，故复用 v4，且 agent-multi 直接断代无需读时刻 upgrade）。**例外**：如果 PR-E 阶段实测发现既有 v4 fixture 有 agent-multi 残留导致 round-trip fail，再起 v5 + reader upgrader 把残留 `agent-multi` 标 invalid。
- DB 表结构：node_runs / clarify_rounds（RFC-058 后名字）保持原样，复用既有 `parentNodeRunId` + `shardKey` + `iteration` + `crossClarifyIteration` 四轴。
- 现有 wrapper-git / wrapper-loop 容器 UX（RFC-016 沿用）。
- review / clarify / cross-clarify 节点 kind 本身的 schema、UI 不动；只调整 lifecycle 与 wrapper-fanout 的对接（per-shard 自然落地）。

### 1.3 与未上生产假设的关系

整个设计依赖两个事实：

1. **agent-multi 未上线**：DB / fixture / 用户工作流里没有 agent-multi node 行；故可硬断代删 NodeKind，不留 migration。
2. **wrapper-git 未上线**：`git_diff` port kind 从 `string` 升级为 `list<path>` 是 breaking change；同上 windows 内无回归。

实施 PR-E（断代）前由 maintainer 抽样 `select count(*) from workflows where definition_json like '%"agent-multi"%' or definition_json like '%"wrapper-git"%'` 在 production / staging DB 上验证为 0；若非 0 则升级为 migration 路径（见 §14）。

## 2. Kind 系统升级

### 2.1 现状

`AgentOutputKind` 现在是 string union：`'string' | 'markdown' | 'markdown_file'`（`packages/shared/src/schemas/review.ts:27`）。`outputKinds` 是 agent 输出端口的 kind 注解；端口 wire content 解析见 `OutputKindHandler`（`packages/shared/src/outputKinds/markdownFile.ts`）。

### 2.2 目标态

引入参数化 kind 字符串字面值：

```
kind ::= base | parametric
base ::= 'string' | 'markdown' | 'signal' | ...   (extensible)
parametric ::= 'path' '<' ext '>' | 'list' '<' kind '>'
ext ::= '*' | <identifier>     (e.g., 'md', 'markdown', 'txt')
```

例：

- `'string'` — 基本 kind。
- `'path<md>'` — 路径，扩展名约束 `.md` / `.markdown`。
- `'path<*>'` — 任意扩展名路径。
- `'list<path<md>>'` — 列表，每个元素是 `path<md>`。
- `'list<string>'` — 列表，每个元素是任意字符串。
- `'list<list<string>>'` — 嵌套列表（v1 允许，但 fanout shardSource 不接此形态，见 §6.3）。
- `'signal'` — 控制流端口，无数据载荷。

`markdown_file` 不再是独立 kind；YAML 读时**别名映射**为 `path<md>`、内部存储与 prompt 渲染统一走 `path<md>`。

### 2.3 解析器 (`packages/shared/src/kindParser.ts`)

```ts
export type ParsedKind =
  | { kind: 'base'; name: string }
  | { kind: 'path'; ext: '*' | string }
  | { kind: 'list'; item: ParsedKind }

export function parseKind(text: string): ParsedKind {
  const t = text.trim()
  if (t === 'markdown_file') return { kind: 'path', ext: 'md' }   // alias
  // 解析 'list<...>' / 'path<...>' / base name
  ...
}
export function stringifyKind(k: ParsedKind): string { ... }
```

- 错误：括号不闭合 / 未注册 base 名 / 未注册 ext → 抛 `KindParseError`，validator 在 `agent-output-kind-malformed` 报错。
- `markdown_file` 字面值始终能解析；`stringifyKind({kind:'path', ext:'md'}) === 'path<md>'`（不回滚到 `markdown_file`，让仓库内逐步统一到 `path<md>`）。

### 2.4 注册表 (`packages/shared/src/outputKinds/registry.ts`)

```ts
export interface OutputKindHandler<K extends ParsedKind = ParsedKind> {
  matches(k: ParsedKind): k is K
  validate(rawContent: string, ctx: ValidateCtx, io: ValidateIO): ValidateResult
  /** prompt 渲染时把 wire content 转成给 LLM 看的字符串。list<T> 默认按 \n join。 */
  promptRender(rawContent: string, ctx: ValidateCtx): string
}
```

v1 注册项：

- `BaseKindHandler('string' | 'markdown' | 'signal')` — passthrough。`signal` 的 validate 强制 rawContent 必须为空字符串（signal 不带数据）。
- `PathHandler` — 处理 `path<T>` 任意 ext；ext 检查 + worktree containment + file 存在 + non-empty（沿用 RFC-049 `markdownFile.ts:57-107` 逻辑）。
- `ListHandler` — 处理 `list<T>` 任意 T；rawContent = 每行一个 item（trim 后非空）；validate 时逐项调 item handler 的 validate。

### 2.5 list 项形态 + keyOf

list<T> 的每个 item 是**字符串**（`packages/shared/src/shardingRegistry.ts:keyOf` 注册函数从字符串解析出 shardKey）。

```ts
type KeyOfFn = (item: string, idx: number, ctx: { kind: ParsedKind }) => string

export const SHARD_KEY_OF: Record<string /* kind string */, KeyOfFn> = {
  'path<*>': (item) => item.trim(),  // path itself is the key
  'path<md>': (item) => item.trim(),
  // default fallback in resolveKeyOf:
  // any list<T> whose item kind is not registered → 0-based index
}

export function resolveKeyOf(itemKind: ParsedKind): KeyOfFn {
  const handler = SHARD_KEY_OF[stringifyKind(itemKind)]
  return handler ?? ((_, idx) => String(idx))
}
```

list<path<T>> 自动复用 `path<*>` 的 keyOf（基类匹配优先）。

### 2.6 prompt 渲染

LLM 看到的 port 内容由 `promptRender(rawContent, ctx)` 决定：

- `path<T>` → 读盘内容并嵌入（与 RFC-049 现有行为一致）。
- `list<T>` → 默认 `rawContent.split('\n').map(item => item.trim()).filter(Boolean).join('\n')`（即清洗后的多行 path 字符串）。
- `list<T>` 在**聚合 agent prompt 模板**里有特殊语法（§7.3）；在普通 agent prompt 里 `{{port}}` 仍走默认 promptRender。
- `signal` → 强制空字符串（用户在 prompt 里 `{{signal_port}}` 引用 validator 报错；详 §3.3）。

## 3. Signal output kind

### 3.1 语义

- `signal` 端口不传数据，只表达"上游已完成 → 下游可启动"控制流依赖。
- `wrapper-fanout` 无聚合 agent 时 wrapper 自动 mint 的 `__done__` 端口走此 kind（§5.4）。
- 任意 agent 都可声明 `outputs: [{ name, kind: 'signal' }]`，用于"我跑完了通知下游"型节点。

### 3.2 数据存储

- node_run_outputs 行仍保留：`portName: '__done__'`, `content: ''`。  
- runner 处理 signal 端口：envelope 解析到 signal kind 端口时，强制 content 设为空字符串（agent 在 envelope 里写了内容也忽略，warning log 不报错——agent 不会因写多了 fail）。

### 3.3 Prompt 模板约束

`packages/backend/src/services/runner.ts` 中 prompt 渲染前的 validator pass：

```ts
function validatePromptTemplate(template: string, inputs: PortBinding[]): void {
  for (const ref of extractTemplateRefs(template)) {
    const binding = inputs.find(b => b.localName === ref)
    if (binding?.upstreamKind?.kind === 'base' && binding.upstreamKind.name === 'signal') {
      throw new PortValidationError(
        'signal-port-in-prompt',
        `prompt references signal port '${ref}' which carries no data; signal edges are control-flow only`
      )
    }
  }
}
```

errCode `signal-port-in-prompt`，wire 协议沿用现有 PortValidationError 路径。

## 4. Agent role = aggregator

### 4.1 frontmatter schema

`packages/shared/src/schemas/agent.ts` 新增：

```ts
export const AGENT_ROLE = ['normal', 'aggregator'] as const
export const AgentRoleSchema = z.enum(AGENT_ROLE)
```

`Agent.frontmatter` 加 `role?: 'normal' | 'aggregator'`（默认 `normal`，未设值时 = normal）。

存储：进 `agents.frontmatter_extra` JSON column（沿 RFC-005 outputKinds 同样路径）。读写都走 `services/agent.ts` 的 frontmatter merge / split。

### 4.2 wrapperPortName

`agent.outputs[i]` 新增可选字段 `wrapperPortName?: string`。仅 `role: 'aggregator'` 时生效，控制该 output 在被 promote 为 wrapper-fanout 出口时的命名。例：

```yaml
role: aggregator
outputs:
  - name: combined_report
    kind: path<md>
    wrapperPortName: report     # wrapper-fanout.outputs[i].name = 'report'
```

未填 wrapperPortName → 同名 mirror，wrapper output 端口名 = agent output 端口名。

`role: normal` 的 agent 即使填了 wrapperPortName 也会被 validator 忽略 + warn。

### 4.3 验证规则

- `role: 'aggregator'` 的 agent **只能**作为 wrapper-fanout 的 inner 节点出现；在顶层 nodes[] 出现 → validator 报 `aggregator-agent-outside-fanout`。
- wrapper-fanout 内最多 1 个 role=aggregator 的 agent；超过 1 → validator 报 `multiple-aggregators-in-fanout`（v1 限，schema 不锁）。
- aggregator agent 必须有 ≥1 inbound edge（否则它没有输入可聚合）。

## 5. wrapper-fanout schema

### 5.1 NodeKind

```ts
NODE_KIND: [... 'agent-single', 'input', 'output', 'wrapper-git', 'wrapper-loop',
            'wrapper-fanout',  // ADD
            'review', 'clarify', 'clarify-cross-agent']
// 'agent-multi' REMOVED
```

### 5.2 node 字段

```ts
type WrapperFanoutNode = WorkflowNodeBase & {
  kind: 'wrapper-fanout'
  inputs: WrapperPort[]   // 至少 1 个 isShardSource: true
  // outputs 不存于 schema —— runtime 推导，前端渲染时按推导规则展示
  nodeIds: string[]       // inner subgraph 节点 id 引用，沿 wrapper-git/loop 现状
}

type WrapperPort = {
  name: string              // wrapper-internal port id
  kind: string              // kind 字符串字面值
  isShardSource?: boolean   // 至少 1 个 true（恰好 1，validator 报 0/2+ 错）
}
```

约束：

- 恰好 1 个 `isShardSource: true` 的 inputs port；该 port 的 kind 必须是 `list<T>`（解析后是 list 类型）→ validator `wrapper-fanout-shard-source-must-be-list`。
- shardSource 的 list item kind T 必须有注册的 keyOf 或落到默认 0-based 索引（无 hard validate；默认 fallback 总是有的）。

### 5.3 边界 edge schema

```ts
export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: PortRefSchema,
  target: PortRefSchema,
  boundary: z.enum(['wrapper-input', 'wrapper-output']).optional(),  // ADD
})
```

语义：

- `boundary === 'wrapper-input'`：边的 source.nodeId 是 wrapper 节点 id，source.portName 是 wrapper.inputs 中的某 port name；target.nodeId 是 inner 节点（必须 ∈ wrapper.nodeIds）。runtime 把当前 shard / broadcast 值注入到 target 节点的 input。
- `boundary === 'wrapper-output'`：边的 source.nodeId 是 inner 节点；target.nodeId 是 wrapper 节点 id，target.portName 是 wrapper output port name（由聚合 agent 或 `__done__` 推导）。
- 未填 `boundary`：普通 inner-inner 边或 outer-outer 边（按 source / target 是否都在 wrapper.nodeIds 内决定）。

#### 5.3.1 boundary 边的两端校验

```ts
function validateBoundaryEdge(e: WorkflowEdge, defn: WorkflowDefinition) {
  if (e.boundary === 'wrapper-input') {
    const wrapper = nodeById.get(e.source.nodeId)
    if (wrapper?.kind !== 'wrapper-fanout') throw 'boundary-input-source-not-wrapper'
    if (!wrapper.inputs.some(p => p.name === e.source.portName)) throw 'boundary-input-port-not-declared'
    if (!wrapper.nodeIds.includes(e.target.nodeId)) throw 'boundary-input-target-not-inner'
  }
  if (e.boundary === 'wrapper-output') {
    const wrapper = nodeById.get(e.target.nodeId)
    if (wrapper?.kind !== 'wrapper-fanout') throw 'boundary-output-target-not-wrapper'
    if (!wrapper.nodeIds.includes(e.source.nodeId)) throw 'boundary-output-source-not-inner'
    // outputs port name 由 runtime 推导，不存于 schema；validator 仅检查 source 是 aggregator
    const src = nodeById.get(e.source.nodeId)
    if (!(src.kind === 'agent-single' && getAgentRole(src) === 'aggregator')) {
      throw 'boundary-output-source-must-be-aggregator'
    }
  }
}
```

`__done__` 边的特殊情况：当 wrapper-fanout 无聚合 agent 时，wrapper 自身的隐式 `__done__` 出口在 schema 中**不显式存为 boundary edge**——它是 wrapper 对外的 outgoing edge（source.nodeId = wrapperId，source.portName = '__done__'），target 是下游普通节点。validator 见到这种边时按"wrapper signal output"语义放行。

### 5.4 outputs 推导

```ts
export function deriveWrapperFanoutOutputs(
  wrapperId: string,
  defn: WorkflowDefinition,
): Array<{ name: string; kind: string }> {
  const innerIds = getWrapperInnerNodeIds(wrapperId, defn)
  const aggregators = innerIds
    .map(id => nodeById.get(id))
    .filter(n => n.kind === 'agent-single' && getAgentRole(n) === 'aggregator')
  if (aggregators.length === 0) {
    return [{ name: '__done__', kind: 'signal' }]
  }
  if (aggregators.length > 1) {
    // validator 已报 multiple-aggregators-in-fanout；此处兜底取第一个，但不应触发
  }
  const agg = aggregators[0]
  const agent = getAgentByName(agg.agentName)
  return agent.outputs.map(o => ({
    name: o.wrapperPortName ?? o.name,
    kind: o.kind,
  }))
}
```

前端 NodeInspector / canvas 渲染、scheduler "wrapper outgoing edge target" 解析、validator outgoing edge 校验都调这个统一函数。

### 5.5 cartesian schema warning

```ts
function checkFanoutNesting(nodes, wrapperId, depth = 0) {
  if (depth > 0) emitWarning('wrapper-fanout-nested', { wrapperId, depth })
  const innerWrapperFanouts = getWrapperInnerNodeIds(wrapperId, defn)
    .map(id => nodeById.get(id))
    .filter(n => n.kind === 'wrapper-fanout')
  for (const inner of innerWrapperFanouts) {
    checkFanoutNesting(nodes, inner.id, depth + 1)
  }
}
```

Warning 在 ValidationPanel 显示；不阻塞保存 / 启动；runtime 用 §11 的 hard limit 兜底。

## 6. Shard scope 推断

### 6.1 算法

```ts
export function computeShardScope(
  wrapperId: string,
  defn: WorkflowDefinition,
): { perShard: Set<string>; shared: Set<string>; aggregatorId: string | null } {
  const innerIds = new Set(getWrapperInnerNodeIds(wrapperId, defn))
  const aggregatorId = findAggregator(innerIds, defn)
  // shardSource boundary edge 的所有 target 节点是 BFS 起点
  const shardSourcePort = getShardSourcePort(wrapperId, defn)
  const seeds = defn.edges
    .filter(e => e.boundary === 'wrapper-input'
              && e.source.nodeId === wrapperId
              && e.source.portName === shardSourcePort.name)
    .map(e => e.target.nodeId)
  // 顺 dataflow 边 BFS
  const reachable = new Set<string>()
  const queue = [...seeds]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (reachable.has(cur)) continue
    reachable.add(cur)
    for (const e of defn.edges) {
      if (e.source.nodeId !== cur) continue
      if (e.boundary === 'wrapper-output') continue   // 出 wrapper 边不传播
      if (!innerIds.has(e.target.nodeId)) continue     // 出 inner subgraph 不传播
      // 聚合 agent 是 reachable 终点（豁免 promote 规则；它跑 1 次收 raw list）
      if (e.target.nodeId === aggregatorId) continue   // 不把 aggregator 拉进 reachable
      queue.push(e.target.nodeId)
    }
  }
  const shared = new Set<string>([...innerIds].filter(id => !reachable.has(id) && id !== aggregatorId))
  return { perShard: reachable, shared, aggregatorId }
}
```

注意点：

- aggregator agent **不在 perShard、不在 shared**——它是单独一档，永远跑 1 次。函数返回 `aggregatorId` 字段方便 scheduler 区分。
- broadcast 输入只能进入 shared 节点（reachable set 内的节点也能收 broadcast，但 broadcast 不改变 reachability）。
- 自动 promote 规则：在 §6.2 实现。

### 6.2 cross-set edge → 自动 promote

```ts
function applyAutoPromote(scope, defn, wrapperId) {
  const innerIds = ...
  let changed = true
  while (changed) {
    changed = false
    for (const e of defn.edges) {
      if (e.boundary) continue   // boundary 边不参与
      if (!innerIds.has(e.source.nodeId) || !innerIds.has(e.target.nodeId)) continue
      // source ∈ perShard, target ∈ shared, target != aggregator → promote target
      if (scope.perShard.has(e.source.nodeId)
       && scope.shared.has(e.target.nodeId)
       && e.target.nodeId !== scope.aggregatorId) {
        scope.shared.delete(e.target.nodeId)
        scope.perShard.add(e.target.nodeId)
        changed = true
      }
    }
  }
}
```

fix-point loop 因为链式 promote（A→B→C，A 在 perShard、B C 起初在 shared；先 promote B，下一轮 promote C）。aggregator 永远不被 promote。

### 6.3 shardSource list item kind

shardSource port 必须 kind 解析为 `{ kind: 'list', item: T }`。第一层是 list，但 T 可以是任何 kind（含嵌套 list）。

- T = base / `path<*>` → 每个 list item 是字符串，inner 节点收到字符串值。
- T = `list<...>`（嵌套列表）→ inner 节点收到的是一个 list 字符串（多行）。**v1 设计不为此优化语义**：shard 数 = 外层 list 长度，每个 shard 拿到的 item content 是内层 list 的全部多行串（"list of list" 没有自动二级 fan-out）。要做二级 fan-out 须再嵌套一个 wrapper-fanout。

### 6.4 node_runs 行 mint 规则

scheduler 展开 wrapper-fanout 时：

1. wrapper-fanout 自身 1 行 node_run，kind 在 `nodeRuns` schema 已有 `nodeId`，由 node.kind 间接表达；row.status 初始 `pending`，最终 `done` / `failed`（与 wrapper-git 一致，无新字段）。
2. 对 shardSource list 的每个 item（共 N 个），为每个 perShard inner 节点 mint 1 行 node_run：
   - `parentNodeRunId` = wrapper-fanout row id
   - `shardKey` = list kind 的 keyOf(item)
   - 其他字段（status, retryIndex, iteration, clarifyIteration, reviewIteration, crossClarifyIteration）按既有规则。
3. 每个 shared 节点 mint 1 行 node_run，`parentNodeRunId` = wrapper-fanout row id，`shardKey` = null。
4. aggregator agent mint 1 行 node_run，`parentNodeRunId` = wrapper-fanout row id，`shardKey` = null，标记 `aggregator: true`（runtime-only，不入 DB；通过 agent.role 间接判断）。

### 6.5 sharding 行为对照表

| 上游 / shardSource kind | shard 数 | shardKey 来源 |
|---|---|---|
| `list<string>` | item 数 | 0-based index（默认 fallback） |
| `list<path<*>>` | item 数 | item 字符串（=路径） |
| `list<path<md>>` | item 数 | item 字符串（路径） |
| `list<list<T>>` | 外层 list 长度 | 内层 list 整体作为 item 字符串；默认 0-based index |
| 空 `list<T>`（item 数 0） | 0 | wrapper 直接 done（仿 fanout-empty 现状） |

## 7. 聚合 agent runtime

### 7.1 dispatch

scheduler 在 wrapper-fanout 推进过程中，一旦所有 perShard 节点的 reachable subgraph 完成（即从 shardSource 出发的所有 reachable 节点都进入 `done` 或 `failed` 终态），开始聚合 agent dispatch：

```ts
async function dispatchAggregator(wrapperRunId, aggregatorNodeId, scope, defn, db) {
  const aggNode = nodeById.get(aggregatorNodeId)
  const agent = await getAgent(aggNode.agentName)
  const inputs = collectAggregatorInputs(aggregatorNodeId, scope, db)
  // inputs[portName] = [{ shardKey, content }, ...]
  const prompt = renderAggregatorPrompt(agent.promptTemplate, inputs)
  await runNode({
    nodeRunId: ...,
    agent,
    promptOverride: prompt,
    ...
  })
}
```

聚合 agent 是普通 LLM agent，runner 走现有路径；prompt 渲染层（§7.3）多支持一个 raw-list 语法。

### 7.2 input 收集

```ts
function collectAggregatorInputs(aggregatorId, scope, db) {
  const out: Record<string /* localPortName */, Array<{ shardKey: string; content: string }>> = {}
  for (const e of defn.edges) {
    if (e.target.nodeId !== aggregatorId) continue
    const srcNodeId = e.source.nodeId
    const srcPort = e.source.portName
    const localPort = e.target.portName
    if (scope.perShard.has(srcNodeId)) {
      // 收 N 个 shard 的输出
      const childRows = db.select(nodeRuns)
        .where(parentNodeRunId === wrapperRunId, nodeId === srcNodeId, status === 'done')
      for (const child of childRows) {
        const portRow = db.select(nodeRunOutputs)
          .where(nodeRunId === child.id, portName === srcPort)
        out[localPort] ??= []
        out[localPort].push({ shardKey: child.shardKey, content: portRow?.content ?? '' })
      }
      // 按 shardKey 字典序排序，与现有 fanout 聚合稳定性一致
      out[localPort].sort((a, b) => a.shardKey.localeCompare(b.shardKey))
    } else {
      // 上游是 shared（含 broadcast 进来的）→ raw list 长度 1
      const row = db.select(nodeRuns)
        .where(parentNodeRunId === wrapperRunId, nodeId === srcNodeId, status === 'done')
        .latest()
      const portRow = db.select(nodeRunOutputs).where(nodeRunId === row.id, portName === srcPort)
      out[localPort] ??= []
      out[localPort].push({ shardKey: 'shared', content: portRow?.content ?? '' })
    }
  }
  return out
}
```

shared 上游也走 raw list 包装，但只有 1 项；聚合 agent 的模板对单 vs 多 shard 一视同仁。

### 7.3 prompt 渲染：`{{#each port.shards}}`

`packages/backend/src/services/runner.ts`（或抽到 `packages/shared/src/promptRender.ts`）扩展模板引擎：

```
{{#each <portName>.shards}}
  shardKey: {{shardKey}}
  content: {{content}}
{{/each}}
```

实现：先 scan template 找到 `{{#each X.shards}}...{{/each}}` 块（嵌套不支持，v1 line scan 即可），用 raw list 替换；其余 `{{X}}` 走 normal binding 渲染。

向后兼容：聚合 agent 也能用 `{{<portName>}}` 普通引用，渲染规则按 list<T> 的 promptRender 默认（多行 join）。对单值场景退化为单个 content；对多 shard 退化为多行字符串拼接。

### 7.4 输出 promote

聚合 agent 跑完 envelope 解析得到 `agent.outputs[i]` 的内容；按 wrapperPortName 重命名后存入 wrapper-fanout 的 outputs：

```ts
async function finalizeWrapperFanout(wrapperRunId, aggregator?: AgentRunResult) {
  if (aggregator) {
    for (const port of aggregator.outputs) {
      const wrapperPortName = port.wrapperPortName ?? port.name
      await db.insert(nodeRunOutputs).values({
        nodeRunId: wrapperRunId,
        portName: wrapperPortName,
        content: port.content,
      })
    }
  } else {
    // 无聚合 agent → 写一个空 __done__ port
    await db.insert(nodeRunOutputs).values({
      nodeRunId: wrapperRunId,
      portName: '__done__',
      content: '',
    })
  }
  // 此时下游节点（接 boundary='wrapper-output' 或直接读 wrapper.id 的边）可以拿到值
}
```

注意 wrapper-fanout row 的 outputs 命名空间与 wrapper 自身（不存在 inner 节点的）一致：下游边 source.nodeId = wrapperId, source.portName = wrapperPortName。

### 7.5 失败模式

| 失败 | 处理 |
|---|---|
| reachable inner 节点某 shard 跑挂 | 该 shard mark failed；不阻塞其他 shard；聚合阶段只看 `done` 状态 shard 的输出；若 reachable 节点**全部 shard 都失败** → wrapper-fanout marked failed |
| aggregator 自己跑挂 | wrapper-fanout marked failed，errCode `fanout-aggregator-failed` |
| 聚合输入 raw list 长度 0（所有 shard fail）| 跳过 aggregator dispatch，直接 wrapper-fanout marked failed `fanout-all-shards-failed` |
| shared 节点跑挂 | wrapper-fanout marked failed（与 wrapper-git 一致：inner 节点任何 failure 都向 wrapper 冒泡） |

## 8. wrapper-git 升级

### 8.1 改 git_diff port kind

`packages/backend/src/util/git.ts`：现有 `gitDiffSnapshot` 返回完整 diff 字符串；新增（或改造）`gitChangedFiles` 返回 worktree-relative path 列表。

wrapper-git node 的 output port 单一固定 `git_diff`，kind 从 `string` 改为 `list<path>`。

scheduler wrapper-git 完成时：

```ts
const changedFiles = await gitChangedFiles(repoCwd, preSnapshot, postSnapshot)
await db.insert(nodeRunOutputs).values({
  nodeRunId: wrapperGitRunId,
  portName: 'git_diff',
  content: changedFiles.join('\n'),  // list<path> wire 形态：多行
})
```

### 8.2 下游消费 git_diff 的 prompt

之前的 agent prompt 模板若使用 `{{git_diff}}`，现在拿到的是多行 path 列表（而非完整 diff text）。**这是 breaking change**：

- agent 的 system_prompt / user_prompt 模板必须改写为"基于变动文件列表"工作。
- 想看完整 diff text 的，可以 `cat` / `git diff` 在 worker 内自己取（worker 拿到 worktree path 已经有完整 cwd 上下文）。

PR-E 同步刷新所有 fixture / e2e 样例工作流中引用 `{{git_diff}}` 的 prompt 模板。

### 8.3 与 fanout 对接

wrapper-git 的 `git_diff` 是 `list<path>` → 可作为 wrapper-fanout 的 shardSource，shardKey = 路径字符串。

## 9. 删 agent-multi

### 9.1 删除清单

- `NODE_KIND` 数组移除 `'agent-multi'`。
- `workflow.validator.ts`：删除 4 处 `case 'agent-multi'` / `agent-multi-source-port-missing` / `agent-multi-sharding-missing` / `agent-multi-sharding-invalid` 等代码。
- `scheduler.ts`：删除 fanout-aggregate / fanout-empty 老路径（2171-2454 行级），由 wrapper-fanout 新分支取代。
- `services/clarify.ts` / `crossClarify.ts` / `review.ts`：删除"跳过 shard 子 row"等 special-case；统一走 parentNodeRunId + shardKey 通用查询。
- `services/inventory.ts`：`PROMPT_CAPABLE_KINDS` 等枚举去掉 agent-multi。
- frontend：`NodeInspector` 删除 agent-multi 分支；Palette 删除 agent-multi 项；canvas 多个组件中的 agent-multi-only 渲染分支清掉。
- DB：node_runs schema 文档注释里的"agent-multi shard child"措辞改为"wrapper-fanout shard child"。无表结构 migration。

### 9.2 grep 守卫

在 PR-E 加 source-grep test：

```ts
test('agent-multi entirely removed from codebase', async () => {
  const hits = await glob('packages/**/*.{ts,tsx}', { ignore: ['**/dist/**'] })
  for (const file of hits) {
    const text = await readFile(file)
    expect(text).not.toMatch(/agent-multi/)  // 例外 fixture 需特殊放行
  }
})
```

文档 / RFC-060 自身、`design/RFC-NNN-*/proposal.md` 等历史记述里的 agent-multi 由路径白名单 ignore。

## 10. review / clarify per-shard 自然落地

### 10.1 review 节点放在 wrapper-fanout 内

设：fanout 内 inner subgraph = `designer (perShard) → review (perShard)`。

scheduler 推进时：

- designer 节点为每个 shard mint 一行 node_run（shardKey = list item 的 keyOf）；
- review 节点的 dispatch（`dispatchReviewNode`）按 shardKey 维度独立：每个 designer 的 done shard 对应一份独立 review；
- review node 的 `inputSource` (source.nodeId = designerNodeId, source.portName) 在 review 服务内现有"freshest run picker"（`review.ts:309-343`）已通过 parentNodeRunId + shardKey 维度自动正确选择——RFC-060 删掉那条 `// Skip fan-out child rows` 注释 + skip 逻辑，改为按 shardKey 选取与当前 review row 同 shardKey 的 designer run。
- reject / iterate：现有 RFC-014 cascade rerun 顺 reverse-edge BFS 找 rerunnable upstream。由于 wrapper-fanout 内每个 shard 是独立 (parentNodeRunId, shardKey) 集合，cascade 自然限定在该 shard 内。验证测试 §14.A6。

### 10.2 review 节点 input 端口禁 list<T>

review 节点的 inputSource 仍 reflect "单个上游 port"。validator 加规则：

```ts
if (node.kind === 'review') {
  const srcKind = resolvePortKind(node.inputSource.nodeId, node.inputSource.portName, defn)
  const parsed = parseKind(srcKind)
  if (parsed.kind === 'list') {
    issues.push({
      code: 'review-input-list-kind-not-supported',
      message: `review node '${node.id}' input port has list kind '${srcKind}'; review only accepts single-value ports. Move review inside a wrapper-fanout for per-item review.`,
    })
  }
}
```

### 10.3 clarify / clarify-cross-agent 节点

类似：放在 wrapper-fanout 内时，每个 shard 独立 mint clarify_rounds row（RFC-058 合表后的）。`shardKey` 字段在 clarify_rounds 中已经存在（RFC-058 design §3）。

cross-clarify 节点之前禁 agent-multi questioner（`workflow.validator.ts:899` `agent-multi is deferred to a follow-up RFC`）——本 RFC 解禁：cross-clarify-agent 节点放在 wrapper-fanout 内时 questioner 是 perShard 节点，每个 shard 独立 cross-clarify session。删除该 validator 规则。

### 10.4 同 shard iterate / reject 不外泄

测试守门（§14.A6）：US-1 场景下 reviewer reject 第 3 个 shard，仅该 shard 的 designer rerun，其他 N-1 个 shard 不被打扰。

## 11. Cartesian guard

### 11.1 Schema-time warning

§5.5 已述。validator 输出 warning `wrapper-fanout-nested`，severity = warning（不阻塞保存）。

### 11.2 Runtime hard limit

`packages/backend/src/services/scheduler.ts` 在展开 wrapper-fanout shards 前累乘嵌套：

```ts
function estimateShardTotal(wrapperRunId, defn): number {
  const wrapperNode = ...
  const shardCount = ...   // shardSource list 长度
  const innerFanouts = wrapperNode.nodeIds.filter(id => nodeById.get(id).kind === 'wrapper-fanout')
  // 内层 fanout 此时 shard 数未知（取决于其 shardSource 是否依赖外层 shard 输出）
  // v1 保守：内层 shardCount 估算用 schema-time 上限（用户在 wrapper.metadata.expectedShardCount 可选注解）
  let nested = 1
  for (const fid of innerFanouts) {
    nested *= getExpectedShardCount(fid) ?? 16  // 默认估算 16
  }
  return shardCount * nested
}

if (estimateShardTotal(wrapperRunId, defn) > settings.fanoutMaxShardTotal /* default 256 */) {
  throw new DomainError('fanout-cartesian-limit', `estimated shard total exceeds limit`)
}
```

简化：v1 用静态估算 + 用户可选 `expectedShardCount` metadata 注解。实际 runtime 拓展时若发现内层 shard 数远超预期（外层每 shard 跑出来的内层 list 长度爆炸），运行时检查每次 mint perShard rows 时累加 wrapper-fanout 链上总 shard 数，超阈值仍 hard fail。

### 11.3 阈值

- `settings.fanoutMaxShardTotal`：默认 256；用户改 settings.json 可调。
- 单个 wrapper-fanout 内最大 shard 数：暂不单独限制（受 fanoutMaxShardTotal 总限制约束足够）。

## 12. 失败模式与守护

| 失败 | 错误码 | 处理 |
|---|---|---|
| wrapper-fanout 0 个 shardSource | `wrapper-fanout-shard-source-missing` | validator 报错 |
| 2+ 个 shardSource | `wrapper-fanout-shard-source-duplicate` | validator 报错 |
| shardSource kind 非 list<T> | `wrapper-fanout-shard-source-must-be-list` | validator 报错 |
| 多个聚合 agent | `multiple-aggregators-in-fanout` | validator 报错（v1） |
| aggregator agent 顶层 nodes[] 出现 | `aggregator-agent-outside-fanout` | validator 报错 |
| boundary edge 字段不匹配实际 | `boundary-input-port-not-declared` 等 | validator 报错 |
| signal port 被 `{{}}` 引用 | `signal-port-in-prompt` | PortValidationError（envelope 检查时） |
| review 接 list<T> port | `review-input-list-kind-not-supported` | validator 报错 |
| shard 总数超阈值 | `fanout-cartesian-limit` | runtime hard fail |
| aggregator dispatch 但所有 shard 全 fail | `fanout-all-shards-failed` | wrapper-fanout marked failed |
| aggregator agent 自己跑挂 | `fanout-aggregator-failed` | wrapper-fanout marked failed |
| empty list（shardSource 长度 0） | （非错） | wrapper-fanout 直接 done，aggregator 跳过，wrapper.outputs port 全空 |

## 13. 与现有 RFC 的耦合点

### 13.1 与 RFC-049 port-content-repair-followup

RFC-049 引入了 `port-validation-<kind>-<sub>` 错误码体系；本 RFC 新加的 kinds 沿用该路径：

- `list<T>`：subreason 含 `empty-item`（某行 trim 后空）/ `item-validate-failed` （某 item 内层 validate 失败，detail 嵌套子错误）。
- `signal`：subreason 含 `non-empty-content`（agent 写了非空内容，warning level 即可，不强制 fail）/ `in-prompt-template`（§3.3）。
- `path<T>`：复用 RFC-049 现有 `missing-file` / `empty-path` / `escapes-worktree` / `wrong-extension` / `empty-file` 五条 subreason，新增 `ext-mismatch` 如果 ext 注册了 'md' 但拿到 'txt' 这种。

### 13.2 与 RFC-014 sibling regen + RFC-052 retry-cascade

review reject 后的 cascade rerun（`review.ts: cascadeReviewReject`）BFS 反向边到 rerunnable upstream，按 shardKey 维度自动隔离：
- 现有 BFS 不考虑 shardKey；本 RFC 在 wrapper-fanout 内的 cascade 必须按 shardKey 过滤。具体修改：cascade picker 拿当前 review row 的 shardKey，所有 upstream rerun mint 的新 node_runs 继承该 shardKey；本来在 perShard set 内的节点 cascade 出来的新 retry row 自动只影响该 shard。
- shared 节点的 cascade：若 review 在 perShard set 内（如典型 designer→review），cascade 不应跨入 shared 节点（shared 跨 shard 共享、不重跑）。

### 13.3 与 RFC-053 lifecycle hardening

新增 NodeKind `wrapper-fanout` 需要在 `lifecycle.ts` / `setNodeRunStatus` / `transitionNodeRunStatus` 等位置正常被接纳。`isProcessNodeKind` 增加 `wrapper-fanout`。

新 lifecycle alert rule 候选（不在本 RFC 落地，留给 RFC-057 后续 follow-up）：
- F1：wrapper-fanout row stuck 在 `pending` 且 shard children 全 done — orphaned aggregator
- F2：aggregator row stuck，wrapper-fanout 已 done — finalize race

### 13.4 与 RFC-056 cross-clarify

§10.3 删除 `clarify-cross-agent must not connect to agent-multi questioner` 验证规则（`workflow.validator.ts:899`）。questioner 在 wrapper-fanout 内的 perShard set 时，每个 shard 独立 cross-clarify session（cross_clarify_iteration 按 shard 计）。

### 13.5 与 RFC-058 clarify_rounds 合表

RFC-058 已将 `clarify_sessions` + `cross_clarify_sessions` 合并为 `clarify_rounds`，含 `kind: 'self' | 'cross'` discriminator 和 `shardKey` 字段。本 RFC 直接复用，不动表。

### 13.6 与 RFC-055 fanout-sharding-strategy-inspector

RFC-055 给 `agent-multi` 加了 sharding strategy inspector UI（per-file / per-N-files / per-directory）。本 RFC 删除 `agent-multi` → 该 inspector 整体废弃（前端 `<ShardingStrategyField>` 删除）。新模型下 sharding 由"上游 list<T>"决定，无需 inspector。

## 14. 测试策略

### 14.1 测试覆盖目标

> 总计新增 backend ≥ 60 / frontend ≥ 20 / e2e ≥ 1 spec（含 ≥ 3 scenario）。

### 14.2 backend 测试分布

| 模块 | 文件 | 覆盖 |
|---|---|---|
| kind parser | `packages/shared/tests/kind-parser.test.ts` | parse / stringify 双向 round-trip 各种 kind；malformed 异常 |
| outputKinds registry | `packages/shared/tests/output-kinds-list.test.ts` | list / path 注册；keyOf fallback；嵌套 list |
| signal kind | `packages/backend/tests/signal-output-kind.test.ts` | 渲染空 / envelope 解析非空 warning / prompt 模板引用报错 |
| agent role | `packages/backend/tests/agent-role-aggregator.test.ts` | frontmatter parse / wrapperPortName / 顶层 nodes 报错 / 多 aggregator 报错 |
| wrapper-fanout validator | `packages/backend/tests/wrapper-fanout-validator.test.ts` | shardSource 唯一 / list kind / boundary edge / multiple aggregator / nested fanout warning |
| shard scope | `packages/backend/tests/fanout-shard-scope.test.ts` | reachable BFS / cross-set promote / fix-point / aggregator 豁免 |
| aggregator runtime | `packages/backend/tests/fanout-aggregator-runtime.test.ts` | raw list collection / prompt rendering with `{{#each}}` / shardKey sort / shared inputs |
| review per-shard | `packages/backend/tests/review-in-fanout.test.ts` | 每 shard 独立 review row / reject 仅本 shard cascade / RFC-052 与 RFC-014 协作 |
| clarify per-shard | `packages/backend/tests/clarify-in-fanout.test.ts` | self + cross 两种 per-shard 独立 session |
| cartesian guard | `packages/backend/tests/fanout-cartesian-guard.test.ts` | schema warning / runtime hard fail / settings 阈值读取 |
| wrapper-git list<path> | `packages/backend/tests/wrapper-git-list-path.test.ts` | output 形态变更 / 下游 prompt 渲染 |
| agent-multi grep | `packages/backend/tests/agent-multi-removed.test.ts` | source grep 守卫 |

### 14.3 frontend 测试分布

| 模块 | 文件 | 覆盖 |
|---|---|---|
| agent editor role | `packages/frontend/tests/agent-editor-role.test.tsx` | role 二选枚举 / wrapperPortName 仅 aggregator 可见 |
| wrapper-fanout 编辑器 | `packages/frontend/tests/wrapper-fanout-editor.test.tsx` | inputs[] 列表 / shardSource flag / boundary 边拖动 |
| signal port 渲染 | `packages/frontend/tests/signal-port-render.test.tsx` | 虚线 / 不能被 prompt 模板 picker 选中 |
| cartesian warning | `packages/frontend/tests/cartesian-warning.test.tsx` | ValidationPanel 渲染 |
| outputs 推导 | `packages/frontend/tests/wrapper-fanout-outputs-derive.test.tsx` | UI 展示 `__done__` vs aggregator output |

### 14.4 e2e

`playwright/fanout-as-wrapper.spec.ts`：

- **Scenario 1**（US-1 markdown × review N 份）：构造一个工作流，designer 输出 list<path<md>>，wrapper-fanout 内放 reviewer + aggregator，run task → /review 页面看到 N 个待审 → 全 approve → aggregator 跑完 → 下游收到合并文档。
- **Scenario 2**（US-3 fanout 嵌套 git wrapper）：fanout 内 nest wrapper-git，每 shard 独立 git diff → aggregator 收 N 份 diff path list 并汇总。
- **Scenario 3**（US-4 无 aggregator）：fanout 内不放 aggregator，wrapper.__done__ 边连下游通知 agent，下游正常拿到信号但不读取数据。

### 14.5 现有套件回归守门

- RFC-005 review 套件全绿（per-shard review 不破坏既有 single-shard 行为）。
- RFC-014 sibling regen 套件全绿（cascade rerun shardKey 隔离不破坏 reachable set 外的链路）。
- RFC-023 clarify + RFC-056 cross-clarify + RFC-058 合表后的套件全绿（per-shard clarify session 在 perShard set 内独立 mint）。
- RFC-049 port validation 套件全绿（新 kind 沿用 errCode 命名空间）。
- RFC-053 lifecycle invariant 套件全绿（新 NodeKind `wrapper-fanout` 不破坏既有不变量）。

### 14.6 source-text 守卫

```ts
test('agent-multi NodeKind fully removed', () => {
  const schemaText = readFileSync('packages/shared/src/schemas/workflow.ts', 'utf8')
  expect(schemaText).not.toMatch(/'agent-multi'/)
})

test('review.ts no longer skips fanout child rows', () => {
  const reviewText = readFileSync('packages/backend/src/services/review.ts', 'utf8')
  expect(reviewText).not.toMatch(/Skip fan-out child rows/)
})

test('wrapper-fanout is in NodeKind enum', () => {
  const schemaText = readFileSync('packages/shared/src/schemas/workflow.ts', 'utf8')
  expect(schemaText).toMatch(/'wrapper-fanout'/)
})

test('signal kind in AgentOutputKind', () => {
  // 通过 import 验证而非 grep
  expect(parseKind('signal')).toEqual({ kind: 'base', name: 'signal' })
})
```

## 15. 落地节奏

详 `plan.md`。粗略：PR-A ≈ 4 天 / PR-B ≈ 3 天 / PR-C ≈ 5 天 / PR-D ≈ 7 天 / PR-E ≈ 4 天 / PR-F ≈ 5 天，单人工时合计 ≈ 4 周。每 PR 单独 push CI 全绿后再启下一 PR。
