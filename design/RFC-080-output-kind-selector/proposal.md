# RFC-080 — Output Kind 选择器统一 + parametric kind 运行时收尾

状态：Draft（待用户批准实现）

## 背景

用户在 `/agents/new`（及编辑）表单给输出端口选 kind 时，只能从 3 个遗留值里挑：
`string` / `markdown` / `markdown_file`。无法声明 `signal`、`path<json>`、
`list<string>`、`list<path<md>>` 这类结构化 kind。

根因不是「系统不支持」，而是三层错位：

1. **类型 / 解析 / 注册表层早已支持全文法**（RFC-060）：
   - `AgentOutputKindSchema = z.string().refine(isRegisteredKindString)`
     （`packages/shared/src/schemas/review.ts:47`）——不再是枚举。
   - `kindParser.ts` 文法支持 `base` / `path<ext>`（含 `path<*>` / `path<md>`）/
     `list<...>`（可嵌套）（`packages/shared/src/kindParser.ts:8-12`）。
   - parametric handler 注册表 `PARAMETRIC_HANDLERS` 对 string / markdown / path /
     list / signal 全有 handler（`packages/shared/src/outputKinds/registry.ts:80`）。

2. **前端两个 kind 输入面不一致**：
   - agent 表单 `OutputsEditor` 是闭合 `<select>`，写死 3 个遗留值
     （`packages/frontend/src/components/OutputsEditor.tsx:19`）。
   - 同一 app 的 canvas wrapper-fanout 输入端口编辑（`NodeInspector`）却用裸
     `<TextInput>` + `tryParseKind` 让用户手敲 `list<path<md>>`
     （`packages/frontend/src/components/canvas/NodeInspector.tsx:696-700`）。
     一个过窄、一个无引导，违反《前端界面统一风格强制原则》。

3. **运行时埋着崩溃隐患**（RFC-060 PR-D 注释承诺「switch runtime callers over」
   但未完成，见 `outputKinds/index.ts:144-147`）：两个消费 **agent 输出 kind** 的
   运行时点仍只认旧 3-key `HANDLERS` Record——
   - `prompt.ts buildProtocolBlock` → `groupPortsByKind` → `getOutputKindHandler`
     （`packages/shared/src/prompt.ts:564`、`outputKinds/index.ts:70`）；
   - `envelope.ts resolvePortContentDetailed` → `getOutputKindHandler`
     （`packages/backend/src/services/envelope.ts:319`）。

   `getOutputKindHandler('list<string>')` 在 `HANDLERS['list<string>']` 未命中时
   **抛** `outputKind handler not registered`（`outputKinds/index.ts:29-34`）。
   今天没在生产爆，**纯粹因为 `OutputsEditor` 物理上不让用户选非遗留 kind**——
   一旦放开 UI 就会在节点派发时崩。

所以「漏配置」的表象下，是一段**未完成的后端迁移**。本 RFC 把它一并收口。

## 目标

- **G1** agent 表单能给输出端口声明完整文法 kind：`string` / `markdown` /
  `signal` / `path<ext>`（含 `path<*>` / `path<md>` / `path<json>`）/ `list<...>`，
  不再只有 3 个遗留值。
- **G2** 抽出**单一公共 `KindSelect` 原语**，用引导式控件表达 kind 文法（base 下拉 +
  path 扩展名输入 + list 包裹开关 + 嵌套/非法值的 raw-text 退路），agent 表单
  （`OutputsEditor`）与 canvas fanout（`NodeInspector`）共用，消除 bespoke
  `<select>` 与裸 `<TextInput>`。
- **G3** 运行时安全：补完 RFC-060 PR-D 延后的迁移，使 agent 输出声明为 parametric
  kind 时，构造 prompt + 校验 envelope 走 parametric 注册表，**不再抛
  `handler not registered`**。
- **G4** 防漏适配骨架：把「新 base kind = shared 加一个 handler 模块 + 一条 UI
  catalog 表项」做成现实——前端 kind 表现从 `OUTPUT_KIND_UI` 描述表派生（不再硬
  编码），并加**三层 drift guard**（handler 能力方法非 optional → typecheck；
  `OUTPUT_KIND_UI as const satisfies` → typecheck；模块加载期交叉校验 base 名 +
  双语 i18n key → 启动/CI）。漏接任何一面变成构建错误。详见 design.md §7。
  （review/markdownish 那一大簇的收编属 **RFC-081**。）

## 非目标

- 不新增 base kind、不改 kind 文法；只暴露既有 string / markdown / signal /
  path / list。
- 不改 wrapper-fanout sharding 语义、review 节点 kind 约束、git wrapper `git_diff`
  的 `list<path>` kind。
- 不强制彻底删除遗留 `HANDLERS` Record。本 RFC 只保证 **agent-output 运行时路径**
  走 parametric；遗留 Record 的整体移除留作 follow-up（迁移后若 grep 确认零引用，
  可顺手在 PR-A 删，否则保留）。

## 用户故事

- **US-1** 作为工作流作者，我建一个「拆分器」agent，让它输出一组 markdown 文件
  路径，供下游 wrapper-fanout 按文件分片。我在表单把输出端口 `docs` 的 kind 选成
  「list of path(.md)」，保存后该 agent 即可作为 fanout 的 `list<path<md>>` 上游。
- **US-2** 作为作者，我给某 agent 加一个控制流信号端口（`signal`），用于无聚合
  agent 时驱动下游。
- **US-3** 作为作者，我在 canvas 上编辑 fanout 输入端口 kind 时，看到的控件与 agent
  表单完全一致，不再需要手敲 `list<path<md>>` 字符串。

## 验收标准

- **AC-1** 表单可选并保存、且能 round-trip 显示以下 kind：`string` / `markdown` /
  `signal` / `path<*>` / `path<md>` / `path<json>` / `list<string>` /
  `list<path<md>>`。
- **AC-2** 保存为 `list<path<md>>` 的 agent 作为 fanout shardSource 上游通过校验；
  历史 `markdown_file` 值读入显示为 path(.md)，再存规范化为 `path<md>`，**运行时
  文件读取 / 扩展名 / 非空校验行为不变**。
- **AC-3** `KindSelect` 同时被 `OutputsEditor` 与 `NodeInspector` fanout 输入使用；
  源码层断言两处都不再各自落 kind `<select>` / 裸 kind `<TextInput>`。
- **AC-4** 声明 parametric 输出 kind 的 agent 派发时：`buildProtocolBlock` 产出正确
  协议块（path / list 端口给出「先写文件、再只回 worktree 相对路径」二步提示；
  signal 端口给出「无数据」提示），`resolvePortContentDetailed` 正确校验，**均不抛
  `handler not registered`**。
- **AC-5** 三个遗留 kind 的运行时行为不回归：`string` / `markdown` 的 prompt + 校验
  **字节一致**；`markdown_file`（≡ `path<md>`）的 **校验行为字节一致**，prompt 文案
  统一为等价的 path 版二步协议（语义等价，快照同步更新）。
- **AC-6** 嵌套 `list<list<...>>` 或非法字符串落入 raw-text 退路，实时显示解析错误，
  **不静默改写用户输入**。
- **AC-7** drift guard 生效：把一个 handler 的能力方法删掉 / 给 `OUTPUT_KIND_UI`
  加一条不填全维度的项 / 让 `REGISTERED_BASE_KINDS` 与 handler `baseNames` 失配 /
  漏一个 locale 的 label key —— 上述任一在 `bun run typecheck` 或模块加载期失败
  （各写一条「红」测试锁住）。
- **AC-8** `KindSelect` 选项、`outputKind_*` 中英标签、`TaskOutputPanel` 下载按钮、
  canvas signal 端口样式**全部从 `OUTPUT_KIND_UI` 派生**；源码层断言这四处不再各自
  硬编码 kind 列表 / 字面 `'__done__'` / 字面 `KIND_OPTIONS`。

## 与既有 RFC 的关系

- **承接 RFC-060**：补完其 PR-D 注释承诺但未落地的「运行时 callers 迁移到 parametric
  注册表」。RFC-060 本体保持 Done，本 RFC 是其运行时收尾 + 前端暴露。
- **触及 RFC-049**：`prompt.ts` / `envelope.ts` / `runner.ts` 的 per-kind handler
  分派路径（RFC-049 引入）从遗留 `HANDLERS` 切到 parametric 等价物。
- **服务 RFC-079 / wrapper-fanout**：让用户能在 agent 层正式声明 `list<path<md>>`
  输出，是 per-item review / 多文档分片的自然上游来源。

## PR 拆分（强序）

1. **PR-A（后端运行时迁移 — 安全前提）**：把 `prompt.ts` / `envelope.ts` /
   `runner.ts` 的 agent-output kind 分派切到 parametric 注册表；保持 3 遗留 kind
   不回归。**必须先 push CI 全绿**，才能放开前端。
2. **PR-B（共享 `KindSelect` 原语 + 改两面）**：新增公共组件，改 `OutputsEditor`
   与 `NodeInspector` fanout 输入。
3. **PR-C（e2e + STATE/plan 收尾）**。

详见 `design.md` / `plan.md`。
