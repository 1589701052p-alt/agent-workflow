# RFC-080 — 技术设计

## 1. 现状：两套并行、未统一的 output-kind 注册表

| 维度                  | 遗留 `HANDLERS`（RFC-049）                               | parametric `PARAMETRIC_HANDLERS`（RFC-060 PR-A）                      |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| 位置                  | `shared/src/outputKinds/index.ts:21`                     | `shared/src/outputKinds/registry.ts:80`                               |
| 形态                  | `Record<'string'\|'markdown'\|'markdown_file', Handler>` | `Handler[]`，靠 `matches(parsed)` 派发                                |
| 取 handler            | `getOutputKindHandler(kind:string)`，未命中**抛**        | `getHandlerForParsedKind(parsed)` / `tryHandlerForParsedKind(parsed)` |
| handler 接口          | `OutputKindHandler`（`types.ts:61`）                     | `ParametricOutputKindHandler`（`registry.ts:43`）                     |
| `validate` ctx        | `{ port, kind:string, worktreePath }`                    | `{ port, kind:ParsedKind, worktreePath }`                             |
| `buildPromptGuidance` | `{ ports }`                                              | `{ ports, portKinds:Map<string,ParsedKind> }`                         |
| `buildRepairBlock`    | `{ failures:KindFailure[], ports }`                      | `{ failures:ParametricKindFailure[], ports }`                         |
| 覆盖 kind             | string / markdown / markdown_file                        | string / markdown / **path / list / signal**                          |

两接口**方法集相同**（`buildPromptGuidance` / `validate` / `buildRepairBlock` /
`subReasons`），差异仅在「字面 key vs `matches(ParsedKind)`」「ctx.kind 是 string
vs ParsedKind」「guidance 多收一个 `portKinds`」「`displayName` 取代 `kind`」。
迁移因此是**机械且无歧义**的——这正是 RFC-060 `index.ts:144-147` 注释里
"PR-D switches runtime callers over" 描述的、但**未落地**的工作。

### 1.1 三个仍接遗留注册表的 agent-output 运行时点

1. `prompt.ts:564` `buildProtocolBlock` → `groupPortsByKind(...)`（`index.ts:70`
   内部对每个 distinct kind 调 `getOutputKindHandler`）。对任何 parametric kind
   **抛**。另有行内字面判断 `agentOutputKinds?.[port] === 'markdown_file'`
   （`prompt.ts:546`）驱动 per-port bullet / example 注解。
2. `envelope.ts:319` `resolvePortContentDetailed` → `getOutputKindHandler(kind)`。
   对任何 parametric kind **抛**。
3. `runner.ts:578` 经 `composePerKindRepairBlocks`（`index.ts:92`）。此处对未注册
   kind 是 `continue` 跳过（`index.ts:101`），**不抛但静默无 repair 文案**。

> 之所以今天不崩：唯一能写 agent `outputKinds` 的 UI 是 `OutputsEditor`，它只放
> 3 个遗留值。git wrapper 的 `list<path>`、fanout 输入端口的 `list<T>` 都不是
> _agent 输出_，不流经上面 3 个点的 agent-output 分组。

## 2. PR-A：运行时迁移到 parametric 注册表

### 2.1 新增共享分组 helper（parametric 版）

在 `shared/src/outputKinds/` 下新增（或并入 registry.ts）两个纯函数，作为
`groupPortsByKind` / `composePerKindRepairBlocks` 的 parametric 对应物：

```ts
// 解析每个 port 的 kind 字符串 → ParsedKind，按命中的 parametric handler 分桶。
// 未声明 kind 的 port 默认 base 'string'。解析失败的 kind（理论上 schema 已挡）
// 退到 string handler 并 console.warn（防御）。
groupPortsByParsedKind(
  declaredOutputs: readonly string[],
  agentOutputKinds?: Record<string, string>,
): { handler: ParametricOutputKindHandler; ports: string[]; portKinds: Map<string, ParsedKind> }[]

composePerParsedKindRepairBlocks(
  failures: readonly ParametricKindFailure[],
  agentOutputKinds?: Record<string, string>,
): string[]
```

分桶 key = `handler.displayName`（稳定、无 `<>`），首次出现序保持。

### 2.2 `prompt.ts buildProtocolBlock`

- `renderPerKindGuidance`：`groupPortsByKind` → `groupPortsByParsedKind`；对每桶调
  `handler.buildPromptGuidance({ ports, portKinds })`。
- per-port bullet / example 的「写文件」注解：把字面 `=== 'markdown_file'`
  （`prompt.ts:546`）换成 parsed 判定——
  `const p = tryParseKind(kind); isPathLike = p?.kind === 'path'`。
  bullet 文案改为通用 path 措辞
  （`(path — write the file first, then emit only its worktree-relative path)`），
  example 占位改为 `<worktree-relative path to the file you just wrote>`。
  `markdown_file` 与 `path<md>` 因此走同一支，语义等价。
- **决策 D1**：迁移后 `markdown_file` 端口的 per-kind 段落由 **path handler**
  （`path.ts:63`，已按 ext 特判 `.md/.markdown`）产出，文案与旧 markdownFile
  handler 文案不同但语义等价。AC-5 据此把「字节一致」收窄到 string/markdown +
  markdown_file 的**校验**行为；prompt 文案快照同步更新。

### 2.3 `envelope.ts resolvePortContentDetailed`

- `getOutputKindHandler(kind)` → `const parsed = parseKind(kind);
const handler = getHandlerForParsedKind(parsed)`。
- `validate` ctx 从 `{ port, kind:string, worktreePath }` 换成
  `{ port, kind:parsed, worktreePath }`（parametric handler 读 `ctx.kind.ext` /
  `ctx.kind.item`）。
- **决策 D2**：errCode 命名段从原始 `kind` 字符串换成 `handler.displayName`
  （`port-validation-path-missing-file` 而非把 `<>` 塞进 errCode）。PR-A 必须
  grep 现有对 `port-validation-markdown_file-*` / `port-validation-<kind>-*` 的
  断言（前端 toast / 测试），同步改为 displayName 形态；若发现外部契约依赖旧
  errCode，则保留 `markdown_file` → 仍输出 `markdown_file` 段的兼容映射（在
  design 评审时定）。
- `kind === undefined` 的 raw passthrough 分支（`envelope.ts:307`）不变。

### 2.4 `runner.ts` repair 路径

`composePerKindRepairBlocks` → `composePerParsedKindRepairBlocks`。`runner.ts` 持有
的 `KindFailure[]`（含字符串 kind）在调用前 map 成 `ParametricKindFailure`
（`kind: parseKind(f.kind)`）。失败码 namespace 同样走 displayName。

### 2.5 遗留 Record 去留

迁移完成后 grep `getOutputKindHandler` / `groupPortsByKind` /
`composePerKindRepairBlocks` 在 `packages/{backend,shared}/src`（排除 test 与
注册表自身）的剩余引用：

- 若**零剩余**：删除 `HANDLERS` / `getOutputKindHandler` / `groupPortsByKind` /
  `composePerKindRepairBlocks` + 三个 legacy handler 文件（string/markdown/
  markdownFile）+ `OutputKindHandler` 接口，兑现 RFC-060 PR-D 的「remove legacy
  entries」。
- 若仍有非 agent-output 引用：保留，加注释指向本 RFC，列为 follow-up。
- 无论哪种，新增**源码 grep 守卫**：`prompt.ts` / `envelope.ts` / `runner.ts`
  不得再出现 `getOutputKindHandler(` / `groupPortsByKind(`。

## 3. PR-B：公共 `KindSelect` 原语

### 3.1 组件契约

```tsx
// packages/frontend/src/components/KindSelect.tsx
interface KindSelectProps {
  value: string // canonical kind 字符串；'' / 'string' 视作 base string
  onChange: (kind: string) => void // 始终回吐 stringifyKind(...) 规范形
  ariaLabel?: string
  disabled?: boolean
  testidPrefix?: string // 比照 ChipsInput testidPrefix 先例，供两面测试挂钩
}
```

内部仅由公共原语组合：`Select`（base 下拉）+ `TextInput`（path 扩展名 / advanced
raw 输入）+ `Switch`（list 包裹）。**禁止**自落原生 `<select>` / 自写 chrome。

### 3.2 引导模式 ↔ advanced 模式

用 `tryParseKind(value)` 解析，判定能否用引导控件表达：

- **可引导** 当且仅当：解析成功 **且** 结构是「最多一层 `list`，叶子 ∈
  {base, path}」。即 `base` / `path<*>` / `list<base>` / `list<path<*>>`。
- 引导控件：
  - base `Select`：选项 `string` / `markdown` / `signal` / `path`（i18n 标签）。
  - 选 `path` 时显示扩展名 `TextInput`：默认 `*`，placeholder `* / md / json`，
    实时校验 `^\*$|^[a-z][a-z0-9]*$`（对齐 `kindParser.ts` 的 `PATH_EXT_RE`）。
  - `list` 包裹 `Switch`：开 → 叶子外包一层 `list<...>`。
  - 任一控件改动 → 重组 `ParsedKind` → `stringifyKind` → `onChange`。
- **advanced 模式**（不可引导：嵌套 `list<list<...>>` 或解析失败）：
  渲染一个 raw `TextInput`（预填 `value`），实时校验
  `isRegisteredKindString`，不合格显示红字解析错误（取 `KindParseError.message`
  或 schema 文案），**不静默改写**。附「切回引导模式」按钮：把当前可提取的叶子
  重置为可引导默认（提不出则回 `string`）。

### 3.3 与两个调用面的接线

- **`OutputsEditor`**（`OutputsEditor.tsx:86-99`）：删除 `<select>` + `KIND_OPTIONS`
  常量，换成 `<KindSelect value={kind} onChange={(k) => setKind(name, k)} />`。
  `setKind` 现有「kind==='string' 则从 map 删」逻辑保留（canonical `string` ≡
  缺省，`compact()` 不变）。`outputKinds` 存任意 canonical kind 字符串；
  `markdown_file` 经组件读入显示为 path(.md)、写出规范化为 `path<md>`（D1）。
- **`NodeInspector` fanout 输入**（`NodeInspector.tsx:696-700`）：删除裸
  `<TextInput>` kind 输入，换 `<KindSelect>`。下方 shardSource 必须 `list<T>` 的
  告警（`isShardKindOk = parsed?.kind === 'list'`，`NodeInspector.tsx:680,722`）
  原样保留。`addInput` 默认 `list<string>`（`NodeInspector.tsx:656`）须能被
  KindSelect round-trip（list + base string，可引导）。

### 3.4 i18n / 样式

- i18n key（cn/en 对称）：`kindSelect.base_string` / `base_markdown` /
  `base_signal` / `base_path` / `extLabel` / `extPlaceholder` / `listToggle` /
  `advancedToggle` / `parseError` / `signalHint`（「控制流-only，无数据」）。
- 样式命名空间 `.kind-select` / `.kind-select__row` / `.kind-select__ext` /
  `.kind-select__advanced`，复用既有 spacing / 控件高度，与 `.outputs-editor` /
  `.fanout-input-row` 对齐。

## 4. 数据流与耦合点

- **保存路径不变**：`OutputsEditor` 仍通过既有 `onChange(outputs, outputKinds)`
  上抛；`CreateAgentSchema.outputKinds`（`schemas/agent.ts:149`）已是
  `AgentOutputKindsMapSchema`（值走 `AgentOutputKindSchema.refine`），canonical
  parametric 字符串天然通过 schema。**无 DB 迁移、无新列**。
- **canvas 保存路径不变**：fanout `inputs[].kind` 已是自由字符串字段；KindSelect
  只是换了输入控件。
- **派发路径**（PR-A 收口）：scheduler → runner → `buildProtocolBlock`（prompt）
  与 envelope `resolvePortContentDetailed`（校验）→ parametric handler。
- **校验器**：`workflow.validator.ts` 对 fanout shardSource「必须 `list<T>`」、
  review「不接 `list<T>`」等既有规则不动（仍读 kind 字符串经 `tryParseKind`）。

## 5. 失败模式

| #   | 场景                                            | 处理                                                                                                                      |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| F1  | agent 输出声明 parametric kind，PR-A **未先落** | 派发时 `buildProtocolBlock` / envelope 抛 `handler not registered`。→ **强序：PR-A 必须先合并且 CI 绿，PR-B 才放开 UI。** |
| F2  | `markdown_file` 历史值再存被规范化为 `path<md>` | 语义等价（parser 折叠 + path handler 同样二步协议 + 校验同样 `.md/.markdown` 非空）。AC-2/AC-5 + 快照锁。                 |
| F3  | errCode 从 `markdown_file` 漂移到 `path`        | D2：统一 displayName；PR-A grep 并更新所有断言旧 errCode 的测试 / 前端文案。                                              |
| F4  | 用户在 advanced 输入非法 / 嵌套 kind            | 实时红字错误，`onChange` 仍回吐原串（不丢字），保存时 schema 兜底拒绝非注册 kind。                                        |
| F5  | fanout shardSource 选了非 list 叶子             | KindSelect 不阻止；沿用 NodeInspector 既有 `fanoutInputShardSourceMustBeList` 告警 + validator 报错。                     |
| F6  | signal 端口被当数据端口下游消费                 | 沿用 `signalPromptGuard` / validator 既有约束，不在本 RFC 改。                                                            |

## 6. 测试策略（详细 case 见 plan.md §验收清单）

### PR-A（后端 / shared）

- **buildProtocolBlock**：对 `string` / `markdown` / `signal` / `path<*>` /
  `path<md>` / `path<json>` / `list<string>` / `list<path<md>>` 各构造一个声明该
  kind 的 agent → 断言不抛、且产出对应 guidance 段（path/list 二步协议、signal
  无数据提示）。
- **回归快照**：纯 `string` / 纯 `markdown` agent 的协议块**字节一致**；
  `markdown_file` agent 协议块更新为 path 文案（断言含「two-step」「worktree-
  relative path」关键句，语义等价）。
- **resolvePortContentDetailed**：`path<md>`（happy + empty-path / escapes /
  wrong-extension / missing-file / empty-file 各失败）、`list<path<md>>`（逐项）、
  `signal`、`string` passthrough；断言 errCode = `port-validation-<displayName>-
<sub>`。
- **grep 守卫**：`prompt.ts` / `envelope.ts` / `runner.ts` 不再出现
  `getOutputKindHandler(` / `groupPortsByKind(`。

### PR-B（前端）

- **KindSelect 单测**：8 个 kind 的 parse→控件态→`stringifyKind` round-trip；
  guided 重组（base 切换 / ext 输入 / list 开关）；advanced 退路（`list<list<
string>>` + 垃圾串）；ext 校验拒非法；signal hint 出现。
- **OutputsEditor**：选「list of path(.md)」→ `outputKinds[port] === 'list<path<md>>'`；
  选 string → 该 key 从 map 删除；`markdown_file` 读入→显示 path(.md)。
- **NodeInspector fanout**：经 KindSelect 改 kind；shardSource 非 list 告警仍在。
- **源码层守卫**：`OutputsEditor` / `NodeInspector` 不再各自落 kind `<select>` /
  裸 kind `<TextInput>`；两处都 import `KindSelect`。
- 角色优先：控件用 `getByRole('combobox')` / `getByRole('switch')` 断言（公共
  组件契约），testid 仅在公共组件本身（`testidPrefix`）。

### PR-C（e2e）

- Playwright：`/agents/new` 用 KindSelect 把某端口设为 `list<path<md>>` → 保存 →
  reload → 断言 agent 详情仍显示该 kind（持久 round-trip）。

### 零回归门槛

- `bun run typecheck && bun run test && bun run format:check` 全绿；
  与 RFC-049 / RFC-060 / RFC-079 既有 output-kind / prompt / envelope 套件零回归；
  单二进制 build smoke（shared barrel 改动，按 `reference_binary_build_module_cycle`
  跑 `bun run build:binary`）。

## 7. 防漏适配骨架（anti-漏适配 hook skeleton + drift guard）

> 依据：一次 11-agent 全仓审计（9 维度 + 对抗式完整性复核）枚举出 **94 个 port-kind
> 处理点**（31 generic / 30 structural / 24 already-abstracted）。最严重的两个
> 漏适配温床：(a) 魔法默认值 `'string'` 散落 5+ 处；(b) 手搓 "markdownish" 集合
> （base markdown + path<md>）散落 10+ 处。本节落「让新 base kind = shared 加一个
> 模块、漏接任何一面即构建错误」的骨架；review/markdownish 那一大簇属于 **RFC-081**。

### 7.1 RFC-080 范围内的具名 hook（不再是内联字面）

PR-A / PR-B 本就要碰这些点，要求把它们做成**具名共享导出**而非内联字面，使其同时
充当未来扩展的 hook：

| hook                                                                                 | 取代的散落点                                                                                                                               | 归属               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `DEFAULT_OUTPUT_KIND` 常量（+ `defaultParsedKind()`）                                | `outputKinds/index.ts:63`、`OutputsEditor.tsx:68/82`、`prompt.ts:546`、`wrapperFanout.ts:121`、`WorkflowCanvas.tsx:1762` 的魔法 `'string'` | registry barrel    |
| `formatPortValidationErrCode(handler, subReason)`                                    | `envelope.ts:331` 内联模板（D2 统一 displayName）                                                                                          | registry barrel    |
| `handler.carriesData()`（**非 optional**）                                           | `signalPromptGuard.ts:57` 硬判 `'signal'`                                                                                                  | parametric handler |
| `handler.bulletSuffix(port)` / `handler.examplePlaceholder(port)`（**非 optional**） | `prompt.ts:546/548/553` 的 `markdown_file` 字面分支（D1 已要求改 parsed 判定，这里进一步把文案搬到 handler）                               | parametric handler |
| `handler.baseNames`（**非 optional**，base handler 自报名、path/list 报 `[]`）       | 反向交叉校验 `REGISTERED_BASE_KINDS`（见 7.3）                                                                                             | parametric handler |

### 7.2 `OUTPUT_KIND_UI` —— 前端枚举的单一描述表

新增一张 co-located 共享描述表，**前端一切 kind 表现从它派生**，取代散落的硬编码：

```ts
// packages/shared/src/outputKinds/uiCatalog.ts （扁平、低依赖，见 7.4 红线）
type OutputKindUiDescriptor = {
  value: string // 一个可选 kind 变体的 canonical 串 / 模板，如 'string' | 'path<*>' | 'list<...>'
  labelKey: string // i18n key（中英两侧都要有，启动期断言，见 7.3）
  editorShape: 'base' | 'param-path' | 'container-list'
  downloadable: boolean // 驱动 TaskOutputPanel 下载按钮（list<path> 可 opt-in）
  dataBearing: boolean // 与 handler.carriesData() 必须一致（见 7.4）
  canvasClass: string | null // 驱动 canvas 端口 chrome（signal 端口样式）
}
export const OUTPUT_KIND_UI = [...] as const satisfies readonly OutputKindUiDescriptor[]
```

派生关系：

- `KindSelect` 的 base 下拉从 `OUTPUT_KIND_UI`（经 `listSelectableKinds()`）枚举，
  **不再硬编码** `string/markdown/signal/path`。
- `OutputsEditor.tsx:96` / i18n `outputKind_*`（含 critic 补的 `zh-CN.ts:1227` TS
  Resources 接口 + `zh-CN.ts:3259` 值）从 `labelKey` 派生。
- `TaskOutputPanel.tsx:136`（下载按钮，critic 补点）+ `output-port.ts:15`
  `isFileOutputKind` 从 `downloadable` 派生。
- `WrapperNodes.tsx:191/247` 的 signal 端口样式**从端口 parsed kind 的 `canvasClass`
  派生**，取代硬判端口名 `__done__`（需把 per-port kind 串进 `CanvasNodeData`）。

### 7.3 三层 drift guard（漏接 = 构建错误）

照搬本仓既有穷尽性模式：

1. **运行时能力非 optional**：7.1 的 `carriesData` / `bulletSuffix` /
   `examplePlaceholder` / `baseNames` 作为**非可选**字段加进
   `ParametricOutputKindHandler`（`registry.ts:43`）。每个 handler 都 `satisfies`
   该接口 → 漏实现一个方法 `bun run typecheck` 直接红（同 RFC-049/060 既有保证）。
2. **UI 表 `as const satisfies`**：`OUTPUT_KIND_UI` 用 `as const satisfies` 锁形，
   加一个 kind 变体不填全维度即编译错。**完全照搬 `packages/shared/src/node-kind-behavior.ts`
   的 `NODE_KIND_BEHAVIORS satisfies Record<NodeKind, NodeKindBehavior>`**。
3. **模块加载期交叉校验**：挂在既有两处 subReason 冲突 assert 旁
   （`outputKinds/index.ts:126`、`registry.ts:112`）新增两条 assert：
   - (a) `REGISTERED_BASE_KINDS`（`kindParser.ts:157`）== 各 handler `baseNames` 的
     并集，且每个 base name 恰好命中一个 handler；
   - (b) 每个 `OUTPUT_KIND_UI.labelKey` 在中英两 locale 都解析得到。
     缺一个 → 启动 / CI 抛，而非渲染裸 key 或静默丢分支。

### 7.4 两条工程红线（均来自 RFC-079 踩过的初始化环）

- **`kindParser.ts` 绝不 import 注册表**：会重建 `index→list→registry→list` 环、崩
  `build:binary`。所以 7.3(a) 的对齐**反向**做——`kindParser` 保留自己的 const Set，
  由**注册表加载期 assert 交叉校验**它，而不是让 parser 反过来 import handler。
- **list wire codec 留在无依赖的 `listWire.ts`**：不要把它挪到 handler 对象上（同一
  个环）。`dataBearing` 这种前后端都要用的 flag 放一个 cycle-safe 的 shared 小
  predicate（前端不能 import backend services、backend handler 不应 import UI 表，
  两侧都 import 这个 shared predicate）。任何往 shared barrel 加 re-export 的改动，
  push 前必须 `bun run build:binary` smoke。

### 7.5 明确划给 RFC-081 的部分（本 RFC 不做）

review / markdownish 那一大簇——`isReviewableBody`（替 `validator.ts:777` +
`reviewMultiDoc.ts:17` + `schemas/review.ts:420` + `review.ts:1892/2176/2410`）、
`passthroughKind` / `acceptedSubsetKind`（替 `review.ts:1367/1530/1537` +
`lifecycleRepair/options-R1.ts:146`）——**改持久化 kind 字符串**、动 10+ review 站点、
且涉及「多文档泛化到内联正文 `list<markdown>`」（doc_versions 持久化扩展），单独走
**RFC-081**，gated on RFC-080 绿。本 RFC 的 `isReviewableBody` 等 handler 方法**可先
以非 optional 占位**（默认实现），RFC-081 再填语义并收编调用面。
