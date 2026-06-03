# RFC-081 — 技术设计

> 前提：RFC-080 已落地，`ParametricOutputKindHandler` 已带非 optional
> `isReviewableBody()` / `passthroughKind()` / `acceptedSubsetKind(inputKind)`
> 占位（默认实现）+ drift-guard。本 RFC 填这些方法的语义并收编调用面。

## 1. markdownish 收编 → `handler.isReviewableBody()`

### 1.1 现状（手搓集合的 6+ 副本）

| 站点                                              | 形态                                         | 作用                                  |
| ------------------------------------------------- | -------------------------------------------- | ------------------------------------- |
| `reviewMultiDoc.ts:17` `isMarkdownishItem`        | ParsedKind：base markdown ∥ path md/markdown | 多文档 item 判定（被 30/41/101 复用） |
| `workflow.validator.ts:777`                       | 同上内联                                     | review inputSource 必须 markdownish   |
| `schemas/review.ts:420` `isMultiMarkdownUpstream` | 字符串 `=== 'markdown' \|\| 'markdown_file'` | iterate sibling 计数                  |
| `review.ts:1892`                                  | 字符串三元过滤                               | iterate sibling cascade               |
| `review.ts:2176`                                  | 同上副本                                     | `{{__sibling_outputs__}}`             |
| `review.ts:2410` `loadUpstreamPortKind`           | 字符串 allowlist + `isMultiDocReviewInput`   | 派发前 kind 允许面                    |

### 1.2 目标

`isReviewableBody(): boolean` 落在每个 parametric handler：`markdownParametric`
（base markdown）→ true；`path` → 仅 `ext ∈ {md, markdown}` 时 true（path handler
内读 `EXT_ALIASES`，RFC-080 已建）→ 需要 path handler 的 `isReviewableBody` 接收
ParsedKind 才能看 ext，**故签名为 `isReviewableBody(parsed: ParsedKind): boolean`**
（base/string/signal 忽略入参返回定值，path 读 ext，list 委托 item）。

所有调用面改成：`const p = tryParseKind(kindStr); getHandlerForParsedKind(p).isReviewableBody(p)`。
list-of-markdownish 仍是结构判定（`p.kind === 'list'`）+ 对 `p.item` 调该 hook
（`reviewMultiDoc.ts:30/41` 保留 list 形态分支，item 检查改走 hook）。

`isMultiMarkdownUpstream`（schemas/review.ts）改为：解析每个 port 的 kind →
`isReviewableBody` 计数（≥2 且 syncOutputsOnIterate）。**注意**：它现在漏 `path<md>`
（只认两个字面），收编后自动覆盖 path<md> → 行为变化（更正确），需更新其测试预期。

## 2. review 输出 kind 派生 → `passthroughKind` / `acceptedSubsetKind`

### 2.1 现状（硬编码 + 重复副本）

- `review.ts:1367` accepted 子集硬写 `'list<path<md>>'`。
- `review.ts:1530/1537` 单文档 approve：`dv.sourceFilePath != null ? 路径 : 正文`，
  kind 硬写 `'markdown_file' : null`。
- `lifecycleRepair/options-R1.ts:146`：同决策的**第二份副本**（critic 发现）。

### 2.2 目标

- `acceptedSubsetKind(inputKind: ParsedKind): string` —— 由评审消费的 list<item>
  推导 accepted 子集 kind：`list<path<md>>` → `list<path<md>>`；`list<markdown>` →
  `list<markdown>`；未来 `list<path<rst>>` → `list<path<rst>>`。`review.ts:1367` 改调它。
- `passthroughKind(inputKind, hasSourcePath): { kind, carriesPath }` —— 单文档
  approve 的输出 kind + 「带路径还是正文」决策，由上游 ParsedKind 派生而非看
  `sourceFilePath` 推断。`review.ts:1530/1537` **与** `options-R1.ts:146` 都改调它
  （消重，两处由构造保证一致）。

> **风险最高**：改持久化 `node_run_outputs.kind` 字符串。design §6 要求对这些 kind
> 串做**字节级回归快照**（迁移前 = 现状，迁移后 = 派生值，逐 case 列明哪些变、为何变）。

## 3. 多文档泛化到内联正文 `list<markdown>`（核心难点）

### 3.1 难点：list wire 形式与 markdown 正文冲突

现行 list wire（`listWire.ts` / `outputKinds/list.ts`）是**每行一项**：
`list<path<md>>` 每行一个文件路径（无换行）天然可行；但 `list<markdown>` 每项是
**含换行的正文**，「每行一项」无法无歧义切分（`list.ts` 注释本就声明「multi-line
items aren't supported」）。这是泛化的真正阻塞点，不解决就只是把 bug 往后移。

### 3.2 候选方案

| 方案                            | 做法                                                                                                                                                           | 取舍                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A. item-kind 感知的 list 编解码 | `listWire` 的 split/join 接收 item ParsedKind：标量/path 项 → 每行一项（不变，零回归）；markdown 正文项 → 文档分隔哨兵（如 `\n<<<doc>>>\n`）+ 正文内同序列转义 | 改动集中在 `listWire`；**保持 cycle-free**（只依赖 ParsedKind，不 import handler）；零回归 path 路径 |
| B. 文档数组信封                 | 上游用结构化信封（如重复 `<port>` 或 JSON 数组）发多文档                                                                                                       | 动 envelope/输出协议，面更大，与 list<T> 抽象不一致                                                  |
| C. 强制落盘                     | 「内联」其实仍写临时文件 → 退回 `list<path<md>>`                                                                                                               | 违背「内联正文不落盘」的产品意图，否决                                                               |

**推荐 A**：`splitListItems(raw, itemKind)` / `joinListItems(items, itemKind)`
（保留在无依赖 `listWire.ts`，红线见 RFC-080 §7.4）。markdown 项用哨兵分隔 + 转义；
path/string 项保持每行一项，对既有 producer/consumer **字节不变**。该方案与 RFC-080
hook 目录里的 `ListKind wire codec` 完全一致。

> 此方案需在 RFC-081 自身评审轮（建议一轮对抗式 + property-based）最终敲定哨兵 /
> 转义细节；本 design 锁定「方案 A 方向 + 字节守恒 + 零回归 path」三条硬约束。

### 3.3 持久化（doc_versions）

复用 RFC-079 的 `doc_versions`（`item_index` / `item_path` / `selection`）：

- `list<path<md>>`（现状）：`item_path` = worktree 相对路径，正文按现状解析。
- `list<markdown>`（新）：`item_path` = NULL，每项正文写入既有 `bodyPath`（与单文档
  正文同路径体系）；accepted 子集序列化为 `list<markdown>` 内联正文（经 §3.2 A 的
  join），不依赖 `item_path`。
- 是否需要新列：倾向**不加列**，用 `item_path IS NULL` 区分内联 vs 文件项（与单文档
  `itemIndex IS NULL` 判据同风格）；若评审轮发现需显式判别再加 `item_inline` 布尔
  （migration 单列 + backfill 全 NULL）。**design 默认无新列、无 migration**，作为
  开放项 OQ-1。

### 3.4 派发与采纳路径

- `review.ts:431` 多文档归档：`isMultiDocReviewInput` 仍判 list-of-reviewable，
  item 抽取改走 §3.2 A 的 `splitListItems(content, itemKind)`；内联项把正文写
  `bodyPath`、`item_path = NULL`。
- `reviewMultiDoc.ts:101` `acceptedSubsetPaths` → 泛化为 `acceptedSubset(rows, inputKind)`：
  文件项收集 `item_path` join 成 `list<path<md>>`；内联项收集正文 join 成
  `list<markdown>`（经 §3.2 A）。kind 由 `acceptedSubsetKind(inputKind)` 给。

## 4. 数据流与耦合点

- review 调用面（validator / dispatch / approve / sibling cascade）从字符串字面改为
  `parseKind` → handler 能力方法；schema 层 `isMultiMarkdownUpstream` 同。
- 持久化：`node_run_outputs.kind`（free-form text，无 CHECK，零 migration）承载派生
  kind；`doc_versions` 复用 RFC-079 列（默认无新列）。
- 前端：多文档三栏面（RFC-079）渲染内联正文项时，`item_path` 为 NULL → 从 `bodyPath`
  正文渲染（已有单文档正文渲染路径，复用）；下载按钮对内联项隐藏（RFC-080 catalog
  的 `downloadable` 已是 per-variant）。

## 5. 失败模式

| #   | 场景                                                | 处理                                                                                                                                            |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | list<markdown> 正文恰含分隔哨兵                     | §3.2 A 的转义规则覆盖；property-based 测试含「正文含哨兵序列」case（AC-5）。                                                                    |
| F2  | 派生 kind 串变化打破外部断言                        | §6 回归快照逐 case 列明；下游/前端读 kind 的点同步核查。                                                                                        |
| F3  | 新 markdown 类 kind 只标 handler 未覆盖某 review 面 | RFC-080 的 drift-guard 层 1（`isReviewableBody` 非 optional）保证 handler 必实现；本 RFC 加源码守卫确保调用面**只**走 hook（grep 无残留字面）。 |
| F4  | 内联多文档与文件多文档混在同一 list                 | 文法上 `list<T>` 单一 item kind，不会混；validator 拒 `list` 的 item 非统一 reviewable。                                                        |
| F5  | options-R1.ts 与 review.ts 派生不一致               | 收编为同一 `passthroughKind` 调用，构造保证一致 + 一条对拍测试。                                                                                |

## 6. 测试策略

### PR-A（markdownish 收编）

- `isReviewableBody` 单测：base markdown=true、path<md>/path<markdown>=true、
  path<json>/string/signal=false、虚构 path<mdx> handler=true 时各调用面自动认。
- 收编回归：validator review-input 规则 / `isMultiMarkdownUpstream` 计数（含
  path<md> 现在被计入的行为变化）/ loadUpstreamPortKind / sibling cascade 各一组。
- 源码守卫：上述文件无残留 `=== 'markdown'` / `'markdown_file'` / 内联 ext 集合。

### PR-B（输出 kind 派生）

- `acceptedSubsetKind` / `passthroughKind` 单测覆盖 list<path<md>> / list<markdown> /
  path<md> / markdown / path<rst>。
- **持久化 kind 字符串回归快照**：approve list<path<md>> / 单文档 path<md> /
  单文档 markdown_file（现状）→ 列明迁移后值；`options-R1.ts:146` 与 `review.ts:1530`
  对拍。
- RFC-079 多文档全套 + 单文档 183 测零回归。

### PR-C（list<markdown> 泛化）

- list wire item-kind 感知编解码：path 项字节不变（零回归 property test）；markdown
  正文项 round-trip 守恒（含换行 / 含哨兵 / 空文档 / 单文档 / N 文档）。
- 端到端：list<markdown> 上游 → 多文档归档（item_path NULL + bodyPath 正文）→ 逐篇
  内联检视 → approve 输出 list<markdown> 子集 → 下游消费。
- migration（若 OQ-1 决定加列）：backfill 字节守恒。

### 门槛

- `typecheck && test && format:check` 全绿；`build:binary` smoke（listWire 改动，红线
  自查无初始化环）；RFC-049/060/079/080 既有套件零回归。

## 7. 开放问题

- **OQ-1** 内联 vs 文件项的区分：`item_path IS NULL` 够用，还是显式加 `item_inline`
  列？（design 默认前者、无 migration；评审轮定。）
- **OQ-2** §3.2 A 的哨兵 / 转义具体形式（建议 RFC-081 评审轮敲定 + property-based 锁）。
- **OQ-3** 派生 kind 串变化是否触及任何下游 / 前端 / e2e 硬断言？（PR-B 前 grep。）
