# RFC-012 — Word 模式 Markdown 表格保留（RFC-010 follow-up）

## 背景

RFC-010 把 review DiffView 的 `word` / `line` / `block` 三种粒度全部改为"含 PUA marker 的 merged markdown → remark 插件 → react-markdown 内联高亮"。当左右两份文档结构一致、只有段内字词级修订时，word 模式工作良好；但只要 **markdown 表格的列数或分隔符宽度发生了变化，或一段表格被替换成非表格内容（反之亦然）**，word 模式就会把表格渲染成裸露 `|---|---|` 的段落，肉眼看像"乱码"。

### 现场（生产环境实测）

打开 `http://localhost:5174/reviews/01KRPT8E3R484QZAA2MWPE9MT8`（granularity=word），React fiber 上的 `left` / `right`：

- 左：`| 项目名称 | 坦克大战游戏 |\n|---------|------------|\n| 文档版本 | V1.0 |\n...`
- 右：`| 项目 | 内容 |\n|------|------|\n| 项目名称 | 坦克大战游戏 |\n| 文档版本 | v1.0 |\n...`

`buildMergedMarkdown(left, right, 'word')` 输出（`[DO]/[DC]` = DEL_OPEN/CLOSE，`[IO]/[IC]` = INS_OPEN/CLOSE）：

```
| 项目[DO]名称[DC] | [DO]坦克[DC][IO]内容[IC][DO]大战游戏[DC] |
|------[DO]-[DC]|[IO][IC]--|[DO][DC]----[DO]-[DC]|[IO][IC][DO]-[DC]
[DO]-[DC]|[IO][IC][DO]-[DC] [DO]-[DC][IO]项目[IC][DO]-[DC][IO]名称[IC][DO]-[DC] [DO]-[DC]|[IO][IC] [IO]坦克大战游戏 [IC]|
| 文档版本 | [DO]V1[DC][IO]v1[IC].0 |
```

DOM 侧：`<div data-testid="markdown-diff-view">` 内 `<table>` 数 = 0，含散落管道符的 `<p>` 共 8 个。GFM 表分隔符正则要求每对 `|` 之间只能是 `:?-+:?` + 空格——上面分隔符行被 jsdiff 在单字符 `-` 粒度上对齐打碎、又被 `wrapLines` 在每条 change 上塞 PUA marker，规则破坏，表格降级成段落。第二宗坏段更夸张：左侧是 C++ 代码块、右侧是新加的表格头，word-diff 跨行对齐后把字段名和表格分隔符碎成一团。

### 为什么 RFC-010 没覆盖到

- `proposal.md` 验收第 1 条只笼统说"表格…正确渲染"，没有为"两侧表格结构不一致"留 fixture。
- `design.md §代码块策略` 明确把 fenced code 列为 v1 限制，加了 `FENCE_RE`；**表格没有对应的原子化策略**。
- 实际 review 场景里，作者改表头 / 增删列 / 把段落改成表格非常常见，所以这是高频痛点，不是边角。

## 目标 / 非目标

### 目标

- 在 word 模式下，**当左右两侧任意一侧出现 markdown 表格块时，整张表格作为原子 token 参与 diff**：要么整张表被标为 `del`（整张以 `<table>` 红底删除线渲染），要么整张表被标为 `ins`（整张以 `<table>` 绿底渲染），要么左右两张表都"不变"原样渲染。表格内部不再做字符级 word-diff。
- 接受副作用：**同一张表内的字词级修订（典型场景 U1：只改了某 cell 的一个词）在 word 模式下将退化为"整张旧表 del + 整张新表 ins"**——结构正确性优先于细粒度高亮。这条折衷写进非目标里。
- 复用同一份 wrapLines + remark 渲染管线，不引入第二条数据流。
- 不损坏 line / block 模式现有行为（line / block 本来就是行 / 块级粒度，表格行天然原子；本 RFC 只调整 word 路径）。

### 非目标

- 不在 word 模式做 table cell 级别的字词高亮（参考实现 `netj/markdown-diff` 也没做这件事；做了反而会再次面对"列数变化"的对齐难题）。
- 不改 line / block 模式的现有行为（它们已经把每行作为最小单元，表格已是正确的）。
- 不做 fenced code block 内部 word-diff（继承 RFC-010 §代码块策略 v1 限制）。
- 不对其它结构性 block（heading、引用、列表项）做原子化——它们的 word-diff 表现已经可接受（heading 改字仍能正确 `<h2>` 渲染，列表项改字 `<li>` 也对）。
- 不引入 side-by-side / table-aware 三路合并 UI。

## 用户故事

- **U1（表格列改名，word）**：原表 `| 项目名称 | 坦克大战游戏 |`，新表把表头改成 `| 项目 | 内容 |` 并把原内容下推一行。reviewer 切到 word 模式，看到**两张完整渲染的 `<table>`**——上一张带红底删除线，下一张带绿底——而不是裸 `|---|---|` 段落。改动直观可读。
- **U2（段落改成表格，word）**：原文是普通段落 `项目名称：坦克大战游戏`，新文重写成 `| 项目 | 内容 |\n|---|---|\n| 项目名称 | 坦克大战游戏 |`。word 模式渲染：原段以红底删除线段落 + 新表以绿底完整 `<table>` 紧随其后。
- **U3（表内仅改单个 cell 字词，word）**：左右两表列数与分隔符一致，仅某 cell 内文字不同。word 模式下整张旧表整体红底 + 整张新表整体绿底（验收里明确接受这个粒度退化）；如果作者想看 cell 级细微差异，切到 line 模式即可。
- **U4（无表格的小修，word）**：本 RFC 不影响任何不含表格的输入；现有 word 模式段内改字 / CJK / heading / list 表现保持不变。

## 验收标准

1. **表格不再降级成段落**：在 review 详情页对一份"左右表格结构不一致"的 doc_version 切到 word 模式，`<div data-testid="markdown-diff-view">` 内对应区域必须出现 `<table>` 元素，不允许出现含 `|---` 等表格元字符的 `<p>`。回归 fixture 直接用本 RFC 背景里的两份样本（"项目名称 / 项目"表头改动）。
2. **接受退化**：表格内仅 cell 内字词改动时，word 模式渲染两个独立 `<table>`（旧 + 新），分别带 `class="diff-del"` / `class="diff-ins"` 容器，**不**期望 cell 内 `<span class="diff-ins/del">`。
3. **段落 ↔ 表格互转**：左段落 vs 右表格（反之亦然）的样本下，渲染输出含一个 `<table>` + 一个段落，且段落 / 表格各自被正确包裹为 del / ins。
4. **不破坏现有 word 模式**：RFC-010 已有的 word 测试（heading 改字、列表项改字、CJK、`<script>` 转义、相同输入无 marker）全部保持绿。
5. **不破坏 line / block 模式**：RFC-010 全部 line / block 测试保持绿；line 模式下表格行各自带 ins/del 行级 marker 的现有表现不变。
6. CI 三件套（`bun run typecheck` + `bun run test` + `bun run format:check`）+ 各 package lint 全绿。

## 与现有 RFC 的关系

- **依赖** RFC-010（本 RFC 在 `markdownDiff.ts` 的 word 路径上加一个 pre-segment 步骤；其它模块零改动）。
- **不影响** RFC-005 / RFC-007 / RFC-008 / RFC-009 / RFC-011（本 RFC 是 word 模式专属修复）。
- **替代** RFC-010 plan 里没有的"表格原子化"工作——RFC-010 标记 Done 时本 RFC 在 In Progress 即可。
