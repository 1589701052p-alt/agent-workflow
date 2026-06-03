# RFC-081 — Output Kind 能力 hook 收编（review/markdownish）+ 多文档泛化到内联 `list<markdown>`

状态：Draft（待 RFC-080 落地后启动）

## 背景

RFC-080 的 11-agent 全仓审计枚举出 94 个 port-kind 处理点。**最大的一簇漏适配温床**
是 review 子系统里手搓的 "markdownish" 判定 + 输出 kind 的硬编码，散落 10+ 处：

- **markdownish 集合**（base markdown + path<md> + path<markdown>）被重复实现于：
  `workflow.validator.ts:777`、`reviewMultiDoc.ts:17`、`schemas/review.ts:420`
  （`isMultiMarkdownUpstream`）、`review.ts:1892`（iterate sibling cascade）、
  `review.ts:2176`（`{{__sibling_outputs__}}`）、`review.ts:2410`
  （`loadUpstreamPortKind`）。加一个新 markdown 类 kind（如 `path<mdx>` / base `doc`）
  要同步改 6+ 处，漏一处就静默丢文档 / 不触发多文档模式。
- **输出 kind 硬编码**：`review.ts:1367` 把 accepted 子集硬写 `list<path<md>>`；
  `review.ts:1530/1537` 用「有没有 `sourceFilePath`」推断 approved_doc 是路径还是
  正文、并硬写 `markdown_file`；critic 还发现 `lifecycleRepair/options-R1.ts:146`
  是同一决策的重复副本。后果：对 `list<markdown>` / `path<rst>` 等做评审会输出
  **被贴错的 kind 字符串**。

同时，产品上要求把多文档评审从「只接 `list<path<md>>`（文件路径）」**泛化到也接
内联正文 `list<markdown>`**（用户 2026-06-04 拍板：现在就泛化）。这触及 doc_versions
持久化（accepted 子集当前依赖 `item_path`）和 list wire 编码（见 design §3 的核心
难点：markdown 正文含换行，与现行「每行一项」的 list wire 形式冲突）。

这些都属于 RFC-080 明确划出的范围（RFC-080 design §7.5），因为它们**改持久化 kind
字符串**、动 10+ review 站点、且涉及 schema/migration —— 风险与 RFC-080 的「地基 +
前端」不同档，单独立此 RFC，**gated on RFC-080 绿**。

## 目标

- **G1** 用 `handler.isReviewableBody()`（RFC-080 已加的非 optional 占位）替换所有
  手搓 markdownish 判定；list-of-markdownish 的「是不是 list」仍是结构判定，但
  「item 是不是可评审文档」一律走该 hook。加新 markdown 类 kind 只动 handler。
- **G2** 用 `handler.passthroughKind()` / `handler.acceptedSubsetKind(inputKind)` 替换
  review 输出 kind 的硬编码（含 `options-R1.ts:146` 重复副本），使评审输出的 kind
  从「上游消费的 kind」派生，不再贴错。
- **G3** 多文档评审泛化到内联正文 `list<markdown>`：上游可声明 `list<markdown>`，
  评审进多文档模式、逐篇内联正文检视、approve 输出内联正文子集；与既有
  `list<path<md>>`（文件路径）并存。

## 非目标

- 不重做 RFC-080 的 drift-guard / UI catalog（直接继承）。
- 不改 review 决策语义（approve / reject / iterate）与单文档评审路径（零回归）。
- 不引入新 base kind / 新文法形态（仅让既有 `markdown` / `path<md>` / `list<...>`
  组合在 review 路径上被 handler 统一识别 + 让 list wire 支持 markdown 正文项）。

## 用户故事

- **US-1** 作为作者，我把某 agent 的输出端口声明为 `path<mdx>`（未来扩展），它**自动**
  被 review 节点识别为可评审文档，无需改 review 代码。
- **US-2** 作为作者，我让「用例生成器」直接产出**内联正文**的一组 markdown 文档
  （`list<markdown>`，不落盘），多文档评审照常逐篇检视、采纳子集走下游。
- **US-3** 我对 `list<markdown>` 做评审并 approve，下游收到的 accepted 子集 kind 是
  `list<markdown>`（内联正文），而非被贴成 `list<path<md>>`。

## 验收标准

- **AC-1** markdownish 判定全部经 `handler.isReviewableBody()`；源码守卫：
  `validator.ts` / `reviewMultiDoc.ts` / `review.ts` / `schemas/review.ts` 不再各自
  落 `=== 'markdown'` / `=== 'markdown_file'` / 内联 ext 集合。给一个虚构
  `path<mdx>` handler 标 `isReviewableBody=true` → 多文档检测 + validator + sibling
  cascade **自动**认它（一条测试锁）。
- **AC-2** review 输出 kind 从上游 kind 派生：对 `list<path<md>>` 评审 approve 输出
  `list<path<md>>`；对 `list<markdown>` 评审 approve 输出 `list<markdown>`；单文档
  `path<md>` 输出 `path<md>`、`markdown` 输出 `markdown`。`options-R1.ts:146` 与
  `review.ts:1530` 走同一 hook（不再两份）。**持久化 kind 字符串回归快照**全锁。
- **AC-3** 内联 `list<markdown>` 多文档评审端到端可用：上游产出 → 进多文档模式 →
  逐篇内联正文检视（选词锚定评论复用）→ approve 输出内联正文子集 → 下游可消费。
- **AC-4** 既有 `list<path<md>>` 多文档评审与单文档评审**零回归**（RFC-079 全套 + 单
  文档 183 测仍绿）。
- **AC-5** list wire 对 markdown 正文项的编解码无歧义（含正文自身含换行 / 含分隔哨兵
  的转义）；producer/consumer round-trip 字节守恒（property-based 测试）。

## 与既有 RFC 的关系

- **承接 RFC-080**：消费其 `isReviewableBody` / `passthroughKind` / `acceptedSubsetKind`
  非 optional 占位 + drift-guard；RFC-080 绿后启动。
- **扩展 RFC-079**：把多文档评审从 `list<path<md>>` 泛化到 `list<markdown>`，复用其
  doc_versions（item_index/item_path/selection）+ awaiting_review + 三栏面。
- **触及 RFC-049/060**：review 路径改用 parametric handler 能力方法。
